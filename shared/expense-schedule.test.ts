import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExpenseSchedule, debtScheduleDetails } from './expense-schedule.ts';
import type { Account, AppState, Obligation } from './types.ts';
import { engineFixtureResult } from '../src/engine-test-fixture.ts';
import type { DailyPlan } from './engine.ts';
import { upcoming } from './analytics.ts';

function state(): AppState {
  return { workspace: 'live', revision: 0, entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 5000 }], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
function bill(id: string, patch: Partial<Obligation> = {}): Obligation {
  return { id, entityId: 'me', name: id, amountCents: 10000, dueDate: '2026-10-01', direction: 'out', recurrence: 'once', status: 'planned', accountId: 'cash', category: 'Bills', ...patch };
}
function debt(id: string, minimumPaymentCents: number | null, patch: Partial<Account> = {}): Account {
  return { id, entityId: 'me', name: id, type: 'debt', currency: 'CAD', balanceCents: 100000, reconciledAt: null, debtTerms: { aprPercent: 10, rateConfirmed: true, minimumPaymentCents, notes: '', paymentDueDate: '2026-10-01' }, ...patch };
}
function addPayday(data: AppState, patch: Partial<NonNullable<AppState['roadmap']>> = {}) {
  data.roadmap = { currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: '', transitionMonths: 0, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, payAmountCents: 150000, payEveryDays: 14, paydayAnchor: '2026-10-01', ...patch };
}

test('pay estimates follow the worked weekdays at both ends of a temporary schedule', () => {
  const data = state();
  addPayday(data, { paydayAnchor: '2026-12-24', transitionDate: '2027-01-01', temporaryWorkSchedule: {
    weeklyHours: 20, fullTimeWeeklyHours: 40, returnDate: '2027-05-01', payPeriodEndLagDays: 5,
  } });
  const paydays = (asOf: string) => buildExpenseSchedule(data, 'me', asOf, 28).upcoming.map(pay => [pay.date, pay.amountCents]);
  assert.deepEqual(paydays('2026-12-24'), [['2026-12-24', 150000], ['2027-01-07', 142500], ['2027-01-21', 75000]]);
  assert.deepEqual(paydays('2027-04-29'), [['2027-04-29', 75000], ['2027-05-13', 112500], ['2027-05-27', 150000]]);
  assert.equal(data.transactions.length, 0);
});

test('schedule keeps salary projections separate from explicit income and excludes other owners', () => {
  const data = state();
  addPayday(data);
  data.obligations = [bill('Rent'), bill('Salary', { direction: 'in', amountCents: 150000 }), bill('Shop bill', { entityId: 'shop' })];
  data.accounts = [debt('Card', 2500), debt('Shop debt', 9000, { entityId: 'shop' })];
  const before = structuredClone(data);
  const personal = buildExpenseSchedule(data, 'me', '2026-09-25', 30);
  assert.deepEqual(personal.upcoming.filter(row => row.sourceType === 'payday').map(row => row.date), ['2026-10-01', '2026-10-15']);
  assert.deepEqual(personal.totals, { paydayIncomeCents: 300000, obligationIncomeCents: 0, outgoingCents: 12500, unknownOutgoingCount: 0, unknownPaydayIncomeCount: 0, unconfirmedObligationIncomeCount: 1, alreadyIncludedIncomeCount: 0 });
  assert.ok(personal.upcoming.every(row => row.entityId === 'me'));
  assert.ok(personal.upcoming.find(row => row.sourceType === 'payday')!.isProjection);
  assert.equal(personal.upcoming.find(row => row.sourceId === 'Rent')!.isProjection, false);
  const shop = buildExpenseSchedule(data, 'shop', '2026-09-25', 30);
  assert.deepEqual(shop.upcoming.map(row => row.name), ['Shop bill', 'Shop debt']);
  assert.equal(shop.totals.paydayIncomeCents, 0);
  assert.equal(buildExpenseSchedule(data, 'all', '2026-09-25', 30).upcoming.length, personal.upcoming.length + shop.upcoming.length);
  assert.deepEqual(data, before);
});

test('monthly repeats retain month-end days without duplicate anchors or lost leap days', () => {
  const data = state();
  data.obligations = [bill('Rent', { dueDate: '2028-01-31', recurrence: 'monthly' })];
  const schedule = buildExpenseSchedule(data, 'me', '2028-01-31', 60);
  assert.deepEqual(schedule.upcoming.map(row => [row.date, row.isProjection]), [['2028-01-31', false], ['2028-02-29', true], ['2028-03-31', true]]);
  assert.equal(new Set(schedule.upcoming.map(row => row.key)).size, 3);
  data.obligations = [bill('Rent', { dueDate: '2026-02-28', recurrence: 'monthly', recurrenceDay: 31 })];
  assert.deepEqual(buildExpenseSchedule(data, 'me', '2026-02-28', 61).upcoming.map(row => row.date), ['2026-02-28', '2026-03-31', '2026-04-30']);
});

test('past rows contain only saved unpaid dates while recurring projections resume at the current window', () => {
  const data = state();
  data.obligations = [bill('Old bill', { dueDate: '2026-01-31', recurrence: 'monthly' }), bill('Old once', { dueDate: '2026-01-01' })];
  data.accounts = [debt('Old debt', 2500, { debtTerms: { aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 2500, notes: '', paymentDueDate: '2026-03-01' } })];
  const schedule = buildExpenseSchedule(data, 'me', '2026-09-22', 40);
  assert.deepEqual(schedule.past.map(row => row.date), ['2026-01-01', '2026-01-31', '2026-03-01']);
  assert.ok(schedule.past.every(row => !row.isProjection));
  assert.deepEqual(schedule.upcoming.map(row => row.date), ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01']);
  assert.equal(schedule.totals.outgoingCents, 25000);
});

test('paid recurring anchors skip their saved date, cancelled records never repeat, and biweekly cadence crosses years', () => {
  const data = state();
  data.obligations = [bill('Paid rent', { dueDate: '2026-12-31', recurrence: 'monthly', status: 'paid' }), bill('Paid once', { dueDate: '2026-12-31', status: 'paid' }), bill('Cancelled', { dueDate: '2026-12-31', recurrence: 'biweekly', status: 'cancelled' }), bill('Biweekly', { dueDate: '2026-12-24', recurrence: 'biweekly' })];
  const schedule = buildExpenseSchedule(data, 'me', '2026-12-31', 31);
  assert.deepEqual(schedule.upcoming.map(row => [row.name, row.date]), [['Biweekly', '2027-01-07'], ['Biweekly', '2027-01-21'], ['Paid rent', '2027-01-31']]);
  assert.deepEqual(schedule.past.map(row => row.name), ['Biweekly']);
  assert.ok(schedule.upcoming.every(row => row.isProjection));
});

for (const direction of ['in', 'out'] as const) for (const scenario of [
  { recurrence: 'monthly', anchor: '2026-01-31', asOf: '2026-02-01', paid: '2026-02-28', end: '2026-03-31', days: 58 },
  { recurrence: 'biweekly', anchor: '2026-09-18', asOf: '2026-10-03', paid: '2026-10-16', end: '2026-10-30', days: 27 },
] as const) {
  test(`${direction} ${scenario.recurrence} forecasts skip paid projections while retaining the arrear and unpaid end date`, t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(`${scenario.asOf}T12:00:00`).getTime() });
    const data = state();
    data.accounts = [{ id: 'cash', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: scenario.asOf }];
    data.obligations = [bill('rent', { direction, dueDate: scenario.anchor, recurrence: scenario.recurrence })];
    data.transactions = [{ id: 'paid', kind: direction === 'in' ? 'income' : 'expense', accountId: 'cash', toAccountId: null, date: scenario.asOf, description: 'Recorded payment', amountCents: 10000, category: 'Bills', source: 'Manual entry', createdAt: `${scenario.asOf}T12:00:00.000Z`, plannedPayment: { obligationId: 'rent', dueDate: scenario.paid } }];
    const before = structuredClone(data);
    const schedule = buildExpenseSchedule(data, 'me', scenario.asOf, scenario.days);
    assert.deepEqual(schedule.past.map(row => row.date), [scenario.anchor]);
    assert.deepEqual(schedule.upcoming.map(row => row.date), [scenario.end]);
    assert.deepEqual(upcoming(data, 'me', scenario.days).map(row => row.occurrenceDate), [scenario.anchor, scenario.end]);
    const plan = engineFixtureResult(data, 'me', scenario.asOf, 'daily_plan', { days: scenario.days + 1 }) as DailyPlan;
    assert.deepEqual(plan.events.filter(row => row.sourceType === 'obligation').map(row => row.date), [scenario.anchor, scenario.end]);
    assert.deepEqual(buildExpenseSchedule(data, 'me', scenario.asOf, scenario.days - 1).upcoming, []);
    data.transactions.push({ ...data.transactions[0], id: 'paid-end', plannedPayment: { obligationId: 'rent', dueDate: scenario.end } });
    assert.deepEqual(buildExpenseSchedule(data, 'me', scenario.asOf, scenario.days).upcoming, []);
    assert.deepEqual(upcoming(data, 'me', scenario.days).map(row => row.occurrenceDate), [scenario.anchor]);
    data.transactions.pop();
    assert.deepEqual(data, before);
  });
}

test('recorded anchors are omitted by exact bill ID while legacy receipts and other owners remain scheduled', () => {
  const data = state();
  data.obligations = [bill('paid', { recurrence: 'once' }), bill('legacy', { recurrence: 'once' }), bill('other-owner', { entityId: 'shop', recurrence: 'once' })];
  data.transactions = [
    { id: 'receipt', accountId: 'cash', toAccountId: null, date: '2026-10-15', description: 'Paid bill', kind: 'expense', amountCents: 10000, category: 'Bills', source: 'Manual entry', createdAt: '2026-10-15T12:00:00.000Z', plannedPayment: { obligationId: 'paid', dueDate: '2026-10-01' } },
    { id: 'legacy', accountId: 'cash', toAccountId: null, date: '2026-10-01', description: 'Old bill', kind: 'expense', amountCents: 10000, category: 'Bills', source: 'Planned payment legacy', createdAt: '2026-10-01T12:00:00.000Z' },
  ];
  assert.deepEqual(buildExpenseSchedule(data, 'me', '2026-10-01', 0).upcoming.map(row => row.sourceId), ['legacy']);
  assert.deepEqual(buildExpenseSchedule(data, 'all', '2026-10-01', 0).upcoming.map(row => row.sourceId), ['legacy', 'other-owner']);
});

test('debt due amounts preserve unknown and zero without replacing them with the balance', () => {
  const data = state();
  const deferred = debt('Deferred', 5000); deferred.debtTerms!.repaymentStatus = 'in_study';
  data.accounts = [debt('Unknown', null), debt('Zero', 0), debt('Positive', 2500), debt('Cleared', 1000, { balanceCents: 0 }), debt('Credit', 1000, { balanceCents: -3000 }), deferred];
  const schedule = buildExpenseSchedule(data, 'me', '2026-09-25', 30);
  assert.deepEqual(schedule.upcoming.map(row => [row.name, row.amountCents]), [['Positive', 2500], ['Unknown', null], ['Zero', 0]]);
  assert.equal(schedule.totals.outgoingCents, 2500);
  assert.equal(schedule.totals.unknownOutgoingCount, 1);
  assert.ok(schedule.upcoming.every(row => !row.isProjection && row.accountId === row.sourceId));
});

test('fixed loan totals include projected installments across 30, 60 and 90 days', () => {
  const data = state();
  data.accounts = [debt('Fixed loan', 10000, { debtTerms: { repaymentKind: 'fixed', aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 10000, statementDate: '2026-09-30', paymentDueDate: '2026-10-25', notes: '' } })];
  const before = structuredClone(data);
  for (const [days, expectedDates] of [[30, ['2026-10-25']], [60, ['2026-10-25', '2026-11-25']], [90, ['2026-10-25', '2026-11-25', '2026-12-25']]] as const) {
    const schedule = buildExpenseSchedule(data, 'me', '2026-10-20', days);
    const plan = engineFixtureResult(data, 'me', '2026-10-20', 'daily_plan', { days }) as DailyPlan;
    assert.deepEqual(schedule.upcoming.map(row => row.date), expectedDates);
    assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents, row.isProjection]), plan.events.filter(row => row.sourceType === 'debt').map(row => [row.date, row.amountCents, row.isProjection]));
    assert.equal(schedule.totals.outgoingCents, expectedDates.length * 10000);
    assert.equal(schedule.upcoming[0].isProjection, false);
    assert.ok(schedule.upcoming.slice(1).every(row => row.isProjection));
  }
  assert.deepEqual(data, before);
});

test('a saved zero minimum does not imply zero future payments on an outstanding recurring debt', () => {
  const data = state();
  data.accounts = [debt('Card', 0, { debtTerms: { repaymentKind: 'revolving', aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 0, statementDate: '2026-09-30', paymentDueDate: '2026-10-25', notes: '' } })];
  const before = structuredClone(data);
  const current = buildExpenseSchedule(data, 'me', '2026-10-20', 30);
  assert.deepEqual(current.upcoming.map(row => [row.date, row.amountCents]), [['2026-10-25', 0]]);
  assert.equal(current.totals.unknownOutgoingCount, 0);
  const future = buildExpenseSchedule(data, 'me', '2026-10-20', 90);
  assert.deepEqual(future.upcoming.map(row => [row.date, row.amountCents, row.isProjection]), [['2026-10-25', 0, false], ['2026-11-25', null, true], ['2026-12-25', null, true]]);
  assert.equal(future.totals.outgoingCents, 0);
  assert.equal(future.totals.unknownOutgoingCount, 2);
  const plan = engineFixtureResult(data, 'me', '2026-10-20', 'daily_plan', { days: 90 }) as DailyPlan;
  assert.deepEqual(future.upcoming.filter(row => row.isProjection).map(row => [row.date, row.amountCents]), plan.events.filter(row => row.sourceType === 'debt').map(row => [row.date, row.amountCents]));
  assert.ok(plan.missingInputs.some(row => row.field === 'debts.Card.minimum'));
  assert.deepEqual(data, before);
  data.accounts[0].debtTerms!.repaymentKind = 'one_off';
  assert.deepEqual(buildExpenseSchedule(data, 'me', '2026-10-20', 90).upcoming.map(row => row.amountCents), [0]);
  data.accounts[0].balanceCents = 0;
  assert.deepEqual(buildExpenseSchedule(data, 'me', '2026-10-20', 90).upcoming, []);
});

test('loan projections clamp month-end dates and deduct recorded payments only from the saved deadline', () => {
  const data = state();
  data.accounts = [debt('Loan', 10000, { debtTerms: { repaymentKind: 'fixed', aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 10000, statementDate: '2027-12-31', paymentDueDate: '2028-01-31', notes: '' } })];
  data.transactions = [{ id: 'paid', kind: 'debt_payment', accountId: 'cash', toAccountId: 'Loan', date: '2028-01-01', amountCents: 2500, description: 'Loan payment', category: '', source: 'Manual entry', createdAt: '2028-01-01T12:00:00Z' }];
  const schedule = buildExpenseSchedule(data, 'me', '2028-01-30', 61);
  assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents]), [['2028-01-31', 7500], ['2028-02-29', 10000], ['2028-03-31', 10000]]);
  assert.equal(schedule.totals.outgoingCents, 27500);
  data.transactions[0].amountCents = 10000;
  const paid = buildExpenseSchedule(data, 'me', '2028-01-30', 61);
  assert.deepEqual(paid.upcoming.map(row => row.amountCents), [0, 10000, 10000]);
});

test('one-off debt and payable deadlines never produce monthly repeats', () => {
  const data = state();
  const once = debt('One-off loan', 10000);
  once.debtTerms!.repaymentKind = 'one_off';
  data.accounts = [once, debt('Payable', 10000, { type: 'payable' })];
  assert.deepEqual(buildExpenseSchedule(data, 'me', '2026-09-25', 90).upcoming.map(row => [row.sourceId, row.date, row.isProjection]), [['One-off loan', '2026-10-01', false], ['Payable', '2026-10-01', false]]);
});

test('interest-only projections preserve the saved payment when it exceeds principal', () => {
  const data = state();
  data.accounts = [debt('Loan', 10000, { balanceCents: 5000, debtTerms: { repaymentKind: 'interest_only', aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 10000, statementDate: '2026-09-30', paymentDueDate: '2026-10-25', notes: '' } })];
  const schedule = buildExpenseSchedule(data, 'me', '2026-10-20', 90);
  const plan = engineFixtureResult(data, 'me', '2026-10-20', 'daily_plan', { days: 90 }) as DailyPlan;
  assert.deepEqual(schedule.upcoming.map(row => row.amountCents), [10000, 10000, 10000]);
  assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents]), plan.events.filter(row => row.sourceType === 'debt').map(row => [row.date, row.amountCents]));
});

test('missing statement dates retain the full requirement and flag unassigned recorded payments', () => {
  const data = state();
  const loan = debt('Loan', 10000);
  data.accounts = [loan];
  const payment = { id: 'paid', kind: 'debt_payment' as const, accountId: 'cash', toAccountId: 'Loan', date: '2026-09-20', amountCents: 2500, description: 'Loan payment', category: '', source: 'Manual entry', createdAt: '2026-09-20T12:00:00Z' };
  data.transactions = [payment];
  const before = structuredClone(data);
  const schedule = buildExpenseSchedule(data, 'me', '2026-09-25', 60);
  assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents, !!row.needsStatementConfirmation]), [['2026-10-01', 10000, true], ['2026-11-01', 10000, false]]);
  const plan = engineFixtureResult(data, 'me', '2026-09-25', 'daily_plan', { days: 60 }) as DailyPlan;
  assert.ok(plan.missingInputs.some(row => row.field === 'debts.Loan.statementDate'));
  assert.deepEqual(data, before);
  loan.debtTerms!.statementDate = '2026-09-01';
  const confirmed = buildExpenseSchedule(data, 'me', '2026-09-25', 60);
  assert.equal(confirmed.upcoming[0].amountCents, 7500);
  assert.ok(confirmed.upcoming.every(row => !row.needsStatementConfirmation));
  delete loan.debtTerms!.statementDate;
  data.transactions = [{ ...payment, postingDates: { Loan: '2026-09-26' } }];
  assert.ok(buildExpenseSchedule(data, 'me', '2026-09-25', 60).upcoming.every(row => !row.needsStatementConfirmation));
  data.transactions = [payment, { ...payment, id: 'reversed', amountCents: -2500, reversalOf: 'paid' }];
  assert.ok(buildExpenseSchedule(data, 'me', '2026-09-25', 60).upcoming.every(row => !row.needsStatementConfirmation));
  data.transactions = [{ ...payment, kind: 'adjustment', accountId: 'Loan', toAccountId: null, category: 'Card payment', statementId: 'statement', balanceChanges: { Loan: -2500 } }];
  assert.equal(buildExpenseSchedule(data, 'me', '2026-09-25', 60).upcoming[0].needsStatementConfirmation, true);
});

test('an ended study period keeps the saved due date visible with an unknown payment', () => {
  const data = state();
  const loan = debt('Study ended', 5000); loan.debtTerms = { ...loan.debtTerms!, repaymentStatus: 'in_study', studyEndDate: '2026-09-24' };
  data.accounts = [loan];
  const schedule = buildExpenseSchedule(data, 'me', '2026-09-25', 30);
  assert.equal(schedule.upcoming[0].amountCents, null);
  assert.equal(schedule.totals.unknownOutgoingCount, 1);
});

test('repayment starting within the schedule keeps the saved deadline and matches the cash plan', () => {
  for (const [repaymentStartDate, paymentDueDate] of [
    ['2026-10-15', '2026-10-15'],
    ['2026-10-15', '2026-10-20'],
    ['2026-10-20', '2026-10-20'],
    ['2026-10-15', '2026-10-21'],
  ]) {
    const data = state();
    const loan = debt('Study loan', 10000);
    loan.debtTerms = { ...loan.debtTerms!, repaymentStatus: 'in_study', repaymentStartDate, paymentDueDate };
    data.accounts = [loan];
    const original = structuredClone(data);
    const schedule = buildExpenseSchedule(data, 'me', '2026-10-14', 6);
    const cash = engineFixtureResult(data, 'me', '2026-10-14', 'daily_plan', { days: 7 }) as DailyPlan;
    const expected = paymentDueDate <= '2026-10-20' ? [[paymentDueDate, 10000]] : [];
    assert.equal(schedule.through, '2026-10-20');
    assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents]), expected);
    assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents]), cash.events.filter(row => row.sourceType === 'debt').map(row => [row.date, row.amountCents]));
    assert.equal(schedule.totals.outgoingCents, cash.knownOutflowCents);
    assert.deepEqual(data, original);
  }
});

test('loans deferred beyond the schedule do not create payments or missing-term notices', () => {
  for (const repaymentStartDate of [null, '2026-10-21']) {
    const data = state();
    const loan = debt('Deferred loan', 10000);
    loan.debtTerms = { ...loan.debtTerms!, repaymentStatus: 'in_study', repaymentStartDate, paymentDueDate: '2026-10-21' };
    data.accounts = [loan];
    const schedule = buildExpenseSchedule(data, 'me', '2026-10-14', 6);
    const cash = engineFixtureResult(data, 'me', '2026-10-14', 'daily_plan', { days: 7 }) as DailyPlan;
    assert.equal(debtScheduleDetails(loan, schedule.through), null);
    assert.deepEqual(schedule.upcoming, []);
    assert.deepEqual(schedule.past, []);
    assert.equal(schedule.totals.outgoingCents, 0);
    assert.ok(!cash.events.some(row => row.sourceType === 'debt'));
    assert.ok(!cash.missingInputs.some(row => row.section === 'debts'));
  }
});

test('resuming loans preserve unknown amounts and require a valid deadline after deferral', () => {
  for (const paymentDueDate of [undefined, '2026-10-14', '2026-10-20']) {
    const data = state();
    const loan = debt('Resuming loan', paymentDueDate === '2026-10-20' ? null : 10000);
    loan.debtTerms = { ...loan.debtTerms!, repaymentStatus: 'in_study', repaymentStartDate: '2026-10-15', paymentDueDate };
    data.accounts = [loan];
    const original = structuredClone(data);
    const schedule = buildExpenseSchedule(data, 'me', '2026-10-14', 6);
    const cash = engineFixtureResult(data, 'me', '2026-10-14', 'daily_plan', { days: 7 }) as DailyPlan;
    const details = debtScheduleDetails(loan, schedule.through)!;
    const needsDate = paymentDueDate !== '2026-10-20';
    assert.equal(details.dueDate, paymentDueDate ?? null);
    assert.equal(details.needsDateConfirmation, needsDate);
    assert.equal(details.minimumCents, needsDate ? 10000 : null);
    assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents]), needsDate ? [] : [['2026-10-20', null]]);
    assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents]), cash.events.filter(row => row.sourceType === 'debt').map(row => [row.date, row.amountCents]));
    assert.equal(schedule.totals.outgoingCents, 0);
    assert.equal(schedule.totals.unknownOutgoingCount, needsDate ? 0 : 1);
    assert.ok(cash.missingInputs.some(row => row.field === `debts.Resuming loan.${needsDate ? 'dueDate' : 'minimum'}`));
    assert.deepEqual(data, original);
  }
});

test('dates include today and the final day, cap projections at 90 days, and never backfill paydays', () => {
  const data = state();
  addPayday(data, { payEveryDays: 1, paydayAnchor: '2026-10-01' });
  data.obligations = [bill('Today', { dueDate: '2026-09-25' }), bill('Boundary', { dueDate: '2026-10-25' }), bill('Outside', { dueDate: '2026-10-26' })];
  const schedule = buildExpenseSchedule(data, 'me', '2026-09-25', 30);
  assert.equal(schedule.through, '2026-10-25');
  assert.ok(schedule.upcoming.some(row => row.name === 'Boundary'));
  assert.ok(!schedule.upcoming.some(row => row.name === 'Outside'));
  assert.equal(schedule.upcoming.filter(row => row.sourceType === 'payday').length, 25);
  assert.equal(schedule.past.length, 0);
  const day = buildExpenseSchedule(data, 'me', '2026-09-25', 0);
  assert.deepEqual(day.upcoming.map(row => row.name), ['Today']);
  const capped = buildExpenseSchedule(data, 'me', '2026-10-01', 365);
  assert.equal(capped.horizonDays, 90);
  assert.equal(capped.through, '2026-12-30');
  assert.equal(capped.upcoming.filter(row => row.sourceType === 'payday').length, 91);
});

test('unknown payday amounts remain unknown and explicit zero pay stays zero', () => {
  const data = state();
  addPayday(data, { payAmountCents: undefined });
  const unknown = buildExpenseSchedule(data, 'me', '2026-10-01', 14);
  assert.deepEqual(unknown.upcoming.map(row => row.amountCents), [null, null]);
  assert.equal(unknown.totals.unknownPaydayIncomeCount, 2);
  addPayday(data, { payAmountCents: 0 });
  const zero = buildExpenseSchedule(data, 'me', '2026-10-01', 14);
  assert.deepEqual(zero.upcoming.map(row => row.amountCents), [0, 0]);
  assert.equal(zero.totals.unknownPaydayIncomeCount, 0);
});

test('confirmed payday receipts are already in cash and are not projected as upcoming income again', () => {
  const data = state();
  addPayday(data);
  data.accounts = [{ id: 'cash', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 250000, reconciledAt: null }];
  data.transactions = [{ id: 'pay', kind: 'income', accountId: 'cash', toAccountId: null, date: '2026-10-01', paydayDate: '2026-10-01', amountCents: 148000, description: 'Payroll', category: 'Pay', source: 'Manual entry', createdAt: '2026-10-01T12:00:00Z' }];
  const before = structuredClone(data);
  const schedule = buildExpenseSchedule(data, 'me', '2026-10-01', 14);
  assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents]), [['2026-10-15', 150000]]);
  assert.equal(schedule.totals.paydayIncomeCents, 150000);
  assert.deepEqual(buildExpenseSchedule(data, 'me', '2026-10-01', 0).upcoming, []);
  assert.equal(buildExpenseSchedule(data, 'all', '2026-10-01', 14).totals.paydayIncomeCents, 150000);
  data.transactions[0].date = '2026-09-30';
  assert.equal(buildExpenseSchedule(data, 'me', '2026-10-01', 14).totals.paydayIncomeCents, 150000);
  data.transactions[0].date = '2026-10-01';
  assert.deepEqual(data, before);
});

test('a payday stays projected without an active explicit receipt from the personal cash account', () => {
  const data = state();
  addPayday(data);
  data.accounts = [
    { id: 'cash', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 250000, reconciledAt: null },
    { id: 'shop-cash', entityId: 'shop', name: 'Shop bank', type: 'cash', currency: 'CAD', balanceCents: 250000, reconciledAt: null },
    { id: 'receivable', entityId: 'me', name: 'Invoice', type: 'receivable', currency: 'CAD', balanceCents: 250000, reconciledAt: null },
  ];
  const receipt = { id: 'pay', kind: 'income' as const, accountId: 'cash', toAccountId: null, date: '2026-10-01', paydayDate: '2026-10-01', amountCents: 150000, description: 'Payroll', category: 'Pay', source: 'Manual entry', createdAt: '2026-10-01T12:00:00Z' };
  for (const patch of [{ paydayDate: undefined }, { paydayDate: '2026-09-17' }, { accountId: 'shop-cash' }, { accountId: 'receivable' }, { date: '2026-10-02' }, { amountCents: 0 }]) {
    data.transactions = [{ ...receipt, ...patch }];
    assert.equal(buildExpenseSchedule(data, 'me', '2026-10-01', 14).totals.paydayIncomeCents, 300000);
  }
  data.transactions = [receipt, { ...receipt, id: 'reversal', amountCents: -150000, paydayDate: undefined, reversalOf: receipt.id }];
  assert.equal(buildExpenseSchedule(data, 'me', '2026-10-01', 14).totals.paydayIncomeCents, 300000);
});

test('schedule input validation rejects impossible dates and fractional or negative periods', () => {
  for (const asOf of ['2026-02-29', '2026-04-31', '2026-2-01', 'invalid']) assert.throws(() => buildExpenseSchedule(state(), 'me', asOf), /valid schedule start/);
  for (const days of [-1, 1.5, Infinity, NaN]) assert.throws(() => buildExpenseSchedule(state(), 'me', '2026-09-25', days), /whole days/);
  assert.throws(() => buildExpenseSchedule(state(), 'me', '9999-12-31', 1), /supported date range/);
});

test('recurring records stop at the four-digit date boundary without wrapping into earlier dates', () => {
  const data = state();
  data.obligations = [bill('Monthly', { dueDate: '9999-12-31', recurrence: 'monthly' }), bill('Biweekly', { dueDate: '9999-12-31', recurrence: 'biweekly' })];
  const schedule = buildExpenseSchedule(data, 'me', '9999-12-31', 0);
  assert.deepEqual(schedule.upcoming.map(row => row.date), ['9999-12-31', '9999-12-31']);
  assert.ok(schedule.upcoming.every(row => !row.isProjection));
});

test('income flags prevent double counting while keeping each recorded income date and amount visible', () => {
  const data = state();
  addPayday(data);
  data.obligations = [
    bill('Salary copy', { direction: 'in', amountCents: 150000, additionalToPay: false }),
    bill('Unconfirmed income', { direction: 'in', amountCents: 40000, recurrence: 'biweekly' }),
    bill('Side work', { direction: 'in', amountCents: 25000, additionalToPay: true }),
    bill('Shop income', { entityId: 'shop', direction: 'in', amountCents: 90000, additionalToPay: false }),
  ];
  const before = structuredClone(data);
  const personal = buildExpenseSchedule(data, 'me', '2026-09-25', 30);
  assert.equal(personal.hasRegularPaySchedule, true);
  assert.equal(personal.totals.paydayIncomeCents, 300000);
  assert.equal(personal.totals.obligationIncomeCents, 25000);
  assert.equal(personal.totals.alreadyIncludedIncomeCount, 1);
  assert.equal(personal.totals.unconfirmedObligationIncomeCount, 2);
  assert.deepEqual(personal.upcoming.filter(row => row.sourceType === 'obligation').map(row => [row.name, row.date, row.amountCents, row.incomeTreatment]), [
    ['Salary copy', '2026-10-01', 150000, 'in_regular_pay'],
    ['Side work', '2026-10-01', 25000, 'additional'],
    ['Unconfirmed income', '2026-10-01', 40000, 'needs_confirmation'],
    ['Unconfirmed income', '2026-10-15', 40000, 'needs_confirmation'],
  ]);
  assert.equal(buildExpenseSchedule(data, 'all', '2026-09-25', 30).totals.obligationIncomeCents, 115000);
  const shop = buildExpenseSchedule(data, 'shop', '2026-09-25', 30);
  assert.equal(shop.hasRegularPaySchedule, false);
  assert.equal(shop.totals.obligationIncomeCents, 90000);
  assert.deepEqual(data, before);
});

test('without a configured regular pay schedule, known scheduled income remains usable', () => {
  const data = state();
  data.obligations = [bill('Known income', { direction: 'in', amountCents: 30000 }), bill('Old salary entry', { direction: 'in', additionalToPay: false, amountCents: 50000 })];
  for (const setup of [() => {}, () => addPayday(data, { paydayAnchor: '' }), () => addPayday(data, { payEveryDays: undefined })]) {
    setup();
    const result = buildExpenseSchedule(data, 'me', '2026-09-25', 30);
    assert.equal(result.hasRegularPaySchedule, false);
    assert.equal(result.totals.obligationIncomeCents, 80000);
    assert.equal(result.totals.unconfirmedObligationIncomeCount, 0);
    assert.ok(result.upcoming.every(row => row.incomeTreatment === 'scheduled'));
  }
});

test('pay dates after a planned income transition keep unknown amounts until current pay is confirmed', () => {
  const data = state();
  addPayday(data, { transitionDate: '2026-10-10', partTimeMonthlyIncomeCents: 100000 });
  const before = structuredClone(data);
  const partial = buildExpenseSchedule(data, 'me', '2026-09-25', 30);
  assert.deepEqual(partial.upcoming.map(row => [row.date, row.amountCents, row.incomeTreatment]), [['2026-10-01', 150000, 'scheduled'], ['2026-10-15', null, 'after_transition']]);
  assert.equal(partial.totals.paydayIncomeCents, 150000);
  assert.equal(partial.totals.unknownPaydayIncomeCount, 1);
  assert.deepEqual(data, before);
  const past = buildExpenseSchedule(data, 'me', '2026-10-10', 30);
  assert.ok(past.upcoming.every(row => row.amountCents === null));
  assert.equal(past.totals.unknownPaydayIncomeCount, 2);
  data.roadmap!.incomeTransitionPlanned = false;
  const resolved = buildExpenseSchedule(data, 'me', '2026-10-10', 30);
  assert.deepEqual(resolved.upcoming.map(row => row.date), past.upcoming.map(row => row.date));
  assert.ok(resolved.upcoming.every(row => row.amountCents === 150000));
  assert.equal(resolved.totals.paydayIncomeCents, 300000);
  assert.equal(resolved.totals.unknownPaydayIncomeCount, 0);
});

test('purchase installments share the confirmed remaining cost across bills and match the cash plan', () => {
  const data = state();
  const purchase = { id: 'car', entityId: 'me', name: 'Car', targetCents: 100000, paidCents: 98000 as number | null, paidAsOf: '2026-10-01', monthlyCents: 10000, payee: 'Family', notes: '' };
  data.assetPurchases = [purchase];
  data.obligations = [bill('Car payment', { dueDate: '2026-10-03', recurrence: 'monthly', assetPurchaseId: 'car' })];
  const schedule = buildExpenseSchedule(data, 'me', '2026-10-01', 59);
  const cash = engineFixtureResult(data, 'me', '2026-10-01', 'daily_plan', { days: 60 }) as DailyPlan;
  assert.deepEqual(schedule.upcoming.map(row => [row.date, row.amountCents]), [['2026-10-03', 2000], ['2026-11-03', 0]]);
  assert.equal(schedule.totals.outgoingCents, cash.knownOutflowCents);
  assert.deepEqual(schedule.upcoming.map(row => [row.sourceId, row.date, row.amountCents]), cash.events.filter(row => row.sourceType === 'obligation').map(row => [row.sourceId, row.date, row.amountCents]));
  purchase.paidCents = null;
  const unknown = buildExpenseSchedule(data, 'me', '2026-10-01', 59);
  assert.ok(unknown.upcoming.every(row => row.amountCents === null));
  assert.equal(unknown.totals.unknownOutgoingCount, 2);
  purchase.paidCents = 95000;
  data.obligations.unshift(bill('Earlier payment', { dueDate: '2026-09-30', amountCents: 3000, assetPurchaseId: 'car' }));
  const overdue = buildExpenseSchedule(data, 'me', '2026-10-01', 59);
  assert.equal(overdue.past[0].amountCents, 3000);
  assert.equal(overdue.upcoming[0].amountCents, 2000);
});

test('current debt payments use posting dates and reversals to agree with the cash plan', () => {
  const data = state();
  const loan = debt('Loan', 10000, { balanceCents: 90000 });
  loan.debtTerms = { ...loan.debtTerms!, statementDate: '2026-09-01', paymentDueDate: '2026-10-03' };
  data.accounts = [loan];
  const payment = { id: 'payment', accountId: 'cash', toAccountId: 'Loan', kind: 'debt_payment' as const, date: '2026-09-10', amountCents: 6000, description: 'Payment', category: 'Debt', source: '', createdAt: '' };
  data.transactions = [payment];
  const remaining = () => buildExpenseSchedule(data, 'me', '2026-10-01', 6).upcoming[0].amountCents;
  const engineRemaining = () => (engineFixtureResult(data, 'me', '2026-10-01', 'daily_plan', { days: 7 }) as DailyPlan).events.find(row => row.sourceType === 'debt')!.amountCents;
  assert.equal(remaining(), 4000);
  assert.equal(remaining(), engineRemaining());
  data.transactions.push({ ...payment, id: 'reverse', amountCents: -6000, reversalOf: payment.id });
  assert.equal(remaining(), 10000);
  assert.equal(remaining(), engineRemaining());
  data.transactions.push({ ...payment, id: 'statement-payment', accountId: 'Loan', toAccountId: null, kind: 'adjustment', date: '2026-08-31', postingDates: { Loan: '2026-09-02' }, category: 'Card payment', statementId: 'statement', amountCents: 7000, balanceChanges: { Loan: -7000 } });
  assert.equal(remaining(), 3000);
  assert.equal(remaining(), engineRemaining());
  data.transactions.push({ ...payment, id: 'future-payment', postingDate: '2026-10-02', amountCents: 3000 });
  assert.equal(remaining(), 3000);
  assert.equal(remaining(), engineRemaining());
});
