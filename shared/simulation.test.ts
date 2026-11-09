import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulateMoney, type SimulationInput } from './simulation.ts';

const input: SimulationInput = {
  cashCents: 100000, investmentsCents: 200000, selectedDebtCents: 100000,
  otherDebtCents: 50000, otherAssetsCents: 300000, monthlyBudgetCents: 100000,
  monthlyDebtCents: 40000, monthlyInvestmentsCents: 35000, monthlyBusinessCents: 15000,
  debtAprPercent: 0, investmentAnnualReturnPercent: 0, businessMonthlyNetCents: 0, months: 12,
};

test('zero-return allocation conserves monthly contributions across cash, debt, investments and business', () => {
  const result = simulateMoney(input);
  assert.equal(result.status, 'ready');
  assert.equal(result.monthlyCashCents, 10000);
  assert.equal(result.points[0].netWorthCents, 450000);
  assert.deepEqual(result.points[1], { month: 1, cashCents: 110000, investmentsCents: 235000, debtCents: 110000, selectedDebtCents: 60000, businessCents: 15000, netWorthCents: 550000, interestCents: 0, investmentChangeCents: 0, debtPaymentCents: 40000, redirectedDebtCents: 0 });
  assert.equal(result.points[12].netWorthCents, 1650000);
  assert.equal(result.points[12].debtCents, 50000);
  assert.equal(result.totalInterestCents, 0);
});

test('business funding is capital, not profit, and starts at zero without duplicating existing assets', () => {
  const allCash = simulateMoney({ ...input, monthlyDebtCents: 0, monthlyInvestmentsCents: 0, monthlyBusinessCents: 0 });
  const allBusiness = simulateMoney({ ...input, monthlyDebtCents: 0, monthlyInvestmentsCents: 0, monthlyBusinessCents: 100000 });
  assert.equal(allBusiness.points[0].businessCents, 0);
  assert.equal(allBusiness.points[12].businessCents, 1200000);
  assert.equal(allBusiness.points[12].netWorthCents, allCash.points[12].netWorthCents);
});

test('interest rounds to cents and unpaid interest grows debt instead of inventing a payoff', () => {
  const result = simulateMoney({ ...input, selectedDebtCents: 100000, debtAprPercent: 12, monthlyDebtCents: 500, months: 2 });
  assert.equal(result.points[1].selectedDebtCents, 100500);
  assert.equal(result.points[2].selectedDebtCents, 101005);
  assert.equal(result.totalInterestCents, 2005);
  assert.equal(result.points[2].netWorthCents, result.points[0].netWorthCents + 200000 - 2005);
});

test('debt overpayments and later allocations go to cash after the selected debt clears', () => {
  const result = simulateMoney({ ...input, selectedDebtCents: 10000, months: 2 });
  assert.equal(result.points[1].debtPaymentCents, 10000);
  assert.equal(result.points[1].redirectedDebtCents, 30000);
  assert.equal(result.points[1].cashCents, 140000);
  assert.equal(result.points[2].debtPaymentCents, 0);
  assert.equal(result.points[2].redirectedDebtCents, 40000);
  assert.equal(result.points[2].cashCents, 190000);
});

test('unknown inputs stay unknown and allocations above budget produce no projection', () => {
  const unknown = simulateMoney({ ...input, monthlyBudgetCents: null, debtAprPercent: null });
  assert.equal(unknown.status, 'needs_inputs');
  assert.deepEqual(unknown.missing, ['budget', 'apr']);
  assert.equal(unknown.totalInterestCents, null);
  assert.equal(unknown.points.length, 0);
  const over = simulateMoney({ ...input, monthlyBudgetCents: 50000 });
  assert.equal(over.status, 'over_budget');
  assert.equal(over.overBudgetCents, 40000);
  assert.equal(over.points.length, 0);
  assert.equal(simulateMoney({ ...input, selectedDebtCents: 0, debtAprPercent: null }).status, 'ready');
});

test('effective annual return is applied to prior-month investments before new contributions', () => {
  const result = simulateMoney({ ...input, investmentsCents: 100000, monthlyInvestmentsCents: 0, investmentAnnualReturnPercent: 12 });
  assert.ok(Math.abs(result.points[12].investmentsCents - 112000) <= 2);
  const newMoney = simulateMoney({ ...input, investmentsCents: 0, monthlyInvestmentsCents: 100000, monthlyDebtCents: 0, monthlyBusinessCents: 0, investmentAnnualReturnPercent: 12, months: 1 });
  assert.equal(newMoney.points[1].investmentChangeCents, 0);
  assert.equal(newMoney.points[1].investmentsCents, 100000);
});

test('business income changes net worth once and losses use capital then expose a cash gap', () => {
  const profit = simulateMoney({ ...input, businessMonthlyNetCents: 20000, months: 1 });
  assert.equal(profit.points[1].businessCents, 35000);
  assert.equal(profit.points[1].netWorthCents, profit.points[0].netWorthCents + 120000);
  const loss = simulateMoney({ ...input, cashCents: 10000, businessMonthlyNetCents: -50000, months: 1 });
  assert.equal(loss.points[1].businessCents, 0);
  assert.equal(loss.points[1].cashCents, -15000);
  assert.equal(loss.firstCashGapMonth, 1);
  assert.equal(loss.points[1].netWorthCents, loss.points[0].netWorthCents + 50000);
});

test('negative returns and zero available money remain valid scenarios, invalid numbers do not', () => {
  const result = simulateMoney({ ...input, monthlyBudgetCents: 0, monthlyDebtCents: 0, monthlyInvestmentsCents: 0, monthlyBusinessCents: 0, investmentAnnualReturnPercent: -100, months: 1 });
  assert.equal(result.points[1].investmentsCents, 0);
  assert.throws(() => simulateMoney({ ...input, monthlyDebtCents: -1 }), /Debt allocation/);
  assert.throws(() => simulateMoney({ ...input, investmentAnnualReturnPercent: -101 }), /Annual investment return/);
  assert.throws(() => simulateMoney({ ...input, months: 61 }), /1 to 60/);
  assert.throws(() => simulateMoney({ ...input, monthlyBudgetCents: 0.1 }), /Monthly budget/);
});

test('omitting the frequency preserves monthly interest, returns and allocations', () => {
  const monthly = { ...input, debtAprPercent: 12, investmentAnnualReturnPercent: 8, businessMonthlyNetCents: 5000 };
  assert.deepEqual(simulateMoney(monthly), simulateMoney({ ...monthly, periodsPerYear: 12 }));
});

test('biweekly interest uses 26 periods and rounds each charge before repayment', () => {
  const result = simulateMoney({ ...input, periodsPerYear: 26, debtAprPercent: 26, monthlyDebtCents: 500, months: 2 });
  assert.equal(result.points[1].interestCents, 1000);
  assert.equal(result.points[1].selectedDebtCents, 100500);
  assert.equal(result.points[2].interestCents, 1005);
  assert.equal(result.points[2].selectedDebtCents, 101005);
  assert.equal(result.totalInterestCents, 2005);
  assert.equal(result.points[2].netWorthCents, result.points[0].netWorthCents + 200000 - 2005);
});

test('26 biweekly periods apply one annual return and contributions arrive after each return', () => {
  const result = simulateMoney({ ...input, periodsPerYear: 26, investmentsCents: 100000, monthlyInvestmentsCents: 0, investmentAnnualReturnPercent: 12, months: 26 });
  assert.ok(Math.abs(result.points[26].investmentsCents - 112000) <= 15);
  const contributions = simulateMoney({ ...input, periodsPerYear: 26, investmentsCents: 0, monthlyDebtCents: 0, monthlyInvestmentsCents: 100000, monthlyBusinessCents: 0, investmentAnnualReturnPercent: 12, months: 2 });
  assert.equal(contributions.points[1].investmentChangeCents, 0);
  assert.equal(contributions.points[1].investmentsCents, 100000);
  assert.equal(contributions.points[2].investmentChangeCents, 437);
  assert.equal(contributions.points[2].investmentsCents, 200437);
});

test('biweekly allocations conserve every pay period and business income applies once per period', () => {
  const result = simulateMoney({ ...input, periodsPerYear: 26, businessMonthlyNetCents: 10000, months: 26 });
  assert.equal(result.points.length, 27);
  assert.equal(result.monthlyCashCents, 10000);
  for (const point of result.points) assert.equal(point.netWorthCents, result.points[0].netWorthCents + point.month * 110000);
  assert.equal(result.points[26].investmentsCents, 1110000);
  assert.equal(result.points[26].businessCents, 650000);
  assert.equal(result.points[26].selectedDebtCents, 0);
  assert.equal(result.points[26].redirectedDebtCents, 40000);
});

test('weekly interest, annual returns and contributions use 52 periods per year', () => {
  const debt = simulateMoney({ ...input, periodsPerYear: 52, debtAprPercent: 52, monthlyDebtCents: 500, months: 2 });
  assert.equal(debt.points[1].interestCents, 1000);
  assert.equal(debt.points[2].interestCents, 1005);
  const growth = simulateMoney({ ...input, periodsPerYear: 52, investmentsCents: 100000, monthlyInvestmentsCents: 0, investmentAnnualReturnPercent: 12, months: 52 });
  assert.ok(Math.abs(growth.points[52].investmentsCents - 112000) <= 30);
  const contributions = simulateMoney({ ...input, periodsPerYear: 52, months: 52 });
  assert.equal(contributions.points[52].netWorthCents, contributions.points[0].netWorthCents + 5200000);
  assert.equal(contributions.points[52].investmentsCents, 2020000);
});

test('custom period counts stay within five years at the selected frequency', () => {
  for (const periodsPerYear of [12, 26, 52] as const) {
    const maximumPeriods = periodsPerYear * 5;
    assert.equal(simulateMoney({ ...input, periodsPerYear, months: 7 }).points.length, 8);
    assert.equal(simulateMoney({ ...input, periodsPerYear, months: maximumPeriods }).points.length, maximumPeriods + 1);
    for (const months of [0, 1.5, maximumPeriods + 1]) assert.throws(() => simulateMoney({ ...input, periodsPerYear, months }), new RegExp(`1 to ${maximumPeriods}`));
  }
  for (const periodsPerYear of [0, 24, 365, NaN, null] as unknown as SimulationInput['periodsPerYear'][]) {
    assert.throws(() => simulateMoney({ ...input, periodsPerYear }), /12 monthly, 26 biweekly, or 52 weekly/);
  }
});
