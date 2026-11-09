import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReviewPeriod } from './review-period.ts';
import { spendingCalendar } from './spending-calendar.ts';
import type { AppState, Transaction } from './types.ts';

function state(): AppState {
  return {
    workspace: 'live', revision: 0,
    entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'studio', name: 'Studio', kind: 'business', ownershipBps: 5000 }],
    accounts: [
      { id: 'bank', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null },
      { id: 'card', entityId: 'me', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 50000, reconciledAt: null },
      { id: 'studio-bank', entityId: 'studio', name: 'Studio bank', type: 'cash', currency: 'CAD', balanceCents: 200000, reconciledAt: null },
    ],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

function entry(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return { id, date: '2026-10-15', description: id, kind: 'expense', amountCents: 1000, accountId: 'bank', toAccountId: null, category: 'Food', source: 'Manual entry', createdAt: '2026-10-15T12:00:00Z', ...overrides };
}

test('current week uses Monday through today and compares the same elapsed days last week', () => {
  const data = state();
  data.transactions = [
    entry('monday', { date: '2026-10-12', amountCents: 1200 }),
    entry('today', { amountCents: 300 }),
    entry('future-friday', { date: '2026-10-16', amountCents: 99900 }),
    entry('prior-monday', { date: '2026-10-05', amountCents: 500 }),
    entry('prior-thursday', { date: '2026-10-08', amountCents: 100 }),
    entry('prior-friday', { date: '2026-10-09', amountCents: 77700 }),
  ];
  const review = buildReviewPeriod(data, 'me', '2026-10-15', 'weekly');
  assert.deepEqual([review.start, review.end, review.through], ['2026-10-12', '2026-10-18', '2026-10-15']);
  assert.deepEqual([review.previous.start, review.previous.end, review.previous.through], ['2026-10-05', '2026-10-11', '2026-10-08']);
  assert.equal(review.dayCount, 7);
  assert.equal(review.elapsedDays, 4);
  assert.equal(review.expensesCents, 1500);
  assert.equal(review.previous.expensesCents, 600);
  assert.equal(review.expenseDifferenceCents, 900);
  assert.equal(review.expenseChangePercent, 150);
  assert.equal(review.isComplete, false);
  assert.equal(review.isCurrent, true);
  assert.deepEqual(review.days.filter(day => day.isFuture).map(day => day.date), ['2026-10-16', '2026-10-17', '2026-10-18']);
  assert.equal(review.days.reduce((sum, day) => sum + day.expensesCents, 0), review.expensesCents);
});

test('completed weeks compare the full prior week including its weekend', () => {
  const data = state();
  data.transactions = [entry('prior-sunday', { date: '2026-10-11', amountCents: 900 }), entry('earlier-sunday', { date: '2026-10-04', amountCents: 600 })];
  const review = buildReviewPeriod(data, 'all', '2026-10-15', 'weekly', -1);
  assert.deepEqual([review.start, review.end, review.through], ['2026-10-05', '2026-10-11', '2026-10-11']);
  assert.deepEqual([review.previous.start, review.previous.through], ['2026-09-28', '2026-10-04']);
  assert.equal(review.expensesCents, 900);
  assert.equal(review.previous.expensesCents, 600);
  assert.equal(review.elapsedDays, 7);
  assert.equal(review.isComplete, true);
  assert.equal(review.isCurrent, false);
  assert.ok(review.days.every(day => !day.isFuture));
});

test('month comparisons cap elapsed days at the prior month end and use full completed months', () => {
  const data = state();
  const current = buildReviewPeriod(data, 'all', '2028-03-31', 'monthly');
  assert.deepEqual([current.start, current.end, current.previous.start, current.previous.end, current.previous.through], ['2028-03-01', '2028-03-31', '2028-02-01', '2028-02-29', '2028-02-29']);
  const completed = buildReviewPeriod(data, 'all', '2028-03-04', 'monthly', -1);
  assert.deepEqual([completed.start, completed.end, completed.previous.start, completed.previous.through], ['2028-02-01', '2028-02-29', '2028-01-01', '2028-01-31']);
  assert.equal(completed.dayCount, 29);
  assert.equal(completed.days.at(-1)?.date, '2028-02-29');
  const partial = buildReviewPeriod(data, 'all', '2026-10-15', 'monthly');
  assert.equal(partial.previous.through, '2026-09-15');
});

test('day, month and Monday-based week navigation crosses calendar years without timezone shifts', () => {
  const data = state();
  const day = buildReviewPeriod(data, 'all', '2027-01-01', 'daily');
  assert.deepEqual([day.start, day.end, day.previous.start], ['2027-01-01', '2027-01-01', '2026-12-31']);
  const week = buildReviewPeriod(data, 'all', '2027-01-01', 'weekly');
  assert.deepEqual([week.start, week.end, week.previous.through], ['2026-12-28', '2027-01-03', '2026-12-25']);
  const sunday = buildReviewPeriod(data, 'all', '2027-01-03', 'weekly');
  assert.equal(sunday.start, '2026-12-28');
  assert.equal(sunday.elapsedDays, 7);
  const monday = buildReviewPeriod(data, 'all', '2027-01-04', 'weekly');
  assert.equal(monday.start, '2027-01-04');
  assert.equal(monday.previous.through, '2026-12-28');
  const month = buildReviewPeriod(data, 'all', '2027-01-01', 'monthly', -1);
  assert.deepEqual([month.start, month.end, month.previous.start], ['2026-12-01', '2026-12-31', '2026-11-01']);
});

test('refunds reduce spending while transfers, debt payments, opening balances and corrections are not income or spending', () => {
  const data = state();
  data.transactions = [
    entry('purchase', { accountId: 'card', amountCents: 3200 }),
    entry('refund', { accountId: 'card', amountCents: -700, refundOf: 'purchase' }),
    entry('pay', { kind: 'income', amountCents: 10000 }),
    entry('transfer', { kind: 'transfer', toAccountId: 'studio-bank', amountCents: 80000 }),
    entry('payment', { kind: 'debt_payment', toAccountId: 'card', amountCents: 90000 }),
    entry('opening', { kind: 'opening', amountCents: 900000 }),
    entry('reconciliation', { kind: 'adjustment', amountCents: 900000 }),
  ];
  const review = buildReviewPeriod(data, 'me', '2026-10-15', 'daily');
  assert.equal(review.expensesCents, 2500);
  assert.equal(review.grossExpensesCents, 3200);
  assert.equal(review.refundsCents, 700);
  assert.equal(review.incomeCents, 10000);
  assert.equal(review.netCents, 7500);
  assert.equal(review.recordCount, 3);
  assert.equal(review.expenseCount, 2);
  assert.equal(review.incomeCount, 1);
  assert.equal(review.activityCount, 5);
  assert.deepEqual(new Set(review.latestTransactions.map(transaction => transaction.kind)), new Set(['expense', 'income', 'transfer', 'debt_payment']));
  assert.equal(review.categories[0].totalCents, 2500);
  assert.equal(review.activity.find(item => item.transaction.id === 'refund')?.amountCents, -700);
});

test('signed corrections stay in totals and activity while category review omits canceled entries', () => {
  const data = state();
  data.transactions = [
    entry('original', { category: 'Uncategorized', amountCents: 3000 }),
    entry('reversal', { category: 'Uncategorized', amountCents: -3000, reversalOf: 'original' }),
    entry('replacement', { category: 'Uncategorized', amountCents: 2500, replacesId: 'original' }),
    entry('removed', { category: 'Uncategorized', amountCents: 900 }),
    entry('removed-reversal', { category: 'Uncategorized', amountCents: -900, reversalOf: 'removed' }),
    entry('refund', { category: 'Uncategorized', amountCents: -500, refundOf: 'replacement' }),
    entry('income', { kind: 'income', amountCents: 4000 }),
    entry('income-reversal', { kind: 'income', amountCents: -4000, reversalOf: 'income' }),
    entry('classified', { category: 'Uncategorized', expenseCategory: 'Transport', amountCents: 300 }),
    entry('future', { category: 'Uncategorized', date: '2026-10-16' }),
  ];
  const review = buildReviewPeriod(data, 'me', '2026-10-15', 'monthly');
  assert.equal(review.expensesCents, 2300);
  assert.equal(review.incomeCents, 0);
  assert.equal(review.recordCount, 9);
  assert.equal(review.uncategorizedCount, 2);
  assert.deepEqual(new Set(review.latestTransactions.map(transaction => transaction.id)), new Set(['original', 'reversal', 'replacement', 'removed', 'removed-reversal', 'refund', 'income', 'income-reversal', 'classified']));
  assert.deepEqual(review.categories.map(category => [category.key, category.totalCents, category.recordCount]), [['other', 2000, 6], ['transport', 300, 1]]);
});

test('cross-month corrections use their signed transaction dates and match the spending calendar', () => {
  const data = state();
  data.transactions = [
    entry('september-purchase', { date: '2026-09-30', amountCents: 10000, category: 'Uncategorized' }),
    entry('october-reversal', { date: '2026-10-02', amountCents: -10000, reversalOf: 'september-purchase', category: 'Uncategorized' }),
    entry('september-income', { date: '2026-09-30', kind: 'income', amountCents: 50000 }),
    entry('october-income-reversal', { date: '2026-10-02', kind: 'income', amountCents: -50000, reversalOf: 'september-income' }),
  ];
  const september = buildReviewPeriod(data, 'me', '2026-10-15', 'monthly', -1);
  const october = buildReviewPeriod(data, 'me', '2026-10-15', 'monthly');
  assert.equal(september.expensesCents, 10000);
  assert.equal(october.expensesCents, -10000);
  assert.equal(september.incomeCents, 50000);
  assert.equal(october.incomeCents, -50000);
  assert.equal(september.netCents, 40000);
  assert.equal(october.netCents, -40000);
  assert.equal(september.expensesCents, spendingCalendar(data, 'me', '2026-09', '2026-10-15').totalCents);
  assert.equal(october.expensesCents, spendingCalendar(data, 'me', '2026-10', '2026-10-15').totalCents);
  assert.equal(september.categories[0].totalCents, 10000);
  assert.equal(october.categories[0].totalCents, -10000);
  assert.equal(september.uncategorizedCount, 0);
  assert.equal(october.uncategorizedCount, 0);
  assert.ok(october.latestTransactions.every(transaction => !!transaction.reversalOf));
});

test('all scopes weight income and signed expenses per record while owner scopes keep full amounts', () => {
  const data = state();
  data.transactions = [
    entry('personal', { amountCents: 1000 }),
    entry('studio', { accountId: 'studio-bank', amountCents: 101 }),
    entry('studio-refund', { accountId: 'studio-bank', amountCents: -1 }),
    entry('studio-income', { accountId: 'studio-bank', kind: 'income', amountCents: 105 }),
    entry('fund-studio', { kind: 'transfer', toAccountId: 'studio-bank', amountCents: 20001 }),
    entry('missing-account', { accountId: 'missing', amountCents: 999999 }),
  ];
  const all = buildReviewPeriod(data, 'all', '2026-10-15', 'daily');
  assert.equal(all.expensesCents, 1050);
  assert.equal(all.incomeCents, 53);
  assert.equal(all.hasWeightedAmounts, true);
  const studioEntry = all.activity.find(item => item.transaction.id === 'studio')!;
  assert.deepEqual([studioEntry.amountCents, studioEntry.recordedAmountCents, studioEntry.ownershipBps, studioEntry.ownerName, studioEntry.accountName], [51, 101, 5000, 'Studio', 'Studio bank']);
  assert.equal(all.activity.find(item => item.transaction.id === 'fund-studio')?.amountCents, 20001);
  const studio = buildReviewPeriod(data, 'studio', '2026-10-15', 'daily');
  assert.equal(studio.expensesCents, 100);
  assert.equal(studio.incomeCents, 105);
  assert.equal(studio.hasWeightedAmounts, false);
  assert.equal(studio.activityCount, 4);
  assert.ok(studio.latestTransactions.some(transaction => transaction.id === 'fund-studio'));
  assert.equal(buildReviewPeriod(data, 'me', '2026-10-15', 'daily').expensesCents, 1000);
  assert.equal(buildReviewPeriod(data, 'unknown', '2026-10-15', 'daily').activityCount, 0);
});

test('net worth exclusions and closed accounts do not erase their recorded spending', () => {
  const data = state();
  data.accounts[1].excludeFromNetWorth = true;
  data.accounts[1].closedAt = '2026-10-15';
  data.transactions = [entry('card-purchase', { accountId: 'card', amountCents: 5000 })];
  assert.equal(buildReviewPeriod(data, 'me', '2026-10-15', 'monthly').expensesCents, 5000);
});

test('category aliases, saved labels and explicit categories match the expense calendar', () => {
  const data = state();
  data.spendingLimits = [{ id: 'me:food', entityId: 'me', name: 'Meals', aliases: ['Food', 'Groceries', 'Coffee'], color: '#123456', dailyCents: null, weeklyCents: null, monthlyCents: null }];
  data.transactions = [
    entry('food', { amountCents: 1000 }),
    entry('coffee', { category: 'Coffee', amountCents: 200 }),
    entry('gas', { category: 'Fuel & convenience', amountCents: 800 }),
    entry('corrected', { category: 'Food', expenseCategory: 'Career', amountCents: 300 }),
  ];
  const review = buildReviewPeriod(data, 'me', '2026-10-15', 'monthly');
  assert.deepEqual(review.categories.map(category => [category.key, category.label, category.totalCents]), [['food', 'Meals', 1200], ['transport', 'Transport', 800], ['career', 'Career & learning', 300]]);
  assert.equal(review.categories[0].color, '#123456');
  assert.equal(review.activity.find(item => item.transaction.id === 'corrected')?.categoryKey, 'career');
  assert.equal(review.categories.reduce((sum, category) => sum + category.totalCents, 0), review.expensesCents);
});

test('empty, zero-net and refund-only periods remain distinct and avoid a misleading percent baseline', () => {
  const data = state();
  const empty = buildReviewPeriod(data, 'me', '2026-10-15', 'daily');
  assert.equal(empty.expensesCents, 0);
  assert.equal(empty.hasRecords, false);
  assert.equal(empty.expenseChangePercent, null);
  data.transactions = [entry('purchase'), entry('refund', { amountCents: -1000 })];
  const zero = buildReviewPeriod(data, 'me', '2026-10-15', 'daily');
  assert.equal(zero.expensesCents, 0);
  assert.equal(zero.hasRecords, true);
  assert.equal(zero.recordCount, 2);
  assert.equal(zero.categories[0].totalCents, 0);
  data.transactions = [entry('refund', { amountCents: -800 }), entry('previous-refund', { date: '2026-10-14', amountCents: -1000 })];
  const refunds = buildReviewPeriod(data, 'me', '2026-10-15', 'daily');
  assert.equal(refunds.expensesCents, -800);
  assert.equal(refunds.expenseDifferenceCents, 200);
  assert.equal(refunds.expenseChangePercent, null);
  assert.equal(refunds.categories[0].totalCents, -800);
});

test('daily review includes no future records and returns the full sorted activity without mutating the state', () => {
  const data = state();
  data.transactions = [
    entry('old', { date: '2026-10-14' }),
    ...Array.from({ length: 8 }, (_, index) => entry(`record-${index}`, { createdAt: `2026-10-15T${String(index + 10).padStart(2, '0')}:00:00Z` })),
    entry('future', { date: '2026-10-16' }),
  ];
  const original = structuredClone(data);
  const review = buildReviewPeriod(data, 'all', '2026-10-15', 'daily');
  assert.equal(review.latestTransactions.length, 8);
  assert.equal(review.latestTransactions[0].id, 'record-7');
  assert.equal(review.latestTransactions.at(-1)?.id, 'record-0');
  assert.equal(review.days[0].recordCount, 8);
  assert.deepEqual(data, original);
});

test('invalid dates and future or fractional offsets fail before producing a review', () => {
  for (const asOf of ['2026-02-30', 'not-a-date', '2026-13-01']) assert.throws(() => buildReviewPeriod(state(), 'all', asOf, 'daily'), /valid review date/);
  for (const offset of [1, -0.5, Infinity, Number.MIN_SAFE_INTEGER]) assert.throws(() => buildReviewPeriod(state(), 'all', '2026-10-15', 'monthly', offset));
});

test('ownership rounds large supported cents exactly and unsafe totals fail', () => {
  const data = state();
  data.entities[1].ownershipBps = 5001;
  data.transactions = [entry('large', { accountId: 'studio-bank', amountCents: 99999999999947 })];
  assert.equal(buildReviewPeriod(data, 'all', '2026-10-15', 'daily').expensesCents, 50009999999973);
  data.transactions = Array.from({ length: 91 }, (_, index) => entry(`large-${index}`, { amountCents: 100000000000000 }));
  assert.throws(() => buildReviewPeriod(data, 'all', '2026-10-15', 'daily'), /supported amount/);
});
