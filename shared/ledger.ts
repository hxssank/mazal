import { transactionSearchText } from './transaction-label.ts';
import { purchaseAccountId } from './asset-purchases.ts';
import { addCents } from './analytics.ts';
import type { AppState, Transaction, TransactionKind } from './types.ts';

export const transactionLabels: Record<TransactionKind, string> = {
  income: 'Income', expense: 'Expense', transfer: 'Transfer', debt_payment: 'Debt payment',
  opening: 'Opening balance', adjustment: 'Balance correction',
};

export interface LedgerFilters {
  scope: string;
  month: string | null;
  accountId: string;
  kind: TransactionKind | 'all';
  query: string;
}

const normalize = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase('en-CA').replace(/\s+/g, ' ');

export function isStatementMovement(entry: Pick<Transaction, 'kind' | 'statementId' | 'importSources'>): boolean {
  return entry.kind === 'adjustment' && (!!entry.statementId || !!entry.importSources?.length);
}

export function isStatementCardPayment(entry: Pick<Transaction, 'kind' | 'category' | 'statementId' | 'importSources'>): boolean {
  return isStatementMovement(entry) && normalize(entry.category) === 'card payment';
}

export function transactionDisplayLabel(entry: Pick<Transaction, 'kind' | 'amountCents' | 'category' | 'statementId' | 'importSources' | 'source' | 'reversalOf'>): string {
  if (entry.reversalOf) return `${transactionLabels[entry.kind]} reversal`;
  if (entry.kind === 'expense' && entry.amountCents < 0) return 'Refund';
  if (isStatementCardPayment(entry)) return 'Card payment';
  if (isStatementMovement(entry)) return 'Account movement';
  if (entry.kind === 'adjustment' && entry.source === 'Receivable repayment') return 'Repayment received';
  if (entry.kind === 'adjustment' && entry.source === 'Asset sale') return 'Sale proceeds';
  if (entry.kind === 'adjustment' && ['Receivable repayment reversal', 'Asset sale reversal'].includes(entry.source)) return 'Receipt reversed';
  return transactionLabels[entry.kind];
}

export function filterLedger(state: AppState, filters: LedgerFilters): Transaction[] {
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const inScope = (id: string | null): boolean => !!id && !!accounts.get(id) && (filters.scope === 'all' || accounts.get(id)?.entityId === filters.scope);
  if (filters.accountId !== 'all' && !inScope(filters.accountId)) return [];
  const purchaseNames = new Map((state.assetPurchases ?? []).map(purchase => [purchaseAccountId(purchase.id), purchase.name]));
  const query = normalize(filters.query);
  return state.transactions.filter(entry => {
    if (!inScope(entry.accountId) && !inScope(entry.toAccountId)) return false;
    if (filters.month && !entry.date.startsWith(`${filters.month}-`)) return false;
    if (filters.accountId !== 'all' && entry.accountId !== filters.accountId && entry.toAccountId !== filters.accountId) return false;
    if (filters.kind !== 'all' && (filters.kind === 'debt_payment' ? entry.kind !== 'debt_payment' && !isStatementCardPayment(entry) : filters.kind === 'adjustment' ? entry.kind !== 'adjustment' || isStatementCardPayment(entry) : entry.kind !== filters.kind)) return false;
    const text = `${transactionSearchText(entry)} ${entry.category} ${transactionLabels[entry.kind]} ${transactionDisplayLabel(entry)} ${accounts.get(entry.accountId)?.name ?? ''} ${accounts.get(entry.toAccountId ?? '')?.name ?? purchaseNames.get(entry.toAccountId ?? '') ?? ''} ${entry.source}`;
    return !query || normalize(text).includes(query);
  }).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function ledgerTotals(rows: Transaction[]): Record<TransactionKind, { amountCents: number; count: number }> {
  const totals = Object.fromEntries(Object.keys(transactionLabels).map(kind => [kind, { amountCents: 0, count: 0 }])) as Record<TransactionKind, { amountCents: number; count: number }>;
  for (const row of rows) {
    totals[row.kind].amountCents = addCents(totals[row.kind].amountCents, row.amountCents);
    totals[row.kind].count += 1;
  }
  return totals;
}

export function ledgerDirection(entry: Transaction, accountId = 'all', scopeAccountIds?: ReadonlySet<string>): 'In' | 'Out' | 'Increase' | 'Decrease' | 'Transfer' | 'Debt payment' | 'Opening balance' | 'Unknown' {
  if (entry.kind === 'income') return entry.amountCents < 0 ? 'Out' : 'In';
  if (entry.kind === 'expense') return entry.amountCents < 0 ? 'In' : 'Out';
  if (entry.kind === 'adjustment' && ['Receivable repayment', 'Asset sale'].includes(entry.source)) return 'In';
  if (entry.kind === 'adjustment' && ['Receivable repayment reversal', 'Asset sale reversal'].includes(entry.source)) return 'Out';
  if (entry.kind === 'transfer') {
    const outgoingDirection = entry.amountCents < 0 ? 'In' : 'Out';
    const incomingDirection = entry.amountCents < 0 ? 'Out' : 'In';
    if (accountId !== 'all') return accountId === entry.accountId ? outgoingDirection : accountId === entry.toAccountId ? incomingDirection : 'Transfer';
    if (scopeAccountIds) {
      const outgoing = scopeAccountIds.has(entry.accountId);
      const incoming = !!entry.toAccountId && scopeAccountIds.has(entry.toAccountId);
      if (outgoing !== incoming) return incoming ? incomingDirection : outgoingDirection;
    }
    return 'Transfer';
  }
  if (isStatementMovement(entry)) {
    const effect = entry.balanceChanges?.[accountId === 'all' ? entry.accountId : accountId];
    if (effect !== undefined && effect !== 0) return effect > 0 ? 'Increase' : 'Decrease';
  }
  if (entry.kind === 'debt_payment' || isStatementCardPayment(entry)) return 'Debt payment';
  if (entry.kind === 'opening') return 'Opening balance';
  return 'Unknown';
}

function csvText(value: string): string {
  const safe = /^[\s]*[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function decimalAmount(cents: number): string {
  const amount = BigInt(cents);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function ledgerCSV(state: AppState, rows: Transaction[], accountId = 'all', scope = 'all'): string {
  const accounts = new Map([...state.accounts.map(account => [account.id, account.name] as const), ...(state.assetPurchases ?? []).map(purchase => [purchaseAccountId(purchase.id), purchase.name] as const)]);
  const scopeAccountIds = new Set(state.accounts.filter(account => scope === 'all' || account.entityId === scope).map(account => account.id));
  const header = ['Transaction ID', 'Date', 'Description', 'Type', 'Account', 'To account', 'Category', 'Amount CAD', 'Direction', 'Source', 'Name', 'Notes'];
  const records = rows.map(entry => [
    entry.id, entry.date, entry.description, transactionDisplayLabel(entry),
    accounts.get(entry.accountId) ?? entry.accountId,
    entry.toAccountId ? accounts.get(entry.toAccountId) ?? entry.toAccountId : '',
    entry.category, decimalAmount(entry.amountCents), ledgerDirection(entry, accountId, scopeAccountIds), entry.source, entry.displayName ?? '', entry.note ?? '',
  ]);
  const lines = [header.map(csvText).join(','), ...records.map(record => record.map((value, index) => index === 7 ? `"${value}"` : csvText(value)).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
