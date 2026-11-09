import { transactionLabel } from '../../../shared/transaction-label.ts';
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AppState } from '../../../shared/types.ts';
import type { SpendingCalendarProjection } from '../../../shared/engine.ts';
import { buildExpenseMonthlySummary, type ExpenseMonthlyBill } from '../../../shared/expense-monthly-summary.ts';
import { buildExpenseCategoryStory } from '../../../shared/expense-category-story.ts';
import { money } from '../../../shared/analytics.ts';
import { categoryLimits, categoryTemplateFor, normalizedCategory } from '../../../shared/expense-categories.ts';
import { shiftCalendarMonth } from '../../../shared/spending-calendar.ts';
import { useEngineDate, useEngineProject } from '../../services/useEngine.ts';
import EngineStatus from '../../components/EngineStatus.tsx';
import Icon from '../../components/Icon.tsx';
import AnimatedValue from '../../components/AnimatedValue.tsx';
import './expense-dashboard.css';

export interface ExpenseDashboardProps {
  state: AppState;
  ownerId: string;
  month: string;
  onMonth: (month: string) => void;
  onTransactions: () => void;
  onCategory: (name: string) => void;
  onTransaction: (id: string, trigger: HTMLButtonElement) => void;
  onSchedule: () => void;
  onBudget: () => void;
  readOnly: boolean;
  onBill?: (bill: ExpenseMonthlyBill) => void;
  onAddBill?: () => void;
}

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthLabel = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function ExpenseDashboard({ state, ownerId, month, onMonth, onTransactions, onCategory, onTransaction, onSchedule, onBudget, readOnly, onBill, onAddBill }: ExpenseDashboardProps) {
  const id = useId();
  const asOf = useEngineDate();
  const spending = useEngineProject<SpendingCalendarProjection>(state, ownerId, asOf, { kind: 'spending_calendar', draft: { month } });
  const data = spending.data?.data;
  const summary = spending.data?.summary;
  const coverage = spending.data?.coverage;
  const [selection, setSelection] = useState<{ month: string; date: string | null }>({ month, date: null });
  const [allEntries, setAllEntries] = useState(false);
  const [expandedBill, setExpandedBill] = useState<string | null>(null);
  const [allBills, setAllBills] = useState(false);
  const [allCategories, setAllCategories] = useState(false);
  const [categorySelection, setCategorySelection] = useState<{month: string; key: string} | null>(null);
  const bills = buildExpenseMonthlySummary(state, ownerId, month, asOf);
  const chart = useRef<HTMLDivElement>(null);
  const spendingDetails = useRef<HTMLDetailsElement>(null);
  const categoryDetail = useRef<HTMLElement>(null);
  const selectedDate = selection.month === month ? selection.date : null;
  const selectedDay = data?.days.find(day => day.date === selectedDate);
  const entries = (selectedDay ? selectedDay.entries : data?.days.flatMap(day => day.entries) ?? [])
    .slice().sort((a, b) => b.transaction.date.localeCompare(a.transaction.date) || b.transaction.createdAt.localeCompare(a.transaction.createdAt) || a.transaction.id.localeCompare(b.transaction.id));
  const reversedIds = new Set(state.transactions.flatMap(transaction => transaction.reversalOf ? [transaction.reversalOf] : []));
  const limits = categoryLimits(state, ownerId);
  const categoryByKey = new Map(limits.map(limit => [categoryTemplateFor(limit)?.key ?? `custom:${normalizedCategory(limit.name)}`, limit]));
  const categories = summary?.categories ?? [];
  const selectedCategory = categorySelection?.month === month ? categories.find(category => category.key === categorySelection.key) : undefined;
  const positiveCategories = categories.filter(category => category.totalCents > 0);
  const positiveTotal = positiveCategories.reduce((sum, category) => sum + category.totalCents, 0);
  const palette = ['#007aff', '#5e9ce6', '#64a8a1', '#af8dd1', '#d19a58', '#94a1b3'];
  const categoryColor = (key: string) => categoryByKey.get(key)?.color ?? palette[Math.max(0, categories.findIndex(category => category.key === key)) % palette.length];
  const categoryStory = data && selectedCategory ? buildExpenseCategoryStory(state, ownerId, data, selectedCategory.key) : null;
  const categoryIcons: Record<string, string> = { food: 'basket', transport: 'car', personal: 'person', digital: 'devices', subscriptions: 'repeat', bills: 'home', fees: 'coins', health: 'activity', shopping: 'bag' };
  const categoryIcon = (key: string) => categoryIcons[key] ?? 'grid';
  const currentMonth = month === asOf.slice(0, 7);
  const maxPositive = Math.max(0, ...(data?.days ?? []).map(day => day.totalCents));
  const maxNegative = Math.max(0, ...(data?.days ?? []).map(day => -day.totalCents));
  const positiveShare = maxPositive + maxNegative ? maxPositive / (maxPositive + maxNegative) * 100 : 100;
  const validDays = data?.days.filter(day => !day.isFuture) ?? [];
  const largestDay = validDays.filter(day => day.totalCents > 0).reduce<typeof validDays[number] | undefined>((largest, day) => !largest || day.totalCents > largest.totalCents ? day : largest, undefined);
  const nextBill = bills.currentBills.find(bill => bill.dueDate && (bill.status === 'overdue' || bill.status === 'scheduled'));
  const scheduledBillCount = bills.currentBills.filter(bill => bill.sourceType === 'obligation').length;
  const focusedDate = selectedDate ?? (validDays.some(day => day.date === asOf) ? asOf : validDays.at(-1)?.date);

  useEffect(() => { if (selectedCategory) categoryDetail.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' }); }, [selectedCategory?.key, month]);

  function selectCategory(key: string) {
    setCategorySelection(selectedCategory?.key === key ? null : { month, key });
    if (categories.findIndex(category => category.key === key) >= 6) setAllCategories(true);
  }
  function selectDay(date: string | null) { setSelection({ month, date }); setAllEntries(false); }
  function exploreDay(date: string) {
    selectDay(date);
    if (spendingDetails.current) spendingDetails.current.open = true;
    window.requestAnimationFrame(() => {
      const day = chart.current?.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);
      day?.focus({ preventScroll: true });
      day?.scrollIntoView?.({ block: 'nearest' });
    });
  }
  function changeMonth(value: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01' || value > asOf.slice(0, 7)) return;
    setSelection({ month: value, date: null }); setCategorySelection(null); setAllCategories(false); setAllEntries(false); onMonth(value);
  }
  function dayKey(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const index = validDays.findIndex(day => day.date === date);
    const target = event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(validDays.length - 1, index + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? validDays.length - 1 : null;
    if (target === null || !validDays[target]) return;
    event.preventDefault();
    selectDay(validDays[target].date);
    chart.current?.querySelector<HTMLButtonElement>(`[data-date="${validDays[target].date}"]`)?.focus();
  }
  function categoryRows(rows: typeof categories) {
    return rows.map(category => <li key={category.key}>
      <button type="button" className={`expense-category-row${category.totalCents < 0 ? ' is-refund' : ''}`} aria-pressed={selectedCategory?.key === category.key} onClick={() => selectCategory(category.key)} style={{ '--category-color': categoryColor(category.key) } as CSSProperties}>
        <span className="expense-category-symbol" aria-hidden="true"><Icon name={categoryIcon(category.key)} size={18}/></span>
        <span className="expense-category-copy"><span>{category.label}</span><strong>{money(category.totalCents)}</strong></span>
        <Icon name={selectedCategory?.key === category.key ? 'close' : 'arrow'} size={14}/>
      </button>
    </li>);
  }

  return <div className="expense-dashboard">
    <div className="expense-overview-grid">
      <div className="expense-overview-main">
        <section className="expense-dashboard-spending" aria-labelledby={`${id}-spending`} data-motion-enter>
          <header className="expense-dashboard-heading"><h2 id={`${id}-spending`}>{monthLabel(month)}</h2><div className="expense-dashboard-month">
            <button type="button" aria-label="Previous spending month" disabled={month <= '1900-01'} onClick={() => changeMonth(shiftCalendarMonth(month, -1))}><Icon name="down" size={15}/></button>
            <input type="month" aria-label="Spending month" min="1900-01" max={asOf.slice(0, 7)} value={month} onChange={event => changeMonth(event.target.value)}/>
            <button type="button" aria-label="Next spending month" disabled={month >= asOf.slice(0, 7)} onClick={() => changeMonth(shiftCalendarMonth(month, 1))}><Icon name="down" size={15}/></button>
          </div></header>
          <EngineStatus {...spending}/>
          {data && <>
            <div className="expense-dashboard-total"><div><span>Recorded spending</span><strong className={data.totalCents < 0 ? 'is-refund' : undefined}><AnimatedValue value={data.totalCents}/></strong></div><p>{data.transactionCount} recorded {data.transactionCount === 1 ? 'entry' : 'entries'}<span>{currentMonth ? `Through ${dateLabel(asOf)}` : 'Full calendar month'}</span></p></div>
            {!!positiveCategories.length && <div className="expense-composition" role="group" aria-label="Spending by category">{positiveCategories.map(category => <button key={category.key} type="button" aria-label={`Show ${category.label} spending, ${money(category.totalCents)}`} aria-pressed={selectedCategory?.key === category.key} title={`${category.label} · ${money(category.totalCents)}`} onClick={() => selectCategory(category.key)} style={{ '--category-color': categoryColor(category.key), flexGrow: category.totalCents / positiveTotal } as CSSProperties}/>)}</div>}
            <div className="expense-month-foot"><span>CAD · {categories.length} {categories.length === 1 ? 'category' : 'categories'}</span>{!!coverage?.accountCount && <details className="expense-dashboard-coverage"><summary><span className={`expense-coverage-dot ${coverage.status}`} aria-hidden="true"/>{coverage.status === 'complete' ? 'Statements covered' : 'Partial records'}<Icon name="info" size={13}/></summary><p>{coverage.status === 'complete' ? "Statements cover this month's posting dates. Purchases use transaction dates." : 'Recorded spending may be incomplete. Import the remaining statements to fill the gaps.'} Refunds reduce spending. Transfers and debt payments are separate. The category bar shows positive category totals.</p></details>}</div>
            {largestDay && <button type="button" className="expense-largest-day" onClick={() => exploreDay(largestDay.date)} aria-label={`Review largest recorded spending day, ${dateLabel(largestDay.date)}, ${money(largestDay.totalCents)}`}><span className="expense-largest-day-icon"><Icon name="activity" size={17}/></span><span><small>Largest recorded day</small><strong>{dateLabel(largestDay.date)}<span>{money(largestDay.totalCents)}</span></strong></span><span className="expense-largest-day-action">Review entries<Icon name="arrow" size={14}/></span></button>}
          </>}
        </section>
        <section className="expense-category-section" aria-labelledby={`${id}-categories`} data-motion-enter>
          <header className="expense-category-heading"><h2 id={`${id}-categories`}>Where it went</h2>{selectedCategory ? <button type="button" className="text-button" onClick={() => setCategorySelection(null)}>All spending <Icon name="close" size={13}/></button> : <span>Select a category</span>}</header>
          {data ? categories.length ? <>
            <ul className="expense-category-list">{categoryRows(allCategories ? categories : categories.slice(0, 6))}</ul>
            {categories.length > 6 && <button type="button" className="expense-category-more" aria-expanded={allCategories} onClick={() => setAllCategories(value => !value)}>{allCategories ? 'Show fewer categories' : `Show ${categories.length - 6} more categories`}<Icon name="down" size={13}/></button>}
            {selectedCategory && categoryStory && <section ref={categoryDetail} className="expense-category-story" aria-label={`${selectedCategory.label} spending details`} style={{ '--category-color': categoryColor(selectedCategory.key) } as CSSProperties}>
              <header><div aria-live="polite"><span>{selectedCategory.label}</span><strong className="expense-selected-total">{money(selectedCategory.totalCents)}</strong></div><span>{categoryStory.entryCount} {categoryStory.entryCount === 1 ? 'entry' : 'entries'}{selectedCategory.totalCents < 0 ? ' · Net refunds' : ''}</span></header>
              <dl className="expense-story-totals"><div><dt>Charges</dt><dd>{money(categoryStory.chargedCents)}</dd></div>{categoryStory.refundCount > 0 && <div><dt>Refunds</dt><dd className="is-refund">{money(categoryStory.refundCents)}</dd></div>}{categoryStory.correctionCount > 0 && <div><dt>Corrections</dt><dd>{money(categoryStory.correctionCents)}</dd></div>}</dl>
              {!!categoryStory.merchants.length && <><h3>Largest merchant totals</h3><ul className="expense-merchant-list">{categoryStory.merchants.slice(0, 3).map(merchant => <li key={merchant.key}><span title={merchant.name}>{merchant.name}</span><strong className={merchant.totalCents < 0 ? 'is-refund' : undefined}>{money(merchant.totalCents)}</strong></li>)}</ul></>}
              <button type="button" className="text-button" onClick={() => onCategory(categoryByKey.get(selectedCategory.key)?.name ?? selectedCategory.label)}>Review {selectedCategory.label} transactions<Icon name="arrow" size={14}/></button>
            </section>}
          </> : <div className="expense-summary-empty"><Icon name="wallet" size={28}/><h3>No spending recorded</h3><p>Choose another month or add an expense.</p></div> : <p className="expense-dashboard-empty">{spending.loading ? 'Loading categories…' : 'Categories unavailable.'}</p>}
          <footer className="expense-overview-actions"><button type="button" className="text-button" onClick={onTransactions}>Review transactions<Icon name="arrow" size={14}/></button><button type="button" className="text-button" onClick={onBudget}>Budget<Icon name="arrow" size={14}/></button></footer>
        </section>
      </div>

      <aside className="expense-recurring" aria-labelledby={`${id}-bills`} data-motion-enter>
        <header className="expense-dashboard-heading"><div><span className="expense-dashboard-eyebrow">Bills & subscriptions</span><h2 id={`${id}-bills`}>Regular payments</h2></div><Icon name="repeat" size={20}/></header>
        <p className="expense-recurring-summary"><strong>{bills.currentBills.length}</strong><span>{bills.currentBills.length === 1 ? 'regular payment' : 'regular payments'}<small>Current saved schedule</small></span></p>
        {scheduledBillCount > 0 && <div className="expense-monthly-baseline"><span>Monthly bill average</span><strong><AnimatedValue value={bills.scheduledMonthlyCents}/></strong><small>Saved recurring bills. Biweekly amounts annualized; debt payments excluded.</small></div>}
        {nextBill && <div className={`expense-next-payment${nextBill.status === 'overdue' ? ' needs-review' : ''}`}><span><Icon name="clock" size={15}/>{nextBill.status === 'overdue' ? 'Past saved payment date' : 'Next saved payment'}</span><strong>{nextBill.name}</strong><div><time dateTime={nextBill.dueDate!}>{dateLabel(nextBill.dueDate!)}</time><span>{nextBill.amountCents === null ? 'Amount needed' : money(nextBill.amountCents)}</span></div>{nextBill.status === 'overdue' && <small>Check whether this payment was made.</small>}</div>}
        <button type="button" className="button secondary expense-bills-destination" onClick={onSchedule}>Manage bills<Icon name="arrow" size={14}/></button>
        {!!bills.unscheduledCount && <div className="expense-bill-notice"><Icon name="clock" size={15}/><p>{bills.unscheduledCount} {bills.unscheduledCount === 1 ? 'schedule needs' : 'schedules need'} a date.<span>Last charges are shown until confirmed.</span></p></div>}
        <details className="expense-regular-details"><summary>Quick view<Icon name="down" size={14}/></summary>
        <div className="expense-bill-cards" id={`${id}-bill-cards`}>{bills.currentBills.slice(0, allBills ? undefined : 4).map(bill => {
          const expanded = expandedBill === bill.id;
          const detailId = `${id}-bill-${bill.id}`;
          const tone = bill.sourceType === 'debt' ? 'instalment' : /goodlife/i.test(bill.name) ? 'gym' : 'subscription';
          return <article className={`expense-bill-card ${bill.status} ${tone}${expanded ? ' is-expanded' : ''}`} key={bill.id}>
            <button type="button" className="expense-bill-disclosure" aria-label={`Show ${bill.name} details`} aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpandedBill(expanded ? null : bill.id)}>
              <span className="expense-bill-symbol" aria-hidden="true"><Icon name={tone === 'instalment' ? 'split' : tone === 'gym' ? 'activity' : 'spark'} size={21}/></span>
              <span className="expense-bill-name"><h3>{bill.name}</h3><span>{bill.sourceType === 'debt' ? 'Instalment' : bill.recurrence === 'biweekly' ? 'Every two weeks' : bill.recurrence === 'monthly' ? 'Monthly' : 'Schedule needed'}</span></span>
              <span className="expense-bill-figure"><strong>{bill.amountCents === null ? 'Not set' : money(bill.amountCents)}</strong><span>{bill.status === 'needs_schedule' ? 'Last charge' : bill.dueDate ? `${bill.status === 'overdue' ? 'Check' : 'Due'} ${dateLabel(bill.dueDate)}` : 'Date needed'}</span></span>
              <Icon name="down" size={14}/>
            </button>
            <div className="expense-bill-details" id={detailId} hidden={!expanded}>
              {bill.lastPayment && <p>Last charge <strong>{money(bill.lastPayment.amountCents)}</strong> on {dateLabel(bill.lastPayment.date)}.</p>}
              {bill.sourceType !== 'debt' && <p>{money(bill.recordedMonthCents)} recorded in {monthLabel(month)}.</p>}
              <p>{bill.status === 'needs_schedule' ? 'Confirm the amount and next date to add this bill to your schedule.' : bill.sourceType === 'debt' ? 'This is a scheduled debt payment.' : bill.dueDate ? `Next saved payment ${dateLabel(bill.dueDate)}. Record it after the payment happens.` : 'Confirm the next payment date.'}</p>
              {bill.sourceType === 'debt' ? <a className="expense-bill-card-action" href={`#debts?record=${encodeURIComponent(bill.sourceId)}`}>View payment <Icon name="arrow" size={14}/></a> : <button type="button" className="expense-bill-card-action" disabled={readOnly && bill.sourceType === 'recorded'} onClick={() => onBill ? onBill(bill) : onSchedule()}>{bill.status === 'needs_schedule' ? 'Set up bill' : 'View bill'}<Icon name="arrow" size={14}/></button>}
            </div>
          </article>;
        })}</div>
        {bills.currentBills.length > 4 && <button type="button" className="text-button expense-manage-bills" aria-expanded={allBills} aria-controls={`${id}-bill-cards`} onClick={event => { if (allBills) event.currentTarget.focus(); setAllBills(value => !value); }}>{allBills ? 'Show fewer regular payments' : `Show all ${bills.currentBills.length} regular payments`}<Icon name="down" size={14}/></button>}
        {!bills.currentBills.length && <p className="expense-dashboard-empty">Add your regular bills to see their amounts and next dates here.</p>}
        {!readOnly && <button type="button" className="expense-add-bill" onClick={onAddBill ?? onSchedule}><Icon name="plus" size={16}/>Add a recurring bill</button>}
        </details>
      </aside>
    </div>
    <details ref={spendingDetails} className="expense-spending-details" data-motion-enter><summary>Explore daily spending <Icon name="down" size={16}/></summary><div className="expense-spending-explorer">
      <section className="expense-dashboard-daily" aria-label="Daily spending details">
        {data ? <>        <div className="expense-daily-heading"><h3>Day by day</h3><span aria-live="polite">{selectedDay ? <>{dateLabel(selectedDay.date)} <strong>{money(selectedDay.totalCents)}</strong></> : 'Select a day to see its transactions'}</span></div>
        <div ref={chart} className="expense-daily-plot" role="group" aria-label="Daily spending" style={{ '--positive-share': `${positiveShare}%` } as CSSProperties}>
          <span className="expense-daily-baseline" aria-hidden="true"/>
          {data.days.map((day, index) => <button key={day.date} type="button" data-date={day.date} className={`expense-daily-column${day.isFuture ? ' is-future' : ''}${day.totalCents < 0 ? ' is-refund' : ''}`} disabled={day.isFuture} aria-pressed={selectedDate === day.date} aria-current={day.date === asOf ? 'date' : undefined} tabIndex={day.date === focusedDate ? 0 : -1} aria-label={`${dateLabel(day.date)}, ${money(day.totalCents)}${day.totalCents < 0 ? ' net refunds' : ' recorded spending'}${day.isFuture ? ', future date' : ''}`} title={`${dateLabel(day.date)} · ${money(day.totalCents)}`} onClick={() => selectDay(day.date)} onKeyDown={event => dayKey(event, day.date)}>
            <span className="expense-daily-positive"><i style={{ height: day.totalCents > 0 ? `${day.totalCents / maxPositive * 100}%` : '0%' }}/></span>
            <span className="expense-daily-negative"><i style={{ height: day.totalCents < 0 ? `${-day.totalCents / maxNegative * 100}%` : '0%' }}/></span>
            <small aria-hidden="true">{index === 0 || (index + 1) % 7 === 0 || index === data.days.length - 1 ? index + 1 : ''}</small>
          </button>)}
        </div>
<p className="expense-dashboard-note">Refunds reduce spending. Transfers, debt payments and asset payments are excluded.{data.hasWeightedExpenses ? ' Business spending uses your ownership share.' : ''}</p></> : <EngineStatus {...spending}/>}
      </section>
    <section className="expense-dashboard-recent" aria-labelledby={`${id}-recent`}>
      <header className="expense-dashboard-heading"><div><span className="expense-dashboard-eyebrow">Recorded transactions</span><h2 id={`${id}-recent`}>{selectedDay ? dateLabel(selectedDay.date) : 'Recent expenses'}</h2></div>{selectedDay ? <button type="button" className="text-button" onClick={() => selectDay(null)}>Whole month<Icon name="close" size={14}/></button> : <button type="button" className="text-button" onClick={onTransactions}>View all<Icon name="arrow" size={14}/></button>}</header>
      {data ? entries.length ? <><ul className="expense-recent-list">{entries.slice(0, selectedDay && allEntries ? entries.length : 6).map(entry => {
        const transaction = entry.transaction;
        const reversal = !!transaction.reversalOf;
        const refunded = entry.amountCents < 0 && !reversal;
        const label = reversal ? 'Reversal' : reversedIds.has(transaction.id) ? 'Reversed entry' : refunded ? 'Refund' : '';
        return <li key={transaction.id}><button type="button" data-transaction-id={transaction.id} onClick={event => onTransaction(transaction.id, event.currentTarget)} aria-label={`${readOnly ? 'View' : 'Open'} ${transactionLabel(transaction)}, ${money(entry.amountCents)}${label ? `, ${label}` : ''}`}>
          <span className={`expense-transaction-icon${refunded || reversal ? ' is-refund' : ''}`} aria-hidden="true"><Icon name={refunded || reversal ? 'arrow' : 'wallet'} size={16}/></span>
          <span className="expense-transaction-copy"><strong>{transactionLabel(transaction) || 'Expense'}</strong><small><time dateTime={transaction.date}>{dateLabel(transaction.date)}</time> · {entry.accountName}{label && <span className={refunded ? 'expense-refund-label' : undefined}> · {label}</span>}</small></span>
          <strong className={entry.amountCents < 0 ? 'is-refund' : undefined}>{money(entry.amountCents)}</strong><Icon name="arrow" size={14}/>
        </button></li>;
      })}</ul>{selectedDay && entries.length > 6 && <button type="button" className="text-button expense-dashboard-link" onClick={() => setAllEntries(value => !value)}>{allEntries ? 'Show recent entries' : `Show all ${entries.length} entries`}</button>}</> : <p className="expense-dashboard-empty">{selectedDay ? 'No expenses recorded on this day.' : 'No expenses recorded for this month.'}</p> : <p className="expense-dashboard-empty">{spending.loading ? 'Loading transactions…' : 'Transactions unavailable.'}</p>}
    </section>
    </div></details>
  </div>;
}
