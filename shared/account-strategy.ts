import type { Account, AppState } from './types.ts';
import { today } from './analytics.ts';
import { effectiveDebtApr, rankedInterestDebts } from './debt-model.ts';
import { debtPaymentStatus } from './debt-status.ts';
import { tdPlanningMinimumEstimate, type TdMinimumEstimate } from './td-minimum.ts';

export interface AccountStrategyData {
  ownerId: string | null;
  cashCents: number | null;
  rankedDebts: Account[];
  debtsMissingRates: Account[];
  tdCard: Account | null;
  cibcLine: Account | null;
  tdChequing: Account | null;
  livingCostsKnown: boolean;
  tdMinimumKnown: boolean;
  tdMinimumEstimate: TdMinimumEstimate | null;
}

export function annualInterestPerThousand(aprPercent: number): number {
  if (!Number.isFinite(aprPercent) || aprPercent < 0 || aprPercent > 1000) throw new Error('Use a valid recorded annual interest rate.');
  return Math.round(100000 * aprPercent / 100);
}

export function accountStrategyData(state: AppState, scope = 'all', asOf = today()): AccountStrategyData {
  const ownerId = (scope === 'all' ? state.entities.find(owner => owner.kind === 'personal') : state.entities.find(owner => owner.id === scope))?.id ?? null;
  const accounts = state.accounts.filter(account => account.entityId === ownerId);
  const cash = accounts.filter(account => account.type === 'cash');
  const cashTotal = cash.reduce((sum, account) => sum + BigInt(account.balanceCents), 0n);
  if (cashTotal > BigInt(Number.MAX_SAFE_INTEGER) || cashTotal < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Cash exceeds the supported amount in cents.');
  const debts = accounts.filter(account => (account.type === 'debt' || account.type === 'payable') && account.balanceCents > 0 && debtPaymentStatus(account, asOf) !== 'in_study');
  const tdCard = debts.find(account => /\bTD\b/i.test(account.name) && /visa|credit card/i.test(account.name)) ?? null;
  return {
    ownerId, cashCents: cash.length ? Number(cashTotal) : null,
    rankedDebts: rankedInterestDebts(debts),
    debtsMissingRates: debts.filter(account => effectiveDebtApr(account, true) === null),
    tdCard,
    cibcLine: debts.find(account => /\bCIBC\b/i.test(account.name) && /LOC|line of credit/i.test(account.name)) ?? null,
    tdChequing: cash.find(account => /\bTD\b/i.test(account.name) && /chequing/i.test(account.name)) ?? null,
    livingCostsKnown: state.roadmap?.monthlyEssentialsCents !== undefined && state.roadmap.monthlyEssentialsCents !== null,
    tdMinimumKnown: tdCard !== null && tdCard.debtTerms?.minimumPaymentCents !== undefined && tdCard.debtTerms.minimumPaymentCents !== null && !!tdCard.debtTerms.paymentDueDate && tdCard.debtTerms.paymentDueDate >= asOf,
    tdMinimumEstimate: tdCard ? tdPlanningMinimumEstimate(tdCard, asOf) : null,
  };
}
