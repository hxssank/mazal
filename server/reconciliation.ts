import type { Account, Reconciliation, Transaction } from '../shared/types.ts';
import type { StoredData } from './store.ts';
import { reconciliationDate, reconciliationStart, transactionBalanceChanges, transactionBalanceDates, transactionPostingDates } from '../shared/reconciliation.ts';

const maximum = 100_000_000_000_000;
function calendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Choose a valid statement date.');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (value > today) throw new Error('The statement date cannot be in the future.');
  return value;
}
function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -maximum || value > maximum) throw new Error('Enter a statement balance in whole cents between -100000000000000 and 100000000000000.');
  return value;
}
function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 250_000 || value.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(value).size !== value.length) throw new Error(`${label} must contain distinct transaction IDs.`);
  return [...value].sort();
}
function selectedTotal(selected: string[], accountId: string, transactions: Map<string, Transaction>, changes: Map<string, Record<string,number>>, date?: string): number {
  let total = 0n;
  for (const id of selected) {
    const transaction = transactions.get(id);
    const amounts = changes.get(id);
    if (!transaction || !amounts || !Object.hasOwn(amounts, accountId)) throw new Error('A checked transaction does not belong to this account.');
    if (date && reconciliationDate(transaction,accountId) > date) throw new Error('A checked transaction falls after the statement date.');
    total += BigInt(amounts[accountId]);
  }
  if (total < -BigInt(maximum) || total > BigInt(maximum)) throw new Error('Checked transactions exceed the supported balance.');
  return Number(total);
}

export function validateAccountChecks(raw: { clearedTransactionIds?:unknown; reconciliation?:unknown }, account: { id:string;type:string }, transactions: Map<string, Transaction>, changes: Map<string, Record<string,number>>): Pick<Account, 'clearedTransactionIds' | 'reconciliation'> {
  if (raw.clearedTransactionIds === undefined && raw.reconciliation === undefined) return {};
  if (!['cash','debt','payable'].includes(account.type)) throw new Error('Transaction reconciliation needs a cash or debt account.');
  const clearedTransactionIds = ids(raw.clearedTransactionIds ?? [], 'Checked transactions');
  selectedTotal(clearedTransactionIds, account.id, transactions, changes);
  if (raw.reconciliation === undefined) return { clearedTransactionIds };
  if (!raw.reconciliation || typeof raw.reconciliation !== 'object' || Array.isArray(raw.reconciliation)) throw new Error('The saved reconciliation is invalid.');
  const input = raw.reconciliation as Record<string, unknown>;
  const reconciliation: Reconciliation = { date:calendarDate(input.date), balanceCents:amount(input.balanceCents), transactionIds:ids(input.transactionIds, 'Reconciled transactions') };
  const openingDate = reconciliationStart(transactions.values(), account.id);
  if (openingDate && reconciliation.date < openingDate) throw new Error(`Opening balance is dated ${openingDate}. Review earlier statements in Statements.`);
  const cleared = new Set(clearedTransactionIds);
  if (reconciliation.transactionIds.some(id => !cleared.has(id))) throw new Error('Reconciled transactions must remain checked.');
  if (selectedTotal(reconciliation.transactionIds, account.id, transactions, changes, reconciliation.date) !== reconciliation.balanceCents) throw new Error('Reconciled transactions do not match the saved balance.');
  return { clearedTransactionIds, reconciliation };
}

export function applyReconciliationCommand(data: StoredData, command: Record<string, unknown>): string | null {
  if (command.type !== 'save_reconciliation' && command.type !== 'reopen_reconciliation') return null;
  if (!Number.isSafeInteger(command.expectedRevision) || Number(command.expectedRevision) < 0) throw new Error('Refresh your records before saving transaction checks.');
  const account = data.accounts.find(account => account.id === command.accountId);
  if (!account || !['cash','debt','payable'].includes(account.type)) throw new Error('Choose a cash or debt account.');
  if (command.type === 'reopen_reconciliation') {
    if (!account.reconciliation) throw new Error('This account has no completed reconciliation.');
    delete account.reconciliation;
    return `Reopened transaction checks for ${account.name}.`;
  }
  if (typeof command.finish !== 'boolean') throw new Error('Choose whether to finish reconciliation.');
  const date = calendarDate(command.date);
  const target = amount(command.balanceCents);
  const openingDate = reconciliationStart(data.transactions, account.id);
  if (openingDate && date < openingDate) throw new Error(`Opening balance is dated ${openingDate}. Review earlier statements in Statements.`);
  if (account.reconciliation && date < account.reconciliation.date) throw new Error('Choose the last reconciled date or a later date.');
  const selected = ids(command.clearedTransactionIds, 'Checked transactions');
  const selectedSet = new Set(selected);
  if (account.reconciliation?.transactionIds.some(id => !selectedSet.has(id))) throw new Error('Reopen the previous reconciliation before unchecking its transactions.');
  const postingDates = transactionPostingDates(data);
  const balanceDates = transactionBalanceDates(data);
  const transactions = new Map(data.transactions.map(transaction => [transaction.id, {...transaction,postingDates:postingDates.get(transaction.id),balanceDates:balanceDates.get(transaction.id)}]));
  const changes = transactionBalanceChanges(data.accounts, data.transactions, data.entries);
  selectedTotal(selected, account.id, transactions, changes);
  const throughDate = selected.filter(id => reconciliationDate(transactions.get(id)!,account.id) <= date);
  const total = selectedTotal(throughDate, account.id, transactions, changes, date);
  if (command.finish && total !== target) throw new Error('The checked balance must match the statement before finishing.');
  account.clearedTransactionIds = selected;
  if (command.finish) account.reconciliation = { date, balanceCents:target, transactionIds:throughDate };
  return command.finish ? `Reconciled ${account.name} through ${date}.` : `Saved transaction checks for ${account.name}.`;
}
