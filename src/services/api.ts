import {CommandRejectedError} from './command-errors.ts';
import type { AppState, Command, Workspace } from '../../shared/types.ts';
import { serializeBackup } from '../../shared/backup.ts';

export class StateRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = 'StateRequestError'; this.status = status; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readState(response: Response, workspace: Workspace, fallback: string, signal?: AbortSignal, baseline?: AppState, mutation=false): Promise<AppState> {
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(fallback);
  }
  if (signal?.aborted) throw signal.reason;
  if (!response.ok) {
    if(mutation&&[400,401,403,404,409,413,415,422].includes(response.status)&&record(result)&&typeof result.error==='string')throw new CommandRejectedError(result.error,response.status);
    const message = record(result) && typeof result.error === 'string' ? result.error : fallback;
    if (!mutation) throw new StateRequestError(message, response.status);
    throw new Error(message);
  }
  if (record(result) && result.format === 'mazal-state-changes') {
    const allowed = new Set(['entities', 'accounts', 'transactions', 'obligations', 'reserves', 'positions', 'audit', 'lastBackupAt', 'spendingLimits', 'assets', 'wishItems', 'moneyOwed', 'expenseFunds', 'expensePlanItems', 'assetPurchases', 'statements', 'importBatches', 'sourceFacts', 'categoryRules', 'payrollImports', 'roadmap']);
    if (result.workspace !== workspace || !Number.isSafeInteger(result.baseRevision) || !Number.isSafeInteger(result.revision)
      || Number(result.revision) !== Number(result.baseRevision) + 1 || !record(result.changes)
      || Object.entries(result.changes).some(([key, value]) => !allowed.has(key) || !['lastBackupAt', 'roadmap'].includes(key) && !Array.isArray(value))) {
      throw new Error('Mazal received incomplete records. Refresh to read them again.');
    }
    if (!baseline || baseline.workspace !== workspace || baseline.revision !== result.baseRevision) return loadState(workspace, signal);
    result = { ...baseline, ...result.changes, revision: result.revision };
  }
  const collections = ['entities', 'accounts', 'transactions', 'obligations', 'reserves', 'positions', 'audit'];
  if (!record(result) || result.workspace !== workspace || !Number.isSafeInteger(result.revision)
    || Number(result.revision) < 0 || collections.some(key => !Array.isArray(result[key]))) {
    throw new Error('Mazal received incomplete records. Refresh to read them again.');
  }
  return result as unknown as AppState;
}

export type DataSource = 'personal' | 'sample' | 'snapshot';
const stateReadMetadata = new WeakMap<AppState, { etag: string; source: DataSource; workspace: Workspace; revision: number }>();
function dataSource(response: Response, workspace: Workspace): DataSource {
  const source = response.headers.get('X-Mazal-Data-Source');
  return workspace === 'demo' || source === 'sample' ? 'sample' : source === 'snapshot' ? 'snapshot' : 'personal';
}

export async function loadState(workspace: Workspace, signal?: AbortSignal, onDataSource?: (source: DataSource) => void, baseline?: AppState): Promise<AppState> {
  const fallback = 'Mazal could not read your records. Check that the local server is running.';
  const metadata = baseline?.workspace === workspace ? stateReadMetadata.get(baseline) : undefined;
  const cached = metadata?.workspace === workspace && metadata.revision === baseline?.revision ? metadata : undefined;
  const request = new AbortController();
  const cancel = () => request.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let rejectAborted: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(request.signal.reason);
    if (request.signal.aborted) rejectAborted();
    else request.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const timer = setTimeout(() => request.abort(new Error('Reading your records timed out after 15 seconds. Retry to check the latest saved records.')), 15_000);
  async function read(conditional = true): Promise<AppState> {
    let response: Response;
    try {
      response = await fetch(`/api/state?workspace=${workspace}`, { signal: request.signal, cache: 'no-store', ...(conditional && cached ? { headers: { 'If-None-Match': cached.etag } } : {}) });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new Error(fallback);
    }
    if (request.signal.aborted) throw request.signal.reason;
    const source = dataSource(response, workspace);
    const etag = response.headers.get('ETag');
    if (response.status === 304) {
      if (!conditional || !cached || !baseline || etag !== cached.etag) throw new Error('Mazal received incomplete records. Refresh to read them again.');
      if (source !== cached.source) return read(false);
      onDataSource?.(source);
      return baseline;
    }
    const state = await readState(response, workspace, fallback, request.signal);
    if (request.signal.aborted) throw request.signal.reason;
    if (etag) stateReadMetadata.set(state, { etag, source, workspace, revision: state.revision });
    onDataSource?.(source);
    return state;
  }
  try { return await Promise.race([read(), aborted]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    request.signal.removeEventListener('abort', rejectAborted!);
  }
}

export async function sendCommand(workspace: Workspace, command: Command, baseline?: AppState): Promise<AppState> {
  const fallback = 'Mazal could not confirm whether the change was saved. Refresh your records before trying again.';
  const restoring = command.type === 'restore';
  const body = restoring ? serializeBackup(command.backup) : JSON.stringify(command);
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`The save response timed out after ${restoring ? '3 minutes' : '60 seconds'}. ${fallback}`);
      request.abort(error);
      reject(error);
    }, restoring ? 180_000 : 60_000);
  });
  async function send(): Promise<AppState> {
    let response: Response;
    try {
      response = await fetch(`/api/${restoring ? 'backup/restore' : 'command'}?workspace=${workspace}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(!restoring && baseline?.workspace === workspace && baseline.revision === command.expectedRevision ? { 'X-Mazal-State-Changes': '1' } : {}), ...(restoring && command.expectedRevision !== undefined ? { 'X-Mazal-Revision': String(command.expectedRevision) } : {}) },
        body,
        signal: request.signal,
      });
    } catch {
      if (request.signal.aborted) throw request.signal.reason;
      throw new Error(fallback);
    }
    if (request.signal.aborted) throw request.signal.reason;
    const state = await readState(response, workspace, fallback, request.signal, baseline, true);
    if (request.signal.aborted) throw request.signal.reason;
    return state;
  }
  try { return await Promise.race([send(), deadline]); }
  finally { clearTimeout(timer!); }
}
