import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subscriptionAmount, subscriptionAmountText, subscriptionPresets, subscriptionTotals } from './subscriptions.ts';
import type { Obligation } from './types.ts';

function subscription(id: string, amountCents: number, overrides: Partial<Obligation> = {}): Obligation {
  return { id, entityId: 'personal', name: id, amountCents, dueDate: '2026-09-23', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Bills', subscription: true, ...overrides };
}

test('monthly equivalent combines monthly and biweekly charges without counting cancelled plans or ordinary bills', () => {
  const rows = [subscription('monthly', 1299), subscription('biweekly', 2000, { recurrence: 'biweekly' }), subscription('cancelled', 5000, { status: 'cancelled' }), subscription('bill', 100000, { subscription: undefined }), subscription('business', 500, { entityId: 'business' })];
  assert.deepEqual(subscriptionTotals(rows, 'personal'), { count: 2, annualCents: 67588, monthlyCents: 5632 });
  assert.deepEqual(subscriptionTotals(rows), { count: 3, annualCents: 73588, monthlyCents: 6132 });
  assert.deepEqual(subscriptionTotals([]), { count: 0, annualCents: 0, monthlyCents: 0 });
});

test('presets contain names and categories only, with no fabricated prices or dates', () => {
  assert.deepEqual(subscriptionPresets.map(preset => Object.keys(preset)), [['name', 'category'], ['name', 'category'], ['name', 'category']]);
  assert.deepEqual(subscriptionPresets.map(preset => preset.name), ['YouTube Red', 'GoodLife', 'Phone plan']);
});

test('subscription amounts use exact cents and reject blank, zero, negative and subcent inputs', () => {
  assert.equal(subscriptionAmount('12.99'), 1299);
  assert.equal(subscriptionAmount('.50'), 50);
  assert.equal(subscriptionAmountText(1299), '12.99');
  assert.equal(subscriptionAmountText(100), '1.00');
  assert.equal(subscriptionAmount('1000000000000.00'), 100_000_000_000_000);
  for (const value of ['', '0', '-10', '1.001', '1e3', '1000000000000.01']) assert.throws(() => subscriptionAmount(value));
});
