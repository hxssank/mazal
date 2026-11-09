import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import type { Command, StatementSource } from '../shared/types.ts';

function setup(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-bank-correction-'));
  const path = join(directory, 'live.sqlite');
  let store = createStore(path, 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (input: Command) => store.command({ ...input, expectedRevision: store.state().revision });
  const accountId = command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 100000, openingDate: '2026-01-01', requestId: 'account' }).accounts[0].id;
  command({ type: 'save_asset_purchase', purchase: { id: 'car', entityId: 'personal', name: 'Car', payee: 'Seller', targetCents: 2000000, monthlyCents: 100000, paidCents: 400000, paidAsOf: '2026-01-01', notes: '' }, expected: null, requestId: 'purchase' });
  command({ type: 'add_transaction', kind: 'income', accountId, amountCents: 300000, date: '2026-01-10', description: 'Estimated paycheck', category: 'Payroll', paydayDate: '2026-01-10', requestId: 'income' });
  const income = store.state().transactions.find(row => row.kind === 'income')!;
  command({ type: 'add_obligation', entityId: 'personal', name: 'Received paycheck', amountCents: 300000, dueDate: '2026-01-10', direction: 'in', recurrence: 'once', accountId, category: 'Payroll', requestId: 'income-obligation' });
  const incomeObligation = store.state().obligations[0];
  command({ type: 'pay_obligation', id: incomeObligation.id, expectedDueDate: incomeObligation.dueDate, transactionId: income.id, requestId: 'link-income' });
  command({ type: 'add_obligation', entityId: 'personal', name: 'Car contribution', amountCents: 180000, dueDate: '2026-01-10', direction: 'out', recurrence: 'once', accountId, category: 'Car purchase', assetPurchaseId: 'car', requestId: 'car-obligation' });
  const carObligation = store.state().obligations.find(row => row.assetPurchaseId)!;
  command({ type: 'pay_obligation', id: carObligation.id, expectedDueDate: carObligation.dueDate, date: '2026-01-10', requestId: 'pay-car' });
  command({ type: 'reconcile', accountId, date: '2026-01-10', balanceCents: 220000, note: 'Owner estimate before bank review', requestId: 'owner-balance' });
  const rows = [
    { id: 'income', transactionDate: '2026-01-10', postingDate: '2026-01-10', description: 'BANK PAYROLL', amountCents: 337934, sourcePage: 1 },
    { id: 'car', transactionDate: '2026-01-10', postingDate: '2026-01-10', description: 'BANK TRANSFER', amountCents: -150000, sourcePage: 1 },
  ];
  const bytes = Buffer.from(JSON.stringify({ observedOn: '2026-01-10', rows }));
  mkdirSync(join(directory, 'source-documents'));
  const originalPath = join(directory, 'source-documents', 'bank-observation.json');
  writeFileSync(originalPath, bytes);
  const source: StatementSource = { id: 'bank', accountId, sourceFile: 'bank-observation.json', sha256: createHash('sha256').update(bytes).digest('hex'), periodStart: '2026-01-02', periodEnd: '2026-01-10', openingBalanceCents: 100000, closingBalanceCents: 287934, sourceKind: 'bank_activity', observedOn: '2026-01-10', rows };
  command({ type: 'stage_statement', statement: source, requestId: 'stage-bank' });
  const correction = (kind: 'income' | 'car'): Extract<Command, { type: 'correct_bank_matched_amount' }> => {
    const state = store.state();
    const transaction = state.transactions.find(row => kind === 'income' ? row.id === income.id : row.source === 'Asset contribution')!;
    return { type: 'correct_bank_matched_amount', transactionId: transaction.id, source, rowId: kind, expectedSourceSha256: source.sha256, expectedTransaction: transaction, expectedObligation: state.obligations.find(row => row.id === transaction.plannedPayment!.obligationId)!, expectedPurchase: kind === 'car' ? state.assetPurchases![0] : null, description: kind === 'income' ? 'Bank confirmed paycheck' : 'Bank confirmed car contribution', reason: 'The authenticated bank original supplies the posted amount.', requestId: `correct-${kind}`, expectedRevision: state.revision };
  };
  return { get store() { return store; }, command, correction, source, originalPath, accountId, reopen() { store.close(); store = createStore(path, 'live'); } };
}

test('bank corrections preserve linked identities, archive originals and match without duplicate postings', t => {
  const fixture = setup(t);
  const before = fixture.store.export();
  const income = fixture.correction('income');
  fixture.command(income);
  const car = fixture.correction('car');
  fixture.command(car);
  const corrected = fixture.store.state();
  assert.equal(corrected.accounts[0].balanceCents, 287934);
  assert.equal(corrected.assetPurchases![0].paidCents, 550000);
  assert.equal(corrected.assetPurchases![0].monthlyCents, 100000);
  for (const correction of [income, car]) {
    const transaction = corrected.transactions.find(row => row.id === correction.transactionId)!;
    assert.deepEqual(transaction.plannedPayment, correction.expectedTransaction.plannedPayment);
    assert.equal(transaction.paydayDate, correction.expectedTransaction.paydayDate);
    assert.equal(transaction.date, correction.expectedTransaction.date);
    assert.equal(transaction.category, correction.expectedTransaction.category);
    assert.equal(corrected.obligations.find(row => row.id === transaction.plannedPayment!.obligationId)!.amountCents, transaction.amountCents);
  }
  const archives = fixture.store.export().data.originalImports;
  assert.equal(archives.length, 2);
  const saved = archives[0].source as { before: { transaction: { amountCents: number } }; after: { transaction: { amountCents: number } } };
  assert.equal(saved.before.transaction.amountCents, 300000);
  assert.equal(saved.after.transaction.amountCents, 337934);
  const originalIncome = before.data.transactions.find(row => row.id === income.transactionId)!;
  assert.deepEqual((archives[0].source as { before: { transaction: unknown } }).before.transaction, originalIncome);
  assert.deepEqual(fixture.store.command(income), fixture.store.state());
  assert.throws(() => fixture.store.command({ ...income, reason: 'Different payload' }), /request ID/);
  fixture.command({ type: 'reconcile', accountId: fixture.accountId, date: '2026-01-10', balanceCents: fixture.source.closingBalanceCents, note: 'Authenticated bank observation', requestId: 'bank-balance' });
  fixture.command({ type: 'review_statement', importId: fixture.source.id, decisions: [{ rowId: 'income', kind: 'income', category: income.expectedTransaction.category, match: { transactionId: income.transactionId } }, { rowId: 'car', kind: 'transfer', category: car.expectedTransaction.category, match: { transactionId: car.transactionId } }], requestId: 'review-bank' });
  fixture.command({ type: 'commit_statements', importIds: [fixture.source.id], requestId: 'commit-bank' });
  const committed = fixture.store.state();
  assert.equal(committed.accounts[0].balanceCents, 287934);
  assert.equal(committed.transactions.filter(row => row.kind === 'income').length, 1);
  assert.equal(committed.transactions.filter(row => row.source === 'Asset contribution').length, 1);
  for (const id of [income.transactionId, car.transactionId]) assert.equal(committed.transactions.find(row => row.id === id)!.importSources?.length, 1);
  fixture.reopen();
  assert.deepEqual(fixture.store.state(), committed);
  assert.deepEqual(fixture.store.export().data.originalImports, archives);
});

test('bank correction rejects stale snapshots, changed source bytes and missing revision without changes', t => {
  const fixture = setup(t);
  const original = fixture.correction('income');
  const before = fixture.store.state();
  for (const command of [
    { ...original, expectedTransaction: { ...original.expectedTransaction, amountCents: 299999 } },
    { ...original, expectedObligation: { ...original.expectedObligation, amountCents: 299999 } },
    { ...original, expectedSourceSha256: '0'.repeat(64) },
    { ...original, rowId: 'missing' },
    { ...original, expectedRevision: undefined },
    { ...original, expectedRevision: before.revision - 1 },
    { ...original, requestId: '' },
  ]) {
    assert.throws(() => fixture.store.command(command));
    assert.deepEqual(fixture.store.state(), before);
  }
  writeFileSync(fixture.originalPath, 'changed');
  assert.throws(() => fixture.store.command(original), /original review source changed/);
  assert.deepEqual(fixture.store.state(), before);
});

test('bank correction rejects wrong kind, later balance and stale purchase progress', t => {
  const fixture = setup(t);
  const income = fixture.correction('income');
  assert.throws(() => fixture.command({ ...income, rowId: 'car' }), /linked income and asset contributions/);
  const car = fixture.correction('car');
  assert.throws(() => fixture.command({ ...car, expectedPurchase: { ...car.expectedPurchase!, paidCents: 1 } }), /linked purchase changed/);
  fixture.command({ type: 'reconcile', accountId: fixture.accountId, date: '2026-01-11', balanceCents: 220000, note: 'Later observation', requestId: 'later-bank-balance' });
  const before = fixture.store.state();
  assert.throws(() => fixture.command(income), /later confirmed balance/);
  assert.deepEqual(fixture.store.state(), before);
});

test('bank correction rejects row changes that retain the saved original file hash', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-11T12:00:00Z') });
  const fixture = setup(t);
  const original = fixture.correction('income');
  const before = fixture.store.export();
  const source = structuredClone(original.source);
  source.rows[0].amountCents += 10000;
  source.closingBalanceCents += 10000;
  assert.throws(() => fixture.command({ ...original, source }), /bank correction source changed/);
  assert.deepEqual(fixture.store.export(), before);
});

test('bank correction requires the current saved extraction even when its original hash is unchanged', t => {
  const fixture = setup(t);
  const original = fixture.correction('income');
  const revised = structuredClone(original.source);
  revised.rows[0].amountCents += 10000;
  revised.closingBalanceCents += 10000;
  fixture.command({ type: 'revise_statement', importId: revised.id, statement: revised, reason: 'Correct the extracted amount against its original.', requestId: 'revise-bank' });
  const before = fixture.store.state();
  assert.throws(() => fixture.command(original), /bank correction source changed/);
  assert.throws(() => fixture.command({ ...original, source: { ...revised, id: 'unsaved' } }), /not saved/);
  assert.deepEqual(fixture.store.state(), before);
  const state = fixture.command({ ...original, source: revised });
  assert.equal(state.transactions.find(transaction => transaction.id === original.transactionId)?.amountCents, revised.rows[0].amountCents);
});
