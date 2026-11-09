import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';

function setup(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-sol-consistency-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const accountId = store.command({ type: 'add_account', entityId: 'personal', name: 'SOL', accountType: 'investment', openingBalanceCents: 0, openingDate: '2026-01-01' }).accounts[0].id;
  const snapshot = { type: 'save_sol' as const, accountId, liquidSol: '1', stakedSol: '10', costBasisCents: 100000, priceCents: 20000, priceDate: '2026-01-10', requestId: 'snapshot' };
  store.command(snapshot);
  return { store, snapshot };
}

test('a reward before the saved SOL quantity snapshot cannot add the same holdings again', t => {
  const { store } = setup(t);
  const before = store.state();
  assert.throws(() => store.command({ type: 'add_sol_reward', positionId: before.positions[0].id, sol: '0.5', date: '2026-01-09', requestId: 'historical-reward' }), /confirmed balance on 2026-01-10/);
  assert.deepEqual(store.state(), before);
  const after = store.command({ type: 'add_sol_reward', positionId: before.positions[0].id, sol: '0.5', date: '2026-01-11', requestId: 'new-reward' });
  assert.equal(after.positions[0].stakedSol, '10.5');
  assert.equal(after.accounts[0].balanceCents, 230000);
});

test('a SOL quantity update cannot replace a later snapshot or erase a later reward', t => {
  const { store, snapshot } = setup(t);
  const before = store.state();
  assert.throws(() => store.command({ ...snapshot, priceDate: '2026-01-09', requestId: 'old-snapshot' }), /2026-01-10.*Choose that date or later/);
  assert.deepEqual(store.state(), before);
  const rewarded = store.command({ type: 'add_sol_reward', positionId: before.positions[0].id, sol: '0.5', date: '2026-01-11', requestId: 'reward' });
  assert.throws(() => store.command({ ...snapshot, requestId: 'before-reward' }), /2026-01-11.*Choose that date or later/);
  assert.deepEqual(store.state(), rewarded);
  const updated = store.command({ ...snapshot, stakedSol: '10.5', priceCents: 21000, priceDate: '2026-01-11', requestId: 'current-snapshot' });
  assert.equal(updated.accounts[0].balanceCents, 241500);
  assert.equal(updated.positions[0].rewardsSol, '0.5');
});
