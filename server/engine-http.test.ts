import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngineService, EngineError, type EngineTransport } from './engine.ts';
import { engineRoute, sendEngineResponse } from './routes/engine.ts';
import type { AppState, Workspace } from '../shared/types.ts';

const snapshot: AppState = { workspace: 'live', revision: 7, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
const identity = { expectedRevision: 7, scope: 'personal', asOf: '2026-09-26' };

async function serve(t: TestContext, engine: EngineTransport) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://127.0.0.1');
      const workspace = (url.searchParams.get('workspace') ?? 'live') as Workspace;
      const result = await engineRoute(request, url, workspace, async () => snapshot, engine);
      await sendEngineResponse(response, result);
    } catch (error) {
      response.writeHead(error instanceof EngineError ? error.status : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/api/engine`;
}

test('engine routes send server snapshots and validated revision identity', async t => {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const base = await serve(t, { async request(path, method, body) { calls.push({ path, method, body }); return { result: 'calculated' }; } });
  const summary = await fetch(`${base}/summary?${new URLSearchParams({ ...identity, expectedRevision: '7' })}`);
  assert.equal(summary.status, 200);
  assert.deepEqual(calls[0], { path: '/summary', method: 'POST', body: { snapshot, scope: 'personal', asOf: '2026-09-26' } });
  const project = await fetch(`${base}/project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, kind: 'planner', draft: { pay: '100' } }) });
  assert.equal(project.status, 200);
  assert.deepEqual(calls[1].body, { snapshot, scope: 'personal', asOf: '2026-09-26', kind: 'planner', draft: { pay: '100' } });
  const run = await fetch(`${base}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, assumptions: { months: 12 } }) });
  assert.equal(run.status, 202);
  assert.deepEqual(calls[2].body, { snapshot, scope: 'personal', asOf: '2026-09-26', kind: 'comparison', assumptions: { months: 12 } });
  assert.equal(snapshot.revision, 7);
});

test('invalid, stale, forged and oversized requests never invoke Python', async t => {
  let calls = 0;
  const base = await serve(t, { async request() { calls++; return {}; } });
  for (const [body, status] of [
    [{ ...identity, expectedRevision: 6 }, 409],
    [{ ...identity, expectedRevision: undefined }, 400],
    [{ ...identity, expectedRevision: '7' }, 400],
    [{ ...identity, scope: 'missing' }, 400],
    [{ ...identity, asOf: '2026-02-30' }, 400],
    [{ ...identity, asOf: '1900-12-31' }, 400],
    [{ ...identity, asOf: '2200-01-01' }, 400],
    [{ ...identity, snapshot: { revision: 7, accounts: [{ balanceCents: 999999999 }] } }, 400],
    [{ ...identity, draft: 'x'.repeat(512 * 1024) }, 413],
  ] as const) {
    const response = await fetch(`${base}/project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
  const invalidJson = await fetch(`${base}/project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
  const invalidType = await fetch(`${base}/project`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(invalidType.status, 415);
  const missingQuery = await fetch(`${base}/summary?scope=personal&asOf=2026-09-26`);
  assert.equal(missingQuery.status, 400);
  const wrongMethod = await fetch(`${base}/runs`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(calls, 0);
});

test('run reads and cancellation carry and check their workspace', async t => {
  const calls: string[] = [];
  const base = await serve(t, { async request(path, method) { calls.push(`${method} ${path}`); return { workspace: 'live', id: 'run-123', status: method === 'DELETE' ? 'cancelled' : 'completed' }; } });
  assert.equal((await fetch(`${base}/runs/run-123?workspace=live`)).status, 200);
  assert.equal((await fetch(`${base}/runs/run-123?workspace=live`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/runs/run-123?workspace=demo`)).status, 503);
  assert.deepEqual(calls, ['GET /runs/run-123?workspace=live', 'DELETE /runs/run-123?workspace=live', 'GET /runs/run-123?workspace=demo']);
});

test('engine failures are reported without a local calculation fallback', async t => {
  const base = await serve(t, { async request() { throw new EngineError(503, 'The financial engine is unavailable.'); } });
  const response = await fetch(`${base}/summary?scope=personal&asOf=2026-09-26&expectedRevision=7`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'The financial engine is unavailable.' });
});

test('engine service owns one authenticated process and stops it', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'mazal-engine-process-'));
  const backend = join(root, 'backend');
  mkdirSync(join(backend, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(backend, '.venv', 'bin', 'python'), `#!${process.execPath}\nconst http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer(async (request, response) => {
  if (request.headers['x-mazal-engine-key'] !== process.env.MAZAL_ENGINE_KEY) return response.writeHead(401).end('{}');
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  if (request.url === '/invalid') return response.writeHead(422, {'Content-Type':'application/json'}).end(JSON.stringify({error:'Input rejected'}));
  if (request.url === '/fail') return response.writeHead(500, {'Content-Type':'application/json'}).end(JSON.stringify({error:'Engine failed'}));
  if (request.url === '/incomplete') return response.end('invalid');
  if (request.url === '/worker') {
    const worker = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    return response.end(JSON.stringify({pid:worker.pid}));
  }
  response.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({pid:process.pid, authenticated:true, body:chunks.length?JSON.parse(Buffer.concat(chunks)):null, runDirectory:process.env.MAZAL_ENGINE_RUN_DIR, threadCount:process.env.OMP_NUM_THREADS}));
}).listen(port, '127.0.0.1');\n`, { mode: 0o700 });
  const engine = createEngineService(root, join(root, 'data'));
  t.after(async () => { await engine.close(); rmSync(root, { recursive: true, force: true }); });
  const replies = await Promise.all(Array.from({ length: 6 }, () => engine.request('/summary', 'POST', { test: true }))) as { pid: number; authenticated: boolean; body: unknown; runDirectory: string; threadCount: string }[];
  assert.equal(new Set(replies.map(reply => reply.pid)).size, 1);
  assert.deepEqual(replies[0].body, { test: true });
  assert.equal(replies[0].authenticated, true);
  assert.equal(replies[0].runDirectory, join(root, 'data', 'engine-runs'));
  assert.equal(replies[0].threadCount, '1');
  await assert.rejects(engine.request('/invalid'), error => error instanceof EngineError && error.status === 422);
  await assert.rejects(engine.request('/fail'), error => error instanceof EngineError && error.status === 503);
  await assert.rejects(engine.request('/incomplete'), error => error instanceof EngineError && error.status === 503);
  const worker = await engine.request('/worker') as { pid: number };
  t.after(() => { try { process.kill(worker.pid, 'SIGKILL'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; } });
  process.kill(replies[0].pid, 'SIGKILL');
  let recovered: { pid: number } | undefined;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const reply = await engine.request('/health') as { pid: number };
      if (reply.pid !== replies[0].pid) { recovered = reply; break; }
    } catch (error) { assert.ok(error instanceof EngineError && error.status === 503); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(recovered, 'The next request starts a new engine after the original engine exits.');
  assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' });
  await engine.close();
  assert.throws(() => process.kill(replies[0].pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(recovered.pid, 0), { code: 'ESRCH' });
  await assert.rejects(engine.request('/health'), error => error instanceof EngineError && error.status === 503);
});

test('missing Python environment fails with 503 without hanging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mazal-engine-missing-'));
  mkdirSync(join(root, 'backend'));
  const engine = createEngineService(root, join(root, 'data'));
  try { await assert.rejects(engine.request('/health'), error => error instanceof EngineError && error.status === 503); }
  finally { await engine.close(); rmSync(root, { recursive: true, force: true }); }
});

test('calculation storage forwards only selected identifiers and the server workspace', async t => {
  const id = '6c74ecc9-3374-4db7-af29-f84fe22b70be';
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const base = await serve(t, { async request(path, method, body) { calls.push({ path, method, body }); return { workspace: 'demo' }; } });
  assert.equal((await fetch(`${base}/storage?workspace=demo`)).status, 200);
  for (const [route, body] of [['archive', { runIds: [id] }], ['restore', { archiveId: id }]] as const) {
    const response = await fetch(`${base}/storage/${route}?workspace=demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls, [
    { path: '/storage?workspace=demo', method: 'GET', body: undefined },
    { path: '/storage/archive?workspace=demo', method: 'POST', body: { runIds: [id] } },
    { path: '/storage/restore?workspace=demo', method: 'POST', body: { archiveId: id } },
  ]);
  assert.equal((await fetch(`${base}/storage?workspace=live`)).status, 503);
});

test('invalid archive selections never reach Python', async t => {
  let calls = 0;
  const base = await serve(t, { async request() { calls++; return {}; } });
  const id = '6c74ecc9-3374-4db7-af29-f84fe22b70be';
  for (const [route, body] of [
    ['archive', { runIds: [] }], ['archive', { runIds: [id, id] }], ['archive', { runIds: ['../secret'] }],
    ['archive', { runIds: [id], workspace: 'demo' }], ['restore', { archiveId: '../secret' }],
    ['restore', { archiveId: id, snapshot: {} }],
  ]) {
    assert.equal((await fetch(`${base}/storage/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await fetch(`${base}/storage/archive`)).status, 405);
  assert.equal((await fetch(`${base}/storage`, { method: 'POST' })).status, 405);
  assert.equal(calls, 0);
});

test('verified archive downloads stream bytes with a fixed safe filename', async t => {
  const id = '6c74ecc9-3374-4db7-af29-f84fe22b70be';
  const content = new Uint8Array([80, 75, 3, 4, 0, 255]);
  const paths: string[] = [];
  const base = await serve(t, {
    async request() { throw new Error('Download must not use JSON transport'); },
    async download(path) { paths.push(path); return new Response(content, { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(content.length), 'X-Mazal-Workspace': 'live' } }); },
  });
  const response = await fetch(`${base}/storage/archives/${id}/download?workspace=live`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition')!, /mazal-calculations-6c74ecc9/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content);
  assert.deepEqual(paths, [`/storage/archives/${id}/download?workspace=live`]);
});

test('wrong-workspace and oversized downloads are rejected before streaming', async t => {
  const id = '6c74ecc9-3374-4db7-af29-f84fe22b70be';
  let workspace = 'demo';
  let length = '4';
  const base = await serve(t, { async request() { return {}; }, async download() { return new Response('data', { headers: { 'Content-Type': 'application/zip', 'Content-Length': length, 'X-Mazal-Workspace': workspace } }); } });
  assert.equal((await fetch(`${base}/storage/archives/${id}/download`)).status, 503);
  workspace = 'live'; length = String(130 * 1024 * 1024);
  assert.equal((await fetch(`${base}/storage/archives/${id}/download`)).status, 503);
});
