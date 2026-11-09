import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { deferTestCleanup, trackTestResource, closeTestResource } from './test-cleanup.ts';
import type { Command, ExpensePlanItem } from '../shared/types.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-plan-items-'));
  deferTestCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'live.sqlite');
  const store = trackTestResource(t, createStore(path, 'live'));
  return { store, path };
}
const item: ExpensePlanItem = { id: 'haircut', entityId: 'personal', categoryId: 'personal:personal', name: 'Haircut', amountCents: 3500, date: '2026-10-01', notes: 'Bring a reference photo.' };

test('plan details preserve money, dates and notes across restart and backup without creating spending', t => {
  const { store, path } = setup(t);
  const create: Command = { type: 'save_expense_plan_item', item, expected: null, requestId: 'new' };
  store.command(create);
  store.command(create);
  const mealPlan: ExpensePlanItem = { ...item, id: 'meals', categoryId: 'personal:food', name: 'Weekday meals', amountCents: null, date: '', notes: 'Monday: rice and chicken\nTuesday: lentil soup' };
  store.command({ type: 'save_expense_plan_item', item: mealPlan, expected: null, requestId: 'meals' });
  assert.deepEqual(store.state().expensePlanItems, [item, mealPlan]);
  assert.equal(store.state().accounts.length, 0);
  assert.equal(store.state().transactions.length, 0);
  const backup = store.export();
  closeTestResource(store);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  assert.deepEqual(reopened.state().expensePlanItems, [item, mealPlan]);
  reopened.restore(backup);
  assert.deepEqual(reopened.state().expensePlanItems, [item, mealPlan]);
  const remove: Command = { type: 'delete_expense_plan_item', id: item.id, expected: item, requestId: 'remove' };
  reopened.command(remove);
  reopened.command(remove);
  assert.deepEqual(reopened.state().expensePlanItems, [mealPlan]);
});

test('plan detail commands reject stale edits, owner moves and invalid category references atomically', t => {
  const { store } = setup(t);
  store.command({ type: 'save_expense_plan_item', item, expected: null, requestId: 'create' });
  const updated = { ...item, amountCents: 4000, notes: 'New price' };
  store.command({ type: 'save_expense_plan_item', item: updated, expected: item, requestId: 'update' });
  store.command({ type: 'add_entity', name: 'Shop', ownershipBps: 10000 });
  const owner = store.state().entities.find(entity => entity.kind === 'business')!.id;
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'save_expense_plan_item', item, expected: item, requestId: 'stale' }), /changed or was removed/);
  assert.throws(() => store.command({ type: 'delete_expense_plan_item', id: item.id, expected: item, requestId: 'stale-delete' }), /changed or was removed/);
  assert.throws(() => store.command({ type: 'save_expense_plan_item', item: { ...updated, entityId: owner, categoryId: `${owner}:personal` }, expected: updated, requestId: 'owner' }), /cannot move/);
  assert.throws(() => store.command({ type: 'save_expense_plan_item', item: { ...updated, id: 'wrong-category', categoryId: `${owner}:food` }, expected: null, requestId: 'category' }), /belonging to this owner/);
  const bad: Partial<ExpensePlanItem>[] = [{ amountCents: -1 }, { amountCents: 0.5 }, { date: '2026-02-30' }, { name: '' }, { entityId: 'missing' }];
  bad.forEach((fields, index) => assert.throws(() => store.command({ type: 'save_expense_plan_item', item: { ...item, id: `bad-${index}`, ...fields }, expected: null, requestId: `bad-${index}` })));
  assert.throws(() => store.command({ type: 'save_expense_plan_item', item, expected: null } as unknown as Command), /request ID/);
  assert.deepEqual(store.state(), baseline);
});

test('old backups load empty plan details and duplicate or orphaned detail restores reject', t => {
  const { store } = setup(t);
  const old = store.export();
  delete old.data.expensePlanItems;
  store.restore(old);
  assert.deepEqual(store.state().expensePlanItems, []);
  store.command({ type: 'save_expense_plan_item', item, expected: null, requestId: 'create' });
  const backup = store.export();
  const duplicate = structuredClone(backup);
  duplicate.data.expensePlanItems!.push(item);
  const baseline = store.state();
  assert.throws(() => store.restore(duplicate), /Duplicate plan item/);
  const orphan = structuredClone(backup);
  orphan.data.expensePlanItems![0].categoryId = 'missing';
  assert.throws(() => store.restore(orphan), /belonging to this owner/);
  assert.deepEqual(store.state(), baseline);
});
