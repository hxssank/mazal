import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.ts';
import type { AppState, Command } from '../shared/types.ts';
import { CommandRecoveryError, executeCommandWithRecovery } from './services/command-recovery.ts';

function fixture(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-annotation-recovery-'));
  const store = createStore(join(directory, 'demo.sqlite'), 'demo');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = store.state();
  const transaction = before.transactions.find(row => row.kind === 'expense')!;
  const command: Extract<Command, { type: 'annotate_transaction' }> = { type: 'annotate_transaction', id: transaction.id, expectedDisplayName: null, expectedNote: null, displayName: '  Home internet  ', note: ' Monthly service ', requestId: 'annotation-recovery', expectedRevision: before.revision };
  return { store, before, transaction, command };
}

test('annotation recovery confirms a lost response by replaying the same request exactly once', async t => {
  const { store, before, transaction, command } = fixture(t);
  const sent: Command[] = [];
  let accepted: AppState | undefined;
  const result = await executeCommandWithRecovery('demo', command, async (_workspace, input) => {
    sent.push(input);
    const state = store.command(input);
    if (sent.length === 1) throw new Error('Connection closed after saving');
    return state;
  }, async () => store.state(), state => { accepted = state; });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { ...command, expectedRevision: before.revision + 1 });
  assert.equal(result.revision, before.revision + 1);
  assert.equal(accepted?.revision, result.revision);
  assert.equal(result.transactions.find(row => row.id === transaction.id)?.displayName, 'Home internet');
  assert.equal(result.audit.filter(row => row.action === 'annotate_transaction').length, 1);
  assert.deepEqual(result.accounts, before.accounts);
});

test('annotation recovery accepts a saved reset to the original description and no note', async t => {
  const { store, transaction, command } = fixture(t);
  store.command(command);
  const reset: Command = { ...command, expectedDisplayName: 'Home internet', expectedNote: 'Monthly service', displayName: ' ', note: null, requestId: 'reset', expectedRevision: store.state().revision };
  let calls = 0;
  const result = await executeCommandWithRecovery('demo', reset, async (_workspace, input) => {
    const saved = store.command(input);
    if (++calls === 1) throw new Error('Lost reset response');
    return saved;
  }, async () => store.state(), () => {});
  assert.equal(calls, 2);
  const restored = result.transactions.find(row => row.id === transaction.id)!;
  assert.equal(Object.hasOwn(restored, 'displayName'), false);
  assert.equal(Object.hasOwn(restored, 'note'), false);
});

test('annotation recovery does not retry over a different concurrent name or note', async t => {
  const { store, command } = fixture(t);
  store.command({ ...command, displayName: 'Shared internet bill', note: 'Split with roommate', requestId: 'other-window' });
  const concurrent = store.state();
  let calls = 0;
  let accepted: AppState | undefined;
  await assert.rejects(executeCommandWithRecovery('demo', command, async (_workspace, input) => {
    calls++;
    return store.command(input);
  }, async () => store.state(), state => { accepted = state; }), error => {
    assert.ok(error instanceof CommandRecoveryError);
    assert.equal(error.refreshedState?.revision, concurrent.revision);
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(accepted, concurrent);
  assert.deepEqual(store.state(), concurrent);
});

test('a matching annotation from another request is not mistaken for this request succeeding', async t => {
  const { store, command } = fixture(t);
  store.command({ ...command, requestId: 'other-window' });
  const concurrent = store.state();
  let calls = 0;
  await assert.rejects(executeCommandWithRecovery('demo', command, async (_workspace, input) => {
    calls++;
    return store.command(input);
  }, async () => store.state(), () => {}), /name or note changed/);
  assert.equal(calls, 2);
  assert.deepEqual(store.state(), concurrent);
});
