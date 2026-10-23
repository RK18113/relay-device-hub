#!/usr/bin/env bash
# Install the prepared Relay host and agent as regular-user system services.
set -euo pipefail
[[ $EUID -eq 0 && -n ${SUDO_USER:-} && $SUDO_USER != root ]] || { echo 'Run this script with sudo from your regular account.' >&2; exit 1; }
account=$SUDO_USER
user_home=$(getent passwd "$account" | cut -d: -f6)
app_dir="$user_home/.local/share/relay"
config_dir="$user_home/.config/relay"
[[ -f "$app_dir/app/server/index.js" && -f "$config_dir/server.env" ]] || { echo 'Configure and build Relay first.' >&2; exit 1; }
if [[ -e /etc/systemd/system/relay-hub.service ]] && ! grep -q '^Description=Relay private device workspace$' /etc/systemd/system/relay-hub.service; then
  echo 'An unrelated relay-hub service already exists; leaving it untouched.' >&2; exit 1
fi
node_bin=$(command -v node)
python3 - "$account" "$user_home" "$node_bin" <<'PY'
import pathlib, sys
account, home, node = sys.argv[1:]
app = pathlib.Path(home) / '.local/share/relay'
config = pathlib.Path(home) / '.config/relay'
def q(s): return '"' + str(s).replace('\\','\\\\').replace('"','\\"').replace('%','%%') + '"'
for name, description, command in [
    ('relay-hub', 'Relay private device workspace', q(node) + ' ' + q(app/'app/server/index.js')),
    ('relay-agent', 'Relay host device reports', '/usr/bin/python3 ' + q(app/'agent.py') + ' --config ' + q(config/'agent.json') + ' run')]:
    env_path = str(config/'server.env').replace('%', '%%').replace('\\', '\\\\').replace(' ', r'\x20').replace('\t', r'\x09')
    env = 'EnvironmentFile=' + env_path + '\n' if name == 'relay-hub' else ''
    unit = '[Unit]\nDescription=' + description + '\nWants=network-online.target\nAfter=network-online.target tailscaled.service docker.service\n\n[Service]\nType=simple\nUser=' + account + '\nEnvironment=' + q('HOME='+home) + '\n' + env + 'ExecStart=' + command + '\nRestart=on-failure\nRestartSec=15\nNoNewPrivileges=true\nUMask=0077\nMemoryMax=256M\nNice=5\n\n[Install]\nWantedBy=multi-user.target\n'
    pathlib.Path('/etc/systemd/system/'+name+'.service').write_text(unit)
PY
systemd-analyze verify /etc/systemd/system/relay-hub.service /etc/systemd/system/relay-agent.service
systemctl daemon-reload
systemctl enable relay-hub.service relay-agent.service
systemctl restart relay-hub.service relay-agent.service
echo 'Relay services installed. Checking startup before enabling private HTTPS…'
port=$(python3 - "$config_dir/server.env" <<'PY'
import pathlib,sys
values=dict(line.split('=',1) for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if '=' in line)
value=values.get('PORT','4310')
assert value.isdigit() and 1024 <= int(value) <= 65535
print(value)
PY
)
for attempt in {1..30}; do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null; then break; fi
  if [[ $attempt -eq 30 ]]; then echo 'Relay did not become healthy. Check journalctl -u relay-hub.service.' >&2; exit 1; fi
  sleep 1
done
tailscale serve status --json | python3 -c 'import json,sys; data=json.load(sys.stdin); port=sys.argv[1]; expected="http://127.0.0.1:"+port; conflicts=[host for host,web in data.get("Web",{}).items() if host.endswith(":443") and web.get("Handlers",{}).get("/",{}).get("Proxy",expected)!=expected]; sys.exit("Another service already owns the HTTPS root; configure a separate Serve port for Relay." if conflicts else 0)' "$port"
tailscale serve --bg --yes "http://127.0.0.1:$port"
systemctl show relay-hub.service relay-agent.service -p Id -p ActiveState -p SubState
tailscale serve status
