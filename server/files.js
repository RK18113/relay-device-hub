import { spawn } from 'node:child_process';

export function fileProcess(device, action, root, filePath) {
  const args = [device.agentPath, '--config', device.agentConfig, 'files'];
  const command = device.local ? 'python3' : 'tailscale';
  const commandArgs = device.local ? args : ['ssh', `${device.sshUser}@${device.address}`,
    'python3 "$HOME/.local/share/relay/agent.py" --config "$HOME/.config/relay/agent.json" files'];
  const child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ action, root, path: filePath }));
  // Do not log SSH diagnostics or user paths into the web response.
  child.stderr.resume();
  return child;
}

export function readListing(device, root, filePath) {
  return new Promise((resolve, reject) => {
    const child = fileProcess(device, 'list', root, filePath);
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Device did not respond. Wake it and retry.')); }, 15000);
    child.stdout.on('data', data => {
      buffer += data.toString();
      if (buffer.length > 2e6) { child.kill(); reject(new Error('Folder response was too large.')); }
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('File access is unavailable.')); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error();
        const result = JSON.parse(buffer);
        if (!['listing', 'error'].includes(result.type)) throw new Error();
        resolve(result);
      } catch { reject(new Error('Device did not return a folder listing.')); }
    });
  });
}

export function streamDownload(device, root, filePath, res) {
  const child = fileProcess(device, 'download', root, filePath);
  let buffer = Buffer.alloc(0), started = false;
  const timer = setTimeout(() => {
    child.kill();
    if (!res.headersSent) res.status(504).json({ error: 'Device did not respond. Wake it and retry.' });
  }, 15000);
  const data = chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(10);
    if (newline < 0 && buffer.length < 8192) return;
    clearTimeout(timer);
    child.stdout.off('data', data);
    try {
      if (newline < 0 || newline > 8192) throw new Error();
      const header = JSON.parse(buffer.subarray(0, newline).toString());
      if (header.type === 'error') {
        res.status(Number(header.status) || 403).json({ error: header.message }); child.kill(); return;
      }
      if (header.type !== 'download' || !Number.isSafeInteger(header.size) || header.size < 0 || typeof header.name !== 'string') throw new Error();
      started = true;
      res.attachment(header.name.replace(/[\x00-\x1f\x7f]/g, '_'));
      res.setHeader('Content-Length', header.size);
      res.setHeader('Cache-Control', 'no-store');
      const remaining = buffer.subarray(newline + 1);
      if (remaining.length && !res.write(remaining)) {
        child.stdout.pause(); res.once('drain', () => child.stdout.resume());
      }
      child.stdout.pipe(res);
    } catch {
      child.kill();
      if (!res.headersSent) res.status(502).json({ error: 'File could not be downloaded.' });
    }
  };
  child.stdout.on('data', data);
  child.on('error', () => {
    clearTimeout(timer);
    if (!res.headersSent) res.status(503).json({ error: 'File access is unavailable.' });
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (!started && !res.headersSent) res.status(502).json({ error: 'Device could not provide this file.' });
    else if (code !== 0 && !res.writableEnded) res.destroy();
  });
  res.on('close', () => child.kill());
}
