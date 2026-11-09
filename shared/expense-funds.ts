import { today } from './analytics.ts';
import type { ExpenseFund, RoadmapSettings } from './types.ts';

export const expenseFundStarters = ['Car maintenance', 'Travel', 'Moving out', 'Education'] as const;

export interface ExpenseFundProgress {
  remainingCents: number;
  percent: number;
  complete: boolean;
  overdue: boolean;
  daysRemaining: number;
  cadence: 'paycheck' | 'monthly' | 'unknown';
  contributionsRemaining: number | null;
  contributionCents: number | null;
  firstContributionDate: string | null;
  payEveryDays: number | null;
}

function dateValue(value: string): Date {
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Choose a valid calendar date from 1900 through 2200.');
  return parsed;
}

function monthlyDates(start: Date, through: string): string[] {
  const dates: string[] = [];
  for (let month = 0; ; month += 1) {
    const date = new Date(start);
    date.setUTCDate(1);
    date.setUTCMonth(start.getUTCMonth() + month);
    const lastDay = new Date(date);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(start.getUTCDate(), lastDay.getUTCDate()));
    const value = date.toISOString().slice(0, 10);
    if (value > through) return dates;
    dates.push(value);
  }
}

export function expenseFundProgress(fund: ExpenseFund, roadmap?: RoadmapSettings, asOf = today()): ExpenseFundProgress {
  if (!Number.isSafeInteger(fund.targetCents) || fund.targetCents <= 0 || !Number.isSafeInteger(fund.savedCents) || fund.savedCents < 0) throw new Error('Target and saved amounts must be whole cents.');
  const current = dateValue(asOf);
  const deadline = dateValue(fund.targetDate);
  const remainingCents = Math.max(0, fund.targetCents - fund.savedCents);
  const complete = remainingCents === 0;
  const daysRemaining = Math.round((deadline.getTime() - current.getTime()) / 86_400_000);
  const result: ExpenseFundProgress = {
    remainingCents,
    percent: Number(BigInt(Math.min(fund.savedCents, fund.targetCents)) * 10000n / BigInt(fund.targetCents)) / 100,
    complete, overdue: daysRemaining < 0 && !complete, daysRemaining,
    cadence: 'unknown', contributionsRemaining: null, contributionCents: complete ? 0 : null, firstContributionDate: null, payEveryDays: null,
  };
  if (roadmap?.payAmountCents !== undefined && roadmap.payAmountCents > 0 && roadmap.payEveryDays !== undefined && Number.isInteger(roadmap.payEveryDays) && roadmap.payEveryDays >= 1 && roadmap.payEveryDays <= 366 && roadmap.paydayAnchor) {
    const anchor = dateValue(roadmap.paydayAnchor);
    const interval = roadmap.payEveryDays * 86_400_000;
    const offset = Math.max(0, Math.ceil((current.getTime() - anchor.getTime()) / interval));
    const next = new Date(anchor.getTime() + offset * interval);
    const count = Math.max(0, Math.floor((deadline.getTime() - next.getTime()) / interval) + 1);
    result.cadence = 'paycheck';
    result.payEveryDays = roadmap.payEveryDays;
    result.contributionsRemaining = count;
    result.firstContributionDate = count ? next.toISOString().slice(0, 10) : null;
  } else if (roadmap?.currentMonthlyIncomeCents !== null && roadmap?.currentMonthlyIncomeCents !== undefined && roadmap.currentMonthlyIncomeCents > 0) {
    const dates = monthlyDates(current, fund.targetDate);
    result.cadence = 'monthly';
    result.contributionsRemaining = dates.length;
    result.firstContributionDate = dates[0] ?? null;
  }
  if (!complete && result.contributionsRemaining !== null && result.contributionsRemaining > 0) {
    const count = BigInt(result.contributionsRemaining);
    result.contributionCents = Number((BigInt(remainingCents) + count - 1n) / count);
  }
  return result;
}

export function expenseFundAmount(value: string, allowZero = false): number {
  const raw = value.trim();
  if (!/^(?:\d+|\d*\.\d{1,2})$/.test(raw)) throw new Error('Enter an amount with up to two decimal places.');
  const [whole, fraction = ''] = raw.split('.');
  const amount = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount < (allowZero ? 0n : 1n) || amount > 100_000_000_000_000n) throw new Error(allowZero ? 'Saved amount must be zero or more within the supported range.' : 'Target amount must be more than zero within the supported range.');
  return Number(amount);
}

export function expenseFundAmountText(value: number): string {
  const cents = BigInt(value);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
