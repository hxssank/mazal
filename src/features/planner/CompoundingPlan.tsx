import { useId } from 'react';
import type { AppState } from '../../../shared/types.ts';
import type { DailyPlan } from '../../../shared/engine.ts';
import { buildCompoundingPlan } from '../../../shared/compounding-plan.ts';
import { money } from '../../../shared/analytics.ts';
import { workScheduleDescription } from '../../../shared/expense-pay.ts';
import Icon from '../../components/Icon.tsx';
import './compounding-plan.css';

interface Props {
  state: AppState; ownerId: string; plan: DailyPlan | null; asOf: string;
  loading?: boolean; error?: string;
  onSetup: () => void; onDebts: () => void; onCompare: () => void;
}

const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const amount = (value: number | null) => value === null ? 'Not confirmed' : money(value);

export default function CompoundingPlan({ state, ownerId, plan, asOf, loading = false, error, onSetup, onDebts, onCompare }: Props) {
  const id = useId();
  if (state.entities.find(entity => entity.id === ownerId)?.kind !== 'personal') return null;
  const data = buildCompoundingPlan(state, ownerId, plan, asOf);
  const saved = state.roadmap?.growthTarget === 'lifetime_compounding';
  const forecastAvailable = !!plan && !loading && !error;
  const current = data.stages.find(stage => stage.id === data.stage);
  const action = forecastAvailable && data.stage === 'debt' ? onDebts : forecastAvailable && data.stage === 'invest' ? onCompare : onSetup;
  const actionLabel = forecastAvailable && data.stage === 'debt' ? 'Review debt priority' : forecastAvailable && data.stage === 'invest' ? 'Compare contributions' : 'Review plan inputs';
  const investmentNow = forecastAvailable ? data.investmentNowCents : null;
  const workSchedule = workScheduleDescription(state.roadmap);

  return <section className="planner-compounding" aria-labelledby={`${id}-title`} aria-busy={loading}>
    <header>
      <div><span className="compounding-eyebrow"><Icon name="invest" size={16}/>{saved ? 'Your main target' : 'Your growth target'}</span><h2 id={`${id}-title`}>Lifetime compounding</h2><p>Grow net worth. Invest before optional comfort purchases.</p></div>
      <span className={`compounding-goal-status${saved ? ' is-saved' : ''}`}>{saved && <Icon name="check" size={13}/>} {saved ? 'Target saved' : 'Target preview'}</span>
    </header>
    <div className="compounding-current">
      <div><span className="compounding-current-label">Current priority</span><h3>{forecastAvailable ? current?.title ?? 'Confirm the money available for growth' : 'Confirm the cash forecast'}</h3><p>{error ? 'The current cash forecast is unavailable. Review the saved plan before assigning money to investments.' : loading ? 'Checking the cash forecast against your saved pay and commitments.' : current?.description ?? 'Confirm income, costs and required payments before choosing a recurring contribution.'}</p></div>
      <button type="button" className="button secondary" onClick={action}>{actionLabel}<Icon name="arrow" size={14}/></button>
    </div>
    {workSchedule && <p className="compounding-budget-note">{workSchedule} {data.partTimeMonthlyIncomeCents === null ? 'Confirm full-time pay and pay frequency to estimate part-time income.' : `At part-time hours, estimated take-home averages ${money(data.partTimeMonthlyIncomeCents)} a month.`} {data.partTimeHeadroomCents !== null && (data.partTimeHeadroomCents < 0 ? `Known recurring costs exceed that by ${money(-data.partTimeHeadroomCents)} a month. ` : `That leaves ${money(data.partTimeHeadroomCents)} a month before any extra costs or unknown payments. `)}Deposits near either change include the hours worked in each part of the pay period.</p>}
    <dl className="compounding-metrics">
      <div><dt>Average monthly take-home</dt><dd>{amount(data.monthlyIncomeCents)}</dd><small>From the saved regular pay schedule</small></div>
      <div><dt>Recurring budget remainder</dt><dd className={data.monthlyHeadroomCents !== null && data.monthlyHeadroomCents < 0 ? 'is-short' : undefined}>{amount(data.monthlyHeadroomCents)}</dd><small>Monthly estimate before extra dated costs and unknown payments.</small></div>
      <div><dt>New investing now</dt><dd>{loading ? 'Checking…' : amount(investmentNow)}</dd><small>{investmentNow === 0 ? 'Keep cash for the current priority' : 'Subject to the cash forecast and missing inputs'}</small></div>
    </dl>
    <details className="compounding-details">
      <summary><span>Your compounding plan<small>Stages, monthly amounts and missing inputs</small></span><Icon name="down" size={16}/></summary>
      <div className="compounding-details-body">
        <ol className="compounding-steps">{data.stages.map((stage, index) => <li key={stage.id} aria-current={data.stage === stage.id ? 'step' : undefined}>
          <span className="compounding-step-number" aria-hidden="true">{index + 1}</span><div><h3>{stage.title}</h3><p>{stage.description}</p></div>
        </li>)}</ol>
        <div className="compounding-evidence">
          <h3>Monthly plan in CAD</h3>
          <dl className="compounding-budget">
            <div><dt>Take-home pay, averaged</dt><dd>{amount(data.monthlyIncomeCents)}</dd></div>
            <div><dt>Total ordinary spending cap</dt><dd>{amount(data.monthlyLivingCents)}</dd></div>
            <div><dt>Purchase commitments</dt><dd>{money(data.monthlyPurchaseCents)}</dd></div>
            <div><dt>Known debt minimums</dt><dd>{money(data.knownDebtMinimumsCents)}</dd></div>
            <div><dt>Monthly estimate before extra dated costs</dt><dd>{amount(data.monthlyHeadroomCents)}</dd></div>
            <div><dt>Equivalent per paycheck, before extra costs</dt><dd>{amount(data.headroomPerPayCents)}</dd></div>
          </dl>
          <p>Ordinary scheduled bills and subscriptions sit inside the living allowance. Purchase installments and debt minimums are separate. Unconfirmed costs and one-off payments reduce the remainder.</p>
          <p className="compounding-budget-note">Average monthly pay spreads extra paychecks across the year. The dated cash forecast decides when money is available.</p>
          {data.debtPriority && <p className="compounding-debt-priority">Highest confirmed rate: {data.debtPriority.name}, {data.debtPriority.aprPercent.toLocaleString('en-CA', { maximumFractionDigits: 2 })}% on {money(data.debtPriority.balanceCents)}. Unconfirmed rates may change this order.</p>}
          {data.blockers.length > 0 && <><h3 className="compounding-missing-title">Before assigning contributions</h3><ul className="compounding-blockers">{data.blockers.map((blocker, index) => <li key={`${index}-${blocker}`}>{blocker}</li>)}</ul></>}
          <button type="button" className="text-button" onClick={onSetup}>Review saved assumptions<Icon name="arrow" size={14}/></button>
        </div>
      </div>
      <p className="compounding-source-note">Plan principles: <a href="https://www.canada.ca/en/financial-consumer-agency/services/debt/paying-debt.html" target="_blank" rel="noreferrer">debt repayment</a>, <a href="https://www.canada.ca/en/revenue-agency/services/tax/registered-plans-administrators/tax-free-savings-account-tfsa/about-tax-free-savings-account-tfsa.html" target="_blank" rel="noreferrer">TFSA rules</a> and <a href="https://www.getsmarteraboutmoney.ca/learning-path/understanding-risk/diversification/" target="_blank" rel="noreferrer">diversification</a>.</p>
    </details>
    {data.futureExamples.length > 0 && <details className="compounding-details">
      <summary><span>What consistent contributions could build<small>Illustrations after the debt phase</small></span><Icon name="down" size={16}/></summary>
      <div className="compounding-examples">
        <p>Illustration after the debt phase, not your current allocation. Starts at $0 with monthly deposits. Nominal rates are after fees, before tax and inflation. Returns are not guaranteed.</p>
        <div className="compounding-table-scroll"><table><caption className="sr-only">Hypothetical investment balances at 4% and 6% annual returns</caption><thead><tr><th scope="col">Monthly</th><th scope="col">Years</th><th scope="col">Deposited</th><th scope="col">At 4%</th><th scope="col">At 6%</th></tr></thead><tbody>{data.futureExamples.map(example => <tr key={`${example.monthlyCents}-${example.years}`}><th scope="row">{money(example.monthlyCents)}</th><td>{example.years}</td><td>{money(example.contributedCents)}</td><td>{money(example.atFourPercentCents)}</td><td>{money(example.atSixPercentCents)}</td></tr>)}</tbody></table></div>
      </div>
    </details>}
    <footer className="compounding-foot"><p>Based on saved records as of {dateLabel(asOf)}{forecastAvailable && data.forecastEndDate ? `. Cash check through ${dateLabel(data.forecastEndDate)}` : ''}. Recalculate after each payday or change in income.</p><button type="button" className="text-button" onClick={onCompare}>Compare debt and investing<Icon name="arrow" size={14}/></button></footer>
  </section>;
}
