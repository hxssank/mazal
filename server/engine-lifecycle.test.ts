import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitUntil(check: () => boolean, label: string, timeout = 10000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await delay(25);
  assert.ok(check(), label);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return process.platform !== 'linux' || !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch (error) { if (error instanceof Error && 'code' in error && ['ESRCH', 'ENOENT'].includes(String(error.code))) return false; throw error; }
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-engine-lifecycle-'));
  let child: ChildProcess | undefined, enginePid: number | undefined, output = '';
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    if (enginePid && alive(enginePid)) process.kill(-enginePid, 'SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    launch(args: string[], env: NodeJS.ProcessEnv = process.env) {
      child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout!.on('data', bytes => { output += bytes; });
      child.stderr!.on('data', bytes => { output += bytes; enginePid = Number(/Started server process \[(\d+)\]/.exec(output)?.[1]) || enginePid; });
      return child;
    },
    output: () => output,
    enginePid: () => enginePid,
  };
}

test('the real Python engine exits when its Node owner is forcibly terminated', { skip: process.platform === 'win32', timeout: 40000 }, async t => {
  const f = fixture(t);
  const script = `import { createEngineService } from ${JSON.stringify(new URL('./engine.ts', import.meta.url).href)};
const engine = createEngineService(${JSON.stringify(root)}, ${JSON.stringify(f.directory)});
console.log(JSON.stringify({ endpoint: await engine.start() }));`;
  const child = f.launch(['--input-type=module', '-e', script]);
  await waitUntil(() => f.output().includes('"endpoint"'), 'The engine became ready.', 30000);
  const pid = f.enginePid(); assert.ok(pid);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await waitUntil(() => !alive(pid), 'The orphaned Python engine stopped.');
});

test('shutdown stops Python before an unfinished HTTP upload has drained', { skip: process.platform === 'win32', timeout: 40000 }, async t => {
  const f = fixture(t);
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = f.launch(['server/index.ts'], { ...process.env, PORT: String(address.port), MAZAL_DATA_DIR: f.directory, MAZAL_MASTER_WORKBOOK: join(f.directory, 'master.xlsx') });
  await waitUntil(() => f.output().includes('Mazal is available'), 'The server became ready.', 15000);
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/api/engine/health`, { signal: AbortSignal.timeout(30000) });
  assert.equal(health.status, 200); await health.arrayBuffer();
  const pid = f.enginePid(); assert.ok(pid);
  const upload = request(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' } });
  upload.on('error', () => {});
  t.after(() => upload.destroy());
  upload.write('{');
  await once(upload, 'socket');
  await delay(100);
  child.kill('SIGTERM');
  await waitUntil(() => !alive(pid), 'Python stopped while the upload remained open.');
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  const exited = once(child, 'exit'); upload.destroy(); await exited;
  assert.equal(child.exitCode, 0);
});
