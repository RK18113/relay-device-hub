import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent'))
import relay_power as power
import power_service as sampler
import relay_controls as controls


class Power(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.cache = self.root / 'power.json'; self.supplies = self.root / 'supplies'; self.supplies.mkdir()

    def tearDown(self): self.tmp.cleanup()

    def reading(self, watts=12.5, age=0):
        self.cache.write_text(json.dumps({'watts': watts, 'source': 'CPU energy',
            'sampledAt': (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=age)).isoformat()}))

    def collect(self, battery=None, gpu=None, config=None):
        return power.collect_power(config or {}, battery, gpu, self.cache, self.supplies)

    def test_energy_conversion_rollover_and_invalid_sample(self):
        self.assertEqual(sampler.energy_watts(1000000, 25000000, 100000000, 2), 12)
        self.assertEqual(sampler.energy_watts(90000000, 10000000, 100000000, 2), 10)
        self.assertIsNone(sampler.energy_watts(0, 1, 100, 0))
        self.assertIsNone(sampler.energy_watts(0, 1, 100, 60))
        self.assertIsNone(sampler.energy_watts(0, 101, 100, 2))

    def test_package_domains_deduplicated_and_subdomains_not_added(self):
        for name, label in [('intel-rapl:0', 'package-0'), ('intel-rapl-mmio:0', 'package-0'), ('intel-rapl:0/intel-rapl:0:0', 'core')]:
            zone = self.root / name; zone.mkdir(parents=True, exist_ok=True)
            (zone / 'energy_uj').write_text('1'); (zone / 'name').write_text(label); (zone / 'max_energy_range_uj').write_text('1000')
        result = sampler.discover(self.root)
        self.assertEqual(list(result), ['package-0'])
        self.assertEqual(result['package-0'][0].parent.name, 'intel-rapl:0')

    def test_missing_stale_invalid_and_zero_readings_are_distinct(self):
        self.assertIsNone(self.collect()['cpu']['watts'])
        for watts, age in [(12, 60), (None, 0), (True, 0), (-5, 0)]:
            self.reading(watts, age); self.assertIsNone(self.collect()['cpu']['watts'])
        self.cache.write_text('[]'); self.assertIsNone(power.fresh_reading(self.cache))
        self.reading(0); self.assertEqual(self.collect()['cpu']['watts'], 0)

    def test_components_are_never_summed_as_a_total(self):
        self.reading(); result = self.collect(gpu={'mode': 'nvidia', 'powerW': 180})
        self.assertEqual(result['cpu']['watts'], 12.5); self.assertEqual(result['gpu']['watts'], 180)
        self.assertIsNone(result['system']['watts'])

    def test_battery_is_total_only_when_discharging_without_ac(self):
        battery = {'status': 'Discharging', 'powerW': 8.2}
        self.assertEqual(self.collect(battery)['system']['scope'], 'battery')
        ac = self.supplies / 'AC'; ac.mkdir(); (ac / 'type').write_text('Mains'); (ac / 'online').write_text('1')
        self.assertIsNone(self.collect(battery)['system']['watts'])
        self.assertIsNone(self.collect({'status': 'Charging', 'powerW': 20})['system']['watts'])

    def test_external_meter_requires_fresh_explicit_reading(self):
        self.reading(210)
        result = self.collect(config={'system_power_file': str(self.cache)})
        self.assertEqual(result['system']['scope'], 'wall'); self.assertEqual(result['system']['watts'], 210)
        self.reading(210, 120); self.assertIsNone(self.collect(config={'system_power_file': str(self.cache)})['system']['watts'])


class Controls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.state = patch.object(controls, 'STATE', Path(self.tmp.name)); self.state.start(); self.addCleanup(self.state.stop)
        self.caps = {name: {'available': True, 'reason': ''} for name in controls.ACTIONS}

    def test_malformed_actions_never_reach_os_commands(self):
        with patch.object(controls, 'command') as command:
            for request in [{'operation': 'execute', 'action': {}}, {'operation': 'execute', 'action': 'shell'}, {'operation': 'status', 'jobId': '../escape'}]:
                with self.assertRaises(ValueError): controls.handle(request)
            command.assert_not_called()

    def test_scheduling_uses_fixed_worker_and_json_status_not_a_shell(self):
        with patch.object(controls, 'capabilities', return_value=self.caps), patch.object(controls, 'command') as command:
            result = controls.handle({'operation': 'execute', 'action': 'reboot'})
            args = command.call_args.args[0]
            self.assertEqual(args[0], 'systemd-run'); self.assertIn('--on-active=3s', args)
            self.assertEqual(args[-3:], ['--worker', 'reboot', result['jobId']])
            self.assertNotIn('shell', command.call_args.kwargs)
            self.assertEqual(controls.handle({'operation': 'status', 'jobId': result['jobId']})['status'], 'scheduled')

    def test_worker_respects_inhibitors_and_records_failure(self):
        job = 'a' * 32
        with patch.object(controls, 'capabilities', return_value=self.caps), patch.object(controls, 'command', side_effect=subprocess.CalledProcessError(1, ['busctl'])) as command:
            controls.perform('poweroff', job)
            self.assertEqual(command.call_args.args[0][-3:], ['PowerOff', 'b', 'false'])
            self.assertEqual(controls.handle({'operation': 'status', 'jobId': job})['status'], 'failed')

    def test_lock_targets_only_local_graphical_sessions_of_this_uid(self):
        def command(args):
            output = '1 user\n2 other\n3 ssh\n' if args[1] == 'list-sessions' else {
                '1': f'User={os.getuid()}\nType=wayland\nRemote=no',
                '2': f'User={os.getuid()+1}\nType=x11\nRemote=no',
                '3': f'User={os.getuid()}\nType=tty\nRemote=yes'}[args[2]]
            return subprocess.CompletedProcess(args, 0, output, '')
        with patch.object(controls, 'command', side_effect=command): self.assertEqual(controls.desktop_sessions(), ['1'])

    def test_unavailable_permissions_never_schedule(self):
        self.caps['reboot']['available'] = False
        with patch.object(controls, 'capabilities', return_value=self.caps), patch.object(controls, 'command') as command:
            with self.assertRaises(ValueError): controls.handle({'operation': 'execute', 'action': 'reboot'})
            command.assert_not_called()
