import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../../../shared/types';
import { plannerDefaults, plannerSourceKey, plannerTdMinimumEstimate, restorePlannerDraft, type PlannerDraft as Draft, type PlannerDebtDraft as DebtDraft } from '../../../shared/planner-draft';
import { workScheduleDescription } from '../../../shared/expense-pay.ts';
import { tdAgreementUrl } from '../../../shared/td-minimum';
import { money } from '../../../shared/analytics';
import SimulationProgress, { type SimulationArea } from './SimulationProgress';
import PlannerCalendar, { plannerDate } from './PlannerCalendar';
import Icon from '../../components/Icon';
import AccountStrategy from './AccountStrategy';
import { debtPaymentStatus } from '../../../shared/debt-status';
import { debtRepaymentKind } from '../../../shared/debt-model';
import type { PlannerProjection } from '../../../shared/engine';
import { useEngineDate, useEngineProject } from '../../services/useEngine';
import EngineStatus from '../../components/EngineStatus';
import FundingComparison from './FundingComparison';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';

interface Props { state: AppState; scope: string; motion: boolean; onDebts?: () => void }

export default function Simulations({ state, scope, motion, onDebts }: Props) {
  const asOf = useEngineDate();
  const ownerId = (scope === 'all' ? state.entities.find(entity => entity.kind === 'personal') : state.entities.find(entity => entity.id === scope))?.id ?? 'personal';
  return <MonthlyPlanner key={`${state.workspace}-${ownerId}`} state={state} ownerId={ownerId} asOf={asOf} motion={motion} onDebts={onDebts}/>;
}

function MonthlyPlanner({ state, ownerId, asOf, motion, onDebts }: { state: AppState; ownerId: string; asOf: string; motion: boolean; onDebts?: () => void }) {
  const accounts = state.accounts.filter(account => account.entityId === ownerId && ['debt', 'payable'].includes(account.type));
  const creditAccounts = accounts.filter(account => account.balanceCents < 0);
  const deferredAccounts = accounts.filter(account => debtPaymentStatus(account) === 'in_study');
  const cashAccounts = state.accounts.filter(account => account.entityId === ownerId && account.type === 'cash');
  const defaults = plannerDefaults(state, ownerId, asOf);
  const schedule = state.entities.some(entity => entity.id === ownerId && entity.kind === 'personal') ? workScheduleDescription(state.roadmap) : '';
  const sourceKey = plannerSourceKey(state, ownerId, asOf);
  const storageKey = `mazal.planner.monthly.v4.${state.workspace}.${ownerId}`;
  const [draft, setDraft] = useState(() => {
    try {
      const serialized = localStorage.getItem(storageKey);
      const restored = restorePlannerDraft(serialized, defaults, sourceKey);
      if (JSON.parse(serialized ?? 'null')?.deferredPlanningVersion !== 1) {
        for (const account of deferredAccounts) restored.debts[account.id] = { ...restored.debts[account.id], included: false };
        if (!restored.debts[restored.selectedDebtId]?.included) restored.selectedDebtId = accounts.find(account => restored.debts[account.id].included)?.id ?? '';
      }
      return restored;
    }
    catch { return defaults; }
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showDeferred, setShowDeferred] = useState(false);
  const [focus, setFocus] = useState<SimulationArea>('debt');
  const [playing, setPlaying] = useState(false);
  const [draftSaved, setDraftSaved] = useState(true);
  const lastSavedDraft = useRef(JSON.stringify(draft));
  const [discard, setDiscard] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [draftSourceKey, setDraftSourceKey] = useState(sourceKey);
  if (draftSourceKey !== sourceKey) {
    setDraftSourceKey(sourceKey);
    setDraft(defaults);
    lastSavedDraft.current = JSON.stringify(defaults);
    setSelectedIndex(0);
    setPlaying(false);
  }
  const protection = useDraftProtection({ dirty: !draftSaved && !discarded && JSON.stringify(draft) !== lastSavedDraft.current, onRequestDiscard: () => setDiscard(true) });
  const estimatedMinimumAccounts = accounts.filter(account => {
    const values = draft.debts[account.id] ?? defaults.debts[account.id];
    return account.balanceCents > 0 && values.included && values.minimumMode === 'td_estimate';
  });
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const plannerRef = useRef<HTMLDivElement>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => { setPlaying(false); setDraft(previous => ({ ...previous, [key]: value })); };
  useEffect(() => {
    setDiscarded(false);
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 4, deferredPlanningVersion: 1, sourceKey, draft })); lastSavedDraft.current = JSON.stringify(draft); setDraftSaved(true); }
    catch { setDraftSaved(false); }
  }, [draft, storageKey, sourceKey]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => { setReducedMotion(media.matches); setPlaying(false); };
    const hide = () => { if (document.hidden) setPlaying(false); };
    media.addEventListener('change', change); document.addEventListener('visibilitychange', hide);
    return () => { media.removeEventListener('change', change); document.removeEventListener('visibilitychange', hide); };
  }, []);
  useEffect(() => { if (!motion) setPlaying(false); }, [motion]);
  useEffect(() => {
    const planner = plannerRef.current;
    const toolbar = planner?.closest('.app-shell')?.querySelector<HTMLElement>('.glass-toolbar');
    if (!planner || !toolbar) return;
    const update = () => {
      const top = Number.parseFloat(getComputedStyle(toolbar).top) || 0;
      planner.style.setProperty('--mp-sticky-top', `${Math.ceil(toolbar.getBoundingClientRect().height + top + 12)}px`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    window.addEventListener('resize', update);
    update();
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, []);

  const engine = useEngineProject<PlannerProjection>(state, ownerId, asOf, { kind: 'planner', draft });
  const calculation = engine.data;
  const input = calculation?.input;
  const result = calculation?.result;
  const fixedDebt = calculation?.fixedDebt ?? 0;
  const index = result ? Math.min(selectedIndex, result.days.length) : 0;
  const selected = result ? index === 0 ? result.opening : result.days[index - 1] : null;
  const points = calculation?.points ?? [];
  const last = result?.days.at(-1);
  const normalPaychecks = calculation?.derived.normalPaychecks ?? 2;
  const normalLabel = `${normalPaychecks}-paycheck month`;
  const thirdPayMonths = result?.months.filter(month => month.paydayCount > normalPaychecks) ?? [];
  const firstPay = result?.paychecks[0];
  const interestSaved = calculation?.derived.interestSaved ?? 0;
  const contributionsDelayed = calculation?.derived.contributionsDelayed ?? 0;
  const earlierDays = calculation?.derived.earlierDays;
  const baselinePayoff = calculation?.baseline?.milestones.find(item => item.type === 'debt_paid' && item.debtId === input?.selectedDebtId);
  const fasterPayoff = calculation?.faster?.milestones.find(item => item.type === 'debt_paid' && item.debtId === input?.selectedDebtId);
  const dayInterest = calculation?.derived.dayInterest ?? 0;
  const startingCash = calculation?.derived.startingCash ?? 0;
  const startingInvestments = calculation?.derived.startingInvestments ?? 0;
  const motionAllowed = motion && !reducedMotion;
  useEffect(() => {
    if (!playing || !result || !motionAllowed) return;
    if (index >= result.days.length) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setSelectedIndex(value => Math.min(value + 1, result.days.length)), 65);
    return () => window.clearTimeout(timer);
  }, [playing, result, index, motionAllowed]);
  function selectDay(dayIndex: number) { setPlaying(false); setSelectedIndex(dayIndex + 1); }
  function nextPay(direction: -1 | 1) {
    if (!result || !selected) return;
    const next = direction > 0 ? result.paychecks.find(pay => pay.dayIndex > selected.dayIndex) : [...result.paychecks].reverse().find(pay => pay.dayIndex < selected.dayIndex);
    selectDay(next?.dayIndex ?? (direction < 0 ? -1 : result.days.length - 1));
  }
  function moneyField(label: string, key: 'pay' | 'mom' | 'debt' | 'living' | 'extraDebt', helper: string) {
    return <label className="monthly-field"><span>{label}</span><span className="monthly-money"><span aria-hidden="true">$</span><input aria-label={label} inputMode="decimal" value={draft[key]} placeholder="Not entered" onChange={event => set(key, event.target.value)}/></span><small>{helper}</small></label>;
  }
  function changeDebt(id: string, field: Exclude<keyof DebtDraft,'included'|'minimumMode'>, value: string) { setPlaying(false); setDraft(previous => ({ ...previous, debts: { ...previous.debts, [id]: { ...(previous.debts[id] ?? defaults.debts[id]), [field]: value, ...(field === 'minimum' ? { minimumMode: 'manual' as const } : {}) } } })); }

  function includeDebt(id:string,included:boolean){
    setPlaying(false);
    setDraft(previous=>{
      const debts={...previous.debts,[id]:{...(previous.debts[id]??defaults.debts[id]),included}};
      const selectedDebtId=(debts[previous.selectedDebtId]??defaults.debts[previous.selectedDebtId])?.included?previous.selectedDebtId:accounts.find(account=>(debts[account.id]??defaults.debts[account.id]).included)?.id??'';
      return {...previous,debts,selectedDebtId};
    });
  }

  return <div className="monthly-planner" ref={plannerRef} data-motion={motionAllowed ? 'on' : 'off'}>
    <DraftDiscardDialog open={discard} onDiscard={() => { setDiscard(false); setDiscarded(true); protection.discard(); }} onKeepEditing={() => { setDiscard(false); protection.keepEditing(); }}/>
    <div className="monthly-intro"><p>{schedule || (input ? `${money(input.payCents)} ${input.frequency === 26 ? 'every 14 days' : input.frequency === 52 ? 'every week' : 'every month'}, starting ${plannerDate(draft.firstPayday)}.` : 'Set your pay schedule and monthly targets.')}</p><span>{draftSaved ? 'Draft saved in this browser' : 'Draft could not be saved in this browser'}</span></div>
    <section className="monthly-plan" aria-label="Base monthly plan">
      <div className="monthly-plan-heading"><div><span className="monthly-kicker">Your scenario · CAD</span><h2>Your base plan</h2></div></div>
      <div className="monthly-base-fields">
        {moneyField(schedule ? 'Full-time pay per paycheck' : 'Pay per paycheck', 'pay', Number(draft.frequency) === 26 ? 'Every 2 weeks' : Number(draft.frequency) === 52 ? 'Every week' : draft.frequency === '12' ? 'Every month' : 'Choose a schedule below')}
        {moneyField('To Mom', 'mom', 'Per month · enter 0 if not applicable')}
        {moneyField('To debt', 'debt', 'Per month · interest included')}
        {moneyField('Living costs', 'living', 'Per month · bills and spending')}
      </div>
      <label className="monthly-field"><span>Remaining income</span><select aria-label="Remaining income destination" value={draft.surplusDestination} onChange={event=>{set('surplusDestination',event.target.value as Draft['surplusDestination']);setFocus('debt');}}><option value="cash">Keep as cash</option><option value="investments">Add to investments</option></select><small>After living costs, Mom, and debt payments. Extra debt payments use this remainder first.</small></label>
      {input && <div className="monthly-remainder"><span><i/>Unallocated after Mom, debt, and living costs.</span><strong>{money(calculation!.derived.unallocatedCents)}<small>{input.payByDateCents ? ' in the first modeled month' : ` in a ${normalLabel}`}{input.extraDebtCents ? ', before extra debt payments' : ''}</small></strong></div>}
      {(calculation?.fixedNames.length ?? 0) > 0 && <p className="monthly-exclusion-note">{calculation!.fixedNames.join(', ')}: balances stay in total debt and are held fixed in this projection. Their interest and payments are not projected.</p>}
      {creditAccounts.length > 0 && <p className="monthly-exclusion-note" aria-label="Recorded account credits">{creditAccounts.map(account => `${account.name}: ${money(-account.balanceCents)} credit`).join('. ')}. These credits stay fixed in net worth. They do not fund cash payments or accrue debt interest in this projection.</p>}
      {estimatedMinimumAccounts.length > 0 && <p className="monthly-exclusion-note" aria-label="Estimated minimum assumptions">{estimatedMinimumAccounts.map(account => {
        const estimate = plannerTdMinimumEstimate(account, draft.debts[account.id] ?? defaults.debts[account.id]);
        return `${account.name}: ${estimate ? money(estimate.amountCents) : 'unknown'} estimated regular minimum per month.`;
      }).join(' ')} Uses estimated monthly interest plus $10, capped at the balance. The scenario holds this monthly target fixed. Excludes fees, overdue amounts, over-limit requirements and instalments. The current statement amount and due date remain unconfirmed. <a href={tdAgreementUrl} target="_blank" rel="noreferrer">TD agreement</a>.</p>}
      <details className="monthly-settings" open={!result || undefined}>
        <summary>Dates, balances & assumptions <Icon name="down" size={16}/></summary>
        <div className="monthly-settings-grid">
          <label className="monthly-field"><span>First paycheck</span><input aria-label="First paycheck" type="date" value={draft.firstPayday} onChange={event => { set('firstPayday', event.target.value); if (event.target.value.slice(0, 7) > draft.startMonth) set('startMonth', event.target.value.slice(0, 7)); }}/><small>Then repeat on this schedule.</small></label>
          <label className="monthly-field"><span>Pay schedule</span><select aria-label="Pay schedule" value={draft.frequency} onChange={event => set('frequency', event.target.value)}><option value="">Choose schedule</option><option value="26">Every 2 weeks</option><option value="52">Weekly</option><option value="12">Monthly</option></select></label>
          <label className="monthly-field"><span>Start month</span><input aria-label="Start month" type="month" value={draft.startMonth} onChange={event => set('startMonth', event.target.value)}/><small>Full months. Recorded balances are treated as opening balances on the first day; update them before relying on the forecast.</small></label>
          <label className="monthly-field"><span>Plan length</span><select aria-label="Plan length" value={draft.months} onChange={event => set('months', event.target.value)}><option value="6">6 months</option><option value="12">12 months</option><option value="24">24 months</option></select></label>
          <label className="monthly-field"><span>Annual investment return · %</span><input aria-label="Annual investment return" inputMode="decimal" value={draft.investmentReturn} onChange={event => set('investmentReturn', event.target.value)}/><small>0% shows contributions only. Returns are uncertain.</small></label>
          {moneyField('Extra to debt', 'extraDebt', 'Up to this amount per month, from remaining income.')}
          <label className="monthly-field"><span>Debt to prioritize</span><select aria-label="Debt to prioritize" value={draft.selectedDebtId} onChange={event => set('selectedDebtId', event.target.value)}><option value="">Choose an included debt</option>{accounts.filter(account => account.balanceCents > 0 && (draft.debts[account.id] ?? defaults.debts[account.id]).included).map(account => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label>
        </div>
        {deferredAccounts.length > 0 && <div className="monthly-exclusion-note"><p>{deferredAccounts.map(account => account.name).join(', ')}: no payment due now. Repayment planning is optional while deferred.</p><button type="button" className="text-button" aria-expanded={showDeferred} onClick={() => setShowDeferred(value => !value)}>{showDeferred ? 'Hide deferred loans' : deferredAccounts.length === 1 ? 'Show deferred loan' : 'Show deferred loans'}</button></div>}
        <div className="monthly-debt-settings">{accounts.filter(account => account.balanceCents >= 0 && (showDeferred || !deferredAccounts.includes(account))).map(account => {
          const values = draft.debts[account.id] ?? defaults.debts[account.id];
          const componentRate = Boolean(account.debtTerms?.components?.length);
          const deferredMinimum = account.debtTerms?.repaymentStatus === 'in_study' && Boolean(account.debtTerms.repaymentStartDate);
          const estimate = plannerTdMinimumEstimate(account, values);
          const usingEstimate = values.minimumMode === 'td_estimate';
          const paymentLabel = debtRepaymentKind(account) === 'one_off' ? 'Lump-sum payment' : usingEstimate ? 'Estimated regular minimum' : deferredMinimum ? 'Minimum after deferral' : 'Monthly minimum';
          return <div key={account.id}>
            <div><h3>{account.name}</h3><label className="monthly-debt-toggle"><input type="checkbox" aria-label={`Include ${account.name} in repayment scenario`} checked={values.included} onChange={event=>includeDebt(account.id,event.target.checked)}/>Include in repayment scenario</label><p>{!values.included?'Balance held fixed. Interest and payments are not projected.':componentRate?'Interest uses the saved loan portions. Review their balances and rates on Debts.':account.debtTerms?.rateConfirmed && values.apr === String(account.debtTerms.aprPercent) ? 'Rate from your records.' : values.apr ? 'Scenario rate. Confirm it against your statement.' : 'APR required for an outstanding balance. Enter 0 only if interest-free.'}</p></div>
            <label className="monthly-field"><span>Balance · CAD</span><input aria-label={`${account.name} balance`} inputMode="decimal" value={values.balance} onChange={event => changeDebt(account.id, 'balance', event.target.value)}/></label>
            <label className="monthly-field"><span>{componentRate?'Combined APR':'APR'} · %</span><input aria-label={`${account.name} APR`} inputMode="decimal" placeholder="Unknown" disabled={componentRate} value={componentRate?defaults.debts[account.id].apr:values.apr} onChange={event => changeDebt(account.id, 'apr', event.target.value)}/>{componentRate&&<small>Calculated from the saved component balances and rates.</small>}</label>
            <div><label className="monthly-field"><span>{paymentLabel} · CAD</span><input aria-label={`${account.name} ${paymentLabel.toLowerCase()}`} inputMode="decimal" placeholder="Unknown" value={usingEstimate ? estimate ? String(estimate.amountCents / 100) : '' : values.minimum} onChange={event => changeDebt(account.id, 'minimum', event.target.value)}/>{deferredMinimum&&<small>Monthly amount once repayment starts. Enter the payment due date on Debts when confirmed.</small>}{usingEstimate&&<small>Changes with this scenario's balance and APR. Editing this amount switches to a manual scenario target.</small>}</label>{(estimate || usingEstimate) && <label className="monthly-debt-toggle"><input type="checkbox" aria-label={`Use estimated regular minimum for ${account.name}`} checked={usingEstimate} onChange={event=>{
              const checked = event.target.checked;
              setPlaying(false);
              setDraft(previous=>({ ...previous, debts:{ ...previous.debts, [account.id]:{ ...(previous.debts[account.id] ?? defaults.debts[account.id]), minimum: estimate ? String(estimate.amountCents / 100) : values.minimum, minimumMode: checked ? 'td_estimate' : 'manual' } } }));
            }}/>Use estimated regular minimum</label>}</div>
          </div>;
        })}</div>
        <div className="monthly-settings-footer"><span>Scenario only. These edits do not change accounts, actual income, or recorded payments.</span><button className="text-button" type="button" onClick={() => { setDraft(defaults); setSelectedIndex(0); setPlaying(false); }}>Reset draft</button></div>
      </details>
    </section>
    <div className="monthly-assumption-note"><Icon name="info" size={16}/><p>{schedule ? 'This scenario scales full-time pay by the hours worked in each pay period and keeps existing cash aside.' : 'This scenario repeats your paycheck amount and keeps existing cash aside.'} {draft.surplusDestination==='cash'?'Remaining income stays in cash.':'Remaining income goes to investments.'} Open the allocation comparison below to include reserves, dated bills or income changes. Account changes reset this draft to the latest records.</p></div>
    <EngineStatus {...engine}/>
    {calculation?.error && <p className="monthly-error" role="alert">{calculation.error}</p>}
    {result && selected && last && input && <>
      {(result.totalShortfallCents > 0 || result.totalMinimumShortfallCents > 0) && <p className="monthly-error" role="alert">{result.totalShortfallCents > 0 ? `This plan is short ${money(result.totalShortfallCents)} across ${draft.months} months. ` : ''}{result.totalMinimumShortfallCents > 0 ? `${money(result.totalMinimumShortfallCents)} of required payments is not funded on time. ` : ''}Payments after a recorded deadline do not erase the missed deadline. The calendar shows only payments this income can fund.</p>}
      {result.warnings.length > 0 && <div className="monthly-assumption-note" aria-label="Payment timing and loan assumptions"><div><strong>Payment dates and loan assumptions</strong><ul>{result.warnings.slice(0, 6).map(warning => <li key={warning}>{warning}</li>)}</ul>{result.warnings.length > 6 && <p>{result.warnings.length - 6} more notices appear in calculation details below.</p>}</div></div>}
      {result.monthsWithUnknownMinimums > 0 && <p className="monthly-error" role="alert">Required payment amounts are unknown in {result.monthsWithUnknownMinimums} {result.monthsWithUnknownMinimums === 1 ? 'month' : 'months'}. Their coverage cannot be confirmed. Enter the lender's repayment dates and current minimums.</p>}
      <section className="monthly-projection" aria-label="Daily plan progress">
        <div className="monthly-projection-heading"><div><span className="monthly-kicker">Estimated balances</span><h2>{selected.dayIndex < 0 ? 'At the start' : plannerDate(selected.date)}</h2></div><div><strong>{selected.paycheckNumber}<span> / {result.paychecks.length} paychecks</span></strong><small>{selected.dayIndex < 0 ? `First paycheck ${firstPay ? plannerDate(firstPay.date) : 'outside this plan'}` : selected.payday ? `${money(selected.payday.payCents)} paycheck today` : 'Interest changes daily. Payments happen on paydays.'}</small></div></div>
        <div className="monthly-projection-layout"><div className="monthly-columns"><SimulationProgress points={points} month={index} focus={focus} onFocus={setFocus} visibleAreas={draft.surplusDestination==='cash'?['debt','cash',...(startingInvestments>0?['investments' as const]:[])]:['debt','investments',...(startingCash!==0?['cash' as const]:[])]} labels={{ debt: 'Debt remaining', cash: cashAccounts.length?'Cash balance':'New cash kept', investments: 'Investments' }} motion={motionAllowed}/></div>
        <aside className="monthly-day-details" aria-label="Selected day targets"><span className="monthly-kicker">{selected.payday ? `Paycheck ${selected.payday.number} targets` : 'Progress to this date'}</span><dl>
          <div><dt>To Mom{!selected.payday && ' so far'}</dt><dd>{money(selected.payday?.momCents ?? selected.momPaidCents)}</dd></div>
          <div><dt>{selected.payday ? 'To debt' : 'Debt reduced'}</dt><dd>{money(selected.payday?.debtCents ?? selected.debtReducedCents)}</dd></div>
          <div><dt>{selected.payday ? 'Living costs' : 'Interest so far'}</dt><dd>{money(selected.payday?.spendingCents ?? selected.interestCents)}</dd></div>
          <div className="monthly-invest-target"><dt>{draft.surplusDestination==='cash'?(selected.payday?'Keep as cash':'Cash kept from pay'):(selected.payday?'To invest':'Investment contributions')}</dt><dd>{money(draft.surplusDestination==='cash'?(selected.payday?.cashCents??selected.cashContributionsCents):(selected.payday?.investCents??selected.investmentContributionsCents))}</dd></div>
        </dl>{selected.momRemainingCents !== null && <p>{money(selected.momRemainingCents)} left toward your car.</p>}{fixedDebt > 0 && <p>{money(fixedDebt)} in excluded debt balances stays fixed. Their interest and payments are not projected.</p>}<p>{focus === 'debt' ? 'Debt payments include interest. Known minimums come first, then your priority debt.' : focus==='cash' ? `${cashAccounts.length?`Starting cash ${money(startingCash)}.`:'Opening cash is not recorded. This shows only cash kept from future pay.'} Existing cash is kept aside; payments use future paychecks.` : `Starting investments ${money(startingInvestments)}. ${Number(draft.investmentReturn) === 0 ? 'Only new contributions are projected.' : `${draft.investmentReturn}% annual return is an assumption.`}`}</p></aside></div>
        <div className="monthly-player"><button type="button" className="button primary compact" disabled={!motionAllowed} aria-label={playing ? 'Pause daily projection' : 'Play daily projection'} onClick={() => { if (index >= result.days.length) setSelectedIndex(0); setPlaying(value => !value); }}>{playing ? 'Pause' : 'Play days'}</button><button type="button" className="monthly-step" aria-label="Previous paycheck" disabled={index === 0} onClick={() => nextPay(-1)}>−</button><label><span className="sr-only">Daily timeline</span><input type="range" aria-label="Daily timeline" min="0" max={result.days.length} step="1" value={index} onChange={event => { setPlaying(false); setSelectedIndex(Number(event.target.value)); }} aria-valuetext={`${plannerDate(selected.date)}, ${selected.paycheckNumber} paychecks, debt ${money(selected.totalDebtCents)}, cash ${money(selected.cashCents)}, investments ${money(selected.investmentsCents)}`}/></label><button type="button" className="monthly-step" aria-label="Next paycheck" disabled={index >= result.days.length} onClick={() => nextPay(1)}>+</button><button type="button" className="text-button" onClick={() => selectDay(result.days.length - 1)}>End of plan</button></div>
        {!motionAllowed && <p className="monthly-motion-note">Animation is paused. Select a day or use the timeline.</p>}
      </section>
      <details className="monthly-tool-disclosure monthly-calendar-disclosure"><summary><span><strong>Paycheck calendar</strong><small>{result.months.length} months of payment dates and projected balances</small></span><Icon name="down" size={16}/></summary><div className="monthly-tool-content"><PlannerCalendar result={result} selected={selected} cashLabel={cashAccounts.length?'Cash':'Cash kept'} onSelect={selectDay}/></div></details>
      <details className="monthly-insights monthly-tool-disclosure" aria-label="Ways to improve the plan"><summary><span><strong>Extra payments and paycheck totals</strong><small>Review the effect of an extra $100 toward debt each month</small></span><Icon name="down" size={16}/></summary><div className="monthly-tool-content">
        <div className="monthly-insight-row"><span className="monthly-insight-number">01</span><div><h3>{result.paychecks.length} paychecks make {money(calculation!.derived.totalPayCents)}</h3><p>{thirdPayMonths.length ? `${thirdPayMonths.map(month => new Date(`${month.month}-01T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })).join(' and ')} have extra paychecks.` : 'No extra-paycheck months occur in this plan.'} Mom and debt keep the same monthly targets; the extra income {draft.surplusDestination==='cash'?'stays in cash':'goes to investments'} after living costs in this draft.</p></div></div>
        <div className="monthly-insight-row"><span className="monthly-insight-number">02</span><div><h3>Try up to C$100 more toward debt each month</h3><p>{interestSaved > 0 ? `With the same debt priority, the comparison saves ${money(interestSaved)} in modeled interest over these ${draft.months} months.` : 'With these inputs, the comparison does not reduce interest over this plan.'}{earlierDays != null && earlierDays > 0 ? ` Your priority debt finishes ${earlierDays} days earlier.` : fasterPayoff && !baselinePayoff ? ` Your priority debt reaches zero on ${plannerDate(fasterPayoff.date)} in the comparison.` : ''} {contributionsDelayed >= 0 ? `${money(contributionsDelayed)} less would go to ${draft.surplusDestination} during this period.` : `${money(-contributionsDelayed)} more reaches ${draft.surplusDestination} after the earlier debt payoff.`}</p><button type="button" className="text-button" onClick={() => { set('extraDebt', draft.extraDebt === '100' ? '0' : '100');  }}>{draft.extraDebt === '100' ? 'Return to the base plan' : 'Try $100 extra per month'} <Icon name="arrow" size={14}/></button></div></div>
        <div className="monthly-insight-row"><span className="monthly-insight-number">03</span><div><h3>Interest starts near {money(dayInterest)} a day</h3><p>{calculation?.derived.selectedDebtEarlyPaymentSavingsCents != null ? `A C$500 payment posted 14 days earlier saves about ${money(calculation.derived.selectedDebtEarlyPaymentSavingsCents)} while that balance remains interest-bearing at the scenario rate. ` : ''}Payments reduce the balance when each paycheck arrives. Actual lender posting rules can change the result.</p></div></div>
        <div className="monthly-insight-row"><span className="monthly-insight-number">04</span><div><h3>Confirm minimums and keep an emergency reserve</h3><p>Pay every debt minimum before directing extra money to the highest rate. This draft does not deduct an emergency cash reserve. Scenario targets are amounts to review before transferring money.</p></div></div>
      </div></details>
      <details className="monthly-method"><summary>Assumptions & calculation details <Icon name="down" size={15}/></summary><div><p>Monthly targets are divided across the actual paydays in that month, to the cent. The first payday is {plannerDate(draft.firstPayday)}. {Number(draft.frequency) === 26 ? 'Later paydays are exactly 14 days apart.' : 'Later paydays follow your selected schedule.'} Mom payments stop at the recorded remaining car cost when known. Once modeled debts are paid, their unused allocation {draft.surplusDestination==='cash'?'stays in cash':'goes to investments'}.</p><p>This draft compounds debt interest daily using APR / 365. Your lender may post interest monthly or use a different calculation. Investment growth uses the daily equivalent of your annual assumption. Cash earns no modeled return. Existing cash stays aside and does not fund shortfalls. Contributions happen after that day’s interest and growth. The model excludes lender fees, taxes, new borrowing, inflation, and price changes to your car. It does not predict market returns.</p>{(calculation?.fixedNames.length ?? 0) > 0 && <p>Excluded from repayment projection: {calculation!.fixedNames.join(', ')}. Their repayments and interest are excluded from the targets.</p>}{result.warnings.map((warning, warningIndex) => <p key={warningIndex}>{warning}</p>)}<p>Starting account balances come from Mazal records and may need updating. Blank minimums are unknown, not zero. All dates and amounts on this page are estimates; no payment is recorded.</p><p>References: <a href="https://www.canada.ca/en/financial-consumer-agency/services/debt/paying-debt.html" target="_blank" rel="noreferrer">FCAC debt repayment guidance</a> and <a href="https://www.canada.ca/en/financial-consumer-agency/services/savings-investments/savings-investment-goals.html" target="_blank" rel="noreferrer">FCAC savings and investment goals</a>.</p></div></details>
    </>}
    <details className="monthly-tool-disclosure monthly-strategy-disclosure"><summary><span><strong>Review current debt priorities</strong><small>Rates, required payments and terms from your saved accounts</small></span><Icon name="down" size={16}/></summary><div className="monthly-tool-content"><AccountStrategy state={state} scope={ownerId} onDebts={onDebts}/></div></details>
    <details className="monthly-tool-disclosure monthly-funding-disclosure"><summary><span><strong>Compare debt and saving allocations</strong><small>Include reserves, dated bills, income changes and market setbacks</small></span><Icon name="down" size={16}/></summary><div className="monthly-tool-content"><FundingComparison state={state} scope={ownerId} draft={draft} onDebts={onDebts}/></div></details>
  </div>;
}
