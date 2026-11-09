import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocumentStore, DocumentError } from './documents.ts';
import { decodeDocumentArchive } from './document-archive.ts';
import { parseStatementCSV } from '../shared/statement-csv.ts';
import { csvHeaders, defaultStatementMapping, mapStatementCSV } from '../shared/statement-mapping.ts';
import type { StatementSource } from '../shared/types.ts';

const csv = Buffer.from('TransactionDate,PostingDate,Description,Amount\r\n2026-01-02,2026-01-03,"Groceries, local",-10.00\r\n');

test('CSV originals require valid UTF-8, consistent columns and the CSV extension', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-csv-validation-'));
  const documents = createDocumentStore(directory);
  t.after(() => { documents.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const [bytes, originalName] of [[csv, 'statement.html'], [Buffer.from([0xff, 0xfe, 0]), 'statement.csv'], [Buffer.from('Date,Description,Amount\n2026-01-02,Shop'), 'statement.csv'], [Buffer.from('Date,Date,Amount\n2026-01-02,Shop,-10'), 'statement.csv'], [Buffer.concat([csv, Buffer.from([0])]), 'statement.csv']] as const) {
    assert.throws(() => documents.upload(bytes, { originalName, kind: 'statement' }), DocumentError);
  }
  assert.equal(documents.list().documents.length, 0);
  const saved = documents.upload(csv, { originalName: 'Statement.CSV', kind: 'statement' }).document;
  assert.equal(saved.mimeType, 'text/csv; charset=utf-8');
  assert.equal(saved.originalName, 'Statement.csv');
  assert.deepEqual(documents.content(saved.id).bytes, csv);
});

test('CSV intake stages exact source rows and exports and restores the same original bytes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-csv-http-'));
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], { env: { ...process.env, PORT: String(port), MAZAL_DATA_DIR: directory, MAZAL_MASTER_WORKBOOK: join(directory, 'qa.xlsx') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CSV test server did not start')), 10000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CSV test server exited ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const command = (body: unknown) => fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const initial = await (await fetch(`${base}/api/state`)).json();
  const added = await command({ type: 'add_account', entityId: 'personal', name: 'CSV bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01', expectedRevision: initial.revision, requestId: 'csv-bank' });
  assert.equal(added.status, 200);
  const before = await added.json();
  const accountId = before.accounts[0].id;
  const uploaded = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Mazal-Document': encodeURIComponent(JSON.stringify({ originalName: 'Bank.csv', accountId, kind: 'statement', periodStart: '2026-01-01', periodEnd: '2026-01-31' })) }, body: csv });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const { document } = await uploaded.json();
  const statement = { id: 'csv-source', accountId, sourceFile: document.originalName, sha256: document.sha256, periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 9000, rows: parseStatementCSV(csv.toString('utf8')) };
  const altered = await command({ type: 'stage_statement', expectedRevision: before.revision, requestId: 'altered-csv', statement: { ...statement, closingBalanceCents: 8000, rows: statement.rows.map(row => ({ ...row, amountCents: -2000 })) } });
  assert.equal(altered.status, 400);
  assert.match((await altered.json()).error, /match every row/);
  const staged = await command({ type: 'stage_statement', expectedRevision: before.revision, requestId: 'stage-csv', statement });
  assert.equal(staged.status, 200, await staged.clone().text());
  const state = await staged.json();
  assert.equal(state.importBatches[0].status, 'staged');
  assert.deepEqual(state.transactions, before.transactions);
  assert.deepEqual(state.accounts, before.accounts);
  const sourceURL = `${base}/api/source?${new URLSearchParams({ file: statement.sourceFile, sha: statement.sha256 })}`;
  for (const url of [sourceURL, `${base}/api/documents/${document.id}/content`]) {
    const source = await fetch(url);
    assert.equal(source.status, 200);
    assert.equal(source.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(source.headers.get('content-disposition')!, /^attachment/);
    assert.equal(source.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await source.arrayBuffer()), csv);
  }
  assert.equal((await (await fetch(`${base}/api/documents/recovery`)).json()).missingStatementSources, 0);
  const exported = await fetch(`${base}/api/documents/export`);
  assert.equal(exported.status, 200, await exported.clone().text());
  const archive = Buffer.from(await exported.arrayBuffer());
  const decoded = decodeDocumentArchive(archive);
  assert.equal(decoded.documents.length, 1);
  assert.equal(decoded.reviewSources.length, 0);
  assert.deepEqual(decoded.files.get(`originals/${document.sha256}.csv`), csv);
  unlinkSync(join(directory, 'documents', 'live', `${document.id}.original`));
  assert.equal((await (await fetch(`${base}/api/documents/recovery`)).json()).missingStatementSources, 1);
  const previewResponse = await fetch(`${base}/api/documents/restore/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archive });
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  const restored = await fetch(`${base}/api/documents/restore/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token, expectedRevision: preview.expectedRevision }) });
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual(Buffer.from(await (await fetch(sourceURL)).arrayBuffer()), csv);
  assert.equal((await (await fetch(`${base}/api/documents/recovery`)).json()).missingStatementSources, 0);
  assert.deepEqual(await (await fetch(`${base}/api/state`)).json(), state);
});

test('mapped bank CSV imports verify original rows, retain the mapping and survive backup restoration', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-mapped-csv-http-'));
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], { env: { ...process.env, PORT: String(port), MAZAL_DATA_DIR: directory, MAZAL_MASTER_WORKBOOK: join(directory, 'qa.xlsx') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mapped CSV test server did not start')), 10000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Mapped CSV test server exited ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const command = (body: unknown) => fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const added = await command({ type: 'add_account', entityId: 'personal', name: 'Mapped CSV bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01', expectedRevision: 0, requestId: 'mapped-bank' });
  let state = await added.json();
  const accountId = state.accounts[0].id;
  const inputs = [
    { filename: 'Bank export.csv', text: 'Date,Details,Withdrawals,Deposits\r\n01/02/2026,"Shop, local",10.00,\r\n01/03/2026,Pay,,20.00\r\n', mode: 'split' as const, dateFormat: 'mdy' as const, sameDate: true, sign: 'as-is' as const, opening: 10000, closing: 11000, periodStart: '2026-01-01', periodEnd: '2026-01-31' },
    { filename: 'Reverse signs.csv', text: 'TransactionDate,PostingDate,Description,Amount\n2026-02-02,2026-02-03,Shop,5.00\n', mode: 'signed' as const, dateFormat: 'ymd' as const, sameDate: false, sign: 'invert' as const, opening: 11000, closing: 10500, periodStart: '2026-02-01', periodEnd: '2026-02-28' },
  ];
  for (const [index, input] of inputs.entries()) {
    const bytes = Buffer.from(input.text);
    const csvMapping = { ...defaultStatementMapping(csvHeaders(input.text)), mode: input.mode, dateFormat: input.dateFormat, sameDate: input.sameDate, sign: input.sign };
    const uploaded = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Mazal-Document': encodeURIComponent(JSON.stringify({ originalName: input.filename, accountId, kind: 'statement' })) }, body: bytes });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const { document } = await uploaded.json();
    const statement: StatementSource = { id: `mapped-source-${index}`, accountId, sourceFile: document.originalName, sha256: document.sha256, periodStart: input.periodStart, periodEnd: input.periodEnd, openingBalanceCents: input.opening, closingBalanceCents: input.closing, rows: mapStatementCSV(input.text, csvMapping), csvMapping };
    const stage = (source: unknown, requestId: string) => command({ type: 'stage_statement', expectedRevision: state.revision, requestId, statement: source });
    const missing = await stage({ ...statement, csvMapping: undefined }, `missing-map-${index}`);
    assert.equal(missing.status, 400); await missing.arrayBuffer();
    const malformed = await stage({ ...statement, csvMapping: { ...csvMapping, sameDate: 'false' } }, `bad-map-${index}`);
    assert.equal(malformed.status, 400); await malformed.arrayBuffer();
    for (const [attempt, rows] of [statement.rows.slice(1), statement.rows.map(row => ({ ...row, amountCents: row.amountCents - 1 })), statement.rows.map(row => ({ ...row, dateBasis: 'transaction_only' }))].entries()) {
      const rejected = await stage({ ...statement, rows }, `altered-map-${index}-${attempt}`);
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /match every row/);
    }
    const staged = await stage(statement, `valid-map-${index}`);
    assert.equal(staged.status, 200, await staged.clone().text());
    state = await staged.json();
    assert.deepEqual(state.importBatches.at(-1).source, statement);
    const reviewed = await command({ type: 'review_statement', importId: statement.id, decisions: statement.rows.map(row => ({ rowId: row.id, kind: row.amountCents < 0 ? 'expense' : 'income', category: 'Mapped review' })), expectedRevision: state.revision, requestId: `review-map-${index}` });
    assert.equal(reviewed.status, 200, await reviewed.clone().text()); state = await reviewed.json();
    const committed = await command({ type: 'commit_statements', importIds: [statement.id], expectedRevision: state.revision, requestId: `commit-map-${index}` });
    assert.equal(committed.status, 200, await committed.clone().text()); state = await committed.json();
    assert.equal(state.accounts[0].balanceCents, input.closing);
    assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/documents/${document.id}/content`)).arrayBuffer()), bytes);
  }
  const backup = await (await fetch(`${base}/api/backup`)).json();
  const invalid = structuredClone(backup); invalid.data.importBatches[0].source.csvMapping.sign = 'ignored';
  const restore = (body: unknown) => fetch(`${base}/api/backup/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mazal-Revision': String(state.revision) }, body: JSON.stringify(body) });
  const invalidRestore = await restore(invalid); assert.equal(invalidRestore.status, 400); await invalidRestore.arrayBuffer();
  const restored = await restore(backup); assert.equal(restored.status, 200, await restored.clone().text());
  assert.deepEqual((await restored.json()).importBatches, state.importBatches);
  const archive = decodeDocumentArchive(new Uint8Array(await (await fetch(`${base}/api/documents/export`)).arrayBuffer()));
  for (const input of inputs) {
    const document = archive.documents.find(item => item.originalName === input.filename)!;
    assert.deepEqual(archive.files.get(document.originalPath), Buffer.from(input.text));
  }
});
