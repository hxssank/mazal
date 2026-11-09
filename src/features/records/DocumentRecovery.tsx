import { useEffect, useId, useRef, useState } from 'react';
import type { Account, Workspace } from '../../../shared/types.ts';
import { MAX_DOCUMENT_ARCHIVE_BYTES, type DocumentRecoveryHealth, type DocumentRestorePreview, type DocumentRestoreResult } from '../../../shared/recovery.ts';
import RecoveryAccountLinks from './RecoveryAccountLinks.tsx';
import './document-recovery.css';

interface Props {
  workspace: Workspace;
  revision: number;
  accounts: Account[];
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

async function responseData<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The original files could not be restored.');
  return value as T;
}

class RecoveryRequestTimeoutError extends Error {}

async function recoveryRequest<T>(url: string, options: RequestInit, controller: AbortController, milliseconds: number, timeoutMessage: string): Promise<T> {
  if (controller.signal.aborted) throw controller.signal.reason;
  let rejectAborted: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new RecoveryRequestTimeoutError(timeoutMessage)), milliseconds);
  const read = async () => {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (controller.signal.aborted) throw controller.signal.reason;
    const value = await responseData<T>(response);
    if (controller.signal.aborted) throw controller.signal.reason;
    return value;
  };
  try {
    const value = await Promise.race([read(), aborted]);
    if (controller.signal.aborted) throw controller.signal.reason;
    return value;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', rejectAborted!);
  }
}

export default function DocumentRecovery(props: Props) {
  return <WorkspaceDocumentRecovery key={props.workspace} {...props}/>;
}

function WorkspaceDocumentRecovery({ workspace, revision, accounts, disabled = false, onBusyChange, onDirtyChange }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DocumentRestorePreview | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [restoreAttempt, setRestoreAttempt] = useState<{ body: string; archiveSha256: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linkDirty, setLinkDirty] = useState(false);
  const [operation, setOperation] = useState<'verify' | 'restore' | 'clear' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [health, setHealth] = useState<DocumentRecoveryHealth | null>(null);
  const [healthError, setHealthError] = useState('');
  const [healthRefresh, setHealthRefresh] = useState(0);
  const healthRequest = useRef<AbortController | null>(null);
  const archiveRequest = useRef<AbortController | null>(null);
  const recoveryRegion = useRef<HTMLElement>(null);
  const archiveError = useRef<HTMLParagraphElement>(null);
  const restoreArchiveFocus = useRef(false);
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const fileInput = useRef<HTMLInputElement>(null);
  const headingId = useId();
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(Boolean(file) || linkDirty); }, [file, linkDirty, onDirtyChange]);
  useEffect(() => () => { archiveRequest.current?.abort(); archiveRequest.current = null; }, []);
  useEffect(() => {
    if (!error || busy) return;
    const region = recoveryRegion.current;
    const active = document.activeElement;
    const ownsFocus = region?.contains(active) || active === document.body && restoreArchiveFocus.current;
    restoreArchiveFocus.current = false;
    if (!region || !ownsFocus || region.closest('[hidden], [inert], dialog:not([open]), details:not([open])')) return;
    for (let element: HTMLElement | null = region; element; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
    }
    archiveError.current?.focus();
  }, [error, busy]);
  useEffect(() => {
    const controller = new AbortController();
    healthRequest.current = controller;
    setHealth(null);
    setHealthError('');
    void recoveryRequest<DocumentRecoveryHealth>(`/api/documents/recovery?workspace=${workspace}`, { cache: 'no-store' }, controller, 15_000, 'Checking original-file recovery timed out after 15 seconds. Try checking recovery again.').then(value => {
        if (!Array.isArray(value.issues)) throw new Error('The recovery check returned an invalid response.');
        if (healthRequest.current === controller && !controller.signal.aborted) setHealth(value);
      }).catch(failure => {
        if (healthRequest.current === controller && (!controller.signal.aborted || failure instanceof RecoveryRequestTimeoutError)) setHealthError(failure instanceof Error ? failure.message : 'The recovery check is unavailable.');
      });
    return () => { controller.abort(); if (healthRequest.current === controller) healthRequest.current = null; };
  }, [workspace, revision, healthRefresh]);
  const stale = preview !== null && preview.expectedRevision !== revision;
  const unresolved = preview?.documents.filter(document => document.status === 'new' && document.linkReason === 'unresolved' && !mappings[document.id]) ?? [];

  function chooseFile(value: File | null) {
    if (restoreAttempt) return;
    setFile(value); setPreview(null); setMappings({}); setConfirmed(false); setError(''); setNotice('');
  }
  function checkArchiveRequest(controller: AbortController) {
    if (archiveRequest.current !== controller || controller.signal.aborted) throw controller.signal.reason ?? new DOMException('The archive operation was canceled.', 'AbortError');
  }
  function trackArchiveFocus(button: HTMLButtonElement) {
    restoreArchiveFocus.current = document.activeElement === button || Boolean(recoveryRegion.current?.contains(document.activeElement));
    const focusLeftRecovery = (event: Event) => {
      if ((event.type === 'pointerdown' || event.target !== document.body) && !recoveryRegion.current?.contains(event.target as Node)) restoreArchiveFocus.current = false;
    };
    document.addEventListener('focusin', focusLeftRecovery);
    document.addEventListener('pointerdown', focusLeftRecovery);
    return () => {
      document.removeEventListener('focusin', focusLeftRecovery);
      document.removeEventListener('pointerdown', focusLeftRecovery);
    };
  }
  async function discardPreview(controller: AbortController) {
    if (!preview) return;
    const result = await recoveryRequest<{ status: 'discarded' }>(`/api/documents/restore/preview?${new URLSearchParams({ workspace, token: preview.token })}`, { method: 'DELETE' }, controller, 60_000, 'Clearing the archive preview timed out after 60 seconds. The preview may already be cleared. Your archive and account choices are still here. Retry clearing it.');
    checkArchiveRequest(controller);
    if (result?.status !== 'discarded') throw new Error('The archive preview was not confirmed as cleared. Your archive and account choices are still here. Retry clearing it.');
    setPreview(null); setMappings({}); setConfirmed(false);
  }
  async function clearArchive(button: HTMLButtonElement) {
    if (busy || disabled || archiveRequest.current || restoreAttempt) return;
    const controller = new AbortController();
    archiveRequest.current = controller;
    const stopTrackingFocus = trackArchiveFocus(button);
    setBusy(true); setOperation('clear'); setError(''); setConfirmed(false);
    try {
      await discardPreview(controller);
      checkArchiveRequest(controller);
      chooseFile(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (failure) {
      if (archiveRequest.current === controller && (!controller.signal.aborted || failure instanceof RecoveryRequestTimeoutError)) setError(failure instanceof Error ? failure.message : 'The archive preview could not be cleared.');
    } finally {
      stopTrackingFocus();
      if (archiveRequest.current === controller) { archiveRequest.current = null; setBusy(false); setOperation(null); }
    }
  }
  async function verify(button: HTMLButtonElement) {
    if (!file || busy || disabled || archiveRequest.current || restoreAttempt) return;
    const controller = new AbortController();
    archiveRequest.current = controller;
    const stopTrackingFocus = trackArchiveFocus(button);
    setBusy(true); setOperation('verify'); setError(''); setNotice(''); setConfirmed(false);
    try {
      if (file.size > MAX_DOCUMENT_ARCHIVE_BYTES) throw new Error('Choose an original-file archive smaller than 256 MiB.');
      await discardPreview(controller);
      checkArchiveRequest(controller);
      const result = await recoveryRequest<DocumentRestorePreview>(`/api/documents/restore/preview?workspace=${workspace}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      }, controller, 180_000, 'Archive verification timed out after 3 minutes. The archive is still selected. No originals were restored. Try verifying again.');
      checkArchiveRequest(controller);
      setPreview(result);
      setMappings(Object.fromEntries(result.documents.filter(document => document.status === 'new').map(document => [document.id, document.suggestedAccountId ?? (document.linkReason === 'unresolved' ? '' : 'unlinked')])));
      if (result.expectedRevision !== currentRevision.current) throw new Error('Financial records changed during verification. Verify the archive again.');
    } catch (failure) {
      if (archiveRequest.current === controller && (!controller.signal.aborted || failure instanceof RecoveryRequestTimeoutError)) setError(failure instanceof Error ? failure.message : 'The archive could not be verified.');
    } finally {
      stopTrackingFocus();
      if (archiveRequest.current === controller) { archiveRequest.current = null; setBusy(false); setOperation(null); }
    }
  }
  async function restore(button: HTMLButtonElement) {
    if (!preview || busy || disabled || archiveRequest.current || !restoreAttempt && (!confirmed || stale || unresolved.length || preview.conflicts.length)) return;
    const attempt = restoreAttempt ?? {
      body: JSON.stringify({ token: preview.token, expectedRevision: preview.expectedRevision, accountMappings: Object.fromEntries(Object.entries(mappings).map(([id, account]) => [id, account === 'unlinked' ? null : account])) }),
      archiveSha256: preview.archiveSha256,
    };
    const controller = new AbortController();
    archiveRequest.current = controller;
    const stopTrackingFocus = trackArchiveFocus(button);
    setRestoreAttempt(attempt);
    setBusy(true); setOperation('restore'); setError(''); setNotice('');
    try {
      const result = await recoveryRequest<DocumentRestoreResult>(`/api/documents/restore/commit?workspace=${workspace}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: attempt.body,
      }, controller, 180_000, 'Restoring original files timed out after 3 minutes. The restore may have completed. Check recovery, then confirm the original restore to retry with the same account choices.');
      checkArchiveRequest(controller);
      if (result?.status !== 'restored' || result.archiveSha256 !== attempt.archiveSha256 || ![result.documentsAdded, result.originalsRepaired, result.documentsPreserved, result.reviewSourcesRestored].every(value => Number.isSafeInteger(value) && value >= 0) || !Array.isArray(result.recovery?.issues)) throw new Error('The restore returned an invalid confirmation.');
      setNotice(`${result.documentsAdded} documents restored, ${result.originalsRepaired} missing originals repaired, ${result.documentsPreserved} existing documents preserved, and ${result.reviewSourcesRestored} review sources restored.`);
      setHealth(result.recovery); setFile(null); setPreview(null); setMappings({}); setConfirmed(false); setRestoreAttempt(null);
      if (fileInput.current) fileInput.current.value = '';
      setHealthRefresh(value => value + 1);
    } catch (failure) {
      if (archiveRequest.current === controller && (!controller.signal.aborted || failure instanceof RecoveryRequestTimeoutError)) setError(failure instanceof RecoveryRequestTimeoutError ? failure.message : `${failure instanceof Error ? failure.message : 'Restore could not be confirmed.'} The restore may have completed. Check recovery, then confirm the original restore with the same account choices.`);
    } finally {
      stopTrackingFocus();
      if (archiveRequest.current === controller) { archiveRequest.current = null; setBusy(false); setOperation(null); }
    }
  }

  return <section ref={recoveryRegion} className="mazal-backup-section document-recovery" aria-labelledby={headingId}>
    <h3 id={headingId}>2. Restore original files</h3>
    <p className="muted">Restore your financial backup first. Then choose the original-file archive saved with it. Mazal checks file sizes and SHA-256 hashes, matches documents to accounts, and keeps existing document details.</p>
    <label className="field mazal-file"><span>Original-file archive (.tar.gz)</span><input ref={fileInput} type="file" accept=".gz,.tgz,application/gzip" disabled={busy || disabled || linkDirty || Boolean(preview)} onChange={event => chooseFile(event.target.files?.[0] ?? null)} /></label>
    {file && <div className="document-recovery-actions"><button type="button" className="button secondary" disabled={busy || disabled || Boolean(restoreAttempt)} onClick={event => void verify(event.currentTarget)}>{preview ? 'Verify archive again' : 'Verify archive'}</button><button type="button" className="text-button" disabled={busy || disabled || Boolean(restoreAttempt)} onClick={event => void clearArchive(event.currentTarget)}>Clear archive</button></div>}
    {busy && operation && <p role="status">{operation === 'restore' ? 'Restoring verified files…' : operation === 'clear' ? 'Clearing archive preview…' : 'Checking archive contents and hashes…'}</p>}
    {error && <p ref={archiveError} role="alert" tabIndex={-1} className="notice">{error}</p>}
    {restoreAttempt && !busy && <p className="muted">These account choices are locked until the original restore is confirmed. Closing this window discards only the on-screen choices. It does not undo files already restored.</p>}
    {notice && <p role="status">{notice}</p>}
    {preview && <div className="mazal-backup-preview">
      <strong>{file?.name}</strong>
      <p>{preview.counts.documents} documents and {preview.counts.reviewSources} review sources verified. {preview.counts.newDocuments} new documents, {preview.counts.missingOriginals} missing originals to repair.</p>
      {stale && !restoreAttempt && <p role="alert">Financial records changed. Verify the archive again before restoring.</p>}
      {preview.conflicts.length > 0 && <div role="alert"><p>Resolve these conflicts before restoring:</p><ul>{preview.conflicts.map((conflict, index) => <li key={index}>{conflict}</li>)}</ul></div>}
      <details open={preview.counts.unresolvedLinks > 0}><summary>Review document and account links</summary>
        <ul className="document-recovery-links">{preview.documents.map(document => <li key={document.id}>
          <strong>{document.originalName}</strong>
          {document.status === 'new' ? <label className="field"><span>Account for {document.originalName}</span><select aria-label={`Account for ${document.originalName}`} value={mappings[document.id] ?? ''} disabled={busy || disabled || stale || Boolean(restoreAttempt)} onChange={event => { if (restoreAttempt) return; setMappings(previous => ({ ...previous, [document.id]: event.target.value })); setConfirmed(false); }}>
            <option value="" disabled>Choose an account or leave unlinked</option><option value="unlinked">Leave unlinked and preserve source details</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>{document.linkReason === 'unresolved' && <small>The original account could not be matched. Choose where this document belongs.</small>}{document.linkReason === 'statement_source' && <small>Matched through a restored financial statement.</small>}</label> : <><span>Account: {document.suggestedAccountId === null ? 'Unlinked' : accounts.find(account => account.id === document.suggestedAccountId)?.name ?? 'Previous account is missing'}</span><span>{document.status === 'repair' ? 'Restore missing original; keep saved details.' : document.status === 'conflict' ? document.conflict : 'Already saved; keep existing original and details.'}</span></>}
        </li>)}</ul>
      </details>
      <label className="mazal-checkbox"><input type="checkbox" checked={confirmed} disabled={busy || disabled || stale || Boolean(restoreAttempt) || unresolved.length > 0 || preview.conflicts.length > 0} onChange={event => setConfirmed(event.target.checked)} /><span>I reviewed the account links. Restore these verified files.</span></label>
      <button type="button" className="button primary" disabled={busy || disabled || !restoreAttempt && (stale || !confirmed || unresolved.length > 0 || preview.conflicts.length > 0)} onClick={event => void restore(event.currentTarget)}>{restoreAttempt ? 'Confirm original restore' : 'Restore original files'}</button>
    </div>}
    <h3>3. Check recovery</h3>
    {health ? <><p>{health.documents} documents, {health.statementSources} statement sources, and {health.sourceReferences ?? 0} other source links checked.</p>
      {health.missingOriginals + health.damagedOriginals + health.missingStatementSources + health.missingAccountLinks + (health.missingSourceReferences ?? 0) === 0 && <p role="status">All saved originals and statement sources passed their hash checks. Every assigned account link exists.</p>}
      {(health.incompleteRecoveries ?? 0) > 0 && <p role="alert">{health.incompleteRecoveries} interrupted recovery stages need review. Mazal kept their files and recovery records.</p>}
      {health.issues.length > 0 && <><p role="status">{health.missingOriginals} missing originals, {health.damagedOriginals} damaged originals, {health.missingStatementSources} missing statement sources, {health.missingSourceReferences ?? 0} missing source links, {health.missingAccountLinks} missing account links, and {health.unlinkedDocuments} unlinked documents.</p><details><summary>Review file and account details</summary><ul>{health.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul></details><p className="muted">General documents, such as credit reports, can stay unlinked. Review saved account links below to assign accounts where needed.</p></>}
    </> : <p role={healthError ? 'alert' : 'status'}>{healthError || 'Checking saved originals and account links…'}</p>}
    <button type="button" className="button secondary" disabled={busy || disabled} onClick={() => setHealthRefresh(value => value + 1)}>Check recovery again</button>
    <RecoveryAccountLinks key={workspace} workspace={workspace} accounts={accounts} disabled={busy || disabled || Boolean(file)} onBusyChange={setBusy} onDirtyChange={setLinkDirty} onSaved={() => setHealthRefresh(value => value + 1)} />
  </section>;
}
