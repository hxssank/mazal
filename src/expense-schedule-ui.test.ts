import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createStore } from '../server/store.ts';
import { today } from '../shared/analytics.ts';
import type { AppState, Command, Obligation } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
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
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ExpenseSchedule } = await import('./features/expenses/ExpenseSchedule.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });

function inDays(days: number): string {
  const date = new Date(`${today()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function bill(id: string, patch: Partial<Obligation> = {}): Obligation {
  return { id, entityId: 'personal', name: id, amountCents: 10000, dueDate: inDays(1), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Bills', ...patch };
}
function fixture(): AppState {
  return {
    workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 10000 }],
    accounts: [{ id: 'cash', entityId: 'personal', name: 'Chequing', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }, { id: 'card', entityId: 'personal', name: 'Card minimum', type: 'debt', currency: 'CAD', balanceCents: 500000, reconciledAt: null, debtTerms: { aprPercent: 12, minimumPaymentCents: 2500, rateConfirmed: true, notes: '', paymentDueDate: inDays(3) } }, { id: 'shop-cash', entityId: 'shop', name: 'Shop bank', type: 'cash', currency: 'CAD', balanceCents: 900000, reconciledAt: null }],
    obligations: [bill('Internet'), bill('Gym', { subscription: true, category: 'Gym', amountCents: 2000, dueDate: inDays(4) }), bill('Side work', { direction: 'in', recurrence: 'once', amountCents: 50000, dueDate: inDays(5) }), bill('Annual renewal', { recurrence: 'once', amountCents: 7500, dueDate: inDays(70) }), bill('Business rent', { entityId: 'shop', accountId: 'shop-cash', amountCents: 80000 }), bill('Business subscription', { entityId: 'shop', accountId: 'shop-cash', subscription: true })],
    roadmap: { currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: '', transitionMonths: 0, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, payAmountCents: 200000, payEveryDays: 14, paydayAnchor: inDays(2) },
    transactions: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}
function button(label: string, parent: Element = container): HTMLButtonElement {
  const element = [...parent.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  assert.ok(element, `Button ${label} exists`);
  return element;
}
function management(label: string): HTMLButtonElement {
  const element = [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Schedule management"] button')].find(item => item.textContent?.startsWith(label));
  assert.ok(element, `Management view ${label} exists`);
  return element;
}
async function select(input: HTMLSelectElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
function editorField(label: string): HTMLInputElement | HTMLSelectElement {
  const element = [...container.querySelectorAll('dialog label')].find(item => item.querySelector('span')?.textContent === label)?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
  assert.ok(element, `Editor field ${label} exists`);
  return element;
}
async function submitEditor() { await act(async () => container.querySelector('dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

test('the personal agenda combines paydays and debt dates, and view controls never change records', async () => {
  const state = fixture();
  const original = structuredClone(state);
  let commands = 0; let payments = 0;
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'all', readOnly: false, pending: '', onCommand: async () => { commands++; }, onPay: async () => { payments++; } })));
  const agenda = () => container.querySelector('.schedule-days')!;
  assert.match(agenda().textContent!, /Internet/);
  assert.doesNotMatch(agenda().textContent!, /Payday|Side work/);
  await act(async () => button('All dates').click());
  assert.match(agenda().textContent!, /Payday/);
  assert.match(agenda().textContent!, /Card minimum/);
  assert.doesNotMatch(container.textContent!, /Business rent|Business subscription|Shop bank/);
  assert.doesNotMatch(agenda().textContent!, /Annual renewal/);
  assert.equal(agenda().querySelector('[aria-label="Review Card minimum on Debts"]')?.getAttribute('href'), '#debts?record=card');
  await act(async () => button('Pay schedule', agenda()).click());
  const payEditor = container.querySelector<HTMLButtonElement>('.schedule-pay header button')!;
  assert.equal(document.activeElement, payEditor);
  await act(async () => payEditor.click());
  await fill(container.querySelector<HTMLInputElement>('.expense-pay-form input')!, '2100');
  await act(async () => button('Cancel', container.querySelector('.expense-pay-form')!).click());
  await act(async () => button('Discard changes', document.body).click());
  await act(async () => button('Payments').click());
  assert.doesNotMatch(agenda().textContent!, /Payday|Side work/);
  assert.match(agenda().textContent!, /Card minimum/);
  await select(container.querySelector<HTMLSelectElement>('[aria-label="Schedule date range"]')!, '90');
  assert.match(agenda().textContent!, /Annual renewal/);
  await act(async () => button('Income').click());
  assert.match(agenda().textContent!, /Payday|Side work/);
  assert.doesNotMatch(agenda().textContent!, /Internet|Card minimum|Annual renewal/);
  await act(async () => management('Subscriptions').click());
  assert.equal(management('Subscriptions').getAttribute('aria-pressed'), 'true');
  const subscriptions = container.querySelector('section[aria-label="Subscriptions"]')!;
  assert.match(subscriptions.textContent!, /Gym/);
  assert.doesNotMatch(subscriptions.querySelector('.subscription-list')!.textContent!, /Internet/);
  assert.doesNotMatch(subscriptions.textContent!, /Business subscription/);
  assert.equal(container.querySelector('section[aria-label="Bills and income"]'), null);
  await act(async () => management('Bills & income').click());
  assert.ok(container.querySelector('section[aria-label="Bills and income"]'));
  assert.equal(commands, 0);
  assert.equal(payments, 0);
  assert.deepEqual(state, original);
});

test('unknown payday and debt amounts stay explicit while a confirmed zero debt payment stays zero', async () => {
  const state = fixture();
  delete state.roadmap!.payAmountCents;
  state.accounts[1].debtTerms!.minimumPaymentCents = null;
  state.accounts.push({ ...state.accounts[1], id: 'zero', name: 'Zero minimum', debtTerms: { ...state.accounts[1].debtTerms!, minimumPaymentCents: 0 } });
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: false, pending: '', onCommand: async () => {}, onPay: async () => {} })));
  await act(async () => button('All dates').click());
  const event = (name: string) => [...container.querySelectorAll('.schedule-days .schedule-event')].find(item => item.querySelector('h4')?.textContent === name)!;
  assert.equal(event('Card minimum').querySelector('.schedule-event-amount')?.textContent, 'Amount not set');
  assert.equal(event('Payday').querySelector('.schedule-event-amount')?.textContent, 'Amount not set');
  assert.equal(event('Zero minimum').querySelector('.schedule-event-amount')?.textContent, '$0');
  assert.match(container.querySelector('.schedule-summary .is-income')!.textContent!, /Amount not set/);
  assert.match(container.querySelector('.schedule-summary')!.textContent!, /1 amount missing/);
  assert.match(container.querySelector('[aria-label="Schedule details needed"]')!.textContent!, /Card minimum.*Payment amount needs confirmation/);
  assert.equal(container.querySelector('[aria-label="Schedule details needed"] a')?.getAttribute('href'), '#debts?record=card');
});

test('Bills totals include projected monthly loan installments when the date range changes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T12:00:00Z').getTime() });
  const state = fixture();
  state.obligations = [];
  delete state.roadmap;
  const loan = state.accounts[1];
  loan.name = 'Fixed loan';
  loan.debtTerms = { ...loan.debtTerms!, repaymentKind: 'fixed', minimumPaymentCents: 10000, paymentDueDate: '2026-10-25', statementDate: '2026-09-30' };
  const before = structuredClone(state);
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: true, pending: '', onCommand: async () => assert.fail('Viewing a schedule must not write records'), onPay: async () => assert.fail('Viewing a schedule must not record payments') })));
  assert.equal(container.querySelector('.schedule-summary strong')?.textContent, '$100');
  assert.equal(container.querySelectorAll('.schedule-days .schedule-event').length, 1);
  assert.match(container.querySelector('.schedule-days')!.textContent!, /Debt payment · saved amount and date/);
  const range = container.querySelector<HTMLSelectElement>('[aria-label="Schedule date range"]')!;
  await select(range, '60');
  assert.equal(container.querySelector('.schedule-summary strong')?.textContent, '$200');
  assert.equal(container.querySelectorAll('.schedule-days .schedule-event').length, 2);
  assert.match(container.querySelector('.schedule-days')!.textContent!, /Debt payment · projected monthly repeat/);
  await select(range, '90');
  assert.equal(container.querySelector('.schedule-summary strong')?.textContent, '$300');
  assert.deepEqual([...container.querySelectorAll('.schedule-days time')].map(item => item.getAttribute('datetime')), ['2026-10-25', '2026-11-25', '2026-12-25']);
  assert.match(container.querySelector('.schedule-agenda-note')!.textContent!, /Projected debt payments repeat the saved minimum\. Future interest and payoff dates are not modeled\./);
  assert.deepEqual(state, before);
});

test('Bills explains why payments with an unknown statement period do not reduce the saved minimum', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T12:00:00Z').getTime() });
  const state = fixture();
  state.obligations = [];
  delete state.roadmap;
  const loan = state.accounts[1];
  loan.debtTerms = { ...loan.debtTerms!, repaymentKind: 'revolving', minimumPaymentCents: 10000, paymentDueDate: '2026-11-02' };
  state.transactions = [{ id: 'payment', accountId: 'cash', toAccountId: 'card', date: '2026-10-15', description: 'Debt payment', kind: 'debt_payment', amountCents: 2500, category: 'Debt', source: 'Manual', createdAt: '2026-10-15T12:00:00Z' }];
  const before = structuredClone(state);
  const render = async () => act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: true, pending: '', onCommand: async () => assert.fail('Viewing a schedule must not write records'), onPay: async () => assert.fail('Viewing a schedule must not record payments') })));
  await render();
  assert.equal(container.querySelector('.schedule-summary strong')?.textContent, '$100');
  assert.match(container.querySelector('.schedule-days')!.textContent!, /Debt payment · payment period unconfirmed/);
  assert.match(container.querySelector('.schedule-needs-details')!.textContent!, /Confirm the statement date and current minimum\. Recorded payments have not reduced this amount because their payment period is unknown\./);
  assert.equal(container.querySelector('.schedule-needs-details a')?.getAttribute('href'), '#debts?record=card');
  assert.deepEqual(state, before);
  loan.debtTerms.statementDate = '2026-09-30';
  await render();
  assert.equal(container.querySelector('.schedule-summary strong')?.textContent, '$75');
  assert.equal(container.querySelector('.schedule-needs-details'), null);
  assert.doesNotMatch(container.querySelector('.schedule-days')!.textContent!, /payment period unconfirmed/);
});

test('Add bill and agenda editing reuse the payment editor and persist only scheduling changes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-schedule-ui-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let state = store.command({ type: 'add_account', entityId: 'personal', name: 'Chequing', accountType: 'cash', openingBalanceCents: 100000, openingDate: today() });
  const originalAccounts = structuredClone(state.accounts);
  const originalTransactions = structuredClone(state.transactions);
  const commands: Command[] = [];
  const onCommand = async (command: Command) => { commands.push(command); state = store.command(command); render(); };
  const render = () => root.render(createElement(ExpenseSchedule, { state, scope: 'all', readOnly: false, pending: '', onCommand, onPay: async () => { assert.fail('Editing a schedule must not record a payment'); } }));
  await act(async () => render());
  await act(async () => button('Add bill or income', container.querySelector('.schedule-heading')!).click());
  assert.ok(container.querySelector('dialog.bill-dialog[open]'));
  assert.equal(commands.length, 0);
  await fill(editorField('Name') as HTMLInputElement, 'Internet');
  await fill(editorField('Amount per payment · CAD') as HTMLInputElement, '50');
  await fill(editorField('Next payment date') as HTMLInputElement, inDays(1));
  await select(editorField('Repeats') as HTMLSelectElement, 'monthly');
  await select(editorField('Pay from · optional') as HTMLSelectElement, state.accounts[0].id);
  await submitEditor();
  assert.equal(container.querySelector('dialog'), null);
  assert.equal(commands[0].type, 'add_obligation');
  assert.equal(store.state().obligations[0].entityId, 'personal');
  assert.equal(store.state().obligations[0].amountCents, 5000);
  await act(async () => container.querySelector<HTMLButtonElement>('.schedule-days [aria-label="Edit schedule for Internet"]')!.click());
  assert.equal(container.querySelector('dialog h2')?.textContent, 'Edit payment');
  assert.equal((editorField('Amount per payment · CAD') as HTMLInputElement).value, '50.00');
  await fill(editorField('Amount per payment · CAD') as HTMLInputElement, '55.25');
  await fill(editorField('Next payment date') as HTMLInputElement, inDays(3));
  await submitEditor();
  assert.equal(commands[1].type, 'update_obligation');
  assert.equal(store.state().obligations[0].amountCents, 5525);
  assert.equal(store.state().obligations[0].dueDate, inDays(3));
  assert.deepEqual(store.state().accounts, originalAccounts);
  assert.deepEqual(store.state().transactions, originalTransactions);
});

test('read-only schedule keeps navigation while hiding write controls in agenda and management', async () => {
  const state = fixture(); let writes = 0;
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'all', readOnly: true, pending: '', onCommand: async () => { writes++; }, onPay: async () => { writes++; } })));
  assert.equal(container.querySelector('.schedule-heading button'), null);
  assert.equal(container.querySelector('[aria-label^="Edit schedule for"]'), null);
  assert.equal(container.querySelector('.bill-row-actions'), null);
  assert.equal(container.querySelector('.schedule-record-payment'), null);
  assert.equal(container.querySelector('.schedule-pay header button'), null);
  assert.equal(container.querySelector('dialog'), null);
  await act(async () => button('Income').click());
  await select(container.querySelector<HTMLSelectElement>('[aria-label="Schedule date range"]')!, '60');
  await act(async () => management('Subscriptions').click());
  assert.ok(container.querySelector('section[aria-label="Subscriptions"]'));
  assert.equal(container.querySelector('.subscription-actions'), null);
  assert.equal(container.querySelector('.subscription-heading button'), null);
  assert.equal(container.querySelector('.subscription-add-options'), null);
  assert.equal(writes, 0);
});

test('income totals and agenda explain salary copies, unresolved income and confirmed additional money', async () => {
  const state = fixture();
  state.obligations = [
    bill('Salary copy', { direction: 'in', recurrence: 'once', amountCents: 200000, additionalToPay: false }),
    bill('Unconfirmed income', { direction: 'in', recurrence: 'once', amountCents: 70000 }),
    bill('Side work', { direction: 'in', recurrence: 'once', amountCents: 50000, additionalToPay: true }),
  ];
  const before = structuredClone(state);
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: true, pending: '', onCommand: async () => assert.fail('Read-only schedule'), onPay: async () => assert.fail('Read-only schedule') })));
  const summary = container.querySelector('.schedule-other-income')!;
  assert.equal(summary.querySelector('strong')?.textContent, '$500 confirmed');
  assert.match(summary.textContent!, /1 entry needs confirmation.*1 entry is already in regular pay/);
  await act(async () => button('Income').click());
  const events = [...container.querySelectorAll('.schedule-days .schedule-event')];
  const salary = events.find(row => row.querySelector('h4')?.textContent === 'Salary copy')!;
  assert.match(salary.textContent!, /Already included in regular pay.*not added again/);
  assert.equal(salary.querySelector('.schedule-event-amount')?.textContent, '$2,000');
  const unknown = events.find(row => row.querySelector('h4')?.textContent === 'Unconfirmed income')!;
  assert.match(unknown.textContent!, /Confirm whether this is additional income.*excluded from income total/);
  assert.equal(unknown.querySelector('.schedule-event-amount')?.textContent, '$700');
  assert.deepEqual(state, before);
});

test('unresolved income totals never display zero as confirmed extra income', async () => {
  const state = fixture();
  state.obligations = [bill('Unconfirmed income', { direction: 'in', recurrence: 'once', amountCents: 70000 })];
  const render = async () => act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: true, pending: '', onCommand: async () => {}, onPay: async () => {} })));
  await render();
  assert.equal(container.querySelector('.schedule-other-income strong')?.textContent, 'Needs confirmation');
  delete state.roadmap;
  await render();
  assert.equal(container.querySelector('.schedule-summary .is-income strong')?.textContent, 'Schedule not set');
  assert.match(container.querySelector('.schedule-other-income')!.textContent!, /Scheduled income\$700/);
});

test('income transitions show the known salary subtotal and preserve dates with unconfirmed later amounts', async () => {
  const state = fixture();
  state.roadmap!.transitionDate = inDays(15);
  state.roadmap!.partTimeMonthlyIncomeCents = 100000;
  const render = async () => act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: true, pending: '', onCommand: async () => {}, onPay: async () => {} })));
  await render();
  await act(async () => button('Income').click());
  assert.equal(container.querySelector('.schedule-summary .is-income strong')?.textContent, '$2,000 known');
  assert.match(container.querySelector('.schedule-summary .is-income')!.textContent!, /2 payday amounts need confirmation/);
  assert.match(container.querySelector('.schedule-days')!.textContent!, /Pay after income change.*amount needs confirmation.*Amount not set/);
  const dates = [...container.querySelectorAll('.schedule-days time')].map(item => item.getAttribute('dateTime'));
  state.roadmap!.transitionDate = inDays(-1);
  await render();
  assert.equal(container.querySelector('.schedule-summary .is-income strong')?.textContent, 'Amount not set');
  state.roadmap!.incomeTransitionPlanned = false;
  await render();
  assert.equal(container.querySelector('.schedule-summary .is-income strong')?.textContent, '$6,000');
  assert.deepEqual([...container.querySelectorAll('.schedule-days time')].map(item => item.getAttribute('dateTime')), dates);
});

test('a purchase with a scheduled installment is not labeled as missing its payment date', async () => {
  const state = fixture();
  state.assetPurchases = [{ id: 'car', entityId: 'personal', name: 'Car purchase', payee: 'Seller', targetCents: 1000000, paidCents: 100000, paidAsOf: today(), monthlyCents: 20000, notes: '' }];
  state.obligations.push(bill('Car installment', { assetPurchaseId: 'car', amountCents: 20000 }));
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: false, pending: '', onCommand: async () => {}, onPay: async () => {} })));
  assert.match(container.querySelector('.schedule-days')!.textContent!, /Car installment/);
  assert.doesNotMatch(container.querySelector('.schedule-needs-details')?.textContent ?? '', /Car purchase/);
  state.obligations = state.obligations.filter(item => !item.assetPurchaseId);
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: false, pending: '', onCommand: async () => {}, onPay: async () => {} })));
  assert.match(container.querySelector('.schedule-needs-details')!.textContent!, /Car purchase.*No payment date saved/);
});

test('Bills shows the saved loan deadline when repayment resumes at the horizon boundary', async () => {
  const state = fixture();
  state.obligations = [];
  delete state.roadmap;
  const loan = state.accounts.find(account => account.id === 'card')!;
  loan.name = 'Resuming loan';
  loan.debtTerms = { ...loan.debtTerms!, minimumPaymentCents: 10000, repaymentStatus: 'in_study', repaymentStartDate: inDays(30), paymentDueDate: inDays(30) };
  const original = structuredClone(state);
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: true, pending: '', onCommand: async () => assert.fail('Viewing a schedule must not write records'), onPay: async () => assert.fail('Viewing a schedule must not record payments') })));
  assert.equal(container.querySelector('.schedule-summary strong')?.textContent, '$100');
  assert.equal(container.querySelector('.schedule-days time')?.getAttribute('datetime'), inDays(30));
  assert.match(container.querySelector('.schedule-days')!.textContent!, /Resuming loan.*\$100/);
  assert.equal(container.querySelector('.schedule-needs-details'), null);
  assert.deepEqual(state, original);
  loan.debtTerms.repaymentStartDate = inDays(31);
  loan.debtTerms.paymentDueDate = inDays(31);
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: true, pending: '', onCommand: async () => {}, onPay: async () => {} })));
  assert.equal(container.querySelector('.schedule-days'), null);
  assert.equal(container.querySelector('.schedule-needs-details'), null);
  await select(container.querySelector<HTMLSelectElement>('[aria-label="Schedule date range"]')!, '60');
  assert.equal(container.querySelector('.schedule-days time')?.getAttribute('datetime'), inDays(31));
  assert.equal(container.querySelector('.schedule-summary strong')?.textContent, '$100');
});

test('resuming loans expose missing or stale terms without inventing payment dates or amounts', async () => {
  const state = fixture();
  state.obligations = [];
  delete state.roadmap;
  const loan = state.accounts.find(account => account.id === 'card')!;
  loan.name = 'Resuming loan';
  loan.debtTerms = { ...loan.debtTerms!, repaymentStatus: 'in_study', repaymentStartDate: inDays(1), paymentDueDate: undefined };
  const render = async () => act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: true, pending: '', onCommand: async () => assert.fail('Viewing a schedule must not write records'), onPay: async () => assert.fail('Viewing a schedule must not record payments') })));
  await render();
  assert.equal(container.querySelector('.schedule-days'), null);
  assert.match(container.querySelector('.schedule-needs-details')!.textContent!, /Resuming loan.*Payment date not set.*Confirm the first payment deadline/);
  loan.debtTerms.paymentDueDate = today();
  await render();
  assert.equal(container.querySelector('.schedule-days'), null);
  assert.match(container.querySelector('.schedule-needs-details')!.textContent!, /Saved date.*Confirm the first payment deadline on or after repayment resumes/);
  loan.debtTerms.paymentDueDate = inDays(3);
  loan.debtTerms.minimumPaymentCents = null;
  await render();
  assert.equal(container.querySelector('.schedule-days time')?.getAttribute('datetime'), inDays(3));
  assert.match(container.querySelector('.schedule-days')!.textContent!, /Resuming loan.*Amount not set/);
  assert.match(container.querySelector('.schedule-needs-details')!.textContent!, /Payment amount needs confirmation/);
  assert.equal(container.querySelector('.schedule-summary strong')?.textContent, 'Amount not set');
  loan.debtTerms.repaymentStartDate = null;
  await render();
  assert.equal(container.querySelector('.schedule-days'), null);
  assert.equal(container.querySelector('.schedule-needs-details'), null);
});


test('Bills starts with outgoing dates and leaves management and income collapsed', async () => {
  const state = fixture();
  state.obligations.push(bill('Cancelled bill', { status: 'cancelled' }), bill('Paid one-off', { status: 'paid', recurrence: 'once' }));
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: false, pending: '', onCommand: async () => {}, onPay: async () => {} })));
  assert.equal(container.querySelector('.schedule-heading h2')?.textContent, 'Bills');
  assert.equal(button('Payments').getAttribute('aria-pressed'), 'true');
  assert.equal(container.querySelector<HTMLDetailsElement>('.schedule-management-details')?.open, false);
  assert.equal(container.querySelector<HTMLDetailsElement>('.schedule-income-details')?.open, false);
  const agenda = container.querySelector('.schedule-days')!;
  assert.match(agenda.textContent!, /Internet.*Card minimum.*Gym/s);
  assert.doesNotMatch(agenda.textContent!, /Payday|Side work|Cancelled bill|Paid one-off/);
  const dates = [...agenda.querySelectorAll('time')].map(element => element.getAttribute('datetime')!);
  assert.deepEqual(dates, [...dates].sort());
  const managementDetails = container.querySelector<HTMLDetailsElement>('.schedule-management-details')!;
  await act(async () => managementDetails.querySelector('summary')!.click());
  assert.equal(managementDetails.open, true);
  const cancelled = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Scheduled payment status"] button')].find(element => element.textContent?.startsWith('Cancelled'))!;
  await act(async () => cancelled.click());
  assert.match(container.querySelector('.bill-list')!.textContent!, /Cancelled bill/);
  assert.ok(container.querySelector('[aria-label="Reactivate Cancelled bill"]'));
});

test('only the saved bill occurrence can open payment recording, never a projected repeat', async () => {
  const state = fixture();
  const before = structuredClone(state);
  const payments: string[] = [];
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: false, pending: '', onCommand: async () => assert.fail('Recording must use the existing payment flow'), onPay: async id => { payments.push(id); } })));
  await select(container.querySelector<HTMLSelectElement>('[aria-label="Schedule date range"]')!, '90');
  const rows = [...container.querySelectorAll('.schedule-days .schedule-event')].filter(row => row.querySelector('h4')?.textContent === 'Internet');
  assert.ok(rows.length > 1);
  assert.equal(rows.filter(row => row.querySelector('.schedule-record-payment')).length, 1);
  await act(async () => rows[0].querySelector<HTMLButtonElement>('.schedule-record-payment')!.click());
  assert.deepEqual(payments, ['Internet']);
  for (const row of rows.slice(1)) assert.match(row.textContent!, /projected repeat/);
  assert.deepEqual(state, before);
});

test('a payment-opening failure stays visible and the same saved payment can be retried', async () => {
  const state = fixture();
  let fail = true;
  const payments: string[] = [];
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: false, pending: '', onCommand: async () => {}, onPay: async id => { if (fail) throw new Error('Payment unavailable'); payments.push(id); } })));
  const record = container.querySelector<HTMLButtonElement>('.schedule-days [aria-label="Record paid: Internet"]')!;
  await act(async () => record.click());
  assert.equal(container.querySelector('.schedule-payment-error')?.textContent, 'Payment unavailable');
  assert.equal(record.disabled, false);
  fail = false;
  await act(async () => record.click());
  assert.equal(container.querySelector('.schedule-payment-error'), null);
  assert.deepEqual(payments, ['Internet']);
});

test('closing the income disclosure protects a pay-schedule draft', async () => {
  const state = fixture();
  await act(async () => root.render(createElement(ExpenseSchedule, { state, scope: 'personal', readOnly: false, pending: '', onCommand: async () => assert.fail('This only checks draft protection'), onPay: async () => {} })));
  const details = container.querySelector<HTMLDetailsElement>('.schedule-income-details')!;
  const summary = details.querySelector('summary')!;
  await act(async () => summary.click());
  await act(async () => container.querySelector<HTMLButtonElement>('.schedule-pay header button')!.click());
  const amount = container.querySelector<HTMLInputElement>('.expense-pay-form input')!;
  await fill(amount, '2100');
  await act(async () => summary.click());
  assert.equal(details.open, true);
  assert.equal(document.querySelector<HTMLDialogElement>('.draft-discard-dialog')?.open, true);
  await act(async () => button('Keep editing', document.body).click());
  assert.equal(amount.value, '2100');
  assert.equal(details.open, true);
  await act(async () => summary.click());
  await act(async () => button('Discard changes', document.body).click());
  assert.equal(details.open, false);
  assert.equal(container.querySelector('.expense-pay-form'), null);
});
