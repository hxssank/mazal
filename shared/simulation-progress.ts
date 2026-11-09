import type { SimulationPoint } from './simulation.ts';

export interface SimulationProgress {
  debtPaidCents: number;
  debtPaidPercent: number;
  interestAccruedCents: number;
  investmentGrowthCents: number;
  redirectedDebtCents: number;
}

export interface SimulationMilestone {
  id: 'debt-paid' | 'net-worth-positive' | 'cash-gap';
  month: number;
  valueCents: number;
}

type Points = readonly SimulationPoint[] | null | undefined;

function ordered(points: Points): SimulationPoint[] {
  return [...(points ?? [])].sort((a, b) => a.month - b.month);
}

function safeCents(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error('Cumulative projection exceeds the supported whole-cent range.');
  return amount;
}

export function summarizeProgress(points: Points, month: number): SimulationProgress {
  const result: SimulationProgress = { debtPaidCents: 0, debtPaidPercent: 0, interestAccruedCents: 0, investmentGrowthCents: 0, redirectedDebtCents: 0 };
  const timeline = ordered(points);
  const cutoff = Number.isFinite(month) ? Math.max(0, Math.floor(month)) : 0;
  const elapsed = timeline.filter(point => point.month <= cutoff);
  const current = elapsed.at(-1);
  const opening = timeline.find(point => point.month === 0);
  if (!current) return result;
  if (opening && opening.selectedDebtCents > 0) {
    const openingDebt = BigInt(opening.selectedDebtCents);
    const reduction = openingDebt - BigInt(current.selectedDebtCents);
    const debtPaid = reduction < 0n ? 0n : reduction > openingDebt ? openingDebt : reduction;
    result.debtPaidCents = safeCents(debtPaid);
    result.debtPaidPercent = Number(debtPaid * 10000n / openingDebt) / 100;
  }
  result.interestAccruedCents = safeCents(elapsed.reduce((sum, point) => sum + BigInt(point.interestCents), 0n));
  result.investmentGrowthCents = safeCents(elapsed.reduce((sum, point) => sum + BigInt(point.investmentChangeCents), 0n));
  result.redirectedDebtCents = safeCents(elapsed.reduce((sum, point) => sum + BigInt(point.redirectedDebtCents), 0n));
  return result;
}

export function simulationMilestones(points: Points): SimulationMilestone[] {
  const timeline = ordered(points);
  const opening = timeline.find(point => point.month === 0);
  const milestones: SimulationMilestone[] = [];
  if (opening && opening.selectedDebtCents > 0) {
    const paid = timeline.find(point => point.month > 0 && point.selectedDebtCents === 0);
    if (paid) milestones.push({ id: 'debt-paid', month: paid.month, valueCents: paid.selectedDebtCents });
  }
  if (opening && opening.netWorthCents < 0) {
    const positive = timeline.find(point => point.month > 0 && point.netWorthCents >= 0);
    if (positive) milestones.push({ id: 'net-worth-positive', month: positive.month, valueCents: positive.netWorthCents });
  }
  const gap = timeline.find(point => point.cashCents < 0);
  if (gap) milestones.push({ id: 'cash-gap', month: gap.month, valueCents: gap.cashCents });
  return milestones.sort((a, b) => a.month - b.month || a.id.localeCompare(b.id));
}
