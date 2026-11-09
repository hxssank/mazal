import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function startServer(t: TestContext, samplePreview = '0', recordsPreview = '0') {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-http-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], { env: { ...process.env, PORT: String(port), MAZAL_DATA_DIR: directory, MAZAL_MASTER_WORKBOOK: join(directory, 'workbook', 'Preview.xlsx'), MAZAL_SAMPLE_PREVIEW: samplePreview, MAZAL_RECORDS_PREVIEW: recordsPreview }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited; } rmSync(directory, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mazal server did not start.')), 5000);
    child.stdout.on('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Mazal server exited with ${code}.`)); });
  });
  return `http://127.0.0.1:${port}`;
}

test('HTTP rejects hostile hosts, cross-origin commands, invalid content types, and keeps demo separate', async t => {
  const url = await startServer(t);
  const state = await fetch(`${url}/api/state?workspace=live`);
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('x-mazal-data-source'), 'personal');
  assert.equal(state.headers.get('access-control-allow-origin'), null);
  assert.equal((await state.json()).accounts.length, 0);
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => { const req = request(`${url}/api/state`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(badHostStatus, 403);
  const badOrigin = await fetch(`${url}/api/command`, { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const crossSite = await fetch(`${url}/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const badType = await fetch(`${url}/api/command`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(badType.status, 415);
  const invalidWorkspace = await fetch(`${url}/api/state?workspace=other`);
  assert.equal(invalidWorkspace.status, 400);
  const addCommand = { type: 'add_account', entityId: 'personal', name: 'Test cash', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01', requestId: 'create-cash', expectedRevision: 0 };
  const post = (command: unknown) => fetch(`${url}/api/command?workspace=live`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(command) });
  for (const expectedRevision of [undefined, null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const rejected = await post({ ...addCommand, expectedRevision });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /revision/);
  }
  const missingRequest = await post({ ...addCommand, requestId: undefined });
  assert.equal(missingRequest.status, 400);
  assert.match((await missingRequest.json()).error, /request ID/);
  const add = await post(addCommand);
  assert.equal(add.status, 200);
  assert.equal((await add.json()).accounts[0].balanceCents, 10000);
  const replay = await post(addCommand);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).accounts.length, 1);
  const stale = await post({ ...addCommand, name: 'Stale account', requestId: 'create-stale' });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed in another window/);
  assert.equal((await (await fetch(`${url}/api/state?workspace=live`)).json()).accounts.length, 1);
  const demo = await fetch(`${url}/api/state?workspace=demo`);
  assert.equal(demo.headers.get('x-mazal-data-source'), 'sample');
  assert.equal((await demo.json()).accounts.length, 9);
  const backup = await fetch(`${url}/api/backup?workspace=live`);
  assert.match(backup.headers.get('content-disposition')!, /attachment/);
  assert.equal((await backup.json()).format, 'mazal-backup');
});

test('HTTP labels an isolated sample preview without changing the financial state', async t => {
  const url = await startServer(t, '1');
  for (const query of ['', '?workspace=live', '?workspace=demo']) {
    const response = await fetch(`${url}/api/state${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-mazal-data-source'), 'sample');
    const state = await response.json();
    assert.equal(state.workspace, query.endsWith('demo') ? 'demo' : 'live');
    assert.equal('dataSource' in state, false);
    const unchanged = await fetch(`${url}/api/state${query}`, { headers: { 'If-None-Match': response.headers.get('etag')! } });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get('x-mazal-data-source'), 'sample');
    assert.equal(await unchanged.text(), '');
  }
  const missing = await fetch(`${url}/api/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-mazal-data-source'), 'sample');
});

test('HTTP state validators omit unchanged bodies and distinguish metadata and workspaces', async t => {
  const url = await startServer(t);
  const initial = await fetch(`${url}/api/state`);
  const etag = initial.headers.get('etag')!;
  const initialState = await initial.json();
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  const unchanged = await fetch(`${url}/api/state`, { headers: { 'If-None-Match': etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get('etag'), etag);
  assert.equal(unchanged.headers.get('cache-control'), 'no-store');
  assert.equal(unchanged.headers.get('x-mazal-data-source'), 'personal');
  assert.equal(await unchanged.text(), '');
  const demo = await fetch(`${url}/api/state?workspace=demo`, { headers: { 'If-None-Match': etag } });
  assert.equal(demo.status, 200);
  assert.notEqual(demo.headers.get('etag'), etag);
  assert.equal(demo.headers.get('x-mazal-data-source'), 'sample');
  assert.equal((await demo.json()).workspace, 'demo');
  const backup = await (await fetch(`${url}/api/backup`)).json();
  const changed = await fetch(`${url}/api/state`, { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  const changedState = await changed.json();
  assert.equal(changedState.revision, initialState.revision);
  assert.equal(changedState.lastBackupAt, backup.data.lastBackupAt);
});

test('HTTP records previews label snapshots and reject financial and document writes', async t => {
  const url = await startServer(t, '0', '1');
  const state = await fetch(`${url}/api/state`);
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('x-mazal-data-source'), 'snapshot');
  const before = await state.json();
  const unchanged = await fetch(`${url}/api/state`, { headers: { 'If-None-Match': state.headers.get('etag')! } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get('x-mazal-data-source'), 'snapshot');
  assert.equal(await unchanged.text(), '');
  const documentsBefore = await (await fetch(`${url}/api/documents`)).json();
  const requests: [string, string, string][] = [
    ['POST', '/api/command', JSON.stringify({ type: 'add_account', entityId: 'personal', name: 'Preview cash', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01', requestId: 'preview-cash', expectedRevision: before.revision })],
    ['POST', '/api/backup/restore', '{}'],
    ['POST', '/api/documents', '%PDF-1.4\npreview fixture'],
    ['POST', '/api/master-workbook/refresh', JSON.stringify({ expectedRevision: before.revision })],
    ['PATCH', '/api/documents/example', '{}'],
    ['POST', '/api/engine/storage/archive', '{}'],
    ['DELETE', '/api/engine/runs', '{}'],
  ];
  for (const [method, path, body] of requests) {
    const response = await fetch(`${url}${path}`, { method, headers: { 'Content-Type': path === '/api/documents' ? 'application/octet-stream' : 'application/json' }, body });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(response.headers.get('x-mazal-data-source'), 'snapshot');
    assert.match((await response.json()).error, /read.only/i);
  }
  const backup = await fetch(`${url}/api/backup`);
  assert.equal(backup.status, 403);
  assert.match((await backup.json()).error, /read.only/i);
  assert.deepEqual(await (await fetch(`${url}/api/state`)).json(), before);
  assert.deepEqual((await (await fetch(`${url}/api/documents`)).json()).documents, documentsBefore.documents);
  const head = await fetch(`${url}/api/state`, { method: 'HEAD' });
  assert.notEqual(head.status, 403);
  assert.equal(head.headers.get('x-mazal-data-source'), 'snapshot');
  const demo = await fetch(`${url}/api/state?workspace=demo`);
  assert.equal(demo.status, 200);
  assert.equal(demo.headers.get('x-mazal-data-source'), 'sample');
});

test('HTTP records previews allow analysis request validation', async t => {
  const url = await startServer(t, '0', '1');
  for (const path of ['/api/engine/project', '/api/engine/runs']) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 400, path);
    assert.match((await response.json()).error, /revision/);
  }
  const cancel = await fetch(`${url}/api/engine/runs/preview-run?workspace=invalid`, { method: 'DELETE' });
  assert.equal(cancel.status, 400);
  assert.match((await cancel.json()).error, /workspace/);
});

test('HTTP sample process labels take precedence over records-preview labels', async t => {
  const url = await startServer(t, '1', '1');
  const response = await fetch(`${url}/api/state?workspace=live`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-mazal-data-source'), 'sample');
});
