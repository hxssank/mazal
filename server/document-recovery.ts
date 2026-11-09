import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { createDocumentStore, DocumentError, MAX_DOCUMENT_BYTES, type DocumentMetadata } from './documents.ts';
import { sourceFilename, type ArchivedSource } from './document-archive.ts';
import { statementReviewSources } from './review-sources.ts';
import type { AppState } from '../shared/types.ts';
import type { DocumentRecoveryHealth, DocumentRestoreCommit, DocumentRestorePreview, DocumentRestoreResult } from '../shared/recovery.ts';

interface StagedArchive { archiveSha256: string; manifest: Record<string, unknown>; documents: (DocumentMetadata & { originalPath: string })[]; reviewSources: ArchivedSource[] }
interface PreviewRecord { archive: StagedArchive; preview: DocumentRestorePreview; fingerprint: string; files: string }
interface Install { kind: 'document' | 'source'; name: string; originalPath: string; sha256: string; bytes: number }
interface Receipt { requestHash: string; manifest: unknown; accountMappings: Record<string, string | null>; result: DocumentRestoreResult }
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function hasUnfinishedDocumentRecovery(stages: string): boolean {
  const details = lstatSync(stages, { throwIfNoEntry: false });
  if (!details) return false;
  if (!details.isDirectory()) return true;
  return readdirSync(stages).some(token => {
    const stage = join(stages, token);
    if (!tokenPattern.test(token) || !lstatSync(stage).isDirectory() || lstatSync(join(stage, 'pending.json'), { throwIfNoEntry: false })) return true;
    try {
      const marker = join(stage, 'preview.json');
      const file = lstatSync(marker);
      if (!file.isFile() || file.size > 256) return true;
      const value = JSON.parse(readFileSync(marker, 'utf8'));
      return value?.version !== 1 || value.token !== token;
    } catch { return true; }
  });
}
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function directory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new DocumentError(409, 'A recovery directory is not an ordinary directory.');
}
function fileState(path: string, sha256: string, bytes?: number): 'missing' | 'matching' | 'conflict' {
  let details;
  try { details = lstatSync(path); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing'; throw error; }
  if (!details.isFile() || details.size > MAX_DOCUMENT_BYTES || bytes !== undefined && details.size !== bytes) return 'conflict';
  return hash(readFileSync(path)) === sha256 ? 'matching' : 'conflict';
}
function payrollSources(state: AppState) {
  return [...new Map((state.payrollImports ?? []).flatMap(batch => batch.sources).map(source => [source.sha256, source])).values()];
}

export function createDocumentRecovery(options: { directory: string; sourceDirectory: string; financePath: string; documents: ReturnType<typeof createDocumentStore> }) {
  const { documents, sourceDirectory, financePath } = options;
  const stages = join(options.directory, '.recovery');
  directory(stages);
  const pending = new Map<string, PreviewRecord>();
  const incompleteStages = new Set<string>();
  let decoding = false;
  const target = (item: Install): string => {
    if (item.kind === 'document' && /^[a-f0-9]{64}\.original$/.test(item.name)) return join(options.directory, item.name);
    if (item.kind === 'source') return join(sourceDirectory, sourceFilename(item.name));
    throw new DocumentError(500, 'The recovery journal contains an invalid destination.');
  };
  function readJournal(path: string, maximum: number): unknown {
    const details = lstatSync(path);
    if (!details.isFile() || details.size > maximum) throw new DocumentError(500, 'The recovery journal is not an ordinary bounded file.');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  function validatePlan(value: unknown): Install[] {
    if (!Array.isArray(value) || value.length > 10000) throw new DocumentError(500, 'The recovery journal is invalid.');
    const destinations = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.originalPath !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.kind === 'document' && item.bytes === 0 || item.bytes > MAX_DOCUMENT_BYTES) throw new DocumentError(500, 'The recovery journal contains an invalid file.');
      const originalPattern = item.kind === 'document' ? /^originals\/[a-f0-9]{64}\.(pdf|png|jpg|heic|csv)$/ : item.kind === 'source' ? /^review-sources\/[a-f0-9]{64}\.(csv|json|pdf|png|jpg|heic)$/ : null;
      if (!originalPattern?.test(item.originalPath) || basename(item.originalPath).split('.')[0] !== item.sha256 || item.kind === 'document' && item.name !== `${item.sha256}.original`) throw new DocumentError(500, 'The recovery journal contains an invalid staged path.');
      const destination = target(item);
      if (destinations.has(destination)) throw new DocumentError(500, 'The recovery journal contains a duplicate destination.');
      destinations.add(destination);
    }
    return value as Install[];
  }
  function rollbackFiles(stage: string, plan: Install[]): void {
    const installedPaths: string[] = [];
    validatePlan(plan);
    for (const item of plan) {
      const path = target(item);
      if (!existsSync(path)) continue;
      const original = lstatSync(join(stage, item.originalPath));
      const installed = lstatSync(path);
      if (!original.isFile()) throw new DocumentError(500, 'The recovery journal refers to a staged file that is not an ordinary file.');
      if (original.dev === installed.dev && original.ino === installed.ino) installedPaths.push(path);
    }
    for (const path of installedPaths) unlinkSync(path);
    syncDirectory(options.directory);
    if (existsSync(sourceDirectory)) syncDirectory(sourceDirectory);
  }
  for (const token of readdirSync(stages)) {
    if (!tokenPattern.test(token)) continue;
    const stage = join(stages, token);
    try {
      if (!lstatSync(stage).isDirectory()) throw new DocumentError(500, 'The recovery stage is not an ordinary directory.');
      const ownerPath = join(stage, 'owner.json');
      if (existsSync(ownerPath)) {
        const owner = readJournal(ownerPath, 1024) as { pid?: unknown } | null;
        if (!owner || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) throw new DocumentError(500, 'The recovery journal has an invalid owner.');
        try { process.kill(Number(owner.pid), 0); continue; }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) continue; }
      }
      const journal = join(stage, 'pending.json');
      if (existsSync(journal) && !documents.recoveryReceipt(token)) rollbackFiles(stage, validatePlan(readJournal(journal, 16 * 1024 * 1024)));
      rmSync(stage, { recursive: true, force: true });
    } catch {
      incompleteStages.add(token);
    }
  }

  function health(state: AppState): DocumentRecoveryHealth {
    const saved = documents.list().documents;
    const accounts = new Set(state.accounts.map(account => account.id));
    const payroll = payrollSources(state);
    const payrollHashes = new Set(payroll.map(source => source.sha256));
    const generalSources = new Set((state.sourceFacts ?? []).map(source => source.sourceFile.normalize('NFC').toLowerCase()));
    const nameCounts = new Map<string, number>();
    for (const document of saved) { const name = document.originalName.normalize('NFC').toLowerCase(); nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1); }
    const result: DocumentRecoveryHealth = { revision: state.revision, documents: saved.length, missingOriginals: 0, damagedOriginals: 0, unlinkedDocuments: 0, missingAccountLinks: 0, statementSources: 0, missingStatementSources: 0, issues: [] };
    const incomplete = [...incompleteStages].filter(token => existsSync(join(stages, token)));
    result.incompleteRecoveries = incomplete.length;
    for (const token of incomplete) result.issues.push({ kind: 'incomplete_recovery', message: `Recovery ${token} has an unreadable or incomplete staging journal. Its staged files and destination files have been preserved for inspection.` });
    const valid = new Set<string>();
    for (const document of saved) {
      const status = fileState(join(options.directory, `${document.id}.original`), document.sha256, document.bytes);
      if (status === 'matching') valid.add(document.sha256);
      else {
        const missing = status === 'missing';
        if (missing) result.missingOriginals++; else result.damagedOriginals++;
        result.issues.push({ kind: missing ? 'missing_original' : 'damaged_original', documentId: document.id, sourceFile: document.originalName, message: `${document.originalName}: ${missing ? 'original file is missing' : 'saved original does not match its SHA-256'}.` });
      }
      if (document.accountId === null) {
        const name = document.originalName.normalize('NFC').toLowerCase();
        const reviewedGeneralSource = document.reviewStatus === 'reviewed' && generalSources.has(name) && nameCounts.get(name) === 1;
        if (document.kind !== 'other' || !payrollHashes.has(document.sha256) && !reviewedGeneralSource) { result.unlinkedDocuments++; result.issues.push({ kind: 'unlinked_document', documentId: document.id, sourceFile: document.originalName, message: `${document.originalName} is not linked to an account.` }); }
      } else if (!accounts.has(document.accountId)) { result.missingAccountLinks++; result.issues.push({ kind: 'missing_account', documentId: document.id, sourceFile: document.originalName, message: `${document.originalName} refers to an account absent from the current financial records.` }); }
    }
    const sources = statementReviewSources(state, financePath);
    result.statementSources = sources.length;
    for (const source of sources) {
      const safe = source.sourceFile === basename(source.sourceFile) && !/[\\\u0000-\u001f]/.test(source.sourceFile);
      const present = valid.has(source.sha256) || safe && fileState(join(sourceDirectory, source.sourceFile), source.sha256) === 'matching';
      if (!present) { result.missingStatementSources++; result.issues.push({ kind: 'missing_statement_source', sourceFile: source.sourceFile, message: `${source.sourceFile}: statement original is missing or does not match its SHA-256.` }); }
    }
    const sourceNames = new Set(sources.map(source => source.sourceFile.normalize('NFC').toLowerCase()));
    const references = [...new Set([...state.accounts.flatMap(account => account.evidence ? [account.evidence.sourceFile] : []), ...(state.sourceFacts ?? []).map(fact => fact.sourceFile)])].filter(name => /\.(pdf|png|jpe?g|heic)$/i.test(name) && !sourceNames.has(name.normalize('NFC').toLowerCase()));
    result.sourceReferences = references.length + payroll.length;
    result.missingSourceReferences = 0;
    for (const name of references) {
      const matches = saved.filter(document => document.originalName.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase());
      let present = matches.length === 1 && valid.has(matches[0].sha256);
      if (!present && name === basename(name) && !/[\\\u0000-\u001f]/.test(name)) {
        const candidates = [name.replace(/\.heic$/i, '.png'), name];
        present = candidates.some(candidate => { const legacy = join(sourceDirectory, candidate); return existsSync(legacy) && lstatSync(legacy).isFile() && lstatSync(legacy).size <= MAX_DOCUMENT_BYTES; });
      }
      if (!present) { result.missingSourceReferences++; result.issues.push({ kind: 'missing_source_reference', sourceFile: name, message: `${name}: linked source original is missing or ambiguous.` }); }
    }
    for (const source of payroll) {
      if (!valid.has(source.sha256)) { result.missingSourceReferences++; result.issues.push({ kind: 'missing_source_reference', documentId: source.sha256, sourceFile: source.filename, message: `${source.filename}: payroll original is missing or does not match its SHA-256.` }); }
    }
    return result;
  }

  function describe(archive: StagedArchive, state: AppState, token: string): DocumentRestorePreview {
    const saved = new Map(documents.list().documents.map(document => [document.id, document]));
    const accounts = new Set(state.accounts.map(account => account.id));
    const sources = statementReviewSources(state, financePath);
    const payrollHashes = new Set(payrollSources(state).map(source => source.sha256));
    const conflicts: string[] = [];
    const previews: DocumentRestorePreview['documents'] = archive.documents.map(document => {
      const existing = saved.get(document.id);
      const file = fileState(join(options.directory, `${document.id}.original`), document.sha256, document.bytes);
      const identityConflict = existing && (existing.sha256 !== document.sha256 || existing.bytes !== document.bytes || existing.mimeType !== document.mimeType);
      const status = identityConflict || file === 'conflict' ? 'conflict' : existing ? file === 'missing' ? 'repair' : 'existing' : 'new';
      const conflict = status === 'conflict' ? `${document.originalName}: an existing original or document identity differs. Nothing will overwrite it.` : undefined;
      if (conflict) conflicts.push(conflict);
      const registered = sources.filter(source => source.sha256 === document.sha256 && source.accountId !== undefined && accounts.has(source.accountId));
      const matchingNames = registered.filter(source => source.sourceFile === document.originalName);
      const linked = new Set((matchingNames.length ? matchingNames : registered).map(source => source.accountId!));
      let suggestedAccountId: string | null = null;
      let linkReason: DocumentRestorePreview['documents'][number]['linkReason'] = 'unresolved';
      if (existing) {
        suggestedAccountId = existing.accountId;
        linkReason = existing.accountId === null ? 'unlinked' : accounts.has(existing.accountId) ? 'account_id' : 'unresolved';
      } else if (document.accountId === null && document.kind === 'other' && payrollHashes.has(document.sha256)) linkReason = 'unlinked';
      else if (document.accountId !== null && accounts.has(document.accountId) && (!linked.size || linked.has(document.accountId))) { suggestedAccountId = document.accountId; linkReason = 'account_id'; }
      else if (linked.size === 1) { suggestedAccountId = [...linked][0]; linkReason = 'statement_source'; }
      else if (document.accountId === null && linked.size === 0) linkReason = 'unlinked';
      return { id: document.id, originalName: document.originalName, bytes: document.bytes, status, originalAccountId: document.accountId, suggestedAccountId, linkReason, ...(conflict ? { conflict } : {}) };
    });
    const reviewSources: DocumentRestorePreview['reviewSources'] = archive.reviewSources.map(source => {
      const states = source.sourceFiles.map(name => fileState(join(sourceDirectory, name), source.sha256, source.bytes));
      const registeredConflict = source.sourceFiles.some(name => sources.some(saved => saved.sourceFile === name && saved.sha256 !== source.sha256));
      const status = registeredConflict || states.includes('conflict') ? 'conflict' : states.includes('missing') ? 'new' : 'existing';
      const conflict = status === 'conflict' ? `${source.sourceFiles.join(', ')}: a source filename already contains different data. Nothing will overwrite it.` : undefined;
      if (conflict) conflicts.push(conflict);
      return { sha256: source.sha256, sourceFiles: source.sourceFiles, bytes: source.bytes, status, ...(conflict ? { conflict } : {}) };
    });
    return { token, expectedRevision: state.revision, archiveSha256: archive.archiveSha256, counts: { documents: previews.length, reviewSources: reviewSources.length, newDocuments: previews.filter(document => document.status === 'new').length, existingDocuments: previews.filter(document => ['existing', 'repair'].includes(document.status)).length, missingOriginals: previews.filter(document => document.status === 'repair').length, unresolvedLinks: previews.filter(document => document.status === 'new' && document.linkReason === 'unresolved').length, conflicts: conflicts.length }, documents: previews, reviewSources, conflicts };
  }

  async function preview(bytes: Uint8Array, readState: () => Promise<AppState>): Promise<DocumentRestorePreview> {
    if (decoding) throw new DocumentError(409, 'Another archive is being checked. Wait for its preview.');
    decoding = true;
    const token = randomUUID();
    const stage = join(stages, token);
    try {
      directory(stage);
      writeFileSync(join(stage, 'owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600, flush: true });
      syncDirectory(stage); syncDirectory(stages);
      const owned = Uint8Array.from(bytes);
      const archive = await new Promise<StagedArchive>((resolve, reject) => {
        const worker = new Worker(new URL('./document-recovery-worker.ts', import.meta.url), { workerData: { directory: stage, bytes: owned }, transferList: [owned.buffer] });
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; void worker.terminate().then(() => reject(new DocumentError(408, 'The archive took too long to inspect. Try a smaller archive.'))); } }, 60000);
        worker.once('message', (result: StagedArchive | { error: { status: number; message: string } }) => { settled = true; clearTimeout(timer); if ('error' in result) reject(new DocumentError(result.error.status, result.error.message)); else resolve(result); });
        worker.once('error', error => { settled = true; clearTimeout(timer); reject(error); });
        worker.once('exit', code => { clearTimeout(timer); if (!settled) reject(new DocumentError(500, `Archive inspection stopped before completion (${code}).`)); });
      });
      const state = await readState();
      const result = describe(archive, state, token);
      const fingerprint = documents.fingerprint();
      const files = hash(JSON.stringify(result.documents.map(document => [document.id, document.status]).concat(result.reviewSources.map(source => [source.sha256, source.status]))));
      writeFileSync(join(stage, 'preview.json'), JSON.stringify({ version: 1, token }), { flag: 'wx', mode: 0o600, flush: true });
      syncDirectory(stage);
      pending.set(token, { archive, preview: result, fingerprint, files });
      const previews = [...pending.keys()].filter(key => !lstatSync(join(stages, key, 'pending.json'), { throwIfNoEntry: false }));
      while (previews.length > 3) discard(previews.shift()!);
      return structuredClone(result);
    } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
    finally { decoding = false; }
  }

  function discard(token: unknown): { status: 'discarded' } {
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw new DocumentError(400, 'Choose a valid archive preview to clear.');
    if (!pending.has(token)) return { status: 'discarded' };
    const stage = join(stages, token);
    if (lstatSync(join(stage, 'pending.json'), { throwIfNoEntry: false })) throw new DocumentError(409, 'This recovery started installing files. Check recovery status before clearing its preview. Its files and journal have been kept.');
    rmSync(stage, { recursive: true, force: true });
    pending.delete(token);
    return { status: 'discarded' };
  }

  function commit(input: DocumentRestoreCommit, state: AppState): DocumentRestoreResult {
    if (!input || typeof input !== 'object' || !tokenPattern.test(input.token) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new DocumentError(400, 'Choose a valid archive preview and current financial revision.');
    const mappings = input.accountMappings ?? {};
    if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings) || Object.values(mappings).some(value => value !== null && (typeof value !== 'string' || !value || value.length > 200))) throw new DocumentError(400, 'Choose an account or leave the document unlinked.');
    const requestHash = hash(JSON.stringify({ expectedRevision: input.expectedRevision, accountMappings: Object.fromEntries(Object.entries(mappings).sort(([a], [b]) => a.localeCompare(b))) }));
    const previous = documents.recoveryReceipt(input.token) as Receipt | null;
    if (previous) {
      if (previous.requestHash !== requestHash) throw new DocumentError(409, 'This recovery token was already used with different choices.');
      return previous.result;
    }
    const record = pending.get(input.token);
    if (!record) throw new DocumentError(404, 'This archive preview expired. Upload the archive again.');
    if (state.revision !== input.expectedRevision || record.preview.expectedRevision !== input.expectedRevision) throw new DocumentError(409, 'Financial records changed after preview. Preview the archive again.');
    const finance = new DatabaseSync(financePath);
    const stage = join(stages, input.token);
    const plan: Install[] = [];
    let locked = false;
    try {
      finance.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); locked = true;
      const current = finance.prepare('SELECT revision FROM workspace_meta WHERE id = 1').get() as { revision: number };
      if (current.revision !== input.expectedRevision) throw new DocumentError(409, 'Financial records changed after preview. Preview the archive again.');
      directory(options.directory); directory(sourceDirectory);
      const latest = describe(record.archive, state, input.token);
      const files = hash(JSON.stringify(latest.documents.map(document => [document.id, document.status]).concat(latest.reviewSources.map(source => [source.sha256, source.status]))));
      if (documents.fingerprint() !== record.fingerprint || files !== record.files) throw new DocumentError(409, 'Original files or document details changed after preview. Preview the archive again.');
      if (latest.conflicts.length) throw new DocumentError(409, 'Resolve the existing-file conflicts before restoring this archive.');
      const accounts = new Set(state.accounts.map(account => account.id));
      const newIds = new Set(latest.documents.filter(document => document.status === 'new').map(document => document.id));
      if (Object.keys(mappings).some(id => !newIds.has(id))) throw new DocumentError(400, 'Account choices may only refer to new documents in this archive.');
      const additions: DocumentMetadata[] = [];
      for (const document of record.archive.documents) {
        const row = latest.documents.find(item => item.id === document.id)!;
        if (row.status === 'new') {
          if (row.linkReason === 'unresolved' && !Object.hasOwn(mappings, document.id)) throw new DocumentError(400, `Choose an account for ${document.originalName}, or explicitly leave it unlinked.`);
          const accountId = Object.hasOwn(mappings, document.id) ? mappings[document.id] : row.suggestedAccountId;
          if (accountId !== null && !accounts.has(accountId)) throw new DocumentError(400, 'A selected account does not exist in the restored financial records.');
          const { originalPath: _path, ...metadata } = document;
          additions.push({ ...metadata, accountId });
        }
        if (fileState(join(options.directory, `${document.id}.original`), document.sha256, document.bytes) === 'missing') plan.push({ kind: 'document', name: `${document.id}.original`, originalPath: document.originalPath, sha256: document.sha256, bytes: document.bytes });
      }
      for (const source of record.archive.reviewSources) for (const name of source.sourceFiles) if (fileState(join(sourceDirectory, name), source.sha256, source.bytes) === 'missing') plan.push({ kind: 'source', name, originalPath: source.originalPath, sha256: source.sha256, bytes: source.bytes });
      for (const item of plan) if (fileState(join(stage, item.originalPath), item.sha256, item.bytes) !== 'matching') throw new DocumentError(409, 'The staged archive changed. Upload it again.');
      const receipt = documents.commitRecovery(input.token, record.fingerprint, additions, () => {
        writeFileSync(join(stage, 'pending.json'), JSON.stringify(plan), { flag: 'wx', mode: 0o600, flush: true });
        syncDirectory(stage);
        for (const item of plan) linkSync(join(stage, item.originalPath), target(item));
        syncDirectory(options.directory); syncDirectory(sourceDirectory);
      }, () => {
        const recovery = health(state);
        const addedIds = new Set(additions.map(document => document.id));
        const result: DocumentRestoreResult = { status: 'restored', documentsAdded: additions.length, originalsRepaired: latest.counts.missingOriginals, documentsPreserved: latest.counts.existingDocuments, reviewSourcesRestored: plan.filter(item => item.kind === 'source').length, unlinkedDocuments: recovery.issues.filter(issue => issue.kind === 'unlinked_document' && issue.documentId !== undefined && addedIds.has(issue.documentId)).length, archiveSha256: record.archive.archiveSha256, recovery };
        return { requestHash, manifest: record.archive.manifest, accountMappings: Object.fromEntries(additions.map(document => [document.id, document.accountId])), result } satisfies Receipt;
      }) as Receipt;
      pending.delete(input.token);
      rmSync(stage, { recursive: true, force: true });
      return receipt.result;
    } catch (error) {
      if (!documents.recoveryReceipt(input.token) && existsSync(join(stage, 'pending.json'))) {
        rollbackFiles(stage, plan);
        rmSync(join(stage, 'pending.json'), { force: true });
      }
      if (error instanceof Error && 'code' in error && ['ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'EEXIST'].includes(String(error.code))) throw new DocumentError(409, 'Records or destination files changed during recovery. Preview the archive again.');
      throw error;
    } finally { if (locked) finance.exec('ROLLBACK'); finance.close(); }
  }
  return { preview, discard, commit, health };
}
