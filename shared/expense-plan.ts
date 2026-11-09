import { addCents, today } from './analytics.ts';
import { monthlyBudgetCents, periodBounds } from './spending.ts';
import { categoryLimits, categoryMatcher, categoryTemplateFor as templateFor, normalizedCategory as normalized, transactionCategoryMatcher } from './expense-categories.ts';
import type { AppState, SpendingLimit, Transaction } from './types.ts';

export interface ExpensePlanRow {
  key: string;
  limit: SpendingLimit;
  label: string;
  examples: string;
  spentCents: number;
  transactionCount: number;
  remainingCents: number | null;
  matchedCategories: string[];
  transactions: Transaction[];
}

export interface ExpensePlanSummary {
  ownerId: string;
  month: string;
  start: string;
  end: string;
  asOf: string;
  rows: ExpensePlanRow[];
  plannedCents: number;
  recordedCents: number;
  plannedCategoryCount: number;
  categoryCount: number;
  plannedSpendingCents: number;
  unplannedSpendingCents: number;
  transactionCount: number;
}

export function expensePlanLimits(state: AppState, ownerId: string, month?: string): SpendingLimit[] {
  return categoryLimits(state, ownerId).map(limit => month ? { ...limit, monthlyCents: monthlyBudgetCents(limit, month) } : limit);
}

export function expensePlanCategory(state: AppState, ownerId: string, transactionCategory: string): string {
  return categoryMatcher(expensePlanLimits(state, ownerId), new Set((state.spendingLimits ?? []).map(limit => limit.id)))(transactionCategory).name;
}

export function expensePlanTransactionCategory(state: AppState, ownerId: string, transaction: Transaction): string {
  return transactionCategoryMatcher(state, ownerId, expensePlanLimits(state, ownerId))(transaction).name;
}

export function buildExpensePlan(state: AppState, ownerId: string, month: string, asOf = today()): ExpensePlanSummary {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Choose a month as YYYY-MM.');
  periodBounds('daily', asOf);
  const { start, end } = periodBounds('monthly', `${month}-01`);
  const limits = expensePlanLimits(state, ownerId, month);
  const savedIds = new Set((state.spendingLimits ?? []).map(limit => limit.id));
  const matchTransaction = transactionCategoryMatcher(state, ownerId, limits);
  const rows: ExpensePlanRow[] = limits.map(limit => {
    const template = templateFor(limit);
    const savedName = savedIds.has(limit.id) && template && ![template.name, template.label].some(name => normalized(name) === normalized(limit.name));
    return { key: template?.key ?? limit.id, limit, label: savedName ? limit.name : template?.label ?? limit.name, examples: savedName || !template ? (limit.aliases.length ? limit.aliases.slice(0, 3).join(', ') : 'Your saved category') : template.examples, spentCents: 0, transactionCount: 0, remainingCents: limit.monthlyCents, matchedCategories: [], transactions: [] };
  });
  const rowById = new Map(rows.map(row => [row.limit.id, row]));
  const accounts = new Set(state.accounts.filter(account => account.entityId === ownerId).map(account => account.id));
  let recordedCents = 0;
  let transactionCount = 0;
  for (const transaction of state.transactions) {
    if (transaction.kind !== 'expense' || !accounts.has(transaction.accountId) || transaction.date < start || transaction.date > end || transaction.date > asOf) continue;
    const limit = matchTransaction(transaction);
    const row = rowById.get(limit.id)!;
    row.spentCents = addCents(row.spentCents, transaction.amountCents);
    row.transactionCount += 1;
    row.transactions.push(transaction);
    if (!row.matchedCategories.includes(transaction.category)) row.matchedCategories.push(transaction.category);
    recordedCents = addCents(recordedCents, transaction.amountCents);
    transactionCount += 1;
  }
  let plannedCents = 0;
  let plannedCategoryCount = 0;
  let plannedSpendingCents = 0;
  let unplannedSpendingCents = 0;
  for (const row of rows) {
    row.transactions.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    if (row.limit.monthlyCents === null) { unplannedSpendingCents = addCents(unplannedSpendingCents, row.spentCents); continue; }
    plannedCents = addCents(plannedCents, row.limit.monthlyCents);
    plannedCategoryCount += 1;
    plannedSpendingCents = addCents(plannedSpendingCents, row.spentCents);
    row.remainingCents = addCents(row.limit.monthlyCents, -row.spentCents);
  }
  return { ownerId, month, start, end, asOf, rows, plannedCents, recordedCents, plannedCategoryCount, categoryCount: rows.length, plannedSpendingCents, unplannedSpendingCents, transactionCount };
}

export function parseExpensePlanAmount(value: string): number | null {
  const clean = value.trim();
  if (!clean) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) throw new Error('Enter zero or a positive amount with up to two decimal places.');
  const [whole, fraction = ''] = clean.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > 100000000000000n) throw new Error('This monthly amount is above the supported limit.');
  return Number(cents);
}

export function createExpensePlanCategory(input: { id: string; ownerId: string; name: string; monthlyAmount: string; categories: string }, existingNames: readonly string[] = []): SpendingLimit {
  const name = input.name.trim();
  if (!name) throw new Error('Enter a category name.');
  if (existingNames.some(existing => normalized(existing) === normalized(name))) throw new Error('This category already exists. Edit its monthly amount instead.');
  const seen = new Set([normalized(name)]);
  const aliases = input.categories.split(',').map(category => category.trim()).filter(category => {
    const key = normalized(category);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { id: input.id, entityId: input.ownerId, name, aliases, color: '#7D4DD5', dailyCents: null, weeklyCents: null, monthlyCents: parseExpensePlanAmount(input.monthlyAmount) };
}
