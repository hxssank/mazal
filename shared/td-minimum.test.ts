import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account } from './types.ts';
import { tdPlanningMinimumEstimate, tdRegularMinimumEstimate } from './td-minimum.ts';

const card = (): Account => ({ id: 'td', entityId: 'personal', name: 'TD Low Rate Visa sample', type: 'debt', currency: 'CAD', balanceCents: 600000, reconciledAt: null, debtTerms: { aprPercent: 12.9, rateConfirmed: true, minimumPaymentCents: null, statementDate: '2026-08-10', notes: '' } });

test('TD regular estimate uses the saved balance and APR without creating confirmed terms', () => {
  const account = card();
  const before = structuredClone(account);
  assert.deepEqual(tdRegularMinimumEstimate(account), { amountCents: 7450, interestCents: 6450, balanceCents: 600000, aprPercent: 12.9 });
  assert.deepEqual(account, before);
  account.balanceCents = 100000;
  account.debtTerms!.aprPercent = 12;
  assert.equal(tdRegularMinimumEstimate(account)?.amountCents, 2000);
});

test('TD estimate is restricted to the known card product and valid regular repayment inputs', () => {
  for (const name of ['TD Visa', 'TD Cash Back Visa', 'CIBC Low Rate Visa', 'TD Low Rate line of credit']) assert.equal(tdRegularMinimumEstimate({ ...card(), name }), null);
  for (const balanceCents of [0, -1, 1.5, NaN, Infinity]) assert.equal(tdRegularMinimumEstimate({ ...card(), balanceCents }), null);
  for (const aprPercent of [null, -1, NaN, Infinity, 1001]) assert.equal(tdRegularMinimumEstimate({ ...card(), debtTerms: { ...card().debtTerms!, aprPercent } }), null);
  assert.equal(tdRegularMinimumEstimate({ ...card(), type: 'cash' }), null);
  assert.equal(tdRegularMinimumEstimate({ ...card(), debtTerms: { ...card().debtTerms!, repaymentStatus: 'in_study' } }), null);
  assert.equal(tdRegularMinimumEstimate({ ...card(), debtTerms: { ...card().debtTerms!, repaymentKind: 'one_off' } }), null);
});

test('small balances are capped and explicit interest-free treatment is respected', () => {
  assert.equal(tdRegularMinimumEstimate({ ...card(), balanceCents: 501 })?.amountCents, 501);
  assert.equal(tdRegularMinimumEstimate({ ...card(), debtTerms: { ...card().debtTerms!, interestStatus: 'interest_free' } })?.amountCents, 1000);
  assert.equal(tdRegularMinimumEstimate({ ...card(), debtTerms: { ...card().debtTerms!, interestStatus: 'unknown' } }), null);
});

test('confirmed current and explicit zero minimums take priority; expired statements permit an estimate', () => {
  const account = card();
  account.debtTerms!.minimumPaymentCents = 8000;
  account.debtTerms!.paymentDueDate = '2026-09-04';
  assert.equal(tdPlanningMinimumEstimate(account, '2026-09-04'), null);
  assert.equal(tdPlanningMinimumEstimate(account, '2026-09-05')?.amountCents, 7450);
  account.debtTerms!.minimumPaymentCents = 0;
  account.debtTerms!.paymentDueDate = null;
  assert.equal(tdPlanningMinimumEstimate(account, '2026-09-05'), null);
  account.debtTerms!.minimumPaymentCents = null;
  assert.equal(tdPlanningMinimumEstimate(account, '2026-09-05')?.amountCents, 7450);
});
