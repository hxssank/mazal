import type { MoneyOwed } from './types.ts';
import { parseMoneyCents } from './money-input.ts';

export const owedPaid = (tab: MoneyOwed): number => tab.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
export const owedRemaining = (tab: MoneyOwed): number => tab.amountCents - owedPaid(tab);

export function parseAssetMoney(value: string, label = 'Amount'): number {
  return parseMoneyCents(value, { maxCents:100_000_000_000_000, invalidMessage:`${label} must be a nonnegative amount with at most two decimal places.`, rangeMessage:`${label} exceeds the supported amount.` });
}
