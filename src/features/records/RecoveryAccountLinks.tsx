import { useEffect, useRef, useState } from 'react';
import type { Account, Workspace } from '../../../shared/types.ts';
import type { DocumentList, DocumentMetadata } from '../../../shared/documents.ts';

interface Props {
  workspace: Workspace; accounts: Account[]; disabled: boolean;
  onBusyChange: (busy: boolean) => void; onDirtyChange: (dirty: boolean) => void; onSaved: () => void;
}
class AccountLinkTimeoutError extends Error {}
async function linkRequest<T>(url: string, options: RequestInit, controller: AbortController, milliseconds: number, timeoutMessage: string): Promise<T> {
  if (controller.signal.aborted) throw controller.signal.reason;
  let rejectAborted: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new AccountLinkTimeoutError(timeoutMessage)), milliseconds);
  const read = async () => {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (controller.signal.aborted) throw controller.signal.reason;
    const value = await response.json();
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) throw new Error(value.error || 'The document account link request failed.');
    return value as T;
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
function validDocument(value: DocumentMetadata): boolean {
  return Boolean(value && typeof value.id === 'string' && value.id && typeof value.originalName === 'string' && value.originalName && Number.isSafeInteger(value.revision) && value.revision >= 0 && (value.accountId === null || typeof value.accountId === 'string' && value.accountId));
}
export default function RecoveryAccountLinks(props: Props) {
  return <WorkspaceAccountLinks key={props.workspace} {...props}/>;
}
function WorkspaceAccountLinks({ workspace, accounts, disabled, onBusyChange, onDirtyChange, onSaved }: Props) {
  const [documents, setDocuments] = useState<DocumentMetadata[] | null>(null);
  const [selected, setSelected] = useState<DocumentMetadata | null>(null);
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const operationError = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useRef(false);
  const currentDocument = documents?.find(item => item.id === selected?.id);
  const changed = Boolean(selected && accountId && (!currentDocument || accountId !== (currentDocument.accountId ?? 'unlinked')));
  const blocked = disabled || busy;
  const choicesBlocked = blocked || needsReload;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange(changed || needsReload); }, [changed, needsReload, onDirtyChange]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  useEffect(() => {
    if (!error || busy) return;
    const element = region.current;
    const active = document.activeElement;
    const ownsFocus = element?.contains(active) || active === document.body && restoreFocus.current;
    restoreFocus.current = false;
    if (!element || !ownsFocus || element.closest('[hidden], [inert], dialog:not([open]), details:not([open])')) return;
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden') return;
    }
    operationError.current?.focus();
  }, [error, busy]);
  function trackFocus(button: HTMLButtonElement) {
    restoreFocus.current = document.activeElement === button || Boolean(region.current?.contains(document.activeElement));
    const focusLeft = (event: Event) => {
      if ((event.type === 'pointerdown' || event.target !== document.body) && !region.current?.contains(event.target as Node)) restoreFocus.current = false;
    };
    document.addEventListener('focusin', focusLeft);
    document.addEventListener('pointerdown', focusLeft);
    return () => { document.removeEventListener('focusin', focusLeft); document.removeEventListener('pointerdown', focusLeft); };
  }
  function checkRequest(controller: AbortController) {
    if (request.current !== controller || controller.signal.aborted) throw controller.signal.reason ?? new DOMException('The account link request was canceled.', 'AbortError');
  }
  function canReport(controller: AbortController, failure: unknown) {
    return request.current === controller && (!controller.signal.aborted || failure instanceof AccountLinkTimeoutError);
  }
  function finishRequest(controller: AbortController) {
    if (request.current === controller) { request.current = null; setBusy(false); }
  }
  const accountName = (id: string | null) => id === null ? 'Unlinked' : accounts.find(account => account.id === id)?.name ?? 'Previous account is missing';
  async function load(button: HTMLButtonElement) {
    if (blocked || request.current) return;
    const controller = new AbortController(); request.current = controller;
    const stopTrackingFocus = trackFocus(button);
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await linkRequest<DocumentList>(`/api/documents?workspace=${workspace}`, { cache: 'no-store' }, controller, 15_000, 'Loading saved account links timed out after 15 seconds. Try loading them again.');
      checkRequest(controller);
      if (!Array.isArray(value?.documents) || !value.documents.every(validDocument) || new Set(value.documents.map(item => item.id)).size !== value.documents.length) throw new Error('Document links could not be loaded. The saved details returned an invalid response.');
      setDocuments(value.documents); setNeedsReload(false);
      if (selected) {
        const latest = value.documents.find(item => item.id === selected.id);
        if (!latest) setError('The selected document is no longer in saved links. Your account choice is kept. Reload again or discard this link change.');
        else {
          setSelected(latest);
          if ((latest.accountId ?? 'unlinked') === accountId) {
            setNotice('The saved account link matches your choice. No new change was sent.');
            if (needsReload) onSaved();
          } else setNotice('Saved account link reloaded. Review the saved link and your choice before saving.');
        }
      }
    } catch (failure) { if (canReport(controller, failure)) setError(failure instanceof Error ? failure.message : 'Document links could not be loaded.'); }
    finally { stopTrackingFocus(); finishRequest(controller); }
  }
  async function save(button: HTMLButtonElement) {
    if (!currentDocument || !changed || choicesBlocked || request.current) return;
    const controller = new AbortController(); request.current = controller;
    const stopTrackingFocus = trackFocus(button);
    const desiredAccount = accountId === 'unlinked' ? null : accountId;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await linkRequest<{ document: DocumentMetadata }>(`/api/documents/${currentDocument.id}?workspace=${workspace}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: currentDocument.revision, accountId: desiredAccount }),
      }, controller, 60_000, 'Saving the account link timed out after 60 seconds. The link may already be saved. Reload saved links before making another change.');
      checkRequest(controller);
      if (!validDocument(value?.document) || value.document.id !== currentDocument.id || value.document.accountId !== desiredAccount || value.document.revision !== currentDocument.revision + 1) throw new Error('The account link returned an invalid save confirmation.');
      setDocuments(previous => previous!.map(item => item.id === currentDocument.id ? value.document : item));
      setSelected(value.document); setNeedsReload(false);
      setNotice('Account link saved. The original file is unchanged.'); onSaved();
    } catch (failure) {
      if (canReport(controller, failure)) {
        setNeedsReload(true);
        setError(failure instanceof AccountLinkTimeoutError ? failure.message : `${failure instanceof Error ? failure.message : 'The account link could not be confirmed.'} The link may already be saved. Reload saved links before making another change.`);
      }
    } finally { stopTrackingFocus(); finishRequest(controller); }
  }
  function discard() {
    if (choicesBlocked || request.current) return;
    if (currentDocument) setAccountId(currentDocument.accountId ?? 'unlinked');
    else { setSelected(null); setAccountId(''); }
    setError(''); setNotice('');
  }
  return <div ref={region} className="recovery-account-links">
    <button type="button" className="button secondary" disabled={blocked} onClick={event => void load(event.currentTarget)}>{documents ? 'Reload saved links' : 'Review saved account links'}</button>
    {error && <p ref={operationError} role="alert" tabIndex={-1}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {documents && <>
      {documents.length === 0 && !selected ? <p>No documents to link yet.</p> : <label className="field"><span>Saved document</span><select aria-label="Saved document" value={selected?.id ?? ''} disabled={choicesBlocked || changed} onChange={event => {
        if (choicesBlocked || request.current) return;
        const item = documents.find(document => document.id === event.target.value);
        setSelected(item ?? null); setAccountId(item?.accountId ?? 'unlinked'); setError(''); setNotice('');
      }}><option value="">Choose a document</option>{selected && !currentDocument && <option value={selected.id} disabled>{selected.originalName} (no longer saved)</option>}{documents.map(item => <option key={item.id} value={item.id}>{item.originalName}</option>)}</select></label>}
      {selected && <>{currentDocument && <><a href={`/api/documents/${currentDocument.id}/content?workspace=${workspace}`} target="_blank" rel="noreferrer">Open original file</a><p className="muted">Saved account link: {accountName(currentDocument.accountId)}.</p></>}<label className="field"><span>Saved account link</span><select aria-label="Saved account link" value={accountId} disabled={choicesBlocked || !currentDocument} onChange={event => { if (choicesBlocked || request.current) return; setAccountId(event.target.value); setNotice(''); }}>
        {accountId !== 'unlinked' && !accounts.some(account => account.id === accountId) && <option value={accountId} disabled>Selected account is missing</option>}
        <option value="unlinked">Leave unlinked</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select></label><div className="document-recovery-actions"><button type="button" className="button secondary" disabled={choicesBlocked || !currentDocument || !changed} onClick={event => void save(event.currentTarget)}>Save account link</button>{changed && <button type="button" className="text-button" disabled={choicesBlocked} onClick={discard}>Discard link change</button>}</div></>}
    </>}
  </div>;
}
