import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { createStore } from './store.ts';
import { readStorageSettings, storageCollectionTables, validateStorageCollections } from './persistence.ts';
import { createDocumentStore, documentRevisionFloor, validateArchivedDocument, type DocumentMetadata } from './documents.ts';
import { createDocumentRecovery, hasUnfinishedDocumentRecovery } from './document-recovery.ts';
import { BackupError } from './backup.ts';
import type { Workspace } from '../shared/types.ts';

export const MAX_COMPLETE_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_CONTENT_BYTES = 180 * 1024 * 1024;
const MAX_COMPLETE_BACKUP_FILES = 20000;
const magic = Buffer.from('MAZAL-ENCRYPTED-1\n');
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const workspaces = ['live', 'demo'] as const;
interface BackupFile { path: string; bytes: number; sha256: string; content: string }
export interface CompleteManifest { format: 'mazal-complete-backup'; version: 1; exportedAt: string; files: BackupFile[] }
interface WorkspaceSummary { revision: number; transactions: number; documents: number; unlinkedDocuments: number }
export interface CompleteBackupPreview { token: string; exportedAt: string; encrypted: boolean; archiveSha256: string; expectedRevision: number; files: number; bytes: number; workspaces: Record<Workspace, WorkspaceSummary>; calculationFiles: number }
interface Staged { directory: string; preview: CompleteBackupPreview; fingerprint: string; stagedFingerprint: string }
interface Runtime { close(): Promise<void>; open(): Promise<void> }
const fail = (message: string): never => { throw new BackupError(400, message); };

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function syncTree(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) syncTree(path);
    else if (entry.isFile()) {
      const descriptor = openSync(path, 'r+');
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    } else fail('The staged backup contains a link or unsupported file. Verify the original backup again.');
  }
  syncDirectory(directory);
}
function ordinaryDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) fail('Backup storage cannot contain symbolic links.');
}
function safePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > 600 || /[\\<>:"|?*\u0000-\u001f\u007f]/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.length > 240 || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false;
  return /^(live|demo)\.sqlite$/.test(path)
    || /^documents\/(live|demo)\/(documents\.sqlite|[a-f0-9]{64}\.original)$/.test(path)
    || /^(source-documents|payroll-originals)\/[^/]+\.(csv|json|pdf|png|jpe?g|heic)$/i.test(path)
    || /^source-documents\/[^/]+\.txt$/i.test(path)
    || /^payroll-originals\/[^/]+\.zip$/i.test(path)
    || new RegExp(`^engine-runs/${uuid}/[A-Za-z0-9_.-]{1,100}$`).test(path)
    || new RegExp(`^engine-runs-archives/${uuid}\\.(json|zip)$`).test(path)
    || new RegExp(`^engine-runs-archives/\\.moving-${uuid}/${uuid}/[A-Za-z0-9_.-]{1,100}$`).test(path);
}
function inventory(directory: string, prefix = ''): string[] {
  ordinaryDirectory(directory);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const supportedRoot = ['documents', 'source-documents', 'payroll-originals', 'engine-runs', 'engine-runs-archives'].includes(entry.name);
    if (!prefix && !supportedRoot && !/^(live|demo)\.sqlite$/.test(entry.name)) continue;
    if (/\.(sqlite-wal|sqlite-shm)$/.test(path) || path.includes('/.recovery/')) continue;
    if (entry.name === '.recovery') continue;
    if (entry.isSymbolicLink()) fail('Complete backups cannot contain symbolic links. Keep the original folder and inspect the linked file.');
    if (entry.isDirectory()) files.push(...inventory(join(directory, entry.name), path));
    else if (entry.isFile() && safePath(path)) files.push(path);
    else fail(`The data folder contains an unsupported evidence file: ${path}. Keep a separate copy before continuing.`);
  }
  return files;
}
function fingerprint(directory: string): string {
  return hash(JSON.stringify(inventory(directory).map(path => {
    const file = join(directory, path);
    if (path.endsWith('.sqlite')) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec('BEGIN');
        const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
        const rows = tables.map(table => [table.name, db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
        db.exec('COMMIT');
        return [path, rows];
      } finally { db.close(); }
    }
    return [path, hash(readFileSync(file))];
  })));
}
function activeCalculations(directory: string): boolean {
  const runs = join(directory, 'engine-runs');
  if (!existsSync(runs)) return false;
  for (const name of readdirSync(runs)) {
    const path = join(runs, name, 'status.json');
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    try { if (['queued', 'running'].includes(JSON.parse(readFileSync(path, 'utf8')).status)) return true; } catch {}
  }
  return false;
}
function checkDocumentRecovery(directory: string): void {
  for (const workspace of workspaces) {
    const path = join(directory, 'documents', workspace, '.recovery');
    if (hasUnfinishedDocumentRecovery(path)) throw new BackupError(409, 'Finish or inspect the pending original-file recovery before creating a complete backup. Its staged files and originals have been kept unchanged.');
  }
}
async function key(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) fail('Use a backup passphrase from 12 to 1,024 characters.');
  return new Promise((resolve, reject) => scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value)));
}
export async function encodeCompleteBackup(manifest: CompleteManifest, passphrase = ''): Promise<Buffer> {
  const json = Buffer.from(JSON.stringify(manifest));
  if (json.length > MAX_COMPLETE_BACKUP_BYTES) throw new BackupError(413, 'The complete backup exceeds 256 MiB before compression.');
  const bytes = await promisify(gzip)(json);
  if (!passphrase) return bytes;
  const salt = randomBytes(16), iv = randomBytes(12);
  const header = Buffer.concat([magic, salt, iv]);
  const derived = await key(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', derived, iv);
    cipher.setAAD(header);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([header, cipher.getAuthTag(), encrypted]);
  } finally { derived.fill(0); }
}
export async function decodeCompleteBackup(input: Buffer, passphrase = ''): Promise<{ manifest: CompleteManifest; encrypted: boolean }> {
  if (!input.length || input.length > MAX_COMPLETE_BACKUP_BYTES) throw new BackupError(413, 'Choose a complete backup smaller than 256 MiB.');
  const encrypted = input.subarray(0, magic.length).equals(magic);
  let compressed = input;
  if (encrypted) {
    const start = magic.length;
    if (input.length < start + 45) fail('The encrypted backup is incomplete.');
    const derived = await key(passphrase, input.subarray(start, start + 16));
    try {
      const cipher = createDecipheriv('aes-256-gcm', derived, input.subarray(start + 16, start + 28));
      cipher.setAAD(input.subarray(0, start + 28)); cipher.setAuthTag(input.subarray(start + 28, start + 44));
      compressed = Buffer.concat([cipher.update(input.subarray(start + 44)), cipher.final()]);
    } catch { fail('The passphrase is incorrect or the encrypted backup is damaged.'); }
    finally { derived.fill(0); }
  }
  let manifest: CompleteManifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await promisify(gunzip)(compressed, { maxOutputLength: MAX_COMPLETE_BACKUP_BYTES }))); }
  catch { return fail('Choose an intact Mazal complete backup. Its decompressed size must be below 256 MiB.'); }
  if (manifest?.format !== 'mazal-complete-backup' || manifest.version !== 1 || typeof manifest.exportedAt !== 'string' || !Number.isFinite(Date.parse(manifest.exportedAt)) || new Date(manifest.exportedAt).toISOString() !== manifest.exportedAt || !Array.isArray(manifest.files) || manifest.files.length > MAX_COMPLETE_BACKUP_FILES) fail('The complete backup manifest is invalid.');
  const paths = new Set<string>(); let total = 0;
  for (const file of manifest.files) {
    if (!file || !safePath(file.path) || paths.has(file.path.normalize('NFC').toLowerCase()) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.content !== 'string' || file.content.length !== 4 * Math.ceil(file.bytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content) || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('The complete backup contains an invalid or duplicate file.');
    total += file.bytes; if (total > MAX_CONTENT_BYTES) throw new BackupError(413, 'The complete backup contains more than 180 MiB of records and evidence.');
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length !== file.bytes || bytes.toString('base64') !== file.content || hash(bytes) !== file.sha256) fail('A complete-backup file does not match its size or SHA-256.');
    paths.add(file.path.normalize('NFC').toLowerCase());
  }
  for (const workspace of workspaces) if (!paths.has(`${workspace}.sqlite`) || !paths.has(`documents/${workspace}/documents.sqlite`)) fail('The complete backup is missing a financial or document database.');
  return { manifest, encrypted };
}
function verifyDirectory(directory: string): Record<Workspace, WorkspaceSummary> {
  const result = {} as Record<Workspace, WorkspaceSummary>;
  for (const workspace of workspaces) {
    for (const path of [`${workspace}.sqlite`, `documents/${workspace}/documents.sqlite`]) {
      const db = new DatabaseSync(join(directory, path), { readOnly: true });
      try {
        const tables = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]).map(table => table.name));
        const requireTables = (names: string[]) => {
          if (names.some(name => !tables.has(name))) fail('A backup database is missing required storage tables. Keep it for inspection and choose a complete copy.');
        };
        const hasRecords = (table: string) => tables.has(table) && Boolean(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
        if (path === `${workspace}.sqlite`) {
          const meta = tables.has('workspace_meta') ? db.prepare('SELECT workspace, schema_version, settings FROM workspace_meta WHERE id=1').get() as { workspace: string; schema_version: number; settings: string } | undefined : undefined;
          if (tables.has('workspace_meta') && !meta) fail('A backup database is missing its saved workspace metadata.');
          if (meta) {
            if (meta.workspace !== workspace || meta.schema_version !== 2) fail('A backup database belongs to a different workspace or uses an unsupported storage version.');
            const { presentCollections: names } = readStorageSettings(meta.settings);
            validateStorageCollections(db, names);
          } else {
            requireTables(['workspace_state']);
            if ([...Object.values(storageCollectionTables), 'collection_records', 'statement_rows', 'import_source_rows', 'import_decisions', 'transaction_import_sources'].some(hasRecords)) fail('A backup database has relational records without their workspace metadata. Keep it for inspection and choose a complete copy.');
            const legacy = db.prepare('SELECT workspace, document FROM workspace_state WHERE id=1').get() as { workspace: string; document: string } | undefined;
            if (!legacy || legacy.workspace !== workspace || typeof legacy.document !== 'string') fail('A backup database is missing its saved workspace.');
          }
        } else {
          requireTables(['documents']);
          db.prepare('SELECT id, metadata FROM documents LIMIT 0').all();
        }
        if (JSON.stringify(db.prepare('PRAGMA integrity_check').all()) !== '[{"integrity_check":"ok"}]' || db.prepare('PRAGMA foreign_key_check').all().length) fail('A backup database failed its integrity check.');
      } catch (error) {
        if (error instanceof BackupError) throw error;
        fail('A backup database has invalid storage metadata. Keep it for inspection and choose a complete copy.');
      }
      finally { db.close(); }
    }
  }
  for (const workspace of workspaces) {
    const store = createStore(join(directory, `${workspace}.sqlite`), workspace);
    const documents = createDocumentStore(join(directory, 'documents', workspace), id => store.state().accounts.some(account => account.id === id));
    try {
      const state = store.state();
      for (const document of documents.list().documents) validateArchivedDocument(document, documents.content(document.id).bytes);
      const recovery = createDocumentRecovery({ directory: join(directory, 'documents', workspace), sourceDirectory: join(directory, 'source-documents'), financePath: join(directory, `${workspace}.sqlite`), documents }).health(state);
      if (recovery.missingOriginals || recovery.damagedOriginals || recovery.missingStatementSources || recovery.missingSourceReferences || recovery.missingAccountLinks || recovery.incompleteRecoveries) fail('The complete backup has missing originals, damaged evidence, or broken account links. Keep it for inspection and choose a complete copy.');
      result[workspace] = { revision: state.revision, transactions: state.transactions.length, documents: recovery.documents, unlinkedDocuments: recovery.unlinkedDocuments };
    } finally { documents.close(); store.close(); }
  }
  return result;
}
function advanceDocumentRevisions(currentPath: string, restoredPath: string): void {
  const current = new DatabaseSync(currentPath, { readOnly: true });
  const restored = new DatabaseSync(restoredPath);
  try {
    const highestRevision = (database: DatabaseSync) => {
      let highest = documentRevisionFloor(database);
      for (const row of database.prepare('SELECT metadata FROM documents').all() as { metadata: string }[]) {
        const revision = (JSON.parse(row.metadata) as DocumentMetadata).revision ?? 0;
        if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) fail('A document revision exceeds the supported range.');
        highest = Math.max(highest, revision);
      }
      return highest;
    };
    const revision = Math.max(highestRevision(current), highestRevision(restored)) + 1;
    if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER) fail('A restored document revision exceeds the supported range.');
    const update = restored.prepare('UPDATE documents SET metadata=? WHERE id=?');
    restored.exec('BEGIN IMMEDIATE');
    try {
      for (const row of restored.prepare('SELECT id, metadata FROM documents').all() as { id: string; metadata: string }[]) {
        const document = JSON.parse(row.metadata) as DocumentMetadata;
        update.run(JSON.stringify({ ...document, revision }), row.id);
      }
      restored.exec('CREATE TABLE IF NOT EXISTS document_restore_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision >= 0)) STRICT');
      restored.prepare('INSERT INTO document_restore_state(id,revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision').run(revision);
      restored.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) { if (restored.isTransaction) restored.exec('ROLLBACK'); throw error; }
  } finally { current.close(); restored.close(); }
}
function journalPath(directory: string): string { return join(dirname(directory), `.${basename(directory)}.complete-restore.json`); }
export function recoverCompleteRestore(directory: string, allowProtected = false): void {
  const path = journalPath(directory);
  if (!existsSync(path)) return;
  if (!lstatSync(path).isFile() || lstatSync(path).size > 4096) fail('The complete-restore journal needs inspection. Existing folders were kept.');
  const value = JSON.parse(readFileSync(path, 'utf8')) as { previous: string; stage: string; version: number };
  if (value.version !== 1 || !new RegExp(`^\\.mazal-before-${uuid}$`).test(value.previous) || !new RegExp(`^\\.mazal-restore-${uuid}$`).test(value.stage)) fail('The complete-restore journal is invalid. Existing folders were kept.');
  const previous = join(dirname(directory), value.previous), stage = join(dirname(directory), value.stage);
  if (!allowProtected && [directory, previous].some(folder => existsSync(join(folder, '.desktop-only')))) fail('Open Mazal.app to recover these protected records.');
  if (existsSync(previous)) {
    ordinaryDirectory(previous);
    if (existsSync(directory)) renameSync(directory, existsSync(stage) ? join(dirname(directory), `.mazal-interrupted-${randomUUID()}`) : stage);
    renameSync(previous, directory); syncDirectory(dirname(directory));
  } else if (!existsSync(directory)) fail('The interrupted restore has no current or previous data folder. Restore requires inspection.');
  rmSync(path); syncDirectory(dirname(directory));
}

export function createCompleteBackupService(directory: string, runtime: Runtime) {
  let staged: Staged | undefined;
  let receipt: { token: string; expectedRevision: number; previousDirectory: string } | undefined;
  async function exportArchive(passphrase = ''): Promise<Buffer> {
    checkDocumentRecovery(directory);
    if (activeCalculations(directory)) throw new BackupError(409, 'Wait for running calculations to finish or cancel them before creating a complete backup.');
    const before = fingerprint(directory);
    const paths = inventory(directory);
    if (paths.length > MAX_COMPLETE_BACKUP_FILES) throw new BackupError(413, 'Complete backups support up to 20,000 files. Keep a full data-folder copy for larger installations.');
    const temporary = join(dirname(directory), `.mazal-snapshot-${randomUUID()}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      const files: BackupFile[] = []; let total = 0;
      for (const path of paths) {
        let bytes: Buffer;
        if (path.endsWith('.sqlite')) {
          const target = join(temporary, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          const database = new DatabaseSync(join(directory, path), { readOnly: true });
          try { await backup(database, target); } finally { database.close(); }
          bytes = readFileSync(target);
        } else {
          bytes = readFileSync(join(directory, path));
          const target = join(temporary, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
        }
        total += bytes.length; if (total > MAX_CONTENT_BYTES) throw new BackupError(413, 'Complete backups support up to 180 MiB of records and evidence. Keep a full data-folder copy for larger installations.');
        files.push({ path, bytes: bytes.length, sha256: hash(bytes), content: bytes.toString('base64') });
      }
      verifyDirectory(temporary);
      checkDocumentRecovery(directory);
      if (fingerprint(directory) !== before || activeCalculations(directory)) throw new BackupError(409, 'Records or calculations changed during the backup. Try again.');
      return await encodeCompleteBackup({ format: 'mazal-complete-backup', version: 1, exportedAt: new Date().toISOString(), files }, passphrase);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  async function preview(input: Buffer, passphrase = ''): Promise<CompleteBackupPreview> {
    const { manifest, encrypted } = await decodeCompleteBackup(input, passphrase);
    const token = randomUUID(), target = join(dirname(directory), `.mazal-restore-${token}`);
    mkdirSync(target, { mode: 0o700 });
    try {
      for (const file of manifest.files) {
        const path = join(target, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: 0o600, flush: true });
      }
      const summaries = verifyDirectory(target);
      const current = new DatabaseSync(join(directory, 'live.sqlite'), { readOnly: true });
      let revision: number;
      try { revision = (current.prepare('SELECT revision FROM workspace_meta WHERE id=1').get() as { revision: number }).revision; } finally { current.close(); }
      const result: CompleteBackupPreview = { token, exportedAt: manifest.exportedAt, encrypted, archiveSha256: hash(input), expectedRevision: revision, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), workspaces: summaries, calculationFiles: manifest.files.filter(file => file.path.startsWith('engine-runs')).length };
      if (staged) rmSync(staged.directory, { recursive: true, force: true });
      staged = { directory: target, preview: result, fingerprint: fingerprint(directory), stagedFingerprint: fingerprint(target) };
      return result;
    } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
  }
  async function restore(input: { token?: unknown; expectedRevision?: unknown; confirmation?: unknown }) {
    if (input?.confirmation !== true || typeof input.token !== 'string' || !Number.isSafeInteger(input.expectedRevision)) fail('Confirm the complete backup and its current revision before restoring.');
    if (receipt && receipt.token === input.token && receipt.expectedRevision === input.expectedRevision) return { status: 'restored', ...receipt };
    if (!staged || staged.preview.token !== input.token) throw new BackupError(404, 'Verify the complete backup again before restoring.');
    if (staged.preview.expectedRevision !== input.expectedRevision || fingerprint(directory) !== staged.fingerprint) throw new BackupError(409, 'Records, originals, or calculation evidence changed after verification. Verify the backup again.');
    if (activeCalculations(directory)) throw new BackupError(409, 'Finish or cancel running calculations before restoring a complete backup.');
    const target = staged.directory;
    if (fingerprint(target) !== staged.stagedFingerprint) throw new BackupError(409, 'The staged backup changed after verification. Verify the original backup again.');
    verifyDirectory(target);
    for (const workspace of workspaces) {
      const current = new DatabaseSync(join(directory, `${workspace}.sqlite`), { readOnly: true });
      const next = new DatabaseSync(join(target, `${workspace}.sqlite`));
      try {
        const old = (current.prepare('SELECT revision FROM workspace_meta WHERE id=1').get() as { revision: number }).revision;
        const archived = (next.prepare('SELECT revision FROM workspace_meta WHERE id=1').get() as { revision: number }).revision;
        const revision = Math.max(old, archived) + 1; if (!Number.isSafeInteger(revision)) fail('The restored revision exceeds the supported range.');
        const audit = { id: randomUUID(), date: new Date().toISOString(), action: 'complete_restore', description: `Restored a complete backup from ${staged.preview.exportedAt}. The previous data folder was preserved.` };
        next.exec('BEGIN IMMEDIATE');
        next.prepare('UPDATE workspace_meta SET revision=? WHERE id=1').run(revision);
        next.prepare('INSERT INTO audit_events(id,position,data,date,action) VALUES(?,(SELECT COALESCE(MAX(position),-1)+1 FROM audit_events),?,?,?)').run(audit.id, JSON.stringify(audit), audit.date, audit.action);
        next.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { current.close(); next.close(); }
      advanceDocumentRevisions(join(directory, 'documents', workspace, 'documents.sqlite'), join(target, 'documents', workspace, 'documents.sqlite'));
    }
    if (existsSync(join(directory, '.desktop-only'))) writeFileSync(join(target, '.desktop-only'), 'Mazal desktop authentication required.\n', { mode: 0o600, flag: 'wx', flush: true });
    syncTree(target);
    const previous = join(dirname(directory), `.mazal-before-${randomUUID()}`);
    const journal = journalPath(directory);
    writeFileSync(journal, JSON.stringify({ version: 1, previous: basename(previous), stage: basename(target) }), { mode: 0o600, flag: 'wx', flush: true }); syncDirectory(dirname(directory));
    try {
      await runtime.close();
      if (fingerprint(directory) !== staged.fingerprint) throw new BackupError(409, 'Records changed while the restore was preparing. Verify the backup again.');
      renameSync(directory, previous); syncDirectory(dirname(directory));
      renameSync(target, directory); syncDirectory(dirname(directory));
      await runtime.open();
      rmSync(journal); syncDirectory(dirname(directory));
      receipt = { token: input.token, expectedRevision: Number(input.expectedRevision), previousDirectory: previous };
      staged = undefined;
      return { status: 'restored', ...receipt };
    } catch (error) {
      await runtime.close().catch(() => undefined);
      recoverCompleteRestore(directory, true);
      await runtime.open();
      staged = undefined;
      throw error;
    }
  }
  function close(): void {
    if (staged && !existsSync(journalPath(directory))) { rmSync(staged.directory, { recursive: true, force: true }); staged = undefined; }
  }
  return { exportArchive, preview, restore, close };
}
