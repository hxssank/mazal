import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopAuth } from './desktop-auth.ts';
import { availableTestPort, waitForTestServer } from './test-server.ts';

test('desktop records refuse startup without a valid launcher token', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-desktop-marker-'));
  try {
    assert.equal(createDesktopAuth(directory, undefined).enabled, false);
    writeFileSync(join(directory, '.desktop-only'), '');
    assert.throws(() => createDesktopAuth(directory, undefined), /Open Mazal.app/);
    for (const token of ['', 'short', 'z'.repeat(64)]) assert.throws(() => createDesktopAuth(directory, token), /token/);
    assert.equal(createDesktopAuth(directory, randomBytes(32).toString('hex')).enabled, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('desktop authentication protects records, exports and assets and rejects replay and cross-origin unlocks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-desktop-http-'));
  const token = randomBytes(32).toString('hex');
  const port = await availableTestPort();
  const child = spawn(process.execPath, ['server/index.ts'], { env: { ...process.env, NODE_ENV: 'production', MAZAL_ENGINE_AUTOSTART: '0', PORT: String(port), MAZAL_DATA_DIR: directory, MAZAL_DESKTOP_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await waitForTestServer(child, 'Desktop server', 10_000);
  const base = `http://127.0.0.1:${port}`;
  const paths = ['/', '/assets/main.js', '/private/', '/api/state', '/api/transactions', '/api/documents', '/api/documents/export', '/api/backup', '/api/complete-backup', '/api/complete-backup/preview', '/api/complete-backup/restore', '/api/master-workbook', '/api/engine/health'];
  for (const path of paths) assert.equal((await fetch(`${base}${path}`)).status, 401, path);
  assert.deepEqual(await (await fetch(`${base}/api/desktop/health`)).json(), { ready: true, instance: createHash('sha256').update(token).digest('hex') });
  const unlock = (body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/desktop/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await unlock({ token: '0'.repeat(64) })).status, 401);
  assert.equal((await unlock({ token }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await unlock({ token }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await unlock({ token: 'x'.repeat(2000) })).status, 413);
  const response = await unlock({ token });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie')!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.ok(!setCookie.includes(token));
  const cookie = setCookie.split(';')[0];
  const records = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
  assert.equal(records.status, 200);
  assert.equal((await records.json()).revision, 0);
  const etag = records.headers.get('etag')!;
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie, 'If-None-Match': etag } })).status, 304);
  const unauthenticated = await fetch(`${base}/api/state`, { headers: { 'If-None-Match': etag } });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('etag'), null);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: `${cookie}; ${cookie}` } })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: `${cookie}x` } })).status, 401);
  assert.equal((await fetch(`${base}/api/state?token=${token}`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await unlock({ token })).status, 401);
  const revoke = (secret: string) => fetch(`${base}/api/desktop/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }) });
  assert.equal((await revoke('0'.repeat(64))).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await revoke(token)).status, 200);
  const lockedConditional = await fetch(`${base}/api/state`, { headers: { Cookie: cookie, 'If-None-Match': etag } });
  assert.equal(lockedConditional.status, 401);
  assert.equal(lockedConditional.headers.get('etag'), null);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 401);
  const reopened = await unlock({ token }); assert.equal(reopened.status, 200);
  const nextCookie = reopened.headers.get('set-cookie')!.split(';')[0]; assert.notEqual(nextCookie, cookie);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: nextCookie } })).status, 200);

});

test('local agent access is opt-in, survives desktop locking and restarts, and revokes with its private credential file', { skip: !process.getuid }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-local-agent-'));
  const dataDirectory = join(directory, 'data');
  mkdirSync(dataDirectory);
  const credential = join(directory, 'local-agent-token');
  const desktopToken = randomBytes(32).toString('hex');
  const agentToken = randomBytes(32).toString('hex');
  let auth = createDesktopAuth(dataDirectory, desktopToken);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (await auth.handle(request, response, pathname)) return;
    response.end('authorized');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const agent = (pathname = '/api/state', token = agentToken, headers: Record<string, string> = {}) => fetch(`${base}${pathname}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  assert.equal((await agent()).status, 401);
  writeFileSync(credential, `${agentToken}\n`, { mode: 0o600 });
  const challenge = randomBytes(32).toString('hex');
  const proofPath = `/api/desktop/agent-health?challenge=${challenge}`;
  const proof = await fetch(`${base}${proofPath}`);
  assert.equal(proof.status, 200);
  assert.equal(proof.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await proof.json(), { ready: true, proof: createHmac('sha256', agentToken).update(`mazal-local-agent:${challenge}`).digest('hex') });
  assert.equal((await fetch(`${base}/api/desktop/agent-health`)).status, 400);
  assert.equal((await fetch(`${base}${proofPath}&challenge=${challenge}`)).status, 400);
  assert.equal((await fetch(`${base}/api/desktop/agent-health?challenge=short`)).status, 400);
  assert.equal((await fetch(`${base}${proofPath}`, { method: 'POST' })).status, 405);
  const proofBrowserHeaders: Record<string, string>[] = [{ Origin: base }, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Dest': 'empty' }];
  for (const headers of proofBrowserHeaders) {
    assert.equal((await fetch(`${base}${proofPath}`, { headers })).status, 401);
  }
  assert.equal((await agent()).status, 200);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await agent('/api/state', desktopToken)).status, 401);
  assert.equal((await agent('/api/state', '0'.repeat(64))).status, 401);
  for (const pathname of ['/', '/assets/main.js', '/api/desktop/session', '/api/desktop/lock']) {
    assert.notEqual((await agent(pathname)).status, 200, pathname);
  }
  const browserHeaders: Record<string, string>[] = [{ Origin: base }, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Dest': 'empty' }];
  for (const headers of browserHeaders) {
    assert.equal((await agent('/api/state', agentToken, headers)).status, 401);
  }
  assert.equal((await fetch(`${base}/api/command`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  const lock = await fetch(`${base}/api/desktop/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: desktopToken }) });
  assert.equal(lock.status, 200);
  assert.equal((await agent()).status, 200);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  auth = createDesktopAuth(dataDirectory, randomBytes(32).toString('hex'));
  assert.equal((await agent()).status, 200);
  chmodSync(credential, 0o644);
  assert.equal((await agent()).status, 401);
  assert.equal((await fetch(`${base}${proofPath}`)).status, 401);
  chmodSync(credential, 0o600);
  writeFileSync(credential, 'not-a-credential');
  assert.equal((await agent()).status, 401);
  const rotated = randomBytes(32).toString('hex');
  writeFileSync(credential, rotated);
  assert.equal((await agent()).status, 401);
  assert.equal((await agent('/api/state', rotated)).status, 200);
  rmSync(credential);
  assert.equal((await agent('/api/state', rotated)).status, 401);
  const linked = join(directory, 'linked-token');
  writeFileSync(linked, agentToken, { mode: 0o600 });
  symlinkSync(linked, credential);
  assert.equal((await agent()).status, 401);
  assert.equal((await fetch(`${base}${proofPath}`)).status, 401);
});

test('trusted automation reads and writes isolated records across a real server restart without unlocking the human UI', { skip: !process.getuid }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-agent-restart-'));
  const dataDirectory = join(directory, 'data');
  mkdirSync(dataDirectory);
  const agentToken = randomBytes(32).toString('hex');
  writeFileSync(join(directory, 'local-agent-token'), `${agentToken}\n`, { mode: 0o600 });
  writeFileSync(join(dataDirectory, '.desktop-only'), '', { mode: 0o600 });
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  let child: ReturnType<typeof spawn> | undefined;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  };
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ['server/index.ts'], { env: { ...process.env, NODE_ENV: 'production', MAZAL_ENGINE_AUTOSTART: '0', PORT: String(port), MAZAL_DATA_DIR: dataDirectory, MAZAL_DESKTOP_TOKEN: randomBytes(32).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Locked automation server did not start.')), 10_000);
      child!.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Locked automation server exited with ${code}.`)); });
    });
  };
  const headers = { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' };
  await start();
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(`${base}/api/state?workspace=live`)).status, 401);
  const saved = await fetch(`${base}/api/command?workspace=live`, { method: 'POST', headers, body: JSON.stringify({ type: 'add_account', entityId: 'personal', name: 'Isolated automation check', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01', requestId: 'agent-restart-account', expectedRevision: 0 }) });
  assert.equal(saved.status, 200);
  const before = await (await fetch(`${base}/api/state?workspace=live`, { headers })).json();
  assert.equal(before.revision, 1);
  await stop();
  await start();
  const challenge = randomBytes(32).toString('hex');
  const proof = await (await fetch(`${base}/api/desktop/agent-health?challenge=${challenge}`)).json();
  assert.equal(proof.proof, createHmac('sha256', agentToken).update(`mazal-local-agent:${challenge}`).digest('hex'));
  const after = await (await fetch(`${base}/api/state?workspace=live`, { headers })).json();
  assert.deepEqual(after, before);
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(`${base}/api/state?workspace=live`)).status, 401);
  assert.equal((await fetch(`${base}/api/desktop/session`, { method: 'POST', headers, body: JSON.stringify({ token: agentToken }) })).status, 401);
});
