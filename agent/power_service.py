#!/usr/bin/env python3
"""Relay read-only CPU energy sampler. No network, commands, or power-limit writes."""
import datetime
import json
import math
from pathlib import Path
import time


def read(path):
    try: return Path(path).read_text().strip()
    except OSError: return ''


def discover(root=Path('/sys/class/powercap')):
    packages = {}
    paths = list(root.glob('*/energy_uj')) + list(root.glob('*/*/energy_uj'))
    for energy in sorted(paths, key=lambda p: ('mmio' in str(p), str(p))):
        zone = energy.parent; name = read(zone / 'name')
        if not name.startswith('package-') or name in packages:
            continue
        try:
            maximum = int(read(zone / 'max_energy_range_uj'))
            if maximum > 0: packages[name] = (energy.resolve(), maximum)
        except ValueError: pass
    return packages


def energy_watts(previous, current, maximum, elapsed):
    if not 0 < elapsed <= 30 or not 0 <= previous <= maximum or not 0 <= current <= maximum:
        return None
    delta = current - previous if current >= previous else maximum - previous + current
    watts = delta / 1e6 / elapsed
    return round(watts, 2) if math.isfinite(watts) and 0 <= watts <= 5000 else None


def run(output=Path('/run/relay-power/power.json'), interval=2):
    packages = discover(); previous = {}; last = time.monotonic()
    output.parent.mkdir(parents=True, exist_ok=True)
    while True:
        now = time.monotonic(); values = []; current = {}
        for name, (path, maximum) in packages.items():
            try:
                value = int(read(path)); current[name] = value
                if name in previous:
                    watts = energy_watts(previous[name], value, maximum, now - last)
                    if watts is not None: values.append(watts)
            except ValueError: pass
        complete = bool(packages) and len(values) == len(packages)
        payload = {'watts': round(sum(values), 2) if complete else None,
                   'source': 'CPU package energy · ' + ', '.join(packages) if packages else 'CPU energy counter unavailable',
                   'sampledAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'windowSeconds': round(now - last, 2), 'scope': 'package'}
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps(payload)); temporary.chmod(0o644); temporary.replace(output)
        previous, last = current, now
        time.sleep(interval)


if __name__ == '__main__': run()
