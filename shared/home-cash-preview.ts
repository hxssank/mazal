import type { DailyPlan } from './engine.ts';

export interface HomeCashPreviewOptions {
  endDate?: string;
  extraSpendCents?: number;
  spendDate?: string;
}

export type HomeCashPreviewDay = DailyPlan['days'][number] & {
  baselineCents: number;
  previewCents: number;
  beforeIncomeCents: number;
  extraSpendCents: number;
};

export interface HomeCashPreview {
  asOf: string;
  endDate: string;
  spendDate: string;
  extraSpendCents: number;
  openingCents: number;
  baselineEndingCents: number;
  endingCents: number;
  lowestCents: number;
  lowestDate: string;
  firstShortfallDate: string | null;
  incomeCents: number;
  outflowCents: number;
  livingCostsCents: number;
  days: HomeCashPreviewDay[];
}

function checkedCents(value: number, nonnegative = false): number {
  if (!Number.isSafeInteger(value) || nonnegative && value < 0) throw new Error('Cash preview exceeds the supported amount in cents.');
  return value;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function projectHomeCash(plan: DailyPlan, options: HomeCashPreviewOptions = {}): HomeCashPreview {
  if (!validDate(plan.asOf) || !validDate(plan.endDate) || plan.endDate < plan.asOf) throw new Error('The cash forecast has an invalid date range.');
  const endDate = options.endDate ?? plan.endDate;
  const spendDate = options.spendDate ?? plan.asOf;
  const extraSpendCents = options.extraSpendCents ?? 0;
  if (!validDate(endDate) || endDate < plan.asOf || endDate > plan.endDate) throw new Error('Choose an end date within the cash forecast.');
  if (!validDate(spendDate) || spendDate < plan.asOf || spendDate > plan.endDate) throw new Error('Choose a spending date within the cash forecast.');
  if (!Number.isSafeInteger(extraSpendCents) || extraSpendCents < 0) throw new Error('Enter a nonnegative whole amount in cents for extra spending.');
  let previousDate = '';
  for (const day of plan.days) {
    if (!validDate(day.date) || day.date < plan.asOf || day.date > plan.endDate || day.date <= previousDate) throw new Error('The cash forecast has invalid or unordered days.');
    previousDate = day.date;
  }
  if (extraSpendCents > 0 && !plan.days.some(day => day.date === spendDate)) throw new Error('Choose a spending date with a forecast day.');
  const openingCents = checkedCents(checkedCents(plan.cashCents) - checkedCents(plan.protectedCents, true));
  let lowestCents = openingCents;
  let lowestDate = plan.asOf;
  let firstShortfallDate = openingCents < 0 ? plan.asOf : null;
  let incomeCents = 0;
  let outflowCents = 0;
  let livingCostsCents = 0;
  const days = plan.days.filter(day => day.date <= endDate).map(day => {
    const baselineCents = checkedCents(day.afterProtectedCents);
    const previewCents = checkedCents(baselineCents - (day.date >= spendDate ? extraSpendCents : 0));
    const beforeIncomeCents = checkedCents(previewCents - checkedCents(day.incomeCents, true));
    const spendToday = day.date === spendDate ? extraSpendCents : 0;
    checkedCents(day.closingCashCents);
    incomeCents = checkedCents(incomeCents + day.incomeCents);
    outflowCents = checkedCents(checkedCents(outflowCents + checkedCents(day.outflowCents, true)) + spendToday);
    livingCostsCents = checkedCents(livingCostsCents + checkedCents(day.livingCostsCents, true));
    if (beforeIncomeCents < lowestCents) { lowestCents = beforeIncomeCents; lowestDate = day.date; }
    if (beforeIncomeCents < 0 && firstShortfallDate === null) firstShortfallDate = day.date;
    return { ...day, eventIds: [...day.eventIds], baselineCents, previewCents, beforeIncomeCents, extraSpendCents: spendToday };
  });
  return {
    asOf: plan.asOf, endDate, spendDate, extraSpendCents, openingCents,
    baselineEndingCents: days.at(-1)?.baselineCents ?? openingCents,
    endingCents: days.at(-1)?.previewCents ?? openingCents,
    lowestCents, lowestDate, firstShortfallDate, incomeCents, outflowCents, livingCostsCents, days,
  };
}
