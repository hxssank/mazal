import { transactionLabel } from '../../../shared/transaction-label.ts';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AppState } from '../../../shared/types.ts';
import { money } from '../../../shared/analytics.ts';
import { buildReviewPeriod, type ReviewCadence } from '../../../shared/review-period.ts';
import type { HomeNavigate } from '../home/HomeNextUp.tsx';
import Icon from '../../components/Icon.tsx';
import useReviewMotion from '../../hooks/useReviewMotion.ts';
import './review-workspace.css';

interface Props {
  state: AppState;
  scope: string;
  asOf: string;
  motion: boolean;
  cashCents: number | null;
  cashLoading?: boolean;
  onNavigate: HomeNavigate;
  onCheckBalances: () => void;
  onForecast: (days?: 7 | 30) => void;
}
interface Selection { cadence: ReviewCadence; offset: number; day: string; category: string }
const initial: Selection = { cadence: 'weekly', offset: 0, day: '', category: '' };
const cadences: { value: ReviewCadence; label: string; icon: string }[] = [
  { value: 'daily', label: 'Daily', icon: 'overview' },
  { value: 'weekly', label: 'Weekly', icon: 'activity' },
  { value: 'monthly', label: 'Monthly', icon: 'plan' },
];
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const rangeLabel = (start: string, end: string) => start === end ? dateLabel(start) : `${shortDate(start)} to ${dateLabel(end)}`;

function savedSelection(key: string): Selection {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (saved && cadences.some(item => item.value === saved.cadence) && Number.isInteger(saved.offset) && saved.offset <= 0 && saved.offset >= -120) {
      return { cadence: saved.cadence, offset: saved.offset, day: typeof saved.day === 'string' ? saved.day : '', category: typeof saved.category === 'string' ? saved.category : '' };
    }
  } catch { /* Review controls work when browser storage is unavailable. */ }
  return initial;
}

export default function ReviewWorkspace({ state, scope, asOf, motion, cashCents, cashLoading = false, onNavigate, onCheckBalances, onForecast }: Props) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const storageKey = `mazal.review.${state.workspace}.${scope}`;
  const [selection, setSelection] = useState<Selection>(() => savedSelection(storageKey));
  const [showCategories, setShowCategories] = useState(false);
  const [visibleRecords, setVisibleRecords] = useState(5);
  const { cadence, offset } = selection;
  const review = useMemo(() => buildReviewPeriod(state, scope, asOf, cadence, offset), [state, scope, asOf, cadence, offset]);
  const selectedDay = review.days.some(day => day.date === selection.day && !day.isFuture) ? selection.day : '';
  const selectedCategory = review.categories.find(category => category.key === selection.category);
  const activity = review.activity.filter(item => (!selectedDay || item.transaction.date === selectedDay) && (!selectedCategory || item.categoryKey === selectedCategory.key));
  const heading = cadence === 'daily' ? offset === 0 ? 'Today at a glance' : 'Your day in review' : cadence === 'weekly' ? 'Your week in review' : 'Your month in review';
  const periodUnit = cadence === 'daily' ? 'day' : cadence === 'weekly' ? 'week' : 'month';
  const currentLabel = cadence === 'daily' ? 'Today' : cadence === 'weekly' ? 'This week' : 'This month';
  const positiveMax = Math.max(0, ...review.days.map(day => day.expensesCents));
  const negativeMax = Math.max(0, ...review.days.map(day => -day.expensesCents));
  const hasRefundDay = negativeMax > 0;
  const chartRange = Math.max(1, positiveMax + negativeMax);
  const refundHeight = negativeMax / chartRange * 105;
  const chartFocusDay = selectedDay || review.days.filter(day => !day.isFuture).at(-1)?.date;
  const categoryMax = Math.max(1, ...review.categories.map(category => Math.abs(category.totalCents)));
  const previousHasSpending = review.previous.expenseCount > 0;
  const delta = review.expenseDifferenceCents;
  const previousDayCount = Math.round((Date.parse(`${review.previous.through}T12:00:00Z`) - Date.parse(`${review.previous.start}T12:00:00Z`)) / 86_400_000) + 1;
  const comparison = previousHasSpending ? delta === 0 ? 'Same recorded spending' : `${money(Math.abs(delta))} ${delta > 0 ? 'more' : 'less'} recorded` : 'No expenses recorded in the comparison period';
  useReviewMotion(root, motion, `${cadence}-${review.start}`);
  useEffect(() => { try { window.sessionStorage.setItem(storageKey, JSON.stringify(selection)); } catch { /* Session storage is optional. */ } }, [storageKey, selection]);

  function changePeriod(nextCadence: ReviewCadence, nextOffset: number) {
    setSelection({ cadence: nextCadence, offset: nextOffset, day: '', category: '' });
    setVisibleRecords(5);
    setShowCategories(false);
  }
  function selectDay(day: string) {
    setSelection(current => ({ ...current, day: current.day === day ? '' : day }));
    setVisibleRecords(5);
  }
  function selectCategory(key: string) {
    setSelection(current => ({ ...current, category: current.category === key ? '' : key }));
    setVisibleRecords(5);
  }
  const accountIds = new Set(state.accounts.filter(account => scope === 'all' || account.entityId === scope).map(account => account.id));
  const staged = (state.importBatches ?? []).filter(batch => batch.status === 'staged' && accountIds.has(batch.source.accountId)).length;
  const actions = cadence === 'daily' ? [
    { icon: 'wallet', title: 'Check account balances', detail: 'Compare saved balances with your bank', run: onCheckBalances },
    { icon: 'plan', title: 'Check upcoming payments', detail: 'See cash after planned payments', run: () => onForecast() },
    { icon: 'plus', title: 'Review recent records', detail: 'Check purchases and deposits', run: () => onNavigate('expenses', 'activity') },
  ] : cadence === 'weekly' ? [
    { icon: 'grid', title: 'Review uncategorized expenses', detail: `${review.uncategorizedCount} in the selected week · opens the full review queue`, run: () => onNavigate('expenses', 'activity', 'categories') },
    { icon: 'plan', title: 'Plan the next 7 days', detail: 'Check payment dates and expected income', run: () => onForecast(7) },
    { icon: 'wallet', title: 'Check account balances', detail: 'Resolve any difference with your bank', run: onCheckBalances },
  ] : [
    { icon: 'grid', title: 'Review your budget', detail: 'Compare plans with recorded spending', run: () => onNavigate('expenses', 'plan') },
    { icon: 'upload', title: 'Review statements', detail: staged ? `${staged} waiting to be added` : 'Check records against your statements', run: () => onNavigate('documents', 'imports') },
    { icon: 'plan', title: 'Plan the next month', detail: 'Review recurring bills and cash needs', run: () => onForecast(30) },
  ];

  return <section ref={root} className="home-review-workspace" aria-label="Spending review" data-cadence={cadence}>
    <div className="review-toolbar">
      <div className="review-cadence" role="group" aria-label="Review period">
        <span className="review-cadence-indicator" aria-hidden="true" style={{ '--cadence-index': cadences.findIndex(item => item.value === cadence) } as CSSProperties}/>
        {cadences.map(item => <button type="button" key={item.value} aria-pressed={cadence === item.value} onClick={() => changePeriod(item.value, 0)}><Icon name={item.icon} size={15}/>{item.label}</button>)}
      </div>
      <div className="review-period-controls">
        <button type="button" aria-label={`Previous review ${periodUnit}`} disabled={offset <= -120} onClick={() => changePeriod(cadence, offset - 1)}><Icon name="down" size={15}/></button>
        <span aria-live="polite" aria-atomic="true">{review.label}</span>
        <button type="button" aria-label={`Next review ${periodUnit}`} disabled={offset === 0} onClick={() => changePeriod(cadence, Math.min(0, offset + 1))}><Icon name="down" size={15}/></button>
        {offset !== 0 && <button type="button" className="review-return" onClick={() => changePeriod(cadence, 0)}>{currentLabel}</button>}
      </div>
    </div>

    <div className="review-main-grid">
      <section className="review-panel review-spending" data-review-panel aria-labelledby={`${id}-title`}>
        <header className="review-panel-heading"><div><span className="review-eyebrow">{review.isComplete ? 'Recorded activity' : `Recorded through ${shortDate(review.through)}`}</span><h2 id={`${id}-title`}>{heading}</h2></div><span className="review-period-badge">{review.elapsedDays} / {review.dayCount} {review.dayCount === 1 ? 'day' : 'days'}</span></header>
        <div className="review-totals">
          <div className="review-primary-total"><span>{review.expensesCents < 0 ? 'Refunds & corrections' : review.refundsCents > 0 ? 'Spent after credits' : 'Spent'}</span><strong data-review-value="spending">{money(review.expensesCents)}</strong><span>{review.expenseCount ? `${review.expenseCount} expense ${review.expenseCount === 1 ? 'record' : 'records'}` : 'No expenses recorded'}</span></div>
          <div className="review-income-total"><span><i/>Income recorded</span><strong data-review-value="income">{money(review.incomeCents)}</strong><span>{review.incomeCount ? `${review.incomeCount} income ${review.incomeCount === 1 ? 'record' : 'records'}` : 'No income recorded'}</span></div>
        </div>
        <div className={`review-comparison${previousHasSpending && delta < 0 ? ' is-lower' : ''}`}><Icon name={delta > 0 ? 'invest' : 'activity'} size={15}/><span>{comparison}<small>{rangeLabel(review.previous.start, review.previous.through)}{!review.isComplete && cadence !== 'daily' ? previousDayCount === review.elapsedDays ? ' · matching days' : ' · shorter previous period' : ''}</small></span></div>
        {cadence === 'daily' ? <div className="review-day-comparison" aria-label="Recorded daily spending comparison">
          {[{ label: shortDate(review.previous.start), value: review.previous.expensesCents }, { label: offset === 0 ? 'Today' : shortDate(review.start), value: review.expensesCents }].map((item, index) => <div key={index} className={item.value < 0 ? 'is-refund' : undefined}><span>{item.label}</span><div><i data-review-meter style={{ width: `${Math.abs(item.value) / Math.max(1, Math.abs(review.expensesCents), Math.abs(review.previous.expensesCents)) * 100}%` }}/></div><strong>{money(item.value)}{item.value < 0 && <small>Net expense credit</small>}</strong></div>)}
        </div> : <>
          <div className={`review-chart${hasRefundDay ? ' has-refunds' : ''}`} role="group" aria-label="Spending by day. Select a day to filter activity." style={{ '--refund-height': `${refundHeight}px` } as CSSProperties}>
            {review.days.map((day, index) => <button type="button" key={day.date} className={`review-chart-day${day.isFuture ? ' is-future' : ''}${day.expensesCents < 0 ? ' is-refund' : ''}${day.date === asOf ? ' is-today' : ''}`} disabled={day.isFuture} tabIndex={day.date === chartFocusDay ? 0 : -1} aria-pressed={selectedDay === day.date} aria-label={`${dateLabel(day.date)}: ${money(day.expensesCents)} recorded spending${day.isFuture ? ', future date' : ''}`} title={`${shortDate(day.date)} · ${money(day.expensesCents)}`} onClick={() => selectDay(day.date)} onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const last = review.days.filter(item => !item.isFuture).length - 1;
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, index + (event.key === 'ArrowRight' ? 1 : -1)));
              setSelection(current => ({ ...current, day: review.days[next].date }));
              setVisibleRecords(5);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
            }} style={{ '--bar-size': `${Math.abs(day.expensesCents) / chartRange * 105}px`, '--bar-index': index } as CSSProperties}><span className="review-chart-column"><i data-review-bar/></span><span className="review-chart-label">{cadence === 'weekly' ? new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', timeZone: 'UTC' }) : index === 0 || (index + 1) % 5 === 0 || index === review.days.length - 1 ? Number(day.date.slice(-2)) : ''}</span></button>)}
          </div>
          <div className="review-chart-caption"><span>{selectedDay ? `Showing ${shortDate(selectedDay)}` : 'Select a day to see its records'}</span><span>{hasRefundDay ? 'Credits below the line' : 'Net recorded spending'}</span></div>
        </>}
        <p className="review-record-note">{review.hasWeightedAmounts ? 'Includes your ownership share. ' : ''}Saved records may be incomplete. Transfers and debt payments are excluded from spending.</p>
      </section>

      <aside className="review-panel review-routine" data-review-panel aria-labelledby={`${id}-routine`}>
        <div className="review-cash-now"><span><Icon name="wallet" size={15}/>Saved cash now</span><strong data-review-value="cash">{cashCents === null ? cashLoading ? 'Checking balances' : 'Unavailable' : money(cashCents)}</strong><small>Before upcoming payments</small></div>
        <header className="review-routine-heading"><h2 id={`${id}-routine`}>{cadence === 'daily' ? 'Your daily check' : cadence === 'weekly' ? 'Your weekly review' : 'Your monthly review'}</h2><Icon name="check" size={16}/></header>
        <div className="review-routine-actions">{actions.map(action => <button type="button" key={action.title} onClick={action.run}><span className="review-action-icon"><Icon name={action.icon} size={16}/></span><span><strong>{action.title}</strong><small>{action.detail}</small></span><Icon name="arrow" size={15}/></button>)}</div>
      </aside>
    </div>

    <div className="review-detail-grid">
      <section className="review-panel review-categories" data-review-panel aria-labelledby={`${id}-categories`}>
        <header className="review-panel-heading"><h3 id={`${id}-categories`}>Where it went</h3><span>{review.categories.length} {review.categories.length === 1 ? 'category' : 'categories'}</span></header>
        {review.categories.length ? <><div className="review-category-list">{review.categories.slice(0, showCategories ? undefined : 4).map(category => <button type="button" key={category.key} className={category.totalCents < 0 ? 'is-refund' : undefined} aria-pressed={selectedCategory?.key === category.key} onClick={() => selectCategory(category.key)} style={{ '--review-category': category.color } as CSSProperties}><span className="review-category-label"><i/>{category.label}{category.totalCents < 0 && <small>Net expense credit</small>}<strong>{money(category.totalCents)}</strong></span><span className="review-category-track"><i data-review-meter style={{ width: `${Math.abs(category.totalCents) / categoryMax * 100}%` }}/></span></button>)}</div>{review.categories.length > 4 && <button type="button" className="review-text-button" aria-expanded={showCategories} onClick={() => setShowCategories(value => !value)}>{showCategories ? 'Show fewer categories' : `Show all ${review.categories.length} categories`}<Icon name="down" size={14}/></button>}</> : <div className="review-empty"><Icon name="basket" size={24}/><p>No expenses recorded for this {periodUnit}.</p><button type="button" className="review-text-button" onClick={() => onNavigate('expenses', 'activity')}>Open expense records<Icon name="arrow" size={14}/></button></div>}
      </section>
      <section className="review-panel review-activity" data-review-panel aria-labelledby={`${id}-activity`}>
        <header className="review-panel-heading"><h3 id={`${id}-activity`}>{selectedCategory ? selectedCategory.label : selectedDay ? shortDate(selectedDay) : 'Recorded activity'}</h3><span aria-live="polite">{activity.length} {activity.length === 1 ? 'record' : 'records'}</span></header>
        {(selectedDay || selectedCategory) && <div className="review-filter-summary"><span>{[selectedDay && shortDate(selectedDay), selectedCategory?.label].filter(Boolean).join(' · ')}</span><button type="button" onClick={() => { setSelection(current => ({ ...current, day: '', category: '' })); setVisibleRecords(5); }}>Clear filters<Icon name="close" size={12}/></button></div>}
        {activity.length ? <ul className="review-activity-list">{activity.slice(0, visibleRecords).map(item => <li key={item.transaction.id}><div className={`review-activity-symbol${item.transaction.kind === 'income' && item.amountCents > 0 || item.transaction.kind === 'expense' && item.amountCents < 0 ? ' is-income' : ''}`}><Icon name={item.transaction.kind === 'income' ? 'coins' : item.transaction.kind === 'expense' ? 'bag' : 'split'} size={16}/></div><div><strong>{transactionLabel(item.transaction) || 'Recorded transaction'}</strong><small>{shortDate(item.transaction.date)} · {item.transaction.reversalOf ? 'Correction · ' : ''}{item.categoryLabel ?? item.transaction.kind.replaceAll('_', ' ')} · {item.accountName}</small></div><span className={item.transaction.kind === 'income' && item.amountCents > 0 || item.transaction.kind === 'expense' && item.amountCents < 0 ? 'is-income' : ''}>{item.transaction.kind === 'income' && item.amountCents > 0 ? '+' : ''}{money(item.amountCents)}{item.ownershipBps !== 10000 && (item.transaction.kind === 'income' || item.transaction.kind === 'expense') && <small>Your share</small>}</span></li>)}</ul> : <p className="review-activity-empty">{selectedDay || selectedCategory ? 'No records match these filters.' : `No activity recorded for this ${periodUnit}.`}</p>}
        <footer className="review-activity-footer">{activity.length > visibleRecords && <button type="button" className="review-text-button" onClick={() => setVisibleRecords(count => count + 5)}>Show more records<Icon name="down" size={14}/></button>}<button type="button" className="review-text-button" onClick={() => onNavigate('expenses', 'activity')}>Open full activity<Icon name="arrow" size={14}/></button></footer>
      </section>
    </div>
  </section>;
}
