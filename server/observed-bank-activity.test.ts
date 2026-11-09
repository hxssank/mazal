import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { bankReview } from '../shared/bank-review.ts';
import { reconciliationDate, reconciliationRows } from '../shared/reconciliation.ts';
import { statementCoverage } from '../shared/statement-imports.ts';
import type { StatementSource } from '../shared/types.ts';
import { createStore } from './store.ts';

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-26T16:00:00Z') });
  const directory = mkdtempSync(join(tmpdir(), 'mazal-observed-activity-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const accountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Observed bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-09-24' }).accounts[0].id;
  const source: StatementSource = { id: 'weekend-activity', accountId, sourceFile: 'bank-activity.json', sha256: 'a'.repeat(64), sourceKind: 'bank_activity', observedOn: '2026-09-26', periodStart: '2026-09-25', periodEnd: '2026-09-26', openingBalanceCents: 10000, closingBalanceCents: 7000, rows: [{ id: 'purchase', transactionDate: '2026-09-26', postingDate: '2026-09-28', description: 'Weekend purchase', amountCents: -3000, sourcePage: 1 }] };
  return { store, path, accountId, source };
}

function stage(store: ReturnType<typeof createStore>, source: StatementSource) {
  store.command({ type: 'stage_statement', statement: source, requestId: `stage-${source.id}` });
  store.command({ type: 'review_statement', importId: source.id, decisions: source.rows.map(row => ({ rowId: row.id, kind: 'expense', category: 'Food' })), expectedRevision: store.state().revision, requestId: `review-${source.id}` });
}

test('observed bank activity preserves posting dates and reconciles the balance on its observation date', t => {
  const { store, path, accountId, source } = setup(t);
  stage(store, source);
  const state = store.command({ type: 'commit_statements', importIds: [source.id], expectedRevision: store.state().revision, requestId: 'commit' });
  assert.equal(state.accounts[0].balanceCents, 7000);
  assert.equal(state.accounts[0].reconciledAt, '2026-09-26');
  assert.equal(state.accounts[0].evidence?.asOf, '2026-09-26');
  const purchase = state.transactions.find(row => row.description === 'Weekend purchase')!;
  assert.equal(purchase.date, '2026-09-26');
  assert.equal(purchase.postingDate, '2026-09-28');
  assert.equal(purchase.postingDates?.[accountId], '2026-09-28');
  assert.equal(reconciliationDate(purchase, accountId), '2026-09-26');
  assert.deepEqual(state.importBatches![0].source, source);
  const review = bankReview(state, accountId);
  assert.deepEqual(review.daily, [{ date: '2026-09-25', balanceCents: 10000 }, { date: '2026-09-26', balanceCents: 7000 }]);
  assert.equal(review.rows[0].postingDate, '2026-09-28');
  assert.equal(statementCoverage(state, 'personal', '2026-09', accountId).coveredAccountDays, 2);
  const checked = reconciliationRows(state, accountId, '2026-09-26').map(row => row.id);
  store.command({ type: 'save_reconciliation', accountId, date: '2026-09-26', balanceCents: 7000, clearedTransactionIds: checked, finish: true, expectedRevision: store.state().revision, requestId: 'checks' });
  store.command({ type: 'reconcile', accountId, date: '2026-09-26', balanceCents: 7000, note: 'Observed current balance', requestId: 'confirm' });
  store.restore(store.export());
  store.close();
  const reopened = createStore(path, 'live');
  try {
    assert.deepEqual(reopened.state().importBatches![0].source, source);
    assert.equal(reopened.state().accounts[0].reconciliation?.balanceCents, 7000);
    assert.equal(bankReview(reopened.state(), accountId).closingCents, 7000);
  } finally { reopened.close(); }
});

test('bank activity cannot bypass future transaction, observation, or statement period validation', t => {
  const { store, source } = setup(t);
  const { sourceKind: _kind, observedOn: _observed, ...ordinary } = source;
  const invalid: StatementSource[] = [
    ordinary,
    { ...ordinary, periodEnd: '2026-09-28' },
    { ...source, observedOn: undefined },
    { ...source, sourceKind: undefined },
    { ...source, observedOn: '2026-09-27' },
    { ...source, observedOn: '2026-09-27', periodEnd: '2026-09-27' },
    { ...source, rows: [{ ...source.rows[0], transactionDate: '2026-09-27' }] },
    { ...source, rows: [{ ...source.rows[0], postingDate: '2026-10-04' }] },
  ];
  const before = store.state();
  for (const [index, statement] of invalid.entries()) {
    assert.throws(() => store.command({ type: 'stage_statement', statement, requestId: `invalid-${index}` }), /future|observation|posting dates|source kind/);
    assert.deepEqual(store.state(), before);
  }
});

test('a later source cannot record observed activity twice under a longer merchant name, while duplicate purchases within one source remain distinct', t => {
  const { store, source } = setup(t);
  source.rows.push({ ...source.rows[0], id: 'another-purchase' });
  source.closingBalanceCents = 4000;
  stage(store, source);
  store.command({ type: 'commit_statements', importIds: [source.id], expectedRevision: store.state().revision, requestId: 'commit' });
  t.mock.timers.setTime(new Date('2026-09-29T16:00:00Z').getTime());
  const next: StatementSource = { ...source, id: 'posted-activity', sha256: 'b'.repeat(64), sourceKind: undefined, observedOn: undefined, periodStart: '2026-09-27', periodEnd: '2026-09-28', openingBalanceCents: 4000, closingBalanceCents: 1000, rows: [{ ...source.rows[0], description: 'Weekend purchase Toronto ON' }] };
  stage(store, next);
  const before = store.state();
  assert.equal(before.transactions.filter(row => row.description === 'Weekend purchase').length, 2);
  assert.throws(() => store.command({ type: 'commit_statements', importIds: [next.id], expectedRevision: before.revision, requestId: 'duplicate' }), /Previously observed bank activity/);
  assert.deepEqual(store.state(), before);
});

test('a month-end observation does not add next-month coverage or move its balance into the next month', t => {
  const { store, source, accountId } = setup(t);
  t.mock.timers.setTime(new Date('2026-09-30T16:00:00Z').getTime());
  source.observedOn = source.periodEnd = '2026-09-30';
  source.rows[0].transactionDate = '2026-09-30';
  source.rows[0].postingDate = '2026-10-01';
  stage(store, source);
  const state = store.command({ type: 'commit_statements', importIds: [source.id], expectedRevision: store.state().revision, requestId: 'commit' });
  assert.equal(bankReview(state, accountId, '2026-09').removedCents, 3000);
  assert.equal(bankReview(state, accountId, '2026-09').closingCents, 7000);
  assert.equal(bankReview(state, accountId, '2026-10').coveredDays, 0);
  assert.equal(bankReview(state, accountId, '2026-10').rows.length, 0);
  assert.equal(statementCoverage(state, 'personal', '2026-10', accountId).status, 'none');
});

test('matched transfers keep each account observation date and its original posting date', t => {
  const { store, source, accountId } = setup(t);
  const card = store.command({ type: 'add_account', entityId: 'personal', name: 'Card', accountType: 'debt', openingBalanceCents: 5000, openingDate: '2026-09-24' }).accounts.find(account => account.name === 'Card')!.id;
  const credit: StatementSource = { ...source, id: 'card-activity', accountId: card, sha256: 'b'.repeat(64), observedOn: '2026-09-25', periodEnd: '2026-09-25', openingBalanceCents: 5000, closingBalanceCents: 2000, rows: [{ ...source.rows[0], transactionDate: '2026-09-25', postingDate: '2026-09-25' }] };
  source.rows[0].transactionDate = '2026-09-25';
  for (const statement of [source, credit]) store.command({ type: 'stage_statement', statement, requestId: `stage-${statement.id}` });
  for (const [statement, other] of [[source, credit], [credit, source]]) store.command({ type: 'review_statement', importId: statement.id, decisions: [{ rowId: statement.rows[0].id, kind: 'transfer', category: 'Card payment', match: { importId: other.id, rowId: other.rows[0].id } }], expectedRevision: store.state().revision, requestId: `review-${statement.id}` });
  const state = store.command({ type: 'commit_statements', importIds: [source.id, credit.id], expectedRevision: store.state().revision, requestId: 'commit' });
  const payment = state.transactions.find(transaction => transaction.kind === 'debt_payment')!;
  assert.equal(payment.postingDates?.[accountId], '2026-09-28');
  assert.equal(payment.postingDates?.[card], '2026-09-25');
  assert.equal(reconciliationDate(payment, accountId), '2026-09-26');
  assert.equal(reconciliationDate(payment, card), '2026-09-25');
  assert.equal(reconciliationRows(state, accountId, '2026-09-25').some(row => row.id === payment.id), false);
  assert.equal(reconciliationRows(state, card, '2026-09-25').some(row => row.id === payment.id), true);
  store.restore(store.export());
});

for (const dateBasis of ['posting_only', 'transaction_only'] as const) test(`bank activity preserves ${dateBasis} provenance through correction, commit, export, restore and reopen`, t => {
  const { store, path, source, accountId } = setup(t);
  source.rows[0] = { ...source.rows[0], postingDate: source.rows[0].transactionDate, dateBasis };
  stage(store, source);
  const before = store.state();
  const changedBasis: StatementSource = { ...source, rows: [{ ...source.rows[0], dateBasis: dateBasis === 'posting_only' ? 'transaction_only' : 'posting_only' }] };
  assert.throws(() => store.command({ type: 'stage_statement', statement: changedBasis, requestId: 'changed-basis' }), /different extracted rows/);
  assert.deepEqual(store.state(), before);
  const corrected = { ...source, rows: [{ ...source.rows[0], description: 'Corrected bank description' }] };
  store.command({ type: 'revise_statement', importId: source.id, statement: corrected, reason: 'Read full description from original source', expectedRevision: store.state().revision, requestId: 'correct' });
  store.command({ type: 'review_statement', importId: source.id, decisions: [{ rowId: source.rows[0].id, kind: 'expense', category: 'Food' }], expectedRevision: store.state().revision, requestId: 'review-correction' });
  const state = store.command({ type: 'commit_statements', importIds: [source.id], expectedRevision: store.state().revision, requestId: 'commit-single-date' });
  assert.equal(state.accounts[0].balanceCents, 7000);
  assert.deepEqual(state.importBatches![0].source, corrected);
  assert.deepEqual(state.importBatches![0].extractionHistory![0].source, source);
  assert.equal(bankReview(state, accountId).rows[0].dateBasis, dateBasis);
  const transaction = state.transactions.find(row => row.description === 'Corrected bank description')!;
  assert.equal(transaction.date, source.rows[0].transactionDate);
  assert.equal(transaction.postingDate, source.rows[0].transactionDate);
  const exported = store.export();
  assert.deepEqual(exported.data.importBatches![0].source, corrected);
  store.restore(exported);
  store.close();
  const reopened = createStore(path, 'live');
  try {
    assert.deepEqual(reopened.state().importBatches![0].source, corrected);
    assert.deepEqual(reopened.state().importBatches![0].extractionHistory![0].source, source);
    assert.equal(bankReview(reopened.state(), accountId).closingCents, 7000);
  } finally { reopened.close(); }
});

test('single-date metadata cannot silently replace two supplied dates or apply to an ordinary statement', t => {
  const { store, source } = setup(t);
  const single = { ...source, rows: [{ ...source.rows[0], postingDate: source.rows[0].transactionDate, dateBasis: 'posting_only' as const }] };
  const invalid = [
    { ...single, rows: [{ ...single.rows[0], dateBasis: 'unknown' }] },
    { ...single, rows: [{ ...single.rows[0], dateBasis: null }] },
    { ...single, rows: [{ ...single.rows[0], postingDate: '2026-09-28' }] },
    { ...single, sourceKind: undefined, observedOn: undefined },
  ];
  const before = store.state();
  for (const [index, statement] of invalid.entries()) {
    assert.throws(() => store.command({ type: 'stage_statement', statement, requestId: `bad-basis-${index}` } as never), /date basis|Single-date|single supplied date/);
    assert.deepEqual(store.state(), before);
  }
  stage(store, single);
  const exported = store.export();
  exported.data.importBatches![0].source.rows[0].dateBasis = 'unknown' as never;
  assert.throws(() => store.restore(exported), /date basis/);
  assert.equal(store.state().importBatches![0].source.rows[0].dateBasis, 'posting_only');
});
