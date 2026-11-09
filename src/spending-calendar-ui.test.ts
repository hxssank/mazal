import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import { engineFixtureFetch } from './engine-test-fixture.ts';
import type { AppState, Transaction } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({
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
const { default: SpendingCalendar } = await import('./features/expenses/SpendingCalendar.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
beforeEach(async () => { engineState = undefined; globalThis.fetch = engineFixtureFetch(() => engineState); await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });

function expense(id: string, patch: Partial<Transaction> = {}): Transaction {
  return { id, accountId: 'bank', toAccountId: null, kind: 'expense', amountCents: 1234, category: 'Food', description: 'Original merchant', date: '2026-09-23', createdAt: '2026-09-23T12:00:00Z', source: 'Manual', ...patch };
}
function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 5000 }], accounts: [{ id: 'bank', entityId: 'personal', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }, { id: 'shop-bank', entityId: 'shop', name: 'Shop bank', type: 'cash', currency: 'CAD', balanceCents: 50000, reconciledAt: null }], transactions: [expense('one'), expense('work', { accountId: 'shop-bank', description: 'Business merchant', category: 'Supplies', amountCents: 5000 })], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
const details = () => container.querySelector<HTMLElement>('.spend-calendar-details')!;
const total = () => details().querySelector('.spend-calendar-selected-total')!.textContent;
const summaryTotal = () => details().querySelector('.spend-calendar-summary-total')!.textContent;
const selectedDate = () => container.querySelector<HTMLButtonElement>('.spend-calendar-day[aria-pressed="true"]')?.dataset.date;
async function choose(date: string) { await act(async () => container.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)!.click()); }
async function chooseCategory(key: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[data-category-key]')].find(item => item.dataset.categoryKey === key);
  assert.ok(button, `Category ${key} exists`);
  await act(async () => { const disclosure = button.closest('details'); if (disclosure) disclosure.open = true; button.focus(); button.click(); });
}
async function fillMonth(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Calendar month"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function monthSummary() {
  const button = [...details().querySelectorAll('button')].find(item => item.textContent?.trim().endsWith('Month summary'));
  assert.ok(button, 'Month summary button exists');
  await act(async () => button.click());
}

test('the calendar opens with a month summary and a selected day can return to it', async () => {
  const state = fixture();
  const original = structuredClone(state);
  await act(async () => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf: '2026-09-25' })));
  assert.equal(summaryTotal(), '$12.34');
  assert.equal(details().querySelector('.spend-calendar-selected-total'), null);
  assert.equal(selectedDate(), undefined);
  assert.equal(container.querySelectorAll('.spend-calendar-day[tabindex="0"]').length, 1);
  await choose('2026-09-23');
  assert.equal(details().querySelector('.spend-calendar-summary'), null);
  assert.equal(selectedDate(), '2026-09-23');
  assert.equal(total(), '$12.34');
  assert.match(details().textContent!, /Original merchant/);
  await monthSummary();
  assert.equal(summaryTotal(), '$12.34');
  assert.equal(details().querySelector('.spend-calendar-selected-total'), null);
  assert.equal(selectedDate(), undefined);
  const highestDay = details().querySelector<HTMLButtonElement>('[aria-label^="View highest spending day,"]');
  assert.ok(highestDay);
  await act(async () => highestDay.click());
  assert.equal(selectedDate(), '2026-09-23');
  assert.equal(total(), '$12.34');
  assert.deepEqual(state, original);
});

test('month navigation replaces a day detail with the new month summary', async () => {
  const state = fixture();
  state.transactions.push(expense('august', { date: '2026-08-21', amountCents: 5500, description: 'August purchase' }));
  await act(async () => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf: '2026-09-25' })));
  await choose('2026-09-23');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!.click());
  assert.equal(container.querySelector('.spend-calendar-navigation h3')?.textContent, 'August 2026');
  assert.equal(summaryTotal(), '$55');
  assert.equal(selectedDate(), undefined);
  await choose('2026-08-21');
  assert.equal(total(), '$55');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
  assert.equal(container.querySelector('.spend-calendar-navigation h3')?.textContent, 'September 2026');
  assert.equal(summaryTotal(), '$12.34');
  assert.equal(selectedDate(), undefined);
});

test('month summary refreshes with saved records and owner changes without changing the current view', async () => {
  let state = fixture();
  const render = (scope = 'personal') => root.render(createElement(SpendingCalendar, { state, scope, asOf: '2026-09-25' }));
  await act(async () => render());
  assert.equal(summaryTotal(), '$12.34');
  state = { ...state, revision: 2, transactions: [...state.transactions.map(row => row.id === 'one' ? { ...row, amountCents: 2000 } : row), expense('refund', { amountCents: -500, description: 'Store refund' })] };
  await act(async () => render());
  assert.equal(summaryTotal(), '$15');
  assert.equal(selectedDate(), undefined);
  await act(async () => render('shop'));
  assert.equal(summaryTotal(), '$50');
  assert.equal(selectedDate(), undefined);
  await act(async () => render('all'));
  assert.equal(summaryTotal(), '$40');
});

test('selected-day records, refunds and account ownership update when saved state changes', async () => {
  let state = fixture();
  const render = (scope = 'personal') => root.render(createElement(SpendingCalendar, { state, scope, asOf: '2026-09-25' }));
  await act(async () => render());
  await choose('2026-09-25');
  assert.equal(total(), '$0');
  assert.match(details().textContent!, /No expenses recorded for this day/);
  await choose('2026-09-23');
  assert.equal(total(), '$12.34');
  assert.match(details().textContent!, /Original merchant/);
  state = { ...state, revision: 2, transactions: [...state.transactions.map(row => row.id === 'one' ? { ...row, amountCents: 2000, description: 'Updated merchant' } : row), expense('refund', { amountCents: -500, description: 'Store refund' })] };
  const original = structuredClone(state);
  await act(async () => render());
  assert.equal(selectedDate(), '2026-09-23');
  assert.equal(total(), '$15');
  assert.match(details().textContent!, /2 expenses.*Updated merchant.*Store refund/);
  assert.doesNotMatch(details().textContent!, /Original merchant|Business merchant/);
  await act(async () => render('shop'));
  assert.equal(total(), '$50');
  assert.match(details().textContent!, /Business merchant.*Shop bank/);
  assert.doesNotMatch(details().textContent!, /Updated merchant|Store refund/);
  assert.deepEqual(state, original);
});

test('a calendar following Today advances its selected day and month when the date changes', async () => {
  const state = fixture();
  state.transactions.push(expense('next-day', { date: '2026-10-01', amountCents: 990, description: 'October purchase' }));
  const render = (asOf: string) => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf }));
  await act(async () => render('2026-09-30'));
  await act(async () => container.querySelector<HTMLButtonElement>('.spend-calendar-today')!.click());
  assert.equal(selectedDate(), '2026-09-30');
  await act(async () => render('2026-10-01'));
  assert.equal(selectedDate(), '2026-10-01');
  assert.equal(container.querySelector('.spend-calendar-navigation h3')?.textContent, 'October 2026');
  assert.equal(total(), '$9.90');
  assert.match(details().textContent!, /Today.*October purchase/);
});

test('a date change preserves a day chosen for historical review', async () => {
  const state = fixture();
  const render = (asOf: string) => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf }));
  await act(async () => render('2026-09-30'));
  await choose('2026-09-23');
  await act(async () => render('2026-10-01'));
  assert.equal(selectedDate(), '2026-09-23');
  assert.equal(container.querySelector('.spend-calendar-navigation h3')?.textContent, 'September 2026');
  assert.equal(total(), '$12.34');
  assert.match(details().textContent!, /Original merchant/);
  await act(async () => container.querySelector<HTMLButtonElement>('.spend-calendar-today')!.click());
  await act(async () => render('2026-10-02'));
  assert.equal(selectedDate(), '2026-10-02');
});

test('keyboard navigation across months retains its selection and focus when today changes', async () => {
  const state = fixture();
  const render = (asOf: string) => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf }));
  await act(async () => render('2026-10-01'));
  const first = container.querySelector<HTMLButtonElement>('[data-date="2026-10-01"]')!;
  await act(async () => { first.focus(); first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
  assert.equal(selectedDate(), '2026-09-30');
  assert.equal((document.activeElement as HTMLElement).dataset.date, '2026-09-30');
  await act(async () => render('2026-10-02'));
  assert.equal(selectedDate(), '2026-09-30');
  assert.equal((document.activeElement as HTMLElement).dataset.date, '2026-09-30');
});

test('month controls stay visible and focused while the new month is loading', async () => {
  const state = fixture();
  await act(async () => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf: '2026-10-01' })));
  const fetchFixture = globalThis.fetch;
  let release!: () => void;
  globalThis.fetch = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return fetchFixture(...args); };
  const previous = container.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!;
  await act(async () => { previous.focus(); previous.click(); });
  assert.equal(document.activeElement, previous);
  assert.equal(previous.closest('[hidden]'), null);
  assert.equal(container.querySelector('.spend-calendar-body')!.getAttribute('aria-busy'), 'true');
  assert.equal(container.querySelector<HTMLElement>('.spend-calendar-month-records')!.hidden, true);
  assert.equal(details().hidden, true);
  await act(async () => { release(); });
  assert.equal(document.activeElement, previous);
  assert.equal(container.querySelector('.spend-calendar-navigation h3')?.textContent, 'September 2026');
  assert.equal(container.querySelector<HTMLElement>('.spend-calendar-month-records')!.hidden, false);
  assert.equal(details().hidden, false);
});

test('the month picker jumps to saved history, clamps the selected day and ignores incomplete values', async () => {
  const state = fixture();
  state.transactions.push(expense('february', { date: '2026-02-28', amountCents: 5600, description: 'February expense' }));
  await act(async () => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf: '2026-09-30' })));
  await choose('2026-09-30');
  const input = container.querySelector<HTMLInputElement>('[aria-label="Calendar month"]')!;
  input.focus();
  await fillMonth('2026-02');
  assert.equal(summaryTotal(), '$56');
  assert.equal(document.activeElement, input);
  assert.equal(container.querySelector('.spend-calendar-navigation h3')!.textContent, 'February 2026');
  assert.equal(container.querySelector<HTMLButtonElement>('.spend-calendar-day[tabindex="0"]')!.dataset.date, '2026-02-28');
  for (const invalid of ['', '2026-13', '0000-01', '10000-01']) {
    await fillMonth(invalid);
    assert.equal(summaryTotal(), '$56');
    assert.equal(input.value, '2026-02');
  }
  await fillMonth('2026-09');
  assert.equal(container.querySelector<HTMLButtonElement>('.spend-calendar-day[tabindex="0"]')!.dataset.date, '2026-09-30');
  assert.equal(summaryTotal(), '$12.34');
});

test('category details follow aliases, explicit categories, planned subscriptions, refunds and ownership', async () => {
  const state = fixture();
  state.spendingLimits = [{ id: 'pets', entityId: 'personal', name: 'Pets', color: '#aabbcc', aliases: ['Vet'], dailyCents: null, weeklyCents: null, monthlyCents: null }];
  state.obligations = [{ id: 'sub', entityId: 'personal', accountId: 'bank', name: 'App subscription', category: 'Digital', amountCents: 1000, dueDate: '2026-09-24', direction: 'out', recurrence: 'monthly', status: 'planned', subscription: true }];
  state.transactions.push(
    expense('refund', { amountCents: -234, date: '2026-09-24', category: 'Groceries', description: 'Food refund' }),
    expense('business-food', { accountId: 'shop-bank', amountCents: 1000, category: 'Restaurants', description: 'Business lunch' }),
    expense('override', { amountCents: 700, category: 'Food', expenseCategory: 'Transport', description: 'Category override' }),
    expense('pet', { amountCents: 400, category: 'Vet', description: 'Pet expense' }),
    expense('sub-payment', { amountCents: 1000, category: 'Digital', source: 'Planned payment sub', description: 'Subscription payment' }),
  );
  const original = structuredClone(state);
  await act(async () => root.render(createElement(SpendingCalendar, { state, scope: 'all', asOf: '2026-09-25' })));
  await chooseCategory('food');
  assert.equal(details().querySelector('h3')!.textContent, 'Food & groceries');
  assert.equal(total(), '$15');
  assert.equal(details().querySelectorAll('.spend-calendar-entries > li').length, 3);
  assert.match(details().textContent!, /Food refund.*Business lunch.*50% of \$10/);
  assert.doesNotMatch(details().textContent!, /Category override|Pet expense|Subscription payment/);
  assert.equal(details().querySelector('time')!.dateTime, '2026-09-24');
  assert.equal(container.querySelector('.spend-calendar-grid')?.closest('[hidden]'), null);
  assert.equal(document.activeElement, details().querySelector('h3'));
  await monthSummary();
  await chooseCategory('transport');
  assert.equal(total(), '$7');
  assert.match(details().textContent!, /Category override/);
  await monthSummary();
  await chooseCategory('subscriptions');
  assert.equal(total(), '$10');
  assert.match(details().textContent!, /Subscription payment/);
  await monthSummary();
  await chooseCategory('custom:pets');
  assert.equal(total(), '$4');
  assert.match(details().textContent!, /Pet expense/);
  assert.deepEqual(state, original);
});

test('highest-day and category drilldowns return focus to their month-summary controls', async () => {
  const state = fixture();
  state.transactions.push(...['Gas', 'Clothing', 'Travel', 'Fees'].map((category, index) => expense(`extra-${index}`, { category, amountCents: 5000 - index * 1000 })));
  await act(async () => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf: '2026-09-25' })));
  const highest = details().querySelector<HTMLButtonElement>('[data-highest-day]')!;
  await act(async () => { highest.focus(); highest.click(); });
  assert.equal(document.activeElement, details().querySelector('h3'));
  await monthSummary();
  assert.equal(document.activeElement, details().querySelector('[data-highest-day]'));
  assert.equal(details().querySelector('[data-category-key="food"]')!.closest('details')?.open, false);
  await chooseCategory('food');
  assert.equal(document.activeElement, details().querySelector('h3'));
  await monthSummary();
  const food = details().querySelector<HTMLButtonElement>('[data-category-key="food"]')!;
  assert.equal(document.activeElement, food);
  assert.equal(food.closest('details')?.open, true);
  await choose('2026-09-23');
  await monthSummary();
  assert.equal(document.activeElement, details().querySelector('h3'));
});

test('expense rows open the requested record only when a record callback is supplied', async () => {
  const state = fixture();
  const selected: string[] = [];
  await act(async () => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf: '2026-09-25' })));
  await choose('2026-09-23');
  assert.equal(details().querySelector('.spend-calendar-entry-button'), null);
  await act(async () => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf: '2026-09-25', onTransaction: id => selected.push(id) })));
  await act(async () => details().querySelector<HTMLButtonElement>('[data-transaction-id="one"]')!.click());
  await monthSummary();
  await chooseCategory('food');
  await act(async () => details().querySelector<HTMLButtonElement>('[data-transaction-id="one"]')!.click());
  assert.deepEqual(selected, ['one', 'one']);
});

test('returning from a record waits for refreshed entries and uses the heading if its category disappears', async () => {
  let state = fixture();
  let handled = 0;
  const render = (returnFocusTo: string | null = null) => root.render(createElement(SpendingCalendar, { state, scope: 'personal', asOf: '2026-09-25', onTransaction: () => {}, returnFocusTo, onFocusReturned: () => { handled++; } }));
  await act(async () => render());
  await chooseCategory('food');
  const fetchFixture = globalThis.fetch;
  let release!: () => void;
  globalThis.fetch = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return fetchFixture(...args); };
  state = { ...state, revision: 2, transactions: state.transactions.map(item => item.id === 'one' ? { ...item, description: 'Updated record' } : item) };
  await act(async () => render('one'));
  assert.equal(details().hidden, true);
  assert.equal(handled, 0);
  await act(async () => release());
  assert.equal(document.activeElement, details().querySelector('[data-transaction-id="one"]'));
  assert.equal(handled, 1);
  await act(async () => render(null));
  state = { ...state, revision: 3, transactions: state.transactions.filter(item => item.id !== 'one') };
  await act(async () => render('one'));
  assert.equal(handled, 1);
  await act(async () => release());
  assert.equal(details().querySelector('h3')!.textContent, 'September 2026');
  assert.equal(document.activeElement, details().querySelector('h3'));
  assert.equal(handled, 2);
});
