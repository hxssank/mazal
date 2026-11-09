import type { Account, Command } from './types.ts';
import { money } from './analytics.ts';

type TransactionKind = Extract<Command, { type: 'add_transaction' }>['kind'];
interface PreviewInput {
  kind: TransactionKind;
  account: Account;
  destination?: Account;
  amountCents: number;
  date: string;
  today: string;
  solAccountIds?: ReadonlySet<string>;
}
export interface TransactionPreview {
  warning: string;
  rows: { account: Account; after: number }[];
}

const MAX_CENTS = 100_000_000_000_000;
const supportedCents = (value: number) => Number.isSafeInteger(value) && Math.abs(value) <= MAX_CENTS;
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '2200-12-31'
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function previewTransaction(input: PreviewInput): TransactionPreview {
  const { kind, account, destination, amountCents: amount, date, today, solAccountIds } = input;
  const invalid = (warning: string): TransactionPreview => ({ warning, rows: [] });
  if (!supportedCents(amount) || amount <= 0) return invalid('Enter an amount greater than zero and within the supported range.');
  if (!validDate(date) || !validDate(today)) return invalid('Choose a valid transaction date.');
  if (date > today) return invalid('Use a bill or expected payment for a future date. Record this transaction after it happens.');
  if (account.reconciledAt !== null && date < account.reconciledAt) return invalid(`${account.name} has a confirmed balance on ${account.reconciledAt}. Earlier activity is already included in that balance. Review the entry date so the same money is not counted twice.`);
  if (!supportedCents(account.balanceCents)) return invalid('The account balance is outside the supported range.');
  if (solAccountIds?.has(account.id)) return invalid('Update the SOL holdings or record a staking reward for this account.');
  const movingMoney = kind === 'transfer' || kind === 'debt_payment';
  const allowedSource = kind === 'income' ? ['cash', 'receivable'] : kind === 'expense' ? ['cash', 'debt', 'payable'] : kind === 'transfer' ? ['cash', 'investment', 'receivable'] : kind === 'debt_payment' ? ['cash'] : [];
  if (!allowedSource.includes(account.type)) return invalid('Choose an account that supports this transaction.');
  if (movingMoney) {
    if (!destination || destination.id === account.id) return invalid('Choose a different destination account.');
    if (destination.reconciledAt !== null && date < destination.reconciledAt) return invalid(`${destination.name} has a confirmed balance on ${destination.reconciledAt}. Earlier activity is already included in that balance. Review the entry date so the same money is not counted twice.`);
    if (!supportedCents(destination.balanceCents)) return invalid('The destination balance is outside the supported range.');
    if (solAccountIds?.has(destination.id)) return invalid('Update SOL holdings to change this account.');
    const allowedDestination = kind === 'debt_payment' ? ['debt', 'payable'] : ['cash', 'investment'];
    if (!allowedDestination.includes(destination.type)) return invalid(kind === 'debt_payment' ? 'Choose a debt account for this payment.' : 'Transfers need a cash or investment destination.');
  }
  const usesFunds = movingMoney || (kind === 'expense' && account.type === 'cash');
  if (usesFunds && amount > account.balanceCents) return invalid(`${account.name} has ${money(account.balanceCents)} recorded. Enter a smaller amount, or update its balance first.`);
  if (kind === 'debt_payment' && amount > destination!.balanceCents) return invalid(`This payment is more than the ${money(destination!.balanceCents)} owed on ${destination!.name}.`);
  const debtExpense = kind === 'expense' && ['debt', 'payable'].includes(account.type);
  const sourceAfter = account.balanceCents + (kind === 'income' || debtExpense ? amount : -amount);
  const rows = [{ account, after: sourceAfter }];
  if (movingMoney) rows.push({ account: destination!, after: destination!.balanceCents + (kind === 'debt_payment' ? -amount : amount) });
  if (rows.some(row => !supportedCents(row.after))) return invalid('The resulting balance would exceed the supported range.');
  return { warning: '', rows };
}
