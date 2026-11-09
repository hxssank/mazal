import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDocumentStore, DocumentError, MAX_DOCUMENT_BYTES } from './documents.ts';
import { MAX_DOCUMENT_ARCHIVE_BYTES } from '../shared/recovery.ts';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n%%EOF\n');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const jpeg = Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]);
function heic(brand = 'heic') { const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write(brand, 8); bytes.write('mif1', 16); bytes.write(brand, 20); return bytes; }
function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-documents-'));
  const store = createDocumentStore(directory, id => id === 'card');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { directory, store };
}
function updateDocument(store: ReturnType<typeof createDocumentStore>, id: string, metadata: Record<string, unknown>) { return store.patch(id, { ...metadata, expectedRevision: store.list().documents.find(document => document.id === id)!.revision }); }
function archiveEntries(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset < bytes.length - 1024;) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const length = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, ''), 8);
    const checksum = Number.parseInt(header.subarray(148, 156).toString('ascii').trim(), 8);
    assert.equal(checksum, header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0));
    assert.equal(header.subarray(257, 263).toString('ascii'), 'ustar\0');
    assert.ok(!name.startsWith('/') && !name.includes('..'));
    entries.set(name, bytes.subarray(offset + 512, offset + 512 + length));
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  return entries;
}

test('original uploads survive restart byte-for-byte with reviewed metadata separate from financial accounts', t => {
  const { store, directory } = setup(t);
  const result = store.upload(pdf, { originalName: 'September statement.pdf', kind: 'statement', accountId: 'card', periodStart: '2026-08-15', periodEnd: '2026-09-14', notes: 'Review interest and payments.' });
  assert.equal(result.duplicate, false);
  assert.equal(result.document.reviewStatus, 'needs_review');
  assert.equal(result.document.sha256, createHash('sha256').update(pdf).digest('hex'));
  assert.equal(result.document.amountCents, null);
  assert.deepEqual(store.content(result.document.id).bytes, pdf);
  const revised = updateDocument(store, result.document.id, { reviewStatus: 'reviewed', notes: 'Checked the source pages.' });
  const storage = store.list().storage;
  assert.equal(storage.usedBytes, pdf.length);
  assert.equal(storage.documentCount, 1);
  assert.equal(storage.limitPerFileBytes, MAX_DOCUMENT_BYTES);
  assert.ok(storage.freeBytes > 0);
  store.close();
  const reopened = createDocumentStore(directory);
  try { assert.deepEqual(reopened.list().documents, [revised]); assert.deepEqual(reopened.content(result.document.id).bytes, pdf); }
  finally { reopened.close(); }
});

test('content signatures determine stored MIME and safe names instead of filename extensions', t => {
  const { store, directory } = setup(t);
  const cases = [[pdf, 'application/pdf', '.pdf'], [png, 'image/png', '.png'], [jpeg, 'image/jpeg', '.jpg'], [heic(), 'image/heic', '.heic'], [heic('heix'), 'image/heic', '.heic'], [heic('mif1'), 'image/heic', '.heic']] as const;
  for (const [bytes, mimeType, extension] of cases) {
    const { document } = store.upload(bytes, { originalName: '../../folder\\malicious.html', kind: 'receipt' });
    assert.equal(document.mimeType, mimeType);
    assert.equal(document.originalName, `malicious${extension}`);
    assert.equal(document.expenseUse, 'unknown');
    assert.equal(document.reviewStatus, 'needs_review');
    assert.ok(readdirSync(directory).includes(`${document.id}.original`));
  }
  for (const content of [Buffer.from('<html>Not a PDF</html>'), Buffer.from('GIF89a'), heic('avif'), Buffer.from('')]) assert.throws(() => store.upload(content, { originalName: 'valid.pdf', kind: 'receipt' }), DocumentError);
  assert.throws(() => store.content('../../private'), /not found/);
  assert.throws(() => store.content('f'.repeat(64)), /not found/);
});

test('same SHA upload is idempotent and cannot replace prior classification or review notes', t => {
  const { store } = setup(t);
  const first = store.upload(pdf, { originalName: 'Original.pdf', kind: 'receipt' });
  const updated = updateDocument(store, first.document.id, { amountCents: 15432, documentDate: '2026-09-24', merchant: 'Vehicle service', expenseUse: 'personal', notes: 'Personal and commuting vehicle.', reviewStatus: 'reviewed' });
  const duplicate = store.upload(pdf, { originalName: 'Another name.png', kind: 'statement', notes: 'Overwrite attempt' });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.document, updated);
  assert.equal(store.list().documents.length, 1);
  assert.equal(store.list().storage.usedBytes, pdf.length);
});

test('re-uploading a missing original repairs its source link without replacing reviewed metadata', t => {
  const { store, directory } = setup(t);
  const uploaded = store.upload(pdf, { originalName: 'Original statement.pdf', kind: 'statement', accountId: 'card' }).document;
  const reviewed = updateDocument(store, uploaded.id, { notes: 'Checked against the bank.', amountCents: 15432, reviewStatus: 'reviewed' });
  const original = join(directory, `${uploaded.id}.original`);
  rmSync(original);
  assert.throws(() => store.content(uploaded.id), /missing/);
  const repaired = store.upload(pdf, { originalName: 'Downloaded again.pdf', kind: 'other' });
  assert.equal(repaired.duplicate, true);
  assert.deepEqual(repaired.document, reviewed);
  assert.deepEqual(store.content(uploaded.id), { document: reviewed, bytes: pdf });
  assert.deepEqual(store.list().documents, [reviewed]);
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  if (process.platform !== 'win32') assert.equal(statSync(original).mode & 0o777, 0o600);
});

test('invalid money, dates, classification, account references and immutable metadata reject without changes', t => {
  const { store } = setup(t);
  const { document } = store.upload(pdf, { originalName: 'Receipt.pdf', kind: 'receipt' });
  const baseline = store.list().documents;
  for (const patch of [{ amountCents: -1 }, { amountCents: 1.1 }, { amountCents: Number.MAX_SAFE_INTEGER }, { documentDate: '2026-02-30' }, { periodStart: '2026-01-01' }, { periodStart: '2026-02-01', periodEnd: '2026-01-01' }, { currency: 'USD' }, { expenseUse: 'deductible' }, { reviewStatus: 'approved' }, { accountId: 'missing' }, { originalName: 'Replacement.pdf' }, { id: 'f'.repeat(64) }, { sha256: 'f'.repeat(64) }, { notes: 'a'.repeat(4001) }, {}]) {
    assert.throws(() => updateDocument(store, document.id, patch));
    assert.deepEqual(store.list().documents, baseline);
  }
  assert.throws(() => store.upload(png, { originalName: 'Image.png', kind: 'receipt', reviewStatus: 'reviewed' }), /need review/);
  assert.throws(() => store.upload(png, { originalName: 'Image.png', kind: 'receipt', accountId: 'missing' }), /existing account/);
  assert.equal(store.list().documents.length, 1);
  updateDocument(store, document.id, { amountCents: 0, documentDate: '2026-02-28', accountId: 'card' });
  const cleared = updateDocument(store, document.id, { amountCents: null, documentDate: null, accountId: null });
  assert.equal(cleared.amountCents, null);
  assert.equal(cleared.documentDate, null);
  assert.equal(cleared.accountId, null);
});

test('oversized files and metadata insertion failures leave no partial document or temporary upload', t => {
  const { store, directory } = setup(t);
  const oversized = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
  pdf.copy(oversized);
  assert.throws(() => store.upload(oversized, { originalName: 'Too large.pdf', kind: 'receipt' }), /25 MB/);
  const second = new DatabaseSync(join(directory, 'documents.sqlite'));
  second.exec("CREATE TRIGGER fail_document_insert BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, 'simulated metadata write failure'); END;");
  try { assert.throws(() => store.upload(pdf, { originalName: 'Failed.pdf', kind: 'receipt' }), /simulated metadata write failure/); }
  finally { second.exec('DROP TRIGGER fail_document_insert'); second.close(); }
  assert.equal(store.list().documents.length, 0);
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.tmp') || name.endsWith('.original')), []);
  assert.equal(store.upload(pdf, { originalName: 'Saved.pdf', kind: 'receipt' }).duplicate, false);
});

test('a preserved original from an interrupted upload can recover metadata without deleting or rewriting its bytes', t => {
  const { store, directory } = setup(t);
  const id = createHash('sha256').update(pdf).digest('hex');
  const original = join(directory, `${id}.original`);
  writeFileSync(original, pdf, { mode: 0o600 });
  const before = statSync(original).mtimeMs;
  const uploaded = store.upload(pdf, { originalName: 'Recovered.pdf', kind: 'statement' });
  assert.equal(uploaded.document.id, id);
  assert.equal(statSync(original).mtimeMs, before);
  assert.deepEqual(readFileSync(original), pdf);
  writeFileSync(original, Buffer.from('Changed on disk'));
  assert.throws(() => store.content(id), /no longer matches/);
  assert.throws(() => store.upload(pdf, { originalName: 'Again.pdf', kind: 'statement' }), /no longer matches/);
  assert.equal(store.list().documents.length, 1);
});

test('library archive contains a portable manifest and every original using safe hash filenames', t => {
  const { store } = setup(t);
  const first = store.upload(pdf, { originalName: '../Receipt.pdf', kind: 'receipt', amountCents: 1200, expenseUse: 'personal' });
  const second = store.upload(png, { originalName: 'Image.png', kind: 'other' });
  const entries = archiveEntries(Buffer.concat([...store.export()]));
  const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
  assert.equal(manifest.format, 'mazal-document-library');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.documents.length, 2);
  assert.deepEqual(entries.get(`originals/${first.document.id}.pdf`), pdf);
  assert.deepEqual(entries.get(`originals/${second.document.id}.png`), png);
  assert.equal(entries.size, 3);
  const libraryFirst = manifest.documents.find((document: { id: string }) => document.id === first.document.id);
  assert.equal(libraryFirst.amountCents, 1200);
  assert.equal(libraryFirst.expenseUse, 'personal');
});

test('archive creation checks every original before returning a download stream', t => {
  const { store, directory } = setup(t);
  store.upload(pdf, { originalName: 'Valid.pdf' });
  const damaged = store.upload(png, { originalName: 'Damaged.png' }).document;
  const path = join(directory, `${damaged.id}.original`);
  rmSync(path);
  assert.throws(() => store.export(), /missing/);
  writeFileSync(path, Buffer.alloc(png.length));
  assert.throws(() => store.export(), /SHA-256/);
  writeFileSync(path, png);
  assert.ok(archiveEntries(Buffer.concat([...store.export()])).has(`originals/${damaged.id}.png`));
});

test('archive creation rejects unsafe aliases and output that would exceed restore limits before reading originals', t => {
  const { store, directory } = setup(t);
  const bytes = Buffer.from('Date,Description,Amount\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  for (const sourceFiles of [['../Review.csv'], ['Review.csv', 'review.csv']]) assert.throws(() => store.export([{ sha256, bytes, mimeType: 'text/csv; charset=utf-8', sourceFiles }]), /unsafe|case-colliding/);
  assert.throws(() => store.export([{ sha256, bytes, mimeType: 'text/csv; charset=utf-8', sourceFiles: Array.from({ length: 10001 }, (_, index) => `Review-${index}.csv`) }]), (error: unknown) => error instanceof DocumentError && error.status === 413 && /10,000/.test(error.message));
  const template = store.upload(pdf, { originalName: 'Statement.pdf' }).document;
  const database = new DatabaseSync(join(directory, 'documents.sqlite'));
  try {
    database.prepare('DELETE FROM documents').run();
    const insert = database.prepare('INSERT INTO documents (id, metadata) VALUES (?, ?)');
    for (let index = 0; index < 11; index++) {
      const id = index.toString(16).padStart(64, '0');
      const size = index < 10 ? MAX_DOCUMENT_BYTES : MAX_DOCUMENT_ARCHIVE_BYTES - 10 * MAX_DOCUMENT_BYTES - 16 * 1024;
      insert.run(id, JSON.stringify({ ...template, id, sha256: id, bytes: size }));
    }
    assert.throws(() => store.export(), (error: unknown) => error instanceof DocumentError && error.status === 413 && /256 MiB/.test(error.message));
  } finally { database.close(); }
});

test('document stores isolate workspaces and restrict local file permissions', t => {
  const { directory } = setup(t);
  const live = createDocumentStore(join(directory, 'live'));
  const sample = createDocumentStore(join(directory, 'demo'));
  try {
    const { document } = live.upload(pdf, { originalName: 'Personal.pdf', kind: 'statement' });
    assert.equal(sample.list().documents.length, 0);
    assert.throws(() => sample.content(document.id), /not found/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(directory, 'live')).mode & 0o777, 0o700);
      for (const filename of ['documents.sqlite', 'documents.sqlite-wal', 'documents.sqlite-shm', `${document.id}.original`]) assert.equal(statSync(join(directory, 'live', filename)).mode & 0o777, 0o600);
    }
  } finally { live.close(); sample.close(); }
});

test('stale document editors cannot overwrite newer notes and old metadata defaults to revision zero', t => {
  const { store, directory } = setup(t);
  const uploaded = store.upload(pdf, { originalName: 'Receipt.pdf', kind: 'receipt' }).document;
  assert.equal(uploaded.revision, 0);
  const second = createDocumentStore(directory);
  try {
    const opened = second.list().documents[0];
    const saved = store.patch(uploaded.id, { notes: 'Latest checked notes', expectedRevision: uploaded.revision });
    assert.equal(saved.revision, 1);
    assert.throws(() => second.patch(uploaded.id, { notes: 'Stale notes', expectedRevision: opened.revision }), (error: unknown) => error instanceof DocumentError && error.status === 409);
    assert.equal(second.list().documents[0].notes, 'Latest checked notes');
    assert.throws(() => store.patch(uploaded.id, { notes: 'Missing version' }), /revision/);
    const database = new DatabaseSync(join(directory, 'documents.sqlite'));
    const legacy = { ...saved } as Partial<typeof saved>;
    delete legacy.revision;
    database.prepare('UPDATE documents SET metadata = ? WHERE id = ?').run(JSON.stringify(legacy), uploaded.id);
    database.close();
    assert.equal(store.list().documents[0].revision, 0);
    assert.equal(store.content(uploaded.id).document.revision, 0);
    const manifest = JSON.parse(archiveEntries(Buffer.concat([...store.export()])).get('manifest.json')!.toString());
    assert.equal(manifest.documents[0].revision, 0);
  } finally { second.close(); }
});

test('document edits reject revision overflow without making the original impossible to back up', t => {
  const { store, directory } = setup(t);
  const uploaded = store.upload(pdf, { originalName: 'Receipt.pdf' }).document;
  const database = new DatabaseSync(join(directory, 'documents.sqlite'));
  try { database.prepare('UPDATE documents SET metadata=? WHERE id=?').run(JSON.stringify({ ...uploaded, revision: Number.MAX_SAFE_INTEGER - 2 }), uploaded.id); }
  finally { database.close(); }
  const saved = store.patch(uploaded.id, { notes: 'Last supported revision', expectedRevision: Number.MAX_SAFE_INTEGER - 2 });
  assert.equal(saved.revision, Number.MAX_SAFE_INTEGER - 1);
  assert.throws(() => store.patch(uploaded.id, { notes: 'Cannot save this revision', expectedRevision: saved.revision }), /revision exceeds/);
  assert.deepEqual(store.content(uploaded.id).document, saved);
  assert.ok(archiveEntries(Buffer.concat([...store.export()])).has('manifest.json'));
});
