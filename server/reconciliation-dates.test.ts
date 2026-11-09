import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from './store.ts';
import { clearedBalance, reconciliationRows, reconciliationStart } from '../shared/reconciliation.ts';
import type { Command, StatementSource } from '../shared/types.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-reconciliation-dates-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const cash = store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const card = store.command({ type: 'add_account', entityId: 'personal', name: 'Card', accountType: 'debt', openingBalanceCents: 5000, openingDate: '2026-01-01' }).accounts.find(account => account.name === 'Card')!.id;
  return { store, path, cash, card };
}

function matchedPayment(store: ReturnType<typeof createStore>, cash: string, card: string, bankDate: string, cardDate: string) {
  const source = (id: string, accountId: string, postingDate: string, openingBalanceCents: number, sha: string): StatementSource => ({
    id, accountId, sourceFile: `${id}.pdf`, sha256: sha.repeat(64), periodStart: `${postingDate.slice(0, 7)}-01`, periodEnd: postingDate.startsWith('2026-01') ? '2026-01-31' : '2026-02-28', openingBalanceCents, closingBalanceCents: openingBalanceCents - 1000,
    rows: [{ id: 'payment', transactionDate: postingDate, postingDate, description: 'Card payment', amountCents: -1000, sourcePage: 1 }],
  });
  const bank = source('bank-source', cash, bankDate, 10000, 'a');
  const credit = source('card-source', card, cardDate, 5000, 'b');
  for (const statement of [bank, credit]) store.command({ type: 'stage_statement', statement, requestId: `stage-${statement.id}` });
  for (const [statement, other] of [[bank, credit], [credit, bank]]) store.command({ type: 'review_statement', importId: statement.id, decisions: [{ rowId: 'payment', kind: 'transfer', category: 'Card payment', match: { importId: other.id, rowId: 'payment' } }], expectedRevision: store.state().revision, requestId: `review-${statement.id}` });
  return store.command({ type: 'commit_statements', importIds: [bank.id, credit.id], expectedRevision: store.state().revision, requestId: 'commit-matched-payment' });
}

test('a card credit posted before its bank debit reconciles on the card date and survives restore', t => {
  const { store, card, cash, path } = setup(t);
  const state = matchedPayment(store, cash, card, '2026-02-02', '2026-01-31');
  const payment = state.transactions.find(transaction => transaction.kind === 'debt_payment')!;
  const rows = reconciliationRows(state, card, '2026-01-31');
  assert.ok(rows.some(row => row.id === payment.id), 'The card January statement includes its January 31 credit.');
  assert.equal(reconciliationRows(state, cash, '2026-01-31').some(row => row.id === payment.id), false);
  const selected = rows.map(row => row.id);
  assert.equal(clearedBalance(rows, state.accounts.find(account => account.id === card)!, new Set(selected)), 4000);
  const saved = store.command({ type: 'save_reconciliation', accountId: card, date: '2026-01-31', balanceCents: 4000, clearedTransactionIds: selected, finish: true, requestId: 'finish-card', expectedRevision: state.revision });
  assert.equal(saved.accounts.find(account => account.id === card)!.reconciliation?.date, '2026-01-31');
  const backup = store.export();
  store.restore(backup, saved.revision);
  store.close();
  const reopened = createStore(path, 'live');
  try {
    const restored = reopened.state();
    assert.deepEqual(restored.accounts.find(account => account.id === card)!.reconciliation, saved.accounts.find(account => account.id === card)!.reconciliation);
    assert.ok(reconciliationRows(restored, card, '2026-01-31').some(row => row.id === payment.id));
  } finally { reopened.close(); }
});

test('a card credit posted after its bank debit cannot enter the earlier card reconciliation', t => {
  const { store, card, cash } = setup(t);
  const state = matchedPayment(store, cash, card, '2026-01-31', '2026-02-02');
  const payment = state.transactions.find(transaction => transaction.kind === 'debt_payment')!;
  const january = reconciliationRows(state, card, '2026-01-31');
  assert.equal(january.some(row => row.id === payment.id), false, 'The card credit belongs to February even when the bank posted in January.');
  assert.ok(reconciliationRows(state, cash, '2026-01-31').some(row => row.id === payment.id));
  const selected = [...january.map(row => row.id), payment.id];
  assert.throws(() => store.command({ type: 'save_reconciliation', accountId: card, date: '2026-01-31', balanceCents: 4000, clearedTransactionIds: selected, finish: true, requestId: 'premature-card', expectedRevision: state.revision }), /match|after|statement/);
  assert.deepEqual(store.state(), state);
  const januarySaved = store.command({ type: 'save_reconciliation', accountId: card, date: '2026-01-31', balanceCents: 5000, clearedTransactionIds: january.map(row => row.id), finish: true, requestId: 'january-card', expectedRevision: state.revision });
  const invalid = store.export();
  const account = invalid.data.accounts.find(account => account.id === card)!;
  account.clearedTransactionIds!.push(payment.id);
  account.reconciliation!.transactionIds.push(payment.id);
  account.reconciliation!.balanceCents = 4000;
  assert.throws(() => store.restore(invalid, januarySaved.revision), /after|statement/);
  const february = reconciliationRows(store.state(), card, '2026-02-28');
  const finished = store.command({ type: 'save_reconciliation', accountId: card, date: '2026-02-28', balanceCents: 4000, clearedTransactionIds: february.map(row => row.id), finish: true, requestId: 'february-card', expectedRevision: januarySaved.revision });
  assert.equal(finished.accounts.find(account => account.id === card)!.reconciliation?.balanceCents, 4000);
});

test('checking and reopening transactions require a revision and request identity', t => {
  const { store, cash } = setup(t);
  const before = store.state();
  const command: Command = { type: 'save_reconciliation', accountId: cash, date: '2026-01-31', balanceCents: 10000, clearedTransactionIds: reconciliationRows(before, cash, '2026-01-31').map(row => row.id), finish: true, requestId: 'finish-bank', expectedRevision: before.revision };
  const withoutRevision = { ...command };
  delete withoutRevision.expectedRevision;
  assert.throws(() => store.command(withoutRevision), /revision|refresh/i);
  const withoutRequest = { ...command } as Record<string, unknown>;
  delete withoutRequest.requestId;
  assert.throws(() => store.command(withoutRequest as Command), /request ID/i);
  assert.deepEqual(store.state(), before);
  const saved = store.command(command);
  const reopen: Command = { type: 'reopen_reconciliation', accountId: cash, requestId: 'reopen-bank', expectedRevision: saved.revision };
  const noReopenRevision = { ...reopen };
  delete noReopenRevision.expectedRevision;
  assert.throws(() => store.command(noReopenRevision), /revision|refresh/i);
  const noReopenRequest = { ...reopen } as Record<string, unknown>;
  delete noReopenRequest.requestId;
  assert.throws(() => store.command(noReopenRequest as Command), /request ID/i);
  assert.deepEqual(store.state(), saved);
});

test('historical statements before the known journal opening cannot become a misleading checkpoint', t => {
  const { store } = setup(t);
  const card = store.command({ type: 'add_account', entityId: 'personal', name: 'Later opening', accountType: 'debt', openingBalanceCents: 12345, openingDate: '2026-09-01' }).accounts.find(account => account.name === 'Later opening')!.id;
  store.command({ type: 'reconcile', accountId: card, balanceCents: 12345, date: '2026-09-01', note: 'Current bank balance', requestId: 'current-balance' });
  const state = store.command({ type: 'import_statement', statement: { id: 'earlier-january', accountId: card, sourceFile: 'Earlier January.pdf', sha256: 'c'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 11000, rows: [{ id: 'purchase', transactionDate: '2026-01-10', postingDate: '2026-01-10', description: 'Earlier purchase', amountCents: 1000, kind: 'purchase', category: 'Food', sourcePage: 1 }] }, requestId: 'earlier-import' });
  assert.equal(reconciliationStart(state.transactions, card), '2026-09-01');
  const earlier = reconciliationRows(state, card, '2026-01-31').map(row => row.id);
  assert.equal(earlier.length, 1);
  for (const finish of [false, true]) {
    assert.throws(() => store.command({ type: 'save_reconciliation', accountId: card, date: '2026-01-31', balanceCents: 1000, clearedTransactionIds: earlier, finish, requestId: `too-early-${finish}`, expectedRevision: state.revision }), /Opening balance is dated 2026-09-01/);
  }
  assert.deepEqual(store.state(), state);
  const invalid = store.export();
  const saved = invalid.data.accounts.find(account => account.id === card)!;
  saved.clearedTransactionIds = earlier;
  saved.reconciliation = { date: '2026-01-31', balanceCents: 1000, transactionIds: earlier };
  assert.throws(() => store.restore(invalid, state.revision), /Opening balance is dated 2026-09-01/);
  assert.equal(store.state().accounts.find(account => account.id === card)!.balanceCents, 12345);
  const rows = reconciliationRows(store.state(), card, '2026-09-01');
  const result = store.command({ type: 'save_reconciliation', accountId: card, date: '2026-09-01', balanceCents: 12345, clearedTransactionIds: rows.map(row => row.id), finish: true, requestId: 'at-opening-date', expectedRevision: state.revision });
  assert.equal(result.accounts.find(account => account.id === card)!.reconciliation?.balanceCents, 12345);
});

test('the earliest known opening belongs to its account and an absent opening stays unknown', () => {
  const row = (id: string, accountId: string, date: string) => ({ id, accountId, date, kind: 'opening' as const, amountCents: 1000, description: id, toAccountId: null, category: '', source: 'Opening balance', createdAt: `${date}T12:00:00Z` });
  const rows = [row('late', 'card', '2026-09-01'), row('other', 'cash', '2026-01-01'), row('early', 'card', '2026-02-01')];
  assert.equal(reconciliationStart(rows, 'card'), '2026-02-01');
  assert.equal(reconciliationStart(rows, 'cash'), '2026-01-01');
  assert.equal(reconciliationStart(rows, 'missing'), null);
});
