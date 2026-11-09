import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertMatchingBuild } from './mac-release-status.mjs';

export async function verifyMacRuntime(bundle, expected) {
  const temporary = await mkdtemp(join(tmpdir(), 'mazal-package-runtime-'));
  const data = join(temporary, 'data');
  await mkdir(data, { mode: 0o700 });
  const agentToken = randomBytes(32).toString('hex');
  await writeFile(join(temporary, 'local-agent-token'), agentToken, { mode: 0o600 });
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const resources = join(bundle, 'Contents', 'Resources');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MAZAL_') && !['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'NODE_OPTIONS'].includes(key)));
  Object.assign(env, { PORT: String(port), NODE_ENV: 'production', MAZAL_DATA_DIR: data, MAZAL_MASTER_WORKBOOK: join(temporary, 'workbook.xlsx'), MAZAL_DESKTOP_TOKEN: randomBytes(32).toString('hex'), MAZAL_ENGINE_AUTOSTART: '1', PYTHONDONTWRITEBYTECODE: '1', MPLCONFIGDIR: join(temporary, 'matplotlib') });
  const child = spawn(join(resources, 'runtime', 'node'), ['server/index.ts'], { cwd: join(resources, 'app'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', launchError;
  const collect = bytes => { logs = (logs + bytes).slice(-6000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.on('error', error => { launchError = error; });
  const request = (path, authenticated = true) => fetch(`http://127.0.0.1:${port}${path}`, { headers: authenticated ? { Authorization: `Bearer ${agentToken}` } : {}, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  try {
    const deadline = Date.now() + 45_000;
    while (!logs.includes('Mazal is available')) {
      if (launchError || child.exitCode !== null || child.signalCode !== null) throw new Error(`The packaged server could not start: ${launchError?.message ?? logs}`);
      if (Date.now() >= deadline) throw new Error(`The packaged server did not start in 45 seconds. ${logs}`);
      await delay(100);
    }
    const locked = await request('/', false);
    await locked.body?.cancel();
    assert.equal(locked.status, 401, 'The packaged app must reject an unauthenticated browser.');
    const identityResponse = await request('/api/build-status');
    assert.equal(identityResponse.status, 200);
    const runtime = await identityResponse.json();
    assert.equal(runtime.identityStatus, 'available');
    assert.equal(runtime.processId, child.pid, 'The runtime response must belong to the packaged process started for this check.');
    assertMatchingBuild(runtime.build, expected, 'The packaged server');
    const stateResponse = await request('/api/state?workspace=live');
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.revision, 0);
    assert.equal(state.transactions.length, 0, 'Package verification must use empty isolated records.');
    const healthResponse = await request('/api/engine/health');
    assert.equal(healthResponse.status, 200);
    const engine = await healthResponse.json();
    assert.equal(engine.status, 'ok');
    const summaryResponse = await request(`/api/engine/summary?workspace=live&scope=personal&expectedRevision=0&asOf=2026-01-01`);
    assert.equal(summaryResponse.status, 200);
    assert.equal((await summaryResponse.json()).result.summary.netWorthCents, 0);
    return { status: 'passed', sourceSha256: runtime.build.sourceSha256, assetsSha256: runtime.build.assetsSha256, engineModel: engine.modelVersion, protectedUi: true, isolatedRevision: state.revision };
  } finally {
    let timer;
    try {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        const stopped = once(child, 'exit');
        child.kill('SIGTERM');
        const [code, signal] = await Promise.race([stopped, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The packaged server did not stop within 15 seconds.')), 15_000); })]);
        assert.equal(signal, null, `The packaged server terminated from ${signal} instead of completing shutdown.`);
        assert.equal(code, 0, 'The packaged server must complete shutdown without an error.');
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null && child.pid) child.kill('SIGKILL');
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
