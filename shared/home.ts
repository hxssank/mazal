import type { Account, AppState, Transaction } from './types.ts';
import { today } from './analytics.ts';
import { debtPaymentStatus } from './debt-status.ts';
import { effectiveDebtApr } from './debt-model.ts';

export function recentActivity(state: AppState, scope: string, asOf: string, limit = 4): Transaction[] {
  const accountIds = new Set(state.accounts.filter(account => scope === 'all' || account.entityId === scope).map(account => account.id));
  return state.transactions.filter(transaction =>
    (accountIds.has(transaction.accountId) || transaction.toAccountId !== null && accountIds.has(transaction.toAccountId)) &&
    transaction.date <= asOf && transaction.kind !== 'opening' && transaction.kind !== 'adjustment'
  ).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export function debtsMissingTerms(state: AppState, scope: string, asOf = today()): Account[] {
  return state.accounts.filter(account => {
    if (scope !== 'all' && account.entityId !== scope) return false;
    if ((account.type !== 'debt' && account.type !== 'payable') || account.balanceCents <= 0) return false;
    const status = debtPaymentStatus(account, asOf);
    if (status === 'in_study') return false;
    if (status === 'needs_confirmation') return true;
    const terms = account.debtTerms ?? (state.roadmap?.loanAccountId === account.id ? {
      aprPercent: state.roadmap.loanAprPercent,
      minimumPaymentCents: state.roadmap.loanMonthlyPaymentCents,
    } : undefined);
    return (account.debtTerms ? effectiveDebtApr(account) === null : terms?.aprPercent == null) || terms?.minimumPaymentCents == null
      || !!account.debtTerms?.paymentDueDate && account.debtTerms.paymentDueDate < asOf;
  });
}
