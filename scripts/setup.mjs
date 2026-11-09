import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runNpm } from './process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeVersion = (await readFile(join(root, '.node-version'), 'utf8')).trim();
const pythonVersion = (await readFile(join(root, 'backend/.python-version'), 'utf8')).trim();
if (process.versions.node !== nodeVersion) throw new Error(`This checkpoint requires Node.js ${nodeVersion}; found ${process.versions.node}.`);
const env = { ...process.env, UV_PROJECT_ENVIRONMENT: join(root, 'backend/.venv') };
let uvVersion;
try { uvVersion = execFileSync('uv', ['--version'], { cwd: root, env, encoding: 'utf8' }).trim(); }
catch { throw new Error('Install uv 0.13.1 on PATH, then run setup again.'); }
if (!/^uv 0\.13\.1(?:\s|$)/.test(uvVersion)) throw new Error(`This checkpoint requires uv 0.13.1; found ${uvVersion}.`);
console.log(uvVersion);
await runNpm(['ci', '--no-audit', '--no-fund'], { cwd: root, env });
await run('uv', ['lock', '--project', 'backend', '--check', '--python', pythonVersion], { cwd: root, env });
await run('uv', ['sync', '--project', 'backend', '--frozen', '--python', pythonVersion], { cwd: root, env });
console.log('Dependencies installed from the lockfiles. Run npm run build, then npm start.');
