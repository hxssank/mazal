import { isDeepStrictEqual } from 'node:util';
import type { Account, AccountType, AppState, Command, StatementDecision, StatementSource, StatementSourceRow, Transaction } from '../shared/types.ts';
import { canMatchStatementTransaction, neutralStatementTransactions, statementBalanceDate, statementDebit, statementDecisionIssue, statementPeriodIssues, transactionAccountDelta } from '../shared/statement-imports.ts';
import { transactionBalanceDates } from '../shared/reconciliation.ts';
import { readReviewSource } from './review-sources.ts';
import type { StoredData } from './store.ts';

type Extension = Extract<Command, { type: 'extend_bank_activity' }>;
type LedgerAccount = StoredData['accounts'][number];
interface ExtensionOperations {
  validateSource(raw: unknown): StatementSource;
  validateDecisions(raw: unknown, source: StatementSource): StatementDecision[];
  importState(): Pick<AppState, 'accounts' | 'transactions' | 'importBatches' | 'statements'>;
  post(transaction: Omit<Transaction, 'id' | 'createdAt'>, lines: [string, number][]): Transaction;
  internal(entityId: string, kind: 'income' | 'expense' | 'equity'): string;
  alignHistory(account: LedgerAccount): void;
  balance(account: LedgerAccount): number;
  now(): string;
  today(): string;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function existingBatch(data: StoredData, command: Extension) {
  const batch = data.importBatches?.find(item => item.id === command.sourceId);
  requireCondition(batch?.status === 'committed' && batch.source.sourceKind === 'bank_activity', 'Choose committed bank activity to extend.');
  requireCondition(isDeepStrictEqual(batch.source, command.expectedSource), 'The bank activity source changed. Review its current rows before extending it.');
  return batch;
}

export function verifyBankActivityExtensionSource(data: StoredData, command: Extension, sourceDirectory: string): void {
  const batch = existingBatch(data, command);
  readReviewSource(sourceDirectory, batch.source);
  requireCondition(command.replacementSource && typeof command.replacementSource === 'object', 'Supply the updated bank activity source.');
  readReviewSource(sourceDirectory, command.replacementSource);
}

function rowFacts(row: StatementSourceRow): string {
  return JSON.stringify([row.transactionDate, row.postingDate, row.amountCents, row.description.trim().replace(/\s+/g, ' ').toLowerCase()]);
}

export function extendBankActivity(data: StoredData, command: Extension, operations: ExtensionOperations): string {
  requireCondition(Number.isSafeInteger(command.expectedRevision) && Number(command.expectedRevision) >= 0, 'Extending bank activity needs the current workspace revision.');
  requireCondition(typeof command.reason === 'string' && command.reason.trim() && command.reason.length <= 1000, 'Give an extension reason of at most 1000 characters.');
  const batch = existingBatch(data, command);
  const previous = batch.source;
  const source = operations.validateSource(command.replacementSource);
  requireCondition(source.sourceKind === 'bank_activity' && source.id === previous.id && source.accountId === previous.accountId
    && source.periodStart === previous.periodStart && source.openingBalanceCents === previous.openingBalanceCents,
  'A bank activity extension must keep its source ID, account, start date and opening balance.');
  requireCondition(source.periodEnd >= previous.periodEnd, 'A bank activity extension cannot shorten its observed period.');
  requireCondition(source.sha256 !== previous.sha256 && source.sourceFile !== previous.sourceFile, 'Save the newer bank observation in a separate source file with its own SHA-256.');
  requireCondition(!(data.importBatches ?? []).some(item => item.id !== batch.id && item.source.accountId === source.accountId && item.source.sha256 === source.sha256)
    && !(data.statements ?? []).some(item => item.accountId === source.accountId && item.sha256 === source.sha256), 'The updated bank source is already saved for this account.');
  requireCondition(isDeepStrictEqual(source.csvMapping, previous.csvMapping), 'A bank activity extension cannot change its CSV column mapping.');
  const correctionIds = command.dateCorrectionRowIds ?? [];
  requireCondition(Array.isArray(correctionIds) && correctionIds.every(id => typeof id === 'string') && new Set(correctionIds).size === correctionIds.length, 'Choose different existing transfer row IDs for date corrections.');
  const dateCorrections = new Set(correctionIds);
  requireCondition(correctionIds.every(id => previous.rows.some(row => row.id === id)), 'A date correction must reference an existing source row.');
  requireCondition(source.rows.length > previous.rows.length && previous.rows.every((row, index) => dateCorrections.has(row.id) || isDeepStrictEqual(source.rows[index], row)), 'A bank activity extension must preserve every existing row in order and append new rows.');
  requireCondition(previous.rows.every(row => dateCorrections.has(row.id) || statementBalanceDate(previous, row) === statementBalanceDate(source, row)), 'Extending this observation would move an existing bank balance date. Review that posting transition separately.');
  const added = source.rows.slice(previous.rows.length);
  const seenFacts = new Set([...previous.rows, ...source.rows.slice(0, previous.rows.length)].map(rowFacts));
  for (const row of added) {
    const facts = rowFacts(row);
    requireCondition(!seenFacts.has(facts), 'An appended row duplicates activity already present in this source.');
    seenFacts.add(facts);
  }
  requireCondition(BigInt(source.openingBalanceCents) + source.rows.reduce((sum, row) => sum + BigInt(row.amountCents), 0n) === BigInt(source.closingBalanceCents), 'Extended bank rows must reconcile from the opening balance to the closing balance.');
  const decisions = operations.validateDecisions(command.decisions, { ...source, rows: added });
  requireCondition(decisions.length === added.length, 'Review every appended bank activity row.');
  const periodIssue = statementPeriodIssues(data.statements, (data.importBatches ?? []).map(item => item.id === batch.id ? { ...item, source } : item))[0];
  requireCondition(!periodIssue, periodIssue ?? 'The extended bank period is invalid.');
  const account = data.accounts.find(item => item.id === source.accountId)!;
  requireCondition(!account.closedAt, 'Reopen the account before extending its bank activity.');
  requireCondition(!account.reconciledAt || account.reconciledAt <= source.periodEnd, 'This account has a later confirmed balance. Review that balance before extending earlier bank activity.');
  requireCondition(data.originalImports.length < 100, 'The original-record archive is full. Review its capacity before extending bank activity.');
  const state = operations.importState();
  const transactions = new Map(data.transactions.map(transaction => [transaction.id, transaction]));
  for (const [index, oldRow] of previous.rows.entries()) {
    if (!dateCorrections.has(oldRow.id)) continue;
    const row = source.rows[index];
    const decision = batch.decisions.find(item => item.rowId === oldRow.id);
    const transaction = data.transactions.find(item => item.importSources?.some(ref => ref.importId === batch.id && ref.rowId === oldRow.id));
    const { transactionDate: _oldTransactionDate, postingDate: _oldPostingDate, dateBasis: _oldBasis, ...oldFacts } = oldRow;
    const { transactionDate: _transactionDate, postingDate: _postingDate, dateBasis: _basis, ...newFacts } = row;
    requireCondition(oldRow.dateBasis !== undefined && row.dateBasis === undefined && isDeepStrictEqual(oldFacts, newFacts)
      && decision?.kind === 'transfer' && decision.match && transaction
      && transactionAccountDelta(transaction, account as Account) === row.amountCents
      && Math.abs(Date.parse(row.postingDate) - Date.parse(transaction.postingDate ?? transaction.date)) <= 7 * 86400000,
    'Date corrections require an existing matched transfer with single-date provenance and unchanged row identity, description, amount and page.');
    requireCondition(!account.reconciliation?.transactionIds.includes(transaction.id)
      || statementBalanceDate(previous, oldRow) === statementBalanceDate(source, row), 'Reopen completed transaction checks before changing a checked transfer balance date.');
  }
  const reviewed = new Map(decisions.map(decision => [decision.rowId, decision]));
  const matches = new Map<string, StatementSourceRow>();
  for (const row of added) {
    const decision = reviewed.get(row.id)!;
    const issue = statementDecisionIssue(account as Account, row, decision);
    requireCondition(!issue, issue ?? 'Invalid bank activity classification.');
    requireCondition(decision.kind !== 'transfer' || decision.match, 'Match each appended transfer to an existing transaction.');
    requireCondition(!account.reconciliation || statementBalanceDate(source, row) > account.reconciliation.date
      || decision.match && 'transactionId' in decision.match && account.reconciliation.transactionIds.includes(decision.match.transactionId), 'Reopen completed transaction checks before adding earlier bank activity.');
    if (!decision.match) continue;
    requireCondition('transactionId' in decision.match, 'Appended bank activity can match existing transactions only.');
    const transaction = transactions.get(decision.match.transactionId);
    requireCondition(transaction && canMatchStatementTransaction(state, { ...batch, source }, row, decision.kind, transaction), 'The appended row match has different accounts, amount, date or kind, is reversed, or already has a source.');
    requireCondition(!matches.has(transaction.id), 'An existing transaction cannot match two appended rows for the same account.');
    requireCondition(decision.kind === 'transfer' ? transactionAccountDelta(transaction, account as Account) === row.amountCents : transaction.category === decision.category, 'The appended row must retain the recorded transaction category and exact account movement.');
    requireCondition(!account.reconciliation?.transactionIds.includes(transaction.id)
      || statementBalanceDate(source, row) <= account.reconciliation.date, 'Reopen completed transaction checks before moving a matched payment past their date.');
    matches.set(transaction.id, row);
  }
  const dates = transactionBalanceDates(data);
  const neutral = neutralStatementTransactions(data.transactions);
  const accountBatches = new Set((data.importBatches ?? []).filter(item => item.source.accountId === account.id && item.status === 'committed').map(item => item.id));
  for (const transaction of data.transactions) {
    if (transaction.accountId !== account.id && transaction.toAccountId !== account.id || neutral.has(transaction.id)) continue;
    const matchedRow = matches.get(transaction.id);
    const effectiveDate = matchedRow ? statementBalanceDate(source, matchedRow) : dates.get(transaction.id)?.[account.id] ?? transaction.postingDate ?? transaction.date;
    requireCondition(effectiveDate <= source.periodEnd, 'This account has later transactions. Review their current bank balance before extending earlier activity.');
    const balanceRecord = transaction.kind === 'opening' || transaction.kind === 'adjustment'
      && ['Statement reconciliation', 'Historical statement reconciliation', 'Statement history correction'].includes(transaction.source);
    const linked = transaction.importSources?.some(ref => accountBatches.has(ref.importId)) || transaction.statementId;
    requireCondition(effectiveDate < source.periodStart || balanceRecord || linked || matchedRow, `Match existing entries before extending bank activity. Unmatched: ${transaction.description}.`);
  }
  data.originalImports.push({ date: operations.now(), source: {
    format: 'mazal-bank-activity-extension', version: 1, requestId: command.requestId, reason: command.reason.trim(),
    previousBatch: structuredClone(batch), replacementSource: structuredClone(source), appendedDecisions: structuredClone(decisions),
    ...(correctionIds.length ? { dateCorrectionRowIds: correctionIds } : {}),
  } });
  batch.source = source;
  batch.decisions.push(...decisions);
  delete batch.extractionHistory;
  for (const row of added) {
    const decision = reviewed.get(row.id)!;
    const ref = { importId: batch.id, rowId: row.id };
    if (decision.match && 'transactionId' in decision.match) {
      const transaction = transactions.get(decision.match.transactionId)!;
      transaction.importSources = [...transaction.importSources ?? [], ref];
      transaction.postingDate = decision.kind === 'transfer' ? transaction.postingDate ?? transaction.date : row.postingDate;
    } else {
      const kind = decision.kind === 'movement' ? 'adjustment' : decision.kind === 'income' ? 'income' : 'expense';
      const delta = statementDebit({ type: account.type as AccountType }, row.amountCents);
      operations.post({ date: row.transactionDate, postingDate: row.postingDate, description: row.description, kind,
        amountCents: decision.kind === 'refund' ? -Math.abs(row.amountCents) : Math.abs(row.amountCents), accountId: account.id,
        toAccountId: null, category: decision.category, source: `${source.sourceFile}, page ${row.sourcePage}`.slice(0, 300), importSources: [ref] },
      [[account.id, delta], [operations.internal(account.entityId, kind === 'adjustment' ? 'equity' : kind), -delta]]);
    }
  }
  operations.alignHistory(account);
  requireCondition(operations.balance(account) === source.closingBalanceCents, 'Extended bank transactions do not match the observed closing balance.');
  account.reconciledAt = source.periodEnd;
  account.evidence = { sourceFile: source.sourceFile, asOf: source.periodEnd, capturedOn: operations.today(), status: 'bank',
    notes: 'Observed bank balance includes all reviewed rows, including any later bank posting dates.', balanceCents: source.closingBalanceCents };
  return `Added ${added.length} observed bank rows to ${source.sourceFile}. Preserved all earlier rows, decisions and the original source archive.`;
}
