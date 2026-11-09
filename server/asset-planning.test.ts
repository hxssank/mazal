import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from './store.ts';
import { deferTestCleanup, trackTestResource, closeTestResource } from './test-cleanup.ts';
import { owedPaid, owedRemaining } from '../shared/asset-planning.ts';
import { summarize } from '../shared/analytics.ts';
import type { Command, MoneyOwed, OwedPayment, WishItem } from '../shared/types.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-asset-planning-'));
  deferTestCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'live.sqlite');
  const store = trackTestResource(t, createStore(path, 'live'));
  store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-01-01' });
  return { store, path };
}

function cash(store: ReturnType<typeof createStore>): string { return store.state().accounts.find(account => account.type === 'cash')!.id; }

const item: WishItem = { id: 'drill', entityId: 'personal', name: 'Cordless drill', costCents: 14999, comment: 'Includes two batteries.' };
const tab: MoneyOwed = { id: 'temporary', entityId: 'personal', name: 'People who owe me', amountCents: 450000, comment: 'Temporary combined tab.', payments: [] };
const payment: OwedPayment = { id: 'first-payment', amountCents: 50000, date: '2026-01-01', comment: 'First repayment.' };

test('wish basket and money owed survive restart while repayments move cash exactly once', t => {
  const { store, path } = setup(t);
  store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 100000, openingDate: '2026-01-01' });
  const before = store.state();
  const createItem: Command = { type: 'save_wish_item', item, expected: null, requestId: 'wish' };
  const createTab: Command = { type: 'save_money_owed', tab, expected: null, requestId: 'tab' };
  store.command(createItem);
  store.command(createTab);
  const pay: Command = { type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: tab, payment, requestId: 'pay' };
  store.command(pay);
  const expected = store.state();
  store.command(createItem);
  store.command(createTab);
  store.command(pay);
  assert.deepEqual(store.state(), expected);
  assert.deepEqual(expected.wishItems, [item]);
  assert.equal(owedPaid(expected.moneyOwed![0]), 50000);
  assert.equal(owedRemaining(expected.moneyOwed![0]), 400000);
  assert.equal(expected.accounts.find(account => account.id === cash(store))!.balanceCents, 50000);
  assert.equal(expected.transactions.length, before.transactions.length + 1);
  assert.equal(summarize(expected).netWorthCents, summarize(before).netWorthCents + 450000);
  assert.equal(summarize(expected).receivablesCents, 400000);
  assert.equal(summarize(expected).availableCents, summarize(before).availableCents + 50000);
  const backup = store.export();
  closeTestResource(store);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  assert.deepEqual(reopened.state().wishItems, expected.wishItems);
  assert.deepEqual(reopened.state().moneyOwed, expected.moneyOwed);
  reopened.restore(backup);
  assert.deepEqual(reopened.state().moneyOwed, expected.moneyOwed);
  const removeItem: Command = { type: 'delete_wish_item', id: item.id, expected: item, requestId: 'delete-wish' };
  assert.throws(() => reopened.command({ type: 'delete_money_owed', id: tab.id, expected: expected.moneyOwed![0], requestId: 'delete-linked-tab' }), /cash repayments/);
  reopened.command({ type: 'remove_owed_payment', id: tab.id, expected: expected.moneyOwed![0], paymentId: payment.id, requestId: 'undo-before-removal' });
  const removeTab: Command = { type: 'delete_money_owed', id: tab.id, expected: reopened.state().moneyOwed![0], requestId: 'delete-tab' };
  reopened.command(removeItem);
  reopened.command(removeTab);
  const removed = reopened.state();
  reopened.command(removeItem);
  reopened.command(removeTab);
  assert.deepEqual(reopened.state(), removed);
  assert.deepEqual(removed.wishItems, []);
  assert.deepEqual(removed.moneyOwed, []);
  assert.deepEqual(removed.accounts, before.accounts);
  assert.equal(removed.transactions.length, before.transactions.length + 2);
  assert.equal(removed.transactions.filter(tx => tx.kind === 'income').length, 0);
});

test('stale wish basket edits, removals and owner moves reject without changing saved items', t => {
  const { store } = setup(t);
  store.command({ type: 'save_wish_item', item, expected: null, requestId: 'wish' });
  const updated = { ...item, costCents: 12999, comment: 'On sale.' };
  store.command({ type: 'save_wish_item', item: updated, expected: item, requestId: 'update' });
  store.command({ type: 'add_entity', name: 'Business', ownershipBps: 10000 });
  const owner = store.state().entities.find(entity => entity.kind === 'business')!.id;
  const before = store.state();
  assert.throws(() => store.command({ type: 'save_wish_item', item, expected: item, requestId: 'stale' }), /changed or was removed/);
  assert.throws(() => store.command({ type: 'delete_wish_item', id: item.id, expected: item, requestId: 'stale-remove' }), /changed or was removed/);
  assert.throws(() => store.command({ type: 'save_wish_item', item, expected: null, requestId: 'duplicate' }), /already exists/);
  assert.throws(() => store.command({ type: 'save_wish_item', item: { ...updated, entityId: owner }, expected: updated, requestId: 'move' }), /cannot move/);
  assert.throws(() => store.command({ type: 'save_wish_item', item: updated, expected: item, requestId: 'wish' }), /request ID was already used/);
  assert.deepEqual(store.state(), before);
  store.command({ type: 'delete_wish_item', id: item.id, expected: updated, requestId: 'remove' });
  assert.throws(() => store.command({ type: 'save_wish_item', item, expected: updated, requestId: 'recreate' }), /changed or was removed/);
  assert.deepEqual(store.state().wishItems, []);
});

test('repayment corrections restore the remaining tab and can be retried once saved', t => {
  const { store } = setup(t);
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  store.command({ type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: tab, payment, requestId: 'pay' });
  const paid = store.state().moneyOwed![0];
  const edited: MoneyOwed = { ...paid, name: 'Alex', amountCents: 440000, comment: 'Corrected original amount.' };
  store.command({ type: 'save_money_owed', tab: edited, expected: paid, requestId: 'edit' });
  assert.equal(owedRemaining(store.state().moneyOwed![0]), 390000);
  assert.equal(store.state().moneyOwed![0].payments[0].amountCents, payment.amountCents);
  assert.equal(store.state().moneyOwed![0].payments[0].cashAccountId, cash(store));
  const correction: Command = { type: 'remove_owed_payment', id: tab.id, expected: edited, paymentId: payment.id, requestId: 'correction' };
  store.command(correction);
  const corrected = store.state();
  store.command(correction);
  assert.deepEqual(store.state(), corrected);
  assert.equal(owedPaid(corrected.moneyOwed![0]), 0);
  assert.equal(owedRemaining(corrected.moneyOwed![0]), 440000);
  store.command({ type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: corrected.moneyOwed![0], payment: { ...payment, id: 'settled', amountCents: 440000 }, requestId: 'settled' });
  assert.equal(owedRemaining(store.state().moneyOwed![0]), 0);
  assert.equal(store.state().accounts[0].balanceCents, 440000);
  assert.equal(store.state().transactions.length, 3);
});

test('stale tabs and payments reject across two database connections', t => {
  const { store, path } = setup(t);
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  const second = trackTestResource(t, createStore(path, 'live'));
  const original = second.state().moneyOwed![0];
  store.command({ type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: original, payment, requestId: 'pay' });
  const before = store.state();
  assert.throws(() => second.command({ type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: original, payment: { ...payment, id: 'second' }, requestId: 'second' }), /changed or was removed/);
  assert.throws(() => second.command({ type: 'save_money_owed', tab: { ...original, amountCents: 500000 }, expected: original, requestId: 'stale-edit' }), /changed or was removed/);
  assert.throws(() => second.command({ type: 'delete_money_owed', id: tab.id, expected: original, requestId: 'stale-delete' }), /changed or was removed/);
  assert.throws(() => second.command({ type: 'remove_owed_payment', id: tab.id, expected: original, paymentId: payment.id, requestId: 'stale-correction' }), /changed or was removed/);
  assert.deepEqual(second.state(), before);
  const current = second.state().moneyOwed![0];
  store.command({ type: 'remove_owed_payment', id: tab.id, expected: current, paymentId: payment.id, requestId: 'undo-before-delete' });
  store.command({ type: 'delete_money_owed', id: tab.id, expected: store.state().moneyOwed![0], requestId: 'delete' });
  assert.throws(() => second.command({ type: 'save_money_owed', tab: current, expected: current, requestId: 'recreate' }), /changed or was removed/);
  assert.deepEqual(store.state().moneyOwed, []);
});

test('tab edits cannot alter repayment history or lower the original amount below repayments', t => {
  const { store } = setup(t);
  assert.throws(() => store.command({ type: 'save_money_owed', tab: { ...tab, payments: [payment] }, expected: null, requestId: 'create-with-payment' }), /Record repayments separately/);
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  store.command({ type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: tab, payment, requestId: 'pay' });
  store.command({ type: 'add_entity', name: 'Business', ownershipBps: 10000 });
  const owner = store.state().entities.find(entity => entity.kind === 'business')!.id;
  const current = store.state().moneyOwed![0];
  const before = store.state();
  assert.throws(() => store.command({ type: 'save_money_owed', tab: { ...current, payments: [] }, expected: current, requestId: 'erase' }), /cannot change repayment history/);
  assert.throws(() => store.command({ type: 'save_money_owed', tab: { ...current, payments: [{ ...payment, comment: 'Tampered comment.' }] }, expected: current, requestId: 'rewrite' }), /cannot change repayment history/);
  assert.throws(() => store.command({ type: 'save_money_owed', tab: { ...current, amountCents: 49999 }, expected: current, requestId: 'lower' }), /less than recorded repayments/);
  assert.throws(() => store.command({ type: 'save_money_owed', tab: { ...current, entityId: owner }, expected: current, requestId: 'move' }), /cannot move/);
  assert.throws(() => store.command({ type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: current, payment, requestId: 'duplicate' }), /repayment already exists/);
  assert.throws(() => store.command({ type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: current, payment: { ...payment, id: 'too-much', amountCents: 400001 }, requestId: 'overpay' }), /cannot exceed the remaining tab/);
  assert.throws(() => store.command({ type: 'remove_owed_payment', id: tab.id, expected: current, paymentId: 'missing', requestId: 'missing' }), /already removed/);
  assert.deepEqual(store.state(), before);
});

test('invalid costs, repayments, dates and commands without request IDs reject atomically', t => {
  const { store } = setup(t);
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  const before = store.state();
  const invalidItems: Partial<WishItem>[] = [{ costCents: -1 }, { costCents: 0.5 }, { costCents: Number.MAX_SAFE_INTEGER }, { name: ' ' }, { comment: 'x'.repeat(2001) }, { entityId: 'missing' }];
  invalidItems.forEach((fields, index) => assert.throws(() => store.command({ type: 'save_wish_item', item: { ...item, ...fields }, expected: null, requestId: `invalid-item-${index}` })));
  const invalidPayments: Partial<OwedPayment>[] = [{ amountCents: 0 }, { amountCents: -1 }, { amountCents: 0.5 }, { amountCents: Number.MAX_SAFE_INTEGER }, { date: '2026-02-30' }, { date: '2199-01-01' }, { id: '' }];
  invalidPayments.forEach((fields, index) => assert.throws(() => store.command({ type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: tab, payment: { ...payment, ...fields }, requestId: `invalid-payment-${index}` })));
  const noRequest = [
    { type: 'save_wish_item', item, expected: null },
    { type: 'delete_wish_item', id: item.id, expected: item },
    { type: 'save_money_owed', tab, expected: null },
    { type: 'delete_money_owed', id: tab.id, expected: tab },
    { type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: tab, payment },
    { type: 'remove_owed_payment', id: tab.id, expected: tab, paymentId: payment.id },
  ];
  noRequest.forEach(command => assert.throws(() => store.command(command as Command), /request ID/));
  assert.deepEqual(store.state(), before);
});

test('legacy databases and backups default to empty lists and export both lists', t => {
  const { store, path } = setup(t);
  const old = store.export();
  delete old.data.wishItems;
  delete old.data.moneyOwed;
  store.restore(old);
  assert.deepEqual(store.state().wishItems, []);
  assert.deepEqual(store.state().moneyOwed, []);
  closeTestResource(store);
  const legacyPath = `${path}.legacy`;
  const database = trackTestResource(t, new DatabaseSync(legacyPath));
  database.exec('CREATE TABLE workspace_state (id INTEGER PRIMARY KEY, workspace TEXT NOT NULL, document TEXT NOT NULL)');
  database.prepare('INSERT INTO workspace_state (id, workspace, document) VALUES (1, ?, ?)').run('live', JSON.stringify(old.data));
  closeTestResource(database);
  const reopened = trackTestResource(t, createStore(legacyPath, 'live'));
  assert.deepEqual(reopened.state().wishItems, []);
  assert.deepEqual(reopened.state().moneyOwed, []);
  const exported = reopened.export();
  assert.deepEqual(exported.data.wishItems, []);
  assert.deepEqual(exported.data.moneyOwed, []);
});

test('restore rejects duplicate records, missing owners and invalid repayment totals without changing data', t => {
  const { store } = setup(t);
  store.command({ type: 'save_wish_item', item, expected: null, requestId: 'wish' });
  store.command({ type: 'save_money_owed', tab, expected: null, requestId: 'tab' });
  store.command({ type: 'record_owed_payment', cashAccountId: cash(store), id: tab.id, expected: tab, payment, requestId: 'pay' });
  const backup = store.export();
  const before = store.state();
  const cases: Array<(copy: typeof backup) => void> = [
    copy => copy.data.wishItems!.push(item),
    copy => copy.data.moneyOwed!.push(tab),
    copy => { copy.data.wishItems![0].entityId = 'missing'; },
    copy => { copy.data.moneyOwed![0].entityId = 'missing'; },
    copy => { copy.data.moneyOwed![0].amountCents = 49999; },
    copy => { copy.data.moneyOwed![0].payments.push(payment); },
    copy => { copy.data.moneyOwed![0].payments[0].amountCents = -1; },
    copy => { copy.data.moneyOwed![0].payments[0].date = '2199-01-01'; },
    copy => { copy.data.wishItems = null as never; },
    copy => { copy.data.moneyOwed = null as never; },
  ];
  for (const alter of cases) {
    const invalid = structuredClone(backup);
    alter(invalid);
    assert.throws(() => store.restore(invalid));
    assert.deepEqual(store.state(), before);
  }
});
