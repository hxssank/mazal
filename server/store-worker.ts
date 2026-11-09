import { parentPort, workerData } from 'node:worker_threads';
import { createStore, type StateResponse } from './store.ts';
import { serializeBackup } from '../shared/backup.ts';
import { BackupError, decodeBackup, type BackupContentType } from './backup.ts';
import type { Command, Workspace } from '../shared/types.ts';
import type { TransactionQuery } from './persistence.ts';

export type StoreRequest =
  | { method: 'state' | 'export' | 'close' }
  | { method: 'state_response'; ifNoneMatch?: string }
  | { method: 'command'; command: Command; changesOnly: boolean }
  | { method: 'restore'; backup: unknown; expectedRevision: unknown }
  | { method: 'restore_encoded'; bytes: Uint8Array; contentType: BackupContentType; expectedRevision: unknown }
  | { method: 'transactions'; query?: TransactionQuery };
export interface StoreFailure { name: string; message: string; code?: string; status?: number }
export interface StoreReply { id: number; json?: string; stateResponse?: StateResponse; error?: StoreFailure }

const port = parentPort!;
const { path, workspace } = workerData as { path: string; workspace: Workspace };
const store = createStore(path, workspace);
port.postMessage({ ready: true });
port.on('message', ({ id, request }: { id: number; request: StoreRequest }) => {
  try {
    if (request.method === 'state_response') {
      port.postMessage({ id, stateResponse: store.stateResponse(request.ifNoneMatch) } satisfies StoreReply);
      return;
    }
    let json: string;
    switch (request.method) {
      case 'state': json = store.stateJson(); break;
      case 'command': json = JSON.stringify(request.changesOnly ? store.commandChanges(request.command) : store.command(request.command)); break;
      case 'restore': json = JSON.stringify(store.restore(request.backup, request.expectedRevision)); break;
      case 'restore_encoded': json = JSON.stringify(store.restore(decodeBackup(request.bytes, request.contentType, request.expectedRevision), request.expectedRevision)); break;
      case 'transactions': json = JSON.stringify(store.transactions(request.query)); break;
      case 'export': json = serializeBackup(store.export()); break;
      case 'close': store.close(); json = 'null'; break;
    }
    port.postMessage({ id, json } satisfies StoreReply);
    if (request.method === 'close') port.close();
  } catch (error) {
    const failure = error instanceof Error ? { name: error.constructor.name, message: error.message, ...('code' in error ? { code: String(error.code) } : {}), ...(error instanceof BackupError ? { status: error.status } : {}) } : { name: 'Error', message: String(error) };
    port.postMessage({ id, error: failure } satisfies StoreReply);
  }
});
