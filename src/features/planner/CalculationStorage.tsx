import { useEffect, useId, useRef, useState } from 'react';
import type { CalculationStorageUsage } from '../../../shared/engine.ts';
import type { Workspace } from '../../../shared/types.ts';
import './calculation-storage.css';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const bytes = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function storageUsage(value: unknown, workspace: Workspace): CalculationStorageUsage {
  if (!record(value) || value.workspace !== workspace || !bytes(value.runBytes) || !bytes(value.archiveBytes) || !bytes(value.totalBytes) || !bytes(value.unreadableEntryCount) || !bytes(value.unclassifiedBytes) || !record(value.limits) || !bytes(value.limits.runsPerArchive) || !bytes(value.limits.uncompressedBytesPerArchive)
    || !Array.isArray(value.runs) || !value.runs.every(run => record(run) && run.workspace === workspace && identifier(run.id) && typeof run.kind === 'string' && typeof run.asOf === 'string' && typeof run.createdAt === 'string' && bytes(run.revision) && bytes(run.bytes) && typeof run.archivable === 'boolean' && ['running', 'queued', 'completed', 'failed', 'cancelled'].includes(String(run.status)))
    || !Array.isArray(value.archives) || !value.archives.every(archive => record(archive) && archive.workspace === workspace && identifier(archive.id) && typeof archive.createdAt === 'string' && bytes(archive.bytes) && bytes(archive.uncompressedBytes) && bytes(archive.runCount) && bytes(archive.restoredRunCount) && bytes(archive.retainedBytes) && bytes(archive.metadataBytes) && Array.isArray(archive.runIds) && archive.runIds.every(identifier) && typeof archive.sha256 === 'string')) throw new Error('Calculation storage returned incomplete information. Refresh to read it again.');
  return value as unknown as CalculationStorageUsage;
}
function size(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
class StorageTimeoutError extends Error {}
async function request(workspace: Workspace, controller: AbortController, path = '', body?: unknown): Promise<unknown> {
  if (controller.signal.aborted) throw controller.signal.reason;
  let rejectAborted: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new StorageTimeoutError(`Calculation storage ${body === undefined ? 'could not be read' : 'did not confirm the update'} within 125 seconds.`)), 125_000);
  const read = async () => {
    let response: Response;
    try { response = await fetch(`/api/engine/storage${path}?workspace=${workspace}`, { signal: controller.signal, cache: 'no-store', method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); }
    catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw new Error('Calculation storage is unavailable. Check that Mazal is running, then retry.'); }
    if (controller.signal.aborted) throw controller.signal.reason;
    const value: unknown = await response.json().catch(() => null);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) throw new Error(record(value) && typeof value.error === 'string' ? value.error : 'Calculation storage could not complete this request.');
    if (!record(value) || value.workspace !== workspace) throw new Error('Calculation storage returned information from another workspace.');
    return value;
  };
  try { return await Promise.race([read(), aborted]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAborted!); }
}

interface Props {
  workspace: Workspace; disabled?: boolean; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void;
}
export default function CalculationStorage(props: Props) {
  return <WorkspaceCalculationStorage key={props.workspace} {...props}/>;
}
function WorkspaceCalculationStorage({ workspace, disabled = false, onBusyChange, onDirtyChange }: Props) {
  const titleId = useId();
  const [usage, setUsage] = useState<CalculationStorageUsage | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(true);
  const [reconciled, setReconciled] = useState(false);
  const [errorSequence, setErrorSequence] = useState(0);
  const currentUsage = useRef(false);
  const mounted = useRef(false);
  const readRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);
  const region = useRef<HTMLElement>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const restoreOperationFocus = useRef(false);
  const focusError = useRef(false);
  const callbacks = useRef({ onBusyChange, onDirtyChange });
  callbacks.current = { onBusyChange, onDirtyChange };
  useEffect(() => {
    mounted.current = true;
    callbacks.current.onBusyChange?.(false);
    void readStorage(false);
    return () => {
      mounted.current = false;
      readRequest.current?.abort(); readRequest.current = null;
      mutationRequest.current?.abort(); mutationRequest.current = null;
      callbacks.current.onBusyChange?.(false); callbacks.current.onDirtyChange?.(false);
    };
  }, [workspace]);
  useEffect(() => { callbacks.current.onDirtyChange?.(selected.length > 0); }, [selected]);
  useEffect(() => {
    if (!error || busy || !focusError.current) return;
    focusError.current = false;
    const section = region.current;
    const active = document.activeElement;
    const ownsFocus = section?.contains(active) || active === document.body && restoreOperationFocus.current;
    restoreOperationFocus.current = false;
    if (!section || !ownsFocus || section.closest('[hidden], [inert], dialog:not([open]), details:not([open])')) return;
    for (let element: HTMLElement | null = section; element; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
    }
    errorElement.current?.focus();
  }, [error, errorSequence, busy]);

  function trackOperationFocus(button: HTMLButtonElement) {
    restoreOperationFocus.current = document.activeElement === button || Boolean(region.current?.contains(document.activeElement));
    const focusLeftStorage = (event: Event) => {
      if ((event.type === 'pointerdown' || event.target !== document.body) && !region.current?.contains(event.target as Node)) restoreOperationFocus.current = false;
    };
    document.addEventListener('focusin', focusLeftStorage);
    document.addEventListener('pointerdown', focusLeftStorage);
    return () => { document.removeEventListener('focusin', focusLeftStorage); document.removeEventListener('pointerdown', focusLeftStorage); };
  }
  function reportError(message: string, shouldFocus: boolean, append = false) {
    focusError.current = shouldFocus;
    setError(previous => append && previous ? `${previous} ${message}` : message);
    setErrorSequence(value => value + 1);
  }
  async function readStorage(shouldFocus: boolean, stopTrackingFocus?: () => void, keepError = false) {
    if (!mounted.current) { stopTrackingFocus?.(); return; }
    readRequest.current?.abort();
    const controller = new AbortController(); readRequest.current = controller;
    currentUsage.current = false; setReconciled(false); setReading(true);
    if (!keepError) setError('');
    try {
      const value = storageUsage(await request(workspace, controller), workspace);
      if (!mounted.current || readRequest.current !== controller || controller.signal.aborted) return;
      setUsage(value);
      setSelected(previous => previous.filter(id => value.runs.some(run => run.id === id && run.archivable)));
      currentUsage.current = true; setReconciled(true);
    } catch (cause) {
      if (mounted.current && readRequest.current === controller && (!controller.signal.aborted || cause instanceof StorageTimeoutError)) reportError(`${cause instanceof Error ? cause.message : 'Could not read calculation storage.'} Refresh storage to check the latest evidence before another change.`, shouldFocus, keepError);
    } finally {
      stopTrackingFocus?.();
      if (mounted.current && readRequest.current === controller) { readRequest.current = null; setReading(false); }
    }
  }

  async function mutate(path: '/archive' | '/restore', body: unknown, button: HTMLButtonElement): Promise<void> {
    if (busy || disabled || mutationRequest.current || readRequest.current || !currentUsage.current) return;
    const controller = new AbortController(); mutationRequest.current = controller;
    const stopTrackingFocus = trackOperationFocus(button);
    currentUsage.current = false; setReconciled(false);
    setBusy(true); setError(''); setNotice(''); callbacks.current.onBusyChange?.(true);
    try {
      await request(workspace, controller, path, body);
      if (!mounted.current || mutationRequest.current !== controller || controller.signal.aborted) return;
      setNotice(path === '/archive' ? 'Selected calculations were verified and moved into a saved ZIP archive.' : 'Calculations were restored. The ZIP archive remains saved.');
    } catch (cause) {
      if (mounted.current && mutationRequest.current === controller && (!controller.signal.aborted || cause instanceof StorageTimeoutError)) {
        reportError(cause instanceof Error ? cause.message : 'Calculation storage could not confirm the update.', true);
        setNotice('The update may have completed. Mazal will check the current storage before another change. No update will be retried automatically.');
      }
    } finally {
      if (mounted.current && mutationRequest.current === controller) {
        mutationRequest.current = null; setBusy(false); callbacks.current.onBusyChange?.(false);
        void readStorage(true, stopTrackingFocus, true);
      } else stopTrackingFocus();
    }
  }

  const selectedBytes = usage?.runs.filter(run => selected.includes(run.id)).reduce((total, run) => total + run.bytes, 0) ?? 0;
  const overLimit = usage && (selected.length > usage.limits.runsPerArchive || selectedBytes > usage.limits.uncompressedBytesPerArchive);
  return <section ref={region} className="calculation-storage" aria-labelledby={titleId}>
    <div className="calculation-storage-heading"><h3 id={titleId}>Calculation storage</h3><button type="button" className="button secondary compact" disabled={disabled || busy || reading} onClick={event => { if (mutationRequest.current || readRequest.current) return; setNotice(''); void readStorage(true, trackOperationFocus(event.currentTarget)); }}>Refresh storage</button></div>
    <p>Archive finished calculations to reduce their storage. Each ZIP keeps the original inputs, results and status with file checks. Mazal never archives or deletes calculations on a schedule.</p>
    {error && <p ref={errorElement} className="mazal-form-error" role="alert" tabIndex={-1}>{error}</p>}
    {notice && <p className="mazal-form-notice" role="status">{notice}</p>}
    {!usage && !error && <p role="status">Reading calculation storage...</p>}
    {usage && reading && <p role="status">Checking the current calculation storage before another change...</p>}
    {usage && <>
      <p className="calculation-storage-totals"><strong>{size(usage.totalBytes)} saved</strong><span>{size(usage.runBytes)} calculations · {size(usage.archiveBytes)} archives</span></p>
      {usage.unreadableEntryCount > 0 && <p role="alert">Some stored evidence could not be read and is excluded from these totals. Existing files were kept.</p>}
      {usage.unclassifiedBytes > 0 && <p>Another {size(usage.unclassifiedBytes)} of unclassified calculation evidence remains on disk across the workspaces.</p>}
      {usage.runs.length === 0 ? <p>No unpacked calculations in this workspace.</p> : <>
        <div className="calculation-storage-runs" role="group" aria-label="Choose finished calculations to archive">
          {usage.runs.map(run => <label key={run.id} className="calculation-storage-run">
            <input type="checkbox" checked={selected.includes(run.id)} disabled={disabled || busy || !run.archivable} onChange={event => setSelected(current => event.target.checked ? [...current, run.id] : current.filter(id => id !== run.id))} />
            <span><strong>{run.kind === 'comparison' ? 'Funding comparison' : run.kind === 'spending' ? 'Spending analysis' : 'Calculation'}</strong><span>{run.asOf} · Revision {run.revision} · {run.status}</span><small>{run.id}</small></span><span>{size(run.bytes)}</span>
          </label>)}
        </div>
        <p>{selected.length} selected · {size(selectedBytes)}. Up to {usage.limits.runsPerArchive} calculations and {size(usage.limits.uncompressedBytesPerArchive)} per archive.</p>
        <button type="button" className="button secondary" disabled={disabled || busy || !reconciled || selected.length === 0 || Boolean(overLimit)} onClick={event => void mutate('/archive', { runIds: selected }, event.currentTarget)}>{busy ? 'Updating calculation storage...' : `Archive selected calculations${selected.length ? ` (${selected.length})` : ''}`}</button>
      </>}
      {usage.archives.length > 0 && <div className="calculation-storage-archives" role="group" aria-label="Saved calculation archives">
        <h4>Saved archives</h4>
        {usage.archives.map(archive => <div key={archive.id} className="calculation-storage-archive">
          <p><strong>{archive.runCount} {archive.runCount === 1 ? 'calculation' : 'calculations'} · {size(archive.bytes)}</strong><span>{new Date(archive.createdAt).toLocaleString()} · Original size {size(archive.uncompressedBytes)}</span><small>{archive.id}</small></p>
          {archive.retainedBytes > 0 && <p role="alert">An interrupted move retained {size(archive.retainedBytes)} of original files. They are included in storage usage and have not been deleted.</p>}
          <div className="calculation-storage-actions"><a className="button secondary compact" href={`/api/engine/storage/archives/${archive.id}/download?workspace=${workspace}`} download>Download ZIP</a><button type="button" className="button secondary compact" disabled={disabled || busy || !reconciled || archive.restoredRunCount === archive.runCount} onClick={event => void mutate('/restore', { archiveId: archive.id }, event.currentTarget)}>{archive.restoredRunCount === archive.runCount ? 'Already restored' : 'Restore calculations'}</button></div>
        </div>)}
      </div>}
    </>}
  </section>;
}
