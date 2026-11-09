import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createStore } from './store.ts';
import { createDocumentStore, DocumentError } from './documents.ts';
import { createDocumentRecovery } from './document-recovery.ts';
import { decodeDocumentArchive } from './document-archive.ts';

const pdf = Buffer.from('%PDF-1.7\nOriginal bank statement.\n%%EOF\n');
const csv = Buffer.from('Date,Description,Amount\n');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function setup(t: TestContext, label: string) {
  const base = mkdtempSync(join(tmpdir(), `mazal-document-recovery-${label}-`));
  const financePath = join(base, 'live.sqlite');
  const finance = createStore(financePath, 'live');
  const documentDirectory = join(base, 'documents');
  const sourceDirectory = join(base, 'source-documents');
  const documents = createDocumentStore(documentDirectory, id => finance.state().accounts.some(account => account.id === id));
  t.after(() => { documents.close(); finance.close(); rmSync(base, { recursive: true, force: true }); });
  const recovery = createDocumentRecovery({ directory: documentDirectory, sourceDirectory, financePath, documents });
  return { base, finance, financePath, documents, documentDirectory, sourceDirectory, recovery };
}
function archiveFixture(t: TestContext) {
  const context = setup(t, 'source');
  const state = context.finance.command({ type: 'add_account', entityId: 'personal', name: 'Source bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' });
  const accountId = state.accounts[0].id;
  const uploaded = context.documents.upload(pdf, { originalName: 'Bank.pdf', kind: 'statement', accountId, notes: 'Source notes.' }).document;
  const document = context.documents.patch(uploaded.id, { reviewStatus: 'reviewed', expectedRevision: uploaded.revision });
  for (const [id, sourceFile, sha256, month] of [['pdf', 'Bank.pdf', document.sha256, '01'], ['csv', 'Review.csv', digest(csv), '02']] as const) context.finance.command({ type: 'stage_statement', requestId: id, statement: { id, accountId, sourceFile, sha256, periodStart: `2026-${month}-01`, periodEnd: `2026-${month}-${month === '01' ? '31' : '28'}`, openingBalanceCents: 10000, closingBalanceCents: 10000, rows: [] } });
  const backup = context.finance.export();
  const archive = gzipSync(Buffer.concat([...context.documents.export([{ sha256: digest(csv), sourceFiles: ['Review.csv'], mimeType: 'text/csv; charset=utf-8', bytes: csv }])]));
  return { ...context, document, accountId, backup, archive };
}
function tarFiles(files: Map<string, Buffer>): Buffer {
  const output: Buffer[] = [];
  for (const [name, bytes] of files) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write('0000600\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 'ascii'); header.write('00', 263, 'ascii');
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    output.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...output, Buffer.alloc(1024)]);
}
function editHeader(tar: Buffer, change: (header: Buffer) => void): Buffer {
  const copy = Buffer.from(tar);
  const header = copy.subarray(0, 512); change(header); header.fill(32, 148, 156);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return gzipSync(copy);
}

test('real exported archives verify every original and reject malformed tar, paths, links and duplicate files', t => {
  const fixture = archiveFixture(t);
  const decoded = decodeDocumentArchive(fixture.archive);
  assert.equal(decoded.documents.length, 1);
  assert.equal(decoded.reviewSources.length, 1);
  assert.deepEqual(decoded.files.get(`originals/${fixture.document.id}.pdf`), pdf);
  const tar = gunzipSync(fixture.archive);
  const badChecksum = Buffer.from(tar); badChecksum[0] ^= 1;
  const firstSize = Number.parseInt(tar.subarray(124, 136).toString('ascii').replace(/\0/g, ''), 8);
  const firstRecord = tar.subarray(0, 512 + Math.ceil(firstSize / 512) * 512);
  const attacks = [
    Buffer.from('not gzip'), gzipSync(tar.subarray(0, tar.length - 1)), gzipSync(badChecksum),
    editHeader(tar, header => { header.fill(0, 0, 100); header.write('../outside.json'); }),
    editHeader(tar, header => { header[156] = 50; header.write('/tmp/outside', 157); }),
    editHeader(tar, header => { header[156] = 49; }),
    editHeader(tar, header => { header.write('../prefix', 345); }),
    gzipSync(Buffer.concat([firstRecord, tar])),
    gzipSync(Buffer.concat([tar, Buffer.from('trailing data')])),
  ];
  for (const archive of attacks) assert.throws(() => decodeDocumentArchive(archive), error => error instanceof DocumentError && error.status === 400);
  assert.throws(() => decodeDocumentArchive(fixture.archive, tar.length - 1), error => error instanceof DocumentError && error.status === 413);
  assert.throws(() => decodeDocumentArchive(fixture.archive, fixture.archive.length - 1), error => error instanceof DocumentError && error.status === 413);
});

test('archive manifests reject missing payloads, changed hashes, invalid metadata and unsafe review-source destinations', t => {
  const fixture = archiveFixture(t);
  const decoded = decodeDocumentArchive(fixture.archive);
  for (const edit of [
    (manifest: any) => { manifest.documents[0].bytes++; },
    (manifest: any) => { manifest.documents[0].accountId = 123; },
    (manifest: any) => { manifest.documents[0].createdAt = 'yesterday'; },
    (manifest: any) => { manifest.documents[0].periodStart = '2026-01-02'; manifest.documents[0].periodEnd = '2026-01-01'; },
    (manifest: any) => { manifest.reviewSources[0].sourceFiles = ['../Review.csv']; },
    (manifest: any) => { manifest.reviewSources[0].restorePaths = ['../../outside']; },
    (manifest: any) => { manifest.reviewSources[0].sourceFiles = ['Review.csv', 'review.csv']; manifest.reviewSources[0].restorePaths = ['source-documents/Review.csv', 'source-documents/review.csv']; },
    (manifest: any) => { manifest.reviewSources[0].sha256 = '0'.repeat(64); },
  ]) {
    const manifest = structuredClone(decoded.manifest); edit(manifest);
    const files = new Map(decoded.files); files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    assert.throws(() => decodeDocumentArchive(gzipSync(tarFiles(files))), DocumentError);
  }
  const missing = new Map(decoded.files); missing.delete(`originals/${fixture.document.id}.pdf`);
  assert.throws(() => decodeDocumentArchive(gzipSync(tarFiles(missing))), /missing/);
  const tampered = new Map(decoded.files); tampered.set(`originals/${fixture.document.id}.pdf`, Buffer.from('%PDF-1.7\nDifferent original.'));
  assert.throws(() => decodeDocumentArchive(gzipSync(tarFiles(tampered))), /SHA-256/);
});

test('archive decompression and validation leave the HTTP event loop available', async t => {
  const target = setup(t, 'worker');
  const invalid = gzipSync(Buffer.alloc(32 * 1024 * 1024, 65));
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  try { await assert.rejects(target.recovery.preview(invalid, async () => target.finance.state()), /ustar/); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 0, 'A timer must run while an invalid large archive is decompressed and rejected.');
  assert.deepEqual(target.documents.list().documents, []);
});

test('financial restore followed by archive restore preserves originals, metadata, source links and provenance', async t => {
  const fixture = archiveFixture(t);
  const target = setup(t, 'target');
  const restored = target.finance.restore(fixture.backup, 0);
  assert.equal(target.recovery.health(restored).missingStatementSources, 2);
  const preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  assert.equal(preview.documents[0].suggestedAccountId, fixture.accountId);
  assert.equal(preview.counts.unresolvedLinks, 0);
  assert.equal(target.documents.list().documents.length, 0);
  const command = { token: preview.token, expectedRevision: preview.expectedRevision };
  const result = target.recovery.commit(command, target.finance.state());
  assert.equal(result.documentsAdded, 1);
  assert.equal(result.reviewSourcesRestored, 1);
  assert.equal(result.recovery.missingOriginals, 0);
  assert.equal(result.recovery.missingStatementSources, 0);
  assert.equal(result.recovery.missingAccountLinks, 0);
  assert.deepEqual(target.documents.content(fixture.document.id).bytes, pdf);
  assert.deepEqual(target.documents.list().documents, [fixture.document]);
  assert.deepEqual(readFileSync(join(target.sourceDirectory, 'Review.csv')), csv);
  assert.deepEqual(target.finance.state(), restored);
  assert.deepEqual(target.recovery.commit(command, target.finance.state()), result);
  assert.throws(() => target.recovery.commit({ ...command, accountMappings: { [fixture.document.id]: null } }, target.finance.state()), /different choices/);
  const receipt = target.documents.recoveryReceipt(preview.token) as { manifest: { documents: { accountId: string }[] } };
  assert.equal(receipt.manifest.documents[0].accountId, fixture.accountId);
});

test('discarding a verified preview keeps saved originals and refuses a recovery install journal', async t => {
  const fixture = archiveFixture(t);
  const target = setup(t, 'discard');
  const preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  const stage = join(target.documentDirectory, '.recovery', preview.token);
  const stagedOriginal = join(stage, 'originals', `${fixture.document.id}.pdf`);
  const before = target.finance.state();
  const journal = join(stage, 'pending.json');
  writeFileSync(journal, '[{"kind":');
  assert.throws(() => target.recovery.discard(preview.token), (error: unknown) => error instanceof DocumentError && error.status === 409);
  assert.deepEqual(readFileSync(stagedOriginal), pdf);
  assert.equal(readFileSync(journal, 'utf8'), '[{"kind":');
  rmSync(journal);
  assert.deepEqual(target.recovery.discard(preview.token), { status: 'discarded' });
  assert.deepEqual(target.recovery.discard(preview.token), { status: 'discarded' });
  assert.equal(existsSync(stage), false);
  assert.throws(() => target.recovery.commit({ token: preview.token, expectedRevision: preview.expectedRevision }, before), /expired/);
  assert.deepEqual(target.finance.state(), before);
  assert.deepEqual(fixture.documents.content(fixture.document.id).bytes, pdf);
  assert.throws(() => target.recovery.discard('../outside'), DocumentError);
});

test('preview eviction keeps interrupted installation journals and their staged originals', async t => {
  const fixture = archiveFixture(t);
  const target = setup(t, 'eviction');
  const interrupted = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  const stage = join(target.documentDirectory, '.recovery', interrupted.token);
  writeFileSync(join(stage, 'pending.json'), '[{"kind":');
  const previews = [];
  for (let index = 0; index < 4; index++) previews.push(await target.recovery.preview(fixture.archive, async () => target.finance.state()));
  assert.equal(existsSync(join(target.documentDirectory, '.recovery', previews[0].token)), false);
  assert.deepEqual(readFileSync(join(stage, 'originals', `${fixture.document.id}.pdf`)), pdf);
  assert.equal(readFileSync(join(stage, 'pending.json'), 'utf8'), '[{"kind":');
});

test('unresolved accounts require an explicit mapping or an explicit unlinked choice', async t => {
  const fixture = archiveFixture(t);
  const target = setup(t, 'unlinked');
  const preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  const command = { token: preview.token, expectedRevision: preview.expectedRevision };
  assert.equal(preview.counts.unresolvedLinks, 1);
  assert.throws(() => target.recovery.commit(command, target.finance.state()), /explicitly leave it unlinked/);
  assert.throws(() => target.recovery.commit({ ...command, accountMappings: { [fixture.document.id]: 'missing' } }, target.finance.state()), /does not exist/);
  const result = target.recovery.commit({ ...command, accountMappings: { [fixture.document.id]: null } }, target.finance.state());
  assert.equal(result.unlinkedDocuments, 1);
  assert.equal(target.documents.list().documents[0].accountId, null);
  const receipt = target.documents.recoveryReceipt(preview.token) as { manifest: { documents: { accountId: string }[] } };
  assert.equal(receipt.manifest.documents[0].accountId, fixture.accountId);
});

test('reviewed general evidence can stay unlinked without hiding unresolved documents or damaged originals', t => {
  const target = setup(t, 'general-evidence');
  const accountId = target.finance.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-01-01' }).accounts[0].id;
  const upload = (name: string, kind: 'other' | 'statement' | 'receipt' = 'other', reviewed = true, accountId: string | null = null) => {
    const document = target.documents.upload(Buffer.from(`%PDF-1.7\nSynthetic evidence ${name} ${target.documents.list().documents.length}.`), { originalName: name, kind, accountId }).document;
    return reviewed ? target.documents.patch(document.id, { reviewStatus: 'reviewed', expectedRevision: document.revision }) : document;
  };
  const general = [upload('Score.pdf'), upload('Score history.pdf'), upload('Credit report.pdf')];
  const unreviewed = upload('Unchecked.pdf', 'other', false);
  const orphan = upload('Unreferenced.pdf');
  const statement = upload('Statement.pdf', 'statement');
  const receipt = upload('Receipt.pdf', 'receipt');
  const duplicates = [upload('Duplicate.pdf'), upload('duplicate.pdf')];
  const broken = upload('Missing account.pdf', 'other', true, accountId);
  const state = target.finance.state();
  state.accounts = [];
  state.sourceFacts = [...general, unreviewed, statement, receipt, duplicates[0], broken].map((document, index) => ({ id: `fact-${index}`, label: 'Reviewed source', value: 'Recorded separately', asOf: null, sourceFile: document.originalName.toUpperCase(), note: '' }));
  const before = structuredClone(state);
  const saved = target.documents.list().documents;
  let health = target.recovery.health(state);
  assert.equal(health.unlinkedDocuments, 6);
  assert.deepEqual(new Set(health.issues.filter(issue => issue.kind === 'unlinked_document').map(issue => issue.documentId)), new Set([unreviewed, orphan, statement, receipt, ...duplicates].map(document => document.id)));
  assert.equal(health.missingAccountLinks, 1);
  assert.equal(health.issues.find(issue => issue.kind === 'missing_account')?.documentId, broken.id);
  assert.deepEqual(target.documents.list().documents, saved);
  assert.deepEqual(state, before);
  rmSync(join(target.documentDirectory, `${general[0].id}.original`));
  writeFileSync(join(target.documentDirectory, `${general[1].id}.original`), 'Changed evidence.');
  health = target.recovery.health(state);
  assert.equal(health.missingOriginals, 1);
  assert.equal(health.damagedOriginals, 1);
  assert.equal(health.unlinkedDocuments, 6);
  assert.ok(health.issues.some(issue => issue.kind === 'missing_source_reference' && issue.sourceFile === general[0].originalName.toUpperCase()));
});

test('restoring reviewed general evidence preserves null account links and counts only unresolved additions', async t => {
  const source = setup(t, 'general-archive');
  const general = source.documents.upload(Buffer.from('%PDF-1.7\nSynthetic credit overview.'), { originalName: 'Credit overview.pdf', kind: 'other' }).document;
  source.documents.patch(general.id, { reviewStatus: 'reviewed', expectedRevision: general.revision });
  const orphan = source.documents.upload(Buffer.from('%PDF-1.7\nSynthetic unidentified record.'), { originalName: 'Unknown.pdf', kind: 'other' }).document;
  const backup = source.finance.export();
  backup.data.sourceFacts = [{ id: 'overview', label: 'Credit overview', value: 'Reviewed report', asOf: null, sourceFile: 'CREDIT OVERVIEW.PDF', note: '' }];
  const archive = gzipSync(Buffer.concat([...source.documents.export()]));
  const target = setup(t, 'general-restored');
  const state = target.finance.restore(backup, 0);
  const preview = await target.recovery.preview(archive, async () => target.finance.state());
  const command = { token: preview.token, expectedRevision: preview.expectedRevision };
  const result = target.recovery.commit(command, target.finance.state());
  assert.equal(result.documentsAdded, 2);
  assert.equal(result.unlinkedDocuments, 1);
  assert.equal(result.recovery.unlinkedDocuments, 1);
  assert.equal(result.recovery.missingSourceReferences, 0);
  assert.deepEqual(result.recovery.issues.map(issue => issue.documentId), [orphan.id]);
  assert.ok(target.documents.list().documents.every(document => document.accountId === null));
  assert.deepEqual(target.finance.state(), state);
  assert.deepEqual(target.recovery.commit(command, target.finance.state()), result);
});

test('registered statement hashes and names recover account links when account IDs differ', async t => {
  const fixture = archiveFixture(t);
  const target = setup(t, 'mapping');
  const accountId = target.finance.command({ type: 'add_account', entityId: 'personal', name: 'Recovered bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const source = fixture.backup.data.importBatches![0].source;
  target.finance.command({ type: 'stage_statement', requestId: 'source', statement: { ...source, accountId } });
  const preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  assert.equal(preview.documents[0].linkReason, 'statement_source');
  assert.equal(preview.documents[0].suggestedAccountId, accountId);
  target.recovery.commit({ token: preview.token, expectedRevision: preview.expectedRevision }, target.finance.state());
  assert.equal(target.documents.list().documents[0].accountId, accountId);
});

test('existing document metadata is preserved, missing originals are repaired, and conflicting files are never overwritten', async t => {
  const fixture = archiveFixture(t);
  const target = setup(t, 'existing');
  const existing = target.documents.upload(pdf, { originalName: 'My reviewed original.pdf', notes: 'Keep these newer notes.' }).document;
  const path = join(target.documentDirectory, `${existing.id}.original`);
  rmSync(path);
  let preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  assert.equal(preview.documents[0].status, 'repair');
  const result = target.recovery.commit({ token: preview.token, expectedRevision: preview.expectedRevision }, target.finance.state());
  assert.equal(result.originalsRepaired, 1);
  assert.deepEqual(target.documents.list().documents, [existing]);
  assert.deepEqual(readFileSync(path), pdf);
  writeFileSync(path, 'User data that must survive.');
  preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  assert.equal(preview.counts.conflicts, 1);
  assert.throws(() => target.recovery.commit({ token: preview.token, expectedRevision: preview.expectedRevision }, target.finance.state()), /conflicts/);
  assert.equal(readFileSync(path, 'utf8'), 'User data that must survive.');
});

test('stale financial records, changed document metadata and changed source destinations reject before installation', async t => {
  const fixture = archiveFixture(t);
  const target = setup(t, 'stale');
  let preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  target.finance.command({ type: 'add_reserve', entityId: 'personal', name: 'New plan', amountCents: 100 });
  assert.throws(() => target.recovery.commit({ token: preview.token, expectedRevision: preview.expectedRevision }, target.finance.state()), /Financial records changed/);
  preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  target.documents.upload(Buffer.from('%PDF-1.7\nOther document'), { originalName: 'Other.pdf' });
  assert.throws(() => target.recovery.commit({ token: preview.token, expectedRevision: preview.expectedRevision, accountMappings: { [fixture.document.id]: null } }, target.finance.state()), /changed after preview/);
  preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  mkdirSync(target.sourceDirectory, { recursive: true });
  writeFileSync(join(target.sourceDirectory, 'Review.csv'), 'Different user evidence.');
  assert.throws(() => target.recovery.commit({ token: preview.token, expectedRevision: preview.expectedRevision, accountMappings: { [fixture.document.id]: null } }, target.finance.state()), /changed after preview/);
  assert.equal(existsSync(join(target.documentDirectory, `${fixture.document.id}.original`)), false);
});

test('filename source lookup rejects ambiguous names and verifies the selected original hash', t => {
  const target = setup(t, 'named-source');
  const document = target.documents.upload(pdf, { originalName: 'Account.pdf' }).document;
  assert.deepEqual(target.documents.namedContent('ACCOUNT.PDF')!.bytes, pdf);
  writeFileSync(join(target.documentDirectory, `${document.id}.original`), 'Different original.');
  assert.throws(() => target.documents.namedContent('Account.pdf'), /SHA-256/);
  target.documents.upload(Buffer.from('%PDF-1.7\nA different account source.'), { originalName: 'account.pdf' });
  assert.throws(() => target.documents.namedContent('Account.pdf'), /More than one original/);
});

test('a database write failure rolls back installed files and metadata, then the same preview can retry', async t => {
  const fixture = archiveFixture(t);
  const target = setup(t, 'rollback');
  target.finance.restore(fixture.backup, 0);
  const preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  const sql = new DatabaseSync(join(target.documentDirectory, 'documents.sqlite'));
  t.after(() => sql.close());
  sql.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'Injected recovery failure'); END");
  const command = { token: preview.token, expectedRevision: preview.expectedRevision };
  assert.throws(() => target.recovery.commit(command, target.finance.state()));
  assert.deepEqual(target.documents.list().documents, []);
  assert.equal(existsSync(join(target.documentDirectory, `${fixture.document.id}.original`)), false);
  assert.equal(existsSync(join(target.sourceDirectory, 'Review.csv')), false);
  assert.equal(target.documents.recoveryReceipt(preview.token), null);
  sql.exec('DROP TRIGGER reject_recovery');
  assert.equal(target.recovery.commit(command, target.finance.state()).documentsAdded, 1);
});

test('restart rolls back interrupted installs using staged inode identity without deleting unrelated files', async t => {
  const fixture = archiveFixture(t);
  const target = setup(t, 'interrupted');
  const preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
  const stage = join(target.documentDirectory, '.recovery', preview.token);
  const originalPath = `originals/${fixture.document.id}.pdf`;
  const path = join(target.documentDirectory, `${fixture.document.id}.original`);
  linkSync(join(stage, originalPath), path);
  mkdirSync(target.sourceDirectory, { recursive: true });
  const unrelated = join(target.sourceDirectory, 'Review.csv');
  writeFileSync(unrelated, csv);
  const empty = Buffer.alloc(0);
  const emptyOriginal = `review-sources/${digest(empty)}.csv`;
  writeFileSync(join(stage, emptyOriginal), empty);
  const emptyTarget = join(target.sourceDirectory, 'Empty.csv');
  linkSync(join(stage, emptyOriginal), emptyTarget);
  writeFileSync(join(stage, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  writeFileSync(join(stage, 'pending.json'), JSON.stringify([{ kind: 'document', name: `${fixture.document.id}.original`, originalPath, sha256: fixture.document.sha256, bytes: pdf.length }, { kind: 'source', name: 'Review.csv', originalPath: `review-sources/${digest(csv)}.csv`, sha256: digest(csv), bytes: csv.length }, { kind: 'source', name: 'Empty.csv', originalPath: emptyOriginal, sha256: digest(empty), bytes: 0 }]));
  createDocumentRecovery({ directory: target.documentDirectory, sourceDirectory: target.sourceDirectory, financePath: target.financePath, documents: target.documents });
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(emptyTarget), false);
  assert.equal(existsSync(stage), false);
  assert.deepEqual(readFileSync(unrelated), csv);
  assert.deepEqual(target.documents.list().documents, []);
});

test('corrupt interrupted-recovery journals preserve evidence and report a health issue without blocking startup', async t => {
  const fixture = archiveFixture(t);
  for (const fault of ['owner-json', 'owner-value', 'pending-json', 'pending-value', 'missing-stage-file']) {
    const target = setup(t, fault);
    const preview = await target.recovery.preview(fixture.archive, async () => target.finance.state());
    const stage = join(target.documentDirectory, '.recovery', preview.token);
    const originalPath = `originals/${fixture.document.id}.pdf`;
    const path = join(target.documentDirectory, `${fixture.document.id}.original`);
    linkSync(join(stage, originalPath), path);
    const installed = { kind: 'document', name: `${fixture.document.id}.original`, originalPath, sha256: fixture.document.sha256, bytes: pdf.length };
    let journal = JSON.stringify([installed]);
    if (fault === 'pending-json') journal = '[{"kind":';
    if (fault === 'pending-value') journal = JSON.stringify([installed, { ...installed, originalPath: '../outside' }]);
    if (fault === 'missing-stage-file') {
      const missingId = '0'.repeat(64);
      writeFileSync(join(target.documentDirectory, `${missingId}.original`), pdf);
      journal = JSON.stringify([installed, { ...installed, name: `${missingId}.original`, originalPath: `originals/${missingId}.pdf`, sha256: missingId }]);
    }
    writeFileSync(join(stage, 'owner.json'), fault === 'owner-json' ? '{"pid":' : JSON.stringify({ pid: fault === 'owner-value' ? 'unknown' : 2147483647 }));
    writeFileSync(join(stage, 'pending.json'), journal);
    const restarted = createDocumentRecovery({ directory: target.documentDirectory, sourceDirectory: target.sourceDirectory, financePath: target.financePath, documents: target.documents });
    assert.deepEqual(readFileSync(path), pdf, fault);
    assert.equal(readFileSync(join(stage, 'pending.json'), 'utf8'), journal, fault);
    assert.deepEqual(readFileSync(join(stage, originalPath)), pdf, fault);
    const health = restarted.health(target.finance.state());
    assert.equal(health.incompleteRecoveries, 1, fault);
    assert.equal(health.issues[0].kind, 'incomplete_recovery', fault);
    assert.match(health.issues[0].message, /preserved for inspection/);
    assert.deepEqual(target.documents.list().documents, [], fault);
  }
});
