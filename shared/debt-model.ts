import type { Account, DebtComponent, DebtInterestStatus, DebtRepaymentKind, DebtTerms } from './types.ts';

type ModelTerms = Pick<DebtTerms, 'repaymentKind' | 'interestStatus' | 'studyEndDate' | 'repaymentStartDate' | 'components'>;
export interface DebtInterestPart { balanceCents: number; aprPercent: number }

export function validateDebtTermsModel(raw: Record<string, unknown>): ModelTerms {
  const result: ModelTerms = {};
  if (raw.repaymentKind !== undefined) {
    if (!['fixed', 'revolving', 'interest_only', 'one_off'].includes(raw.repaymentKind as string)) throw new Error('Choose a valid debt repayment kind.');
    result.repaymentKind = raw.repaymentKind as DebtRepaymentKind;
  }
  if (raw.interestStatus !== undefined) result.interestStatus = interestStatus(raw.interestStatus);
  for (const field of ['studyEndDate', 'repaymentStartDate'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value)) throw new Error('Study and repayment dates must be real dates or blank.');
    result[field] = value as string | null;
  }
  if (result.studyEndDate && result.repaymentStartDate && result.repaymentStartDate < result.studyEndDate) throw new Error('Repayment start cannot be before the study end.');
  if (raw.components !== undefined) {
    if (!Array.isArray(raw.components) || raw.components.length > 2) throw new Error('Use at most the federal and Ontario loan components.');
    const ids = new Set<string>();
    result.components = raw.components.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each loan component needs its own terms.');
      const part = value as Record<string, unknown>;
      if (!['federal', 'ontario'].includes(part.id as string) || ids.has(part.id as string)) throw new Error('Federal and Ontario components must have unique names.');
      ids.add(part.id as string);
      if (part.balanceCents !== null && (!Number.isSafeInteger(part.balanceCents) || (part.balanceCents as number) < 0)) throw new Error('Component balance must be nonnegative whole cents or unknown.');
      if (part.aprPercent !== null && (typeof part.aprPercent !== 'number' || !Number.isFinite(part.aprPercent) || part.aprPercent < 0 || part.aprPercent > 1000)) throw new Error('Component APR must be between 0 and 1000, or unknown.');
      if (typeof part.rateConfirmed !== 'boolean' || part.rateConfirmed && part.aprPercent === null) throw new Error('Enter a component APR before confirming its rate.');
      return { id: part.id, balanceCents: part.balanceCents, aprPercent: part.aprPercent, rateConfirmed: part.rateConfirmed, interestStatus: interestStatus(part.interestStatus) } as DebtComponent;
    });
  }
  return result;
}

function interestStatus(value: unknown): DebtInterestStatus {
  if (!['accruing', 'interest_free', 'unknown'].includes(value as string)) throw new Error('Choose whether interest accrues, is waived, or is unknown.');
  return value as DebtInterestStatus;
}

export function debtInterestParts(account: Pick<Account, 'balanceCents' | 'debtTerms'>, confirmed = false): DebtInterestPart[] | null {
  const terms = account.debtTerms;
  if (!terms) return null;
  if (terms.components?.length) {
    if (terms.components.length !== 2 || terms.components.some(part => part.balanceCents === null) || terms.components.reduce((sum, part) => sum + (part.balanceCents ?? 0), 0) !== account.balanceCents) return null;
    const parts: DebtInterestPart[] = [];
    for (const part of terms.components) {
      if (!part.balanceCents) continue;
      const rate = part.interestStatus === 'interest_free' ? 0 : part.interestStatus === 'accruing' && (!confirmed || part.rateConfirmed) ? part.aprPercent : null;
      if (rate === null) return null;
      parts.push({ balanceCents: part.balanceCents, aprPercent: rate });
    }
    return parts;
  }
  if (terms.interestStatus === 'interest_free') return [{ balanceCents: account.balanceCents, aprPercent: 0 }];
  if (terms.interestStatus === 'unknown' || terms.repaymentStatus === 'in_study' && !terms.interestStatus) return null;
  if (terms.aprPercent === null || confirmed && !terms.rateConfirmed) return null;
  return [{ balanceCents: account.balanceCents, aprPercent: terms.aprPercent }];
}

export function effectiveDebtApr(account: Pick<Account, 'balanceCents' | 'debtTerms'>, confirmed = false): number | null {
  const parts = debtInterestParts(account, confirmed);
  if (parts === null) return null;
  return account.balanceCents > 0 ? parts.reduce((sum, part) => sum + part.balanceCents * part.aprPercent, 0) / account.balanceCents : 0;
}

export function debtRepaymentKind(account: Pick<Account, 'type' | 'debtTerms'>): DebtRepaymentKind {
  return account.debtTerms?.repaymentKind ?? (account.type === 'payable' && account.debtTerms?.paymentDueDate ? 'one_off' : 'fixed');
}

export function paymentDeferral(account: Pick<Account, 'debtTerms'>, asOf: string): 'deferred' | 'review' | 'repaying' {
  const terms = account.debtTerms;
  if (terms?.repaymentStatus !== 'in_study') return 'repaying';
  if (terms.repaymentStartDate) return asOf < terms.repaymentStartDate ? 'deferred' : 'repaying';
  if (terms.studyEndDate && asOf > terms.studyEndDate) return 'review';
  return 'deferred';
}

export function rankedInterestDebts(accounts: Account[]): Account[] {
  return accounts.filter(account => ['debt', 'payable'].includes(account.type) && account.balanceCents > 0 && (effectiveDebtApr(account, true) ?? 0) > 0)
    .sort((a, b) => effectiveDebtApr(b, true)! - effectiveDebtApr(a, true)! || a.name.localeCompare(b.name));
}
