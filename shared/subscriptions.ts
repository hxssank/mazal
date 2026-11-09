import type { Obligation } from './types.ts';

export const subscriptionPresets = [
  { name: 'YouTube Red', category: 'Digital' },
  { name: 'GoodLife', category: 'Gym' },
  { name: 'Phone plan', category: 'Digital' },
] as const;

export function subscriptionTotals(obligations: readonly Obligation[], scope = 'all'): { count: number; monthlyCents: number; annualCents: number } {
  const active = obligations.filter(item => item.subscription && item.status === 'planned' && item.direction === 'out' && item.recurrence !== 'once' && (scope === 'all' || item.entityId === scope));
  const annual = active.reduce((sum, item) => sum + BigInt(item.amountCents) * (item.recurrence === 'monthly' ? 12n : 26n), 0n);
  const annualCents = Number(annual);
  const monthlyCents = Number((annual + 6n) / 12n);
  if (!Number.isSafeInteger(annualCents) || !Number.isSafeInteger(monthlyCents)) throw new Error('Subscription totals exceed the supported amount.');
  return { count: active.length, monthlyCents, annualCents };
}

export function subscriptionAmount(value: string): number {
  const raw = value.trim();
  if (!/^(?:\d+|\d*\.\d{1,2})$/.test(raw)) throw new Error('Enter a charge amount with up to two decimal places.');
  const [whole, decimal = ''] = raw.split('.');
  const amount = BigInt(whole || '0') * 100n + BigInt(decimal.padEnd(2, '0'));
  if (amount <= 0n || amount > 100_000_000_000_000n) throw new Error('Enter a charge greater than zero within the supported amount.');
  return Number(amount);
}

export function subscriptionAmountText(cents: number): string {
  const amount = BigInt(cents);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}
