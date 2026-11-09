export interface BackupStatus {
  supported: boolean; unsupportedReason: string | null; configured: boolean; enabled: boolean;
  destination: string | null; intervalHours: number; retentionCount: number;
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastVerifiedAt: string | null;
  lastBackupPath: string | null; lastBackupSha256: string | null; lastError: string | null;
  nextRunAt: string | null; running: boolean;
}
export function validStatus(value: BackupStatus): boolean {
  return Boolean(value && ['supported', 'configured', 'enabled', 'running'].every(key => typeof value[key as keyof BackupStatus] === 'boolean')
    && [value.unsupportedReason, value.destination, value.lastBackupPath, value.lastError, value.lastBackupSha256].every(item => item === null || typeof item === 'string')
    && [value.lastAttemptAt, value.lastSuccessAt, value.lastVerifiedAt, value.nextRunAt].every(item => item === null || typeof item === 'string' && Number.isFinite(Date.parse(item)))
    && Number.isSafeInteger(value.intervalHours) && value.intervalHours > 0 && Number.isSafeInteger(value.retentionCount) && value.retentionCount > 0);
}
export async function request<T>(path: string, method: 'GET' | 'POST', controller: AbortController, body?: object): Promise<T> {
  const timeout = method === 'GET' ? 15_000 : 180_000;
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error(method === 'GET' ? 'Backup status did not respond within 15 seconds. Try checking again.' : 'The backup request timed out after 3 minutes. Check backup status before trying another change.')), timeout);
  const read = async () => {
    const response = await fetch(`/api/automatic-backup${path}`, { method, cache: 'no-store', signal: controller.signal, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) });
    if (controller.signal.aborted) throw controller.signal.reason;
    const data = await response.json();
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) throw new Error(data.error || 'The automatic backup request failed.');
    return data as T;
  };
  try { return await Promise.race([read(), aborted]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
}
