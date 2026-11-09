import { useId, useState, type ReactNode, type RefObject } from 'react';
import type { AppState } from '../../../shared/types.ts';
import type { DailyPlan, DailyPlanEvent } from '../../../shared/engine.ts';
import { money } from '../../../shared/analytics.ts';
import { isUncategorized } from '../../../shared/expense-categories.ts';
import { activeExpenseTransactions } from '../../../shared/category-review.ts';
import { incomeBeforePayday } from '../../../shared/daily-plan.ts';
import type { useEngineProject } from '../../services/useEngine.ts';
import EngineStatus from '../../components/EngineStatus.tsx';
import Icon from '../../components/Icon.tsx';
import HomeCashPreview from './HomeCashPreview.tsx';
import './home-outlook.css';

export type HomeNavigate = (view: 'investments' | 'expenses' | 'debts' | 'assets' | 'simulations' | 'documents', section?: 'accounts' | 'schedule' | 'activity' | 'imports' | 'plan', recordId?: string) => void;
type Open = (kind: 'transaction' | 'account' | 'obligation' | 'import' | 'reserve' | 'reconcile', accountId?: string) => void;
interface Props { state: AppState; scope: string; asOf: string; readOnly: boolean; engine: ReturnType<typeof useEngineProject<DailyPlan>>; onNavigate: HomeNavigate; onOpen: Open; forecastRef?: RefObject<HTMLDetailsElement | null>; children?: ReactNode }
interface Review { id: string; title: string; detail: string; action: () => void; edits?: boolean; urgent?: boolean }

export default function HomeNextUp({ state, scope, asOf, readOnly, engine, onNavigate, onOpen, forecastRef, children }: Props) {
  const id = useId();
  const [paymentWindow, setPaymentWindow] = useState<'payday' | 'week'>('payday');
  const [showAllPayments, setShowAllPayments] = useState(false);
  const plan = engine.data;
  const weekEnd = new Date(`${asOf}T12:00:00Z`);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const weekEndDate = weekEnd.toISOString().slice(0, 10);
  const paymentEndDate = plan ? paymentWindow === 'week' ? weekEndDate < plan.endDate ? weekEndDate : plan.endDate : plan.beforePayday.endDate : undefined;
  const accountIds = new Set(state.accounts.filter(account => scope === 'all' || account.entityId === scope).map(account => account.id));
  const staged = (state.importBatches ?? []).filter(batch => batch.status === 'staged' && accountIds.has(batch.source.accountId));
  const uncategorized = activeExpenseTransactions(state.transactions).filter(transaction => accountIds.has(transaction.accountId) && isUncategorized(transaction.category));
  const unresolvedSources = new Set(plan?.missingInputs.map(item => item.sourceId));
  const due = plan?.events.filter(event => event.direction === 'out'
    && (event.includedInCashflow || event.amountCents === null && (event.sourceType === 'obligation' || event.sourceType === 'debt' || unresolvedSources.has(event.sourceId)))
    && (event.status === 'overdue' || event.date <= paymentEndDate!)) ?? [];
  const unknownPayments = due.filter(event => event.amountCents === null).length;
  const knownPaymentsCents = due.reduce((total, event) => total + (event.amountCents ?? 0), 0);
  const earlierIncome = plan ? incomeBeforePayday(plan) : undefined;
  const nextIncome = earlierIncome ?? plan?.nextPayday;
  const incomeDays = nextIncome ? Math.round((Date.parse(`${nextIncome.date}T12:00:00Z`) - Date.parse(`${asOf}T12:00:00Z`)) / 86_400_000) : null;
  const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(date.slice(0, 4) !== asOf.slice(0, 4) ? { year: 'numeric' as const } : {}), timeZone: 'UTC' });
  function openEvent(event: DailyPlanEvent) {
    if (event.sourceType === 'payday') {
      if (event.date === asOf && plan?.todayPayday?.receiptStatus === 'unconfirmed') onNavigate('simulations', undefined, `payday:${event.date}`);
      else onNavigate('expenses', 'schedule');
    }
    else if (event.sourceType === 'debt') onNavigate('debts', undefined, event.sourceId);
    else if (event.sourceType === 'obligation') onNavigate('expenses', 'schedule', event.sourceId);
    else onNavigate('expenses', 'plan', event.sourceId);
  }
  const review: Review[] = [];
  if (plan?.firstShortfallDate) {
    const day = plan.days.find(day => day.date === plan.firstShortfallDate);
    const timingGap = !!day && day.incomeCents > 0 && day.afterProtectedCents >= 0;
    review.push({ id: 'cash-gap', title: `${timingGap ? 'Check payment timing' : 'Review the cash gap'} on ${dateLabel(plan.firstShortfallDate)}`, detail: `${timingGap ? `Payments may leave before ${money(day.incomeCents)} arrives that day. The forecast assumes payments leave first.` : `Forecast cash is below ${plan.protectedCents ? `your ${money(plan.protectedCents)} protected amount` : '$0'}.`}${plan.status === 'partial' ? ' Some amounts still need confirmation.' : ''}`, action: () => onNavigate('simulations'), urgent: true });
  }
  if (plan?.todayPayday?.receiptStatus === 'unconfirmed') review.push({ id: 'today-pay', title: "Confirm today's pay", detail: plan.todayPayday.amountCents === null ? 'The take-home amount and bank receipt need confirmation.' : `${money(plan.todayPayday.amountCents)} is scheduled. The forecast does not add it to recorded cash. Confirm whether the deposit is already included in your bank balance.`, action: () => onNavigate('simulations', undefined, `payday:${plan.todayPayday!.date}`), urgent: true });
  if (staged.length) review.push({ id: 'imports', title: 'Review statements', detail: `${staged.length} ${staged.length === 1 ? 'statement is' : 'statements are'} waiting to be added${staged.length === 1 ? `: ${staged[0].source.sourceFile}` : '.'}`, action: () => onNavigate('documents', 'imports', staged[0].id) });
  if (uncategorized.length) review.push({ id: 'categories', title: `Categorize ${uncategorized.length} ${uncategorized.length === 1 ? 'expense' : 'expenses'}`, detail: 'Choose categories from the recorded merchants and amounts.', action: () => onNavigate('expenses', 'activity', 'categories') });
  const missing = new Map<string, DailyPlan['missingInputs']>();
  for (const item of plan?.missingInputs ?? []) {
    if (item.field === 'paydayReceipt' && plan?.todayPayday?.receiptStatus === 'unconfirmed') continue;
    const dueEvent = due.find(event => event.sourceId === item.sourceId && (event.status === 'overdue' || event.amountCents === null));
    if (dueEvent) continue;
    const key = `${item.section}:${item.sourceId ?? ''}`;
    missing.set(key, [...(missing.get(key) ?? []), item]);
  }
  for (const [key, items] of missing) {
    const item = items[0];
    const account = state.accounts.find(account => account.id === item.sourceId);
    const obligation = state.obligations.find(obligation => obligation.id === item.sourceId);
    const plannedItem = state.expensePlanItems?.find(row => row.id === item.sourceId);
    const title = obligation ? `Review ${obligation.name}` : item.section === 'accounts' ? account ? `Check ${account.name} balance` : 'Add a cash account' : item.section === 'debts' ? account ? `Confirm ${account.name} payment details` : 'Confirm debt payment details' : item.section === 'reserve' ? 'Confirm protected cash' : item.section === 'pay' ? 'Confirm your pay schedule' : item.field.startsWith('expensePlanItems') ? plannedItem ? `Review ${plannedItem.name}` : 'Review a planned expense' : item.section === 'expenses' ? 'Confirm living costs' : 'Complete asset details';
    review.push({ id: `missing:${key}`, title, detail: items.map(value => value.message).join(' '), edits: item.section === 'accounts', action: () => {
      if (obligation) onNavigate('expenses', 'schedule', obligation.id);
      else if (item.section === 'accounts') account ? onOpen('reconcile', account.id) : onOpen('account');
      else if (item.section === 'debts') onNavigate('debts', undefined, item.sourceId);
      else if (item.field.startsWith('expensePlanItems')) onNavigate('expenses', 'plan', item.sourceId);
      else if (item.section === 'assets') onNavigate('assets', undefined, item.sourceId);
      else onNavigate('simulations', undefined, `setup:${item.section}`);
    } });
  }
  const urgentReview = review.filter(item => item.urgent);
  const otherReview = review.filter(item => !item.urgent);
  const reviewRow = (item: Review) => <li key={item.id}><button type="button" className={item.urgent ? 'is-urgent' : undefined} disabled={readOnly && item.edits} onClick={item.action}><span><strong>{item.title}</strong><small>{item.detail}</small></span><Icon name="arrow" size={16}/></button></li>;

  return <><section className="home-next-up" aria-labelledby={`${id}-title`} data-motion-enter>
    <header className="home-next-heading"><h2 id={`${id}-title`}>Coming up</h2><button type="button" className="text-button" onClick={() => onNavigate('simulations')}>Open Planner <Icon name="arrow" size={15}/></button></header>
    <EngineStatus {...engine}/>
    {urgentReview.length > 0 && <div className="home-review home-review-urgent" aria-labelledby={`${id}-urgent`}><h3 id={`${id}-urgent`}>Check first</h3><ul className="home-review-list">{urgentReview.map(reviewRow)}</ul></div>}
    <div className="home-next-grid">
      <div className="home-next-pay">
        <span>{earlierIncome ? 'Next expected income' : 'Next paycheck'}</span>
        {plan && <><strong>{nextIncome ? dateLabel(nextIncome.date) : 'Payday not available'}</strong>{incomeDays !== null && incomeDays >= 0 && <span className="home-pay-countdown">{incomeDays === 0 ? 'Today' : incomeDays === 1 ? 'Tomorrow' : `In ${incomeDays} days`}</span>}<p>{nextIncome ? nextIncome.amountCents === null ? 'Take-home amount not confirmed' : `${money(nextIncome.amountCents)} expected` : 'Review your pay dates to plan the days between paychecks.'}</p>{earlierIncome && <p>{earlierIncome.name}</p>}</>}
        {!plan && <strong>{engine.loading ? 'Checking dates' : 'Dates unavailable'}</strong>}
        <button type="button" className="text-button" onClick={() => earlierIncome ? openEvent(earlierIncome) : onNavigate('expenses', 'schedule')}>{earlierIncome ? 'Review income' : plan?.nextPayday ? 'Edit pay schedule' : 'Review pay schedule'} <Icon name="arrow" size={14}/></button>
      </div>
      <div className="home-next-payments">
        <div className="home-payment-window" role="group" aria-label="Payment window">
          <button type="button" aria-pressed={paymentWindow === 'payday'} disabled={!plan} onClick={() => { setPaymentWindow('payday'); setShowAllPayments(false); }}>{plan && !plan.nextPayday ? `Next ${plan.horizonDays} days` : 'Before payday'}</button>
          <button type="button" aria-pressed={paymentWindow === 'week'} disabled={!plan} onClick={() => { setPaymentWindow('week'); setShowAllPayments(false); }}>Next 7 days</button>
        </div>
        <h3>{paymentEndDate ? `Payments through ${dateLabel(paymentEndDate)}` : 'Coming payments'}</h3>
        {plan && due.length > 0 && <div className="home-payment-total"><strong>{unknownPayments === due.length ? 'Total not confirmed' : `${money(knownPaymentsCents)}${unknownPayments ? ' known' : ' due'}`}</strong><span>{due.length} {due.length === 1 ? 'payment' : 'payments'}{unknownPayments > 0 && <span className="home-payment-unknown"> · {unknownPayments} {unknownPayments === 1 ? 'amount' : 'amounts'} needed</span>}</span></div>}
        {plan && (due.length ? <ul id={`${id}-payments`}>{due.slice(0, showAllPayments ? due.length : 3).map(event => <li key={event.id}><button type="button" onClick={() => openEvent(event)}><span><strong>{event.name}</strong><small><span className={`home-payment-date${event.status === 'overdue' ? ' is-overdue' : event.status === 'today' ? ' is-today' : ''}`}>{event.status === 'overdue' ? 'Past date, check payment' : event.status === 'today' ? 'Today' : dateLabel(event.date)}</span>{event.isProjection ? ' · Expected repeat' : ''}</small></span><strong>{event.amountCents === null ? 'Amount needed' : money(event.amountCents)}</strong><Icon name="arrow" size={14}/></button></li>)}</ul> : <p className="home-next-empty">No saved payments through {dateLabel(paymentEndDate!)}.</p>)}
        {due.length > 3 && <button type="button" className="text-button home-next-more" aria-expanded={showAllPayments} aria-controls={`${id}-payments`} onClick={() => setShowAllPayments(value => !value)}>{showAllPayments ? 'Show fewer payments' : `Show ${due.length - 3} more ${due.length === 4 ? 'payment' : 'payments'}`}<Icon name="down" size={14}/></button>}
      </div>
    </div>
    {otherReview.length > 0 && <details className="home-review home-review-queue"><summary id={`${id}-review`}>Needs review <span>{otherReview.length}</span></summary><ul className="home-review-list" aria-labelledby={`${id}-review`}>{otherReview.map(reviewRow)}</ul></details>}
  </section><details ref={forecastRef} className="home-forecast-details" hidden={!plan} data-motion-enter>
    <summary><Icon name="activity" size={18}/><span><strong>Explore your cash forecast</strong><small>See daily balances and try a spending amount.</small></span><Icon name="down" size={18}/></summary>
    <HomeCashPreview key={`${state.workspace}-${scope}`} plan={plan} onNavigate={onNavigate} onEvent={openEvent}/>
  </details>{children}</>;
}
