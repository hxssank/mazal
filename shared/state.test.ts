import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newestState } from './state.ts';
import type { AppState } from './types.ts';

function state(revision: number, balanceCents: number, workspace: AppState['workspace'] = 'live'): AppState {
  return {
    workspace, revision, entities: [],
    accounts: [{ id: 'cash', entityId: 'personal', name: 'Cash', type: 'cash', currency: 'CAD', balanceCents, reconciledAt: null }],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

test('a refresh started before a save cannot replace the saved balance when it finishes later', () => {
  const refresh = state(4, 10000);
  const saved = state(5, 8000);
  assert.equal(newestState(saved, refresh), saved);
  assert.equal(newestState(saved, refresh).accounts[0].balanceCents, 8000);
});

test('out-of-order command responses retain the highest revision', () => {
  const secondSave = state(6, 7000);
  const firstSave = state(5, 8000);
  const responses = [state(4, 10000), secondSave, firstSave];
  assert.equal(responses.reduce<AppState | null>(newestState, null), secondSave);
  assert.equal(newestState(firstSave, secondSave), secondSave);
});

test('an initial load and a different workspace accept their own revision', () => {
  const live = state(0, 0);
  assert.equal(newestState(null, live), live);
  assert.equal(newestState(state(20, 10000, 'demo'), live), live);
});
