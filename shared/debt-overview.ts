import { addCents, today } from './analytics.ts';
import { debtInterestParts, effectiveDebtApr } from './debt-model.ts';
import { debtPaymentStatus, requiredDebtPaymentCents } from './debt-status.ts';
import type { Account } from './types.ts';

export interface DebtOverviewRow {
  account: Account;
  accountId: string;
  balanceCents: number;
  confirmedApr: number | null;
  monthlyInterestCents: number | null;
  paymentStatus: ReturnType<typeof debtPaymentStatus>;
  requiredPaymentCents: number | null;
  dueDate: string | null;
}

export interface DebtOverview {
  rows: DebtOverviewRow[];
  debtCents: number;
  creditCents: number;
  monthlyInterestCents: number;
  unknownInterestCount: number;
  deferredCents: number;
  repayingCents: number;
  highestRateAccountId: string | null;
  largestBalanceAccountId: string | null;
}

export function buildDebtOverview(accounts: Account[], asOf = today()): DebtOverview {
  const rows = accounts.filter(account => account.type === 'debt' || account.type === 'payable').map(account => {
    const balanceCents = Math.max(0, account.balanceCents);
    const parts = balanceCents > 0 ? debtInterestParts(account, true) : [];
    return {
      account,
      accountId: account.id,
      balanceCents,
      confirmedApr: effectiveDebtApr(account, true),
      monthlyInterestCents: parts === null ? null : parts.reduce((sum, part) => addCents(sum, Math.round(part.balanceCents * part.aprPercent / 1200)), 0),
      paymentStatus: debtPaymentStatus(account, asOf),
      requiredPaymentCents: balanceCents > 0 ? requiredDebtPaymentCents(account, asOf) : 0,
      dueDate: balanceCents > 0 ? account.debtTerms?.paymentDueDate ?? null : null,
    };
  });
  let debtCents = 0;
  let creditCents = 0;
  let monthlyInterestCents = 0;
  let unknownInterestCount = 0;
  let deferredCents = 0;
  let repayingCents = 0;
  let highestRate: DebtOverviewRow | null = null;
  let largestBalance: DebtOverviewRow | null = null;
  for (const row of rows) {
    debtCents = addCents(debtCents, row.balanceCents);
    creditCents = addCents(creditCents, Math.max(0, -row.account.balanceCents));
    if (row.balanceCents === 0) continue;
    if (row.monthlyInterestCents === null) unknownInterestCount += 1;
    else monthlyInterestCents = addCents(monthlyInterestCents, row.monthlyInterestCents);
    if (row.paymentStatus === 'in_study') deferredCents = addCents(deferredCents, row.balanceCents);
    if (row.paymentStatus === 'repaying') repayingCents = addCents(repayingCents, row.balanceCents);
    if (row.paymentStatus !== 'in_study' && row.confirmedApr !== null && row.confirmedApr > 0 && (!highestRate || row.confirmedApr > highestRate.confirmedApr!)) highestRate = row;
    if (!largestBalance || row.balanceCents > largestBalance.balanceCents) largestBalance = row;
  }
  return { rows, debtCents, creditCents, monthlyInterestCents, unknownInterestCount, deferredCents, repayingCents, highestRateAccountId: highestRate?.accountId ?? null, largestBalanceAccountId: largestBalance?.accountId ?? null };
}
