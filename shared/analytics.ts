import type { AppState, Obligation, Transaction } from './types.ts';
import { owedRemaining } from './asset-planning.ts';
import { purchaseRemaining } from './asset-purchases.ts';

export interface Summary {
  assetsCents: number;
  liabilitiesCents: number;
  netWorthCents: number;
  cashCents: number;
  investmentsCents: number;
  receivablesCents: number;
  physicalAssetsCents: number;
  purchaseEquityCents: number;
  availableCents: number;
  reservedCents: number;
  committedCents: number;
  incomeCents: number;
  expensesCents: number;
  personalAvailableCents: number;
}

export type Occurrence = Obligation & { occurrenceDate: string };
export interface ForecastPoint { date: string; cashCents: number }

const wholeDollarFormatter = new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', minimumFractionDigits: 0, maximumFractionDigits: 0,
});
const centsFormatter = new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function money(cents: number): string {
  return (cents % 100 === 0 ? wholeDollarFormatter : centsFormatter).format(cents / 100);
}

export function addCents(total: number, amount: number): number {
  const result = total + amount;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(amount) || !Number.isSafeInteger(result)) throw new Error('Money total exceeds the supported amount in whole cents.');
  return result;
}

function dateValue(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

function dayAfter(value: string, days: number): string {
  const date = dateValue(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthAfter(value: string, months: number, recurrenceDay?: number): string {
  const original = dateValue(value);
  const date = dateValue(value);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const endOfMonth = new Date(date);
  endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(recurrenceDay ?? original.getUTCDate(), endOfMonth.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

function boundedDays(days: number): number {
  if (!Number.isInteger(days) || days < 0 || days > 3660) {
    throw new Error('Choose a forecast period between 0 and 3,660 whole days.');
  }
  return days;
}

export function recordedObligationDates(transactions: readonly Transaction[]): Map<string, Set<string>> {
  const dates = new Map<string, Set<string>>();
  for (const { plannedPayment } of transactions) {
    if (!plannedPayment) continue;
    const paid = dates.get(plannedPayment.obligationId) ?? new Set<string>();
    paid.add(plannedPayment.dueDate);
    dates.set(plannedPayment.obligationId, paid);
  }
  return dates;
}

export function upcoming(state: AppState, entityId = 'all', days = 90): Occurrence[] {
  const start = today();
  const end = dayAfter(start, boundedDays(days));
  const result: Occurrence[] = [];
  const recorded = recordedObligationDates(state.transactions);
  for (const obligation of state.obligations) {
    if (obligation.status === 'cancelled') continue;
    if (entityId !== 'all' && obligation.entityId !== entityId) continue;
    if (obligation.dueDate > end) continue;
    const paid = recorded.get(obligation.id);
    if (obligation.status === 'planned' && !paid?.has(obligation.dueDate)) {
      result.push({ ...obligation, occurrenceDate: obligation.dueDate });
    }
    if (obligation.recurrence === 'once') continue;
    const anchor = dateValue(obligation.dueDate);
    const current = dateValue(start);
    let offset = obligation.recurrence === 'monthly'
      ? Math.max(1, (current.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + current.getUTCMonth() - anchor.getUTCMonth())
      : Math.max(1, Math.floor((current.getTime() - anchor.getTime()) / (14 * 86_400_000)));
    for (;;) {
      const occurrenceDate = obligation.recurrence === 'monthly'
        ? monthAfter(obligation.dueDate, offset, obligation.recurrenceDay)
        : dayAfter(obligation.dueDate, offset * 14);
      if (occurrenceDate > end) break;
      if (occurrenceDate >= start && !paid?.has(occurrenceDate)) {
        result.push({ ...obligation, dueDate: occurrenceDate, occurrenceDate, status: 'planned' });
      }
      offset += 1;
    }
  }
  return result.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function summarize(state: AppState, entityId = 'all'): Summary {
  const entities = new Map(state.entities.map((entity) => [entity.id, entity]));
  const personalIds = new Set(state.entities.filter((entity) => entity.kind === 'personal').map((entity) => entity.id));
  const included = (id: string) => entityId === 'all' || id === entityId;
  const weighted = (cents: number, owner: string) => entityId === 'all'
    ? Number((BigInt(Math.abs(cents)) * BigInt(entities.get(owner)?.ownershipBps ?? 0) + 5000n) / 10000n) * Math.sign(cents)
    : cents;
  const result: Summary = {
    assetsCents: 0, liabilitiesCents: 0, netWorthCents: 0, cashCents: 0,
    investmentsCents: 0, receivablesCents: 0, physicalAssetsCents: 0, purchaseEquityCents: 0, availableCents: 0, reservedCents: 0,
    committedCents: 0, incomeCents: 0, expensesCents: 0, personalAvailableCents: 0,
  };
  for (const account of state.accounts) {
    if (personalIds.has(account.entityId) && account.type === 'cash') result.personalAvailableCents = addCents(result.personalAvailableCents, account.balanceCents);
    if (!included(account.entityId)) continue;
    const balance = weighted(account.balanceCents, account.entityId);
    if (account.type === 'debt' || account.type === 'payable') result.liabilitiesCents = addCents(result.liabilitiesCents, balance);
    else result.assetsCents = addCents(result.assetsCents, balance);
    if (account.type === 'cash') result.cashCents = addCents(result.cashCents, balance);
    if (account.type === 'investment') result.investmentsCents = addCents(result.investmentsCents, balance);
    if (account.type === 'receivable') result.receivablesCents = addCents(result.receivablesCents, balance);
  }
  for (const tab of state.moneyOwed ?? []) {
    if (!included(tab.entityId)) continue;
    if (state.accounts.some(account => account.id === tab.id && account.entityId === tab.entityId && account.type === 'receivable')) continue;
    const remaining = weighted(owedRemaining(tab), tab.entityId);
    result.receivablesCents = addCents(result.receivablesCents, remaining);
    result.assetsCents = addCents(result.assetsCents, remaining);
  }
  for (const purchase of state.assetPurchases ?? []) {
    if (!included(purchase.entityId) || purchase.paidCents === null) continue;
    const equity = weighted(purchase.paidCents, purchase.entityId);
    result.purchaseEquityCents = addCents(result.purchaseEquityCents, equity);
    result.assetsCents = addCents(result.assetsCents, equity);
  }
  for (const asset of state.assets ?? []) {
    if (!included(asset.entityId) || asset.status === 'sold' || asset.estimatedValueCents === null) continue;
    if (state.assetPurchases?.some(purchase => purchase.id === asset.id && purchase.entityId === asset.entityId)) continue;
    const estimated = weighted(Math.max(0, asset.estimatedValueCents - asset.feesCents), asset.entityId);
    result.physicalAssetsCents = addCents(result.physicalAssetsCents, estimated);
    result.assetsCents = addCents(result.assetsCents, estimated);
  }
  for (const reserve of state.reserves) {
    if (personalIds.has(reserve.entityId)) result.personalAvailableCents = addCents(result.personalAvailableCents, -reserve.amountCents);
    if (included(reserve.entityId)) result.reservedCents = addCents(result.reservedCents, weighted(reserve.amountCents, reserve.entityId));
  }
  const purchaseBalances = new Map((state.assetPurchases ?? []).map(purchase => [purchase.id, purchaseRemaining(purchase)]));
  for (const obligation of upcoming(state, 'all', 30)) {
    if (obligation.direction !== 'out') continue;
    let amount = obligation.amountCents;
    if (obligation.assetPurchaseId) {
      const remaining = purchaseBalances.get(obligation.assetPurchaseId);
      if (remaining === null) continue;
      if (remaining !== undefined) {
        amount = Math.min(amount, remaining);
        purchaseBalances.set(obligation.assetPurchaseId, remaining - amount);
      }
    }
    if (personalIds.has(obligation.entityId)) result.personalAvailableCents = addCents(result.personalAvailableCents, -amount);
    if (included(obligation.entityId)) result.committedCents = addCents(result.committedCents, weighted(amount, obligation.entityId));
  }
  const accounts = new Map(state.accounts.map((account) => [account.id, account]));
  const currentDate = today();
  const month = currentDate.slice(0, 7);
  for (const transaction of state.transactions) {
    if (transaction.date.slice(0, 7) !== month || transaction.date > currentDate) continue;
    const account = accounts.get(transaction.accountId);
    if (!account || !included(account.entityId)) continue;
    if (transaction.kind === 'income') result.incomeCents = addCents(result.incomeCents, weighted(transaction.amountCents, account.entityId));
    if (transaction.kind === 'expense') result.expensesCents = addCents(result.expensesCents, weighted(transaction.amountCents, account.entityId));
  }
  result.netWorthCents = addCents(result.assetsCents, -result.liabilitiesCents);
  result.availableCents = entityId === 'all'
    ? result.personalAvailableCents
    : addCents(addCents(result.cashCents, -result.reservedCents), -result.committedCents);
  return result;
}

export function forecast(state: AppState, entityId = state.entities.find((entity) => entity.kind === 'personal')?.id ?? 'personal', days = 90, purchaseCents = 0): ForecastPoint[] {
  boundedDays(days);
  if (!Number.isSafeInteger(purchaseCents) || purchaseCents < 0) throw new Error('Enter a nonnegative purchase amount in cents.');
  const start = today();
  const entities = new Map(state.entities.map((entity) => [entity.id, entity]));
  const accounts = new Map(state.accounts.map((account) => [account.id, account]));
  const weighted = (cents: number, owner: string) => entityId === 'all'
    ? Number((BigInt(Math.abs(cents)) * BigInt(entities.get(owner)?.ownershipBps ?? 0) + 5000n) / 10000n) * Math.sign(cents)
    : cents;
  let cash = addCents(state.accounts.reduce((total, account) => account.type === 'cash' && (entityId === 'all' || account.entityId === entityId)
    ? addCents(total, weighted(account.balanceCents, account.entityId)) : total, 0), -purchaseCents);
  const scheduled = new Map<string, number>();
  for (const occurrence of upcoming(state, entityId, days)) {
    if (accounts.get(occurrence.accountId)?.type !== 'cash') continue;
    const date = occurrence.dueDate < start ? start : occurrence.dueDate;
    const delta = weighted(occurrence.amountCents, occurrence.entityId) * (occurrence.direction === 'in' ? 1 : -1);
    scheduled.set(date, addCents(scheduled.get(date) ?? 0, delta));
  }
  const result: ForecastPoint[] = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = dayAfter(start, offset);
    cash = addCents(cash, scheduled.get(date) ?? 0);
    result.push({ date, cashCents: cash });
  }
  return result;
}
