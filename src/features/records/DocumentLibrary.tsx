import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AppState, Command } from '../../../shared/types.ts';
import type { DocumentList } from '../../../shared/documents.ts';
import ReviewPast from '../expenses/ReviewPast.tsx';
import ImportQueue from './ImportQueue.tsx';
import BankReview from './BankReview.tsx';
import Icon from '../../components/Icon.tsx';
import AnimatedValue from '../../components/AnimatedValue.tsx';
import './document-library.css';
import './records-workspace.css';

interface Props { state: AppState; scope: string; readOnly?: boolean; initialSection?: 'imports' | 'files'; onSectionChange?: (section?: 'imports' | 'files') => void; onTransactions?: () => void; onImportStatement?: () => void; onCommand: (command: Command) => Promise<void> }
interface WorkbookStatus { available: boolean; fileName: string; lastUpdatedAt: string | null; revision?: number; stale?: boolean; modified?: boolean }
const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

async function result<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : `The request failed (${response.status}).`;
    throw new Error(error);
  }
  if (!body) throw new Error('The server returned an unreadable response.');
  return body as T;
}

class RequestTimeoutError extends Error {}

async function requestResult<T>(url: string, request: AbortController, timeoutMs: number, timeoutMessage: string, options: RequestInit = {}): Promise<T> {
  if (request.signal.aborted) throw request.signal.reason;
  let rejectAborted: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(request.signal.reason);
    request.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const timer = setTimeout(() => request.abort(new RequestTimeoutError(timeoutMessage)), timeoutMs);
  const read = async () => {
    const response = await fetch(url, { ...options, signal: request.signal, cache: 'no-store' });
    if (request.signal.aborted) throw request.signal.reason;
    const value = await result<T>(response);
    if (request.signal.aborted) throw request.signal.reason;
    return value;
  };
  try {
    const value = await Promise.race([read(), aborted]);
    if (request.signal.aborted) throw request.signal.reason;
    return value;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', rejectAborted!);
  }
}

async function readResult<T>(url: string, request: AbortController, timeoutMessage: string): Promise<T> {
  return requestResult<T>(url, request, 15_000, timeoutMessage);
}

export default function DocumentLibrary(props: Props) {
  return <WorkspaceDocuments key={props.state.workspace} {...props}/>;
}

function WorkspaceDocuments({ state, scope, readOnly = false, initialSection, onSectionChange, onTransactions, onImportStatement, onCommand }: Props) {
  const id = useId();
  const [section, setSection] = useState<'transactions' | 'imports' | 'files'>(() => initialSection ?? (window.location.hash.split('?')[0] === '#documents/imports' ? 'imports' : window.location.hash.split('?')[0] === '#documents/files' ? 'files' : 'transactions'));
  const navigation = useRef<HTMLDivElement>(null);
  const focusSection = useRef(false);
  useEffect(()=>{if(onSectionChange){const next=initialSection??'transactions';if(next!==section){focusSection.current=true;setSection(next);}}},[initialSection,onSectionChange]);
  useEffect(()=>{if(focusSection.current){focusSection.current=false;navigation.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();}},[section]);
  function chooseSection(value: 'transactions' | 'imports' | 'files') { if(onSectionChange)onSectionChange(value==='transactions'?undefined:value);else setSection(value); }
  useEffect(() => {
    const open = () => { if (window.location.hash.split('?')[0] === '#documents/imports') { if(onSectionChange)onSectionChange('imports');else setSection('imports'); } };
    const hashChanged = () => { if(!onSectionChange)open(); };
    window.addEventListener('hashchange', hashChanged);
    window.addEventListener('mazal:open-import-review', open);
    return () => { window.removeEventListener('hashchange', hashChanged); window.removeEventListener('mazal:open-import-review', open); };
  }, [onSectionChange]);
  const [library, setLibrary] = useState<DocumentList | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const readRequest = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    readRequest.current?.abort();
    const request = new AbortController();
    readRequest.current = request;
    setLibraryError('');
    try {
      const value = await readResult<DocumentList>(`/api/documents?workspace=${state.workspace}`, request, 'Reading saved statement files timed out after 15 seconds. Retry to check the latest originals.');
      if (readRequest.current === request && !request.signal.aborted) setLibrary(value);
    } catch (failure) {
      if (readRequest.current === request && (!request.signal.aborted || failure instanceof RequestTimeoutError)) setLibraryError(failure instanceof RequestTimeoutError ? failure.message : 'Could not load saved statement files. Retry to check the latest originals.');
    }
  }, [state.workspace]);
  useEffect(() => {
    void refresh();
    return () => { readRequest.current?.abort(); readRequest.current = null; };
  }, [refresh, state.revision]);
  useEffect(() => {
    const check = () => { void refresh(); };
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const knownFiles = new Set([...(state.statements ?? []).map(statement => statement.sha256), ...(state.importBatches ?? []).map(batch => batch.source.sha256)]);
  const waitingStatements = (library?.documents ?? []).filter(document => document.kind === 'statement' && !knownFiles.has(document.sha256) && (scope === 'all' || !document.accountId || accounts.get(document.accountId)?.entityId === scope))
    .sort((a, b) => (b.periodEnd ?? b.documentDate ?? b.createdAt).localeCompare(a.periodEnd ?? a.documentDate ?? a.createdAt));
  const stagedSources = (state.importBatches ?? []).filter(batch => batch.status === 'staged' && (scope === 'all' || accounts.get(batch.source.accountId)?.entityId === scope))
    .map(batch => batch.source).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.accountId.localeCompare(b.accountId));
  const pendingCount = stagedSources.length;
  const recordedSources = [...new Map([...(state.statements ?? []), ...(state.importBatches ?? []).filter(batch => batch.status === 'committed').map(batch => batch.source)]
    .filter(source => scope === 'all' || accounts.get(source.accountId)?.entityId === scope)
    .map(source => [JSON.stringify([source.accountId, source.sha256]), source])).values()]
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.accountId.localeCompare(b.accountId));
  const recordedAccountCount = new Set(recordedSources.map(source => source.accountId)).size;
  const pendingEntryCount = stagedSources.reduce((total, source) => total + source.rows.length, 0);
  function openImports() {
    chooseSection('imports');
    document.getElementById(`${id}-imports-button`)?.focus();
  }

  return <div className="document-page records-workspace">
    <header className="records-overview-heading" data-motion-enter>
      <div><span className="records-eyebrow">Imports and source files</span><h2>Review your statements</h2><p>{pendingCount > 0 ? `${pendingCount} ${pendingCount === 1 ? 'statement needs' : 'statements need'} review before the entries are recorded.` : recordedSources.length ? `Latest statement ends ${dateLabel(recordedSources[0].periodEnd)}.` : 'Add a bank or card statement to start your transaction history.'}</p></div>
      <div className="records-heading-actions">
        {pendingCount > 0 && section !== 'imports' && <button type="button" className="button primary" onClick={openImports}>Review statements<Icon name="arrow" size={15}/></button>}
        {onImportStatement && <button type="button" className={`button ${pendingCount > 0 && section !== 'imports' ? 'secondary' : 'primary'}`} disabled={readOnly} onClick={onImportStatement}><Icon name="plus" size={16}/>Add statement</button>}
      </div>
    </header>
    <div className="records-overview" role="group" aria-label="Record review overview" data-motion-enter>
      <button type="button" className={`records-overview-card records-import-card${pendingCount ? ' has-pending' : ''}`} onClick={openImports} aria-label={`Open import review, ${pendingCount} pending ${pendingCount === 1 ? 'statement' : 'statements'}`}>
        <span className="records-card-label"><Icon name="clock" size={17}/>Waiting for review<Icon name="arrow" size={15}/></span>
        <strong className="records-card-number"><AnimatedValue value={pendingCount} format={String}/><small>{pendingCount === 1 ? 'statement' : 'statements'}</small></strong>
        <span className="records-card-detail">{pendingCount ? `${pendingEntryCount} extracted ${pendingEntryCount === 1 ? 'entry' : 'entries'}. Check categories and transfers.` : 'No pending imports. Add a statement when it arrives.'}</span>
        <span className="records-card-action">{pendingCount ? 'Review entries' : 'Open import review'}<Icon name="arrow" size={14}/></span>
      </button>
      <button type="button" className="records-overview-card records-archive-card" onClick={() => chooseSection('transactions')} aria-label={`Browse ${recordedSources.length} recorded ${recordedSources.length === 1 ? 'source' : 'sources'}`}>
        <span className="records-card-label"><Icon name="check" size={17}/>Recorded sources<Icon name="arrow" size={15}/></span>
        <strong className="records-card-number"><AnimatedValue value={recordedSources.length} format={String}/><small>{recordedSources.length === 1 ? 'source' : 'sources'}</small></strong>
        <span className="records-card-detail">{recordedAccountCount ? `${recordedAccountCount} ${recordedAccountCount === 1 ? 'account' : 'accounts'}. Search by date, merchant or amount.` : 'Your statement history will appear here.'}</span>
        <span className="records-card-action">Browse transactions<Icon name="arrow" size={14}/></span>
      </button>
      <button type="button" className="records-overview-card records-files-card" onClick={() => chooseSection('files')} aria-label="Browse source files and originals">
        <span className="records-card-label"><Icon name="grid" size={17}/>Files to import<Icon name="arrow" size={15}/></span>
        <strong className={`records-card-number${!library || libraryError ? ' is-status' : ''}`}><AnimatedValue value={library && !libraryError ? waitingStatements.length : null} format={String} fallback={libraryError ? 'Check files' : 'Loading'}/>{library && !libraryError && <small>{waitingStatements.length === 1 ? 'original' : 'originals'}</small>}</strong>
        <span className="records-card-detail">{libraryError ? 'The file list needs a retry. Open Source files.' : !library ? 'Reading the saved document library.' : waitingStatements.length ? 'Saved originals whose entries have not been imported.' : 'Originals and Excel are available in Source files.'}</span>
        <span className="records-card-action">Browse originals<Icon name="arrow" size={14}/></span>
      </button>
    </div>
    {libraryError && section !== 'files' && <div className="records-file-warning" role="alert"><Icon name="info" size={17}/><span>Saved files could not be checked.</span><button type="button" className="text-button" onClick={() => chooseSection('files')}>Check source files<Icon name="arrow" size={14}/></button></div>}
    <div ref={navigation} className="document-navigation" role="group" aria-label="Statements sections">
      <button type="button" id={`${id}-transactions-button`} aria-pressed={section === 'transactions'} aria-controls={`${id}-transactions`} onClick={() => chooseSection('transactions')}>Statement archive</button>
      <button type="button" id={`${id}-imports-button`} aria-pressed={section === 'imports'} aria-controls={`${id}-imports`} onClick={() => chooseSection('imports')}>Import review{pendingCount > 0 && <span>{pendingCount}</span>}</button>
      <button type="button" id={`${id}-files-button`} aria-pressed={section === 'files'} aria-controls={`${id}-files`} onClick={() => chooseSection('files')}>Source files{waitingStatements.length > 0 && <span>{waitingStatements.length} waiting</span>}</button>
    </div>
    <div className="document-section" id={`${id}-transactions`} role="region" aria-labelledby={`${id}-transactions-button`} hidden={section !== 'transactions'}>
      <ReviewPast state={state} scope={scope} onTransactions={onTransactions} onImport={pendingCount > 0 ? openImports : undefined}/>
      {recordedSources.length > 0 && <details className="document-account-history" data-motion-enter><summary>Account balance history<span>Review monthly cash movement and gaps between sources</span></summary><BankReview state={state} scope={scope}/></details>}
    </div>
    <div className="document-section" id={`${id}-imports`} role="region" aria-labelledby={`${id}-imports-button`} hidden={section !== 'imports'}>
      {pendingCount > 0 ? <><div className="document-import-heading"><p>Review classifications and matched transfers before recording these statements.</p>{onImportStatement && <button type="button" className="button secondary compact" disabled={readOnly} onClick={onImportStatement}>Import another statement</button>}</div></> : <section className="document-section-empty"><h2>No statements waiting for review</h2><p>Import a bank or card statement, then review its entries here before adding them to your records.</p>{onImportStatement && <button type="button" className="button primary compact" disabled={readOnly} onClick={onImportStatement}>Import statement</button>}{waitingStatements.length > 0 && <button type="button" className="text-button" onClick={() => chooseSection('files')}>View {waitingStatements.length} saved statement {waitingStatements.length === 1 ? 'file' : 'files'} →</button>}</section>}
      <ImportQueue state={state} scope={scope} readOnly={readOnly} onCommand={onCommand}/>
    </div>
    <div className="document-section" id={`${id}-files`} role="region" aria-labelledby={`${id}-files-button`} hidden={section !== 'files'}>
    {waitingStatements.length > 0 && <section className="statement-files" aria-labelledby={`${id}-statement-files-heading`}>
      <header><h2 id={`${id}-statement-files-heading`}>Saved files without an import</h2><p>These originals are saved. Import their entries, then review them before recording transactions.</p>{onImportStatement && <button type="button" className="button secondary compact" disabled={readOnly} onClick={onImportStatement}>Import statement entries</button>}</header>
      <ul>{waitingStatements.map(document => <li key={document.id}>
        <div><strong>{accounts.get(document.accountId ?? '')?.name ?? 'Account not assigned'}</strong><span>{document.periodStart && document.periodEnd ? `${dateLabel(document.periodStart)} to ${dateLabel(document.periodEnd)}` : document.documentDate ? dateLabel(document.documentDate) : 'Statement dates not recorded'}</span><small>{document.originalName}</small></div>
        <a className="button secondary compact" href={`/api/documents/${document.id}/content?workspace=${state.workspace}`} target="_blank" rel="noreferrer" aria-label={`Open original ${document.originalName}`}>Open statement</a>
      </li>)}</ul>
    </section>}
    {stagedSources.length > 0 && <section className="statement-files statement-staged-files" aria-labelledby={`${id}-staged-files-heading`}><header><h2 id={`${id}-staged-files-heading`}>Waiting for entry review</h2><p>{stagedSources.length} {stagedSources.length === 1 ? 'statement has' : 'statements have'} saved originals and extracted entries. Review classifications and transfers before they change your records.</p><button type="button" className="button secondary compact" onClick={openImports}>Review pending statements</button></header><ul>{stagedSources.map(source => <li key={source.id}><div><strong>{accounts.get(source.accountId)?.name ?? 'Statement account'}</strong><span>{dateLabel(source.periodStart)} to {dateLabel(source.periodEnd)}</span><small>{source.sourceFile}</small></div><a className="button secondary compact" target="_blank" rel="noreferrer" aria-label={`Open original ${source.sourceFile}`} href={`/api/source?file=${encodeURIComponent(source.sourceFile)}&sha=${source.sha256}&workspace=${state.workspace}`}>Open original</a></li>)}</ul></section>}
    {recordedSources.length > 0 && <section className="statement-files statement-recorded-files" aria-labelledby={`${id}-recorded-files-heading`}><header><h2 id={`${id}-recorded-files-heading`}>Recorded source files</h2><p>{recordedSources.length} original {recordedSources.length === 1 ? 'file' : 'files'} behind the statement archive.</p></header><ul>{recordedSources.map(source => <li key={JSON.stringify([source.accountId, source.sha256])}><div><strong>{accounts.get(source.accountId)?.name ?? 'Statement account'}</strong><span>{dateLabel(source.periodStart)} to {dateLabel(source.periodEnd)}</span><small>{source.sourceFile}</small></div><a className="button secondary compact" target="_blank" rel="noreferrer" aria-label={`Open original ${source.sourceFile}`} href={`/api/source?file=${encodeURIComponent(source.sourceFile)}&sha=${source.sha256}&workspace=${state.workspace}`}>Open original</a></li>)}</ul></section>}
    {waitingStatements.length === 0 && stagedSources.length === 0 && recordedSources.length === 0 && !libraryError && <section className="document-section-empty"><h2>{library ? 'No saved statement files' : 'Loading saved files'}</h2><p>{library ? 'Imported bank and card statements will appear here with a link to the original file.' : 'Checking the local document library.'}</p>{onImportStatement && <button type="button" className="button primary compact" disabled={readOnly} onClick={onImportStatement}>Import statement</button>}</section>}
    {libraryError && <div role="alert" className="document-message error">{libraryError}{library && <p>The last loaded file list is still shown.</p>}<button type="button" className="text-button" onClick={() => void refresh()}>Retry file list</button></div>}
    <WorkbookActions state={state} readOnly={readOnly}/>
    </div>
  </div>;
}

function WorkbookActions({ state, readOnly }: { state: AppState; readOnly: boolean }) {
  const [workbook, setWorkbook] = useState<WorkbookStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [checking, setChecking] = useState(true);
  const [statusRetry, setStatusRetry] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const requestVersion = useRef(0);
  const exportRequest = useRef<AbortController | null>(null);
  const workbookRegion = useRef<HTMLDetailsElement>(null);
  const updateError = useRef<HTMLParagraphElement>(null);
  const restoreUpdateFocus = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; exportRequest.current?.abort(); exportRequest.current = null; }; }, []);
  useEffect(() => {
    if (!error) return;
    const region = workbookRegion.current;
    const active = document.activeElement;
    if (region?.open && !region.closest('[hidden]') && (region.contains(active) || (active === document.body && restoreUpdateFocus.current))) updateError.current?.focus();
    restoreUpdateFocus.current = false;
  }, [error]);
  useEffect(() => {
    const request = new AbortController();
    const version = ++requestVersion.current;
    setChecking(true);
    void readResult<WorkbookStatus>(`/api/master-workbook/status?workspace=${state.workspace}`, request, 'Checking the saved workbook timed out after 15 seconds.')
      .then(status => { if (!request.signal.aborted && version === requestVersion.current) { setWorkbook(status); setUnavailable(false); } })
      .catch(failure => {
        if (mounted.current && version === requestVersion.current && (!request.signal.aborted || failure instanceof RequestTimeoutError)) {
          setUnavailable(true);
          setStatusError(failure instanceof RequestTimeoutError ? failure.message : 'Could not check the saved workbook.');
        }
      })
      .finally(() => { if (mounted.current && version === requestVersion.current && (!request.signal.aborted || request.signal.reason instanceof RequestTimeoutError)) setChecking(false); });
    return () => request.abort();
  }, [state.workspace, state.revision, statusRetry]);
  function recheckWorkbook() {
    requestVersion.current++;
    setChecking(true);
    setStatusRetry(value => value + 1);
  }
  async function updateWorkbook(button: HTMLButtonElement) {
    if (readOnly || state.workspace !== 'live' || exporting || exportRequest.current || checking || !workbook || unavailable || workbook.modified) return;
    const request = new AbortController();
    exportRequest.current = request;
    restoreUpdateFocus.current = document.activeElement === button;
    const focusLeftWorkbook = (event: Event) => {
      if ((event.type === 'pointerdown' || event.target !== document.body) && !workbookRegion.current?.contains(event.target as Node)) restoreUpdateFocus.current = false;
    };
    document.addEventListener('focusin', focusLeftWorkbook);
    document.addEventListener('pointerdown', focusLeftWorkbook);
    const version = ++requestVersion.current;
    setExporting(true); setError(''); setNotice('');
    try {
      const status = await requestResult<WorkbookStatus>(`/api/master-workbook/refresh?workspace=${state.workspace}`, request, 180_000, 'Updating Excel timed out after 3 minutes.', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: state.revision }) });
      if (mounted.current && exportRequest.current === request && !request.signal.aborted) {
        if (version === requestVersion.current) { setWorkbook(status); setUnavailable(false); }
        else recheckWorkbook();
        setNotice('Excel updated from your saved records.');
      }
    } catch (failure) {
      if (mounted.current && exportRequest.current === request && (!request.signal.aborted || failure instanceof RequestTimeoutError)) {
        setError(`${failure instanceof Error ? failure.message : 'Could not confirm the Excel update.'} The update may still finish. Check the saved workbook status before updating again.`);
        recheckWorkbook();
      }
    } finally {
      document.removeEventListener('focusin', focusLeftWorkbook);
      document.removeEventListener('pointerdown', focusLeftWorkbook);
      if (mounted.current && exportRequest.current === request) { exportRequest.current = null; setExporting(false); }
    }
  }
  return <details ref={workbookRegion} className="document-workbook">
    <summary>Master Excel</summary>
    <div className="document-workbook-body">
      {unavailable ? <p>{statusError} <button type="button" className="text-button" disabled={checking} onClick={() => setStatusRetry(value => value + 1)}>{checking ? 'Checking Excel…' : 'Retry workbook check'}</button></p> : workbook?.available ? <>
        {workbook.lastUpdatedAt && <p>Updated {new Date(workbook.lastUpdatedAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}</p>}
        {workbook.stale && <p>New records are available for Excel.</p>}
        {workbook.modified && <p>Excel contains local edits. Review those changes before updating it.</p>}
      </> : <p>{readOnly ? 'Open Mazal.app to view or update master Excel.' : workbook ? state.workspace === 'live' ? 'No Excel export yet.' : 'Your Excel workbook is in the live workspace.' : 'Checking Excel…'}</p>}
      <div className="document-workbook-actions">
        {workbook?.available && <a className="button secondary compact" href={`/api/master-workbook?workspace=${state.workspace}`}>Download Excel</a>}
        {state.workspace === 'live' && <button type="button" className="button secondary compact" disabled={readOnly || exporting || checking || !workbook || unavailable || workbook.modified} onClick={event => void updateWorkbook(event.currentTarget)}>{exporting ? 'Updating Excel…' : 'Update Excel'}</button>}
      </div>
      {error && <p ref={updateError} role="alert" tabIndex={-1} className="document-message error">{error}</p>}
      {notice && <p role="status" className="document-message">{notice}</p>}
    </div>
  </details>;
}
