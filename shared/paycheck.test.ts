import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentageCents, paydayForPeriod, nextPaydayOnOrAfter, type PayFrequency } from './paycheck.ts';

test('paycheck percentages keep cents exact and leave fractional cents in cash', () => {
  assert.equal(percentageCents(150000, '40'), 60000);
  assert.equal(percentageCents(150001, '33.33'), 49995);
  assert.equal(percentageCents(Number.MAX_SAFE_INTEGER, '100'), Number.MAX_SAFE_INTEGER);
  const split = ['33.33', '33.33', '33.34'].map(p => percentageCents(100, p));
  assert.equal(split.reduce((a, b) => a + b), 99);
  for (const p of ['-1', '101', '', '1e2', '5.001']) assert.throws(() => percentageCents(150000, p));
});

test('biweekly and weekly payday dates cross year and daylight saving boundaries', () => {
  assert.equal(paydayForPeriod('2026-09-24', 1, 26), '2026-09-24');
  assert.equal(paydayForPeriod('2026-09-24', 26, 26), '2027-09-09');
  assert.equal(paydayForPeriod('2026-10-29', 2, 52), '2026-11-05');
  assert.throws(() => paydayForPeriod('2026-02-30', 1, 26));
  assert.throws(() => paydayForPeriod('2026-09-24', 0, 26));
});

test('monthly paydays clamp to month end without drifting the original payday', () => {
  assert.equal(paydayForPeriod('2028-01-31', 2, 12), '2028-02-29');
  assert.equal(paydayForPeriod('2028-01-31', 3, 12), '2028-03-31');
  assert.equal(paydayForPeriod('0000-01-31', 2, 12), '0000-02-29');
});

test('period paydays reject unsupported frequencies and dates outside the four-digit year range', () => {
  for (const frequency of [0, 24, 365, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => paydayForPeriod('2026-09-24', 1, frequency as PayFrequency), /monthly, biweekly, or weekly/);
  }
  for (const frequency of [12, 26, 52] as const) {
    assert.equal(paydayForPeriod('9999-12-31', 1, frequency), '9999-12-31');
    assert.throws(() => paydayForPeriod('9999-12-31', 2, frequency), /supported date range/);
  }
});

test('next payday advances ancient anchors without a projection horizon limit', () => {
  assert.equal(nextPaydayOnOrAfter('1900-01-01', '2026-09-23', 52), '2026-09-28');
  assert.equal(nextPaydayOnOrAfter('1900-01-01', '2026-09-23', 26), '2026-10-05');
  assert.equal(nextPaydayOnOrAfter('1900-01-31', '2026-09-23', 12), '2026-09-30');
  assert.equal(nextPaydayOnOrAfter('0001-01-31', '2026-09-23', 12), '2026-09-30');
});

test('next payday includes the current payday and retains an anchor in the future', () => {
  for (const frequency of [12, 26, 52] as const) {
    assert.equal(nextPaydayOnOrAfter('2026-09-23', '2026-09-23', frequency), '2026-09-23');
    assert.equal(nextPaydayOnOrAfter('2026-09-24', '2026-09-23', frequency), '2026-09-24');
  }
  assert.equal(nextPaydayOnOrAfter('1900-01-01', '2026-09-21', 26), '2026-09-21');
  assert.equal(nextPaydayOnOrAfter('2026-01-31', '2026-09-30', 12), '2026-09-30');
});

test('next monthly payday preserves the anchored day after short months and leap years', () => {
  assert.equal(nextPaydayOnOrAfter('2026-01-31', '2026-02-01', 12), '2026-02-28');
  assert.equal(nextPaydayOnOrAfter('2026-01-31', '2026-03-01', 12), '2026-03-31');
  assert.equal(nextPaydayOnOrAfter('2028-01-31', '2028-02-01', 12), '2028-02-29');
  assert.equal(nextPaydayOnOrAfter('2028-01-31', '2028-03-01', 12), '2028-03-31');
  assert.equal(nextPaydayOnOrAfter('2026-01-15', '2026-09-16', 12), '2026-10-15');
  assert.equal(nextPaydayOnOrAfter('2026-01-31', '2027-01-01', 12), '2027-01-31');
});

test('weekly and biweekly next paydays keep calendar cadence through DST and year boundaries', () => {
  assert.equal(nextPaydayOnOrAfter('2026-03-01', '2026-03-09', 52), '2026-03-15');
  assert.equal(nextPaydayOnOrAfter('2026-03-01', '2026-03-09', 26), '2026-03-15');
  assert.equal(nextPaydayOnOrAfter('2026-10-25', '2026-11-02', 52), '2026-11-08');
  assert.equal(nextPaydayOnOrAfter('2026-10-25', '2026-11-02', 26), '2026-11-08');
  assert.equal(nextPaydayOnOrAfter('2026-12-24', '2027-01-01', 52), '2027-01-07');
  assert.equal(nextPaydayOnOrAfter('2026-12-24', '2027-01-01', 26), '2027-01-07');
});

test('next payday rejects invalid dates and unsupported frequencies', () => {
  for (const invalid of ['', '2026-2-01', '2026-02-29', '2028-02-30', '2026-13-01', 'not-a-date']) {
    assert.throws(() => nextPaydayOnOrAfter(invalid, '2026-09-23', 26), /valid payday anchor/);
    assert.throws(() => nextPaydayOnOrAfter('2026-01-01', invalid, 26), /valid current date/);
  }
  assert.throws(() => nextPaydayOnOrAfter('2026-01-01', '2026-09-23', 24 as PayFrequency), /monthly, biweekly, or weekly/);
  assert.throws(() => nextPaydayOnOrAfter('9999-12-30', '9999-12-31', 52), /supported date range/);
});
