import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExpenseMonthlySummary } from './expense-monthly-summary.ts';
import type { Account, AppState, Obligation, Transaction } from './types.ts';

function state(): AppState {
  return {
    workspace: 'live', revision: 1,
    entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 5000 }],
    accounts: [account('bank'), account('shop-bank', { entityId: 'shop' })],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}
function account(id: string, patch: Partial<Account> = {}): Account {
  return { id, entityId: 'me', name: id, type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null, ...patch };
}
function bill(id: string, patch: Partial<Obligation> = {}): Obligation {
  return { id, entityId: 'me', name: id, amountCents: 2000, dueDate: '2026-10-20', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'bank', category: 'Subscriptions', subscription: true, ...patch };
}
function expense(id: string, patch: Partial<Transaction> = {}): Transaction {
  return { id, accountId: 'bank', toAccountId: null, date: '2026-10-06', description: id, kind: 'expense', amountCents: 3400, category: 'Personal', source: 'Statement.pdf', createdAt: '2026-10-15T12:00:00Z', ...patch };
}
const summarize = (data: AppState, ownerId = 'me', month = '2026-10') => buildExpenseMonthlySummary(data, ownerId, month, '2026-10-15');

test('observed GoodLife and ChatGPT charges keep their recorded prices without inventing renewal dates or cadence', () => {
  const data = state();
  data.transactions = [
    expense('gym-sep', { description: 'GOODLIFE CLUBS MSP', date: '2026-09-22' }),
    expense('gym-oct', { description: 'GOODLIFE CLUBS MSP' }),
    expense('chatgpt', { description: 'PAYPAL *OPENAI *CHATGPT S 4029357733', date: '2026-09-06', amountCents: 15368 }),
    expense('future', { description: 'GOODLIFE CLUBS MSP', date: '2026-10-20', amountCents: 5000 }),
  ];
  const before = structuredClone(data);
  const result = summarize(data);
  assert.equal(result.recordedBillsCents, 3400);
  assert.equal(result.scheduledMonthlyCents, 0);
  assert.equal(result.unscheduledCount, 2);
  assert.deepEqual(result.currentBills.map(row => [row.name, row.amountCents, row.dueDate, row.recurrence, row.status]), [
    ['ChatGPT', 15368, null, null, 'needs_schedule'], ['GoodLife', 3400, null, null, 'needs_schedule'],
  ]);
  assert.equal(result.currentBills.find(row => row.name === 'ChatGPT')?.lastPayment?.date, '2026-09-06');
  assert.deepEqual(data, before);
});

test('saved schedules show monthly equivalents while actual linked payments and refunds count once', () => {
  const data = state();
  data.obligations = [bill('gym', { name: 'GoodLife', amountCents: 3400, recurrence: 'biweekly' }), bill('app', { name: 'ChatGPT' })];
  data.transactions = [
    expense('gym', { description: 'GOODLIFE CLUBS MSP', plannedPayment: { obligationId: 'gym', dueDate: '2026-10-06' } }),
    expense('app', { description: 'App bill', amountCents: 2100, source: 'Planned payment app' }),
    expense('refund', { description: 'Provider refund', amountCents: -500, refundOf: 'app' }),
  ];
  const result = summarize(data);
  assert.equal(result.currentBills.length, 2);
  assert.equal(result.recordedBillsCents, 5000);
  assert.equal(result.scheduledMonthlyCents, 9367);
  assert.equal(result.currentBills.find(row => row.sourceId === 'app')?.recordedMonthCents, 1600);
  assert.deepEqual(result.currentBills.find(row => row.sourceId === 'app')?.transactionIds, ['app', 'refund']);
  assert.equal(result.currentBills.find(row => row.sourceId === 'gym')?.status, 'scheduled');
});

test('restored paid recurring bills keep their next occurrence and monthly cost without reviving completed one-time bills', () => {
  const data = state();
  data.obligations = [
    bill('rent', { status: 'paid', subscription: false, dueDate: '2026-09-30', recurrenceDay: 31 }),
    bill('gym', { status: 'paid', subscription: false, dueDate: '2026-09-30', recurrence: 'biweekly', amountCents: 3400 }),
    bill('completed', { status: 'paid', subscription: false, recurrence: 'once' }),
    bill('cancelled', { status: 'cancelled' }),
  ];
  data.transactions = [expense('paid-rent', { date: '2026-09-30', amountCents: 2000, plannedPayment: { obligationId: 'rent', dueDate: '2026-09-30' } })];
  const before = structuredClone(data);
  const result = summarize(data, 'me', '2026-09');
  assert.deepEqual(result.currentBills.map(row => [row.sourceId, row.dueDate, row.status]), [
    ['gym', '2026-10-28', 'scheduled'], ['rent', '2026-10-31', 'scheduled'],
  ]);
  assert.equal(result.scheduledMonthlyCents, 9367);
  assert.equal(result.recordedBillsCents, 2000);
  assert.deepEqual(data, before);
});

test('paid recurring anchors beyond the current schedule still show their next saved recurrence', () => {
  const data = state();
  data.obligations = [bill('later', { status: 'paid', subscription: false, dueDate: '2027-03-31', recurrenceDay: 31 })];
  const result = summarize(data);
  assert.equal(result.currentBills[0]?.dueDate, '2027-04-30');
  assert.equal(result.scheduledMonthlyCents, 2000);
});

test('Affirm is a saved debt payment and never adds its balance, imported movements or payments to expenses', () => {
  const data = state();
  data.accounts.push(account('affirm', { name: 'Affirm', type: 'debt', balanceCents: 119118, debtTerms: { repaymentKind: 'fixed', interestStatus: 'unknown', aprPercent: null, rateConfirmed: false, minimumPaymentCents: 9162, paymentDueDate: '2026-10-24', notes: '' } }));
  data.transactions = [expense('affirm-import', { kind: 'adjustment', description: 'AFFIRM CANADA _V', amountCents: 9162 }), expense('affirm-payment', { kind: 'debt_payment', toAccountId: 'affirm', amountCents: 9162 })];
  const result = summarize(data);
  assert.equal(result.recordedBillsCents, 0);
  assert.equal(result.scheduledMonthlyCents, 0);
  assert.equal(result.currentBills.length, 1);
  assert.deepEqual([result.currentBills[0].name, result.currentBills[0].amountCents, result.currentBills[0].dueDate, result.currentBills[0].recurrence], ['Affirm', 9162, '2026-10-24', null]);
  assert.equal(result.currentBills[0].recordedMonthCents, 0);
});

test('projected loan installments do not replace the current partially paid minimum', () => {
  const data = state();
  data.accounts.push(account('loan', { type: 'debt', debtTerms: { repaymentKind: 'fixed', aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 2000, statementDate: '2026-09-30', paymentDueDate: '2026-10-20', notes: '' } }));
  data.transactions = [expense('payment', { kind: 'debt_payment', toAccountId: 'loan', amountCents: 500 })];
  const before = structuredClone(data);
  const result = summarize(data);
  assert.deepEqual(result.currentBills.map(row => [row.sourceId, row.amountCents, row.dueDate]), [['loan', 1500, '2026-10-20']]);
  assert.equal(result.recordedBillsCents, 0);
  assert.deepEqual(data, before);
});

test('current bills stay current when reviewing a historical month, and cancelled services stay out', () => {
  const data = state();
  data.obligations = [bill('phone'), bill('gym', { name: 'GoodLife', status: 'cancelled' }), bill('car', { assetPurchaseId: 'car' }), bill('once', { recurrence: 'once' }), bill('income', { direction: 'in' })];
  data.transactions = [expense('old-gym', { description: 'GOODLIFE CLUBS MSP', date: '2026-09-22' })];
  const result = summarize(data, 'me', '2026-09');
  assert.equal(result.recordedBillsCents, 3400);
  assert.equal(result.currentBills.length, 1);
  assert.equal(result.currentBills[0].name, 'phone');
  assert.equal(result.currentBills[0].dueDate, '2026-10-20');
  assert.equal(result.scheduledMonthlyCents, 2000);
});

test('reversed observations do not suggest an active bill and cross-owner links cannot move spending', () => {
  const data = state();
  data.obligations = [bill('personal-app')];
  data.transactions = [
    expense('gym', { description: 'GOODLIFE CLUBS MSP' }), expense('reversal', { description: 'Correction', amountCents: -3400, reversalOf: 'gym' }),
    expense('shop-app', { accountId: 'shop-bank', description: 'CHATGPT', amountCents: 3001, plannedPayment: { obligationId: 'personal-app', dueDate: '2026-10-06' } }),
  ];
  const personal = summarize(data);
  assert.equal(personal.recordedBillsCents, 0);
  assert.equal(personal.currentBills.length, 1);
  assert.equal(personal.currentBills[0].recordedMonthCents, 0);
  const all = summarize(data, 'all');
  assert.equal(all.recordedBillsCents, 1501);
  assert.equal(all.currentBills.find(row => row.entityId === 'shop')?.amountCents, 1501);
});

test('unknown debt amounts and dates remain unknown while closed, deferred and revolving accounts stay out', () => {
  const data = state();
  const terms: NonNullable<Account['debtTerms']> = { repaymentKind: 'fixed', aprPercent: null, rateConfirmed: false, minimumPaymentCents: null, notes: '' };
  data.accounts.push(
    account('unknown', { type: 'debt', debtTerms: terms }),
    account('closed', { type: 'debt', closedAt: '2026-10-01', debtTerms: terms }),
    account('study', { type: 'debt', debtTerms: { ...terms, repaymentStatus: 'in_study', repaymentStatusSource: 'owner', repaymentStatusAsOf: '2026-10-01' } }),
    account('card', { type: 'debt', debtTerms: { ...terms, repaymentKind: 'revolving' } }),
  );
  const result = summarize(data);
  assert.equal(result.currentBills.length, 1);
  assert.deepEqual([result.currentBills[0].amountCents, result.currentBills[0].dueDate, result.currentBills[0].status], [null, null, 'needs_date']);
});

test('loans resuming within the payment schedule appear in current bills without inventing deferred payments', () => {
  const data = state();
  const terms: NonNullable<Account['debtTerms']> = { repaymentKind: 'fixed', aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 2000, repaymentStatus: 'in_study', repaymentStartDate: '2026-10-16', paymentDueDate: '2026-10-20', notes: '' };
  data.accounts.push(
    account('resuming', { type: 'debt', debtTerms: terms }),
    account('boundary', { type: 'debt', debtTerms: { ...terms, repaymentStartDate: '2027-01-13', paymentDueDate: '2027-01-13' } }),
    account('later', { type: 'debt', debtTerms: { ...terms, repaymentStartDate: '2027-01-14', paymentDueDate: '2027-01-14' } }),
    account('unknown-date', { type: 'debt', debtTerms: { ...terms, paymentDueDate: '2026-10-10' } }),
    account('unknown-amount', { type: 'debt', debtTerms: { ...terms, minimumPaymentCents: null } }),
  );
  const original = structuredClone(data);
  const result = summarize(data);
  assert.deepEqual(result.currentBills.map(row => [row.sourceId, row.amountCents, row.dueDate, row.status]), [
    ['resuming', 2000, '2026-10-20', 'scheduled'],
    ['unknown-amount', null, '2026-10-20', 'scheduled'],
    ['boundary', 2000, '2027-01-13', 'scheduled'],
    ['unknown-date', 2000, null, 'needs_date'],
  ]);
  assert.equal(result.unscheduledCount, 1);
  assert.deepEqual(data, original);
});

test('summary rejects invalid calendar dates', () => {
  assert.throws(() => buildExpenseMonthlySummary(state(), 'me', '2026-13', '2026-10-15'));
  assert.throws(() => buildExpenseMonthlySummary(state(), 'me', '2026-10', '2026-02-30'));
});

test('old merchant charges remain in their historical month without suggesting a current bill', () => {
  const data = state();
  data.transactions = [expense('old-chatgpt', { description: 'CHATGPT', date: '2025-09-06', amountCents: 2000 })];
  const result = summarize(data, 'me', '2025-09');
  assert.equal(result.recordedBillsCents, 2000);
  assert.deepEqual(result.currentBills, []);
  assert.equal(result.unscheduledCount, 0);
});

test('active and cancelled copies of a merchant do not create a second setup suggestion', () => {
  const data = state();
  data.obligations = [bill('active', { name: 'GoodLife' }), bill('cancelled', { name: 'GoodLife', status: 'cancelled' })];
  data.transactions = [expense('gym', { description: 'GOODLIFE CLUBS MSP' })];
  const result = summarize(data);
  assert.equal(result.currentBills.length, 1);
  assert.equal(result.currentBills[0].sourceId, 'active');
  assert.equal(result.currentBills[0].recordedMonthCents, 3400);
  data.obligations[0].status = 'cancelled';
  const cancelled = summarize(data);
  assert.equal(cancelled.currentBills.length, 0);
  assert.equal(cancelled.recordedBillsCents, 3400);
});

test('satisfied debt minimums, zero requirements and cleared balances do not appear as unpaid commitments', () => {
  const data = state();
  const terms: NonNullable<Account['debtTerms']> = { repaymentKind: 'fixed', aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 2000, statementDate: '2026-09-30', paymentDueDate: '2026-10-10', notes: '' };
  data.accounts.push(
    account('paid', { type: 'debt', debtTerms: terms }),
    account('zero', { type: 'debt', debtTerms: { ...terms, minimumPaymentCents: 0 } }),
    account('cleared', { type: 'debt', balanceCents: 0, debtTerms: terms }),
  );
  data.transactions = [expense('payment', { kind: 'debt_payment', toAccountId: 'paid', amountCents: 2000 })];
  assert.deepEqual(summarize(data).currentBills, []);
});

test('repayment dates before the saved repayment start require confirmation', () => {
  const data = state();
  data.accounts.push(account('loan', { type: 'debt', debtTerms: { repaymentKind: 'fixed', aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 2000, paymentDueDate: '2026-09-01', repaymentStatus: 'in_study', repaymentStartDate: '2026-10-01', notes: '' } }));
  const row = summarize(data).currentBills[0];
  assert.equal(row.status, 'needs_date');
  assert.equal(row.dueDate, null);
  assert.equal(row.amountCents, 2000);
});
