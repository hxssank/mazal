import { useId, useRef, useState, type PointerEvent } from 'react';
import type { DailyPlan, DailyPlanEvent } from '../../../shared/engine.ts';
import { money } from '../../../shared/analytics.ts';
import { parseMoneyCents } from '../../../shared/money-input.ts';
import { projectHomeCash } from '../../../shared/home-cash-preview.ts';
import type { HomeNavigate } from './HomeNextUp.tsx';
import Icon from '../../components/Icon.tsx';
import './home-cash-preview.css';

interface Props {
  plan: DailyPlan | null;
  onNavigate: HomeNavigate;
  onEvent: (event: DailyPlanEvent) => void;
}

const dateLabel = (date: string, weekday = false) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { ...(weekday ? { weekday: 'short' as const } : {}), month: 'short', day: 'numeric', timeZone: 'UTC' });

export default function HomeCashPreview({ plan, onNavigate, onEvent }: Props) {
  const id = useId();
  const slider = useRef<HTMLInputElement>(null);
  const [period, setPeriod] = useState(30);
  const [selectedDate, setSelectedDate] = useState('');
  const [amount, setAmount] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  if (!plan || !plan.days.length) return null;

  const endDate = plan.days[Math.min(period, plan.days.length) - 1].date;
  const spendDate = plan.days.some(day => day.date === purchaseDate) ? purchaseDate : plan.asOf;
  let extraSpendCents = 0;
  let amountError = '';
  try {
    if (amount.trim()) extraSpendCents = parseMoneyCents(amount, { leadingDecimal: true, maxCents: 100_000_000, invalidMessage: 'Enter an amount of $0 or more, with up to two decimal places.', rangeMessage: 'Enter an amount up to $1,000,000.' });
  } catch (error) { amountError = (error as Error).message; }
  const preview = projectHomeCash(plan, { endDate, extraSpendCents, spendDate });
  const baseline = projectHomeCash(plan, { endDate });
  const index = Math.max(0, preview.days.findIndex(day => day.date === selectedDate));
  const day = preview.days[index];
  const events = plan.events.filter(event => day.eventIds.includes(event.id));
  const testing = extraSpendCents > 0 && !amountError;
  const activeSpend = testing && spendDate <= endDate;
  const values = preview.days.flatMap(row => [row.baselineCents, row.previewCents]);
  const min = Math.min(0, ...values);
  const max = Math.max(10000, ...values);
  const padding = (max - min) * .12;
  const x = (dayIndex: number) => 18 + dayIndex / Math.max(1, preview.days.length - 1) * 964;
  const y = (value: number) => 18 + (max + padding - value) / (max - min + padding * 2) * 164;
  const points = preview.days.map((row, dayIndex) => `${x(dayIndex)},${y(row.previewCents)}`).join(' ');
  const baselinePoints = preview.days.map((row, dayIndex) => `${x(dayIndex)},${y(row.baselineCents)}`).join(' ');
  const nextPayment = plan.events.filter(event => event.direction === 'out' && event.effectiveDate > day.date && event.effectiveDate <= endDate).sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate))[0];
  const select = (date: string) => { setSelectedDate(date); };
  function selectOnChart(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = ((event.clientX - bounds.left) / bounds.width * 1000 - 18) / 964;
    const next = Math.max(0, Math.min(preview.days.length - 1, Math.round(position * (preview.days.length - 1))));
    select(preview.days[next].date);
  }
  function changePeriod(days: number) {
    setPeriod(days);
    if (selectedDate > plan!.days[Math.min(days, plan!.days.length) - 1].date) setSelectedDate(plan!.days[Math.min(days, plan!.days.length) - 1].date);
  }

  return <section className="home-cash-preview" aria-labelledby={`${id}-title`} data-motion-enter>
    <header className="home-cash-heading">
      <div><span className="home-cash-eyebrow"><Icon name="activity" size={14}/>Forecast from saved records{plan.status === 'partial' && <span className="home-cash-partial">Incomplete forecast</span>}</span><h2 id={`${id}-title`}>Cash ahead</h2></div>
      <div className="home-cash-period" role="group" aria-label="Cash forecast period">{[7, 14, 30].map(days => <button key={days} type="button" aria-pressed={period === days} onClick={() => changePeriod(days)}>Next {days} days</button>)}</div>
    </header>
    <div className="home-cash-layout">
      <div className="home-cash-explorer">
        <div className="home-cash-readout">
          <div><span>{dateLabel(day.date, true)}</span><strong className={`home-cash-selected-amount${day.previewCents < 0 ? ' is-short' : ''}`}>{amountError ? 'Check amount' : money(day.previewCents)}</strong><small>{activeSpend ? 'With extra spending' : 'End of day'} · after reserves</small></div>
          <button type="button" className="home-cash-lowest" aria-label="Jump to lowest balance" aria-describedby={`${id}-low-value ${id}-low-date`} onClick={() => { select(preview.lowestDate); slider.current?.focus(); }}><span>Lowest before deposits<Icon name="arrow" size={13}/></span><strong id={`${id}-low-value`} className={preview.lowestCents < 0 ? 'is-short' : ''}>{amountError ? 'Check amount' : money(preview.lowestCents)}</strong><small id={`${id}-low-date`}>{dateLabel(preview.lowestDate)}</small></button>
        </div>
        <div className="home-cash-chart" data-preview={activeSpend || undefined}>
          <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); selectOnChart(event); }} onPointerMove={event => { if (event.buttons === 1) selectOnChart(event); }}>
            <defs><linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".24"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs>
            {[max, 0, ...(min < 0 ? [min] : [])].map((value, line) => <line key={line} x1="18" x2="982" y1={y(value)} y2={y(value)} className={value === 0 ? 'home-cash-zero' : 'home-cash-grid'}/>)}
            <polygon points={`18,196 ${points} 982,196`} fill={`url(#${id}-fill)`}/>
            {activeSpend && <polyline points={baselinePoints} className="home-cash-baseline" fill="none" vectorEffect="non-scaling-stroke"/>}
            <polyline points={points} className="home-cash-line" fill="none" vectorEffect="non-scaling-stroke"/>
            <line x1={x(index)} x2={x(index)} y1="10" y2="196" className="home-cash-cursor"/>
            <circle cx={x(index)} cy={y(day.previewCents)} r="12" className="home-cash-halo"/>
            <circle cx={x(index)} cy={y(day.previewCents)} r="4" className="home-cash-dot"/>
          </svg>
          <label className="home-cash-scrubber"><span className="sr-only">Inspect Home cash forecast date</span><input ref={slider} type="range" min="0" max={preview.days.length - 1} step="1" value={index} onChange={event => select(preview.days[Number(event.target.value)].date)} aria-label="Inspect Home cash forecast date" aria-valuetext={`${dateLabel(day.date)}, ${amountError ? 'check spending amount' : money(day.previewCents)}, end of day after reserves`}/></label>
          <div className="home-cash-chart-dates"><span>{dateLabel(plan.asOf)}</span><span>{activeSpend ? 'Solid: preview · Dashed: saved plan' : 'Drag to explore each day'}</span><span>{dateLabel(endDate)}</span></div>
        </div>
        <div className="home-cash-day-details" aria-label={`Forecast details for ${dateLabel(day.date)}`}>
          <header><h3>{dateLabel(day.date, true)}</h3>{nextPayment && <button type="button" className="text-button" onClick={() => select(nextPayment.effectiveDate)}>Next payment<Icon name="arrow" size={13}/></button>}</header>
          <div className="home-cash-day-totals"><span>Expected in <strong>{money(day.incomeCents)}</strong></span><span>Planned out <strong>{money(day.outflowCents + day.extraSpendCents)}</strong></span><span>Before deposits <strong className={day.beforeIncomeCents < 0 ? 'is-short' : ''}>{amountError ? 'Check amount' : money(day.beforeIncomeCents)}</strong></span></div>
          {events.length > 0 && <ul>{events.map(event => <li key={event.id}><button type="button" onClick={() => onEvent(event)}><i className={event.direction === 'in' ? 'is-income' : ''} aria-hidden="true"/><span><strong>{event.name}</strong><small>{event.status === 'overdue' ? `Past due ${dateLabel(event.date)} · ` : ''}{event.includedInCashflow ? event.isProjection ? 'Expected repeat' : event.direction === 'in' ? 'Expected income' : 'Scheduled payment' : 'Not included in forecast'}</small></span><strong>{event.amountCents === null ? 'Amount needed' : money(event.amountCents)}</strong><Icon name="arrow" size={13}/></button></li>)}</ul>}
          {day.livingCostsCents > 0 && <p className="home-cash-allowance"><span>Living costs allowance</span><strong>{money(day.livingCostsCents)}</strong></p>}
          {day.extraSpendCents > 0 && <p className="home-cash-allowance is-preview"><span>Extra spending preview</span><strong>{money(day.extraSpendCents)}</strong></p>}
          {!events.length && !day.livingCostsCents && !day.extraSpendCents && <p className="home-cash-empty">No saved payments or income on this date.</p>}
        </div>
      </div>
      <details className="home-cash-experiment">
        <summary><Icon name="simulate" size={18}/><span><strong id={`${id}-scenario`}>Try extra spending</strong><small>{amountError ? 'Check your preview amount' : activeSpend ? `${money(extraSpendCents)} purchase preview is active` : testing ? `Purchase on ${dateLabel(spendDate)} is outside this view` : 'See how a purchase affects your balance'}</small></span><Icon name="down" size={16}/></summary>
      <aside className="home-cash-scenario" aria-labelledby={`${id}-scenario`}>
        <p>See how a purchase changes your cash forecast.</p>
        <label className="home-cash-amount" htmlFor={`${id}-amount`}>Extra cash spending · CAD<div><span aria-hidden="true">$</span><input id={`${id}-amount`} aria-label="Extra cash spending" inputMode="decimal" placeholder="0.00" value={amount} aria-invalid={!!amountError} aria-describedby={amountError ? `${id}-amount-error` : `${id}-preview-note`} onChange={event => setAmount(event.target.value)}/></div></label>
        {amountError && <p id={`${id}-amount-error`} className="home-cash-input-error" role="alert">{amountError}</p>}
        <div className="home-cash-presets" role="group" aria-label="Try a spending amount">{[50, 100, 250].map(dollars => <button key={dollars} type="button" aria-pressed={!amountError && extraSpendCents === dollars * 100} onClick={() => setAmount(String(dollars))}>${dollars}</button>)}</div>
        <label className="home-cash-spend-date" htmlFor={`${id}-spend-date`}>Spend date<select id={`${id}-spend-date`} value={spendDate} onChange={event => { setPurchaseDate(event.target.value); if (event.target.value > endDate) setPeriod(30); select(event.target.value); }}>{plan.days.map(row => <option key={row.date} value={row.date}>{row.date === plan.asOf ? `Today · ${dateLabel(row.date)}` : dateLabel(row.date, true)}</option>)}</select></label>
        <div className="home-cash-impact" aria-live="polite" aria-atomic="true">
          {amountError ? <p>Correct the amount to see its effect.</p> : <><span>{activeSpend ? `Cash on ${dateLabel(endDate)} with this purchase` : `Cash on ${dateLabel(endDate)} after reserves`}</span><strong className={preview.endingCents < 0 ? 'is-short' : ''}>{money(preview.endingCents)}</strong>{activeSpend && <small>Saved plan {money(baseline.endingCents)} · {money(extraSpendCents)} less</small>}{testing && !activeSpend && <small>Spend date is outside this view. Choose a longer period to see its effect.</small>}</>}
        </div>
        {preview.firstShortfallDate && !amountError && <button type="button" className="home-cash-gap" onClick={() => { select(preview.firstShortfallDate!); slider.current?.focus(); }}><Icon name="info" size={15}/><span>Below reserves {dateLabel(preview.firstShortfallDate)}<small>{preview.days.find(row => row.date === preview.firstShortfallDate)?.previewCents! >= 0 ? 'Payments may leave before income arrives.' : 'Review the payments on this day.'}</small></span><Icon name="arrow" size={14}/></button>}
        <p id={`${id}-preview-note`} className="home-cash-preview-note">Additional to planned spending. This preview does not save a transaction.</p>
        <button type="button" className="text-button home-cash-reset" disabled={!amount && !purchaseDate} onClick={() => { setAmount(''); setPurchaseDate(''); }}>Reset preview</button>
      </aside>
      </details>
    </div>
    <footer className="home-cash-footnote"><p>{plan.status === 'partial' ? 'Incomplete forecast. Unknown amounts are not included.' : 'Forecast from saved balances and planned dates.'} The line shows end-of-day cash. Low points assume payments leave before deposits.</p><button type="button" className="text-button" onClick={() => onNavigate('simulations')}>{plan.missingInputs.length ? `Review ${plan.missingInputs.length} missing ${plan.missingInputs.length === 1 ? 'detail' : 'details'}` : 'Review plan'}<Icon name="arrow" size={14}/></button></footer>
  </section>;
}
