import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, RevisionConflictError } from './store.ts';
import type { StatementImport } from '../shared/types.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-statements-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const card = store.command({ type: 'add_account', entityId: 'personal', name: 'Card', accountType: 'debt', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  return { store, path, card };
}

function statement(accountId: string): StatementImport {
  return { id: 'statement-january', accountId, sourceFile: 'January.pdf', sha256: 'a'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 10900, rows: [
    { id: 'purchase', transactionDate: '2026-01-02', postingDate: '2026-01-03', description: 'Groceries', amountCents: 2000, kind: 'purchase', category: 'Food', sourcePage: 2 },
    { id: 'payment', transactionDate: '2026-01-04', postingDate: '2026-01-04', description: 'Payment received', amountCents: -1000, kind: 'payment', category: 'Card payment', sourcePage: 2 },
    { id: 'refund', transactionDate: '2026-01-05', postingDate: '2026-01-06', description: 'Refund', amountCents: -200, kind: 'refund', category: 'Food', sourcePage: 2 },
    { id: 'interest', transactionDate: '2026-01-31', postingDate: '2026-01-31', description: 'Interest', amountCents: 100, kind: 'interest', category: 'Interest', sourcePage: 3 },
  ] };
}

test('statement purchases, refunds and interest reconcile without counting card payments as cash or income', t => {
  const { store, path, card } = setup(t);
  store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 50000, openingDate: '2026-01-01' });
  const input = { type: 'import_statement', statement: statement(card), requestId: 'january' } as const;
  const result = store.command(input);
  assert.equal(result.accounts.find(account => account.id === card)!.balanceCents, 10900);
  assert.equal(result.accounts.find(account => account.name === 'Cash')!.balanceCents, 50000);
  assert.equal(result.transactions.filter(tx => tx.kind === 'expense').reduce((sum, tx) => sum + tx.amountCents, 0), 1900);
  assert.equal(result.transactions.filter(tx => tx.kind === 'income' || tx.kind === 'debt_payment').length, 0);
  assert.equal(result.transactions.find(tx => tx.statementRowId === 'payment')!.kind, 'adjustment');
  assert.equal(result.accounts[0].reconciledAt, '2026-01-31');
  assert.deepEqual(result.statements, [input.statement]);
  assert.deepEqual(store.command(input), result);
  store.command({ ...input, requestId: 'january-again' });
  assert.equal(store.state().transactions.length, result.transactions.length);
  assert.equal(store.state().statements!.length, 1);
  const backup = store.export();
  store.restore(backup);
  store.close();
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state().statements, [input.statement]); assert.equal(reopened.state().accounts[0].balanceCents, 10900); }
  finally { reopened.close(); }
});

test('historical statements retain a later bank-confirmed balance and its evidence', t => {
  const { store, card } = setup(t);
  store.command({ type: 'reconcile', accountId: card, balanceCents: 12345, date: '2026-09-01', note: 'Current banking screen', requestId: 'current-balance' });
  const evidence = store.state().accounts[0].evidence;
  store.command({ type: 'import_statement', statement: statement(card), requestId: 'history' });
  assert.equal(store.state().accounts[0].balanceCents, 12345);
  assert.equal(store.state().accounts[0].reconciledAt, '2026-09-01');
  assert.deepEqual(store.state().accounts[0].evidence, evidence);
  assert.equal(store.state().transactions.filter(tx => tx.statementId).length, 4);
  assert.equal(store.state().transactions.filter(tx => tx.source === 'Historical statement reconciliation').length, 1);
});

test('statement import rejects unreconciled totals, invalid source rows and overlapping periods atomically', t => {
  const { store, card } = setup(t);
  const valid = statement(card);
  const baseline = store.state();
  for (const change of [
    (input: StatementImport) => { input.closingBalanceCents++; },
    (input: StatementImport) => { input.rows[0].postingDate = '2026-02-01'; },
    (input: StatementImport) => { input.rows[0].kind = 'payment'; },
    (input: StatementImport) => { input.rows[0].id = input.rows[1].id; },
    (input: StatementImport) => { input.sha256 = 'invalid'; },
    (input: StatementImport) => { input.openingBalanceCents += 100; input.closingBalanceCents += 100; },
  ]) {
    const input = structuredClone(valid);
    change(input);
    assert.throws(() => store.command({ type: 'import_statement', statement: input, requestId: 'bad-statement' }));
    assert.deepEqual(store.state(), baseline);
  }
  store.command({ type: 'import_statement', statement: valid, requestId: 'good-statement' });
  const imported = store.state();
  assert.throws(() => store.command({ type: 'import_statement', statement: { ...valid, id: 'overlap', sha256: 'b'.repeat(64) }, requestId: 'overlap' }), /overlap/);
  assert.deepEqual(store.state(), imported);
});

test('identical purchases remain distinct source rows and adjacent statements can be imported', t => {
  const { store, card } = setup(t);
  const first = statement(card);
  first.rows.push({ ...first.rows[0], id: 'purchase-duplicate' });
  first.closingBalanceCents += 2000;
  store.command({ type: 'import_statement', statement: first, requestId: 'first-statement' });
  assert.equal(store.state().transactions.filter(tx => tx.description === 'Groceries').length, 2);
  const next = { ...first, id: 'february', sha256: 'b'.repeat(64), periodStart: '2026-02-01', periodEnd: '2026-02-28', openingBalanceCents: first.closingBalanceCents, closingBalanceCents: first.closingBalanceCents, rows: [] };
  store.command({ type: 'import_statement', statement: next, requestId: 'next-statement' });
  assert.equal(store.state().statements!.length, 2);
  assert.equal(store.state().accounts[0].balanceCents, 12900);
});

test('backup restore rejects changed, missing or duplicated statement transactions and altered payment journals', t => {
  const { store, card } = setup(t);
  store.command({ type: 'import_statement', statement: statement(card), requestId: 'source' });
  const backup = store.export();
  const baseline = store.state();
  for (const change of [
    (copy: typeof backup) => { copy.data.statements![0].rows[0].amountCents++; copy.data.statements![0].closingBalanceCents++; },
    (copy: typeof backup) => { copy.data.transactions = copy.data.transactions.filter(tx => tx.statementRowId !== 'refund'); },
    (copy: typeof backup) => { copy.data.transactions.push({ ...copy.data.transactions.find(tx => tx.statementRowId === 'purchase')!, id: 'duplicate' }); },
    (copy: typeof backup) => { const payment = copy.data.transactions.find(tx => tx.statementRowId === 'payment')!; for (const entry of copy.data.entries.filter(entry => entry.transactionId === payment.id)) entry.debitCents *= -1; },
    (copy: typeof backup) => { const refund = copy.data.transactions.find(tx => tx.statementRowId === 'refund')!; delete refund.statementId; delete refund.statementRowId; delete refund.postingDate; },
  ]) {
    const invalid = structuredClone(backup);
    change(invalid);
    assert.throws(() => store.restore(invalid));
    assert.deepEqual(store.state(), baseline);
  }
});

test('balance evidence, statement dates and reference facts survive restore and manual reconciliation clears stale payoff values', t => {
  const { store, card } = setup(t);
  const backup = store.export();
  backup.data.accounts[0].evidence = { sourceFile: 'Bank.heic', asOf: '2026-01-31', capturedOn: '2026-02-01', status: 'bank', notes: 'Bank balance', creditLimitCents: 50000, availableCreditCents: 39000, payoffCents: 11000 };
  backup.data.accounts[0].debtTerms = { aprPercent: null, rateConfirmed: false, minimumPaymentCents: null, notes: '', statementDate: '2026-01-31', paymentDueDate: '2026-02-20' };
  backup.data.sourceFacts = [{ id: 'score', label: 'Credit score', value: '654', asOf: '2026-02-01', sourceFile: 'Report.heic', note: 'Reported score only.' }];
  store.restore(backup);
  assert.deepEqual(store.state().accounts[0].evidence, backup.data.accounts[0].evidence);
  assert.deepEqual(store.state().accounts[0].debtTerms, backup.data.accounts[0].debtTerms);
  assert.deepEqual(store.state().sourceFacts, backup.data.sourceFacts);
  store.command({ type: 'reconcile', accountId: card, balanceCents: 13000, date: '2026-03-01', note: 'Latest balance', requestId: 'manual' });
  assert.equal(store.state().accounts[0].evidence!.sourceFile, 'Manual balance update');
  assert.equal(store.state().accounts[0].evidence!.payoffCents, undefined);
  assert.equal(store.state().accounts[0].evidence!.availableCreditCents, undefined);
});

test('stale revisions reject writes and restores, while successful request retries retain idempotency', t => {
  const { store, card } = setup(t);
  const revision = store.state().revision;
  const input = { type: 'reconcile', accountId: card, balanceCents: 15000, date: '2026-02-01', note: 'Confirmed', requestId: 'once', expectedRevision: revision } as const;
  store.command(input);
  const saved = store.state();
  assert.deepEqual(store.command(input), saved);
  assert.deepEqual(store.command({ ...input, expectedRevision: saved.revision }), saved);
  assert.throws(() => store.command({ ...input, requestId: 'stale-write' }), RevisionConflictError);
  const backup = store.export();
  assert.throws(() => store.command({ type: 'restore', backup, expectedRevision: revision }), RevisionConflictError);
  assert.equal(store.state().revision, saved.revision);
});

test('live and sample backups cannot replace each other and local database files restrict access', t => {
  const { store, path } = setup(t);
  const baseline = store.state();
  const backup = store.export();
  backup.workspace = 'demo';
  assert.throws(() => store.restore(backup), /Switch to that workspace/);
  assert.equal(store.state().revision, baseline.revision);
  if (process.platform !== 'win32') for (const file of [path, `${path}-wal`, `${path}-shm`]) assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('category corrections retain source money and can be retried without importing the original statement twice', t => {
  const { store, card } = setup(t);
  const source = statement(card);
  store.command({ type: 'import_statement', statement: source, requestId: 'import-to-categorize' });
  const expense = store.state().transactions.find(tx => tx.statementRowId === 'purchase')!;
  const input = { type: 'categorize_transaction', id: expense.id, expectedCategory: 'Food', category: 'Groceries', requestId: 'category-change' } as const;
  const saved = store.command(input);
  assert.equal(saved.transactions.find(tx => tx.id === expense.id)!.category, 'Groceries');
  assert.equal(saved.statements![0].rows.find(row => row.id === 'purchase')!.category, 'Groceries');
  assert.equal(saved.accounts[0].balanceCents, 10900);
  assert.deepEqual(store.command(input), saved);
  assert.throws(() => store.command({ ...input, category: 'Shopping', requestId: 'stale-category' }), /category changed/);
  assert.throws(() => store.command({ ...input, id: saved.transactions.find(tx => tx.statementRowId === 'payment')!.id, requestId: 'payment-category' }), /expense or refund/);
  store.command({ type: 'import_statement', statement: { ...source, id: 'renamed-id', sourceFile: 'Renamed.pdf' }, requestId: 'reimport' });
  assert.equal(store.state().transactions.length, saved.transactions.length);
  assert.equal(store.state().transactions.find(tx => tx.id === expense.id)!.category, 'Groceries');
  const backup = store.export();
  store.restore(backup);
  assert.equal(store.state().transactions.find(tx => tx.id === expense.id)!.category, 'Groceries');
});

test('backup write failure prevents restore from replacing existing financial records', t => {
  const { store, path } = setup(t);
  const backup = store.export();
  store.command({ type: 'add_account', entityId: 'personal', name: 'Keep this cash', accountType: 'cash', openingBalanceCents: 5000, openingDate: '2026-01-01' });
  const baseline = store.state();
  const backupDirectory = join(path, '..', 'backups', 'live');
  rmSync(backupDirectory, { recursive: true });
  writeFileSync(backupDirectory, 'Not a directory');
  assert.throws(() => store.restore(backup));
  assert.deepEqual(store.state(), baseline);
});

test('CSV history cannot change a newer confirmed balance twice, and already imported rows still deduplicate', t => {
  const { store, card } = setup(t);
  const rows = [{ date: '2026-01-05', description: 'Existing purchase', amountCents: -1000 }];
  store.command({ type: 'import_rows', accountId: card, rows, requestId: 'old-csv' });
  store.command({ type: 'reconcile', accountId: card, balanceCents: 15000, date: '2026-02-01', note: 'New balance', requestId: 'new-balance' });
  store.command({ type: 'import_rows', accountId: card, rows, requestId: 'old-csv-again' });
  assert.equal(store.state().accounts[0].balanceCents, 15000);
  const baseline = store.state();
  for (const date of ['2026-01-10', '2026-02-01']) assert.throws(() => store.command({ type: 'import_rows', accountId: card, rows: [{ date, description: 'New old purchase', amountCents: -500 }], requestId: `old-row-${date}` }), /complete statement/);
  assert.deepEqual(store.state(), baseline);
  store.command({ type: 'import_rows', accountId: card, rows: [{ date: '2026-02-02', description: 'After statement', amountCents: -500 }], requestId: 'new-row' });
  assert.equal(store.state().accounts[0].balanceCents, 15500);
});

test('statement imports reject existing manual purchases, CSV entries, and incoming card payments without posting duplicates', t => {
  for (const kind of ['manual', 'csv', 'payment']) {
    const { store, card } = setup(t);
    if (kind === 'manual') store.command({ type: 'add_transaction', kind: 'expense', accountId: card, amountCents: 2000, date: '2026-01-02', description: 'Groceries', category: 'Food', requestId: 'manual-purchase' });
    if (kind === 'csv') store.command({ type: 'import_rows', accountId: card, rows: [{ date: '2026-01-02', description: 'Groceries', amountCents: -2000 }], requestId: 'csv-purchase' });
    if (kind === 'payment') {
      const result = store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 50000, openingDate: '2026-01-01' });
      const cash = result.accounts.find(account => account.name === 'Cash')!.id;
      store.command({ type: 'add_transaction', kind: 'debt_payment', accountId: cash, toAccountId: card, amountCents: 1000, date: '2026-01-04', description: 'Payment received', category: 'Card payment', requestId: 'manual-payment' });
    }
    store.command({ type: 'reconcile', accountId: card, balanceCents: 15000, date: '2026-09-01', note: 'Current bank balance', requestId: 'latest-bank-balance' });
    const baseline = store.state();
    assert.throws(() => store.command({ type: 'import_statement', statement: statement(card), requestId: 'ambiguous-statement' }), /already has activity.*not recorded twice/);
    assert.deepEqual(store.state(), baseline);
  }
});

test('statement imports allow opening entries, balance corrections, and activity outside the statement period', t => {
  const { store, card } = setup(t);
  store.command({ type: 'reconcile', accountId: card, balanceCents: 12000, date: '2026-01-15', note: 'Midmonth balance', requestId: 'midmonth-balance' });
  store.command({ type: 'add_transaction', kind: 'expense', accountId: card, amountCents: 500, date: '2026-02-02', description: 'Later purchase', category: 'Food', requestId: 'later-expense' });
  store.command({ type: 'reconcile', accountId: card, balanceCents: 15000, date: '2026-09-01', note: 'Current bank balance', requestId: 'current-bank-balance' });
  store.command({ type: 'import_statement', statement: statement(card), requestId: 'history-after-corrections' });
  assert.equal(store.state().accounts[0].balanceCents, 15000);
  assert.equal(store.state().transactions.filter(tx => tx.kind === 'expense').reduce((sum, tx) => sum + tx.amountCents, 0), 2400);
});

test('adjacent statement balances must agree even when a later reconciliation preserves the current balance', t => {
  for (const reverse of [false, true]) {
    const { store, card } = setup(t);
    store.command({ type: 'reconcile', accountId: card, balanceCents: 15000, date: '2026-09-01', note: 'Current bank balance', requestId: 'current' });
    const january = statement(card);
    const february = { ...january, id: 'february', sha256: 'b'.repeat(64), periodStart: '2026-02-01', periodEnd: '2026-02-28', openingBalanceCents: 20000, closingBalanceCents: 20000, rows: [] };
    store.command({ type: 'import_statement', statement: reverse ? february : january, requestId: 'first' });
    const baseline = store.state();
    assert.throws(() => store.command({ type: 'import_statement', statement: reverse ? january : february, requestId: 'second' }), /Adjacent statements/);
    assert.deepEqual(store.state(), baseline);
  }
});

test('restore rejects inconsistent adjacent statements and future reconciliation dates without changing the current records', t => {
  const { store, card } = setup(t);
  const january = statement(card);
  store.command({ type: 'import_statement', statement: january, requestId: 'january-to-restore' });
  store.command({ type: 'import_statement', statement: { ...january, id: 'february', sha256: 'b'.repeat(64), periodStart: '2026-02-01', periodEnd: '2026-02-28', openingBalanceCents: 10900, closingBalanceCents: 10900, rows: [] }, requestId: 'february-to-restore' });
  const backup = store.export();
  const baseline = store.state();
  const invalidStatements = structuredClone(backup);
  invalidStatements.data.statements![1].openingBalanceCents = 20000;
  invalidStatements.data.statements![1].closingBalanceCents = 20000;
  assert.throws(() => store.restore(invalidStatements), /Adjacent statements/);
  const invalidDate = structuredClone(backup);
  invalidDate.data.accounts.find(account => account.id === card)!.reconciledAt = '2199-01-01';
  assert.throws(() => store.restore(invalidDate), /Reconciliation dates.*future/);
  assert.deepEqual(store.state(), baseline);
});

test('bank evidence keeps its original amount when later activity changes the running balance', t => {
  const { store, card } = setup(t);
  store.command({ type: 'reconcile', accountId: card, balanceCents: 15000, date: '2026-02-01', note: 'Bank snapshot', requestId: 'snapshot' });
  store.command({ type: 'add_transaction', kind: 'expense', accountId: card, amountCents: 1000, date: '2026-02-02', description: 'New purchase', category: 'Food', requestId: 'new-spending' });
  assert.equal(store.state().accounts[0].balanceCents, 16000);
  assert.equal(store.state().accounts[0].evidence!.balanceCents, 15000);
  const backup = store.export();
  store.restore(backup);
  assert.equal(store.state().accounts[0].evidence!.balanceCents, 15000);
  for (const invalid of [-100_000_000_000_001, 0.25, Number.MAX_SAFE_INTEGER]) {
    const broken = structuredClone(backup);
    broken.data.accounts[0].evidence!.balanceCents = invalid;
    assert.throws(() => store.restore(broken), /Source balance/);
  }
});
