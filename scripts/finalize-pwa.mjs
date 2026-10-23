import fs from 'node:fs/promises';
const files = await fs.readdir('dist/assets');
const assets = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/font.css', ...files.map(file => '/assets/' + file)];
const sw = await fs.readFile('dist/sw.js', 'utf8');
await fs.writeFile('dist/sw.js', sw.replace(/^const PRECACHE = .*;$/m, 'const PRECACHE = ' + JSON.stringify(assets) + ';'));
console.log(`PWA shell prepared: ${assets.length} local assets. Private API responses are never cached.`);
