import type { Account } from './types.ts';
import { effectiveDebtApr } from './debt-model.ts';

export const tdAgreementUrl = 'https://www.td.com/content/dam/tdct/document/pdf/personal-banking/12128-599186-cha-25-a1-en.pdf';

export interface TdMinimumEstimate {
  amountCents: number;
  interestCents: number;
  balanceCents: number;
  aprPercent: number;
}

export function tdRegularMinimumEstimate(account: Account): TdMinimumEstimate | null {
  if (account.type !== 'debt' || !/\bTD\b.*\blow\s+rate\b.*\bVisa\b/i.test(account.name) || account.debtTerms?.repaymentStatus === 'in_study' || account.debtTerms?.components?.length || ['one_off', 'interest_only'].includes(account.debtTerms?.repaymentKind ?? '')) return null;
  if (!Number.isSafeInteger(account.balanceCents) || account.balanceCents <= 0) return null;
  const aprPercent = effectiveDebtApr(account);
  if (aprPercent === null || !Number.isFinite(aprPercent) || aprPercent < 0 || aprPercent > 1000) return null;
  const interestCents = Math.round(account.balanceCents * aprPercent / 1200);
  if (!Number.isSafeInteger(interestCents + 1000)) return null;
  return { amountCents: Math.min(account.balanceCents, interestCents + 1000), interestCents, balanceCents: account.balanceCents, aprPercent };
}

export function tdPlanningMinimumEstimate(account: Account, asOf: string): TdMinimumEstimate | null {
  const terms = account.debtTerms;
  if (terms?.minimumPaymentCents != null && (!terms.paymentDueDate || terms.paymentDueDate >= asOf)) return null;
  return tdRegularMinimumEstimate(account);
}
