import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createStore } from './store.ts';
import { createStoreService } from './store-service.ts';
import { BackupError } from './backup.ts';
import type { AppState, Command } from '../shared/types.ts';
import type { StateChanges } from '../shared/state-changes.ts';

test('large encoded backups decode and restore in the worker while the parent event loop runs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-worker-restore-'));
  const service = await createStoreService(join(directory, 'live.sqlite'), 'live');
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const backup = await service.export();
  const before = await service.state();
  const padding = ' '.repeat(32 * 1024 * 1024);
  const malformed = gzipSync(`${padding}{"incomplete":`);
  let ticks = 0;
  let timer = setInterval(() => { ticks++; }, 1);
  try {
    await assert.rejects(service.restoreEncoded(malformed, 'application/gzip', before.revision), error => error instanceof BackupError && error.status === 400 && /not valid JSON/.test(error.message));
  } finally { clearInterval(timer); }
  assert.ok(ticks > 0, 'The parent timer must run during decompression and JSON parsing, even when decoding fails before restore.');
  assert.deepEqual(await service.state(), before);
  const compressed = gzipSync(`${padding}${backup}`);
  const originalBytes = Buffer.from(compressed);
  ticks = 0;
  timer = setInterval(() => { ticks++; }, 1);
  let response: string;
  try { response = await service.restoreEncoded(compressed, 'application/gzip', before.revision); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 0, 'The parent timer must run before a large restore returns.');
  assert.deepEqual(compressed, originalBytes, 'Transferring request bytes must not detach or change the caller buffer.');
  const restored = JSON.parse(response) as AppState;
  assert.equal(restored.revision, before.revision + 1);
  assert.deepEqual(restored.accounts, before.accounts);
  assert.deepEqual(restored.transactions, before.transactions);
  assert.deepEqual(await service.state(), restored);
  await assert.rejects(service.restoreEncoded(Buffer.from(backup), 'application/json', before.revision), /records changed/);
  await assert.rejects(service.restoreEncoded(Buffer.from(backup), 'application/json', undefined), error => error instanceof BackupError && error.status === 400);
  assert.deepEqual(await service.state(), restored);
});

test('a full money write with 5000 expense records leaves the parent event loop responsive', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-worker-load-'));
  const path = join(directory, 'live.sqlite');
  let service:Awaited<ReturnType<typeof createStoreService>>|undefined;
  t.after(async () => { if (service) await service.close(); rmSync(directory, {recursive:true, force:true}); });
  const seed = createStore(path, 'live');
  let accountId:string;
  try {
    accountId = seed.command({type:'add_account', entityId:'personal', name:'Cash', accountType:'cash', openingBalanceCents:1_000_000, openingDate:'2026-01-01'}).accounts[0].id;
    seed.command({type:'add_transaction', kind:'expense', accountId, amountCents:1, date:'2026-01-02', description:'Expense template', category:'Other', requestId:'template'});
    const backup = seed.export();
    const template = backup.data.transactions.find(transaction => transaction.kind === 'expense')!;
    const entries = backup.data.entries.filter(entry => entry.transactionId === template.id);
    backup.data.transactions = backup.data.transactions.filter(transaction => transaction.id !== template.id);
    backup.data.entries = backup.data.entries.filter(entry => entry.transactionId !== template.id);
    for (let index = 0; index < 5000; index++) {
      const id = `expense-${index}`;
      backup.data.transactions.push({...template, id, description:`Expense ${index}`});
      backup.data.entries.push(...entries.map((entry, position) => ({...entry, id:`entry-${index}-${position}`, transactionId:id})));
    }
    seed.restore(backup);
  } finally { seed.close(); }
  service = await createStoreService(path, 'live');
  const before = await service.state();
  assert.equal(before.transactions.filter(transaction => transaction.kind === 'expense').length, 5000);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  let json:string;
  try {
    json = await service.command({type:'add_transaction', kind:'expense', accountId, amountCents:123, date:'2026-01-03', description:'New expense', category:'Other', requestId:'money-write', expectedRevision:before.revision});
  } finally { clearInterval(timer); }
  assert.ok(ticks > 0, 'The parent timer must run before the full money write returns.');
  const after = JSON.parse(json) as AppState;
  assert.equal(after.accounts.find(account => account.id === accountId)!.balanceCents, 994877);
  assert.equal(after.transactions.length, before.transactions.length + 1);
  assert.equal(after.revision, before.revision + 1);
  const replay = JSON.parse(await service.command({type:'add_transaction', kind:'expense', accountId, amountCents:123, date:'2026-01-03', description:'New expense', category:'Other', requestId:'money-write', expectedRevision:before.revision})) as AppState;
  assert.deepEqual(replay, after);
  await service.close(); service = undefined;
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state(), after); } finally { reopened.close(); }
});

async function startServer(t:TestContext):Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-worker-http-'));
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], {env:{...process.env, PORT:String(port), MAZAL_DATA_DIR:join(directory,'data'), MAZAL_MASTER_WORKBOOK:join(directory,'master.xlsx')}, stdio:['ignore','pipe','pipe']});
  let errors = '';
  child.stderr.on('data', bytes => { errors += String(bytes); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
    rmSync(directory, {recursive:true, force:true});
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Test server did not start. ${errors}`)), 15000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited with ${code}. ${errors}`)); });
  });
  return `http://127.0.0.1:${port}`;
}

test('HTTP change responses reconstruct current records, while retries and money writes return complete states', async t => {
  const url = await startServer(t);
  const post = (command:Command, changes=false) => fetch(`${url}/api/command`, {method:'POST', headers:{'Content-Type':'application/json', ...(changes ? {'X-Mazal-State-Changes':'1'} : {})}, body:JSON.stringify(command)});
  const initial = await (await fetch(`${url}/api/state`)).json() as AppState;
  const accountResponse = await post({type:'add_account', entityId:'personal', name:'Cash', accountType:'cash', openingBalanceCents:10000, openingDate:'2026-01-01', requestId:'account', expectedRevision:initial.revision});
  assert.equal(accountResponse.status, 200);
  const baseline = await accountResponse.json() as AppState;
  assert.ok(Array.isArray(baseline.transactions));
  const command:Command = {type:'save_category_rule', rule:{id:'rule', entityId:'personal', accountId:null, match:'contains', merchant:'Store', category:'Shopping', enabled:true}, expected:null, requestId:'rule', expectedRevision:baseline.revision};
  const response = await post(command, true);
  assert.equal(response.status, 200);
  const delta = await response.json() as StateChanges;
  assert.equal(delta.format, 'mazal-state-changes');
  assert.equal(delta.baseRevision, baseline.revision);
  assert.equal(Object.hasOwn(delta.changes, 'transactions'), false);
  assert.equal(Object.hasOwn(delta.changes, 'accounts'), false);
  const reconstructed = {...baseline, ...delta.changes, revision:delta.revision};
  assert.deepEqual(reconstructed, await (await fetch(`${url}/api/state`)).json());
  assert.deepEqual(await (await post(command, true)).json(), reconstructed);
  const stale = await post({...command, requestId:'stale', rule:{...command.rule, id:'different'}}, true);
  assert.equal(stale.status, 409);
  const money = await post({type:'add_transaction', kind:'expense', accountId:baseline.accounts[0].id, amountCents:100, date:'2026-01-02', description:'Store purchase', category:'Uncategorized', requestId:'expense', expectedRevision:reconstructed.revision}, true);
  assert.equal(money.status, 200);
  const complete = await money.json() as AppState;
  assert.equal(Object.hasOwn(complete, 'format'), false);
  assert.equal(complete.accounts[0].balanceCents, 9900);
  assert.equal(complete.transactions.find(transaction => transaction.kind==='expense')!.category, 'Shopping');
  assert.deepEqual(complete, await (await fetch(`${url}/api/state`)).json());
});
