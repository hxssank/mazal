import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculatePayoff, transitionPlan } from './roadmap.ts';
import type { TransitionInput } from './roadmap.ts';

const transition: TransitionInput = {
  cashCents: 200_000,
  protectedReservesCents: 100_000,
  monthlyEssentialsCents: 150_000,
  monthlyDebtMinimumsCents: 25_000,
  currentMonthlyIncomeCents: 300_000,
  partTimeMonthlyIncomeCents: 100_000,
  monthsUntilChange: 3,
  transitionMonths: 6,
  monthlyExtraDebtCents: 50_000,
};

test('a zero balance is already paid even when APR is unknown', () => {
  assert.deepEqual(calculatePayoff({ balanceCents: 0, aprPercent: null, monthlyPaymentCents: 0 }), {
    status: 'paid_off', months: 0, totalInterestCents: 0, schedule: [],
  });
});

test('unknown APR remains unknown instead of producing a zero-interest payoff date', () => {
  assert.deepEqual(calculatePayoff({ balanceCents: 100_000, aprPercent: null, monthlyPaymentCents: 10_000 }), {
    status: 'needs_inputs', months: null, totalInterestCents: null, schedule: [],
  });
});

test('zero APR pays exact principal and caps the final payment at the remaining debt', () => {
  const result = calculatePayoff({ balanceCents: 10_000, aprPercent: 0, monthlyPaymentCents: 3_000 });
  assert.equal(result.status, 'paid_off');
  assert.equal(result.months, 4);
  assert.equal(result.totalInterestCents, 0);
  assert.deepEqual(result.schedule.map((row) => row.paymentCents), [3_000, 3_000, 3_000, 1_000]);
  assert.equal(result.schedule.at(-1)?.balanceCents, 0);
});

test('monthly interest rounds to cents and total interest matches all payments minus principal', () => {
  const result = calculatePayoff({ balanceCents: 100_000, aprPercent: 12, monthlyPaymentCents: 10_000 });
  assert.equal(result.status, 'paid_off');
  assert.equal(result.months, 11);
  assert.equal(result.totalInterestCents, 5_898);
  assert.deepEqual(result.schedule[0], { month: 1, balanceCents: 91_000, paymentCents: 10_000, interestCents: 1_000 });
  assert.deepEqual(result.schedule[1], { month: 2, balanceCents: 81_910, paymentCents: 10_000, interestCents: 910 });
  assert.equal(result.schedule.reduce((sum, row) => sum + row.paymentCents, 0) - 100_000, result.totalInterestCents);
});

test('a monthly extra payment shortens payoff and reduces interest without overpaying the last month', () => {
  const baseline = calculatePayoff({ balanceCents: 100_000, aprPercent: 12, monthlyPaymentCents: 10_000 });
  const faster = calculatePayoff({ balanceCents: 100_000, aprPercent: 12, monthlyPaymentCents: 10_000, extraPaymentCents: 10_000 });
  assert.equal(faster.status, 'paid_off');
  assert.equal(faster.months, 6);
  assert.ok(faster.totalInterestCents! < baseline.totalInterestCents!);
  assert.ok(faster.schedule.at(-1)!.paymentCents < 20_000);
  assert.equal(faster.schedule.at(-1)!.balanceCents, 0);
});

test('payments at or below monthly interest have no payoff date', () => {
  for (const payment of [0, 999, 1000]) {
    const result = calculatePayoff({ balanceCents: 100_000, aprPercent: 12, monthlyPaymentCents: payment });
    assert.equal(result.status, 'below_interest');
    assert.equal(result.months, null);
    assert.equal(result.totalInterestCents, null);
  }
  assert.equal(calculatePayoff({ balanceCents: 100, aprPercent: 0, monthlyPaymentCents: 0 }).status, 'below_interest');
});

test('the payoff horizon limits the schedule without claiming a total interest or payoff date', () => {
  const result = calculatePayoff({ balanceCents: 100_000, aprPercent: 12, monthlyPaymentCents: 10_000, maxMonths: 3 });
  assert.equal(result.status, 'beyond_horizon');
  assert.equal(result.schedule.length, 3);
  assert.equal(result.months, null);
  assert.equal(result.totalInterestCents, null);
  assert.ok(result.schedule.at(-1)!.balanceCents > 0);
});

test('transition planning protects reserves and applies extra payments only before the income change', () => {
  assert.deepEqual(transitionPlan(transition), {
    status: 'ready',
    currentMonthlySurplus: 75_000,
    monthlyShortfallAfterChange: 75_000,
    transitionBufferNeeded: 450_000,
    cashAvailableForGoal: 100_000,
    projectedTransitionCash: 325_000,
    targetGap: 125_000,
  });
  const withoutExtra = transitionPlan({ ...transition, monthlyExtraDebtCents: 0 });
  assert.equal(withoutExtra.projectedTransitionCash, 475_000);
  assert.equal(withoutExtra.transitionBufferNeeded, 450_000);
  assert.equal(withoutExtra.targetGap, 0);
});

test('unknown incomes produce null dependent amounts while preserving independently known cash', () => {
  const bothUnknown = transitionPlan({ ...transition, currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null });
  assert.deepEqual(bothUnknown, {
    status: 'needs_inputs', currentMonthlySurplus: null, monthlyShortfallAfterChange: null,
    transitionBufferNeeded: null, cashAvailableForGoal: 100_000, projectedTransitionCash: null, targetGap: null,
  });
  const unknownPartTime = transitionPlan({ ...transition, partTimeMonthlyIncomeCents: null });
  assert.equal(unknownPartTime.currentMonthlySurplus, 75_000);
  assert.equal(unknownPartTime.projectedTransitionCash, 325_000);
  assert.equal(unknownPartTime.transitionBufferNeeded, null);
  assert.equal(unknownPartTime.targetGap, null);
  const unknownCurrent = transitionPlan({ ...transition, currentMonthlyIncomeCents: null });
  assert.equal(unknownCurrent.transitionBufferNeeded, 450_000);
  assert.equal(unknownCurrent.projectedTransitionCash, null);
});

test('confirmed zero income is distinct from unknown income', () => {
  const plan = transitionPlan({ ...transition, currentMonthlyIncomeCents: 0, partTimeMonthlyIncomeCents: 0 });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.currentMonthlySurplus, -225_000);
  assert.equal(plan.monthlyShortfallAfterChange, 175_000);
  assert.equal(plan.transitionBufferNeeded, 1_050_000);
});

test('cash below reserves and a current deficit remain visible in the transition gap', () => {
  const plan = transitionPlan({ ...transition, cashCents: 50_000, currentMonthlyIncomeCents: 200_000 });
  assert.equal(plan.cashAvailableForGoal, -50_000);
  assert.equal(plan.currentMonthlySurplus, -25_000);
  assert.equal(plan.projectedTransitionCash, -125_000);
  assert.equal(plan.targetGap, 575_000);
});

test('a transition starting now does not subtract any pre-change extra debt payments', () => {
  const plan = transitionPlan({ ...transition, monthsUntilChange: 0 });
  assert.equal(plan.projectedTransitionCash, 100_000);
  assert.equal(plan.targetGap, 350_000);
});

test('part-time income covering essentials and minimums needs no shortfall buffer', () => {
  const plan = transitionPlan({ ...transition, partTimeMonthlyIncomeCents: 200_000 });
  assert.equal(plan.monthlyShortfallAfterChange, 0);
  assert.equal(plan.transitionBufferNeeded, 0);
  assert.equal(plan.targetGap, 0);
});

test('invalid inputs and arithmetic outside safe cents fail instead of producing misleading projections', () => {
  assert.throws(() => calculatePayoff({ balanceCents: -1, aprPercent: 12, monthlyPaymentCents: 100 }), /Loan balance/);
  assert.throws(() => calculatePayoff({ balanceCents: 100, aprPercent: NaN, monthlyPaymentCents: 100 }), /APR/);
  assert.throws(() => calculatePayoff({ balanceCents: 100, aprPercent: 12, monthlyPaymentCents: 100, maxMonths: 0 }), /Maximum months/);
  assert.throws(() => calculatePayoff({ balanceCents: 100, aprPercent: 12, monthlyPaymentCents: 0.5 }), /Monthly payment/);
  assert.throws(() => transitionPlan({ ...transition, monthsUntilChange: -1 }), /Months until/);
  assert.throws(() => transitionPlan({ ...transition, partTimeMonthlyIncomeCents: -1 }), /Part-time monthly/);
  assert.throws(() => transitionPlan({ ...transition, monthlyEssentialsCents: Number.MAX_SAFE_INTEGER }), /Essentials and debt minimums/);
});
