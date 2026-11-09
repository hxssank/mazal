import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DailyPlan } from '../shared/engine.ts';
import type { Command } from '../shared/types.ts';
import { engineFixtureResult } from '../src/engine-test-fixture.ts';
import { createStore } from './store.ts';

function setup(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-payment-occurrence-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const cash = store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 600000, openingDate: '2026-01-01' }).accounts[0];
  store.command({ type: 'update_living_costs', monthlyEssentialsCents: 300000 });
  store.command({ type: 'update_planning_reserve', amountCents: 0 });
  const rent = store.command({ type: 'add_obligation', entityId: 'personal', name: 'Rent', amountCents: 150000, dueDate: '2026-09-01', direction: 'out', recurrence: 'monthly', accountId: cash.id, category: 'Housing' }).obligations[0];
  const project = (current = store) => engineFixtureResult(current.state(), 'personal', '2026-10-01', 'daily_plan', { days: 31 }) as DailyPlan;
  return { store, path, rent, project };
}

test('paying September rent in October preserves the October allowance across payment, restart and restore', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12).getTime() });
  const { store, path, rent, project } = setup(t);
  const before = project();
  assert.equal(before.livingCostsCents, 150000);
  assert.equal(before.cashAfterKnownCents, 150000);
  store.command({ type: 'pay_obligation', id: rent.id, expectedDueDate: '2026-09-01', requestId: 'pay-september' });
  const after = project();
  assert.equal(store.state().accounts[0].balanceCents, 450000);
  assert.equal(store.state().obligations[0].dueDate, '2026-10-01');
  assert.deepEqual(store.state().transactions.find(row => row.kind === 'expense')?.plannedPayment, { obligationId: rent.id, dueDate: '2026-09-01' });
  assert.equal(after.livingCostsCents, before.livingCostsCents);
  assert.equal(after.cashAfterKnownCents, before.cashAfterKnownCents);
  store.command({ type: 'pay_obligation', id: rent.id, expectedDueDate: '2026-10-01', requestId: 'pay-october' });
  assert.equal(project().cashAfterKnownCents, before.cashAfterKnownCents);
  assert.equal(project().livingCostsCents, 150000);
  const backup = store.export();
  store.close();
  const reopened = createStore(path, 'live');
  t.after(() => reopened.close());
  assert.equal(project(reopened).cashAfterKnownCents, before.cashAfterKnownCents);
  reopened.restore(backup);
  assert.deepEqual(reopened.state().transactions.filter(row => row.kind === 'expense').map(row => row.plannedPayment?.dueDate).sort(), ['2026-09-01', '2026-10-01']);
  assert.equal(project(reopened).livingCostsCents, before.livingCostsCents);
});

test('restore validates occurrence references while old payments remain readable without an invented billing month', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 1, 12).getTime() });
  const { store, rent, project } = setup(t);
  store.command({ type: 'pay_obligation', id: rent.id, expectedDueDate: '2026-09-01', requestId: 'september' });
  store.command({ type: 'pay_obligation', id: rent.id, expectedDueDate: '2026-10-01', requestId: 'october' });
  const backup = store.export();
  const before = store.state();
  const invalidDate = structuredClone(backup);
  invalidDate.data.transactions.find(row => row.plannedPayment)!.plannedPayment!.dueDate = '2026-02-30';
  assert.throws(() => store.restore(invalidDate), /Original payment due date/);
  const invalidSource = structuredClone(backup);
  invalidSource.data.transactions.find(row => row.plannedPayment)!.plannedPayment!.obligationId = 'unrelated';
  assert.throws(() => store.restore(invalidSource), /match an obligation belonging/);
  const duplicate = structuredClone(backup);
  duplicate.data.transactions.filter(row => row.plannedPayment).forEach(row => { row.plannedPayment!.dueDate = '2026-09-01'; });
  assert.throws(() => store.restore(duplicate), /cannot be recorded twice/);
  assert.deepEqual(store.state(), before);
  const legacy = structuredClone(backup);
  legacy.data.transactions.forEach(row => { delete row.plannedPayment; });
  store.restore(legacy);
  assert.equal(project().livingCostsCents, 300000);
  assert.equal(project().cashAfterKnownCents, 0);
  assert.equal(project().missingInputs.filter(row => row.field.endsWith('.plannedPayment')).length, 2);
});

for (const direction of ['in', 'out'] as const) for (const scenario of [
  { recurrence: 'monthly', first: '2026-02-28', second: '2026-04-30', earlier: '2026-01-31', gap: '2026-03-31', next: '2026-05-31' },
  { recurrence: 'biweekly', first: '2026-10-02', second: '2026-10-30', earlier: '2026-09-18', gap: '2026-10-16', next: '2026-11-13' },
] as const) {
  test(`${direction} ${scenario.recurrence} catch-up skips recorded dates and stops at each unpaid occurrence`, t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 16, 12).getTime() });
    const { store, path } = setup(t);
    const cash = store.state().accounts[0];
    const schedule = store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash.id, name: 'Catch-up', direction, amountCents: 5000, dueDate: scenario.first, recurrence: scenario.recurrence, category: 'Bills' }).obligations.at(-1)!;
    function move(dueDate: string): void {
      const current = store.state().obligations.find(row => row.id === schedule.id)!;
      store.command({ type: 'update_obligation', id: current.id, expectedDueDate: current.dueDate, expectedStatus: 'planned', name: current.name, amountCents: current.amountCents, dueDate, recurrence: current.recurrence, accountId: cash.id, category: current.category, requestId: `move-${dueDate}` });
    }
    const pay = (dueDate: string): Command => ({ type: 'pay_obligation', id: schedule.id, expectedDueDate: dueDate, date: '2026-10-15', requestId: `pay-${dueDate}` });
    store.command(pay(scenario.first));
    move(scenario.second);
    store.command(pay(scenario.second));
    const recorded = store.state().transactions.filter(row => row.plannedPayment);
    move(scenario.earlier);
    store.command(pay(scenario.earlier));
    assert.equal(store.state().obligations.find(row => row.id === schedule.id)?.dueDate, scenario.gap);
    store.command(pay(scenario.gap));
    const after = store.state();
    assert.equal(after.obligations.find(row => row.id === schedule.id)?.dueDate, scenario.next);
    assert.equal(after.accounts[0].balanceCents, cash.balanceCents + (direction === 'in' ? 20000 : -20000));
    assert.deepEqual(after.transactions.filter(row => recorded.some(previous => previous.id === row.id)), recorded);
    assert.deepEqual(after.transactions.filter(row => row.plannedPayment).map(row => row.plannedPayment!.dueDate).sort(), [scenario.first, scenario.second, scenario.earlier, scenario.gap].sort());
    store.command(pay(scenario.gap));
    assert.deepEqual(store.state(), after);
    const backup = store.export();
    store.close();
    const reopened = createStore(path, 'live');
    t.after(() => reopened.close());
    assert.deepEqual(reopened.state().obligations, after.obligations);
    reopened.restore(backup);
    assert.deepEqual(reopened.state().transactions, after.transactions);
  });
}

test('catch-up skips a fully refunded occurrence without treating its refund as another payment', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 16, 12).getTime() });
  const { store, rent } = setup(t);
  const cash = store.state().accounts[0];
  store.command({ type: 'update_obligation', id: rent.id, expectedDueDate: rent.dueDate, expectedStatus: 'planned', name: rent.name, amountCents: rent.amountCents, dueDate: '2026-10-01', recurrence: 'monthly', accountId: cash.id, category: rent.category, requestId: 'october-first' });
  store.command({ type: 'pay_obligation', id: rent.id, expectedDueDate: '2026-10-01', requestId: 'pay-october' });
  const paid = store.state().transactions.find(row => row.plannedPayment)!;
  store.command({ type: 'record_refund', id: paid.id, accountId: cash.id, amountCents: paid.amountCents, date: '2026-10-16', reason: 'Refunded October payment', expectedRevision: store.state().revision, requestId: 'refund-october' });
  store.command({ type: 'update_obligation', id: rent.id, expectedDueDate: '2026-11-01', expectedStatus: 'planned', name: rent.name, amountCents: rent.amountCents, dueDate: '2026-09-01', recurrence: 'monthly', accountId: cash.id, category: rent.category, requestId: 'september-catch-up' });
  store.command({ type: 'pay_obligation', id: rent.id, expectedDueDate: '2026-09-01', requestId: 'pay-september' });
  assert.equal(store.state().obligations[0].dueDate, '2026-11-01');
  assert.equal(store.state().accounts[0].balanceCents, 450000);
  assert.equal(store.state().transactions.filter(row => row.plannedPayment).length, 2);
  assert.equal(store.state().transactions.filter(row => row.refundOf === paid.id).length, 1);
});
