import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { z } from 'zod';
import { snapshotSchema } from './schema.js';
import { controlDevice } from './controls.js';
import { readListing, streamDownload } from './files.js';

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function publicDevice(device, snapshot) {
  const receivedAt = snapshot?.receivedAt;
  const age = receivedAt ? Date.now() - new Date(receivedAt).getTime() : Infinity;
  const { token, address, sshUser, agentPath, agentConfig, local, ...metadata } = device;
  const onlineWindow = Math.max(90000, (device.intervalSeconds || 30) * 3000);
  return { ...metadata, status: age < onlineWindow ? 'online' : age < Math.max(300000, onlineWindow * 2) ? 'stale' : receivedAt ? 'offline' : 'pending',
    hostsRelay: Boolean(device.local), receivedAt: receivedAt || null, snapshot: snapshot ? Object.fromEntries(Object.entries(snapshot).filter(([k]) => !['_id', 'processes'].includes(k))) : null };
}

export function createApp({ config, store, localPreview = false, distDirectory, saveConfig, sourceDirectory, controlTransport = controlDevice }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"], 'object-src': ["'none'"], 'frame-ancestors': ["'none'"] } } }));
  app.use(express.json({ limit: '512kb', strict: true }));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  const reportTimes = new Map();
  app.post('/api/ingest', async (req, res) => {
    const authorization = req.get('authorization') || '';
    const secret = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const device = config.devices.find(item => equal(item.token, secret));
    if (!device) return res.status(401).json({ error: 'Agent authentication required.' });
    const parsed = snapshotSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.deviceId !== device.id) return res.status(400).json({ error: 'Invalid device report.' });
    const last = reportTimes.get(device.id) || 0;
    if (Date.now() - last < 5000) return res.status(429).json({ error: 'Please wait before reporting again.' });
    await store.ingest(parsed.data);
    reportTimes.set(device.id, Date.now());
    res.status(202).json({ accepted: true });
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const login = req.get('tailscale-user-login');
    if (!local || (!localPreview && !config.allowedLogins.includes(login))) return res.status(401).json({ error: 'Open Relay through your private Tailscale address.' });
    req.relayUser = localPreview ? config.allowedLogins[0] : login;
    next();
  });
  app.get('/api/session', (req, res) => res.json({ user: req.relayUser, private: true, version: '1.0.0', preview: localPreview,
    intervalSeconds: 30, historyHours: 48, filesReadOnly: true }));
  app.get('/api/devices', async (_req, res) => {
    const rows = await store.devices();
    res.json({ devices: config.devices.map(device => publicDevice(device, rows.find(row => row.deviceId === device.id))), serverTime: new Date().toISOString() });
  });
  const newDeviceSchema = z.object({
    name: z.string().trim().min(1).max(60), kind: z.enum(['desktop', 'laptop', 'server']),
    address: z.string().max(180).regex(/^[a-zA-Z0-9.:-]*$/).default(''),
    sshUser: z.string().max(64).regex(/^([a-zA-Z_][a-zA-Z0-9_-]*[$]?)?$/).default(''),
    intervalSeconds: z.number().int().min(15).max(300).default(30),
    nvidiaMonitor: z.boolean().default(false),
  });
  let configQueue = Promise.resolve();
  app.post('/api/devices', async (req, res) => {
    const origin = req.get('origin');
    const expected = config.publicUrl && new URL(config.publicUrl).origin;
    if (!localPreview && (!origin || origin !== expected)) return res.status(403).json({ error: 'Use this workspace to add a device.' });
    if (!saveConfig) return res.status(503).json({ error: 'Device enrollment is not configured.' });
    const result = newDeviceSchema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ error: 'Check the device name, SSH address, username and interval.' });
    const value = result.data;
    if (Boolean(value.address) !== Boolean(value.sshUser)) return res.status(400).json({ error: 'Provide both the SSH address and username, or leave both empty.' });
    const id = `${value.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'device'}-${randomBytes(4).toString('hex')}`;
    const device = { id: /^[a-z]/.test(id) ? id : 'd-' + id, name: value.name, kind: value.kind,
      role: value.kind === 'laptop' ? 'PORTABLE DEVICE' : value.kind === 'server' ? 'SERVER' : 'DESKTOP',
      description: 'Linux device', token: randomBytes(32).toString('hex'), local: false,
      address: value.address, sshUser: value.sshUser, intervalSeconds: value.intervalSeconds, nvidiaMonitor: value.nvidiaMonitor };
    const change = configQueue.then(async () => {
      const devices = [...config.devices, device];
      await saveConfig({ ...config, devices });
      config.devices = devices;
    });
    configQueue = change.catch(() => {});
    await change;
    res.status(201).json({ device: publicDevice(device, null) });
  });
  app.get('/api/devices/:id/enrollment', async (req, res) => {
    const device = config.devices.find(item => item.id === req.params.id);
    if (!device || !sourceDirectory) return res.status(404).json({ error: 'Device not found.' });
    const agentConfig = { device_id: device.id, server_url: config.publicUrl, token: device.token,
      interval_seconds: device.intervalSeconds || 30, nvidia_monitor: device.nvidiaMonitor || false };
    const files = ['agent/agent.py', 'agent/relay_power.py', 'agent/relay_controls.py', 'agent/power_service.py',
      'scripts/install-agent.py', 'scripts/install-device-access.sh'];
    const archiveFiles = Object.fromEntries(await Promise.all(files.map(async filename => [path.basename(filename), new Uint8Array(await fs.readFile(path.join(sourceDirectory, filename)))])));
    const archive = zipSync({ ...archiveFiles,
      'device.json': strToU8(JSON.stringify(agentConfig, null, 2)),
      'README.txt': strToU8('On the Linux device, extract this folder and run:\npython3 install-agent.py --config device.json\n\nOptional CPU power sampling and reboot/shutdown permissions:\nsudo bash install-device-access.sh\n\nThe configuration contains a private agent key. Keep it on your own device.\n') });
    res.setHeader('Content-Type', 'application/zip');
    res.attachment(`relay-${device.id}.zip`).send(Buffer.from(archive));
  });
  app.get('/api/devices/:id/processes', async (req, res) => {
    if (!config.devices.some(device => device.id === req.params.id)) return res.status(404).json({ error: 'Device not found.' });
    const row = (await store.devices()).find(item => item.deviceId === req.params.id);
    res.json({ processes: row?.processes || [], total: row?.processCount || 0, receivedAt: row?.receivedAt || null });
  });
  app.get('/api/devices/:id/history', async (req, res) => {
    if (!config.devices.some(device => device.id === req.params.id)) return res.status(404).json({ error: 'Device not found.' });
    res.json({ points: await store.history(req.params.id) });
  });
  const challenges = new Map(), jobs = new Map();
  const actionSchema = z.enum(['lock', 'reboot', 'poweroff']);
  const ownerOrigin = (req, res, next) => {
    const origin = req.get('origin');
    const expected = localPreview ? `http://${req.get('host')}` : config.publicUrl && new URL(config.publicUrl).origin;
    if (!origin || origin !== expected) return res.status(403).json({ error: 'Use this workspace to request device actions.' });
    next();
  };
  async function actionableDevice(req, res, next) {
    const device = config.devices.find(item => item.id === req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found.' });
    if (!device.local && (!device.address || !device.sshUser)) return res.status(503).json({ error: 'Configure Tailscale SSH for device controls.' });
    const row = (await store.devices()).find(item => item.deviceId === device.id);
    if (!row || publicDevice(device, row).status !== 'online') return res.status(503).json({ error: 'This device has no recent report. Wake it before requesting an action.' });
    req.relayDevice = device; next();
  }
  function prune() {
    for (const [key, value] of challenges) if (value.expires < Date.now()) challenges.delete(key);
    for (const [key, value] of jobs) if (value.expires < Date.now()) jobs.delete(key);
  }
  app.post('/api/devices/:id/actions/prepare', ownerOrigin, actionableDevice, async (req, res) => {
    prune();
    const parsed = actionSchema.safeParse(req.body.action);
    if (!parsed.success) return res.status(400).json({ error: 'Choose lock, reboot or poweroff.' });
    if (challenges.size >= 100) return res.status(429).json({ error: 'Too many pending confirmations. Please wait a minute.' });
    try {
      const result = await controlTransport(req.relayDevice, { operation: 'capabilities' });
      if (result.capabilities?.[parsed.data]?.available !== true) return res.status(409).json({ error: result.capabilities?.[parsed.data]?.reason || 'This device action is unavailable.' });
      const challenge = randomBytes(32).toString('hex');
      challenges.set(challenge, { device: req.relayDevice.id, action: parsed.data, user: req.relayUser, expires: Date.now() + 60000 });
      res.json({ challenge, expiresInSeconds: 60, hostsRelay: Boolean(req.relayDevice.local) });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.post('/api/devices/:id/actions', ownerOrigin, actionableDevice, async (req, res) => {
    prune();
    const parsed = z.object({ action: actionSchema, challenge: z.string().regex(/^[a-f0-9]{64}$/),
      confirmation: z.string().max(60), acknowledged: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Confirm the device action before continuing.' });
    const value = parsed.data, pending = challenges.get(value.challenge);
    if (!pending || pending.device !== req.relayDevice.id || pending.action !== value.action || pending.user !== req.relayUser)
      return res.status(409).json({ error: 'Confirmation expired or already used. Open the confirmation again.' });
    if (value.confirmation !== req.relayDevice.name) return res.status(400).json({ error: 'The device name does not match.' });
    // Consume before contacting the device: a lost response must never execute twice.
    challenges.delete(value.challenge);
    try {
      const result = await controlTransport(req.relayDevice, { operation: 'execute', action: value.action });
      if (!/^[a-f0-9]{32}$/.test(result.jobId || '') || result.status !== 'scheduled') throw new Error('The device did not schedule this action.');
      jobs.set(result.jobId, { device: req.relayDevice.id, user: req.relayUser, expires: Date.now() + 3600000 });
      res.status(202).json({ jobId: result.jobId, status: 'scheduled', delaySeconds: 3 });
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/devices/:id/actions/:job', async (req, res) => {
    prune();
    const job = jobs.get(req.params.job), device = config.devices.find(item => item.id === req.params.id);
    if (!job || !device || job.device !== device.id || job.user !== req.relayUser) return res.status(404).json({ error: 'Action not found.' });
    try {
      const result = await controlTransport(device, { operation: 'status', jobId: req.params.job });
      const status = ['scheduled', 'requested', 'failed', 'unknown'].includes(result.status) ? result.status : 'unknown';
      res.json({ status, message: typeof result.message === 'string' ? result.message.slice(0, 300) : 'No action status available.' });
    } catch { res.status(503).json({ error: 'Device disconnected. The action may have run; check its state before retrying.' }); }
  });
  async function fileDevice(req, res, next) {
    const device = config.devices.find(item => item.id === req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found.' });
    if (!device.local && (!device.address || !device.sshUser)) return res.status(503).json({ error: 'Add this device’s Tailscale SSH address and username to enable file browsing.' });
    const row = (await store.devices()).find(item => item.deviceId === device.id);
    if (!row || Date.now() - new Date(row.receivedAt).getTime() > Math.max(90000, (device.intervalSeconds || 30) * 3000)) return res.status(503).json({ error: 'This device is offline. Wake it to browse files.' });
    if (typeof req.query.root !== 'string' || typeof (req.query.path ?? '') !== 'string' || req.query.root.length > 80 || (req.query.path || '').length > 4096) return res.status(400).json({ error: 'Invalid folder request.' });
    req.relayDevice = device;
    next();
  }
  app.get('/api/files/:id', fileDevice, async (req, res) => {
    try {
      const listing = await readListing(req.relayDevice, req.query.root, req.query.path || '');
      if (listing.type === 'error') return res.status(listing.status || 403).json({ error: listing.message });
      res.json(listing);
    } catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.get('/api/files/:id/download', fileDevice, (req, res) => streamDownload(req.relayDevice, req.query.root, req.query.path || '', res));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  if (distDirectory) {
    app.use(express.static(distDirectory, { index: false, setHeaders(res, filename) {
      res.setHeader('Cache-Control', filename.endsWith('sw.js') || filename.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600');
    } }));
    app.get('/{*splat}', (_req, res) => res.sendFile('index.html', { root: distDirectory }));
  }
  app.use((error, _req, res, _next) => {
    console.error('Relay request failed:', error.name || 'Error');
    if (!res.headersSent) res.status(error.type === 'entity.too.large' ? 413 : 500).json({ error: 'The request could not be completed.' });
  });
  return app;
}
