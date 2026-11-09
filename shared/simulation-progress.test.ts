import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulateMoney, type SimulationInput } from './simulation.ts';
import { simulationMilestones, summarizeProgress } from './simulation-progress.ts';

const input: SimulationInput = {
  cashCents: 100000, investmentsCents: 200000, selectedDebtCents: 100000,
  otherDebtCents: 50000, otherAssetsCents: 300000, monthlyBudgetCents: 100000,
  monthlyDebtCents: 40000, monthlyInvestmentsCents: 35000, monthlyBusinessCents: 15000,
  debtAprPercent: 0, investmentAnnualReturnPercent: 0, businessMonthlyNetCents: 0, months: 12,
};

test('month zero and missing projections have no invented progress or milestones', () => {
  const points = simulateMoney(input).points;
  const zero = { debtPaidCents: 0, debtPaidPercent: 0, interestAccruedCents: 0, investmentGrowthCents: 0, redirectedDebtCents: 0 };
  assert.deepEqual(summarizeProgress(points, 0), zero);
  assert.deepEqual(summarizeProgress(points, -4), zero);
  assert.deepEqual(summarizeProgress(points, NaN), zero);
  assert.deepEqual(summarizeProgress([], 12), zero);
  assert.deepEqual(summarizeProgress(undefined, 12), zero);
  assert.deepEqual(simulationMilestones(null), []);
  assert.deepEqual(simulationMilestones([]), []);
});

test('progress counts selected principal reduction and cumulative redirection without claiming all debt is paid', () => {
  const points = simulateMoney(input).points;
  assert.deepEqual(summarizeProgress(points, 1), { debtPaidCents: 40000, debtPaidPercent: 40, interestAccruedCents: 0, investmentGrowthCents: 0, redirectedDebtCents: 0 });
  assert.equal(summarizeProgress(points, 2).debtPaidCents, 80000);
  assert.equal(summarizeProgress(points, 3).redirectedDebtCents, 20000);
  assert.equal(summarizeProgress(points, 4).redirectedDebtCents, 60000);
  assert.equal(points[3].debtCents, 50000);
  assert.deepEqual(simulationMilestones(points), [{ id: 'debt-paid', month: 3, valueCents: 0 }]);
  assert.deepEqual(summarizeProgress(points, 100), summarizeProgress(points, 12));
  assert.deepEqual(summarizeProgress(points, 2.9), summarizeProgress(points, 2));
});

test('interest is cumulative accrued interest even when payments do not cover it', () => {
  const points = simulateMoney({ ...input, debtAprPercent: 12, monthlyDebtCents: 500, months: 3 }).points;
  assert.equal(summarizeProgress(points, 1).interestAccruedCents, 1000);
  assert.equal(summarizeProgress(points, 2).interestAccruedCents, 2005);
  assert.equal(summarizeProgress(points, 2).debtPaidCents, 0);
  assert.equal(summarizeProgress(points, 2).debtPaidPercent, 0);
  assert.ok(points[2].selectedDebtCents > points[0].selectedDebtCents);
  assert.deepEqual(simulationMilestones(points), []);
});

test('biweekly progress follows pay period indexes without treating them as calendar months', () => {
  const points = simulateMoney({ ...input, periodsPerYear: 26, debtAprPercent: 12, months: 4 }).points;
  assert.deepEqual(summarizeProgress(points, 2), { debtPaidCents: 79259, debtPaidPercent: 79.25, interestAccruedCents: 741, investmentGrowthCents: 0, redirectedDebtCents: 0 });
  assert.equal(summarizeProgress(points, 4).redirectedDebtCents, 59163);
  assert.deepEqual(simulationMilestones(points), [{ id: 'debt-paid', month: 3, valueCents: 0 }]);
});

test('investment growth sums returns through the chosen month and excludes contributions', () => {
  const points = simulateMoney({ ...input, investmentAnnualReturnPercent: 12, months: 3 }).points;
  const first = points[1].investmentChangeCents;
  const second = points[2].investmentChangeCents;
  assert.equal(summarizeProgress(points, 1).investmentGrowthCents, first);
  assert.equal(summarizeProgress(points, 2).investmentGrowthCents, first + second);
  assert.equal(points[2].investmentsCents - points[0].investmentsCents, first + second + 70000);
  const loss = simulateMoney({ ...input, investmentAnnualReturnPercent: -100, months: 2 }).points;
  assert.equal(summarizeProgress(loss, 2).investmentGrowthCents, -235000);
});

test('already-zero debt and nonnegative opening net worth create no payoff milestones', () => {
  const points = simulateMoney({ ...input, selectedDebtCents: 0, months: 2 }).points;
  assert.equal(summarizeProgress(points, 2).debtPaidPercent, 0);
  assert.equal(summarizeProgress(points, 2).redirectedDebtCents, 80000);
  assert.deepEqual(simulationMilestones(points), []);
});

test('milestones include an opening cash gap and first net worth recovery in month order', () => {
  const points = simulateMoney({ ...input, cashCents: -10000, investmentsCents: 0, otherAssetsCents: 0, otherDebtCents: 0, months: 4 }).points;
  assert.deepEqual(simulationMilestones(points), [
    { id: 'cash-gap', month: 0, valueCents: -10000 },
    { id: 'net-worth-positive', month: 2, valueCents: 90000 },
    { id: 'debt-paid', month: 3, valueCents: 0 },
  ]);
  const laterGap = simulateMoney({ ...input, cashCents: 10000, businessMonthlyNetCents: -50000, months: 2 }).points;
  assert.deepEqual(simulationMilestones(laterGap), [{ id: 'cash-gap', month: 1, valueCents: -15000 }]);
});

test('zero net worth counts as recovery and missing opening points do not invent initial debt', () => {
  const points = simulateMoney({ ...input, cashCents: 0, investmentsCents: 0, otherAssetsCents: 0, otherDebtCents: 0, months: 2 }).points;
  assert.ok(simulationMilestones(points).some(event => event.id === 'net-worth-positive' && event.month === 1 && event.valueCents === 0));
  assert.equal(summarizeProgress(points.slice(1), 2).debtPaidCents, 0);
  assert.deepEqual(simulationMilestones(points.slice(1)), []);
  const original = [...points];
  const reversed = [...points].reverse();
  assert.deepEqual(summarizeProgress(reversed, 2), summarizeProgress(points, 2));
  assert.deepEqual(simulationMilestones(reversed), simulationMilestones(points));
  assert.deepEqual(points, original);
  assert.equal(reversed[0].month, 2);
});

test('money sums use integer cents and reject an unsafe cumulative amount', () => {
  const points = simulateMoney({ ...input, months: 2 }).points;
  points[1].investmentChangeCents = Number.MAX_SAFE_INTEGER;
  points[2].investmentChangeCents = -2;
  assert.equal(summarizeProgress(points, 2).investmentGrowthCents, Number.MAX_SAFE_INTEGER - 2);
  points[2].investmentChangeCents = 1;
  assert.throws(() => summarizeProgress(points, 2), /supported whole-cent range/);
});
