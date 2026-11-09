import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPastReview, reviewStatements } from './past-review.ts';
import type { AppState, StatementImport, StatementRow } from './types.ts';

function row(id: string, amountCents: number, kind: StatementRow['kind'] = 'purchase', description = 'Merchant'): StatementRow {
  return { id, transactionDate: '2026-07-10', postingDate: '2026-07-13', description, amountCents, kind, category: 'Uncategorized', sourcePage: 1 };
}

function statement(patch: Partial<StatementImport> = {}): StatementImport {
  return { id: 'august', accountId: 'card', sourceFile: 'Statement.pdf', sha256: 'a'.repeat(64), periodStart: '2026-07-09', periodEnd: '2026-08-10', openingBalanceCents: 563051, closingBalanceCents: 555511,
    rows: [row('purchases', 264075), row('refund', -3108, 'refund'), row('interest', 6493, 'interest', 'Interest'), row('payment', -275000, 'payment', 'Payment')], ...patch };
}

function state(): AppState {
  const source = statement();
  return {
    workspace: 'live', revision: 0, entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 5000 }],
    accounts: [{ id: 'card', entityId: 'me', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 600000, reconciledAt: '2026-09-24' }, { id: 'shop-card', entityId: 'shop', name: 'Shop card', type: 'debt', currency: 'CAD', balanceCents: 0, reconciledAt: null }],
    transactions: source.rows.map(item => ({ id: `tx-${item.id}`, date: item.transactionDate, postingDate: item.postingDate, description: item.description, kind: item.kind === 'payment' ? 'adjustment' : 'expense', amountCents: item.kind === 'payment' ? -item.amountCents : item.amountCents, accountId: source.accountId, toAccountId: null, category: item.category, source: source.sourceFile, createdAt: '2026-09-24T12:00:00.000Z', statementId: source.id, statementRowId: item.id })),
    statements: [source], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

test('statement review reconciles payments, purchases, refunds and interest in cents', () => {
  const data = state();
  const review = buildPastReview(data, 'august')!;
  assert.equal(review.purchaseCents, 264075);
  assert.equal(review.refundCents, 3108);
  assert.equal(review.interestCents, 6493);
  assert.equal(review.paymentCents, 275000);
  assert.equal(review.netNewChargesCents, 267460);
  assert.equal(review.balanceReductionCents, 7540);
  assert.equal(review.calculatedClosingBalanceCents, 555511);
  assert.equal(review.reconciled, true);
  assert.equal(review.periodDays, 33);
  assert.equal(review.linkedRowCount, 4);
  assert.equal(review.merchants.length, 1);
  assert.equal(review.merchants[0].netCents, 260967);
  assert.equal(data.accounts[0].balanceCents, 600000);
});

test('a legacy card payment remains linked after matching its bank statement entry', () => {
  const data = state();
  data.accounts.push({ id: 'bank', entityId: 'me', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: '2026-09-24' });
  const payment = data.transactions.find(transaction => transaction.statementRowId === 'payment')!;
  Object.assign(payment, { kind: 'debt_payment', accountId: 'bank', toAccountId: 'card', importSources: [{ importId: 'bank-july', rowId: 'bank-payment' }] });
  const before = structuredClone(data);
  const review = buildPastReview(data, 'august')!;
  assert.equal(review.linkedRowCount, review.rowCount);
  assert.equal(review.paymentCents, 275000);
  assert.equal(review.calculatedClosingBalanceCents, 555511);
  assert.equal(review.reconciled, true);
  assert.deepEqual(data, before);
  payment.toAccountId = 'shop-card';
  assert.equal(buildPastReview(data, 'august')!.linkedRowCount, review.rowCount - 1);
  payment.toAccountId = 'card';
  payment.statementId = 'another-statement';
  assert.equal(buildPastReview(data, 'august')!.linkedRowCount, review.rowCount - 1);
});

test('each statement uses its own rows regardless of manual activity or an earlier transaction date', () => {
  const data = state();
  data.statements![0].rows[0].transactionDate = '2026-07-07';
  data.transactions.push({ ...data.transactions[0], id: 'manual', statementId: undefined, statementRowId: undefined, amountCents: 100000 });
  const review = buildPastReview(data, 'august')!;
  assert.equal(review.purchaseCents, 264075);
  assert.equal(review.merchants[0].rows[0].transactionDate, '2026-07-07');
  assert.equal(review.rowCount, 4);
  assert.equal(review.periodDays, 33);
});

test('exact descriptions stay separate and repeated source charges remain separate rows', () => {
  const data = state();
  data.statements = [statement({ rows: [row('one', 700, 'purchase', 'AUTO SPA'), row('two', 700, 'purchase', 'AUTO SPA'), row('elsewhere', 1000, 'purchase', 'AUTO SPA NORTH'), row('refund', -200, 'refund', 'AUTO SPA')], openingBalanceCents: 0, closingBalanceCents: 2200 })];
  const review = buildPastReview(data, 'august')!;
  assert.equal(review.merchants.length, 2);
  const group = review.merchants[0];
  assert.equal(group.description, 'AUTO SPA');
  assert.equal(group.purchaseCents, 1400);
  assert.equal(group.purchaseCount, 2);
  assert.equal(group.refundCents, 200);
  assert.equal(group.rows.length, 3);
  assert.deepEqual(group.repeatedCharges, [{ transactionDate: '2026-07-10', postingDate: '2026-07-13', amountCents: 700, count: 2 }]);
});

test('matching amounts on different transaction or posting dates are not flagged as same-day matching charges', () => {
  const data = state();
  data.statements = [statement({ rows: [row('one', 700), { ...row('two', 700), transactionDate: '2026-07-11' }, { ...row('three', 700), postingDate: '2026-07-14' }], openingBalanceCents: 0, closingBalanceCents: 2100 })];
  const group = buildPastReview(data, 'august')!.merchants[0];
  assert.equal(group.purchaseCount, 3);
  assert.deepEqual(group.repeatedCharges, []);
});

test('review reflects corrected linked categories and leaves the source state unchanged', () => {
  const data = state();
  data.transactions[0].category = 'Food';
  const before = structuredClone(data);
  assert.equal(buildPastReview(data, 'august')!.merchants[0].rows.find(item => item.id === 'purchases')!.category, 'Food');
  assert.deepEqual(data, before);
  data.transactions = [];
  const unlinked = buildPastReview(data, 'august')!;
  assert.equal(unlinked.linkedRowCount, 0);
  assert.equal(unlinked.purchaseCents, 264075);
});

test('statement selection sorts newest first and keeps owners separate without weighting source amounts', () => {
  const data = state();
  data.statements!.push(statement({ id: 'july', periodStart: '2026-06-09', periodEnd: '2026-07-08' }), statement({ id: 'shop-august', accountId: 'shop-card' }));
  assert.deepEqual(reviewStatements(data, 'me').map(item => item.id), ['august', 'july']);
  assert.deepEqual(reviewStatements(data, 'shop').map(item => item.id), ['shop-august']);
  assert.equal(reviewStatements(data).length, 3);
  assert.equal(buildPastReview(data, 'shop-august')!.purchaseCents, 264075);
  assert.deepEqual(reviewStatements(data, 'missing'), []);
});

test('balance increases, empty statements and missing history remain explicit', () => {
  const data = state();
  data.statements = [statement({ openingBalanceCents: 10000, closingBalanceCents: 12000, rows: [row('purchase', 2000)] })];
  assert.equal(buildPastReview(data, 'august')!.balanceReductionCents, -2000);
  data.statements = [statement({ openingBalanceCents: 10000, closingBalanceCents: 10000, rows: [] })];
  const empty = buildPastReview(data, 'august')!;
  assert.equal(empty.balanceReductionCents, 0);
  assert.equal(empty.paymentCents, 0);
  assert.deepEqual(empty.merchants, []);
  assert.equal(buildPastReview(data, 'missing'), null);
  data.statements = [];
  assert.deepEqual(reviewStatements(data), []);
});

test('unreconciled source totals and unsafe cents cannot become a confirmed result', () => {
  const data = state();
  data.statements![0].closingBalanceCents++;
  assert.equal(buildPastReview(data, 'august')!.reconciled, false);
  data.statements![0].rows = [row('one', Number.MAX_SAFE_INTEGER), row('two', 1)];
  assert.throws(() => buildPastReview(data, 'august'), /supported amount/);
});
