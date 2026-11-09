import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Command, TransactionKind } from '../../shared/types.ts';
import { MAX_BACKUP_BYTES } from '../../shared/backup.ts';
import { parseStatementCSV } from '../../shared/statement-csv.ts';
import { mapStatementCSV } from '../../shared/statement-mapping.ts';
import type { BackupContentType } from '../backup.ts';
import type { createStoreService } from '../store-service.ts';
import type { createDocumentStore } from '../documents.ts';
import { validatePayrollImport } from '../payroll.ts';
import { readBody } from '../request-body.ts';
import type { RouteContext } from './context.ts';

interface RecordServices {
  store: Pick<Awaited<ReturnType<typeof createStoreService>>, 'transactions' | 'stateResponse' | 'state' | 'export' | 'restoreEncoded' | 'command'>;
  documents: Pick<ReturnType<typeof createDocumentStore>, 'content'>;
  statementOriginal(source: { sourceFile: string; sha256: string }): { bytes: Buffer; document: { id?: string; originalName: string; mimeType: string } };
}

type RecordHandler = (context: RouteContext, services: RecordServices) => Promise<void>;
const routes: Record<string, { method?: string; handle: RecordHandler }> = {
  '/api/transactions': { handle: readTransactions },
  '/api/state': { method: 'GET', handle: readState },
  '/api/backup': { method: 'GET', handle: downloadBackup },
  '/api/backup/restore': { handle: restoreBackup },
  '/api/command': { method: 'POST', handle: writeCommand },
};

export async function recordRoute(context: RouteContext, services: RecordServices): Promise<boolean> {
  const route = routes[context.url.pathname];
  if (!route || route.method && route.method !== context.request.method) return false;
  await route.handle(context, services);
  return true;
}

async function readTransactions({ request, response, url, send, sendJson }: RouteContext, { store }: RecordServices): Promise<void> {
  if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); return send(405, { error: 'Use GET to read transactions.' }); }
  const text = (key: string) => url.searchParams.get(key) ?? undefined;
  const number = (key: string) => url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined;
  return sendJson(200, await store.transactions({ accountId: text('accountId'), entityId: text('entityId'), kind: text('kind') as TransactionKind | undefined, category: text('category'), from: text('from'), to: text('to'), search: text('search'), limit: number('limit'), offset: number('offset') }));
}

async function readState({ request, response, sendJson }: RouteContext, { store }: RecordServices): Promise<void> {
  const result = await store.stateResponse(request.headers['if-none-match']);
  response.setHeader('ETag', result.etag);
  if (result.status === 304) { response.statusCode = 304; response.end(); return; }
  return sendJson(200, result.json);
}

async function downloadBackup({ response, url, workspace }: RouteContext, { store }: RecordServices): Promise<void> {
  const json = await store.export();
  const compressed = url.searchParams.get('format') === 'gzip';
  response.setHeader('Content-Disposition', `attachment; filename="mazal-${workspace}-${new Date().toISOString().slice(0, 10)}.json${compressed ? '.gz' : ''}"`);
  response.setHeader('Content-Type', compressed ? 'application/gzip' : 'application/json; charset=utf-8');
  if (compressed) await pipeline(Readable.from([json]), createGzip(), response);
  else response.end(json);
  return;
}

async function restoreBackup({ request, response, send, sendJson }: RouteContext, { store }: RecordServices): Promise<void> {
  if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return send(405, { error: 'Use POST to restore a backup.' }); }
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (!['application/json', 'application/gzip'].includes(contentType ?? '')) return send(415, { error: 'Upload a JSON or gzip backup.' });
  const revision = request.headers['x-mazal-revision'];
  if (typeof revision !== 'string' || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) return send(400, { error: 'Refresh your records before restoring a backup.' });
  const bytes = await readBody(request, MAX_BACKUP_BYTES);
  return sendJson(200, await store.restoreEncoded(bytes, contentType as BackupContentType, Number(revision)));
}

async function writeCommand({ request, send, sendJson }: RouteContext, { store, documents, statementOriginal }: RecordServices): Promise<void> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return send(415, { error: 'Commands must use application/json.' });
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) { length += chunk.length; if (length > 25 * 1024 * 1024) { send(413, { error: 'The request exceeds 25 MB.' }); return; } chunks.push(chunk); }
  let command: Command;
  try { command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Command; } catch { return send(400, { error: 'The request is not valid JSON.' }); }
  if (command?.type === 'import_rows' || command?.type === 'import_statement') return send(400, { error: 'Import a complete statement with opening and closing balances, then review its entries before recording it.' });
  if (!Number.isSafeInteger(command?.expectedRevision) || Number(command.expectedRevision) < 0) return send(400, { error: 'Refresh your records before saving. Every change needs the current workspace revision.' });
  const requestId = 'requestId' in command ? command.requestId : undefined;
  if (['add_entity', 'add_account', 'add_obligation', 'add_reserve'].includes(command.type) && (typeof requestId !== 'string' || !requestId.trim())) return send(400, { error: 'This command needs a request ID so a retry cannot create the same record twice.' });
  if (command?.type === 'import_payroll') {
    const payroll = validatePayrollImport(command.import);
    for (const source of payroll.sources) {
      const original = documents.content(source.sha256).document;
      if (original.originalName !== source.filename || original.mimeType !== source.mimeType) return send(400, { error: 'Each payroll source must match its saved original filename and file type.' });
    }
  }
  if (command?.type === 'stage_statement' || command?.type === 'revise_statement') {
    const original = statementOriginal(command.statement);
    if (original.document.originalName !== command.statement.sourceFile) return send(400, { error: 'The statement filename must match its saved original.' });
    if ('id' in original.document && original.document.mimeType === 'text/csv; charset=utf-8') {
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(original.bytes);
      const rows = command.statement.csvMapping === undefined ? parseStatementCSV(csv, command.statement.sourceKind) : mapStatementCSV(csv, command.statement.csvMapping);
      const submitted = command.statement.rows;
      if (!Array.isArray(submitted) || submitted.length !== rows.length || rows.some((row, index) => (['id', 'transactionDate', 'postingDate', 'description', 'amountCents', 'sourcePage', 'dateBasis'] as const).some(field => row[field] !== submitted[index]?.[field]))) return send(400, { error: 'Statement entries must match every row in the saved CSV. Review classifications after staging the original entries.' });
    }
  }
  if (command?.type === 'commit_statements' && Array.isArray(command.importIds)) {
    const batches = (await store.state()).importBatches ?? [];
    for (const id of command.importIds) {
      const batch = batches.find(item => item.id === id);
      if (batch) statementOriginal(batch.source);
    }
  }
  return sendJson(200, await store.command(command, request.headers['x-mazal-state-changes'] === '1'));
}
