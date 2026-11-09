import { gunzipSync } from 'node:zlib';
import { BACKUP_SIZE_ERROR, MAX_BACKUP_BYTES } from '../shared/backup.ts';

export type BackupContentType = 'application/json' | 'application/gzip';

export class BackupError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function decodeBackup(input: Uint8Array, contentType: BackupContentType, expectedRevision: unknown, maximum = MAX_BACKUP_BYTES): unknown {
  if (!['application/json', 'application/gzip'].includes(contentType)) throw new BackupError(415, 'Upload a JSON or gzip backup.');
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new BackupError(400, 'Refresh your records before restoring a backup.');
  if (input.byteLength > maximum) throw new BackupError(413, BACKUP_SIZE_ERROR);
  let bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (contentType === 'application/gzip') {
    try { bytes = gunzipSync(bytes, { maxOutputLength: maximum }); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') throw new BackupError(413, BACKUP_SIZE_ERROR);
      throw new BackupError(400, 'The compressed backup is incomplete or invalid.');
    }
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new BackupError(400, 'The backup is not valid JSON.'); }
}
