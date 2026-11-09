import type { AppState } from './types.ts';
import type { DailyPlan } from './engine.ts';
import { addCents, money } from './analytics.ts';
import { debtRepaymentKind, effectiveDebtApr, paymentDeferral, rankedInterestDebts } from './debt-model.ts';
import { requiredDebtPaymentCents } from './debt-status.ts';
import { estimatedWorkPayCents, temporaryWorkSchedule } from './expense-pay.ts';

export interface CompoundingExample {
  monthlyCents: number; years: number; contributedCents: number; atFourPercentCents: number; atSixPercentCents: number;
}
export interface CompoundingPlanData {
  stage: 'review' | 'cashflow' | 'reserve' | 'debt' | 'invest';
  monthlyIncomeCents: number | null; monthlyLivingCents: number | null; monthlyCommitmentsCents: number;
  monthlyHeadroomCents: number | null; headroomPerPayCents: number | null; investmentNowCents: number | null;
  partTimeMonthlyIncomeCents: number | null; partTimeHeadroomCents: number | null;
  starterReserveTargetCents: number; reserveGapCents: number | null; cashCents: number | null; investmentCents: number;
  knownDebtMinimumsCents: number; monthlyPurchaseCents: number; forecastGapCents: number | null;
  debtPriority: { id: string; name: string; balanceCents: number; aprPercent: number } | null;
  blockers: string[]; stages: { id: string; title: string; description: string }[]; forecastEndDate: string | null;
  futureExamples: CompoundingExample[];
}

export function compoundContributions(monthlyCents: number, years: number, annualPercent: number): number {
  if (!Number.isSafeInteger(monthlyCents) || monthlyCents < 0 || !Number.isInteger(years) || years < 1 || years > 60
    || !Number.isFinite(annualPercent) || annualPercent < 0 || annualPercent > 20) throw new Error('Choose a valid monthly contribution, horizon and illustrative annual return.');
  const rate = Math.pow(1 + annualPercent / 100, 1 / 12) - 1;
  const value = Math.round(rate === 0 ? monthlyCents * years * 12 : monthlyCents * Math.expm1(years * 12 * Math.log1p(rate)) / rate);
  return addCents(0, value);
}

export function buildCompoundingPlan(state: AppState, ownerId: string, plan: DailyPlan | null, asOf: string): CompoundingPlanData {
  const personal = state.entities.find(entity => entity.id === ownerId)?.kind === 'personal';
  const roadmap = personal ? state.roadmap : undefined;
  const accounts = state.accounts.filter(account => account.entityId === ownerId);
  const debts = accounts.filter(account => ['debt', 'payable'].includes(account.type) && account.balanceCents > 0);
  const activeDebts = debts.filter(account => paymentDeferral(account, asOf) !== 'deferred');
  const cashAccounts = accounts.filter(account => account.type === 'cash');
  const cashCents = cashAccounts.length ? cashAccounts.reduce((sum, account) => addCents(sum, account.balanceCents), 0) : null;
  const investmentCents = accounts.filter(account => account.type === 'investment').reduce((sum, account) => addCents(sum, account.balanceCents), 0);
  const frequency = roadmap?.payEveryDays === 14 ? 26 : roadmap?.payEveryDays === 7 ? 52 : null;
  const fullTimeMonthlyIncomeCents = frequency && roadmap?.payAmountCents != null ? Math.round(addCents(0, roadmap.payAmountCents * frequency) / 12) : null;
  const work = temporaryWorkSchedule(roadmap);
  const partTimePay = work && roadmap?.payAmountCents != null ? estimatedWorkPayCents(roadmap.payAmountCents, work) : null;
  const partTimeMonthlyIncomeCents = frequency && partTimePay !== null ? Math.round(addCents(0, partTimePay * frequency) / 12) : null;
  const monthlyIncomeCents = work && roadmap && asOf >= roadmap.transitionDate && asOf < work.returnDate ? partTimeMonthlyIncomeCents : fullTimeMonthlyIncomeCents;
  const monthlyLivingCents = roadmap?.monthlyEssentialsCents ?? null;
  const purchases = (state.assetPurchases ?? []).filter(purchase => purchase.entityId === ownerId && (purchase.paidCents === null || purchase.paidCents < purchase.targetCents));
  const monthlyPurchaseCents = purchases.reduce((sum, purchase) => addCents(sum, purchase.paidCents === null ? purchase.monthlyCents : Math.min(purchase.monthlyCents, purchase.targetCents - purchase.paidCents)), 0);
  const knownDebtMinimumsCents = activeDebts.filter(account => debtRepaymentKind(account) !== 'one_off').reduce((sum, account) => addCents(sum, Math.min(account.balanceCents, requiredDebtPaymentCents(account, asOf) ?? 0)), 0);
  const monthlyCommitmentsCents = addCents(monthlyPurchaseCents, knownDebtMinimumsCents);
  const monthlyHeadroomCents = monthlyIncomeCents === null || monthlyLivingCents === null ? null : addCents(addCents(monthlyIncomeCents, -monthlyLivingCents), -monthlyCommitmentsCents);
  const partTimeHeadroomCents = partTimeMonthlyIncomeCents === null || monthlyLivingCents === null ? null : addCents(addCents(partTimeMonthlyIncomeCents, -monthlyLivingCents), -monthlyCommitmentsCents);
  const headroomPerPayCents = monthlyHeadroomCents === null || frequency === null ? null : Math.floor(addCents(0, monthlyHeadroomCents * 12) / frequency);
  const ranked = rankedInterestDebts(debts);
  const first = ranked[0];
  const debtPriority = first ? { id: first.id, name: first.name, balanceCents: first.balanceCents, aprPercent: effectiveDebtApr(first, true)! } : null;
  const expensiveDebt = debtPriority !== null && debtPriority.aprPercent >= 10;
  const blockers: string[] = [];
  if (monthlyIncomeCents === null) blockers.push('Confirm regular take-home pay and a weekly or biweekly schedule.');
  if (monthlyLivingCents === null) blockers.push('Set a monthly spending cap that includes ordinary scheduled bills and subscriptions.');
  if (!plan || plan.asOf !== asOf) blockers.push('Refresh the dated cash forecast before assigning money.');
  else {
    blockers.push(...plan.missingInputs.map(item => item.message));
    if (plan.horizonDays < 90) blockers.push('Check a full 90 days of commitments before assigning current cash.');
  }
  for (const debt of debts) {
    if (effectiveDebtApr(debt, true) === null) blockers.push(`Confirm ${debt.name}'s interest terms before finalizing debt priority.`);
    if (paymentDeferral(debt, asOf) === 'deferred' && !debt.debtTerms?.repaymentStartDate) blockers.push(`Confirm when ${debt.name} payments resume. Keep this debt in your lifetime plan.`);
    if (paymentDeferral(debt, asOf) !== 'deferred' && requiredDebtPaymentCents(debt, asOf) === null) blockers.push(`Confirm the required payment for ${debt.name}.`);
  }
  for (const purchase of purchases) if (purchase.paidCents === null) blockers.push(`Confirm the remaining purchase amount for ${purchase.name}.`);
  const forecast = plan?.asOf === asOf ? plan : null;
  const cashFloor = cashCents === null ? null : Math.min(cashCents, forecast?.lowestCashCents ?? cashCents);
  const starterReserveTargetCents = Math.max(100000, roadmap?.planningCashReserveCents ?? 0, state.reserves.filter(reserve => reserve.entityId === ownerId).reduce((sum, reserve) => addCents(sum, reserve.amountCents), 0));
  const reserveGapCents = cashFloor === null ? null : Math.max(0, addCents(starterReserveTargetCents, -cashFloor));
  const fullReserve = monthlyLivingCents === null ? null : Math.max(starterReserveTargetCents, addCents(0, addCents(monthlyLivingCents, monthlyCommitmentsCents) * 3));
  const forecastGapCents = forecast ? Math.max(0, addCents(forecast.protectedCents, -forecast.lowestCashCents)) : null;
  const partTimeGap = !!work && asOf < work.returnDate && (partTimeHeadroomCents ?? 0) < 0;
  const cashGap = (forecastGapCents ?? 0) > 0 || !!forecast?.firstShortfallDate || (monthlyHeadroomCents ?? 0) < 0 || partTimeGap;
  const ready = personal && forecast?.status === 'ready' && forecast.horizonDays >= 90 && blockers.length === 0;
  const stage = cashGap ? 'cashflow' : !ready ? 'review' : (reserveGapCents ?? 1) > 0 ? 'reserve' : expensiveDebt ? 'debt' : fullReserve !== null && (cashFloor ?? 0) < fullReserve ? 'reserve' : 'invest';
  const investmentNowCents = cashGap || (reserveGapCents ?? 0) > 0 || expensiveDebt ? 0 : null;
  const stages: CompoundingPlanData['stages'] = [
    { id: 'cashflow', title: 'Cover the cash gap before investing', description: forecastGapCents ? `The dated forecast needs up to ${money(forecastGapCents)} more to cover known costs and the saved reserve. Confirm outstanding payments and deposit timing first. Expected income is not cash received.` : 'Fund required payments on their actual dates. Keep optional purchases at zero until recurring income covers the spending cap, installments and minimums.' },
    { id: 'review', title: 'Confirm the budget and upcoming income', description: `Keep ordinary spending within ${monthlyLivingCents === null ? 'a confirmed monthly cap' : `${money(monthlyLivingCents)} a month`}, including subscriptions. Purchase installments and debt payments are separate. Confirm any work or school income change before committing future paychecks.` },
    { id: 'reserve', title: 'Build a cash reserve from confirmed surplus', description: `Start with ${money(starterReserveTargetCents)} kept in cash after upcoming bills. This is a suggested target, separate from the saved forecast reserve. After expensive debt is cleared, build toward ${fullReserve === null ? 'three months of confirmed costs' : `${money(fullReserve)} for three months of known costs`}; missing payments may increase it.` },
    { id: 'debt', title: 'Stop expensive interest before adding investments', description: debtPriority ? `${debtPriority.name} is the highest confirmed rate at ${debtPriority.aprPercent.toLocaleString('en-CA', { maximumFractionDigits: 2 })}%. After the starter reserve and required payments, direct confirmed surplus to double-digit interest debt. Confirm unknown rates and employer matching before finalizing the order.` : 'Confirm all interest rates and employer matching. After the starter reserve and required payments, prioritize double-digit interest debt; compare lower-rate debt with investing.' },
    { id: 'invest', title: 'Turn freed payments into lifelong contributions', description: 'Once cash flow, expensive debt and the reserve are covered, automate contributions each payday to a low-cost diversified portfolio. Check employer matching, TFSA room, tax treatment and loss tolerance first. Reinvest returns, redirect freed debt payments, and fund optional comfort purchases only after the contribution.' },
  ];
  return { stage, monthlyIncomeCents, monthlyLivingCents, monthlyCommitmentsCents, monthlyHeadroomCents, headroomPerPayCents, investmentNowCents,
    partTimeMonthlyIncomeCents, partTimeHeadroomCents,
    starterReserveTargetCents, reserveGapCents, cashCents, investmentCents, knownDebtMinimumsCents, monthlyPurchaseCents, forecastGapCents, debtPriority,
    blockers: [...new Set(blockers)], stages, forecastEndDate: forecast?.endDate ?? null,
    futureExamples: [10, 20, 30].map(years => ({ monthlyCents: 100000, years, contributedCents: 100000 * years * 12, atFourPercentCents: compoundContributions(100000, years, 4), atSixPercentCents: compoundContributions(100000, years, 6) })),
  };
}
