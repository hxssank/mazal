import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedWorkPayCents, expensePayDates } from './expense-pay.ts';
import type { RoadmapSettings } from './types.ts';

const settings = { paydayAnchor: '2026-09-24', payEveryDays: 14, payAmountCents: 150000 } as RoadmapSettings;
test('work pay rounds half cents up with fractional hours and within large supported balances', () => {
  const work = { weeklyHours: 18.75, fullTimeWeeklyHours: 37.5, returnDate: '2027-05-01', payPeriodEndLagDays: 5 };
  assert.equal(estimatedWorkPayCents(1001, work), 501);
  assert.equal(estimatedWorkPayCents(99_999_999_999_995, work, 1, 5), 89_999_999_999_996);
});
test('expense pay dates keep biweekly cadence through month boundaries', () => {
  assert.deepEqual(expensePayDates(settings, '2026-09-23'), ['2026-09-24', '2026-10-08', '2026-10-22']);
  assert.deepEqual(expensePayDates(settings, '2026-10-08', 1), ['2026-10-08']);
  assert.deepEqual(expensePayDates(settings, '2026-10-09', 1), ['2026-10-22']);
});
test('expense pay dates support custom cadence and do not backfill before an anchor', () => {
  assert.deepEqual(expensePayDates({ ...settings, payEveryDays: 7 }, '2026-09-01', 2), ['2026-09-24', '2026-10-01']);
  assert.deepEqual(expensePayDates({ ...settings, payEveryDays: 28 }, '2026-10-01', 1), ['2026-10-22']);
  assert.deepEqual(expensePayDates(undefined, '2026-09-23'), []);
});

test('invalid calendar dates and unsupported projections never produce normalized payday dates', () => {
  for (const invalid of ['', '2026-2-01', '2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', 'not-a-date']) {
    assert.deepEqual(expensePayDates({ ...settings, paydayAnchor: invalid }, '2026-09-23'), []);
    assert.deepEqual(expensePayDates(settings, invalid), []);
  }
  for (const count of [0, -1, 1.5, 101, Number.POSITIVE_INFINITY]) assert.deepEqual(expensePayDates(settings, '2026-09-23', count), []);
  for (const payEveryDays of [0, -1, 1.5, 367, Number.POSITIVE_INFINITY]) assert.deepEqual(expensePayDates({ ...settings, payEveryDays }, '2026-09-23'), []);
  assert.deepEqual(expensePayDates({ ...settings, paydayAnchor: '9999-12-31' }, '9999-12-31', 2), []);
  assert.deepEqual(expensePayDates({ ...settings, paydayAnchor: '2028-02-29' }, '2028-02-29', 2), ['2028-02-29', '2028-03-14']);
});
