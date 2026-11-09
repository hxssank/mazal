import assert from 'node:assert/strict';
import { test } from 'node:test';
import { debtsMissingTerms, recentActivity } from './home.ts';
import type { AppState, RoadmapSettings, Transaction } from './types.ts';

function state(): AppState {
  return {
    workspace: 'live', revision: 0,
    entities: [
      { id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 },
      { id: 'studio', name: 'Studio', kind: 'business', ownershipBps: 5000 },
    ],
    accounts: [
      { id: 'bank', entityId: 'personal', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null },
      { id: 'card', entityId: 'personal', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 50000, reconciledAt: null },
      { id: 'studio-bank', entityId: 'studio', name: 'Studio bank', type: 'cash', currency: 'CAD', balanceCents: 200000, reconciledAt: null },
      { id: 'studio-payable', entityId: 'studio', name: 'Studio payable', type: 'payable', currency: 'CAD', balanceCents: 30000, reconciledAt: null },
    ],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

function entry(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id, date: '2026-09-22', description: id, kind: 'expense', amountCents: 1200,
    accountId: 'bank', toAccountId: null, category: '', source: 'manual', createdAt: '2026-09-22T12:00:00.000Z', ...overrides,
  };
}

function roadmap(overrides: Partial<RoadmapSettings> = {}): RoadmapSettings {
  return {
    currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null,
    monthlyDebtMinimumsCents: null, transitionDate: '2027-01-01', transitionMonths: 3,
    monthlyExtraDebtCents: 0, loanAccountId: 'card', loanAprPercent: 6, loanMonthlyPaymentCents: 10000,
    ...overrides,
  };
}

test('a transfer appears for its source and destination owners once, without weighting the recorded amount', () => {
  const data = state();
  data.transactions = [entry('fund-studio', { kind: 'transfer', toAccountId: 'studio-bank', amountCents: 20000 })];
  for (const scope of ['personal', 'studio', 'all']) {
    const activity = recentActivity(data, scope, '2026-09-22');
    assert.deepEqual(activity.map(transaction => transaction.id), ['fund-studio']);
    assert.equal(activity[0].amountCents, 20000);
  }
  assert.deepEqual(recentActivity(data, 'another-owner', '2026-09-22'), []);
});

test('activity includes payments received by a debt owner and excludes unrelated owner entries', () => {
  const data = state();
  data.transactions = [
    entry('pay-studio-debt', { kind: 'debt_payment', toAccountId: 'studio-payable' }),
    entry('personal-purchase'),
  ];
  assert.deepEqual(recentActivity(data, 'studio', '2026-09-22').map(transaction => transaction.id), ['pay-studio-debt']);
  assert.deepEqual(recentActivity(data, 'personal', '2026-09-22').map(transaction => transaction.id), ['pay-studio-debt', 'personal-purchase']);
});

test('activity excludes future entries, opening balances and adjustments, even when they involve the selected destination', () => {
  const data = state();
  data.transactions = [
    entry('future', { date: '2026-09-23', kind: 'transfer', toAccountId: 'studio-bank' }),
    entry('opening', { kind: 'opening', accountId: 'studio-bank' }),
    entry('adjustment', { kind: 'adjustment', accountId: 'studio-bank' }),
    entry('today', { kind: 'income', accountId: 'studio-bank' }),
    entry('yesterday', { date: '2026-09-21', accountId: 'studio-bank' }),
  ];
  assert.deepEqual(recentActivity(data, 'studio', '2026-09-22').map(transaction => transaction.id), ['today', 'yesterday']);
  assert.deepEqual(recentActivity(data, 'studio', '2026-09-21').map(transaction => transaction.id), ['yesterday']);
});

test('activity sorts by transaction date then entry time, limits after filtering and leaves stored order unchanged', () => {
  const data = state();
  data.transactions = [
    entry('old', { date: '2026-09-01' }),
    entry('morning', { createdAt: '2026-09-22T09:00:00.000Z' }),
    entry('future', { date: '2026-09-23' }),
    entry('yesterday', { date: '2026-09-21' }),
    entry('evening', { createdAt: '2026-09-22T18:00:00.000Z' }),
    entry('older', { date: '2026-08-31' }),
  ];
  const original = structuredClone(data);
  assert.deepEqual(recentActivity(data, 'all', '2026-09-22').map(transaction => transaction.id), ['evening', 'morning', 'yesterday', 'old']);
  assert.deepEqual(recentActivity(data, 'all', '2026-09-22', 2).map(transaction => transaction.id), ['evening', 'morning']);
  assert.deepEqual(recentActivity(data, 'all', '2026-09-22', 0), []);
  assert.deepEqual(data, original);
});

test('missing terms include outstanding debts and payables within the selected owner only', () => {
  const data = state();
  assert.deepEqual(debtsMissingTerms(data, 'all').map(account => account.id), ['card', 'studio-payable']);
  assert.deepEqual(debtsMissingTerms(data, 'studio').map(account => account.id), ['studio-payable']);
  assert.deepEqual(debtsMissingTerms(data, 'another-owner'), []);
  data.accounts.find(account => account.id === 'card')!.balanceCents = 0;
  assert.deepEqual(debtsMissingTerms(data, 'personal'), []);
});

test('legacy roadmap terms satisfy the matching loan only and preserve unknown rates or payments', () => {
  const data = state();
  data.roadmap = roadmap();
  const original = structuredClone(data);
  assert.deepEqual(debtsMissingTerms(data, 'all').map(account => account.id), ['studio-payable']);
  assert.deepEqual(data, original);
  data.roadmap.loanAprPercent = null;
  assert.deepEqual(debtsMissingTerms(data, 'personal').map(account => account.id), ['card']);
  data.roadmap.loanAprPercent = 0;
  data.roadmap.loanMonthlyPaymentCents = null;
  assert.deepEqual(debtsMissingTerms(data, 'personal').map(account => account.id), ['card']);
  data.roadmap.loanMonthlyPaymentCents = 0;
  assert.deepEqual(debtsMissingTerms(data, 'personal'), []);
});

test('explicit account terms take precedence over legacy terms and unconfirmed or zero values are not missing', () => {
  const data = state();
  data.roadmap = roadmap();
  const card = data.accounts.find(account => account.id === 'card')!;
  card.debtTerms = { aprPercent: null, minimumPaymentCents: 10000, rateConfirmed: false, notes: '' };
  assert.deepEqual(debtsMissingTerms(data, 'personal').map(account => account.id), ['card']);
  card.debtTerms = { aprPercent: 0, minimumPaymentCents: null, rateConfirmed: false, notes: '' };
  assert.deepEqual(debtsMissingTerms(data, 'personal').map(account => account.id), ['card']);
  card.debtTerms.minimumPaymentCents = 0;
  assert.deepEqual(debtsMissingTerms(data, 'personal'), []);
  card.debtTerms = { aprPercent: 6, minimumPaymentCents: 10000, rateConfirmed: false, notes: '' };
  assert.deepEqual(debtsMissingTerms(data, 'personal'), []);
});

test('expired statement minimums need new payment details without discarding amounts due today', () => {
  const data = state();
  data.roadmap = roadmap();
  const card = data.accounts.find(account => account.id === 'card')!;
  card.debtTerms = { aprPercent: 6, minimumPaymentCents: 10000, rateConfirmed: true, notes: '', paymentDueDate: '2026-09-23' };
  const original = structuredClone(data);
  assert.deepEqual(debtsMissingTerms(data, 'personal', '2026-09-22'), []);
  assert.deepEqual(debtsMissingTerms(data, 'personal', '2026-09-23'), []);
  assert.deepEqual(debtsMissingTerms(data, 'personal', '2026-09-24').map(account => account.id), ['card']);
  assert.deepEqual(debtsMissingTerms(data, 'studio', '2026-09-24').map(account => account.id), ['studio-payable']);
  assert.deepEqual(data, original);
  card.balanceCents = 0;
  assert.deepEqual(debtsMissingTerms(data, 'personal', '2026-09-24'), []);
});
