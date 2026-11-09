import type { AppState, SpendingLimit } from './types.ts';
import { addCents, today } from './analytics.ts';
import { categoryLimits, transactionCategoryMatcher } from './expense-categories.ts';

export type SpendingPeriod = 'daily' | 'weekly' | 'monthly';
export interface SpendingRow { limit: SpendingLimit; spentCents: number; transactionCount: number }
export interface SpendingOverview { start: string; end: string; asOf: string; rows: SpendingRow[]; totalSpentCents: number }

export function monthlyBudgetCents(limit: SpendingLimit, month: string): number | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Choose a month as YYYY-MM.');
  return limit.monthlyAmounts && Object.hasOwn(limit.monthlyAmounts, month) ? limit.monthlyAmounts[month] : limit.monthlyCents;
}

export function limitsForOwner(state: AppState, entityId: string, month = today().slice(0, 7)): SpendingLimit[] {
  return categoryLimits(state, entityId, true).map(limit => ({ ...limit, monthlyCents: monthlyBudgetCents(limit, month) }));
}

export function periodBounds(period: SpendingPeriod, asOf = today()): { start: string; end: string } {
  const date = new Date(`${asOf}T12:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== asOf) throw new Error('Choose a valid calendar date.');
  const start = new Date(date);
  const end = new Date(date);
  if (period === 'weekly') {
    start.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    end.setTime(start.getTime() + 6 * 86_400_000);
  } else if (period === 'monthly') {
    start.setUTCDate(1);
    end.setUTCMonth(date.getUTCMonth() + 1, 0);
  }
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function spendingOverview(state: AppState, entityId: string, period: SpendingPeriod, asOf = today()): SpendingOverview {
  const { start, end } = periodBounds(period, asOf);
  const rows = limitsForOwner(state, entityId, asOf.slice(0, 7)).map((limit) => ({ limit, spentCents: 0, transactionCount: 0 }));
  const rowById = new Map(rows.map(row => [row.limit.id, row]));
  const matchTransaction = transactionCategoryMatcher(state, entityId, rows.map(row => row.limit));
  const accounts = new Set(state.accounts.filter((account) => account.entityId === entityId).map((account) => account.id));
  let totalSpentCents = 0;
  for (const transaction of state.transactions) {
    if (transaction.kind !== 'expense' || !accounts.has(transaction.accountId) || transaction.date < start || transaction.date > end || transaction.date > asOf) continue;
    const row = rowById.get(matchTransaction(transaction).id)!;
    row.spentCents = addCents(row.spentCents, transaction.amountCents);
    row.transactionCount += 1;
    totalSpentCents = addCents(totalSpentCents, transaction.amountCents);
  }
  return { start, end, asOf, rows, totalSpentCents };
}

export function selectedLimit(limit: SpendingLimit, period: SpendingPeriod): number | null {
  return period === 'daily' ? limit.dailyCents : period === 'weekly' ? limit.weeklyCents : limit.monthlyCents;
}
