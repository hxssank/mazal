import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterLedger, ledgerCSV, ledgerDirection, ledgerTotals, transactionDisplayLabel } from './ledger.ts';
import type { AppState, Transaction } from './types.ts';

function entry(id: string, kind: Transaction['kind'], amountCents = 1000, accountId = 'bank', toAccountId: string | null = null): Transaction {
  return { id, date: '2026-09-22', kind, amountCents, accountId, toAccountId, description: id, category: 'Other', source: 'Manual entry', createdAt: '2026-09-22T12:00:00Z' };
}

function state(): AppState {
  return {
    workspace: 'live', revision: 0, entities: [],
    accounts: [
      { id: 'bank', entityId: 'me', name: 'Chequing', type: 'cash', currency: 'CAD', balanceCents: 10000, reconciledAt: null },
      { id: 'savings', entityId: 'me', name: 'Savings', type: 'cash', currency: 'CAD', balanceCents: 0, reconciledAt: null },
      { id: 'business', entityId: 'work', name: 'Business', type: 'cash', currency: 'CAD', balanceCents: 0, reconciledAt: null },
    ],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

test('ledger totals reject purchases or refunds that exceed exact aggregate cents', () => {
  const purchases = Array.from({ length: 91 }, (_, index) => entry(`expense-${index}`, 'expense', 100_000_000_000_000));
  assert.throws(() => ledgerTotals(purchases), /supported amount/);
  assert.throws(() => ledgerTotals(purchases.map(transaction => ({ ...transaction, amountCents: -transaction.amountCents }))), /supported amount/);
});

test('all dates retains account scope and includes both sides of transfers once', () => {
  const data = state();
  data.transactions = [entry('expense', 'expense'), { ...entry('old', 'income'), date: '2025-08-02' }, entry('internal', 'transfer', 500, 'bank', 'savings'), entry('incoming', 'transfer', 400, 'business', 'bank'), entry('unrelated', 'expense', 600, 'business')];
  const filters = { scope: 'me', month: null, accountId: 'all', kind: 'all' as const, query: '' };
  assert.deepEqual(filterLedger(data, filters).map(row => row.id), ['expense', 'incoming', 'internal', 'old']);
  assert.deepEqual(filterLedger(data, { ...filters, accountId: 'savings' }).map(row => row.id), ['internal']);
  assert.deepEqual(filterLedger(data, { ...filters, month: '2026-09', kind: 'income' }), []);
  assert.deepEqual(filterLedger(data, { ...filters, kind: 'income' }).map(row => row.id), ['old']);
  assert.deepEqual(filterLedger(data, { ...filters, query: '  BUSINESS ' }).map(row => row.id), ['incoming']);
  assert.deepEqual(filterLedger(data, { ...filters, accountId: 'business' }), []);
  assert.deepEqual(filterLedger(data, { ...filters, scope: 'work' }).map(row => row.id), ['incoming', 'unrelated']);
});

test('transfer direction follows the owner scope and remains neutral for internal moves', () => {
  const data = state();
  const personalAccounts = new Set(['bank', 'savings']);
  const incoming = entry('incoming', 'transfer', 550, 'business', 'bank');
  const outgoing = entry('outgoing', 'transfer', 550, 'bank', 'business');
  assert.equal(ledgerDirection(incoming, 'all', personalAccounts), 'In');
  assert.equal(ledgerDirection(outgoing, 'all', personalAccounts), 'Out');
  assert.equal(ledgerDirection(entry('internal', 'transfer', 100, 'bank', 'savings'), 'all', personalAccounts), 'Transfer');
  assert.ok(ledgerCSV(data, [incoming], 'all', 'me').includes('"5.50","In"'));
  assert.ok(ledgerCSV(data, [incoming], 'all', 'work').includes('"5.50","Out"'));
  assert.ok(ledgerCSV(data, [incoming]).includes('"5.50","Transfer"'));
});

test('manual reversals show the reversed cash direction and remain distinct from refunds', () => {
  const data = state();
  const income = { ...entry('reverse-income', 'income', -550), reversalOf: 'income' };
  const expense = { ...entry('reverse-expense', 'expense', -550), reversalOf: 'expense' };
  const transfer = { ...entry('reverse-transfer', 'transfer', -550, 'bank', 'business'), reversalOf: 'transfer' };
  const debt = { ...entry('reverse-payment', 'debt_payment', -550), reversalOf: 'payment' };
  data.transactions = [income, expense, transfer, debt];
  assert.equal(ledgerDirection(income), 'Out');
  assert.equal(ledgerDirection(expense), 'In');
  assert.equal(ledgerDirection(transfer, 'bank'), 'In');
  assert.equal(ledgerDirection(transfer, 'business'), 'Out');
  assert.equal(ledgerDirection(transfer, 'all', new Set(['bank', 'savings'])), 'In');
  assert.equal(ledgerDirection(transfer, 'all', new Set(['business'])), 'Out');
  assert.equal(ledgerDirection(transfer, 'all', new Set(['bank', 'business'])), 'Transfer');
  assert.equal(transactionDisplayLabel(income), 'Income reversal');
  assert.equal(transactionDisplayLabel(expense), 'Expense reversal');
  assert.equal(transactionDisplayLabel(transfer), 'Transfer reversal');
  assert.equal(transactionDisplayLabel(debt), 'Debt payment reversal');
  assert.equal(filterLedger(data, { scope: 'all', month: null, accountId: 'all', kind: 'all', query: 'refund' }).length, 0);
  const csv = ledgerCSV(data, data.transactions, 'bank', 'me');
  assert.ok(csv.includes('"Income reversal","Chequing","","Other","-5.50","Out"'));
  assert.ok(csv.includes('"Transfer reversal","Chequing","Business","Other","-5.50","In"'));
});

test('CSV cents stay exact at the largest safe integer', () => {
  const csv = ledgerCSV(state(), [entry('large', 'income', Number.MAX_SAFE_INTEGER), entry('fraction', 'expense', 1)]);
  assert.ok(csv.includes('"90071992547409.91","In"'));
  assert.ok(csv.includes('"0.01","Out"'));
});

test('filtered totals separate purchases, debt repayments, transfers and corrections', () => {
  const rows = [entry('expense', 'expense', 1500), entry('transfer', 'transfer', 3000), entry('paid', 'debt_payment', 2000), entry('income', 'income', 5000), entry('correction', 'adjustment', 100)];
  const totals = ledgerTotals(rows);
  assert.deepEqual(totals.expense, { count: 1, amountCents: 1500 });
  assert.deepEqual(totals.transfer, { count: 1, amountCents: 3000 });
  assert.deepEqual(totals.debt_payment, { count: 1, amountCents: 2000 });
  assert.equal(ledgerDirection(rows[4]), 'Unknown');
  assert.equal(ledgerDirection(rows[1]), 'Transfer');
  assert.equal(ledgerDirection(entry('move', 'transfer', 100, 'bank', 'savings'), 'bank'), 'Out');
  assert.equal(ledgerDirection(entry('move', 'transfer', 100, 'bank', 'savings'), 'savings'), 'In');
});

test('CSV exports exactly the selected rows and preserves amounts without inventing correction signs', () => {
  const data = state();
  const correction = { ...entry('correction', 'adjustment', 125), description: '=SUM(1,2)\n"note"' };
  data.transactions = [entry('excluded', 'expense'), correction];
  const csv = ledgerCSV(data, [correction]);
  assert.ok(csv.startsWith('\uFEFF"Transaction ID"'));
  assert.ok(csv.includes('"\'=SUM(1,2)\n""note"""'));
  assert.ok(csv.includes('"1.25","Unknown"'));
  assert.ok(csv.includes('"Chequing"'));
  assert.ok(!csv.includes('excluded'));
  assert.ok(csv.endsWith('\r\n'));
});

test('refunds reduce expenses and remain searchable and distinguishable from card payments', () => {
  const data = state();
  const purchase = entry('purchase', 'expense', 3221);
  const refund = entry('credit', 'expense', -3108);
  const payment = { ...entry('payment', 'adjustment', 25000), category: 'Card payment', statementId: 'statement', statementRowId: 'row-3' };
  data.transactions = [purchase, refund, payment];
  assert.deepEqual(ledgerTotals(data.transactions).expense, { count: 2, amountCents: 113 });
  assert.equal(ledgerTotals(data.transactions).income.amountCents, 0);
  assert.equal(transactionDisplayLabel(purchase), 'Expense');
  assert.equal(transactionDisplayLabel(refund), 'Refund');
  assert.equal(transactionDisplayLabel(payment), 'Card payment');
  assert.equal(transactionDisplayLabel(entry('correction', 'adjustment', -125)), 'Balance correction');
  assert.equal(ledgerDirection(refund), 'In');
  assert.equal(ledgerDirection(payment), 'Debt payment');
  const filters = { scope: 'me', month: null, accountId: 'all', kind: 'all' as const, query: 'refund' };
  assert.deepEqual(filterLedger(data, filters).map(row => row.id), ['credit']);
  assert.deepEqual(filterLedger(data, { ...filters, query: 'card payment' }).map(row => row.id), ['payment']);
  assert.deepEqual(filterLedger(data, { ...filters, query: '', kind: 'debt_payment' }).map(row => row.id), ['payment']);
  assert.deepEqual(filterLedger(data, { ...filters, query: '', kind: 'adjustment' }), []);
  const csv = ledgerCSV(data, data.transactions);
  assert.ok(csv.includes('"Refund","Chequing","","Other","-31.08","In"'));
  assert.ok(csv.includes('"Card payment","Chequing","","Card payment","250.00","Debt payment"'));
});

test('CSV refunds remain numeric while text fields retain formula protection', () => {
  const refund = { ...entry('refund', 'expense', -3108), description: '-10+20', category: '+SUM(1,2)', source: '@source' };
  const csv = ledgerCSV(state(), [refund]);
  assert.ok(csv.includes('"\'-10+20"'));
  assert.ok(csv.includes('"\'+SUM(1,2)"'));
  assert.ok(csv.includes('"\'@source"'));
  assert.ok(csv.includes('"-31.08","In"'));
  assert.ok(!csv.includes('"\'-31.08"'));
});

test('receipts and reversals show cash direction without becoming salary income', () => {
  const received = { ...entry('received', 'adjustment', 25000), source: 'Receivable repayment' };
  const sold = { ...entry('sold', 'adjustment', 50000), source: 'Asset sale' };
  const reversed = { ...entry('reversed', 'adjustment', 25000), source: 'Receivable repayment reversal' };
  assert.equal(transactionDisplayLabel(received), 'Repayment received');
  assert.equal(transactionDisplayLabel(sold), 'Sale proceeds');
  assert.equal(transactionDisplayLabel(reversed), 'Receipt reversed');
  assert.equal(ledgerDirection(received), 'In');
  assert.equal(ledgerDirection(sold), 'In');
  assert.equal(ledgerDirection(reversed), 'Out');
  assert.equal(ledgerTotals([received, sold, reversed]).income.count, 0);
});

test('imported source movements retain their account direction without labelling every adjustment a card payment', () => {
  const data = state();
  const source = [{ importId: 'review', rowId: 'row' }];
  const payment = { ...entry('payment', 'adjustment', 25000), importSources: source, category: 'Card payment', balanceChanges: { bank: -25000 } };
  const reversal = { ...entry('reversal', 'adjustment', 25000), importSources: source, category: 'Card payment', balanceChanges: { bank: 25000 } };
  const movement = { ...entry('movement', 'adjustment', 10000), importSources: source, category: 'Account transfer', balanceChanges: { bank: -10000 } };
  const unrelatedLegacy = { ...entry('legacy-movement', 'adjustment', 10000), statementId: 'statement', category: 'Account transfer', balanceChanges: { bank: 10000 } };
  data.transactions = [payment, reversal, movement, unrelatedLegacy];
  assert.equal(transactionDisplayLabel(payment), 'Card payment');
  assert.equal(transactionDisplayLabel(movement), 'Account movement');
  assert.equal(transactionDisplayLabel(unrelatedLegacy), 'Account movement');
  assert.equal(ledgerDirection(payment), 'Decrease');
  assert.equal(ledgerDirection(reversal), 'Increase');
  assert.equal(ledgerDirection(movement, 'bank'), 'Decrease');
  const filters = { scope: 'me', month: null, accountId: 'all', kind: 'debt_payment' as const, query: '' };
  assert.deepEqual(filterLedger(data, filters).map(row => row.id), ['payment', 'reversal']);
  assert.deepEqual(filterLedger(data, { ...filters, kind: 'adjustment' }).map(row => row.id), ['legacy-movement', 'movement']);
  const csv = ledgerCSV(data, data.transactions);
  assert.ok(csv.includes('"250.00","Decrease"'));
  assert.ok(csv.includes('"250.00","Increase"'));
  assert.deepEqual(ledgerTotals(data.transactions).income, { count: 0, amountCents: 0 });
});

test('saved names and notes are searchable and exported beside the original description',()=>{
  const data=state();const original={...entry('raw bank merchant','expense'),displayName:'Home internet',note:'Work connection\n50% shared'};data.transactions=[original];
  for(const query of ['raw bank merchant','home internet','work connection'])assert.equal(filterLedger(data,{scope:'all',month:null,accountId:'all',kind:'all',query})[0]?.id,original.id);
  const csv=ledgerCSV(data,data.transactions);assert.match(csv,/"Source","Name","Notes"/);assert.ok(csv.includes('"raw bank merchant","Expense"'));assert.ok(csv.includes('"Home internet","Work connection\n50% shared"'));
});
