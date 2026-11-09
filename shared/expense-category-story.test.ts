import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExpenseCategoryStory } from './expense-category-story.ts';
import { spendingCalendar, summarizeSpendingMonth } from './spending-calendar.ts';
import type { AppState, Transaction } from './types.ts';

function state(): AppState {
  return {
    workspace: 'live', revision: 0,
    entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'studio', name: 'Studio', kind: 'business', ownershipBps: 5000 }],
    accounts: [
      { id: 'bank', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null },
      { id: 'studio-bank', entityId: 'studio', name: 'Studio bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null },
    ],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

function entry(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return { id, date: '2026-10-14', description: id, kind: 'expense', amountCents: 1000, accountId: 'bank', toAccountId: null, category: 'Food', source: 'Manual entry', createdAt: '2026-10-14T12:00:00Z', ...overrides };
}

test('category stories combine matching descriptions and preserve signed refunds separately from charges', () => {
  const data = state();
  data.transactions = [
    entry('coffee-1', { description: ' Cafe  One ', amountCents: 500, category: 'Coffee' }),
    entry('coffee-2', { description: 'cafe one', amountCents: 700 }),
    entry('refund', { description: 'Refund received', amountCents: -200, refundOf: 'coffee-1' }),
    entry('groceries', { description: 'Grocery store', amountCents: 2000, category: 'Groceries' }),
    entry('fuel', { description: 'Fuel station', amountCents: 8000, category: 'Gas' }),
  ];
  const month = spendingCalendar(data, 'me', '2026-10', '2026-10-15');
  const story = buildExpenseCategoryStory(data, 'me', month, 'food');
  assert.equal(story.categoryLabel, 'Food & groceries');
  assert.equal(story.totalCents, 3000);
  assert.equal(story.chargedCents, 3200);
  assert.equal(story.refundCents, -200);
  assert.equal(story.entryCount, 4);
  assert.equal(story.chargeCount, 3);
  assert.equal(story.refundCount, 1);
  assert.equal(story.merchantCount, 2);
  assert.deepEqual(story.merchants.map(merchant => [merchant.key, merchant.totalCents, merchant.entryCount]), [['grocery store', 2000, 1], ['cafe one', 1000, 3]]);
  assert.equal(buildExpenseCategoryStory(data, 'me', month).totalCents, month.totalCents);
});

test('stories use projected cents and owner category aliases without recomputing ownership', () => {
  const data = state();
  data.spendingLimits = [
    { id: 'me:food', entityId: 'me', name: 'Meals', aliases: ['Food', 'Groceries'], color: '#ABCDEF', dailyCents: null, weeklyCents: null, monthlyCents: null },
    { id: 'studio:supplies', entityId: 'studio', name: 'Work supplies', aliases: ['Food', 'Software'], color: '#ABCDEF', dailyCents: null, weeklyCents: null, monthlyCents: null },
  ];
  data.transactions = [entry('personal'), entry('studio', { accountId: 'studio-bank', amountCents: 101 }), entry('studio-refund', { accountId: 'studio-bank', amountCents: -1 })];
  const month = spendingCalendar(data, 'all', '2026-10', '2026-10-15');
  for (const category of summarizeSpendingMonth(data, month).categories) {
    const story = buildExpenseCategoryStory(data, 'all', month, category.key);
    assert.equal(story.categoryLabel, category.label);
    assert.equal(story.totalCents, category.totalCents);
  }
  const studio = buildExpenseCategoryStory(data, 'all', month, 'custom:work supplies');
  assert.equal(studio.chargedCents, 51);
  assert.equal(studio.refundCents, -1);
  assert.equal(buildExpenseCategoryStory(data, 'me', month).totalCents, 1000);
  const selectedOwner = spendingCalendar(data, 'studio', '2026-10', '2026-10-15');
  assert.equal(buildExpenseCategoryStory(data, 'studio', selectedOwner).totalCents, 100);
  selectedOwner.days[13].entries.find(item => item.transaction.id === 'studio')!.amountCents = 23;
  assert.equal(buildExpenseCategoryStory(data, 'studio', selectedOwner).totalCents, 22);
});

test('largest merchant totals rank net impact after refunds rather than original charges', () => {
  const data = state();
  data.transactions = [
    entry('purchase', { description: 'Partly returned purchase', amountCents: 10000 }),
    entry('partial-refund', { description: 'Returned items', amountCents: -8000, refundOf: 'purchase' }),
    entry('meal', { description: 'Meal', amountCents: 5000 }),
    entry('large-refund', { description: 'Previous purchase refund', amountCents: -7000 }),
    entry('equal-refund', { description: 'Another refund', amountCents: -5000 }),
  ];
  const month = spendingCalendar(data, 'me', '2026-10', '2026-10-15');
  const story = buildExpenseCategoryStory(data, 'me', month, 'food');
  assert.deepEqual(story.merchants.map(merchant => [merchant.name, merchant.totalCents]), [
    ['Previous purchase refund', -7000],
    ['Meal', 5000],
    ['Another refund', -5000],
    ['Partly returned purchase', 2000],
  ]);
  assert.equal(story.merchants.at(-1)!.chargedCents, 10000);
  assert.equal(story.totalCents, month.totalCents);
});

test('planned bill categories and explicit category corrections match the spending month summary', () => {
  const data = state();
  data.obligations = [{ id: 'app', entityId: 'me', name: 'App', amountCents: 2000, dueDate: '2026-11-14', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Digital', subscription: true }];
  data.transactions = [
    entry('bill', { category: 'Digital', source: 'Planned payment app' }),
    entry('corrected', { category: 'Digital', expenseCategory: 'Career', source: 'Planned payment app' }),
    entry('other-owner', { accountId: 'studio-bank', category: 'Digital', source: 'Planned payment app' }),
  ];
  const month = spendingCalendar(data, 'all', '2026-10', '2026-10-15');
  for (const category of summarizeSpendingMonth(data, month).categories) {
    const story = buildExpenseCategoryStory(data, 'all', month, category.key);
    assert.equal(story.categoryLabel, category.label);
    assert.equal(story.totalCents, category.totalCents);
  }
  assert.equal(buildExpenseCategoryStory(data, 'all', month, 'subscriptions').entryCount, 1);
});

test('same-month reversals and their originals count as corrections rather than charges and refunds', () => {
  const data = state();
  data.transactions = [
    entry('original', { description: 'Store', amountCents: 4000 }),
    entry('reverse', { description: 'Reverse expense', amountCents: -4000, reversalOf: 'original' }),
    entry('replacement', { description: 'Store', amountCents: 3000, replacesId: 'original' }),
    entry('refund', { description: 'Store refund', amountCents: -500, refundOf: 'replacement' }),
  ];
  const month = spendingCalendar(data, 'me', '2026-10', '2026-10-15');
  const story = buildExpenseCategoryStory(data, 'me', month, 'food');
  assert.equal(story.totalCents, 2500);
  assert.equal(story.chargedCents, 3000);
  assert.equal(story.refundCents, -500);
  assert.equal(story.correctionCents, 0);
  assert.equal(story.chargeCount, 1);
  assert.equal(story.refundCount, 1);
  assert.equal(story.correctionCount, 2);
  assert.equal(story.merchantCount, 1);
  assert.equal(story.merchants[0].entryCount, 4);
});

test('cross-month corrections remain signed and do not turn into refunds', () => {
  const data = state();
  data.transactions = [
    entry('original', { date: '2026-09-30', description: 'Old store', amountCents: 4000 }),
    entry('reverse', { description: 'Reverse expense', amountCents: -4000, reversalOf: 'original' }),
    entry('refund', { description: 'Other refund', amountCents: -500 }),
  ];
  const month = spendingCalendar(data, 'me', '2026-10', '2026-10-15');
  const story = buildExpenseCategoryStory(data, 'me', month, 'food');
  assert.equal(story.totalCents, month.totalCents);
  assert.equal(story.chargedCents, 0);
  assert.equal(story.refundCents, -500);
  assert.equal(story.correctionCents, -4000);
  assert.equal(story.refundCount, 1);
  assert.equal(story.correctionCount, 1);
  assert.equal(story.merchants.find(merchant => merchant.key === 'old store')?.correctionCents, -4000);
  const previous = spendingCalendar(data, 'me', '2026-09', '2026-10-15');
  assert.equal(buildExpenseCategoryStory(data, 'me', previous).chargedCents, 4000);
});

test('merchant links cannot cross owners and distinct bank reference descriptions stay distinct', () => {
  const data = state();
  data.transactions = [
    entry('business', { accountId: 'studio-bank', description: 'Business merchant' }),
    entry('refund', { description: 'Personal refund', amountCents: -200, refundOf: 'business' }),
    entry('shop-a', { description: 'SHOP #1234' }),
    entry('shop-b', { description: 'SHOP #5678' }),
  ];
  const month = spendingCalendar(data, 'me', '2026-10', '2026-10-15');
  const before = structuredClone({ data, month });
  const story = buildExpenseCategoryStory(data, 'me', month, 'food');
  assert.equal(story.merchantCount, 3);
  assert.ok(story.merchants.some(merchant => merchant.name === 'Personal refund'));
  assert.ok(!story.merchants.some(merchant => merchant.name === 'Business merchant'));
  assert.deepEqual({ data, month }, before);
});

test('empty category selection returns zero values without borrowing another category', () => {
  const data = state();
  data.transactions = [entry('food')];
  const month = spendingCalendar(data, 'me', '2026-10', '2026-10-15');
  const story = buildExpenseCategoryStory(data, 'me', month, 'subscriptions');
  assert.equal(story.categoryKey, 'subscriptions');
  assert.equal(story.categoryLabel, null);
  assert.equal(story.totalCents, 0);
  assert.equal(story.entryCount, 0);
  assert.deepEqual(story.merchants, []);
});
