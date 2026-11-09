import { lazy, Suspense, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AppState, Command, Obligation, Reserve } from '../../../shared/types.ts';
import type { DailyPlan, DailyPlanEvent } from '../../../shared/engine.ts';
import { incomeBeforePayday } from '../../../shared/daily-plan.ts';
import { projectHomeCash } from '../../../shared/home-cash-preview.ts';
import { money } from '../../../shared/analytics.ts';
import { parseMoneyCents } from '../../../shared/money-input.ts';
import { useEngineDate, useEngineProject } from '../../services/useEngine.ts';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
import { ExpensePay } from '../expenses/ExpenseOverview.tsx';
import { BillEditor } from '../expenses/ExpenseBills.tsx';
import { PaymentRecorder, ReserveEditor, PaydayReceipt } from '../../components/RecordActions.tsx';
import Icon from '../../components/Icon.tsx';
import AnimatedValue from '../../components/AnimatedValue.tsx';
import ReviewWorkspace from '../expenses/ReviewWorkspace.tsx';
import PlannerHorizon from './PlannerHorizon.tsx';
import CompoundingPlan from './CompoundingPlan.tsx';
import useReviewMotion from '../../hooks/useReviewMotion.ts';
import './planner-workspace.css';
import './planner-review.css';
import '../../styles/organized-workspaces.css';

const Simulations = lazy(() => import('./Simulations.tsx'));
type Destination = 'expenses' | 'debts' | 'assets' | 'documents';
interface Props {
  state: AppState; scope: string; motion: boolean; readOnly?: boolean;
  initialSection?: 'compare' | 'setup' | 'review';
  onSectionChange?: (section?: 'compare' | 'setup' | 'review') => void;
  onCommand: (command: Command) => Promise<void>;
  onNavigate: (view: Destination, section?: 'schedule' | 'activity' | 'plan' | 'imports', recordId?:string) => void;
  onOpen: (kind: 'account' | 'reserve' | 'reconcile', accountId?: string) => void;
  onRecord: (kind: 'income' | 'expense' | 'debt_payment', accountId?: string) => void;
}
const dateLabel = (value: string, weekday = false) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(weekday ? { weekday: 'short' as const } : {}), timeZone: 'UTC' });
const sourceNames: Record<DailyPlanEvent['sourceType'], string> = { payday: 'Expected pay', obligation: 'Scheduled payment', debt: 'Debt payment', expense: 'Planned spending' };

export default function Planner({ state, scope, motion, readOnly = false, initialSection, onSectionChange, onCommand, onNavigate, onOpen, onRecord }: Props) {
  const asOf = useEngineDate();
  const ownerId = scope === 'all' ? state.entities.find(entity => entity.kind === 'personal')?.id ?? 'personal' : scope;
  const [section, setSection] = useState<'plan' | 'compare' | 'setup' | 'review'>(initialSection ?? 'plan');
  const [reviewVisited, setReviewVisited] = useState(initialSection === 'review');
  const [setupVisited, setSetupVisited] = useState(initialSection === 'setup');
  const [comparisonVisited, setComparisonVisited] = useState(initialSection === 'compare');
  useEffect(()=>{setSection(initialSection??'plan');if(initialSection==='review')setReviewVisited(true);if(initialSection==='setup')setSetupVisited(true);if(initialSection==='compare')setComparisonVisited(true);},[initialSection]);
  const personal = state.entities.find(entity => entity.id === ownerId)?.kind === 'personal';
  const [range, setRange] = useState<'payday' | '7' | '30' | '90'>('payday');
  const [selectedDate, setSelectedDate] = useState('');
  const planRef = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<'all' | 'out' | 'in'>('all');
  const [editor, setEditor] = useState<{ obligation?: Obligation } | null>(null);
  const [payment, setPayment] = useState<{ obligation: Obligation; revision: number } | null>(null);
  const pending = '';
  const [reserveEditor,setReserveEditor]=useState<Reserve|null>(null);
  const [paydayReceipt,setPaydayReceipt]=useState<string|null>(()=>{const target=new URLSearchParams(window.location.hash.split('?')[1]).get('record');return target?.startsWith('payday:')?target.slice(7):null;});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showAllMissing, setShowAllMissing] = useState(false);
  const setupRef = useRef<HTMLDivElement>(null);
  const pendingSetupTarget = useRef<string | null>(null);
  const reviewRef = useRef<HTMLDetailsElement>(null);
  const engine = useEngineProject<DailyPlan>(state, ownerId, asOf, { kind: 'daily_plan', draft: { days: range === '90' ? 90 : 30 } });
  const growthEngine = useEngineProject<DailyPlan>(state, ownerId, asOf, personal ? { kind: 'daily_plan', draft: { days: 90 } } : null);
  const plan = engine.data;
  useReviewMotion(planRef, motion && section === 'plan', `${range}-${!!plan}`);
  const earlierIncome = plan ? incomeBeforePayday(plan) : undefined;
  const nextIncome = earlierIncome ?? plan?.nextPayday;
  const cashAccounts = state.accounts.filter(account => account.entityId === ownerId && account.type === 'cash');
  const reserves = state.reserves.filter(reserve => reserve.entityId === ownerId);
  const endDate = plan ? range === 'payday' ? plan.beforePayday.endDate : range === '7' ? plan.days[Math.min(6, plan.days.length - 1)]?.date ?? plan.endDate : plan.endDate : asOf;
  const rangeForecast = plan ? projectHomeCash(plan, { endDate }) : null;
  const activeDate = selectedDate >= asOf && selectedDate <= endDate ? selectedDate : '';
  const events = plan?.events.filter(event => event.date <= endDate && (!activeDate || event.effectiveDate === activeDate) && (direction === 'all' || event.direction === direction)) ?? [];
  const dates = [...new Set(events.map(event => event.date))];
  const overdue = plan?.events.filter(event => event.status === 'overdue').length ?? 0;

  function showSetup() {
    if(onSectionChange)onSectionChange('setup');else {setSetupVisited(true);setSection('setup');}
  }
  function openSetup(target?: string) {
    if (section === 'setup') focusSetup(target);
    else { pendingSetupTarget.current = target ?? ''; showSetup(); }
  }
  function focusSetup(target?: string) {
    window.requestAnimationFrame(() => {
      const element = target ? setupRef.current?.querySelector<HTMLElement>(`[data-setup="${target}"]`) : setupRef.current;
      if(element?.closest('[hidden]'))return;
      element?.scrollIntoView({ block: 'start', behavior: 'instant' });
      const control = element?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
      if (element && !control) element.tabIndex = -1;
      (control ?? element)?.focus({ preventScroll: true });
    });
  }
  function openComparison() { if(onSectionChange)onSectionChange('compare');else {setComparisonVisited(true);setSection('compare');} }
  function openReview() { if(onSectionChange)onSectionChange('review');else {setReviewVisited(true);setSection('review');} }
  function openPlan() { if(onSectionChange)onSectionChange();else setSection('plan'); }
  function reviewLabel(item: DailyPlan['missingInputs'][number]) {
    const account = state.accounts.find(row => row.id === item.sourceId);
    const obligation = state.obligations.find(row => row.id === item.sourceId);
    const expense = state.expensePlanItems?.find(row => row.id === item.sourceId);
    const purchase = state.assetPurchases?.find(row => row.id === item.sourceId);
    if (obligation) return `Review ${obligation.name}`;
    if (item.section === 'accounts') return account ? `Check ${account.name} balance` : 'Add a cash account';
    if (item.section === 'debts') return account ? `Review ${account.name} terms` : 'Review debt terms';
    if (expense) return `Review ${expense.name}`;
    if (purchase) return `Review ${purchase.name} payments`;
    return item.section === 'reserve' ? 'Set protected cash' : item.section === 'pay' ? 'Confirm pay details' : item.section === 'expenses' ? 'Set living costs' : 'Review asset details';
  }
  function fixMissing(item: DailyPlan['missingInputs'][number]) {
    const obligation = item.sourceId ? state.obligations.find(row => row.id === item.sourceId) : undefined;
    if (obligation) { if (!readOnly) setEditor({ obligation }); return; }
    if (item.field.startsWith('expensePlanItems')) { onNavigate('expenses', 'plan', item.sourceId); return; }
    if (item.section === 'reserve') { personal ? openSetup('reserve') : !readOnly && onOpen('reserve'); return; }
    if ((item.section === 'pay' || item.section === 'expenses') && personal) openSetup(item.section);
    else if (item.section === 'accounts') { if (!readOnly) item.sourceId ? onOpen('reconcile', item.sourceId) : onOpen('account'); }
    else if (item.section === 'debts') onNavigate('debts', undefined, item.sourceId);
    else if (item.section === 'assets') onNavigate('assets', undefined, item.sourceId);
    else if (item.section === 'pay') onNavigate('expenses', 'schedule');
    else onNavigate(item.section as Destination);
  }
  useEffect(()=>{const target=new URLSearchParams(window.location.hash.split('?')[1]).get('record');if(target?.startsWith('setup:')){pendingSetupTarget.current=target.slice(6);setSetupVisited(true);setSection('setup');}},[]);
  useEffect(() => {
    if (section !== 'setup' || !setupVisited || pendingSetupTarget.current === null) return;
    const target = pendingSetupTarget.current;
    pendingSetupTarget.current = null;
    focusSetup(target || undefined);
  }, [section, setupVisited]);
  function reviewMissing() {setShowAllMissing(true);window.requestAnimationFrame(()=>{if(reviewRef.current)reviewRef.current.open=true;reviewRef.current?.focus({preventScroll:true});reviewRef.current?.scrollIntoView({block:'center'});});}
  function requestPayment(obligation: Obligation) {
    if (readOnly) return;
    setError(''); setNotice('');
    setPayment({ obligation, revision: state.revision });
  }
  function eventAction(event: DailyPlanEvent) {
    if (event.sourceType === 'payday') return <button type="button" disabled={readOnly} onClick={() => onRecord('income')}>Record income<Icon name="arrow" size={14}/></button>;
    if (event.sourceType === 'debt') return <button type="button" onClick={() => onNavigate('debts',undefined,event.sourceId)}>Review debt<Icon name="arrow" size={14}/></button>;
    if (event.sourceType === 'expense') return <button type="button" onClick={() => onNavigate('expenses','plan',event.sourceId)}>Review plan<Icon name="arrow" size={14}/></button>;
    const obligation = state.obligations.find(item => item.id === event.sourceId);
    if (!obligation) return null;
    return <><button type="button" aria-label={`Edit ${event.name}`} disabled={readOnly} onClick={() => setEditor({ obligation })}>Edit</button>{!event.isProjection && <button type="button" className="planner-record" disabled={readOnly || !!pending} onClick={() => requestPayment(obligation)}>{event.direction === 'in' ? 'Record received' : 'Record paid'}</button>}</>;
  }

  return <div className="planner-workspace">
    <div className="planner-workspace-toolbar">
    <nav className="workspace-tabs" aria-label="Planner sections">
      <button type="button" aria-pressed={section === 'plan'} onClick={openPlan}><Icon name="plan" size={16}/>Your plan</button>
      <button type="button" aria-pressed={section === 'compare'} onClick={openComparison}><Icon name="simulate" size={16}/>Compare options</button>
      <button type="button" aria-pressed={section === 'setup'} onClick={showSetup}><Icon name="wallet" size={16}/>Plan setup</button>
      {section === 'review' && <button type="button" aria-pressed="true" onClick={openReview}><Icon name="activity" size={16}/>Spending review</button>}
    </nav>
    <button type="button" className="button primary" disabled={readOnly} onClick={() => setEditor({})}><Icon name="plus" size={16}/>Add bill or income</button>
    </div>
    {notice && <p className="planner-notice" role="status"><Icon name="check" size={16}/>{notice}</p>}
    {plan?.todayPayday?.receiptStatus==='unconfirmed'&&<section className="planner-setup-card"><h2>Today's pay needs confirmation</h2><p>{plan.todayPayday.amountCents===null?'An unknown amount':money(plan.todayPayday.amountCents)} is scheduled. The forecast does not add it to your recorded cash.</p><button className="button primary" disabled={readOnly} onClick={()=>setPaydayReceipt(plan.todayPayday!.date)}>Match recorded deposit</button><button className="text-button" disabled={readOnly} onClick={()=>onRecord('income')}>Record income first</button></section>}
    {error && !payment && <p className="planner-error" role="alert">{error}</p>}
    <div ref={planRef} className="planner-plan-content" hidden={section !== 'plan'}>
      {personal && <CompoundingPlan state={state} ownerId={ownerId} plan={growthEngine.data} asOf={asOf} loading={growthEngine.loading} error={growthEngine.error} onSetup={() => openSetup()} onDebts={() => onNavigate('debts')} onCompare={openComparison}/>}
      {engine.error && <div className="planner-empty" role="alert"><Icon name="info" size={24}/><h2>The plan could not be calculated</h2><p>{engine.error}</p><div><button type="button" className="button primary" onClick={engine.retry}>Retry calculation</button><button type="button" className="button secondary" onClick={() => openSetup()}>View saved setup</button></div></div>}
      {engine.loading && <div className="planner-loading" role="status"><span/><p>Checking paydays and commitments…</p></div>}
      {plan && <>
        {plan.status==='partial'&&<section className="planner-incomplete" role="status"><div><h2>Forecast incomplete</h2><p>{plan.missingInputs.length} {plan.missingInputs.length===1?'detail needs':'details need'} confirmation. The amount below includes known costs only; missing amounts may reduce it.</p></div><button type="button" className="button secondary" onClick={reviewMissing}>Review missing inputs<Icon name="arrow" size={15}/></button></section>}
        <section className={`planner-overview${plan.beforePayday.cashAfterKnownCents < 0 ? ' is-short' : ''}`} aria-label="Cash before next regular payday" data-review-panel>
          <div className="planner-balance">
            <div className="planner-eyebrow"><span className="planner-dot"/>{plan.nextPayday ? 'Before your next regular payday' : 'Until pay is confirmed'}<span className="planner-estimate">{plan.status === 'partial' ? 'Some amounts missing' : 'Forecast'}</span></div>
            <h2>{plan.beforePayday.cashAfterKnownCents < 0 ? 'Forecast cash gap' : plan.status==='partial' ? 'Cash after known costs' : 'Cash after upcoming costs'}</h2>
            <strong className="planner-big-money" data-review-value="cash-before-payday"><AnimatedValue className="planner-animated-money" value={Math.abs(plan.beforePayday.cashAfterKnownCents)}/><span>{plan.beforePayday.cashAfterKnownCents < 0 ? 'short' : 'remaining'}</span></strong>
            <p>Through {dateLabel(plan.beforePayday.endDate)}. {plan.status === 'partial' ? 'Missing amounts may increase what you need.' : 'Based on your saved schedule and living-cost estimate.'}</p>
            <details className="planner-breakdown"><summary>How this is calculated<Icon name="down" size={14}/></summary><dl>
              <div><dt>Recorded cash</dt><dd>{money(plan.cashCents)}</dd></div><div><dt>Set aside</dt><dd>−{money(plan.protectedCents)}</dd></div>
              <div><dt>Expected income before regular payday</dt><dd>+{money(plan.beforePayday.knownIncomeCents)}</dd></div><div><dt>Known costs before regular payday</dt><dd>−{money(plan.beforePayday.knownOutflowCents)}</dd></div>
            </dl><small>Account balances need to be current. This forecast does not confirm money is available to spend.</small></details>
          </div>
          <div className="planner-payday">
            <span className="planner-eyebrow"><Icon name="down" size={17}/>{earlierIncome ? 'Next expected income' : 'Next expected pay'}</span>
            <strong><AnimatedValue value={nextIncome?.amountCents ?? null} fallback="Not set"/></strong>
            <span>{nextIncome ? dateLabel(nextIncome.date, true) : 'Review your pay schedule'}</span>
            {earlierIncome && <p>{earlierIncome.name}</p>}
            <p>Expected income stays separate from cash until you record it.</p>
            <div>{earlierIncome ? eventAction(earlierIncome) : <><button type="button" onClick={() => personal ? openSetup('pay') : onNavigate('expenses', 'schedule')}>{readOnly ? 'View schedule' : 'Edit schedule'}<Icon name="arrow" size={14}/></button>{plan.nextPayday && <button type="button" disabled={readOnly} onClick={() => onRecord('income')}>Record income<Icon name="plus" size={14}/></button>}</>}</div>
          </div>
        </section>
        <div className="planner-horizon-range"><span>Look ahead</span><label className="planner-range"><span className="sr-only">Planner date range</span><select aria-label="Planner date range" value={range} onChange={event => { setRange(event.target.value as typeof range); setSelectedDate(''); }}><option value="payday">{plan.nextPayday ? 'Before next regular payday' : 'Next 30 days'}</option><option value="7">Next 7 days</option><option value="30">Next 30 days</option><option value="90">Next 90 days</option></select></label></div>
        {rangeForecast && <section className="planner-range-overview" aria-label="Selected forecast range" data-motion-enter>
          <header><span>{dateLabel(asOf)} to {dateLabel(endDate)}</span><span>{plan.status === 'partial' ? 'Known amounts only' : 'Based on saved plans'}</span></header>
          <dl>
            <div className="planner-range-income"><dt><Icon name="down" size={15}/>Expected deposits</dt><dd><AnimatedValue value={rangeForecast.incomeCents}/></dd><small>Not added to recorded cash</small></div>
            <div><dt><Icon name="wallet" size={15}/>Known costs</dt><dd><AnimatedValue value={rangeForecast.outflowCents}/></dd><small>Includes {money(rangeForecast.livingCostsCents)} planned living costs</small></div>
            <div className={rangeForecast.endingCents < 0 ? 'is-short' : ''}><dt><Icon name="plan" size={15}/>Forecast at range end</dt><dd><AnimatedValue value={rangeForecast.endingCents}/></dd><small>After costs and {money(plan.protectedCents)} set aside</small></div>
          </dl>
          {plan.status === 'partial' && <p>Unknown amounts are excluded and may reduce the forecast.</p>}
        </section>}
      </>}
        <PlannerHorizon plan={plan} loading={engine.loading} endDate={endDate} selectedDate={selectedDate} onSelect={setSelectedDate}/>
      {plan && <>
        <div className="planner-layout">
          <section className="planner-agenda" aria-label="Payments and income" data-motion-enter>
            <header className="planner-section-header"><div><h2>Coming up</h2><p>Scheduled payments and expected income.</p></div><button type="button" className="text-button" onClick={() => onNavigate('expenses', 'schedule')}>Manage bills<Icon name="arrow" size={14}/></button></header>
            {activeDate && <div className="planner-selected-date"><span>Payments for {dateLabel(activeDate, true)}</span><button type="button" className="text-button" onClick={() => setSelectedDate('')}>Show all dates<Icon name="close" size={13}/></button></div>}
            <div className="planner-agenda-toolbar"><div className="planner-filters" role="group" aria-label="Schedule direction">{(['all', 'out', 'in'] as const).map(value => <button key={value} type="button" aria-pressed={direction === value} onClick={() => setDirection(value)}>{value === 'all' ? 'All' : value === 'out' ? 'Money out' : 'Money in'}</button>)}</div><span>{events.length} {events.length === 1 ? 'entry' : 'entries'}</span></div>
            {overdue > 0 && <p className="planner-overdue-note"><Icon name="clock" size={15}/>{overdue} past {overdue === 1 ? 'date needs' : 'dates need'} review. Check whether the money already moved.</p>}
            {dates.length ? <div className="planner-event-groups">{dates.map(date => <section className="planner-day" key={date} aria-label={dateLabel(date, true)}><div className={`planner-date${date < asOf ? ' is-past' : ''}`}><time dateTime={date}><span>{date === asOf ? 'Today' : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', timeZone: 'UTC' })}</span><strong>{Number(date.slice(8))}</strong><small>{new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' })}</small></time></div><div>{events.filter(event => event.date === date).map(event => <article key={event.id} className={`planner-event is-${event.direction}`}>
              <div className="planner-event-main"><span className="planner-event-icon"><Icon name={event.direction === 'in' ? 'down' : event.sourceType === 'debt' ? 'wallet' : 'plan'} size={17}/></span><div><h3>{event.name}</h3><p>{event.sourceType === 'obligation' && event.direction === 'in' ? 'Expected income' : sourceNames[event.sourceType]}{event.isProjection ? ' · expected repeat' : ''}{event.status === 'overdue' ? ' · past date' : ''}</p></div><strong>{event.amountCents == null ? 'Amount needed' : `${event.direction === 'in' ? '+' : ''}${money(event.amountCents)}`}</strong></div>
              {event.note && <p className="planner-event-note">{event.note}</p>}
              {!event.includedInCashflow && <span className="planner-excluded">Excluded from cash forecast</span>}
              <div className="planner-event-actions">{eventAction(event)}</div>
            </article>)}</div></section>)}</div> : <div className="planner-agenda-empty"><Icon name="plan" size={28}/><h3>{direction === 'all' ? 'No saved dates in this range' : `No ${direction === 'in' ? 'income' : 'payments'} in this range`}</h3><p>{direction === 'all' ? 'Add bills as they arrive. Mazal will put them beside your paydays.' : 'Change the filter or choose a longer date range.'}</p><button type="button" className="text-button" disabled={readOnly} onClick={() => setEditor({})}>Add a bill or income<Icon name="plus" size={14}/></button></div>}
            <footer>Record a payment after it happens. A planned date does not confirm a bank payment.</footer>
          </section>
          <aside className="planner-sidebar">
            <details ref={reviewRef} className="planner-checklist" aria-label="Plan details to review" tabIndex={-1}><summary className="planner-detail-toggle"><span><strong>{plan.missingInputs.length ? `${plan.missingInputs.length} ${plan.missingInputs.length === 1 ? 'detail to confirm' : 'details to confirm'}` : 'No missing inputs'}</strong><small>{plan.missingInputs.length ? 'Review what the forecast still needs' : 'Review your saved planning details'}</small></span><Icon name="down" size={16}/></summary>{plan.missingInputs.length ? <><div>{(showAllMissing ? plan.missingInputs : plan.missingInputs.slice(0, 4)).map((item, index) => <button type="button" key={`${item.field}-${index}`} disabled={readOnly && Boolean(item.section === 'accounts' || item.sourceId && state.obligations.some(obligation => obligation.id === item.sourceId) || item.section === 'reserve' && !personal)} onClick={() => fixMissing(item)}><span className="planner-check-number">{String(index + 1).padStart(2, '0')}</span><span><strong>{reviewLabel(item)}</strong><small>{item.message}</small></span><Icon name="arrow" size={14}/></button>)}</div>{plan.missingInputs.length > 4 && <button type="button" className="text-button planner-show-details" onClick={() => setShowAllMissing(value => !value)}>{showAllMissing ? 'Show fewer details' : `Show all ${plan.missingInputs.length} details`}</button>}</> : <p>{plan.firstShortfallDate ? 'The inputs are complete, but the forecast still has a cash or payment-timing gap. Review the cash forecast below.' : 'The forecast uses your saved dates and amounts. Keep account balances current.'}</p>}</details>
            <CashTimeline plan={plan}/>
            <button type="button" className="text-button planner-balance-link" onClick={() => openSetup('accounts')}><Icon name="wallet" size={16}/>Check account balances<Icon name="arrow" size={14}/></button>
          </aside>
        </div>
        <details className="planner-method"><summary>Forecast details and past spending<Icon name="down" size={15}/></summary><p>Recorded cash, saved reserves, paydays, scheduled bills, dated debt payments, and planned expenses. Changes here do not move money at a bank.</p>{plan.warnings.map((warning, index) => <p key={index}>{warning}</p>)}<p>Calculated from saved records as of {dateLabel(plan.asOf)}. Undated and unknown amounts appear in the review list.</p><button type="button" className="text-button" onClick={openReview}>Spending review<Icon name="arrow" size={14}/></button></details>
      </>}
    </div>
    {reviewVisited && <div hidden={section !== 'review'} className="planner-spending-review"><header className="planner-review-location"><div><h2>Past spending</h2><p>Review a day, week or month of recorded activity.</p></div><button type="button" className="text-button" onClick={() => onNavigate('expenses')}>Open Expenses<Icon name="arrow" size={14}/></button></header><ReviewWorkspace state={state} scope={ownerId} asOf={asOf} motion={motion && section === 'review'} cashCents={plan?.cashCents ?? null} cashLoading={engine.loading} onCheckBalances={() => openSetup('accounts')} onForecast={days => { if (days) { setRange(String(days) as '7' | '30'); setSelectedDate(''); } openPlan(); }} onNavigate={(view, target, recordId) => {
      if (view === 'simulations') openPlan();
      else if (view === 'expenses') onNavigate('expenses', target === 'activity' || target === 'plan' || target === 'schedule' ? target : undefined, recordId);
      else if (view === 'documents') onNavigate('documents', target === 'imports' ? target : undefined, recordId);
    }}/></div>}
    {setupVisited && <div ref={setupRef} className="planner-setup" hidden={section !== 'setup'}>
      <header className="planner-section-header"><div><span className="planner-eyebrow">Plan setup</span><h2>Start with the amounts you know</h2><p>Set your pay, living costs and cash cushion.</p></div></header>
      <div className="planner-setup-grid">{personal && <><div data-setup="pay"><ExpensePay state={state} readOnly={readOnly} onCommand={onCommand}/></div><div data-setup="expenses"><LivingCosts state={state} readOnly={readOnly} onCommand={onCommand}/></div><div data-setup="reserve"><ProtectedCash state={state} readOnly={readOnly} onCommand={onCommand}/></div></>}
      <section className="planner-setup-card"><header><h3>Money set aside</h3><button type="button" className="text-button" disabled={readOnly} onClick={() => onOpen('reserve')}>Add reserve<Icon name="plus" size={14}/></button></header>{reserves.length ? <dl>{reserves.map(reserve => <div key={reserve.id}><dt>{reserve.name}</dt><dd>{money(reserve.amountCents)}{!readOnly&&<button type="button" className="text-button" onClick={()=>setReserveEditor(reserve)}>Edit or release</button>}</dd></div>)}</dl> : <p>No reserve is saved. Set an amount to keep out of the cash forecast.</p>}<small>A reserve is part of your existing cash, not an extra account balance.</small></section>
      <section className="planner-setup-card" data-setup="accounts"><header><h3>Starting cash</h3></header>{cashAccounts.length ? <div className="planner-cash-accounts">{cashAccounts.map(account => <div key={account.id}><span><strong>{account.name}</strong><small>{account.closedAt ? `Closed ${dateLabel(account.closedAt)}` : account.reconciledAt ? `Checked ${dateLabel(account.reconciledAt)}` : 'Balance not checked'}</small></span><strong>{money(account.balanceCents)}</strong><button type="button" className="text-button" disabled={readOnly} onClick={() => onOpen('reconcile', account.id)} aria-label={account.closedAt ? `Review closed account ${account.name}` : `Check balance for ${account.name}`}>{account.closedAt ? 'Review' : 'Check'}</button></div>)}</div> : <p>Add a cash account and its current balance to start the forecast.</p>}{!cashAccounts.some(account => !account.closedAt) && <>{cashAccounts.length > 0 && <p>No open cash account. Add one or reopen an account in Manage accounts.</p>}<button type="button" className="text-button" disabled={readOnly} onClick={() => onOpen('account')}>Add cash account<Icon name="plus" size={14}/></button></>}</section></div>
      <section className="planner-setup-card planner-bill-location"><div><h3>Bills and regular payments</h3><p>Manage amounts and due dates in Expenses. Your saved schedule feeds this forecast.</p></div><button type="button" className="button secondary" onClick={() => onNavigate('expenses', 'schedule')}>Manage bills<Icon name="arrow" size={15}/></button></section>
    </div>}
    {comparisonVisited && <section className="planner-scenarios" hidden={section !== 'compare'}><header className="planner-section-header"><div><span className="planner-eyebrow">Scenario drafts</span><h2>Explore debt, cash and investing</h2><p>Try different amounts and compare the results. Your saved bills and transactions stay unchanged.</p></div><button type="button" className="text-button" onClick={openPlan}>Back to your plan<Icon name="arrow" size={15}/></button></header><Suspense fallback={<p role="status">Opening comparisons…</p>}><Simulations state={state} scope={ownerId} motion={motion && section === 'compare'} onDebts={() => onNavigate('debts')}/></Suspense></section>}
    {editor && !readOnly && <BillEditor key={editor.obligation?.id ?? 'new'} state={state} scope={ownerId} obligation={editor.obligation} onCommand={onCommand} onClose={() => setEditor(null)}/>}
    {payment && !readOnly && <PaymentRecorder state={state} obligation={payment.obligation} onCommand={onCommand} onClose={()=>{setPayment(null);setError('');}}/>}
    {reserveEditor&&!readOnly&&<ReserveEditor reserve={reserveEditor} state={state} onCommand={onCommand} onClose={()=>setReserveEditor(null)}/>}
    {paydayReceipt&&!readOnly&&<PaydayReceipt paydayDate={paydayReceipt} state={state} onCommand={onCommand} onClose={()=>setPaydayReceipt(null)}/>}
  </div>;
}

function LivingCosts(props: Pick<Props, 'state' | 'readOnly' | 'onCommand'>) { return <PlanningAmount {...props}/>; }
function ProtectedCash(props: Pick<Props, 'state' | 'readOnly' | 'onCommand'>) { return <PlanningAmount {...props} reserve/>; }

function PlanningAmount({ state, onCommand, readOnly = false, reserve = false }: Pick<Props, 'state' | 'readOnly' | 'onCommand'> & { reserve?: boolean }) {
  const saved = reserve ? state.roadmap?.planningCashReserveCents : state.roadmap?.monthlyEssentialsCents;
  const title = reserve ? 'Cash to protect' : 'Monthly living costs';
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
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
  const protection = useDraftProtection({ dirty: !readOnly && editing && amount !== initial.current, busy: pending, onRequestDiscard: () => setDiscard(true) });
  const { changed, review, prepare } = useCommandDraft(state.revision);
  function edit() { if (readOnly) return; protection.requestChange(() => { review(); const amount = saved == null ? '' : String(saved / 100); initial.current = amount; setAmount(amount); setError(''); setEditing(true); }); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (readOnly || pending || changed) return;
    try {
      const cents = amount.trim() === '' ? null : parseMoneyCents(amount, { invalidMessage: 'Enter an amount with up to two decimal places.', rangeMessage: 'That amount is outside the supported range.', leadingDecimal: true, maxCents: 100_000_000_000_000 });
      setPending(true); setError('');
      await onCommand(prepare(reserve ? { type: 'update_planning_reserve', amountCents: cents } : { type: 'update_living_costs', monthlyEssentialsCents: cents })); finishEditing();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this amount.'); }
    finally { setPending(false); }
  }
  return <section ref={cardRef} className="planner-setup-card planner-living" aria-label={title}><DraftDiscardDialog open={discard} onDiscard={() => { finishEditing(); setDiscard(false); protection.discard(); }} onKeepEditing={() => { setDiscard(false); protection.keepEditing(); }}/><header><h3>{title}</h3>{!editing && <button ref={editRef} type="button" className="text-button" disabled={readOnly} onClick={edit}>{saved == null ? 'Set amount' : 'Edit'}</button>}</header>{editing && !readOnly ? <form onSubmit={save}><label>{title} · CAD<input aria-label={title} autoFocus inputMode="decimal" placeholder="Unknown" value={amount} onChange={event => setAmount(event.target.value)} disabled={pending}/></label><p>{reserve ? 'Keep at least this much cash outside your plan. Any larger total in named reserves stays protected.' : 'Include routine bills and everyday spending. Saved cash bills count toward this total. Debt payments stay separate.'}</p><small>{reserve ? 'Leave blank if undecided. Enter 0 to confirm that no extra reserve is needed.' : 'Leave blank if unknown. Enter 0 only if you have no living costs.'}</small>{changed && <div className="planner-error" role="status">Records changed while you were editing.<div><button type="button" className="text-button" onClick={() => review()}>Keep my amount</button><button type="button" className="text-button" onClick={edit}>Load saved amount</button></div></div>}{error && <p className="planner-error" role="alert">{error}</p>}<div className="planner-form-actions"><button type="button" className="button secondary" disabled={pending} onClick={() => protection.requestChange(finishEditing)}>Cancel</button><button type="submit" className="button primary" disabled={pending || changed}>{pending ? 'Saving…' : reserve ? 'Save cash reserve' : 'Save living costs'}</button></div></form> : <><strong className="planner-setup-amount">{saved == null ? 'Not set' : money(saved)}{saved != null && !reserve && <small>/ month</small>}</strong><p>{reserve ? 'A minimum cash cushion. Named reserves count toward it, so the same money is not protected twice.' : 'Routine bills and everyday spending. Missing living costs leave the cash forecast incomplete.'}</p></>}</section>;
}

function CashTimeline({ plan }: { plan: DailyPlan }) {
  const id = useId();
  const [index, setIndex] = useState(0);
  if (!plan.days.length) return null;
  const day = plan.days[Math.min(index, plan.days.length - 1)];
  const gapDay = plan.days.find(item => item.date === plan.firstShortfallDate);
  const timingGap = !!gapDay && gapDay.incomeCents > 0 && gapDay.afterProtectedCents >= 0;
  const values = [plan.cashCents - plan.protectedCents, ...plan.days.map(item => item.afterProtectedCents)];
  const low = Math.min(0, ...values), high = Math.max(1, ...values);
  const y = (value: number) => 108 - (value - low) / Math.max(1, high - low) * 90;
  const x = (offset: number) => 10 + offset / (values.length - 1) * 980;
  const points = values.map((value, offset) => `${x(offset)},${y(value)}`).join(' ');
  return <details className="planner-timeline" aria-label="Cash forecast timeline"><summary className="planner-detail-toggle"><span><strong>Cash forecast details</strong><small>Next {plan.horizonDays} days</small>{plan.firstShortfallDate && <span className="planner-timeline-warning">{timingGap ? `Check payment timing on ${dateLabel(plan.firstShortfallDate)}. Bills may leave before ${money(gapDay.incomeCents)} arrives that day.` : `Known commitments exceed unreserved cash on ${dateLabel(plan.firstShortfallDate)}.`}</span>}</span><Icon name="down" size={16}/></summary><div className="planner-timeline-heading"><div><p>Lowest before deposits {money(plan.lowestCashCents - plan.protectedCents)} on {dateLabel(plan.lowestCashDate)}.{plan.status === 'partial' ? ' Missing amounts are not fully included.' : ''}</p></div><div className={day.afterProtectedCents < 0 ? 'is-short' : ''} aria-live="polite"><strong>{money(day.afterProtectedCents)}</strong><span>{dateLabel(day.date, true)} · after money set aside</span></div></div><svg viewBox="0 0 1000 125" preserveAspectRatio="none" role="img" aria-label={`Projected cash after reserves. Lowest before deposits ${money(plan.lowestCashCents - plan.protectedCents)} on ${dateLabel(plan.lowestCashDate)}.`}><defs><linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".16"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs><line x1="10" x2="990" y1={y(0)} y2={y(0)} className="planner-zero"/><polygon points={`10,120 ${points} 990,120`} fill={`url(#${id}-fill)`}/><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/><line x1={x(index + 1)} x2={x(index + 1)} y1="8" y2="120" className="planner-selected-line"/><circle cx={x(index + 1)} cy={y(day.afterProtectedCents)} r="4" fill="currentColor"/></svg><label className="planner-timeline-slider"><span className="sr-only">Inspect cash forecast date</span><input aria-label="Inspect cash forecast date" type="range" min="0" max={plan.days.length - 1} value={index} onChange={event => setIndex(Number(event.target.value))} aria-valuetext={`${dateLabel(day.date)}, ${money(day.afterProtectedCents)} after reserves`}/></label><p className="planner-chart-note">The line shows end-of-day cash. Low points assume bills leave before income arrives that day.</p><div className="planner-timeline-dates"><span>{dateLabel(plan.asOf)}</span><span>{dateLabel(plan.endDate)}</span></div></details>;
}
