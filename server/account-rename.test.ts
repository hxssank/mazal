import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from '../shared/types.ts';
import { createStore, RevisionConflictError } from './store.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-account-rename-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const state = store.command({ type: 'add_account', entityId: 'personal', name: 'Family loan', accountType: 'debt', openingBalanceCents: 260000, openingDate: '2026-01-01' });
  const accountId = state.accounts[0].id;
  store.command({ type: 'set_debt_terms', accountId, terms: { aprPercent: 0, rateConfirmed: false, minimumPaymentCents: null, notes: 'Original owner note', paymentDueDate: '2027-04-01' } });
  return { store, path, accountId };
}

test('account rename preserves ledger and terms, persists, and retries only once', t => {
  const { store, path, accountId } = setup(t);
  const before = store.state();
  const command: Extract<Command, { type: 'rename_account' }> = { type: 'rename_account', accountId, expectedName: 'Family loan', name: 'Lose Ends', expectedRevision: before.revision, requestId: 'rename' };
  const saved = store.command(command);
  assert.deepEqual(saved.accounts, before.accounts.map(account => ({ ...account, name: 'Lose Ends' })));
  assert.deepEqual(saved.transactions, before.transactions);
  assert.equal(saved.audit[0].action, 'rename_account');
  assert.equal(saved.audit[0].description, 'Renamed Family loan to Lose Ends.');
  assert.equal(saved.revision, before.revision + 1);
  assert.deepEqual(store.command(command), saved);
  assert.throws(() => store.command({ ...command, name: 'Different' }), /different operation/);
  store.close();
  const reopened = createStore(path, 'live');
  try {
    assert.deepEqual(reopened.state(), saved);
    assert.deepEqual(reopened.command(command), saved);
  } finally { reopened.close(); }
});

test('account rename rejects stale records, stale names, invalid names, and missing retry protection', t => {
  const { store, accountId } = setup(t);
  const before = store.state();
  const command: Extract<Command, { type: 'rename_account' }> = { type: 'rename_account', accountId, expectedName: 'Family loan', name: 'Lose Ends', expectedRevision: before.revision, requestId: 'rename' };
  assert.throws(() => store.command({ ...command, expectedRevision: before.revision - 1 }), RevisionConflictError);
  assert.throws(() => store.command({ ...command, expectedName: 'Different' }), /name changed/);
  assert.throws(() => store.command({ ...command, name: ' ' }), /Account name/);
  assert.throws(() => store.command({ ...command, accountId: 'missing' }), /existing account/);
  assert.throws(() => store.command({ ...command, expectedRevision: undefined }), /current workspace revision/);
  const { requestId: _requestId, ...withoutRequest } = command;
  assert.throws(() => store.command(withoutRequest as Command), /request ID/);
  assert.deepEqual(store.state(), before);
});
