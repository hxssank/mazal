import { useId } from 'react';
import type { DailyPlan } from '../../../shared/engine.ts';
import { money } from '../../../shared/analytics.ts';
import type { useEngineProject } from '../../services/useEngine.ts';
import AnimatedValue from '../../components/AnimatedValue.tsx';
import EngineStatus from '../../components/EngineStatus.tsx';
import Icon from '../../components/Icon.tsx';
import './home-outlook.css';

interface Props {
  engine: ReturnType<typeof useEngineProject<DailyPlan>>;
  onDetails: () => void;
}

export default function HomeOutlook({ engine, onDetails }: Props) {
  const id = useId();
  const plan = engine.data;
  const short = !!plan && (plan.beforePayday.cashAfterKnownCents < 0 || !!plan.firstShortfallDate);
  const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(date.slice(0, 4) !== plan?.asOf.slice(0, 4) ? { year: 'numeric' as const } : {}), timeZone: 'UTC' });

  return <section className={`home-outlook${short ? ' has-shortfall' : ''}`} aria-labelledby={`${id}-title`} data-motion-enter>
    <header className="home-outlook-heading"><h2 id={`${id}-title`}>After upcoming costs</h2><Icon name="plan" size={19}/></header>
    <EngineStatus {...engine}/>
    {plan && <>
      <div className={`home-outlook-value${plan.beforePayday.cashAfterKnownCents < 0 ? ' is-negative' : ''}`}><AnimatedValue value={plan.beforePayday.cashAfterKnownCents}/></div>
      <p className="home-outlook-period">Estimated through <time dateTime={plan.beforePayday.endDate}>{dateLabel(plan.beforePayday.endDate)}</time></p>
      <span className={`home-outlook-status${plan.status === 'partial' ? ' is-partial' : ''}`}><Icon name={plan.status === 'partial' || short ? 'info' : 'check'} size={13}/>{plan.status === 'partial' ? 'Incomplete forecast' : 'Based on saved inputs'}</span>
      <p className="home-outlook-note">{plan.protectedCents > 0 ? `After ${money(plan.protectedCents)} set aside.` : plan.missingInputs.some(item => item.section === 'reserve') ? 'Money set aside is not confirmed.' : 'No cash set aside.'}{plan.status === 'partial' ? ' Some amounts need confirmation.' : ' Includes known payments and living costs.'}</p>
      {short && <p className="home-outlook-risk">{plan.firstShortfallDate ? `Check cash or payment timing on ${dateLabel(plan.firstShortfallDate)}.` : 'Known costs exceed available cash.'}</p>}
      <button type="button" className="text-button home-outlook-details" onClick={onDetails}>See forecast details<Icon name="arrow" size={15}/></button>
    </>}
  </section>;
}
