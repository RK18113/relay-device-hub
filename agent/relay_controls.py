"""Fixed logind actions under the current account. No shell or forced inhibitors."""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

ACTIONS = {'lock', 'reboot', 'poweroff'}
JOB_PATTERN = re.compile(r'^[a-f0-9]{32}$')
STATE = Path.home() / '.local/state/relay/actions'


def command(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, timeout=8, check=True, **kwargs)


def desktop_sessions():
    sessions = []
    try:
        for line in command(['loginctl', 'list-sessions', '--no-legend', '--no-pager']).stdout.splitlines():
            sid = line.split()[0]
            if not re.fullmatch(r'[a-zA-Z0-9_-]+', sid): continue
            props = dict(x.split('=', 1) for x in command(['loginctl', 'show-session', sid, '-p', 'User', '-p', 'Type', '-p', 'Remote']).stdout.splitlines() if '=' in x)
            if props.get('User') == str(os.getuid()) and props.get('Type') in ('x11', 'wayland') and props.get('Remote') == 'no': sessions.append(sid)
    except (OSError, subprocess.SubprocessError, IndexError): pass
    return sessions


def capabilities():
    desktop = desktop_sessions()
    manager = Path(f'/run/user/{os.getuid()}/bus').exists()
    result = {'lock': {'available': bool(desktop) and manager, 'reason': '' if desktop and manager else 'An active graphical session and user manager are required.'}}
    for action, method in [('reboot', 'CanReboot'), ('poweroff', 'CanPowerOff')]:
        try:
            response = command(['busctl', '--timeout=5', 'call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', method]).stdout
            allowed = response.strip() == 's "yes"'
            result[action] = {'available': allowed and manager, 'reason': '' if allowed and manager else 'Install device access permissions.' if not allowed else 'A systemd user manager is required.'}
        except (OSError, subprocess.SubprocessError): result[action] = {'available': False, 'reason': 'Login manager is unavailable.'}
    return result


def write_job(job, payload):
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700); STATE.chmod(0o700)
    for old in STATE.glob('*.json'):
        if JOB_PATTERN.fullmatch(old.stem) and old.stat().st_mtime < datetime.datetime.now().timestamp() - 604800:
            old.unlink(missing_ok=True)
    temporary = STATE / (job + '.tmp')
    temporary.write_text(json.dumps({**payload, 'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}))
    temporary.chmod(0o600); temporary.replace(STATE / (job + '.json'))


def perform(action, job):
    try:
        if action not in ACTIONS or not JOB_PATTERN.fullmatch(job): raise ValueError('Invalid action.')
        if not capabilities()[action]['available']: raise ValueError('Device permission or session is unavailable.')
        if action == 'lock':
            for session in desktop_sessions(): command(['loginctl', 'lock-session', session])
        else:
            method = 'Reboot' if action == 'reboot' else 'PowerOff'
            command(['busctl', '--timeout=5', 'call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', method, 'b', 'false'])
        write_job(job, {'action': action, 'status': 'requested', 'message': 'Request accepted by the login manager.'})
    except (OSError, ValueError, subprocess.SubprocessError):
        write_job(job, {'action': action, 'status': 'failed', 'message': 'Action refused. Check device permissions, sessions or shutdown inhibitors.'})


def handle(request):
    operation = request.get('operation')
    if operation == 'capabilities': return {'capabilities': capabilities()}
    if operation == 'status':
        job = request.get('jobId', '')
        if not isinstance(job, str) or not JOB_PATTERN.fullmatch(job): raise ValueError('Invalid request.')
        try: return json.loads((STATE / (job + '.json')).read_text())
        except OSError: return {'status': 'unknown', 'message': 'Action status is not available.'}
    action = request.get('action')
    if operation != 'execute' or not isinstance(action, str) or action not in ACTIONS: raise ValueError('Unsupported action.')
    if not capabilities()[action]['available']: raise ValueError('This action is not available on the device.')
    job = uuid.uuid4().hex
    write_job(job, {'action': action, 'status': 'scheduled', 'message': 'Device action scheduled.'})
    try:
        environment = os.environ.copy(); environment['XDG_RUNTIME_DIR'] = f'/run/user/{os.getuid()}'
        environment['DBUS_SESSION_BUS_ADDRESS'] = f'unix:path=/run/user/{os.getuid()}/bus'
        command(['systemd-run', '--user', '--collect', '--quiet', '--unit=relay-action-' + job, '--on-active=3s',
                 '/usr/bin/python3', str(Path(__file__).resolve()), '--worker', action, job], env=environment)
    except (OSError, subprocess.SubprocessError):
        write_job(job, {'action': action, 'status': 'failed', 'message': 'The device could not schedule this action.'})
        raise ValueError('The device could not schedule this action.')
    return {'jobId': job, 'status': 'scheduled', 'delaySeconds': 3}


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker' and sys.argv[2] in ACTIONS and JOB_PATTERN.fullmatch(sys.argv[3]):
        perform(sys.argv[2], sys.argv[3])
    else: raise SystemExit(2)
