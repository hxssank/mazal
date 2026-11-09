import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const apiOnly = process.argv.includes('--api');
const children = [
  spawn(process.execPath, ['--watch', 'server/index.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, MAZAL_ENGINE_AUTOSTART: '1' } }),
  ...apiOnly ? [] : [spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: root, stdio: 'inherit' })],
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
