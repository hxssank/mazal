import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppState } from './types.ts';
import { summarize } from './analytics.ts';
import { displayNetWorth } from './net-worth.ts';

function fixture(): AppState {
  return {
    workspace: 'live', revision: 1,
    entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'business', name: 'Business', kind: 'business', ownershipBps: 5000 }],
    accounts: [
      { id: 'cash', entityId: 'personal', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 1000000, reconciledAt: null },
      { id: 'osap', entityId: 'personal', name: 'OSAP', type: 'debt', currency: 'CAD', balanceCents: 500000, reconciledAt: null },
      { id: 'card', entityId: 'personal', name: 'Card', type: 'debt', currency: 'CAD', balanceCents: 100000, reconciledAt: null },
      { id: 'business-debt', entityId: 'business', name: 'Vendor', type: 'payable', currency: 'CAD', balanceCents: 20001, reconciledAt: null },
    ],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

test('the default view includes every saved account and excludes no liabilities', () => {
  const state = fixture();
  const summary = summarize(state);
  const display = displayNetWorth(state, summary);
  assert.equal(display.assetsCents, summary.assetsCents);
  assert.equal(display.liabilitiesCents, summary.liabilitiesCents);
  assert.equal(display.netWorthCents, summary.netWorthCents);
  assert.deepEqual(display.excludedAccounts, []);
});

test('hiding OSAP changes displayed net worth without changing saved balances or the full summary', () => {
  const state = fixture();
  state.accounts[1].excludeFromNetWorth = true;
  const summary = summarize(state, 'personal');
  const original = structuredClone({ state, summary });
  const display = displayNetWorth(state, summary, 'personal');
  assert.equal(display.assetsCents, 1000000);
  assert.equal(display.liabilitiesCents, 100000);
  assert.equal(display.netWorthCents, 900000);
  assert.deepEqual(display.excludedAccounts.map(account => account.id), ['osap']);
  assert.equal(summary.netWorthCents, 400000);
  assert.deepEqual({ state, summary }, original);
});

test('exclusions use rounded ownership shares across entities and full balances in one entity', () => {
  const state = fixture();
  state.accounts[3].excludeFromNetWorth = true;
  const all = displayNetWorth(state, summarize(state));
  assert.equal(all.liabilitiesCents, 600000);
  assert.equal(all.netWorthCents, 400000);
  assert.equal(summarize(state).liabilitiesCents - all.liabilitiesCents, 10001);
  const business = displayNetWorth(state, summarize(state, 'business'), 'business');
  assert.equal(business.liabilitiesCents, 0);
  assert.equal(business.netWorthCents, 0);
  const personal = displayNetWorth(state, summarize(state, 'personal'), 'personal');
  assert.deepEqual(personal.excludedAccounts, []);
  assert.equal(personal.liabilitiesCents, 600000);
});

test('excluding a credit balance removes its signed contribution without creating debt', () => {
  const state = fixture();
  state.accounts[3].balanceCents = -20001;
  state.accounts[3].excludeFromNetWorth = true;
  const summary = summarize(state);
  const display = displayNetWorth(state, summary);
  assert.equal(summary.liabilitiesCents, 589999);
  assert.equal(display.liabilitiesCents, 600000);
  assert.equal(display.netWorthCents, summary.netWorthCents - 10001);
});

test('excluded asset accounts also leave the net worth equation and asset breakdown', () => {
  const state = fixture();
  state.accounts.push(
    { id: 'investment', entityId: 'personal', name: 'Investments', type: 'investment', currency: 'CAD', balanceCents: 80000, reconciledAt: null, excludeFromNetWorth: true },
    { id: 'receivable', entityId: 'personal', name: 'Receivable', type: 'receivable', currency: 'CAD', balanceCents: 600000, reconciledAt: null, excludeFromNetWorth: true },
  );
  const summary = summarize(state, 'personal');
  const display = displayNetWorth(state, summary, 'personal');
  assert.equal(display.assetsCents, 1000000);
  assert.equal(display.netWorthCents, 400000);
  assert.equal(display.investmentsCents, 0);
  assert.equal(display.trackedAssetsCents, 0);
  assert.equal(summary.receivablesCents, 600000);
  assert.equal(summary.investmentsCents, 80000);
  assert.equal(summary.cashCents, 1000000);
});
