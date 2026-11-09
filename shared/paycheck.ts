export type PayFrequency = 12 | 26 | 52;

function validFrequency(frequency: PayFrequency): void {
  if (![12, 26, 52].includes(frequency)) throw new Error('Choose monthly, biweekly, or weekly pay.');
}

function parseDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Enter a valid ${label} in YYYY-MM-DD format.`);
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`Enter a valid ${label}.`);
  return date;
}

function monthlyPayday(anchor: Date, offset: number): Date {
  const date = new Date(anchor);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const endOfMonth = new Date(date);
  endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(anchor.getUTCDate(), endOfMonth.getUTCDate()));
  return date;
}

function paydayText(date: Date): string {
  if (date.getUTCFullYear() > 9999) throw new Error('The next payday is outside the supported date range.');
  return date.toISOString().slice(0, 10);
}

export function percentageCents(cents: number, percent: string): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Enter a valid take-home pay amount.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(percent.trim())) throw new Error('Use percentages from 0 to 100, with up to two decimals.');
  const [whole, fraction = ''] = percent.trim().split('.');
  const basisPoints = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (basisPoints > 10000n) throw new Error('Each allocation must be between 0% and 100%.');
  return Number(BigInt(cents) * basisPoints / 10000n);
}

export function paydayForPeriod(firstPayday: string, period: number, frequency: PayFrequency): string {
  validFrequency(frequency);
  if (!Number.isInteger(period) || period < 1 || period > frequency * 5) throw new Error('Enter a valid first payday and pay period.');
  const date = parseDate(firstPayday, 'first payday');
  if (frequency === 12) return paydayText(monthlyPayday(date, period - 1));
  date.setUTCDate(date.getUTCDate() + (period - 1) * (frequency === 26 ? 14 : 7));
  return paydayText(date);
}

export function nextPaydayOnOrAfter(anchor: string, today: string, frequency: PayFrequency): string {
  validFrequency(frequency);
  const anchorDate = parseDate(anchor, 'payday anchor');
  const threshold = parseDate(today, 'current date');
  if (anchorDate >= threshold) return anchor;
  let next: Date;
  if (frequency === 12) {
    const monthOffset = (threshold.getUTCFullYear() - anchorDate.getUTCFullYear()) * 12 + threshold.getUTCMonth() - anchorDate.getUTCMonth();
    next = monthlyPayday(anchorDate, monthOffset);
    if (next < threshold) next = monthlyPayday(anchorDate, monthOffset + 1);
  } else {
    const days = frequency === 26 ? 14 : 7;
    const periods = Math.ceil((threshold.getTime() - anchorDate.getTime()) / (days * 86400000));
    next = new Date(anchorDate);
    next.setUTCDate(next.getUTCDate() + periods * days);
  }
  return paydayText(next);
}
