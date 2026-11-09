import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expenseFundAmount, expenseFundAmountText, expenseFundProgress, expenseFundStarters } from './expense-funds.ts';
import type { ExpenseFund, RoadmapSettings } from './types.ts';

const fund: ExpenseFund = { id: 'car-fund', entityId: 'personal', name: 'Car maintenance', targetCents: 100001, savedCents: 10000, targetDate: '2026-10-08' };
const roadmap: RoadmapSettings = { currentMonthlyIncomeCents: 400000, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: '2027-01-01', transitionMonths: 12, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, payAmountCents: 200000, payEveryDays: 14, paydayAnchor: '2026-09-24' };

test('paydays include today and the deadline, with remaining cents rounded up per payday', () => {
  const progress = expenseFundProgress(fund, roadmap, '2026-09-24');
  assert.equal(progress.remainingCents, 90001);
  assert.equal(progress.contributionsRemaining, 2);
  assert.equal(progress.contributionCents, 45001);
  assert.equal(progress.firstContributionDate, '2026-09-24');
  assert.equal(progress.cadence, 'paycheck');
  assert.equal(progress.payEveryDays, 14);
  assert.equal(expenseFundProgress(fund, roadmap, '2026-09-25').contributionsRemaining, 1);
  assert.equal(expenseFundProgress({ ...fund, targetDate: '2026-10-07' }, roadmap, '2026-09-25').contributionCents, null);
});

test('custom cadence keeps calendar dates across DST and advances historical anchors', () => {
  const progress = expenseFundProgress({ ...fund, targetDate: '2026-11-22' }, { ...roadmap, payEveryDays: 7, paydayAnchor: '1900-01-07' }, '2026-11-01');
  assert.equal(progress.firstContributionDate, '2026-11-01');
  assert.equal(progress.contributionsRemaining, 4);
  assert.equal(progress.contributionCents, 22501);
  const future = expenseFundProgress(fund, { ...roadmap, paydayAnchor: '2026-10-09' }, '2026-09-23');
  assert.equal(future.contributionsRemaining, 0);
  assert.equal(future.contributionCents, null);
});

test('monthly fallback says estimate and preserves month-end deadlines without inventing paydays', () => {
  const monthly = { ...roadmap, payAmountCents: undefined, payEveryDays: undefined, paydayAnchor: undefined };
  const progress = expenseFundProgress({ ...fund, targetDate: '2028-03-31' }, monthly, '2028-01-31');
  assert.equal(progress.cadence, 'monthly');
  assert.equal(progress.contributionsRemaining, 3);
  assert.equal(progress.contributionCents, 30001);
  assert.equal(progress.firstContributionDate, '2028-01-31');
  assert.equal(progress.payEveryDays, null);
  assert.equal(expenseFundProgress({ ...fund, targetDate: '2028-03-30' }, monthly, '2028-01-31').contributionsRemaining, 2);
});

test('missing pay stays unknown, overdue is distinct, and excess savings cap progress without loss', () => {
  const unknown = expenseFundProgress(fund, undefined, '2026-09-23');
  assert.equal(unknown.cadence, 'unknown');
  assert.equal(unknown.contributionsRemaining, null);
  assert.equal(unknown.contributionCents, null);
  const overdue = expenseFundProgress(fund, roadmap, '2026-10-09');
  assert.equal(overdue.overdue, true);
  assert.equal(overdue.daysRemaining, -1);
  assert.equal(overdue.contributionsRemaining, 0);
  assert.equal(overdue.contributionCents, null);
  const complete = expenseFundProgress({ ...fund, savedCents: 120000 }, undefined, '2026-10-09');
  assert.equal(complete.remainingCents, 0);
  assert.equal(complete.percent, 100);
  assert.equal(complete.contributionCents, 0);
  assert.equal(complete.overdue, false);
  assert.equal(complete.complete, true);
});

test('amount parsing and contribution rounding preserve exact cents at supported limits', () => {
  assert.equal(expenseFundAmount('.01'), 1);
  assert.equal(expenseFundAmount('0', true), 0);
  assert.equal(expenseFundAmountText(100001), '1000.01');
  assert.equal(expenseFundAmount('1000000000000.00'), 100_000_000_000_000);
  const progress = expenseFundProgress({ ...fund, targetCents: Number.MAX_SAFE_INTEGER, savedCents: 0 }, roadmap, '2026-09-24');
  assert.equal(progress.contributionCents, 4503599627370496);
  for (const value of ['', '0', '-1', '2.001', '1e3', '1000000000000.01']) assert.throws(() => expenseFundAmount(value));
  assert.throws(() => expenseFundProgress({ ...fund, targetCents: 0 }, roadmap));
  assert.throws(() => expenseFundProgress({ ...fund, targetDate: '2026-02-30' }, roadmap));
});

test('starter choices contain names only', () => {
  assert.deepEqual(expenseFundStarters, ['Car maintenance', 'Travel', 'Moving out', 'Education']);
});
