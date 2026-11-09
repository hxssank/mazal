import { transactionLabel } from '../../../shared/transaction-label.ts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AppState, Command, StatementBatch, StatementDecision, StatementSourceRow } from '../../../shared/types.ts';
import { statementTransactionMatcher, previewStatementBatches, statementDateBasisLabel, statementDebit, statementDecisionIssue } from '../../../shared/statement-imports.ts';
import StatementTools from './StatementTools.tsx';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
import {useDraftProtection,requestDraftNavigation} from '../../hooks/draft-protection.ts';
import { money } from '../../../shared/analytics.ts';
import { categoryLimits, suggestExpenseCategory } from '../../../shared/expense-categories.ts';

interface Props { state: AppState; scope: string; readOnly?: boolean; onCommand: (command: Command) => Promise<void> }
interface Editor { batch: StatementBatch; row: StatementSourceRow; kind: StatementDecision['kind'] | ''; category: string; match: string; revision: number; requestId: string }
const date = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { dateStyle: 'medium', timeZone: 'UTC' });

export default function ImportQueue({ state, scope, readOnly = false, onCommand }: Props) {
  const categoryListId = useId();
  const [excluded, setExcluded] = useState<string[]>([]);
  const [opened, setOpened] = useState(()=>new URLSearchParams(window.location.hash.split('?')[1]).get('record')??(()=>{try{return localStorage.getItem(`mazal:statement-review:${state.workspace}`)??'';}catch{return '';}})());
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard,setDiscard]=useState(false);
  const [toolsDirty, setToolsDirty] = useState(false);
  const retainedBatch = useRef<StatementBatch | null>(null);
  const returnEntry = useRef<HTMLButtonElement | null>(null);
  const restoreEntry = useRef(false);
  const guard=useDraftProtection({dirty:!!editor,busy,onRequestDiscard:()=>setDiscard(true)});
  useEffect(() => {
    if (editor || busy) return;
    const target = returnEntry.current;
    returnEntry.current = null;
    const restore = restoreEntry.current;
    restoreEntry.current = false;
    if (restore && target?.isConnected && !target.disabled && !target.closest('[hidden]')) target.focus();
  }, [editor, busy]);
  useEffect(()=>{try{localStorage.setItem(`mazal:statement-review:${state.workspace}`,opened);}catch{/* Review decisions are saved separately in Mazal. */}},[opened,state.workspace]);
  const batches = (state.importBatches ?? []).filter(batch => batch.status === 'staged' && (scope === 'all' || state.accounts.find(account => account.id === batch.source.accountId)?.entityId === scope));
  if (!batches.length && !editor && !toolsDirty) return null;
  const selected = batches.filter(batch => !excluded.includes(batch.id));
  const preview = previewStatementBatches(state, selected.map(batch => batch.id));
  const pendingActive = batches.find(batch => batch.id === opened);
  if (pendingActive) retainedBatch.current = pendingActive;
  const active = pendingActive ?? (toolsDirty ? state.importBatches?.find(batch => batch.id === opened) ?? retainedBatch.current : undefined);
  const rows = active?.source.rows ?? [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 50) - 1));
  const accountName = (id: string) => state.accounts.find(account => account.id === id)?.name ?? 'Unknown account';
  const editorAccount = editor && state.accounts.find(account => account.id === editor.batch.source.accountId);
  const editorChanged = !!editor && editor.revision !== state.revision;
  const latestBatch = editor && batches.find(batch => batch.id === editor.batch.id);
  const latestRow = latestBatch?.source.rows.find(row => row.id === editor?.row.id);
  const latestDecision = latestBatch?.decisions.find(decision => decision.rowId === editor?.row.id);
  const suggestion = editor && ['expense', 'refund', 'interest'].includes(editor.kind) ? suggestExpenseCategory(editor.row.description) : null;
  const categoryOptions = editorAccount ? categoryLimits(state, editorAccount.entityId) : [];
  const matches: { value: string; label: string }[] = [];
  const matchesTransaction = statementTransactionMatcher(state);
  if (editor && editorAccount && editor.kind) {
    if (editor.kind === 'transfer') for (const batch of state.importBatches ?? []) {
      const account = state.accounts.find(item => item.id === batch.source.accountId);
      if (batch.status !== 'staged' || !account || account.id === editorAccount.id) continue;
      for (const row of batch.source.rows) {
        if (statementDebit(account, row.amountCents) + statementDebit(editorAccount, editor.row.amountCents) !== 0 || Math.abs(Date.parse(row.postingDate) - Date.parse(editor.row.postingDate)) > 7 * 86400000) continue;
        matches.push({ value: JSON.stringify({ importId: batch.id, rowId: row.id }), label: `${account.name}: ${date(row.postingDate)}, ${money(row.amountCents)}, ${row.description}` });
      }
    }
    for (const transaction of state.transactions) {
      if (matchesTransaction(editor.batch, editor.row, editor.kind, transaction)) matches.push({ value: JSON.stringify({ transactionId: transaction.id }), label: `${date(transaction.date)}: ${transactionLabel(transaction)}, ${money(transaction.amountCents)}` });
    }
  }
  function edit(batch: StatementBatch, row: StatementSourceRow, trigger: HTMLButtonElement) {
    if (readOnly || busy || editor) return;
    const saved = batch.decisions.find(decision => decision.rowId === row.id);
    requestDraftNavigation(() => {
      returnEntry.current = trigger;
      setEditor({ batch, row, kind: saved?.kind ?? '', category: saved?.category ?? '', match: saved?.match ? JSON.stringify(saved.match) : '', revision: state.revision, requestId: crypto.randomUUID() });
      setError('');
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (readOnly || !editor?.kind || busy || editorChanged) return;
    setBusy(true); setError('');
    const decision: StatementDecision = { rowId: editor.row.id, kind: editor.kind, category: editor.category.trim(), ...(editor.match ? { match: JSON.parse(editor.match) } : {}) };
    try {
      await onCommand({ type: 'review_statement', importId: editor.batch.id, decisions: [...editor.batch.decisions.filter(item => item.rowId !== editor.row.id), decision], requestId: editor.requestId, expectedRevision: editor.revision });
      finishEditing();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the classification.'); }
    finally { setBusy(false); }
  }
  function finishEditing() { restoreEntry.current = true; setEditor(null); }
  function reviewUpdatedEntry() {
    if (!editor || !latestBatch || !latestRow) return;
    setEditor({ ...editor, batch: latestBatch, row: latestRow, revision: state.revision, requestId: crypto.randomUUID() });
    setError('');
  }
  async function commit() {
    if (readOnly || !preview.ready || busy || editor || toolsDirty) return;
    setBusy(true); setError('');
    try { await onCommand({ type: 'commit_statements', importIds: selected.map(batch => batch.id), expectedRevision: state.revision, requestId: crypto.randomUUID() }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not record the statements.'); }
    finally { setBusy(false); }
  }
  return <section className="import-queue" aria-labelledby="import-queue-heading">
    <DraftDiscardDialog open={discard} onDiscard={()=>{setDiscard(false);setEditor(null);guard.discard();}} onKeepEditing={()=>{setDiscard(false);guard.keepEditing();}}/>
    <h2 id="import-queue-heading">{batches.length ? 'Pending statements' : 'Statement review draft'}</h2>
    <p>{batches.length ? 'These entries do not affect balances or spending until recorded.' : 'This statement is no longer pending. Your unsaved review is kept below.'}</p>
    {error && <p role="alert" className="document-message error">{error}</p>}
    <div className="import-batches">{batches.map(batch => <div key={batch.id}><label><input type="checkbox" checked={!excluded.includes(batch.id)} disabled={busy} onChange={event => setExcluded(current => event.target.checked ? current.filter(id => id !== batch.id) : [...current, batch.id])}/><span><strong>{accountName(batch.source.accountId)}</strong><small>{date(batch.source.periodStart)} to {date(batch.source.periodEnd)} · {batch.source.rows.length} entries · {batch.decisions.length} classified</small></span></label><button type="button" className="text-button" disabled={busy} onClick={() => requestDraftNavigation(()=>{ setOpened(active?.id === batch.id ? '' : batch.id); setPage(0); })}>{active?.id === batch.id ? 'Close entries' : 'Review entries'}</button><a className="text-button" href={`/api/source?workspace=${state.workspace}&file=${encodeURIComponent(batch.source.sourceFile)}&sha=${batch.source.sha256}`} target="_blank" rel="noreferrer">Original</a></div>)}</div>
    {active && <div className="import-entries"><h3>{active.source.sourceFile}</h3><StatementTools key={active.id} state={state} batch={active} readOnly={readOnly||!!editor||busy} onCommand={onCommand} onDraftChange={setToolsDirty}/><p>{money(active.source.openingBalanceCents)} opening · {money(active.source.closingBalanceCents)} closing</p>{rows.slice(currentPage * 50, (currentPage + 1) * 50).map(row => {
      const decision = active.decisions.find(item => item.rowId === row.id);
      return <div className="import-entry" key={row.id}><span><strong>{row.description}</strong><small>{date(row.transactionDate)}{row.dateBasis && ` · ${statementDateBasisLabel(row)}`} · Page {row.sourcePage}</small></span><span>{money(row.amountCents)}</span><button type="button" className="text-button" disabled={readOnly || busy || !!editor} onClick={event => edit(active, row, event.currentTarget)}>{decision ? decision.kind === 'transfer' ? 'Transfer' : `${decision.kind}${decision.category ? ` · ${decision.category}` : ''}` : 'Classify'}</button></div>;
    })}{rows.length > 50 && <nav className="ledger-pagination" aria-label="Statement entry pages"><button type="button" className="button secondary compact" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage * 50 + 1} to {Math.min((currentPage + 1) * 50, rows.length)} of {rows.length}</span><button type="button" className="button secondary compact" disabled={(currentPage + 1) * 50 >= rows.length} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}</div>}
    {editor && !readOnly && <form className="import-editor" onSubmit={save}><h3>Classify entry</h3><p className="muted">Save or cancel this classification before editing another entry.</p><p>{editor.row.description} · {money(editor.row.amountCents)}</p><label>Type<select autoFocus value={editor.kind} disabled={busy} onChange={event => setEditor({ ...editor, kind: event.target.value as Editor['kind'], match: '', requestId: crypto.randomUUID() })}><option value="">Choose type</option>{(['expense', 'income', 'refund', 'interest', 'transfer', 'movement'] as const).filter(kind => editorAccount && !statementDecisionIssue(editorAccount, editor.row, { rowId: editor.row.id, kind, category: '' })).map(kind => <option value={kind} key={kind}>{kind === 'transfer' ? 'Transfer or card payment' : kind === 'movement' ? 'Other account movement' : kind[0].toUpperCase() + kind.slice(1)}</option>)}</select></label>{['transfer','expense','income','interest','refund'].includes(editor.kind) && <label>{editor.kind === 'transfer' ? 'Matching entry' : 'Existing recorded entry'}<select value={editor.match} disabled={busy} onChange={event => { const match = event.target.value ? JSON.parse(event.target.value) : null; const transaction = match && 'transactionId' in match ? state.transactions.find(item => item.id === match.transactionId) : undefined; setEditor({ ...editor, match:event.target.value, category:editor.kind !== 'transfer' && transaction ? transaction.category : editor.category, requestId:crypto.randomUUID() }); }}><option value="">{editor.kind === 'transfer' ? 'Choose matching entry' : 'Record a new transaction'}</option>{matches.map(match => <option value={match.value} key={match.value}>{match.label}</option>)}</select></label>}{editor.kind !== 'transfer' && <label>Category<input list={categoryListId} value={editor.category} maxLength={100} disabled={busy || !!editor.match} onChange={event => setEditor({ ...editor, category: event.target.value, requestId: crypto.randomUUID() })}/></label>}{editor.match && editor.kind !== 'transfer' && <p>Links this source row to the existing entry. Its amount, date, description, category, and bill or payday links stay unchanged. No second transaction is recorded.</p>}{editor.kind === 'movement' && <p>Records the balance change without counting it as income or spending. Use it for borrowing, payment reversals, or money whose purpose is unconfirmed.</p>}<datalist id={categoryListId}>{categoryOptions.map(limit => <option key={limit.id} value={limit.name}/>)}</datalist>{suggestion && !editor.match && suggestion.category !== editor.category && <p className="muted">Suggested {suggestion.category}. {suggestion.reason} <button type="button" className="text-button" disabled={busy} onClick={() => setEditor({ ...editor, category: suggestion.category, requestId: crypto.randomUUID() })}>Use {suggestion.category}</button></p>}{editorChanged && <div className="mazal-form-notice" role="status"><p>Records changed while this entry was open. Your classification has been kept.</p>{latestRow ? <><p>Saved classification: {latestDecision ? `${latestDecision.kind}${latestDecision.category ? ` · ${latestDecision.category}` : ''}` : 'Not classified'}. Other saved classifications will be preserved.</p><button type="button" className="button secondary compact" disabled={busy} onClick={reviewUpdatedEntry}>Keep my classification</button></> : <p>This entry is no longer pending. Close this editor to continue.</p>}</div>}<div><button type="button" className="button secondary compact" disabled={busy} onClick={() => guard.requestChange(finishEditing)}>Cancel</button><button className="button primary compact" disabled={busy || editorChanged || !editor.kind || editor.kind === 'transfer' && !editor.match}>Save classification</button></div></form>}
    {preview.issues.length > 0 && <div className="import-issues"><p>{preview.unreviewedCount ? `${preview.unreviewedCount} ${preview.unreviewedCount === 1 ? 'entry needs' : 'entries need'} classification.` : 'Resolve these items before recording:'}</p><ul>{preview.issues.filter(issue => !issue.endsWith('still need a classification.')).slice(0, 5).map(issue => <li key={issue}>{issue}</li>)}</ul>{preview.issues.length > 5 && <p>{preview.issues.length - 5} more items remain.</p>}</div>}
    <button type="button" className="button primary" disabled={readOnly || busy || !!editor || toolsDirty || !preview.ready} onClick={() => void commit()}>{busy ? 'Saving…' : `Record ${selected.length} ${selected.length === 1 ? 'statement' : 'statements'}`}</button>
  </section>;
}
