#!/usr/bin/env python3
"""Relay Linux agent. Standard library only; never collects command arguments."""
import argparse
import csv
import datetime
import json
import math
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request


def text(path, default=''):
    try:
        return Path(path).read_text().strip()
    except (OSError, ValueError):
        return default


def number(value):
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def sensor_celsius(path):
    value = number(text(path))
    if value is None or not math.isfinite(value) or not -30000 <= value <= 150000:
        return None
    return round(value / 1000, 1)


def cpu_temperature(hwmon_root=Path('/sys/class/hwmon'), thermal_root=Path('/sys/class/thermal')):
    """Prefer CPU package/die sensors, never motherboard or disk sensors."""
    candidates = []
    for monitor in hwmon_root.glob('hwmon*'):
        driver = text(monitor / 'name')
        if driver not in ('coretemp', 'k10temp', 'zenpower'):
            continue
        for source in monitor.glob('temp*_input'):
            value = sensor_celsius(source)
            if value is None:
                continue
            label = text(source.with_name(source.name.replace('_input', '_label')), source.stem)
            lower = label.lower()
            rank = 0 if lower.startswith('package') or lower == 'tdie' else 1 if lower == 'tctl' else 2
            candidates.append((rank, value, f'{driver} · {label}'))
    if candidates:
        priority = min(item[0] for item in candidates)
        _, value, source = max((item for item in candidates if item[0] == priority), key=lambda item: item[1])
        return value, source
    for zone in thermal_root.glob('thermal_zone*'):
        kind = text(zone / 'type')
        if kind in ('x86_pkg_temp', 'k10temp', 'cpu-thermal', 'cpu_thermal'):
            value = sensor_celsius(zone / 'temp')
            if value is not None:
                return value, kind
    return None, None


def passive_gpu_temperature(pci):
    """Do not touch GPU temperature files unless it is already active."""
    pci = Path(pci)
    if text(pci / 'power_state') != 'D0' or text(pci / 'power/runtime_status') != 'active':
        return None, None
    for monitor in (pci / 'hwmon').glob('hwmon*'):
        for source in sorted(monitor.glob('temp*_input')):
            value = sensor_celsius(source)
            if value is not None:
                label = text(source.with_name(source.name.replace('_input', '_label')), source.stem)
                return value, f'{text(monitor / "name", "GPU")} · {label}'
    return None, None


class Sampler:
    def __init__(self, config):
        self.config = config
        self.previous = {}
        self.previous_cpu = None
        self.previous_time = None
        self.previous_net = None
        self.users = {}
        self.gpu_cache = None
        self.gpu_sampled = -1000
        info = text('/proc/cpuinfo')
        self.cpu_name = next((line.split(':', 1)[1].strip() for line in info.splitlines() if line.startswith('model name')), 'CPU')
        osinfo = dict(line.split('=', 1) for line in text('/etc/os-release').splitlines() if '=' in line)
        self.os_name = osinfo.get('PRETTY_NAME', 'Linux').strip('"')

    def battery(self):
        for bat in Path('/sys/class/power_supply').glob('*'):
            if text(bat / 'type') != 'Battery' or text(bat / 'present', '1') != '1':
                continue
            v = (number(text(bat / 'voltage_now')) or 0) / 1e6
            nominal = (number(text(bat / 'voltage_min_design')) or v * 1e6) / 1e6
            def energy(field):
                direct = number(text(bat / ('energy_' + field)))
                charge = number(text(bat / ('charge_' + field)))
                return direct / 1e6 if direct is not None else charge * nominal / 1e6 if charge is not None else None
            full, design, current = energy('full'), energy('full_design'), energy('now')
            power = number(text(bat / 'power_now'))
            power = power / 1e6 if power is not None else (number(text(bat / 'current_now')) or 0) * v / 1e6
            state = text(bat / 'status')
            return {'percent': number(text(bat / 'capacity')), 'status': state, 'powerW': round(power, 2),
                    'fullWh': full, 'designWh': design, 'energyWh': current,
                    'healthPercent': round(full / design * 100, 1) if full and design else None,
                    'remainingHours': round(current / power, 2) if state == 'Discharging' and current and power > 0.5 else None}
        return None

    def gpu(self, now):
        if self.config.get('nvidia_monitor'):
            if now - self.gpu_sampled < max(15, min(300, int(self.config.get('interval_seconds', 30)))):
                return self.gpu_cache
            self.gpu_sampled = now
            try:
                fields = 'name,pstate,utilization.gpu,temperature.gpu,power.draw,power.limit,memory.used,memory.total'
                raw = subprocess.check_output(['nvidia-smi', '--query-gpu=' + fields, '--format=csv,noheader,nounits'], text=True, timeout=5)
                row = next(csv.reader(raw.splitlines(), skipinitialspace=True))
                self.gpu_cache = {'name': row[0], 'state': row[1], 'utilization': number(row[2]), 'temperatureC': number(row[3]),
                                  'powerW': number(row[4]), 'powerLimitW': number(row[5]), 'memoryUsedMb': number(row[6]),
                                  'memoryTotalMb': number(row[7]), 'mode': 'nvidia', 'temperatureSource': 'NVIDIA GPU core',
                                  'sampledAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            except (OSError, subprocess.SubprocessError, StopIteration, IndexError):
                self.gpu_cache = {'name': self.config.get('gpu_name', 'NVIDIA'), 'state': 'unavailable', 'mode': 'nvidia'}
            return self.gpu_cache
        pci = self.config.get('gpu_pci_path')
        if pci:
            temperature, source = passive_gpu_temperature(pci)
            return {'name': self.config.get('gpu_name', 'Discrete GPU'), 'state': text(Path(pci) / 'power_state', 'unavailable'),
                    'runtimeStatus': text(Path(pci) / 'power/runtime_status', 'unknown'),
                    'temperatureC': temperature, 'temperatureSource': source,
                    'sampledAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'mode': 'intel' if text('/etc/prime-discrete') == 'off' else 'hybrid',
                    'driverLoaded': Path('/sys/module/nvidia').exists()}
        return None

    def sample(self):
        now = time.monotonic()
        elapsed = now - self.previous_time if self.previous_time else 0
        cpu = [int(x) for x in text('/proc/stat').splitlines()[0].split()[1:9]]
        total, idle = sum(cpu), cpu[3] + cpu[4]
        percent = 0
        if self.previous_cpu:
            dt, di = total - self.previous_cpu[0], idle - self.previous_cpu[1]
            percent = max(0, min(100, (1 - di / dt) * 100)) if dt else 0
        self.previous_cpu = (total, idle)
        mem = {line.split(':', 1)[0]: int(line.split()[1]) * 1024 for line in text('/proc/meminfo').splitlines() if len(line.split()) >= 2}
        total_mem = mem.get('MemTotal', 1)
        used_mem = total_mem - mem.get('MemAvailable', mem.get('MemFree', 0))
        processes, current = [], {}
        ticks, pages = os.sysconf('SC_CLK_TCK'), os.sysconf('SC_PAGE_SIZE')
        for directory in Path('/proc').iterdir():
            if not directory.name.isdigit():
                continue
            try:
                value = (directory / 'stat').read_text()
                left, right = value.find('('), value.rfind(')')
                name = value[left + 1:right][:120]
                fields = value[right + 2:].split()
                pid, started = int(directory.name), fields[19]
                consumed = int(fields[11]) + int(fields[12])
                key = (pid, started)
                current[key] = consumed
                usage = (consumed - self.previous[key]) / ticks / elapsed * 100 if elapsed and key in self.previous else 0
                uid = directory.stat().st_uid
                if uid not in self.users:
                    try:
                        self.users[uid] = pwd.getpwuid(uid).pw_name
                    except KeyError:
                        self.users[uid] = str(uid)
                rss = max(0, int(fields[21])) * pages
                processes.append({'pid': pid, 'name': name, 'user': self.users[uid], 'cpuPercent': round(max(0, usage), 1),
                                  'memoryBytes': rss, 'memoryPercent': round(rss / total_mem * 100, 2), 'state': fields[0]})
            except (OSError, ValueError, IndexError, ProcessLookupError):
                continue
        self.previous = current
        processes.sort(key=lambda x: (x['cpuPercent'], x['memoryBytes']), reverse=True)
        net = [0, 0]
        for line in text('/proc/net/dev').splitlines()[2:]:
            iface, values = line.split(':', 1)
            if not iface.strip().startswith(('en', 'eth', 'wl')):
                continue
            values = values.split()
            net[0] += int(values[0]); net[1] += int(values[8])
        rates = [max(0, (net[i] - self.previous_net[i]) / elapsed) for i in range(2)] if elapsed and self.previous_net else [0, 0]
        self.previous_net, self.previous_time = net, now
        disk = shutil.disk_usage(self.config.get('disk_path', '/'))
        temp, temp_source = cpu_temperature()
        try:
            profile = subprocess.check_output(['powerprofilesctl', 'get'], text=True, timeout=2).strip()
        except (OSError, subprocess.SubprocessError):
            profile = 'unknown'
        uptime = number(text('/proc/uptime').split(' ')[0]) or 0
        return {'deviceId': self.config['device_id'], 'sampledAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'hostname': os.uname().nodename, 'os': self.os_name, 'cpuName': self.cpu_name, 'cpuCores': os.cpu_count() or 1,
                'cpuPercent': round(percent, 1), 'temperatureC': temp, 'temperatureSource': temp_source,
                'memoryTotalBytes': total_mem, 'memoryUsedBytes': used_mem,
                'diskTotalBytes': disk.total, 'diskUsedBytes': disk.used, 'diskFreeBytes': disk.free,
                'uptimeSeconds': uptime, 'powerProfile': profile, 'battery': self.battery(), 'gpu': self.gpu(now),
                'network': {'rxBytesPerSecond': round(rates[0]), 'txBytesPerSecond': round(rates[1])},
                'processCount': len(processes), 'processes': processes[:250]}


class FileError(Exception):
    def __init__(self, message, code=403):
        self.code = code
        super().__init__(message)


def safe_parts(path):
    if not isinstance(path, str) or len(path) > 4096 or '\\' in path or '\0' in path or path.startswith('/'):
        raise FileError('This path is not allowed.')
    parts = path.split('/') if path else []
    for part in parts:
        if not part or part.startswith('.') or part.lower().endswith(('.pem', '.key', '.p12', '.pfx')) or part in ('id_rsa', 'id_ed25519'):
            raise FileError('Hidden files, credentials and parent paths are not available.')
    return parts


def file_request(config, request, output=None):
    """Use directory fds and O_NOFOLLOW for every component, including files."""
    output = output or sys.stdout.buffer
    roots = config.get('file_roots', {})
    root = roots.get(request.get('root'))
    if not root:
        raise FileError('Choose an available folder.')
    parts = safe_parts(request.get('path', ''))
    root_path = str(Path(root['path']).resolve(strict=True))
    fd = os.open(root_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        action = request.get('action', 'list')
        components = parts if action == 'list' else parts[:-1]
        for part in components:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        if action == 'list':
            entries = []
            total_entries = 0
            with os.scandir(fd) as directory:
                for entry in directory:
                    try:
                        safe_parts(entry.name)
                        info = entry.stat(follow_symlinks=False)
                    except (OSError, FileError):
                        continue
                    total_entries += 1
                    if len(entries) >= 1000:
                        continue
                    kind = 'folder' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'link'
                    entries.append({'name': entry.name, 'kind': kind, 'size': info.st_size, 'modifiedAt': datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc).isoformat()})
            entries.sort(key=lambda e: (e['kind'] != 'folder', e['name'].casefold()))
            return {'type': 'listing', 'root': request['root'], 'path': '/'.join(parts), 'entries': entries,
                    'truncated': total_entries > 1000, 'roots': [{'id': key, 'name': value['name']} for key, value in roots.items()]}
        if action != 'download' or not parts:
            raise FileError('Unsupported file request.', 400)
        source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(source, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise FileError('Only regular files can be downloaded.')
            if info.st_size > 2 * 1024**3:
                raise FileError('Use SFTP for files larger than 2 GB.', 413)
            header = {'type': 'download', 'name': parts[-1], 'size': info.st_size}
            output.write((json.dumps(header) + '\n').encode())
            shutil.copyfileobj(stream, output, 128 * 1024)
            output.flush()
            return None
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('mode', choices=['run', 'snapshot', 'files'], default='run', nargs='?')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    if args.mode == 'files':
        try:
            raw = sys.stdin.buffer.read(16385)
            if len(raw) > 16384:
                raise FileError('Request is too large.', 400)
            result = file_request(config, json.loads(raw))
            if result is not None:
                print(json.dumps(result))
        except FileError as exc:
            print(json.dumps({'type': 'error', 'status': exc.code, 'message': str(exc)}))
        except (OSError, ValueError, TypeError):
            print(json.dumps({'type': 'error', 'status': 403, 'message': 'This file or folder is not accessible.'}))
        return
    sampler = Sampler(config)
    sampler.sample()
    time.sleep(0.25)
    if args.mode == 'snapshot':
        print(json.dumps(sampler.sample()))
        return
    interval = max(15, min(300, int(config.get('interval_seconds', 30))))
    while True:
        started = time.monotonic()
        body = json.dumps(sampler.sample()).encode()
        request = urllib.request.Request(config['server_url'].rstrip('/') + '/api/ingest', data=body,
                                         headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['token']}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                response.read(1024)
        except (OSError, urllib.error.URLError) as exc:
            print('Relay report delayed: ' + type(exc).__name__, file=sys.stderr, flush=True)
        time.sleep(max(1, interval - (time.monotonic() - started)))


if __name__ == '__main__':
    main()
