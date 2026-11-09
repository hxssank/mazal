import { transactionLabel } from '../../../shared/transaction-label.ts';
import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import { useId, useRef, useState } from 'react';
import type { AppState, Command, ExpensePlanItem } from '../../../shared/types.ts';
import type { ExpensePlanRow } from '../../../shared/expense-plan.ts';
import { parseExpensePlanAmount } from '../../../shared/expense-plan.ts';
import { money } from '../../../shared/analytics.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';

interface Props {
  state: AppState;
  row: ExpensePlanRow;
  readOnly: boolean;
  onCommand: (command: Command) => Promise<void>;
}
interface Draft { id: string; name: string; amount: string; date: string; notes: string; obligationId: string; transactionId: string; separatePaymentConfirmed: boolean; expected: ExpensePlanItem | null }
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });

export default function ExpensePlanDetails({ state, row, readOnly, onCommand }: Props) {
  const id = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [discard, setDiscard] = useState(false);
  const initialDraft = useRef<Draft | null>(null);
  const [attempt, setAttempt] = useState<Extract<Command, { type: 'save_expense_plan_item' }> | null>(null);
  const protection = useDraftProtection({ dirty: !!draft && JSON.stringify(draft) !== JSON.stringify(initialDraft.current) || !!attempt, busy: pending, onRequestDiscard: () => setDiscard(true) });
  const requests = useRef(new Map<string, string>());
  const items = (state.expensePlanItems ?? []).filter(item => item.entityId === row.limit.entityId && item.categoryId === row.limit.id).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.name.localeCompare(b.name));
  const food = row.key === 'food';
  const personal = row.key === 'personal';
  const trips = row.key === 'trips';
  const example = trips ? 'Montreal weekend' : food ? 'Weekly groceries' : personal ? 'Haircut' : row.key === 'sidequests' ? 'Weekend project' : 'Planned purchase';
  const bills = state.obligations.filter(item => item.entityId === row.limit.entityId && item.direction === 'out' && item.status !== 'cancelled');
  const accountIds = new Set(state.accounts.filter(account => account.entityId === row.limit.entityId).map(account => account.id));
  const expenses = state.transactions.filter(item => accountIds.has(item.accountId) && item.kind === 'expense' && item.amountCents > 0 && !item.reversalOf).sort((a, b) => b.date.localeCompare(a.date));

  function requestId(payload: unknown) {
    const key = JSON.stringify(payload);
    if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID());
    return requests.current.get(key)!;
  }

  function edit(item?: ExpensePlanItem, name = '') {
    protection.requestChange(() => {
      const next = item ? { id: item.id, name: item.name, amount: item.amountCents === null ? '' : (item.amountCents / 100).toFixed(2), date: item.date, notes: item.notes, obligationId: item.obligationId ?? '', transactionId: item.transactionId ?? '', separatePaymentConfirmed: item.separatePaymentConfirmed ?? false, expected: structuredClone(item) } : { id: crypto.randomUUID(), name, amount: '', date: '', notes: '', obligationId: '', transactionId: '', separatePaymentConfirmed: false, expected: null };
      initialDraft.current = next;
      setDraft(next); setAttempt(null); setError(''); setNotice('');
    });
  }

  async function save() {
    if (!draft || pending || readOnly) return;
    setError('');
    if (attempt) {
      setPending(true);
      try { await onCommand(attempt); setDraft(null); setAttempt(null); setNotice(`${attempt.item.name} saved to your plan.`); }
      catch (error) { if (isConfirmedCommandRejection(error)) setAttempt(null); setError(error instanceof Error ? error.message : 'Could not confirm this item.'); }
      finally { setPending(false); }
      return;
    }
    let amountCents: number | null;
    try {
      if (!draft.name.trim()) throw new Error('Enter a name for this item.');
      amountCents = parseExpensePlanAmount(draft.amount);
    } catch (error) { setError(error instanceof Error ? error.message : 'Check this item.'); return; }
    const item: ExpensePlanItem = { id: draft.id, entityId: row.limit.entityId, categoryId: row.limit.id, name: draft.name.trim(), amountCents, date: draft.date, notes: draft.notes.trim(), ...(draft.obligationId ? { obligationId: draft.obligationId } : {}), ...(draft.transactionId ? { transactionId: draft.transactionId } : {}), ...(draft.separatePaymentConfirmed ? { separatePaymentConfirmed: true } : {}) };
    const payload = { type: 'save_expense_plan_item' as const, item, expected: draft.expected };
    setPending(true);
    try {
      const command = { ...payload, requestId: requestId(payload) };
      setAttempt(command);
      await onCommand(command);
      setDraft(null); setAttempt(null);
      setNotice(`${item.name} saved to your plan.`);
    } catch (error) { if (isConfirmedCommandRejection(error)) setAttempt(null); setError(error instanceof Error ? error.message : 'Could not save this item.'); }
    finally { setPending(false); }
  }

  async function remove(item: ExpensePlanItem) {
    if (pending || readOnly) return;
    setPending(true);
    setError('');
    const payload = { type: 'delete_expense_plan_item' as const, id: item.id, expected: item };
    try {
      await onCommand({ ...payload, requestId: requestId(payload) });
      if (draft?.id === item.id) setDraft(null);
      setNotice(`${item.name} removed from your plan.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not remove this item.'); }
    finally { setPending(false); }
  }

  return <section className="expense-plan-details" aria-labelledby={`${id}-title`}>
    <DraftDiscardDialog open={discard} uncertain={!!attempt} onKeepEditing={() => { protection.keepEditing(); setDiscard(false); }} onDiscard={() => { setDraft(null); setAttempt(null); setError(''); setDiscard(false); protection.discard(); }}/>
    <div className="expense-plan-details-heading"><h4 id={`${id}-title`}>{trips ? 'Trip plans' : food ? 'Groceries & meal plans' : 'Planned items'}</h4>{!readOnly && <button className="text-button" type="button" disabled={pending || draft !== null} onClick={() => edit()}>+ Add item</button>}</div>
    {!items.length && !draft && <div className="expense-plan-item-empty"><p>{trips ? 'Add each trip with its total cost and travel date.' : food ? 'Add a grocery list or meal plan with a cost and date.' : personal ? 'Keep the cost, appointment date and notes for a haircut or other personal purchase.' : 'Add a cost, date and notes for the things you are planning.'}</p>{!readOnly && (food || personal) && <button className="expense-plan-suggestion" type="button" onClick={() => edit(undefined, food ? 'Weekly meal plan' : 'Haircut')}>+ {food ? 'Meal plan' : 'Haircut'}</button>}</div>}
    {items.length > 0 && <ul className="expense-plan-item-list">{items.map(item => <li key={item.id}>
      <div className="expense-plan-item-copy"><strong>{item.name}</strong><span>{item.date ? dateLabel(item.date) : 'No date set'}</span>{item.obligationId && <span>Linked bill: {state.obligations.find(bill => bill.id === item.obligationId)?.name ?? 'Unavailable'}</span>}{item.transactionId && <span>Recorded expense: {((transaction) => transaction ? transactionLabel(transaction) : 'Unavailable')(state.transactions.find(transaction => transaction.id === item.transactionId))}</span>}{item.separatePaymentConfirmed && <span>Confirmed as a separate payment</span>}{item.notes && <p>{item.notes}</p>}</div>
      <div className="expense-plan-item-cost"><strong>{item.amountCents === null ? 'Cost not set' : money(item.amountCents)}</strong>{!readOnly && <div><button type="button" disabled={pending} onClick={() => edit(item)} aria-label={`Edit ${item.name}`}>Edit</button><button type="button" disabled={pending} onClick={() => protection.requestChange(() => { setDraft(null); setAttempt(null); void remove(item); })} aria-label={`Remove ${item.name}`}>Remove</button></div>}</div>
    </li>)}</ul>}
    {draft && <form className="expense-plan-editor expense-plan-item-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className="expense-plan-item-fields-group" disabled={pending || !!attempt}>
      <label htmlFor={`${id}-name`}>Item name<input id={`${id}-name`} className="expense-plan-text-input" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder={example} maxLength={150} required disabled={pending} autoFocus/></label>
      <div className="expense-plan-item-fields">
        <label htmlFor={`${id}-cost`}>Planned cost <small>Optional</small><span className="expense-plan-input"><span aria-hidden="true">$</span><input id={`${id}-cost`} value={draft.amount} onChange={event => setDraft({ ...draft, amount: event.target.value })} type="text" inputMode="decimal" placeholder="Not set" disabled={pending}/><span>CAD</span></span></label>
        <label htmlFor={`${id}-date`}>{personal ? 'Appointment or purchase date' : 'Planned date'} <small>Optional</small><input id={`${id}-date`} className="expense-plan-text-input" type="date" min="1900-01-01" max="2200-12-31" value={draft.date} onChange={event => setDraft({ ...draft, date: event.target.value })} disabled={pending}/></label>
      </div>
      <label htmlFor={`${id}-notes`}>{food ? 'Meal plan or grocery notes' : 'Comment or notes'}<textarea id={`${id}-notes`} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })} placeholder={food ? 'Meals for the week, ingredients, quantities…' : personal ? 'Barber, appointment details, what to ask for…' : 'What you need, where to get it, or a reminder…'} maxLength={4000} rows={3} disabled={pending}/></label>
      <label htmlFor={`${id}-link`}>Already included elsewhere?<select id={`${id}-link`} className="expense-plan-text-input" value={draft.obligationId ? `bill:${draft.obligationId}` : draft.transactionId ? `expense:${draft.transactionId}` : ''} onChange={event => { const value = event.target.value; setDraft({ ...draft, obligationId: value.startsWith('bill:') ? value.slice(5) : '', transactionId: value.startsWith('expense:') ? value.slice(8) : '', separatePaymentConfirmed: false }); }}><option value="">No linked bill or expense</option>{bills.length > 0 && <optgroup label="Bills">{bills.map(bill => <option key={bill.id} value={`bill:${bill.id}`}>{bill.name} · {dateLabel(bill.dueDate)} · {money(bill.amountCents)}</option>)}</optgroup>}{expenses.length > 0 && <optgroup label="Recorded expenses">{expenses.map(expense => <option key={expense.id} value={`expense:${expense.id}`}>{transactionLabel(expense)} · {dateLabel(expense.date)} · {money(expense.amountCents)}</option>)}</optgroup>}</select></label>
      {!draft.obligationId && !draft.transactionId && <label className="cash-posting-confirmation"><input type="checkbox" checked={draft.separatePaymentConfirmed} onChange={event => setDraft({ ...draft, separatePaymentConfirmed: event.target.checked })}/><span>This is a separate payment from any similar bill or recorded expense.</span></label>}
      <p>Link the same payment to keep it from being counted twice in your plan. This does not change recorded spending.</p>
      </fieldset>
      {attempt && <p role="status">The original save is awaiting confirmation. Confirm it before changing these details.</p>}
      <div className="expense-plan-editor-actions"><button className="expense-plan-save" type="submit" disabled={pending}>{pending ? 'Saving…' : attempt ? 'Confirm original save' : 'Save item'}</button><button className="expense-plan-cancel" type="button" disabled={pending} onClick={() => protection.requestChange(() => { setDraft(null); setAttempt(null); setError(''); })}>Cancel</button></div>
    </form>}
    {error && <p className="expense-plan-error" role="alert">{error}</p>}
    <p className="expense-plan-status" role="status">{notice}</p>
  </section>;
}
