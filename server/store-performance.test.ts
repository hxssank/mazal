import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, RevisionConflictError } from './store.ts';
import { createStoreService } from './store-service.ts';
import type { AppState, Command } from '../shared/types.ts';
import type { StateChanges } from '../shared/state-changes.ts';

const rule = { id: 'fuel', entityId: 'personal', accountId: null, match: 'contains' as const, merchant: 'Test station', category: 'Fuel & convenience', enabled: true };
function temporary() { return join(mkdtempSync(join(tmpdir(), 'mazal-store-performance-')), 'live.sqlite'); }
function remove(path: string) { rmSync(dirname(path), { recursive: true, force: true }); }

test('planning updates leave the journal untouched and return changes that reconstruct the complete state', t => {
  const path = temporary();
  const store = createStore(path, 'demo');
  const sql = new DatabaseSync(path);
  t.after(() => { sql.close(); store.close(); remove(path); });
  for (const table of ['transactions', 'journal_entries', 'statement_rows', 'accounts']) {
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) sql.exec(`CREATE TRIGGER guard_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'Planning wrote ledger data'); END`);
  }
  const before = store.state();
  const result = store.commandChanges({ type: 'save_category_rule', rule, expected: null, requestId: 'rule', expectedRevision: before.revision });
  assert.ok('format' in result);
  assert.equal(result.format, 'mazal-state-changes');
  assert.equal(Object.hasOwn(result.changes, 'transactions'), false);
  assert.equal(Object.hasOwn(result.changes, 'accounts'), false);
  assert.equal(result.baseRevision, before.revision);
  assert.deepEqual({ ...before, ...result.changes, revision: result.revision }, store.state());
  assert.deepEqual(store.state().transactions, before.transactions);
  const backup = store.export();
  // Restore runs the full validator, including all journal and ownership checks.
  const restoredPath = join(path, '..', 'restored.sqlite');
  const restored = createStore(restoredPath, 'demo');
  try { assert.deepEqual(restored.restore(backup).transactions, before.transactions); }
  finally { restored.close(); }
});

test('cache returns independent snapshots, refreshes across connections, and discards rolled-back drafts', t => {
  const path = temporary();
  const first = createStore(path, 'live');
  const second = createStore(path, 'live');
  t.after(() => { first.close(); second.close(); remove(path); });
  const opening = first.state();
  opening.entities[0].name = 'Changed caller copy';
  assert.notEqual(first.state().entities[0].name, opening.entities[0].name);
  const saved = second.command({ type: 'add_reserve', entityId: 'personal', name: 'Other window', amountCents: 500, expectedRevision: opening.revision });
  assert.deepEqual(first.state(), saved);
  assert.throws(() => first.commandChanges({ type: 'save_category_rule', rule, expected: null, requestId: 'stale', expectedRevision: opening.revision }), RevisionConflictError);
  assert.throws(() => first.commandChanges({ type: 'save_category_rule', rule: { ...rule, entityId: 'missing-owner' }, expected: null, requestId: 'bad', expectedRevision: saved.revision }), /existing rule owner/);
  assert.deepEqual(first.state(), saved);
  const changes = first.commandChanges({ type: 'save_category_rule', rule, expected: null, requestId: 'good', expectedRevision: saved.revision }) as StateChanges;
  changes.changes.categoryRules![0].category = 'Mutated response';
  assert.equal(first.state().categoryRules![0].category, rule.category);
  assert.deepEqual(second.state(), first.state());
});

test('request replay returns the latest complete state and a changed request payload is rejected', t => {
  const path = temporary();
  const store = createStore(path, 'live');
  t.after(() => { store.close(); remove(path); });
  const command: Command = { type: 'save_category_rule', rule, expected: null, requestId: 'same', expectedRevision: 0 };
  store.commandChanges(command);
  store.command({ type: 'add_reserve', name: 'Buffer', entityId: 'personal', amountCents: 100 });
  assert.deepEqual(store.commandChanges(command), store.state());
  assert.throws(() => store.commandChanges({ ...command, rule: { ...rule, merchant: 'Changed' } }), /already used/);
});

test('serialized snapshots refresh after writes, same-revision exports, external writes, rollback, and restore', t => {
  const path = temporary();
  const first = createStore(path, 'live');
  const second = createStore(path, 'live');
  t.after(() => { first.close(); second.close(); remove(path); });
  const initial = first.stateJson();
  assert.deepEqual(JSON.parse(initial), first.state());
  const callerState = JSON.parse(initial) as AppState;
  callerState.entities[0].name = 'Changed caller copy';
  assert.equal(first.stateJson(), initial);

  const backup = first.export();
  const exported = JSON.parse(first.stateJson()) as AppState;
  assert.equal(exported.revision, callerState.revision);
  assert.equal(exported.lastBackupAt, backup.data.lastBackupAt);
  assert.notEqual(first.stateJson(), initial);

  const saved = first.commandChanges({ type: 'save_category_rule', rule, expected: null, requestId: 'serialized-rule', expectedRevision: exported.revision }) as StateChanges;
  assert.deepEqual(JSON.parse(first.stateJson()), first.state());
  assert.equal(JSON.parse(first.stateJson()).revision, saved.revision);
  const external = second.command({ type: 'add_reserve', entityId: 'personal', name: 'Other window', amountCents: 500, expectedRevision: saved.revision });
  assert.deepEqual(JSON.parse(first.stateJson()), external);

  const beforeFailure = first.stateJson();
  assert.throws(() => first.commandChanges({ type: 'save_category_rule', rule: { ...rule, id: 'invalid', entityId: 'missing-owner' }, expected: null, requestId: 'serialized-bad', expectedRevision: external.revision }), /existing rule owner/);
  assert.equal(first.stateJson(), beforeFailure);
  const restored = first.restore(backup, external.revision);
  assert.deepEqual(JSON.parse(first.stateJson()), restored);
  assert.notEqual(first.stateJson(), beforeFailure);
  assert.deepEqual(restored.reserves, []);
});

test('conditional snapshots compare complete content and omit unchanged JSON before worker delivery', async t => {
  const path = temporary();
  const service = await createStoreService(path, 'live');
  const external = createStore(path, 'live');
  t.after(async () => { external.close(); await service.close(); remove(path); });
  const initial = await service.stateResponse();
  assert.equal(initial.status, 200);
  if (initial.status !== 200) assert.fail('An initial read needs the complete state.');
  assert.match(initial.etag, /^"[a-f0-9]{64}"$/);
  assert.equal(initial.json, await service.stateJson());
  for (const validator of [initial.etag, `W/${initial.etag}`, `"other,tag", W/${initial.etag}`, `, ${initial.etag},`, '*']) {
    assert.deepEqual(await service.stateResponse(validator), { status: 304, etag: initial.etag });
  }
  for (const validator of ['"different"', `${initial.etag} garbage`, `"prefix,${initial.etag}`, `*, ${initial.etag}`]) {
    assert.equal((await service.stateResponse(validator)).status, 200);
  }

  const backup = external.export();
  const exported = await service.stateResponse(initial.etag);
  assert.equal(exported.status, 200);
  if (exported.status !== 200) assert.fail('Export metadata must invalidate the earlier representation.');
  assert.notEqual(exported.etag, initial.etag);
  assert.equal(JSON.parse(exported.json).revision, JSON.parse(initial.json).revision);
  assert.equal(JSON.parse(exported.json).lastBackupAt, backup.data.lastBackupAt);
  assert.deepEqual(await service.stateResponse(exported.etag), { status: 304, etag: exported.etag });

  const saved = JSON.parse(await service.command({ type: 'add_reserve', entityId: 'personal', name: 'Conditional read', amountCents: 500, expectedRevision: backup.data.revision })) as AppState;
  const changed = await service.stateResponse(exported.etag);
  assert.equal(changed.status, 200);
  if (changed.status !== 200) assert.fail('A saved command must invalidate the earlier representation.');
  assert.deepEqual(JSON.parse(changed.json), saved);
  await assert.rejects(service.command({ type: 'save_category_rule', rule: { ...rule, entityId: 'missing-owner' }, expected: null, requestId: 'conditional-bad', expectedRevision: saved.revision }, true), /existing rule owner/);
  assert.deepEqual(await service.stateResponse(changed.etag), { status: 304, etag: changed.etag });

  const restored = JSON.parse(await service.restore(backup, saved.revision));
  const restoreResponse = await service.stateResponse(changed.etag);
  assert.equal(restoreResponse.status, 200);
  if (restoreResponse.status !== 200) assert.fail('Restore must invalidate the earlier representation.');
  assert.deepEqual(JSON.parse(restoreResponse.json), restored);
  const externalChange = external.command({ type: 'add_reserve', entityId: 'personal', name: 'Other connection', amountCents: 100, expectedRevision: restored.revision });
  const externalResponse = await service.stateResponse(restoreResponse.etag);
  assert.equal(externalResponse.status, 200);
  if (externalResponse.status !== 200) assert.fail('External writes must invalidate the earlier representation.');
  assert.deepEqual(JSON.parse(externalResponse.json), externalChange);
});

test('worker serializes writes, preserves revision conflicts, and drains accepted work before closing', async t => {
  const path = temporary();
  const service = await createStoreService(path, 'live');
  t.after(async () => { await service.close(); remove(path); });
  const initial = await service.state();
  const operations = [1, 2].map(index => service.command({ type: 'add_reserve', name: `Reserve ${index}`, entityId: 'personal', amountCents: 100, expectedRevision: initial.revision }));
  const outcomes = await Promise.allSettled(operations);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof RevisionConflictError);
  const pending = service.command({ type: 'save_category_rule', rule, expected: null, requestId: 'worker-rule', expectedRevision: 1 }, true);
  const closing = service.close();
  const response = JSON.parse(await pending) as StateChanges;
  assert.equal(response.revision, 2);
  await closing;
  await assert.rejects(service.state(), /closing|stopped/);
  const reopened = createStore(path, 'live');
  try { assert.equal(reopened.state().categoryRules![0].id, rule.id); }
  finally { reopened.close(); }
});

test('cached planning writes detect externally corrupted ledger rows before committing', t => {
  const path = temporary();
  const store = createStore(path, 'demo');
  const sql = new DatabaseSync(path);
  t.after(() => { sql.close(); store.close(); remove(path); });
  const before: AppState = store.state();
  store.stateJson();
  const conditional = store.stateResponse();
  sql.exec("UPDATE journal_entries SET debit_cents = debit_cents + 1, data = json_set(data, '$.debitCents', debit_cents + 1) WHERE id = (SELECT id FROM journal_entries LIMIT 1)");
  assert.throws(() => store.stateResponse(conditional.etag), /does not balance|does not match/);
  assert.throws(() => store.stateJson(), /does not balance|does not match/);
  assert.throws(() => store.commandChanges({ type: 'save_category_rule', rule, expected: null, requestId: 'corrupted', expectedRevision: before.revision }), /does not balance|does not match/);
  assert.equal((sql.prepare('SELECT revision FROM workspace_meta').get() as { revision: number }).revision, before.revision);
});

test('planning changes include backup metadata even when an export kept the same revision', t => {
  const path = temporary();
  const store = createStore(path, 'live');
  t.after(() => { store.close(); remove(path); });
  const baseline = store.state();
  assert.equal(baseline.lastBackupAt, null);
  const exported = store.export();
  assert.equal(store.state().revision, baseline.revision);
  const delta = store.commandChanges({ type: 'save_category_rule', rule, expected: null, requestId: 'after-backup', expectedRevision: baseline.revision }) as StateChanges;
  assert.equal(delta.changes.lastBackupAt, exported.data.lastBackupAt);
  assert.deepEqual({ ...baseline, ...delta.changes, revision: delta.revision }, store.state());
});

test('planning saves enforce the same revision limit as ledger saves', t => {
  const path = temporary();
  const store = createStore(path, 'live');
  const sql = new DatabaseSync(path);
  t.after(() => { sql.close(); store.close(); remove(path); });
  const maximum = 100_000_000_000_000;
  sql.prepare('UPDATE workspace_meta SET revision = ?').run(maximum);
  assert.throws(() => store.commandChanges({ type: 'save_category_rule', rule, expected: null, requestId: 'max-revision', expectedRevision: maximum }), /Revision must be/);
  assert.equal(store.state().revision, maximum);
  assert.deepEqual(store.state().categoryRules, []);
});

test('restores reject a revision or edit history that would make the saved database unreadable', t => {
  const path = temporary();
  const store = createStore(path, 'live');
  const sql = new DatabaseSync(path);
  t.after(() => { sql.close(); store.close(); remove(path); });
  const backup = store.export();
  const maximum = 100_000_000_000_000;
  sql.prepare('UPDATE workspace_meta SET revision = ?').run(maximum);
  const before = store.state();
  assert.throws(() => store.restore(backup, maximum), /Revision must be/);
  assert.deepEqual(store.state(), before);
  sql.prepare('UPDATE workspace_meta SET revision = ?').run(0);
  const empty = store.state();
  backup.data.audit = Array.from({ length: 250_000 }, (_, index) => ({ id: `history-${index}`, date: '2026-01-01T00:00:00.000Z', action: 'review', description: 'Reviewed a source.' }));
  assert.throws(() => store.restore(backup, empty.revision), /Edit history must be a list with at most/);
  assert.deepEqual(store.state(), empty);
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state(), empty); }
  finally { reopened.close(); }
});
