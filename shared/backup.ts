export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
export const BACKUP_SIZE_ERROR = 'Mazal backups support up to 256 MiB of uncompressed JSON.';

export function serializeBackup(backup: unknown, maximum = MAX_BACKUP_BYTES): string {
  const json = JSON.stringify(backup);
  if (typeof json !== 'string') throw new Error('The backup must contain a JSON object.');
  if (new TextEncoder().encode(json).byteLength > maximum) throw new Error(BACKUP_SIZE_ERROR);
  return json;
}

export async function readBackupFile(file: Blob, maximum = MAX_BACKUP_BYTES): Promise<unknown> {
  if (file.size > maximum) throw new Error(BACKUP_SIZE_ERROR);
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const stream = signature[0] === 0x1f && signature[1] === 0x8b
    ? file.stream().pipeThrough(new DecompressionStream('gzip')) : file.stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pieces: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw new Error(BACKUP_SIZE_ERROR);
      pieces.push(decoder.decode(value, { stream: true }));
    }
    pieces.push(decoder.decode());
    return JSON.parse(pieces.join(''));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
