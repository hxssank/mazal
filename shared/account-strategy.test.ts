import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountStrategyData, annualInterestPerThousand } from './account-strategy.ts';
import type { Account, AppState } from './types.ts';

const debt = (id: string, name: string, aprPercent: number | null, patch: Partial<Account> = {}): Account => ({ id, name, entityId: 'me', type: 'debt', currency: 'CAD', balanceCents: 100000, reconciledAt: null, debtTerms: { aprPercent, rateConfirmed: aprPercent !== null, minimumPaymentCents: null, notes: '' }, ...patch });
function state(): AppState {
  return { workspace: 'live', revision: 0, entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 10000 }], accounts: [
    { id: 'cash', name: 'TD Student Chequing', entityId: 'me', type: 'cash', currency: 'CAD', balanceCents: 3505, reconciledAt: null },
    { id: 'shop-cash', name: 'Shop cash', entityId: 'shop', type: 'cash', currency: 'CAD', balanceCents: 1000000, reconciledAt: null },
    debt('td', 'TD Low Rate Visa', 12.9), debt('cibc', 'CIBC Student LOC', 5.45), debt('osap', 'OSAP', null), debt('family', 'Family', 0),
  ], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}

test('annual interest comparison uses a constant $1000 principal and each recorded rate', () => {
  assert.equal(annualInterestPerThousand(12.9), 12900);
  assert.equal(annualInterestPerThousand(5.45), 5450);
  assert.equal(annualInterestPerThousand(0), 0);
  for (const value of [NaN, Infinity, -1, 1001]) assert.throws(() => annualInterestPerThousand(value), /annual interest rate/);
});

test('personal strategy excludes business cash and ranks only confirmed positive APRs', () => {
  const data = state();
  const before = structuredClone(data);
  const strategy = accountStrategyData(data);
  assert.equal(strategy.cashCents, 3505);
  assert.deepEqual(strategy.rankedDebts.map(account => account.id), ['td', 'cibc']);
  assert.deepEqual(strategy.debtsMissingRates.map(account => account.id), ['osap']);
  assert.equal(strategy.tdMinimumKnown, false);
  assert.equal(strategy.livingCostsKnown, false);
  assert.deepEqual(data, before);
  assert.equal(accountStrategyData(data, 'shop').cashCents, 1000000);
});

test('unknown cash stays unknown and debt minimum requires both amount and due date', () => {
  const data = state();
  assert.equal(accountStrategyData(data, 'missing').cashCents, null);
  data.accounts.find(account => account.id === 'td')!.debtTerms!.minimumPaymentCents = 7493;
  assert.equal(accountStrategyData(data).tdMinimumKnown, false);
  data.accounts.find(account => account.id === 'td')!.debtTerms!.paymentDueDate = '2026-10-04';
  assert.equal(accountStrategyData(data, 'all', '2026-09-24').tdMinimumKnown, true);
  assert.equal(accountStrategyData(data, 'all', '2026-10-05').tdMinimumKnown, false);
});

test('deferred loans stay out of active rate nags and priority without assuming zero interest', () => {
  const data = state();
  const osap = data.accounts.find(account => account.id === 'osap')!;
  osap.debtTerms = { ...osap.debtTerms!, repaymentStatus: 'in_study', repaymentStatusSource: 'owner', repaymentStartDate: '2027-01-01' };
  const before = structuredClone(data);
  assert.deepEqual(accountStrategyData(data, 'all', '2026-09-24').debtsMissingRates, []);
  assert.deepEqual(data, before);
  osap.debtTerms = { ...osap.debtTerms, aprPercent: 18, rateConfirmed: true, interestStatus: 'accruing' };
  assert.deepEqual(accountStrategyData(data, 'all', '2026-09-24').rankedDebts.map(account => account.id), ['td', 'cibc']);
  assert.equal(accountStrategyData(data, 'all', '2027-01-01').rankedDebts[0].id, 'osap');
  osap.debtTerms = { ...osap.debtTerms, aprPercent: null, rateConfirmed: false, repaymentStartDate: null, studyEndDate: '2026-09-30' };
  assert.deepEqual(accountStrategyData(data, 'all', '2026-10-01').debtsMissingRates.map(account => account.id), ['osap']);
});
