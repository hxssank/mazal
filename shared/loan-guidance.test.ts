import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annualInterestSavedCents, interestPriority, loanGuideFor } from './loan-guidance.ts';
import type { Account } from './types.ts';

function debt(id: string, rate: number | null, balanceCents = 200000): Account {
  return { id, entityId: 'personal', name: id, type: 'debt', currency: 'CAD', balanceCents, reconciledAt: null, debtTerms: { aprPercent: rate, rateConfirmed: rate !== null, minimumPaymentCents: null, notes: '' } };
}
test('extra payment priority excludes in-study, unconfirmed, cleared and zero-rate debts', () => {
  const visa = debt('Visa', 12.9), loc = debt('LOC', 5.45), study = debt('OSAP', 8), unconfirmed = debt('Estimate', 20);
  study.debtTerms!.repaymentStatus = 'in_study';
  unconfirmed.debtTerms!.rateConfirmed = false;
  const input = [loc, debt('Unknown', null), study, debt('Family', 0), debt('Cleared', 25, 0), visa, unconfirmed];
  assert.deepEqual(interestPriority(input).map(account => account.id), ['Visa', 'LOC']);
  assert.equal(input[0], loc);
  assert.equal(annualInterestSavedCents(visa), 12900);
  assert.equal(annualInterestSavedCents(loc), 5450);
  assert.equal(annualInterestSavedCents(study), null);
  assert.equal(annualInterestSavedCents(unconfirmed), null);
  assert.equal(annualInterestSavedCents(debt('Small', 12.9, 50000)), 6450);
});
test('public guidance attaches only to the identified loan product', () => {
  assert.equal(loanGuideFor(debt('TD Low Rate Visa · 1234', 12.9))?.product, 'TD Low Rate Visa');
  assert.equal(loanGuideFor(debt('CIBC Professional Student LOC · 1234', 5.45))?.product, 'CIBC Professional Student line of credit');
  assert.equal(loanGuideFor(debt('OSAP student loan', null))?.product, 'OSAP government student loan');
  assert.equal(loanGuideFor(debt('TD mortgage', 5)), null);
  assert.equal(loanGuideFor(debt('CIBC credit card', 20)), null);
});
