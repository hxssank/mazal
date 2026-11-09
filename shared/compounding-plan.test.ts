import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from './types.ts';
import type { DailyPlan } from './engine.ts';
import { buildCompoundingPlan, compoundContributions } from './compounding-plan.ts';

const asOf = '2026-06-01';
test('compounding shows the part-time budget ahead of the change and switches its monthly rate on both dates', () => {
  const s = state();
  Object.assign(s.roadmap!, { monthlyEssentialsCents: 180000, transitionDate: '2027-01-01',
    temporaryWorkSchedule: { weeklyHours: 20, fullTimeWeeklyHours: 40, returnDate: '2027-05-01', payPeriodEndLagDays: 5 } });
  const before = buildCompoundingPlan(s, 'personal', plan(), asOf);
  assert.equal(before.monthlyIncomeCents, 260000);
  assert.equal(before.partTimeMonthlyIncomeCents, 130000);
  assert.equal(before.partTimeHeadroomCents, -50000);
  assert.equal(before.stage, 'cashflow');
  assert.equal(before.investmentNowCents, 0);
  assert.equal(buildCompoundingPlan(s, 'personal', null, '2027-04-30').monthlyIncomeCents, 130000);
  assert.equal(buildCompoundingPlan(s, 'personal', null, '2027-05-01').monthlyIncomeCents, 260000);
});
function state(): AppState {
  return {
    workspace: 'demo', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }],
    accounts: [{ id: 'cash', entityId: 'personal', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 250000, reconciledAt: asOf }],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
    roadmap: { currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: 60000, monthlyDebtMinimumsCents: null, transitionDate: asOf, transitionMonths: 1, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, payAmountCents: 120000, payEveryDays: 14, paydayAnchor: asOf, planningCashReserveCents: 10000 },
  };
}
function plan(): DailyPlan {
  return { asOf, endDate: '2026-08-29', horizonDays: 90, status: 'ready', cashCents: 250000, protectedCents: 10000, cashAfterKnownCents: 290000,
    knownIncomeCents: 600000, knownOutflowCents: 550000, livingCostsCents: 180000, lowestCashCents: 200000, lowestCashDate: asOf, firstShortfallDate: null,
    nextPayday: { date: '2026-06-15', amountCents: 120000 }, todayPayday: null,
    beforePayday: { endDate: '2026-06-14', knownIncomeCents: 0, knownOutflowCents: 50000, cashAfterKnownCents: 190000 }, events: [], days: [], missingInputs: [], warnings: [] };
}

test('monthly budget counts installments once and leaves ordinary bills inside the living cap', () => {
  const s = state();
  s.assetPurchases = [{ id: 'car', entityId: 'personal', name: 'Car', payee: 'Family', targetCents: 1000000, monthlyCents: 40000, paidCents: 100000, paidAsOf: asOf, notes: '' }];
  s.obligations = [
    { id: 'car-payment', entityId: 'personal', name: 'Car payment', amountCents: 40000, dueDate: asOf, direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: '', assetPurchaseId: 'car' },
    { id: 'subscription', entityId: 'personal', name: 'Subscription', amountCents: 10000, dueDate: asOf, direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: '' },
  ];
  const before = structuredClone(s);
  const result = buildCompoundingPlan(s, 'personal', plan(), asOf);
  assert.equal(result.monthlyIncomeCents, 260000);
  assert.equal(result.monthlyPurchaseCents, 40000);
  assert.equal(result.monthlyHeadroomCents, 160000);
  assert.equal(result.headroomPerPayCents, 73846);
  assert.deepEqual(s, before);
});

test('positive ending cash never overrides an earlier shortfall', () => {
  const p = plan(); p.lowestCashCents = -2000; p.firstShortfallDate = asOf;
  const result = buildCompoundingPlan(state(), 'personal', p, asOf);
  assert.equal(result.stage, 'cashflow');
  assert.equal(result.forecastGapCents, 12000);
  assert.equal(result.investmentNowCents, 0);
});

test('unknown debt rates remain blockers even for deferred or excluded debt', () => {
  const s = state();
  s.accounts.push({ id: 'loan', entityId: 'personal', name: 'Student loan', type: 'debt', currency: 'CAD', balanceCents: 1000000, reconciledAt: null, excludeFromNetWorth: true,
    debtTerms: { aprPercent: null, rateConfirmed: false, minimumPaymentCents: null, notes: '', repaymentStatus: 'in_study' } });
  const result = buildCompoundingPlan(s, 'personal', plan(), asOf);
  assert.equal(result.stage, 'review');
  assert.equal(result.knownDebtMinimumsCents, 0);
  assert.equal(result.investmentNowCents, null);
  assert.ok(result.blockers.some(item => item.includes('interest terms')));
  assert.ok(result.blockers.some(item => item.includes('payments resume')));
});

test('confirmed expensive debt gets priority after starter cash and required payments', () => {
  const s = state();
  s.accounts.push({ id: 'card', entityId: 'personal', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 400000, reconciledAt: asOf,
    debtTerms: { aprPercent: 19, rateConfirmed: true, minimumPaymentCents: 12000, notes: '', repaymentKind: 'revolving' } });
  const result = buildCompoundingPlan(s, 'personal', plan(), asOf);
  assert.equal(result.stage, 'debt'); assert.equal(result.debtPriority?.id, 'card');
  assert.equal(result.knownDebtMinimumsCents, 12000); assert.equal(result.investmentNowCents, 0);
});

test('deferring required payments does not remove confirmed accruing interest from priority', () => {
  const s = state();
  s.accounts.push({ id: 'study', entityId: 'personal', name: 'Study loan', type: 'debt', currency: 'CAD', balanceCents: 500000, reconciledAt: asOf,
    debtTerms: { aprPercent: 18, rateConfirmed: true, minimumPaymentCents: null, notes: '', repaymentStatus: 'in_study', repaymentStartDate: '2027-06-01', interestStatus: 'accruing' } });
  const result = buildCompoundingPlan(s, 'personal', plan(), asOf);
  assert.equal(result.stage, 'debt'); assert.equal(result.debtPriority?.id, 'study');
  assert.equal(result.knownDebtMinimumsCents, 0); assert.equal(result.investmentNowCents, 0);
});

test('a missing, partial, old or short cash forecast cannot authorize investing', () => {
  for (const p of [null, { ...plan(), status: 'partial' as const }, { ...plan(), asOf: '2026-05-31' }, { ...plan(), horizonDays: 30 }]) {
    const result = buildCompoundingPlan(state(), 'personal', p, asOf);
    assert.equal(result.stage, 'review'); assert.equal(result.investmentNowCents, null);
  }
});

test('a reserve is a cash target, never an additional expense or cash balance', () => {
  const s = state(); s.accounts[0].balanceCents = 50000;
  const result = buildCompoundingPlan(s, 'personal', plan(), asOf);
  assert.equal(result.stage, 'reserve'); assert.equal(result.reserveGapCents, 50000);
  assert.equal(result.monthlyHeadroomCents, 200000); assert.equal(result.investmentNowCents, 0);
});

test('cash committed before payday cannot satisfy the starter reserve', () => {
  const s = state(); s.accounts[0].balanceCents = 120000;
  s.accounts.push({ id: 'card', entityId: 'personal', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 400000, reconciledAt: asOf,
    debtTerms: { aprPercent: 19, rateConfirmed: true, minimumPaymentCents: 12000, notes: '', repaymentKind: 'revolving' } });
  const p = plan(); p.cashCents = 120000; p.lowestCashCents = 70000; p.protectedCents = 0;
  const result = buildCompoundingPlan(s, 'personal', p, asOf);
  assert.equal(result.stage, 'reserve'); assert.equal(result.reserveGapCents, 30000);
});

test('lump sums are not repeated as monthly debt minimums and completed purchases drop out', () => {
  const s = state();
  s.accounts.push({ id: 'family', entityId: 'personal', name: 'Family loan', type: 'debt', currency: 'CAD', balanceCents: 100000, reconciledAt: asOf,
    debtTerms: { aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 100000, notes: '', repaymentKind: 'one_off', paymentDueDate: '2026-07-01' } });
  s.assetPurchases = [{ id: 'paid', entityId: 'personal', name: 'Paid purchase', payee: '', targetCents: 100000, monthlyCents: 20000, paidCents: 100000, paidAsOf: asOf, notes: '' }];
  const result = buildCompoundingPlan(s, 'personal', plan(), asOf);
  assert.equal(result.monthlyPurchaseCents, 0); assert.equal(result.knownDebtMinimumsCents, 0);
});

test('future illustrations use effective annual rates and month-end deposits', () => {
  assert.equal(compoundContributions(10000, 1, 0), 120000);
  const rate = Math.pow(1.06, 1 / 12) - 1;
  let independent = 0;
  for (let month = 0; month < 360; month++) independent = independent * (1 + rate) + 100000;
  assert.equal(compoundContributions(100000, 30, 6), Math.round(independent));
  assert.throws(() => compoundContributions(-1, 10, 6));
  assert.throws(() => compoundContributions(10000, 0, 6));
  assert.throws(() => compoundContributions(10000, 30, Infinity));
});
