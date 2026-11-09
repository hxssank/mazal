import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { deferTestCleanup, trackTestResource, closeTestResource } from './test-cleanup.ts';
import type { Command, ExpenseFund, RoadmapSettings } from '../shared/types.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-fund-test-'));
  deferTestCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'live.sqlite');
  const store = trackTestResource(t, createStore(path, 'live'));
  return { store, path };
}

const fund: ExpenseFund = { id: 'car-fund', entityId: 'personal', name: 'Car maintenance', targetCents: 100000, savedCents: 0, targetDate: '2027-06-01' };

test('cost targets save progress without accounts and persist across restart and backup restore', t => {
  const { store, path } = setup(t);
  const save: Command = { type: 'save_expense_fund', fund, expected: null, requestId: 'create-fund' };
  store.command(save);
  store.command(save);
  assert.deepEqual(store.state().expenseFunds, [fund]);
  assert.equal(store.state().accounts.length, 0);
  assert.equal(store.state().transactions.length, 0);
  assert.equal(store.state().reserves.length, 0);
  const progressed = { ...fund, savedCents: 125000 };
  store.command({ type: 'save_expense_fund', fund: progressed, expected: fund, requestId: 'update-progress' });
  assert.deepEqual(store.state().expenseFunds, [progressed]);
  const backup = store.export();
  closeTestResource(store);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  assert.deepEqual(reopened.state().expenseFunds, [progressed]);
  reopened.restore(backup);
  assert.deepEqual(reopened.state().expenseFunds, [progressed]);
  const remove: Command = { type: 'delete_expense_fund', id: fund.id, expected: progressed, requestId: 'delete-fund' };
  reopened.command(remove);
  reopened.command(remove);
  assert.deepEqual(reopened.state().expenseFunds, []);
  assert.equal(reopened.state().transactions.length, 0);
});

test('fund saves and removal leave account balances, reserves and recorded transactions unchanged', t => {
  const { store } = setup(t);
  store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 50000, openingDate: '2026-01-01' });
  store.command({ type: 'add_reserve', entityId: 'personal', name: 'Existing reserve', amountCents: 10000 });
  const baseline = store.state();
  store.command({ type: 'save_expense_fund', fund: { ...fund, savedCents: 25000 }, expected: null, requestId: 'save-no-cash-movement' });
  const updated = store.state();
  assert.deepEqual(updated.accounts, baseline.accounts);
  assert.deepEqual(updated.transactions, baseline.transactions);
  assert.deepEqual(updated.reserves, baseline.reserves);
  const saved = updated.expenseFunds![0];
  store.command({ type: 'delete_expense_fund', id: saved.id, expected: saved, requestId: 'remove-no-cash-movement' });
  assert.deepEqual(store.state().accounts, baseline.accounts);
  assert.deepEqual(store.state().reserves, baseline.reserves);
});

test('stale editors cannot overwrite progress, remove newer progress, or recreate a removed target', t => {
  const { store } = setup(t);
  store.command({ type: 'save_expense_fund', fund, expected: null, requestId: 'new' });
  const progressed = { ...fund, savedCents: 30000 };
  store.command({ type: 'save_expense_fund', fund: progressed, expected: fund, requestId: 'progress' });
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'save_expense_fund', fund: { ...fund, targetCents: 200000 }, expected: fund, requestId: 'stale-save' }), /changed or was removed/);
  assert.throws(() => store.command({ type: 'delete_expense_fund', id: fund.id, expected: fund, requestId: 'stale-delete' }), /changed or was removed/);
  assert.throws(() => store.command({ type: 'save_expense_fund', fund, expected: null, requestId: 'id-collision' }), /already exists/);
  assert.deepEqual(store.state(), baseline);
  store.command({ type: 'delete_expense_fund', id: fund.id, expected: progressed, requestId: 'delete-current' });
  assert.throws(() => store.command({ type: 'save_expense_fund', fund, expected: progressed, requestId: 'recreate-stale' }), /changed or was removed/);
  assert.deepEqual(store.state().expenseFunds, []);
});

test('fund owners are immutable and malformed IDs, amounts, names and dates fail atomically', t => {
  const { store } = setup(t);
  store.command({ type: 'save_expense_fund', fund, expected: null, requestId: 'valid' });
  store.command({ type: 'add_entity', name: 'Business', ownershipBps: 10000 });
  const businessId = store.state().entities.find(entity => entity.name === 'Business')!.id;
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'save_expense_fund', fund: { ...fund, entityId: businessId }, expected: fund, requestId: 'move-owner' }), /cannot move/);
  const invalid: Partial<ExpenseFund>[] = [{ id: '../fund' }, { id: '' }, { name: '' }, { entityId: 'missing' }, { targetCents: 0 }, { savedCents: -1 }, { targetCents: 0.5 }, { targetCents: Number.MAX_SAFE_INTEGER }, { savedCents: NaN }, { targetDate: '2026-02-30' }, { targetDate: '2201-01-01' }];
  invalid.forEach((fields, index) => assert.throws(() => store.command({ type: 'save_expense_fund', fund: { ...fund, id: `invalid-${index}`, ...fields }, expected: null, requestId: `invalid-request-${index}` })));
  assert.throws(() => store.command({ type: 'save_expense_fund', fund: { ...fund, id: 'no-request' }, expected: null } as unknown as Command), /request ID/);
  assert.deepEqual(store.state(), baseline);
});

test('old backups load empty targets and malformed or duplicate fund backups reject before replacement', t => {
  const { store } = setup(t);
  const old = store.export();
  delete old.data.expenseFunds;
  store.restore(old);
  assert.deepEqual(store.state().expenseFunds, []);
  store.command({ type: 'save_expense_fund', fund, expected: null, requestId: 'valid-backup-fund' });
  const duplicate = store.export();
  duplicate.data.expenseFunds!.push({ ...fund });
  const baseline = store.state();
  assert.throws(() => store.restore(duplicate), /Duplicate cost target IDs/);
  const invalid = structuredClone(duplicate);
  invalid.data.expenseFunds = [{ ...fund, entityId: 'missing' }];
  assert.throws(() => store.restore(invalid), /missing owner/);
  assert.deepEqual(store.state(), baseline);
});

test('one-time bills, monthly bills and expected income can be planned without cash accounts', t => {
  const { store, path } = setup(t);
  const cases = [{ name: 'Tuition', direction: 'out', recurrence: 'once' }, { name: 'Rent', direction: 'out', recurrence: 'monthly' }, { name: 'Payday', direction: 'in', recurrence: 'biweekly' }] as const;
  for (const item of cases) store.command({ type: 'add_obligation', entityId: 'personal', accountId: '', name: item.name, amountCents: 10000, dueDate: '2026-10-01', direction: item.direction, recurrence: item.recurrence, category: 'Planning', requestId: item.name });
  assert.equal(store.state().obligations.length, 3);
  assert.equal(store.state().accounts.length, 0);
  for (const item of store.state().obligations) assert.throws(() => store.command({ type: 'pay_obligation', id: item.id, expectedDueDate: item.dueDate, requestId: `pay-${item.id}` }), /Choose a payment account before recording this payment/);
  const tuition = store.state().obligations[0];
  store.command({ type: 'update_obligation', id: tuition.id, expectedDueDate: tuition.dueDate, expectedStatus: 'planned', name: tuition.name, amountCents: 20000, dueDate: '2026-11-01', recurrence: tuition.recurrence, accountId: '', category: tuition.category, requestId: 'edit-unlinked-tuition' });
  const expected = store.state().obligations;
  const backup = store.export();
  closeTestResource(store);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  assert.deepEqual(reopened.state().obligations, expected);
  reopened.restore(backup);
  assert.deepEqual(reopened.state().obligations, expected);
  assert.equal(reopened.state().accounts.length, 0);
  assert.equal(reopened.state().transactions.length, 0);
});

test('a stale pay schedule save preserves the latest family payment and unrelated roadmap settings', t => {
  const { store } = setup(t);
  const initial: RoadmapSettings = { currentMonthlyIncomeCents: 400000, partTimeMonthlyIncomeCents: 100000, monthlyEssentialsCents: 50000, monthlyDebtMinimumsCents: 10000, transitionDate: '2027-01-01', transitionMonths: 12, monthlyExtraDebtCents: 20000, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, monthlyFamilyPaymentCents: 30000, familyPaymentNote: 'Old note', payAmountCents: 200000, payEveryDays: 14, paydayAnchor: '2026-09-24' };
  store.command({ type: 'save_roadmap', settings: initial });
  const staleClient = structuredClone(store.state().roadmap!);
  const current = { ...initial, monthlyFamilyPaymentCents: 45000, familyPaymentNote: 'Confirmed this week', monthlyEssentialsCents: 80000, transitionMonths: 18 };
  store.command({ type: 'save_roadmap', settings: current });
  store.command({ ...staleClient, type: 'update_pay_schedule', payAmountCents: 220000, payEveryDays: 7, paydayAnchor: '2026-10-02' });
  assert.deepEqual(store.state().roadmap, { ...current, payAmountCents: 220000, payEveryDays: 7, paydayAnchor: '2026-10-02' });
  assert.equal(store.state().transactions.length, 0);
  assert.equal(store.state().accounts.length, 0);
});

test('pay schedule updates use unknown defaults and validate fields without partial changes', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const { store } = setup(t);
  const command = { type: 'update_pay_schedule', payAmountCents: 200000, payEveryDays: 14, paydayAnchor: '2026-09-24' } as const;
  store.command(command);
  assert.deepEqual(store.state().roadmap, { incomeTransitionPlanned: false, currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: '2026-09-23', transitionMonths: 1, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, payAmountCents: 200000, payEveryDays: 14, paydayAnchor: '2026-09-24' });
  const baseline = store.state();
  assert.throws(() => store.command({ ...command, payAmountCents: 0 }), /Pay amount/);
  assert.throws(() => store.command({ ...command, payEveryDays: 367 }), /Days between paydays/);
  assert.throws(() => store.command({ ...command, paydayAnchor: '2026-02-30' }), /valid YYYY-MM-DD/);
  assert.deepEqual(store.state(), baseline);
});

test('living cost updates preserve the current pay schedule, unrelated roadmap fields and money records', t => {
  const { store } = setup(t);
  store.command({ type: 'update_pay_schedule', payAmountCents: 220000, payEveryDays: 14, paydayAnchor: '2026-10-02' });
  const before = store.state();
  store.command({ type: 'update_living_costs', monthlyEssentialsCents: 135000, expectedRevision: before.revision });
  const after = store.state();
  assert.deepEqual(after.roadmap, { ...before.roadmap, monthlyEssentialsCents: 135000 });
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.accounts, before.accounts);
  assert.equal(after.revision, before.revision + 1);
  assert.throws(() => store.command({ type: 'update_living_costs', monthlyEssentialsCents: 150000, expectedRevision: before.revision }), /changed|revision|refresh/i);
  assert.deepEqual(store.state(), after);
});

test('living costs keep explicit zero distinct from unknown and reject invalid amounts atomically', t => {
  const { store } = setup(t);
  store.command({ type: 'update_living_costs', monthlyEssentialsCents: 0 });
  assert.equal(store.state().roadmap?.monthlyEssentialsCents, 0);
  assert.equal(store.state().roadmap?.payAmountCents, undefined);
  store.command({ type: 'update_living_costs', monthlyEssentialsCents: null });
  assert.equal(store.state().roadmap?.monthlyEssentialsCents, null);
  const before = store.state();
  for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, undefined, '100']) {
    assert.throws(() => store.command({ type: 'update_living_costs', monthlyEssentialsCents: amount } as unknown as Command), /Monthly living costs/);
    assert.deepEqual(store.state(), before);
  }
});

test('planning cash floor preserves named reserves and survives save, restart and backup', t => {
  const { store, path } = setup(t);
  store.command({ type: 'add_reserve', entityId: 'personal', name: 'Rent', amountCents: 100000 });
  store.command({ type: 'update_living_costs', monthlyEssentialsCents: 200000 });
  const before = store.state();
  store.command({ type: 'update_planning_reserve', amountCents: 0, expectedRevision: before.revision });
  assert.deepEqual(store.state().roadmap, { ...before.roadmap, planningCashReserveCents: 0 });
  assert.deepEqual(store.state().reserves, before.reserves);
  const backup = store.export();
  closeTestResource(store);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  assert.equal(reopened.state().roadmap?.planningCashReserveCents, 0);
  reopened.restore(backup);
  assert.equal(reopened.state().roadmap?.planningCashReserveCents, 0);
  reopened.command({ type: 'update_planning_reserve', amountCents: null });
  assert.equal(reopened.state().roadmap?.planningCashReserveCents, null);
  const current = reopened.state();
  for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, undefined, '0']) {
    assert.throws(() => reopened.command({ type: 'update_planning_reserve', amountCents: amount } as unknown as Command), /Protected cash reserve/);
    assert.deepEqual(reopened.state(), current);
  }
});

test('new planning settings do not invent an income transition, and a confirmed current pay can resolve a past one', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 28, 12).getTime() });
  const { store } = setup(t);
  store.command({ type: 'update_living_costs', monthlyEssentialsCents: 100000 });
  assert.equal(store.state().roadmap?.incomeTransitionPlanned, false);
  store.command({ type: 'save_roadmap', settings: { ...store.state().roadmap!, transitionDate: '2026-09-01', incomeTransitionPlanned: true } });
  store.command({ type: 'update_pay_schedule', payAmountCents: 100000, payEveryDays: 14, paydayAnchor: '2026-09-25', resolveIncomeTransition: true });
  assert.equal(store.state().roadmap?.incomeTransitionPlanned, false);
  const current = store.state();
  assert.throws(() => store.command({ type: 'update_pay_schedule', payAmountCents: 100000, payEveryDays: 14, paydayAnchor: '2026-08-25', resolveIncomeTransition: true }), /on or after/);
  assert.deepEqual(store.state(), current);
});

test('additional income is explicit, validated, preserved by edits, and persisted in backups', t => {
  const { store, path } = setup(t);
  store.command({ type: 'add_obligation', entityId: 'personal', name: 'Side work', amountCents: 20000, dueDate: '2026-10-01', direction: 'in', recurrence: 'monthly', accountId: '', category: 'Income', additionalToPay: true });
  const income = store.state().obligations[0];
  assert.equal(income.additionalToPay, true);
  store.command({ type: 'update_obligation', id: income.id, expectedDueDate: income.dueDate, expectedStatus: 'planned', name: 'Updated side work', amountCents: 30000, dueDate: income.dueDate, recurrence: income.recurrence, accountId: '', category: 'Income', requestId: 'update-income' });
  assert.equal(store.state().obligations[0].additionalToPay, true);
  const before = store.state();
  assert.throws(() => store.command({ type: 'add_obligation', entityId: 'personal', name: 'Bill', amountCents: 20000, dueDate: '2026-10-01', direction: 'out', recurrence: 'once', accountId: '', category: 'Bills', additionalToPay: true }), /Only incoming/);
  assert.throws(() => store.command({ type: 'add_obligation', entityId: 'personal', name: 'Bad income', amountCents: 20000, dueDate: '2026-10-01', direction: 'in', recurrence: 'once', accountId: '', category: 'Income', additionalToPay: 'true' } as unknown as Command), /true or false/);
  assert.deepEqual(store.state(), before);
  const backup = store.export();
  closeTestResource(store);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  assert.equal(reopened.state().obligations[0].additionalToPay, true);
  reopened.restore(backup);
  assert.equal(reopened.state().obligations[0].additionalToPay, true);
});
