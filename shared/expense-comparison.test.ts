import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExpenseComparison } from './expense-comparison.ts';
import type { AppState, Transaction } from './types.ts';

function state(transactions: Transaction[] = []): AppState {
  return {
    workspace: 'live', revision: 0,
    entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 5000 }],
    accounts: [
      { id: 'bank', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null },
      { id: 'shop-bank', entityId: 'shop', name: 'Shop bank', type: 'cash', currency: 'CAD', balanceCents: 50000, reconciledAt: null },
    ],
    transactions, obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

function expense(id: string, date: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction {
  return { id, date, category: 'Food', kind: 'expense', accountId: 'bank', amountCents, description: id, toAccountId: null, source: 'manual', createdAt: `${date}T12:00:00Z`, ...patch };
}

test('missing category history stays unavailable even when another category has history', () => {
  const empty = buildExpenseComparison(state([expense('current', '2026-09-01', 2000)]), 'me', '2026-09', '2026-09-25');
  assert.equal(empty.hasHistory, false);
  assert.deepEqual(empty.byCategoryId.get('me:food'), { spentCents: 0, transactionCount: 0, differenceCents: null, direction: 'unavailable' });
  const comparison = buildExpenseComparison(state([expense('past', '2026-08-20', 1500), expense('current', '2026-09-01', 1000)]), 'me', '2026-09', '2026-09-25');
  assert.equal(comparison.hasHistory, true);
  assert.deepEqual(comparison.byCategoryId.get('me:food'), { spentCents: 1500, transactionCount: 1, differenceCents: -500, direction: 'lower' });
  assert.equal(comparison.byCategoryId.get('me:housing')?.direction, 'unavailable');
});

test('current month compares the same elapsed days and excludes future expenses', () => {
  const data = state([
    expense('prior', '2026-08-01', 2000), expense('prior-cutoff', '2026-08-25', 400), expense('prior-later', '2026-08-26', 9000),
    expense('current', '2026-09-01', 1000), expense('current-cutoff', '2026-09-25', 200), expense('tomorrow', '2026-09-26', 8000),
  ]);
  const comparison = buildExpenseComparison(data, 'me', '2026-09', '2026-09-25');
  assert.equal(comparison.start, '2026-08-01');
  assert.equal(comparison.end, '2026-08-25');
  assert.equal(comparison.partialPeriod, true);
  assert.deepEqual(comparison.byCategoryId.get('me:food'), { spentCents: 2400, transactionCount: 2, differenceCents: -1200, direction: 'lower' });
});

test('completed months use all days of the prior month across the year boundary', () => {
  const comparison = buildExpenseComparison(state([
    expense('old', '2025-11-30', 10000), expense('prior-end', '2025-12-31', 2000), expense('selected-end', '2026-01-31', 3000),
  ]), 'me', '2026-01', '2026-09-25');
  assert.equal(comparison.previousMonth, '2025-12');
  assert.equal(comparison.start, '2025-12-01');
  assert.equal(comparison.end, '2025-12-31');
  assert.equal(comparison.partialPeriod, false);
  assert.deepEqual(comparison.byCategoryId.get('me:food'), { spentCents: 2000, transactionCount: 1, differenceCents: 1000, direction: 'higher' });
});

test('elapsed-day comparison clamps to February in regular and leap years', () => {
  for (const [year, lastDay] of [['2026', '28'], ['2028', '29']]) {
    const comparison = buildExpenseComparison(state([
      expense('prior-end', `${year}-02-${lastDay}`, 2000), expense('current', `${year}-03-30`, 2000),
    ]), 'me', `${year}-03`, `${year}-03-30`);
    assert.equal(comparison.end, `${year}-02-${lastDay}`);
    assert.deepEqual(comparison.byCategoryId.get('me:food'), { spentCents: 2000, transactionCount: 1, differenceCents: 0, direction: 'same' });
  }
});

test('zero totals and net refunds still count as prior category history', () => {
  const comparison = buildExpenseComparison(state([
    expense('past-purchase', '2026-08-01', 2000), expense('past-refund', '2026-08-02', -2000), expense('current', '2026-09-01', 500),
    expense('past-social-refund', '2026-08-03', -900, { category: 'Social' }), expense('current-social-refund', '2026-09-02', -400, { category: 'Social' }),
    expense('past-trip', '2026-08-03', 1500, { category: 'Trips' }),
  ]), 'me', '2026-09', '2026-09-25');
  assert.deepEqual(comparison.byCategoryId.get('me:food'), { spentCents: 0, transactionCount: 2, differenceCents: 500, direction: 'higher' });
  assert.deepEqual(comparison.byCategoryId.get('me:social'), { spentCents: -900, transactionCount: 1, differenceCents: 500, direction: 'higher' });
  assert.deepEqual(comparison.byCategoryId.get('me:trips'), { spentCents: 1500, transactionCount: 1, differenceCents: -1500, direction: 'lower' });
});

test('comparison keeps ownership, aliases and explicit category choices from the expense plan', () => {
  const data = state([
    expense('prior', '2026-08-01', 2000, { category: 'software' }), expense('current', '2026-09-01', 3000, { category: 'coffee', expenseCategory: 'Work' }),
    expense('business-past', '2026-08-02', 9000, { category: 'software', accountId: 'shop-bank' }), expense('business-current', '2026-09-02', 2000, { category: 'software', accountId: 'shop-bank' }),
    expense('payment', '2026-08-03', 5000, { kind: 'debt_payment' }),
  ]);
  data.spendingLimits = [{ id: 'me:work', entityId: 'me', name: 'Work', aliases: ['software'], color: '#ABCDEF', dailyCents: null, weeklyCents: null, monthlyCents: null }];
  const before = structuredClone(data);
  const comparison = buildExpenseComparison(data, 'me', '2026-09', '2026-09-25');
  assert.deepEqual(comparison.byCategoryId.get('me:work'), { spentCents: 2000, transactionCount: 1, differenceCents: 1000, direction: 'higher' });
  assert.equal(comparison.byCategoryId.get('me:food')?.direction, 'unavailable');
  assert.deepEqual(data, before);
  const business = buildExpenseComparison(data, 'shop', '2026-09', '2026-09-25');
  assert.deepEqual(business.byCategoryId.get('shop:digital'), { spentCents: 9000, transactionCount: 1, differenceCents: -7000, direction: 'lower' });
});

test('future selections have no comparison even with recorded history in the prior month', () => {
  const comparison = buildExpenseComparison(state([
    expense('now', '2026-09-01', 2000), expense('future', '2026-10-01', 4000),
  ]), 'me', '2026-10', '2026-09-25');
  assert.equal(comparison.hasHistory, false);
  assert.equal(comparison.partialPeriod, false);
  assert.ok([...comparison.byCategoryId.values()].every(row => row.differenceCents === null && row.direction === 'unavailable'));
});

test('coverage is complete only when every spending account covers both comparison months', () => {
  const data = state([expense('prior', '2026-08-01', 2000)]);
  assert.equal(buildExpenseComparison(data, 'me', '2026-09', '2026-10-01').coverageComplete, false);
  data.statements = [{ id: 'bank-statement', accountId: 'bank', sourceFile: 'statement.pdf', sha256: 'a'.repeat(64), periodStart: '2026-08-01', periodEnd: '2026-09-30', openingBalanceCents: 0, closingBalanceCents: 0, rows: [] }];
  assert.equal(buildExpenseComparison(data, 'me', '2026-09', '2026-10-01').coverageComplete, true);
  assert.equal(buildExpenseComparison(data, 'shop', '2026-09', '2026-10-01').coverageComplete, false);
  data.statements[0].periodEnd = '2026-09-29';
  assert.equal(buildExpenseComparison(data, 'me', '2026-09', '2026-10-01').coverageComplete, false);
  data.statements[0].periodEnd = '2026-09-30';
  data.accounts.push({ ...data.accounts[0], id: 'second-bank' });
  assert.equal(buildExpenseComparison(data, 'me', '2026-09', '2026-10-01').coverageComplete, false);
});
