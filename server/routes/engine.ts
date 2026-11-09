import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AppState, Workspace } from '../../shared/types.ts';
import { EngineError, type EngineTransport } from '../engine-contract.ts';

const MAX_BODY_BYTES = 512 * 1024;

export interface EngineRouteResult { status: number; body?: unknown; download?: { body: ReadableStream<Uint8Array>; headers: Record<string, string> } }

export async function sendEngineResponse(response: ServerResponse, result: EngineRouteResult): Promise<void> {
  if (result.download) {
    response.writeHead(result.status, result.download.headers);
    await pipeline(Readable.fromWeb(result.download.body as NodeReadableStream<Uint8Array>), response);
    return;
  }
  response.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result.body));
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new EngineError(415, 'Calculations must use application/json.');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new EngineError(413, 'The calculation request exceeds 512 KB.');
    chunks.push(chunk);
  }
  let result: unknown;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new EngineError(400, 'The calculation request is not valid JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new EngineError(400, 'The calculation request must be an object.');
  return result as Record<string, unknown>;
}

function asOfDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1901-01-01' || value > '2199-12-31' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new EngineError(400, 'Choose a valid calculation date between 1901 and 2199 as YYYY-MM-DD.');
  return value;
}

export async function engineRoute(request: IncomingMessage, url: URL, workspace: Workspace, state: () => Promise<AppState>, engine: EngineTransport): Promise<EngineRouteResult> {
  const route = url.pathname.slice('/api/engine'.length);
  if (workspace !== 'live' && workspace !== 'demo') throw new EngineError(400, 'Choose the live or demo workspace.');
  const archiveDownload = /^\/storage\/archives\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/download$/.exec(route);
  if (archiveDownload) {
    if (request.method !== 'GET') throw new EngineError(405, 'Use GET to download a calculation archive.');
    if (!engine.download) throw new EngineError(503, 'Calculation archive downloads are unavailable. Restart Mazal.');
    const response = await engine.download(`${route}?workspace=${workspace}`);
    const length = Number(response.headers.get('content-length'));
    if (!response.ok || !response.body || response.headers.get('x-mazal-workspace') !== workspace || response.headers.get('content-type')?.split(';')[0] !== 'application/zip' || !Number.isSafeInteger(length) || length <= 0 || length > 129 * 1024 * 1024) {
      await response.body?.cancel();
      throw new EngineError(503, 'The engine returned an invalid calculation archive. Existing evidence is unchanged.');
    }
    return { status: 200, download: { body: response.body, headers: {
      'Content-Type': 'application/zip', 'Content-Length': String(length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="mazal-calculations-${archiveDownload[1]}.zip"`,
    } } };
  }
  if (route === '/storage' || route === '/storage/archive' || route === '/storage/restore') {
    const reading = route === '/storage';
    if (request.method !== (reading ? 'GET' : 'POST')) throw new EngineError(405, reading ? 'Use GET to read calculation storage.' : 'Use POST to archive or restore calculation evidence.');
    const body = reading ? undefined : await requestBody(request);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (route === '/storage/archive' && (!body || Object.keys(body).length !== 1 || !Array.isArray(body.runIds) || body.runIds.length < 1 || body.runIds.length > 20 || new Set(body.runIds).size !== body.runIds.length || body.runIds.some(value => typeof value !== 'string' || !uuid.test(value)))) throw new EngineError(400, 'Select between 1 and 20 distinct finished calculations.');
    if (route === '/storage/restore' && (!body || Object.keys(body).length !== 1 || typeof body.archiveId !== 'string' || !uuid.test(body.archiveId))) throw new EngineError(400, 'Choose a saved calculation archive.');
    const result = await engine.request(`${route}?workspace=${workspace}`, request.method, body);
    if (!result || typeof result !== 'object' || !('workspace' in result) || result.workspace !== workspace) throw new EngineError(503, 'The engine returned calculation storage from another workspace.');
    return { status: 200, body: result };
  }
  const job = /^\/runs\/([A-Za-z0-9_-]{1,128})$/.exec(route);
  if (job) {
    if (request.method !== 'GET' && request.method !== 'DELETE') throw new EngineError(405, 'Use GET to read a run or DELETE to cancel it.');
    const result = await engine.request(`/runs/${job[1]}?workspace=${workspace}`, request.method);
    if (!result || typeof result !== 'object' || !('workspace' in result) || result.workspace !== workspace) throw new EngineError(503, 'The financial engine returned a run from another workspace.');
    return { status: 200, body: result };
  }
  if (route === '/health') {
    if (request.method !== 'GET') throw new EngineError(405, 'Use GET to check the financial engine.');
    return { status: 200, body: await engine.request('/health') };
  }
  if (!['/summary', '/readiness', '/project', '/runs'].includes(route)) throw new EngineError(404, 'Financial engine endpoint was not found.');
  const read = route === '/summary' || route === '/readiness';
  if (request.method !== (read ? 'GET' : 'POST')) throw new EngineError(405, read ? 'Use GET to read this calculation.' : 'Use POST to calculate a scenario.');
  const body = read ? Object.fromEntries(url.searchParams) : await requestBody(request);
  if (Object.hasOwn(body, 'snapshot')) throw new EngineError(400, 'Calculations use saved records. Do not supply a snapshot.');
  const expectedRevision = read && typeof body.expectedRevision === 'string' && /^\d+$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new EngineError(400, 'Calculations need the current workspace revision.');
  const asOf = asOfDate(body.asOf);
  const snapshot = await state();
  if (snapshot.revision !== expectedRevision) throw new EngineError(409, 'Your records changed. Refresh Mazal before calculating again.');
  const scope = body.scope;
  if (typeof scope !== 'string' || scope !== 'all' && !snapshot.entities.some(entity => entity.id === scope)) throw new EngineError(400, 'Choose an existing financial scope.');
  const payload = { snapshot, scope, asOf, ...(route === '/project' ? { kind: body.kind, draft: body.draft } : {}), ...(route === '/runs' ? { kind: body.kind ?? 'comparison', assumptions: body.assumptions ?? {} } : {}) };
  return { status: route === '/runs' ? 202 : 200, body: await engine.request(route, 'POST', payload) };
}
