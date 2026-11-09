import assert from 'node:assert/strict';
import { test } from 'node:test';
import { debtInterestParts, effectiveDebtApr, validateDebtTermsModel } from './debt-model.ts';
import { debtPaymentStatus, debtPaymentSummary } from './debt-status.ts';
import { interestPriority } from './loan-guidance.ts';
import { accountStrategyData } from './account-strategy.ts';
import { simulatePlanner, type PlannerInput } from './planner.ts';
import { calculatePayoff } from './roadmap.ts';
import { plannerDebtProjection, plannerDefaults } from './planner-draft.ts';
import type { Account, AppState } from './types.ts';

const loan: Account = { id: 'loan', name: 'Student loan', entityId: 'me', type: 'debt', currency: 'CAD', balanceCents: 1000000, reconciledAt: null, debtTerms: { aprPercent: 6, rateConfirmed: true, minimumPaymentCents: 10000, notes: '' } };
const input: PlannerInput = { startMonth: '2026-10', months: 1, payCents: 100000, frequency: 26, paydayAnchor: '2026-10-15', monthlyMomCents: 0, momRemainingCents: 0, monthlyDebtCents: 10000, monthlySpendingCents: 0, debts: [{ id: 'loan', name: 'Card', balanceCents: 100000, aprPercent: 0, minimumCents: 10000, minimumDueDate: '2026-10-01' }], startingCashCents: 0, startingInvestmentsCents: 0, surplusDestination: 'cash', annualReturnPercent: 0, extraDebtCents: 0, strategy: 'avalanche', selectedDebtId: null };

test('payments after a dated deadline remain late even when the full month is funded', () => {
  const plan = simulatePlanner(input);
  assert.equal(plan.paychecks.reduce((sum, pay) => sum + pay.debtCents, 0), 10000);
  assert.equal(plan.totalMinimumShortfallCents, 10000);
  assert.match(plan.warnings.join(' '), /due 2026-10-01.*not funded/);
  assert.equal(plan.days.find(day => day.date === '2026-10-01')!.debts[0].paymentCents, 0);
});

test('the earlier paycheck can cover a deadline without increasing the monthly debt budget', () => {
  const plan = simulatePlanner({ ...input, debts: [{ ...input.debts[0], minimumDueDate: '2026-10-20' }] });
  assert.deepEqual(plan.paychecks.map(pay => pay.debtCents), [10000, 0]);
  assert.equal(plan.totalMinimumShortfallCents, 0);
  for (const pay of plan.paychecks) assert.equal(pay.payCents, pay.debtCents + pay.cashCents + pay.investCents + pay.spendingCents + pay.momCents);
});

test('one-off dated obligations do not repeat in later months and pre-plan deadlines stay visible', () => {
  const plan = simulatePlanner({ ...input, months: 2, monthlyDebtCents: 0, debts: [{ ...input.debts[0], repaymentKind: 'one_off', minimumDueDate: '2026-09-30' }] });
  assert.equal(plan.months[0].minimumShortfallCents, 10000);
  assert.equal(plan.months[1].minimumShortfallCents, 0);
  assert.match(plan.warnings.join(' '), /2026-09-30/);
  const saved = { ...loan, type: 'payable' as const, debtTerms: { ...loan.debtTerms!, paymentDueDate: '2026-09-30' } };
  const projected = plannerDebtProjection([saved], { loan: { balance: '10000', apr: '6', minimum: '100', included: true } });
  assert.equal(projected.debts[0].repaymentKind, 'one_off');
  assert.equal(projected.debts[0].minimumDueDate, '2026-09-30');
});

test('interest-only contracts use the recorded first obligation then changing interest targets', () => {
  const plan = simulatePlanner({ ...input, months: 2, paydayAnchor: '2026-10-01', monthlyDebtCents: 5000, debts: [{ ...input.debts[0], balanceCents: 1000000, aprPercent: 12, minimumCents: 5000, minimumDueDate: '2026-10-15', repaymentKind: 'interest_only' }] });
  assert.equal(plan.months[0].minimumShortfallCents, 0);
  assert.ok(plan.months[1].minimumShortfallCents > 4900);
  const only = calculatePayoff({ balanceCents: 1000000, aprPercent: 12, monthlyPaymentCents: 10000, repaymentKind: 'interest_only' });
  assert.equal(only.status, 'interest_only');
  assert.equal(only.months, null);
  const extra = calculatePayoff({ balanceCents: 1000000, aprPercent: 12, monthlyPaymentCents: 10000, extraPaymentCents: 50000, repaymentKind: 'interest_only' });
  assert.equal(extra.months, 20);
  assert.equal(extra.totalInterestCents, 105000);
  assert.equal(extra.schedule[1].paymentCents, 59500);
  const overdue = simulatePlanner({ ...input, startMonth: '2026-11', paydayAnchor: '2026-11-15', monthlyDebtCents: 0, debts: [{ ...input.debts[0], balanceCents: 1000000, aprPercent: 6, minimumCents: 8336, minimumDueDate: '2026-10-01', repaymentKind: 'interest_only' }] });
  assert.equal(overdue.totalMinimumShortfallCents, 8336);
  assert.match(overdue.warnings.join(' '), /83.36.*due 2026-10-01/);
});

test('component unknowns and mismatched balances block projections without inventing federal rates', () => {
  const account = structuredClone(loan);
  account.debtTerms!.components = [{ id: 'federal', balanceCents: 800000, aprPercent: null, rateConfirmed: false, interestStatus: 'unknown' }, { id: 'ontario', balanceCents: 200000, aprPercent: 6, rateConfirmed: true, interestStatus: 'accruing' }];
  assert.equal(effectiveDebtApr(account), null);
  account.debtTerms!.components[0].interestStatus = 'interest_free';
  assert.equal(effectiveDebtApr(account, true), 1.2);
  const parts = debtInterestParts(account)!;
  const plan = simulatePlanner({ ...input, debts: [{ ...input.debts[0], balanceCents: account.balanceCents, aprPercent: 1.2, components: parts }] });
  assert.ok(plan.totalInterestCents > 950 && plan.totalInterestCents < 1050);
  assert.deepEqual(parts, [{ balanceCents: 800000, aprPercent: 0 }, { balanceCents: 200000, aprPercent: 6 }]);
  account.balanceCents -= 100;
  assert.equal(effectiveDebtApr(account), null);
  assert.throws(() => plannerDebtProjection([account], { loan: { balance: String(account.balanceCents / 100), apr: '6', minimum: '100', included: true } }), /component balances/);
});

test('study deferral expires only from recorded dates and ranking shares interest status rules', () => {
  const account = structuredClone(loan);
  account.debtTerms = { ...account.debtTerms!, repaymentStatus: 'in_study', repaymentStatusSource: 'owner', studyEndDate: '2026-12-31' };
  assert.equal(debtPaymentStatus(account, '2026-12-31'), 'in_study');
  assert.equal(debtPaymentStatus(account, '2027-01-01'), 'needs_confirmation');
  assert.equal(debtPaymentSummary([account], '2027-01-01').unknownPayments, 1);
  account.debtTerms.repaymentStartDate = '2027-07-01';
  assert.equal(debtPaymentStatus(account, '2027-06-30'), 'in_study');
  assert.equal(debtPaymentStatus(account, '2027-07-01'), 'repaying');
  const state = { entities: [{ id: 'me', kind: 'personal' }], accounts: [account] } as AppState;
  assert.deepEqual(interestPriority([account]), accountStrategyData(state, 'all', '2027-07-01').rankedDebts);
  assert.equal(interestPriority([account]).length, 0);
  account.debtTerms.interestStatus = 'accruing';
  assert.deepEqual(accountStrategyData(state, 'all', '2027-06-30').rankedDebts, []);
  assert.deepEqual(interestPriority([account]), accountStrategyData(state, 'all', '2027-07-01').rankedDebts);
  assert.equal(interestPriority([account]).length, 1);
  assert.equal(plannerDefaults(state, 'me', '2027-07-01').debts.loan.included, true);
  const plan = simulatePlanner({ ...input, startMonth: '2027-06', months: 2, paydayAnchor: '2027-06-01', monthlyDebtCents: 0, debts: [{ ...input.debts[0], minimumDueDate: null, paymentsDeferred: true, repaymentStartDate: '2027-07-01' }] });
  assert.equal(plan.months[0].minimumShortfallCents, 0);
  assert.equal(plan.months[1].minimumShortfallCents, 10000);
});

test('repayment starts required monthly payments without inventing a payment deadline', () => {
  const resumed = simulatePlanner({ ...input, startMonth: '2027-01', paydayAnchor: '2027-01-15', debts: [{ ...input.debts[0], minimumDueDate: null, repaymentKind: 'fixed', paymentsDeferred: true, repaymentStartDate: '2027-01-01' }] });
  assert.equal(resumed.totalMinimumShortfallCents, 0);
  assert.match(resumed.warnings.join(' '), /due date is unknown.*does not confirm on-time payment/);
  assert.doesNotMatch(resumed.warnings.join(' '), /due 2027-01-01.*not funded/);
  const unfunded = simulatePlanner({ ...input, startMonth: '2027-01', paydayAnchor: '2027-01-15', monthlyDebtCents: 0, debts: [{ ...input.debts[0], minimumDueDate: null, repaymentKind: 'fixed', paymentsDeferred: true, repaymentStartDate: '2027-01-01' }] });
  assert.equal(unfunded.totalMinimumShortfallCents, 10000);
  const knownDeadline = simulatePlanner({ ...input, startMonth: '2027-01', paydayAnchor: '2027-01-15', debts: [{ ...input.debts[0], minimumDueDate: '2027-01-10', repaymentKind: 'fixed', paymentsDeferred: true, repaymentStartDate: '2027-01-01' }] });
  assert.equal(knownDeadline.totalMinimumShortfallCents, 10000);
  assert.match(knownDeadline.warnings.join(' '), /due 2027-01-10.*not funded/);
  const future = simulatePlanner({ ...input, startMonth: '2027-01', paydayAnchor: '2027-01-15', monthlyDebtCents: 0, debts: [{ ...input.debts[0], minimumDueDate: '2027-03-15', repaymentKind: 'fixed' }] });
  assert.equal(future.totalMinimumShortfallCents, 0);
});

test('a pre-deferral deadline cannot become a missed payment before repayment resumes', () => {
  const plan = simulatePlanner({
    ...input, months: 2, paydayAnchor: '2026-10-15', monthlyDebtCents: 10000,
    debts: [{ ...input.debts[0], minimumDueDate: '2026-10-01', repaymentKind: 'fixed', paymentsDeferred: true, repaymentStartDate: '2026-10-15' }],
  });
  assert.equal(plan.totalMinimumShortfallCents, 0);
  assert.match(plan.warnings.join(' '), /recorded due date 2026-10-01 is before repayment resumes 2026-10-15/);
  assert.match(plan.warnings.join(' '), /payment due date is unknown/);
  assert.doesNotMatch(plan.warnings.join(' '), /due 2026-10-01.*not funded|due 2026-11-01.*not funded/);
  const unfunded = simulatePlanner({
    ...input, monthlyDebtCents: 0,
    debts: [{ ...input.debts[0], minimumDueDate: '2026-10-01', repaymentKind: 'fixed', paymentsDeferred: true, repaymentStartDate: '2026-10-15' }],
  });
  assert.equal(unfunded.totalMinimumShortfallCents, 10000);
});

test('crossing an explicit study end makes later requirements unknown, not zero', () => {
  const plan = simulatePlanner({ ...input, startMonth: '2027-01', months: 2, paydayAnchor: '2027-01-15', monthlyDebtCents: 0, debts: [{ ...input.debts[0], minimumCents: 0, minimumDueDate: null, paymentsDeferred: true, studyEndDate: '2027-01-15' }] });
  assert.equal(plan.monthsWithUnknownMinimums, 2);
  assert.deepEqual(plan.months.map(month => month.unknownMinimumCount), [1, 1]);
  assert.match(plan.warnings.join(' '), /review after 2027-01-15.*unknown/);
  const endsOnLastDay = simulatePlanner({ ...input, startMonth: '2027-01', months: 2, paydayAnchor: '2027-01-15', monthlyDebtCents: 0, debts: [{ ...input.debts[0], minimumCents: 0, minimumDueDate: null, paymentsDeferred: true, studyEndDate: '2027-01-31' }] });
  assert.deepEqual(endsOnLastDay.months.map(month => month.unknownMinimumCount), [0, 1]);
});

test('model validation preserves blanks and rejects invalid schedules and components', () => {
  assert.deepEqual(validateDebtTermsModel({}), {});
  assert.deepEqual(validateDebtTermsModel({ studyEndDate: null, repaymentStartDate: null, components: [] }), { studyEndDate: null, repaymentStartDate: null, components: [] });
  for (const raw of [{ repaymentKind: 'guess' }, { interestStatus: 'maybe' }, { studyEndDate: '2026-02-30' }, { studyEndDate: '2027-01-01', repaymentStartDate: '2026-01-01' }, { components: [{ id: 'federal', balanceCents: -1, aprPercent: null, rateConfirmed: false, interestStatus: 'unknown' }] }]) assert.throws(() => validateDebtTermsModel(raw));
});
