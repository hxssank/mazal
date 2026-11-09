import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from './store.ts';
import type { StatementDecision, StatementSource } from '../shared/types.ts';
import { reconciliationDate } from '../shared/reconciliation.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-quality-planning-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const bank = store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const card = store.command({ type: 'add_account', entityId: 'personal', name: 'Card', accountType: 'debt', openingBalanceCents: 5000, openingDate: '2026-01-01' }).accounts.find(account => account.name === 'Card')!.id;
  return { store, bank, card };
}

function stage(store: ReturnType<typeof createStore>, source: StatementSource, decisions: StatementDecision[]) {
  store.command({ type: 'stage_statement', statement: source, requestId: `stage-${source.id}` });
  store.command({ type: 'review_statement', importId: source.id, decisions, expectedRevision: store.state().revision, requestId: `review-${source.id}` });
}

const source = (id: string, accountId: string, month: string, day: string, openingBalanceCents: number, amountCents: number, sha: string): StatementSource => ({
    id, accountId, sourceFile: `${id}.pdf`, sha256: sha.repeat(64), periodStart: `${month}-01`, periodEnd: `${month}-${month === '2026-01' ? '31' : '28'}`, openingBalanceCents, closingBalanceCents: openingBalanceCents + amountCents,
    rows: [{ id: 'row', transactionDate: `${month}-${day}`, postingDate: `${month}-${day}`, description: id, amountCents, sourcePage: 1 }],
});

function matchedPayment(store: ReturnType<typeof createStore>, bank: string, card: string, reverseDates = false) {
  const bankFebruary = source('bank-payment', bank, reverseDates ? '2026-01' : '2026-02', reverseDates ? '31' : '02', 10000, -1000, 'a');
  const cardJanuary = source('card-payment', card, reverseDates ? '2026-02' : '2026-01', reverseDates ? '02' : '31', 5000, -1000, 'b');
  stage(store, bankFebruary, [{ rowId: 'row', kind: 'transfer', category: 'Card payment', match: { importId: cardJanuary.id, rowId: 'row' } }]);
  stage(store, cardJanuary, [{ rowId: 'row', kind: 'transfer', category: 'Card payment', match: { importId: bankFebruary.id, rowId: 'row' } }]);
  store.command({ type: 'commit_statements', importIds: [bankFebruary.id, cardJanuary.id], expectedRevision: store.state().revision, requestId: 'commit-payment' });
}

test('the next card statement is not blocked by the bank side of a previously matched transfer', t => {
  const { store, bank, card } = setup(t);
  matchedPayment(store, bank, card);
  const cardFebruary = source('card-february', card, '2026-02', '10', 4000, 500, 'c');
  stage(store, cardFebruary, [{ rowId: 'row', kind: 'expense', category: 'Food' }]);
  const result = store.command({ type: 'commit_statements', importIds: [cardFebruary.id], expectedRevision: store.state().revision, requestId: 'commit-card-february' });
  assert.equal(result.accounts.find(account => account.id === card)!.balanceCents, 4500);
});

test('legacy statement import also uses the card posting date for duplicate detection', t => {
  const { store, bank, card } = setup(t);
  matchedPayment(store, bank, card);
  const statement = source('legacy-card-february', card, '2026-02', '10', 4000, 500, 'c');
  const result = store.command({ type: 'import_statement', statement: { ...statement, rows: statement.rows.map(row => ({ ...row, kind: 'purchase', category: 'Food' })) }, requestId: 'legacy-february' });
  assert.equal(result.accounts.find(account => account.id === card)!.balanceCents, 4500);
});

test('manual balance confirmation follows the selected account posting date in either transfer direction', t => {
  const { store, bank, card } = setup(t);
  matchedPayment(store, bank, card);
  const result = store.command({ type: 'reconcile', accountId: card, balanceCents: 4000, date: '2026-01-31', note: 'Confirmed from card statement', requestId: 'card-confirmation' });
  assert.equal(result.accounts.find(account => account.id === card)!.reconciledAt, '2026-01-31');
  assert.throws(() => store.command({ type: 'reconcile', accountId: bank, balanceCents: 9000, date: '2026-01-31', note: 'Too early for bank', requestId: 'early-bank' }), /2026-02-02/);
});

test('a later card posting still blocks an earlier balance confirmation', t => {
  const { store, bank, card } = setup(t);
  matchedPayment(store, bank, card, true);
  assert.throws(() => store.command({ type: 'reconcile', accountId: card, balanceCents: 4000, date: '2026-01-31', note: 'Too early for card', requestId: 'early-card' }), /2026-02-02/);
});

test('an unlinked manual transfer still blocks duplicate statement activity', t => {
  const { store, bank, card } = setup(t);
  store.command({ type: 'add_transaction', kind: 'debt_payment', accountId: bank, toAccountId: card, amountCents: 1000, date: '2026-02-02', description: 'Manual card payment', category: 'Card payment', requestId: 'manual-payment' });
  const statement = source('card-february', card, '2026-02', '10', 4000, 500, 'c');
  stage(store, statement, [{ rowId: 'row', kind: 'expense', category: 'Food' }]);
  const before = store.state();
  assert.throws(() => store.command({ type: 'commit_statements', importIds: [statement.id], expectedRevision: before.revision, requestId: 'ambiguous-import' }), /already has activity/);
  assert.deepEqual(store.state(), before);
});

test('a reviewed earlier card posting can link to an existing manual transfer dated for the bank', t => {
  const { store, bank, card } = setup(t);
  const state = store.command({ type: 'add_transaction', kind: 'debt_payment', accountId: bank, toAccountId: card, amountCents: 1000, date: '2026-02-02', description: 'Manual card payment', category: 'Card payment', requestId: 'manual-payment' });
  const payment = state.transactions.find(transaction => transaction.kind === 'debt_payment')!;
  const statement = source('card-january', card, '2026-01', '31', 5000, -1000, 'a');
  stage(store, statement, [{ rowId: 'row', kind: 'transfer', category: 'Card payment', match: { transactionId: payment.id } }]);
  const result = store.command({ type: 'commit_statements', importIds: [statement.id], expectedRevision: store.state().revision, requestId: 'link-card-statement' });
  assert.equal(result.accounts.find(account => account.id === card)!.balanceCents, 4000);
  assert.deepEqual(result.transactions.filter(transaction => transaction.kind === 'debt_payment').map(transaction => transaction.id), [payment.id]);
  const corrections = result.transactions.filter(transaction => transaction.source === 'Statement history correction');
  assert.equal(corrections.reduce((sum, transaction) => sum + (transaction.balanceChanges?.[card] ?? 0), 0), 0, 'Dated opening corrections must not change the current card balance.');
  assert.equal(result.transactions.filter(transaction => reconciliationDate(transaction, card) < statement.periodStart).reduce((sum, transaction) => sum + (transaction.balanceChanges?.[card] ?? 0), 0), statement.openingBalanceCents);
  assert.equal(result.accounts.find(account => account.id === bank)!.balanceCents, state.accounts.find(account => account.id === bank)!.balanceCents);
  assert.equal(result.transactions.find(transaction => transaction.id === payment.id)!.postingDates![card], '2026-01-31');
  assert.equal(result.transactions.find(transaction => transaction.id === payment.id)!.postingDate, '2026-02-02');
  assert.throws(() => store.command({ type: 'reconcile', accountId: bank, balanceCents: 9000, date: '2026-01-31', note: 'Bank date stays later', requestId: 'early-bank' }), /2026-02-02/);
  store.restore(store.export(), store.state().revision);
});
