import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function startServer(t: TestContext): Promise<{ url: string; directory: string; workbookPath: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-master-workbook-http-'));
  const workbookPath = join(directory, 'master.xlsx');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], { env: { ...process.env, PORT: String(port), MAZAL_DATA_DIR: join(directory, 'data'), MAZAL_MASTER_WORKBOOK: workbookPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited; } rmSync(directory, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mazal master workbook server did not start.')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Mazal master workbook server exited with ${code}.`)); });
  });
  return { url: `http://127.0.0.1:${port}`, directory, workbookPath };
}

test('master workbook status follows the local file and downloads its exact bytes without changing finance data', async t => {
  const { url, directory, workbookPath } = await startServer(t);
  const initialFinance = await (await fetch(`${url}/api/state`)).json();
  const unavailable = { available: false, lastUpdatedAt: null, fileName: 'Mazal master.xlsx' };
  assert.deepEqual(await (await fetch(`${url}/api/master-workbook/status`)).json(), unavailable);
  assert.equal((await fetch(`${url}/api/master-workbook`)).status, 404);

  const bytes = Buffer.from('PK\x03\x04test workbook bytes');
  writeFileSync(workbookPath, bytes);
  const status = await fetch(`${url}/api/master-workbook/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { available: true, lastUpdatedAt: statSync(workbookPath).mtime.toISOString(), fileName: 'Mazal master.xlsx' });
  const download = await fetch(`${url}/api/master-workbook`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="Mazal master.xlsx"');
  assert.equal(download.headers.get('content-length'), String(bytes.length));
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

  const otherPath = join(directory, 'other.xlsx');
  writeFileSync(otherPath, 'unrelated private file');
  const queryDownload = await fetch(`${url}/api/master-workbook?path=${encodeURIComponent(otherPath)}&file=${encodeURIComponent(otherPath)}`);
  assert.deepEqual(Buffer.from(await queryDownload.arrayBuffer()), bytes);
  assert.deepEqual(await (await fetch(`${url}/api/master-workbook/status?workspace=demo`)).json(), unavailable);
  assert.equal((await fetch(`${url}/api/master-workbook?workspace=demo`)).status, 404);
  const demoState = await (await fetch(`${url}/api/state?workspace=demo`)).json();
  const demoRefresh = await fetch(`${url}/api/master-workbook/refresh?workspace=demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: demoState.revision }) });
  assert.equal(demoRefresh.status, 400);
  assert.match((await demoRefresh.json()).error, /live workspace/);
  assert.deepEqual(readFileSync(workbookPath), bytes);
  assert.deepEqual(await (await fetch(`${url}/api/state`)).json(), initialFinance);

  rmSync(workbookPath);
  assert.deepEqual(await (await fetch(`${url}/api/master-workbook/status`)).json(), unavailable);
  assert.equal((await fetch(`${url}/api/master-workbook`)).status, 404);
  mkdirSync(workbookPath);
  assert.deepEqual(await (await fetch(`${url}/api/master-workbook/status`)).json(), unavailable);
  assert.equal((await fetch(`${url}/api/master-workbook`)).status, 404);
});

test('master workbook endpoints reject writes, invalid workspaces, hostile hosts and cross-site access', async t => {
  const { url, workbookPath } = await startServer(t);
  const bytes = Buffer.from('PK\x03\x04original workbook');
  writeFileSync(workbookPath, bytes);
  for (const endpoint of ['/api/master-workbook', '/api/master-workbook/status']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const response = await fetch(`${url}${endpoint}`, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      await response.arrayBuffer();
    }
    assert.equal((await fetch(`${url}${endpoint}?workspace=other`)).status, 400);
    assert.equal((await fetch(`${url}${endpoint}`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(`${url}${endpoint}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => { const req = request(`${url}${endpoint}`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(badHostStatus, 403);
  }
  assert.deepEqual(readFileSync(workbookPath), bytes);
});
