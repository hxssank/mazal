import { transactionLabel } from '../../../shared/transaction-label.ts';
import { useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { AppState, Command } from '../../../shared/types.ts';
import { money, today } from '../../../shared/analytics.ts';
import { spendingCalendar, shiftCalendarMonth } from '../../../shared/spending-calendar.ts';
import { expensePayDates, projectedPayCents, temporaryWorkSchedule, workScheduleDescription } from '../../../shared/expense-pay.ts';
import { subscriptionAmount } from '../../../shared/subscriptions.ts';
import { statementCoverage } from '../../../shared/statement-imports.ts';
import Icon from '../../components/Icon.tsx';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
import './expense-workspace.css';

interface Props {
  state: AppState;
  ownerId: string;
  month: string;
  onMonth: (month: string) => void;
  onTransactions: () => void;
}
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export default function ExpenseOverview({ state, ownerId, month, onMonth, onTransactions }: Props) {
  const asOf = today();
  const data = spendingCalendar(state, ownerId, month, asOf);
  const coverage = statementCoverage(state, ownerId, month);
  const [selected, setSelected] = useState<string | null>(null);
  const day = data.days.find(item => item.date === selected);
  const name = new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  function changeMonth(value: string) { onMonth(value); setSelected(null); }
  return <section className={`expense-month-story${data.transactionCount ? '' : ' is-empty'}`} aria-label="Recorded monthly spending">
    <header><span className="expense-kicker">Recorded spending</span><div className="expense-month-nav"><button aria-label="Previous spending month" onClick={() => changeMonth(shiftCalendarMonth(month, -1))}><Icon name="down" size={15}/></button><label><span className="sr-only">Spending month</span><input type="month" value={month} max={asOf.slice(0, 7)} onChange={event => { if (event.target.value && event.target.value <= asOf.slice(0, 7)) changeMonth(event.target.value); }}/></label><button aria-label="Next spending month" disabled={month >= asOf.slice(0, 7)} onClick={() => changeMonth(shiftCalendarMonth(month, 1))}><Icon name="down" size={15}/></button></div></header>
    <div className="expense-month-summary"><div className="expense-month-amount"><strong>{money(data.totalCents)}</strong><span>{data.transactionCount ? `${data.transactionCount} recorded ${data.transactionCount === 1 ? 'expense' : 'expenses'}` : 'No expenses recorded yet'}<small>{name}</small></span></div>{data.transactionCount>0&&<button type="button" className="expense-inline-link" onClick={onTransactions}>View transactions <Icon name="arrow" size={14}/></button>}</div>
    {coverage.accountCount>0&&<p className="source-coverage">{coverage.status==='complete'?`Statements cover this month's posting dates for all ${coverage.accountCount} recorded spending accounts. Purchases use transaction dates.`:coverage.status==='partial'?'Statement coverage is partial for these accounts. Recorded spending may be incomplete.':'No statement covers this month for these accounts. Recorded spending is incomplete.'}</p>}
    {!data.transactionCount && <div className="expense-month-detail"><span>No recorded expenses for this month. Add an expense or import a statement to build your spending history.</span><button type="button" className="expense-inline-link" onClick={onTransactions}>View transactions <Icon name="arrow" size={14}/></button></div>}
    {data.transactionCount>0&&<details className="expense-daily-details"><summary>Daily spending</summary>
    <div className="expense-month-bars" aria-label="Daily spending. Select a day for details.">{data.days.map(item => <button key={item.date} type="button" disabled={item.isFuture} aria-pressed={selected === item.date} aria-label={`${shortDate(item.date)}: ${money(item.totalCents)}${item.isFuture ? ', future date' : ' recorded'}`} title={`${shortDate(item.date)} · ${money(item.totalCents)}`} className={`${item.isFuture ? 'is-future' : ''} ${item.date === asOf ? 'is-today' : ''}`} onClick={() => setSelected(item.date)} style={{ '--bar-height': `${data.largestDayCents ? Math.max(5, item.totalCents / data.largestDayCents * 100) : 5}%` } as CSSProperties}><span/></button>)}</div>
    <div className="expense-month-axis"><span>1 {name.split(' ')[0].slice(0, 3)}</span><span>Daily expenses</span><span>{data.days.length} {name.split(' ')[0].slice(0, 3)}</span></div>
    <div className="expense-month-detail" aria-live="polite">{day ? <><span><strong>{shortDate(day.date)} · {money(day.totalCents)}</strong>{day.entries.length ? day.entries.slice(0, 2).map(entry => transactionLabel(entry.transaction)).join(', ') + (day.entries.length > 2 ? ` +${day.entries.length - 2} more` : '') : 'No expenses recorded on this day.'}</span><button aria-label="Clear selected spending day" onClick={() => setSelected(null)}><Icon name="close" size={15}/></button></> : <span>{data.transactionCount ? "Select a bar to see that day's spending." : state.transactions.some(transaction=>transaction.kind==='expense')?'Choose another month to see imported expenses.':'Add a purchase or import a statement to start your spending history.'}</span>}</div>
    </details>}
  </section>;
}

interface PayProps { state: AppState; readOnly: boolean; onCommand: (command: Command) => Promise<void> }
export function ExpensePay({ state, readOnly, onCommand }: PayProps) {
  const dates = expensePayDates(state.roadmap, today());
  const [editing, setEditing] = useState(false);
  const { changed: recordsChanged, review: reviewRevision, prepare } = useCommandDraft(state.revision);
  const [amount, setAmount] = useState('');
  const [cadence, setCadence] = useState('14');
  const [anchor, setAnchor] = useState('');
  const [resolveTransition, setResolveTransition] = useState(false);
  const work = temporaryWorkSchedule(state.roadmap);
  const nextPay = dates[0] ? projectedPayCents(state.roadmap, dates[0]) : state.roadmap?.payAmountCents;
  const nextPayNeedsConfirmation = nextPay == null && !!dates[0] && state.roadmap?.payAmountCents != null;
  const pastTransition = !work && state.roadmap?.incomeTransitionPlanned !== false && !!state.roadmap?.transitionDate && state.roadmap.transitionDate <= today();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const initial = useRef('');
  const cardRef = useRef<HTMLElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  function finishEditing() {
    setEditing(false);
    window.requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card?.isConnected || card.closest('[hidden]')) return;
      (card.querySelector<HTMLElement>('form input:not(:disabled)') ?? editRef.current)?.focus({ preventScroll: true });
    });
  }
  const draft = JSON.stringify({ amount, cadence, anchor, resolveTransition });
  const protection = useDraftProtection({ dirty: !readOnly && editing && draft !== initial.current, busy: pending, onRequestDiscard: () => setDiscard(true) });
  function edit() { protection.requestChange(() => { const amount = state.roadmap?.payAmountCents ? String(state.roadmap.payAmountCents / 100) : ''; const cadence = String(state.roadmap?.payEveryDays ?? 14); const anchor = state.roadmap?.paydayAnchor ?? ''; initial.current = JSON.stringify({ amount, cadence, anchor, resolveTransition: false }); reviewRevision(); setAmount(amount); setCadence(cadence); setAnchor(anchor); setError(''); setResolveTransition(false); setEditing(true); }); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (pending || readOnly) return; setError('');
    try {
      if (recordsChanged) throw new Error('Review the updated records before saving your pay schedule.');
      const payAmountCents = subscriptionAmount(amount);
      if (!Number.isInteger(Number(cadence)) || Number(cadence) < 1 || Number(cadence) > 366) throw new Error('Choose 1 to 366 days between paydays.');
      const date = new Date(`${anchor}T12:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== anchor) throw new Error('Enter a valid payday.');
      if (pastTransition && resolveTransition && anchor < state.roadmap!.transitionDate) throw new Error('Choose a payday on or after the saved income change.');
      setPending(true);
      await onCommand(prepare({ type: 'update_pay_schedule', payAmountCents, payEveryDays: Number(cadence), paydayAnchor: anchor, ...(pastTransition && resolveTransition ? { resolveIncomeTransition: true } : {}) }));
      finishEditing();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the pay schedule.'); }
    finally { setPending(false); }
  }
  return <section ref={cardRef} className="expense-pay-card" aria-label="Pay schedule">
    <DraftDiscardDialog open={discard} onDiscard={() => { finishEditing(); setDiscard(false); protection.discard(); }} onKeepEditing={() => { setDiscard(false); protection.keepEditing(); }}/>
    <header><span className="expense-kicker">Regular pay schedule</span>{!readOnly && <button ref={editRef} className="expense-inline-link" disabled={pending} onClick={edit}>{dates.length ? 'Edit' : 'Set up'}</button>}</header>
    {editing && !readOnly ? <form className="expense-pay-form" onSubmit={save}><label>{work ? 'Full-time take-home pay per paycheck' : 'Take-home pay per paycheck'}<input disabled={pending} autoFocus inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="Amount per payday" required/></label><div><label>Repeat every<input disabled={pending} type="number" min="1" max="366" value={cadence} onChange={event => setCadence(event.target.value)} required/><small>days</small></label><label>Confirmed payday<input disabled={pending} type="date" min="1900-01-01" max="2200-12-31" value={anchor} onChange={event => setAnchor(event.target.value)} required/></label></div>{pastTransition && <label className="pay-transition-confirm"><input type="checkbox" checked={resolveTransition} onChange={event => setResolveTransition(event.target.checked)} disabled={pending}/><span>This is my pay after the {shortDate(state.roadmap!.transitionDate)} income change<small>Confirm only if this amount and payday already reflect that change.</small></span></label>}{recordsChanged && <div className="mazal-form-notice" role="status"><p>Records changed while this schedule was open. Saved schedule: {state.roadmap?.payAmountCents == null ? 'Amount not entered' : money(state.roadmap.payAmountCents)}{state.roadmap?.payEveryDays ? ` every ${state.roadmap.payEveryDays} days` : ''}{state.roadmap?.paydayAnchor ? ` from ${state.roadmap.paydayAnchor}` : ''}.</p><button type="button" disabled={pending} onClick={() => { reviewRevision(); setError(''); }}>Keep my entries</button><button type="button" disabled={pending} onClick={edit}>Load saved schedule</button></div>}{error && <p role="alert">{error}</p>}<div className="expense-pay-form-actions"><button type="button" disabled={pending} onClick={() => protection.requestChange(finishEditing)}>Cancel</button><button className="button primary compact" disabled={pending || recordsChanged}>{pending ? 'Saving…' : 'Save schedule'}</button></div></form> : <><div className="expense-pay-value"><strong>{nextPayNeedsConfirmation ? 'Confirm take-home pay' : nextPay != null ? money(nextPay) : 'Amount not set'}</strong><span>{dates[0] ? `${dates[0] === today() ? 'Today' : shortDate(dates[0])} · every ${state.roadmap?.payEveryDays} days` : 'Set an amount and pay schedule.'}</span></div><div className="expense-pay-path">{dates.map((date, index) => <div key={date} className={index === 0 ? 'is-next' : ''}><i aria-hidden="true"/><span>{index === 0 ? 'Next scheduled' : `Pay ${index + 1}`}</span><strong>{shortDate(date)}</strong></div>)}</div><p>{work ? `${workScheduleDescription(state.roadmap)} Mazal estimates each deposit from the weekdays worked in its pay period.` : nextPayNeedsConfirmation ? 'The next payday follows your saved income change. Confirm the new amount in Edit.' : 'This schedule repeats. Record each deposit when it arrives; add one-off income separately.'}</p></>}
  </section>;
}
