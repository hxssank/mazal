import { transactionLabel } from '../../../shared/transaction-label.ts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppState, Command } from '../../../shared/types.ts';
import type { PayrollImport, PayrollPaystub } from '../../../shared/payroll.ts';
import { payrollCurrentLinks, payrollIssueReview } from '../../../shared/payroll.ts';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';

type Save = (command: Command) => Promise<void>;
interface Props { state: AppState; batch: PayrollImport; issueId?: string; paystub?: PayrollPaystub; onCommand?: Save }
const money = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);

export default function PayrollReview({ state, batch, issueId, paystub, onCommand }: Props) {
  const [note, setNote] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [discard, setDiscard] = useState(false);
  const [attempt, setAttempt] = useState<Command | null>(null);
  const protection = useDraftProtection({ dirty: !!note.trim() || !!transactionId || !!attempt, busy, onRequestDiscard: () => setDiscard(true) });
  const lock = useRef(false);
  const { changed, review, prepare, resetRequest } = useCommandDraft(state.revision);
  useEffect(() => { if (!busy && !note && !transactionId && !attempt) review(); }, [busy, note, transactionId, attempt, review]);
  const issue = issueId ? payrollIssueReview(batch, issueId) : undefined;
  const links = payrollCurrentLinks(state.payrollImports ?? []);
  const linked = paystub ? links.find(link => link.paystubId === paystub.id) : undefined;
  const reversed = new Set(state.transactions.flatMap(transaction => transaction.reversalOf ? [transaction.reversalOf] : []));
  const cash = new Set(state.accounts.filter(account => account.type === 'cash' && state.entities.some(entity => entity.id === account.entityId && entity.kind === 'personal')).map(account => account.id));
  const used = new Set(links.map(link => link.transactionId));
  const candidates = paystub ? state.transactions.filter(transaction => transaction.kind === 'income' && transaction.amountCents > 0 && transaction.amountCents === paystub.netCents && cash.has(transaction.accountId) && !reversed.has(transaction.id) && !transaction.reversalOf && !used.has(transaction.id)).sort((left, right) => right.date.localeCompare(left.date)) : [];
  const history = issueId ? (batch.issueReviews ?? []).filter(item => item.issueId === issueId) : (batch.bankLinks ?? []).filter(item => item.paystubId === paystub?.id);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!onCommand || lock.current) return;
    setError(''); setMessage('');
    if (changed) { setError('Review the updated records before saving this decision.'); return; }
    let command = attempt;
    if (!command) {
      if (!note.trim()) { setError('Add a note explaining what you checked.'); return; }
      if (issueId) command = { type: 'review_payroll_issue', importId: batch.id, issueId, status: issue?.status === 'resolved' ? 'open' : 'resolved', note, requestId: '' };
      else if (paystub && linked) command = { type: 'unlink_payroll_deposit', importId: batch.id, paystubId: paystub.id, note, requestId: '' };
      else if (paystub && candidates.some(item => item.id === transactionId)) command = { type: 'link_payroll_deposit', importId: batch.id, paystubId: paystub.id, transactionId, note, requestId: '' };
      else { setError('Choose the recorded deposit you checked against the original paystub.'); return; }
    }
    lock.current = true; setBusy(true);
    try { const prepared = prepare(command); setAttempt(prepared); await onCommand(prepared); setNote(''); setTransactionId(''); setAttempt(null); resetRequest(); setMessage('Review saved. Bank records are unchanged.'); }
    catch (failure) { if (isConfirmedCommandRejection(failure)) { setAttempt(null); resetRequest(); } setError(failure instanceof Error ? failure.message : 'The review could not be confirmed. Your note has been kept.'); }
    finally { lock.current = false; setBusy(false); }
  }

  if (!onCommand && !history.length && !issueId) return null;
  return <section className="payroll-review-control" aria-label={issueId ? 'Issue decision' : 'Confirm bank deposit'}>
    <DraftDiscardDialog open={discard} uncertain={!!attempt} onDiscard={() => { setDiscard(false); setAttempt(null); resetRequest(); setNote(''); setTransactionId(''); protection.discard(); }} onKeepEditing={() => { setDiscard(false); protection.keepEditing(); }}/>
    {issueId && <p><strong>{issue?.status === 'resolved' ? 'Resolved' : 'Open for review'}</strong>{issue && ` · ${new Date(issue.reviewedAt).toLocaleString('en-CA')}`}</p>}
    {onCommand && <form onSubmit={save}>
      {!attempt && !issueId && !linked && <><h3>Confirm an existing bank deposit</h3><p>Choose the exact net amount from your personal cash records. Check its date and employer against the original. A missing match does not establish unpaid wages.</p><label>Recorded deposit<select value={transactionId} onChange={event => setTransactionId(event.target.value)} disabled={busy}><option value="">Choose a deposit</option>{candidates.map(transaction => <option key={transaction.id} value={transaction.id}>{transaction.date} · {state.accounts.find(account => account.id === transaction.accountId)?.name} · {money(transaction.amountCents)} · {transactionLabel(transaction)}</option>)}</select></label>{!candidates.length && <p>No unused cash income entry has this net amount. Record or import the bank evidence first.</p>}</>}
      {!attempt && !issueId && linked && <p>This deposit is confirmed. Unlink it to review a different bank entry.</p>}
      <label>{attempt ? 'Original review note' : linked ? 'Reason for removing this link' : 'Review note'}<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={2000} rows={2} required disabled={busy || !!attempt}/></label>
      {attempt && !busy && <p role="status">The review may already be saved. Retry to confirm the same decision and note.</p>}
      {changed && <p role="status">Records changed while this review was open. <button type="button" onClick={() => { review(!!attempt); setError(''); }} disabled={busy}>I reviewed the updated records</button></p>}
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <button className="button secondary compact" disabled={busy || changed || !attempt && !issueId && !linked && !candidates.length}>{busy ? 'Saving…' : attempt ? 'Confirm original review' : issueId ? issue?.status === 'resolved' ? 'Reopen issue' : 'Resolve with note' : linked ? 'Unlink deposit' : 'Confirm deposit link'}</button>
    </form>}
    {history.length > 0 && <details><summary>Review history ({history.length})</summary><ol>{[...history].reverse().map(item => <li key={item.id}><strong>{'status' in item ? item.status === 'resolved' ? 'Resolved' : 'Reopened' : item.transactionId ? 'Deposit confirmed' : 'Deposit unlinked'}</strong> · {new Date(item.reviewedAt).toLocaleString('en-CA')}<p>{item.note}</p></li>)}</ol></details>}
  </section>;
}
