import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AppState, StatementImport, StatementSource } from '../shared/types.ts';
import { reconciliationDate, reconciliationRows } from '../shared/reconciliation.ts';
import { createStore } from './store.ts';

function setup(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-statement-history-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const accountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Reviewed card', accountType: 'debt', openingBalanceCents: 5000, openingDate: '2026-09-24' }).accounts[0].id;
  store.command({ type: 'reconcile', accountId, balanceCents: 5000, date: '2026-09-24', note: 'Latest confirmed balance', requestId: 'latest' });
  return { store, path, accountId };
}
function source(accountId: string, month: '07' | '08'): StatementSource {
  return { id: `month-${month}`, accountId, sourceFile: `${month}.pdf`, sha256: month.repeat(32), periodStart: `2026-${month}-01`, periodEnd: `2026-${month}-31`, openingBalanceCents: month === '07' ? 10000 : 9000, closingBalanceCents: month === '07' ? 9000 : 8000,
    rows: [{ id: 'payment', transactionDate: `2026-${month}-10`, postingDate: `2026-${month}-11`, description: 'Source payment', amountCents: -1000, sourcePage: 1 }] };
}
function commit(store: ReturnType<typeof createStore>, statement: StatementSource) {
  store.command({ type: 'stage_statement', statement, requestId: `stage-${statement.id}` });
  store.command({ type: 'review_statement', importId: statement.id, decisions: [{ rowId: 'payment', kind: 'movement', category: 'Card payment' }], expectedRevision: store.state().revision, requestId: `review-${statement.id}` });
  return store.command({ type: 'commit_statements', importIds: [statement.id], expectedRevision: store.state().revision, requestId: `commit-${statement.id}` });
}
function at(state: AppState, accountId: string, date: string): number {
  return state.transactions.filter(transaction => reconciliationDate(transaction, accountId) <= date).reduce((sum, transaction) => sum + (transaction.balanceChanges?.[accountId] ?? 0), 0);
}

for (const legacy of [false, true]) test(`historical imports reconstruct all source checkpoints with ${legacy ? 'legacy' : 'staged'} later statements and retain the current bank balance`, t => {
  const { store, path, accountId } = setup(t);
  const august = source(accountId, '08');
  if (legacy) {
    const statement: StatementImport = { ...august, rows: august.rows.map(row => ({ ...row, kind: 'payment', category: 'Card payment' })) };
    store.command({ type: 'import_statement', statement, requestId: 'legacy-august' });
  } else commit(store, august);
  const originals = store.export();
  const confirmed = store.state().accounts[0];
  const saved = commit(store, source(accountId, '07'));
  assert.deepEqual(saved.accounts[0], confirmed);
  assert.equal(at(saved, accountId, '2026-06-30'), 10000);
  assert.equal(at(saved, accountId, '2026-07-10'), 10000, 'Transaction date cannot pull a source payment ahead of its posting date.');
  assert.equal(at(saved, accountId, '2026-07-11'), 9000);
  assert.equal(at(saved, accountId, '2026-07-31'), 9000);
  assert.equal(at(saved, accountId, '2026-08-01'), 9000);
  assert.equal(at(saved, accountId, '2026-08-11'), 8000);
  assert.equal(at(saved, accountId, '2026-08-31'), 8000);
  assert.equal(at(saved, accountId, '2026-09-24'), 5000);
  const after = store.export();
  for (const transaction of originals.data.transactions) assert.deepEqual(after.data.transactions.find(row => row.id === transaction.id), transaction);
  for (const entry of originals.data.entries) assert.deepEqual(after.data.entries.find(row => row.id === entry.id), entry);
  const checks = reconciliationRows(saved, accountId, '2026-07-31').map(row => row.id);
  store.command({ type: 'save_reconciliation', accountId, date: '2026-07-31', balanceCents: 9000, clearedTransactionIds: checks, finish: true, expectedRevision: store.state().revision, requestId: 'july-checked' });
  store.restore(store.export());
  store.close();
  const reopened = createStore(path, 'live');
  try {
    assert.equal(at(reopened.state(), accountId, '2026-07-31'), 9000);
    assert.equal(at(reopened.state(), accountId, '2026-08-31'), 8000);
    assert.equal(reopened.state().accounts[0].balanceCents, 5000);
  } finally { reopened.close(); }
});

test('a same-day balance confirmation that contradicts the source close blocks import without changes', t => {
  const { store, accountId } = setup(t);
  const statement = { ...source(accountId, '08'), id: 'september', periodStart: '2026-09-01', periodEnd: '2026-09-24', rows: [{ ...source(accountId, '08').rows[0], transactionDate: '2026-09-10', postingDate: '2026-09-11' }] };
  store.command({ type: 'stage_statement', statement, requestId: 'stage' });
  store.command({ type: 'review_statement', importId: statement.id, decisions: [{ rowId: 'payment', kind: 'movement', category: 'Card payment' }], expectedRevision: store.state().revision, requestId: 'review' });
  const before = store.state();
  assert.throws(() => store.command({ type: 'commit_statements', importIds: [statement.id], expectedRevision: before.revision, requestId: 'commit' }), /closing balance disagree on the same date/);
  assert.deepEqual(store.state(), before);
});
