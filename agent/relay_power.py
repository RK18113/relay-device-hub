"""Read cached CPU power, GPU telemetry and explicitly scoped system power."""
import datetime
import json
import math
from pathlib import Path
import time


def valid_watts(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 100000 else None


def fresh_reading(path, max_age=30):
    try:
        if Path(path).stat().st_size > 8192: return None
        value = json.loads(Path(path).read_text())
        if not isinstance(value, dict) or not isinstance(value.get('sampledAt'), str): return None
        age = time.time() - datetime.datetime.fromisoformat(value['sampledAt'].replace('Z', '+00:00')).timestamp()
        if not 0 <= age <= max_age or valid_watts(value.get('watts')) is None: return None
        return value
    except (OSError, ValueError, TypeError, KeyError): return None


def collect_power(config, battery, gpu, cpu_path=Path('/run/relay-power/power.json'), supplies=Path('/sys/class/power_supply')):
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    cpu = fresh_reading(cpu_path)
    result = {'cpu': {'watts': cpu['watts'] if cpu else None,
                      'source': str(cpu.get('source', 'CPU package energy'))[:150] if cpu else 'CPU power sampler not available',
                      'sampledAt': cpu['sampledAt'] if cpu else None, 'scope': 'package'},
              'gpu': {'watts': valid_watts(gpu.get('powerW')) if gpu else None,
                      'source': 'NVIDIA board power' if gpu and gpu.get('mode') == 'nvidia' else 'GPU power sensor unavailable',
                      'sampledAt': gpu.get('sampledAt') if gpu else None, 'scope': 'board'},
              'system': {'watts': None, 'source': 'External power meter required', 'scope': 'unavailable', 'sampledAt': None}}
    meter = fresh_reading(config.get('system_power_file', '/nonexistent/relay-power-meter'), 90)
    if meter:
        result['system'] = {'watts': meter['watts'], 'source': str(meter.get('source', 'External power meter'))[:150], 'scope': 'wall', 'sampledAt': meter['sampledAt']}
        return result
    ac_online = False
    for supply in supplies.glob('*'):
        try:
            if (supply / 'type').read_text().strip() != 'Battery' and (supply / 'online').read_text().strip() == '1': ac_online = True
        except OSError: pass
    if battery and battery.get('status') == 'Discharging' and not ac_online and valid_watts(battery.get('powerW')) is not None:
        result['system'] = {'watts': battery['powerW'], 'source': 'Battery discharge · system draw', 'scope': 'battery', 'sampledAt': stamp}
    elif battery:
        result['system']['source'] = 'System draw available on battery or with an external meter'
    return result
