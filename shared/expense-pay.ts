import type { RoadmapSettings, TemporaryWorkSchedule } from './types.ts';

function validDate(value: string, date: Date): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function temporaryWorkSchedule(settings?: RoadmapSettings) {
  return settings?.incomeTransitionPlanned === false ? undefined : settings?.temporaryWorkSchedule;
}

export function workScheduleDescription(settings?: RoadmapSettings): string {
  const work = temporaryWorkSchedule(settings);
  if (!settings || !work) return '';
  const label = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `Average ${work.weeklyHours} hours a week from ${label(settings.transitionDate)}. Full-time hours resume ${label(work.returnDate)} at ${work.fullTimeWeeklyHours} hours a week.`;
}

export function estimatedWorkPayCents(base: number, work: TemporaryWorkSchedule, partTimeDays = 1, days = 1): number {
  const partTimeHours = BigInt(Math.round(work.weeklyHours * 100));
  const fullTimeHours = BigInt(Math.round(work.fullTimeWeeklyHours * 100));
  const scheduled = BigInt(days - partTimeDays) * fullTimeHours + BigInt(partTimeDays) * partTimeHours;
  const capacity = BigInt(days) * fullTimeHours;
  return Number((2n * BigInt(base) * scheduled + capacity) / (2n * capacity));
}

export function projectedPayCents(settings: RoadmapSettings | undefined, payday: string): number | null {
  const amount = settings?.payAmountCents;
  if (amount == null || !Number.isSafeInteger(amount) || amount < 0) return null;
  if (!settings?.transitionDate || settings.incomeTransitionPlanned === false) return amount;
  const work = temporaryWorkSchedule(settings);
  if (!work) {
    const start = new Date(`${settings.transitionDate}T12:00:00Z`);
    return validDate(settings.transitionDate, start) && payday >= settings.transitionDate ? null : amount;
  }
  const interval = settings.payEveryDays;
  const day = new Date(`${payday}T12:00:00Z`);
  if (!interval || !Number.isInteger(interval) || interval < 1 || interval > 366 || !validDate(payday, day)) return null;
  day.setUTCDate(day.getUTCDate() - work.payPeriodEndLagDays - interval + 1);
  let weekdays = 0, reducedWeekdays = 0, reducedDays = 0;
  for (let offset = 0; offset < interval; offset++) {
    const date = day.toISOString().slice(0, 10);
    const reduced = date >= settings.transitionDate && date < work.returnDate;
    if (reduced) reducedDays++;
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      weekdays++;
      if (reduced) reducedWeekdays++;
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  const days = weekdays || interval;
  const partTimeDays = weekdays ? reducedWeekdays : reducedDays;
  return estimatedWorkPayCents(amount, work, partTimeDays, days);
}

export function expensePayDates(settings: RoadmapSettings | undefined, asOf: string, count = 3): string[] {
  if (!settings?.paydayAnchor || !settings.payEveryDays) return [];
  const anchor = new Date(`${settings.paydayAnchor}T12:00:00Z`);
  const now = new Date(`${asOf}T12:00:00Z`);
  if (!validDate(settings.paydayAnchor, anchor) || !validDate(asOf, now) || !Number.isInteger(settings.payEveryDays) || settings.payEveryDays < 1 || settings.payEveryDays > 366 || !Number.isInteger(count) || count < 1 || count > 100) return [];
  const interval = settings.payEveryDays * 86_400_000;
  const offset = Math.max(0, Math.ceil((now.getTime() - anchor.getTime()) / interval));
  const last = new Date(anchor.getTime() + (offset + count - 1) * interval);
  if (last.getUTCFullYear() > 9999) return [];
  return Array.from({ length: count }, (_, index) => new Date(anchor.getTime() + (offset + index) * interval).toISOString().slice(0, 10));
}
