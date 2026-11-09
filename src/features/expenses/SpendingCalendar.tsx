import { transactionLabel } from '../../../shared/transaction-label.ts';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AppState } from '../../../shared/types.ts';
import { money } from '../../../shared/analytics.ts';
import { shiftCalendarMonth, type CalendarExpense, type SpendingMonthSummary } from '../../../shared/spending-calendar.ts';
import { categoryLimits, categoryTemplateFor, normalizedCategory, transactionCategoryMatcher } from '../../../shared/expense-categories.ts';
import type { SpendingCalendarProjection } from '../../../shared/engine.ts';
import { useEngineProject } from '../../services/useEngine.ts';
import EngineStatus from '../../components/EngineStatus.tsx';
import Icon from '../../components/Icon.tsx';
import './spending-calendar.css';

interface Props { state: AppState; scope: string; asOf: string; onAdd?: () => void; onTransaction?: (id: string) => void; returnFocusTo?: string | null; onFocusReturned?: () => void }

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fullDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const monthName = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortMoney = (cents: number) => Math.abs(cents) < 100000 ? money(cents) : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);

export default function SpendingCalendar({ state, scope, asOf, onAdd, onTransaction, returnFocusTo, onFocusReturned }: Props) {
  const [month, setMonth] = useState(asOf.slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(asOf);
  const [detailView, setDetailView] = useState<'month' | 'day' | 'category'>('month');
  const [categoryKey, setCategoryKey] = useState('');
  const previousAsOf = useRef(asOf);
  const grid = useRef<HTMLTableElement>(null);
  const focusDay = useRef(false);
  const details = useRef<HTMLElement>(null);
  const focusDetail = useRef<'detail' | 'summary' | null>(null);
  const summaryReturn = useRef<{ kind: 'highest' } | { kind: 'category'; key: string } | null>(null);
  const returnedFocusRequest = useRef<string | null>(null);
  const id = useId();
  const engine = useEngineProject<SpendingCalendarProjection>(state, scope, asOf, { kind: 'spending_calendar', draft: { month } });
  const previousResult = useRef<SpendingCalendarProjection | null>(null);
  if (engine.data) previousResult.current = engine.data;
  const retained = engine.data ?? previousResult.current;
  const data = retained?.data;
  const summary = retained?.summary;
  const largestCategory = Math.max(1, ...(summary?.categories ?? []).map(category => Math.abs(category.totalCents)));
  const coverage = retained?.coverage;
  const category = summary?.categories.find(item => item.key === categoryKey);
  const categoryEntries = useMemo(() => {
    if (!data || !categoryKey) return [];
    const owners = new Map(state.accounts.map(account => [account.id, account.entityId]));
    const matchers = new Map<string, ReturnType<typeof transactionCategoryMatcher>>();
    return data.days.flatMap(day => day.entries).filter(entry => {
      const owner = owners.get(entry.transaction.accountId) ?? '';
      let match = matchers.get(owner);
      if (!match) {
        match = transactionCategoryMatcher(state, owner, categoryLimits(state, owner));
        matchers.set(owner, match);
      }
      const limit = match(entry.transaction);
      return (categoryTemplateFor(limit)?.key ?? `custom:${normalizedCategory(limit.name)}`) === categoryKey;
    }).sort((a, b) => b.transaction.date.localeCompare(a.transaction.date) || b.transaction.createdAt.localeCompare(a.transaction.createdAt) || a.transaction.id.localeCompare(b.transaction.id));
  }, [data, state, categoryKey]);
  const selected = data?.days.find(day => day.date === selectedDate) ?? data?.days[0];
  const paddedDays = [...Array.from({ length: data?.firstWeekday ?? 0 }, () => null), ...(data?.days ?? [])];
  while (paddedDays.length % 7) paddedDays.push(null);
  const rows = Array.from({ length: paddedDays.length / 7 }, (_, index) => paddedDays.slice(index * 7, index * 7 + 7));

  useEffect(() => {
    const previous = previousAsOf.current;
    previousAsOf.current = asOf;
    if (asOf !== previous && selectedDate === previous && month === previous.slice(0, 7)) {
      setMonth(asOf.slice(0, 7));
      setSelectedDate(asOf);
    }
  }, [asOf, month, selectedDate]);

  useEffect(() => {
    if (!focusDay.current || !engine.data || data?.month !== month) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${selectedDate}"]`)?.focus();
    focusDay.current = false;
  }, [selectedDate, month, data, engine.data]);

  useEffect(() => {
    if (!engine.data || !focusDetail.current) return;
    let target: HTMLElement | null = null;
    if (focusDetail.current === 'summary') {
      const origin = summaryReturn.current;
      target = origin?.kind === 'highest' ? details.current?.querySelector('[data-highest-day]') ?? null
        : origin?.kind === 'category' ? [...(details.current?.querySelectorAll<HTMLButtonElement>('[data-category-key]') ?? [])].find(button => button.dataset.categoryKey === origin.key) ?? null : null;
      const disclosure = target?.closest('details');
      if (disclosure) disclosure.open = true;
    }
    (target ?? details.current?.querySelector<HTMLElement>('h3'))?.focus({ preventScroll: true });
    focusDetail.current = null;
  }, [detailView, categoryKey, selectedDate, month, engine.data]);

  useEffect(() => {
    if (engine.data && detailView === 'category' && !category) {
      if (details.current?.contains(document.activeElement)) focusDetail.current = 'summary';
      setDetailView('month');
    }
  }, [engine.data, detailView, category]);

  useEffect(() => {
    if (!returnFocusTo) { returnedFocusRequest.current = null; return; }
    if (returnedFocusRequest.current === returnFocusTo || !engine.data || data?.month !== month || detailView === 'category' && !category) return;
    const entry = [...(details.current?.querySelectorAll<HTMLButtonElement>('[data-transaction-id]') ?? [])].find(button => button.dataset.transactionId === returnFocusTo);
    const target = entry ?? details.current?.querySelector<HTMLElement>('h3');
    if (!target) return;
    target.focus({ preventScroll: true });
    returnedFocusRequest.current = returnFocusTo;
    onFocusReturned?.();
  }, [returnFocusTo, onFocusReturned, engine.data, data?.month, month, detailView, category]);

  function selectMonth(next: string, keyboard = false) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(next) || next < '0001-01' || next > '9999-12') return;
    const last = new Date(`${next}-01T12:00:00Z`);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    const dayNumber = Math.min(Number(selectedDate.slice(-2)), last.getUTCDate());
    setMonth(next);
    setSelectedDate(next === asOf.slice(0, 7) && !keyboard ? asOf : `${next}-${String(dayNumber).padStart(2, '0')}`);
    setDetailView(keyboard ? 'day' : 'month');
    summaryReturn.current = null;
    focusDay.current = keyboard;
  }
  function changeMonth(offset: number, keyboard = false) { selectMonth(shiftCalendarMonth(month, offset), keyboard); }

  function handleDayKey(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      changeMonth(event.key === 'PageUp' ? -1 : 1, true);
      return;
    }
    const value = new Date(`${date}T12:00:00Z`);
    const weekday = (value.getUTCDay() + 6) % 7;
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
    if (!(event.key in offsets)) return;
    event.preventDefault();
    value.setUTCDate(value.getUTCDate() + offsets[event.key]);
    const next = value.toISOString().slice(0, 10);
    if (next < '0001-01-01' || next > '9999-12-31') return;
    setMonth(next.slice(0, 7));
    setSelectedDate(next);
    setDetailView('day');
    focusDay.current = true;
  }

  function chooseDay(date: string, fromSummary = false) {
    setSelectedDate(date); setDetailView('day');
    summaryReturn.current = fromSummary ? { kind: 'highest' } : null;
    if (fromSummary) focusDetail.current = 'detail';
  }
  function goToday() { setMonth(asOf.slice(0, 7)); chooseDay(asOf); }
  function showMonthSummary() { setDetailView('month'); focusDetail.current = 'summary'; }
  function chooseCategory(key: string) {
    setCategoryKey(key); setDetailView('category');
    summaryReturn.current = { kind: 'category', key };
    focusDetail.current = 'detail';
  }
  function categoryRows(categories: SpendingMonthSummary['categories']) {
    return categories.map(category => <li key={category.key}><button type="button" className="spend-calendar-category-choice" data-category-key={category.key} onClick={() => chooseCategory(category.key)} aria-label={`View ${category.label} expenses for ${monthName(month)}, ${money(category.totalCents)}`}>
      <span className="spend-calendar-category-label"><span>{category.label}</span><strong>{money(category.totalCents)}</strong><Icon name="arrow" size={13}/></span>
      <span className={`spend-calendar-category-bar${category.totalCents < 0 ? ' is-refund' : ''}`} aria-hidden="true"><span style={{ width: `${Math.abs(category.totalCents) / largestCategory * 100}%` }}/></span>
    </button></li>);
  }
  function entriesList(entries: CalendarExpense[], showDate = false) {
    return <ul className={`spend-calendar-entries${showDate ? ' is-month-list' : ''}`} aria-label={showDate ? `${category?.label ?? 'Category'} expenses` : undefined} tabIndex={showDate ? 0 : undefined}>{entries.map(entry => {
      const content = <><span className="spend-calendar-entry-copy"><strong>{transactionLabel(entry.transaction)}</strong>{showDate && <time dateTime={entry.transaction.date}>{fullDate(entry.transaction.date)}</time>}<span>{!showDate && `${(entry.transaction.expenseCategory ?? entry.transaction.category) || 'Uncategorized'} · `}{entry.accountName}</span>{scope === 'all' && entry.ownerName && state.entities.length > 1 && <span>{entry.ownerName}</span>}{entry.ownershipBps !== 10000 && <span>{entry.ownershipBps / 100}% of {money(entry.recordedAmountCents)}</span>}</span><span className="spend-calendar-entry-value"><strong>{money(entry.amountCents)}</strong>{onTransaction && <Icon name="arrow" size={13}/>}</span></>;
      return <li key={entry.transaction.id} className={onTransaction ? 'is-actionable' : undefined}>{onTransaction ? <button type="button" className="spend-calendar-entry-button" data-transaction-id={entry.transaction.id} onClick={() => onTransaction(entry.transaction.id)} aria-label={`View record for ${transactionLabel(entry.transaction)}, ${fullDate(entry.transaction.date)}, ${money(entry.amountCents)}`}>{content}</button> : content}</li>;
    })}</ul>;
  }

  return <section className="spend-calendar" aria-labelledby={`${id}-title`}>
    <header className="spend-calendar-heading">
      <div><h2 id={`${id}-title`}>Spending calendar</h2><p>Choose a day or category to see its expenses.</p></div>
      {onAdd && <button type="button" className="button secondary" onClick={onAdd}><Icon name="plus" size={15}/>Add expense</button>}
    </header>
    <EngineStatus {...engine}/>
    {data && summary && coverage && selected && <div className="spend-calendar-body" aria-busy={!engine.data}>
      <div className="spend-calendar-month">
        <div className="spend-calendar-toolbar">
          <div className="spend-calendar-navigation"><button type="button" aria-label="Previous month" disabled={month === '0001-01'} onClick={() => changeMonth(-1)}><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m12 4-6 6 6 6"/></svg></button><h3 id={`${id}-month`} className="sr-only">{monthName(month)}</h3><input type="month" className="spend-calendar-month-picker" aria-label="Calendar month" min="0001-01" max="9999-12" value={month} onChange={event => selectMonth(event.target.value)}/><button type="button" aria-label="Next month" disabled={month === '9999-12'} onClick={() => changeMonth(1)}><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m8 4 6 6-6 6"/></svg></button></div>
          <button type="button" className="spend-calendar-today" onClick={goToday}>Today</button>
        </div>
        <div className="spend-calendar-month-records" hidden={!engine.data}>
        <div className="spend-calendar-month-total"><span>{month > asOf.slice(0, 7) ? 'No recorded spending yet' : 'Recorded spending'}</span><strong>{money(data.totalCents)}</strong><span>{data.transactionCount} {data.transactionCount === 1 ? 'expense' : 'expenses'} · CAD</span></div>
        {coverage.accountCount>0&&<p className="source-coverage">{coverage.status==='complete'?`Statements cover this month's posting dates for all ${coverage.accountCount} recorded spending accounts. Purchases use transaction dates.`:coverage.status==='partial'?'Statement coverage is partial for these accounts. Recorded spending may be incomplete.':'No statement covers this month for these accounts. Recorded spending is incomplete.'}</p>}
        <table ref={grid} className="spend-calendar-grid" role="grid" aria-labelledby={`${id}-month`}>
          <thead><tr>{weekdays.map(day => <th key={day} scope="col"><abbr title={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekdays.indexOf(day)]}>{day}</abbr></th>)}</tr></thead>
          <tbody>{rows.map((week, index) => <tr key={index}>{week.map((day, column) => <td key={day?.date ?? `empty-${column}`} className={day ? '' : 'spend-calendar-spacer'}>{day && <button type="button" data-date={day.date} tabIndex={day.date === selected.date ? 0 : -1} aria-pressed={detailView === 'day' && day.date === selected.date} aria-current={day.date === asOf ? 'date' : undefined} aria-label={`${fullDate(day.date)}. ${day.isFuture ? 'Future date.' : `${money(day.totalCents)} spent. ${day.entries.length} ${day.entries.length === 1 ? 'expense' : 'expenses'}.`}`} onClick={() => chooseDay(day.date)} onKeyDown={event => handleDayKey(event, day.date)} className={`spend-calendar-day${detailView === 'day' && day.date === selected.date ? ' is-selected' : ''}${day.date === asOf ? ' is-today' : ''}${day.isFuture ? ' is-future' : ''}${day.entries.length ? ' has-expenses' : ''}`} style={{ '--day-intensity': data.largestDayCents > 0 && day.totalCents > 0 ? (0.035 + day.totalCents / data.largestDayCents * 0.115).toFixed(3) : 0 } as CSSProperties}>
            <span className="spend-calendar-number">{Number(day.date.slice(-2))}</span>
            <span className="spend-calendar-amount" title={day.isFuture ? 'Future date' : money(day.totalCents)}>{day.isFuture ? '' : day.entries.length ? <><span className="spend-calendar-exact">{money(day.totalCents)}</span><span className="spend-calendar-compact">{shortMoney(day.totalCents)}</span></> : '—'}</span>
            <span className="spend-calendar-entry-dot" aria-hidden="true"/>
          </button>}</td>)}</tr>)}</tbody>
        </table>
        <div className="spend-calendar-footnote"><span>Expenses include interest and subtract refunds. Card payments and transfers are excluded.</span>{data.hasWeightedExpenses && <span>Business expenses use your ownership share.</span>}<span className="spend-calendar-rounding">Select a day for exact amounts.</span></div>
        </div>
      </div>
      <aside ref={details} className="spend-calendar-details" aria-labelledby={`${id}-detail`} hidden={!engine.data}>
        {detailView === 'month' ? <div className="spend-calendar-summary">
          <header><span className="spend-calendar-day-label">Month summary</span><h3 id={`${id}-detail`} tabIndex={-1}>{monthName(month)}</h3><strong className="spend-calendar-summary-total" aria-live="polite">{money(data.totalCents)}</strong><span className="spend-calendar-day-count">{data.transactionCount} {data.transactionCount === 1 ? 'expense' : 'expenses'}{month === asOf.slice(0, 7) ? ` · through ${Number(asOf.slice(-2))} ${new Date(`${asOf}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' })}` : ' · recorded'}</span></header>
          {data.transactionCount > 0 ? <>
            <div className="spend-calendar-summary-facts"><div><span>Days with expenses</span><strong>{summary.daysWithExpenses}</strong></div>{summary.highestDay && <button type="button" data-highest-day onClick={() => chooseDay(summary.highestDay!.date, true)} aria-label={`View highest spending day, ${fullDate(summary.highestDay.date)}`}><span>Highest spending day</span><strong>{money(summary.highestDay.totalCents)}</strong><small>{new Date(`${summary.highestDay.date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' })}<Icon name="arrow" size={13}/></small></button>}</div>
            <section className="spend-calendar-category-summary" aria-label="Spending by category"><h4>By category</h4><ul>{categoryRows(summary.categories.slice(0, 4))}</ul>{summary.categories.length > 4 && <details><summary>{summary.categories.length - 4} more categories</summary><ul>{categoryRows(summary.categories.slice(4))}</ul></details>}</section>
          </> : <div className="spend-calendar-empty"><p>{month > asOf.slice(0, 7) ? 'Expenses will appear here when they are recorded.' : 'No expenses recorded for this month.'}</p></div>}
        </div> : <>
          <button type="button" className="spend-calendar-summary-back" onClick={showMonthSummary}><span aria-hidden="true">←</span>Month summary</button>
        {detailView === 'category' && category ? <>
          <header><span className="spend-calendar-day-label">{monthName(month)}</span><h3 id={`${id}-detail`} tabIndex={-1}>{category.label}</h3><strong className="spend-calendar-selected-total" aria-live="polite">{money(category.totalCents)}</strong><span className="spend-calendar-day-count">{categoryEntries.length} {categoryEntries.length === 1 ? 'expense' : 'expenses'} · CAD</span></header>
          {entriesList(categoryEntries, true)}
        </> : <>
        <header><span className="spend-calendar-day-label">{selected.date === asOf ? 'Today' : new Date(`${selected.date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', timeZone: 'UTC' })}</span><h3 id={`${id}-detail`} tabIndex={-1}>{new Date(`${selected.date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', timeZone: 'UTC' })}</h3><strong className="spend-calendar-selected-total" aria-live="polite">{selected.isFuture ? 'Not yet' : money(selected.totalCents)}</strong><span className="spend-calendar-day-count">{selected.isFuture ? 'Future date' : `${selected.entries.length} ${selected.entries.length === 1 ? 'expense' : 'expenses'}`}</span></header>
        {selected.entries.length ? entriesList(selected.entries) : <div className="spend-calendar-empty"><svg viewBox="0 0 36 36" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true"><rect x="6" y="9" width="24" height="22" rx="3"/><path d="M6 16h24M12 5v8M24 5v8M13 22h10M13 26h6"/></svg><p>{selected.isFuture ? 'Spending appears here after it is recorded for this date.' : 'No expenses recorded for this day.'}</p></div>}
        </>}
        </>}
      </aside>
    </div>}
  </section>;
}
