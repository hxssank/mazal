import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import { engineFixtureFetch } from './engine-test-fixture.ts';
import type { AppState, TrackedAsset } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });
Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
let scrolled: HTMLElement | null = null;
HTMLElement.prototype.scrollIntoView = function () { scrolled = this; };
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const extension of ['.ts', '.tsx']) {
        const url = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(url)) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Assets } = await import('./features/assets/Assets.tsx');
const { default: Investments } = await import('./features/investments/Investments.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
let engineState: AppState | undefined;
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  localStorage.clear();
  engineState = undefined;
  scrolled = null;
  globalThis.fetch = engineFixtureFetch(() => engineState);
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });

function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [
    { id: 'wallet', entityId: 'personal', name: 'Wallet', type: 'investment', currency: 'CAD', balanceCents: 30000, reconciledAt: null },
    { id: 'broker', entityId: 'personal', name: 'Brokerage', type: 'investment', currency: 'CAD', balanceCents: 10000, reconciledAt: null },
  ], transactions: [], obligations: [], reserves: [], positions: [{ id: 'sol', accountId: 'wallet', liquidSol: '1', stakedSol: '2', rewardsSol: '0', costBasisCents: 25000, priceCents: 10000, priceDate: '2026-09-17' }], audit: [], lastBackupAt: null };
}
function item(id: string, overrides: Partial<TrackedAsset> = {}): TrackedAsset {
  return { id, entityId: 'personal', name: id, category: 'Tools', purchaseDate: null, costCents: null, estimatedValueCents: null, status: 'owned', soldDate: null, saleCents: null, feesCents: 0, notes: '', ...overrides };
}
function byText(text: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!; }
function itemNames() { return [...container.querySelectorAll('.portfolio-asset-title h3')].map(node => node.textContent); }
async function renderInvestments(state = fixture()) {
  engineState = state;
  await act(async () => root.render(createElement(Investments, { state, readOnly: false, onOpen: () => {}, onAddAccount: () => {}, onCommand: async () => {} })));
}

test('item record filters distinguish unknown values from zero and include missing sale costs', async () => {
  const state = fixture();
  state.assets = [item('No estimate', { costCents: 2500 }), item('No cost', { category: 'Audio', estimatedValueCents: 2000 }), item('Confirmed zero', { costCents: 0, estimatedValueCents: 0 }), item('Past sale', { status: 'sold', soldDate: '2026-09-01', saleCents: 1000 })];
  const original = structuredClone(state);
  await act(async () => root.render(createElement(Assets, { state, readOnly: true, onOpen: () => {}, onCommand: async () => {} })));
  const review = container.querySelector('[aria-label="Review item records"]')!;
  assert.match(review.textContent!, /Resale estimates recorded2 \/ 3 held items/);
  const buttons = review.querySelectorAll<HTMLButtonElement>('button');
  assert.match(buttons[0].textContent!, /Missing estimates1/);
  assert.match(buttons[1].textContent!, /Missing purchase costs2/);
  await act(async () => buttons[0].click());
  assert.deepEqual(itemNames(), ['No estimate']);
  await act(async () => buttons[1].click());
  assert.deepEqual(itemNames().sort(), ['No cost', 'Past sale']);
  const category = container.querySelector<HTMLSelectElement>('[aria-label="Filter item category"]')!;
  await act(async () => { category.value = 'Audio'; category.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.deepEqual(itemNames(), ['No cost']);
  assert.match(container.querySelector('.assets-results')!.textContent!, /1 item missing a purchase cost in Audio/);
  await act(async () => byText('Show all items').click());
  assert.equal(itemNames().length, 4);
  assert.equal(category.value, '');
  assert.equal(document.activeElement, container.querySelector('.portfolio-status-filters button'));
  assert.deepEqual(state, original);
});

test('item filtering leaves an open editor and its unsaved values mounted', async () => {
  const state = fixture();
  state.assets = [item('No estimate', { costCents: 2500 }), item('No cost', { estimatedValueCents: 2000 })];
  await act(async () => root.render(createElement(Assets, { state, readOnly: false, onOpen: () => {}, onCommand: async () => {} })));
  await act(async () => byText('Edit item').click());
  const dialog = container.querySelector<HTMLDialogElement>('dialog')!;
  const field = dialog.querySelector<HTMLInputElement>('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Unsaved name'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => container.querySelector<HTMLButtonElement>('.holdings-review-action')!.click());
  assert.equal(container.querySelector('dialog'), dialog);
  assert.equal(field.value, 'Unsaved name');
  assert.equal(dialog.open, true);
});

test('asset overview preserves missing prices and opens the related records without changing data', async () => {
  const state = fixture();
  state.assets = [item('Unvalued'), item('Valued', { estimatedValueCents: 8000 }), item('Sold', { status: 'sold', estimatedValueCents: 50000, saleCents: 20000 }), item('Business', { entityId: 'business', estimatedValueCents: 100000 })];
  state.wishItems = [{ id: 'wish', entityId: 'personal', name: 'New tool', costCents: null, comment: '' }];
  state.moneyOwed = [{ id: 'alex', entityId: 'personal', name: 'Alex', amountCents: 10000, comment: '', payments: [{ id: 'paid', amountCents: 2500, date: '2026-09-17', comment: '' }] }];
  const before = structuredClone(state);
  await act(async () => root.render(createElement(Assets, { state, readOnly: true, onOpen: () => {}, onCommand: async () => { throw new Error('Read-only review must not write'); } })));
  const overview = container.querySelector('[aria-label="Assets at a glance"]')!;
  assert.equal(overview.querySelector('.assets-glance-value > strong')!.textContent, '$80');
  assert.match(overview.textContent!, /1 of 2 held items valued/);
  const actions = overview.querySelectorAll<HTMLButtonElement>('button');
  assert.equal(actions[0].querySelector('strong')!.textContent, '$75');
  assert.equal(actions[1].querySelector('strong')!.textContent, 'Prices needed');
  for (const action of actions) {
    await act(async () => action.click());
    await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())));
    const details = document.getElementById(action.getAttribute('aria-controls')!) as HTMLDetailsElement;
    assert.equal(details.open, true);
    assert.equal(document.activeElement, details.querySelector('summary'));
  }
  assert.deepEqual(state, before);
});

test('allocation starts collapsed while unchecked balances stay visible and review focuses the selected holding', async () => {
  await renderInvestments();
  const disclosure = container.querySelector<HTMLDetailsElement>('.holdings-allocation-disclosure')!;
  assert.equal(disclosure.open, false);
  const warning = container.querySelector('.holdings-balance-check')!;
  assert.match(warning.textContent!, /1 balance has no recorded check/);
  assert.equal(warning.closest('details'), null);
  await act(async () => byText('Check balances').click());
  assert.equal(document.activeElement, container.querySelector('[id$="-other-holdings"]'));
  await act(async () => disclosure.querySelector('summary')!.click());
  assert.equal(disclosure.open, true);
  const choices = container.querySelectorAll<HTMLButtonElement>('.holdings-allocation-option');
  assert.match(choices[0].textContent!, /SOL accounts75%\$3001 recorded account/);
  assert.match(choices[1].textContent!, /Other investments25%\$1001 recorded account/);
  assert.match(container.querySelector('.holdings-review-next')!.textContent!, /Earliest saved price: Sep 17, 2026/);
  await act(async () => choices[1].click());
  assert.equal(choices[1].getAttribute('aria-pressed'), 'true');
  assert.match(container.querySelector('.holdings-review-next')!.textContent!, /Recorded account balances/);
  await act(async () => byText('Review account balances').click());
  assert.equal(document.activeElement, container.querySelector('[id$="-other-holdings"]'));
  assert.equal(scrolled, document.activeElement);
});

test('recorded allocation and price date stay visible without opening the details', async () => {
  await renderInvestments();
  const mix = container.querySelector('[aria-label="Recorded investment mix"]')!;
  assert.equal(mix.closest('details'), null);
  assert.equal(mix.querySelector('[role="img"]')!.getAttribute('aria-label'), 'SOL 75%, other investments 25%');
  const price = container.querySelector('.investment-price-context')!;
  assert.equal(price.closest('details'), null);
  assert.match(price.textContent!, /Oldest saved SOL price · Sep 17, 2026/);
  await act(async () => byText('Review prices').click());
  assert.equal(document.activeElement, container.querySelector('[id$="-sol-holdings"]'));
});

test('allocation selection preserves a dirty SOL activity form', async () => {
  await renderInvestments();
  await act(async () => container.querySelector<HTMLDetailsElement>('.holdings-allocation-disclosure')!.querySelector('summary')!.click());
  await act(async () => byText('Record activity').click());
  const form = container.querySelector('.investment-history-form')!;
  const quantity = form.querySelector<HTMLInputElement>('input[id$="-quantity"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(quantity, '0.75'); quantity.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => container.querySelector<HTMLButtonElement>('.holdings-allocation-option.is-other')!.click());
  assert.equal(container.querySelector('.investment-history-form'), form);
  assert.equal(quantity.value, '0.75');
  assert.equal(form.closest('[hidden]'), null);
});

test('accounts without SOL keep the first holding action in a compact disclosure and omit it when read-only', async () => {
  const state = fixture();
  state.positions = [];
  engineState = state;
  const opened: string[] = [];
  for (const readOnly of [false, true]) {
    await act(async () => root.render(createElement(Investments, { state, readOnly, onOpen: kind => opened.push(kind), onAddAccount: () => {}, onCommand: async () => {} })));
    assert.equal(container.querySelector('[id$="-sol-holdings"]'), null);
    assert.ok(container.querySelector('.portfolio-holdings-grid.single-holding-group'));
    const add = container.querySelector<HTMLDetailsElement>('.holdings-add-sol');
    if (readOnly) assert.equal(add, null);
    else {
      assert.ok(add);
      assert.equal(add.open, false);
      assert.equal(add.querySelector('summary')!.textContent, 'Add a Solana holding');
      await act(async () => add.querySelector('summary')!.click());
      await act(async () => byText('Add SOL').click());
      assert.deepEqual(opened, ['sol']);
    }
  }
});

test('negative balances suppress the share chart without hiding the recorded amount', async () => {
  const state = fixture();
  state.accounts[1].balanceCents = -5000;
  await renderInvestments(state);
  assert.equal(container.querySelector('.holdings-allocation-rail'), null);
  assert.match(container.querySelector('.holdings-allocation-option.is-other')!.textContent!, /-\$50/);
  assert.doesNotMatch(container.querySelector('.holdings-allocation-options')!.textContent!, /%|NaN|Infinity/);
});
