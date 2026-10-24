import { spawn } from 'node:child_process';

// Only this fixed agent entry point crosses SSH. Request values travel as JSON.
export function controlDevice(device, request) {
  return new Promise((resolve, reject) => {
    const child = device.local
      ? spawn('python3', [device.agentPath, '--config', device.agentConfig, 'control'], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('tailscale', ['ssh', `${device.sshUser}@${device.address}`,
        'python3 "$HOME/.local/share/relay/agent.py" --config "$HOME/.config/relay/agent.json" control'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Device did not respond. Check its status before retrying an action.')); }, 20000);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 16384) { child.kill(); finish(new Error('Invalid device response.')); }
    });
    child.on('error', () => finish(new Error('Device controls are unavailable.')));
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error();
        const value = JSON.parse(output);
        if (!value || typeof value !== 'object' || value.error) throw new Error();
        finish(null, value);
      } catch { finish(new Error('Device refused the request. Check its agent, permissions and SSH connection.')); }
    });
  });
}
