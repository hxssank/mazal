import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { createStore } from './store.ts';
import { createDocumentStore } from './documents.ts';
import { decodeDocumentArchive } from './document-archive.ts';
import type { AppState } from '../shared/types.ts';
import type { DocumentRecoveryHealth, DocumentRestorePreview, DocumentRestoreResult } from '../shared/recovery.ts';

test('a new installation restores financial records, previews originals, commits once, and opens every recovered source', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-recovery-http-'));
  const original = createStore(join(directory, 'original', 'live.sqlite'), 'live');
  const sourceDocuments = createDocumentStore(join(directory, 'original', 'documents'));
  let backup: ReturnType<typeof original.export>;
  let archive: Buffer;
  const pdf = Buffer.from('%PDF-1.7\nOriginal statement for recovery.\n');
  const heic = Buffer.alloc(24); heic.writeUInt32BE(24); heic.write('ftyp', 4); heic.write('heic', 8); heic.write('mif1', 16); heic.write('heic', 20);
  const sources = [
    { name: 'Reviewed.csv', mimeType: 'text/csv; charset=utf-8', bytes: Buffer.from('Date,Description,Amount\n') },
    { name: 'Reviewed.json', mimeType: 'application/json; charset=utf-8', bytes: Buffer.from('{"original":"review"}\n') },
  ].map(source => ({ ...source, sha256: createHash('sha256').update(source.bytes).digest('hex') }));
  const historicalBytes = Buffer.from('Date,Description,Amount\n2026-01-01,Earlier bank observation,0\n');
  const historical = { name: 'Earlier.csv', mimeType: 'text/csv; charset=utf-8', bytes: historicalBytes, sha256: createHash('sha256').update(historicalBytes).digest('hex') };
  let documentId: string;
  try {
    const accountId = original.command({ type: 'add_account', entityId: 'personal', name: 'Recovered bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
    const document = sourceDocuments.upload(pdf, { originalName: 'Recovered.pdf', accountId, kind: 'statement', notes: 'Keep original notes.' }).document;
    sourceDocuments.upload(heic, { originalName: 'Account.HEIC', accountId, kind: 'other' });
    documentId = document.id;
    for (const [index, source] of [{ name: document.originalName, sha256: document.sha256 }, ...sources].entries()) {
      const month = String(index + 1).padStart(2, '0');
      original.command({ type: 'stage_statement', requestId: `statement-${index}`, statement: { id: `statement-${index}`, accountId, sourceFile: source.name, sha256: source.sha256, periodStart: `2026-${month}-01`, periodEnd: `2026-${month}-${index === 1 ? '28' : '31'}`, openingBalanceCents: 10000, closingBalanceCents: 10000, rows: [] } });
    }
    backup = original.export();
    backup.data.originalImports.push({ date: new Date().toISOString(), source: { format: 'mazal-bank-activity-extension', version: 1, previousBatch: { source: { sourceFile: historical.name, sha256: historical.sha256, accountId } } } });
    backup.data.accounts.find(account => account.id === accountId)!.evidence = { sourceFile: 'Account.HEIC', asOf: '2026-01-01', capturedOn: '2026-01-01', status: 'bank', notes: 'Original account source.' };
    backup.data.sourceFacts = [{ id: 'source-fact', label: 'Account source', value: 'Original image', asOf: '2026-01-01', sourceFile: 'Account.HEIC', note: 'Preserved source reference.' }];
    archive = gzipSync(Buffer.concat([...sourceDocuments.export([...sources, historical].map(source => ({ sha256: source.sha256, sourceFiles: [source.name], mimeType: source.mimeType, bytes: source.bytes })))]));
  } finally { sourceDocuments.close(); original.close(); }
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], { env: { ...process.env, PORT: String(port), MAZAL_DATA_DIR: join(directory, 'new-machine'), MAZAL_MASTER_WORKBOOK: join(directory, 'master.xlsx') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', bytes => { errors += String(bytes); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer);
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Recovery server did not start. ${errors}`)), 10000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Recovery server exited ${code}. ${errors}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const restored = await fetch(`${base}/api/backup/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mazal-Revision': '0' }, body: JSON.stringify(backup) });
  assert.equal(restored.status, 200);
  const state = await restored.json() as AppState;
  assert.equal((await (await fetch(`${base}/api/documents/recovery`)).json() as DocumentRecoveryHealth).missingStatementSources, 4);
  const discarded = await (await fetch(`${base}/api/documents/restore/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Uint8Array.from(archive) })).json() as DocumentRestorePreview;
  const discardUrl = `${base}/api/documents/restore/preview?token=${discarded.token}`;
  assert.equal((await fetch(discardUrl, { method: 'DELETE', headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.deepEqual(await (await fetch(discardUrl, { method: 'DELETE' })).json(), { status: 'discarded' });
  assert.equal((await fetch(discardUrl, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/documents/restore/preview?token=invalid`, { method: 'DELETE' })).status, 400);
  assert.equal((await fetch(`${base}/api/documents/restore/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: discarded.token, expectedRevision: discarded.expectedRevision }) })).status, 404);
  const previewResponse = await fetch(`${base}/api/documents/restore/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Uint8Array.from(archive) });
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json() as DocumentRestorePreview;
  assert.equal(preview.expectedRevision, state.revision);
  assert.equal(preview.counts.unresolvedLinks, 0);
  assert.equal(preview.documents[0].suggestedAccountId, state.accounts[0].id);
  const command = { token: preview.token, expectedRevision: preview.expectedRevision };
  const commit = (body: unknown, workspace = 'live') => fetch(`${base}/api/documents/restore/commit?workspace=${workspace}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await commit(command, 'demo')).status, 404);
  const saved = await commit(command);
  assert.equal(saved.status, 200, await saved.clone().text());
  const result = await saved.json() as DocumentRestoreResult;
  assert.equal(result.documentsAdded, 2);
  assert.equal(result.reviewSourcesRestored, 3);
  assert.deepEqual(await (await commit(command)).json(), result);
  assert.equal((await commit({ ...command, expectedRevision: command.expectedRevision + 1 })).status, 409);
  const opened = await fetch(`${base}/api/documents/${documentId}/content`);
  assert.equal(opened.status, 200); assert.deepEqual(Buffer.from(await opened.arrayBuffer()), pdf);
  const registered = [{ name: 'Recovered.pdf', sha256: documentId, bytes: pdf }, ...sources, historical];
  for (const source of registered) {
    const content = await fetch(`${base}/api/source?${new URLSearchParams({ file: source.name, sha: source.sha256 })}`);
    assert.equal(content.status, 200); assert.deepEqual(Buffer.from(await content.arrayBuffer()), source.bytes);
  }
  const image = await fetch(`${base}/api/source?file=Account.HEIC`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/heic');
  assert.match(image.headers.get('content-disposition')!, /attachment/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), heic);
  const health = await (await fetch(`${base}/api/documents/recovery`)).json() as DocumentRecoveryHealth;
  assert.deepEqual(health.issues, []);
  assert.equal(health.documents, 2); assert.equal(health.statementSources, 4);
  assert.equal(health.sourceReferences, 1); assert.equal(health.missingSourceReferences, 0);
  const exported = await fetch(`${base}/api/documents/export`);
  assert.equal(exported.status, 200);
  const exportedArchive = decodeDocumentArchive(new Uint8Array(await exported.arrayBuffer()));
  const historicalSource = exportedArchive.reviewSources.find(source => source.sha256 === historical.sha256);
  assert.ok(historicalSource);
  assert.deepEqual(exportedArchive.files.get(historicalSource.originalPath), historical.bytes);
  assert.deepEqual(await (await fetch(`${base}/api/state`)).json(), state);
  assert.equal((await fetch(`${base}/api/documents/recovery`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/documents/restore/preview`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'archive' })).status, 415);
  assert.equal((await fetch(`${base}/api/documents/restore/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://attacker.example' }, body: 'archive' })).status, 403);
  assert.equal((await fetch(`${base}/api/documents/restore/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'broken gzip' })).status, 400);
});
