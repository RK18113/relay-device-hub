import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp, publicDevice } from '../server/app.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sample = {
  deviceId: 'test-desktop', sampledAt: new Date().toISOString(), hostname: 'desktop', os: 'Linux', cpuName: 'Generic CPU', cpuCores: 8,
  cpuPercent: 5, temperatureC: null, memoryTotalBytes: 1000, memoryUsedBytes: 400, diskTotalBytes: 10000, diskUsedBytes: 4000,
  diskFreeBytes: 6000, uptimeSeconds: 90, powerProfile: 'balanced', battery: null, gpu: null,
  network: { rxBytesPerSecond: 0, txBytesPerSecond: 0 }, processCount: 1,
  processes: [{ pid: 123, name: 'python', user: 'tester', cpuPercent: 3, memoryBytes: 100, memoryPercent: 10, state: 'S', arguments: 'sensitive-argument' }],
};
const headers = { 'tailscale-user-login': 'owner@example.test' };
async function fixture(t, options = {}) {
  const config = { allowedLogins: ['owner@example.test'], publicUrl: 'https://hub.example.test', devices: [
    { id: 'test-desktop', name: 'Desktop', kind: 'desktop', token: 'first-agent-key', local: true, agentPath: '/unpublished/path', agentConfig: '/private/config' },
    { id: 'test-laptop', name: 'Laptop', kind: 'laptop', token: 'second-agent-key', address: 'laptop.example.test', sshUser: 'tester' },
  ] };
  const rows = [];
  const store = { ingest: async value => rows.push({ ...value, receivedAt: new Date() }), devices: async () => rows, history: async () => [] };
  const app = createApp({ config, store, sourceDirectory: root, saveConfig: async () => {}, ...options });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  return { config, rows, request: (endpoint, init) => fetch(url + endpoint, init) };
}

test('production rejects missing identity and other tailnet accounts', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/devices')).status, 401);
  assert.equal((await request('/api/devices', { headers: { 'tailscale-user-login': 'someone@example.test' } })).status, 401);
  assert.equal((await request('/api/devices', { headers })).status, 200);
});
test('agent keys are device-bound and unknown report fields are stripped', async t => {
  const { request, rows } = await fixture(t);
  const post = (secret, body) => request('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret }, body: JSON.stringify(body) });
  assert.equal((await post('wrong-key', sample)).status, 401);
  assert.equal((await post('second-agent-key', sample)).status, 400);
  assert.equal((await post('first-agent-key', sample)).status, 202);
  assert.equal(rows[0].processes[0].arguments, undefined);
  assert.equal((await post('first-agent-key', sample)).status, 429);
});
test('the public device list never exposes keys, SSH credentials or process payloads', async t => {
  const { request, rows } = await fixture(t); rows.push({ ...sample, receivedAt: new Date() });
  const response = await request('/api/devices', { headers });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  for (const secret of ['first-agent-key', 'second-agent-key', '/private/config', 'sensitive-argument', 'laptop.example.test']) assert.equal(text.includes(secret), false);
  assert.equal(JSON.parse(text).devices[0].status, 'online');
});
test('stale and offline states depend on server receipt time', () => {
  const device = { id: 'device-a', token: 'private' };
  assert.equal(publicDevice(device, null).status, 'pending');
  assert.equal(publicDevice(device, { receivedAt: new Date(Date.now() - 120000) }).status, 'stale');
  assert.equal(publicDevice(device, { receivedAt: new Date(Date.now() - 360000) }).status, 'offline');
});
test('enrollment requires a same-origin owner request and validates SSH identifiers', async t => {
  const { request, config } = await fixture(t);
  const body = { name: 'Another computer', kind: 'server', address: 'server.example.test', sshUser: 'tester', intervalSeconds: 60 };
  const post = (data, origin) => request('/api/devices', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...(origin && { Origin: origin }) }, body: JSON.stringify(data) });
  assert.equal((await post(body)).status, 403);
  assert.equal((await post({ ...body, address: 'bad;command' }, config.publicUrl)).status, 400);
  const response = await post(body, config.publicUrl); assert.equal(response.status, 201);
  const data = await response.json(); assert.equal(data.device.token, undefined); assert.equal(config.devices.length, 3);
});
test('an enrollment bundle contains only its own private agent key', async t => {
  const { request } = await fixture(t);
  const response = await request('/api/devices/test-laptop/enrollment', { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
  assert.equal(JSON.parse(strFromU8(zip['device.json'])).token, 'second-agent-key');
  assert.equal(strFromU8(zip['device.json']).includes('first-agent-key'), false);
  assert.ok(zip['agent.py'] && zip['install-agent.py']);
});
test('offline devices cannot serve files', async t => {
  const { request } = await fixture(t);
  const response = await request('/api/files/test-desktop?root=home&path=', { headers });
  assert.equal(response.status, 503);
});

test('the frontend loads when installed beneath a hidden home directory', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-static-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, '.local', 'share', 'relay', 'dist');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'index.html'), '<main>Relay shell</main>');
  const { request } = await fixture(t, { distDirectory: directory });
  const response = await request('/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Relay shell/);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0');
});


test('CPU and GPU temperature readings and sensor labels survive ingestion', async t => {
  const { request, rows } = await fixture(t);
  const body = { ...sample, temperatureC: 72.5, temperatureSource: 'k10temp · Tctl',
    gpu: { name: 'GPU', state: 'P0', mode: 'nvidia', temperatureC: 64, temperatureSource: 'GPU core' } };
  const post = value => request('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer first-agent-key' }, body: JSON.stringify(value) });
  assert.equal((await post({ ...body, temperatureC: 999 })).status, 400);
  assert.equal((await post(body)).status, 202);
  assert.equal(rows[0].temperatureC, 72.5); assert.equal(rows[0].temperatureSource, 'k10temp · Tctl');
  assert.equal(rows[0].gpu.temperatureC, 64);
});

const actionHeaders = { ...headers, 'Content-Type': 'application/json', Origin: 'https://hub.example.test' };
function mockControls() {
  const calls = [];
  return { calls, controlTransport: async (_device, request) => {
    calls.push(request);
    if (request.operation === 'capabilities') return { capabilities: { reboot: { available: true }, lock: { available: true }, poweroff: { available: true } } };
    if (request.operation === 'execute') return { jobId: 'a'.repeat(32), status: 'scheduled' };
    return { status: 'requested', message: 'Accepted' };
  } };
}
test('device actions require owner, same origin, fresh device and one-use matching confirmation', async t => {
  const mock = mockControls(), { request, rows } = await fixture(t, mock);
  const post = (endpoint, body, h = actionHeaders) => request('/api/devices/test-desktop/actions' + endpoint, { method: 'POST', headers: h, body: JSON.stringify(body) });
  assert.equal((await post('/prepare', { action: 'reboot' }, { ...actionHeaders, 'tailscale-user-login': 'intruder@example.test' })).status, 401);
  assert.equal((await post('/prepare', { action: 'reboot' }, { ...actionHeaders, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/prepare', { action: 'reboot' })).status, 503);
  rows.push({ ...sample, receivedAt: new Date() });
  assert.equal((await post('/prepare', { action: 'shell' })).status, 400);
  const prepared = await (await post('/prepare', { action: 'reboot' })).json();
  const confirmation = { action: 'reboot', challenge: prepared.challenge, confirmation: 'Desktop', acknowledged: true };
  assert.equal((await post('', { ...confirmation, action: 'poweroff' })).status, 409);
  assert.equal((await post('', { ...confirmation, confirmation: 'Laptop' })).status, 400);
  assert.equal((await post('', { ...confirmation, acknowledged: false })).status, 400);
  assert.equal((await post('', confirmation)).status, 202);
  assert.equal((await post('', confirmation)).status, 409);
  assert.equal(mock.calls.filter(call => call.operation === 'execute').length, 1);
  assert.equal((await request('/api/devices/test-desktop/actions/' + 'a'.repeat(32), { headers })).status, 200);
  assert.equal((await request('/api/devices/test-laptop/actions/' + 'a'.repeat(32), { headers })).status, 404);
  assert.equal((await request('/api/devices/test-desktop/actions', { headers })).status, 404);
});
test('an expired action confirmation cannot execute', async t => {
  const mock = mockControls(), { request, rows } = await fixture(t, mock); rows.push({ ...sample, receivedAt: new Date() });
  const post = (suffix, body) => request('/api/devices/test-desktop/actions' + suffix, { method: 'POST', headers: actionHeaders, body: JSON.stringify(body) });
  const { challenge } = await (await post('/prepare', { action: 'lock' })).json();
  const original = Date.now; Date.now = () => original() + 61000;
  try { assert.equal((await post('', { action: 'lock', challenge, confirmation: 'Desktop', acknowledged: true })).status, 409); }
  finally { Date.now = original; }
  assert.equal(mock.calls.filter(call => call.operation === 'execute').length, 0);
});
test('lost action responses consume the challenge and cannot be retried automatically', async t => {
  let attempts = 0; const mock = mockControls();
  const transport = async (...args) => { if (args[1].operation === 'execute') { attempts++; throw new Error('Connection lost'); } return mock.controlTransport(...args); };
  const { request, rows } = await fixture(t, { controlTransport: transport }); rows.push({ ...sample, receivedAt: new Date() });
  const post = (suffix, body) => request('/api/devices/test-desktop/actions' + suffix, { method: 'POST', headers: actionHeaders, body: JSON.stringify(body) });
  const { challenge } = await (await post('/prepare', { action: 'poweroff' })).json();
  const body = { action: 'poweroff', challenge, confirmation: 'Desktop', acknowledged: true };
  assert.equal((await post('', body)).status, 503); assert.equal((await post('', body)).status, 409); assert.equal(attempts, 1);
});
test('measured power and capability metadata survive schema validation; enrollment includes helper modules', async t => {
  const { request, rows } = await fixture(t);
  const metric = { watts: 21.2, source: 'CPU package', scope: 'package', sampledAt: new Date().toISOString() };
  const body = { ...sample, power: { cpu: metric, gpu: { ...metric, watts: null, scope: 'board' }, system: { ...metric, watts: null, scope: 'unavailable' } }, controls: { lock: { available: true, reason: '' }, reboot: { available: false, reason: 'Permissions' }, poweroff: { available: false, reason: 'Permissions' } } };
  const response = await request('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer first-agent-key' }, body: JSON.stringify(body) });
  assert.equal(response.status, 202); assert.equal(rows[0].power.cpu.watts, 21.2); assert.equal(rows[0].power.system.watts, null);
  const zip = unzipSync(new Uint8Array(await (await request('/api/devices/test-laptop/enrollment', { headers })).arrayBuffer()));
  for (const name of ['relay_power.py', 'relay_controls.py', 'power_service.py', 'install-device-access.sh']) assert.ok(zip[name]);
});
