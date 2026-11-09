import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { summarize } from '../shared/analytics.ts';
import type { TrackedAsset, WishItem } from '../shared/types.ts';
import { createStore } from './store.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-asset-unknowns-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}

const asset: TrackedAsset = { id: 'printer', entityId: 'personal', name: 'Printer', category: 'Tools', purchaseDate: null, costCents: 95000, estimatedValueCents: null, status: 'owned', soldDate: null, saleCents: null, feesCents: 0, notes: 'Purchase cost confirmed. Purchase date and resale value are unknown.' };
const wish: WishItem = { id: 'glasses', entityId: 'personal', name: 'Glasses', costCents: null, priority: 'essential', comment: 'Price not confirmed.' };

test('unknown purchase cost survives restart and backup while resale value counts without posting cash', t => {
  const { store, path } = setup(t);
  const before = store.state();
  const laptop: TrackedAsset = { ...asset, id: 'laptop', name: 'Example laptop', costCents: null, estimatedValueCents: 150000 };
  store.command({ type: 'save_asset', asset: laptop });
  const after = store.state();
  assert.equal(after.assets![0].costCents, null);
  assert.equal(summarize(after).netWorthCents, summarize(before).netWorthCents + 150000);
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(after.transactions, before.transactions);
  for (const costCents of [undefined, -1, 0.5]) assert.throws(() => store.command({ type: 'save_asset', asset: { ...laptop, costCents } } as unknown as Parameters<typeof store.command>[0]), /Purchase cost/);
  const backup = store.export();
  store.close();
  const reopened = createStore(path, 'live');
  t.after(() => reopened.close());
  assert.deepEqual(reopened.state().assets, [laptop]);
  reopened.restore(backup);
  assert.deepEqual(reopened.state().assets, [laptop]);
  reopened.command({ type: 'save_asset', asset: { ...laptop, costCents: 0 } });
  assert.equal(reopened.state().assets![0].costCents, 0);
  assert.equal(summarize(reopened.state()).netWorthCents, summarize(after).netWorthCents);
});

test('unknown purchase date, resale value and wish price survive save, restart and backup restore', t => {
  const { store, path } = setup(t);
  store.command({ type: 'save_asset', asset });
  store.command({ type: 'save_wish_item', item: wish, expected: null, requestId: 'wish' });
  const zeroAsset = { ...asset, id: 'zero-value', estimatedValueCents: 0, purchaseDate: '2026-01-01' };
  const zeroWish = { ...wish, id: 'free-item', costCents: 0, priority: 'optional' as const };
  const legacyWish = { id: 'unassigned', entityId: 'personal', name: 'Undecided', costCents: 1000, comment: '' };
  store.command({ type: 'save_asset', asset: zeroAsset });
  store.command({ type: 'save_wish_item', item: zeroWish, expected: null, requestId: 'zero-wish' });
  store.command({ type: 'save_wish_item', item: legacyWish, expected: null, requestId: 'legacy-wish' });
  const backup = store.export();
  store.close();
  const reopened = createStore(path, 'live');
  t.after(() => reopened.close());
  assert.deepEqual(reopened.state().assets, [asset, zeroAsset]);
  assert.deepEqual(reopened.state().wishItems, [wish, zeroWish, legacyWish]);
  reopened.restore(backup);
  assert.deepEqual(reopened.state().assets, [asset, zeroAsset]);
  assert.deepEqual(reopened.state().wishItems, [wish, zeroWish, legacyWish]);
  assert.equal(Object.hasOwn(reopened.state().wishItems![2], 'priority'), false);
});

test('unknown resale value adds no net worth and saving inventory does not post purchase cash or alter source facts', t => {
  const { store } = setup(t);
  store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 200000, openingDate: '2026-01-01' });
  const source = store.export();
  source.data.sourceFacts = [{ id: 'receipt', label: 'Receipt amount', value: '$950', asOf: null, sourceFile: 'receipt.pdf', note: 'Original source amount. No resale estimate.' }];
  store.restore(source);
  const before = store.state();
  store.command({ type: 'save_asset', asset });
  store.command({ type: 'save_asset', asset: { ...asset, id: 'known', costCents: 100000, estimatedValueCents: 30000, feesCents: 5000 } });
  store.command({ type: 'save_asset', asset: { ...asset, id: 'zero', estimatedValueCents: 0 } });
  store.command({ type: 'save_wish_item', item: wish, expected: null, requestId: 'wish' });
  const after = store.state();
  assert.equal(summarize(after).physicalAssetsCents, 25000);
  assert.equal(summarize(after).netWorthCents, summarize(before).netWorthCents + 25000);
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.statements, before.statements);
  assert.deepEqual(after.importBatches, before.importBatches);
  assert.deepEqual(after.sourceFacts, before.sourceFacts);
});

test('wish priority edits preserve null prices and stale or invalid changes reject atomically', t => {
  const { store } = setup(t);
  store.command({ type: 'save_wish_item', item: wish, expected: null, requestId: 'wish' });
  const optional = { ...wish, priority: 'optional' as const };
  store.command({ type: 'save_wish_item', item: optional, expected: wish, requestId: 'optional' });
  const before = store.state();
  assert.throws(() => store.command({ type: 'save_wish_item', item: wish, expected: wish, requestId: 'stale' }), /changed or was removed/);
  for (const priority of ['urgent', '', null]) assert.throws(() => store.command({ type: 'save_wish_item', item: { ...optional, priority } as never, expected: optional, requestId: `invalid-${priority}` }), /priority/);
  assert.deepEqual(store.state(), before);
  const { priority: _priority, ...unassigned } = optional;
  store.command({ type: 'save_wish_item', item: unassigned, expected: optional, requestId: 'unassigned' });
  assert.deepEqual(store.state().wishItems, [unassigned]);
});

test('a missing purchase date permits a dated sale without weakening sale validation or cash reversal', t => {
  const { store } = setup(t);
  const cashAccountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  store.command({ type: 'save_asset', asset });
  const before = store.state();
  for (const soldDate of [null, '2026-02-30', '2199-01-01']) assert.throws(() => store.command({ type: 'record_asset_sale', asset: { ...asset, status: 'sold', soldDate, saleCents: 50000 }, expected: asset, cashAccountId, requestId: `invalid-sale-${soldDate}` }), /date|future/);
  assert.deepEqual(store.state(), before);
  const sold = store.command({ type: 'record_asset_sale', asset: { ...asset, status: 'sold', soldDate: '2026-01-10', saleCents: 50000, feesCents: 1000 }, expected: asset, cashAccountId, requestId: 'sale' });
  assert.equal(sold.accounts[0].balanceCents, 59000);
  assert.equal(sold.assets![0].purchaseDate, null);
  assert.equal(sold.assets![0].estimatedValueCents, null);
  store.command({ type: 'undo_asset_sale', id: asset.id, expected: sold.assets![0], requestId: 'undo' });
  assert.equal(store.state().accounts[0].balanceCents, 10000);
  assert.deepEqual(store.state().assets, [asset]);
});
