import { Worker, type Transferable } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { RevisionConflictError } from './store.ts';
import { BackupError, type BackupContentType } from './backup.ts';
import type { AppState, Command, Workspace } from '../shared/types.ts';
import type { TransactionQuery } from './persistence.ts';
import type { StoreFailure, StoreReply, StoreRequest } from './store-worker.ts';

function failure(error: StoreFailure): Error {
  const result = error.name === 'RevisionConflictError' ? new RevisionConflictError(error.message) : error.name === 'BackupError' ? new BackupError(error.status ?? 400, error.message) : new Error(error.message);
  if (error.code) Object.assign(result, { code: error.code });
  return result;
}

export async function createStoreService(path: string, workspace: Workspace) {
  const worker = new Worker(new URL('./store-worker.ts', import.meta.url), { workerData: { path, workspace } });
  let sequence = 0;
  let stopped: Error | undefined;
  let closing = false;
  const pending = new Map<number, { resolve: (reply: StoreReply) => void; reject: (error: Error) => void }>();
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  function stop(error: Error): void {
    stopped = error;
    readyReject(error);
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  }
  worker.on('error', stop);
  worker.on('exit', () => stop(new Error('The database worker stopped. Restart Mazal, then refresh your records before trying again.')));
  worker.on('message', (reply: StoreReply | { ready: true }) => {
    if ('ready' in reply) { readyResolve(); return; }
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error) task.reject(failure(reply.error));
    else task.resolve(reply);
  });
  try { await ready; }
  catch (error) { await worker.terminate(); throw error; }
  let accounts: DatabaseSync | undefined;
  let accountLookup: ReturnType<DatabaseSync['prepare']>;
  try {
    accounts = new DatabaseSync(path, { readOnly: true });
    accountLookup = accounts.prepare("SELECT 1 FROM accounts WHERE id = ? AND type IN ('cash', 'investment', 'debt', 'receivable', 'payable')");
  } catch (error) {
    accounts?.close();
    await worker.terminate();
    throw error;
  }
  function reply(request: StoreRequest, transfer: readonly Transferable[] = []): Promise<StoreReply> {
    if (stopped) return Promise.reject(stopped);
    if (closing && request.method !== 'close') return Promise.reject(new Error('The database is closing.'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, request }, transfer); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  async function call(request: StoreRequest, transfer: readonly Transferable[] = []): Promise<string> {
    return (await reply(request, transfer)).json!;
  }
  return {
    state: async (): Promise<AppState> => JSON.parse(await call({ method: 'state' })) as AppState,
    stateJson: () => call({ method: 'state' }),
    stateResponse: async (ifNoneMatch?: string) => (await reply({ method: 'state_response', ifNoneMatch })).stateResponse!,
    hasAccount: (id: string): boolean => Boolean(accountLookup.get(id)),
    transactions: (query?: TransactionQuery) => call({ method: 'transactions', query }),
    command: (command: Command, changesOnly = false) => call({ method: 'command', command, changesOnly }),
    restore: (backup: unknown, expectedRevision: unknown) => call({ method: 'restore', backup, expectedRevision }),
    restoreEncoded: (bytes: Uint8Array, contentType: BackupContentType, expectedRevision: unknown) => {
      const owned = Uint8Array.from(bytes);
      return call({ method: 'restore_encoded', bytes: owned, contentType, expectedRevision }, [owned.buffer]);
    },
    export: () => call({ method: 'export' }),
    close: async (): Promise<void> => {
      if (closing) return;
      closing = true;
      try { await call({ method: 'close' }); }
      finally { accounts!.close(); await worker.terminate(); }
    },
  };
}
