import type { Account } from './types.ts';
import { today } from './analytics.ts';
import { paymentDeferral } from './debt-model.ts';

export function isInStudy(account: Pick<Account, 'debtTerms'>): boolean {
  return account.debtTerms?.repaymentStatus === 'in_study';
}

export function debtPaymentStatus(account: Pick<Account, 'debtTerms' | 'balanceCents'>, asOf = today()): 'paid_off' | 'in_study' | 'repaying' | 'needs_confirmation' {
  if (account.balanceCents <= 0) return 'paid_off';
  const status = paymentDeferral(account, asOf);
  return status === 'deferred' ? 'in_study' : status === 'review' ? 'needs_confirmation' : 'repaying';
}

export function requiredDebtPaymentCents(account: Pick<Account, 'debtTerms'>, asOf = today()): number | null {
  const status = paymentDeferral(account, asOf);
  return status === 'deferred' ? 0 : status === 'review' ? null : account.debtTerms?.minimumPaymentCents ?? null;
}

export function debtPaymentSummary(accounts: Account[], asOf = today()): { recordedMinimumsCents: number; unknownPayments: number; inStudyCount: number } {
  const active = accounts.filter(account => ['debt', 'payable'].includes(account.type) && account.balanceCents > 0);
  return {
    recordedMinimumsCents: active.reduce((sum, account) => sum + (requiredDebtPaymentCents(account, asOf) ?? 0), 0),
    unknownPayments: active.filter(account => requiredDebtPaymentCents(account, asOf) === null).length,
    inStudyCount: active.filter(account => debtPaymentStatus(account, asOf) === 'in_study').length,
  };
}
