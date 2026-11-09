import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from './analytics.ts';
import { debtPaymentSummary, isInStudy, requiredDebtPaymentCents } from './debt-status.ts';
import { debtsMissingTerms } from './home.ts';
import { plannerDebtProjection, plannerDefaults } from './planner-draft.ts';
import type { Account, AppState } from './types.ts';

function state(): AppState {
  return { workspace: 'live', revision: 0, entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}

function loan(id = 'osap'): Account {
  return { id, name: id, entityId: 'me', type: 'debt', currency: 'CAD', balanceCents: 1192000, reconciledAt: null, debtTerms: { aprPercent: null, rateConfirmed: false, minimumPaymentCents: null, notes: '', repaymentStatus: 'in_study', repaymentStatusSource: 'owner', repaymentStatusAsOf: '2026-09-24', schoolReturnMonth: '2027-01' } };
}

test('reported in-study loans remain in net worth without becoming missing or overdue required payments', () => {
  const data = state();
  const osap = loan();
  const card = { ...loan('card'), balanceCents: 50000, debtTerms: { aprPercent: 12.9, rateConfirmed: true, minimumPaymentCents: null, notes: '' } };
  data.accounts = [osap, card];
  const before = structuredClone(data);
  assert.equal(isInStudy(osap), true);
  assert.equal(requiredDebtPaymentCents(osap), 0);
  assert.equal(requiredDebtPaymentCents(card), null);
  assert.deepEqual(debtPaymentSummary(data.accounts), { recordedMinimumsCents: 0, unknownPayments: 1, inStudyCount: 1 });
  assert.deepEqual(debtsMissingTerms(data, 'me', '2026-09-24').map(account => account.id), ['card']);
  assert.equal(summarize(data).netWorthCents, -1242000);
  assert.deepEqual(data, before);
  osap.debtTerms!.minimumPaymentCents = 20000;
  osap.debtTerms!.paymentDueDate = '2026-01-01';
  assert.equal(requiredDebtPaymentCents(osap), 0);
  assert.deepEqual(debtsMissingTerms(data, 'me', '2026-09-24').map(account => account.id), ['card']);
  assert.equal(osap.debtTerms!.minimumPaymentCents, 20000);
  osap.debtTerms!.repaymentStatus = 'repaying';
  assert.equal(requiredDebtPaymentCents(osap), 20000);
  assert.deepEqual(debtsMissingTerms(data, 'me', '2026-09-24').map(account => account.id), ['osap', 'card']);
});

test('in-study projection defaults keep principal counted and APR unknown, with voluntary modeling opt-in', () => {
  const data = state();
  data.accounts = [loan()];
  const defaults = plannerDefaults(data, 'me', '2026-09-24');
  assert.deepEqual(defaults.debts.osap, { balance: '11920', apr: '', minimum: '0', included: false });
  const projected = plannerDebtProjection(data.accounts, defaults.debts);
  assert.equal(projected.fixedDebtCents, 1192000);
  assert.equal(projected.debts.length, 0);
  const voluntary = { osap: { ...defaults.debts.osap, included: true } };
  assert.throws(() => plannerDebtProjection(data.accounts, voluntary), /APR/);
  voluntary.osap.apr = '3';
  assert.deepEqual(plannerDebtProjection(data.accounts, voluntary).debts[0], { id: 'osap', name: 'osap', balanceCents: 1192000, aprPercent: 3, minimumCents: 0, repaymentKind: 'fixed', paymentsDeferred: true, repaymentStartDate: null, studyEndDate: null });
  data.accounts[0].debtTerms!.aprPercent = 3;
  assert.equal(plannerDefaults(data, 'me', '2027-01-01').debts.osap.included, false);
  assert.equal(data.accounts[0].debtTerms!.minimumPaymentCents, null);
});
