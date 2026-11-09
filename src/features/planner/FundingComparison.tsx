import { useEffect, useId, useRef, useState } from 'react';
import type { AppState } from '../../../shared/types.ts';
import type { PlannerDraft } from '../../../shared/planner-draft.ts';
import type { AllocationAssumptions, AllocationComparison, EngineIdentity } from '../../../shared/engine.ts';
import { money } from '../../../shared/analytics.ts';
import { workScheduleDescription } from '../../../shared/expense-pay.ts';
import { parseAssetMoney } from '../../../shared/asset-planning.ts';
import { useEngineRun } from '../../services/useEngineRun.ts';
import { useEngineDate } from '../../services/useEngine.ts';
import './funding-comparison.css';
import SpendingAnalysis from '../expenses/SpendingAnalysis.tsx';
import { fundingDefaults, restoreFundingDraft } from './funding-draft.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
interface Props { state: AppState; scope: string; draft: PlannerDraft; onDebts?: () => void }
export default function FundingComparison(props: Props) {
  return <Comparison key={`${props.state.workspace}:${props.scope}`} {...props}/>;
}

function Comparison({ state, scope, draft, onDebts }: Props) {
  const id = useId();
  const asOf = useEngineDate();
  const storageKey = `mazal.planner.funding.v1.${state.workspace}.${scope}`;
  const defaults = fundingDefaults(state);
  const workSchedule = workScheduleDescription(state.roadmap);
  const [restored] = useState(() => {
    try { return restoreFundingDraft(localStorage.getItem(storageKey), defaults); }
    catch { return defaults; }
  });
  const [draftSaved, setDraftSaved] = useState(true);
  const [discard, setDiscard] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [reserve, setReserve] = useState(restored.reserve);
  const [reserveConfirmed, setReserveConfirmed] = useState(restored.reserveConfirmed);
  const [annualReturn, setAnnualReturn] = useState(restored.annualReturn);
  const [shock, setShock] = useState(restored.shock);
  const [months, setMonths] = useState(restored.months);
  const [investmentShare, setInvestmentShare] = useState(restored.investmentShare);
  const [period, setPeriod] = useState<'weekly' | 'monthly'>('weekly');
  const [selectedPolicy, setSelectedPolicy] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [additionalIncomeIds, setAdditionalIncomeIds] = useState<string[]>(restored.additionalIncomeIds);
  const [incomeConfirmedFor, setIncomeConfirmedFor] = useState(restored.incomeConfirmedFor);
  const [purchaseDates, setPurchaseDates] = useState<Record<string, string>>(restored.purchaseDates);
  const [transitionDate, setTransitionDate] = useState(restored.transitionDate);
  const [transitionIncome, setTransitionIncome] = useState(restored.transitionIncome);
  const [transitionSourceKey, setTransitionSourceKey] = useState(defaults.transitionSourceKey);
  useEffect(() => {
    if (transitionSourceKey === defaults.transitionSourceKey) return;
    setTransitionDate(defaults.transitionDate);
    setTransitionIncome(defaults.transitionIncome);
    setTransitionSourceKey(defaults.transitionSourceKey);
  }, [transitionSourceKey, defaults.transitionSourceKey, defaults.transitionDate, defaults.transitionIncome]);
  const serializedDraft = JSON.stringify({ version: 1, draft: { reserve, reserveConfirmed, annualReturn, shock, months, investmentShare, additionalIncomeIds, incomeConfirmedFor, purchaseDates, transitionDate, transitionIncome, transitionSourceKey } });
  const lastSavedDraft = useRef(serializedDraft);
  const protection = useDraftProtection({ dirty: !draftSaved && !discarded && serializedDraft !== lastSavedDraft.current, onRequestDiscard: () => setDiscard(true) });
  useEffect(() => {
    setDiscarded(false);
    try { localStorage.setItem(storageKey, serializedDraft); lastSavedDraft.current = serializedDraft; setDraftSaved(true); }
    catch { setDraftSaved(false); }
  }, [storageKey, serializedDraft]);
  const owners = new Set(state.entities.filter(owner => owner.kind === 'personal' && (scope === 'all' || owner.id === scope)).map(owner => owner.id));
  const incoming = state.obligations.filter(item => owners.has(item.entityId) && item.direction === 'in' && item.status !== 'cancelled' && (item.status === 'planned' || item.recurrence !== 'once'));
  const incomingKey = JSON.stringify(incoming);
  const incomeConfirmed = incoming.length === 0 || incomeConfirmedFor === incomingKey;
  const purchases = (state.assetPurchases ?? []).filter(item => owners.has(item.entityId) && (item.paidCents === null || item.paidCents < item.targetCents));
  const linkedBills = state.obligations.filter(item => owners.has(item.entityId) && item.direction === 'out' && item.assetPurchaseId && item.status !== 'cancelled' && (item.status === 'planned' || item.recurrence !== 'once'));
  const firstPaymentDates = Object.fromEntries(purchases.filter(item => !linkedBills.some(bill => bill.assetPurchaseId === item.id)).map(item => [item.id, purchaseDates[item.id] ?? asOf]));
  const [validation, setValidation] = useState('');
  const identity: EngineIdentity = { workspace: state.workspace, scope, expectedRevision: state.revision, asOf };
  const key = JSON.stringify([identity, reserve, reserveConfirmed, annualReturn, shock, months, investmentShare, draft.pay, draft.frequency, draft.firstPayday, draft.living, additionalIncomeIds, incomeConfirmed, firstPaymentDates, transitionDate, transitionIncome]);
  const run = useEngineRun<AllocationComparison>(identity, key, 'comparison');
  const result = run.envelope?.result;
  const policy = result?.policies.find(item => item.id === selectedPolicy) ?? result?.policies.find(item => item.id === result.bestPolicyId) ?? result?.policies[0];
  const checkpoints = policy?.[period] ?? [];
  function start() {
    try {
      if (!reserveConfirmed) throw new Error('Enter and confirm the cash reserve to protect before comparing allocations.');
      const reserveCents = parseAssetMoney(reserve, 'Protected cash reserve');
      if (!incomeConfirmed) throw new Error('Confirm which scheduled income is already covered by your regular pay.');
      if (!annualReturn.trim() || !Number.isFinite(Number(annualReturn)) || Number(annualReturn) <= -100 || Number(annualReturn) > 100) throw new Error('Enter an annual return above -100% and at most 100%.');
      if (!shock.trim() || !Number.isFinite(Number(shock)) || Number(shock) < -100 || Number(shock) > 0) throw new Error('Enter a market setback from -100% to 0%.');
      if (!investmentShare.trim() || !Number.isFinite(Number(investmentShare)) || Number(investmentShare) < 0 || Number(investmentShare) > 100) throw new Error('Enter an investment split from 0% to 100%.');
      if (!draft.frequency || !draft.firstPayday) throw new Error('Enter your pay schedule and first paycheck in the base plan.');
      const assumptions: AllocationAssumptions = { additionalIncomeObligationIds: additionalIncomeIds.filter(value => incoming.some(item => item.id === value)), purchaseFirstPaymentDates: firstPaymentDates, months: Number(months), reserveCents, annualReturnPercent: Number(annualReturn), shockPercent: Number(shock), shockMonth: Math.min(3, Number(months)), seed: 42, userInvestmentShare: Number(investmentShare) / 100, payCents: parseAssetMoney(draft.pay, 'Take-home pay'), monthlySpendingCents: parseAssetMoney(draft.living, 'Living costs'), frequency: Number(draft.frequency) as 12 | 26 | 52, paydayAnchor: draft.firstPayday };
      if (!workSchedule && transitionIncome.trim()) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(transitionDate) || !Number.isFinite(Date.parse(transitionDate)) || new Date(transitionDate).toISOString().slice(0, 10) !== transitionDate) throw new Error('Enter a valid income change date.');
        assumptions.incomeChanges = [{ date: transitionDate, monthlyIncomeCents: parseAssetMoney(transitionIncome, 'Income after the change') }];
      }
      setValidation(''); setSelectedPolicy(''); setShowAll(false);
      run.start(assumptions);
    } catch (error) { setValidation(error instanceof Error ? error.message : 'Review the comparison inputs.'); }
  }
  return <section className="monthly-plan funding-comparison" aria-labelledby={`${id}-heading`}>
    <DraftDiscardDialog open={discard} onDiscard={() => { setDiscard(false); setDiscarded(true); protection.discard(); }} onKeepEditing={() => { setDiscard(false); protection.keepEditing(); }}/>
    <div className="monthly-plan-heading"><div><span className="monthly-kicker">Allocate, invest, check the setback</span><h2 id={`${id}-heading`}>What should this money do?</h2></div></div>
    <p>Compare cash, debt repayments, and investment funding using your saved balances and debt terms. Pay and living costs come from the base plan above. The comparison starts today. Debt edits in the base plan stay in that scenario; this comparison uses saved debt terms.</p>
    <small>{draftSaved ? 'Comparison draft saved in this browser' : 'Comparison draft could not be saved in this browser'}</small>
    <div className="monthly-settings-grid">
      <label className="monthly-field"><span>Protected cash reserve · CAD</span><input aria-label="Protected cash reserve" inputMode="decimal" value={reserve} placeholder="Confirm an amount, including zero" onChange={event => { setReserve(event.target.value); setReserveConfirmed(false); }}/></label>
      <label className="monthly-field"><span>Annual return assumption · %</span><input aria-label="Comparison annual return" inputMode="decimal" value={annualReturn} onChange={event => setAnnualReturn(event.target.value)}/><small>0% projects contributions only.</small></label>
      <label className="monthly-field"><span>Market setback in month 3 · %</span><input aria-label="Comparison market setback" inputMode="decimal" value={shock} onChange={event => setShock(event.target.value)}/><small>A named scenario with no assigned probability.</small></label>
      <label className="monthly-field"><span>Compare over</span><select aria-label="Comparison horizon" value={months} onChange={event => setMonths(event.target.value)}><option value="12">1 year</option><option value="24">2 years</option><option value="60">5 years</option></select></label>
      <label className="monthly-field"><span>Your split to investing · %</span><input aria-label="Your surplus investment percentage" type="number" min="0" max="100" step="1" value={investmentShare} onChange={event => setInvestmentShare(event.target.value)}/><small>After bills, minimum payments, and the reserve. The rest repays debt.</small></label>
    </div>
    {workSchedule && owners.size > 0 && <p>{workSchedule} This comparison uses the full-time pay amount from the base plan and scales each deposit by the hours worked in its pay period.</p>}
    {defaults.transitionDate && <fieldset className="funding-income-sources"><legend>Income after your planned change</legend><p>Your records include a work or school change on {dateLabel(defaults.transitionDate)}. Enter a take-home income assumption for the comparison, including zero if needed.</p><div className="monthly-settings-grid"><label className="monthly-field"><span>Income change date</span><input type="date" aria-label="Income change date" value={transitionDate} onChange={event => setTransitionDate(event.target.value)}/></label><label className="monthly-field"><span>Take-home income after the change · CAD/month</span><input aria-label="Monthly income after the change" inputMode="decimal" placeholder="Not entered" value={transitionIncome} onChange={event => setTransitionIncome(event.target.value)}/><small>This replaces regular pay from that date through the end of the comparison. It uses the current pay schedule, so months with extra paychecks differ. These assumptions do not change your saved records.</small></label></div></fieldset>}
    {incoming.length > 0 && <fieldset className="funding-income-sources"><legend>Scheduled income</legend><p>Select only income that is additional to the regular pay above.</p>{incoming.map(item => <label className="monthly-debt-toggle" key={item.id}><input type="checkbox" checked={additionalIncomeIds.includes(item.id)} onChange={event => setAdditionalIncomeIds(previous => event.target.checked ? [...previous.filter(value => value !== item.id), item.id] : previous.filter(value => value !== item.id))}/>{item.name}, {money(item.amountCents)}, {item.recurrence} from {dateLabel(item.dueDate)}</label>)}<label className="monthly-debt-toggle"><input type="checkbox" checked={incomeConfirmed} onChange={event => setIncomeConfirmedFor(event.target.checked ? incomingKey : '')}/>My regular pay already covers the unselected scheduled income</label></fieldset>}
    {purchases.length > 0 && <fieldset className="funding-purchase-dates"><legend>Purchase installments</legend><p>These payments are additional to living costs and stop at the recorded remaining cost. Linked bills provide their saved dates. Other first payment dates are assumptions; confirm them against the agreement.</p><div className="monthly-settings-grid">{purchases.map(item => { const bills = linkedBills.filter(bill => bill.assetPurchaseId === item.id); return bills.length ? <div className="monthly-field" key={item.id}><span>{item.name} linked payment schedule</span>{bills.map(bill => <small key={bill.id}>{bill.name}: {money(bill.amountCents)}, {bill.recurrence} from {dateLabel(bill.dueDate)}.</small>)}<small>Uses these saved bill dates, capped at the confirmed remaining cost.</small></div> : <label className="monthly-field" key={item.id}><span>{item.name} first payment</span><input type="date" min={asOf} aria-label={`${item.name} first modeled payment`} value={firstPaymentDates[item.id]} onChange={event => setPurchaseDates(previous => ({ ...previous, [item.id]: event.target.value }))}/><small>{money(item.monthlyCents)} per month. {item.paidCents === null ? 'Confirm paid-to-date on Assets before comparing.' : 'Remaining cost comes from the purchase record.'}</small></label>; })}</div></fieldset>}
    <label className="monthly-debt-toggle"><input type="checkbox" checked={reserveConfirmed} onChange={event => setReserveConfirmed(event.target.checked)}/>Use this confirmed cash reserve for the comparison</label>
    <div className="funding-actions"><button type="button" className="button primary" onClick={start} disabled={run.running}>Compare allocations</button>{run.running && <><span role="status">{run.run?.progress ?? 'Comparing allocations…'}</span><button type="button" className="button secondary" onClick={run.cancel} disabled={run.cancelling || !run.run}>{run.cancelling ? 'Cancelling…' : 'Cancel comparison'}</button></>}</div>
    {(validation || run.error) && <p className="monthly-error" role="alert">{validation || run.error}</p>}
    {run.run?.status === 'cancelled' && <p role="status">Comparison cancelled.</p>}
    {run.stale && <p role="status">Records or assumptions changed. Run the comparison again.</p>}
    <SpendingAnalysis state={state} scope={scope}/>
    {result && <>
      <p>{result.comparisonNote}</p>
      {result.missingInputs.length > 0 && <div className="monthly-error" role="alert"><strong>Confirm these inputs before choosing an allocation.</strong><ul>{result.missingInputs.map(item => <li key={item.field}>{item.message}</li>)}</ul>{onDebts && result.missingInputs.some(item => item.field.startsWith('accounts.')) && <button type="button" className="text-button" onClick={onDebts}>Review saved debt terms</button>}</div>}
      {result.policies.length > 0 && <><p>Investment contributions include available starting cash and later income. Interest is accrued borrowing cost, including any unpaid interest.</p><div className="funding-table-scroll" tabIndex={0} role="region" aria-label="Scrollable allocation table"><table className="funding-table"><caption>Allocation outcomes over {months} months</caption><thead><tr><th scope="col">Allocation</th><th scope="col">Ending net worth</th><th scope="col">Investment contributions</th><th scope="col">Interest accrued</th><th scope="col">Lowest cash</th><th scope="col">Largest shortfall</th><th scope="col">Reserve gap</th></tr></thead><tbody>{result.policies.map(item => <tr key={item.id} aria-selected={policy?.id === item.id}><th scope="row"><button type="button" className="text-button" aria-pressed={policy?.id === item.id} onClick={() => { setSelectedPolicy(item.id); setShowAll(false); }}>{item.name}</button><small>{!item.eligible ? 'Breaks a funding constraint' : item.id === result.bestPolicyId ? 'Best tested under these assumptions' : 'Within funding constraints'}</small></th><td>{money(item.netWorthCents)}</td><td>{money(item.totalInvestmentContributionsCents)}</td><td>{money(item.totalInterestCents)}</td><td>{money(item.lowestCashCents)}</td><td>{money(item.maxUnfundedCents)}</td><td>{money(item.reserveGapCents)}</td></tr>)}</tbody></table></div></>}
      {policy && <>
        <div className="funding-checkpoint-heading"><h3>{policy.name}</h3><div className="period-control" role="group" aria-label="Allocation checkpoints"><button type="button" aria-pressed={period === 'weekly'} onClick={() => { setPeriod('weekly'); setShowAll(false); }}>Weekly</button><button type="button" aria-pressed={period === 'monthly'} onClick={() => { setPeriod('monthly'); setShowAll(false); }}>Monthly</button></div></div>
        <p>{policy.debtFreeDate ? `Modeled debt reaches zero on ${dateLabel(policy.debtFreeDate)}.` : 'Modeled debt remains at the end, or a payoff date cannot be confirmed.'} Review the next week’s contribution before transferring money.</p>
        <div className="funding-table-scroll" tabIndex={0} role="region" aria-label="Scrollable allocation table"><table className="funding-table"><caption>{period === 'weekly' ? 'Weekly allocation checkpoints' : 'Monthly allocation checkpoints'}</caption><thead><tr><th scope="col">Period</th><th scope="col">Income</th><th scope="col">Spending and purchases</th><th scope="col">Required debt</th><th scope="col">Extra debt</th><th scope="col">To invest</th><th scope="col">Closing cash</th><th scope="col">Unfunded</th></tr></thead><tbody>{(showAll ? checkpoints : checkpoints.slice(0, 8)).map(row => <tr key={row.startDate}><th scope="row">{dateLabel(row.startDate)} to {dateLabel(row.endDate)}{row.partial && <small>Partial period</small>}</th><td>{money(row.incomeCents)}</td><td>{money(row.spendingCents)}</td><td>{money(row.requiredDebtCents)}</td><td>{money(row.extraDebtCents)}</td><td>{money(row.investmentCents)}</td><td>{money(row.closingCashCents)}</td><td>{money(row.unfundedCents)}</td></tr>)}</tbody></table></div>
        {checkpoints.length > 8 && <button type="button" className="text-button" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show next 8 checkpoints' : `Show all ${checkpoints.length} checkpoints`}</button>}
        <div className="funding-table-scroll" tabIndex={0} role="region" aria-label="Scrollable allocation table"><table className="funding-table"><caption>How far could {policy.name.toLowerCase()} set you back?</caption><thead><tr><th scope="col">Scenario</th><th scope="col">Ending net worth</th><th scope="col">Market loss at setback</th><th scope="col">Setback vs stated return</th><th scope="col">Difference vs holding cash</th><th scope="col">Largest shortfall</th><th scope="col">Paychecks to replace loss</th></tr></thead><tbody>{policy.scenarios.map(scenario => <tr key={scenario.id}><th scope="row">{scenario.name}</th><td>{money(scenario.netWorthCents)}</td><td>{money(scenario.shockLossCents)}</td><td>{money(scenario.lossVsBaseCents)}</td><td>{money(scenario.differenceVsCashCents)}</td><td>{money(scenario.maxUnfundedCents)}</td><td>{scenario.paychecksToReplace === null ? 'Cannot estimate' : scenario.paychecksToReplace}</td></tr>)}</tbody></table></div>
        <p>The setback compares ending wealth with the stated-return case, including foregone growth. Market loss is the value erased by the shock itself. Replacement paychecks measure new funding needed. Market recovery is not predicted, and these scenarios have no assigned probabilities.</p>
      </>}
      {result.warnings.length > 0 && <details className="monthly-method"><summary>Assumptions and limits</summary><ul>{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
      <small>Records revision {run.envelope!.revision} · Model {run.envelope!.modelVersion} · Input {run.envelope!.inputHash.slice(0, 12)}</small>
    </>}
  </section>;
}
