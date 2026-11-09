import type { Transaction } from './types.ts';

export function transactionLabel(transaction: Pick<Transaction, 'description' | 'displayName'>): string {
  return transaction.displayName?.trim() || transaction.description;
}

export function transactionSearchText(transaction: Pick<Transaction, 'description' | 'displayName' | 'note'>): string {
  return [transaction.displayName, transaction.description, transaction.note].filter(Boolean).join(' ');
}
