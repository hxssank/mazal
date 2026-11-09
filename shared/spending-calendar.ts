import type { AppState, Transaction } from './types.ts';
import { addCents } from './analytics.ts';
import { categoryLimits, categoryTemplateFor, normalizedCategory, transactionCategoryMatcher } from './expense-categories.ts';

export interface CalendarExpense {
  transaction: Transaction;
  amountCents: number;
  recordedAmountCents: number;
  accountName: string;
  ownerName: string;
  ownershipBps: number;
}

export interface SpendingDay {
  date: string;
  totalCents: number;
  entries: CalendarExpense[];
  isFuture: boolean;
}

export interface SpendingMonth {
  month: string;
  firstWeekday: number;
  days: SpendingDay[];
  totalCents: number;
  transactionCount: number;
  largestDayCents: number;
  hasWeightedExpenses: boolean;
}

export interface SpendingMonthSummary {
  categories: { key: string; label: string; totalCents: number }[];
  daysWithExpenses: number;
  highestDay: SpendingDay | null;
}

export function summarizeSpendingMonth(state: AppState, data: SpendingMonth): SpendingMonthSummary {
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const savedIds = new Set((state.spendingLimits ?? []).map(limit => limit.id));
  const matchers = new Map<string, ReturnType<typeof transactionCategoryMatcher>>();
  const categories = new Map<string, SpendingMonthSummary['categories'][number]>();
  let daysWithExpenses = 0;
  let highestDay: SpendingDay | null = null;
  for (const day of data.days) {
    if (day.entries.length) daysWithExpenses++;
    if (day.totalCents > (highestDay?.totalCents ?? 0)) highestDay = day;
    for (const entry of day.entries) {
      const ownerId = accounts.get(entry.transaction.accountId)?.entityId ?? '';
      let match = matchers.get(ownerId);
      if (!match) {
        match = transactionCategoryMatcher(state, ownerId, categoryLimits(state, ownerId));
        matchers.set(ownerId, match);
      }
      const limit = match(entry.transaction);
      const template = categoryTemplateFor(limit);
      const savedName = savedIds.has(limit.id) && template && ![template.name, template.label].some(name => normalizedCategory(name) === normalizedCategory(limit.name));
      const label = savedName ? limit.name : template?.label ?? limit.name;
      const key = template?.key ?? `custom:${normalizedCategory(label)}`;
      const category = categories.get(key) ?? { key, label, totalCents: 0 };
      category.totalCents = addCents(category.totalCents, entry.amountCents);
      categories.set(key, category);
    }
  }
  return { categories: [...categories.values()].sort((a, b) => b.totalCents - a.totalCents || a.label.localeCompare(b.label)), daysWithExpenses, highestDay };
}

function monthDate(month: string): Date {
  const value = new Date(`${month}-01T12:00:00Z`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isFinite(value.getTime())) throw new Error('Choose a calendar month as YYYY-MM.');
  return value;
}

export function shiftCalendarMonth(month: string, offset: number): string {
  if (!Number.isInteger(offset)) throw new Error('Month offset must be a whole number.');
  const date = monthDate(month);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

export function spendingCalendar(state: AppState, scope: string, month: string, asOf: string): SpendingMonth {
  const first = monthDate(month);
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const days: SpendingDay[] = Array.from({ length: last.getUTCDate() }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    return { date, totalCents: 0, entries: [], isFuture: date > asOf };
  });
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const owners = new Map(state.entities.map(entity => [entity.id, entity]));
  let totalCents = 0;
  let transactionCount = 0;
  let hasWeightedExpenses = false;
  for (const transaction of state.transactions) {
    if (transaction.kind !== 'expense' || transaction.date.slice(0, 7) !== month || transaction.date > asOf) continue;
    const account = accounts.get(transaction.accountId);
    if (!account || (scope !== 'all' && account.entityId !== scope)) continue;
    const day = days[Number(transaction.date.slice(8, 10)) - 1];
    if (!day || day.date !== transaction.date) continue;
    const owner = owners.get(account.entityId);
    const ownershipBps = scope === 'all' ? owner?.ownershipBps ?? 0 : 10000;
    const weightedCents = BigInt(transaction.amountCents) * BigInt(ownershipBps);
    const amountCents = Number((weightedCents + (weightedCents < 0n ? -5000n : 5000n)) / 10000n);
    day.entries.push({ transaction, amountCents, recordedAmountCents: transaction.amountCents, accountName: account.name, ownerName: owner?.name ?? '', ownershipBps });
    day.totalCents = addCents(day.totalCents, amountCents);
    totalCents = addCents(totalCents, amountCents);
    transactionCount += 1;
    if (ownershipBps !== 10000) hasWeightedExpenses = true;
  }
  for (const day of days) day.entries.sort((a, b) => b.transaction.createdAt.localeCompare(a.transaction.createdAt) || a.transaction.id.localeCompare(b.transaction.id));
  return {
    month, firstWeekday: (first.getUTCDay() + 6) % 7, days, totalCents, transactionCount,
    largestDayCents: Math.max(0, ...days.map(day => day.totalCents)), hasWeightedExpenses,
  };
}
