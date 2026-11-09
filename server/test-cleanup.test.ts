import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { deferTestCleanup, trackTestResource, closeTestResource } from './test-cleanup.ts';

function hooks() {
  const callbacks: Array<() => void | Promise<void>> = [];
  return {
    context: { after: (callback: () => void | Promise<void>) => { callbacks.push(callback); } },
    async finish() { for (const callback of callbacks) await callback(); },
  };
}

test('test cleanup closes reopened SQLite handles before removing their directory after a failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-cleanup-'));
  const databases: DatabaseSync[] = [];
  t.after(() => {
    for (const database of databases) if (database.isOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { context, finish } = hooks();
  deferTestCleanup(context, () => {
    assert.ok(databases.every(database => !database.isOpen), 'A SQLite handle still owns the fixture');
    rmSync(directory, { recursive: true, force: true });
  });
  const failure = new Error('Injected assertion failure');
  try {
    const first = trackTestResource(context, new DatabaseSync(join(directory, 'live.sqlite')));
    databases.push(first);
    first.exec('CREATE TABLE records (id INTEGER PRIMARY KEY)');
    closeTestResource(first);
    const reopened = trackTestResource(context, new DatabaseSync(join(directory, 'live.sqlite')));
    databases.push(reopened);
    const reader = trackTestResource(context, new DatabaseSync(join(directory, 'live.sqlite'), { readOnly: true }));
    databases.push(reader);
    throw failure;
  } catch (error) {
    assert.equal(error, failure);
  } finally {
    await finish();
  }
  assert.equal(existsSync(directory), false);
});

test('test cleanup awaits resources in reverse acquisition order', async () => {
  const { context, finish } = hooks();
  const order: string[] = [];
  deferTestCleanup(context, () => { order.push('directory'); });
  trackTestResource(context, { close() { order.push('database'); } });
  trackTestResource(context, { async close() { await Promise.resolve(); order.push('preview'); } });
  await finish();
  assert.deepEqual(order, ['preview', 'database', 'directory']);
});

test('explicit test disposal closes the original resource once without replacing its method', async () => {
  const { context, finish } = hooks();
  let calls = 0;
  const close = () => { calls++; };
  const resource = trackTestResource(context, { close });
  closeTestResource(resource);
  closeTestResource(resource);
  await finish();
  assert.equal(resource.close, close);
  assert.equal(calls, 1);
});

test('cleanup reports every error after attempting remaining resources and directory cleanup', async () => {
  const { context, finish } = hooks();
  const order: string[] = [];
  const databaseFailure = new Error('Database close failed');
  const previewFailure = new Error('Preview close failed');
  deferTestCleanup(context, () => { order.push('directory'); });
  trackTestResource(context, { close() { order.push('database'); throw databaseFailure; } });
  trackTestResource(context, { async close() { order.push('preview'); throw previewFailure; } });
  await assert.rejects(finish(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [previewFailure, databaseFailure]);
    return true;
  });
  assert.deepEqual(order, ['preview', 'database', 'directory']);
});
