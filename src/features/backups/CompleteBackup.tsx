import { useEffect, useId, useRef, useState } from 'react';
import type { Workspace } from '../../../shared/types.ts';
import AutomaticBackup from './AutomaticBackup.tsx';

interface Preview {
  token: string; exportedAt: string; encrypted: boolean; archiveSha256: string; expectedRevision: number; files: number; bytes: number;
  workspaces: Record<Workspace, { revision: number; transactions: number; documents: number; unlinkedDocuments: number }>;
  calculationFiles: number;
}
interface Props { workspace: Workspace; revision: number; disabled?: boolean; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void; onRestored?: () => void }
interface RestoreAttempt { token: string; expectedRevision: number; body: string }
interface RestoreReceipt { status: 'restored'; token: string; expectedRevision: number; previousDirectory: string }
async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The complete backup could not be processed.');
  return body as T;
}
class BackupRequestTimeoutError extends Error {}
async function backupRequest<T>(url: string, options: RequestInit, controller: AbortController, timeoutMessage: string, readBody: (response: Response) => Promise<T>): Promise<T> {
  if (controller.signal.aborted) throw controller.signal.reason;
  let rejectAborted: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new BackupRequestTimeoutError(timeoutMessage)), 180_000);
  const read = async () => {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (controller.signal.aborted) throw controller.signal.reason;
    const result = await readBody(response);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  };
  try {
    const result = await Promise.race([read(), aborted]);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', rejectAborted!);
  }
}
function validPreview(result: Preview): boolean {
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
  return Boolean(result && typeof result.token === 'string' && result.token && /^[a-f0-9]{64}$/.test(result.archiveSha256) && typeof result.encrypted === 'boolean' && Number.isFinite(Date.parse(result.exportedAt)) && [result.expectedRevision, result.files, result.bytes, result.calculationFiles].every(count) && [result.workspaces?.live, result.workspaces?.demo].every(workspace => workspace && [workspace.revision, workspace.transactions, workspace.documents, workspace.unlinkedDocuments].every(count)));
}
export default function CompleteBackup(props: Props) {
  return <WorkspaceCompleteBackup key={props.workspace} {...props}/>;
}
function WorkspaceCompleteBackup({ workspace, revision, disabled = false, onBusyChange, onDirtyChange, onRestored }: Props) {
  const heading = useId();
  const [encrypted, setEncrypted] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [repeatPassphrase, setRepeatPassphrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState<RestoreAttempt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [automaticBusy, setAutomaticBusy] = useState(false);
  const [automaticDirty, setAutomaticDirty] = useState(false);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restored, setRestored] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const backupRegion = useRef<HTMLElement>(null);
  const operationError = useRef<HTMLParagraphElement>(null);
  const restoreOperationFocus = useRef(false);
  useEffect(() => { onBusyChange?.(busy || automaticBusy); }, [busy, automaticBusy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(Boolean(file) || automaticDirty); }, [file, automaticDirty, onDirtyChange]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  useEffect(() => {
    if (!error || busy) return;
    const region = backupRegion.current;
    const active = document.activeElement;
    const ownsFocus = region?.contains(active) || active === document.body && restoreOperationFocus.current;
    restoreOperationFocus.current = false;
    if (!region || !ownsFocus || region.closest('[hidden], [inert], dialog:not([open]), details:not([open])')) return;
    for (let element: HTMLElement | null = region; element; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
    }
    operationError.current?.focus();
  }, [error, busy]);
  const blocked = disabled || busy || automaticBusy || automaticDirty || workspace !== 'live';
  const choicesBlocked = blocked || Boolean(restoreAttempt);
  const stale = preview !== null && preview.expectedRevision !== revision;
  function trackOperationFocus(button: HTMLButtonElement) {
    restoreOperationFocus.current = document.activeElement === button || Boolean(backupRegion.current?.contains(document.activeElement));
    const focusLeftBackup = (event: Event) => {
      if ((event.type === 'pointerdown' || event.target !== document.body) && !backupRegion.current?.contains(event.target as Node)) restoreOperationFocus.current = false;
    };
    document.addEventListener('focusin', focusLeftBackup);
    document.addEventListener('pointerdown', focusLeftBackup);
    return () => {
      document.removeEventListener('focusin', focusLeftBackup);
      document.removeEventListener('pointerdown', focusLeftBackup);
    };
  }
  function checkRequest(controller: AbortController) {
    if (request.current !== controller || controller.signal.aborted) throw controller.signal.reason ?? new DOMException('The backup operation was canceled.', 'AbortError');
  }
  function canReport(controller: AbortController, failure: unknown) {
    return request.current === controller && (!controller.signal.aborted || failure instanceof BackupRequestTimeoutError);
  }
  function finishRequest(controller: AbortController) {
    if (request.current === controller) { request.current = null; setBusy(false); setOperation(''); }
  }
  async function download(button: HTMLButtonElement) {
    if (choicesBlocked || request.current) return;
    setError(''); setNotice('');
    if (encrypted && (exportPassphrase.length < 12 || exportPassphrase !== repeatPassphrase)) { setError('Use at least 12 characters and enter the same passphrase twice.'); return; }
    const controller = new AbortController(); request.current = controller;
    const stopTrackingFocus = trackOperationFocus(button);
    setBusy(true); setOperation('Creating and verifying complete backup…');
    try {
      const blob = await backupRequest('/api/complete-backup/export?workspace=live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: encrypted ? exportPassphrase : '' }) }, controller, 'Creating the complete backup timed out after 3 minutes. Your download settings are still here. Try downloading again.', async response => {
        if (!response.ok) await responseData(response);
        return response.blob();
      });
      checkRequest(controller);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `mazal-complete-${new Date().toISOString().slice(0, 10)}${encrypted ? '.encrypted' : ''}.mazal`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setExportPassphrase(''); setRepeatPassphrase('');
      setNotice('Download started. Save the complete backup outside Mazal’s data folder and keep a copy on another device. Verify the saved file below.');
    } catch (failure) { if (canReport(controller, failure)) setError(failure instanceof Error ? failure.message : 'The complete backup could not be downloaded.'); }
    finally { stopTrackingFocus(); finishRequest(controller); }
  }
  async function verify(button: HTMLButtonElement) {
    if (choicesBlocked || !file || request.current) return;
    const controller = new AbortController(); request.current = controller;
    const stopTrackingFocus = trackOperationFocus(button);
    setBusy(true); setOperation('Checking every file and restored database…'); setPreview(null); setConfirmed(false); setError(''); setNotice('');
    try {
      if (file.size > 256 * 1024 * 1024) throw new Error('Choose a complete backup smaller than 256 MiB.');
      const result = await backupRequest('/api/complete-backup/preview?workspace=live', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(restorePassphrase ? { 'X-Mazal-Backup-Passphrase': encodeURIComponent(restorePassphrase) } : {}) }, body: file }, controller, 'Verifying the complete backup timed out after 3 minutes. Your backup file and passphrase are still here. No restore was requested. Try verifying again.', responseData<Preview>);
      checkRequest(controller);
      if (!validPreview(result)) throw new Error('The backup returned an invalid verification. Try verifying the file again.');
      setPreview(result); setRestorePassphrase('');
    } catch (failure) { if (canReport(controller, failure)) setError(failure instanceof Error ? failure.message : 'The backup could not be verified.'); }
    finally { stopTrackingFocus(); finishRequest(controller); }
  }
  async function restore(button: HTMLButtonElement) {
    if (blocked || !preview || request.current || !restoreAttempt && (stale || !confirmed)) return;
    const attempt = restoreAttempt ?? { token: preview.token, expectedRevision: preview.expectedRevision, body: JSON.stringify({ token: preview.token, expectedRevision: preview.expectedRevision, confirmation: true }) };
    const controller = new AbortController(); request.current = controller;
    const stopTrackingFocus = trackOperationFocus(button);
    setRestoreAttempt(attempt);
    setBusy(true); setOperation('Restoring the verified backup…'); setError(''); setNotice('');
    try {
      const result = await backupRequest('/api/complete-backup/restore?workspace=live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: attempt.body }, controller, 'Restoring the complete backup timed out after 3 minutes. The restore may have completed. Confirm the original restore to retry the same request, or close this window and inspect your records.', responseData<RestoreReceipt>);
      checkRequest(controller);
      if (result?.status !== 'restored' || result.token !== attempt.token || result.expectedRevision !== attempt.expectedRevision || typeof result.previousDirectory !== 'string' || !result.previousDirectory) throw new Error('The restore returned an invalid confirmation.');
      setFile(null); setPreview(null); setConfirmed(false); setRestoreAttempt(null); setRestored(true); onDirtyChange?.(false);
      if (fileInput.current) fileInput.current.value = '';
      setNotice('Complete backup restored and verified. Mazal kept the previous data folder beside the current folder. Open the restored records to refresh this window.');
      onRestored?.();
    } catch (failure) { if (canReport(controller, failure)) setError(failure instanceof BackupRequestTimeoutError ? failure.message : `${failure instanceof Error ? failure.message : 'Restore could not be confirmed.'} The restore may have completed. Confirm the original restore to retry the same request, or close this window and inspect your records.`); }
    finally { stopTrackingFocus(); finishRequest(controller); }
  }
  function clear() { if (choicesBlocked || request.current) return; setFile(null); setPreview(null); setConfirmed(false); setRestorePassphrase(''); if (fileInput.current) fileInput.current.value = ''; }
  return <section ref={backupRegion} className="mazal-backup-section" aria-labelledby={heading}>
    <h3 id={heading}>Complete backup</h3>
    <p className="muted">One file saves My finances and Sample records, document metadata, original files, and calculation evidence. Restore replaces both workspaces together. Excel exports, temporary caches, and earlier safety copies stay separate.</p>
    {workspace === 'live' && <AutomaticBackup disabled={disabled || busy || Boolean(file) || Boolean(restoreAttempt)} onBusyChange={setAutomaticBusy} onDirtyChange={setAutomaticDirty}/>}
    <label className="mazal-checkbox"><input type="checkbox" checked={encrypted} disabled={choicesBlocked} onChange={event => setEncrypted(event.target.checked)} /><span>Encrypt this download with a passphrase</span></label>
    {encrypted && <div className="form-grid"><label className="field"><span>Backup passphrase</span><input type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={exportPassphrase} disabled={choicesBlocked} onChange={event => setExportPassphrase(event.target.value)} /></label><label className="field"><span>Repeat passphrase</span><input type="password" autoComplete="new-password" maxLength={1024} value={repeatPassphrase} disabled={choicesBlocked} onChange={event => setRepeatPassphrase(event.target.value)} /></label><p className="muted">Keep the passphrase separately. Mazal cannot recover an encrypted backup without it.</p></div>}
    <button type="button" className="button secondary" disabled={choicesBlocked} onClick={event => void download(event.currentTarget)}>Download complete backup</button>
    <label className="field mazal-file"><span>Verify or restore a complete backup (.mazal)</span><input ref={fileInput} type="file" accept=".mazal,application/octet-stream" disabled={choicesBlocked} onChange={event => { if (choicesBlocked || request.current) return; setFile(event.target.files?.[0] ?? null); setPreview(null); setConfirmed(false); setError(''); setNotice(''); }} /></label>
    {file && <><label className="field"><span>Backup passphrase, if encrypted</span><input type="password" autoComplete="off" maxLength={1024} value={restorePassphrase} disabled={choicesBlocked} onChange={event => setRestorePassphrase(event.target.value)} /></label><button type="button" className="button secondary" disabled={choicesBlocked} onClick={event => void verify(event.currentTarget)}>Verify complete backup</button>{' '}<button type="button" className="text-button" disabled={choicesBlocked} onClick={clear}>Clear backup</button></>}
    {preview && <div className="mazal-backup-preview"><strong>Backup verified</strong><p>{preview.workspaces.live.transactions.toLocaleString()} personal transactions · {preview.workspaces.live.documents} personal originals · {preview.calculationFiles} calculation evidence files</p><p className="muted">Saved {new Date(preview.exportedAt).toLocaleString()}. Every file passed its SHA-256 check. Both financial databases and document links passed restore checks.</p>{Object.values(preview.workspaces).some(value => value.unlinkedDocuments) && <p className="muted">Unlinked documents remain unlinked after restoration. No account assignments are guessed.</p>}{stale && !restoreAttempt && <p role="alert">Your records changed. Verify the backup again before restoring.</p>}<label className="mazal-checkbox"><input type="checkbox" checked={confirmed} disabled={choicesBlocked || stale} onChange={event => setConfirmed(event.target.checked)} /><span>Replace both workspaces, originals, and calculation evidence with this backup. Keep the previous data folder as a safety copy.</span></label><button type="button" className="button primary" disabled={blocked || !restoreAttempt && (stale || !confirmed)} onClick={event => void restore(event.currentTarget)}>{restoreAttempt ? 'Confirm original restore' : 'Restore complete backup'}</button></div>}
    {operation && <p role="status">{operation}</p>}{notice && <p role="status">{notice}</p>}{error && <p ref={operationError} className="form-error" role="alert" tabIndex={-1}>{error}</p>}
    {restoreAttempt && !busy && <p className="muted">The original restore is awaiting confirmation. This backup stays locked so a retry uses the same request. Closing this window discards only the on-screen choices. It does not undo a completed restore. If Mazal restarted, inspect your records before starting another restore.</p>}
    {restoreAttempt && !busy && <button type="button" className="button secondary" onClick={() => window.location.reload()}>Open records to check</button>}
    {restored && <button type="button" className="button primary" onClick={() => window.location.reload()}>Open restored records</button>}
  </section>;
}
