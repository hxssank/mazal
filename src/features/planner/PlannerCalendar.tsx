import { useId, useMemo } from 'react';
import type { EnginePlannerResult, EnginePlannerDay } from '../../../shared/engine';
import { money } from '../../../shared/analytics';

export const plannerDate = (date: string, short = false) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: short ? undefined : 'short', month: 'short', day: 'numeric', year: short ? undefined : 'numeric', timeZone: 'UTC' });
const monthName = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const compact = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);

interface Props { result: EnginePlannerResult; selected: EnginePlannerDay; onSelect: (dayIndex: number) => void; cashLabel?: string }
export default function PlannerCalendar({ result, selected, onSelect, cashLabel = 'Cash' }: Props) {
  const id = useId();
  const cashMode = result.surplusDestination === 'cash';
  const tabbableDayIndex = selected.dayIndex < 0 ? result.days[0]?.dayIndex : selected.dayIndex;
  const byMonth = useMemo(() => {
    const grouped = new Map<string, EnginePlannerDay[]>();
    for (const day of result.days) { const key = day.date.slice(0, 7); const month = grouped.get(key) ?? []; month.push(day); grouped.set(key, month); }
    return grouped;
  }, [result]);
  const milestones = new Map<string, string[]>();
  for (const item of result.milestones) milestones.set(item.date, [...(milestones.get(item.date) ?? []), item.type === 'mom_paid' ? 'Mom target reached' : `${item.name} paid off`]);
  function move(dayIndex: number, key: string) {
    const difference = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : key === 'ArrowDown' ? 7 : key === 'ArrowUp' ? -7 : 0;
    const next = Math.max(0, Math.min(result.days.length - 1, dayIndex + difference));
    onSelect(next);
    document.getElementById(`${id}-${next}`)?.focus();
  }
  return <section className="monthly-calendar" aria-label="Paycheck calendar">
    <div className="monthly-section-heading"><div><span className="monthly-kicker">Your next {result.months.length} months</span><h2>Paycheck calendar</h2><p>Select any day to inspect its estimated balances. Numbered days are paychecks.</p></div><span className="monthly-calendar-count">{result.paychecks.length} paychecks</span></div>
    <div className="monthly-calendar-selection" aria-live="polite"><strong className="monthly-calendar-date">{plannerDate(selected.date)}</strong><span className="monthly-calendar-metric"><span>Debt</span> <b>{money(selected.totalDebtCents)}</b></span><span className="monthly-calendar-metric"><span>{cashLabel}</span> <b>{money(selected.cashCents)}</b></span><span className="monthly-calendar-metric"><span>Investments</span> <b>{money(selected.investmentsCents)}</b></span>{selected.payday ? <span className="monthly-calendar-pay">P{selected.payday.number} · Mom {money(selected.payday.momCents)} · Debt {money(selected.payday.debtCents)} · {cashMode?'Cash':'Invest'} {money(cashMode?selected.payday.cashCents:selected.payday.investCents)}</span> : <span className="monthly-calendar-note">{selected.dayIndex < 0 ? 'Starting balances' : `Daily interest estimate. ${selected.paycheckNumber} paychecks received.`}</span>}</div>
    <div className="monthly-calendar-grid">{result.months.map(month => {
      const days = byMonth.get(month.month) ?? [];
      const offset = (new Date(`${month.month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
      const debtReduction = month.debtReducedCents;
      return <section className="monthly-calendar-month" key={month.month} aria-label={monthName(month.month)}>
        <header><h3>{monthName(month.month)}</h3><span className={month.paydayCount === 3 ? 'extra-pay-month' : ''}>{month.paydayCount} paychecks</span></header>
        <div className="monthly-calendar-week" aria-hidden="true">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span key={index}>{day}</span>)}</div>
        <div className="monthly-calendar-days">{Array.from({ length: offset }, (_, index) => <span key={`blank-${index}`} aria-hidden="true"/>)}{days.map(day => {
          const payday = day.payday;
          const label = `${plannerDate(day.date)}. ${payday ? `Paycheck ${payday.number}, ${money(payday.payCents)}. Mom ${money(payday.momCents)}, debt ${money(payday.debtCents)}, ${cashMode?'cash':'invest'} ${money(cashMode?payday.cashCents:payday.investCents)}. ` : ''}Estimated debt ${money(day.totalDebtCents)}, cash ${money(day.cashCents)}, investments ${money(day.investmentsCents)}.${milestones.has(day.date) ? ` ${milestones.get(day.date)!.join('; ')}.` : ''}`;
          return <button type="button" id={`${id}-${day.dayIndex}`} key={day.date} className={`${payday ? 'is-payday' : ''}${selected.date === day.date ? ' is-selected' : ''}${milestones.has(day.date) ? ' is-milestone' : ''}`} tabIndex={day.dayIndex === tabbableDayIndex ? 0 : -1} aria-label={label} aria-pressed={selected.date === day.date} title={label} onClick={() => onSelect(day.dayIndex)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(day.dayIndex, event.key); } }}><span>{Number(day.date.slice(8))}</span>{payday ? <strong>P{payday.number}</strong> : <i aria-hidden="true"/>}</button>;
        })}{Array.from({ length: 42 - offset - days.length }, (_, index) => <span className="monthly-calendar-trailing" key={`trailing-${index}`} aria-hidden="true"/>)}</div>
        <footer><span>Mom <strong>{compact(month.momCents)}</strong></span><span>Debt <strong>{compact(month.debtCents)}</strong></span><span>{cashMode?'Cash':'Invest'} <strong>{compact(cashMode?month.cashCents:month.investCents)}</strong></span></footer>
        <p className="monthly-month-target">{debtReduction >= 0 ? `${money(debtReduction)} less debt` : `${money(-debtReduction)} more debt`}{month.shortfallCents > 0 ? ` · ${money(month.shortfallCents)} underfunded` : ''}{month.minimumShortfallCents > 0 ? ` · ${money(month.minimumShortfallCents)} of required payments not funded on time` : ''}{month.unknownMinimumCount > 0 ? ' · Required payments unknown' : ''}</p>
      </section>;
    })}</div>
  </section>;
}
