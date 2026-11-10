import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

test('the production launcher rejects development origins even when the parent uses development mode', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-production-start-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['scripts/start.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), MAZAL_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', bytes => { output += bytes; });
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
      else child.kill('SIGTERM');
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Production server did not start. ${output}`)), 15000);
    child.stdout.on('data', bytes => {
      if (String(bytes).includes('Mazal is available')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Production server exited with ${code}. ${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const sameOrigin = await fetch(`${base}/api/state`, { headers: { Origin: base } });
  assert.equal(sameOrigin.status, 200);
  assert.equal((await sameOrigin.json()).revision, 0);
  assert.match(sameOrigin.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(sameOrigin.headers.get('cache-control'), 'no-store');
  for (const origin of ['http://127.0.0.1:5190', 'http://localhost:5173', 'https://example.com']) {
    const response = await fetch(`${base}/api/state`, { headers: { Origin: origin } });
    assert.equal(response.status, 403, origin);
    await response.arrayBuffer();
  }
});
