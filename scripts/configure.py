#!/usr/bin/env python3
"""Create private Relay configuration and an isolated MongoDB container.

Run as a regular Docker-enabled user. Identity and hosts are discovered or supplied
at setup time; no installation-specific details belong in the application source.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
from urllib.parse import quote

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--owner', help='Tailscale login allowed to open the workspace')
p.add_argument('--url', help='Private HTTPS URL, normally https://HOST.TAILNET.ts.net')
p.add_argument('--name', default=socket.gethostname())
p.add_argument('--kind', choices=['desktop', 'laptop', 'server'], default='server')
p.add_argument('--extra-device', action='store_true', help='Read one additional device registration from stdin')
p.add_argument('--port', type=int, default=4310)
p.add_argument('--mongo-port', type=int, default=27021)
a = p.parse_args()
if os.geteuid() == 0:
    raise SystemExit('Run as your regular Docker-enabled user, not root.')
home = Path.home()
config_dir = home / '.config/relay'
app_dir = home / '.local/share/relay'
config_dir.mkdir(parents=True, exist_ok=True, mode=0o700); config_dir.chmod(0o700)
if (config_dir / 'hub.json').exists():
    raise SystemExit('Existing Relay configuration found; leaving it untouched. Add devices through the application.')
existing = subprocess.run(['docker', 'container', 'inspect', 'relay-mongo'], capture_output=True)
if existing.returncode == 0:
    raise SystemExit('A container named relay-mongo already exists; leaving it untouched.')
with socket.socket() as check:
    try:
        check.bind(('127.0.0.1', a.mongo_port))
    except OSError:
        raise SystemExit('The selected MongoDB port is already in use; choose --mongo-port.')
status = {}
try:
    status = json.loads(subprocess.check_output(['tailscale', 'status', '--json'], text=True))
except (OSError, subprocess.SubprocessError, ValueError):
    pass
self_node = status.get('Self', {})
profile = status.get('User', {}).get(str(self_node.get('UserID')), {})
owner = a.owner or profile.get('LoginName')
public_url = a.url or ('https://' + self_node.get('DNSName', '').rstrip('.') if self_node.get('DNSName') else '')
if not owner or not public_url.startswith('https://'):
    raise SystemExit('Supply --owner and --url, or sign this host into Tailscale first.')
def write_private(path, value):
    path.write_text(value); path.chmod(0o600)
def roots():
    result = {'home': {'name': 'Home', 'path': str(home)}}
    for name in ['Documents', 'Downloads', 'Desktop']:
        if (home / name).is_dir(): result[name.lower()] = {'name': name, 'path': str(home / name)}
    return result
self_id = 'device-' + secrets.token_hex(4)
self_device = {'id': self_id, 'name': a.name, 'kind': a.kind, 'role': 'HOST DEVICE', 'description': 'Workspace host',
    'token': secrets.token_hex(32), 'local': True, 'intervalSeconds': 30, 'nvidiaMonitor': a.kind != 'laptop' and bool(shutil.which('nvidia-smi')),
    'agentPath': str(app_dir / 'agent.py'), 'agentConfig': str(config_dir / 'agent.json')}
configuration = {'allowedLogins': [owner], 'publicUrl': public_url, 'devices': [self_device]}
enrollments = config_dir / 'enrollments'; enrollments.mkdir(mode=0o700, exist_ok=True)
if a.extra_device:
    import sys
    extra = json.load(sys.stdin)
    name = str(extra['name'])[:60]
    other = {'id': 'device-' + secrets.token_hex(4), 'name': name, 'kind': extra.get('kind', 'laptop'),
        'role': 'PORTABLE DEVICE' if extra.get('kind') == 'laptop' else 'CONNECTED DEVICE', 'description': 'Personal Linux device',
        'token': secrets.token_hex(32), 'local': False, 'address': extra['address'], 'sshUser': extra['sshUser'],
        'intervalSeconds': 30, 'nvidiaMonitor': False}
    configuration['devices'].append(other)
    write_private(enrollments / (other['id'] + '.json'), json.dumps({'device_id': other['id'], 'server_url': public_url,
        'token': other['token'], 'interval_seconds': 30, 'nvidia_monitor': False}, indent=2))
root_password, app_password = secrets.token_hex(32), secrets.token_hex(32)
write_private(config_dir / 'mongo.env', 'MONGO_INITDB_ROOT_USERNAME=relay_admin\nMONGO_INITDB_ROOT_PASSWORD=' + root_password + '\nRELAY_DB_PASSWORD=' + app_password + '\n')
init = 'db.getSiblingDB("relay").createUser({user:"relay",pwd:process.env.RELAY_DB_PASSWORD,roles:[{role:"readWrite",db:"relay"}]});\n'
write_private(config_dir / 'mongo-init.js', init)
# The MongoDB entrypoint reads this one non-secret script as its own container UID.
(config_dir / 'mongo-init.js').chmod(0o644)
write_private(config_dir / 'hub.json', json.dumps(configuration, indent=2))
uri = 'mongodb://relay:' + quote(app_password, safe='') + f'@127.0.0.1:{a.mongo_port}/relay?authSource=relay'
write_private(config_dir / 'server.env', f'NODE_ENV=production\nPORT={a.port}\nHUB_CONFIG={config_dir / "hub.json"}\nMONGODB_URI={uri}\n')
write_private(config_dir / 'agent.json', json.dumps({'device_id': self_id, 'server_url': f'http://127.0.0.1:{a.port}',
    'token': self_device['token'], 'interval_seconds': 30, 'nvidia_monitor': self_device['nvidiaMonitor'], 'file_roots': roots()}, indent=2))
subprocess.run(['docker', 'run', '-d', '--name', 'relay-mongo', '--restart', 'unless-stopped', '--memory', '768m', '--pids-limit', '256',
    '--label', 'app=relay-device-hub', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
    '-p', f'127.0.0.1:{a.mongo_port}:27017', '--env-file', str(config_dir / 'mongo.env'),
    '--mount', 'type=volume,source=relay-mongo-data,target=/data/db',
    '--mount', f'type=bind,source={config_dir / "mongo-init.js"},target=/docker-entrypoint-initdb.d/relay.js,readonly',
    'mongo:7', '--wiredTigerCacheSizeGB', '0.25'], check=True, stdout=subprocess.DEVNULL)
print(json.dumps({'publicUrl': public_url, 'devices': [{'id': d['id'], 'name': d['name'], 'local': d['local']} for d in configuration['devices']], 'configuration': str(config_dir)}))
