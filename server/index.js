import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { MongoStore } from './store.js';

const config = JSON.parse(fs.readFileSync(process.env.HUB_CONFIG, 'utf8'));
if (!process.env.MONGODB_URI || !config.allowedLogins?.length || !config.devices?.length) throw new Error('Relay configuration is incomplete.');
const store = new MongoStore(process.env.MONGODB_URI);
await store.connect();
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = createApp({ config, store, localPreview: process.env.HUB_LOCAL_PREVIEW === '1' && process.env.NODE_ENV !== 'production', distDirectory: path.join(root, 'dist'), sourceDirectory: root,
  saveConfig: async next => {
    const temporary = process.env.HUB_CONFIG + '.tmp';
    await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporary, process.env.HUB_CONFIG);
  } });
const server = app.listen(Number(process.env.PORT || 4310), '127.0.0.1', () => console.log('Relay is ready on the private loopback interface.'));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => server.close(async () => { await store.close(); process.exit(signal === 'SIGHUP' ? 75 : 0); }));
