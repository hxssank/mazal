import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.PORT ?? '5191');
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');

export default defineConfig({
  plugins: [react()],
  build: { target: ['chrome107', 'edge107', 'firefox104', 'safari16'] },
  server: { host: '127.0.0.1', port: 5190, strictPort: true, watch: { ignored: ['**/backend/.venv/**'] }, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
});
