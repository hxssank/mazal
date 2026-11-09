import { isDeepStrictEqual } from 'node:util';
import type { Command, Transaction } from '../shared/types.ts';
import { purchaseAccountId } from '../shared/asset-purchases.ts';
import { payrollCurrentLinks } from '../shared/payroll.ts';
import { readReviewSource } from './review-sources.ts';
import type { StoredData } from './store.ts';

type Correction = Extract<Command, { type: 'correct_bank_matched_amount' }>;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function transactionRecord(transaction: Transaction): Omit<Transaction, 'balanceChanges' | 'postingDates' | 'balanceDates'> {
  const { balanceChanges: _changes, postingDates: _postingDates, balanceDates: _balanceDates, ...record } = transaction;
  return record;
}

function sourceRow(command: Correction) {
  const source = command.source;
  requireCondition(source.sourceKind === 'bank_activity' && source.observedOn, 'Choose observed bank activity as the correction source.');
  requireCondition(source.sha256 === command.expectedSourceSha256, 'The bank correction source changed. Review its saved original again.');
  requireCondition(source.rows.reduce((total, row) => total + BigInt(row.amountCents), BigInt(source.openingBalanceCents)) === BigInt(source.closingBalanceCents), 'The correction source rows do not reconcile to the observed closing balance.');
  const row = source.rows.find(item => item.id === command.rowId);
  requireCondition(row, 'The bank correction source row was not found.');
  return { source, row };
}

export function verifyBankAmountCorrectionSource(command: Correction, sourceDirectory: string): void {
  const { source } = sourceRow(command);
  readReviewSource(sourceDirectory, source);
}

export function applyBankAmountCorrection(data: StoredData, command: Correction): string {
  requireCondition(Number.isSafeInteger(command.expectedRevision) && Number(command.expectedRevision) >= 0, 'A bank amount correction needs the current workspace revision.');
  requireCondition(typeof command.requestId === 'string' && command.requestId.trim(), 'A bank amount correction needs a request ID.');
  requireCondition(typeof command.reason === 'string' && command.reason.trim() && command.reason.length <= 500, 'Give a correction reason of at most 500 characters.');
  requireCondition(typeof command.description === 'string' && command.description.trim() && command.description.length <= 500, 'Give a corrected description of at most 500 characters.');
  const { source, row } = sourceRow(command);
  const savedSource = data.importBatches?.find(batch => batch.id === source.id)?.source;
  requireCondition(savedSource && isDeepStrictEqual(source, savedSource), 'The bank correction source changed or is not saved. Review its current rows before correcting the payment.');
  const transaction = data.transactions.find(item => item.id === command.transactionId);
  requireCondition(transaction && command.expectedTransaction && isDeepStrictEqual(transactionRecord(transaction), transactionRecord(command.expectedTransaction)), 'The recorded payment changed. Review it before correcting its amount.');
  requireCondition(!transaction.statementId && !transaction.importSources?.length && !transaction.reversalOf && !transaction.refundOf && !transaction.replacesId
    && !data.transactions.some(item => item.reversalOf === transaction.id || item.refundOf === transaction.id), 'Only an unimported, unreversed payment can receive a bank amount correction.');
  const sourceIds = new Set([source.id, ...(data.importBatches ?? []).filter(item => item.source.accountId === source.accountId && item.source.sha256 === source.sha256).map(item => item.id)]);
  requireCondition(!data.transactions.some(item => item.importSources?.some(ref => sourceIds.has(ref.importId) && ref.rowId === row.id)), 'This bank row is already linked to a recorded transaction.');
  requireCondition(!data.originalImports.some(item => {
    const archived = item.source as { format?: string; bankSource?: { sha256?: string; row?: { id?: string } }; after?: { transaction?: { id?: string } } };
    return archived.format === 'mazal-bank-amount-correction' && archived.bankSource?.sha256 === source.sha256
      && archived.bankSource?.row?.id === row.id && archived.after?.transaction?.id !== transaction.id;
  }), 'This bank row already corrected another recorded payment.');
  requireCondition(transaction.plannedPayment, 'Choose a payment already linked to its paid obligation.');
  requireCondition(!payrollCurrentLinks(data.payrollImports ?? []).some(link => link.transactionId === transaction.id), 'Unlink the existing payroll deposit review before correcting its amount.');
  const account = data.accounts.find(item => item.id === transaction.accountId);
  requireCondition(account?.type === 'cash' && !account.closedAt && source.accountId === account.id, 'The bank source must belong to the payment cash account.');
  requireCondition(!account.reconciliation && !account.clearedTransactionIds?.includes(transaction.id), 'Reopen completed transaction checks before correcting this bank amount.');
  requireCondition(!account.reconciledAt || account.reconciledAt <= source.observedOn!, 'The cash account has a later confirmed balance. Review that balance first.');
  requireCondition(Math.abs(Date.parse(transaction.date) - Date.parse(row.transactionDate)) <= 7 * 86400000
    && Math.abs(Date.parse(transaction.date) - Date.parse(row.postingDate)) <= 7 * 86400000, 'The bank row and payment dates must be within seven days.');
  const obligation = data.obligations.find(item => item.id === transaction.plannedPayment!.obligationId);
  requireCondition(obligation && isDeepStrictEqual(obligation, command.expectedObligation), 'The linked obligation changed. Review it before correcting this payment.');
  requireCondition(obligation.status === 'paid' && obligation.recurrence === 'once' && obligation.entityId === account.entityId
    && obligation.accountId === account.id && obligation.dueDate === transaction.plannedPayment.dueDate
    && obligation.amountCents === transaction.amountCents, 'This correction needs one paid obligation with the same account, date, owner and recorded amount.');
  const amountCents = Math.abs(row.amountCents);
  requireCondition(Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents !== transaction.amountCents, 'The bank row must supply a different, positive payment amount.');
  const income = transaction.kind === 'income' && transaction.toAccountId === null
    && ['Manual entry', `Planned payment ${obligation.id}`].includes(transaction.source)
    && obligation.direction === 'in' && !obligation.assetPurchaseId && row.amountCents > 0;
  const contribution = transaction.kind === 'transfer' && transaction.source === 'Asset contribution'
    && obligation.direction === 'out' && !!obligation.assetPurchaseId
    && transaction.toAccountId === purchaseAccountId(obligation.assetPurchaseId) && row.amountCents < 0;
  requireCondition(income || contribution, 'Bank amount corrections support linked income and asset contributions only.');
  const purchase = contribution ? data.assetPurchases?.find(item => item.id === obligation.assetPurchaseId) : undefined;
  if (contribution) requireCondition(purchase && isDeepStrictEqual(purchase, command.expectedPurchase) && purchase.entityId === account.entityId && purchase.paidCents !== null, 'The linked purchase changed or its paid total is unknown.');
  else requireCondition(command.expectedPurchase === null, 'An income correction cannot update an asset purchase.');
  const difference = amountCents - transaction.amountCents;
  if (purchase) requireCondition(purchase.paidCents! + difference >= 0 && purchase.paidCents! + difference <= purchase.targetCents, 'The corrected contribution exceeds the purchase total or recorded progress.');
  const counterpart = income ? `${account.entityId}:income` : transaction.toAccountId!;
  const lines = data.entries.filter(entry => entry.transactionId === transaction.id);
  requireCondition(lines.length === 2 && lines.some(entry => entry.accountId === account.id && entry.debitCents === (income ? transaction.amountCents : -transaction.amountCents))
    && lines.some(entry => entry.accountId === counterpart && entry.debitCents === (income ? -transaction.amountCents : transaction.amountCents)), 'The payment journal does not match its recorded amount.');
  requireCondition(data.originalImports.length < 100, 'The original-record archive is full. Archive capacity must be reviewed before another correction.');
  const before = structuredClone({ transaction, entries: lines, obligation, purchase: purchase ?? null });
  transaction.amountCents = amountCents;
  transaction.description = command.description.trim();
  obligation.amountCents = amountCents;
  if (purchase) purchase.paidCents! += difference;
  for (const entry of lines) entry.debitCents = entry.accountId === account.id ? (income ? amountCents : -amountCents) : (income ? -amountCents : amountCents);
  const after = structuredClone({ transaction, entries: lines, obligation, purchase: purchase ?? null });
  data.originalImports.push({ date: new Date().toISOString(), source: {
    format: 'mazal-bank-amount-correction', version: 1, requestId: command.requestId, reason: command.reason.trim(),
    bankSource: { importId: source.id, sourceFile: source.sourceFile, sha256: source.sha256, observedOn: source.observedOn, row: structuredClone(row) },
    before, after,
  } });
  return `Corrected ${before.transaction.description} from CAD ${(before.transaction.amountCents / 100).toFixed(2)} to CAD ${(amountCents / 100).toFixed(2)} using ${source.sourceFile}. Preserved its links and archived the original payment, journal and linked records.`;
}
