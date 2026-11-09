import { useEffect, useId, useRef, useState } from 'react';
import type { DailyPlan } from '../../../shared/engine.ts';
import { money } from '../../../shared/analytics.ts';
import { projectHomeCash } from '../../../shared/home-cash-preview.ts';
import Icon from '../../components/Icon.tsx';

interface Props { plan: DailyPlan | null; endDate: string; loading?: boolean; selectedDate: string; onSelect: (date: string) => void }
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export default function PlannerHorizon({ plan, endDate, loading = false, selectedDate, onSelect }: Props) {
  const id = useId();
  const [page, setPage] = useState(0);
  const retained = useRef<{ plan: DailyPlan; endDate: string } | null>(null);
  if (plan) retained.current = { plan, endDate };
  const currentPlan = retained.current?.plan;
  const currentEndDate = retained.current?.endDate ?? endDate;
  useEffect(() => { setPage(0); }, [currentPlan?.asOf, currentEndDate]);
  if (!currentPlan?.days.length) return null;
  const forecast = projectHomeCash(currentPlan, { endDate: currentEndDate });
  const amountLabel = (cents: number) => plan ? money(cents) : loading ? 'Updating…' : 'Unavailable';
  const lastPage = Math.max(0, Math.ceil(forecast.days.length / 7) - 1);
  const activePage = Math.min(page, lastPage);
  const days = forecast.days.slice(activePage * 7, activePage * 7 + 7);
  const selected = forecast.days.find(day => day.date === selectedDate);
  const nextOutflow = plan?.events.find(event => event.direction === 'out' && event.includedInCashflow && event.effectiveDate >= currentPlan.asOf && event.effectiveDate <= currentEndDate);
  function selectIndex(index: number) {
    const bounded = Math.max(0, Math.min(forecast.days.length - 1, index));
    const day = forecast.days[bounded];
    setPage(Math.floor(bounded / 7));
    onSelect(day.date);
    window.requestAnimationFrame(() => document.getElementById(`${id}-${day.date}`)?.focus({ preventScroll: true }));
  }
  return <section className={`planner-horizon${!plan ? ' is-updating' : ''}`} aria-busy={loading} aria-labelledby={`${id}-title`} data-review-panel>
    <header className="planner-horizon-heading"><div><span className="planner-eyebrow">{shortDate(currentPlan.asOf)} to {shortDate(currentEndDate)}</span><h2 id={`${id}-title`}>Plan by day</h2><p>{plan ? 'Select a date to see its payments below.' : loading ? 'Updating the forecast from your saved records.' : 'The forecast is unavailable. Retry the calculation above.'}</p></div><div className="planner-horizon-summary"><span>Lowest before deposits<strong data-review-value="lowest">{amountLabel(forecast.lowestCents)}</strong><small>{plan ? `${shortDate(forecast.lowestDate)} · after reserves` : 'Waiting for a current forecast'}</small></span><button type="button" className="text-button" disabled={!plan} onClick={() => selectIndex(forecast.days.findIndex(day => day.date === forecast.lowestDate))}>Inspect low point<Icon name="arrow" size={14}/></button></div></header>
    <div className="planner-horizon-controls"><div><button type="button" aria-label="Previous planning week" disabled={activePage === 0} onClick={() => { setPage(activePage - 1); onSelect(''); }}><Icon name="down" size={15}/></button><span>{shortDate(days[0].date)} to {shortDate(days.at(-1)!.date)}</span><button type="button" aria-label="Next planning week" disabled={activePage >= lastPage} onClick={() => { setPage(activePage + 1); onSelect(''); }}><Icon name="down" size={15}/></button></div><button type="button" className="text-button" disabled={!selectedDate} onClick={() => onSelect('')}>Show all dates</button></div>
    <div className="planner-day-cards" role="group" aria-label="Daily cash forecast">{days.map(day => {
      const index = forecast.days.findIndex(row => row.date === day.date);
      const unknown = plan ? currentPlan.events.filter(event => day.eventIds.includes(event.id) && event.amountCents === null).length : 0;
      return <button type="button" id={`${id}-${day.date}`} key={day.date} aria-pressed={selectedDate === day.date} aria-label={`${shortDate(day.date)}, ${amountLabel(day.previewCents)} end of day after reserves${unknown ? `, ${unknown} unknown ${unknown === 1 ? 'amount' : 'amounts'}` : ''}`} className={`${day.date === currentPlan.asOf ? 'is-today ' : ''}${plan && day.beforeIncomeCents < 0 ? 'is-short' : ''}`} aria-disabled={!plan} onClick={() => { if (plan) onSelect(day.date === selectedDate ? '' : day.date); }} onKeyDown={event => {
        if (!plan || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        selectIndex(event.key === 'Home' ? 0 : event.key === 'End' ? forecast.days.length - 1 : index + (event.key === 'ArrowRight' ? 1 : -1));
      }}><span className="planner-day-name">{day.date === currentPlan.asOf ? 'Today' : new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', timeZone: 'UTC' })}<i aria-hidden="true"/></span><span className="planner-day-number">{Number(day.date.slice(-2))}</span><strong data-review-value={day.date}>{amountLabel(day.previewCents)}</strong><span className="planner-day-movements">{plan && day.incomeCents > 0 && <span className="is-in">+{amountLabel(day.incomeCents)}</span>}{plan && day.outflowCents > 0 && <span>−{amountLabel(day.outflowCents)}</span>}{plan && !day.incomeCents && !day.outflowCents && !unknown && <span>No known cash movement</span>}{unknown > 0 && <span className="is-unknown">{unknown} {unknown === 1 ? 'amount' : 'amounts'} needed</span>}</span></button>;
    })}</div>
    <footer className="planner-horizon-foot"><span>{selected ? `${shortDate(selected.date)} selected · ${amountLabel(selected.beforeIncomeCents)} before deposits` : 'End-of-day cash after reserves and planned living costs.'}</span>{!plan ? <span>{loading ? 'Updating forecast' : 'Forecast unavailable'}</span> : currentPlan.status === 'partial' ? <span className="is-unknown">Unknown amounts are excluded</span> : nextOutflow ? <span>Next payment {shortDate(nextOutflow.effectiveDate)}</span> : <span>No saved payments in this range</span>}</footer>
  </section>;
}
