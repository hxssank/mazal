import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppState, Transaction } from './types.ts';
import { limitsForOwner, periodBounds, selectedLimit, spendingOverview } from './spending.ts';

function state(): AppState {
  return {
    workspace: 'live', revision: 0, entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }],
    accounts: [{ id: 'bank', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }, { id: 'business-bank', entityId: 'business', name: 'Business', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}
function entry(id: string, category: string, date = '2026-09-22', kind: Transaction['kind'] = 'expense', accountId = 'bank'): Transaction {
  return { id, category, date, kind, accountId, description: id, amountCents: 1200, toAccountId: null, source: 'manual', createdAt: `${date}T12:00:00Z` };
}

test('periods use calendar days, Monday to Sunday, month ends, and leap years', () => {
  assert.deepEqual(periodBounds('daily', '2026-09-22'), { start: '2026-09-22', end: '2026-09-22' });
  assert.deepEqual(periodBounds('weekly', '2026-01-01'), { start: '2025-12-29', end: '2026-01-04' });
  assert.deepEqual(periodBounds('weekly', '2026-09-27'), { start: '2026-09-21', end: '2026-09-27' });
  assert.deepEqual(periodBounds('monthly', '2028-02-20'), { start: '2028-02-01', end: '2028-02-29' });
  assert.throws(() => periodBounds('daily', '2026-02-29'), /valid calendar/);
});

test('live limits are unknown and explicit zero stays distinct from unknown', () => {
  const data = state();
  assert.ok(limitsForOwner(data, 'me').every((limit) => limit.dailyCents === null && limit.weeklyCents === null && limit.monthlyCents === null));
  const food = limitsForOwner(data, 'me').find(limit => limit.name === 'Food')!;
  data.spendingLimits = [{ ...food, dailyCents: 0, monthlyCents: 20000 }];
  assert.equal(selectedLimit(limitsForOwner(data, 'me').find(limit => limit.name === 'Food')!, 'daily'), 0);
  assert.equal(selectedLimit(limitsForOwner(data, 'me').find(limit => limit.name === 'Food')!, 'weekly'), null);
  assert.equal(selectedLimit(limitsForOwner(data, 'me').find(limit => limit.name === 'Food')!, 'monthly'), 20000);
});

test('only expenses in the selected owner and elapsed period count, including credit-card purchases once', () => {
  const data = state();
  data.accounts.push({ id: 'card', entityId: 'me', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 2000, reconciledAt: null });
  data.transactions = [entry('food', '  GROCERIES  '), entry('card-food', 'Food & Drink', '2026-09-21', 'expense', 'card'), entry('future', 'food', '2026-09-23'), entry('old', 'food', '2026-09-20'), entry('transfer', 'food', '2026-09-22', 'transfer'), entry('payment', 'food', '2026-09-22', 'debt_payment'), entry('opening', 'food', '2026-09-22', 'opening'), entry('income', 'food', '2026-09-22', 'income'), entry('business', 'food', '2026-09-22', 'expense', 'business-bank')];
  const summary = spendingOverview(data, 'me', 'weekly', '2026-09-22');
  assert.equal(summary.totalSpentCents, 2400);
  assert.equal(summary.rows.find((row) => row.limit.name === 'Food')?.spentCents, 2400);
  assert.equal(spendingOverview(data, 'me', 'daily', '2026-09-22').totalSpentCents, 1200);
});

test('unknown categories go to Other once and saved aliases override default classifications', () => {
  const data = state();
  data.spendingLimits = [{ id: 'me:work', entityId: 'me', name: 'Work', color: '#aabbcc', aliases: ['software', 'food'], dailyCents: null, weeklyCents: null, monthlyCents: null }];
  data.transactions = [entry('work', 'Software'), entry('ambiguous', 'food'), entry('unknown', 'Personal gift'), entry('empty', '')];
  const summary = spendingOverview(data, 'me', 'monthly', '2026-09-22');
  assert.equal(summary.totalSpentCents, 4800);
  assert.equal(summary.rows.reduce((sum, row) => sum + row.spentCents, 0), 4800);
  assert.equal(summary.rows.find((row) => row.limit.name === 'Work')?.spentCents, 2400);
  assert.equal(summary.rows.find((row) => row.limit.name === 'Other')?.spentCents, 2400);
});

test('sample limits apply only in the sample workspace and do not overwrite saved values', () => {
  const data = state();
  data.workspace = 'demo';
  assert.equal(limitsForOwner(data, 'me').find(limit => limit.name === 'Food')!.monthlyCents, 70000);
  data.spendingLimits = [{ ...limitsForOwner(data, 'me').find(limit => limit.name === 'Food')!, monthlyCents: null }];
  assert.equal(limitsForOwner(data, 'me').find(limit => limit.name === 'Food')!.monthlyCents, null);
});

test('spending totals reject unsafe cents across categories and within one category', () => {
  const data = state();
  data.transactions = Array.from({ length: 91 }, (_, index) => ({ ...entry(`expense-${index}`, index % 2 ? 'Food' : 'Transport'), amountCents: 100_000_000_000_000 }));
  assert.throws(() => spendingOverview(data, 'me', 'monthly', '2026-09-22'), /supported amount/);
  data.transactions = data.transactions.map(transaction => ({ ...transaction, category: 'Food' }));
  assert.throws(() => spendingOverview(data, 'me', 'monthly', '2026-09-22'), /supported amount/);
});
