import { createServer } from 'node:http';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { RevisionConflictError } from './store.ts';
import { createStoreService } from './store-service.ts';
import { BackupError } from './backup.ts';
import { createDocumentStore, DocumentError, MAX_DOCUMENT_BYTES } from './documents.ts';
import { createDocumentRecovery } from './document-recovery.ts';
import { createWorkbookService, WorkbookError } from './workbook.ts';
import { masterWorkbookPath as resolveMasterWorkbookPath } from './workbook-path.ts';
import { readReviewSource, reviewSourcesForArchive, statementReviewSources } from './review-sources.ts';
import { staticFile } from './static.ts';
import { createEngineService, EngineError } from './engine.ts';
import { engineRoute, sendEngineResponse } from './routes/engine.ts';
import type { Workspace } from '../shared/types.ts';
import { MAX_DOCUMENT_ARCHIVE_BYTES, type DocumentRestoreCommit } from '../shared/recovery.ts';
import { createDesktopAuth } from './desktop-auth.ts';
import { createCompleteBackupService, recoverCompleteRestore, MAX_COMPLETE_BACKUP_BYTES } from './complete-backup.ts';
import { createDocumentExtractor, MAX_EXTRACTION_BYTES } from './document-extract.ts';
import { acquireDataLease } from './data-lease.ts';
import { createAutomaticBackupService } from './automatic-backup.ts';
import { captureBuildStatus } from './build-status.ts';
import { readBody } from './request-body.ts';
import { recordRoute } from './routes/records.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildStatus = captureBuildStatus(root);
const documentExtractor = createDocumentExtractor(root);
const port = Number(process.env.PORT ?? '5191');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
const dataLease = acquireDataLease(process.env.MAZAL_DATA_DIR ? resolve(process.env.MAZAL_DATA_DIR) : join(root, 'data'));
const dataDirectory = dataLease.directory;
const samplePreview = process.env.MAZAL_SAMPLE_PREVIEW === '1';
const recordsPreview = process.env.MAZAL_RECORDS_PREVIEW === '1';
recoverCompleteRestore(dataDirectory, Boolean(process.env.MAZAL_DESKTOP_TOKEN));
const desktopAuth = createDesktopAuth(dataDirectory);
delete process.env.MAZAL_DESKTOP_TOKEN;
let engine = createEngineService(root, dataDirectory);
const masterWorkbookPath = resolveMasterWorkbookPath();
const masterWorkbookName = 'Mazal master.xlsx';
const workbookService = createWorkbookService(masterWorkbookPath);
type Stores = Record<Workspace, Awaited<ReturnType<typeof createStoreService>>>;
type DocumentStores = Record<Workspace, ReturnType<typeof createDocumentStore>>;
type Recoveries = Record<Workspace, ReturnType<typeof createDocumentRecovery>>;
let stores: Stores;
let documentStores: DocumentStores;
let documentRecovery: Recoveries;
let runtimeOpen = false;
async function openRuntime(): Promise<void> {
  const opened: Partial<Stores> = {};
  const documents: Partial<DocumentStores> = {};
  try {
    for (const workspace of ['live', 'demo'] as const) opened[workspace] = await createStoreService(join(dataDirectory, `${workspace}.sqlite`), workspace);
    for (const workspace of ['live', 'demo'] as const) documents[workspace] = createDocumentStore(join(dataDirectory, 'documents', workspace), id => opened[workspace]!.hasAccount(id));
    stores = opened as Stores; documentStores = documents as DocumentStores;
    documentRecovery = Object.fromEntries((['demo', 'live'] as const).map(workspace => [workspace, createDocumentRecovery({ directory: join(dataDirectory, 'documents', workspace), sourceDirectory: join(dataDirectory, 'source-documents'), financePath: join(dataDirectory, `${workspace}.sqlite`), documents: documentStores[workspace] })])) as Recoveries;
    engine = createEngineService(root, dataDirectory);
    runtimeOpen = true;
  } catch (error) {
    for (const document of Object.values(documents)) document.close();
    await Promise.all(Object.values(opened).map(store => store.close()));
    throw error;
  }
}
async function closeRuntime(): Promise<void> {
  await engine.close();
  if (!runtimeOpen) return;
  runtimeOpen = false;
  documentStores.live.close(); documentStores.demo.close();
  await Promise.all([stores.live.close(), stores.demo.close()]);
}
await openRuntime();
const completeBackup = createCompleteBackupService(dataDirectory, { open: openRuntime, close: closeRuntime });
let activeApiRequests = 0;
let completeBackupBusy = false;
const drained = new Set<() => void>();
async function drainApiRequests(): Promise<void> {
  if (!activeApiRequests) return;
  await new Promise<void>((resolveDrain, reject) => {
    const finish = () => { clearTimeout(timer); drained.delete(finish); resolveDrain(); };
    const timer = setTimeout(() => { drained.delete(finish); reject(new BackupError(409, 'Another operation is still running. Finish it before backing up or restoring.')); }, 10000);
    drained.add(finish);
  });
}
const automaticBackup = createAutomaticBackupService({
  dataDirectory,
  exportArchive: passphrase => completeBackup.exportArchive(passphrase),
  exclusive: async operation => {
    if (completeBackupBusy) throw new BackupError(409, 'Another complete backup or restore is in progress. Automatic backups will retry.');
    completeBackupBusy = true;
    try { await drainApiRequests(); return await operation(); }
    finally { completeBackupBusy = false; }
  },
});
function statementOriginal(source: { sourceFile: string; sha256: string }, documents: ReturnType<typeof createDocumentStore>) {
  const download = ['.csv', '.json', '.heic'].includes(extname(source?.sourceFile ?? '').toLowerCase());
  try { return { ...documents.content(source.sha256), download }; }
  catch (error) { if (!(error instanceof DocumentError) || error.status !== 404) throw error; }
  const original = readReviewSource(join(dataDirectory, 'source-documents'), source);
  return { bytes: original.bytes, document: { originalName: original.originalName, mimeType: original.mimeType }, download };
}
const developmentPorts = process.env.NODE_ENV === 'production' ? [] : [5190, 5173];
const allowedOrigins = new Set([port, ...developmentPorts].flatMap(localPort => [`http://localhost:${localPort}`, `http://127.0.0.1:${localPort}`]));
const allowedHosts = new Set([port, ...developmentPorts].flatMap(localPort => [`localhost:${localPort}`, `127.0.0.1:${localPort}`]));
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = createServer(async (request, response) => {
  const sendJson = (status: number, json: string) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(json); };
  const send = (status: number, body: unknown) => sendJson(status, JSON.stringify(body));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:5190 ws://127.0.0.1:5190; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (!allowedHosts.has(request.headers.host ?? '')) return send(403, { error: 'Mazal accepts local Host headers only.' });
  if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) return send(403, { error: 'This origin cannot access Mazal.' });
  if (request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site access is not allowed.' });
  let counted = false;
  let exclusive = false;
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) response.setHeader('X-Mazal-Data-Source', samplePreview || url.searchParams.get('workspace') === 'demo' ? 'sample' : recordsPreview ? 'snapshot' : 'personal');
    if (await desktopAuth.handle(request, response, url.pathname)) return;
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/build-status') {
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); return send(405, { error: 'Use GET to read the running build identity.' }); }
        return send(200, buildStatus);
      }
      if (url.pathname.startsWith('/api/automatic-backup')) {
        if (recordsPreview || samplePreview || (url.searchParams.get('workspace') ?? 'live') !== 'live') return send(403, { error: 'Open your personal records in Mazal to manage automatic backups.' });
        if (url.pathname === '/api/automatic-backup' && request.method === 'GET') return send(200, automaticBackup.status());
        if (request.method !== 'POST') { response.setHeader('Allow', url.pathname === '/api/automatic-backup' ? 'GET' : 'POST'); return send(405, { error: 'Use POST to change automatic backups.' }); }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { error: 'Automatic backup requests must use application/json.' });
        const body = JSON.parse((await readBody(request, 8192)).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'Provide automatic backup options as a JSON object.' });
        if (url.pathname === '/api/automatic-backup/configure') return send(200, await automaticBackup.configure(body));
        if (url.pathname === '/api/automatic-backup/run') return send(200, await automaticBackup.run());
        if (url.pathname === '/api/automatic-backup/disable') return send(200, await automaticBackup.disable());
        if (url.pathname === '/api/automatic-backup/recovery-key') return send(200, await automaticBackup.recoveryKey());
        return send(404, { error: 'Choose automatic backup setup, run, pause, or recovery key.' });
      }
      if (completeBackupBusy) { response.setHeader('Retry-After', '1'); return send(503, { error: 'A complete backup or restore is in progress. Try again when it finishes.' }); }
      if (url.pathname.startsWith('/api/complete-backup')) {
        if (recordsPreview || samplePreview || (url.searchParams.get('workspace') ?? 'live') !== 'live') return send(403, { error: 'Open your personal records in Mazal to create or restore a complete backup.' });
        completeBackupBusy = true; exclusive = true;
        await drainApiRequests();
        if (url.pathname === '/api/complete-backup' && request.method === 'GET' || url.pathname === '/api/complete-backup/export' && request.method === 'POST') {
          let passphrase = '';
          if (request.method === 'POST') {
            if (request.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { error: 'Backup export options must use application/json.' });
            const body = JSON.parse((await readBody(request, 8192)).toString('utf8'));
            if (typeof body.passphrase !== 'string') return send(400, { error: 'Choose a backup passphrase or leave it blank.' });
            passphrase = body.passphrase;
          }
          const archive = await completeBackup.exportArchive(passphrase);
          response.setHeader('Content-Type', 'application/octet-stream');
          response.setHeader('Content-Disposition', `attachment; filename="mazal-complete-${new Date().toISOString().slice(0, 10)}${passphrase ? '.encrypted' : ''}.mazal"`);
          response.setHeader('Content-Length', archive.length); response.end(archive); return;
        }
        if (url.pathname === '/api/complete-backup/preview' && request.method === 'POST') {
          if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') return send(415, { error: 'Upload the complete backup as application/octet-stream.' });
          const header = request.headers['x-mazal-backup-passphrase'];
          if (header !== undefined && typeof header !== 'string') return send(400, { error: 'Provide one backup passphrase.' });
          const passphrase = header ? decodeURIComponent(header) : '';
          return send(200, await completeBackup.preview(await readBody(request, MAX_COMPLETE_BACKUP_BYTES), passphrase));
        }
        if (url.pathname === '/api/complete-backup/restore' && request.method === 'POST') {
          if (request.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { error: 'Restore confirmation must use application/json.' });
          return send(200, await completeBackup.restore(JSON.parse((await readBody(request, 4096)).toString('utf8'))));
        }
        return send(405, { error: 'Choose complete-backup export, verification, or restore.' });
      }
      activeApiRequests++; counted = true;
      const calculation = request.method === 'POST' && ['/api/engine/project', '/api/engine/runs'].includes(url.pathname);
      const cancelCalculation = request.method === 'DELETE' && /^\/api\/engine\/runs\/[^/]+$/.test(url.pathname);
      if (recordsPreview && (url.pathname === '/api/backup' || !['GET', 'HEAD'].includes(request.method ?? '') && !calculation && !cancelCalculation)) return send(403, { error: 'This preview is read-only. Open Mazal.app to change your records.' });
      const workspace = url.searchParams.get('workspace') ?? 'live';
      if (!['demo', 'live'].includes(workspace)) return send(400, { error: 'Choose the demo or live workspace.' });
      const store = stores[workspace as Workspace];
      const documents = documentStores[workspace as Workspace];
      const recovery = documentRecovery[workspace as Workspace];
      if (url.pathname === '/api/document-extract') {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return send(405, { error: 'Use POST to extract document text.' }); }
        const mimeType = request.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? '';
        return send(200, await documentExtractor.extract(await readBody(request, MAX_EXTRACTION_BYTES), mimeType));
      }
      if (url.pathname === '/api/engine' || url.pathname.startsWith('/api/engine/')) {
        const result = await engineRoute(request, url, workspace as Workspace, store.state, engine);
        await sendEngineResponse(response, result);
        return;
      }
      if (await recordRoute({ request, response, url, workspace: workspace as Workspace, send, sendJson }, { store, documents, statementOriginal: source => statementOriginal(source, documents) })) return;
      if (url.pathname === '/api/workbook-data') {
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); return send(405, { error: 'Use GET to read the Excel snapshot.' }); }
        return send(200, { state: await store.state(), documents: documents.list().documents, generatedAt: new Date().toISOString() });
      }
      if (url.pathname === '/api/master-workbook/refresh') {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return send(405, { error: 'Use POST to generate Excel.' }); }
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return send(415, { error: 'Excel requests must use application/json.' });
        let body: unknown;
        try { body = JSON.parse((await readBody(request, 1024)).toString('utf8')); }
        catch (error) { if (error instanceof DocumentError) throw error; return send(400, { error: 'The request is not valid JSON.' }); }
        const state = await store.state();
        if (!body || typeof body !== 'object' || !('expectedRevision' in body) || !Number.isSafeInteger(body.expectedRevision)) return send(400, { error: 'Refresh your records before exporting Excel.' });
        if (body.expectedRevision !== state.revision) return send(409, { error: 'Your records changed. Refresh Mazal before exporting Excel.' });
        await workbookService.refresh({ state, documents: documents.list().documents, generatedAt: new Date().toISOString() });
        return send(200, await workbookService.status({ state: await store.state(), documents: documents.list().documents }));
      }
      if (url.pathname === '/api/master-workbook' || url.pathname === '/api/master-workbook/status') {
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          return send(405, { error: 'Use GET to read the master workbook.' });
        }
        let workbook: FileHandle | undefined;
        try {
          if (workspace === 'live') {
            try { workbook = await open(masterWorkbookPath, 'r'); }
            catch (error) {
              if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code)))) throw new DocumentError(500, 'Mazal could not read the master workbook.');
            }
          }
          const details = await workbook?.stat();
          const fileDetails = details?.isFile() ? details : null;
          if (url.pathname.endsWith('/status')) return send(200, workspace === 'live' ? await workbookService.status({ state: await store.state(), documents: documents.list().documents }) : { available: false, lastUpdatedAt: null, fileName: masterWorkbookName });
          if (!fileDetails || !workbook) return send(404, { error: 'The master workbook is not available in this workspace.' });
          response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          response.setHeader('Content-Disposition', `attachment; filename="${masterWorkbookName}"`);
          response.setHeader('Content-Length', fileDetails.size);
          await pipeline(workbook.createReadStream({ autoClose: false }), response);
          return;
        } finally { await workbook?.close(); }
      }
      if (url.pathname === '/api/documents/recovery') {
        if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); return send(405, { error: 'Use GET to check original-file recovery.' }); }
        return send(200, recovery.health(await store.state()));
      }
      if (url.pathname === '/api/documents/restore/preview') {
        if (request.method === 'DELETE') return send(200, recovery.discard(url.searchParams.get('token')));
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST, DELETE'); return send(405, { error: 'Use POST to preview an original-file archive or DELETE to clear its preview.' }); }
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return send(415, { error: 'Upload the .tar.gz archive as application/octet-stream.' });
        return send(200, await recovery.preview(await readBody(request, MAX_DOCUMENT_ARCHIVE_BYTES), store.state));
      }
      if (url.pathname === '/api/documents/restore/commit') {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return send(405, { error: 'Use POST to restore a previewed original-file archive.' }); }
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return send(415, { error: 'Recovery choices must use application/json.' });
        let input: DocumentRestoreCommit;
        try { input = JSON.parse((await readBody(request, 4 * 1024 * 1024)).toString('utf8')) as DocumentRestoreCommit; }
        catch (error) { if (error instanceof DocumentError) throw error; return send(400, { error: 'The recovery choices are not valid JSON.' }); }
        return send(200, recovery.commit(input, await store.state()));
      }
      if (url.pathname === '/api/documents') {
        if (request.method === 'GET') return send(200, documents.list());
        if (request.method !== 'POST') return send(405, { error: 'Use GET to list documents or POST to upload one.' });
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return send(415, { error: 'Upload the original file as application/octet-stream.' });
        const header = request.headers['x-mazal-document'];
        let metadata: unknown;
        try { if (typeof header !== 'string' || header.length > 12000) throw new Error(); metadata = JSON.parse(decodeURIComponent(header)); }
        catch { return send(400, { error: 'Document metadata must be encoded JSON in X-Mazal-Document, up to 12 KB.' }); }
        const result = documents.upload(await readBody(request, MAX_DOCUMENT_BYTES), metadata);
        return send(result.duplicate ? 200 : 201, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/documents/export') {
        const state = await store.state();
        const library = documents.list().documents;
        const archived = new Set(library.map(document => document.sha256));
        const registered = statementReviewSources(state, join(dataDirectory, `${workspace}.sqlite`)).filter(source => !archived.has(source.sha256));
        const references = [...new Set([...state.accounts.flatMap(account => account.evidence ? [account.evidence.sourceFile] : []), ...(state.sourceFacts ?? []).map(fact => fact.sourceFile)])].filter(name => /\.(pdf|png|jpe?g|heic)$/i.test(name) && !library.some(document => document.originalName.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase()) && !registered.some(source => source.sourceFile === name));
        const reviewSources = reviewSourcesForArchive(join(dataDirectory, 'source-documents'), [...registered, ...references.map(sourceFile => ({ sourceFile }))]);
        const archive = documents.export(reviewSources);
        response.setHeader('Content-Type', 'application/gzip');
        response.setHeader('Content-Disposition', `attachment; filename="mazal-documents-${workspace}-${new Date().toISOString().slice(0, 10)}.tar.gz"`);
        await pipeline(Readable.from(archive), createGzip(), response);
        return;
      }
      const documentRoute = /^\/api\/documents\/([^/]+)(\/content)?$/.exec(url.pathname);
      if (documentRoute) {
        const [, id, contentRoute] = documentRoute;
        if (contentRoute && (request.method === 'GET' || request.method === 'HEAD')) {
          const result = documents.content(id);
          response.setHeader('Content-Type', result.document.mimeType);
          response.setHeader('Content-Length', result.document.bytes);
          response.setHeader('Content-Disposition', `${url.searchParams.get('download') === '1' || ['image/heic', 'text/csv; charset=utf-8'].includes(result.document.mimeType) ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(result.document.originalName)}`);
          response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
          response.end(request.method === 'HEAD' ? undefined : result.bytes);
          return;
        }
        if (!contentRoute && request.method === 'PATCH') {
          if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return send(415, { error: 'Document changes must use application/json.' });
          let metadata: unknown;
          try { metadata = JSON.parse((await readBody(request, 32 * 1024)).toString('utf8')); }
          catch (error) { if (error instanceof DocumentError) throw error; return send(400, { error: 'The request is not valid JSON.' }); }
          return send(200, { document: documents.patch(id, metadata) });
        }
        return send(405, { error: contentRoute ? 'Use GET to open the original document.' : 'Use PATCH to update document details.' });
      }
      if (request.method === 'GET' && url.pathname === '/api/source') {
        const name = url.searchParams.get('file') ?? '';
        const state = await store.state();
        const sourceSha = url.searchParams.get('sha');
        const statementSources = statementReviewSources(state, join(dataDirectory, `${workspace}.sqlite`));
        const linkedStatement = statementSources.find(statement => statement.sourceFile === name && (sourceSha ? statement.sha256 === sourceSha : true));
        if (sourceSha && !linkedStatement) return send(404, { error: 'Statement source was not found.' });
        if (linkedStatement) {
          try {
            const original = statementOriginal(linkedStatement, documents);
            response.setHeader('Content-Type', original.document.mimeType);
            response.setHeader('Content-Disposition', `${original.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(original.document.originalName)}`);
            response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
            response.end(original.bytes);
            return;
          } catch (error) {
            if (!(error instanceof DocumentError) || error.status !== 404) throw error;
            if (['.csv', '.json'].includes(extname(linkedStatement.sourceFile).toLowerCase())) throw error;
            if (sourceSha) return send(404, { error: 'Upload this statement original in Documents to restore its source link.' });
          }
        }
        const registered = new Set([...state.accounts.flatMap(account => account.evidence ? [account.evidence.sourceFile] : []), ...statementSources.map(statement => statement.sourceFile), ...(state.sourceFacts ?? []).map(fact => fact.sourceFile)]);
        if (!name || name !== basename(name) || name.includes('\\') || !registered.has(name)) return send(404, { error: 'Source document was not found.' });
        const extension = extname(name).toLowerCase();
        if (!['.heic', '.pdf', '.png', '.jpg', '.jpeg'].includes(extension)) return send(404, { error: 'This record has no attached source document.' });
        const previewName = extension === '.heic' ? name.replace(/\.heic$/i, '.png') : name;
        const fileName = extension === '.heic' && !existsSync(join(dataDirectory, 'source-documents', previewName)) ? name : previewName;
        const sourcePath = join(dataDirectory, 'source-documents', fileName);
        const sourceDetails = existsSync(sourcePath) ? lstatSync(sourcePath) : null;
        if (!sourceDetails?.isFile()) {
          if (!linkedStatement) {
            const saved = documents.namedContent(name);
            if (saved) {
              response.setHeader('Content-Type', saved.document.mimeType);
              response.setHeader('Content-Disposition', `${['image/heic', 'text/csv; charset=utf-8'].includes(saved.document.mimeType) ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(saved.document.originalName)}`);
              response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
              response.end(saved.bytes);
              return;
            }
          }
          return send(404, { error: 'Source document is missing from this computer.' });
        }
        if (sourceDetails.size > MAX_DOCUMENT_BYTES) return send(413, { error: 'The source document exceeds 25 MB.' });
        const bytes = readFileSync(sourcePath);
        if (bytes.length > MAX_DOCUMENT_BYTES) return send(413, { error: 'The source document exceeds 25 MB.' });
        if (linkedStatement && createHash('sha256').update(bytes).digest('hex') !== linkedStatement.sha256) return send(409, { error: 'The original statement changed. Restore the file matching the saved statement SHA-256.' });
        const rawHeic = extname(fileName).toLowerCase() === '.heic';
        response.setHeader('Content-Type', rawHeic ? 'image/heic' : extension === '.pdf' ? 'application/pdf' : extension === '.heic' || extension === '.png' ? 'image/png' : 'image/jpeg');
        response.setHeader('Content-Disposition', `${rawHeic ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
        response.end(bytes);
        return;
      }
      return send(404, { error: 'API endpoint was not found.' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, { error: 'Method is not allowed.' });
    const asset = staticFile(join(root, 'dist'), url.pathname);
    if ('error' in asset) return send(asset.status, { error: asset.error });
    const file = asset.path;
    response.setHeader('Content-Type', contentTypes[extname(file)] ?? 'application/octet-stream');
    response.end(request.method === 'HEAD' ? undefined : readFileSync(file));
  } catch (error) {
    if (response.headersSent) { console.error(error); response.destroy(); return; }
    if (error instanceof DocumentError) return send(error.status, { error: error.message });
    if (error instanceof WorkbookError) return send(error.status, { error: error.message });
    if (error instanceof EngineError) return send(error.status, { error: error.message });
    if (error instanceof BackupError) return send(error.status, { error: error.message });
    if (error instanceof RevisionConflictError) return send(409, { error: error.message });
    if (error instanceof Error && 'code' in error && (/^(?:ERR_)?SQLITE/.test(String(error.code)) || ['EACCES', 'EIO', 'ENOSPC', 'EROFS', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE'].includes(String(error.code)))) { console.error(error); return send(500, { error: 'Mazal could not save this change. Your previous data is intact.' }); }
    return send(400, { error: error instanceof Error ? error.message : 'The request could not be completed.' });
  } finally {
    if (exclusive) completeBackupBusy = false;
    if (counted && --activeApiRequests === 0) for (const finish of drained) finish();
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Mazal is available at http://127.0.0.1:${port}. Data: ${dataDirectory}`);
  if (!samplePreview && !recordsPreview) automaticBackup.start();
});
if (process.env.MAZAL_ENGINE_AUTOSTART === '1') void engine.start().catch(error => console.error(error instanceof Error ? error.message : 'The financial engine could not start.'));
let shuttingDown = false;
const parentPid = Number(process.env.MAZAL_DESKTOP_PARENT_PID);
const parentWatch = desktopAuth.enabled && Number.isSafeInteger(parentPid) && parentPid > 1 ? setInterval(() => {
  try { process.kill(parentPid, 0); } catch { shutdown(); }
}, 1000) : undefined;
parentWatch?.unref();
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (parentWatch) clearInterval(parentWatch);
  const stoppingBackups = automaticBackup.close();
  const stoppingEngine = stoppingBackups.then(() => engine.close());
  server.close(async () => { await stoppingEngine; await closeRuntime(); completeBackup.close(); await documentExtractor.close(); dataLease.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
