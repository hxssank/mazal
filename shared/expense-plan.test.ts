import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.ts';
import { buildExpensePlan, createExpensePlanCategory, expensePlanCategory, expensePlanLimits, expensePlanTransactionCategory, parseExpensePlanAmount } from './expense-plan.ts';
import type { AppState, SpendingLimit, Transaction } from './types.ts';

function state(): AppState {
  return {
    workspace: 'live', revision: 0,
    entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 5000 }],
    accounts: [
      { id: 'bank', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null },
      { id: 'card', entityId: 'me', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 0, reconciledAt: null },
      { id: 'shop-bank', entityId: 'shop', name: 'Shop bank', type: 'cash', currency: 'CAD', balanceCents: 50000, reconciledAt: null },
    ],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}
function expense(id: string, category: string, amountCents = 1000, patch: Partial<Transaction> = {}): Transaction {
  return { id, category, date: '2026-09-22', kind: 'expense', accountId: 'bank', amountCents, description: id, toAccountId: null, source: 'manual', createdAt: '2026-09-22T12:00:00Z', ...patch };
}

test('priority categories start unplanned without requiring accounts or copying sample amounts', () => {
  for (const workspace of ['live', 'demo'] as const) {
    const data = { ...state(), workspace, accounts: [] };
    const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
    assert.equal(plan.rows.length, 14);
    assert.equal(plan.plannedCents, 0);
    assert.equal(plan.plannedCategoryCount, 0);
    assert.equal(plan.recordedCents, 0);
    assert.ok(plan.rows.every(row => row.limit.monthlyCents === null && row.remainingCents === null));
    assert.deepEqual(plan.rows.map(row => row.label), ['Housing & family', 'Bills', 'Food & groceries', 'Transport', 'Personal care', 'Subscriptions', 'Digital purchases', 'Career & learning', 'Social', 'Trips', 'Side quests', 'Fees & interest', 'Goy', 'Other']);
  }
});

test('unsaved defaults classify bills and subscriptions once while keeping other classifications', () => {
  const data = state();
  const categories: [string, string][] = [
    ['  FOOD   & DRINK ', 'Food'], ['coffee', 'Food'], ['restaurants', 'Food'], ['fitness', 'Personal'], ['subscriptions', 'Subscriptions'], ['software', 'Digital'], ['travel', 'Trips'],
    ['Family support', 'Housing'], ['car insurance', 'Transport'], ['medication', 'Personal'], ['phone', 'Bills'], ['concerts', 'Social'], ['clothing', 'Personal'], ['courses', 'Career'], ['hotels', 'Trips'], ['unknown expense', 'Other'], ['', 'Other'],
  ];
  for (const [category, expected] of categories) assert.equal(expensePlanCategory(data, 'me', category), expected, category);
  data.transactions = categories.map(([category], index) => expense(`${index}`, category));
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
  assert.equal(plan.recordedCents, 17000);
  assert.equal(plan.rows.reduce((sum, row) => sum + row.spentCents, 0), plan.recordedCents);
  assert.equal(plan.transactionCount, 17);
});

test('monthly expenses use whole amounts for one owner and exclude future dates and non-expenses', () => {
  const data = state();
  data.transactions = [
    expense('bank-purchase', 'groceries', 2000), expense('card-purchase', 'coffee', 450, { accountId: 'card' }),
    expense('shop-purchase', 'groceries', 3000, { accountId: 'shop-bank' }),
    expense('tomorrow', 'groceries', 5000, { date: '2026-09-24' }), expense('last-month', 'groceries', 6000, { date: '2026-08-31' }),
    ...(['income', 'transfer', 'debt_payment', 'opening', 'adjustment'] as const).map(kind => expense(kind, 'groceries', 10000, { kind, toAccountId: 'card' })),
  ];
  const personal = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
  assert.equal(personal.recordedCents, 2450);
  assert.equal(personal.transactionCount, 2);
  assert.equal(personal.rows.find(row => row.limit.name === 'Food')?.spentCents, 2450);
  assert.equal(buildExpensePlan(data, 'shop', '2026-09', '2026-09-23').recordedCents, 3000);
  assert.equal(buildExpensePlan(data, 'me', '2026-10', '2026-09-23').recordedCents, 0);
  assert.equal(buildExpensePlan(data, 'me', '2026-08', '2026-09-23').recordedCents, 6000);
});

test('plan totals and remaining amounts distinguish zero from blank and expose unplanned spending', () => {
  const data = state();
  const defaults = expensePlanLimits(data, 'me');
  data.spendingLimits = defaults.filter(limit => ['Food', 'Social', 'Housing'].includes(limit.name)).map(limit => ({ ...limit, monthlyCents: limit.name === 'Food' ? 10000 : limit.name === 'Housing' ? 50000 : 0 }));
  data.transactions = [expense('food', 'groceries', 12000), expense('social', 'movies', 1500), expense('digital', 'apps', 2500)];
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
  assert.equal(plan.plannedCents, 60000);
  assert.equal(plan.plannedCategoryCount, 3);
  assert.equal(plan.categoryCount, 14);
  assert.equal(plan.recordedCents, 16000);
  assert.equal(plan.plannedSpendingCents, 13500);
  assert.equal(plan.unplannedSpendingCents, 2500);
  assert.equal(plan.rows.find(row => row.limit.name === 'Food')?.remainingCents, -2000);
  assert.equal(plan.rows.find(row => row.limit.name === 'Social')?.remainingCents, -1500);
  assert.equal(plan.rows.find(row => row.limit.name === 'Housing')?.remainingCents, 50000);
  assert.equal(plan.rows.find(row => row.limit.name === 'Digital')?.remainingCents, null);
});

test('saved aliases and renamed default identities survive without duplicate classification', () => {
  const data = state();
  const custom: SpendingLimit = { id: 'me:work', entityId: 'me', name: 'Work', aliases: ['software', 'food', 'family'], color: '#ABCDEF', dailyCents: 100, weeklyCents: 500, monthlyCents: 10000 };
  const renamed: SpendingLimit = { id: 'me:gym', entityId: 'me', name: 'Climbing', aliases: ['bouldering'], color: '#112233', dailyCents: null, weeklyCents: null, monthlyCents: 0 };
  data.spendingLimits = [custom, renamed];
  const before = structuredClone(data);
  data.transactions = [expense('work', 'software'), expense('also-work', 'ＦＯＯＤ'), expense('climb', 'bouldering'), expense('elsewhere', 'unknown')];
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
  assert.deepEqual(plan.rows.find(row => row.limit.id === custom.id)?.limit, custom);
  assert.equal(plan.rows.find(row => row.limit.id === custom.id)?.spentCents, 2000);
  assert.equal(plan.rows.find(row => row.limit.id === renamed.id)?.label, 'Climbing');
  assert.equal(plan.rows.find(row => row.limit.id === renamed.id)?.spentCents, 1000);
  assert.equal(plan.rows.find(row => row.limit.name === 'Other')?.spentCents, 1000);
  assert.equal(plan.rows.reduce((sum, row) => sum + row.spentCents, 0), 4000);
  assert.deepEqual(data.spendingLimits, before.spendingLimits);
  assert.equal(expensePlanCategory(data, 'me', 'Food'), 'Work');
});

test('date validation includes leap months and future spending stays excluded', () => {
  const data = state();
  data.transactions = [expense('leap-day', 'Food', 123, { date: '2028-02-29' })];
  const plan = buildExpensePlan(data, 'me', '2028-02', '2028-03-02');
  assert.equal(plan.start, '2028-02-01');
  assert.equal(plan.end, '2028-02-29');
  assert.equal(plan.recordedCents, 123);
  assert.equal(buildExpensePlan(data, 'me', '2028-02', '2028-02-28').recordedCents, 0);
  for (const invalid of ['2026-9', '2026-00', '2026-13', '2026-09-01', 'bad']) assert.throws(() => buildExpensePlan(data, 'me', invalid, '2026-09-23'), /month/);
  assert.throws(() => buildExpensePlan(data, 'me', '2026-02', '2026-02-29'), /calendar date/);
});

test('monthly amount parser preserves cents and rejects rounding or unsupported amounts', () => {
  assert.equal(parseExpensePlanAmount(''), null);
  assert.equal(parseExpensePlanAmount('  '), null);
  assert.equal(parseExpensePlanAmount('0'), 0);
  assert.equal(parseExpensePlanAmount(' 000.09 '), 9);
  assert.equal(parseExpensePlanAmount('12.3'), 1230);
  assert.equal(parseExpensePlanAmount('1000000000000'), 100000000000000);
  for (const value of ['-1', '1.001', '1e2', '$20', '1,000', 'Infinity', '1000000000000.01']) assert.throws(() => parseExpensePlanAmount(value));
});

test('custom categories trim and deduplicate aliases while leaving optional monthly amounts unknown', () => {
  const input = { id: 'pet-id', ownerId: 'me', name: '  Pets ', monthlyAmount: '', categories: ' Vet, pet food, VET, , Pets,  PET   FOOD, ＶＥＴ ' };
  const limit = createExpensePlanCategory(input);
  assert.deepEqual(limit, { id: 'pet-id', entityId: 'me', name: 'Pets', monthlyCents: null, dailyCents: null, weeklyCents: null, color: '#7D4DD5', aliases: ['Vet', 'pet food'] });
  assert.equal(createExpensePlanCategory({ ...input, monthlyAmount: '0' }).monthlyCents, 0);
  assert.equal(createExpensePlanCategory({ ...input, monthlyAmount: '43.25' }).monthlyCents, 4325);
  assert.throws(() => createExpensePlanCategory({ ...input, name: '   ' }), /category name/);
  assert.throws(() => createExpensePlanCategory({ ...input, name: 'ＦＯＯＤ' }, ['Food', 'Food & groceries']), /already exists/);
  assert.throws(() => createExpensePlanCategory({ ...input, monthlyAmount: '-25' }), /positive amount/);
  const data = state();
  data.spendingLimits = [limit];
  data.transactions = [expense('pet-food', 'PET FOOD', 4500), expense('vet', 'Vet', 7500), expense('name', 'Pets', 1000)];
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
  assert.equal(plan.rows.find(row => row.limit.id === limit.id)?.spentCents, 13000);
  assert.equal(plan.unplannedSpendingCents, 13000);
  assert.equal(plan.categoryCount, 15);
});

test('generated plans persist without a cash account, preserve saved limits and clear to unknown', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-expense-plan-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const work: SpendingLimit = { id: 'personal:work', entityId: 'personal', name: 'Work', aliases: ['food', 'software'], color: '#ABCDEF', dailyCents: 75, weeklyCents: 600, monthlyCents: 20000 };
  store.command({ type: 'save_spending_limit', limit: work });
  for (const generated of expensePlanLimits(store.state(), 'personal').filter(limit => limit.id !== work.id)) store.command({ type: 'save_spending_limit', limit: { ...generated, monthlyCents: 0 } });
  assert.equal(store.state().accounts.length, 0);
  assert.equal(store.state().transactions.length, 0);
  assert.equal(store.state().spendingLimits?.length, 15);
  assert.equal(expensePlanCategory(store.state(), 'personal', 'food'), 'Work');
  store.command({ type: 'save_spending_limit', limit: { ...work, monthlyCents: parseExpensePlanAmount('150.45') } });
  store.close();
  const reopened = createStore(path, 'live');
  try {
    const limit = reopened.state().spendingLimits!.find(limit => limit.id === work.id)!;
    assert.deepEqual(limit, { ...work, monthlyCents: 15045 });
    reopened.command({ type: 'save_spending_limit', limit: { ...limit, monthlyCents: parseExpensePlanAmount('') } });
    const plan = buildExpensePlan(reopened.state(), 'personal', '2026-09', '2026-09-23');
    assert.equal(plan.rows.find(row => row.limit.id === work.id)?.remainingCents, null);
    assert.equal(plan.plannedCategoryCount, 14);
    assert.equal(plan.plannedCents, 0);
    assert.equal(reopened.state().transactions.length, 0);
  } finally { reopened.close(); }
});

test('unsafe aggregate cents fail instead of displaying a rounded plan or spending total', () => {
  const data = state();
  data.transactions = Array.from({ length: 91 }, (_, index) => expense(`${index}`, 'Food', 100000000000000));
  assert.throws(() => buildExpensePlan(data, 'me', '2026-09', '2026-09-23'), /supported amount/);
});

test('refunds cannot overflow remaining plan room when the recorded total itself is safe', () => {
  const data = state();
  const food = expensePlanLimits(data, 'me').find(limit => limit.name === 'Food')!;
  data.spendingLimits = [{ ...food, monthlyCents: 100_000_000_000_000 }];
  data.transactions = Array.from({ length: 90 }, (_, index) => expense(`${index}`, 'Food', -100_000_000_000_000));
  assert.throws(() => buildExpensePlan(data, 'me', '2026-09', '2026-09-23'), /supported amount/);
});

test('saved legacy aliases keep their classification after introducing dedicated bill and subscription rows', () => {
  const data = state();
  const digital = expensePlanLimits(data, 'me').find(limit => limit.id === 'me:digital')!;
  data.spendingLimits = [{ ...digital, aliases: ['digital', 'apps', 'subscriptions', 'phone'], monthlyCents: 12000 }];
  data.transactions = [expense('subscription', 'subscriptions', 1200), expense('phone', 'phone', 6000), expense('quest', 'hobbies', 2500)];
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
  assert.equal(plan.rows.find(row => row.key === 'digital')?.spentCents, 7200);
  assert.equal(plan.rows.find(row => row.key === 'subscriptions')?.spentCents, 0);
  assert.equal(plan.rows.find(row => row.key === 'bills')?.spentCents, 0);
  assert.equal(plan.rows.find(row => row.key === 'sidequests')?.spentCents, 2500);
  assert.equal(plan.recordedCents, 9700);
  assert.equal(plan.rows.flatMap(row => row.transactions).length, 3);
  assert.equal(plan.rows.reduce((sum, row) => sum + row.spentCents, 0), plan.recordedCents);
});

test('payments connected to subscriptions or bills appear in their matching row and ledger category', () => {
  const data = state();
  data.obligations = [
    { id: 'streaming', entityId: 'me', name: 'Streaming', amountCents: 1500, dueDate: '2026-10-22', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Digital', subscription: true },
    { id: 'phone', entityId: 'me', name: 'Phone', amountCents: 5000, dueDate: '2026-10-22', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Digital' },
  ];
  data.transactions = [expense('streaming-paid', 'Digital', 1500, { source: 'Planned payment streaming' }), expense('phone-paid', 'Digital', 5000, { source: 'Planned payment phone' }), expense('software', 'Digital', 2000), expense('shop', 'Digital', 3000, { accountId: 'shop-bank', source: 'Planned payment streaming' })];
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
  assert.equal(plan.rows.find(row => row.key === 'subscriptions')?.spentCents, 1500);
  assert.equal(plan.rows.find(row => row.key === 'bills')?.spentCents, 5000);
  assert.equal(plan.rows.find(row => row.key === 'digital')?.spentCents, 2000);
  assert.equal(plan.recordedCents, 8500);
  assert.equal(plan.rows.reduce((sum, row) => sum + row.spentCents, 0), 8500);
  for (const row of plan.rows) for (const transaction of row.transactions) assert.equal(expensePlanTransactionCategory(data, 'me', transaction), row.limit.name);
  assert.equal(expensePlanTransactionCategory(data, 'shop', data.transactions[3]), 'Digital');
});

test('planned details and future appointments do not count as monthly budget or spending', () => {
  const data = state();
  data.expensePlanItems = [{ id: 'haircut', entityId: 'me', categoryId: 'me:personal', name: 'Haircut', amountCents: 4500, date: '2026-10-01', notes: 'Appointment at noon' }, { id: 'meal-plan', entityId: 'me', categoryId: 'me:food', name: 'Meal plan', amountCents: null, date: '', notes: 'Rice, vegetables, chicken' }];
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
  assert.equal(plan.plannedCents, 0);
  assert.equal(plan.recordedCents, 0);
  assert.equal(plan.transactionCount, 0);
  assert.ok(plan.rows.every(row => row.transactions.length === 0));
});

test('refunds reduce their category spending and restore plan room without counting card payments', () => {
  const data = state();
  const food = expensePlanLimits(data, 'me').find(limit => limit.name === 'Food')!;
  data.spendingLimits = [{ ...food, monthlyCents: 5000 }];
  data.transactions = [
    expense('purchase', 'groceries', 3221, { accountId: 'card' }),
    expense('refund', 'groceries', -3108, { accountId: 'card' }),
    expense('previous-month-refund', 'Other', -500),
    expense('card-payment', 'Card payment', -25000, { accountId: 'card', kind: 'adjustment' }),
  ];
  const plan = buildExpensePlan(data, 'me', '2026-09', '2026-09-23');
  const foodRow = plan.rows.find(row => row.limit.name === 'Food')!;
  assert.equal(foodRow.spentCents, 113);
  assert.equal(foodRow.remainingCents, 4887);
  assert.equal(foodRow.transactionCount, 2);
  assert.equal(plan.plannedSpendingCents, 113);
  assert.equal(plan.unplannedSpendingCents, -500);
  assert.equal(plan.recordedCents, -387);
  assert.equal(plan.transactionCount, 3);
  assert.equal(plan.rows.reduce((sum, row) => sum + row.spentCents, 0), -387);
});
