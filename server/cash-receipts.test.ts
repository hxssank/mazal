import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { summarize } from '../shared/analytics.ts';
import type { MoneyOwed, OwedPayment, TrackedAsset } from '../shared/types.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-cash-receipts-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const cashAccountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  return { store, path, cashAccountId };
}
const tab: MoneyOwed = { id: 'alex', entityId: 'personal', name: 'Alex', amountCents: 50000, comment: 'Loan repayment', payments: [] };
const payment: OwedPayment = { id: 'repayment', amountCents: 12000, date: '2026-01-10', comment: 'Bank transfer' };
const asset: TrackedAsset = { id: 'camera', entityId: 'personal', name: 'Camera', category: 'Electronics', purchaseDate: '2026-01-01', costCents: 10000, estimatedValueCents: 8000, status: 'owned', soldDate: null, saleCents: null, feesCents: 0, notes: '' };
const sold: TrackedAsset = { ...asset, status: 'sold', soldDate: '2026-01-10', saleCents: 8500, feesCents: 500 };

test('a repayment cannot credit cash while a duplicate receivable account still carries the same value', t => {
  const { store, cashAccountId } = setup(t);
  const account = store.command({ type: 'add_account', entityId: 'personal', name: 'Alex receivable', accountType: 'receivable', openingBalanceCents: tab.amountCents, openingDate: '2026-01-01' }).accounts.find(item => item.type === 'receivable')!;
  const duplicateTab = { ...tab, id: account.id };
  store.command({ type: 'save_money_owed', tab: duplicateTab, expected: null, requestId: 'duplicate-tab' });
  const before = store.state();
  assert.throws(() => store.command({ type: 'record_owed_payment', id: duplicateTab.id, expected: duplicateTab, cashAccountId, payment, requestId: 'duplicate-value-receipt' }), /receivable account/);
  assert.deepEqual(store.state(), before);
});

test('an asset sale cannot credit cash while a duplicate purchase still carries the same value', t => {
  const { store, cashAccountId } = setup(t);
  store.command({ type: 'save_asset_purchase', purchase: { id: asset.id, entityId: asset.entityId, name: asset.name, payee: 'Seller', targetCents: asset.costCents!, paidCents: asset.estimatedValueCents, paidAsOf: asset.purchaseDate!, monthlyCents: 1000, notes: '' }, expected: null, requestId: 'duplicate-purchase' });
  store.command({ type: 'save_asset', asset });
  const before = store.state();
  assert.throws(() => store.command({ type: 'record_asset_sale', asset: sold, expected: asset, cashAccountId, requestId: 'duplicate-value-sale' }), /purchase record/);
  assert.deepEqual(store.state(), before);
});

test('repayment moves receivable value into cash without income and undo reverses the exact receipt', t => {
  const { store, cashAccountId } = setup(t);
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  const before = summarize(store.state());
  const receive = { type: 'record_owed_payment', id: tab.id, expected: tab, cashAccountId, payment, requestId: 'receipt' } as const;
  const received = store.command(receive);
  assert.equal(received.accounts[0].balanceCents, 22000);
  assert.equal(summarize(received).receivablesCents, 38000);
  assert.equal(summarize(received).netWorthCents, before.netWorthCents);
  assert.equal(received.transactions.filter(tx => tx.kind === 'income').length, 0);
  assert.deepEqual(store.command(receive), received);
  const remove = { type: 'remove_owed_payment', id: tab.id, expected: received.moneyOwed![0], paymentId: payment.id, requestId: 'undo' } as const;
  const undone = store.command(remove);
  assert.equal(undone.accounts[0].balanceCents, 10000);
  assert.equal(summarize(undone).receivablesCents, 50000);
  assert.equal(summarize(undone).netWorthCents, before.netWorthCents);
  assert.deepEqual(store.command(remove), undone);
  assert.equal(undone.transactions.filter(tx => tx.source === 'Receivable repayment reversal').length, 1);
  store.command({ type: 'delete_money_owed', id: tab.id, expected: undone.moneyOwed![0], requestId: 'remove-empty-history-tab' });
  store.restore(store.export());
});

test('sale credits gross less fees once, preserves net worth at the recorded estimate, and undo restores the asset', t => {
  const { store, cashAccountId, path } = setup(t);
  store.command({ type: 'save_asset', asset });
  const before = summarize(store.state());
  const sale = { type: 'record_asset_sale', asset: sold, expected: asset, cashAccountId, requestId: 'sale' } as const;
  const result = store.command(sale);
  assert.equal(result.accounts[0].balanceCents, 18000);
  assert.equal(result.assets![0].status, 'sold');
  assert.equal(summarize(result).netWorthCents, before.netWorthCents);
  assert.equal(result.transactions.filter(tx => tx.kind === 'income').length, 0);
  assert.deepEqual(store.command(sale), result);
  const saved = result.assets![0];
  store.command({ type: 'save_asset', asset: { ...saved, notes: 'Receipt saved' } });
  const posted = store.state().assets![0];
  for (const patch of [{ status: 'owned' as const, soldDate: null, saleCents: null, salePosting: undefined }, { saleCents: 9000 }, { feesCents: 600 }, { soldDate: '2026-01-11' }, { salePosting: undefined }]) assert.throws(() => store.command({ type: 'save_asset', asset: { ...posted, ...patch } }), /Undo the recorded sale/);
  const backup = store.export();
  store.close();
  const reopened = createStore(path, 'live');
  try {
    assert.equal(reopened.state().accounts[0].balanceCents, 18000);
    reopened.restore(backup);
    const undo = { type: 'undo_asset_sale', id: asset.id, expected: posted, requestId: 'undo-sale' } as const;
    const undone = reopened.command(undo);
    assert.equal(undone.accounts[0].balanceCents, 10000);
    assert.equal(undone.assets![0].status, 'owned');
    assert.equal(undone.assets![0].salePosting, undefined);
    assert.equal(summarize(undone).netWorthCents, before.netWorthCents);
    assert.deepEqual(reopened.command(undo), undone);
    reopened.restore(reopened.export());
  } finally { reopened.close(); }
});

test('cash receipts reject missing or foreign accounts, stale records and dates already covered by bank balances', t => {
  const { store, cashAccountId } = setup(t);
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  store.command({ type: 'save_asset', asset });
  store.command({ type: 'add_entity', name: 'Business', ownershipBps: 5000 });
  const owner = store.state().entities.find(entity => entity.kind === 'business')!.id;
  store.command({ type: 'add_account', entityId: owner, name: 'Business bank', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-01-01' });
  store.command({ type: 'add_account', entityId: 'personal', name: 'Card', accountType: 'debt', openingBalanceCents: 10000, openingDate: '2026-01-01' });
  const invalidAccounts = ['missing', store.state().accounts.find(account => account.name === 'Business bank')!.id, store.state().accounts.find(account => account.name === 'Card')!.id];
  for (const cashId of invalidAccounts) {
    assert.throws(() => store.command({ type: 'record_owed_payment', id: tab.id, expected: tab, payment, cashAccountId: cashId, requestId: `bad-repayment-${cashId}` }));
    assert.throws(() => store.command({ type: 'record_asset_sale', asset: sold, expected: asset, cashAccountId: cashId, requestId: `bad-sale-${cashId}` }));
  }
  store.command({ type: 'reconcile', accountId: cashAccountId, balanceCents: 10000, date: '2026-01-10', note: 'Bank already includes prior activity', requestId: 'bank' });
  const baseline = store.state();
  for (const effectiveDate of ['2026-01-09', '2026-01-10']) {
    assert.throws(() => store.command({ type: 'record_owed_payment', id: tab.id, expected: tab, payment: { ...payment, date: effectiveDate }, cashAccountId, requestId: `old-repayment-${effectiveDate}` }), /after that date|after the balance check/);
    assert.throws(() => store.command({ type: 'record_asset_sale', asset: { ...sold, soldDate: effectiveDate }, expected: asset, cashAccountId, requestId: `old-sale-${effectiveDate}` }), /after that date|after the balance check/);
  }
  assert.throws(() => store.command({ type: 'record_asset_sale', asset: { ...sold, feesCents: 9000 }, expected: asset, cashAccountId, requestId: 'fees' }), /fees cannot exceed/);
  assert.deepEqual(store.state(), baseline);
});

test('undo cannot withdraw cash already spent or receipts covered by a later reconciliation', t => {
  for (const receiptType of ['repayment', 'sale']) {
    const { store, cashAccountId } = setup(t);
    store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
    if (receiptType === 'repayment') store.command({ type: 'record_owed_payment', id: tab.id, expected: tab, payment, cashAccountId, requestId: 'receipt' });
    else store.command({ type: 'record_asset_sale', asset: sold, expected: null, cashAccountId, requestId: 'receipt' });
    const undo = receiptType === 'repayment' ? { type: 'remove_owed_payment' as const, id: tab.id, expected: store.state().moneyOwed![0], paymentId: payment.id, requestId: 'undo' } : { type: 'undo_asset_sale' as const, id: asset.id, expected: store.state().assets![0], requestId: 'undo' };
    store.command({ type: 'add_transaction', kind: 'expense', accountId: cashAccountId, amountCents: store.state().accounts[0].balanceCents, date: '2026-01-11', description: 'Spent available cash', category: 'Other', requestId: 'spend' });
    const spent = store.state();
    assert.throws(() => store.command(undo), /enough recorded funds/);
    assert.deepEqual(store.state(), spent);
    store.command({ type: 'reconcile', accountId: cashAccountId, balanceCents: 100000, date: '2026-01-12', note: 'Later bank balance', requestId: 'later-bank' });
    const reconciled = store.state();
    assert.throws(() => store.command(undo), /included in the confirmed cash balance/);
    assert.deepEqual(store.state(), reconciled);
  }
});

test('restores reject detached receipt links, altered cash journals and changed sale proceeds atomically', t => {
  const { store, cashAccountId } = setup(t);
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  store.command({ type: 'record_owed_payment', id: tab.id, expected: tab, payment, cashAccountId, requestId: 'receipt' });
  store.command({ type: 'record_asset_sale', asset: sold, expected: null, cashAccountId, requestId: 'sale' });
  const backup = store.export();
  const baseline = store.state();
  for (const change of [
    (copy: typeof backup) => { delete copy.data.cashPostings; },
    (copy: typeof backup) => { delete copy.data.moneyOwed![0].payments[0].cashAccountId; delete copy.data.moneyOwed![0].payments[0].transactionId; },
    (copy: typeof backup) => { delete copy.data.assets![0].salePosting; },
    (copy: typeof backup) => { copy.data.assets![0].saleCents!++; },
    (copy: typeof backup) => { copy.data.cashPostings![0].amountCents++; },
    (copy: typeof backup) => { const id = copy.data.cashPostings![0].transactionId; for (const entry of copy.data.entries.filter(entry => entry.transactionId === id)) entry.debitCents *= -1; },
  ]) {
    const invalid = structuredClone(backup);
    change(invalid);
    assert.throws(() => store.restore(invalid));
    assert.deepEqual(store.state(), baseline);
  }
});

test('legacy repayment and sale records restore without inventing old cash receipts', t => {
  const { store } = setup(t);
  const backup = store.export();
  backup.data.moneyOwed = [{ ...tab, payments: [payment] }];
  backup.data.assets = [sold];
  delete backup.data.cashPostings;
  store.restore(backup);
  assert.equal(store.state().accounts[0].balanceCents, 10000);
  const beforeTransactions = store.state().transactions;
  store.command({ type: 'remove_owed_payment', id: tab.id, expected: store.state().moneyOwed![0], paymentId: payment.id, requestId: 'correct-legacy' });
  assert.equal(store.state().accounts[0].balanceCents, 10000);
  assert.deepEqual(store.state().transactions, beforeTransactions);
  assert.throws(() => store.command({ type: 'undo_asset_sale', id: asset.id, expected: sold, requestId: 'undo-unposted' }), /no recorded cash sale/);
});

test('same-day receipts require explicit acknowledgement and can be undone after an earlier balance check', t => {
  for (const receiptType of ['repayment', 'sale']) {
    const { store, cashAccountId } = setup(t);
    store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
    store.command({ type: 'reconcile', accountId: cashAccountId, balanceCents: 10000, date: '2026-01-10', note: 'Morning bank check', requestId: 'morning-check' });
    const base = receiptType === 'repayment' ? { type: 'record_owed_payment' as const, id: tab.id, expected: tab, payment, cashAccountId, requestId: 'receipt' } : { type: 'record_asset_sale' as const, asset: sold, expected: null, cashAccountId, requestId: 'receipt' };
    assert.throws(() => store.command(base), /after the balance check/);
    assert.throws(() => store.command({ ...base, afterBalanceConfirmation: false }), /after the balance check/);
    const received = store.command({ ...base, afterBalanceConfirmation: true });
    assert.equal(received.accounts[0].balanceCents, receiptType === 'repayment' ? 22000 : 18000);
    const backup = store.export();
    assert.equal(backup.data.cashPostings![0].balanceCheckDate, '2026-01-10');
    store.restore(backup);
    if (receiptType === 'repayment') store.command({ type: 'remove_owed_payment', id: tab.id, expected: store.state().moneyOwed![0], paymentId: payment.id, requestId: 'undo-same-day' });
    else store.command({ type: 'undo_asset_sale', id: asset.id, expected: store.state().assets![0], requestId: 'undo-same-day' });
    assert.equal(store.state().accounts[0].balanceCents, 10000);
  }
});

test('a later balance check on the same date prevents undo of a receipt already included in that check', t => {
  const { store, cashAccountId } = setup(t);
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  store.command({ type: 'reconcile', accountId: cashAccountId, balanceCents: 10000, date: '2026-01-10', note: 'First check', requestId: 'first-check' });
  store.command({ type: 'record_owed_payment', id: tab.id, expected: tab, payment, cashAccountId, afterBalanceConfirmation: true, requestId: 'receipt' });
  store.command({ type: 'reconcile', accountId: cashAccountId, balanceCents: 22000, date: '2026-01-10', note: 'Check after receipt', requestId: 'second-check' });
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'remove_owed_payment', id: tab.id, expected: baseline.moneyOwed![0], paymentId: payment.id, requestId: 'undo-covered-receipt' }), /included in the confirmed cash balance/);
  assert.deepEqual(store.state(), baseline);
});

test('same-day acknowledgement cannot bypass an older receipt date', t => {
  const { store, cashAccountId } = setup(t);
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  store.command({ type: 'reconcile', accountId: cashAccountId, balanceCents: 10000, date: '2026-01-11', note: 'Latest check', requestId: 'latest-check' });
  assert.throws(() => store.command({ type: 'record_owed_payment', id: tab.id, expected: tab, payment, cashAccountId, afterBalanceConfirmation: true, requestId: 'old-receipt' }), /after that date/);
});
