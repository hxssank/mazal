import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { previewStatementBatches } from '../shared/statement-imports.ts';
import type { AccountType, StatementSource } from '../shared/types.ts';
import { createStore, RevisionConflictError } from './store.ts';

function setup(t: { after: (cleanup: () => void) => void }, accountType: AccountType) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-statement-movements-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const accountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Bank review', accountType, openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const source: StatementSource = {
    id: 'review', accountId, sourceFile: 'Bank review.pdf', sha256: 'a'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 11500,
    rows: [
      { id: 'credit', transactionDate: '2026-01-10', postingDate: '2026-01-11', description: '  ORIGINAL CREDIT  ', amountCents: 2500, sourcePage: 1 },
      { id: 'debit', transactionDate: '2026-01-12', postingDate: '2026-01-13', description: 'ORIGINAL DEBIT', amountCents: -1000, sourcePage: 2 },
    ],
  };
  const review = () => {
    store.command({ type: 'stage_statement', statement: source, requestId: 'stage' });
    return store.command({ type: 'review_statement', importId: source.id, decisions: source.rows.map(row => ({ rowId: row.id, kind: 'movement', category: 'Funding under review' })), expectedRevision: store.state().revision, requestId: 'review' });
  };
  return { store, path, source, accountId, review };
}

for (const accountType of ['cash', 'debt', 'payable'] as const) test(`${accountType} statement movements preserve signed balances and provenance without reporting income or spending`, t => {
  const { store, path, source, accountId, review } = setup(t, accountType);
  const reviewed = review();
  const preview = previewStatementBatches(reviewed, [source.id]);
  assert.equal(preview.ready, true);
  assert.equal(preview.transferCount, 0);
  const command = { type: 'commit_statements', importIds: [source.id], expectedRevision: reviewed.revision, requestId: 'commit' } as const;
  const saved = store.command({ ...command, importIds: [...command.importIds] });
  assert.deepEqual(store.command({ ...command, importIds: [...command.importIds] }), saved);
  assert.equal(saved.accounts[0].balanceCents, 11500);
  assert.equal(saved.transactions.filter(row => row.kind === 'income' || row.kind === 'expense').length, 0);
  assert.deepEqual(saved.importBatches![0].source, source);
  for (const row of source.rows) {
    const transaction = saved.transactions.find(transaction => transaction.importSources?.some(ref => ref.rowId === row.id))!;
    assert.equal(transaction.kind, 'adjustment');
    assert.equal(transaction.amountCents, Math.abs(row.amountCents));
    assert.equal(transaction.balanceChanges![accountId], row.amountCents);
    assert.equal(transaction.description, row.description);
    assert.equal(transaction.postingDates![accountId], row.postingDate);
    assert.equal(transaction.category, 'Funding under review');
    assert.deepEqual(transaction.importSources, [{ importId: source.id, rowId: row.id }]);
  }
  const backup = store.export();
  const baseline = store.state();
  for (const change of [
    (copy: typeof backup) => { copy.data.importBatches![0].decisions[0].kind = accountType === 'cash' ? 'income' : 'expense'; },
    (copy: typeof backup) => { copy.data.transactions.find(transaction => transaction.importSources)!.category = 'Changed'; },
    (copy: typeof backup) => { delete copy.data.transactions.find(transaction => transaction.importSources)!.importSources; },
    (copy: typeof backup) => { copy.data.importBatches![0].source.rows[0].amountCents = -2500; copy.data.importBatches![0].source.closingBalanceCents = 6500; },
  ]) {
    const invalid = structuredClone(backup);
    change(invalid);
    assert.throws(() => store.restore(invalid));
    assert.deepEqual(store.state(), baseline);
  }
  store.restore(backup);
  store.close();
  const reopened = createStore(path, 'live');
  try {
    assert.deepEqual(reopened.state().transactions, saved.transactions);
    assert.deepEqual(reopened.state().importBatches, saved.importBatches);
  } finally { reopened.close(); }
});

test('historical movements retain the newer bank confirmation, reject stale commits and cannot attach a transfer match', t => {
  const { store, source, accountId, review } = setup(t, 'cash');
  const confirmed = store.command({ type: 'reconcile', accountId, date: '2026-09-01', balanceCents: 45678, note: 'Latest bank review', requestId: 'confirmed' }).accounts[0];
  const reviewed = review();
  assert.throws(() => store.command({ type: 'review_statement', importId: source.id, decisions: [{ rowId: 'credit', kind: 'movement', category: 'Funding', match: { transactionId: 'unrelated' } }], expectedRevision: reviewed.revision, requestId: 'bad-match' }), /Match this classification/);
  assert.deepEqual(store.state(), reviewed);
  assert.throws(() => store.command({ type: 'commit_statements', importIds: [source.id], expectedRevision: reviewed.revision - 1, requestId: 'stale' }), RevisionConflictError);
  const saved = store.command({ type: 'commit_statements', importIds: [source.id], expectedRevision: reviewed.revision, requestId: 'commit' });
  assert.deepEqual(saved.accounts[0], confirmed);
  assert.equal(saved.transactions.filter(row => row.kind === 'income' || row.kind === 'expense').length, 0);
  assert.deepEqual(saved.importBatches![0].source, source);
  store.restore(store.export());
});
