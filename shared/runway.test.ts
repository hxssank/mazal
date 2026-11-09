import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cashRunway } from './runway.ts';
import type { AppState, Obligation } from './types.ts';

function state(): AppState {
  return {
    workspace: 'live', revision: 0,
    entities: [
      { id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 },
      { id: 'studio', name: 'Studio', kind: 'business', ownershipBps: 5000 },
    ],
    accounts: [
      { id: 'bank', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null },
      { id: 'card', entityId: 'me', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 50000, reconciledAt: null },
      { id: 'studio-bank', entityId: 'studio', name: 'Studio bank', type: 'cash', currency: 'CAD', balanceCents: 200000, reconciledAt: null },
    ],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

function obligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    id: 'bill', entityId: 'me', name: 'Bill', amountCents: 10000, dueDate: '2026-09-24',
    direction: 'out', recurrence: 'once', status: 'planned', accountId: 'bank', category: '', ...overrides,
  };
}

test('all scope selects the saved personal owner and keeps business cash out of the purchase check', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const data = state();
  data.reserves = [
    { id: 'personal-buffer', entityId: 'me', name: 'Buffer', amountCents: 20000 },
    { id: 'studio-buffer', entityId: 'studio', name: 'Studio buffer', amountCents: 40000 },
  ];
  data.obligations = [obligation(), obligation({ id: 'studio-bill', entityId: 'studio', accountId: 'studio-bank', amountCents: 60000 })];
  const personal = cashRunway(data);
  assert.equal(personal.ownerId, 'me');
  assert.equal(personal.ownerName, 'Personal');
  assert.equal(personal.recordedCashCents, 100000);
  assert.equal(personal.reservedCents, 20000);
  assert.equal(personal.startingCents, 80000);
  assert.equal(personal.outgoingCents, 10000);
  assert.equal(personal.baseline!.endingCents, 70000);
  const business = cashRunway(data, 'studio');
  assert.equal(business.recordedCashCents, 200000);
  assert.equal(business.startingCents, 160000);
  assert.equal(business.baseline!.endingCents, 100000);
});

test('dated bills expose a cash shortfall before expected income, and a purchase lowers both minimum and ending cash', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const data = state();
  data.reserves = [{ id: 'buffer', entityId: 'me', name: 'Buffer', amountCents: 20000 }];
  data.obligations = [
    obligation({ id: 'overdue', dueDate: '2026-09-20' }),
    obligation({ id: 'rent', dueDate: '2026-09-25', amountCents: 90000 }),
    obligation({ id: 'pay', dueDate: '2026-09-26', direction: 'in', amountCents: 50000 }),
  ];
  const result = cashRunway(data, 'me', { purchaseCents: 40000 });
  assert.equal(result.recordedCashCents, 100000);
  assert.equal(result.scheduledIncomeCents, 50000);
  assert.equal(result.outgoingCents, 100000);
  assert.deepEqual(result.baseline!.points[0], { date: '2026-09-23', balanceCents: 70000 });
  assert.deepEqual(result.baseline!.minimum, { date: '2026-09-25', balanceCents: -20000 });
  assert.deepEqual(result.baseline!.firstShortfall, { date: '2026-09-25', balanceCents: -20000 });
  assert.equal(result.baseline!.endingCents, 30000);
  assert.deepEqual(result.proposed!.minimum, { date: '2026-09-25', balanceCents: -60000 });
  assert.equal(result.proposed!.endingCents, -10000);
  assert.equal(result.occurrences[0].dueDate, '2026-09-20');
  assert.equal(result.occurrences[0].effectiveDate, '2026-09-23');
});

test('a future purchase changes balances starting on its selected date and zero balance is not a shortfall', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const result = cashRunway(state(), 'me', { days: 2, purchaseDate: '2026-09-25', purchaseCents: 100000 });
  assert.deepEqual(result.proposed!.points, [
    { date: '2026-09-23', balanceCents: 100000 },
    { date: '2026-09-24', balanceCents: 100000 },
    { date: '2026-09-25', balanceCents: 0 },
  ]);
  assert.deepEqual(result.proposed!.minimum, { date: '2026-09-25', balanceCents: 0 });
  assert.equal(result.proposed!.firstShortfall, null);
  assert.equal(result.baseline!.endingCents, 100000);
});

test('missing cash accounts remain unknown while a recorded zero balance produces a usable forecast', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const data = state();
  data.accounts = data.accounts.filter(account => account.id !== 'bank');
  const missing = cashRunway(data);
  assert.equal(missing.hasCashAccounts, false);
  assert.equal(missing.recordedCashCents, null);
  assert.equal(missing.startingCents, null);
  assert.equal(missing.baseline, null);
  assert.equal(missing.proposed, null);
  const recorded = state();
  recorded.accounts[0].balanceCents = 0;
  assert.equal(cashRunway(recorded).baseline!.endingCents, 0);
  assert.equal(cashRunway(recorded).hasCashAccounts, true);
});

test('missing owners do not silently borrow a business balance or create a personal owner', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const data = state();
  data.entities = data.entities.filter(entity => entity.kind !== 'personal');
  assert.equal(cashRunway(data, 'all').ownerId, null);
  assert.equal(cashRunway(data, 'all').baseline, null);
  assert.equal(cashRunway(state(), 'unknown-owner').recordedCashCents, null);
});

test('cash below reserves remains negative before income scheduled today arrives', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const data = state();
  data.reserves = [{ id: 'buffer', entityId: 'me', name: 'Buffer', amountCents: 120000 }];
  data.obligations = [obligation({ dueDate: '2026-09-23', direction: 'in', amountCents: 50000 })];
  const result = cashRunway(data);
  assert.equal(result.startingCents, -20000);
  assert.equal(result.baseline!.points[0].balanceCents, 30000);
  assert.deepEqual(result.baseline!.minimum, { date: '2026-09-23', balanceCents: -20000 });
  assert.deepEqual(result.baseline!.firstShortfall, { date: '2026-09-23', balanceCents: -20000 });
});

test('same-day expected income, bills and purchase aggregate without inventing an intraday payment order', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const data = state();
  data.accounts[0].balanceCents = 10000;
  data.obligations = [
    obligation({ id: 'bill', amountCents: 20000 }),
    obligation({ id: 'pay', amountCents: 30000, direction: 'in' }),
  ];
  const result = cashRunway(data, 'me', { purchaseCents: 15000, purchaseDate: '2026-09-24' });
  assert.equal(result.proposed!.points[1].balanceCents, 5000);
  assert.equal(result.proposed!.firstShortfall, null);
  data.obligations.reverse();
  assert.deepEqual(cashRunway(data, 'me', { purchaseCents: 15000, purchaseDate: '2026-09-24' }).proposed, result.proposed);
});

test('paid, noncash and other-owner obligations do not change cash, and excluded items remain visible to callers', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const data = state();
  data.obligations = [
    obligation({ id: 'paid', status: 'paid' }),
    obligation({ id: 'card-charge', accountId: 'card' }),
    obligation({ id: 'wrong-owner', accountId: 'studio-bank' }),
    obligation({ id: 'studio-charge', entityId: 'studio', accountId: 'studio-bank' }),
    obligation({ id: 'cash-bill' }),
  ];
  const result = cashRunway(data);
  assert.deepEqual(result.occurrences.map(item => item.id), ['cash-bill']);
  assert.deepEqual(result.excludedOccurrences.map(item => item.id), ['card-charge', 'wrong-owner']);
  assert.equal(result.baseline!.endingCents, 90000);
});

test('recurrences preserve month-end dates and the final forecast date is included once', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 31, 12).getTime() });
  const data = state();
  data.obligations = [obligation({ dueDate: '2026-01-31', recurrence: 'monthly' })];
  const result = cashRunway(data, 'me', { days: 59 });
  assert.deepEqual(result.occurrences.map(item => item.effectiveDate), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(result.outgoingCents, 30000);
  assert.equal(result.baseline!.points.length, 60);
  assert.deepEqual(result.baseline!.points.at(-1), { date: '2026-03-31', balanceCents: 70000 });
});

test('cash uses current account balances without replaying recorded transactions or mutating the ledger', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  const data = state();
  data.transactions = [{ id: 'pay', date: '2026-09-23', description: 'Pay', kind: 'income', amountCents: 100000, accountId: 'bank', toAccountId: null, category: '', source: 'manual', createdAt: '2026-09-23T12:00:00Z' }];
  data.obligations = [obligation()];
  const original = structuredClone(data);
  const first = cashRunway(data, 'me', { purchaseCents: 15000 });
  assert.equal(first.recordedCashCents, 100000);
  assert.equal(first.scheduledIncomeCents, 0);
  assert.equal(first.proposed!.endingCents, 75000);
  assert.deepEqual(cashRunway(data, 'me', { purchaseCents: 15000 }), first);
  assert.deepEqual(data, original);
});

test('purchase inputs reject invalid cents and dates before calculating a result', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 12).getTime() });
  for (const purchaseCents of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => cashRunway(state(), 'me', { purchaseCents }), /purchase amount/);
  }
  for (const purchaseDate of ['2026-09-22', '2026-10-24', '2026-09-31', 'not-a-date']) {
    assert.throws(() => cashRunway(state(), 'me', { purchaseDate }), /purchase date/);
  }
  for (const days of [-1, 1.5, 3661]) assert.throws(() => cashRunway(state(), 'me', { days }), /forecast period/);
  assert.equal(cashRunway(state(), 'me', { days: 0 }).baseline!.points.length, 1);
});
