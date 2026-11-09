import { useRef, useState } from 'react';
import type { AppState, Command, Obligation } from '../../../shared/types.ts';
import { money, today } from '../../../shared/analytics.ts';
import { buildExpenseSchedule, debtScheduleDetails, type ExpenseScheduleEvent } from '../../../shared/expense-schedule.ts';
import { purchaseRemaining } from '../../../shared/asset-purchases.ts';
import { ExpensePay } from './ExpenseOverview.tsx';
import ExpenseBills, { BillEditor } from './ExpenseBills.tsx';
import Subscriptions from './Subscriptions.tsx';
import Icon from '../../components/Icon.tsx';
import { requestDraftNavigation } from '../../hooks/draft-protection.ts';
import './expense-schedule.css';

interface Props {
  state: AppState;
  scope: string;
  readOnly: boolean;
  onCommand: (command: Command) => Promise<void>;
  onPay: (id: string) => Promise<void>;
  pending: string;
}
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(date.slice(0, 4) !== today().slice(0, 4) ? { year: 'numeric' as const } : {}), timeZone: 'UTC' });
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', timeZone: 'UTC' });

export default function ExpenseSchedule({ state, scope, readOnly, onCommand, onPay, pending }: Props) {
  const [days, setDays] = useState(30);
  const [direction, setDirection] = useState<'all' | 'out' | 'in'>('out');
  const [management, setManagement] = useState<'bills' | 'subscriptions'>('bills');
  const [editor, setEditor] = useState<{ obligation?: Obligation } | null>(null);
  const payRef = useRef<HTMLDetailsElement>(null);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const [recording, setRecording] = useState('');
  const [paymentError, setPaymentError] = useState('');
  const asOf = today();
  const ownerId = scope === 'all' ? state.entities.find(entity => entity.kind === 'personal')?.id ?? '' : scope;
  const personal = state.entities.find(entity => entity.id === ownerId)?.kind === 'personal';
  const schedule = buildExpenseSchedule(state, ownerId, asOf, days);
  const rows = schedule.upcoming.filter(row => direction === 'all' || row.direction === direction);
  const dates = [...new Set(rows.map(row => row.date))];
  const pastRows = schedule.past.filter(row => direction === 'all' || row.direction === direction);
  const nextPay = schedule.upcoming.find(row => row.sourceType === 'payday');
  const missingLoans = state.accounts.flatMap(account => {
    if (account.entityId !== ownerId) return [];
    const payment = debtScheduleDetails(account, schedule.through);
    const needsStatementConfirmation = [...schedule.past, ...schedule.upcoming].some(row => row.sourceType === 'debt' && row.sourceId === account.id && row.needsStatementConfirmation);
    return payment && (payment.needsDateConfirmation || payment.minimumCents === null || needsStatementConfirmation) ? [{ account, payment, needsStatementConfirmation }] : [];
  });
  const undatedPurchases = (state.assetPurchases ?? []).filter(purchase => purchase.entityId === ownerId && purchase.monthlyCents > 0 && purchaseRemaining(purchase) !== 0 && !state.obligations.some(item => item.assetPurchaseId === purchase.id && item.entityId === ownerId && item.status === 'planned' && item.direction === 'out'));
  const obligationCount = state.obligations.filter(item => item.entityId === ownerId && item.status === 'planned').length;
  const subscriptionCount = state.obligations.filter(item => item.entityId === ownerId && item.status === 'planned' && item.subscription).length;

  function reviewPay() {
    if (!payRef.current) return;
    payRef.current.open = true;
    payRef.current.scrollIntoView({ block: 'center', behavior: 'instant' });
    (payRef.current.querySelector<HTMLButtonElement>('.schedule-pay header button') ?? payRef.current.querySelector('summary'))?.focus({ preventScroll: true });
  }
  function openEditor(obligation?: Obligation) {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestDraftNavigation(() => { editorTrigger.current = trigger; setEditor({ obligation }); });
  }
  function closeEditor() {
    setEditor(null);
    window.requestAnimationFrame(() => { if (editorTrigger.current?.isConnected) editorTrigger.current.focus({ preventScroll: true }); });
  }
  async function recordPayment(obligation: Obligation) {
    if (readOnly || pending || recording) return;
    setRecording(obligation.id); setPaymentError('');
    try { await onPay(obligation.id); }
    catch (error) { setPaymentError(error instanceof Error ? error.message : 'Could not open this payment.'); }
    finally { setRecording(''); }
  }
  function sourceLabel(row: ExpenseScheduleEvent) {
    if (row.sourceType === 'payday') return row.incomeTreatment === 'after_transition' ? 'Pay after income change · amount needs confirmation' : row.amountCents === null ? 'Expected pay · amount unconfirmed' : 'Expected pay · from your pay schedule';
    if (row.sourceType === 'debt') return row.amountCents === null ? 'Debt payment · amount unconfirmed' : row.needsStatementConfirmation ? 'Debt payment · payment period unconfirmed' : row.isProjection ? 'Debt payment · projected monthly repeat' : 'Debt payment · saved amount and date';
    const frequency = row.recurrence === 'monthly' ? 'Monthly' : row.recurrence === 'biweekly' ? 'Every two weeks' : 'One time';
    const income = row.incomeTreatment === 'in_regular_pay' ? 'Already included in regular pay · not added again' : row.incomeTreatment === 'needs_confirmation' ? 'Confirm whether this is additional income · excluded from income total' : row.incomeTreatment === 'additional' ? 'Additional expected income' : 'Expected income';
    return `${row.subscription ? 'Subscription' : row.direction === 'in' ? income : 'Bill'} · ${frequency}${row.isProjection ? ' · projected repeat' : ''}`;
  }
  function eventRow(row: ExpenseScheduleEvent, past = false) {
    const obligation = row.sourceType === 'obligation' ? state.obligations.find(item => item.id === row.sourceId) : undefined;
    const canRecord = obligation?.status === 'planned' && obligation.dueDate === row.date && !row.isProjection;
    return <article className={`schedule-event is-${row.direction}${past ? ' is-past' : ''}`} key={row.key}>
      <span className="schedule-event-icon"><Icon name={row.sourceType === 'payday' ? 'down' : row.sourceType === 'debt' ? 'wallet' : 'plan'} size={17}/></span>
      <div className="schedule-event-copy"><h4>{row.name}</h4><p>{sourceLabel(row)}</p>{past && <small>Saved date {dateLabel(row.date)}. Check whether this was already {row.direction === 'in' ? 'received' : 'paid'}.</small>}</div>
      <strong className="schedule-event-amount">{row.amountCents === null ? 'Amount not set' : `${row.direction === 'in' && !['in_regular_pay', 'needs_confirmation'].includes(row.incomeTreatment ?? '') ? '+' : ''}${money(row.amountCents)}`}</strong>
      <div className="schedule-event-actions">{row.sourceType === 'debt' ? <a className="schedule-event-action" href={`#debts?record=${encodeURIComponent(row.sourceId)}`} aria-label={`Review ${row.name} on Debts`}>Review debt <Icon name="arrow" size={13}/></a> : row.sourceType === 'payday' ? <button type="button" className="schedule-event-action" onClick={reviewPay}>Pay schedule <Icon name="arrow" size={13}/></button> : obligation && !readOnly ? <>
        {canRecord && <button type="button" className="schedule-record-payment" disabled={!!pending || !!recording} onClick={() => requestDraftNavigation(() => { void recordPayment(obligation); })} aria-label={`${!obligation.accountId ? 'Choose payment account for' : row.direction === 'in' ? 'Record received:' : 'Record paid:'} ${row.name}`}>{recording === obligation.id || pending === obligation.id ? 'Opening…' : !obligation.accountId ? 'Choose account' : row.direction === 'in' ? 'Record received' : 'Record paid'}</button>}
        <button type="button" className="schedule-event-action" disabled={!!pending || !!recording} onClick={() => openEditor(obligation)} aria-label={`Edit schedule for ${row.name}`}>Edit schedule <Icon name="arrow" size={13}/></button>
      </> : null}</div>
    </article>;
  }

  return <div className="expense-schedule-workspace">
    <header className="schedule-heading"><div><h2>Bills</h2><p>Upcoming bills, subscriptions and debt payments.</p></div><div className="schedule-heading-actions"><label><span className="sr-only">Schedule date range</span><select aria-label="Schedule date range" value={days} onChange={event => setDays(Number(event.target.value))}><option value={30}>Next 30 days</option><option value={60}>Next 60 days</option><option value={90}>Next 90 days</option></select></label>{!readOnly && <button type="button" className="button primary compact" disabled={!!pending} onClick={() => openEditor()}><Icon name="plus" size={15}/>Add bill or income</button>}</div></header>
    <div className="schedule-summary" aria-label="Schedule totals">
      <section><span>Upcoming payments</span><strong>{schedule.totals.unknownOutgoingCount > 0 && schedule.totals.outgoingCents === 0 ? 'Amount not set' : money(schedule.totals.outgoingCents)}</strong><p>Bills and saved debt payments through {dateLabel(schedule.through)}{schedule.totals.unknownOutgoingCount > 0 ? ` · ${schedule.totals.unknownOutgoingCount} ${schedule.totals.unknownOutgoingCount === 1 ? 'amount' : 'amounts'} missing` : ''}</p></section>
    </div>
    <div className="schedule-workspace bills-workspace">
      {paymentError && <p className="bill-error schedule-payment-error" role="alert">{paymentError}</p>}
      <section className="night-glass schedule-agenda" aria-label="Upcoming schedule">
        <header><div><h3>Coming up</h3><p>{dateLabel(asOf)} to {dateLabel(schedule.through)}</p></div><div className="schedule-agenda-filter" role="group" aria-label="Agenda direction">{(['out', 'in', 'all'] as const).map(value => <button type="button" key={value} aria-pressed={direction === value} onClick={() => setDirection(value)}>{value === 'all' ? 'All dates' : value === 'out' ? 'Payments' : 'Income'}</button>)}</div></header>
        {pastRows.length > 0 && <details className="schedule-past"><summary><Icon name="clock" size={15}/>{pastRows.length} past {pastRows.length === 1 ? 'date' : 'dates'} to review<Icon name="down" size={14}/></summary><div>{pastRows.map(row => eventRow(row, true))}</div></details>}
        {dates.length ? <div className="schedule-days">{dates.map(date => <section className="schedule-day" key={date} aria-label={dateLabel(date)}><time dateTime={date}><span>{date === asOf ? 'Today' : weekday(date)}</span><strong>{Number(date.slice(8))}</strong><small>{new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' })}</small></time><div>{rows.filter(row => row.date === date).map(row => eventRow(row))}</div></section>)}</div> : <div className="schedule-empty"><Icon name="plan" size={25}/><h4>No {direction === 'out' ? 'outgoing payments' : direction === 'in' ? 'income dates' : 'dates'} in this range</h4><p>{direction === 'all' ? 'Add a bill or set up your pay schedule.' : 'Change the filter or date range to see more.'}</p></div>}
        <p className="schedule-agenda-note">Record paid after money moves. Future repeats are estimates until their saved payment date advances.{schedule.upcoming.some(row => row.sourceType === 'debt' && row.isProjection) ? ' Projected debt payments repeat the saved minimum. Future interest and payoff dates are not modeled.' : ''}</p>
      </section>
      {(undatedPurchases.length > 0 || missingLoans.length > 0) && <aside className="schedule-sidebar">
        <section className="night-glass schedule-needs-details" aria-label="Schedule details needed"><h3>Payment details to confirm</h3>{undatedPurchases.map(purchase => <div key={purchase.id}><strong>{purchase.name}</strong><p>{money(purchase.monthlyCents)} / month{purchase.payee ? ` to ${purchase.payee}` : ''}. No payment date saved, so it is excluded above.</p><a href="#assets">View purchase <Icon name="arrow" size={13}/></a></div>)}{missingLoans.map(({ account, payment, needsStatementConfirmation }) => <div key={account.id}><strong>{account.name}</strong><p>{!payment.dueDate ? 'Payment date not set.' : `Saved date ${dateLabel(payment.dueDate)}.`}{payment.needsDateConfirmation && payment.repaymentStartDate ? ` Confirm the first payment deadline on or after repayment resumes ${dateLabel(payment.repaymentStartDate)}.` : ''}{payment.minimumCents === null ? ' Payment amount needs confirmation.' : ''}{needsStatementConfirmation ? ' Confirm the statement date and current minimum. Recorded payments have not reduced this amount because their payment period is unknown.' : ''}</p><a href={`#debts?record=${encodeURIComponent(account.id)}`} aria-label={`Review ${account.name} on Debts`}>Review debt <Icon name="arrow" size={13}/></a></div>)}</section>
      </aside>}
    </div>
    <details className="schedule-secondary schedule-management-details"><summary onClick={event => { const details = event.currentTarget.parentElement as HTMLDetailsElement; if (details.open) { event.preventDefault(); requestDraftNavigation(() => { details.open = false; }); } }}><span>Manage bills and subscriptions<small>Recurring settings, cancelled entries and recorded payments</small></span><Icon name="down" size={16}/></summary>
    <section className="schedule-management" aria-label="Manage recurring payments"><header><div><h3>Bills and subscriptions</h3><p>Change recurring payments, reactivate cancelled entries or add a subscription.</p></div><nav aria-label="Schedule management"><button type="button" aria-pressed={management === 'bills'} onClick={() => requestDraftNavigation(() => setManagement('bills'))}>Bills & income <span>{obligationCount}</span></button><button type="button" aria-pressed={management === 'subscriptions'} onClick={() => requestDraftNavigation(() => setManagement('subscriptions'))}>Subscriptions <span>{subscriptionCount}</span></button></nav></header>{management === 'bills' ? <ExpenseBills state={state} scope={ownerId} readOnly={readOnly} onCommand={onCommand} onPay={onPay} pending={pending}/> : <Subscriptions state={state} scope={ownerId} readOnly={readOnly} onCommand={onCommand} onPay={onPay} pending={pending}/>}</section>
      <a className="schedule-history-link" href="#expenses/activity">View recorded payments in Transactions <Icon name="arrow" size={14}/></a>
    </details>
    <details ref={payRef} className="schedule-secondary schedule-income-details"><summary onClick={event => { const details = event.currentTarget.parentElement as HTMLDetailsElement; if (details.open) { event.preventDefault(); requestDraftNavigation(() => { details.open = false; }); } }}><span>Pay schedule and expected income<small>{nextPay ? `Next payday ${dateLabel(nextPay.date)}` : 'Review income dates and amounts'}</small></span><Icon name="down" size={16}/></summary>
      <div className="schedule-summary schedule-income-summary" aria-label="Expected income totals">
      {personal && <section className="is-income"><span>Expected pay</span><strong>{!schedule.hasRegularPaySchedule ? 'Schedule not set' : schedule.totals.unknownPaydayIncomeCount > 0 ? schedule.totals.paydayIncomeCents > 0 ? `${money(schedule.totals.paydayIncomeCents)} known` : 'Amount not set' : money(schedule.totals.paydayIncomeCents)}</strong><p>{!schedule.hasRegularPaySchedule ? 'Add a pay schedule to project regular income.' : nextPay ? `Next payday ${dateLabel(nextPay.date)} · ${schedule.upcoming.filter(row => row.sourceType === 'payday').length} paydays in this view` : 'No paydays in this date range'}{schedule.totals.unknownPaydayIncomeCount > 0 ? ` · ${schedule.totals.unknownPaydayIncomeCount} payday ${schedule.totals.unknownPaydayIncomeCount === 1 ? 'amount needs' : 'amounts need'} confirmation` : ''}</p></section>}
      {(schedule.totals.obligationIncomeCents > 0 || schedule.totals.unconfirmedObligationIncomeCount > 0 || schedule.totals.alreadyIncludedIncomeCount > 0) && <section className="schedule-other-income"><span>{schedule.hasRegularPaySchedule ? 'Additional income' : 'Scheduled income'}</span><strong>{schedule.totals.obligationIncomeCents > 0 ? `${money(schedule.totals.obligationIncomeCents)}${schedule.totals.unconfirmedObligationIncomeCount > 0 ? ' confirmed' : ''}` : schedule.totals.unconfirmedObligationIncomeCount > 0 ? 'Needs confirmation' : 'Included in regular pay'}</strong><p>{schedule.hasRegularPaySchedule ? 'Only income confirmed as additional is added to regular pay.' : 'Known income from your dated entries.'}{schedule.totals.unconfirmedObligationIncomeCount > 0 ? ` ${schedule.totals.unconfirmedObligationIncomeCount} ${schedule.totals.unconfirmedObligationIncomeCount === 1 ? 'entry needs' : 'entries need'} confirmation.` : ''}{schedule.totals.alreadyIncludedIncomeCount > 0 ? ` ${schedule.totals.alreadyIncludedIncomeCount} ${schedule.totals.alreadyIncludedIncomeCount === 1 ? 'entry is' : 'entries are'} already in regular pay.` : ''}</p></section>}
      </div>
      {personal && <div className="schedule-pay"><ExpensePay state={state} readOnly={readOnly} onCommand={onCommand}/></div>}
    </details>
    {!readOnly && editor && <BillEditor key={editor.obligation?.id ?? 'new'} state={state} scope={ownerId} obligation={editor.obligation} onCommand={onCommand} onClose={closeEditor}/>}
  </div>;
}
