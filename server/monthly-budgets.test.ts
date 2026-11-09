import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from './store.ts';
import { buildExpensePlan } from '../shared/expense-plan.ts';
import { monthlyBudgetCents, selectedLimit, spendingOverview } from '../shared/spending.ts';
import type { SpendingLimit } from '../shared/types.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-monthly-budget-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { store, path, directory };
}
const food: SpendingLimit = { id: 'personal:food', entityId: 'personal', name: 'Food', color: '#112233', aliases: ['Groceries'], dailyCents: 1500, weeklyCents: 9000, monthlyCents: 30000 };
function saveMonth(store: ReturnType<typeof createStore>, month: string, amount: number | null) {
  const state = store.state();
  const limit = state.spendingLimits?.find(limit => limit.id === food.id) ?? food;
  return store.command({ type: 'save_spending_limit', limit: { ...limit, monthlyCents: amount }, budgetMonth: month, expectedRevision: state.revision });
}

test('dated budgets preserve the legacy baseline, other months and account balances through restart and restore', t => {
  const { store, path, directory } = setup(t);
  store.command({ type: 'save_spending_limit', limit: food });
  saveMonth(store, '2026-09', 25000);
  saveMonth(store, '2026-10', 40000);
  const limit = store.state().spendingLimits![0];
  assert.equal(limit.monthlyCents, 30000);
  assert.deepEqual(limit.monthlyAmounts, { '2026-09': 25000, '2026-10': 40000 });
  for (const [month, expected] of [['2026-08', 30000], ['2026-09', 25000], ['2026-10', 40000], ['2026-11', 30000]] as const) {
    assert.equal(buildExpensePlan(store.state(), 'personal', month, '2026-12-01').plannedCents, expected);
    const spending = spendingOverview(store.state(), 'personal', 'monthly', `${month}-15`);
    assert.equal(selectedLimit(spending.rows.find(row => row.limit.id === food.id)!.limit, 'monthly'), expected);
  }
  const backup = store.export();
  store.close();
  const reopened = createStore(path, 'live');
  const restored = createStore(join(directory, 'restored.sqlite'), 'live');
  try {
    assert.deepEqual(reopened.state().spendingLimits![0], limit);
    restored.restore(backup, 0);
    assert.deepEqual(restored.state().spendingLimits![0], limit);
    saveMonth(reopened, '2026-10', 45000);
    assert.equal(monthlyBudgetCents(reopened.state().spendingLimits![0], '2026-09'), 25000);
    assert.equal(reopened.state().spendingLimits![0].weeklyCents, 9000);
    assert.deepEqual(reopened.state().accounts, []);
    assert.deepEqual(reopened.state().transactions, []);
  } finally { reopened.close(); restored.close(); }
});

test('a new monthly category leaves other months unset and explicit zero differs from clearing', t => {
  const { store } = setup(t);
  saveMonth(store, '2026-09', 0);
  let limit = store.state().spendingLimits![0];
  assert.equal(limit.monthlyCents, null);
  assert.equal(monthlyBudgetCents(limit, '2026-08'), null);
  assert.equal(monthlyBudgetCents(limit, '2026-09'), 0);
  assert.equal(buildExpensePlan(store.state(), 'personal', '2026-09').plannedCategoryCount, 1);
  saveMonth(store, '2026-10', 10000);
  saveMonth(store, '2026-09', null);
  limit = store.state().spendingLimits![0];
  assert.equal(monthlyBudgetCents(limit, '2026-09'), null);
  assert.equal(monthlyBudgetCents(limit, '2026-10'), 10000);
  assert.equal(buildExpensePlan(store.state(), 'personal', '2026-09').plannedCategoryCount, 0);
});

test('clearing a saved legacy amount overrides only the selected month', t => {
  const { store } = setup(t);
  store.command({ type: 'save_spending_limit', limit: food });
  saveMonth(store, '2026-10', null);
  const limit = store.state().spendingLimits![0];
  assert.equal(monthlyBudgetCents(limit, '2026-09'), 30000);
  assert.equal(monthlyBudgetCents(limit, '2026-10'), null);
  assert.equal(monthlyBudgetCents(limit, '2026-11'), 30000);
});

test('monthly edits reject stale revisions, invalid history and attempts to replace other months', t => {
  const { store } = setup(t);
  store.command({ type: 'save_spending_limit', limit: food });
  const stale = store.state().revision;
  saveMonth(store, '2026-09', 25000);
  const before = store.state();
  assert.throws(() => store.command({ type: 'save_spending_limit', limit: { ...food, monthlyCents: 90000 }, budgetMonth: '2026-10', expectedRevision: stale }), /changed/);
  assert.throws(() => store.command({ type: 'save_spending_limit', limit: food, budgetMonth: '2026-10' }), /revision/);
  assert.throws(() => store.command({ type: 'save_spending_limit', limit: food }), /budget month/);
  for (const budgetMonth of ['2026-00', '2026-13', '2026-9', 'other']) assert.throws(() => store.command({ type: 'save_spending_limit', limit: food, budgetMonth, expectedRevision: before.revision }), /month/);
  const invalidHistory: Record<string, number | null>[] = [{ '2026-09': -1 }, { '2026-09': 0.5 }, { '2026-13': 100 }];
  for (const monthlyAmounts of invalidHistory) {
    const backup = store.export();
    backup.data.spendingLimits![0].monthlyAmounts = monthlyAmounts;
    assert.throws(() => store.restore(backup, before.revision));
  }
  assert.deepEqual(store.state().spendingLimits, before.spendingLimits);
  store.command({ type: 'save_spending_limit', limit: { ...food, monthlyCents: 50000, monthlyAmounts: { '2026-09': 99999 } }, budgetMonth: '2026-10', expectedRevision: before.revision });
  assert.deepEqual(store.state().spendingLimits![0].monthlyAmounts, { '2026-09': 25000, '2026-10': 50000 });
});
