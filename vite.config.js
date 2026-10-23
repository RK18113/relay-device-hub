import { defineConfig } from 'vite';
export default defineConfig({
  server: { port: 5173, strictPort: true, proxy: { '/api': process.env.HUB_API_URL || 'http://127.0.0.1:4310' } },
  build: { outDir: 'dist', sourcemap: false },
});
