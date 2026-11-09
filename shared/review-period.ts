import { addCents } from './analytics.ts';
import { activeExpenseTransactions } from './category-review.ts';
import { categoryLimits, categoryTemplateFor, isUncategorized, normalizedCategory, transactionCategoryMatcher } from './expense-categories.ts';
import { recentActivity } from './home.ts';
import type { AppState, Transaction } from './types.ts';

export type ReviewCadence = 'daily' | 'weekly' | 'monthly';

export interface ReviewTotals {
  expensesCents: number;
  grossExpensesCents: number;
  refundsCents: number;
  incomeCents: number;
  netCents: number;
  recordCount: number;
  expenseCount: number;
  incomeCount: number;
  hasRecords: boolean;
}

export interface ReviewRange extends ReviewTotals {
  start: string;
  end: string;
  through: string;
  label: string;
}

export interface ReviewDay {
  date: string;
  expensesCents: number;
  incomeCents: number;
  recordCount: number;
  isFuture: boolean;
}

export interface ReviewCategory {
  key: string;
  label: string;
  color: string;
  totalCents: number;
  recordCount: number;
}

export interface ReviewActivity {
  transaction: Transaction;
  amountCents: number;
  recordedAmountCents: number;
  ownershipBps: number;
  categoryKey: string | null;
  categoryLabel: string | null;
  accountName: string;
  ownerName: string;
}

export interface ReviewPeriod extends ReviewRange {
  cadence: ReviewCadence;
  offset: number;
  isCurrent: boolean;
  isComplete: boolean;
  dayCount: number;
  elapsedDays: number;
  previous: ReviewRange;
  expenseDifferenceCents: number;
  incomeDifferenceCents: number;
  expenseChangePercent: number | null;
  days: ReviewDay[];
  categories: ReviewCategory[];
  uncategorizedCount: number;
  latestTransactions: Transaction[];
  activity: ReviewActivity[];
  activityCount: number;
  hasWeightedAmounts: boolean;
}

const dayMilliseconds = 86_400_000;
const dateValue = (date: string) => new Date(`${date}T12:00:00Z`);
const dayCount = (start: string, end: string) => Math.round((dateValue(end).getTime() - dateValue(start).getTime()) / dayMilliseconds) + 1;

function validDate(date: string): boolean {
  const value = dateValue(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

function dateString(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Review period is outside the supported calendar.');
  const value = date.toISOString().slice(0, 10);
  if (!validDate(value)) throw new Error('Review period is outside the supported calendar.');
  return value;
}

function shiftDays(value: string, offset: number): string {
  const date = dateValue(value);
  date.setUTCDate(date.getUTCDate() + offset);
  return dateString(date);
}

function rangeFor(asOf: string, cadence: ReviewCadence, offset: number): { start: string; end: string } {
  const date = dateValue(asOf);
  if (cadence === 'daily') {
    const start = shiftDays(asOf, offset);
    return { start, end: start };
  }
  if (cadence === 'weekly') {
    const start = shiftDays(asOf, -(date.getUTCDay() + 6) % 7 + offset * 7);
    return { start, end: shiftDays(start, 6) };
  }
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const start = dateString(date);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return { start, end: dateString(date) };
}

function rangeLabel(start: string, end: string, cadence: ReviewCadence): string {
  const format = (value: string, options: Intl.DateTimeFormatOptions) => dateValue(value).toLocaleDateString('en-CA', { ...options, timeZone: 'UTC' });
  if (cadence === 'daily') return format(start, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (cadence === 'monthly') return format(start, { month: 'long', year: 'numeric' });
  return `${format(start, { month: 'short', day: 'numeric', ...(start.slice(0, 4) !== end.slice(0, 4) ? { year: 'numeric' } : {}) })} to ${format(end, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function weightedCents(amount: number, ownershipBps: number): number {
  addCents(0, amount);
  const value = BigInt(amount) * BigInt(ownershipBps);
  return addCents(0, Number((value + (value < 0n ? -5000n : 5000n)) / 10000n));
}

function totals(activity: ReviewActivity[]): ReviewTotals {
  const result: ReviewTotals = { expensesCents: 0, grossExpensesCents: 0, refundsCents: 0, incomeCents: 0, netCents: 0, recordCount: 0, expenseCount: 0, incomeCount: 0, hasRecords: false };
  for (const entry of activity) {
    if (entry.transaction.kind === 'expense') {
      result.expensesCents = addCents(result.expensesCents, entry.amountCents);
      if (entry.amountCents < 0) result.refundsCents = addCents(result.refundsCents, -entry.amountCents);
      else result.grossExpensesCents = addCents(result.grossExpensesCents, entry.amountCents);
      result.expenseCount++;
    } else if (entry.transaction.kind === 'income') {
      result.incomeCents = addCents(result.incomeCents, entry.amountCents);
      result.incomeCount++;
    }
  }
  result.netCents = addCents(result.incomeCents, -result.expensesCents);
  result.recordCount = result.expenseCount + result.incomeCount;
  result.hasRecords = result.recordCount > 0;
  return result;
}

export function buildReviewPeriod(state: AppState, scope: string, asOf: string, cadence: ReviewCadence, offset = 0): ReviewPeriod {
  if (!validDate(asOf)) throw new Error('Choose a valid review date as YYYY-MM-DD.');
  if (!['daily', 'weekly', 'monthly'].includes(cadence)) throw new Error('Choose a daily, weekly, or monthly review.');
  if (!Number.isSafeInteger(offset) || offset > 0) throw new Error('Review offset must be zero or a negative whole number.');
  const range = rangeFor(asOf, cadence, offset);
  const previousRange = rangeFor(asOf, cadence, offset - 1);
  const through = range.end < asOf ? range.end : asOf;
  const elapsedDays = dayCount(range.start, through);
  const isComplete = range.end < asOf;
  const previousThrough = isComplete ? previousRange.end : shiftDays(previousRange.start, Math.min(elapsedDays, dayCount(previousRange.start, previousRange.end)) - 1);
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const owners = new Map(state.entities.map(entity => [entity.id, entity]));
  const recorded = state.transactions.filter(transaction => validDate(transaction.date) && transaction.date <= asOf);
  const activeExpenseIds = new Set(activeExpenseTransactions(recorded).map(transaction => transaction.id));
  const savedIds = new Set((state.spendingLimits ?? []).map(limit => limit.id));
  const matchers = new Map<string, ReturnType<typeof transactionCategoryMatcher>>();
  const categories = new Map<string, ReviewCategory>();
  const categoryFor = (transaction: Transaction) => {
    const ownerId = accounts.get(transaction.accountId)!.entityId;
    let match = matchers.get(ownerId);
    if (!match) {
      match = transactionCategoryMatcher(state, ownerId, categoryLimits(state, ownerId));
      matchers.set(ownerId, match);
    }
    const limit = match(transaction);
    const template = categoryTemplateFor(limit);
    const savedName = savedIds.has(limit.id) && template && ![template.name, template.label].some(name => normalizedCategory(name) === normalizedCategory(limit.name));
    const label = savedName ? limit.name : template?.label ?? limit.name;
    return { key: template?.key ?? `custom:${normalizedCategory(label)}`, label, color: limit.color };
  };
  const toActivity = (transaction: Transaction): ReviewActivity => {
    const account = accounts.get(transaction.accountId);
    const owner = account ? owners.get(account.entityId) : undefined;
    const counted = transaction.kind === 'expense' || transaction.kind === 'income';
    const ownershipBps = counted && scope === 'all' ? owner?.ownershipBps ?? 0 : 10000;
    const category = transaction.kind === 'expense' && account ? categoryFor(transaction) : null;
    return {
      transaction, amountCents: counted ? weightedCents(transaction.amountCents, ownershipBps) : transaction.amountCents,
      recordedAmountCents: transaction.amountCents, ownershipBps, categoryKey: category?.key ?? null, categoryLabel: category?.label ?? null,
      accountName: account?.name ?? '', ownerName: owner?.name ?? '',
    };
  };
  const activityState = { ...state, transactions: recorded };
  const latestTransactions = recentActivity(activityState, scope, through, Number.MAX_SAFE_INTEGER).filter(transaction => transaction.date >= range.start);
  const activity = latestTransactions.map(toActivity);
  const previousActivity = recentActivity(activityState, scope, previousThrough, Number.MAX_SAFE_INTEGER).filter(transaction => transaction.date >= previousRange.start).map(toActivity);
  const currentTotals = totals(activity);
  const previousTotals = totals(previousActivity);
  const days: ReviewDay[] = Array.from({ length: dayCount(range.start, range.end) }, (_, index) => {
    const date = shiftDays(range.start, index);
    return { date, expensesCents: 0, incomeCents: 0, recordCount: 0, isFuture: date > asOf };
  });
  const daysByDate = new Map(days.map(day => [day.date, day]));
  let uncategorizedCount = 0;
  for (const entry of activity) {
    const transaction = entry.transaction;
    const day = daysByDate.get(transaction.date)!;
    if (transaction.kind === 'expense') {
      day.expensesCents = addCents(day.expensesCents, entry.amountCents);
      day.recordCount++;
      const category = categoryFor(transaction);
      const row = categories.get(category.key) ?? { ...category, totalCents: 0, recordCount: 0 };
      row.totalCents = addCents(row.totalCents, entry.amountCents);
      row.recordCount++;
      categories.set(category.key, row);
      if (activeExpenseIds.has(transaction.id) && isUncategorized(transaction.expenseCategory ?? transaction.category)) uncategorizedCount++;
    } else if (transaction.kind === 'income') {
      day.incomeCents = addCents(day.incomeCents, entry.amountCents);
      day.recordCount++;
    }
  }
  const expenseDifferenceCents = addCents(currentTotals.expensesCents, -previousTotals.expensesCents);
  return {
    ...range, through, label: rangeLabel(range.start, range.end, cadence), ...currentTotals,
    cadence, offset, isCurrent: offset === 0, isComplete, dayCount: days.length, elapsedDays,
    previous: { ...previousRange, through: previousThrough, label: rangeLabel(previousRange.start, previousRange.end, cadence), ...previousTotals },
    expenseDifferenceCents, incomeDifferenceCents: addCents(currentTotals.incomeCents, -previousTotals.incomeCents),
    expenseChangePercent: previousTotals.expenseCount && previousTotals.expensesCents > 0 ? expenseDifferenceCents / previousTotals.expensesCents * 100 : null,
    days, categories: [...categories.values()].sort((a, b) => b.totalCents - a.totalCents || a.label.localeCompare(b.label)),
    uncategorizedCount, latestTransactions, activity, activityCount: activity.length,
    hasWeightedAmounts: activity.some(entry => entry.ownershipBps !== 10000),
  };
}
