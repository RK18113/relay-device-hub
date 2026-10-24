#!/usr/bin/env python3
"""Install a Relay agent in the current user's home. No administrator access."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--config', required=True, help='Enrollment JSON downloaded from Relay')
p.add_argument('--no-start', action='store_true', help='Only install files; use a system service instead')
a = p.parse_args()
if os.geteuid() == 0:
    raise SystemExit('Run as your regular account, not root.')
home = Path.home()
config_dir = home / '.config/relay'
app_dir = home / '.local/share/relay'
config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
config_dir.chmod(0o700)
app_dir.mkdir(parents=True, exist_ok=True)
source = Path(__file__).resolve().parent
agent_source = source / 'agent.py'
if not agent_source.exists():
    agent_source = source.parent / 'agent/agent.py'
configuration = json.loads(Path(a.config).read_text())
configuration['file_roots'] = {'home': {'name': 'Home', 'path': str(home)}}
for key in ['Documents', 'Downloads', 'Desktop']:
    directory = home / key
    if directory.is_dir():
        configuration['file_roots'][key.lower()] = {'name': key, 'path': str(directory)}
if not configuration.get('nvidia_monitor'):
    for pci in Path('/sys/bus/pci/devices').iterdir():
        try:
            if (pci / 'vendor').read_text().strip() == '0x10de' and (pci / 'class').read_text().strip().startswith('0x03'):
                configuration['gpu_pci_path'] = str(pci)
                configuration.setdefault('gpu_name', 'NVIDIA GPU')
                break
        except OSError:
            pass
for filename in ['agent.py', 'relay_power.py', 'relay_controls.py']:
    shutil.copy2(agent_source.parent / filename, app_dir / filename)
(app_dir / 'agent.py').chmod(0o755)
target = config_dir / 'agent.json'
target.write_text(json.dumps(configuration, indent=2) + '\n')
target.chmod(0o600)
unit_dir = home / '.config/systemd/user'
unit_dir.mkdir(parents=True, exist_ok=True)
# Quote systemd paths independently of shell syntax.
def quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
unit = '[Unit]\nDescription=Relay device reports\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/python3 ' + quote(app_dir / 'agent.py') + ' --config ' + quote(target) + ' run\nRestart=on-failure\nRestartSec=15\nNice=10\nUMask=0077\n\n[Install]\nWantedBy=default.target\n'
(unit_dir / 'relay-agent.service').write_text(unit)
if not a.no_start:
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', 'relay-agent.service'], check=True)
print('Relay agent installed for this account. Personal folders are read-only through Relay.')
print('The user service runs while your login session is active. For pre-login startup, configure a system service using the supplied server installer.')
