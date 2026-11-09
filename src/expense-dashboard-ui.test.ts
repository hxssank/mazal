import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Transaction } from '../shared/types.ts';
import type { ExpenseMonthlyBill } from '../shared/expense-monthly-summary.ts';
import { today } from '../shared/analytics.ts';
import { shiftCalendarMonth } from '../shared/spending-calendar.ts';
import { engineFixtureFetch } from './engine-test-fixture.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ExpenseDashboard } = await import('./features/expenses/ExpenseDashboard.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
let state: AppState;
let month: string;
let transactionTrigger: HTMLButtonElement | null;
const actions: string[][] = [];
const previousMonth = () => shiftCalendarMonth(today().slice(0, 7), -1);
const date = (day: number) => `${previousMonth()}-${String(day).padStart(2, '0')}`;

function transaction(id: string, amountCents: number, day = 2, category = 'Food'): Transaction {
  return { id, accountId: 'cash', toAccountId: null, date: date(day), createdAt: `${date(day)}T12:00:00Z`, description: id, kind: 'expense', amountCents, category, source: 'Manual' };
}
function fixture(): AppState {
  return {
    workspace: 'live', revision: 1,
    entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'business', name: 'Business', kind: 'business', ownershipBps: 5000 }],
    accounts: [{ id: 'cash', entityId: 'personal', name: 'Chequing', type: 'cash', currency: 'CAD', balanceCents: 90000, reconciledAt: null }, { id: 'loan', entityId: 'personal', name: 'Loan', type: 'debt', currency: 'CAD', balanceCents: 200000, reconciledAt: null }, { id: 'shop', entityId: 'business', name: 'Business cash', type: 'cash', currency: 'CAD', balanceCents: 500000, reconciledAt: null }],
    transactions: [transaction('Groceries', 5000), transaction('Coffee', 1000, 3), { ...transaction('Grocery refund', -1500, 4), refundOf: 'Groceries' }, transaction('Gas', 4000, 5, 'Transport'), { ...transaction('Loan payment', 30000), kind: 'debt_payment', toAccountId: 'loan' }, { ...transaction('Transfer', 100000), kind: 'transfer', toAccountId: 'shop' }, { ...transaction('Business lunch', 99000), accountId: 'shop' }],
    obligations: [{ id: 'phone', entityId: 'personal', name: 'Phone bill', direction: 'out', amountCents: 8000, dueDate: today(), recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Bills' }],
    reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
}
beforeEach(async () => {
  await act(async () => root.unmount()); root = createRoot(container);
  state = fixture(); month = previousMonth(); actions.length = 0; transactionTrigger = null;
  globalThis.fetch = engineFixtureFetch(() => state);
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });
async function render(readOnly = false, onBill?: (bill: ExpenseMonthlyBill) => void) {
  await act(async () => root.render(createElement(ExpenseDashboard, {
    state, ownerId: 'personal', month, readOnly, onBill,
    onMonth: value => { month = value; actions.push(['month', value]); },
    onTransactions: () => actions.push(['transactions']), onCategory: name => actions.push(['category', name]),
    onTransaction: (id, trigger) => { transactionTrigger = trigger; actions.push(['transaction', id]); }, onSchedule: () => actions.push(['schedule']), onBudget: () => actions.push(['budget']),
  })));
}
function button(text: string, parent: ParentNode = container): HTMLButtonElement {
  const result = [...parent.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim().startsWith(text));
  assert.ok(result, `Missing ${text}`); return result;
}
async function exploreSpending() {
  const details = container.querySelector<HTMLDetailsElement>('.expense-spending-details')!;
  assert.ok(details);
  if (!details.open) await act(async () => details.querySelector('summary')!.click());
  assert.equal(details.open, true);
  return details;
}

test('overview keeps transaction detail closed and totals signed expenses for the selected owner', async () => {
  const original = structuredClone(state);
  await render();
  assert.equal(container.querySelector('.expense-dashboard-total strong')?.textContent, '$85');
  assert.match(container.querySelector('.expense-dashboard-total')!.textContent!, /4 recorded entries/);
  const details = container.querySelector<HTMLDetailsElement>('.expense-spending-details')!;
  assert.equal(details.open, false);
  assert.ok(details.contains(container.querySelector('.expense-daily-plot')));
  assert.ok(details.contains(container.querySelector('.expense-dashboard-recent')));
  await exploreSpending();
  const recent = container.querySelector('.expense-dashboard-recent')!;
  assert.match(recent.textContent!, /Grocery refund.*Refund.*-\$15/);
  assert.doesNotMatch(recent.textContent!, /Loan payment|Transfer|Business lunch/);
  assert.equal(container.querySelector(`[data-date="${date(4)}"]`)?.getAttribute('aria-label')?.includes('net refunds'), true);
  assert.equal(container.querySelector<HTMLElement>(`[data-date="${date(4)}"] .expense-daily-negative > i`)!.style.height, '100%');
  assert.match(container.querySelector('.expense-dashboard-coverage')!.textContent!, /incomplete/);
  assert.doesNotMatch(container.textContent!, /last month|less than|more than|over budget|under budget/i);
  assert.deepEqual(state, original);
});

test('the largest recorded day opens its entries and ignores transfers, debt payments and other owners', async () => {
  const original = structuredClone(state);
  await render();
  const insight = container.querySelector<HTMLButtonElement>('.expense-largest-day')!;
  assert.match(insight.getAttribute('aria-label')!, /largest recorded spending day.*\$50/);
  await act(async () => insight.click());
  assert.equal(container.querySelector<HTMLDetailsElement>('.expense-spending-details')!.open, true);
  assert.equal(container.querySelector(`[data-date="${date(2)}"]`)?.getAttribute('aria-pressed'), 'true');
  assert.match(container.querySelector('.expense-dashboard-recent')!.textContent!, /Groceries/);
  assert.doesNotMatch(container.querySelector('.expense-dashboard-recent')!.textContent!, /Coffee|Loan payment|Transfer|Business lunch/);
  assert.deepEqual(actions, []);
  assert.deepEqual(state, original);
});

test('regular payment summary separates monthly bill averages from overdue payment review', async () => {
  state.obligations[0] = { ...state.obligations[0], dueDate: date(2), recurrence: 'biweekly', amountCents: 1200 };
  const original = structuredClone(state);
  await render();
  assert.match(container.querySelector('.expense-monthly-baseline')!.textContent!, /Monthly bill average\$26.*Biweekly amounts annualized; debt payments excluded/);
  assert.match(container.querySelector('.expense-next-payment')!.textContent!, /Past saved payment datePhone bill.*\$12.*Check whether this payment was made/);
  assert.equal(container.querySelector('.expense-next-payment time')!.getAttribute('datetime'), date(2));
  assert.deepEqual(state, original);
});

test('category selection stays in the overview until review and uses saved internal category names', async () => {
  state.spendingLimits = [{ id: 'personal:transport', entityId: 'personal', name: 'Commute', color: '#123456', aliases: ['Transport'], dailyCents: null, weeklyCents: null, monthlyCents: null }];
  await render();
  const food = button('Food & groceries', container.querySelector('.expense-category-list')!);
  await act(async () => food.click());
  assert.equal(food.getAttribute('aria-pressed'), 'true');
  assert.equal(container.querySelector('.expense-selected-total')?.textContent, '$45');
  assert.equal(container.querySelector('.expense-dashboard-total strong')?.textContent, '$85');
  const story = container.querySelector('.expense-category-story')!;
  assert.ok(story);
  assert.match(story.textContent!, /Charges.*\$60/);
  assert.match(story.textContent!, /Refunds.*-\$15/);
  assert.match(story.textContent!, /Groceries.*\$35/);
  assert.match(story.textContent!, /Coffee.*\$10/);
  assert.deepEqual(actions, []);
  await act(async () => button('Review Food & groceries transactions').click());
  const commute = button('Commute', container.querySelector('.expense-category-list')!);
  await act(async () => commute.click());
  assert.equal(commute.getAttribute('aria-pressed'), 'true');
  assert.equal(food.getAttribute('aria-pressed'), 'false');
  assert.equal(container.querySelector('.expense-selected-total')?.textContent, '$40');
  await act(async () => button('Review Commute transactions').click());
  await act(async () => button('All spending').click());
  assert.equal(container.querySelectorAll('.expense-category-row[aria-pressed="true"]').length, 0);
  assert.equal(container.querySelector('.expense-category-story'), null);
  assert.equal(container.querySelector('.expense-selected-total'), null);
  const segment = container.querySelector<HTMLButtonElement>('[aria-label="Show Food & groceries spending, $45"]')!;
  await act(async () => segment.click());
  assert.equal(segment.getAttribute('aria-pressed'), 'true');
  assert.equal(food.getAttribute('aria-pressed'), 'true');
  assert.equal(container.querySelector('.expense-selected-total')?.textContent, '$45');
  await act(async () => segment.click());
  assert.equal(food.getAttribute('aria-pressed'), 'false');
  assert.equal(container.querySelector('.expense-category-story'), null);
  await exploreSpending();
  const refund = container.querySelector<HTMLButtonElement>('[data-transaction-id="Grocery refund"]')!;
  await act(async () => refund.click());
  assert.equal(transactionTrigger, refund);
  await act(async () => button('Budget').click());
  const phone = [...container.querySelectorAll('.expense-bill-card')].find(card => card.querySelector('h3')?.textContent === 'Phone bill')!;
  assert.ok(phone);
  await act(async () => phone.querySelector<HTMLButtonElement>('[aria-label="Show Phone bill details"]')!.click());
  await act(async () => button('View bill', phone).click());
  assert.deepEqual(actions, [['category', 'Food'], ['category', 'Commute'], ['transaction', 'Grocery refund'], ['budget'], ['schedule']]);
});

test('selecting a day filters its records and keyboard navigation changes the selection without recording anything', async () => {
  await render();
  await exploreSpending();
  const day = container.querySelector<HTMLButtonElement>(`[data-date="${date(2)}"]`)!;
  await act(async () => day.click());
  assert.equal(day.getAttribute('aria-pressed'), 'true');
  assert.match(container.querySelector('.expense-dashboard-recent')!.textContent!, /Groceries/);
  assert.doesNotMatch(container.querySelector('.expense-dashboard-recent')!.textContent!, /Coffee|Gas|Grocery refund/);
  await act(async () => day.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  assert.equal(document.activeElement?.getAttribute('data-date'), date(3));
  assert.equal(container.querySelector(`[data-date="${date(3)}"]`)?.getAttribute('aria-pressed'), 'true');
  assert.match(container.querySelector('.expense-dashboard-recent')!.textContent!, /Coffee/);
  await act(async () => button('Whole month').click());
  assert.equal(container.querySelectorAll('.expense-daily-column[aria-pressed="true"]').length, 0);
  assert.equal(container.querySelectorAll('.expense-recent-list li').length, 4);
  assert.deepEqual(actions, []);
});

test('bill details open and close independently without changing the schedule or recorded spending', async () => {
  state.transactions.push({ ...transaction('Phone bill payment', 8000, 6, 'Bills'), source: 'Planned payment phone' });
  state.obligations.push({ id: 'internet', entityId: 'personal', name: 'Internet', direction: 'out', amountCents: 5000, dueDate: today(), recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Bills' });
  const original = structuredClone(state);
  await render();
  const phone = [...container.querySelectorAll('.expense-bill-card')].find(card => card.querySelector('h3')?.textContent === 'Phone bill')!;
  const disclosure = phone.querySelector<HTMLButtonElement>('[aria-label="Show Phone bill details"]')!;
  const internet = container.querySelector<HTMLButtonElement>('[aria-label="Show Internet details"]')!;
  assert.ok(disclosure);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(internet.getAttribute('aria-expanded'), 'false');
  await act(async () => disclosure.click());
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(internet.getAttribute('aria-expanded'), 'false');
  const detailId = disclosure.getAttribute('aria-controls');
  assert.ok(detailId);
  const detail = document.getElementById(detailId)!;
  assert.ok(detail);
  assert.equal(detail.hidden, false);
  assert.match(detail.textContent!, /\$80/);
  assert.ok(button('View bill', phone));
  await act(async () => disclosure.click());
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelector('.expense-dashboard-total strong')?.textContent, '$165');
  assert.deepEqual(actions, []);
  assert.deepEqual(state, original);
});

test('all regular payments can be expanded so observed charges remain actionable after four dated bills', async () => {
  for (const name of ['Internet', 'Insurance', 'Utilities']) state.obligations.push({ ...state.obligations[0], id: name.toLowerCase(), name });
  state.transactions.push(transaction('GOODLIFE FITNESS', 3500, 6, 'Personal'), transaction('CHATGPT SUBSCRIPTION', 3000, 7, 'Subscriptions'));
  const original = structuredClone(state);
  await render(false, bill => { actions.push(['bill', bill.sourceType, bill.sourceId]); });
  assert.equal(container.querySelectorAll('.expense-bill-card').length, 4);
  assert.equal(container.querySelector('[aria-label="Show GoodLife details"]'), null);
  const toggle = button('Show all 6 regular payments');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.getElementById(toggle.getAttribute('aria-controls')!), container.querySelector('.expense-bill-cards'));
  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(container.querySelectorAll('.expense-bill-card').length, 6);
  const goodlife = container.querySelector<HTMLButtonElement>('[aria-label="Show GoodLife details"]')!;
  await act(async () => goodlife.click());
  await act(async () => button('Set up bill', goodlife.closest('article')!).click());
  assert.deepEqual(actions, [['bill', 'recorded', 'goodlife']]);
  await act(async () => { goodlife.focus(); toggle.click(); });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelectorAll('.expense-bill-card').length, 4);
  assert.equal(document.activeElement, toggle);
  assert.deepEqual(state, original);
});

test('month controls clear a selected day and do not display stale amounts while calculations fail', async () => {
  await render();
  await act(async () => button('Food & groceries', container.querySelector('.expense-category-list')!).click());
  await exploreSpending();
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-date="${date(2)}"]`)!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Next spending month"]')!.click());
  await render();
  assert.equal(month, today().slice(0, 7));
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Next spending month"]')!.disabled, true);
  assert.equal(container.querySelector('.expense-dashboard-total strong')?.textContent, '$0');
  assert.equal(container.querySelectorAll('.expense-daily-column[aria-pressed="true"]').length, 0);
  assert.equal(container.querySelectorAll('.expense-category-row[aria-pressed="true"]').length, 0);
  state = { ...state, revision: 2 };
  globalThis.fetch = async () => { throw new Error('Engine offline'); };
  await render();
  assert.equal(container.querySelector('.expense-dashboard-total'), null);
  assert.equal(container.querySelector('.expense-recent-list'), null);
  assert.match(container.textContent!, /Retry calculation/);
  assert.ok(button('Budget'));
  assert.ok(button('Manage bills'));
});

test('a month with only refunds keeps the negative total and category amount readable', async () => {
  state.transactions = [transaction('Returned groceries', -1500, 4)];
  await render();
  assert.equal(container.querySelector('.expense-dashboard-total strong')?.textContent, '-$15');
  await act(async () => button('Food & groceries', container.querySelector('.expense-category-list')!).click());
  assert.equal(container.querySelector('.expense-selected-total')?.textContent, '-$15');
  assert.match(container.querySelector('.expense-category-story')!.textContent!, /Refunds.*-\$15/);
  assert.match(container.querySelector('.expense-category-story')!.textContent!, /Returned groceries.*-\$15/);
  assert.doesNotMatch(container.textContent!, /NaN|Infinity/);
  assert.deepEqual(actions, []);
});

test('reversals remain signed in monthly totals and read-only entries open the record callback', async () => {
  const original = transaction('Canceled meal', 2000, 6);
  state.transactions.push(original, { ...original, id: 'Canceled meal reversal', amountCents: -2000, reversalOf: original.id });
  await render(true);
  await exploreSpending();
  assert.equal(container.querySelector('.expense-dashboard-total strong')?.textContent, '$85');
  assert.match(container.querySelector('.expense-recent-list')!.textContent!, /Reversed entry/);
  const reversal = container.querySelector<HTMLButtonElement>('[data-transaction-id="Canceled meal reversal"]')!;
  assert.match(reversal.getAttribute('aria-label')!, /^View Canceled meal, -\$20, Reversal$/);
  assert.doesNotMatch(reversal.textContent!, /Refund/);
  await act(async () => reversal.click());
  assert.deepEqual(actions, [['transaction', 'Canceled meal reversal']]);
});


test('regular payments keep their quick view closed and bill management available', async () => {
  const original = structuredClone(state);
  await render();
  const recurring = container.querySelector('.expense-recurring')!;
  const details = recurring.querySelector<HTMLDetailsElement>('.expense-regular-details')!;
  assert.equal(details.open, false);
  assert.equal(details.contains(button('Manage bills', recurring)), false);
  assert.ok(details.contains(container.querySelector('.expense-bill-cards')));
  assert.match(recurring.querySelector('.expense-recurring-summary')!.textContent!, /1regular payment/);
  await act(async () => details.querySelector('summary')!.click());
  assert.equal(details.open, true);
  await act(async () => details.querySelector('summary')!.click());
  assert.equal(details.open, false);
  await act(async () => button('Manage bills', recurring).click());
  assert.deepEqual(actions, [['schedule']]);
  assert.deepEqual(state, original);
});
