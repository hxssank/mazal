import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bankReview } from './bank-review.ts';
import type { AppState, StatementBatch, StatementSourceRow, Transaction } from './types.ts';

function state(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'cash', name: 'Bank', entityId: 'personal', type: 'cash', balanceCents: 999999, currency: 'CAD', reconciledAt: null }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}

function row(id: string, postingDate: string, amountCents: number, transactionDate = postingDate): StatementSourceRow {
  return { id, postingDate, transactionDate, amountCents, description: id, sourcePage: 1 };
}

function batch(id: string, start: string, end: string, opening: number, rows: StatementSourceRow[], accountId = 'cash'): StatementBatch {
  return { id, status: 'committed', createdAt: '2026-09-25T12:00:00Z', committedAt: '2026-09-25T12:00:00Z', decisions: [], source: { id, accountId, sourceFile: `${id}.pdf`, sha256: id.padEnd(64, '0'), periodStart: start, periodEnd: end, openingBalanceCents: opening, closingBalanceCents: opening + rows.reduce((sum, item) => sum + item.amountCents, 0), rows } };
}

function transaction(id: string, kind: Transaction['kind'], amountCents: number, importId: string, rowId: string): Transaction {
  return { id, kind, amountCents, accountId: 'cash', toAccountId: null, date: '2026-09-01', description: id, category: kind === 'expense' ? 'Food' : 'Unclassified receipt', source: 'Bank import', createdAt: '2026-09-25T12:00:00Z', importSources: [{ importId, rowId }] };
}

test('bank cash flows use posting dates and separate confirmed spending and income from other movements', () => {
  const data = state();
  data.importBatches = [batch('one', '2026-08-31', '2026-09-03', 10000, [row('purchase', '2026-09-01', -3000, '2026-08-31'), row('refund', '2026-09-02', 500), row('borrowed', '2026-09-02', 8000), row('pay', '2026-09-03', 12000)])];
  data.transactions = [transaction('purchase', 'expense', 3000, 'one', 'purchase'), transaction('refund', 'expense', -500, 'one', 'refund'), transaction('borrowed', 'adjustment', 8000, 'one', 'borrowed'), transaction('pay', 'income', 12000, 'one', 'pay')];
  const before = structuredClone(data);
  const review = bankReview(data, 'cash', '2026-09');
  assert.deepEqual([review.addedCents, review.removedCents, review.incomeCents, review.spendingCents], [20500, 3000, 12000, 2500]);
  assert.deepEqual(review.daily, [{ date: '2026-09-01', balanceCents: 7000 }, { date: '2026-09-02', balanceCents: 15500 }, { date: '2026-09-03', balanceCents: 27500 }]);
  assert.deepEqual([review.openingCents, review.closingCents, review.coveredDays], [10000, 27500, 3]);
  assert.equal(bankReview(data, 'cash', '2026-08').rows.length, 0);
  assert.deepEqual(data, before);
});

test('coverage carries only inside sources, counts zero-activity days, and preserves unknown gaps', () => {
  const data = state();
  data.importBatches = [batch('first', '2028-02-28', '2028-02-29', 1000, [row('debit', '2028-02-28', -2000)]), batch('next', '2028-03-01', '2028-03-02', -1000, [row('credit', '2028-03-02', 7000)]), batch('gap', '2028-03-04', '2028-03-04', 12000, [])];
  const review = bankReview(data, 'cash');
  assert.deepEqual(review.daily.map(day => day.date), ['2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02', '2028-03-04']);
  assert.deepEqual([review.coveredDays, review.below50Days, review.negativeDays], [5, 3, 3]);
  assert.equal(review.gaps, true);
  assert.equal(review.openingCents, null);
  assert.equal(review.closingCents, 12000);
  assert.equal(bankReview(data, 'cash', '2028-02').gaps, false);
  assert.equal(bankReview(data, 'cash', '2028-02').openingCents, 1000);
});

test('staged and other-account sources are excluded and the same source hash cannot double-count rows', () => {
  const data = state();
  const recorded = batch('first', '2026-09-01', '2026-09-02', 10000, [row('debit', '2026-09-01', -500)]);
  const duplicate = structuredClone(recorded);
  duplicate.id = duplicate.source.id = 'copy';
  data.importBatches = [recorded, duplicate, { ...batch('staged', '2026-09-03', '2026-09-04', 9500, []), status: 'staged' }, batch('other', '2026-09-01', '2026-09-30', 100000, [], 'other')];
  const review = bankReview(data, 'cash');
  assert.equal(review.rows.length, 1);
  assert.equal(review.removedCents, 500);
  assert.equal(review.coveredDays, 2);
  assert.equal(review.closingCents, 9500);
});

test('individually reconciled sources cannot conceal a discontinuity between consecutive dates', () => {
  const data = state();
  data.importBatches = [batch('first', '2026-09-01', '2026-09-02', 10000, [row('debit', '2026-09-01', -500)]), batch('next', '2026-09-03', '2026-09-04', 9600, [])];
  assert.throws(() => bankReview(data, 'cash'), /carried-forward balance/);
  data.importBatches[1].source.openingBalanceCents = 9500;
  data.importBatches[1].source.closingBalanceCents = 9500;
  assert.equal(bankReview(data, 'cash').closingCents, 9500);
  data.importBatches[1].source.periodStart = '2026-09-02';
  assert.throws(() => bankReview(data, 'cash'), /overlap/);
});

test('malformed dates, out-of-period entries, mismatched balances, and unsafe cents fail before a projection', () => {
  const data = state();
  const source = batch('one', '2026-09-01', '2026-09-30', 10000, [row('debit', '2026-09-01', -500)]);
  for (const date of ['2026-02-30', '2026-9-1', 'not-a-date', '0000-01-01', '2201-01-01']) {
    data.importBatches = [structuredClone(source)];
    data.importBatches[0].source.periodStart = date;
    assert.throws(() => bankReview(data, 'cash'), /calendar dates/);
  }
  data.importBatches = [structuredClone(source)];
  data.importBatches[0].source.rows[0].postingDate = '2026-10-01';
  assert.throws(() => bankReview(data, 'cash'), /outside its coverage/);
  data.importBatches[0].source.rows[0].postingDate = '2026-09-31';
  assert.throws(() => bankReview(data, 'cash'), /calendar dates/);
  data.importBatches = [structuredClone(source)];
  data.importBatches[0].source.closingBalanceCents++;
  assert.throws(() => bankReview(data, 'cash'), /does not reconcile/);
  data.importBatches = [batch('large', '2026-09-01', '2026-09-01', Number.MAX_SAFE_INTEGER, [row('large', '2026-09-01', 1)])];
  assert.throws(() => bankReview(data, 'cash'), /supported amount/);
  assert.throws(() => bankReview(state(), 'cash', '2026-13'), /calendar month/);
});

test('debt source signs retain debt additions and reductions with legacy transaction links', () => {
  const data = state();
  data.accounts[0].type = 'debt';
  data.statements = [{ id: 'legacy', accountId: 'cash', sourceFile: 'legacy.pdf', sha256: 'a'.repeat(64), periodStart: '2026-09-01', periodEnd: '2026-09-03', openingBalanceCents: 10000, closingBalanceCents: 8100, rows: [
    { ...row('buy', '2026-09-01', 1000), category: 'Food', kind: 'purchase' }, { ...row('pay', '2026-09-02', -3000), category: 'Card payment', kind: 'payment' }, { ...row('interest', '2026-09-03', 100), category: 'Interest', kind: 'interest' },
  ] }];
  data.transactions = data.statements[0].rows.map(item => ({ ...transaction(item.id, item.kind === 'payment' ? 'adjustment' : 'expense', Math.abs(item.amountCents), '', ''), importSources: [], statementId: 'legacy', statementRowId: item.id }));
  const review = bankReview(data, 'cash');
  assert.deepEqual([review.addedCents, review.removedCents, review.spendingCents, review.incomeCents], [1100, 3000, 1100, 0]);
  assert.equal(review.closingCents, 8100);
});
