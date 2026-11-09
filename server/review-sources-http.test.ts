import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import type { AppState, Command, StatementSource } from '../shared/types.ts';
import { createStore } from './store.ts';

function archiveFiles(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    assert.equal(files.has(name), false, 'Archive entries must not repeat.');
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('legacy statement downloads verify original hashes and reject symlinks and oversized files', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-legacy-sources-http-'));
  const sources = join(directory, 'source-documents');
  mkdirSync(sources);
  const original = Buffer.from('%PDF-1.7\nLegacy statement original.\n');
  const filename = 'Legacy.pdf';
  const sourcePath = join(sources, filename);
  const seed = createStore(join(directory, 'live.sqlite'), 'live');
  try {
    const accountId = seed.command({ type: 'add_account', entityId: 'personal', name: 'Legacy account', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
    seed.command({ type: 'stage_statement', requestId: 'legacy-statement', statement: { id: 'legacy', accountId, sourceFile: filename, sha256: createHash('sha256').update(original).digest('hex'), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 10000, rows: [] } });
  } finally { seed.close(); }
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], { env: { ...process.env, PORT: String(port), MAZAL_DATA_DIR: directory, MAZAL_MASTER_WORKBOOK: join(directory, 'master.xlsx') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Legacy source server did not start.')), 10000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Legacy source server exited with ${code}.`)); });
  });
  const url = `http://127.0.0.1:${port}/api/source?file=${filename}`;
  writeFileSync(sourcePath, original);
  const valid = await fetch(url);
  assert.equal(valid.status, 200);
  assert.deepEqual(Buffer.from(await valid.arrayBuffer()), original);
  assert.match(valid.headers.get('content-security-policy')!, /sandbox/);
  writeFileSync(sourcePath, '%PDF-1.7\nDifferent statement.\n');
  const changed = await fetch(url);
  assert.equal(changed.status, 409);
  assert.match((await changed.json()).error, /SHA-256/);
  rmSync(sourcePath);
  const outside = join(directory, 'outside.pdf');
  writeFileSync(outside, original);
  symlinkSync(outside, sourcePath);
  assert.equal((await fetch(url)).status, 404);
  rmSync(sourcePath);
  writeFileSync(sourcePath, Buffer.alloc(25 * 1024 * 1024 + 1));
  assert.equal((await fetch(url)).status, 413);
});

test('review CSV and JSON originals require registered names and matching hashes for download and import', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-review-sources-http-'));
  const sources = join(directory, 'source-documents');
  mkdirSync(sources);
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], { env: { ...process.env, PORT: String(port), MAZAL_DATA_DIR: directory, MAZAL_MASTER_WORKBOOK: join(directory, 'master.xlsx') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Review source server did not start.')), 10000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Review source server exited with ${code}.`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  const post = (command: Command) => fetch(`${url}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  let state = await (await post({ type: 'add_account', entityId: 'personal', name: 'Reviewed bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01', expectedRevision: 0, requestId: 'create-bank' })).json() as AppState;
  const accountId = state.accounts[0].id;
  const originals = new Map<string, string>();
  for (const [index, extension, original] of [[0, 'csv', 'Date,Description,Amount\n2026-01-10,Reviewed credit,10.00\n'], [1, 'json', '{"date":"2026-02-10","description":"Reviewed credit","amountCents":1000}\n']] as const) {
    const sourceFile = `Bank review.${extension}`;
    const path = join(sources, sourceFile);
    const month = index === 0 ? '01' : '02';
    const statement: StatementSource = {
      id: `source-${extension}`, accountId, sourceFile, sha256: createHash('sha256').update(original).digest('hex'), periodStart: `2026-${month}-01`, periodEnd: index === 0 ? '2026-01-31' : '2026-02-28', openingBalanceCents: 10000 + index * 1000, closingBalanceCents: 11000 + index * 1000,
      rows: [{ id: 'credit', transactionDate: `2026-${month}-10`, postingDate: `2026-${month}-10`, description: 'Reviewed credit', amountCents: 1000, sourcePage: 1 }],
    };
    originals.set(statement.sha256, original);
    const sourceUrl = `${url}/api/source?file=${encodeURIComponent(sourceFile)}&sha=${statement.sha256}`;
    writeFileSync(path, original);
    assert.equal((await fetch(sourceUrl)).status, 404, 'Unregistered originals cannot be downloaded.');
    const invalid = await post({ type: 'stage_statement', statement: { ...statement, sha256: 'f'.repeat(64) }, expectedRevision: state.revision, requestId: `invalid-${extension}` });
    assert.equal(invalid.status, 409);
    const staged = await post({ type: 'stage_statement', statement, expectedRevision: state.revision, requestId: `stage-${extension}` });
    assert.equal(staged.status, 200, await staged.clone().text());
    state = await staged.json() as AppState;
    const download = await fetch(sourceUrl);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), extension === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.match(download.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(await download.text(), original);
    assert.equal((await fetch(sourceUrl.replace(statement.sha256, 'e'.repeat(64)))).status, 404);
    assert.equal((await fetch(`${url}/api/source?file=${encodeURIComponent(`../${sourceFile}`)}&sha=${statement.sha256}`)).status, 404);
    state = await (await post({ type: 'review_statement', importId: statement.id, decisions: [{ rowId: 'credit', kind: 'movement', category: 'Funding under review' }], expectedRevision: state.revision, requestId: `review-${extension}` })).json() as AppState;
    writeFileSync(path, 'changed after review');
    assert.equal((await fetch(sourceUrl)).status, 409);
    const damagedArchive = await fetch(`${url}/api/documents/export`);
    assert.equal(damagedArchive.status, 409);
    assert.match(damagedArchive.headers.get('content-type')!, /application\/json/);
    assert.equal((await post({ type: 'commit_statements', importIds: [statement.id], expectedRevision: state.revision, requestId: `tampered-${extension}` })).status, 409);
    assert.deepEqual(await (await fetch(`${url}/api/state`)).json(), state);
    writeFileSync(path, original);
    const committed = await post({ type: 'commit_statements', importIds: [statement.id], expectedRevision: state.revision, requestId: `commit-${extension}` });
    assert.equal(committed.status, 200, await committed.clone().text());
    state = await committed.json() as AppState;
    assert.equal(state.accounts[0].balanceCents, statement.closingBalanceCents);
    const outside = join(directory, `outside.${extension}`);
    writeFileSync(outside, original);
    rmSync(path);
    symlinkSync(outside, path);
    assert.equal((await fetch(sourceUrl)).status, 404, 'Source files cannot follow symlinks outside the source directory.');
    rmSync(path);
    assert.equal((await fetch(sourceUrl)).status, 404);
    assert.equal((await fetch(`${url}/api/documents/export`)).status, 404, 'Missing originals must not produce an apparently complete archive.');
    writeFileSync(path, original);
    assert.equal((await fetch(sourceUrl)).status, 200);
  }
  assert.equal(state.transactions.filter(transaction => transaction.kind === 'income' || transaction.kind === 'expense').length, 0);
  const pdf = '%PDF-1.7\nSaved PDF original\n';
  const uploaded = await fetch(`${url}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Mazal-Document': encodeURIComponent(JSON.stringify({ originalName: 'Existing statement.pdf', kind: 'statement', accountId })) }, body: pdf });
  assert.equal(uploaded.status, 201);
  const pdfDocument = (await uploaded.json()).document;
  state = await (await post({ type: 'add_account', entityId: 'personal', name: 'Second source account', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-01-01', expectedRevision: state.revision, requestId: 'create-second' })).json() as AppState;
  const originalCsv = state.importBatches!.find(batch => batch.source.sourceFile.endsWith('.csv'))!.source;
  const alias = 'Same source under another name.csv';
  writeFileSync(join(sources, alias), originals.get(originalCsv.sha256)!);
  const secondAccount = state.accounts.find(account => account.name === 'Second source account')!.id;
  const staged = await post({ type: 'stage_statement', statement: { ...originalCsv, id: 'same-bytes-alias', accountId: secondAccount, sourceFile: alias }, expectedRevision: state.revision, requestId: 'same-bytes-alias' });
  assert.equal(staged.status, 200);
  state = await staged.json() as AppState;
  writeFileSync(join(sources, 'Unregistered.json'), '{"excluded":true}');
  const exported = await fetch(`${url}/api/documents/export`);
  assert.equal(exported.status, 200);
  const files = archiveFiles(gunzipSync(Buffer.from(await exported.arrayBuffer())));
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
  assert.equal(manifest.documents.length, 1);
  assert.equal(manifest.reviewSources.length, 2);
  assert.equal(files.size, 4, 'One manifest, one PDF, one CSV and one JSON must be archived.');
  assert.equal(files.get(`originals/${pdfDocument.sha256}.pdf`)!.toString('utf8'), pdf);
  for (const source of manifest.reviewSources) {
    const bytes = files.get(source.originalPath)!;
    assert.equal(bytes.toString('utf8'), originals.get(source.sha256));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
    assert.equal(bytes.length, source.bytes);
    assert.deepEqual(source.restorePaths, source.sourceFiles.map((name: string) => `source-documents/${name}`));
  }
  const savedCsv = manifest.reviewSources.find((source: { sha256: string }) => source.sha256 === originalCsv.sha256);
  assert.deepEqual(new Set(savedCsv.sourceFiles), new Set([originalCsv.sourceFile, alias]));
  const demo = await fetch(`${url}/api/documents/export?workspace=demo`);
  const demoFiles = archiveFiles(gunzipSync(Buffer.from(await demo.arrayBuffer())));
  assert.equal(demoFiles.size, 1);
  assert.equal(JSON.parse(demoFiles.get('manifest.json')!.toString('utf8')).reviewSources, undefined);
  assert.deepEqual(await (await fetch(`${url}/api/state`)).json(), state);
});
