import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { csvHeaders } from '../shared/statement-mapping.ts';
import { MAX_DOCUMENT_ARCHIVE_BYTES } from '../shared/recovery.ts';
import type { DocumentList, DocumentMetadata } from '../shared/documents.ts';
export type { DocumentList, DocumentMetadata } from '../shared/documents.ts';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const sourceExtensions: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/heic': 'heic', 'text/csv; charset=utf-8': 'csv', 'application/json; charset=utf-8': 'json' };
export interface DocumentArchiveSource { sha256: string; sourceFiles: string[]; mimeType: string; bytes: Buffer }
type EditableMetadata = Pick<DocumentMetadata, 'kind' | 'accountId' | 'documentDate' | 'periodStart' | 'periodEnd' | 'notes' | 'amountCents' | 'currency' | 'expenseUse' | 'merchant' | 'reviewStatus'>;
export class DocumentError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(message: string): never { throw new DocumentError(400, message); }
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Document metadata must be an object.');
  return raw as Record<string, unknown>;
}
function text(raw: unknown, name: string, max: number, empty = false): string {
  if (typeof raw !== 'string' || raw.length > max || !empty && !raw.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) fail(`${name} must be text of at most ${max} characters.`);
  return raw.trim();
}
function choice<T extends string>(raw: unknown, choices: readonly T[], name: string): T {
  if (typeof raw !== 'string' || !choices.includes(raw as T)) fail(`${name} is not supported.`);
  return raw as T;
}
function nullableDate(raw: unknown, name: string): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = text(raw, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(`${name} must be a valid YYYY-MM-DD date.`);
  return value;
}
function editable(raw: Record<string, unknown>, previous?: DocumentMetadata): EditableMetadata {
  const value = (key: keyof EditableMetadata, fallback: unknown) => Object.hasOwn(raw, key) ? raw[key] : previous?.[key] ?? fallback;
  const periodStart = nullableDate(value('periodStart', null), 'Period start');
  const periodEnd = nullableDate(value('periodEnd', null), 'Period end');
  if ((periodStart === null) !== (periodEnd === null) || periodStart !== null && periodEnd! < periodStart) fail('Enter both statement period dates, with the end on or after the start.');
  const rawAmount = value('amountCents', null);
  if (rawAmount !== null && (typeof rawAmount !== 'number' || !Number.isSafeInteger(rawAmount) || rawAmount < 0 || rawAmount > 100_000_000_000_000)) fail('Document amount must be whole cents from zero to 100000000000000, or blank.');
  const accountId = value('accountId', null);
  return { kind: choice(value('kind', 'other'), ['statement', 'receipt', 'other'] as const, 'Document kind'), accountId: accountId === null || accountId === '' ? null : text(accountId, 'Account ID', 200), documentDate: nullableDate(value('documentDate', null), 'Document date'), periodStart, periodEnd, notes: text(value('notes', ''), 'Document notes', 4000, true), amountCents: rawAmount as number | null, currency: choice(value('currency', 'CAD'), ['CAD'] as const, 'Currency'), expenseUse: choice(value('expenseUse', 'unknown'), ['personal', 'business', 'mixed', 'unknown'] as const, 'Expense use'), merchant: text(value('merchant', ''), 'Merchant', 200, true), reviewStatus: choice(value('reviewStatus', 'needs_review'), ['needs_review', 'reviewed'] as const, 'Review status') };
}
export function fileType(bytes: Buffer, name?: unknown): { mimeType: DocumentMetadata['mimeType']; extension: string } {
  if (bytes.length >= 8 && /^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) return { mimeType: 'application/pdf', extension: '.pdf' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: 'image/png', extension: '.png' };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mimeType: 'image/jpeg', extension: '.jpg' };
  if (bytes.length >= 16 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const boxBytes = bytes.readUInt32BE(0);
    if (boxBytes >= 16 && boxBytes <= bytes.length && boxBytes <= 1024 && boxBytes % 4 === 0) {
      const brands = [bytes.subarray(8, 12).toString('ascii')];
      for (let offset = 16; offset < boxBytes; offset += 4) brands.push(bytes.subarray(offset, offset + 4).toString('ascii'));
      if (!brands.some(brand => ['avif', 'avis'].includes(brand)) && brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand))) return { mimeType: 'image/heic', extension: '.heic' };
    }
  }
  if (typeof name === 'string' && /\.csv$/i.test(name)) {
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new DocumentError(415, 'A statement CSV must contain valid UTF-8 text.'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(source)) throw new DocumentError(415, 'A statement CSV cannot contain binary control characters.');
    try { csvHeaders(source); }
    catch (error) { throw new DocumentError(415, error instanceof Error ? error.message : 'The statement CSV is invalid.'); }
    return { mimeType: 'text/csv; charset=utf-8', extension: '.csv' };
  }
  throw new DocumentError(415, 'Choose a PDF, PNG, JPEG, HEIC, or complete statement CSV. Its contents must match the file type.');
}
function originalName(raw: unknown, extension: string): string {
  const name = text(raw, 'Original filename', 500).replace(/\\/g, '/').split('/').at(-1)!.normalize('NFKC').replace(/[<>:"|?*\u0000-\u001f\u007f]/gu, '_').replace(/^\.+|[. ]+$/g, '').trim();
  const stem = name.replace(/\.[^.]*$/, '').slice(0, 150).trim() || 'document';
  return `${stem}${extension}`;
}
export function validateArchivedDocument(input: unknown, bytes: Buffer): DocumentMetadata {
  const raw = object(input);
  const detected = fileType(bytes, raw.originalName);
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentError(413, 'An archived document exceeds the 25 MB file limit.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (raw.id !== hash || raw.sha256 !== hash || raw.bytes !== bytes.length || raw.mimeType !== detected.mimeType) fail('An archived document does not match its saved identity, size, type, or SHA-256.');
  if (originalName(raw.originalName, detected.extension) !== raw.originalName) fail('An archived document has an invalid original filename.');
  const createdAt = text(raw.createdAt, 'Document creation date', 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) fail('An archived document has an invalid creation date.');
  const revision = raw.revision ?? 0;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0 || Number(revision) >= Number.MAX_SAFE_INTEGER) fail('An archived document has an invalid revision.');
  return { id: hash, sha256: hash, bytes: bytes.length, mimeType: detected.mimeType, originalName: raw.originalName as string, createdAt, revision: Number(revision), ...editable(raw) };
}
function documentId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw new DocumentError(404, 'Document was not found.');
  return raw;
}
export function documentRevisionFloor(database: DatabaseSync): number {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='document_restore_state'").get()) return -1;
  const saved = database.prepare('SELECT revision FROM document_restore_state WHERE id=1').get() as { revision: number } | undefined;
  if (!saved) return -1;
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 0 || saved.revision >= Number.MAX_SAFE_INTEGER) throw new DocumentError(500, 'The document restore revision is invalid.');
  return saved.revision;
}
function insertionRevision(database: DatabaseSync, archivedRevision = 0): number {
  return checkedRevision(Math.max(archivedRevision, documentRevisionFloor(database) + 1));
}
function checkedRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) fail('The document revision exceeds the supported range.');
  return revision;
}
export function sourceFilename(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\/<>:"|?*\u0000-\u001f\u007f]/u.test(value) || /[. ]$/.test(value) || value === '.' || value === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || !/\.(csv|json|pdf|png|jpe?g|heic)$/i.test(value)) fail('An archived review source has an unsafe filename.');
  return value;
}
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function tarHeader(name: string, size: number, modifiedAt: string): Buffer {
  const header = Buffer.alloc(512);
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, '0')}\0`;
  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o600, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(Math.floor(Date.parse(modifiedAt) / 1000), 12), 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}
function* tarEntry(name: string, bytes: Buffer, modifiedAt: string): Generator<Buffer> {
  yield tarHeader(name, bytes.length, modifiedAt);
  yield bytes;
  if (bytes.length % 512) yield Buffer.alloc(512 - bytes.length % 512);
}

export function createDocumentStore(directory: string, accountExists: (id: string) => boolean = () => true) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'documents.sqlite');
  const database = new DatabaseSync(path);
  if (process.platform !== 'win32') for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, metadata TEXT NOT NULL); CREATE TABLE IF NOT EXISTS document_recoveries (token TEXT PRIMARY KEY, receipt TEXT NOT NULL CHECK(json_valid(receipt)));');
  const get = database.prepare('SELECT metadata FROM documents WHERE id = ?');
  const list = database.prepare('SELECT metadata FROM documents ORDER BY json_extract(metadata, \'$.createdAt\') DESC, id');
  const insert = database.prepare('INSERT INTO documents (id, metadata) VALUES (?, ?)');
  const update = database.prepare('UPDATE documents SET metadata = ? WHERE id = ?');
  const decode = (row: unknown) => ({ revision: 0, ...JSON.parse((row as { metadata: string }).metadata) }) as DocumentMetadata;
  function find(id: string): DocumentMetadata {
    const row = get.get(documentId(id));
    if (!row) throw new DocumentError(404, 'Document was not found.');
    return decode(row);
  }
  function content(id: string): { document: DocumentMetadata; bytes: Buffer } {
    const document = find(id);
    const sourcePath = join(directory, `${document.id}.original`);
    if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) throw new DocumentError(500, 'The original document is missing from this computer.');
    const size = lstatSync(sourcePath).size;
    if (size !== document.bytes || size > MAX_DOCUMENT_BYTES) throw new DocumentError(500, 'The original document no longer matches its saved SHA-256.');
    const bytes = readFileSync(sourcePath);
    if (bytes.length !== document.bytes || createHash('sha256').update(bytes).digest('hex') !== document.sha256) throw new DocumentError(500, 'The original document no longer matches its saved SHA-256.');
    return { document, bytes };
  }
  function namedContent(name: string): { document: DocumentMetadata; bytes: Buffer } | null {
    const normalized = name.normalize('NFC').toLowerCase();
    const matches = list.all().map(decode).filter(document => document.originalName.normalize('NFC').toLowerCase() === normalized);
    if (matches.length > 1) throw new DocumentError(409, 'More than one original has this filename. Open the matching file in Documents.');
    return matches.length === 1 ? content(matches[0].id) : null;
  }
  function upload(bytes: Buffer, input: unknown): { document: DocumentMetadata; duplicate: boolean } {
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail('Choose a nonempty document.');
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentError(413, 'Each document must be no larger than 25 MB.');
    const raw = object(input);
    const detected = fileType(bytes, raw.originalName);
    const allowed = new Set(['originalName', 'kind', 'accountId', 'documentDate', 'periodStart', 'periodEnd', 'notes', 'amountCents', 'currency', 'expenseUse', 'merchant', 'reviewStatus']);
    if (Object.keys(raw).some(key => !allowed.has(key))) fail('Document upload contains unsupported metadata fields.');
    if (raw.reviewStatus !== undefined && raw.reviewStatus !== 'needs_review') fail('New uploads need review. Mark a document reviewed after inspecting it.');
    const fields = editable(raw);
    const id = createHash('sha256').update(bytes).digest('hex');
    const document: DocumentMetadata = { id, originalName: originalName(raw.originalName, detected.extension), mimeType: detected.mimeType, bytes: bytes.length, sha256: id, ...fields, createdAt: new Date().toISOString(), reviewStatus: 'needs_review', revision: 0 };
    const original = join(directory, `${id}.original`);
    const temporary = join(directory, `${id}-${randomUUID()}.tmp`);
    let createdOriginal = false;
    function installOriginal(): void {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, original);
      createdOriginal = true;
      syncDirectory(directory);
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = get.get(id);
      if (existing) {
        try { lstatSync(original); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          installOriginal();
        }
        const saved = content(id).document;
        database.exec('COMMIT');
        return { document: saved, duplicate: true };
      }
      if (fields.accountId !== null && !accountExists(fields.accountId)) fail('Choose an existing account for this document.');
      document.revision = insertionRevision(database);
      if (existsSync(original)) {
        if (!lstatSync(original).isFile() || createHash('sha256').update(readFileSync(original)).digest('hex') !== id) throw new DocumentError(500, 'The saved document path contains different data. The upload was not applied.');
      } else installOriginal();
      insert.run(id, JSON.stringify(document));
      database.exec('COMMIT');
      return { document, duplicate: false };
    } catch (error) {
      database.exec('ROLLBACK');
      rmSync(temporary, { force: true });
      if (createdOriginal) { rmSync(original, { force: true }); syncDirectory(directory); }
      throw error;
    }
  }
  function patch(id: string, input: unknown): DocumentMetadata {
    const raw = object(input);
    const allowed = new Set(['kind', 'accountId', 'documentDate', 'periodStart', 'periodEnd', 'notes', 'amountCents', 'currency', 'expenseUse', 'merchant', 'reviewStatus', 'expectedRevision']);
    if (!Object.keys(raw).some(key => key !== 'expectedRevision') || Object.keys(raw).some(key => !allowed.has(key))) fail('Choose document fields to update. File identity and original contents cannot be edited.');
    if (typeof raw.expectedRevision !== 'number' || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) fail('Document changes need the revision that was opened for editing.');
    database.exec('BEGIN IMMEDIATE');
    try {
      const previous = find(id);
      if (raw.expectedRevision !== previous.revision) throw new DocumentError(409, 'This document changed in another window. Review the latest saved details before editing again.');
      const fields = editable(raw, previous);
      if (fields.accountId !== null && fields.accountId !== previous.accountId && !accountExists(fields.accountId)) fail('Choose an existing account for this document.');
      const document = { ...previous, ...fields, revision: checkedRevision(previous.revision + 1) };
      update.run(JSON.stringify(document), id);
      database.exec('COMMIT');
      return document;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  function all(): DocumentList {
    const documents = list.all().map(decode);
    const fs = statfsSync(directory, { bigint: true });
    const available = fs.bavail * fs.bsize;
    return { documents, storage: { usedBytes: documents.reduce((sum, document) => sum + document.bytes, 0), freeBytes: Number(available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available), limitPerFileBytes: MAX_DOCUMENT_BYTES, documentCount: documents.length } };
  }
  function exportLibrary(reviewSources: DocumentArchiveSource[] = []): Generator<Buffer> {
    const documents = list.all().map(decode);
    const sourceNames = new Set<string>();
    const sourcePaths = new Set<string>();
    for (const source of reviewSources) {
      if (!Object.hasOwn(sourceExtensions, source.mimeType) || !source.sourceFiles.length || source.bytes.length > MAX_DOCUMENT_BYTES || createHash('sha256').update(source.bytes).digest('hex') !== source.sha256) throw new DocumentError(409, 'A review source does not match its saved identity, size, or type.');
      const path = `${source.sha256}.${sourceExtensions[source.mimeType]}`;
      if (sourcePaths.has(path)) throw new DocumentError(409, 'A review source is listed more than once.');
      sourcePaths.add(path);
      for (const name of source.sourceFiles) {
        const normalized = sourceFilename(name).normalize('NFC').toLowerCase();
        if (sourceNames.has(normalized)) throw new DocumentError(409, 'Review sources have duplicate or case-colliding destination names.');
        sourceNames.add(normalized);
      }
    }
    if (documents.length + sourceNames.size > 10000) throw new DocumentError(413, 'The original-file library exceeds the 10,000-file restore limit. Quit Mazal, then copy its full data folder to back it up.');
    const exportedAt = new Date().toISOString();
    const extension = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/heic': '.heic', 'text/csv; charset=utf-8': '.csv' } as const;
    const files = documents.map(document => ({ ...document, originalPath: `originals/${document.id}${extension[document.mimeType]}` }));
    const sources = reviewSources.map(source => ({ sha256: source.sha256, bytes: source.bytes.length, mimeType: source.mimeType, sourceFiles: source.sourceFiles, restorePaths: source.sourceFiles.map(name => `source-documents/${name}`), originalPath: `review-sources/${source.sha256}.${sourceExtensions[source.mimeType]}` }));
    const manifest = Buffer.from(JSON.stringify({ format: 'mazal-document-library', version: 1, exportedAt, documents: files, ...(sources.length ? { reviewSources: sources } : {}) }, null, 2));
    const entryBytes = (bytes: number) => 512 + Math.ceil(bytes / 512) * 512;
    const archiveBytes = 1024 + entryBytes(manifest.length) + files.reduce((sum, document) => sum + entryBytes(document.bytes), 0) + reviewSources.reduce((sum, source) => sum + entryBytes(source.bytes.length), 0);
    // Reserve the default zlib gzip bound before the download sends any bytes.
    const gzipBound = archiveBytes + Math.ceil(archiveBytes / 4096) + Math.ceil(archiveBytes / 16384) + Math.ceil(archiveBytes / 33554432) + 25;
    if (manifest.length > 16 * 1024 * 1024 || gzipBound > MAX_DOCUMENT_ARCHIVE_BYTES) throw new DocumentError(413, 'The original-file library exceeds the 256 MiB restore archive limit. Quit Mazal, then copy its full data folder to back it up.');
    for (const document of files) validateArchivedDocument(document, content(document.id).bytes);
    return (function* () {
      yield* tarEntry('manifest.json', manifest, exportedAt);
      for (const document of files) yield* tarEntry(document.originalPath, content(document.id).bytes, document.createdAt);
      for (const [index, source] of sources.entries()) yield* tarEntry(source.originalPath, reviewSources[index].bytes, exportedAt);
      yield Buffer.alloc(1024);
    })();
  }
  function fingerprint(): string { return createHash('sha256').update(JSON.stringify(list.all())).digest('hex'); }
  function recoveryReceipt(token: string): unknown | null {
    const row = database.prepare('SELECT receipt FROM document_recoveries WHERE token = ?').get(token) as { receipt: string } | undefined;
    return row ? JSON.parse(row.receipt) : null;
  }
  function commitRecovery(token: string, expectedFingerprint: string, additions: DocumentMetadata[], install: () => void, receipt: () => unknown): unknown {
    database.exec('BEGIN IMMEDIATE');
    try {
      if (fingerprint() !== expectedFingerprint) throw new DocumentError(409, 'Document details changed after preview. Preview the archive again.');
      if (recoveryReceipt(token)) throw new DocumentError(409, 'This recovery was already committed. Retry the saved request.');
      for (const document of additions) {
        if (get.get(document.id)) throw new DocumentError(409, 'A document was added after preview. Preview the archive again.');
        if (document.accountId !== null && !accountExists(document.accountId)) throw new DocumentError(409, 'A selected account no longer exists. Preview the archive again.');
      }
      install();
      for (const document of additions) insert.run(document.id, JSON.stringify({ ...document, revision: insertionRevision(database, document.revision) }));
      const saved = receipt();
      database.prepare('INSERT INTO document_recoveries (token, receipt) VALUES (?, ?)').run(token, JSON.stringify(saved));
      database.exec('COMMIT');
      return saved;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  return { list: all, upload, patch, content, namedContent, export: exportLibrary, fingerprint, recoveryReceipt, commitRecovery, close: () => database.close() };
}
