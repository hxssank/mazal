import { DatabaseSync } from 'node:sqlite';
import { validateDebtTermsModel } from '../shared/debt-model.ts';
import { serializeBackup } from '../shared/backup.ts';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Account, AccountType, AppState, AssetPurchase, AuditEvent, BalanceEvidence, Command, DebtTerms, Entity, ExpenseFund, ExpensePlanItem, MoneyOwed, Obligation, OwedPayment, Reserve, RoadmapSettings, SolHistoryEntry, SolPosition, SourceFact, SpendingLimit, StatementBatch, StatementDecision, StatementImport, StatementSource, StatementRow, TrackedAsset, Transaction, WishItem, Workspace } from '../shared/types.ts';
import { calculateSolActivity, solMarketValue, solSnapshot, validateSolHistory } from '../shared/sol-history.ts';

import { expensePlanLimits } from '../shared/expense-plan.ts';
import { estimatedWorkPayCents } from '../shared/expense-pay.ts';
import { isUncategorized, plannedExpenseCategory } from '../shared/expense-categories.ts';
import { purchaseAccountId } from '../shared/asset-purchases.ts';
import { owedRemaining } from '../shared/asset-planning.ts';
import { recordedObligationDates } from '../shared/analytics.ts';
import { legacyPaymentMatch, manualStatementMatch, previewStatementBatches, statementDebit, statementDecisionIssue, statementPeriodIssues, statementRowKey } from '../shared/statement-imports.ts';
import type { StateChanges } from '../shared/state-changes.ts';
import { createPersistence, type TransactionQuery } from './persistence.ts';
import { autoCategorizeTransaction, validateCategoryRules, type CategoryRule } from '../shared/category-rules.ts';
import { applyCategoryRuleCommand } from './category-rules.ts';
import { applyReconciliationCommand, validateAccountChecks } from './reconciliation.ts';
import { transactionBalanceChanges, transactionBalanceDates, transactionPostingDates } from '../shared/reconciliation.ts';
import type { PayrollImport } from '../shared/payroll.ts';
import { applyPayrollCommand, validatePayrollImports, validatePayrollLinks } from './payroll.ts';
import { validateStatementMapping } from '../shared/statement-mapping.ts';
import { applyBankAmountCorrection, verifyBankAmountCorrectionSource } from './bank-amount-correction.ts';
import { extendBankActivity, verifyBankActivityExtensionSource } from './bank-activity-extension.ts';

type LedgerType = AccountType | 'income' | 'expense' | 'equity' | 'asset_purchase';
type SavedDebtTerms = DebtTerms;
interface LedgerAccount { id: string; entityId: string; name: string; type: LedgerType; currency: 'CAD'; reconciledAt: string | null; debtTerms?: SavedDebtTerms; evidence?: BalanceEvidence; clearedTransactionIds?:string[]; reconciliation?:Account['reconciliation']; closedAt?:string|null; excludeFromNetWorth?:boolean }
interface Entry { id: string; transactionId: string; accountId: string; debitCents: number }
interface SavedRequest { id: string; digest: string }
interface CashPosting { kind: 'owed_payment' | 'asset_sale'; recordId: string; paymentId?: string; accountId: string; transactionId: string; amountCents: number; date: string; balanceCheckDate?: string; reversedById?: string }
type SavedRoadmap = RoadmapSettings;
type PlannedObligation = Obligation & { recurrenceDay?: number };
export interface StoredData {
  revision: number;
  entities: Entity[];
  accounts: LedgerAccount[];
  transactions: Transaction[];
  entries: Entry[];
  obligations: PlannedObligation[];
  reserves: Reserve[];
  positions: SolPosition[];
  audit: AuditEvent[];
  requests: SavedRequest[];
  importKeys: string[];
  originalImports: { date: string; source: unknown }[];
  lastBackupAt: string | null;
  roadmap?: SavedRoadmap;
  spendingLimits?: SpendingLimit[];
  assets?: TrackedAsset[];
  expenseFunds?: ExpenseFund[];
  expensePlanItems?: ExpensePlanItem[];
  assetPurchases?: AssetPurchase[];
  wishItems?: WishItem[];
  moneyOwed?: MoneyOwed[];
  statements?: StatementImport[];
  importBatches?: StatementBatch[];
  sourceFacts?: SourceFact[];
  cashPostings?: CashPosting[];
  categoryRules?: CategoryRule[];
  payrollImports?: PayrollImport[];
}
export interface MazalBackup { format: 'mazal-backup'; version: 1; workspace: Workspace; exportedAt: string; data: StoredData }
export type StateResponse = { status: 200; etag: string; json: string } | { status: 304; etag: string };
const visibleTypes: AccountType[] = ['cash', 'investment', 'debt', 'receivable', 'payable'];
const signedBalanceTypes: AccountType[] = ['cash', 'debt', 'payable'];
const ledgerTypes: LedgerType[] = [...visibleTypes, 'income', 'expense', 'equity', 'asset_purchase'];
const MAX_CENTS = 100_000_000_000_000;
const MAX_LAMPORTS = 1_000_000_000n * 1_000_000_000n;
const LAMPORTS = 1_000_000_000n;
const solJournalSources: Record<SolHistoryEntry['kind'], readonly string[]> = {
  snapshot: [],
  price: ['Manual SOL valuation'],
  correction: ['Manual SOL correction'],
  buy: ['Manual SOL purchase', 'Manual SOL fee', 'SOL rounding'],
  sell: ['Manual SOL sale', 'Manual SOL fee', 'SOL rounding'],
  reward: ['Manual staking reward', 'SOL rounding'],
  fee: ['Manual SOL fee'],
};

function fail(message: string): never { throw new Error(message); }

function matchesStateTag(header: string | undefined, etag: string): boolean {
  let remaining = header?.trim() ?? '';
  if (remaining === '*') return true;
  let matches = false;
  while (remaining) {
    if (remaining.startsWith(',')) { remaining = remaining.slice(1).trim(); continue; }
    const tag = /^(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")[ \t]*(?:,|$)/.exec(remaining);
    if (!tag) return false;
    matches ||= tag[1] === etag;
    remaining = remaining.slice(tag[0].length).trim();
  }
  return matches;
}
export class RevisionConflictError extends Error {}
function checkRevision(expected: unknown, current: number): void {
  if (expected !== undefined && integer(expected, 'Expected revision') !== current) throw new RevisionConflictError('Your records changed in another window. Review the refreshed records and try again.');
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function str(value: unknown, label: string, max = 200, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(`${label} must contain ${empty ? 'text' : 'a value'} of at most ${max} characters.`);
  return value.trim();
}
function transactionAnnotation(value: unknown, label: string, max: number, multiline = false): string | null {
  if (value === null) return null;
  const text = str(value, label, max, true);
  if (/[\u007f-\u009f]/u.test(value as string) || !multiline && /[\t\n\r]/u.test(value as string)) fail(`${label} contains unsupported control characters.`);
  return text || null;
}
function integer(value: unknown, label: string, min = 0, max = MAX_CENTS): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be a whole number between ${min} and ${max}.`);
  return value;
}
function date(value: unknown, label = 'Date'): string {
  const v = str(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '1900-01-01' || v > '2200-12-31' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) fail(`${label} must be a valid YYYY-MM-DD date.`);
  return v;
}
function timestamp(value: unknown, label: string): string {
  const v = str(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail(`${label} must be a valid ISO timestamp.`);
  return v;
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(`${label} is not supported.`);
  return value as T;
}
function additionalIncomeFlag(value: unknown, direction: Obligation['direction']): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail('Additional income must be true or false.');
  if (value && direction !== 'in') fail('Only incoming payments can be additional income.');
  return value;
}

function subscriptionFlag(value: unknown, direction: Obligation['direction'], recurrence: Obligation['recurrence']): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail('Subscription must be true or false.');
  if (value && (direction !== 'out' || recurrence === 'once')) fail('A subscription needs a recurring outgoing payment.');
  return value;
}
function validateObligationAccount(account: LedgerAccount | undefined, accountId: string, entityId: string, direction: Obligation['direction']): void {
  if (!accountId) return;
  if (!account) fail('Choose an existing payment account.');
  if (account.entityId !== entityId) fail('Choose a payment account belonging to this owner.');
  if (direction === 'in' && account.type !== 'cash') fail('Planned income needs a cash account.');
  if (direction === 'out' && !['cash', 'debt', 'payable'].includes(account.type)) fail('Planned expenses need a cash, debt, or payable account.');
}
function validateUnpaidObligationDate(data: StoredData, obligationId: string, dueDate: string): void {
  if (data.transactions.some(tx => tx.plannedPayment?.obligationId === obligationId && tx.plannedPayment.dueDate === dueDate)) fail(`A payment is already recorded for ${dueDate}. Choose another next due date.`);
}
function preservePlannedExpenseCategory(data: StoredData, obligation: Obligation, payment: Transaction): void {
  if (payment.kind !== 'expense' || payment.expenseCategory !== undefined) return;
  const sameCategory = normalizedCategory(payment.category) === normalizedCategory(obligation.category) || isUncategorized(payment.category) && isUncategorized(obligation.category);
  payment.expenseCategory = sameCategory ? plannedExpenseCategory(data, obligation) : payment.category;
}
function list(value: unknown, label: string, max = 250_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be a list with at most ${max} entries.`);
  return value;
}
function uid(): string { return randomUUID(); }
function now(): string { return new Date().toISOString(); }
function today(): string {
  const current = new Date();
  return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
}
function dateAfter(days: number): string { const d = new Date(`${today()}T12:00:00`); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function normalSign(type: LedgerType): number { return ['debt', 'payable', 'income', 'equity'].includes(type) ? -1 : 1; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function unique(items: { id: string }[], label: string): void { if (new Set(items.map(item => item.id)).size !== items.length) fail(`Duplicate ${label} IDs.`); }
function lamports(value: unknown, label: string): bigint {
  const v = str(value, label, 40);
  if (!/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(v)) fail(`${label} must be a nonnegative SOL quantity with at most 9 decimals.`);
  const [whole, fraction = ''] = v.split('.');
  const amount = BigInt(whole) * LAMPORTS + BigInt(fraction.padEnd(9, '0'));
  if (amount > MAX_LAMPORTS) fail(`${label} exceeds the supported quantity.`);
  return amount;
}
function solString(value: bigint): string { const fraction = (value % LAMPORTS).toString().padStart(9, '0').replace(/0+$/, ''); return `${value / LAMPORTS}${fraction ? `.${fraction}` : ''}`; }
function solValue(position: SolPosition): number {
  const total = lamports(position.liquidSol, 'Liquid SOL') + lamports(position.stakedSol, 'Staked SOL');
  const cents = (total * BigInt(position.priceCents) + LAMPORTS / 2n) / LAMPORTS;
  if (cents > BigInt(MAX_CENTS)) fail('SOL value exceeds the supported balance.');
  return Number(cents);
}
function startSolHistory(data:StoredData, position:SolPosition):void {
  if (position.history) return;
  const effectiveDate = data.transactions.reduce((latest, tx) => (tx.accountId === position.accountId || tx.toAccountId === position.accountId) && tx.date > latest ? tx.date : latest, position.priceDate);
  position.priceSource ??= 'Previously saved manual price';
  position.history = [{ ...solSnapshot(position), id:uid(), date:effectiveDate, kind:'snapshot', quantitySol:'0', amountCents:0, feeCents:0, priceSource:position.priceSource, transactionIds:[] }];
}
function appendSolHistory(position:SolPosition, effectiveDate:string, kind:SolHistoryEntry['kind'], details:Partial<Pick<SolHistoryEntry,'quantitySol'|'amountCents'|'feeCents'|'cashAccountId'|'transactionIds'>> = {}):void {
  position.history!.push({ ...solSnapshot(position), id:uid(), date:effectiveDate, kind, quantitySol:'0', amountCents:0, feeCents:0, priceSource:position.priceSource!, transactionIds:[], ...details });
}
function checkSolHistoryDate(position:SolPosition, effectiveDate:string):void {
  const latest = position.history?.at(-1)?.date ?? position.priceDate;
  if (effectiveDate < latest) fail(`SOL history is recorded through ${latest}. Add new activity on that date or later. Use a balance correction for older activity already included in the holding.`);
}
function updateSolQuote(data:StoredData, position:SolPosition, effectiveDate:string, priceCents:number, priceSource:string):void {
  if (position.priceCents === priceCents && position.priceDate === effectiveDate && position.priceSource === priceSource) return;
  position.priceCents = priceCents;
  position.priceDate = effectiveDate;
  position.priceSource = priceSource;
  adjust(data, getAccount(data, position.accountId), solValue(position), effectiveDate, 'SOL price updated', 'Manual SOL valuation');
  appendSolHistory(position, effectiveDate, 'price', { transactionIds:[data.transactions.at(-1)!.id] });
}
function recordSolActivity(data:StoredData, command:Record<string,unknown>, preserveQuoteDate = false):string {
  const position = data.positions.find(item => item.id === str(command.positionId, 'SOL position ID')) ?? fail('SOL position was not found.');
  const account = getAccount(data, position.accountId);
  const kind = choice(command.kind, ['buy', 'sell', 'reward', 'fee'] as const, 'SOL activity');
  const effectiveDate = date(command.date);
  if (effectiveDate > today()) fail('SOL activity dates cannot be in the future.');
  checkTransactionDate(account, effectiveDate);
  startSolHistory(data, position);
  checkSolHistoryDate(position, effectiveDate);
  const quantitySol = solString(lamports(command.quantitySol, 'SOL quantity'));
  const feeCents = integer(command.feeCents, 'Fee');
  const priceCents = integer(command.priceCents, 'SOL price', kind === 'fee' || preserveQuoteDate ? 0 : 1, 1_000_000_000);
  const priceSource = str(command.priceSource, 'Price source', 200);
  const cash = command.cashAccountId ? getAccount(data, command.cashAccountId) : undefined;
  if (cash) {
    if (cash.type !== 'cash' || cash.entityId !== account.entityId) fail('Choose a cash account belonging to this investment owner.');
    if (kind === 'reward') fail('A staking reward adds SOL, not cash.');
    checkTransactionDate(cash, effectiveDate);
    if (cash.reconciledAt === effectiveDate && command.afterBalanceConfirmation !== true) fail(`Confirm that this SOL activity happened after the cash balance check on ${effectiveDate}.`);
  }
  if (kind !== 'fee' && !preserveQuoteDate) updateSolQuote(data, position, effectiveDate, priceCents, priceSource);
  const calculated = calculateSolActivity(position, { kind, quantitySol, feeCents });
  if (cash && calculated.cashDeltaCents < 0) funds(data, cash, -calculated.cashDeltaCents);
  const firstTransaction = data.transactions.length;
  const amount = calculated.amountCents;
  if (kind === 'buy' || kind === 'sell') {
    if (cash) {
      const from = kind === 'buy' ? cash : account;
      const to = kind === 'buy' ? account : cash;
      post(data, { date:effectiveDate, description:`${kind === 'buy' ? 'Buy' : 'Sell'} ${quantitySol} SOL`, kind:'transfer', amountCents:amount, accountId:from.id, toAccountId:to.id, category:'SOL trade', source:kind === 'buy' ? 'Manual SOL purchase' : 'Manual SOL sale' }, [[from.id, -amount], [to.id, amount]]);
    } else {
      adjust(data, account, balance(data, account) + (kind === 'buy' ? amount : -amount), effectiveDate, `${kind === 'buy' ? 'Buy' : 'Sell'} ${quantitySol} SOL; cash not linked`, kind === 'buy' ? 'Manual SOL purchase' : 'Manual SOL sale');
    }
  } else if (kind === 'reward') {
    post(data, { date:effectiveDate, description:`${quantitySol} SOL staking reward`, kind:'income', amountCents:amount, accountId:account.id, toAccountId:null, category:'Staking rewards', source:'Manual staking reward' }, [[account.id, amount], [internal(data, account.entityId, 'income'), -amount]]);
  }
  if (cash && feeCents) {
    post(data, { date:effectiveDate, description:'SOL fee', kind:'expense', amountCents:feeCents, accountId:cash.id, toAccountId:null, category:'Investment fees', source:'Manual SOL fee' }, [[cash.id, -feeCents], [internal(data, cash.entityId, 'expense'), feeCents]]);
  }
  Object.assign(position, calculated.snapshot);
  if (balance(data, account) !== solValue(position)) adjust(data, account, solValue(position), effectiveDate, 'SOL valuation rounding to cents', 'SOL rounding');
  appendSolHistory(position, effectiveDate, kind, { quantitySol, amountCents:amount, feeCents, ...(cash ? { cashAccountId:cash.id } : {}), transactionIds:data.transactions.slice(firstTransaction).map(tx => tx.id) });
  return `Recorded SOL ${kind}${cash ? ` with ${cash.name}` : ''}${kind === 'reward' ? ` at the saved CAD price dated ${position.priceDate}` : ''}.`;
}
function emptyData(): StoredData {
  return { revision: 0, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [], transactions: [], entries: [], obligations: [], reserves: [], positions: [], audit: [], requests: [], importKeys: [], originalImports: [], lastBackupAt: null, spendingLimits: [], assets: [], expenseFunds: [], expensePlanItems: [], assetPurchases: [], wishItems: [], moneyOwed: [] };
}
function getAccount(data: StoredData, id: unknown): LedgerAccount {
  const account = data.accounts.find(item => item.id === str(id, 'Account ID'));
  if (!account || !visibleTypes.includes(account.type as AccountType)) fail('Choose an existing account.');
  return account;
}
function getEntity(data: StoredData, id: unknown): Entity {
  const entity = data.entities.find(item => item.id === str(id, 'Owner ID'));
  if (!entity) fail('Choose an existing owner.');
  return entity;
}
function balance(data: StoredData, account: LedgerAccount): number {
  return data.entries.reduce((total, entry) => total + (entry.accountId === account.id ? entry.debitCents : 0), 0) * normalSign(account.type);
}
function internal(data: StoredData, entityId: string, type: 'income' | 'expense' | 'equity'): string {
  const id = `${entityId}:${type}`;
  if (!data.accounts.some(account => account.id === id)) data.accounts.push({ id, entityId, name: type, type, currency: 'CAD', reconciledAt: null });
  return id;
}
function audit(data: StoredData, action: string, description: string): void { data.audit.push({ id: uid(), date: now(), action, description }); }
function syncStatementCategory(data: StoredData, transaction: Transaction): void {
  for (const ref of transaction.importSources ?? []) {
    const decision = data.importBatches?.find(batch => batch.id === ref.importId)?.decisions.find(item => item.rowId === ref.rowId) ?? fail('The statement review decision was not found.');
    decision.category = transaction.category;
  }
  if (transaction.statementId) {
    const row = data.statements?.find(statement => statement.id === transaction.statementId)?.rows.find(item => item.id === transaction.statementRowId) ?? fail('The source statement row was not found.');
    row.category = transaction.category;
  }
}
function post(data: StoredData, transaction: Omit<Transaction, 'id' | 'createdAt'>, lines: [string, number][]): Transaction {
  for (const [id] of lines) if (data.accounts.find(account => account.id === id)?.closedAt) fail('Reopen the account before recording new activity.');
  const tx = autoCategorizeTransaction(data.categoryRules ?? [], { ...transaction, id: uid(), createdAt: now() }, data.accounts);
  if (tx.category !== transaction.category) syncStatementCategory(data, tx);
  const sums = new Map<string, number>();
  for (const [accountId, debitCents] of lines) {
    integer(debitCents, 'Journal amount', -MAX_CENTS);
    const account = data.accounts.find(item => item.id === accountId) ?? fail('Journal account is missing.');
    sums.set(account.entityId, (sums.get(account.entityId) ?? 0) + debitCents);
  }
  if ([...sums.values()].some(amount => amount !== 0)) fail('Journal must balance for each owner.');
  data.transactions.push(tx);
  data.entries.push(...lines.filter(([, amount]) => amount !== 0).map(([accountId, debitCents]) => ({ id: uid(), transactionId: tx.id, accountId, debitCents })));
  return tx;
}
function adjust(data: StoredData, account: LedgerAccount, newBalance: number, effectiveDate: string, description: string, source: string, kind: 'opening' | 'adjustment' = 'adjustment'): void {
  const difference = newBalance - balance(data, account);
  const delta = difference * normalSign(account.type);
  post(data, { date: effectiveDate, description, kind, amountCents: Math.abs(difference), accountId: account.id, toAccountId: null, category: 'Balance adjustment', source }, [[account.id, delta], [internal(data, account.entityId, 'equity'), -delta]]);
}
function addAccount(data: StoredData, entityId: string, name: string, type: AccountType, opening: number, openingDate: string): LedgerAccount {
  const account: LedgerAccount = { id: uid(), entityId, name, type, currency: 'CAD', reconciledAt: null };
  data.accounts.push(account);
  if (opening !== 0) adjust(data, account, opening, openingDate, `${name} opening balance`, 'Opening balance', 'opening');
  return account;
}
function funds(data: StoredData, account: LedgerAccount, amount: number): void { if (balance(data, account) < amount) fail(`${account.name} does not have enough recorded funds. Reconcile the balance first if it is out of date.`); }
function checkTransactionDate(account: LedgerAccount, effectiveDate: string): void {
  if (account.reconciledAt !== null && effectiveDate < account.reconciledAt) fail(`${account.name} has a confirmed balance on ${account.reconciledAt}. Earlier activity is already included in that balance. Review the entry date so the same money is not counted twice.`);
}
function checkReconciliationDate(data: StoredData, account: LedgerAccount, effectiveDate: string): void {
  const postingDates = transactionBalanceDates(data);
  const latestDate = data.transactions.reduce((latest, transaction) => {
    const posted = postingDates.get(transaction.id)?.[account.id] ?? transaction.postingDate ?? transaction.date;
    return (transaction.accountId === account.id || transaction.toAccountId === account.id) && posted > latest ? posted : latest;
  }, effectiveDate);
  if (latestDate > effectiveDate) fail(`This account has a transaction dated ${latestDate}. Choose that date or later and enter the balance after those transactions.`);
}
function cashAfterReconciliation(data: StoredData, accountId: unknown, entityId: string, effectiveDate: string, afterBalanceConfirmation?: unknown): LedgerAccount {
  const account = getAccount(data, accountId);
  if (account.type !== 'cash' || account.entityId !== entityId) fail('Choose a cash account belonging to this owner.');
  if (afterBalanceConfirmation !== undefined && typeof afterBalanceConfirmation !== 'boolean') fail('The confirmation that cash arrived after the balance check must be true or false.');
  if (account.reconciledAt !== null && effectiveDate < account.reconciledAt) fail(`This cash account has a confirmed balance on ${account.reconciledAt}. Record receipts only after that date so money already included in the bank balance is not added twice.`);
  if (account.reconciledAt === effectiveDate && afterBalanceConfirmation !== true) fail(`Confirm that this money arrived after the balance check on ${account.reconciledAt} before adding a receipt on the same day.`);
  return account;
}
function cashSource(kind: CashPosting['kind'], reversed = false): string { return `${kind === 'owed_payment' ? 'Receivable repayment' : 'Asset sale'}${reversed ? ' reversal' : ''}`; }
function recordCashPosting(data: StoredData, account: LedgerAccount, amountCents: number, effectiveDate: string, description: string, kind: CashPosting['kind'], recordId: string, paymentId?: string): string {
  const tx = post(data, { date: effectiveDate, description, kind: 'adjustment', amountCents, accountId: account.id, toAccountId: null, category: kind === 'owed_payment' ? 'Repayment received' : 'Asset sale', source: cashSource(kind) }, [[account.id, amountCents], [internal(data, account.entityId, 'equity'), -amountCents]]);
  (data.cashPostings ??= []).push({ kind, recordId, ...(paymentId ? { paymentId } : {}), accountId: account.id, transactionId: tx.id, amountCents, date: effectiveDate, ...(account.reconciledAt === effectiveDate ? { balanceCheckDate: effectiveDate } : {}) });
  return tx.id;
}
function reverseCashPosting(data: StoredData, transactionId: string, description: string): void {
  const posting = data.cashPostings?.find(item => item.transactionId === transactionId) ?? fail('The cash posting was not found.');
  if (posting.reversedById) fail('This cash posting was already reversed.');
  const account = getAccount(data, posting.accountId);
  const originalIndex = data.transactions.findIndex(tx => tx.id === posting.transactionId);
  const laterBalanceCheck = data.transactions.slice(originalIndex + 1).some(tx => tx.accountId === account.id && tx.kind === 'adjustment' && tx.source === 'Statement reconciliation');
  if (account.reconciledAt !== null && (posting.date < account.reconciledAt || posting.date === account.reconciledAt && (posting.balanceCheckDate !== account.reconciledAt || laterBalanceCheck))) fail(`This receipt is included in the confirmed cash balance on ${account.reconciledAt}. Review that balance before correcting the receipt.`);
  funds(data, account, posting.amountCents);
  const tx = post(data, { date: today(), description, kind: 'adjustment', amountCents: posting.amountCents, accountId: account.id, toAccountId: null, category: 'Cash receipt correction', source: cashSource(posting.kind, true) }, [[account.id, -posting.amountCents], [internal(data, account.entityId, 'equity'), posting.amountCents]]);
  posting.reversedById = tx.id;
}
function transaction(data: StoredData, input: { kind: unknown; accountId: unknown; toAccountId?: unknown; amountCents: unknown; date: unknown; description: unknown; category: unknown }, source = 'Manual entry', expenseCategory?: string): Transaction {
  const kind = choice(input.kind, ['income', 'expense', 'transfer', 'debt_payment'] as const, 'Transaction kind');
  const account = getAccount(data, input.accountId);
  const amount = integer(input.amountCents, 'Amount', 1);
  const effectiveDate = date(input.date);
  if (effectiveDate > today()) fail('Record transactions only after they happen. Add future payments to the plan.');
  if (account.closedAt) fail('Reopen this account before recording new activity.');
  checkTransactionDate(account, effectiveDate);
  const description = str(input.description, 'Description', 500);
  const category = str(input.category, 'Category', 100, true) || 'Uncategorized';
  let to: LedgerAccount | undefined;
  let lines: [string, number][] = [];
  if (data.positions.some(position => position.accountId === account.id)) fail('Update SOL quantities or record a staking reward for this account.');
  if (kind === 'income') {
    if (!['cash', 'receivable'].includes(account.type)) fail('Income needs a cash or receivable account.');
    lines = [[account.id, amount], [internal(data, account.entityId, 'income'), -amount]];
  } else if (kind === 'expense') {
    if (!['cash', 'debt', 'payable'].includes(account.type)) fail('Expenses need a cash, debt, or payable account.');
    if (account.type === 'cash') funds(data, account, amount);
    lines = [[account.id, -amount], [internal(data, account.entityId, 'expense'), amount]];
  } else {
    to = getAccount(data, input.toAccountId);
    if (to.closedAt) fail('Reopen the destination account before recording new activity.');
    if (account.id === to.id) fail('Choose two different accounts.');
    checkTransactionDate(to, effectiveDate);
    if (data.positions.some(position => position.accountId === to!.id)) fail('Update SOL quantities to change the SOL account.');
    if (kind === 'debt_payment') {
      if (account.type !== 'cash' || !['debt', 'payable'].includes(to.type)) fail('Debt payments must move cash to a debt or payable account.');
      if (balance(data, to) < amount) fail('The payment exceeds the recorded debt balance.');
    } else if (!['cash', 'investment', 'receivable'].includes(account.type) || !['cash', 'investment'].includes(to.type)) fail('Transfers must move an asset to cash or investments. Use debt payment for liabilities.');
    funds(data, account, amount);
    lines = [[account.id, -amount], [to.id, amount]];
    if (account.entityId !== to.entityId) lines.push([internal(data, account.entityId, 'equity'), amount], [internal(data, to.entityId, 'equity'), -amount]);
  }
  return post(data, { date: effectiveDate, description, kind, amountCents: amount, accountId: account.id, toAccountId: to?.id ?? null, category, source, ...(kind === 'expense' && expenseCategory !== undefined ? { expenseCategory } : {}) }, lines);
}
function advanceDate(dueDate: string, recurrence: 'monthly' | 'biweekly', recurrenceDay?: number): string {
  const d = new Date(`${dueDate}T12:00:00Z`);
  if (recurrence === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
  else { const originalDay = recurrenceDay ?? d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(originalDay, lastDay)); }
  return d.toISOString().slice(0, 10);
}

function validateDebtTerms(raw: unknown): SavedDebtTerms {
  const terms = record(raw, 'Debt terms');
  const apr = terms.aprPercent;
  if (apr !== null && (typeof apr !== 'number' || !Number.isFinite(apr) || apr < 0 || apr > 1000)) fail('Debt APR must be a percentage between 0 and 1000, or unknown.');
  if (typeof terms.rateConfirmed !== 'boolean') fail('Rate confirmation must be true or false.');
  if (terms.rateConfirmed && apr === null) fail('Enter the confirmed interest rate before marking it confirmed.');
  const repaymentStatus = terms.repaymentStatus === undefined ? undefined : choice(terms.repaymentStatus, ['repaying', 'in_study'] as const, 'Repayment status');
  const repaymentStatusSource = terms.repaymentStatusSource === undefined ? undefined : choice(terms.repaymentStatusSource, ['owner', 'lender'] as const, 'Repayment status source');
  if (repaymentStatus === 'in_study' && !repaymentStatusSource) fail('Record whether the in-study status is owner-reported or lender-confirmed.');
  const repaymentStatusAsOf = terms.repaymentStatusAsOf === undefined ? undefined : terms.repaymentStatusAsOf === null ? null : date(terms.repaymentStatusAsOf, 'Repayment status date');
  if (repaymentStatusAsOf && repaymentStatusAsOf > today()) fail('Repayment status cannot be confirmed in the future.');
  const schoolReturnMonth = terms.schoolReturnMonth === undefined ? undefined : terms.schoolReturnMonth === null ? null : str(terms.schoolReturnMonth, 'School return month', 7);
  if (schoolReturnMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(schoolReturnMonth)) fail('School return month must use YYYY-MM.');
  return { ...validateDebtTermsModel(terms), aprPercent: apr as number | null, rateConfirmed: terms.rateConfirmed, minimumPaymentCents: terms.minimumPaymentCents === null ? null : integer(terms.minimumPaymentCents, 'Minimum payment'), notes: str(terms.notes, 'Debt notes', 1000, true), ...(terms.paymentDueDate === undefined ? {} : { paymentDueDate: terms.paymentDueDate === null ? null : date(terms.paymentDueDate, 'Payment due date') }), ...(terms.statementDate === undefined ? {} : { statementDate: terms.statementDate === null ? null : date(terms.statementDate, 'Statement date') }), ...(repaymentStatus === undefined ? {} : { repaymentStatus }), ...(repaymentStatusSource === undefined ? {} : { repaymentStatusSource }), ...(repaymentStatusAsOf === undefined ? {} : { repaymentStatusAsOf }), ...(schoolReturnMonth === undefined ? {} : { schoolReturnMonth }) };
}

function validateEvidence(raw: unknown, accountType: LedgerType): BalanceEvidence {
  const evidence = record(raw, 'Balance evidence');
  const asOf = evidence.asOf === null ? null : date(evidence.asOf, 'Balance date');
  const capturedOn = date(evidence.capturedOn, 'Capture date');
  if (capturedOn > today() || asOf !== null && asOf > capturedOn) fail('Balance evidence cannot be dated after its capture date or in the future.');
  return { sourceFile: str(evidence.sourceFile, 'Balance source', 500), asOf, capturedOn, status: choice(evidence.status, ['bank', 'credit_report'] as const, 'Balance source kind'), notes: str(evidence.notes, 'Balance source notes', 4000, true), ...(evidence.balanceCents === undefined ? {} : { balanceCents: integer(evidence.balanceCents, 'Source balance', signedBalanceTypes.includes(accountType as AccountType) ? -MAX_CENTS : 0) }), ...(evidence.creditLimitCents === undefined ? {} : { creditLimitCents: integer(evidence.creditLimitCents, 'Credit limit') }), ...(evidence.availableCreditCents === undefined ? {} : { availableCreditCents: integer(evidence.availableCreditCents, 'Available credit') }), ...(evidence.payoffCents === undefined ? {} : { payoffCents: integer(evidence.payoffCents, 'Payoff amount') }) };
}

function validateStatement(raw: unknown, accounts: LedgerAccount[]): StatementImport {
  const source = record(raw, 'Statement');
  const accountId = str(source.accountId, 'Statement account ID');
  if (!accounts.some(account => account.id === accountId && ['debt', 'payable'].includes(account.type))) fail('Statements need an existing debt or payable account.');
  const periodStart = date(source.periodStart, 'Statement start date');
  const periodEnd = date(source.periodEnd, 'Statement end date');
  if (periodEnd < periodStart || periodEnd > today()) fail('The statement period must end on or after its start and cannot end in the future.');
  const digest = str(source.sha256, 'Statement SHA-256', 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) fail('The statement SHA-256 must have 64 lowercase hexadecimal characters.');
  const rows = list(source.rows, 'Statement rows', 5000).map(rawRow => {
    const row = record(rawRow, 'Statement row');
    const transactionDate = date(row.transactionDate, 'Transaction date');
    const postingDate = date(row.postingDate, 'Posting date');
    if (postingDate < periodStart || postingDate > periodEnd || transactionDate > postingDate) fail('Statement posting dates must fall within its period and cannot precede the transaction date.');
    const kind = choice(row.kind, ['purchase', 'interest', 'payment', 'refund'] as const, 'Statement row kind');
    const amountCents = integer(row.amountCents, 'Statement amount', -MAX_CENTS);
    if (['purchase', 'interest'].includes(kind) ? amountCents <= 0 : amountCents >= 0) fail('Statement purchases and interest must increase debt; payments and refunds must reduce it.');
    return { id: str(row.id, 'Statement row ID'), transactionDate, postingDate, description: str(row.description, 'Statement description', 500), amountCents, kind, category: str(row.category, 'Statement category', 100, true) || 'Uncategorized', sourcePage: integer(row.sourcePage, 'Source page', 1, 10000) } satisfies StatementRow;
  });
  unique(rows, 'statement row');
  const openingBalanceCents = integer(source.openingBalanceCents, 'Statement opening balance');
  const closingBalanceCents = integer(source.closingBalanceCents, 'Statement closing balance');
  const calculated = rows.reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(openingBalanceCents));
  if (calculated !== BigInt(closingBalanceCents)) fail('Statement rows do not reconcile from the opening balance to the closing balance.');
  return { id: str(source.id, 'Statement ID'), accountId, sourceFile: str(source.sourceFile, 'Statement source filename', 500), sha256: digest, periodStart, periodEnd, openingBalanceCents, closingBalanceCents, rows };
}

function exactText(value: unknown, label: string, max = 500): string {
  str(value, label, max);
  return value as string;
}
function validateStatementSource(raw: unknown, accounts: LedgerAccount[]): StatementSource {
  const source = record(raw, 'Statement source');
  const csvMapping = source.csvMapping === undefined ? undefined : validateStatementMapping(source.csvMapping);
  if (csvMapping && (typeof source.sourceFile !== 'string' || !/\.csv$/i.test(source.sourceFile))) fail('CSV column mappings belong to CSV originals.');
  const accountId = str(source.accountId, 'Statement account ID');
  if (!accounts.some(account => account.id === accountId && ['cash', 'debt', 'payable'].includes(account.type))) fail('Statements need an existing cash, debt, or payable account.');
  const periodStart = date(source.periodStart, 'Statement start date');
  const periodEnd = date(source.periodEnd, 'Statement end date');
  if (periodEnd < periodStart || periodEnd > today()) fail('The statement period must end on or after its start and cannot end in the future.');
  const sourceKind = source.sourceKind === undefined ? undefined : choice(source.sourceKind, ['bank_activity'] as const, 'Statement source kind');
  const observedOn = source.observedOn === undefined ? undefined : date(source.observedOn, 'Bank observation date');
  if ((sourceKind === 'bank_activity') !== (observedOn !== undefined)) fail('Bank activity needs both its source kind and observation date.');
  if (observedOn !== undefined && observedOn !== periodEnd) fail('Bank activity coverage must end on its observation date.');
  const lastPostingDate = observedOn === undefined ? periodEnd : new Date(Date.parse(`${observedOn}T12:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  const sha256 = str(source.sha256, 'Statement SHA-256', 64);
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail('The statement SHA-256 must have 64 lowercase hexadecimal characters.');
  const rows = list(source.rows, 'Statement source rows', 10000).map(rawRow => {
    const row = record(rawRow, 'Statement source row');
    const transactionDate = date(row.transactionDate, 'Transaction date');
    const postingDate = date(row.postingDate, 'Posting date');
    const dateBasis = row.dateBasis === undefined ? undefined : choice(row.dateBasis, ['posting_only', 'transaction_only'] as const, 'Bank activity date basis');
    if (dateBasis !== undefined && sourceKind !== 'bank_activity') fail('A single supplied date is only supported for bank activity.');
    if (dateBasis !== undefined && transactionDate !== postingDate) fail('Single-date bank activity must use its supplied date for both ledger dates.');
    if (postingDate < periodStart || postingDate > lastPostingDate || transactionDate > postingDate) fail('Statement posting dates must fall within its period and cannot precede the transaction date. Bank activity may show posting dates at most seven days after observation.');
    if (observedOn !== undefined && transactionDate > observedOn) fail('Observed bank activity cannot contain future transactions.');
    const amountCents = integer(row.amountCents, 'Statement amount', -MAX_CENTS);
    if (!amountCents) fail('Statement amounts cannot be zero.');
    return { id: str(row.id, 'Statement row ID'), transactionDate, postingDate, description: exactText(row.description, 'Original statement description'), amountCents, sourcePage: integer(row.sourcePage, 'Source page', 1, 10000), ...(dateBasis === undefined ? {} : { dateBasis }) };
  });
  unique(rows, 'statement source row');
  return { id: str(source.id, 'Statement source ID'), accountId, sourceFile: exactText(source.sourceFile, 'Statement source filename'), sha256, periodStart, periodEnd, openingBalanceCents: integer(source.openingBalanceCents, 'Statement opening balance', -MAX_CENTS), closingBalanceCents: integer(source.closingBalanceCents, 'Statement closing balance', -MAX_CENTS), rows, ...(sourceKind === undefined ? {} : { sourceKind, observedOn }), ...(csvMapping === undefined ? {} : { csvMapping }) };
}
function validateStatementDecisions(raw: unknown, source: StatementSource): StatementDecision[] {
  const ids = new Set(source.rows.map(row => row.id));
  const decisions = list(raw, 'Statement decisions', 10000).map(rawDecision => {
    const d = record(rawDecision, 'Statement decision');
    const rowId = str(d.rowId, 'Reviewed row ID');
    if (!ids.has(rowId)) fail('A review decision references a missing source row.');
    const decision: StatementDecision = { rowId, kind: choice(d.kind, ['expense', 'income', 'refund', 'interest', 'transfer', 'movement'] as const, 'Statement classification'), category: str(d.category, 'Statement category', 100, true) || 'Uncategorized' };
    if (d.match !== undefined) {
      const match = record(d.match, 'Statement match');
      if (!['transfer', 'expense', 'income', 'interest', 'refund'].includes(decision.kind) || decision.kind !== 'transfer' && match.transactionId === undefined) fail('Match this classification to an existing expense, income, or refund transaction.');
      if (match.transactionId !== undefined) {
        if (match.importId !== undefined || match.rowId !== undefined) fail('Choose a matching statement row or transaction, not both.');
        decision.match = { transactionId: str(match.transactionId, 'Matched transaction ID') };
      } else decision.match = { importId: str(match.importId, 'Matched import ID'), rowId: str(match.rowId, 'Matched row ID') };
    }
    return decision;
  });
  if (new Set(decisions.map(item => item.rowId)).size !== decisions.length) fail('A statement row can have only one review decision.');
  return decisions;
}
function validateStatementBatches(raw: unknown, accounts: LedgerAccount[]): StatementBatch[] {
  const batches = list(raw ?? [], 'Statement imports', 10000).map(rawBatch => {
    const batch = record(rawBatch, 'Statement import');
    const source = validateStatementSource(batch.source, accounts);
    const id = str(batch.id, 'Import ID');
    if (id !== source.id) fail('A statement source and its import must keep the same ID.');
    const status = choice(batch.status, ['staged', 'committed'] as const, 'Import status');
    const createdAt = timestamp(batch.createdAt, 'Import date');
    const committedAt = batch.committedAt === null ? null : timestamp(batch.committedAt, 'Commit date');
    if (status === 'staged' ? committedAt !== null : committedAt === null || committedAt < createdAt) fail('Statement status and commit date disagree.');
    const extractionHistory = list(batch.extractionHistory ?? [], 'Statement extraction history', 100).map(rawRevision => {
      const revision = record(rawRevision, 'Statement extraction revision');
      const previousSource = validateStatementSource(revision.source, accounts);
      const revisedAt = timestamp(revision.revisedAt, 'Extraction revision date');
      if (previousSource.id !== source.id || previousSource.sha256 !== source.sha256 || revisedAt < createdAt) fail('An extraction revision must retain its original document and import identity.');
      return { source: previousSource, decisions: validateStatementDecisions(revision.decisions, previousSource), revisedAt, reason: str(revision.reason, 'Extraction revision reason', 1000) };
    });
    return { id, source, decisions: validateStatementDecisions(batch.decisions, source), status, createdAt, committedAt, ...(extractionHistory.length ? { extractionHistory } : {}) };
  });
  unique(batches, 'statement import');
  const sourceIds = new Set<string>();
  for (const batch of batches) {
    const key = JSON.stringify([batch.source.accountId, batch.source.sha256]);
    if (sourceIds.has(key)) fail('A source file cannot be staged twice for the same account.');
    sourceIds.add(key);
    if (batch.status === 'committed' && batch.source.rows.reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(batch.source.openingBalanceCents)) !== BigInt(batch.source.closingBalanceCents)) fail('Committed statement rows must reconcile to its closing balance.');
  }
  return batches;
}
function validateImportPeriods(statements: StatementImport[], batches: StatementBatch[]): void {
  const issue = statementPeriodIssues(statements, batches)[0];
  if (issue) fail(issue);
}
function importState(data: StoredData): Pick<AppState, 'accounts' | 'transactions' | 'importBatches' | 'statements'> {
  const balances = new Map<string, number>();
  for (const entry of data.entries) balances.set(entry.accountId, (balances.get(entry.accountId) ?? 0) + entry.debitCents);
  return { accounts: data.accounts.filter(account => visibleTypes.includes(account.type as AccountType)).map(account => ({ ...account, type: account.type as AccountType, balanceCents: (balances.get(account.id) ?? 0) * normalSign(account.type) })), transactions: data.transactions, importBatches: data.importBatches ?? [], statements: data.statements ?? [] };
}
function sourceDigest(source: StatementSource): string {
  const { id: _id, sourceFile: _sourceFile, ...facts } = source;
  return hash(facts);
}
function transferLines(data: StoredData, from: LedgerAccount, to: LedgerAccount, amount: number): [string, number][] {
  const lines: [string, number][] = [[from.id, -amount], [to.id, amount]];
  if (from.entityId !== to.entityId) lines.push([internal(data, from.entityId, 'equity'), amount], [internal(data, to.entityId, 'equity'), -amount]);
  return lines;
}
function alignStatementHistory(data: StoredData, account: LedgerAccount): void {
  const sources = [...(data.statements ?? []), ...(data.importBatches ?? []).filter(batch => batch.status === 'committed').map(batch => batch.source)]
    .filter(source => source.accountId === account.id).sort((left, right) => left.periodStart.localeCompare(right.periodStart));
  if (!sources.length) return;
  const dates = transactionBalanceDates(data);
  const transactions = new Map(data.transactions.map(transaction => [transaction.id, transaction]));
  const movements = new Map<string, bigint>();
  const superseded = new Map<string, bigint>();
  for (const entry of data.entries) {
    if (entry.accountId !== account.id) continue;
    const transaction = transactions.get(entry.transactionId)!;
    const effectiveDate = dates.get(transaction.id)?.[account.id] ?? transaction.postingDate ?? transaction.date;
    const movement = BigInt(entry.debitCents * normalSign(account.type));
    movements.set(effectiveDate, (movements.get(effectiveDate) ?? 0n) + movement);
    const covered = sources.some(source => source.periodStart <= effectiveDate && effectiveDate <= source.periodEnd);
    const balanceRecord = transaction.kind === 'opening' || transaction.kind === 'adjustment' && ['Statement reconciliation', 'Historical statement reconciliation', 'Statement history correction'].includes(transaction.source);
    if (balanceRecord && !transaction.statementId && !transaction.importSources?.length && covered) superseded.set(effectiveDate, (superseded.get(effectiveDate) ?? 0n) + movement);
  }
  function correction(delta: bigint, effectiveDate: string, description: string, kind: 'opening' | 'adjustment' = 'adjustment'): void {
    if (delta === 0n && kind !== 'opening') return;
    if (delta < -BigInt(MAX_CENTS) || delta > BigInt(MAX_CENTS)) fail('Statement history corrections exceed the supported balance.');
    const debit = Number(delta) * normalSign(account.type);
    post(data, { date: effectiveDate, description, kind, amountCents: Math.abs(Number(delta)), accountId: account.id, toAccountId: null, category: 'Balance adjustment', source: 'Statement history correction' }, [[account.id, debit], [internal(data, account.entityId, 'equity'), -debit]]);
    movements.set(effectiveDate, (movements.get(effectiveDate) ?? 0n) + delta);
  }
  for (const [effectiveDate, movement] of superseded) correction(-movement, effectiveDate, 'Statement source rows replace the balance-only entries on this date. Original entries remain in history.');
  const through = (effectiveDate: string) => [...movements].reduce((sum, [date, amount]) => date <= effectiveDate ? sum + amount : sum, 0n);
  for (const [index, source] of sources.entries()) {
    const before = new Date(`${source.periodStart}T12:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    const openingDate = before.toISOString().slice(0, 10);
    if (openingDate < '1900-01-01') fail('Statement history needs an opening date on or after 1900-01-01.');
    const delta = BigInt(source.openingBalanceCents) - through(openingDate);
    const needsOpening = index === 0 && !data.transactions.some(transaction => transaction.kind === 'opening' && transaction.accountId === account.id && transaction.date <= openingDate);
    correction(delta, openingDate, `${source.sourceFile}: opening balance before ${source.periodStart}.`.slice(0, 500), needsOpening ? 'opening' : 'adjustment');
    if (through(source.periodEnd) !== BigInt(source.closingBalanceCents)) fail(`The recorded history does not reconcile to ${source.sourceFile} on ${source.periodEnd}. Review activity within that statement period.`);
  }
}
function commitStatements(data: StoredData, rawIds: unknown): string {
  const ids = list(rawIds, 'Statement imports', 1000).map(id => str(id, 'Import ID'));
  const preview = previewStatementBatches(importState(data), ids);
  if (!preview.ready) fail(preview.issues.join(' '));
  const selected = new Set(ids);
  const batches = (data.importBatches ?? []).filter(batch => selected.has(batch.id)).sort((a, b) => a.source.periodStart.localeCompare(b.source.periodStart));
  validateImportPeriods(data.statements ?? [], (data.importBatches ?? []).map(batch => selected.has(batch.id) ? { ...batch, status: 'committed' } : batch));
  const batchMap = new Map(batches.map(batch => [batch.id, batch]));
  const rows = new Map(batches.flatMap(batch => batch.source.rows.map(row => [statementRowKey(batch.id, row.id), row] as const)));
  const decisions = new Map(batches.flatMap(batch => batch.decisions.map(decision => [statementRowKey(batch.id, decision.rowId), decision] as const)));
  const transactionMap = new Map(data.transactions.map(tx => [tx.id, tx]));
  const byAccount = new Map<string, StatementBatch[]>();
  for (const batch of batches) byAccount.set(batch.source.accountId, [...(byAccount.get(batch.source.accountId) ?? []), batch]);
  const preserved = new Map<string, { balance: number; date: string }>();
  for (const [accountId, group] of byAccount) {
    const account = getAccount(data, accountId);
    if (account.reconciledAt !== null && account.reconciledAt >= group[group.length - 1].source.periodEnd) preserved.set(account.id, { balance: balance(data, account), date: account.reconciledAt });
  }
  const processed = new Set<string>();
  for (const batch of batches) {
    const account = getAccount(data, batch.source.accountId);
    for (const row of batch.source.rows) {
      const key = statementRowKey(batch.id, row.id);
      if (processed.has(key)) continue;
      const decision = decisions.get(key)!;
      const ref = { importId: batch.id, rowId: row.id };
      if (decision.match && 'transactionId' in decision.match || decision.kind === 'transfer') {
        const match = decision.match!;
        if ('transactionId' in match) {
          const tx = transactionMap.get(match.transactionId)!;
          if (decision.kind === 'transfer' && legacyPaymentMatch(tx, batch, row, importState(data).accounts)) {
            const target = getAccount(data, tx.accountId);
            tx.accountId = account.id;
            tx.toAccountId = target.id;
            tx.kind = 'debt_payment';
            data.entries = data.entries.filter(entry => entry.transactionId !== tx.id);
            data.entries.push(...transferLines(data, account, target, tx.amountCents).map(([accountId, debitCents]) => ({ id: uid(), transactionId: tx.id, accountId, debitCents })));
          }
          tx.importSources = [...(tx.importSources ?? []), ref];
          tx.postingDate = decision.kind === 'transfer' ? tx.postingDate ?? tx.date : row.postingDate;
        } else {
          const otherBatch = batchMap.get(match.importId)!;
          const otherRow = rows.get(statementRowKey(match.importId, match.rowId))!;
          const otherAccount = getAccount(data, otherBatch.source.accountId);
          const from = statementDebit({ type: account.type as AccountType }, row.amountCents) < 0 ? account : otherAccount;
          const to = from === account ? otherAccount : account;
          const origin = from === account ? row : otherRow;
          post(data, { date: origin.transactionDate, postingDate: origin.postingDate, description: origin.description, kind: to.type === 'cash' ? 'transfer' : 'debt_payment', amountCents: Math.abs(row.amountCents), accountId: from.id, toAccountId: to.id, category: decision.category, source: 'Matched statement transfer', importSources: [ref, match] }, transferLines(data, from, to, Math.abs(row.amountCents)));
          processed.add(statementRowKey(match.importId, match.rowId));
        }
      } else {
        const amount = decision.kind === 'refund' ? -Math.abs(row.amountCents) : Math.abs(row.amountCents);
        const kind = decision.kind === 'movement' ? 'adjustment' : decision.kind === 'income' ? 'income' : 'expense';
        const delta = statementDebit({ type: account.type as AccountType }, row.amountCents);
        post(data, { date: row.transactionDate, postingDate: row.postingDate, description: row.description, kind, amountCents: amount, accountId: account.id, toAccountId: null, category: decision.category, source: `${batch.source.sourceFile}, page ${row.sourcePage}`.slice(0, 300), importSources: [ref] }, [[account.id, delta], [internal(data, account.entityId, kind === 'adjustment' ? 'equity' : kind), -delta]]);
      }
      processed.add(key);
    }
    batch.status = 'committed';
    batch.committedAt = now();
  }
  for (const [accountId, group] of byAccount) {
    const account = getAccount(data, accountId);
    alignStatementHistory(data, account);
    const keep = preserved.get(accountId);
    if (keep) {
      const latestSource = [...(data.statements ?? []), ...(data.importBatches ?? []).filter(batch => batch.status === 'committed').map(batch => batch.source)].filter(source => source.accountId === accountId).sort((left, right) => right.periodEnd.localeCompare(left.periodEnd))[0];
      if (latestSource.periodEnd === keep.date && latestSource.closingBalanceCents !== keep.balance) fail('The confirmed balance and statement closing balance disagree on the same date. Review the bank balance before importing.');
      adjust(data, account, keep.balance, keep.date, 'Imported historical statements; preserved the later confirmed balance', 'Historical statement reconciliation');
    }
    else {
      const source = group[group.length - 1].source;
      if (balance(data, account) !== source.closingBalanceCents) fail('Imported transactions do not match the statement closing balance.');
      account.reconciledAt = source.periodEnd;
      account.evidence = { sourceFile: source.sourceFile, asOf: source.periodEnd, capturedOn: today(), status: 'bank', notes: source.sourceKind === 'bank_activity' ? 'Observed bank balance includes all reviewed rows, including any later bank posting dates.' : 'Statement opening balance and all reviewed rows reconcile to its closing balance.', balanceCents: source.closingBalanceCents };
    }
  }
  return `Committed ${batches.length} statements and ${preview.rowCount} source rows. Matched transfers are excluded from income and spending.`;
}

function validateCommittedImports(batches: StatementBatch[], transactions: Transaction[], accounts: LedgerAccount[], transactionEntries: Map<string, Entry[]>): void {
  const batchMap = new Map(batches.map(batch => [batch.id, batch]));
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const rows = new Map(batches.flatMap(batch => batch.source.rows.map(row => [statementRowKey(batch.id, row.id), row] as const)));
  const decisions = new Map(batches.flatMap(batch => batch.decisions.map(decision => [statementRowKey(batch.id, decision.rowId), decision] as const)));
  const linked = new Map<string, Transaction>();
  const reversed = new Set(transactions.flatMap(tx => tx.reversalOf ? [tx.reversalOf] : []));
  for (const tx of transactions) {
    const seenAccounts = new Set<string>();
    for (const ref of tx.importSources ?? []) {
      const batch = batchMap.get(ref.importId);
      const row = rows.get(statementRowKey(ref.importId, ref.rowId));
      const decision = decisions.get(statementRowKey(ref.importId, ref.rowId));
      if (!batch || batch.status !== 'committed' || !row || !decision) fail('A transaction references a missing or uncommitted statement source.');
      const key = statementRowKey(ref.importId, ref.rowId);
      if (linked.has(key)) fail('A statement source row cannot be posted twice.');
      linked.set(key, tx);
      if (seenAccounts.has(batch.source.accountId)) fail('A transaction cannot include two source rows for the same account.');
      seenAccounts.add(batch.source.accountId);
      const account = accountMap.get(batch.source.accountId)!;
      const invalid = statementDecisionIssue({ type: account.type as AccountType }, row, decision);
      if (invalid) fail(invalid);
      const delta = (transactionEntries.get(tx.id) ?? []).filter(entry => entry.accountId === account.id).reduce((sum, entry) => sum + entry.debitCents, 0);
      if (delta !== statementDebit({ type: account.type as AccountType }, row.amountCents)) fail('A statement source row does not match its account journal movement.');
      if (decision.kind === 'transfer') {
        if (!['transfer', 'debt_payment'].includes(tx.kind) || !decision.match || Math.abs(Date.parse(row.postingDate) - Date.parse(tx.postingDate ?? tx.date)) > 7 * 86400000) fail('A transfer source needs a matching recorded transfer.');
        if ('transactionId' in decision.match) {
          if (decision.match.transactionId !== tx.id) fail('The transfer review points to a different transaction.');
        } else {
          const match = decision.match;
          const back = decisions.get(statementRowKey(match.importId, match.rowId))?.match;
          if (!tx.importSources?.some(item => item.importId === match.importId && item.rowId === match.rowId) || !back || !('importId' in back) || back.importId !== batch.id || back.rowId !== row.id) fail('Transfer rows must reference each other and one recorded transaction.');
        }
      } else if (decision.match) {
        if (!('transactionId' in decision.match) || decision.match.transactionId !== tx.id || !manualStatementMatch(tx, batch, row, decision.kind, [account as Account]) || tx.postingDate !== row.postingDate || tx.category !== decision.category || tx.importSources?.length !== 1 || reversed.has(tx.id)) fail('A matched statement row must retain one eligible recorded expense, income, or refund and its exact journal movement.');
      } else {
        const amount = decision.kind === 'refund' ? -Math.abs(row.amountCents) : Math.abs(row.amountCents);
        const kind = decision.kind === 'movement' ? 'adjustment' : decision.kind === 'income' ? 'income' : 'expense';
        if (tx.kind !== kind || tx.accountId !== account.id || tx.amountCents !== amount || tx.description !== row.description || tx.date !== row.transactionDate || tx.postingDate !== row.postingDate || tx.category !== decision.category || tx.importSources?.length !== 1) fail('An imported transaction does not match its source row and review decision.');
      }
    }
  }
  for (const batch of batches) if (batch.status === 'committed') {
    if (batch.decisions.length !== batch.source.rows.length || batch.source.rows.some(row => !linked.has(statementRowKey(batch.id, row.id)))) fail('A committed statement row is missing its recorded transaction or review decision.');
  }
}

function validateStatements(raw: unknown, accounts: LedgerAccount[]): StatementImport[] {
  const statements = list(raw ?? [], 'Statements', 10000).map(item => validateStatement(item, accounts));
  unique(statements, 'statement');
  const seen = new Set<string>();
  for (const statement of [...statements].sort((a, b) => a.accountId.localeCompare(b.accountId) || a.periodStart.localeCompare(b.periodStart))) {
    const key = JSON.stringify([statement.accountId, statement.sha256]);
    if (seen.has(key)) fail('This statement file has already been imported for this account.');
    seen.add(key);
  }
  const ordered = [...statements].sort((a, b) => a.accountId.localeCompare(b.accountId) || a.periodStart.localeCompare(b.periodStart));
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.accountId === current.accountId && previous.periodEnd >= current.periodStart) fail('Statement periods for the same account cannot overlap.');
    const nextDay = new Date(`${previous.periodEnd}T12:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (previous.accountId === current.accountId && nextDay.toISOString().slice(0, 10) === current.periodStart && previous.closingBalanceCents !== current.openingBalanceCents) fail('Adjacent statements must carry the previous closing balance into the next opening balance.');
  }
  return statements;
}

function statementDigest(statement: StatementImport): string {
  const { id: _id, sourceFile: _sourceFile, rows, ...facts } = statement;
  return hash({ ...facts, rows: rows.map(({ category: _category, ...row }) => row) });
}

function validateRoadmap(raw: unknown, accounts: LedgerAccount[]): SavedRoadmap {
  const roadmap = record(raw, 'Roadmap');
  const nullableCents = (value: unknown, label: string): number | null => value === null ? null : integer(value, label);
  const loanAccountId = str(roadmap.loanAccountId, 'Loan account ID', 200, true);
  if (loanAccountId && !accounts.some(account => account.id === loanAccountId && ['debt', 'payable'].includes(account.type))) fail('Choose an existing loan or debt account.');
  const apr = roadmap.loanAprPercent;
  if (apr !== null && (typeof apr !== 'number' || !Number.isFinite(apr) || apr < 0 || apr > 1000)) fail('Loan APR must be a percentage between 0 and 1000, or unknown.');
  const cadencePresent = ['payAmountCents', 'payEveryDays', 'paydayAnchor'].some(key => roadmap[key] !== undefined);
  const cadence = cadencePresent ? { payAmountCents: integer(roadmap.payAmountCents, 'Pay amount', 1), payEveryDays: integer(roadmap.payEveryDays, 'Days between paydays', 1, 366), paydayAnchor: date(roadmap.paydayAnchor, 'Payday anchor') } : {};
  const transitionDate = date(roadmap.transitionDate, 'Transition date');
  let temporaryWorkSchedule: RoadmapSettings['temporaryWorkSchedule'];
  let partTimeMonthlyIncomeCents = nullableCents(roadmap.partTimeMonthlyIncomeCents, 'Part-time monthly income');
  if (roadmap.temporaryWorkSchedule !== undefined) {
    const input = record(roadmap.temporaryWorkSchedule, 'Temporary work schedule');
    const hours = (value: unknown, label: string) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 168 || Math.round(value * 100) / 100 !== value) fail(`${label} must be between 0.01 and 168 hours, with at most two decimal places.`);
      return value;
    };
    const weeklyHours = hours(input.weeklyHours, 'Part-time weekly hours');
    const fullTimeWeeklyHours = hours(input.fullTimeWeeklyHours, 'Full-time weekly hours');
    const returnDate = date(input.returnDate, 'Full-time return date');
    if (returnDate <= transitionDate) fail('Full-time work must resume after the part-time start date.');
    if (weeklyHours >= fullTimeWeeklyHours) fail('Part-time hours must be fewer than full-time hours.');
    temporaryWorkSchedule = { weeklyHours, fullTimeWeeklyHours, returnDate, payPeriodEndLagDays: integer(input.payPeriodEndLagDays, 'Days from pay period end to payday', 0, 366) };
    const frequency = cadence.payEveryDays === 14 ? 26 : cadence.payEveryDays === 7 ? 52 : null;
    partTimeMonthlyIncomeCents = frequency && cadence.payAmountCents != null
      ? integer(Math.round(estimatedWorkPayCents(cadence.payAmountCents, temporaryWorkSchedule) * frequency / 12), 'Estimated monthly part-time pay')
      : null;
  }
  return {
    ...cadence,
    ...(temporaryWorkSchedule && { temporaryWorkSchedule }),
    ...(roadmap.growthTarget === undefined ? {} : { growthTarget: roadmap.growthTarget === null ? null : choice(roadmap.growthTarget, ['lifetime_compounding'] as const, 'Growth target') }),
    ...(roadmap.incomeTransitionPlanned === undefined ? {} : { incomeTransitionPlanned: typeof roadmap.incomeTransitionPlanned === 'boolean' ? roadmap.incomeTransitionPlanned : fail('Income transition planned must be true or false.') }),
    ...(roadmap.planningCashReserveCents === undefined ? {} : { planningCashReserveCents: nullableCents(roadmap.planningCashReserveCents, 'Protected cash reserve') }),
    ...(roadmap.monthlyFamilyPaymentCents === undefined ? {} : { monthlyFamilyPaymentCents: integer(roadmap.monthlyFamilyPaymentCents, 'Monthly family payment') }),
    ...(roadmap.familyPaymentNote === undefined ? {} : { familyPaymentNote: str(roadmap.familyPaymentNote, 'Family payment note', 1000, true) }),
    currentMonthlyIncomeCents: nullableCents(roadmap.currentMonthlyIncomeCents, 'Current monthly income'),
    partTimeMonthlyIncomeCents,
    monthlyEssentialsCents: nullableCents(roadmap.monthlyEssentialsCents, 'Monthly essentials'),
    monthlyDebtMinimumsCents: nullableCents(roadmap.monthlyDebtMinimumsCents, 'Monthly debt minimums'),
    transitionDate,
    transitionMonths: integer(roadmap.transitionMonths, 'Transition months', 1, 120),
    monthlyExtraDebtCents: integer(roadmap.monthlyExtraDebtCents, 'Extra monthly debt payment'),
    loanAccountId,
    loanAprPercent: apr as number | null,
    loanMonthlyPaymentCents: nullableCents(roadmap.loanMonthlyPaymentCents, 'Monthly loan payment'),
  };
}

function normalizedCategory(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-CA'); }
function validateSpendingLimit(raw: unknown, entityIds: Set<string>): SpendingLimit {
  const input = record(raw, 'Spending limit');
  const entityId = str(input.entityId, 'Spending limit owner ID');
  if (!entityIds.has(entityId)) fail('A spending limit references a missing owner.');
  const color = str(input.color, 'Category color', 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) fail('Category color must be a six-digit hex color, such as #AABBCC.');
  const aliases = list(input.aliases, 'Category aliases', 50).map(alias => str(alias, 'Category alias', 100));
  if (new Set(aliases.map(normalizedCategory)).size !== aliases.length) fail('Category aliases must be distinct.');
  const nullableLimit = (value: unknown, label: string) => value === null ? null : integer(value, label);
  let monthlyAmounts: SpendingLimit['monthlyAmounts'];
  if (input.monthlyAmounts !== undefined) {
    const amounts = Object.entries(record(input.monthlyAmounts, 'Monthly amounts'));
    if (amounts.length > 1200) fail('A category supports up to 1,200 monthly amounts.');
    monthlyAmounts = Object.fromEntries(amounts.map(([month, amount]) => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('A budget month must use YYYY-MM.');
      return [month, nullableLimit(amount, `${month} monthly amount`)];
    }));
  }
  return { id: str(input.id, 'Spending limit ID'), entityId, name: str(input.name, 'Category name', 100), color, aliases, dailyCents: nullableLimit(input.dailyCents, 'Daily limit'), weeklyCents: nullableLimit(input.weeklyCents, 'Weekly limit'), monthlyCents: nullableLimit(input.monthlyCents, 'Monthly limit'), ...(monthlyAmounts === undefined ? {} : { monthlyAmounts }) };
}
function validateSpendingLimits(raw: unknown, entityIds: Set<string>): SpendingLimit[] {
  const limits = list(raw, 'Spending limits', 10000).map(item => validateSpendingLimit(item, entityIds));
  unique(limits, 'spending limit');
  const matchOwners = new Map<string, string>();
  for (const limit of limits) {
    for (const alias of [limit.name, ...limit.aliases]) {
      const key = JSON.stringify([limit.entityId, normalizedCategory(alias)]);
      const previous = matchOwners.get(key);
      if (previous && previous !== limit.id) fail(`The category or alias "${alias}" already belongs to another spending limit for this owner.`);
      matchOwners.set(key, limit.id);
    }
  }
  return limits;
}
function validateAsset(raw: unknown, entityIds: Set<string>): TrackedAsset {
  const input = record(raw, 'Tracked asset');
  const entityId = str(input.entityId, 'Asset owner ID');
  if (!entityIds.has(entityId)) fail('An asset references a missing owner.');
  const purchaseDate = input.purchaseDate === null ? null : date(input.purchaseDate, 'Purchase date');
  if (purchaseDate !== null && purchaseDate > today()) fail('Purchase dates cannot be in the future.');
  const status = choice(input.status, ['owned', 'listed', 'sold'] as const, 'Asset status');
  const soldDate = input.soldDate === null ? null : date(input.soldDate, 'Sale date');
  const saleCents = input.saleCents === null ? null : integer(input.saleCents, 'Sale proceeds');
  if (status === 'sold') {
    if (soldDate === null || saleCents === null) fail('Sold assets need a sale date and sale proceeds.');
    if (purchaseDate !== null && soldDate < purchaseDate || soldDate > today()) fail('The sale date must be on or after purchase and cannot be in the future.');
  } else if (soldDate !== null || saleCents !== null) fail('Unsold assets must leave sale date and proceeds empty.');
  let salePosting: TrackedAsset['salePosting'];
  if (input.salePosting !== undefined) {
    const posting = record(input.salePosting, 'Sale cash posting');
    if (status !== 'sold') fail('Only a sold asset can have a sale cash posting.');
    salePosting = { cashAccountId: str(posting.cashAccountId, 'Sale cash account ID'), transactionId: str(posting.transactionId, 'Sale transaction ID') };
  }
  return { id: str(input.id, 'Asset ID'), entityId, name: str(input.name, 'Asset name', 200), category: str(input.category, 'Asset category', 100), purchaseDate, costCents: input.costCents === null ? null : integer(input.costCents, 'Purchase cost'), estimatedValueCents: input.estimatedValueCents === null ? null : integer(input.estimatedValueCents, 'Estimated resale value'), status, soldDate, saleCents, feesCents: integer(input.feesCents, 'Selling fees'), notes: str(input.notes, 'Asset notes', 2000, true), ...(salePosting ? { salePosting } : {}) };
}

function validateWishItem(raw: unknown, entityIds: Set<string>): WishItem {
  const input = record(raw, 'Wish basket item');
  const entityId = str(input.entityId, 'Wish basket owner ID');
  if (!entityIds.has(entityId)) fail('A wish basket item references a missing owner.');
  const priority = input.priority === undefined ? undefined : choice(input.priority, ['essential', 'optional'] as const, 'Item priority');
  return { id: str(input.id, 'Wish basket item ID', 128), entityId, name: str(input.name, 'Item name', 200), costCents: input.costCents === null ? null : integer(input.costCents, 'Item cost'), comment: str(input.comment, 'Item comment', 2000, true), ...(priority === undefined ? {} : { priority }) };
}

function validateOwedPayment(raw: unknown): OwedPayment {
  const input = record(raw, 'Repayment');
  const paymentDate = date(input.date, 'Repayment date');
  if (paymentDate > today()) fail('Repayment dates cannot be in the future.');
  const cashPosting = input.cashAccountId !== undefined || input.transactionId !== undefined ? { cashAccountId: str(input.cashAccountId, 'Repayment cash account ID'), transactionId: str(input.transactionId, 'Repayment transaction ID') } : {};
  return { id: str(input.id, 'Repayment ID', 128), amountCents: integer(input.amountCents, 'Repayment amount', 1), date: paymentDate, comment: str(input.comment, 'Repayment comment', 2000, true), ...cashPosting };
}

function validateMoneyOwed(raw: unknown, entityIds: Set<string>): MoneyOwed {
  const input = record(raw, 'Money owed');
  const entityId = str(input.entityId, 'Money owed owner ID');
  if (!entityIds.has(entityId)) fail('A money owed tab references a missing owner.');
  const amountCents = integer(input.amountCents, 'Original amount owed', 1);
  const payments = list(input.payments, 'Repayments', 10000).map(validateOwedPayment);
  unique(payments, 'repayment');
  let remaining = amountCents;
  for (const payment of payments) {
    remaining -= payment.amountCents;
    if (remaining < 0) fail('The original amount owed cannot be less than recorded repayments.');
  }
  return { id: str(input.id, 'Money owed ID', 128), entityId, name: str(input.name, 'Person or tab name', 200), amountCents, comment: str(input.comment, 'Money owed comment', 2000, true), payments };
}

function expenseFundId(raw: unknown): string {
  const id = str(raw, 'Cost target ID', 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) fail('Cost target ID may contain letters, numbers, underscores and hyphens.');
  return id;
}
function validateExpenseFund(raw: unknown, entityIds: Set<string>): ExpenseFund {
  const input = record(raw, 'Cost target');
  const entityId = str(input.entityId, 'Cost target owner ID');
  if (!entityIds.has(entityId)) fail('A cost target references a missing owner.');
  return { id: expenseFundId(input.id), entityId, name: str(input.name, 'Cost target name', 100), targetCents: integer(input.targetCents, 'Target amount', 1), savedCents: integer(input.savedCents, 'Saved amount'), targetDate: date(input.targetDate, 'Target date') };
}

function validateExpensePlanItem(raw: unknown, entityIds: Set<string>, spendingLimits: SpendingLimit[]): ExpensePlanItem {
  const input = record(raw, 'Plan item');
  const entityId = str(input.entityId, 'Plan item owner ID');
  if (!entityIds.has(entityId)) fail('A plan item references a missing owner.');
  const categoryId = str(input.categoryId, 'Plan item category ID');
  const categories = expensePlanLimits({ spendingLimits } as AppState, entityId);
  if (!categories.some(category => category.id === categoryId)) fail('Choose a category belonging to this owner.');
  return { id: str(input.id, 'Plan item ID', 128), entityId, categoryId, name: str(input.name, 'Plan item name', 150), amountCents: input.amountCents === null ? null : integer(input.amountCents, 'Plan item amount'), date: input.date === '' ? '' : date(input.date, 'Plan item date'), notes: str(input.notes, 'Plan item notes', 4000, true), ...(input.obligationId === undefined ? {} : { obligationId: str(input.obligationId, 'Linked bill ID') }), ...(input.transactionId === undefined ? {} : { transactionId: str(input.transactionId, 'Linked transaction ID') }), ...(input.separatePaymentConfirmed === undefined ? {} : { separatePaymentConfirmed: choice(String(input.separatePaymentConfirmed), ['true','false'], 'Separate payment confirmation') === 'true' }) };
}

function validateAssetPurchase(raw: unknown, entityIds: Set<string>): AssetPurchase {
  const input = record(raw, 'Asset purchase');
  const entityId = str(input.entityId, 'Purchase owner ID');
  if (!entityIds.has(entityId)) fail('An asset purchase references a missing owner.');
  const targetCents = integer(input.targetCents, 'Purchase target', 1);
  const paidCents = input.paidCents === null ? null : integer(input.paidCents, 'Confirmed paid amount', 0, targetCents);
  const paidAsOf = input.paidAsOf === '' ? '' : date(input.paidAsOf, 'Confirmation date');
  if (paidCents === null && paidAsOf !== '' || paidCents !== null && !paidAsOf) fail('Confirmed paid amounts need a confirmation date. Leave both empty if unknown.');
  if (paidAsOf > today()) fail('Confirm payments only after they happen.');
  return { id: expenseFundId(input.id), entityId, name: str(input.name, 'Purchase name', 100), payee: str(input.payee, 'Purchase payee', 100), targetCents, monthlyCents: integer(input.monthlyCents, 'Monthly contribution', 1), paidCents, paidAsOf, notes: str(input.notes, 'Purchase notes', 2000, true) };
}


function confirmPayday(data: StoredData, tx: Transaction, rawDate: unknown): void {
  const paydayDate = date(rawDate, 'Payday date');
  if (paydayDate > today()) fail('Confirm a payday only after its date.');
  if (tx.kind !== 'income' || tx.amountCents <= 0 || getAccount(data,tx.accountId).type !== 'cash' || data.entities.find(item => item.id === getAccount(data,tx.accountId).entityId)?.kind !== 'personal' || tx.reversalOf || data.transactions.some(item => item.reversalOf === tx.id)) fail('Choose recorded cash income for this payday.');
  if (tx.paydayDate && tx.paydayDate !== paydayDate) fail('This income is already linked to another payday.');
  if (data.transactions.some(item => item.id !== tx.id && item.paydayDate === paydayDate && !data.transactions.some(other => other.reversalOf === item.id))) fail('This payday already has a confirmed deposit.');
  tx.paydayDate = paydayDate;
}
function validateCorrections(transactions: Transaction[], accounts: Map<string, LedgerAccount>): void {
  const map = new Map(transactions.map(tx => [tx.id,tx]));
  const reversed = new Set<string>();
  const replacements = new Set<string>();
  const refunds = new Map<string,number>();
  for (const tx of transactions) {
    if (tx.reversalOf) {
      const original = map.get(tx.reversalOf);
      if (!original || !['Manual entry','Corrected manual entry'].includes(original.source) || original.statementId || original.importSources?.length || original.plannedPayment || original.reversalOf || original.refundOf || reversed.has(original.id) || tx.source !== 'Manual reversal' || !tx.correctionReason || tx.date !== original.date || tx.kind !== original.kind || tx.accountId !== original.accountId || tx.toAccountId !== original.toAccountId || tx.amountCents !== -original.amountCents || tx.category !== original.category || tx.expenseCategory !== original.expenseCategory || tx.statementId || tx.importSources || tx.refundOf || tx.replacesId || tx.plannedPayment || tx.paydayDate) fail('A reversal must cancel one eligible manual entry exactly.');
      reversed.add(original.id);
    }
    if (tx.refundOf) {
      const original = map.get(tx.refundOf);
      if (!original || original.kind !== 'expense' || original.amountCents <= 0 || original.reversalOf || tx.kind !== 'expense' || tx.amountCents >= 0 || tx.source !== 'Manual refund' || !tx.correctionReason || tx.date < original.date || accounts.get(tx.accountId)?.entityId !== accounts.get(original.accountId)?.entityId || tx.statementId || tx.replacesId) fail('A manual refund must link to an earlier expense belonging to the same owner.');
      refunds.set(original.id,(refunds.get(original.id) ?? 0) - tx.amountCents);
      if (refunds.get(original.id)! > original.amountCents) fail('Refunds cannot exceed the original expense.');
    }
    if (tx.replacesId) {
      if (!map.has(tx.replacesId) || replacements.has(tx.replacesId) || tx.source !== 'Corrected manual entry' || !tx.correctionReason || tx.amountCents <= 0 || tx.statementId) fail('A replacement must link to one corrected manual entry.');
      replacements.add(tx.replacesId);
    }
    if (tx.source === 'Manual reversal' && !tx.reversalOf || tx.source === 'Manual refund' && !tx.refundOf || tx.source === 'Corrected manual entry' && !tx.replacesId) fail('A correction is missing its linked record.');
  }
  for (const id of replacements) if (!reversed.has(id)) fail('A replacement needs a retained reversal of its original entry.');
  for (const id of refunds.keys()) if (reversed.has(id)) fail('An expense with refunds cannot also be reversed.');
  const paydays = new Set<string>();
  for (const tx of transactions) if (tx.paydayDate && !reversed.has(tx.id)) {
    if (tx.kind !== 'income' || tx.amountCents <= 0 || accounts.get(tx.accountId)?.type !== 'cash' || tx.paydayDate > today() || paydays.has(tx.paydayDate)) fail('A payday needs one confirmed cash income entry.');
    paydays.add(tx.paydayDate);
  }
}

function applyCommand(data: StoredData, input: Command): string {
  const command = record(input, 'Command');
  const payrollResult = applyPayrollCommand(data, command);
  if (payrollResult !== null) return payrollResult;
  const ruleResult = applyCategoryRuleCommand(data, command);
  if (ruleResult !== null) return ruleResult;
  const reconciliationResult = applyReconciliationCommand(data, command);
  if (reconciliationResult !== null) return reconciliationResult;
  switch (command.type) {
    case 'convert_wish_to_asset': {
      const index = data.wishItems?.findIndex(item => item.id === command.id) ?? -1;
      const wish = index >= 0 ? data.wishItems![index] : undefined;
      if (!wish || hash(wish) !== hash(command.expected)) fail('This wish changed. Reopen it before adding an owned item.');
      const asset = validateAsset(command.asset, new Set(data.entities.map(entity => entity.id)));
      if (asset.entityId !== wish.entityId || asset.status !== 'owned' || asset.salePosting) fail('Add an owned item belonging to the wish owner.');
      if ((data.assets ?? []).some(item => item.id === asset.id)) fail('This asset already exists.');
      (data.assets ??= []).push(asset);
      data.wishItems!.splice(index, 1);
      return `Added ${asset.name} to owned items and removed its wish. Account balances have not changed.`;
    }
    case 'save_wish_item': {
      const entityIds = new Set(data.entities.map(entity => entity.id));
      const item = validateWishItem(command.item, entityIds);
      const items = data.wishItems ?? [];
      const index = items.findIndex(existing => existing.id === item.id);
      if (index >= 0 && items[index].entityId !== item.entityId) fail('A wish basket item cannot move to another owner.');
      if (command.expected === null) {
        if (index >= 0) fail('This wish basket item already exists. Reopen it before saving.');
        items.push(item);
      } else {
        const expected = validateWishItem(command.expected, entityIds);
        if (index < 0 || expected.id !== item.id || hash(expected) !== hash(items[index])) fail('This wish basket item changed or was removed. Reopen it before saving.');
        items[index] = item;
      }
      data.wishItems = items;
      return `Saved ${item.name} to the wish basket.`;
    }
    case 'delete_wish_item': {
      const id = str(command.id, 'Wish basket item ID', 128);
      const items = data.wishItems ?? [];
      const index = items.findIndex(item => item.id === id);
      const expected = validateWishItem(command.expected, new Set(data.entities.map(entity => entity.id)));
      if (index < 0 || expected.id !== id || hash(expected) !== hash(items[index])) fail('This wish basket item changed or was removed. Reopen it before removing.');
      const [removed] = items.splice(index, 1);
      data.wishItems = items;
      return `Removed ${removed.name} from the wish basket.`;
    }
    case 'save_money_owed': {
      const entityIds = new Set(data.entities.map(entity => entity.id));
      const tab = validateMoneyOwed(command.tab, entityIds);
      const tabs = data.moneyOwed ?? [];
      const index = tabs.findIndex(existing => existing.id === tab.id);
      if (index >= 0 && tabs[index].entityId !== tab.entityId) fail('A money owed tab cannot move to another owner.');
      if (command.expected === null) {
        if (index >= 0) fail('This money owed tab already exists. Reopen it before saving.');
        if (tab.payments.length) fail('Record repayments separately after creating the tab.');
        tabs.push(tab);
      } else {
        const expected = validateMoneyOwed(command.expected, entityIds);
        if (index < 0 || expected.id !== tab.id || hash(expected) !== hash(tabs[index])) fail('This money owed tab changed or was removed. Reopen it before saving.');
        if (hash(tab.payments) !== hash(tabs[index].payments)) fail('Record or remove repayments separately. Editing a tab cannot change repayment history.');
        tabs[index] = tab;
      }
      data.moneyOwed = tabs;
      return `Saved the money owed by ${tab.name}.`;
    }
    case 'delete_money_owed': {
      const id = str(command.id, 'Money owed ID', 128);
      const tabs = data.moneyOwed ?? [];
      const index = tabs.findIndex(tab => tab.id === id);
      const expected = validateMoneyOwed(command.expected, new Set(data.entities.map(entity => entity.id)));
      if (index < 0 || expected.id !== id || hash(expected) !== hash(tabs[index])) fail('This money owed tab changed or was removed. Reopen it before removing.');
      if (tabs[index].payments.some(payment => payment.transactionId)) fail('Correct the recorded cash repayments before deleting this tab. Its payment history is linked to cash balances.');
      const [removed] = tabs.splice(index, 1);
      data.moneyOwed = tabs;
      return `Removed the money owed tab for ${removed.name}.`;
    }
    case 'record_owed_payment':
    case 'remove_owed_payment': {
      const id = str(command.id, 'Money owed ID', 128);
      const tab = (data.moneyOwed ?? []).find(item => item.id === id);
      const expected = validateMoneyOwed(command.expected, new Set(data.entities.map(entity => entity.id)));
      if (!tab || expected.id !== id || hash(expected) !== hash(tab)) fail('This money owed tab changed or was removed. Reopen it before changing repayments.');
      if (command.type === 'record_owed_payment') {
        if (data.accounts.some(account => account.id === tab.id && account.entityId === tab.entityId && account.type === 'receivable')) fail('This tab also has a receivable account with the same ID. Resolve the duplicate records before recording a repayment so the same value is not counted as cash and money still owed.');
        const payment = validateOwedPayment(command.payment);
        if (tab.payments.some(item => item.id === payment.id)) fail('This repayment already exists.');
        if (payment.amountCents > owedRemaining(tab)) fail('A repayment cannot exceed the remaining tab.');
        if (payment.cashAccountId || payment.transactionId) fail('Repayment cash links are created when the receipt is recorded.');
        const cash = cashAfterReconciliation(data, command.cashAccountId, tab.entityId, payment.date, command.afterBalanceConfirmation);
        payment.cashAccountId = cash.id;
        payment.transactionId = recordCashPosting(data, cash, payment.amountCents, payment.date, `Repayment from ${tab.name}${payment.comment ? `: ${payment.comment}` : ''}`.slice(0, 500), 'owed_payment', tab.id, payment.id);
        tab.payments.push(payment);
        return `Recorded a repayment from ${tab.name} in ${cash.name}.`;
      }
      const paymentId = str(command.paymentId, 'Repayment ID', 128);
      const index = tab.payments.findIndex(payment => payment.id === paymentId);
      if (index < 0) fail('This repayment was already removed. Reopen the tab before changing repayments.');
      const payment = tab.payments[index];
      if (payment.transactionId) reverseCashPosting(data, payment.transactionId, `Correction to repayment from ${tab.name}`);
      tab.payments.splice(index, 1);
      return `Removed a repayment from ${tab.name}.`;
    }
    case 'save_expense_plan_item': {
      const entityIds = new Set(data.entities.map(entity => entity.id));
      const item = validateExpensePlanItem(command.item, entityIds, data.spendingLimits ?? []);
      const items = data.expensePlanItems ?? [];
      const index = items.findIndex(existing => existing.id === item.id);
      if (index >= 0 && items[index].entityId !== item.entityId) fail('A plan item cannot move to another owner.');
      if (command.expected === null) {
        if (index >= 0) fail('This plan item already exists. Reopen it before saving.');
        items.push(item);
      } else {
        const expected = validateExpensePlanItem(command.expected, entityIds, data.spendingLimits ?? []);
        if (index < 0 || expected.id !== item.id || hash(expected) !== hash(items[index])) fail('This plan item changed or was removed. Reopen it before saving.');
        items[index] = item;
      }
      data.expensePlanItems = items;
      return `Saved ${item.name} to the monthly plan. No spending was recorded.`;
    }
    case 'delete_expense_plan_item': {
      const id = str(command.id, 'Plan item ID', 128);
      const items = data.expensePlanItems ?? [];
      const index = items.findIndex(item => item.id === id);
      const expected = validateExpensePlanItem(command.expected, new Set(data.entities.map(entity => entity.id)), data.spendingLimits ?? []);
      if (index < 0 || expected.id !== id || hash(expected) !== hash(items[index])) fail('This plan item changed or was removed. Reopen it before removing.');
      const [removed] = items.splice(index, 1);
      data.expensePlanItems = items;
      return `Removed ${removed.name} from the monthly plan.`;
    }
    case 'save_asset_purchase': {
      const entityIds = new Set(data.entities.map(entity => entity.id));
      const purchase = validateAssetPurchase(command.purchase, entityIds);
      const purchases = data.assetPurchases ?? [];
      const index = purchases.findIndex(existing => existing.id === purchase.id);
      if (index >= 0 && purchases[index].entityId !== purchase.entityId) fail('An asset purchase cannot move to another owner.');
      if (command.expected === null) {
        if (index >= 0) fail('This asset purchase already exists. Reopen it before saving.');
        purchases.push(purchase);
      } else {
        const expected = validateAssetPurchase(command.expected, entityIds);
        if (index < 0 || expected.id !== purchase.id || hash(expected) !== hash(purchases[index])) fail('This asset purchase changed. Reopen it before saving.');
        purchases[index] = purchase;
      }
      data.assetPurchases = purchases;
      return `Saved ${purchase.name} purchase progress. Cash balances have not changed.`;
    }
    case 'record_asset_purchase_payment': {
      const purchases = data.assetPurchases ?? [];
      const id = expenseFundId(command.id);
      const purchase = purchases.find(item => item.id === id) ?? fail('Choose an existing asset purchase.');
      const expected = validateAssetPurchase(command.expected, new Set(data.entities.map(entity => entity.id)));
      if (expected.id !== id || hash(expected) !== hash(purchase)) fail('This asset purchase changed. Reopen it before recording a payment.');
      if (purchase.paidCents === null) fail('Confirm the amount already paid before recording another payment.');
      const account = getAccount(data, command.accountId);
      if (account.entityId !== purchase.entityId || account.type !== 'cash') fail('Choose a cash account belonging to this purchase owner.');
      const amount = integer(command.amountCents, 'Payment amount', 1, purchase.targetCents - purchase.paidCents);
      const effectiveDate = date(command.date, 'Payment date');
      if (effectiveDate > today() || effectiveDate < purchase.paidAsOf) fail('Payment date must be on or after the last confirmed total and cannot be in the future.');
      checkTransactionDate(account, effectiveDate);
      const notes = str(command.notes, 'Payment notes', 250, true);
      const contributionKind = choice(command.contributionKind ?? 'payment', ['payment', 'repair'] as const, 'Contribution kind');
      funds(data, account, amount);
      const destination = purchaseAccountId(purchase.id);
      if (!data.accounts.some(item => item.id === destination)) data.accounts.push({ id: destination, entityId: purchase.entityId, name: purchase.name, type: 'asset_purchase', currency: 'CAD', reconciledAt: null });
      post(data, { date: effectiveDate, description: `${purchase.name}${contributionKind === 'repair' ? ' repair contribution' : ` payment to ${purchase.payee}`}${notes ? `: ${notes}` : ''}`, kind: 'transfer', amountCents: amount, accountId: account.id, toAccountId: destination, category: 'Asset purchase', source: contributionKind === 'repair' ? 'Car repair contribution' : 'Asset contribution' }, [[account.id, -amount], [destination, amount]]);
      purchase.paidCents += amount;
      purchase.paidAsOf = effectiveDate;
      return `Recorded a contribution toward ${purchase.name}. Cash moved to asset purchase value.`;
    }
    case 'save_expense_fund': {
      const entityIds = new Set(data.entities.map(entity => entity.id));
      const fund = validateExpenseFund(command.fund, entityIds);
      const funds = data.expenseFunds ?? [];
      const index = funds.findIndex(item => item.id === fund.id);
      if (index >= 0 && funds[index].entityId !== fund.entityId) fail('A cost target cannot move to another owner.');
      if (command.expected === null) {
        if (index >= 0) fail('This cost target already exists. Reopen it before saving.');
        funds.push(fund);
      } else {
        const expected = validateExpenseFund(command.expected, entityIds);
        if (index < 0 || expected.id !== fund.id || hash(expected) !== hash(funds[index])) fail('This cost target changed or was removed. Reopen it before saving.');
        funds[index] = fund;
      }
      data.expenseFunds = funds;
      return `Saved ${fund.name} cost target. Account balances and reserves have not changed.`;
    }
    case 'delete_expense_fund': {
      const id = expenseFundId(command.id);
      const funds = data.expenseFunds ?? [];
      const index = funds.findIndex(item => item.id === id);
      const expected = validateExpenseFund(command.expected, new Set(data.entities.map(entity => entity.id)));
      if (index < 0 || expected.id !== id || hash(expected) !== hash(funds[index])) fail('This cost target changed or was removed. Reopen it before removing.');
      const [removed] = funds.splice(index, 1);
      data.expenseFunds = funds;
      return `Removed ${removed.name} cost target. Account balances and reserves have not changed.`;
    }
    case 'save_spending_limit': {
      const entityIds = new Set(data.entities.map(entity => entity.id));
      let limit = validateSpendingLimit(command.limit, entityIds);
      const existing = data.spendingLimits ?? [];
      const index = existing.findIndex(item => item.id === limit.id);
      const previous = existing[index];
      if (command.budgetMonth !== undefined) {
        if (command.expectedRevision === undefined) fail('Saving a monthly amount needs the current workspace revision.');
        const month = str(command.budgetMonth, 'Budget month', 7);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('A budget month must use YYYY-MM.');
        if (previous && previous.entityId !== limit.entityId) fail('A saved category cannot change owners.');
        limit = { ...limit, monthlyCents: previous?.monthlyCents ?? null, monthlyAmounts: { ...previous?.monthlyAmounts, [month]: limit.monthlyCents } };
      } else if (previous?.monthlyAmounts || limit.monthlyAmounts) {
        fail('Choose a budget month to change this category.');
      }
      const next = [...existing];
      if (index < 0) next.push(limit); else next[index] = limit;
      data.spendingLimits = validateSpendingLimits(next, entityIds);
      return command.budgetMonth ? `Saved ${limit.name} budget for ${command.budgetMonth}.` : `Saved ${limit.name} spending limits.`;
    }
    case 'save_asset': {
      const asset = validateAsset(command.asset, new Set(data.entities.map(entity => entity.id)));
      const assets = data.assets ?? [];
      const index = assets.findIndex(item => item.id === asset.id);
      const current = index < 0 ? undefined : assets[index];
      if (current && asset.entityId !== current.entityId) fail('An asset cannot move to another owner.');
      if (current?.salePosting) {
        if (asset.status !== current.status || asset.soldDate !== current.soldDate || asset.saleCents !== current.saleCents || asset.feesCents !== current.feesCents || hash(asset.salePosting ?? null) !== hash(current.salePosting)) fail('Undo the recorded sale before changing its amount, date, fees, status, or cash account.');
      } else if (asset.salePosting || asset.status === 'sold' && current?.status !== 'sold') fail('Record the sale with its receiving cash account so the proceeds are saved once.');
      if (index < 0) assets.push(asset); else assets[index] = asset;
      data.assets = assets;
      return `Saved ${asset.name} to the asset register as ${asset.status}.`;
    }
    case 'record_asset_sale': {
      const entityIds = new Set(data.entities.map(entity => entity.id));
      const asset = validateAsset(command.asset, entityIds);
      const assets = data.assets ?? [];
      const index = assets.findIndex(item => item.id === asset.id);
      if (command.expected === null) {
        if (index >= 0) fail('This asset already exists. Reopen it before recording the sale.');
      } else {
        const expected = validateAsset(command.expected, entityIds);
        if (index < 0 || expected.id !== asset.id || hash(expected) !== hash(assets[index])) fail('This asset changed or was removed. Reopen it before recording the sale.');
        if (assets[index].entityId !== asset.entityId) fail('An asset cannot move to another owner.');
        if (assets[index].status === 'sold') fail('This asset is already sold. Undo its recorded sale before recording another one.');
      }
      if (asset.status !== 'sold' || asset.soldDate === null || asset.saleCents === null || asset.salePosting) fail('Enter the sale date and gross proceeds for this sale. Cash links are created when it is recorded.');
      if (data.assetPurchases?.some(purchase => purchase.id === asset.id && purchase.entityId === asset.entityId)) fail('This asset also has a purchase record with the same ID. Resolve the duplicate records before recording a sale so the same value is not counted as cash and purchase equity.');
      if (asset.feesCents > asset.saleCents) fail('Selling fees cannot exceed gross sale proceeds.');
      const cash = cashAfterReconciliation(data, command.cashAccountId, asset.entityId, asset.soldDate, command.afterBalanceConfirmation);
      const transactionId = recordCashPosting(data, cash, asset.saleCents - asset.feesCents, asset.soldDate, `Sale of ${asset.name} after selling fees`, 'asset_sale', asset.id);
      asset.salePosting = { cashAccountId: cash.id, transactionId };
      if (index < 0) assets.push(asset); else assets[index] = asset;
      data.assets = assets;
      return `Recorded the sale of ${asset.name} in ${cash.name} after fees.`;
    }
    case 'undo_asset_sale': {
      const id = str(command.id, 'Asset ID');
      const asset = data.assets?.find(item => item.id === id);
      const expected = validateAsset(command.expected, new Set(data.entities.map(entity => entity.id)));
      if (!asset || expected.id !== id || hash(expected) !== hash(asset)) fail('This asset changed or was removed. Reopen it before correcting the sale.');
      if (!asset.salePosting) fail('This asset has no recorded cash sale to undo.');
      reverseCashPosting(data, asset.salePosting.transactionId, `Correction to sale of ${asset.name}`);
      asset.status = 'owned';
      asset.soldDate = null;
      asset.saleCents = null;
      asset.feesCents = 0;
      delete asset.salePosting;
      return `Undid the sale of ${asset.name} and reversed its cash proceeds.`;
    }
    case 'set_debt_terms': {
      const account = getAccount(data, command.accountId);
      if (!['debt', 'payable'].includes(account.type)) fail('Debt terms belong to a debt or payable account.');
      account.debtTerms = validateDebtTerms(command.terms);
      return `Updated ${account.name} debt terms. Balances have not changed.`;
    }
    case 'save_roadmap':
      data.roadmap = validateRoadmap(command.settings, data.accounts);
      return 'Saved the income transition roadmap and loan scenario assumptions.';
    case 'update_pay_schedule': {
      const base: RoadmapSettings = data.roadmap ?? { incomeTransitionPlanned: false, currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: today(), transitionMonths: 1, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null };
      if (command.resolveIncomeTransition !== undefined && typeof command.resolveIncomeTransition !== 'boolean') fail('Income transition confirmation must be true or false.');
      if (command.resolveIncomeTransition === true && base.temporaryWorkSchedule && base.incomeTransitionPlanned !== false) fail('This temporary work schedule already has a return date. Enter the full-time pay amount here.');
      if (command.resolveIncomeTransition === true && (base.transitionDate > today() || date(command.paydayAnchor, 'Payday anchor') < base.transitionDate)) fail('Confirm a payday on or after the completed income change.');
      data.roadmap = validateRoadmap({ ...base, payAmountCents: command.payAmountCents, payEveryDays: command.payEveryDays, paydayAnchor: command.paydayAnchor, ...(command.resolveIncomeTransition === true ? { incomeTransitionPlanned: false } : {}) }, data.accounts);
      return 'Updated the pay amount and schedule. Recorded income has not changed.';
    }
    case 'update_living_costs': {
      const base: RoadmapSettings = data.roadmap ?? { incomeTransitionPlanned: false, currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: today(), transitionMonths: 1, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null };
      const monthlyEssentialsCents = command.monthlyEssentialsCents === null ? null : integer(command.monthlyEssentialsCents, 'Monthly living costs');
      data.roadmap = validateRoadmap({ ...base, monthlyEssentialsCents }, data.accounts);
      return monthlyEssentialsCents === null ? 'Monthly living costs need confirmation.' : 'Updated monthly living costs.';
    }
    case 'update_planning_reserve': {
      const base: RoadmapSettings = data.roadmap ?? { incomeTransitionPlanned: false, currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: today(), transitionMonths: 1, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null };
      const planningCashReserveCents = command.amountCents === null ? null : integer(command.amountCents, 'Protected cash reserve');
      data.roadmap = validateRoadmap({ ...base, planningCashReserveCents }, data.accounts);
      return planningCashReserveCents === null ? 'The cash reserve needs confirmation.' : 'Updated the cash reserve for planning.';
    }
    case 'update_growth_target': {
      const base: RoadmapSettings = data.roadmap ?? { incomeTransitionPlanned: false, currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: today(), transitionMonths: 1, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null };
      const growthTarget = command.target === null ? null : choice(command.target, ['lifetime_compounding'] as const, 'Growth target');
      data.roadmap = validateRoadmap({ ...base, growthTarget }, data.accounts);
      return growthTarget === null ? 'Cleared the growth target.' : 'Set lifetime net worth growth as the planning target, with comfort purchases deferred.';
    }
    case 'add_entity': {
      const name = str(command.name, 'Owner name', 100);
      const ownershipBps = integer(command.ownershipBps, 'Ownership', 0, 10000);
      data.entities.push({ id: uid(), name, kind: 'business', ownershipBps });
      return `Added ${name} with ${ownershipBps / 100}% ownership.`;
    }
    case 'add_account': {
      const entity = getEntity(data, command.entityId);
      const name = str(command.name, 'Account name', 100);
      const accountType = choice(command.accountType, visibleTypes, 'Account type');
      const openingDate = date(command.openingDate, 'Opening date');
      if (openingDate > today()) fail('Opening dates cannot be in the future.');
      addAccount(data, entity.id, name, accountType, integer(command.openingBalanceCents, 'Opening balance', signedBalanceTypes.includes(accountType) ? -MAX_CENTS : 0), openingDate);
      return `Added ${name}.`;
    }
    case 'rename_account': {
      if (command.expectedRevision === undefined) fail('Renaming an account needs the current workspace revision.');
      const account = getAccount(data, command.accountId);
      const previousName = str(command.expectedName, 'Previous account name', 100);
      if (account.name !== previousName) fail('The account name changed. Reopen this account before renaming it.');
      account.name = str(command.name, 'Account name', 100);
      return `Renamed ${previousName} to ${account.name}.`;
    }
    case 'annotate_transaction': {
      if (command.expectedRevision === undefined) fail('Editing transaction names and notes needs the current workspace revision.');
      const tx = data.transactions.find(item => item.id === str(command.id, 'Transaction ID')) ?? fail('Transaction was not found.');
      const expectedDisplayName = transactionAnnotation(command.expectedDisplayName, 'Previous transaction name', 200);
      const expectedNote = transactionAnnotation(command.expectedNote, 'Previous transaction note', 1000, true);
      if ((tx.displayName ?? null) !== expectedDisplayName || (tx.note ?? null) !== expectedNote) fail('This transaction name or note changed. Reopen the transaction before editing it.');
      const displayName = transactionAnnotation(command.displayName, 'Transaction name', 200);
      const note = transactionAnnotation(command.note, 'Transaction note', 1000, true);
      if (displayName === expectedDisplayName && note === expectedNote) fail('No transaction name or note changes to save.');
      if (displayName === null) delete tx.displayName;
      else tx.displayName = displayName;
      if (note === null) delete tx.note;
      else tx.note = note;
      const nameChange = displayName !== expectedDisplayName ? ` Name changed from "${expectedDisplayName ?? 'Original description'}" to "${displayName ?? 'Original description'}".` : '';
      return `Updated transaction ${tx.id}.${nameChange}${note !== expectedNote ? note === null ? ' Removed its note.' : ' Saved its note.' : ''}`;
    }
    case 'set_net_worth_inclusion': {
      if (command.expectedRevision === undefined) fail('Changing net worth inclusion needs the current workspace revision.');
      str(command.requestId, 'Request ID');
      const account = getAccount(data, command.accountId);
      if (!visibleTypes.includes(account.type as AccountType)) fail('Choose a financial account.');
      if (typeof command.included !== 'boolean') fail('Choose whether this account is included in net worth.');
      account.excludeFromNetWorth = !command.included;
      return `${command.included ? 'Included' : 'Excluded'} ${account.name} ${command.included ? 'in' : 'from'} the Home net worth total. Its balance and payment plan are unchanged.`;
    }
    case 'set_account_closed': {
      const account = getAccount(data, command.accountId);
      if (typeof command.closed !== 'boolean') fail('Choose whether this account is closed.');
      if (command.closed) {
        if (balance(data, account) !== 0) fail('An account must have a zero recorded balance before closing.');
        if (data.obligations.some(item => item.accountId === account.id && item.status === 'planned')) fail('Move or cancel this account’s planned payments before closing it.');
        if (data.positions.some(item => item.accountId === account.id)) fail('Remove the investment position before closing this account.');
      }
      account.closedAt = command.closed ? today() : null;
      return `${command.closed ? 'Closed' : 'Reopened'} ${account.name}. Its history is preserved.`;
    }
    case 'update_reserve': {
      const reserve = data.reserves.find(item => item.id === command.id) ?? fail('Reserve was not found.');
      if (hash(command.expected) !== hash(reserve)) fail('This reserve changed. Reopen it before editing.');
      reserve.name = str(command.name, 'Reserve name', 100);
      reserve.amountCents = integer(command.amountCents, 'Reserve amount', 1);
      return `Updated the ${reserve.name} cash reserve.`;
    }
    case 'confirm_payday': {
      const tx = data.transactions.find(item => item.id === command.transactionId) ?? fail('Income entry was not found.');
      confirmPayday(data, tx, command.paydayDate);
      return 'Linked the recorded income to this payday.';
    }
    case 'correct_bank_matched_amount': return applyBankAmountCorrection(data, { ...input as Extract<Command, { type: 'correct_bank_matched_amount' }>, source: validateStatementSource(command.source, data.accounts) });
    case 'extend_bank_activity': return extendBankActivity(data, input as Extract<Command, { type: 'extend_bank_activity' }>, {
      validateSource: raw => validateStatementSource(raw, data.accounts), validateDecisions: validateStatementDecisions,
      importState: () => importState(data), post: (transaction, lines) => post(data, transaction, lines),
      internal: (entityId, kind) => internal(data, entityId, kind), alignHistory: account => alignStatementHistory(data, account),
      balance: account => balance(data, account), now, today,
    });
    case 'correct_transaction': {
      const original = data.transactions.find(item => item.id === command.id) ?? fail('Transaction was not found.');
      const reason = str(command.reason, 'Correction reason', 500);
      if (!['Manual entry','Corrected manual entry'].includes(original.source) || original.statementId || original.importSources?.length || original.plannedPayment || original.reversalOf || original.refundOf) fail('Only unlinked manual entries can be corrected here. Review imported or linked records at their source.');
      if (data.transactions.some(item => item.reversalOf === original.id || item.refundOf === original.id)) fail('This entry already has a reversal or refund. Review its linked records first.');
      for (const id of [original.accountId, original.toAccountId].filter((id): id is string => !!id)) {
        const account = getAccount(data, id);
        if (account.reconciledAt && original.date <= account.reconciledAt || account.clearedTransactionIds?.includes(original.id)) fail('This entry is included in a confirmed balance. Reopen the reconciliation before correcting it.');
        if (account.closedAt) fail('Reopen this account before correcting its entries.');
      }
      const lines: [string, number][] = data.entries.filter(entry => entry.transactionId === original.id).map(entry => [entry.accountId, -entry.debitCents]);
      const reversal = post(data, { date:original.date, description:`Reversal: ${original.description}`, kind:original.kind, amountCents:-original.amountCents, accountId:original.accountId, toAccountId:original.toAccountId, category:original.category, expenseCategory:original.expenseCategory, source:'Manual reversal', reversalOf:original.id, correctionReason:reason }, lines);
      // Preserve the original reporting category even when categorization rules have changed.
      reversal.category = original.category;
      if (command.replacement !== undefined) {
        const input = record(command.replacement, 'Replacement') as unknown as Extract<Command,{type:'add_transaction'}>;
        const category = str(input.category, 'Category', 100, true) || 'Uncategorized';
        const replacement = transaction(data, input, 'Corrected manual entry', category === original.category ? original.expenseCategory : undefined);
        replacement.replacesId = original.id;
        replacement.correctionReason = reason;
        if (original.displayName !== undefined) replacement.displayName = original.displayName;
        if (original.note !== undefined) replacement.note = original.note;
        if (original.paydayDate) confirmPayday(data, replacement, original.paydayDate);
      }
      return `Corrected ${original.description}. The original and reversal are retained.`;
    }
    case 'record_refund': {
      const original = data.transactions.find(item => item.id === command.id) ?? fail('Expense was not found.');
      if (original.kind !== 'expense' || original.amountCents <= 0 || original.reversalOf || data.transactions.some(item => item.reversalOf === original.id)) fail('Choose an expense that has not been reversed.');
      const account = getAccount(data, command.accountId);
      const owner = getAccount(data, original.accountId).entityId;
      if (account.entityId !== owner || !['cash','debt','payable'].includes(account.type) || account.closedAt) fail('Choose an open cash or debt account belonging to this expense owner.');
      const amount = integer(command.amountCents, 'Refund amount', 1);
      const already = data.transactions.filter(item => item.refundOf === original.id).reduce((sum,item) => sum - item.amountCents, 0);
      if (already + amount > original.amountCents) fail('The total refund cannot exceed the original expense.');
      const effectiveDate = date(command.date);
      if (effectiveDate < original.date || effectiveDate > today()) fail('The refund date must be between the expense date and today.');
      checkTransactionDate(account, effectiveDate);
      const reason = str(command.reason, 'Refund reason', 500);
      const refund = post(data, { date:effectiveDate, description:`Refund: ${original.description}`, kind:'expense', amountCents:-amount, accountId:account.id, toAccountId:null, category:original.category, expenseCategory:original.expenseCategory, source:'Manual refund', refundOf:original.id, correctionReason:reason }, [[account.id, amount],[internal(data,owner,'expense'),-amount]]);
      refund.category = original.category;
      return `Recorded a refund for ${original.description}.`;
    }
    case 'add_transaction': {
      const tx = transaction(data, input as Extract<Command, { type: 'add_transaction' }>);
      if (command.paydayDate !== undefined) confirmPayday(data, tx, command.paydayDate);
      return `Recorded ${str(command.description, 'Description', 500)}.`;
    }
    case 'add_obligation': {
      const entity = getEntity(data, command.entityId);
      const accountId = str(command.accountId, 'Payment account ID', 200, true);
      const obligation: Obligation = { id: uid(), entityId: entity.id, name: str(command.name, 'Payment name', 100), amountCents: integer(command.amountCents, 'Amount', 1), dueDate: date(command.dueDate, 'Due date'), direction: choice(command.direction, ['in', 'out'] as const, 'Direction'), recurrence: choice(command.recurrence, ['once', 'monthly', 'biweekly'] as const, 'Recurrence'), status: 'planned', accountId, category: str(command.category, 'Category', 100, true) || 'Uncategorized' };
      const subscription = subscriptionFlag(command.subscription, obligation.direction, obligation.recurrence);
      const additionalToPay = additionalIncomeFlag(command.additionalToPay, obligation.direction);
      validateObligationAccount(data.accounts.find(account => account.id === accountId), accountId, entity.id, obligation.direction);
      if (subscription !== undefined) obligation.subscription = subscription;
      if (additionalToPay !== undefined) obligation.additionalToPay = additionalToPay;
      if (command.assetPurchaseId) obligation.assetPurchaseId = str(command.assetPurchaseId, 'Linked purchase ID');
      if (obligation.recurrence === 'monthly') (obligation as PlannedObligation).recurrenceDay = Number(obligation.dueDate.slice(-2));
      data.obligations.push(obligation);
      return `Planned ${obligation.name}.`;
    }
    case 'update_obligation': {
      const obligation = data.obligations.find(item => item.id === str(command.id, 'Payment ID')) ?? fail('Payment was not found.');
      if (obligation.status === 'paid') fail('A completed payment cannot be edited.');
      if (date(command.expectedDueDate, 'Previous due date') !== obligation.dueDate) fail('The next payment date changed. Reopen this entry before saving.');
      if (choice(command.expectedStatus, ['planned', 'cancelled'] as const, 'Previous status') !== obligation.status) fail('The subscription status changed. Reopen this entry before saving.');
      const accountId = str(command.accountId, 'Payment account ID', 200, true);
      const dueDate = date(command.dueDate, 'Due date');
      const recurrence = choice(command.recurrence, ['once', 'monthly', 'biweekly'] as const, 'Recurrence');
      const subscription = subscriptionFlag(command.subscription === undefined ? obligation.subscription : command.subscription, obligation.direction, recurrence);
      const additionalToPay = additionalIncomeFlag(command.additionalToPay === undefined ? obligation.additionalToPay : command.additionalToPay, obligation.direction);
      validateObligationAccount(data.accounts.find(account => account.id === accountId), accountId, obligation.entityId, obligation.direction);
      const recurrenceChanged = recurrence !== obligation.recurrence || dueDate !== obligation.dueDate;
      const status = command.status === undefined ? obligation.status : choice(command.status, ['planned', 'cancelled'] as const, 'Payment status');
      if (status === 'planned') validateUnpaidObligationDate(data, obligation.id, dueDate);
      for (const tx of data.transactions) {
        if (tx.plannedPayment ? tx.plannedPayment.obligationId === obligation.id : tx.source === `Planned payment ${obligation.id}`) preservePlannedExpenseCategory(data, obligation, tx);
      }
      Object.assign(obligation, { name: str(command.name, 'Payment name', 100), amountCents: integer(command.amountCents, 'Amount', 1), dueDate, recurrence, status, accountId, category: str(command.category, 'Category', 100, true) || 'Uncategorized' });
      if (subscription !== undefined) obligation.subscription = subscription;
      if (additionalToPay !== undefined) obligation.additionalToPay = additionalToPay;
      if (command.assetPurchaseId !== undefined) { if (command.assetPurchaseId) obligation.assetPurchaseId = str(command.assetPurchaseId, 'Linked purchase ID'); else delete obligation.assetPurchaseId; }
      if (recurrence !== 'monthly') delete obligation.recurrenceDay;
      else if (recurrenceChanged || obligation.recurrenceDay === undefined) obligation.recurrenceDay = Number(dueDate.slice(-2));
      return `Updated ${obligation.name}.`;
    }
    case 'set_obligation_status': {
      const obligation = data.obligations.find(item => item.id === str(command.id, 'Payment ID')) ?? fail('Payment was not found.');
      if (obligation.status === 'paid') fail('A completed payment cannot be reactivated or cancelled.');
      const status = choice(command.status, ['planned', 'cancelled'] as const, 'Payment status');
      if (status === 'planned' && obligation.status === 'cancelled') {
        const dueDate = date(command.dueDate, 'Next due date');
        validateUnpaidObligationDate(data, obligation.id, dueDate);
        if (dueDate !== obligation.dueDate && obligation.recurrence === 'monthly') obligation.recurrenceDay = Number(dueDate.slice(-2));
        obligation.dueDate = dueDate;
      }
      obligation.status = status;
      return `${status === 'cancelled' ? 'Cancelled' : 'Activated'} ${obligation.name}.`;
    }
    case 'pay_obligation': {
      const obligation = data.obligations.find(item => item.id === str(command.id, 'Payment ID')) ?? fail('Payment was not found.');
      if (obligation.status !== 'planned') fail(obligation.status === 'cancelled' ? 'This payment is cancelled. Reactivate it before recording a payment.' : 'This payment has already been recorded.');
      if (date(command.expectedDueDate, 'Payment due date') !== obligation.dueDate) fail('The next payment date changed. Refresh this entry before recording a payment.');
      let payment: Transaction;
      const purchase = obligation.assetPurchaseId ? data.assetPurchases?.find(item => item.id === obligation.assetPurchaseId) : undefined;
      if (command.transactionId) {
        payment = data.transactions.find(item => item.id === command.transactionId) ?? fail('Recorded payment was not found.');
        if (command.amountCents !== undefined || command.date !== undefined || command.accountId !== undefined) fail('Matching an existing payment cannot change its recorded details.');
        if (payment.plannedPayment || payment.reversalOf || payment.amountCents <= 0 || data.transactions.some(item => item.reversalOf === payment.id)) fail('This transaction is already linked or reversed.');
        if (getAccount(data,payment.accountId).entityId !== obligation.entityId || payment.kind !== (purchase ? 'transfer' : obligation.direction === 'in' ? 'income' : 'expense') || purchase && payment.toAccountId !== purchaseAccountId(purchase.id)) fail('Choose a recorded payment of the same kind and owner.');
      } else {
        const accountId = command.accountId ?? obligation.accountId;
        if (!accountId) fail('Choose a payment account before recording this payment.');
        const account = getAccount(data, accountId);
        validateObligationAccount(account, account.id, obligation.entityId, obligation.direction);
        if (account.closedAt) fail('Reopen the payment account before recording a payment.');
        const amountCents = integer(command.amountCents ?? obligation.amountCents, 'Payment amount', 1);
        const effectiveDate = date(command.date ?? today());
        if (effectiveDate > today()) fail('Record a payment only after it happens.');
        if (purchase) {
          const before = data.transactions.length;
          applyCommand(data, {type:'record_asset_purchase_payment',id:purchase.id,expected:structuredClone(purchase),accountId:account.id,amountCents,date:effectiveDate,notes:obligation.name,requestId:'nested-purchase'});
          payment = data.transactions[before];
        } else payment = transaction(data, { kind: obligation.direction === 'in' ? 'income' : 'expense', accountId:account.id, amountCents, date:effectiveDate, description: obligation.name, category: obligation.category }, `Planned payment ${obligation.id}`, obligation.direction === 'out' ? plannedExpenseCategory(data, obligation) : undefined);
      }
      preservePlannedExpenseCategory(data, obligation, payment);
      payment.plannedPayment = { obligationId: obligation.id, dueDate: obligation.dueDate };
      const paidDueDate = obligation.dueDate;
      if (obligation.recurrence === 'once') obligation.status = 'paid';
      else {
        if (obligation.recurrence === 'monthly') obligation.recurrenceDay ??= Number(obligation.dueDate.slice(-2));
        const paid = recordedObligationDates(data.transactions).get(obligation.id);
        do { obligation.dueDate = advanceDate(obligation.dueDate, obligation.recurrence, obligation.recurrenceDay); }
        while (paid?.has(obligation.dueDate));
      }
      return `Confirmed ${obligation.name}, due ${paidDueDate}.`;
    }
    case 'add_reserve': {
      const entity = getEntity(data, command.entityId);
      const name = str(command.name, 'Reserve name', 100);
      data.reserves.push({ id: uid(), entityId: entity.id, name, amountCents: integer(command.amountCents, 'Reserve amount', 1) });
      return `Reserved cash for ${name}.`;
    }
    case 'remove_reserve': {
      const index = data.reserves.findIndex(item => item.id === str(command.id, 'Reserve ID'));
      if (index < 0) fail('Reserve was not found.');
      const [reserve] = data.reserves.splice(index, 1);
      return `Released the ${reserve.name} cash reserve.`;
    }
    case 'reconcile': {
      const account = getAccount(data, command.accountId);
      if (data.positions.some(position => position.accountId === account.id)) fail('Update SOL quantities and price to reconcile this investment.');
      const effectiveDate = date(command.date);
      if (effectiveDate > today()) fail('Reconciliation dates cannot be in the future.');
      checkReconciliationDate(data, account, effectiveDate);
      const note = str(command.note, 'Reconciliation note', 500, true) || 'Statement balance confirmed';
      const newBalance = integer(command.balanceCents, 'Statement balance', signedBalanceTypes.includes(account.type as AccountType) ? -MAX_CENTS : 0);
      adjust(data, account, newBalance, effectiveDate, `${account.name}: ${note}`, 'Statement reconciliation');
      account.reconciledAt = effectiveDate;
      account.evidence = { sourceFile: 'Manual balance update', asOf: effectiveDate, capturedOn: today(), status: 'bank', notes: note, balanceCents: newBalance };
      return `Reconciled ${account.name} to CAD ${(newBalance / 100).toFixed(2)}.`;
    }
    case 'stage_statement': {
      const source = validateStatementSource(command.statement, data.accounts);
      const legacy = data.statements?.find(item => item.accountId === source.accountId && item.sha256 === source.sha256);
      if (legacy) fail('This source file is already recorded as a statement. Review the existing statement instead.');
      const batches = data.importBatches ??= [];
      const existing = batches.find(batch => batch.id === source.id || batch.source.accountId === source.accountId && batch.source.sha256 === source.sha256);
      if (existing) {
        if (sourceDigest(existing.source) !== sourceDigest(source)) fail('This source file was already staged with different extracted rows. Preserve the original extraction and review it before replacing records.');
        return `Skipped ${source.sourceFile}; its source rows are already saved.`;
      }
      batches.push({ id: source.id, source, decisions: [], status: 'staged', createdAt: now(), committedAt: null });
      return `Saved ${source.rows.length} source rows for review. Balances and spending are unchanged.`;
    }
    case 'revise_statement': {
      if (command.expectedRevision === undefined) fail('An extraction correction needs the current workspace revision.');
      const batch = data.importBatches?.find(item => item.id === str(command.importId, 'Import ID')) ?? fail('The staged statement was not found.');
      if (batch.status !== 'staged') fail('Committed statement source rows cannot be revised.');
      const source = validateStatementSource(command.statement, data.accounts);
      if (source.id !== batch.id || source.sha256 !== batch.source.sha256) fail('An extraction correction must retain the same import ID and original document SHA-256.');
      const reason = str(command.reason, 'Extraction correction reason', 1000);
      batch.extractionHistory = [...(batch.extractionHistory ?? []), { source: batch.source, decisions: batch.decisions, revisedAt: now(), reason }];
      batch.source = source;
      batch.decisions = [];
      return `Corrected the extraction from ${source.sourceFile}. Preserved the previous source rows and decisions; all corrected rows need review.`;
    }
    case 'review_statement': {
      if (command.expectedRevision === undefined) fail('Statement review needs the current workspace revision.');
      const batch = data.importBatches?.find(item => item.id === str(command.importId, 'Import ID')) ?? fail('The staged statement was not found.');
      if (batch.status !== 'staged') fail('Committed statement decisions cannot be replaced. Use category corrections for recorded expenses.');
      batch.decisions = validateStatementDecisions(command.decisions, batch.source);
      return `Saved ${batch.decisions.length} row decisions. Original source rows and balances are unchanged.`;
    }
    case 'commit_statements': {
      if (command.expectedRevision === undefined) fail('Committing statements needs the current workspace revision.');
      return commitStatements(data, command.importIds);
    }
    case 'import_statement': {
      const statement = validateStatement(command.statement, data.accounts);
      const statements = data.statements ?? [];
      const existing = statements.find(item => item.id === statement.id || item.accountId === statement.accountId && item.sha256 === statement.sha256);
      if (existing) {
        if (statementDigest(statement) !== statementDigest(existing)) fail('This statement was already imported with different details. Review the saved statement before changing its history.');
        return `Skipped ${statement.sourceFile}; this statement is already imported.`;
      }
      const next = validateStatements([...statements, statement], data.accounts);
      validateImportPeriods(next, data.importBatches ?? []);
      const account = getAccount(data, statement.accountId);
      const postingDates = transactionBalanceDates(data);
      const ambiguous = data.transactions.some(tx => {
        const effectiveDate = postingDates.get(tx.id)?.[account.id] ?? tx.postingDate ?? tx.date;
        const reconciliation = tx.kind === 'adjustment' && ['Statement reconciliation', 'Historical statement reconciliation'].includes(tx.source);
        return (tx.accountId === account.id || tx.toAccountId === account.id) && effectiveDate >= statement.periodStart && effectiveDate <= statement.periodEnd && !tx.statementId && tx.kind !== 'opening' && !reconciliation;
      });
      if (ambiguous) fail('This account already has activity in the statement period without a statement link. Review those entries before importing so purchases, refunds, or payments are not recorded twice.');
      const previousBalance = balance(data, account);
      const preserveBalance = account.reconciledAt !== null && account.reconciledAt >= statement.periodEnd;
      if (!preserveBalance && previousBalance !== statement.openingBalanceCents) fail('The recorded balance does not match this statement opening balance. Confirm a current balance dated on or after the statement end before importing historical activity.');
      if (!preserveBalance && data.transactions.some(tx => (tx.accountId === account.id || tx.toAccountId === account.id) && (postingDates.get(tx.id)?.[account.id] ?? tx.postingDate ?? tx.date) > statement.periodEnd)) fail('This account has later transactions. Confirm its current balance before importing historical activity.');
      data.statements = next;
      for (const row of statement.rows) {
        const payment = row.kind === 'payment';
        post(data, { date: row.transactionDate, description: row.description, kind: payment ? 'adjustment' : 'expense', amountCents: payment ? -row.amountCents : row.amountCents, accountId: account.id, toAccountId: null, category: row.category, source: `${statement.sourceFile}, page ${row.sourcePage}`.slice(0, 300), statementId: statement.id, statementRowId: row.id, postingDate: row.postingDate }, [[account.id, -row.amountCents], [internal(data, account.entityId, payment ? 'equity' : 'expense'), row.amountCents]]);
      }
      if (preserveBalance) {
        adjust(data, account, previousBalance, account.reconciledAt!, `Historical statement ${statement.periodStart} to ${statement.periodEnd}; preserved the later confirmed balance`, 'Historical statement reconciliation');
      } else {
        account.reconciledAt = statement.periodEnd;
        account.evidence = { sourceFile: statement.sourceFile, asOf: statement.periodEnd, capturedOn: today(), status: 'bank', notes: 'Statement opening balance plus all listed activity matches the closing balance.', balanceCents: statement.closingBalanceCents };
      }
      return `Imported ${statement.rows.length} rows from ${statement.sourceFile}. ${preserveBalance ? 'Kept the later confirmed balance.' : 'The recorded balance now matches the statement closing balance.'}`;
    }
    case 'categorize_transactions': {
      if (command.expectedRevision === undefined) fail('A category batch needs the current workspace revision.');
      const changes = list(command.changes, 'Category changes', 5000);
      if (!changes.length) fail('Choose at least one category to save.');
      const ids = new Set<string>();
      for (const raw of changes) {
        const change = record(raw, 'Category change');
        const id = str(change.id, 'Transaction ID');
        if (ids.has(id)) fail('A transaction can appear only once in a category batch.');
        ids.add(id);
        applyCommand(data, { type: 'categorize_transaction', id, expectedCategory: str(change.expectedCategory, 'Previous category', 100, true), category: str(change.category, 'Category', 100), ...(change.expectedExpenseCategory === undefined ? {} : { expectedExpenseCategory: change.expectedExpenseCategory === null ? null : str(change.expectedExpenseCategory, 'Previous expense category', 100, true) }), ...(change.expenseCategory === undefined ? {} : { expenseCategory: change.expenseCategory === null ? null : str(change.expenseCategory, 'Expense category', 100, true) }), requestId: str(command.requestId, 'Request ID') });
      }
      return `Changed categories for ${changes.length} ${changes.length === 1 ? 'transaction' : 'transactions'}.`;
    }
    case 'categorize_transaction': {
      const id = str(command.id, 'Transaction ID');
      const tx = data.transactions.find(item => item.id === id) ?? fail('This transaction was not found.');
      if (tx.kind !== 'expense') fail('Choose an expense or refund to change its category.');
      if (tx.reversalOf) fail('Change the original entry category; its reversal follows the same category.');
      if (str(command.expectedCategory, 'Previous category', 100, true) !== tx.category) fail('The transaction category changed. Review the updated category before saving.');
      if (command.expectedExpenseCategory !== undefined) {
        const expected = command.expectedExpenseCategory === null ? null : str(command.expectedExpenseCategory, 'Previous expense category', 100, true);
        if (expected !== (tx.expenseCategory ?? null)) fail('The expense reporting category changed. Review the updated category before saving.');
      }
      const category = str(command.category, 'Category', 100);
      tx.category = category;
      if (command.expenseCategory === null) delete tx.expenseCategory;
      else if (command.expenseCategory !== undefined) tx.expenseCategory = str(command.expenseCategory, 'Expense category', 100, true);
      else if (tx.expenseCategory !== undefined || tx.plannedPayment || tx.source.startsWith('Planned payment ')) tx.expenseCategory = category;
      syncStatementCategory(data, tx);
      const reversal = data.transactions.find(item => item.reversalOf === tx.id);
      if (reversal) { reversal.category = tx.category; if (tx.expenseCategory === undefined) delete reversal.expenseCategory; else reversal.expenseCategory = tx.expenseCategory; }
      return `Changed ${tx.description} to ${category}.`;
    }
    case 'import_rows': {
      const account = getAccount(data, command.accountId);
      if (!['cash', 'debt', 'payable'].includes(account.type)) fail('Statement imports support cash, debt, and payable accounts.');
      const rows = list(command.rows, 'Statement rows', 5000);
      if (rows.length === 0) fail('The statement contains no rows.');
      const seen = new Map<string, number>();
      let imported = 0;
      const parsed = rows.map(raw => {
        const row = record(raw, 'Statement row');
        const amount = integer(row.amountCents, 'Statement amount', -MAX_CENTS);
        if (!amount) fail('Statement amounts cannot be zero.');
        return { date: date(row.date), description: str(row.description, 'Statement description', 500), amountCents: amount, category: row.category === undefined ? 'Uncategorized' : str(row.category, 'Category', 100, true) || 'Uncategorized' };
      });
      for (const row of parsed.sort((a, b) => a.date.localeCompare(b.date))) {
        const fingerprint = hash({ accountId: account.id, date: row.date, description: row.description, amount: row.amountCents });
        const occurrence = (seen.get(fingerprint) ?? 0) + 1;
        seen.set(fingerprint, occurrence);
        const importKey = `${fingerprint}:${occurrence}`;
        if (data.importKeys.includes(importKey)) continue;
        if (account.reconciledAt !== null && row.date <= account.reconciledAt) fail(`This row is dated on or before the confirmed balance on ${account.reconciledAt}. Import a complete statement with opening and closing balances so historical activity does not change the current balance twice.`);
        if (account.type !== 'cash' && row.amountCents > 0) fail('Positive debt statement rows need a matched cash-to-debt payment. Import purchases only, then record payments as transfers.');
        transaction(data, { kind: row.amountCents > 0 ? 'income' : 'expense', accountId: account.id, amountCents: Math.abs(row.amountCents), date: row.date, description: row.description, category: row.category }, 'CSV statement');
        data.importKeys.push(importKey);
        imported++;
      }
      return `Imported ${imported} statement rows; skipped ${rows.length - imported} duplicates.`;
    }
    case 'save_sol': {
      const account = getAccount(data, command.accountId);
      if (account.type !== 'investment') fail('SOL needs an investment account.');
      const liquid = lamports(command.liquidSol, 'Liquid SOL');
      const staked = lamports(command.stakedSol, 'Staked SOL');
      const priceDate = date(command.priceDate, 'Price date');
      if (priceDate > today()) fail('Price dates cannot be in the future.');
      checkReconciliationDate(data, account, priceDate);
      const existing = data.positions.find(item => item.accountId === account.id);
      const priceCents = integer(command.priceCents, 'SOL price', 0, 1_000_000_000);
      const costBasisCents = integer(command.costBasisCents, 'Cost basis');
      const priceSource = command.priceSource === undefined ? existing?.priceSource ?? 'Manual entry' : str(command.priceSource, 'Price source', 200);
      if (existing) {
        startSolHistory(data, existing);
        checkSolHistoryDate(existing, priceDate);
        if (existing.liquidSol !== solString(liquid) || existing.stakedSol !== solString(staked) || existing.costBasisCents !== costBasisCents) {
          Object.assign(existing, { liquidSol:solString(liquid), stakedSol:solString(staked), costBasisCents, priceCents, priceDate, priceSource });
          adjust(data, account, solValue(existing), priceDate, 'SOL balance correction; no trade inferred', 'Manual SOL correction');
          appendSolHistory(existing, priceDate, 'correction', { transactionIds:[data.transactions.at(-1)!.id] });
        } else updateSolQuote(data, existing, priceDate, priceCents, priceSource);
      } else {
        const position:SolPosition = { id:uid(), accountId:account.id, liquidSol:solString(liquid), stakedSol:solString(staked), rewardsSol:'0', costBasisCents, priceCents, priceDate, priceSource };
        data.positions.push(position);
        adjust(data, account, solValue(position), priceDate, 'Initial SOL balance snapshot; no trade inferred', 'Manual SOL valuation');
        startSolHistory(data, position);
      }
      account.reconciledAt = priceDate;
      return `Updated ${account.name}: ${solString(liquid)} liquid SOL and ${solString(staked)} staked SOL.`;
    }
    case 'add_sol_reward': {
      const position = data.positions.find(item => item.id === str(command.positionId, 'SOL position ID')) ?? fail('SOL position was not found.');
      return recordSolActivity(data, { type:'record_sol_activity', positionId:position.id, kind:'reward', quantitySol:command.sol, feeCents:0, priceCents:position.priceCents, priceSource:position.priceSource ?? 'Previously saved manual price', date:command.date, requestId:command.requestId }, true);
    }
    case 'record_sol_activity': return recordSolActivity(data, command);
    case 'import_locked': {
      if (data.accounts.length || data.transactions.length || data.entities.length !== 1 || data.reserves.length || data.obligations.length) fail('Import Locked into an empty workspace. Export the current data before replacing it.');
      const source = record(command.backup, 'Locked backup');
      const wrapped = source.state && typeof source.state === 'object' ? record(source.state, 'Locked state') : source;
      if (wrapped.version !== 1 || !Object.hasOwn(wrapped, 'cash') || !Array.isArray(wrapped.debts)) fail('Choose a Locked version 1 JSON backup.');
      const cash = integer(wrapped.cash, 'Locked cash balance');
      const investments = wrapped.investments === undefined ? 0 : integer(wrapped.investments, 'Locked investment balance');
      const debts = list(wrapped.debts, 'Locked debts', 500).map(raw => { const debt = record(raw, 'Locked debt'); return { name: str(debt.name, 'Debt name', 100), balance: integer(debt.balance, 'Debt balance') }; });
      data.originalImports.push({ date: now(), source: command.backup });
      const personal = data.entities[0].id;
      addAccount(data, personal, 'Imported cash', 'cash', cash, today());
      if (investments) addAccount(data, personal, 'Imported investments', 'investment', investments, today());
      for (const debt of debts) addAccount(data, personal, debt.name, 'debt', debt.balance, today());
      return 'Imported current Locked balances. The full original backup is preserved; historical transactions were not replayed.';
    }
    default: return fail('Command is not supported.');
  }
}

const planningKeys = ['obligations', 'reserves', 'spendingLimits', 'wishItems', 'expenseFunds', 'expensePlanItems', 'categoryRules', 'roadmap'] as const;
const planningCommands = new Set(['save_wish_item', 'delete_wish_item', 'save_expense_fund', 'delete_expense_fund', 'save_expense_plan_item', 'delete_expense_plan_item', 'save_spending_limit', 'save_category_rule', 'delete_category_rule', 'save_roadmap', 'update_pay_schedule', 'update_living_costs', 'update_planning_reserve', 'update_growth_target', 'add_reserve', 'remove_reserve', 'add_obligation', 'set_obligation_status']);

function validatePlanningCollections(data: Record<string, unknown>, entities: Entity[], accounts: LedgerAccount[]) {
  const entityIds = new Set(entities.map(entity => entity.id));
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const obligations = list(data.obligations, 'Planned payments', 20_000).map(rawObligation => {
    const o = record(rawObligation, 'Planned payment');
    const obligation: Obligation = { id: str(o.id, 'Payment ID'), entityId: str(o.entityId, 'Payment owner ID'), name: str(o.name, 'Payment name', 100), amountCents: integer(o.amountCents, 'Payment amount', 1), dueDate: date(o.dueDate, 'Payment due date'), direction: choice(o.direction, ['in', 'out'] as const, 'Payment direction'), recurrence: choice(o.recurrence, ['once', 'monthly', 'biweekly'] as const, 'Recurrence'), status: choice(o.status, ['planned', 'paid', 'cancelled'] as const, 'Payment status'), accountId: str(o.accountId, 'Payment account ID', 200, true), category: str(o.category, 'Payment category', 100, true) };
    if (o.assetPurchaseId !== undefined) obligation.assetPurchaseId = str(o.assetPurchaseId, 'Linked purchase ID');
    const subscription = subscriptionFlag(o.subscription, obligation.direction, obligation.recurrence);
    const additionalToPay = additionalIncomeFlag(o.additionalToPay, obligation.direction);
    if (additionalToPay !== undefined) obligation.additionalToPay = additionalToPay;
    if (subscription !== undefined) obligation.subscription = subscription;
    if (subscription && obligation.status === 'paid') fail('A recurring subscription must be active or cancelled, not completed.');
    if (!entityIds.has(obligation.entityId)) fail('A planned payment references a missing owner.');
    if (obligation.status === 'planned' && accountMap.get(obligation.accountId)?.closedAt) fail('Move or cancel planned payments before closing their account.');
    validateObligationAccount(accountMap.get(obligation.accountId), obligation.accountId, obligation.entityId, obligation.direction);
    if (o.recurrenceDay !== undefined) (obligation as PlannedObligation).recurrenceDay = integer(o.recurrenceDay, 'Monthly recurrence day', 1, 31);
    return obligation;
  });
  unique(obligations, 'planned payment');
  const reserves = list(data.reserves, 'Reserves', 20_000).map(rawReserve => {
    const r = record(rawReserve, 'Reserve');
    const reserve: Reserve = { id: str(r.id, 'Reserve ID'), entityId: str(r.entityId, 'Reserve owner ID'), name: str(r.name, 'Reserve name', 100), amountCents: integer(r.amountCents, 'Reserve amount', 1) };
    if (!entityIds.has(reserve.entityId)) fail('A reserve references a missing owner.');
    return reserve;
  });
  unique(reserves, 'reserve');
  const spendingLimits = validateSpendingLimits(data.spendingLimits === undefined ? [] : data.spendingLimits, entityIds);
  const wishItems = list(data.wishItems === undefined ? [] : data.wishItems, 'Wish basket items', 50000).map(item => validateWishItem(item, entityIds));
  unique(wishItems, 'wish basket item');
  const expenseFunds = list(data.expenseFunds === undefined ? [] : data.expenseFunds, 'Cost targets', 2000).map(fund => validateExpenseFund(fund, entityIds));
  unique(expenseFunds, 'cost target');
  const expensePlanItems = list(data.expensePlanItems === undefined ? [] : data.expensePlanItems, 'Plan items', 50000).map(item => validateExpensePlanItem(item, entityIds, spendingLimits));
  unique(expensePlanItems, 'plan item');
  for (const obligation of obligations) if (obligation.assetPurchaseId) {
    const purchase = (data.assetPurchases as AssetPurchase[] | undefined)?.find(item => item.id === obligation.assetPurchaseId);
    if (!purchase || purchase.entityId !== obligation.entityId || obligation.direction !== 'out') fail('A purchase payment must link to an existing purchase belonging to the same owner.');
    if (obligation.accountId && accountMap.get(obligation.accountId)?.type !== 'cash') fail('Purchase contributions need a cash account.');
  }
  for (const item of expensePlanItems) {
    if (item.obligationId && item.transactionId || (item.obligationId || item.transactionId) && item.separatePaymentConfirmed) fail('Choose one link or confirm a separate payment.');
    if (item.obligationId && !obligations.some(bill => bill.id === item.obligationId && bill.entityId === item.entityId && bill.direction === 'out')) fail('Link to an outgoing bill belonging to this plan owner.');
    if (item.transactionId && !(data.transactions as Transaction[]).some(tx => tx.id === item.transactionId && tx.kind === 'expense' && tx.amountCents > 0 && !tx.reversalOf && accountMap.get(tx.accountId)?.entityId === item.entityId)) fail('Link to an expense belonging to this plan owner.');
  }
  const categoryRules = validateCategoryRules(data.categoryRules ?? [], { entities, accounts });
  return { obligations, reserves, spendingLimits, wishItems, expenseFunds, expensePlanItems, categoryRules, ...(data.roadmap === undefined ? {} : { roadmap: validateRoadmap(data.roadmap, accounts) }) };
}

function validateData(raw: unknown): StoredData {
  const data = record(raw, 'Backup data');
  integer(data.revision, 'Revision');
  const entities = list(data.entities, 'Owners', 1000).map(rawEntity => {
    const e = record(rawEntity, 'Owner');
    return { id: str(e.id, 'Owner ID'), name: str(e.name, 'Owner name', 100), kind: choice(e.kind, ['personal', 'business'] as const, 'Owner kind'), ownershipBps: integer(e.ownershipBps, 'Ownership', 0, 10000) };
  });
  unique(entities, 'owner');
  if (entities.filter(entity => entity.kind === 'personal').length !== 1 || entities.find(entity => entity.kind === 'personal')?.ownershipBps !== 10000) fail('A backup must contain exactly one fully owned Personal owner.');
  const entityIds = new Set(entities.map(entity => entity.id));
  const accounts = list(data.accounts, 'Accounts', 20_000).map(rawAccount => {
    const a = record(rawAccount, 'Account');
    const account: LedgerAccount = { id: str(a.id, 'Account ID'), entityId: str(a.entityId, 'Account owner ID'), name: str(a.name, 'Account name', 100), type: choice(a.type, ledgerTypes, 'Account type'), currency: choice(a.currency, ['CAD'] as const, 'Currency'), reconciledAt: a.reconciledAt === null ? null : date(a.reconciledAt, 'Reconciled date') };
    if (account.reconciledAt !== null && account.reconciledAt > today()) fail('Reconciliation dates cannot be in the future.');
    if (!entityIds.has(account.entityId)) fail('An account references a missing owner.');
    if (a.debtTerms !== undefined) {
      if (!['debt', 'payable'].includes(account.type)) fail('Debt terms belong to a debt or payable account.');
      account.debtTerms = validateDebtTerms(a.debtTerms);
    }
    if (a.closedAt !== undefined) { account.closedAt = a.closedAt === null ? null : date(a.closedAt, 'Account closed date'); if (account.closedAt && account.closedAt > today()) fail('Account closed date cannot be in the future.'); }
    if (a.excludeFromNetWorth !== undefined) {
      if (!visibleTypes.includes(account.type as AccountType) || typeof a.excludeFromNetWorth !== 'boolean') fail('Net worth exclusion must be a boolean on a financial account.');
      account.excludeFromNetWorth = a.excludeFromNetWorth;
    }
    if (a.evidence !== undefined) account.evidence = validateEvidence(a.evidence, account.type);
    return account;
  });
  unique(accounts, 'account');
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const reservedAccountIds = new Set(entities.flatMap(entity => ['income', 'expense', 'equity'].map(type => `${entity.id}:${type}`)));
  for (const account of accounts) {
    if (['income', 'expense', 'equity'].includes(account.type) && account.id !== `${account.entityId}:${account.type}`) fail('An internal journal account has an invalid ID.');
    if (visibleTypes.includes(account.type as AccountType) && reservedAccountIds.has(account.id)) fail('A visible account uses a reserved journal account ID.');
  }
  const statements = validateStatements(data.statements, accounts);
  const statementMap = new Map(statements.map(statement => [statement.id, statement]));
  const statementRowMap = new Map(statements.flatMap(statement => statement.rows.map(row => [statementRowKey(statement.id, row.id), row] as const)));
  const importBatches = validateStatementBatches(data.importBatches, accounts);
  validateImportPeriods(statements, importBatches);
  const linkedRows = new Set<string>();
  const transactions = list(data.transactions, 'Transactions').map(rawTransaction => {
    const t = record(rawTransaction, 'Transaction');
    const tx: Transaction = { id: str(t.id, 'Transaction ID'), date: date(t.date), description: str(t.description, 'Transaction description', 500), kind: choice(t.kind, ['income', 'expense', 'transfer', 'debt_payment', 'opening', 'adjustment'] as const, 'Transaction kind'), amountCents: integer(t.amountCents, 'Transaction amount', -MAX_CENTS), accountId: str(t.accountId, 'Transaction account ID'), toAccountId: t.toAccountId === null ? null : str(t.toAccountId, 'Destination account ID'), category: str(t.category, 'Transaction category', 100, true), source: str(t.source, 'Transaction source', 300), createdAt: timestamp(t.createdAt, 'Created at') };
    if (t.displayName !== undefined) {
      const displayName = transactionAnnotation(t.displayName, 'Transaction name', 200);
      if (displayName !== null) tx.displayName = displayName;
    }
    if (t.note !== undefined) {
      const note = transactionAnnotation(t.note, 'Transaction note', 1000, true);
      if (note !== null) tx.note = note;
    }
    if (t.plannedPayment !== undefined) {
      const payment = record(t.plannedPayment, 'Planned payment reference');
      const obligationId = str(payment.obligationId, 'Planned payment obligation ID');
      if (!['income', 'expense', 'transfer'].includes(tx.kind) || tx.amountCents <= 0) fail('A planned payment reference needs a positive recorded payment.');
      tx.plannedPayment = { obligationId, dueDate: date(payment.dueDate, 'Original payment due date') };
    }
    for (const key of ['reversalOf','replacesId','refundOf','correctionReason','paydayDate'] as const) if (t[key] !== undefined) tx[key] = key === 'paydayDate' ? date(t[key], 'Payday date') : str(t[key], key, key === 'correctionReason' ? 500 : 200);
    if (t.expenseCategory !== undefined) {
      if (tx.kind !== 'expense') fail('Only expenses can have a saved reporting category.');
      tx.expenseCategory = str(t.expenseCategory, 'Expense category', 100, true);
    }
    if (tx.date > today()) fail('A backup cannot contain transactions dated in the future.');
    if (!accountMap.has(tx.accountId) || (tx.toAccountId !== null && !accountMap.has(tx.toAccountId))) fail('A transaction references a missing account.');
    if (t.statementId !== undefined || t.statementRowId !== undefined) {
      tx.statementId = str(t.statementId, 'Transaction statement ID');
      tx.statementRowId = str(t.statementRowId, 'Transaction statement row ID');
      tx.postingDate = date(t.postingDate, 'Transaction posting date');
      const statement = statementMap.get(tx.statementId);
      const key = JSON.stringify([tx.statementId, tx.statementRowId]);
      const row = statementRowMap.get(key);
      const matchedPayment = row?.kind === 'payment' && tx.kind === 'debt_payment' && tx.toAccountId === statement?.accountId;
      if (!statement || !row || (statement.accountId !== tx.accountId && !matchedPayment)) fail('A transaction references a missing statement row or the wrong account.');
      if (linkedRows.has(key)) fail('A statement row cannot be posted twice.');
      linkedRows.add(key);
      if (tx.date !== row.transactionDate || tx.postingDate !== row.postingDate || tx.description !== row.description || tx.category !== row.category || (!matchedPayment && (tx.toAccountId !== null || tx.kind !== (row.kind === 'payment' ? 'adjustment' : 'expense'))) || tx.amountCents !== (row.kind === 'payment' ? -row.amountCents : row.amountCents)) fail('A statement transaction does not match its source row.');
      if (tx.amountCents < 0 && row.kind !== 'refund') fail('Only statement refunds can have a negative expense amount.');
    } else if (tx.amountCents < 0 && t.importSources === undefined && !tx.reversalOf && !tx.refundOf) fail('Negative expenses need a verified statement refund row.');
    if (t.importSources !== undefined) {
      tx.description = exactText(t.description, 'Original statement description');
      tx.importSources = list(t.importSources, 'Transaction source rows', 2).map(rawRef => { const ref = record(rawRef, 'Transaction source row'); return { importId: str(ref.importId, 'Source import ID'), rowId: str(ref.rowId, 'Source row ID') }; });
      if (!tx.importSources.length) fail('An imported transaction needs a source row.');
      tx.postingDate = date(t.postingDate, 'Transaction posting date');
    } else if (!tx.statementId && t.postingDate !== undefined) fail('A posting date needs a statement source.');
    return tx;
  });
  if (statements.some(statement => statement.rows.some(row => !linkedRows.has(JSON.stringify([statement.id, row.id]))))) fail('A statement row is missing its recorded transaction.');
  unique(transactions, 'transaction');
  const txMap = new Map(transactions.map(tx => [tx.id, tx]));
  validateCorrections(transactions, accountMap);
  const entries = list(data.entries, 'Journal entries', 1_000_000).map(rawEntry => {
    const e = record(rawEntry, 'Journal entry');
    const entry: Entry = { id: str(e.id, 'Entry ID'), transactionId: str(e.transactionId, 'Entry transaction ID'), accountId: str(e.accountId, 'Entry account ID'), debitCents: integer(e.debitCents, 'Entry amount', -MAX_CENTS) };
    if (!accountMap.has(entry.accountId) || !txMap.has(entry.transactionId)) fail('A journal entry references a missing account or transaction.');
    return entry;
  });
  unique(entries, 'journal entry');
  const journalSums = new Map<string, number>();
  const accountSums = new Map<string, number>();
  const postedTransactions = new Set<string>();
  const transactionEntries = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.transactionId, accountMap.get(entry.accountId)!.entityId]);
    const sum = (journalSums.get(key) ?? 0) + entry.debitCents;
    if (!Number.isSafeInteger(sum)) fail('Journal totals exceed safe integer precision.');
    journalSums.set(key, sum);
    const accountSum = (accountSums.get(entry.accountId) ?? 0) + entry.debitCents;
    if (!Number.isSafeInteger(accountSum) || Math.abs(accountSum) > MAX_CENTS) fail('Account totals exceed supported balances.');
    accountSums.set(entry.accountId, accountSum);
    postedTransactions.add(entry.transactionId);
    const group = transactionEntries.get(entry.transactionId) ?? [];
    group.push(entry);
    transactionEntries.set(entry.transactionId, group);
  }
  if ([...journalSums.values()].some(sum => sum !== 0)) fail('A journal transaction does not balance for each owner.');
  if (transactions.some(tx => tx.amountCents !== 0 && !postedTransactions.has(tx.id))) fail('A transaction is missing its journal entries.');
  for (const tx of transactions) {
    const main = accountMap.get(tx.accountId)!;
    if (!visibleTypes.includes(main.type as AccountType)) fail('A transaction must reference a visible account.');
    const lines = transactionEntries.get(tx.id) ?? [];
    const actual = new Map<string, number>();
    for (const entry of lines) actual.set(entry.accountId, (actual.get(entry.accountId) ?? 0) + entry.debitCents);
    const expected = new Map<string, number>();
    const setExpected = (id: string, value: number) => { if (value) expected.set(id, value); };
    if (tx.kind === 'transfer' || tx.kind === 'debt_payment') {
      const destination = tx.toAccountId ? accountMap.get(tx.toAccountId) : undefined;
      if (!destination || destination.id === main.id) fail('A transfer needs two different accounts.');
      if (tx.kind === 'debt_payment' && (main.type !== 'cash' || !['debt', 'payable'].includes(destination.type))) fail('A debt payment has invalid account types.');
      if (tx.kind === 'transfer' && (!['cash', 'investment', 'receivable'].includes(main.type) || !['cash', 'investment', 'asset_purchase'].includes(destination.type))) fail('A transfer has invalid account types.');
      if (destination.type === 'asset_purchase' && (main.type !== 'cash' || main.entityId !== destination.entityId)) fail('Asset contributions need cash from the same owner.');
      setExpected(main.id, -tx.amountCents);
      setExpected(destination.id, tx.amountCents);
      if (main.entityId !== destination.entityId) {
        setExpected(`${main.entityId}:equity`, tx.amountCents);
        setExpected(`${destination.entityId}:equity`, -tx.amountCents);
      }
    } else {
      if (tx.toAccountId !== null) fail('Only transfers can have a destination account.');
      if (tx.kind === 'income') {
        if (!['cash', 'receivable', 'investment'].includes(main.type)) fail('Income has an invalid account type.');
        setExpected(main.id, tx.amountCents);
        setExpected(`${main.entityId}:income`, -tx.amountCents);
      } else if (tx.kind === 'expense') {
        if (!['cash', 'debt', 'payable'].includes(main.type)) fail('An expense has an invalid account type.');
        setExpected(main.id, -tx.amountCents);
        setExpected(`${main.entityId}:expense`, tx.amountCents);
      } else {
        const mainDelta = actual.get(main.id) ?? 0;
        if (Math.abs(mainDelta) !== tx.amountCents) fail('An adjustment amount does not match its journal.');
        if (tx.statementId && mainDelta !== tx.amountCents) fail('A statement payment must reduce the recorded debt.');
        setExpected(main.id, mainDelta);
        setExpected(`${main.entityId}:equity`, -mainDelta);
      }
    }
    const nonzero = [...actual].filter(([, value]) => value !== 0);
    if (nonzero.length !== expected.size || nonzero.some(([id, value]) => expected.get(id) !== value)) fail('A transaction amount or account does not match its journal.');
  }
  for (const account of accounts) if (account.closedAt && (accountSums.get(account.id) ?? 0) !== 0) fail('Closed accounts must have zero recorded balances.');
  validateCommittedImports(importBatches, transactions, accounts, transactionEntries);
  for (const account of accounts) if (visibleTypes.includes(account.type as AccountType) && !signedBalanceTypes.includes(account.type as AccountType) && (accountSums.get(account.id) ?? 0) * normalSign(account.type) < 0) fail(`The ${account.name} balance cannot be negative.`);
  const { obligations, reserves, spendingLimits, wishItems, expenseFunds, expensePlanItems, categoryRules, roadmap } = validatePlanningCollections(data, entities, accounts);
  const obligationMap = new Map(obligations.map(item => [item.id, item]));
  const paidOccurrences = new Set<string>();
  for (const tx of transactions) if (tx.plannedPayment) {
    const obligation = obligationMap.get(tx.plannedPayment.obligationId);
    if (!obligation || obligation.entityId !== accountMap.get(tx.accountId)?.entityId || (obligation.assetPurchaseId ? 'transfer' : obligation.direction === 'in' ? 'income' : 'expense') !== tx.kind || obligation.assetPurchaseId && tx.toAccountId !== purchaseAccountId(obligation.assetPurchaseId)) fail('A planned payment reference must match an obligation belonging to the payment account owner.');
    const occurrence = JSON.stringify([tx.plannedPayment.obligationId, tx.plannedPayment.dueDate]);
    if (paidOccurrences.has(occurrence)) fail('A planned payment occurrence cannot be recorded twice.');
    paidOccurrences.add(occurrence);
  }

  const positions = list(data.positions, 'SOL positions', 20_000).map(rawPosition => {
    const p = record(rawPosition, 'SOL position');
    const position: SolPosition = { id: str(p.id, 'Position ID'), accountId: str(p.accountId, 'Position account ID'), liquidSol: solString(lamports(p.liquidSol, 'Liquid SOL')), stakedSol: solString(lamports(p.stakedSol, 'Staked SOL')), rewardsSol: solString(lamports(p.rewardsSol, 'Rewards SOL')), costBasisCents: integer(p.costBasisCents, 'Cost basis'), priceCents: integer(p.priceCents, 'SOL price', 0, 1_000_000_000), priceDate: date(p.priceDate, 'Price date') };
    if (position.priceDate > today()) fail('SOL price dates cannot be in the future.');
    if (accountMap.get(position.accountId)?.type !== 'investment') fail('A SOL position needs an investment account.');
    if (solValue(position) !== (accountSums.get(position.accountId) ?? 0)) fail('A SOL valuation does not match its journal balance.');
    if (p.priceSource !== undefined) position.priceSource = str(p.priceSource, 'SOL price source', 200);
    if (p.history !== undefined) {
      position.history = list(p.history, 'SOL history', 100_000).map(rawEntry => {
        const h = record(rawEntry, 'SOL history entry');
        const entry:SolHistoryEntry = { id:str(h.id, 'SOL history ID'), date:date(h.date, 'SOL activity date'), kind:choice(h.kind, ['snapshot','correction','price','buy','sell','reward','fee'] as const, 'SOL history kind'), quantitySol:solString(lamports(h.quantitySol, 'Activity SOL')), amountCents:integer(h.amountCents, 'SOL activity value'), feeCents:integer(h.feeCents, 'SOL fee'), priceSource:str(h.priceSource, 'SOL price source', 200), transactionIds:list(h.transactionIds, 'SOL journal references', 10).map(id => str(id, 'SOL journal ID')), liquidSol:solString(lamports(h.liquidSol, 'Historical liquid SOL')), stakedSol:solString(lamports(h.stakedSol, 'Historical staked SOL')), rewardsSol:solString(lamports(h.rewardsSol, 'Historical rewards SOL')), costBasisCents:integer(h.costBasisCents, 'Historical SOL cost'), priceCents:integer(h.priceCents, 'Historical SOL price', 0, 1_000_000_000), priceDate:date(h.priceDate, 'Historical price date') };
        if (entry.date > today() || entry.priceDate > today()) fail('SOL history dates and price dates cannot be in the future.');
        if (h.cashAccountId !== undefined) {
          entry.cashAccountId = str(h.cashAccountId, 'SOL cash account');
          const cash = accountMap.get(entry.cashAccountId);
          if (cash?.type !== 'cash' || cash.entityId !== accountMap.get(position.accountId)!.entityId) fail('SOL history cash must belong to the investment owner.');
        }
        return entry;
      });
      unique(position.history, 'SOL history');
      validateSolHistory(position);
      const linkedTransactions = new Set<string>();
      for (const [index, entry] of position.history.entries()) {
        if (!index) continue;
        const before = position.history[index - 1];
        let investmentDelta = 0, cashDelta = 0;
        for (const transactionId of entry.transactionIds) {
          const tx = txMap.get(transactionId);
          if (!tx || tx.date !== entry.date || linkedTransactions.has(transactionId) || !solJournalSources[entry.kind].includes(tx.source)) fail('SOL history has an invalid journal reference for its activity kind.');
          linkedTransactions.add(transactionId);
          for (const line of transactionEntries.get(transactionId) ?? []) {
            if (line.accountId === position.accountId) investmentDelta += line.debitCents;
            else if (line.accountId === entry.cashAccountId) cashDelta += line.debitCents;
            else if (visibleTypes.includes(accountMap.get(line.accountId)!.type as AccountType)) fail('A SOL journal references an unrelated account.');
          }
        }
        const expectedCash = entry.cashAccountId ? entry.kind === 'buy' ? -entry.amountCents - entry.feeCents : entry.kind === 'sell' ? entry.amountCents - entry.feeCents : -entry.feeCents : 0;
        if (investmentDelta !== solMarketValue(entry) - solMarketValue(before) || cashDelta !== expectedCash) fail('SOL history does not match its investment or cash journal.');
      }
    }
    return position;
  });
  unique(positions, 'position');
  if (new Set(positions.map(position => position.accountId)).size !== positions.length) fail('Only one SOL position can belong to an account.');
  const events = list(data.audit, 'Edit history').map(rawEvent => { const a = record(rawEvent, 'Edit history entry'); return { id: str(a.id, 'History ID'), date: timestamp(a.date, 'History date'), action: str(a.action, 'History action', 100), description: str(a.description, 'History description', 1000) }; });
  unique(events, 'history');
  const requests = list(data.requests, 'Saved requests').map(rawRequest => { const r = record(rawRequest, 'Saved request'); const digest = str(r.digest, 'Request digest', 64); if (!/^[a-f0-9]{64}$/.test(digest)) fail('A request digest is invalid.'); return { id: str(r.id, 'Request ID'), digest }; });
  unique(requests, 'request');
  const importKeys = list(data.importKeys, 'Import fingerprints').map(key => str(key, 'Import fingerprint', 100));
  if (new Set(importKeys).size !== importKeys.length) fail('Duplicate import fingerprints.');
  const assets = list(data.assets === undefined ? [] : data.assets, 'Tracked assets', 50000).map(asset => validateAsset(asset, entityIds));
  unique(assets, 'asset');
  const moneyOwed = list(data.moneyOwed === undefined ? [] : data.moneyOwed, 'Money owed tabs', 10000).map(tab => validateMoneyOwed(tab, entityIds));
  unique(moneyOwed, 'money owed');
  const cashPostings = list(data.cashPostings ?? [], 'Cash receipts').map(rawPosting => {
    const posting = record(rawPosting, 'Cash receipt');
    const kind = choice(posting.kind, ['owed_payment', 'asset_sale'] as const, 'Cash receipt kind');
    const effectiveDate = date(posting.date, 'Cash receipt date');
    const balanceCheckDate = posting.balanceCheckDate === undefined ? undefined : date(posting.balanceCheckDate, 'Prior balance check date');
    if (balanceCheckDate !== undefined && balanceCheckDate !== effectiveDate) fail('A same-day receipt acknowledgement must match its receipt date.');
    return { kind, recordId: str(posting.recordId, 'Cash receipt record ID'), ...(kind === 'owed_payment' ? { paymentId: str(posting.paymentId, 'Cash receipt payment ID') } : {}), accountId: str(posting.accountId, 'Cash receipt account ID'), transactionId: str(posting.transactionId, 'Cash receipt transaction ID'), amountCents: integer(posting.amountCents, 'Cash receipt amount', kind === 'owed_payment' ? 1 : 0), date: effectiveDate, ...(balanceCheckDate ? { balanceCheckDate } : {}), ...(posting.reversedById === undefined ? {} : { reversedById: str(posting.reversedById, 'Cash receipt reversal ID') }) } satisfies CashPosting;
  });
  const cashTransactionIds = cashPostings.flatMap(posting => [posting.transactionId, ...(posting.reversedById ? [posting.reversedById] : [])]);
  if (new Set(cashTransactionIds).size !== cashTransactionIds.length) fail('Cash receipt transactions cannot be reused.');
  for (const posting of cashPostings) {
    const account = accountMap.get(posting.accountId);
    const tx = txMap.get(posting.transactionId);
    const cashDelta = (transactionEntries.get(posting.transactionId) ?? []).filter(entry => entry.accountId === posting.accountId).reduce((sum, entry) => sum + entry.debitCents, 0);
    if (!account || account.type !== 'cash' || !tx || tx.accountId !== account.id || tx.kind !== 'adjustment' || tx.amountCents !== posting.amountCents || tx.date !== posting.date || tx.source !== cashSource(posting.kind) || cashDelta !== posting.amountCents) fail('A cash receipt does not match its recorded cash credit.');
    if (posting.reversedById) {
      const reversal = txMap.get(posting.reversedById);
      const reversalDelta = (transactionEntries.get(posting.reversedById) ?? []).filter(entry => entry.accountId === posting.accountId).reduce((sum, entry) => sum + entry.debitCents, 0);
      if (!reversal || reversal.accountId !== account.id || reversal.kind !== 'adjustment' || reversal.amountCents !== posting.amountCents || reversal.date < posting.date || reversal.source !== cashSource(posting.kind, true) || reversalDelta !== -posting.amountCents) fail('A cash receipt correction does not reverse its original credit.');
    } else if (posting.kind === 'owed_payment') {
      const tab = moneyOwed.find(item => item.id === posting.recordId);
      const payment = tab?.payments.find(item => item.id === posting.paymentId);
      if (!tab || tab.entityId !== account.entityId || !payment || payment.cashAccountId !== account.id || payment.transactionId !== tx.id || payment.amountCents !== posting.amountCents || payment.date !== posting.date) fail('A cash repayment does not match its money owed tab.');
    } else {
      const asset = assets.find(item => item.id === posting.recordId);
      if (!asset || asset.entityId !== account.entityId || asset.status !== 'sold' || asset.salePosting?.transactionId !== tx.id || asset.salePosting.cashAccountId !== account.id || asset.soldDate !== posting.date || asset.saleCents === null || asset.saleCents - asset.feesCents !== posting.amountCents) fail('An asset sale does not match its cash proceeds.');
    }
  }
  for (const tab of moneyOwed) for (const payment of tab.payments) if (payment.transactionId && !cashPostings.some(posting => posting.kind === 'owed_payment' && posting.recordId === tab.id && posting.paymentId === payment.id && posting.transactionId === payment.transactionId && !posting.reversedById)) fail('A repayment cash link is missing its receipt record.');
  for (const asset of assets) if (asset.salePosting && !cashPostings.some(posting => posting.kind === 'asset_sale' && posting.recordId === asset.id && posting.transactionId === asset.salePosting!.transactionId && !posting.reversedById)) fail('An asset sale cash link is missing its receipt record.');
  const registeredCashTransactions = new Set(cashTransactionIds);
  for (const tx of transactions) if (['Receivable repayment', 'Receivable repayment reversal', 'Asset sale', 'Asset sale reversal'].includes(tx.source) && !registeredCashTransactions.has(tx.id)) fail('A cash receipt transaction is missing its source record.');
  const assetPurchases = list(data.assetPurchases === undefined ? [] : data.assetPurchases, 'Asset purchases', 10000).map(item => validateAssetPurchase(item, entityIds));
  unique(assetPurchases, 'asset purchase');
  for (const account of accounts.filter(item => item.type === 'asset_purchase')) {
    const purchase = assetPurchases.find(item => purchaseAccountId(item.id) === account.id);
    if (!purchase || account.entityId !== purchase.entityId) fail('An asset contribution references a missing purchase or wrong owner.');
    const recorded = accountSums.get(account.id) ?? 0;
    if (recorded < 0 || purchase.paidCents === null || recorded > purchase.paidCents) fail('Confirmed purchase progress cannot be less than recorded contributions.');
    if (transactions.some(tx => tx.toAccountId === account.id && tx.date > purchase.paidAsOf)) fail('Purchase confirmation date cannot precede a recorded contribution.');
  }
  const originalImports = list(data.originalImports, 'Original imports', 100).map(rawImport => { const o = record(rawImport, 'Original import'); record(o.source, 'Original imported data'); return { date: timestamp(o.date, 'Original import date'), source: o.source }; });
  const sourceFacts = list(data.sourceFacts ?? [], 'Source facts', 10000).map(rawFact => {
    const fact = record(rawFact, 'Source fact');
    return { id: str(fact.id, 'Source fact ID'), label: str(fact.label, 'Source fact label'), value: str(fact.value, 'Source fact value', 1000), asOf: fact.asOf === null ? null : date(fact.asOf, 'Source fact date'), sourceFile: str(fact.sourceFile, 'Source fact filename', 500), note: str(fact.note, 'Source fact note', 4000, true) } satisfies SourceFact;
  });
  unique(sourceFacts, 'source fact');
  const payrollImports = validatePayrollImports(data.payrollImports ?? []);
  validatePayrollLinks(payrollImports, {entities,accounts,transactions});
  const changes = transactionBalanceChanges(accounts, transactions, entries);
  const postingDates = transactionPostingDates({ transactions, statements, importBatches });
  const balanceDates = transactionBalanceDates({ transactions, statements, importBatches });
  const transactionsById = new Map(transactions.map(transaction => [transaction.id, {...transaction,postingDates:postingDates.get(transaction.id),balanceDates:balanceDates.get(transaction.id)}]));
  for (const [index, account] of accounts.entries()) Object.assign(account, validateAccountChecks((data.accounts as Record<string, unknown>[])[index], account, transactionsById, changes));
  return { revision: data.revision as number, entities, accounts, transactions, entries, obligations, reserves, positions, audit: events, requests, importKeys, originalImports, spendingLimits, assets, wishItems, moneyOwed, expenseFunds, expensePlanItems, assetPurchases, statements, importBatches, sourceFacts, cashPostings, categoryRules, payrollImports, lastBackupAt: data.lastBackupAt === null ? null : timestamp(data.lastBackupAt, 'Last backup date'), ...(roadmap === undefined ? {} : { roadmap }) };
}

function seed(): StoredData {
  const data = emptyData();
  const personal = data.entities[0].id;
  const studio: Entity = { id: 'studio', name: 'Studio', kind: 'business', ownershipBps: 10000 };
  const side: Entity = { id: 'side-project', name: 'Side project', kind: 'business', ownershipBps: 10000 };
  data.entities.push(studio, side);
  const cash = addAccount(data, personal, 'Daily banking', 'cash', 603070, dateAfter(-32));
  addAccount(data, personal, 'Emergency fund', 'cash', 250000, dateAfter(-32));
  addAccount(data, personal, 'Index portfolio', 'investment', 1272800, dateAfter(-32));
  const sol = addAccount(data, personal, 'Solana stake', 'investment', 0, dateAfter(-32));
  applyCommand(data, { type: 'save_sol', accountId: sol.id, liquidSol: '2.4', stakedSol: '26.4', costBasisCents: 432000, priceCents: 19000, priceDate: today(), requestId: 'seed-sol' });
  data.positions[0].rewardsSol = '1.18';
  data.positions[0].history![0].rewardsSol = '1.18';
  const debt = addAccount(data, personal, 'Credit card', 'debt', 670000, dateAfter(-32));
  const studioCash = addAccount(data, studio.id, 'Studio operating', 'cash', 477000, dateAfter(-32));
  addAccount(data, studio.id, 'Outstanding invoices', 'receivable', 120000, dateAfter(-32));
  addAccount(data, studio.id, 'Studio card', 'payable', 35000, dateAfter(-32));
  const projectCash = addAccount(data, side.id, 'Project account', 'cash', 135000, dateAfter(-32));
  for (const item of [
    { accountId: cash.id, amount: 6820, days: -1, description: 'Weekly groceries', category: 'Groceries' },
    { accountId: cash.id, amount: 650, days: -2, description: 'Coffee with a friend', category: 'Food & drink' },
    { accountId: studioCash.id, amount: 12000, days: -3, description: 'Design software', category: 'Software' },
    { accountId: cash.id, amount: 600, days: -4, description: 'Transit fare', category: 'Transport' },
  ]) transaction(data, { kind: 'expense', accountId: item.accountId, amountCents: item.amount, date: dateAfter(item.days), description: item.description, category: item.category }, 'Synthetic sample');
  data.obligations.push(
    { id: uid(), entityId: personal, name: 'Rent', amountCents: 165000, dueDate: dateAfter(6), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: cash.id, category: 'Housing' },
    { id: uid(), entityId: personal, name: 'Payday', amountCents: 245000, dueDate: dateAfter(10), direction: 'in', recurrence: 'biweekly', status: 'planned', accountId: cash.id, category: 'Salary' },
    { id: uid(), entityId: personal, name: 'Phone plan', amountCents: 5500, dueDate: dateAfter(3), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: cash.id, category: 'Bills' },
    { id: uid(), entityId: studio.id, name: 'Monthly hosting', amountCents: 8500, dueDate: dateAfter(12), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: studioCash.id, category: 'Software' },
    { id: uid(), entityId: side.id, name: 'Project subscription', amountCents: 2900, dueDate: dateAfter(19), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: projectCash.id, category: 'Software' },
  );
  data.reserves.push({ id: uid(), entityId: personal, name: 'Emergency buffer', amountCents: 250000 }, { id: uid(), entityId: studio.id, name: 'Tax reserve', amountCents: 100000 });
  data.roadmap = { currentMonthlyIncomeCents: 490000, partTimeMonthlyIncomeCents: 180000, monthlyEssentialsCents: 190000, monthlyDebtMinimumsCents: 24000, transitionDate: `${new Date().getFullYear() + 1}-01-01`, transitionMonths: 8, monthlyExtraDebtCents: 25000, loanAccountId: debt.id, loanAprPercent: 18.99, loanMonthlyPaymentCents: 24000 };
  data.spendingLimits = [
    { id: `${personal}:food`, entityId: personal, name: 'Food', color: '#DBAA88', aliases: ['Groceries', 'Food & drink', 'Coffee'], dailyCents: 2500, weeklyCents: 15000, monthlyCents: 60000 },
    { id: `${personal}:gym`, entityId: personal, name: 'Gym', color: '#9BBC9F', aliases: ['Fitness'], dailyCents: null, weeklyCents: null, monthlyCents: 6000 },
    { id: `${personal}:digital`, entityId: personal, name: 'Digital', color: '#AD9CCC', aliases: ['Software', 'Subscriptions'], dailyCents: null, weeklyCents: null, monthlyCents: 10000 },
    { id: `${personal}:transport`, entityId: personal, name: 'Transport', color: '#8CAFCB', aliases: ['Transit', 'Fuel'], dailyCents: null, weeklyCents: 5000, monthlyCents: 15000 },
    { id: `${personal}:other`, entityId: personal, name: 'Other', color: '#B9B4A7', aliases: ['Shopping', 'Uncategorized'], dailyCents: 5000, weeklyCents: 10000, monthlyCents: 25000 },
  ];
  data.assets = [
    { id: 'sample-laptop', entityId: personal, name: 'Laptop', category: 'Electronics', purchaseDate: dateAfter(-180), costCents: 129900, estimatedValueCents: 85000, status: 'owned', soldDate: null, saleCents: null, feesCents: 0, notes: 'Synthetic sample. Estimated resale price entered manually.' },
    { id: 'sample-headphones', entityId: personal, name: 'Wireless headphones', category: 'Electronics', purchaseDate: dateAfter(-90), costCents: 32000, estimatedValueCents: 18000, status: 'listed', soldDate: null, saleCents: null, feesCents: 0, notes: 'Synthetic sample listing.' },
    { id: 'sample-monitor', entityId: personal, name: 'External monitor', category: 'Electronics', purchaseDate: dateAfter(-220), costCents: 26000, estimatedValueCents: 18000, status: 'sold', soldDate: dateAfter(-12), saleCents: 20000, feesCents: 1000, notes: 'Synthetic sample sale. Inventory records are separate from financial accounts.' },
  ];
  cash.reconciledAt = today();
  debt.reconciledAt = today();
  audit(data, 'demo_created', 'Created fully synthetic sample data. These balances do not describe your finances.');
  return validateData(data);
}

export function createStore(dbPath: string, workspace: Workspace) {
  choice(workspace, ['demo', 'live'] as const, 'Workspace');
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(dbPath);
  if (process.platform !== 'win32') {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(path)) chmodSync(path, 0o600);
  }
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  let persistence: ReturnType<typeof createPersistence>;
  try { persistence = createPersistence(database, workspace, () => workspace === 'demo' ? seed() : emptyData(), validateData, data => saveBackup(data, 'before-relational-migration'), rows => saveRecoveryFile(JSON.stringify({ format: 'mazal-legacy-storage', version: 1, workspace, archivedAt: now(), rows }, null, 2), 'legacy-storage-archive')); }
  catch (error) { database.close(); throw error; }
  let cachedData: StoredData | undefined;
  let cachedVersion = -1;
  let cachedSnapshot: { data: StoredData; state: AppState; json?: string; etag?: string } | undefined;
  const dataVersion = () => (database.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
  function load(): StoredData {
    const version = dataVersion();
    if (!cachedData || version !== cachedVersion) {
      cachedData = validateData(persistence.load());
      cachedVersion = version;
    }
    return cachedData;
  }
  function save(data: StoredData, before: StoredData): void {
    persistence.save(data, before);
    cachedData = data;
    cachedVersion = dataVersion();
  }
  function snapshot(data: StoredData): AppState {
    if (cachedSnapshot?.data === data) return cachedSnapshot.state;
    const previous = cachedSnapshot;
    const ledgerUnchanged = previous && (['accounts', 'entries', 'transactions', 'statements', 'importBatches'] as const).every(key => previous.data[key] === data[key]);
    const sums = new Map<string, number>();
    if (!ledgerUnchanged) for (const entry of data.entries) sums.set(entry.accountId, (sums.get(entry.accountId) ?? 0) + entry.debitCents);
    const changes = ledgerUnchanged ? null : transactionBalanceChanges(data.accounts, data.transactions, data.entries);
    const postingDates = ledgerUnchanged ? null : transactionPostingDates(data);
    const balanceDates = ledgerUnchanged ? null : transactionBalanceDates(data);
    const transactions = ledgerUnchanged ? previous.state.transactions : data.transactions.map(transaction => ({ ...transaction, balanceChanges: changes!.get(transaction.id) ?? {}, postingDates:postingDates!.get(transaction.id) ?? {}, balanceDates:balanceDates!.get(transaction.id) ?? {} })).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const state: AppState = { workspace, revision: data.revision, entities: data.entities, accounts: ledgerUnchanged ? previous.state.accounts : data.accounts.filter(account => visibleTypes.includes(account.type as AccountType)).map(account => ({ ...account, type: account.type as AccountType, balanceCents: (sums.get(account.id) ?? 0) * normalSign(account.type) } as Account)), transactions, obligations: data.obligations, reserves: data.reserves, positions: data.positions, audit: [...data.audit].reverse(), lastBackupAt: data.lastBackupAt, spendingLimits: data.spendingLimits ?? [], assets: data.assets ?? [], wishItems: data.wishItems ?? [], moneyOwed: data.moneyOwed ?? [], expenseFunds: data.expenseFunds ?? [], expensePlanItems: data.expensePlanItems ?? [], assetPurchases: data.assetPurchases ?? [], statements: data.statements ?? [], importBatches: data.importBatches ?? [], sourceFacts: data.sourceFacts ?? [], categoryRules:data.categoryRules ?? [], payrollImports:data.payrollImports ?? [], ...(data.roadmap ? { roadmap: data.roadmap } : {}) };
    cachedSnapshot = { data, state };
    return state;
  }
  function backupObject(data: StoredData): MazalBackup { return { format: 'mazal-backup', version: 1, workspace, exportedAt: now(), data: structuredClone(data) }; }
  function saveBackup(data: StoredData, label: string): string {
    return saveRecoveryFile(JSON.stringify(backupObject(data), null, 2), label);
  }
  function saveRecoveryFile(contents: string, label: string): string {
    const directory = join(dirname(dbPath), 'backups', workspace);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${now().replace(/[:.]/g, '-')}-${label}-${uid().slice(0, 8)}.json`);
    const tempPath = `${path}.tmp`;
    try {
      writeFileSync(tempPath, contents, { mode: 0o600, flag: 'wx', flush: true });
      renameSync(tempPath, path);
      if (process.platform !== 'win32') {
        const descriptor = openSync(directory, 'r');
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      }
    } catch (error) { rmSync(tempPath, { force: true }); throw error; }
    return path;
  }
  function withTransaction<T>(fn: () => T): T {
    database.exec('BEGIN IMMEDIATE');
    try { const result = fn(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); cachedData = undefined; cachedSnapshot = undefined; throw error; }
  }
  function restore(raw: unknown, expectedRevision?: unknown): AppState {
    const backup = record(raw, 'Backup');
    if (backup.format !== 'mazal-backup' || backup.version !== 1) fail('Choose a Mazal version 1 JSON backup.');
    choice(backup.workspace, ['demo', 'live'] as const, 'Backup workspace');
    if (backup.workspace !== workspace) fail(`This is a ${backup.workspace} backup. Switch to that workspace before restoring it.`);
    timestamp(backup.exportedAt, 'Backup export date');
    const validated = validateData(backup.data);
    return withTransaction(() => {
      const current = load();
      checkRevision(expectedRevision, current.revision);
      validated.lastBackupAt = now();
      validated.revision = integer(current.revision + 1, 'Revision');
      audit(validated, 'restore', `Restored a ${backup.workspace} backup from ${backup.exportedAt}. Saved the previous workspace before replacement.`);
      list(validated.audit, 'Edit history');
      saveBackup(current, 'before-restore');
      save(validated, current);
      return structuredClone(snapshot(validated));
    });
  }
  function commandResult(input: Command, changesOnly = false): AppState | StateChanges {
    const raw = record(input, 'Command');
    if (raw.type === 'restore') return restore(raw.backup, raw.expectedRevision);
    return withTransaction(() => {
      const before = load();
      const planning = planningCommands.has(String(raw.type));
      const data = planning ? { ...before, ...structuredClone(Object.fromEntries(planningKeys.map(key => [key, before[key]]))), audit: [...before.audit], requests: [...before.requests] } : structuredClone(before);
      const requestId = Object.hasOwn(raw, 'requestId') ? str(raw.requestId, 'Request ID') : null;
      const needsRequest = ['link_payroll_deposit','unlink_payroll_deposit','review_payroll_issue','convert_wish_to_asset','set_account_closed','update_reserve','update_growth_target','confirm_payday','correct_transaction','record_refund', 'import_payroll', 'add_transaction', 'categorize_transaction', 'categorize_transactions', 'record_asset_sale', 'undo_asset_sale', 'pay_obligation', 'update_obligation', 'set_obligation_status', 'save_expense_fund', 'delete_expense_fund', 'save_expense_plan_item', 'delete_expense_plan_item', 'save_asset_purchase', 'record_asset_purchase_payment', 'save_wish_item', 'delete_wish_item', 'save_money_owed', 'delete_money_owed', 'record_owed_payment', 'remove_owed_payment', 'reconcile', 'import_rows', 'import_statement', 'stage_statement', 'revise_statement', 'review_statement', 'commit_statements', 'save_sol', 'add_sol_reward'].includes(String(raw.type)) || raw.type === 'add_obligation' && raw.subscription === true;
      if ((needsRequest || ['rename_account', 'annotate_transaction', 'save_category_rule', 'delete_category_rule', 'save_reconciliation', 'reopen_reconciliation', 'record_sol_activity', 'correct_bank_matched_amount', 'extend_bank_activity'].includes(String(raw.type))) && requestId === null) fail('This command needs a request ID.');
      const { expectedRevision: _expectedRevision, ...payload } = raw;
      const digest = requestId ? hash(payload) : null;
      const previous = requestId ? data.requests.find(request => request.id === requestId) : null;
      if (previous) {
        if (previous.digest !== digest) fail('This request ID was already used for a different operation.');
        return structuredClone(snapshot(before));
      }
      if (['link_payroll_deposit','unlink_payroll_deposit','review_payroll_issue','convert_wish_to_asset','set_account_closed','update_reserve','update_growth_target','confirm_payday','correct_transaction','record_refund'].includes(String(raw.type)) && raw.expectedRevision === undefined) fail('This change needs the current workspace revision.');
      checkRevision(raw.expectedRevision, data.revision);
      if (input.type === 'correct_bank_matched_amount') verifyBankAmountCorrectionSource({ ...input, source: validateStatementSource(input.source, data.accounts) }, join(dirname(dbPath), 'source-documents'));
      if (input.type === 'extend_bank_activity') verifyBankActivityExtensionSource(data, input, join(dirname(dbPath), 'source-documents'));
      if (!data.lastBackupAt || data.lastBackupAt.slice(0, 10) !== now().slice(0, 10)) { saveBackup(data, 'daily'); data.lastBackupAt = now(); }
      const previousSnapshot = changesOnly && planning ? snapshot(before) : undefined;
      const description = applyCommand(data, input);
      if (requestId && digest) data.requests.push({ id: requestId, digest });
      data.revision++;
      audit(data, String(raw.type), description);
      const validated = planning ? Object.assign(data, validatePlanningCollections(data as unknown as Record<string, unknown>, data.entities, data.accounts)) : validateData(data);
      if (planning) {
        integer(data.revision, 'Revision');
        list(data.audit, 'Edit history');
        list(data.requests, 'Saved requests');
        str(data.audit.at(-1)!.description, 'History description', 1000);
      }
      save(validated, before);
      const state = snapshot(validated);
      if (previousSnapshot && raw.expectedRevision === before.revision) {
        const changes = Object.fromEntries(Object.entries(state).filter(([key, value]) => key !== 'workspace' && key !== 'revision' && (key === 'lastBackupAt' || value !== previousSnapshot[key as keyof AppState])));
        return structuredClone({ format: 'mazal-state-changes' as const, workspace, baseRevision: before.revision, revision: state.revision, changes });
      }
      return structuredClone(state);
    });
  }
  function exportBackup(): MazalBackup {
    return withTransaction(() => {
      const before = load();
      const data = { ...before };
      data.lastBackupAt = now();
      const backup = backupObject(data);
      serializeBackup(backup);
      saveBackup(before, 'export');
      save(data, before);
      return backup;
    });
  }
  function readTransaction<T>(read: () => T): T {
    database.exec('BEGIN');
    try { const result = read(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); cachedData = undefined; cachedSnapshot = undefined; throw error; }
  }
  function stateJson(): string {
    return readTransaction(() => {
      const state = snapshot(load());
      return cachedSnapshot!.json ??= JSON.stringify(state);
    });
  }
  function stateResponse(ifNoneMatch?: string): StateResponse {
    return readTransaction(() => {
      const state = snapshot(load());
      const json = cachedSnapshot!.json ??= JSON.stringify(state);
      const etag = cachedSnapshot!.etag ??= `"${createHash('sha256').update(json).digest('hex')}"`;
      return matchesStateTag(ifNoneMatch, etag) ? { status: 304, etag } : { status: 200, etag, json };
    });
  }
  return { state: (): AppState => readTransaction(() => structuredClone(snapshot(load()))), stateJson, stateResponse, transactions: (query?: TransactionQuery) => readTransaction(() => persistence.transactions(query)), command: (input: Command): AppState => commandResult(input) as AppState, commandChanges: (input: Command) => commandResult(input, true), export: exportBackup, backup: exportBackup, restore, close: (): void => database.close() };
}
