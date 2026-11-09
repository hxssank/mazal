import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shiftCalendarMonth, spendingCalendar, summarizeSpendingMonth } from './spending-calendar.ts';
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
  return { id, date: '2026-09-23', description: id, kind: 'expense', amountCents: 1234, accountId: 'bank', toAccountId: null, category: 'Food', source: 'Manual entry', createdAt: '2026-09-23T12:00:00Z', ...overrides };
}

test('daily spending counts cash and card expenses without double-counting transfers or debt payments', () => {
  const data = state();
  data.transactions = [entry('cash'), entry('card', { accountId: 'card', amountCents: 5000 }), entry('payment', { kind: 'debt_payment', toAccountId: 'card' }), entry('transfer', { kind: 'transfer', toAccountId: 'studio-bank' }), entry('income', { kind: 'income' }), entry('opening', { kind: 'opening' }), entry('reconcile', { kind: 'adjustment' })];
  const month = spendingCalendar(data, 'me', '2026-09', '2026-09-23');
  assert.equal(month.totalCents, 6234);
  assert.equal(month.transactionCount, 2);
  assert.equal(month.days[22].totalCents, 6234);
  assert.deepEqual(month.days[22].entries.map(item => item.transaction.id), ['card', 'cash']);
});

test('all-owner totals round each expense using the owner share while a selected owner keeps full amounts', () => {
  const data = state();
  data.transactions = [entry('personal'), entry('studio-1', { accountId: 'studio-bank', amountCents: 101 }), entry('studio-2', { accountId: 'studio-bank', amountCents: 101 })];
  const all = spendingCalendar(data, 'all', '2026-09', '2026-09-23');
  assert.equal(all.totalCents, 1234 + 51 + 51);
  assert.equal(all.hasWeightedExpenses, true);
  const studio = all.days[22].entries.find(item => item.transaction.id === 'studio-1')!;
  assert.equal(studio.recordedAmountCents, 101);
  assert.equal(studio.amountCents, 51);
  assert.equal(studio.ownershipBps, 5000);
  assert.equal(studio.accountName, 'Studio bank');
  assert.equal(studio.ownerName, 'Studio');
  const selected = spendingCalendar(data, 'studio', '2026-09', '2026-09-23');
  assert.equal(selected.totalCents, 202);
  assert.equal(selected.hasWeightedExpenses, false);
});

test('future and other-month entries are excluded and missing account links do not enter totals', () => {
  const data = state();
  data.transactions = [entry('today'), entry('future', { date: '2026-09-24' }), entry('older', { date: '2026-08-31' }), entry('missing', { accountId: 'missing' })];
  const month = spendingCalendar(data, 'all', '2026-09', '2026-09-23');
  assert.equal(month.totalCents, 1234);
  assert.equal(month.days[22].isFuture, false);
  assert.equal(month.days[23].isFuture, true);
  assert.equal(month.days[23].entries.length, 0);
  assert.equal(spendingCalendar(data, 'all', '2026-08', '2026-09-23').totalCents, 1234);
});

test('empty days and an empty month remain zero and keep the complete calendar shape', () => {
  const month = spendingCalendar(state(), 'all', '2026-09', '2026-09-23');
  assert.equal(month.days.length, 30);
  assert.equal(month.firstWeekday, 1);
  assert.equal(month.totalCents, 0);
  assert.equal(month.transactionCount, 0);
  assert.equal(month.largestDayCents, 0);
  assert.ok(month.days.every(day => day.totalCents === 0 && day.entries.length === 0));
});

test('calendar dates handle leap days and month navigation crosses year boundaries', () => {
  assert.equal(spendingCalendar(state(), 'all', '2028-02', '2028-03-01').days.at(-1)!.date, '2028-02-29');
  assert.equal(spendingCalendar(state(), 'all', '2026-02', '2026-03-01').days.length, 28);
  assert.equal(shiftCalendarMonth('2026-12', 1), '2027-01');
  assert.equal(shiftCalendarMonth('2026-01', -1), '2025-12');
  assert.throws(() => shiftCalendarMonth('2026-13', 1), /calendar month/);
});

test('calendar selection leaves source entries unchanged and sorts each day by entry time', () => {
  const data = state();
  data.transactions = [entry('earlier', { createdAt: '2026-09-23T09:00:00Z' }), entry('later', { createdAt: '2026-09-23T18:00:00Z' }), entry('another-day', { date: '2026-09-22', amountCents: 2000 })];
  const original = structuredClone(data);
  const month = spendingCalendar(data, 'me', '2026-09', '2026-09-23');
  assert.deepEqual(month.days[22].entries.map(item => item.transaction.id), ['later', 'earlier']);
  assert.equal(month.largestDayCents, 2468);
  assert.equal(month.days.reduce((sum, day) => sum + day.totalCents, 0), month.totalCents);
  assert.deepEqual(data, original);
});

test('large supported expenses retain the exact rounded ownership share', () => {
  const data = state();
  data.entities[1].ownershipBps = 5001;
  data.transactions = [entry('large', { accountId: 'studio-bank', amountCents: 99999999999947 })];
  assert.equal(spendingCalendar(data, 'all', '2026-09', '2026-09-23').totalCents, 50009999999973);
});

test('an unsafe cumulative total fails instead of displaying imprecise cents', () => {
  const data = state();
  data.transactions = Array.from({ length: 91 }, (_, index) => entry(`large-${index}`, { amountCents: 100000000000000 }));
  assert.throws(() => spendingCalendar(data, 'all', '2026-09', '2026-09-23'), /supported amount/);
});

test('statement refunds reduce spending by their exact cents and card payments do not count twice', () => {
  const data = state();
  data.transactions = [
    entry('purchase', { accountId: 'card', amountCents: 3221 }),
    entry('refund', { accountId: 'card', amountCents: -3108 }),
    entry('payment', { accountId: 'card', kind: 'adjustment', category: 'Card payment', amountCents: -25000 }),
  ];
  for (const scope of ['me', 'all']) {
    const month = spendingCalendar(data, scope, '2026-09', '2026-09-23');
    assert.equal(month.totalCents, 113);
    assert.equal(month.transactionCount, 2);
    assert.equal(month.days[22].totalCents, 113);
    assert.equal(month.days[22].entries.find(item => item.transaction.id === 'refund')?.amountCents, -3108);
  }
});

test('ownership rounds purchases and refunds symmetrically so a full reversal leaves zero spending', () => {
  const data = state();
  data.transactions = [entry('purchase', { accountId: 'studio-bank', amountCents: 101 }), entry('refund', { accountId: 'studio-bank', amountCents: -101 })];
  const month = spendingCalendar(data, 'all', '2026-09', '2026-09-23');
  assert.equal(month.totalCents, 0);
  assert.equal(month.days[22].entries.find(item => item.transaction.id === 'purchase')?.amountCents, 51);
  assert.equal(month.days[22].entries.find(item => item.transaction.id === 'refund')?.amountCents, -51);
  data.entities[1].ownershipBps = 5001;
  data.transactions = [entry('large-refund', { accountId: 'studio-bank', amountCents: -99999999999947 })];
  assert.equal(spendingCalendar(data, 'all', '2026-09', '2026-09-23').totalCents, -50009999999973);
});

test('a refund-only day and month keep negative net spending', () => {
  const data = state();
  data.transactions = [entry('refund', { accountId: 'card', amountCents: -1 })];
  const month = spendingCalendar(data, 'me', '2026-09', '2026-09-23');
  assert.equal(month.totalCents, -1);
  assert.equal(month.days[22].totalCents, -1);
  assert.equal(month.transactionCount, 1);
  assert.equal(month.largestDayCents, 0);
});

test('month summary uses expense aliases and explicit category corrections without changing records', () => {
  const data = state();
  data.transactions = [
    entry('food', { category: 'Food & groceries', amountCents: 2000 }),
    entry('coffee', { category: 'Coffee', amountCents: 500 }),
    entry('gas', { category: 'Fuel & convenience', amountCents: 3000 }),
    entry('fees', { category: 'Interest', amountCents: 700 }),
    entry('corrected', { category: 'Food', expenseCategory: 'Career', amountCents: 1000 }),
  ];
  const month = spendingCalendar(data, 'me', '2026-09', '2026-09-23');
  const before = structuredClone({ data, month });
  const summary = summarizeSpendingMonth(data, month);
  assert.deepEqual(summary.categories, [
    { key: 'transport', label: 'Transport', totalCents: 3000 },
    { key: 'food', label: 'Food & groceries', totalCents: 2500 },
    { key: 'career', label: 'Career & learning', totalCents: 1000 },
    { key: 'fees', label: 'Fees & interest', totalCents: 700 },
  ]);
  assert.equal(summary.categories.reduce((sum, category) => sum + category.totalCents, 0), month.totalCents);
  assert.deepEqual({ data, month }, before);
});

test('month summary resolves planned payments by account owner and honors saved expense snapshots', () => {
  const data = state();
  data.obligations = [
    { id: 'phone', entityId: 'me', name: 'Phone', amountCents: 1000, dueDate: '2026-10-23', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Digital' },
    { id: 'streaming', entityId: 'studio', name: 'Streaming', amountCents: 400, dueDate: '2026-10-23', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'studio-bank', category: 'Digital', subscription: true },
  ];
  data.transactions = [
    entry('phone', { category: 'Digital', source: 'Planned payment phone', amountCents: 1000 }),
    entry('streaming', { accountId: 'studio-bank', category: 'Digital', source: 'Planned payment streaming', amountCents: 400 }),
    entry('same-source-other-owner', { accountId: 'studio-bank', category: 'Digital', source: 'Planned payment phone', amountCents: 600 }),
    entry('corrected-subscription', { accountId: 'studio-bank', category: 'Digital', expenseCategory: 'Personal', source: 'Planned payment streaming', amountCents: 800 }),
    entry('snapshot', { category: 'Digital', expenseCategory: 'Gym', source: 'Planned payment phone', amountCents: 500 }),
  ];
  const month = spendingCalendar(data, 'all', '2026-09', '2026-09-23');
  const summary = summarizeSpendingMonth(data, month);
  assert.deepEqual(summary.categories, [
    { key: 'bills', label: 'Bills', totalCents: 1000 },
    { key: 'personal', label: 'Personal care', totalCents: 900 },
    { key: 'digital', label: 'Digital purchases', totalCents: 300 },
    { key: 'subscriptions', label: 'Subscriptions', totalCents: 200 },
  ]);
  assert.equal(summary.categories.reduce((sum, category) => sum + category.totalCents, 0), month.totalCents);
});

test('month summary merges normalized custom labels with weighted cents and respects owner scope', () => {
  const data = state();
  data.spendingLimits = [
    { id: 'me:work', entityId: 'me', name: 'Work supplies', aliases: ['Food'], color: '#ABCDEF', dailyCents: null, weeklyCents: null, monthlyCents: null },
    { id: 'studio:supplies', entityId: 'studio', name: 'ＷＯＲＫ  supplies', aliases: ['Software'], color: '#ABCDEF', dailyCents: null, weeklyCents: null, monthlyCents: null },
  ];
  data.transactions = [
    entry('personal-work', { amountCents: 1000, date: '2026-09-21' }),
    entry('personal-groceries', { category: 'Groceries', amountCents: 100 }),
    entry('studio-work', { accountId: 'studio-bank', category: 'Software', amountCents: 101 }),
    entry('studio-food', { accountId: 'studio-bank', category: 'Food', amountCents: 101 }),
    entry('studio-food-refund', { accountId: 'studio-bank', category: 'Food', amountCents: -1 }),
  ];
  const all = spendingCalendar(data, 'all', '2026-09', '2026-09-23');
  assert.deepEqual(summarizeSpendingMonth(data, all).categories, [
    { key: 'custom:work supplies', label: 'Work supplies', totalCents: 1051 },
    { key: 'food', label: 'Food & groceries', totalCents: 150 },
  ]);
  const personal = spendingCalendar(data, 'me', '2026-09', '2026-09-23');
  assert.deepEqual(summarizeSpendingMonth(data, personal).categories, [
    { key: 'custom:work supplies', label: 'Work supplies', totalCents: 1000 },
    { key: 'food', label: 'Food & groceries', totalCents: 100 },
  ]);
  const studio = spendingCalendar(data, 'studio', '2026-09', '2026-09-23');
  assert.deepEqual(summarizeSpendingMonth(data, studio).categories, [
    { key: 'custom:work supplies', label: 'ＷＯＲＫ  supplies', totalCents: 101 },
    { key: 'food', label: 'Food & groceries', totalCents: 100 },
  ]);
  for (const month of [all, personal, studio]) assert.equal(summarizeSpendingMonth(data, month).categories.reduce((sum, category) => sum + category.totalCents, 0), month.totalCents);
});

test('month summary preserves renamed template labels and sorts equal category totals by label', () => {
  const data = state();
  data.spendingLimits = [{ id: 'me:food', entityId: 'me', name: 'Meals', aliases: ['Food', 'Groceries'], color: '#ABCDEF', dailyCents: null, weeklyCents: null, monthlyCents: null }];
  data.transactions = [entry('meal', { amountCents: 100 }), entry('gas', { category: 'Gas', amountCents: 100 }), entry('interest', { category: 'Interest', amountCents: 100 })];
  const month = spendingCalendar(data, 'me', '2026-09', '2026-09-23');
  assert.deepEqual(summarizeSpendingMonth(data, month).categories, [
    { key: 'fees', label: 'Fees & interest', totalCents: 100 },
    { key: 'food', label: 'Meals', totalCents: 100 },
    { key: 'transport', label: 'Transport', totalCents: 100 },
  ]);
});

test('month summary keeps refunds and zero-net days and chooses the highest positive net day', () => {
  const data = state();
  data.transactions = [
    entry('purchase', { date: '2026-09-20', amountCents: 900 }),
    entry('refund', { date: '2026-09-20', amountCents: -900 }),
    entry('refund-only', { date: '2026-09-21', category: 'Trips', amountCents: -500 }),
    entry('largest', { date: '2026-09-22', category: 'Transport', amountCents: 400 }),
    entry('same-total-later', { date: '2026-09-23', category: 'Transport', amountCents: 400 }),
    entry('future', { date: '2026-09-24', amountCents: 9999 }),
  ];
  const month = spendingCalendar(data, 'me', '2026-09', '2026-09-23');
  const summary = summarizeSpendingMonth(data, month);
  assert.equal(summary.daysWithExpenses, 4);
  assert.equal(summary.highestDay, month.days[21]);
  assert.deepEqual(summary.categories, [
    { key: 'transport', label: 'Transport', totalCents: 800 },
    { key: 'food', label: 'Food & groceries', totalCents: 0 },
    { key: 'trips', label: 'Trips', totalCents: -500 },
  ]);
  assert.equal(summary.categories.reduce((sum, category) => sum + category.totalCents, 0), month.totalCents);
});

test('empty and nonpositive months have no highest spending day', () => {
  const data = state();
  assert.deepEqual(summarizeSpendingMonth(data, spendingCalendar(data, 'me', '2026-09', '2026-09-23')), { categories: [], daysWithExpenses: 0, highestDay: null });
  data.transactions = [entry('refund', { amountCents: -100 }), entry('zero', { amountCents: 0, date: '2026-09-22' })];
  const summary = summarizeSpendingMonth(data, spendingCalendar(data, 'me', '2026-09', '2026-09-23'));
  assert.equal(summary.highestDay, null);
  assert.equal(summary.daysWithExpenses, 2);
  assert.deepEqual(summary.categories, [{ key: 'food', label: 'Food & groceries', totalCents: -100 }]);
});
