#!/usr/bin/env bash
# Optional root-owned read-only energy sampler and narrowly scoped logind policy.
set -euo pipefail
[[ $EUID -eq 0 && -n ${SUDO_USER:-} && $SUDO_USER != root ]] || { echo 'Run with sudo from your regular account.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
sampler="$source_dir/../agent/power_service.py"
[[ -f $sampler ]] || sampler="$source_dir/power_service.py"
[[ -f $sampler ]] || { echo 'Power sampler source is missing.' >&2; exit 1; }
if [[ -e /etc/systemd/system/relay-power.service ]] && ! grep -q '^Description=Relay read-only CPU energy sampler$' /etc/systemd/system/relay-power.service; then
  echo 'An unrelated relay-power service exists; leaving it untouched.' >&2; exit 1
fi
if [[ -e /etc/polkit-1/rules.d/49-relay-device-controls.rules ]] && ! grep -q '^// Relay device controls$' /etc/polkit-1/rules.d/49-relay-device-controls.rules; then
  echo 'An unrelated access rule exists; leaving it untouched.' >&2; exit 1
fi
install -d -m 0755 /usr/local/libexec /etc/polkit-1/rules.d
install -o root -g root -m 0755 "$sampler" /usr/local/libexec/relay-power-sampler.py
cat > /etc/systemd/system/relay-power.service <<'UNIT'
[Unit]
Description=Relay read-only CPU energy sampler

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/libexec/relay-power-sampler.py
Restart=on-failure
RestartSec=10
RuntimeDirectory=relay-power
RuntimeDirectoryMode=0755
UMask=0022
MemoryMax=64M
Nice=10
NoNewPrivileges=true
PrivateNetwork=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=
ReadWritePaths=/run/relay-power

[Install]
WantedBy=multi-user.target
UNIT
python3 - "$SUDO_USER" <<'PY'
import json, pathlib, sys
account = json.dumps(sys.argv[1])
rule = '''// Relay device controls
// Authorizes this account only. Never bypass shutdown inhibitors or grant a shell.
polkit.addRule(function(action, subject) {
    var allowed = ["org.freedesktop.login1.power-off", "org.freedesktop.login1.power-off-multiple-sessions",
                   "org.freedesktop.login1.reboot", "org.freedesktop.login1.reboot-multiple-sessions"];
    if (subject.user === ACCOUNT && allowed.indexOf(action.id) !== -1) return polkit.Result.YES;
});
'''.replace('ACCOUNT', account)
path = pathlib.Path('/etc/polkit-1/rules.d/49-relay-device-controls.rules')
path.write_text(rule); path.chmod(0o644)
PY
systemd-analyze verify /etc/systemd/system/relay-power.service
systemctl daemon-reload
systemctl enable --now relay-power.service
systemctl restart relay-power.service
systemctl is-active relay-power.service
echo 'CPU sampler enabled. This account may request normal shutdown/reboot; inhibitors remain enforced.'
echo 'No screen lock, shutdown or reboot was executed.'
