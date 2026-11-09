import { today, upcoming } from './analytics.ts';
import type { Occurrence } from './analytics.ts';
import type { AppState } from './types.ts';

export interface RunwayOptions {
  days?: number;
  purchaseCents?: number;
  purchaseDate?: string;
}

export interface RunwayPoint { date: string; balanceCents: number }
export interface RunwayScenario {
  points: RunwayPoint[];
  minimum: RunwayPoint;
  firstShortfall: RunwayPoint | null;
  endingCents: number;
}
export type RunwayOccurrence = Occurrence & { effectiveDate: string };
export interface CashRunway {
  ownerId: string | null;
  ownerName: string | null;
  hasCashAccounts: boolean;
  recordedCashCents: number | null;
  reservedCents: number;
  startingCents: number | null;
  startDate: string;
  endDate: string;
  purchaseCents: number;
  purchaseDate: string;
  scheduledIncomeCents: number;
  outgoingCents: number;
  occurrences: RunwayOccurrence[];
  excludedOccurrences: Occurrence[];
  baseline: RunwayScenario | null;
  proposed: RunwayScenario | null;
}

export const runwayAssumptions = 'Uses recorded cash after reserves and scheduled cash-account entries. Overdue entries apply today. Same-day entries are combined; payment order and account-level overdrafts are not checked. Expected income is not recorded money. Unscheduled spending is not included.';

function cents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Cash projection exceeds the supported amount in cents.');
  return value;
}

function dayAfter(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function project(startingCents: number, dates: string[], changes: Map<string, number>, purchaseCents: number, purchaseDate: string): RunwayScenario {
  let balanceCents = startingCents;
  let minimum: RunwayPoint = { date: dates[0], balanceCents };
  let firstShortfall: RunwayPoint | null = balanceCents < 0 ? { ...minimum } : null;
  const points = dates.map(date => {
    balanceCents = cents(balanceCents + (changes.get(date) ?? 0) - (date === purchaseDate ? purchaseCents : 0));
    const point = { date, balanceCents };
    if (balanceCents < minimum.balanceCents) minimum = point;
    if (balanceCents < 0 && firstShortfall === null) firstShortfall = point;
    return point;
  });
  return { points, minimum, firstShortfall, endingCents: balanceCents };
}

export function cashRunway(state: AppState, scope = 'all', options: RunwayOptions = {}): CashRunway {
  const days = options.days ?? 30;
  if (!Number.isInteger(days) || days < 0 || days > 3660) throw new Error('Choose a forecast period between 0 and 3,660 whole days.');
  const purchaseCents = options.purchaseCents ?? 0;
  if (!Number.isSafeInteger(purchaseCents) || purchaseCents < 0) throw new Error('Enter a nonnegative purchase amount in cents.');
  const startDate = today();
  const endDate = dayAfter(startDate, days);
  const purchaseDate = options.purchaseDate ?? startDate;
  if (!validDate(purchaseDate) || purchaseDate < startDate || purchaseDate > endDate) throw new Error('Choose a purchase date within the forecast period.');
  const owner = scope === 'all'
    ? state.entities.find(entity => entity.kind === 'personal')
    : state.entities.find(entity => entity.id === scope);
  const cashAccounts = state.accounts.filter(account => account.entityId === owner?.id && account.type === 'cash');
  const cashAccountIds = new Set(cashAccounts.map(account => account.id));
  const hasCashAccounts = cashAccounts.length > 0;
  const recordedCashCents = hasCashAccounts ? cashAccounts.reduce((total, account) => cents(total + account.balanceCents), 0) : null;
  const reservedCents = state.reserves.filter(reserve => reserve.entityId === owner?.id).reduce((total, reserve) => cents(total + reserve.amountCents), 0);
  const startingCents = recordedCashCents === null ? null : cents(recordedCashCents - reservedCents);
  const scheduled = owner ? upcoming(state, owner.id, days) : [];
  const occurrences = scheduled.filter(occurrence => cashAccountIds.has(occurrence.accountId)).map(occurrence => ({
    ...occurrence, effectiveDate: occurrence.dueDate < startDate ? startDate : occurrence.dueDate,
  }));
  const excludedOccurrences = scheduled.filter(occurrence => !cashAccountIds.has(occurrence.accountId));
  const changes = new Map<string, number>();
  let scheduledIncomeCents = 0;
  let outgoingCents = 0;
  for (const occurrence of occurrences) {
    const incoming = occurrence.direction === 'in';
    if (incoming) scheduledIncomeCents = cents(scheduledIncomeCents + occurrence.amountCents);
    else outgoingCents = cents(outgoingCents + occurrence.amountCents);
    changes.set(occurrence.effectiveDate, cents((changes.get(occurrence.effectiveDate) ?? 0) + occurrence.amountCents * (incoming ? 1 : -1)));
  }
  const dates = Array.from({ length: days + 1 }, (_, day) => dayAfter(startDate, day));
  return {
    ownerId: owner?.id ?? null, ownerName: owner?.name ?? null, hasCashAccounts,
    recordedCashCents, reservedCents, startingCents, startDate, endDate, purchaseCents, purchaseDate,
    scheduledIncomeCents, outgoingCents, occurrences, excludedOccurrences,
    baseline: startingCents === null ? null : project(startingCents, dates, changes, 0, purchaseDate),
    proposed: startingCents === null ? null : project(startingCents, dates, changes, purchaseCents, purchaseDate),
  };
}
