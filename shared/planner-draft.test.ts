import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppState } from './types.ts';
import { plannerDefaults, plannerDebtProjection, plannerSourceKey, plannerTdMinimumEstimate, restorePlannerDraft } from './planner-draft.ts';
import { simulatePlanner, type PlannerInput } from './planner.ts';
import { summarize } from './analytics.ts';

const state: AppState = {
  workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'business', name: 'Business', kind: 'business', ownershipBps: 5000 }],
  accounts: [{ id: 'card', entityId: 'personal', name: 'Credit card', type: 'debt', currency: 'CAD', balanceCents: 600000, reconciledAt: null }],
  transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
};

test('planner leaves unsupported pay, rates, minimums, and spending blank', () => {
  const draft = plannerDefaults(state, 'personal', '2026-09-24');
  assert.equal(draft.pay, '');
  assert.equal(draft.firstPayday, '');
  assert.equal(draft.frequency, '');
  assert.equal(draft.mom, '');
  assert.equal(draft.debt, '');
  assert.equal(draft.living, '');
  assert.deepEqual(draft.debts.card, { balance: '6000', apr: '', minimum: '', included: false });
  assert.equal(draft.investmentReturn, '0');
  assert.equal(draft.surplusDestination, 'cash');
  assert.equal(draft.startMonth, '2026-10');
  assert.equal(plannerDefaults(state, 'personal', '2026-10-01').startMonth, '2026-10');
  assert.equal(plannerDefaults(state, 'personal', '2026-12-31').startMonth, '2027-01');
});

test('planner uses saved account terms and keeps personal planning out of business scope', () => {
  const withRecords: AppState = { ...state, accounts: [{ ...state.accounts[0], debtTerms: { aprPercent: 12.9, minimumPaymentCents: null, rateConfirmed: true, notes: '' } }], roadmap: {
    currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: 42000,
    monthlyDebtMinimumsCents: null, transitionDate: '', transitionMonths: 0, monthlyExtraDebtCents: 0,
    loanAccountId: 'card', loanAprPercent: 13, loanMonthlyPaymentCents: 10000,
    payAmountCents: 160025, payEveryDays: 14, paydayAnchor: '2026-09-25', monthlyFamilyPaymentCents: 30000,
  } };
  const personal = plannerDefaults(withRecords, 'personal', '2026-09-24');
  assert.equal(personal.pay, '1600.25');
  assert.equal(personal.frequency, '26');
  assert.equal(personal.firstPayday, '2026-09-25');
  assert.equal(personal.debts.card.apr, '12.9');
  assert.equal(personal.debts.card.minimum, '');
  assert.equal(personal.debts.card.included, true);
  const business = plannerDefaults(withRecords, 'business', '2026-09-24');
  assert.equal(business.pay, '');
  assert.equal(business.mom, '');
  assert.equal(business.living, '');
});

test('legacy drafts and drafts with changed source balances cannot restore old amounts', () => {
  const defaults = plannerDefaults(state, 'personal', '2026-09-24');
  const sourceKey = plannerSourceKey(state, 'personal', '2026-09-24');
  const edited = { ...defaults, pay: '999', debts: { card: { balance: '100000', apr: '13', minimum: '100', included: true } } };
  assert.equal(restorePlannerDraft(JSON.stringify({ version: 1, draft: edited }), defaults, sourceKey), defaults);
  assert.equal(restorePlannerDraft(JSON.stringify({ version: 2, sourceKey, draft: edited }), defaults, sourceKey), defaults);
  const saved = JSON.stringify({ version: 4, sourceKey, draft: edited });
  assert.equal(restorePlannerDraft(saved, defaults, sourceKey).pay, '999');
  assert.equal(restorePlannerDraft(saved, defaults, sourceKey).surplusDestination, 'cash');
  assert.equal(restorePlannerDraft(JSON.stringify({ version: 4, sourceKey, draft: { ...edited, surplusDestination: 'investments' } }), defaults, sourceKey).surplusDestination, 'investments');
  const changed = { ...state, accounts: [{ ...state.accounts[0], balanceCents: 580000 }] };
  const refreshed = plannerDefaults(changed, 'personal', '2026-09-24');
  assert.equal(restorePlannerDraft(saved, refreshed, plannerSourceKey(changed, 'personal', '2026-09-24')), refreshed);
  assert.equal(restorePlannerDraft('{', defaults, sourceKey), defaults);
});

test('saved debt priority is selected ahead of the first account when it belongs to this owner', () => {
  const configuration: AppState = { ...state, accounts: [{ ...state.accounts[0], id: 'first-loan', name: 'First loan' }, state.accounts[0]], roadmap: {
    currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null,
    monthlyDebtMinimumsCents: null, transitionDate: '', transitionMonths: 0, monthlyExtraDebtCents: 0,
    loanAccountId: 'card', loanAprPercent: null, loanMonthlyPaymentCents: null,
  } };
  assert.equal(plannerDefaults(configuration, 'personal', '2026-09-24').selectedDebtId, 'card');
  assert.equal(plannerDefaults({ ...configuration, roadmap: { ...configuration.roadmap!, loanAccountId: 'missing' } }, 'personal', '2026-09-24').selectedDebtId, 'first-loan');
  assert.equal(plannerDefaults(configuration, 'business', '2026-09-24').selectedDebtId, '');
});

test('deferred OSAP stays in total debt without blocking another repayment plan', () => {
  const configuration: AppState = { ...state, accounts: [
    { ...state.accounts[0], id: 'osap', name: 'OSAP', balanceCents: 1200000, debtTerms: { aprPercent: null, minimumPaymentCents: null, rateConfirmed: false, notes: '', repaymentStatus: 'in_study', repaymentStatusSource: 'owner' } },
    { ...state.accounts[0], debtTerms: { aprPercent: 12.9, minimumPaymentCents: 10000, rateConfirmed: true, notes: '' } },
  ] };
  const draft = plannerDefaults(configuration, 'personal', '2026-09-24');
  assert.equal(draft.selectedDebtId, 'card');
  assert.equal(draft.debts.osap.included, false);
  assert.equal(draft.debts.osap.apr, '');
  const projected = plannerDebtProjection(configuration.accounts, draft.debts);
  assert.equal(projected.fixedDebtCents, 1200000);
  assert.deepEqual(projected.debts.map(debt => debt.id), ['card']);
  assert.equal(projected.debts[0].minimumCents, 10000);
});

test('recorded card credits and paid debts stay out of repayment while preserving credit value', () => {
  const configuration: AppState = { ...state, accounts: [
    { ...state.accounts[0], id: 'credit', name: 'Card credit', balanceCents: -2500 },
    { ...state.accounts[0], id: 'paid', name: 'Paid card', balanceCents: 0 },
    { ...state.accounts[0], balanceCents: 100000, debtTerms: { aprPercent: 0, minimumPaymentCents: 10000, rateConfirmed: true, notes: '' } },
  ] };
  const before = structuredClone(configuration);
  const defaults = plannerDefaults(configuration, 'personal', '2026-09-24');
  assert.equal(defaults.selectedDebtId, 'card');
  assert.deepEqual(defaults.debts.credit, { balance: '0', apr: '', minimum: '0', included: false });
  assert.deepEqual(defaults.debts.paid, { balance: '0', apr: '', minimum: '0', included: false });
  const projected = plannerDebtProjection(configuration.accounts, {
    ...defaults.debts,
    credit: { balance: '-25', apr: '', minimum: '', included: true },
    paid: { balance: '1000', apr: '', minimum: '', included: true },
  });
  assert.deepEqual(projected.debts.map(debt => debt.id), ['card']);
  assert.equal(projected.creditBalanceCents, 2500);
  assert.equal(projected.fixedDebtCents, 0);
  assert.deepEqual(projected.fixedNames, []);
  const plan = simulatePlanner({
    startMonth: '2026-10', months: 1, payCents: 100000, frequency: 12, paydayAnchor: '2026-10-01',
    monthlyMomCents: 0, momRemainingCents: 0, monthlyDebtCents: 10000, monthlySpendingCents: 0,
    debts: projected.debts, startingCashCents: 0, startingInvestmentsCents: 0, surplusDestination: 'cash', annualReturnPercent: 0,
    extraDebtCents: 0, strategy: 'selected', selectedDebtId: defaults.selectedDebtId,
  });
  assert.equal(plan.opening.cashCents, 0);
  assert.equal(plan.opening.debtCents, 100000);
  assert.equal(plan.paychecks[0].debtCents, 10000);
  assert.deepEqual(plan.paychecks[0].debtPayments, [{ debtId: 'card', amountCents: 10000 }]);
  assert.equal(plan.opening.cashCents + plan.opening.investmentsCents - plan.opening.debtCents - projected.fixedDebtCents + projected.creditBalanceCents, summarize(configuration, 'personal').netWorthCents);
  assert.equal(summarize(configuration, 'personal').netWorthCents, -97500);
  assert.deepEqual(configuration, before);
});

test('a minimum from a past statement does not become the current payment target', () => {
  const withPastMinimum: AppState = { ...state, accounts: [{ ...state.accounts[0], debtTerms: {
    aprPercent: 12.9, rateConfirmed: true, minimumPaymentCents: 15200, notes: '', statementDate: '2026-08-10', paymentDueDate: '2026-09-01',
  } }] };
  assert.equal(plannerDefaults(withPastMinimum, 'personal', '2026-09-24').debts.card.minimum, '');
  const current = { ...withPastMinimum, accounts: [{ ...withPastMinimum.accounts[0], debtTerms: { ...withPastMinimum.accounts[0].debtTerms!, paymentDueDate: '2026-10-01' } }] };
  assert.equal(plannerDefaults(current, 'personal', '2026-09-24').debts.card.minimum, '152');
  assert.notEqual(plannerSourceKey(current, 'personal', '2026-10-01'), plannerSourceKey(current, 'personal', '2026-10-02'));
});

test('excluded debts retain their balances while missing included minimums block projections', () => {
  const accounts = [state.accounts[0], { ...state.accounts[0], id: 'student', name: 'Student loan' }, { ...state.accounts[0], id: 'brother', name: 'Brother' }];
  const drafts = {
    card: { balance: '6000', apr: '12.9', minimum: '100', included: true },
    student: { balance: '11920', apr: '', minimum: '', included: false },
    brother: { balance: '2600', apr: '', minimum: '', included: false },
  };
  const projected = plannerDebtProjection(accounts, drafts);
  assert.equal(projected.debts.length, 1);
  assert.equal(projected.debts[0].id, 'card');
  assert.equal(projected.fixedDebtCents, 1452000);
  assert.deepEqual(projected.fixedNames, ['Student loan', 'Brother']);
  assert.throws(() => plannerDebtProjection(accounts, { ...drafts, card: { ...drafts.card, minimum: '' } }), /minimum for Credit card/);
  assert.throws(() => plannerDebtProjection(accounts, { ...drafts, student: { ...drafts.student, included: true } }), /APR for Student loan/);
  assert.throws(() => plannerDebtProjection(accounts, { ...drafts, student: { ...drafts.student, balance: '' } }), /Student loan balance/);
});

test('deferred minimum drafts show the payment after deferral and honor scenario edits', () => {
  const data: AppState = { ...state, accounts: [{ ...state.accounts[0], debtTerms: {
    aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 10000, notes: '', interestStatus: 'interest_free', repaymentStatus: 'in_study', repaymentStartDate: '2027-01-01',
  } }] };
  const defaults = plannerDefaults(data, 'personal', '2026-09-24');
  assert.equal(defaults.debts.card.minimum, '100');
  assert.equal(defaults.debts.card.included, false);
  const debts = plannerDebtProjection(data.accounts, { card: { ...defaults.debts.card, included: true, minimum: '250' } }).debts;
  assert.equal(debts[0].minimumCents, 25000);
  assert.equal(data.accounts[0].debtTerms!.minimumPaymentCents, 10000);
  const input: PlannerInput = {
    startMonth: '2026-12', months: 2, payCents: 100000, frequency: 12, paydayAnchor: '2026-12-01',
    monthlyMomCents: 0, momRemainingCents: 0, monthlyDebtCents: 0, monthlySpendingCents: 0,
    debts, startingCashCents: 0, startingInvestmentsCents: 0, surplusDestination: 'cash', annualReturnPercent: 0,
    extraDebtCents: 0, strategy: 'avalanche', selectedDebtId: null,
  };
  const plan = simulatePlanner(input);
  assert.deepEqual(plan.months.map(month => month.minimumShortfallCents), [0, 25000]);
  const unknownDebts = plannerDebtProjection(data.accounts, { card: { ...defaults.debts.card, included: true, minimum: '' } }).debts;
  assert.equal(unknownDebts[0].minimumCents, null);
  assert.deepEqual(simulatePlanner({ ...input, debts: unknownDebts }).months.map(month => month.unknownMinimumCount), [0, 1]);
  const zeroDebts = plannerDebtProjection(data.accounts, { card: { ...defaults.debts.card, included: true, minimum: '0' } }).debts;
  assert.equal(simulatePlanner({ ...input, debts: zeroDebts }).totalMinimumShortfallCents, 0);
  data.accounts[0].debtTerms!.paymentDueDate = '2027-01-31';
  assert.equal(plannerDefaults(data, 'personal', '2027-01-01').debts.card.minimum, '100');
  assert.equal(plannerDefaults(data, 'personal', '2027-02-01').debts.card.minimum, '');
});

test('saved drafts expire when study deferral ends or required payments resume', () => {
  const data: AppState = { ...state, accounts: [{ ...state.accounts[0], debtTerms: {
    aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 10000, notes: '', interestStatus: 'interest_free', repaymentStatus: 'in_study', studyEndDate: '2026-12-31',
  } }] };
  const defaults = plannerDefaults(data, 'personal', '2026-12-31');
  const beforeKey = plannerSourceKey(data, 'personal', '2026-12-31');
  assert.equal(beforeKey, plannerSourceKey(data, 'personal', '2026-12-30'));
  const afterKey = plannerSourceKey(data, 'personal', '2027-01-01');
  assert.notEqual(beforeKey, afterKey);
  const updated = plannerDefaults(data, 'personal', '2027-01-01');
  assert.equal(updated.debts.card.minimum, '');
  assert.equal(restorePlannerDraft(JSON.stringify({ version: 4, sourceKey: beforeKey, draft: defaults }), updated, afterKey), updated);
  data.accounts[0].debtTerms!.repaymentStartDate = '2027-07-01';
  assert.notEqual(plannerSourceKey(data, 'personal', '2027-06-30'), plannerSourceKey(data, 'personal', '2027-07-01'));
  assert.equal(plannerDefaults(data, 'personal', '2027-07-01').debts.card.included, true);
});

test('TD missing or expired minimums use an explicit estimate without carrying an old deadline into the plan', () => {
  const data: AppState = { ...state, accounts: [{ ...state.accounts[0], name: 'TD Low Rate Visa', debtTerms: { aprPercent: 12.9, rateConfirmed: true, minimumPaymentCents: 7493, paymentDueDate: '2026-09-04', statementDate: '2026-08-10', notes: '' } }] };
  const before = structuredClone(data);
  const defaults = plannerDefaults(data, 'personal', '2026-09-24');
  assert.equal(defaults.debts.card.minimum, '74.5');
  assert.equal(defaults.debts.card.minimumMode, 'td_estimate');
  const projected = plannerDebtProjection(data.accounts, defaults.debts);
  assert.equal(projected.debts[0].minimumCents, 7450);
  assert.equal(projected.debts[0].minimumDueDate, undefined);
  const changed = { ...defaults.debts.card, balance: '1200', apr: '12' };
  assert.equal(plannerTdMinimumEstimate(data.accounts[0], changed)?.amountCents, 2200);
  assert.equal(plannerDebtProjection(data.accounts, { card: changed }).debts[0].minimumCents, 2200);
  assert.equal(plannerTdMinimumEstimate({ ...data.accounts[0], debtTerms: { ...data.accounts[0].debtTerms!, interestStatus: 'interest_free' } }, changed)?.amountCents, 2200);
  assert.deepEqual(data, before);
  data.accounts[0].debtTerms!.paymentDueDate = '2026-10-04';
  const current = plannerDefaults(data, 'personal', '2026-09-24');
  assert.equal(current.debts.card.minimum, '74.93');
  assert.equal(current.debts.card.minimumMode, 'manual');
  assert.equal(plannerDebtProjection(data.accounts, current.debts).debts[0].minimumDueDate, '2026-10-04');
});

test('old blank TD drafts gain the estimate while manual overrides and explicit blanks survive restore', () => {
  const data: AppState = { ...state, accounts: [{ ...state.accounts[0], name: 'TD Low Rate Visa', debtTerms: { aprPercent: 12.9, rateConfirmed: true, minimumPaymentCents: null, notes: '' } }] };
  const defaults = plannerDefaults(data, 'personal', '2026-09-24');
  const sourceKey = plannerSourceKey(data, 'personal', '2026-09-24');
  const restore = (minimum: string, minimumMode?: 'manual' | 'td_estimate') => restorePlannerDraft(JSON.stringify({ version: 4, sourceKey, draft: { ...defaults, pay: '2250', debts: { card: { ...defaults.debts.card, minimum, minimumMode } } } }), defaults, sourceKey);
  assert.equal(restore('').debts.card.minimumMode, 'td_estimate');
  assert.equal(restore('').pay, '2250');
  assert.equal(restore('85').debts.card.minimum, '85');
  assert.equal(restore('85').debts.card.minimumMode, undefined);
  assert.equal(restore('', 'manual').debts.card.minimum, '');
  assert.equal(restore('', 'manual').debts.card.minimumMode, 'manual');
  assert.throws(() => plannerDebtProjection(data.accounts, restore('', 'manual').debts), /monthly minimum/);
});

test('legacy fixed repayments retain monthly deadlines when passed from account records to the planner', () => {
  const account = { ...state.accounts[0], debtTerms: { aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 10000, paymentDueDate: '2026-10-01', notes: '' } };
  const projected = plannerDebtProjection([account], { card: { balance: '1000', apr: '0', minimum: '100', included: true } });
  assert.equal(projected.debts[0].repaymentKind, 'fixed');
  const plan = simulatePlanner({
    startMonth: '2026-10', months: 2, payCents: 100000, frequency: 12, paydayAnchor: '2026-10-15',
    monthlyMomCents: 0, momRemainingCents: 0, monthlyDebtCents: 10000, monthlySpendingCents: 0,
    debts: projected.debts, startingCashCents: 0, startingInvestmentsCents: 0, surplusDestination: 'cash', annualReturnPercent: 0,
    extraDebtCents: 0, strategy: 'selected', selectedDebtId: 'card',
  });
  assert.deepEqual(plan.months.map(month => month.minimumShortfallCents), [10000, 10000]);
  assert.match(plan.warnings.join(' '), /due 2026-11-01.*not funded/);
});
