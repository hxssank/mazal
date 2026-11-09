import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forecast, money, recordedObligationDates, summarize, today, upcoming } from './analytics.ts';
import type { AppState, Obligation, Transaction } from './types.ts';

function state(): AppState {
  return {
    workspace: 'live', revision: 0,
    entities: [
      { id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10_000 },
      { id: 'studio', name: 'Studio', kind: 'business', ownershipBps: 5_000 },
    ],
    accounts: [
      { id: 'cash', entityId: 'personal', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100_000, reconciledAt: null },
      { id: 'investments', entityId: 'personal', name: 'SOL', type: 'investment', currency: 'CAD', balanceCents: 50_000, reconciledAt: null },
      { id: 'card', entityId: 'personal', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 20_000, reconciledAt: null },
      { id: 'studio-cash', entityId: 'studio', name: 'Studio bank', type: 'cash', currency: 'CAD', balanceCents: 200_000, reconciledAt: null },
      { id: 'invoice', entityId: 'studio', name: 'Invoices', type: 'receivable', currency: 'CAD', balanceCents: 40_000, reconciledAt: null },
      { id: 'vendor', entityId: 'studio', name: 'Vendors', type: 'payable', currency: 'CAD', balanceCents: 40_000, reconciledAt: null },
    ],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

function obligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    id: 'rent', entityId: 'personal', name: 'Rent', amountCents: 10_000, dueDate: '2026-01-25',
    direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Housing', ...overrides,
  };
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'transaction', date: '2026-01-15', description: 'Entry', kind: 'income', amountCents: 30_000,
    accountId: 'cash', toAccountId: null, category: '', source: 'manual', createdAt: '2026-01-15T12:00:00.000Z', ...overrides,
  };
}

test('cancelled subscriptions never recur, consume available cash, or appear in forecasts', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 20, 12).getTime() });
  const data = state();
  data.obligations = [
    obligation({ id: 'monthly', subscription: true, status: 'cancelled', dueDate: '2026-01-01' }),
    obligation({ id: 'biweekly', subscription: true, status: 'cancelled', recurrence: 'biweekly', dueDate: '2026-01-21' }),
  ];
  assert.deepEqual(upcoming(data, 'personal', 365), []);
  assert.equal(summarize(data, 'personal').committedCents, 0);
  assert.ok(forecast(data, 'personal', 90).every(point => point.cashCents === 100_000));
});

test('recorded occurrence dates use explicit links and retain refunded payments without inferring legacy dates', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 16, 12).getTime() });
  const data = state();
  data.obligations = [obligation({ dueDate: '2026-09-20', amountCents: 15000 }), obligation({ id: 'other', dueDate: '2026-10-20', recurrence: 'once' })];
  data.transactions = [
    transaction({ id: 'paid', kind: 'expense', date: '2026-10-15', amountCents: 15000, plannedPayment: { obligationId: 'rent', dueDate: '2026-10-20' } }),
    transaction({ id: 'refund', kind: 'expense', date: '2026-10-16', amountCents: -15000, refundOf: 'paid' }),
    transaction({ id: 'legacy', kind: 'expense', date: '2026-09-20', source: 'Planned payment rent' }),
    transaction({ id: 'reversed', kind: 'expense', date: '2026-09-20' }),
    transaction({ id: 'reversal', kind: 'expense', date: '2026-09-20', amountCents: -30000, reversalOf: 'reversed' }),
  ];
  const before = structuredClone(data);
  assert.deepEqual(recordedObligationDates(data.transactions), new Map([['rent', new Set(['2026-10-20'])]]));
  assert.deepEqual(upcoming(data, 'personal', 35).map(row => [row.id, row.occurrenceDate]), [['rent', '2026-09-20'], ['other', '2026-10-20'], ['rent', '2026-11-20']]);
  assert.equal(summarize(data, 'personal').committedCents, 25000);
  assert.equal(forecast(data, 'personal', 35).at(-1)?.cashCents, 60000);
  assert.deepEqual(data, before);
});

test('all-domain totals use ownership while personal available excludes business cash and SOL positions are not counted twice', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 20, 12).getTime() });
  const data = state();
  data.reserves = [
    { id: 'emergency', entityId: 'personal', name: 'Emergency', amountCents: 10_000 },
    { id: 'tax', entityId: 'studio', name: 'Tax', amountCents: 20_000 },
  ];
  data.obligations = [obligation(), obligation({ id: 'hosting', entityId: 'studio', accountId: 'studio-cash', amountCents: 20_000 })];
  data.positions = [{ id: 'sol', accountId: 'investments', liquidSol: '1', stakedSol: '3', rewardsSol: '1', costBasisCents: 40_000, priceCents: 10_000, priceDate: '2026-01-20' }];
  data.transactions = [
    transaction(), transaction({ id: 'sale', accountId: 'studio-cash', amountCents: 100_000 }),
    transaction({ id: 'expense', kind: 'expense', amountCents: 5_000 }),
    transaction({ id: 'business-expense', kind: 'expense', accountId: 'studio-cash', amountCents: 10_000 }),
    transaction({ id: 'move', kind: 'transfer', toAccountId: 'investments', amountCents: 99_999 }),
    transaction({ id: 'payment', kind: 'debt_payment', toAccountId: 'card', amountCents: 88_888 }),
    transaction({ id: 'opening', kind: 'opening', amountCents: 77_777 }),
    transaction({ id: 'correction', kind: 'adjustment', amountCents: 66_666 }),
    transaction({ id: 'last-month', date: '2025-12-31', amountCents: 55_555 }),
    transaction({ id: 'future', date: '2026-01-31', amountCents: 44_444 }),
  ];
  assert.deepEqual(summarize(data), {
    assetsCents: 270_000, liabilitiesCents: 40_000, netWorthCents: 230_000,
    cashCents: 200_000, investmentsCents: 50_000, receivablesCents: 20_000,
    physicalAssetsCents: 0, purchaseEquityCents: 0,
    availableCents: 80_000, reservedCents: 20_000, committedCents: 20_000,
    incomeCents: 80_000, expensesCents: 10_000, personalAvailableCents: 80_000,
  });
  const business = summarize(data, 'studio');
  assert.equal(business.assetsCents, 240_000);
  assert.equal(business.liabilitiesCents, 40_000);
  assert.equal(business.availableCents, 160_000);
  assert.equal(business.incomeCents, 100_000);
  assert.equal(business.expensesCents, 10_000);
});

test('outstanding standalone tabs count as receivables without becoming available cash', () => {
  const data = state();
  data.moneyOwed = [
    { id: 'friend', entityId: 'personal', name: 'Friend', amountCents: 450000, comment: '', payments: [{ id: 'repaid', amountCents: 50000, date: '2026-01-01', comment: '' }] },
    { id: 'customer', entityId: 'studio', name: 'Customer', amountCents: 30001, comment: '', payments: [{ id: 'part', amountCents: 10000, date: '2026-01-01', comment: '' }] },
    { id: 'settled', entityId: 'personal', name: 'Settled tab', amountCents: 20000, comment: '', payments: [{ id: 'full', amountCents: 20000, date: '2026-01-01', comment: '' }] },
  ];
  const all = summarize(data);
  assert.equal(all.receivablesCents, 430001);
  assert.equal(all.assetsCents, 680001);
  assert.equal(all.netWorthCents, 640001);
  assert.equal(all.availableCents, 100000);
  assert.equal(all.personalAvailableCents, 100000);
  assert.equal(all.cashCents, 200000);
  const personal = summarize(data, 'personal');
  assert.equal(personal.receivablesCents, 400000);
  assert.equal(personal.netWorthCents, 530000);
  assert.equal(summarize(data, 'studio').receivablesCents, 60001);
});

test('physical assets use resale estimates after fees and ownership; sales and wish lists do not count', () => {
  const data = state();
  const item = { id: 'laptop', entityId: 'personal', name: 'Laptop', category: 'Computers', purchaseDate: '2026-01-01', costCents: 200000, estimatedValueCents: 100000, feesCents: 10000, status: 'owned' as const, soldDate: null, saleCents: null, notes: '' };
  data.assets = [item, { ...item, id: 'camera', entityId: 'studio', estimatedValueCents: 20001, feesCents: 10000, status: 'listed' }, { ...item, id: 'sold', status: 'sold', soldDate: '2026-02-01', saleCents: 1000000 }, { ...item, id: 'no-value', estimatedValueCents: 500, feesCents: 1000 }];
  data.wishItems = [{ id: 'wish', entityId: 'personal', name: 'Car', costCents: 10000000, comment: '' }];
  const all = summarize(data);
  assert.equal(all.physicalAssetsCents, 95001);
  assert.equal(all.assetsCents, 365001);
  assert.equal(all.netWorthCents, 325001);
  assert.equal(all.availableCents, 100000);
  assert.equal(summarize(data, 'studio').physicalAssetsCents, 10001);
  assert.equal(summarize(data, 'personal').physicalAssetsCents, 90000);
});

test('purchase equity counts confirmed progress once and exact duplicate records do not inflate assets', () => {
  const data = state();
  data.assetPurchases = [
    { id: 'car', entityId: 'personal', name: 'Car', payee: 'Mom', targetCents: 2000000, monthlyCents: 100000, paidCents: 400000, paidAsOf: '2026-01-01', notes: '' },
    { id: 'unknown', entityId: 'personal', name: 'Unknown progress', payee: 'Seller', targetCents: 500000, monthlyCents: 10000, paidCents: null, paidAsOf: '', notes: '' },
    { id: 'machine', entityId: 'studio', name: 'Machine', payee: 'Seller', targetCents: 100000, monthlyCents: 10000, paidCents: 20001, paidAsOf: '2026-01-01', notes: '' },
  ];
  data.assets = [{ id: 'car', entityId: 'personal', name: 'Car', category: 'Vehicles', purchaseDate: '2026-01-01', costCents: 2000000, estimatedValueCents: 1800000, feesCents: 0, status: 'owned', soldDate: null, saleCents: null, notes: '' }];
  data.moneyOwed = [{ id: 'invoice', entityId: 'studio', name: 'Invoices tracker', amountCents: 40000, comment: '', payments: [] }];
  const all = summarize(data);
  assert.equal(all.purchaseEquityCents, 410001);
  assert.equal(all.physicalAssetsCents, 0);
  assert.equal(all.receivablesCents, 20000);
  assert.equal(all.assetsCents, 680001);
  assert.equal(all.netWorthCents, 640001);
  assert.equal(summarize(data, 'studio').purchaseEquityCents, 20001);
});

for (const { paidCents, committedCents, weightedCents } of [
  { paidCents: 74_999, committedCents: 25_001, weightedCents: 12_501 },
  { paidCents: 100_000, committedCents: 0, weightedCents: 0 },
  { paidCents: null, committedCents: 0, weightedCents: 0 },
]) test(`summary caps shared purchase installments with paid progress ${paidCents}`, t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 16, 12).getTime() });
  const data = state();
  data.assetPurchases = ['personal', 'studio'].map(entityId => ({
    id: `${entityId}-purchase`, entityId, name: 'Purchase', payee: 'Seller', targetCents: 100_000,
    monthlyCents: 10_000, paidCents, paidAsOf: paidCents === null ? '' : '2026-10-16', notes: '',
  }));
  data.obligations = data.assetPurchases.flatMap(purchase => [
    obligation({ id: `${purchase.id}-recurring`, entityId: purchase.entityId, accountId: purchase.entityId === 'personal' ? 'cash' : 'studio-cash', assetPurchaseId: purchase.id, dueDate: '2026-10-16', recurrence: 'biweekly' }),
    obligation({ id: `${purchase.id}-extra`, entityId: purchase.entityId, accountId: purchase.entityId === 'personal' ? 'cash' : 'studio-cash', assetPurchaseId: purchase.id, dueDate: '2026-10-17', recurrence: 'once' }),
  ]);
  data.obligations.push(obligation({ id: 'ordinary', dueDate: '2026-10-17', recurrence: 'once', amountCents: 5_000 }));
  const before = structuredClone(data);
  const all = summarize(data);
  assert.equal(all.committedCents, 5_000 + committedCents + weightedCents);
  assert.equal(all.availableCents, 95_000 - committedCents);
  assert.equal(all.personalAvailableCents, 95_000 - committedCents);
  const personal = summarize(data, 'personal');
  assert.equal(personal.committedCents, 5_000 + committedCents);
  assert.equal(personal.availableCents, 95_000 - committedCents);
  const business = summarize(data, 'studio');
  assert.equal(business.committedCents, committedCents);
  assert.equal(business.availableCents, 200_000 - committedCents);
  assert.equal(business.personalAvailableCents, personal.personalAvailableCents);
  assert.deepEqual(data, before);
});

test('reserves and next 30 days of unpaid outgoing occurrences reduce available once, with shortages kept negative', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 20, 12).getTime() });
  const data = state();
  data.accounts[0].balanceCents = 15_000;
  data.reserves = [{ id: 'buffer', entityId: 'personal', name: 'Buffer', amountCents: 2_000 }];
  data.obligations = [
    obligation({ recurrence: 'biweekly', dueDate: '2026-01-20' }),
    obligation({ id: 'paid', recurrence: 'once', status: 'paid', amountCents: 77_777 }),
    obligation({ id: 'in', direction: 'in', recurrence: 'once', amountCents: 88_888 }),
    obligation({ id: 'outside', recurrence: 'once', dueDate: '2026-02-20', amountCents: 99_999 }),
  ];
  const summary = summarize(data, 'personal');
  assert.equal(summary.committedCents, 30_000);
  assert.equal(summary.availableCents, -17_000);
  assert.equal(summary.incomeCents, 0);
});

test('monthly dates clamp February without drifting March and cross the year boundary', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2025, 11, 31, 12).getTime() });
  const data = state();
  data.obligations = [obligation({ dueDate: '2025-12-31' })];
  assert.deepEqual(upcoming(data, 'personal', 90).map((item) => item.occurrenceDate), [
    '2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31',
  ]);
});

test('monthly dates include leap day and a paid occurrence is skipped without deleting the next payment', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2028, 0, 31, 12).getTime() });
  const data = state();
  data.obligations = [obligation({ dueDate: '2028-01-31', status: 'paid' })];
  assert.deepEqual(upcoming(data, 'personal', 60).map((item) => [item.id, item.dueDate, item.status]), [
    ['rent', '2028-02-29', 'planned'], ['rent', '2028-03-31', 'planned'],
  ]);
});

test('monthly expansion retains the saved recurrence day after payment advances into February', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 1, 28, 12).getTime() });
  const data = state();
  data.obligations = [obligation({ dueDate: '2026-02-28', recurrenceDay: 31 })];
  assert.deepEqual(upcoming(data, 'personal', 61).map((item) => item.dueDate), ['2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(summarize(data, 'personal').committedCents, 10_000);
  const points = forecast(data, 'personal', 31);
  assert.equal(points[0].cashCents, 90_000);
  assert.equal(points[30].cashCents, 90_000);
  assert.deepEqual(points[31], { date: '2026-03-31', cashCents: 80_000 });
});

test('overdue recurring commitments include the next recorded unpaid bill without inventing past arrears', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 22, 12).getTime() });
  const data = state();
  data.obligations = [obligation({ dueDate: '2026-01-31' })];
  assert.deepEqual(upcoming(data, 'personal', 40).map((item) => item.dueDate), ['2026-01-31', '2026-09-30', '2026-10-31']);
});

test('forecast uses posted cash, scheduled incoming and outgoing, skips paid and noncash items, and leaves state unchanged', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 20, 12).getTime() });
  const data = state();
  data.obligations = [
    obligation({ id: 'overdue', recurrence: 'once', dueDate: '2026-01-19', amountCents: 1_000 }),
    obligation({ id: 'salary', recurrence: 'biweekly', direction: 'in', dueDate: '2026-01-21', amountCents: 5_000 }),
    obligation({ id: 'already-paid', recurrence: 'once', status: 'paid', dueDate: '2026-01-20', amountCents: 99_999 }),
    obligation({ id: 'card', accountId: 'card', recurrence: 'once', dueDate: '2026-01-21', amountCents: 88_888 }),
    obligation({ id: 'business', entityId: 'studio', accountId: 'studio-cash', recurrence: 'once', dueDate: '2026-01-21', amountCents: 77_777 }),
  ];
  const original = structuredClone(data);
  const points = forecast(data, 'personal', 15, 10_000);
  assert.equal(points.length, 16);
  assert.deepEqual(points[0], { date: '2026-01-20', cashCents: 89_000 });
  assert.deepEqual(points[1], { date: '2026-01-21', cashCents: 94_000 });
  assert.deepEqual(points.at(-1), { date: '2026-02-04', cashCents: 99_000 });
  assert.deepEqual(data, original);
  assert.equal(summarize(data, 'personal').incomeCents, 0);
});

test('an empty live workspace has zero balances and days stay calendar dates across DST', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 2, 7, 23).getTime() });
  const data = state();
  data.accounts = [];
  assert.equal(summarize(data).netWorthCents, 0);
  assert.deepEqual(forecast(data, 'personal', 3).map((point) => point.date), ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  assert.equal(today(), '2026-03-07');
});

test('default forecast follows a restored personal owner ID while all-scope availability stays personal', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 20, 12).getTime() });
  const data = state();
  data.entities[0].id = 'restored-owner';
  for (const account of data.accounts) if (account.entityId === 'personal') account.entityId = 'restored-owner';
  data.reserves = [{ id: 'buffer', entityId: 'restored-owner', name: 'Buffer', amountCents: 5_000 }];
  data.obligations = [obligation({ entityId: 'restored-owner', dueDate: '2026-01-20', recurrence: 'once' })];
  assert.equal(forecast(data)[0].cashCents, 90_000);
  assert.equal(summarize(data).availableCents, 85_000);
  assert.equal(summarize(data).personalAvailableCents, 85_000);
  assert.equal(summarize(data).cashCents, 200_000);
});

test('money retains cents and invalid forecast arguments fail before producing a result', () => {
  assert.equal(money(123_400), '$1,234');
  assert.equal(money(123_456), '$1,234.56');
  assert.equal(money(-1), '-$0.01');
  assert.throws(() => forecast(state(), 'personal', -1), /forecast period/);
  assert.throws(() => forecast(state(), 'personal', 2.5), /forecast period/);
  assert.throws(() => forecast(state(), 'personal', 90, -1), /purchase amount/);
});

test('money preserves CAD signs, grouping and precision when alternating whole dollars and cents', () => {
  const amounts: [number, string][] = [
    [0, '$0'], [-0, '-$0'], [100, '$1'], [101, '$1.01'], [110, '$1.10'],
    [-100, '-$1'], [-101, '-$1.01'], [1_234_567_800, '$12,345,678'],
    [1_234_567_801, '$12,345,678.01'], [-123_400, '-$1,234'], [-123_456, '-$1,234.56'],
  ];
  for (const [cents, expected] of [...amounts, ...amounts.toReversed()]) assert.equal(money(cents), expected);
});

test('recorded cash deficits reduce net worth and stay visible before expected income', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 20, 12).getTime() });
  const data = state();
  data.accounts = [{ ...data.accounts[0], balanceCents: -1250 }];
  data.reserves = [{ id: 'reserve', entityId: 'personal', name: 'Set aside', amountCents: 500 }];
  data.obligations = [obligation({ direction: 'in', recurrence: 'once', amountCents: 2000, dueDate: '2026-01-21' })];
  const before = structuredClone(data);
  assert.equal(summarize(data).cashCents, -1250);
  assert.equal(summarize(data).netWorthCents, -1250);
  assert.equal(summarize(data).availableCents, -1750);
  assert.deepEqual(forecast(data, 'personal', 1).map(point => point.cashCents), [-1250, 750]);
  assert.deepEqual(data, before);
});

test('card credits retain their owner share in net worth without becoming spendable cash', () => {
  const data = state();
  data.accounts = [
    { ...data.accounts[0], balanceCents: 0 },
    { ...data.accounts[2], balanceCents: -2501 },
    { ...data.accounts[5], balanceCents: -5001 },
  ];
  assert.equal(summarize(data).netWorthCents, 5002);
  assert.equal(summarize(data).availableCents, 0);
  assert.equal(summarize(data, 'personal').netWorthCents, 2501);
  assert.equal(summarize(data, 'studio').netWorthCents, 5001);
});

test('summaries and forecasts reject unsafe aggregate cents even when each saved balance is supported', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 20, 12).getTime() });
  const data = state();
  data.accounts = Array.from({ length: 91 }, (_, index) => ({ ...data.accounts[0], id: `cash-${index}`, balanceCents: 100_000_000_000_000 }));
  assert.throws(() => summarize(data), /supported amount/);
  assert.throws(() => forecast(data, 'personal', 0), /supported amount/);
  data.accounts = [{ ...data.accounts[0], id: 'cash', balanceCents: 100000 }];
  data.transactions = Array.from({ length: 91 }, (_, index) => transaction({ id: `expense-${index}`, kind: 'expense', amountCents: 100_000_000_000_000 }));
  assert.throws(() => summarize(data), /supported amount/);
  data.transactions = [];
  data.obligations = Array.from({ length: 91 }, (_, index) => obligation({ id: `incoming-${index}`, direction: 'in', recurrence: 'once', amountCents: 100_000_000_000_000, dueDate: today() }));
  assert.throws(() => forecast(data, 'personal', 0), /supported amount/);
});
