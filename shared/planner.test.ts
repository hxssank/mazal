import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulatePlanner, type PlannerInput } from './planner.ts';

const input: PlannerInput = {
  startMonth: '2026-10', months: 12, payCents: 150000, frequency: 26, paydayAnchor: '2026-10-01',
  monthlyMomCents: 100000, momRemainingCents: 2000000, monthlyDebtCents: 100000, monthlySpendingCents: 50000,
  debts: [{ id: 'card', name: 'Credit card', balanceCents: 600000, aprPercent: 13, minimumCents: 10000 }],
  startingCashCents: 0, startingInvestmentsCents: 0, surplusDestination: 'investments', annualReturnPercent: 0, extraDebtCents: 0, strategy: 'selected', selectedDebtId: 'card',
};

test('dated paycheck estimates change the money available for that month', () => {
  const plan = simulatePlanner({ ...input, months: 1, payByDateCents: { '2026-10-01': 75000, '2026-10-15': 112500 } });
  assert.deepEqual(plan.paychecks.map(pay => pay.payCents), [75000, 112500, 150000]);
  assert.equal(plan.months[0].incomeCents, 337500);
});

test('calendar months use actual biweekly paydays and preserve every cent of monthly targets', () => {
  const plan = simulatePlanner(input);
  const october = plan.months[0];
  assert.deepEqual(plan.paychecks.slice(0, 3).map((paycheck) => paycheck.date), ['2026-10-01', '2026-10-15', '2026-10-29']);
  assert.equal(october.paydayCount, 3);
  assert.equal(october.incomeCents, 450000);
  assert.equal(october.momCents, 100000);
  assert.equal(october.debtCents, 100000);
  assert.equal(october.spendingCents, 50000);
  assert.equal(october.investCents, 200000);
  assert.deepEqual(plan.paychecks.slice(0, 3).map((paycheck) => paycheck.targets.momCents), [33334, 33333, 33333]);
  assert.deepEqual(plan.paychecks.slice(0, 3).map((paycheck) => paycheck.targets.spendingCents), [16667, 16667, 16666]);
  assert.equal(plan.months[1].paydayCount, 2);
  assert.equal(plan.months[1].investCents, 50000);
  assert.equal(plan.opening.date, '2026-09-30');
  assert.equal(plan.opening.dayIndex, -1);
  assert.equal(plan.days[0].date, '2026-10-01');
  assert.equal(plan.days[0].dayIndex, 0);
  assert.equal(plan.days[0].paycheckNumber, 1);
  assert.equal(plan.days[1].paycheckNumber, 1);
  assert.equal(plan.days.length, 365);
});

test('every payday conserves income and balance changes reconcile with cumulative interest', () => {
  const plan = simulatePlanner({ ...input, annualReturnPercent: 7, months: 24, extraDebtCents: 27113 });
  for (const paycheck of plan.paychecks) {
    assert.equal(paycheck.payCents, paycheck.spendingCents + paycheck.momCents + paycheck.debtCents + paycheck.investCents);
    assert.equal(paycheck.debtCents, paycheck.debtPayments.reduce((total, payment) => total + payment.amountCents, 0));
    assert.ok([paycheck.spendingCents, paycheck.momCents, paycheck.debtCents, paycheck.investCents, paycheck.shortfallCents].every((value) => Number.isSafeInteger(value) && value >= 0));
  }
  for (const day of plan.days) {
    assert.equal(day.debtCents, 600000 + day.interestCents - day.debts.reduce((total, debt) => total + debt.paymentCents, 0));
    assert.equal(day.investmentsCents, day.investmentContributionsCents + day.investmentGrowthCents);
    assert.equal(day.progressCents, 600000 - day.debtCents + day.momPaidCents + day.investmentsCents);
  }
  assert.equal(plan.months.reduce((total, month) => total + month.interestCents, 0), plan.totalInterestCents);
});

test('monthly Jan 31 anchors clamp February then return to March 31', () => {
  const plan = simulatePlanner({ ...input, startMonth: '2027-01', paydayAnchor: '2027-01-31', frequency: 12, months: 3 });
  assert.deepEqual(plan.paychecks.map((paycheck) => paycheck.date), ['2027-01-31', '2027-02-28', '2027-03-31']);
  const leap = simulatePlanner({ ...input, startMonth: '2028-01', paydayAnchor: '2028-01-31', frequency: 12, months: 3 });
  assert.deepEqual(leap.paychecks.map((paycheck) => paycheck.date), ['2028-01-31', '2028-02-29', '2028-03-31']);
});

test('a first payday before the plan advances forward; a future anchor never invents earlier income', () => {
  const earlier = simulatePlanner({ ...input, months: 1, paydayAnchor: '2026-09-17' });
  assert.deepEqual(earlier.paychecks.map((paycheck) => paycheck.date), ['2026-10-01', '2026-10-15', '2026-10-29']);
  const later = simulatePlanner({ ...input, months: 2, paydayAnchor: '2026-11-12' });
  assert.equal(later.months[0].paydayCount, 0);
  assert.equal(later.months[0].shortfallCents, 250000);
  assert.equal(later.paychecks[0].date, '2026-11-12');
  assert.match(later.warnings.join(' '), /no scheduled paycheck/);
  const none = simulatePlanner({ ...input, months: 1, paydayAnchor: '2027-01-01' });
  assert.equal(none.paychecks.length, 0);
  assert.equal(none.totalShortfallCents, 250000);
  assert.equal(none.months[0].minimumShortfallCents, 10000);
});

test('daily APR uses elapsed days across leap February and does not charge a full pay period on day one', () => {
  const plan = simulatePlanner({
    ...input, startMonth: '2028-02', months: 1, paydayAnchor: '2028-03-01',
    debts: [{ id: 'card', name: 'Credit card', balanceCents: 36500, aprPercent: 10, minimumCents: 0 }],
  });
  assert.equal(plan.days.length, 29);
  assert.equal(plan.days[0].interestCents, 10);
  assert.equal(plan.days[0].debtCents, 36510);
  assert.equal(plan.totalInterestCents, Math.round(36500 * (Math.pow(1 + 0.1 / 365, 29) - 1)));
  const small = simulatePlanner({
    ...input, months: 12, paydayAnchor: '2027-10-01',
    debts: [{ id: 'card', name: 'Small balance', balanceCents: 100, aprPercent: 13, minimumCents: 0 }],
  });
  assert.equal(small.days[0].interestCents, 0);
  assert.equal(small.totalInterestCents, 14);
  assert.equal(small.days.at(-1)?.debtCents, 114);
});

test('living costs, Mom and debt fit available pay, with no invented investments or repayments', () => {
  const plan = simulatePlanner({ ...input, months: 1, payCents: 50000, frequency: 12, monthlySpendingCents: 40000, monthlyMomCents: 20000, monthlyDebtCents: 30000, extraDebtCents: 100000 });
  const paycheck = plan.paychecks[0];
  assert.equal(paycheck.spendingCents, 40000);
  assert.equal(paycheck.momCents, 10000);
  assert.equal(paycheck.debtCents, 0);
  assert.equal(paycheck.investCents, 0);
  assert.equal(paycheck.extraDebtCents, 0);
  assert.equal(paycheck.shortfallCents, 40000);
  assert.equal(plan.totalShortfallCents, 40000);
  assert.equal(plan.totalMinimumShortfallCents, 10000);
  assert.match(plan.warnings.join(' '), /minimum payments are not covered/);
});

test('monthly funding gaps count an unpaid debt target once while keeping the missed deadline separate', () => {
  const plan = simulatePlanner({
    ...input, months: 1, payCents: 3000, monthlySpendingCents: 0, monthlyMomCents: 0, monthlyDebtCents: 10000,
    debts: [{ ...input.debts[0], aprPercent: 0, minimumDueDate: '2026-10-20' }],
  });
  assert.deepEqual(plan.paychecks.map(pay => pay.debtCents), [3000, 3000, 3000]);
  assert.equal(plan.totalShortfallCents, 1000);
  assert.equal(plan.months[0].shortfallCents, 1000);
  assert.equal(plan.totalMinimumShortfallCents, 4000);
  const fundedLater = simulatePlanner({
    ...input, months: 1, payCents: 4000, monthlySpendingCents: 0, monthlyMomCents: 0, monthlyDebtCents: 10000,
    debts: [{ ...input.debts[0], aprPercent: 0, minimumDueDate: '2026-10-20' }],
  });
  assert.equal(fundedLater.months[0].debtCents, 10000);
  assert.equal(fundedLater.totalShortfallCents, 0);
  assert.ok(fundedLater.totalMinimumShortfallCents > 0);
});

test('minimum payments receive funds before selected-loan overpayments', () => {
  const plan = simulatePlanner({
    ...input, frequency: 12, months: 1, payCents: 10000, monthlySpendingCents: 0, monthlyMomCents: 0, monthlyDebtCents: 10000,
    debts: [
      { id: 'card', name: 'Selected card', balanceCents: 100000, aprPercent: 0, minimumCents: 1000 },
      { id: 'other', name: 'Other loan', balanceCents: 100000, aprPercent: 20, minimumCents: 2000 },
    ],
  });
  assert.deepEqual(plan.paychecks[0].debtPayments, [{ debtId: 'card', amountCents: 8000 }, { debtId: 'other', amountCents: 2000 }]);
  assert.equal(plan.totalMinimumShortfallCents, 0);
  const avalanche = simulatePlanner({
    ...input, frequency: 12, months: 1, payCents: 10000, monthlySpendingCents: 0, monthlyMomCents: 0, monthlyDebtCents: 10000,
    strategy: 'avalanche', debts: [
      { id: 'card', name: 'Selected card', balanceCents: 100000, aprPercent: 0, minimumCents: 1000 },
      { id: 'other', name: 'Other loan', balanceCents: 100000, aprPercent: 20, minimumCents: 2000 },
    ],
  });
  assert.deepEqual(avalanche.paychecks[0].debtPayments, [{ debtId: 'other', amountCents: 9000 }, { debtId: 'card', amountCents: 1000 }]);
});

test('monthly minimum accounting credits overpayments from earlier paydays', () => {
  const plan = simulatePlanner({ ...input, months: 1, monthlySpendingCents: 0, monthlyMomCents: 0, debts: [
    { id: 'card', name: 'Selected card', balanceCents: 1000000, aprPercent: 0, minimumCents: 60000 },
    { id: 'other', name: 'Other loan', balanceCents: 1000000, aprPercent: 10, minimumCents: 15000 },
  ] });
  assert.equal(plan.totalMinimumShortfallCents, 0);
  assert.equal(plan.paychecks.reduce((total, paycheck) => total + (paycheck.debtPayments.find((payment) => payment.debtId === 'other')?.amountCents ?? 0), 0), 15000);
});

test('unknown minimum payments remain unknown and generate an explicit warning', () => {
  const plan = simulatePlanner({ ...input, months: 1, debts: [{ ...input.debts[0], minimumCents: null }] });
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /Minimum payment for Credit card is unknown/);
  assert.equal(plan.totalMinimumShortfallCents, 0);
  assert.equal(plan.months[0].debtCents, 100000);
  const empty = simulatePlanner({ ...input, months: 1, debts: [{ ...input.debts[0], balanceCents: 0, minimumCents: null }] });
  assert.equal(empty.warnings.length, 0);
});

test('Mom and loan payoff stop their payments, send unused allocations to investments and date the milestones', () => {
  const plan = simulatePlanner({
    ...input, months: 2, frequency: 12, payCents: 300000, monthlySpendingCents: 50000, momRemainingCents: 20000,
    debts: [{ id: 'card', name: 'Credit card', balanceCents: 10000, aprPercent: 0, minimumCents: 5000 }],
  });
  assert.equal(plan.paychecks[0].momCents, 20000);
  assert.equal(plan.paychecks[0].debtCents, 10000);
  assert.equal(plan.paychecks[0].investCents, 220000);
  assert.equal(plan.paychecks[1].momCents, 0);
  assert.equal(plan.paychecks[1].debtCents, 0);
  assert.equal(plan.paychecks[1].investCents, 250000);
  assert.equal(plan.totalShortfallCents, 0);
  assert.equal(plan.totalMinimumShortfallCents, 0);
  assert.equal(plan.debtFreeDate, '2026-10-01');
  assert.deepEqual(plan.milestones, [
    { type: 'mom_paid', date: '2026-10-01', name: 'Mom paid off' },
    { type: 'debt_paid', date: '2026-10-01', debtId: 'card', name: 'Credit card' },
  ]);
});

test('a cleared selected loan redirects payment to the next highest APR debt before investing', () => {
  const plan = simulatePlanner({
    ...input, months: 1, frequency: 12, payCents: 100000, monthlyMomCents: 0, monthlySpendingCents: 0,
    debts: [
      { id: 'card', name: 'Selected card', balanceCents: 10000, aprPercent: 0, minimumCents: 0 },
      { id: 'high', name: 'Higher rate', balanceCents: 100000, aprPercent: 20, minimumCents: 0 },
      { id: 'low', name: 'Lower rate', balanceCents: 100000, aprPercent: 5, minimumCents: 0 },
    ],
  });
  assert.deepEqual(plan.paychecks[0].debtPayments, [{ debtId: 'card', amountCents: 10000 }, { debtId: 'high', amountCents: 90000 }]);
  assert.equal(plan.paychecks[0].investCents, 0);
  assert.equal(plan.debtFreeDate, null);
});

test('extra debt money is limited to the investable remainder and to the remaining debt', () => {
  const plan = simulatePlanner({ ...input, months: 1, frequency: 12, payCents: 300000, extraDebtCents: 100000 });
  assert.equal(plan.paychecks[0].debtCents, 150000);
  assert.equal(plan.paychecks[0].extraDebtCents, 50000);
  assert.equal(plan.paychecks[0].investCents, 0);
  const paid = simulatePlanner({ ...input, months: 1, frequency: 12, payCents: 300000, extraDebtCents: 100000, debts: [{ ...input.debts[0], balanceCents: 110000, aprPercent: 0 }] });
  assert.equal(paid.paychecks[0].debtCents, 110000);
  assert.equal(paid.paychecks[0].extraDebtCents, 10000);
  assert.equal(paid.paychecks[0].investCents, 40000);
});

test('annual investment return compounds daily and end-of-day contributions earn no same-day return', () => {
  const plan = simulatePlanner({
    ...input, startMonth: '2027-01', months: 12, paydayAnchor: '2028-01-01',
    startingInvestmentsCents: 100000, annualReturnPercent: 12,
  });
  assert.equal(plan.days.at(-1)?.investmentsCents, 112000);
  assert.equal(plan.days.at(-1)?.investmentGrowthCents, 12000);
  const newMoney = simulatePlanner({ ...input, months: 1, frequency: 12, monthlyMomCents: 0, monthlySpendingCents: 0, monthlyDebtCents: 0, annualReturnPercent: 12 });
  assert.equal(newMoney.days[0].investmentsCents, 150000);
  assert.equal(newMoney.days[0].investmentGrowthCents, 0);
  assert.equal(newMoney.days[1].investmentsCents, Math.round(150000 * Math.pow(1.12, 1 / 365)));
  const zero = simulatePlanner({ ...input, months: 1, startingInvestmentsCents: 50000 });
  assert.equal(zero.days.at(-1)?.investmentsCents, 250000);
  assert.equal(zero.days.at(-1)?.investmentGrowthCents, 0);
});

test('unknown Mom balance continues the monthly amount without inventing a payoff', () => {
  const plan = simulatePlanner({ ...input, momRemainingCents: null, months: 24 });
  assert.equal(plan.days.at(-1)?.momPaidCents, 2400000);
  assert.equal(plan.days.at(-1)?.momRemainingCents, null);
  assert.ok(!plan.milestones.some((milestone) => milestone.type === 'mom_paid'));
});

test('weekly schedules and zero-pay scenarios do not produce fractional cents', () => {
  const weekly = simulatePlanner({ ...input, months: 1, frequency: 52, monthlyMomCents: 100003, monthlyDebtCents: 90001, monthlySpendingCents: 59999 });
  assert.equal(weekly.paychecks.length, 5);
  assert.equal(weekly.months[0].momCents, 100003);
  assert.equal(weekly.months[0].debtCents, 90001);
  assert.equal(weekly.months[0].spendingCents, 59999);
  const zero = simulatePlanner({ ...input, months: 1, payCents: 0 });
  assert.equal(zero.months[0].incomeCents, 0);
  assert.equal(zero.totalShortfallCents, 250000);
  assert.equal(zero.days.at(-1)?.investmentContributionsCents, 0);
});

test('invalid dates, amounts, rates, schedules and debt identities fail before projection', () => {
  for (const startMonth of ['2026-13', '2026-2', '2026-00', '1899-12']) assert.throws(() => simulatePlanner({ ...input, startMonth }), /month/i);
  for (const paydayAnchor of ['2026-02-29', '2028-02-30', '2026-1-01', 'bad', '2201-01-01']) assert.throws(() => simulatePlanner({ ...input, paydayAnchor }), /date|payday/i);
  for (const months of [0, 25, 1.5, NaN]) assert.throws(() => simulatePlanner({ ...input, months }), /1 to 24/);
  for (const payCents of [-1, 0.5, Number.MAX_SAFE_INTEGER, NaN, Infinity]) assert.throws(() => simulatePlanner({ ...input, payCents }), /Pay/);
  for (const annualReturnPercent of [-101, 101, NaN, Infinity]) assert.throws(() => simulatePlanner({ ...input, annualReturnPercent }), /investment return/);
  for (const aprPercent of [-1, 101, NaN, Infinity]) assert.throws(() => simulatePlanner({ ...input, debts: [{ ...input.debts[0], aprPercent }] }), /APR/);
  assert.throws(() => simulatePlanner({ ...input, frequency: 24 as PlannerInput['frequency'] }), /paychecks/);
  assert.throws(() => simulatePlanner({ ...input, strategy: 'other' as PlannerInput['strategy'] }), /repayment/);
  assert.throws(() => simulatePlanner({ ...input, selectedDebtId: 'missing' }), /selected debt/);
  assert.throws(() => simulatePlanner({ ...input, debts: [input.debts[0], input.debts[0]] }), /unique/);
  assert.throws(() => simulatePlanner({ ...input, debts: [{ ...input.debts[0], minimumCents: -1 }] }), /minimum/);
});

test('projection leaves input records unchanged and handles an empty debt list', () => {
  const before = structuredClone(input);
  simulatePlanner(input);
  assert.deepEqual(input, before);
  const empty = simulatePlanner({ ...input, months: 1, debts: [], selectedDebtId: null });
  assert.equal(empty.debtFreeDate, '2026-09-30');
  assert.equal(empty.months[0].debtCents, 0);
  assert.equal(empty.months[0].investCents, 300000);
  assert.equal(empty.totalInterestCents, 0);
  assert.equal(empty.totalShortfallCents, 0);
});

test('cash allocation preserves investment holdings and keeps each paycheck balanced', () => {
  const plan = simulatePlanner({ ...input, months: 2, startingCashCents: 12345, startingInvestmentsCents: 50000, surplusDestination: 'cash' });
  assert.equal(plan.surplusDestination, 'cash');
  assert.equal(plan.opening.cashCents, 12345);
  assert.equal(plan.opening.investmentsCents, 50000);
  assert.equal(plan.months[0].cashCents, 200000);
  assert.equal(plan.months[0].investCents, 0);
  assert.equal(plan.months[0].end.cashCents, 212345);
  assert.equal(plan.months[1].cashCents, 50000);
  for (const paycheck of plan.paychecks) {
    assert.equal(paycheck.payCents, paycheck.spendingCents + paycheck.momCents + paycheck.debtCents + paycheck.cashCents + paycheck.investCents);
    assert.equal(paycheck.investCents, 0);
  }
  for (const day of plan.days) {
    assert.equal(day.investmentContributionsCents, 0);
    assert.equal(day.investmentsCents, 50000);
    assert.equal(day.cashCents, 12345 + day.cashContributionsCents);
    assert.equal(day.progressCents, plan.opening.debtCents - day.debtCents + day.momPaidCents + day.cashContributionsCents);
  }
});

test('extra debt payments use the same remainder in cash and investment modes without spending starting cash', () => {
  const configuration = { ...input, months: 1, frequency: 12 as const, payCents: 300000, startingCashCents: 500000, extraDebtCents: 100000 };
  const cash = simulatePlanner({ ...configuration, surplusDestination: 'cash' });
  const invested = simulatePlanner({ ...configuration, surplusDestination: 'investments' });
  assert.equal(cash.paychecks[0].debtCents, 150000);
  assert.equal(cash.paychecks[0].extraDebtCents, 50000);
  assert.equal(cash.paychecks[0].cashCents, 0);
  assert.equal(cash.days.at(-1)!.cashCents, 500000);
  assert.equal(cash.days.at(-1)!.investmentContributionsCents, 0);
  assert.equal(cash.totalInterestCents, invested.totalInterestCents);
  assert.deepEqual(cash.paychecks[0].debtPayments, invested.paychecks[0].debtPayments);
  const smallDebt = simulatePlanner({ ...configuration, surplusDestination: 'cash', debts: [{ ...input.debts[0], balanceCents: 110000, aprPercent: 0 }] });
  assert.equal(smallDebt.paychecks[0].debtCents, 110000);
  assert.equal(smallDebt.paychecks[0].cashCents, 40000);
  assert.equal(smallDebt.days.at(-1)!.cashCents, 540000);
});

test('cash mode still models growth on existing investments without adding new investment contributions', () => {
  const plan = simulatePlanner({ ...input, startMonth: '2027-01', months: 12, paydayAnchor: '2027-01-01', surplusDestination: 'cash', startingInvestmentsCents: 100000, annualReturnPercent: 12 });
  assert.equal(plan.days.at(-1)!.investmentsCents, 112000);
  assert.equal(plan.days.at(-1)!.investmentContributionsCents, 0);
  assert.equal(plan.days.at(-1)!.investmentGrowthCents, 12000);
  assert.ok(plan.days.at(-1)!.cashContributionsCents > 0);
  const overdraft = simulatePlanner({ ...input, months: 1, surplusDestination: 'cash', startingCashCents: -10000 });
  assert.equal(overdraft.months[0].end.cashCents, 190000);
  for (const startingCashCents of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => simulatePlanner({ ...input, startingCashCents }), /Starting cash/);
  assert.throws(() => simulatePlanner({ ...input, surplusDestination: 'other' as PlannerInput['surplusDestination'] }), /cash or investments/);
});
