import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { categoryLimits, transactionCategoryMatcher } from '../shared/expense-categories.ts';
import { reverseCategoryChanges } from '../shared/category-review.ts';
import type { Command, StatementSource } from '../shared/types.ts';

function setup(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-category-history-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const accountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const obligation = store.command({ type: 'add_obligation', entityId: 'personal', accountId, name: 'Internet', amountCents: 1000, dueDate: '2026-01-01', direction: 'out', recurrence: 'monthly', category: 'Digital' }).obligations[0];
  store.command({ type: 'pay_obligation', id: obligation.id, expectedDueDate: obligation.dueDate, requestId: 'payment' });
  const edit = { type: 'update_obligation' as const, id: obligation.id, expectedStatus: 'planned' as const, expectedDueDate: '2026-02-01', name: obligation.name, amountCents: obligation.amountCents, dueDate: '2026-02-01', recurrence: 'monthly' as const, accountId, category: 'Gym', subscription: true, requestId: 'edit' };
  const reportCategory = () => {
    const state = store.state();
    return transactionCategoryMatcher(state, 'personal', categoryLimits(state, 'personal'))(state.transactions.find(tx => tx.kind === 'expense')!).name;
  };
  return { store, edit, reportCategory };
}

test('paid expenses keep their reporting category after subscription changes and backup restore', t => {
  const { store, edit, reportCategory } = setup(t);
  assert.equal(reportCategory(), 'Bills');
  const payment = store.state().transactions.find(tx => tx.kind === 'expense')!;
  assert.equal(payment.expenseCategory, 'Bills');
  store.command(edit);
  assert.equal(reportCategory(), 'Bills');
  assert.deepEqual(store.state().transactions.find(tx => tx.id === payment.id), payment);
  store.restore(store.export());
  assert.equal(reportCategory(), 'Bills');
  store.command({ type: 'categorize_transaction', id: payment.id, expectedCategory: 'Digital', category: 'Gym', requestId: 'correct-category' });
  assert.equal(reportCategory(), 'Personal');
  assert.equal(store.state().transactions.find(tx => tx.id === payment.id)!.expenseCategory, 'Gym');
});

test('editing a legacy planned payment snapshots its old reporting category before changing the plan', t => {
  const { store, edit, reportCategory } = setup(t);
  const legacy = store.export();
  for (const transaction of legacy.data.transactions) delete transaction.expenseCategory;
  store.restore(legacy);
  assert.equal(reportCategory(), 'Bills');
  store.command(edit);
  assert.equal(reportCategory(), 'Bills');
  assert.equal(store.state().transactions.find(tx => tx.kind === 'expense')!.expenseCategory, 'Bills');
});

test('backup validation rejects report categories on income and malformed category snapshots', t => {
  const { store } = setup(t);
  for (const badCategory of [123, 'x'.repeat(101)]) {
    const backup = store.export();
    (backup.data.transactions.find(tx => tx.kind === 'expense')! as unknown as Record<string, unknown>).expenseCategory = badCategory;
    const before = store.state();
    assert.throws(() => store.restore(backup), /Expense category/);
    assert.deepEqual(store.state(), before);
  }
  const backup = store.export();
  backup.data.transactions.find(tx => tx.kind === 'opening')!.expenseCategory = 'Bills';
  assert.throws(() => store.restore(backup), /Only expenses/);
});

test('category batch undo restores the saved reporting category and rejects a stale snapshot', t => {
  const { store, edit, reportCategory } = setup(t);
  store.command(edit);
  const payment = store.state().transactions.find(tx => tx.kind === 'expense')!;
  const changes = [{ id: payment.id, expectedCategory: payment.category, category: 'Gym', expectedExpenseCategory: payment.expenseCategory!, expenseCategory: 'Gym' }];
  store.command({ type: 'categorize_transactions', changes, expectedRevision: store.state().revision, requestId: 'batch-correction' });
  assert.equal(reportCategory(), 'Personal');
  store.command({ type: 'categorize_transactions', changes: reverseCategoryChanges(changes), expectedRevision: store.state().revision, requestId: 'batch-undo' });
  assert.equal(reportCategory(), 'Bills');
  assert.deepEqual(store.state().transactions.find(tx => tx.id === payment.id), payment);
  const before = store.state();
  assert.throws(() => store.command({ type: 'categorize_transactions', changes: [{ ...changes[0], expectedExpenseCategory: 'Subscriptions' }], expectedRevision: before.revision, requestId: 'stale-category-snapshot' }), /reporting category changed/);
  assert.deepEqual(store.state(), before);
});

function recordedPayment(t: { after: (cleanup: () => void) => void }, source: 'manual' | 'statement', category = 'Digital') {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-linked-category-history-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (input: Command) => store.command({ ...input, expectedRevision: store.state().revision });
  const accountId = command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const bill = command({ type: 'add_obligation', entityId: 'personal', accountId, name: 'Streaming', amountCents: 1000, dueDate: '2026-01-10', direction: 'out', recurrence: 'monthly', category: 'Digital', subscription: true, requestId: 'bill' }).obligations[0];
  if (source === 'manual') {
    command({ type: 'add_transaction', kind: 'expense', accountId, amountCents: 1000, date: '2026-01-10', description: 'Streaming', category, requestId: 'record' });
  } else {
    const statement: StatementSource = { id: 'january', accountId, sourceFile: 'Synthetic January.csv', sha256: 'a'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 9000, rows: [{ id: 'streaming', transactionDate: '2026-01-10', postingDate: '2026-01-11', description: 'STREAMING ORIGINAL', amountCents: -1000, sourcePage: 1 }] };
    command({ type: 'stage_statement', statement, requestId: 'stage' });
    command({ type: 'review_statement', importId: statement.id, decisions: [{ rowId: 'streaming', kind: 'expense', category }], requestId: 'review' });
    command({ type: 'commit_statements', importIds: [statement.id], requestId: 'commit' });
  }
  const original = store.state().transactions.find(tx => tx.kind === 'expense')!;
  const payment = () => store.state().transactions.find(tx => tx.id === original.id)!;
  const match = () => command({ type: 'pay_obligation', id: bill.id, expectedDueDate: bill.dueDate, transactionId: original.id, requestId: 'match' });
  const edit = () => command({ type: 'update_obligation', id: bill.id, expectedStatus: 'planned', expectedDueDate: '2026-02-10', name: bill.name, amountCents: bill.amountCents, dueDate: '2026-02-10', recurrence: 'monthly', accountId, category: 'Digital', subscription: false, requestId: 'edit' });
  const reportCategory = () => { const state = store.state(); return transactionCategoryMatcher(state, 'personal', categoryLimits(state, 'personal'))(payment()).name; };
  return { store, command, bill, original, payment, match, edit, reportCategory };
}

for (const source of ['manual', 'statement'] as const) {
  for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'new'} linked ${source} payments keep their category when the bill changes`, t => {
    const { store, bill, original, payment, match, edit, reportCategory } = recordedPayment(t, source);
    const before = store.export().data;
    match();
    if (legacy) {
      const backup = store.export();
      delete backup.data.transactions.find(tx => tx.id === original.id)!.expenseCategory;
      store.restore(backup);
    } else {
      assert.equal(payment().expenseCategory, 'Subscriptions');
    }
    assert.equal(reportCategory(), 'Subscriptions');
    edit();
    assert.equal(reportCategory(), 'Subscriptions');
    assert.deepEqual(payment(), { ...original, expenseCategory: 'Subscriptions', plannedPayment: { obligationId: bill.id, dueDate: bill.dueDate } });
    const after = store.export().data;
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.accounts, before.accounts);
    assert.deepEqual(after.importBatches, before.importBatches);
    assert.deepEqual(after.statements, before.statements);
    store.restore(store.export());
    assert.equal(reportCategory(), 'Subscriptions');
  });

  for (const explicit of [false, true]) test(`linked ${source} payments preserve ${explicit ? 'explicit reporting' : 'different transaction'} category choices`, t => {
    const { command, original, payment, match, edit, reportCategory } = recordedPayment(t, source, explicit ? 'Digital' : 'Career');
    if (explicit) command({ type: 'categorize_transaction', id: original.id, expectedCategory: 'Digital', category: 'Digital', expenseCategory: 'Digital', requestId: 'override' });
    const expected = explicit ? 'Digital' : 'Career';
    match();
    assert.equal(reportCategory(), expected);
    edit();
    assert.equal(reportCategory(), expected);
    assert.equal(payment().expenseCategory, expected);
  });
}

test('an explicit category choice overrides a legacy linked payment even when its raw category is unchanged', t => {
  const { store, command, original, match, reportCategory } = recordedPayment(t, 'manual');
  match();
  const backup = store.export();
  delete backup.data.transactions.find(tx => tx.id === original.id)!.expenseCategory;
  store.restore(backup);
  assert.equal(reportCategory(), 'Subscriptions');
  command({ type: 'categorize_transaction', id: original.id, expectedCategory: 'Digital', category: 'Digital', requestId: 'override' });
  assert.equal(reportCategory(), 'Digital');
});
