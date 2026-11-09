import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from '../shared/types.ts';
import { createStore } from './store.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-growth-target-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}

test('the growth target starts unset and can be saved without inventing financial inputs', t => {
  const { store } = setup(t);
  const before = store.state();
  assert.equal(before.roadmap?.growthTarget, undefined);
  const state = store.command({ type: 'update_growth_target', target: 'lifetime_compounding', requestId: 'save-target', expectedRevision: before.revision });
  assert.equal(state.roadmap!.growthTarget, 'lifetime_compounding');
  assert.equal(state.roadmap!.monthlyEssentialsCents, null);
  assert.equal(state.roadmap!.payAmountCents, undefined);
  assert.equal(state.roadmap!.planningCashReserveCents, undefined);
  assert.deepEqual(state.accounts, before.accounts);
  assert.deepEqual(state.transactions, before.transactions);
});

test('saving and clearing the target preserve pay, living costs, reserves, and committed payments', t => {
  const { store } = setup(t);
  store.command({ type: 'update_pay_schedule', payAmountCents: 250000, payEveryDays: 14, paydayAnchor: '2026-01-02' });
  store.command({ type: 'update_living_costs', monthlyEssentialsCents: 150000 });
  store.command({ type: 'update_planning_reserve', amountCents: 300000 });
  const accounts = store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 400000, openingDate: '2026-01-01' }).accounts;
  store.command({ type: 'add_obligation', entityId: 'personal', name: 'Committed payment', accountId: accounts[0].id, amountCents: 10000, dueDate: '2026-01-10', direction: 'out', recurrence: 'monthly', category: 'Bills', requestId: 'add-payment' });
  const before = store.state();
  const saved = store.command({ type: 'update_growth_target', target: 'lifetime_compounding', requestId: 'save-target', expectedRevision: before.revision });
  assert.deepEqual(saved.roadmap, { ...before.roadmap, growthTarget: 'lifetime_compounding' });
  assert.deepEqual(saved.accounts, before.accounts);
  assert.deepEqual(saved.transactions, before.transactions);
  assert.deepEqual(saved.obligations, before.obligations);
  const cleared = store.command({ type: 'update_growth_target', target: null, requestId: 'clear-target', expectedRevision: saved.revision });
  assert.deepEqual(cleared.roadmap, { ...before.roadmap, growthTarget: null });
  assert.deepEqual(cleared.obligations, before.obligations);
});

test('the target survives restart, backup restore, and later planning edits', t => {
  const { store, path } = setup(t);
  store.command({ type: 'update_growth_target', target: 'lifetime_compounding', requestId: 'save-target', expectedRevision: store.state().revision });
  const backup = store.export();
  store.close();
  const reopened = createStore(path, 'live');
  try {
    assert.equal(reopened.state().roadmap!.growthTarget, 'lifetime_compounding');
    reopened.command({ type: 'update_pay_schedule', payAmountCents: 250000, payEveryDays: 14, paydayAnchor: '2026-01-02' });
    reopened.command({ type: 'update_living_costs', monthlyEssentialsCents: 150000 });
    reopened.command({ type: 'update_planning_reserve', amountCents: 300000 });
    assert.equal(reopened.state().roadmap!.growthTarget, 'lifetime_compounding');
    reopened.command({ type: 'update_growth_target', target: null, requestId: 'clear-target', expectedRevision: reopened.state().revision });
    reopened.restore(backup, reopened.state().revision);
    assert.equal(reopened.state().roadmap!.growthTarget, 'lifetime_compounding');
  } finally { reopened.close(); }
});

test('target retries are idempotent across restart and reject changed payloads', t => {
  const { store, path } = setup(t);
  const command = { type: 'update_growth_target', target: 'lifetime_compounding', requestId: 'save-target', expectedRevision: store.state().revision } as const;
  const saved = store.command(command);
  assert.deepEqual(store.command(command), saved);
  assert.throws(() => store.command({ ...command, target: null }), /different operation/);
  store.close();
  const reopened = createStore(path, 'live');
  try {
    assert.deepEqual(reopened.command(command), saved);
    assert.throws(() => reopened.command({ ...command, target: null }), /different operation/);
  } finally { reopened.close(); }
});

test('invalid targets and missing or stale command metadata leave state unchanged', t => {
  const { store } = setup(t);
  const before = store.state();
  for (const target of [undefined, '', 'fastest_return', false, 1, {}]) {
    assert.throws(() => store.command({ type: 'update_growth_target', target, requestId: 'invalid-target', expectedRevision: before.revision } as unknown as Command), /Growth target/);
    assert.deepEqual(store.state(), before);
  }
  assert.throws(() => store.command({ type: 'update_growth_target', target: 'lifetime_compounding', expectedRevision: before.revision } as unknown as Command), /request ID/);
  assert.throws(() => store.command({ type: 'update_growth_target', target: 'lifetime_compounding', requestId: 'missing-revision' }), /current workspace revision/);
  assert.throws(() => store.command({ type: 'update_growth_target', target: 'lifetime_compounding', requestId: 'stale-revision', expectedRevision: before.revision + 1 }), /changed|revision/i);
  assert.deepEqual(store.state(), before);
});

test('roadmap and backup validation reject unsupported growth targets', t => {
  const { store } = setup(t);
  store.command({ type: 'update_growth_target', target: 'lifetime_compounding', requestId: 'save-target', expectedRevision: store.state().revision });
  const backup = store.export();
  const before = store.state();
  assert.throws(() => store.command({ type: 'save_roadmap', settings: { ...before.roadmap!, growthTarget: 'speculation' } } as unknown as Command), /Growth target/);
  const invalid = structuredClone(backup) as unknown as { data: { roadmap: { growthTarget: string } } };
  invalid.data.roadmap.growthTarget = 'speculation';
  assert.throws(() => store.restore(invalid, before.revision), /Growth target/);
  assert.deepEqual(store.state(), before);
});

test('target changes return the updated roadmap through the planning changes response', t => {
  const { store } = setup(t);
  const before = store.state();
  const result = store.commandChanges({ type: 'update_growth_target', target: 'lifetime_compounding', requestId: 'save-target', expectedRevision: before.revision });
  assert.ok('format' in result);
  assert.equal(result.format, 'mazal-state-changes');
  assert.equal(result.baseRevision, before.revision);
  assert.equal(result.changes.roadmap?.growthTarget, 'lifetime_compounding');
  assert.equal(result.changes.accounts, undefined);
  assert.equal(result.changes.transactions, undefined);
});
