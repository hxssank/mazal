import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AccountType, StatementDecision, StatementSource } from '../shared/types.ts';
import { reconciliationRows } from '../shared/reconciliation.ts';
import { createStore } from './store.ts';

function setup(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-signed-balances-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const add = (name: string, accountType: AccountType, openingBalanceCents: number) => store.command({ type: 'add_account', entityId: 'personal', name, accountType, openingBalanceCents, openingDate: '2026-01-01' }).accounts.find(account => account.name === name)!.id;
  return { store, path, add };
}

function commit(store: ReturnType<typeof createStore>, accountId: string, opening: number, movement: number, kind: StatementDecision['kind']) {
  const source: StatementSource = { id: accountId, accountId, sourceFile: `${accountId}.pdf`, sha256: (kind === 'expense' ? 'a' : 'b').repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: opening, closingBalanceCents: opening + movement, rows: [{ id: 'row', transactionDate: '2026-01-15', postingDate: '2026-01-16', amountCents: movement, description: 'Original bank activity', sourcePage: 1 }] };
  store.command({ type: 'stage_statement', statement: source, requestId: `stage-${accountId}` });
  store.command({ type: 'review_statement', importId: source.id, decisions: [{ rowId: 'row', kind, category: 'Other' }], expectedRevision: store.state().revision, requestId: `review-${accountId}` });
  return store.command({ type: 'commit_statements', importIds: [source.id], expectedRevision: store.state().revision, requestId: `commit-${accountId}` });
}

test('opening balances retain cash overdrafts and liability credits through restart and restore', t => {
  const { store, path, add } = setup(t);
  const cash = add('Overdrawn bank', 'cash', -2000);
  const card = add('Card credit', 'debt', -1000);
  const payable = add('Payable credit', 'payable', -500);
  const before = store.state();
  for (const [accountId, balanceCents] of [[cash, -2000], [card, -1000], [payable, -500]] as const) {
    assert.equal(before.accounts.find(account => account.id === accountId)!.balanceCents, balanceCents);
    const opening = before.transactions.find(row => row.accountId === accountId)!;
    assert.equal(opening.kind, 'opening');
    assert.equal(opening.balanceChanges?.[accountId], balanceCents);
  }
  for (const accountType of ['investment', 'receivable'] as const) assert.throws(() => add(accountType, accountType, -1), /whole number/);
  assert.throws(() => store.command({ type: 'add_transaction', kind: 'expense', accountId: cash, date: '2026-01-02', amountCents: 1, description: 'Blocked expense', category: 'Other', requestId: 'blocked' }), /funds/);
  assert.deepEqual(store.state(), before);
  const backup = store.export();
  assert.deepEqual(store.restore(backup).accounts, before.accounts);
  const saved = store.state();
  store.close();
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state(), saved); } finally { reopened.close(); }
});

test('statements record current cash overdrafts and card credits without enabling manual overspending', t => {
  const { store, path, add } = setup(t);
  const cash = add('Bank', 'cash', 10000);
  const card = add('Card', 'debt', 5000);
  const savings = add('Savings', 'cash', 0);
  const loan = add('Loan', 'debt', 1000);
  commit(store, cash, 10000, -12000, 'expense');
  let state = commit(store, card, 5000, -6000, 'refund');
  assert.equal(state.accounts.find(account => account.id === cash)!.balanceCents, -2000);
  assert.equal(state.accounts.find(account => account.id === cash)!.evidence!.balanceCents, -2000);
  assert.equal(state.accounts.find(account => account.id === card)!.balanceCents, -1000);
  assert.equal(state.accounts.find(account => account.id === card)!.evidence!.balanceCents, -1000);
  const before = store.state();
  for (const kind of ['expense', 'transfer', 'debt_payment'] as const) assert.throws(() => store.command({ type: 'add_transaction', kind, accountId: cash, ...(kind === 'expense' ? {} : { toAccountId: kind === 'transfer' ? savings : loan }), date: '2026-02-01', amountCents: 1, description: 'Blocked outflow', category: 'Other', requestId: kind }), /funds/);
  assert.deepEqual(store.state(), before);
  for (const [accountId, balanceCents] of [[cash, -2000], [card, -1000]] as const) {
    state = store.command({ type: 'save_reconciliation', accountId, date: '2026-01-31', balanceCents, clearedTransactionIds: reconciliationRows(state, accountId, '2026-01-31').map(row => row.id), finish: true, expectedRevision: state.revision, requestId: `check-${accountId}` });
  }
  store.restore(store.export());
  const saved = store.state();
  store.close();
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state(), saved); } finally { reopened.close(); }
});

test('explicit balance confirmation accepts bank deficits but retains investment and payment guards', t => {
  const { store, add } = setup(t);
  const cash = add('Bank', 'cash', 10000), card = add('Card', 'debt', 5000), investment = add('Investment', 'investment', 1000);
  for (const accountId of [cash, card]) store.command({ type: 'reconcile', accountId, balanceCents: -1000, date: '2026-01-31', note: 'Confirmed on statement', requestId: accountId });
  const before = store.state();
  assert.throws(() => store.command({ type: 'reconcile', accountId: investment, balanceCents: -1000, date: '2026-01-31', note: 'Invalid investment', requestId: 'investment' }), /whole number/);
  assert.deepEqual(store.state(), before);
  const afterIncome = store.command({ type: 'add_transaction', kind: 'income', accountId: cash, date: '2026-02-01', amountCents: 2000, description: 'Income clears overdraft', category: 'Pay', requestId: 'income' });
  assert.equal(afterIncome.accounts.find(account => account.id === cash)!.balanceCents, 1000);
  assert.throws(() => store.command({ type: 'add_transaction', kind: 'debt_payment', accountId: cash, toAccountId: card, date: '2026-02-01', amountCents: 1, description: 'Payment to credit balance', category: 'Payment', requestId: 'overpayment' }), /exceeds/);
});

test('historical overdraft reconciliation can finish while retaining a later positive bank balance', t => {
  const { store, add } = setup(t), cash = add('Bank', 'cash', 10000);
  store.command({ type: 'reconcile', accountId: cash, balanceCents: 5000, date: '2026-02-01', note: 'Later bank balance', requestId: 'later' });
  const state = commit(store, cash, 10000, -12000, 'expense');
  const saved = store.command({ type: 'save_reconciliation', accountId: cash, date: '2026-01-31', balanceCents: -2000, clearedTransactionIds: reconciliationRows(state, cash, '2026-01-31').map(row => row.id), finish: true, expectedRevision: state.revision, requestId: 'historical-check' });
  assert.equal(saved.accounts[0].balanceCents, 5000);
  assert.equal(saved.accounts[0].reconciliation!.balanceCents, -2000);
  assert.equal(store.restore(store.export()).accounts[0].reconciliation!.balanceCents, -2000);
});
