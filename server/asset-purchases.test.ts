import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { deferTestCleanup, trackTestResource, closeTestResource } from './test-cleanup.ts';
import { summarize, today } from '../shared/analytics.ts';
import { purchaseAccountId } from '../shared/asset-purchases.ts';
import { ledgerCSV } from '../shared/ledger.ts';
import type { AssetPurchase, Command } from '../shared/types.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-purchase-'));
  deferTestCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'live.sqlite');
  const store = trackTestResource(t, createStore(path, 'live'));
  return { store, path };
}
const purchase: AssetPurchase = { id: 'bmw-m240i', entityId: 'personal', name: '2018 BMW M240i', payee: 'Mom', targetCents: 2000000, monthlyCents: 100000, paidCents: null, paidAsOf: '', notes: 'Payments and repairs contribute toward ownership.' };

test('unknown car purchase progress does not invent equity and a confirmed zero remains zero', t => {
  const { store } = setup(t);
  const save: Command = { type: 'save_asset_purchase', purchase, expected: null, requestId: 'setup' };
  store.command(save);
  store.command(save);
  assert.equal(store.state().assetPurchases![0].paidCents, null);
  assert.equal(summarize(store.state()).assetsCents, 0);
  assert.equal(store.state().transactions.length, 0);
  assert.throws(() => store.command({ type: 'record_asset_purchase_payment', id: purchase.id, expected: purchase, accountId: 'missing', amountCents: 100000, date: today(), notes: '', requestId: 'unconfirmed' }), /Confirm the amount already paid/);
  const confirmed = { ...purchase, paidCents: 0, paidAsOf: today() };
  store.command({ type: 'save_asset_purchase', purchase: confirmed, expected: purchase, requestId: 'confirm-zero' });
  assert.equal(store.state().assetPurchases![0].paidCents, 0);
  assert.equal(summarize(store.state()).assetsCents, 0);
  assert.equal(store.state().accounts.length, 0);
});

test('payments and repairs exchange cash for car equity while gas remains ordinary spending', t => {
  const { store, path } = setup(t);
  store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 500000, openingDate: today() });
  const bank = store.state().accounts[0].id;
  const confirmed = { ...purchase, paidCents: 0, paidAsOf: today() };
  store.command({ type: 'save_asset_purchase', purchase: confirmed, expected: null, requestId: 'setup' });
  const payment: Command = { type: 'record_asset_purchase_payment', contributionKind: 'payment', id: purchase.id, expected: confirmed, accountId: bank, amountCents: 100000, date: today(), notes: 'September', requestId: 'pay' };
  store.command(payment);
  store.command(payment);
  assert.equal(store.state().accounts[0].balanceCents, 400000);
  assert.equal(store.state().assetPurchases![0].paidCents, 100000);
  assert.equal(summarize(store.state()).netWorthCents, 500000);
  assert.equal(summarize(store.state()).investmentsCents, 0);
  assert.equal(summarize(store.state()).expensesCents, 0);
  assert.equal(summarize(store.state()).availableCents, 400000);
  const repair: Command = { type: 'record_asset_purchase_payment', contributionKind: 'repair', id: purchase.id, expected: store.state().assetPurchases![0], accountId: bank, amountCents: 25000, date: today(), notes: 'Brake repair', requestId: 'repair' };
  store.command(repair);
  store.command(repair);
  assert.equal(store.state().accounts[0].balanceCents, 375000);
  assert.equal(store.state().assetPurchases![0].paidCents, 125000);
  assert.equal(summarize(store.state()).netWorthCents, 500000);
  assert.equal(summarize(store.state()).expensesCents, 0);
  assert.match(store.state().transactions.find(transaction => transaction.source === 'Car repair contribution')!.description, /repair contribution: Brake repair/);
  store.command({ type: 'add_transaction', kind: 'expense', accountId: bank, amountCents: 6000, date: today(), description: 'Gas', category: 'Fuel', requestId: 'gas' });
  assert.equal(summarize(store.state()).expensesCents, 6000);
  assert.equal(summarize(store.state()).netWorthCents, 494000);
  assert.equal(store.state().assetPurchases![0].paidCents, 125000);
  assert.equal(store.state().accounts.length, 1);
  assert.match(ledgerCSV(store.state(), store.state().transactions), /2018 BMW M240i/);
  const backup = store.export();
  const expected = store.state();
  closeTestResource(store);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  assert.deepEqual(reopened.state().assetPurchases, expected.assetPurchases);
  reopened.restore(backup);
  assert.equal(summarize(reopened.state()).netWorthCents, 494000);
  assert.deepEqual(reopened.state().accounts, expected.accounts);
});

test('contributions reject stale totals, wrong owners, insufficient cash and target overpayments atomically', t => {
  const { store } = setup(t);
  store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 50000, openingDate: today() });
  const bank = store.state().accounts[0].id;
  store.command({ type: 'add_entity', name: 'Shop', ownershipBps: 5000 });
  const business = store.state().entities.find(entity => entity.kind === 'business')!.id;
  store.command({ type: 'add_account', entityId: business, name: 'Business bank', accountType: 'cash', openingBalanceCents: 500000, openingDate: today() });
  const wrongBank = store.state().accounts.find(account => account.entityId === business)!.id;
  const confirmed = { ...purchase, paidCents: 1900000, paidAsOf: today() };
  store.command({ type: 'save_asset_purchase', purchase: confirmed, expected: null, requestId: 'setup' });
  const command: Extract<Command, { type: 'record_asset_purchase_payment' }> = { type: 'record_asset_purchase_payment', id: purchase.id, expected: confirmed, accountId: bank, amountCents: 50000, date: today(), notes: '', requestId: 'pay' };
  const baseline = store.state();
  assert.throws(() => store.command({ ...command, amountCents: 110000, requestId: 'over-target' }), /Payment amount/);
  assert.throws(() => store.command({ ...command, amountCents: 100000, requestId: 'no-funds' }), /enough recorded funds/);
  assert.throws(() => store.command({ ...command, accountId: wrongBank, requestId: 'wrong-owner' }), /belonging to this purchase owner/);
  assert.throws(() => store.command({ ...command, date: '2200-01-01', requestId: 'future' }), /cannot be in the future/);
  assert.deepEqual(store.state(), baseline);
  store.command(command);
  assert.throws(() => store.command({ ...command, requestId: 'stale' }), /purchase changed/);
  assert.throws(() => store.command({ ...command, amountCents: 1 }), /request ID was already used/);
});

test('asset contributions cannot spend cash already included in a later bank balance', t => {
  const { store } = setup(t);
  store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 500000, openingDate: '2026-01-01' });
  const bank = store.state().accounts[0].id;
  store.command({ type: 'reconcile', accountId: bank, balanceCents: 400000, date: '2026-02-01', note: 'Bank snapshot after January payments', requestId: 'bank-check' });
  const confirmed = { ...purchase, paidCents: 0, paidAsOf: '2026-01-01' };
  store.command({ type: 'save_asset_purchase', purchase: confirmed, expected: null, requestId: 'setup' });
  const baseline = store.state();
  const command: Extract<Command, { type: 'record_asset_purchase_payment' }> = { type: 'record_asset_purchase_payment', id: purchase.id, expected: confirmed, accountId: bank, amountCents: 100000, date: '2026-01-31', notes: '', requestId: 'old-payment' };
  for (const contributionKind of ['payment', 'repair'] as const) {
    assert.throws(() => store.command({ ...command, contributionKind, requestId: `old-${contributionKind}` }), /confirmed balance on 2026-02-01/);
    assert.deepEqual(store.state(), baseline);
  }
  store.command({ ...command, date: '2026-02-02', requestId: 'new-payment' });
  assert.equal(store.state().accounts[0].balanceCents, 300000);
  assert.equal(store.state().assetPurchases![0].paidCents, 100000);
});

test('purchase restores reject missing owners, duplicate IDs and totals below recorded contributions', t => {
  const { store } = setup(t);
  store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 500000, openingDate: today() });
  const bank = store.state().accounts[0].id;
  const confirmed = { ...purchase, paidCents: 0, paidAsOf: today() };
  store.command({ type: 'save_asset_purchase', purchase: confirmed, expected: null, requestId: 'setup' });
  store.command({ type: 'record_asset_purchase_payment', id: purchase.id, expected: confirmed, accountId: bank, amountCents: 100000, date: today(), notes: '', requestId: 'pay' });
  const backup = store.export();
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'save_asset_purchase', purchase: { ...baseline.assetPurchases![0], paidCents: 0 }, expected: baseline.assetPurchases![0], requestId: 'erase-progress' }), /less than recorded contributions/);
  const duplicate = structuredClone(backup);
  duplicate.data.assetPurchases!.push(duplicate.data.assetPurchases![0]);
  assert.throws(() => store.restore(duplicate), /Duplicate asset purchase/);
  const orphan = structuredClone(backup);
  orphan.data.assetPurchases = [];
  assert.throws(() => store.restore(orphan), /missing purchase or wrong owner/);
  const inconsistent = structuredClone(backup);
  inconsistent.data.assetPurchases![0].paidCents = 0;
  assert.throws(() => store.restore(inconsistent), /less than recorded contributions/);
  assert.ok(backup.data.accounts.some(account => account.id === purchaseAccountId(purchase.id)));
  assert.deepEqual(store.state(), baseline);
});
