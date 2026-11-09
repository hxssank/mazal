import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Command } from '../shared/types.ts';
import { today } from '../shared/analytics.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLDialogElement', 'Event', 'MouseEvent', 'localStorage'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) for (const extension of ['.ts', '.tsx']) {
      const url = new URL(specifier + extension, context.parentURL);
      if (existsSync(url)) return nextResolve(url.href, context);
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

const { BillEditor } = await import('./features/expenses/ExpenseBills.tsx');
const { default: ExpenseOverview, ExpensePay } = await import('./features/expenses/ExpenseOverview.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
let state: AppState;
let commands: Command[];
const onCommand = async (command: Command) => { commands.push(command); };
function offsetDate(days: number): string {
  const value = new Date(today() + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function fixture(): AppState {
  return {
    workspace: 'live', revision: 7,
    entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }],
    accounts: [{ id: 'cash', entityId: 'personal', name: 'Chequing', type: 'cash', currency: 'CAD', balanceCents: 200000, reconciledAt: today() }],
    transactions: [], obligations: [{ id: 'phone', entityId: 'personal', name: 'Phone bill', amountCents: 25000, dueDate: offsetDate(1), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Phone' }],
    reserves: [{ id: 'buffer', entityId: 'personal', name: 'Cash buffer', amountCents: 10000 }], positions: [], audit: [], lastBackupAt: null,
    roadmap: { currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: 0, monthlyDebtMinimumsCents: null, transitionDate: '', transitionMonths: 0, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, payAmountCents: 100000, payEveryDays: 14, paydayAnchor: offsetDate(7) },
  };
}

beforeEach(async () => {
  await act(async () => root.unmount()); root = createRoot(container);
  state = fixture(); commands = [];
  state.obligations[0] = { ...state.obligations[0], direction: 'in', name: 'Freelance' };
});
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });
async function renderBill() {
  await act(async () => root.render(createElement(BillEditor, { state, scope: 'personal', obligation: state.obligations[0], onCommand, onClose() {} })));
}
async function renderPay(readOnly = false) {
  await act(async () => root.render(createElement(ExpensePay, { state, readOnly, onCommand })));
}
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text);
  assert.ok(button, 'Missing button ' + text);
  await act(async () => button.click());
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
async function fill(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  assert.ok(input);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

test('editing an income name preserves an unconfirmed income source', async () => {
  await renderBill();
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Income source"]')?.value, '');
  await fill('.bill-fields input', 'Updated freelance name');
  await submit();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'update_obligation');
  assert.equal('additionalToPay' in commands[0], false);
});
for (const [choice, expected] of [['regular', false], ['extra', true]] as const) {
  test('the income source explicitly records ' + choice, async () => {
    await renderBill();
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Income source"]')!;
    await act(async () => { select.value = choice; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await submit();
    assert.equal(commands[0].type, 'update_obligation');
    if (commands[0].type !== 'update_obligation') assert.fail('Expected an obligation update');
    assert.equal(commands[0].additionalToPay, expected);
  });
}

test('saving ordinary pay does not silently resolve an income change', async () => {
  state.roadmap = { ...state.roadmap!, transitionDate: offsetDate(-5), incomeTransitionPlanned: true };
  await renderPay(); await click('Edit');
  assert.equal(container.querySelector<HTMLInputElement>('.pay-transition-confirm input')?.checked, false);
  await submit();
  assert.equal(commands.length, 1);
  assert.equal('resolveIncomeTransition' in commands[0], false);
});

test('confirming changed income requires a payday after the change and an unchanged revision', async () => {
  state.roadmap = { ...state.roadmap!, transitionDate: offsetDate(-5), incomeTransitionPlanned: true, paydayAnchor: offsetDate(-10) };
  await renderPay(); await click('Edit');
  await act(async () => container.querySelector<HTMLInputElement>('.pay-transition-confirm input')!.click());
  await submit();
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /on or after the saved income change/);
  assert.equal(commands.length, 0);
  await fill('input[type="date"]', offsetDate(2));
  state = { ...state, revision: state.revision + 1 };
  await renderPay(); await submit();
  assert.equal(commands.length, 0);
  await click('Keep my entries'); await submit();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'update_pay_schedule');
  if (commands[0].type !== 'update_pay_schedule') assert.fail('Expected pay schedule');
  assert.equal(commands[0].resolveIncomeTransition, true);
  assert.equal(commands[0].expectedRevision, state.revision);
});


test('the pay card does not present the old amount as expected income after a planned change', async () => {
  state.roadmap = { ...state.roadmap!, transitionDate: offsetDate(-5), incomeTransitionPlanned: true };
  await renderPay();
  assert.match(container.textContent!, /Confirm take-home pay/);
  assert.doesNotMatch(container.querySelector('.expense-pay-value')!.textContent!, /\$1,000/);
  state = { ...state, revision: state.revision + 1, roadmap: { ...state.roadmap!, incomeTransitionPlanned: false } };
  await renderPay();
  assert.match(container.querySelector('.expense-pay-value')!.textContent!, /\$1,000/);
});

test('regular pay setup identifies its recurring amount separately from one-off income', async () => {
  await renderPay();
  assert.match(container.textContent ?? '', /Regular pay schedule/);
  assert.match(container.textContent ?? '', /add one-off income separately/);
  await click('Edit');
  assert.match(container.querySelector('.expense-pay-form')?.textContent ?? '', /Take-home pay per paycheck.*Repeat every.*Confirmed payday/s);
  await submit();
  assert.equal(commands[0].type, 'update_pay_schedule');
  assert.equal(commands.length, 1);
});

test('a temporary schedule shows the estimated next deposit and edits the full-time baseline', async () => {
  state.roadmap = { ...state.roadmap!, transitionDate: offsetDate(-50), incomeTransitionPlanned: true,
    temporaryWorkSchedule: { weeklyHours: 20, fullTimeWeeklyHours: 40, returnDate: offsetDate(50), payPeriodEndLagDays: 5 } };
  await renderPay();
  assert.match(container.querySelector('.expense-pay-value')!.textContent!, /\$500/);
  assert.match(container.textContent!, /20 hours a week/);
  await click('Edit');
  assert.match(container.querySelector('form')!.textContent!, /Full-time take-home pay per paycheck/);
  assert.equal(container.querySelector<HTMLInputElement>('.pay-transition-confirm input'), null);
  assert.equal(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.value, '1000');
});

test('a pay draft stops offering edits or blocking navigation when records become read-only', async () => {
  await renderPay();
  await click('Edit');
  await fill('input[inputmode="decimal"]','2300');
  await renderPay(true);
  assert.equal(!!container.querySelector('.expense-pay-form'),false);
  assert.match(container.querySelector('.expense-pay-value')?.textContent??'',/\$1,000/);
  const {requestDraftNavigation}=await import('./hooks/draft-protection.ts');
  let navigations=0;
  await act(async()=>{assert.equal(requestDraftNavigation(()=>{navigations++;}),true);});
  assert.equal(navigations,1);
  assert.equal(commands.length,0);
});

test('an empty spending month keeps the transaction review action available', async () => {
  let reviews = 0;
  await act(async () => root.render(createElement(ExpenseOverview, { state, ownerId: 'personal', month: today().slice(0, 7), onMonth() {}, onTransactions() { reviews++; } })));
  assert.match(container.textContent ?? '', /No recorded expenses for this month/);
  assert.equal(container.querySelector('.expense-daily-details'), null);
  await click('View transactions');
  assert.equal(reviews, 1);
  assert.equal(commands.length, 0);
});
