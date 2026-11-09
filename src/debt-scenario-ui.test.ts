import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import { engineFixtureFetch } from './engine-test-fixture.ts';
import type { AppState, Command } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.scrollIntoView = () => {};
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
const { createElement: reactCreateElement, act } = await import('react');
let engineState: AppState | undefined;
const createElement = ((type: unknown, props?: { state?: AppState }, ...children: unknown[]) => {
  if (props?.state) engineState = props.state;
  return reactCreateElement(type as never, props as never, ...children as never[]);
}) as typeof reactCreateElement;
const { createRoot } = await import('react-dom/client');
const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
const { default: DebtScenario } = await import('./features/debts/DebtScenario.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
beforeEach(async () => { engineState = undefined; globalThis.fetch = engineFixtureFetch(() => engineState); await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });

function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'loan', entityId: 'personal', name: 'Loan', type: 'debt', currency: 'CAD', balanceCents: 100000, reconciledAt: null, debtTerms: { aprPercent: 12, rateConfirmed: true, minimumPaymentCents: 10000, repaymentKind: 'fixed', notes: '' } }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
function button(label: string): HTMLButtonElement {
  const item = [...container.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
  assert.ok(item, `Button ${label} exists`);
  return item;
}
async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  assert.ok(input);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

test('extra payments change the visible payoff comparison while account details stay collapsed and records stay unchanged', async () => {
  const state = fixture();
  const original = structuredClone(state);
  const commands: Command[] = [];
  await act(async () => root.render(createElement(DebtScenario, { state, loan: state.accounts[0], readOnly: false, onOpen: () => {}, onCommand: async command => { commands.push(command); } })));
  const details = container.querySelector<HTMLDetailsElement>('#debt-account-details')!;
  assert.equal(details.open, false);
  assert.ok(details.contains(container.querySelector('[aria-label="Debt scenario APR"]')));
  assert.equal(container.querySelector('input')?.getAttribute('aria-label'), 'Extra monthly payment');
  const before = [...container.querySelectorAll('.debt-comparison-dates strong')].map(item => item.textContent);
  assert.equal(before.length, 1);
  assert.doesNotMatch(container.querySelector('.debt-comparison-dates')!.textContent!, /With \$0 extra/);
  assert.deepEqual([...container.querySelectorAll('.debt-curve-value')].map(item => item.textContent), ['$1,000', '$0']);
  await act(async () => button('+$100').click());
  const after = [...container.querySelectorAll('.debt-comparison-dates strong')].map(item => item.textContent);
  assert.equal(after[0], before[0]);
  assert.notEqual(after[0], after[1]);
  assert.match(container.querySelector('.debt-comparison-savings')!.textContent!, /Interest saved/);
  assert.match(container.querySelector('.debt-payoff-curve svg')!.getAttribute('aria-label')!, /Debt clears in 6 months, compared with 11 months/);
  assert.match(container.querySelector('.debt-curve-legend')!.textContent!, /Saved payment/);
  assert.equal(details.open, false);
  assert.equal(commands.length, 0);
  assert.deepEqual(state, original);
});

test('missing terms show no payoff date and both review actions open account details', async () => {
  const state = fixture();
  state.accounts[0].debtTerms = { aprPercent: null, minimumPaymentCents: null, rateConfirmed: false, notes: '' };
  const render = (reviewRequest = 0) => root.render(createElement(DebtScenario, { state, loan: state.accounts[0], readOnly: false, reviewRequest, onOpen: () => {}, onCommand: async () => {} }));
  await act(async () => render());
  const details = container.querySelector<HTMLDetailsElement>('#debt-account-details')!;
  assert.equal(details.open, false);
  assert.equal(container.querySelector('.debt-comparison-dates'), null);
  assert.equal(container.querySelector('[aria-label="Extra monthly payment"]'), null);
  await act(async () => button('Add missing details').click());
  assert.equal(details.open, true);
  details.open = false;
  await act(async () => render(1));
  assert.equal(details.open, true);
});

test('read-only scenarios allow extra payment previews but have no save or balance mutation control', async () => {
  const state = fixture();
  let commands = 0;
  await act(async () => root.render(createElement(DebtScenario, { state, loan: state.accounts[0], readOnly: true, onOpen: () => { commands++; }, onCommand: async () => { commands++; } })));
  await act(async () => button('+$250').click());
  assert.match(container.querySelector('.debt-comparison')!.textContent!, /With \$250 extra/);
  assert.equal([...container.querySelectorAll('button')].some(item => /Save details|Update balance/.test(item.textContent!)), false);
  assert.equal(commands, 0);
});

test('deferred loans need a voluntary amount and do not save it as their recorded minimum', async () => {
  const state = fixture();
  state.accounts[0].name = 'OSAP';
  state.accounts[0].debtTerms = { ...state.accounts[0].debtTerms!, repaymentStatus: 'in_study', repaymentStatusSource: 'owner' };
  const commands: Command[] = [];
  await act(async () => root.render(createElement(DebtScenario, { state, loan: state.accounts[0], readOnly: false, onOpen: () => {}, onCommand: async command => { commands.push(command); } })));
  assert.equal(container.querySelector('.debt-comparison-dates'), null);
  assert.match(container.querySelector('.debt-inputs-needed')!.textContent!, /No required-payment payoff date/);
  await act(async () => button('Add missing details').click());
  await fill('Debt scenario monthly payment', '250');
  assert.match(container.querySelector('.debt-comparison')!.textContent!, /Voluntary amount/);
  assert.equal(commands.length, 0);
  await fill('Debt scenario APR', '11');
  await act(async () => button('Save details').click());
  assert.equal(commands.length, 1);
  assert.ok(commands[0].type === 'set_debt_terms');
  assert.equal(commands[0].terms.minimumPaymentCents, 10000);
});


test('valid payoff inputs show calculation progress while an updated response is pending', async () => {
  const state = fixture();
  const fixtureFetch = globalThis.fetch;
  let calls = 0;
  let complete!: () => Promise<void>;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (calls === 2) return new Promise<Response>(resolve => { complete = async () => resolve(await fixtureFetch(url, init)); });
    return fixtureFetch(url, init);
  };
  await act(async () => root.render(createElement(DebtScenario, { state, loan: state.accounts[0], readOnly: false, onOpen: () => {}, onCommand: async () => {} })));
  assert.ok(container.querySelector('.debt-comparison-dates'));
  await act(async () => button('+$100').click());
  const comparison = container.querySelector('.debt-comparison')!;
  assert.match(comparison.querySelector('[role="status"]')!.textContent!, /Calculating from current records/);
  assert.equal(comparison.querySelector('.debt-comparison-dates'), null);
  assert.equal(comparison.querySelector('.debt-scenario-missing'), null);
  assert.doesNotMatch(comparison.textContent!, /Add the APR|Add missing details/);
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Extra monthly payment"]')!.disabled, false);
  await act(complete);
  assert.match(comparison.textContent!, /With \$100 extra/);
  assert.ok(comparison.querySelector('.debt-comparison-dates'));
  assert.equal(comparison.querySelector('[role="status"]'), null);
});


test('navigation keeps entered debt terms until discard is confirmed', async () => {
  const state=fixture();
  await act(async () => root.render(createElement(DebtScenario, { state, loan: state.accounts[0], readOnly: false, onOpen: () => {}, onCommand: async () => {} })));
  await fill('Debt scenario APR','8.5');
  let navigations=0;
  await act(async () => { assert.equal(requestDraftNavigation(()=>{navigations++;}),false); });
  const discardButton=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('.draft-discard-dialog button')].find(item=>item.textContent===label)!;
  assert.equal(navigations,0);
  await act(async () => discardButton('Keep editing').click());
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Debt scenario APR"]')!.value,'8.5');
  await act(async () => { requestDraftNavigation(()=>{navigations++;}); });
  await act(async () => discardButton('Discard changes').click());
  assert.equal(navigations,1);
});
