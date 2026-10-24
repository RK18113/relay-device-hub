import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('relay_agent', Path(__file__).resolve().parents[1] / 'agent/agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class FilesSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'home'; self.root.mkdir()
        (self.root / 'notes.txt').write_bytes(b'personal notes\n')
        (self.root / 'Documents').mkdir()
        (self.root / '.ssh').mkdir(); (self.root / '.ssh/key').write_text('private')
        (self.root / '.env').write_text('secret')
        (self.root / 'client.key').write_text('secret')
        (self.root / 'escape').symlink_to(Path(self.tmp.name), target_is_directory=True)
        (self.root / 'link.txt').symlink_to(self.root / 'notes.txt')
        self.config = {'file_roots': {'home': {'path': str(self.root), 'name': 'Home'}}}

    def tearDown(self): self.tmp.cleanup()

    def request(self, path='', action='list', output=None):
        return agent.file_request(self.config, {'root': 'home', 'path': path, 'action': action}, output=output)

    def test_listing_hides_credentials_and_sorts_folders(self):
        result = self.request()
        self.assertEqual(result['entries'][0]['name'], 'Documents')
        self.assertFalse({'.ssh', '.env', 'client.key'} & {e['name'] for e in result['entries']})

    def test_parent_absolute_and_hidden_paths_are_rejected(self):
        for path in ['../', '../outside', '/etc/passwd', '.ssh/key', 'Documents/../notes.txt', 'client.key', 'a\\b', 'a\0b']:
            with self.subTest(path=path), self.assertRaises(agent.FileError): self.request(path)

    def test_directory_and_file_symlinks_are_never_followed(self):
        with self.assertRaises(OSError): self.request('escape')
        with self.assertRaises(OSError): self.request('link.txt', 'download', io.BytesIO())

    def test_regular_file_download_is_exact(self):
        target = io.BytesIO(); self.request('notes.txt', 'download', target)
        header, data = target.getvalue().split(b'\n', 1)
        self.assertEqual(json.loads(header)['size'], len(data))
        self.assertEqual(data, b'personal notes\n')

    def test_fifo_is_not_downloaded(self):
        os.mkfifo(self.root / 'pipe')
        with self.assertRaises(agent.FileError): self.request('pipe', 'download', io.BytesIO())

    def test_unknown_root_is_denied(self):
        with self.assertRaises(agent.FileError): agent.file_request(self.config, {'root': 'system', 'path': ''})


class TemperatureSensors(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.hwmon = self.root / 'hwmon'; self.hwmon.mkdir()
        self.thermal = self.root / 'thermal'; self.thermal.mkdir()

    def tearDown(self): self.tmp.cleanup()

    def sensor(self, index, driver, values):
        root = self.hwmon / ('hwmon' + str(index)); root.mkdir()
        (root / 'name').write_text(driver)
        for n, (label, value) in enumerate(values, 1):
            (root / f'temp{n}_label').write_text(label)
            (root / f'temp{n}_input').write_text(str(value))
        return root

    def test_intel_package_is_selected_instead_of_hotter_core_or_disk(self):
        self.sensor(0, 'nvme', [('Composite', 99000)])
        self.sensor(1, 'coretemp', [('Core 0', 82000), ('Package id 0', 61000)])
        self.assertEqual(agent.cpu_temperature(self.hwmon, self.thermal), (61.0, 'coretemp · Package id 0'))

    def test_amd_tdie_preferred_and_tctl_used_when_it_is_the_only_package_reading(self):
        root = self.sensor(0, 'k10temp', [('Tctl', 76000), ('Tccd1', 81000), ('Tdie', 65000)])
        self.assertEqual(agent.cpu_temperature(self.hwmon, self.thermal), (65.0, 'k10temp · Tdie'))
        (root / 'temp3_input').unlink()
        self.assertEqual(agent.cpu_temperature(self.hwmon, self.thermal), (76.0, 'k10temp · Tctl'))

    def test_unknown_motherboard_and_invalid_readings_are_not_cpu_temperatures(self):
        self.sensor(0, 'board', [('CPU', 50000)])
        self.sensor(1, 'coretemp', [('Package id 0', 'nan'), ('Core 0', 999000)])
        self.assertEqual(agent.cpu_temperature(self.hwmon, self.thermal), (None, None))

    def test_known_thermal_zone_is_a_fallback(self):
        zone = self.thermal / 'thermal_zone0'; zone.mkdir()
        (zone / 'type').write_text('x86_pkg_temp'); (zone / 'temp').write_text('53000')
        self.assertEqual(agent.cpu_temperature(self.hwmon, self.thermal), (53.0, 'x86_pkg_temp'))

    def test_sleeping_gpu_never_reads_temperature_or_invokes_nvidia_tools(self):
        pci = self.root / 'pci'; (pci / 'power').mkdir(parents=True)
        (pci / 'power_state').write_text('D3cold'); (pci / 'power/runtime_status').write_text('suspended')
        sampler = agent.Sampler({'gpu_pci_path': str(pci)})
        with patch.object(agent, 'sensor_celsius') as read, patch.object(agent.subprocess, 'check_output') as command:
            result = sampler.gpu(100)
            self.assertIsNone(result['temperatureC']); read.assert_not_called(); command.assert_not_called()

    def test_active_gpu_can_read_its_own_hwmon_sensor(self):
        pci = self.root / 'pci'; (pci / 'power').mkdir(parents=True)
        (pci / 'power_state').write_text('D0'); (pci / 'power/runtime_status').write_text('active')
        monitor = pci / 'hwmon/hwmon2'; monitor.mkdir(parents=True)
        (monitor / 'name').write_text('gpu'); (monitor / 'temp1_input').write_text('47000')
        (monitor / 'temp1_label').write_text('edge')
        self.assertEqual(agent.passive_gpu_temperature(pci), (47.0, 'gpu · edge'))


if __name__ == '__main__': unittest.main()
