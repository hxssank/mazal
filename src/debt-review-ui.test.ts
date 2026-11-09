import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import { today } from '../shared/analytics.ts';
import { engineFixtureFetch } from './engine-test-fixture.ts';
import type { AppState, Command } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.scrollIntoView = () => {};
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }), configurable: true });
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
const { default: Debts } = await import('./features/debts/Debts.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
let engineState: AppState | undefined;
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  window.history.replaceState(null, '', '/');
  engineState = undefined;
  globalThis.fetch = engineFixtureFetch(() => engineState);
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });

function dateAfter(days: number): string {
  const date = new Date(`${today()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function fixture(): AppState {
  const base = { entityId: 'me', currency: 'CAD' as const, reconciledAt: null };
  return {
    workspace: 'live', revision: 1, entities: [{ id: 'me', name: 'Personal', kind: 'personal', ownershipBps: 10000 }],
    accounts: [
      { ...base, id: 'bank', name: 'Bank', type: 'cash', balanceCents: 100000 },
      { ...base, id: 'card', name: 'Everyday card', type: 'debt', balanceCents: 100000, debtTerms: { aprPercent: 18, rateConfirmed: true, minimumPaymentCents: 10000, paymentDueDate: dateAfter(2), notes: '' } },
      { ...base, id: 'loan', name: 'Larger loan', type: 'debt', balanceCents: 500000, debtTerms: { aprPercent: 6, rateConfirmed: true, minimumPaymentCents: 20000, paymentDueDate: dateAfter(-2), notes: '' } },
      { ...base, id: 'unknown', name: 'Terms to confirm', type: 'debt', balanceCents: 200000 },
      { ...base, id: 'deferred', name: 'Student loan', type: 'debt', balanceCents: 800000, debtTerms: { aprPercent: 0, rateConfirmed: true, minimumPaymentCents: null, repaymentStatus: 'in_study', repaymentStatusSource: 'owner', notes: '' } },
      { ...base, id: 'paid', name: 'Paid card', type: 'debt', balanceCents: 0 },
    ],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}

async function render(state = fixture(), commands: Command[] = [], readOnly = false) {
  engineState = state;
  await act(async () => root.render(createElement(Debts, { state, scope: 'me', readOnly, onOpen: () => {}, onCommand: async command => { commands.push(command); } })));
}

function button(label: string, parent: Element = container): HTMLButtonElement {
  const item = [...parent.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
  assert.ok(item, `Button ${label} exists`);
  return item;
}

function filter(label: string): HTMLButtonElement {
  const item = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Filter debt accounts"] button')].find(element => element.textContent?.startsWith(label));
  assert.ok(item, `Filter ${label} exists`);
  return item;
}

const accountNames = () => [...container.querySelectorAll('.debt-account-choice .debt-map-name > strong')].map(item => item.textContent);
const accountButton = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('.debt-account-choice')].find(item => item.querySelector('.debt-map-name > strong')?.textContent === name)!;

async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  assert.ok(input, `Input ${label} exists`);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

async function nextFrame() { await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))); }

test('debt analysis is collapsed while account warnings and the linked calculator remain visible', async () => {
  window.history.replaceState(null, '', '/#debts?record=unknown');
  await render();
  await nextFrame();
  const analysis = container.querySelector<HTMLDetailsElement>('.debt-planning-disclosure')!;
  assert.equal(analysis.open, false);
  const calculator = container.querySelector('[aria-label="Terms to confirm payoff calculator"]')!;
  assert.ok(calculator);
  assert.equal(calculator.closest('.debt-planning-disclosure'), null);
  assert.equal(document.activeElement, calculator);
  assert.match(container.querySelector('.debt-review-account-check')!.textContent!, /Confirm the payment amount/);
  assert.equal(button('Add debt').closest('details'), null);
  await act(async () => analysis.querySelector('summary')!.click());
  assert.equal(analysis.open, true);
  assert.ok(analysis.querySelector('[aria-label="Extra payment priority"]'));
});

test('weekly shortcuts filter known dates and missing details without inventing a payment', async () => {
  const state = fixture();
  const before = structuredClone(state);
  const commands: Command[] = [];
  await render(state, commands);
  const shortcuts = container.querySelector('[aria-label="Debt review shortcuts"]')!;
  assert.match(shortcuts.textContent!, /1 payment date/);
  assert.match(shortcuts.textContent!, /2 accounts to check/);
  assert.match(shortcuts.textContent!, /1 deferred/);
  await act(async () => shortcuts.querySelector<HTMLButtonElement>('button')!.click());
  assert.equal(filter('Next 7 days').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(accountNames(), ['Everyday card']);
  await act(async () => filter('Check details').click());
  assert.deepEqual(new Set(accountNames()), new Set(['Larger loan', 'Terms to confirm']));
  assert.match(accountButton('Larger loan').textContent!, /Past date\. Check the latest statement/);
  assert.match(accountButton('Terms to confirm').textContent!, /Confirm the payment amount/);
  assert.doesNotMatch(accountButton('Terms to confirm').textContent!, /Next date/);
  assert.deepEqual(state, before);
  assert.equal(commands.length, 0);
});

test('payment outlook excludes unknown and deferred amounts and opens the past-date account for review', async () => {
  const state = fixture();
  state.accounts.find(account => account.id === 'unknown')!.debtTerms = { aprPercent: 10, rateConfirmed: true, minimumPaymentCents: null, paymentDueDate: dateAfter(3), notes: '' };
  state.accounts.find(account => account.id === 'deferred')!.debtTerms!.paymentDueDate = dateAfter(1);
  const before = structuredClone(state);
  const commands: Command[] = [];
  await render(state, commands);
  const outlook = container.querySelector('[aria-label="Payment outlook"]')!;
  assert.equal(outlook.querySelector('.debt-weekly-total > strong')!.textContent, '$100');
  assert.match(outlook.textContent!, /1 of 2 payment amounts recorded\. Missing amounts are excluded/);
  assert.match(outlook.querySelector('button')!.textContent!, /Check a past payment dateLarger loan/);
  await act(async () => outlook.querySelector<HTMLButtonElement>('button')!.click());
  await nextFrame();
  assert.ok(container.querySelector('[aria-label="Larger loan payoff calculator"]'));
  assert.deepEqual(state, before);
  assert.equal(commands.length, 0);
});

test('search and status filters keep the selected scenario and its draft until another account is chosen', async () => {
  await render();
  await act(async () => container.querySelector<HTMLDetailsElement>('#debt-account-details')!.querySelector('summary')!.click());
  await fill('Debt scenario APR', '19');
  await fill('Search debt accounts', 'larger');
  assert.deepEqual(accountNames(), ['Larger loan']);
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Debt scenario APR"]')!.value, '19');
  assert.equal(container.querySelector('dialog'), null);
  assert.ok(container.querySelector('[aria-label="Everyday card payoff calculator"]'));
  assert.match(container.querySelector('.debt-review-selection-note')!.textContent!, /Your review stays open/);
  await act(async () => accountButton('Larger loan').click());
  assert.ok(document.querySelector('dialog.draft-discard-dialog'));
  await act(async () => button('Keep editing', document.querySelector('dialog')!).click());
  assert.ok(container.querySelector('[aria-label="Everyday card payoff calculator"]'));
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Debt scenario APR"]')!.value, '19');
  await act(async () => button('Show account').click());
  await nextFrame();
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Search debt accounts"]')!.value, '');
  assert.equal(document.activeElement, accountButton('Everyday card'));
});

test('an unmatched search exposes a reset that restores accounts and input focus', async () => {
  await render();
  await fill('Search debt accounts', 'no such account');
  assert.deepEqual(accountNames(), []);
  assert.match(container.querySelector('.debt-review-no-matches')!.textContent!, /No accounts match your search/);
  await act(async () => button('Show open accounts').click());
  assert.equal(accountNames().length, 4);
  assert.equal(document.activeElement, container.querySelector('[aria-label="Search debt accounts"]'));
  assert.equal(filter('Open accounts').getAttribute('aria-pressed'), 'true');
});

test('sorting changes the account list without replacing the selected account', async () => {
  await render();
  assert.equal(accountNames()[0], 'Everyday card');
  const sort = container.querySelector<HTMLSelectElement>('[aria-label="Sort debt accounts"]')!;
  await act(async () => { sort.value = 'balance'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(accountNames()[0], 'Larger loan');
  assert.ok(container.querySelector('[aria-label="Everyday card payoff calculator"]'));
  await act(async () => { sort.value = 'date'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(accountNames()[0], 'Larger loan');
  assert.equal(accountNames().at(-1), 'Terms to confirm');
});

test('deferred and paid-off filters expose their accounts and selection focuses the correct detail', async () => {
  await render();
  await act(async () => filter('Deferred').click());
  assert.deepEqual(accountNames(), ['Student loan']);
  await act(async () => accountButton('Student loan').click());
  await nextFrame();
  assert.ok(container.querySelector('[aria-label="Student loan payoff calculator"]'));
  assert.equal(document.activeElement, container.querySelector('#debt-payoff'));
  await act(async () => filter('Paid off').click());
  assert.deepEqual(accountNames(), ['Paid card']);
  await act(async () => accountButton('Paid card').click());
  await nextFrame();
  assert.ok(container.querySelector('[aria-label="Paid card payoff calculator"]'));
  assert.equal([...container.querySelectorAll('button')].some(item => item.textContent === 'Record payment'), false);
});

test('review details opens the selected account terms while read-only review offers no writes', async () => {
  const commands: Command[] = [];
  await render(fixture(), commands, true);
  await act(async () => accountButton('Terms to confirm').click());
  await nextFrame();
  assert.equal(container.querySelector<HTMLDetailsElement>('#debt-account-details')!.open, false);
  await act(async () => button('Review details').click());
  await nextFrame();
  assert.equal(container.querySelector<HTMLDetailsElement>('#debt-account-details')!.open, true);
  assert.equal([...container.querySelectorAll('button')].some(item => /Manage account|Record payment|Save details|Update balance/.test(item.textContent!)), false);
  assert.equal(commands.length, 0);
});
