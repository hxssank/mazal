import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDebtOverview } from './debt-overview.ts';
import type { Account, DebtTerms } from './types.ts';

function debt(id: string, balanceCents: number, terms: Partial<DebtTerms> = {}): Account {
  return {
    id, entityId: 'me', name: id, type: 'debt', currency: 'CAD', balanceCents, reconciledAt: null,
    debtTerms: { aprPercent: 12, rateConfirmed: true, minimumPaymentCents: 2500, notes: '', ...terms },
  };
}

test('overview totals positive debt separately from credits and excludes other account types', () => {
  const loan = debt('loan', 200000, { aprPercent: 6, minimumPaymentCents: 6000, paymentDueDate: '2026-09-15' });
  const card = debt('card', 50000, { aprPercent: 24, minimumPaymentCents: 2000 });
  const credit = debt('credit', -1500, { paymentDueDate: '2026-09-15' });
  const accounts = [loan, card, credit, { ...debt('cash', 900000), type: 'cash' as const }];
  const before = structuredClone(accounts);
  const overview = buildDebtOverview(accounts, '2026-09-25');
  assert.equal(overview.debtCents, 250000);
  assert.equal(overview.creditCents, 1500);
  assert.equal(overview.monthlyInterestCents, 2000);
  assert.equal(overview.unknownInterestCount, 0);
  assert.equal(overview.repayingCents, 250000);
  assert.equal(overview.deferredCents, 0);
  assert.equal(overview.highestRateAccountId, 'card');
  assert.equal(overview.largestBalanceAccountId, 'loan');
  assert.deepEqual(overview.rows.map(row => row.accountId), ['loan', 'card', 'credit']);
  assert.deepEqual(overview.rows[0], { account: loan, accountId: 'loan', balanceCents: 200000, confirmedApr: 6, monthlyInterestCents: 1000, paymentStatus: 'repaying', requiredPaymentCents: 6000, dueDate: '2026-09-15' });
  assert.deepEqual(overview.rows[2], { account: credit, accountId: 'credit', balanceCents: 0, confirmedApr: 0, monthlyInterestCents: 0, paymentStatus: 'paid_off', requiredPaymentCents: 0, dueDate: null });
  assert.deepEqual(accounts, before);
});

test('unknown and unconfirmed rates stay unknown while explicit interest-free debt is zero', () => {
  const accounts = [
    debt('known', 100000),
    debt('unconfirmed', 100000, { aprPercent: 24, rateConfirmed: false, minimumPaymentCents: null }),
    debt('unknown', 100000, { interestStatus: 'unknown' }),
    debt('free', 100000, { aprPercent: null, rateConfirmed: false, interestStatus: 'interest_free', minimumPaymentCents: 0 }),
  ];
  const overview = buildDebtOverview(accounts, '2026-09-25');
  assert.equal(overview.monthlyInterestCents, 1000);
  assert.equal(overview.unknownInterestCount, 2);
  assert.deepEqual(overview.rows.map(row => [row.confirmedApr, row.monthlyInterestCents]), [[12, 1000], [null, null], [null, null], [0, 0]]);
  assert.equal(overview.rows[1].requiredPaymentCents, null);
  assert.equal(overview.rows[3].requiredPaymentCents, 0);
  assert.equal(overview.highestRateAccountId, 'known');
});

test('component interest rounds each part and uses the weighted confirmed rate', () => {
  const rounded = debt('rounded', 318, {
    components: [
      { id: 'federal', balanceCents: 159, aprPercent: 12, rateConfirmed: true, interestStatus: 'accruing' },
      { id: 'ontario', balanceCents: 159, aprPercent: 12, rateConfirmed: true, interestStatus: 'accruing' },
    ],
  });
  const mixed = debt('mixed', 100000, {
    aprPercent: 99,
    components: [
      { id: 'federal', balanceCents: 60000, aprPercent: null, rateConfirmed: false, interestStatus: 'interest_free' },
      { id: 'ontario', balanceCents: 40000, aprPercent: 6, rateConfirmed: true, interestStatus: 'accruing' },
    ],
  });
  const overview = buildDebtOverview([rounded, mixed], '2026-09-25');
  assert.equal(overview.rows[0].monthlyInterestCents, 4);
  assert.equal(overview.rows[0].confirmedApr, 12);
  assert.equal(overview.rows[1].monthlyInterestCents, 200);
  assert.equal(overview.rows[1].confirmedApr, 2.4);
  assert.equal(overview.monthlyInterestCents, 204);
});

test('incomplete or inconsistent components prevent an estimate even with an account APR', () => {
  const base = debt('split', 100000, {
    components: [
      { id: 'federal', balanceCents: 60000, aprPercent: 0, rateConfirmed: true, interestStatus: 'interest_free' },
      { id: 'ontario', balanceCents: 30000, aprPercent: 6, rateConfirmed: true, interestStatus: 'accruing' },
    ],
  });
  const missingBalance = structuredClone(base);
  missingBalance.id = 'missing-balance';
  missingBalance.debtTerms!.components![1].balanceCents = null;
  const unconfirmed = structuredClone(base);
  unconfirmed.id = 'unconfirmed-component';
  unconfirmed.debtTerms!.components![1].balanceCents = 40000;
  unconfirmed.debtTerms!.components![1].rateConfirmed = false;
  const overview = buildDebtOverview([base, missingBalance, unconfirmed], '2026-09-25');
  assert.ok(overview.rows.every(row => row.confirmedApr === null && row.monthlyInterestCents === null));
  assert.equal(overview.unknownInterestCount, 3);
  assert.equal(overview.monthlyInterestCents, 0);
  assert.equal(overview.highestRateAccountId, null);
});

test('deferred payments still accrue confirmed interest and become repayable on the saved start date', () => {
  const deferred = debt('student', 1000000, { repaymentStatus: 'in_study', interestStatus: 'accruing', aprPercent: 30, repaymentStartDate: '2026-10-01', paymentDueDate: '2026-01-01' });
  const card = debt('card', 100000, { aprPercent: 24 });
  const before = buildDebtOverview([deferred, card], '2026-09-25');
  assert.equal(before.deferredCents, 1000000);
  assert.equal(before.repayingCents, 100000);
  assert.equal(before.monthlyInterestCents, 27000);
  assert.equal(before.rows[0].requiredPaymentCents, 0);
  assert.equal(before.rows[0].dueDate, '2026-01-01');
  assert.equal(before.rows[0].paymentStatus, 'in_study');
  assert.equal(before.highestRateAccountId, 'card');
  assert.equal(before.largestBalanceAccountId, 'student');
  const after = buildDebtOverview([deferred, card], '2026-10-01');
  assert.equal(after.deferredCents, 0);
  assert.equal(after.repayingCents, 1100000);
  assert.equal(after.rows[0].requiredPaymentCents, 2500);
  assert.equal(after.highestRateAccountId, 'student');
});

test('expired study status remains unconfirmed without assuming a required payment', () => {
  const overview = buildDebtOverview([debt('student', 100000, { repaymentStatus: 'in_study', studyEndDate: '2026-08-31' })], '2026-09-25');
  assert.equal(overview.rows[0].paymentStatus, 'needs_confirmation');
  assert.equal(overview.rows[0].requiredPaymentCents, null);
  assert.equal(overview.rows[0].monthlyInterestCents, null);
  assert.equal(overview.deferredCents, 0);
  assert.equal(overview.repayingCents, 0);
  assert.equal(overview.debtCents, 100000);
});

test('paid and credit accounts without terms have no estimated interest or payment obligation', () => {
  const paid = debt('paid', 0);
  const credit = debt('credit', -10000);
  delete paid.debtTerms;
  delete credit.debtTerms;
  const overview = buildDebtOverview([paid, credit], '2026-09-25');
  assert.equal(overview.debtCents, 0);
  assert.equal(overview.creditCents, 10000);
  assert.equal(overview.monthlyInterestCents, 0);
  assert.equal(overview.unknownInterestCount, 0);
  assert.equal(overview.highestRateAccountId, null);
  assert.equal(overview.largestBalanceAccountId, null);
  assert.ok(overview.rows.every(row => row.monthlyInterestCents === 0 && row.requiredPaymentCents === 0 && row.dueDate === null && row.paymentStatus === 'paid_off'));
});

test('scoped inputs retain full account balances and payable accounts', () => {
  const personal = debt('personal', 700000);
  const business = { ...debt('business', 200000), entityId: 'shop', type: 'payable' as const };
  const accounts = [personal, business];
  const overview = buildDebtOverview(accounts.filter(account => account.entityId === 'shop'), '2026-09-25');
  assert.equal(overview.debtCents, 200000);
  assert.equal(overview.monthlyInterestCents, 2000);
  assert.deepEqual(overview.rows.map(row => row.accountId), ['business']);
});

test('overview rejects unsafe aggregate cents', () => {
  assert.throws(() => buildDebtOverview([debt('one', Number.MAX_SAFE_INTEGER), debt('two', 1)], '2026-09-25'), /supported amount/);
  assert.throws(() => buildDebtOverview([debt('one', -Number.MAX_SAFE_INTEGER), debt('two', -1)], '2026-09-25'), /supported amount/);
});
