import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Command, Transaction } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true });
const frames: FrameRequestCallback[] = [];
Object.defineProperty(dom.window, 'requestAnimationFrame', { value: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }, configurable: true });
const scrolled: HTMLElement[] = [];
HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
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
const { default: ExpensePlan } = await import('./features/expenses/ExpensePlan.tsx');
const { default: Expenses } = await import('./features/expenses/Expenses.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); localStorage.clear(); frames.length = 0; scrolled.length = 0; });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });

function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'bank', entityId: 'personal', name: 'Chequing', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }], transactions: [{ id: 'groceries', accountId: 'bank', toAccountId: null, date: '2026-01-01', createdAt: '2026-01-01T12:00:00Z', description: 'Grocery shop', kind: 'expense', amountCents: 1250, category: 'Food', source: 'Manual' }], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
function category(name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.expense-plan-category-select')].find(item => item.querySelector('strong')?.textContent === name);
  assert.ok(button, `Category ${name} is available`);
  return button;
}
function button(text: string, scope: Element = container): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text);
  assert.ok(result, `Button ${text} is available`);
  return result;
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const visiblePanel = () => container.querySelector<HTMLElement>('.expense-plan-detail-panel:not([hidden])')!;
async function flushFrames() { await act(async () => { for (const callback of frames.splice(0)) callback(0); }); }

test('categories are grouped while one detail panel opens below all groups', async () => {
  const state = fixture();
  const edited: Transaction[] = [];
  await act(async () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand: async () => {}, onCategory: () => {}, onEditCategory: transaction => edited.push(transaction) })));
  const grid = container.querySelector('.expense-plan-groups')!;
  assert.equal(grid.querySelectorAll('.expense-plan-category-card').length, 14);
  assert.doesNotMatch(grid.textContent!, /Health & fitness/);
  assert.deepEqual([...grid.querySelectorAll('.expense-plan-group-heading h3')].map(item => item.textContent), ['Everyday essentials', 'Lifestyle', 'Occasional spending', 'Fees & other spending']);
  assert.equal(container.querySelectorAll('.expense-plan-detail-panel:not([hidden])').length, 0);
  await act(async () => category('Food & groceries').click());
  const panel = visiblePanel();
  assert.equal(panel.getAttribute('aria-label'), 'Food & groceries details');
  assert.equal(grid.contains(panel), false);
  assert.match(panel.textContent!, /Grocery shop/);
  const children = [...panel.children];
  assert.ok(children.indexOf(panel.querySelector('.expense-plan-recorded')!) < children.indexOf(panel.querySelector('.expense-plan-details')!));
  await act(async () => button('Edit category', panel).click());
  assert.equal(edited[0], state.transactions[0]);
  await act(async () => category('Personal care').click());
  assert.equal(container.querySelectorAll('.expense-plan-detail-panel:not([hidden])').length, 1);
  assert.equal(visiblePanel().getAttribute('aria-label'), 'Personal care details');
  assert.equal(grid.querySelectorAll('.expense-plan-category-card').length, 14);
});

test('monthly amounts keep zero distinct from unset and planned item drafts survive category switching', async () => {
  const state = fixture();
  const commands: Command[] = [];
  const render = () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand: async command => { commands.push(command); if (command.type === 'save_spending_limit') state.spendingLimits = [command.limit]; render(); }, onCategory: () => {} }));
  await act(async () => render());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Set Food & groceries monthly amount"]')!.click());
  await fill(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!, '0');
  await act(async () => visiblePanel().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.ok(commands[0].type === 'save_spending_limit');
  assert.equal(commands[0].limit.monthlyCents, 0);
  assert.equal(commands[0].budgetMonth, '2026-01');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Edit Food & groceries monthly amount"]')!.click());
  await act(async () => button('Clear amount', visiblePanel()).click());
  assert.ok(commands[1].type === 'save_spending_limit');
  assert.equal(commands[1].limit.monthlyCents, null);
  assert.equal(commands[1].budgetMonth, '2026-01');
  await act(async () => button('+ Add item', visiblePanel()).click());
  await fill(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-item-editor input')!, 'Weekly groceries');
  await act(async () => category('Personal care').click());
  await act(async () => category('Food & groceries').click());
  assert.equal(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-item-editor input')!.value, 'Weekly groceries');
});

test('large categories render only 50 recorded rows for the selected panel and link to the ledger', async () => {
  const state = fixture();
  const original = state.transactions[0];
  state.transactions = Array.from({ length: 10000 }, (_, index) => ({ ...original, id: `expense-${index}`, description: `Expense ${index}` }));
  const ledgerCalls: string[] = [];
  await act(async () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand: async () => {}, onCategory: name => ledgerCalls.push(name) })));
  assert.equal(container.querySelectorAll('.expense-plan-entries li').length, 0);
  await act(async () => category('Food & groceries').click());
  assert.equal(container.querySelectorAll('.expense-plan-entries li').length, 50);
  assert.match(visiblePanel().textContent!, /Showing 50 of 10000 expenses/);
  await act(async () => button('View transactions', visiblePanel()).click());
  assert.deepEqual(ledgerCalls, ['Food']);
  await act(async () => category('Personal care').click());
  assert.equal(container.querySelectorAll('.expense-plan-entries li').length, 0);
});

test('category actions reveal details or focus the amount without moving the page on refresh or save', async () => {
  const state = fixture();
  const render = () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand: async () => {}, onCategory: () => {} }));
  await act(async () => render());
  assert.equal(scrolled.length, 0);
  await act(async () => category('Food & groceries').click());
  await flushFrames();
  assert.equal(document.activeElement, visiblePanel());
  assert.deepEqual(scrolled, [visiblePanel()]);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Set Food & groceries monthly amount"]')!.click());
  await flushFrames();
  const amount = visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!;
  assert.equal(document.activeElement, amount);
  assert.equal(scrolled.at(-1), amount);
  const scrollCount = scrolled.length;
  state.revision++;
  await act(async () => render());
  await flushFrames();
  await fill(amount, '250');
  await act(async () => visiblePanel().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await flushFrames();
  assert.equal(scrolled.length, scrollCount);
});

test('closing category details returns focus to the button that opened them', async () => {
  await act(async () => root.render(createElement(ExpensePlan, { state: fixture(), scope: 'personal', month: '2026-01', readOnly: false, onCommand: async () => {}, onCategory: () => {} })));
  const triggers = [
    category('Food & groceries'),
    category('Food & groceries').closest('.expense-plan-category-card')!.querySelector<HTMLButtonElement>('.expense-plan-spent')!,
    container.querySelector<HTMLButtonElement>('[aria-label="View Trips plans and dates"]')!,
  ];
  for (const trigger of triggers) {
    await act(async () => trigger.click());
    await flushFrames();
    assert.equal(document.activeElement, visiblePanel());
    await act(async () => button('Close', visiblePanel()).click());
    assert.equal(visiblePanel(), null);
    assert.equal(document.activeElement, trigger);
  }
});

test('closing an edited category preserves its draft and returns focus to the monthly amount button', async () => {
  const state = fixture();
  const original = structuredClone(state);
  const commands: Command[] = [];
  await act(async () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand: async command => { commands.push(command); }, onCategory: () => {} })));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Set Food & groceries monthly amount"]')!;
  await act(async () => trigger.click());
  await flushFrames();
  await fill(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!, '83.36');
  await act(async () => button('Close', visiblePanel()).click());
  assert.equal(document.activeElement, trigger);
  assert.equal(visiblePanel(), null);
  assert.equal(document.querySelector('dialog[open]'), null);
  await act(async () => category('Food & groceries').click());
  assert.equal(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!.value, '83.36');
  assert.deepEqual(commands, []);
  assert.deepEqual(state, original);
});

test('closing category details focuses the spending plan heading if the originating action is removed', async () => {
  const state = fixture();
  const render = (readOnly: boolean) => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly, onCommand: async () => {}, onCategory: () => {} }));
  await act(async () => render(false));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Set Food & groceries monthly amount"]')!;
  await act(async () => trigger.click());
  await flushFrames();
  await act(async () => render(true));
  assert.equal(trigger.isConnected, false);
  await act(async () => button('Close', visiblePanel()).click());
  assert.equal(document.activeElement, container.querySelector('.expense-plan-heading h2'));
  assert.equal(document.activeElement?.textContent, 'Spending plan');
});

function budgetState(): AppState {
  return { ...fixture(), spendingLimits: [{ id: 'personal:food', entityId: 'personal', name: 'Food', color: '#E8B975', aliases: ['Groceries'], dailyCents: null, weeklyCents: 5000, monthlyCents: 20000 }] };
}

for (const trigger of ['background refresh', 'save conflict'] as const) {
  test(`a monthly amount draft requires review after a ${trigger} and preserves the updated limit fields`, async () => {
    let state = budgetState();
    const commands: Command[] = [];
    const newer = (): AppState => ({ ...state, revision: 2, spendingLimits: state.spendingLimits!.map(limit => ({ ...limit, weeklyCents: 7500, monthlyCents: 30000 })) });
    const onCommand = async (command: Command) => {
      commands.push(command);
      if (trigger === 'save conflict' && commands.length === 1) {
        state = newer(); render(); throw new Error('Your records changed in another window.');
      }
    };
    const render = () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand, onCategory: () => {} }));
    await act(async () => render());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Edit Food & groceries monthly amount"]')!.click());
    await fill(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!, '250');
    const submit = async () => { await act(async () => visiblePanel().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };
    if (trigger === 'background refresh') { state = newer(); await act(async () => render()); }
    else { await submit(); assert.equal(commands[0].expectedRevision, 1); }
    assert.equal(button('Save amount', visiblePanel()).disabled, true);
    assert.equal(button('Clear amount', visiblePanel()).disabled, true);
    assert.match(visiblePanel().textContent!, /saved monthly amount for Food & groceries is \$300\. Your draft is still here/);
    const sentBeforeReview = commands.length;
    await submit();
    assert.equal(commands.length, sentBeforeReview);
    await act(async () => button('Review updated records', visiblePanel()).click());
    assert.equal(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!.value, '250');
    assert.equal(button('Save amount', visiblePanel()).disabled, false);
    await submit();
    const saved = commands.at(-1)!;
    assert.equal(saved.expectedRevision, 2);
    assert.ok(saved.type === 'save_spending_limit');
    assert.equal(saved.limit.monthlyCents, 25000);
    assert.equal(saved.limit.weeklyCents, 7500);
  });
}

test('a new category keeps its name, amount, aliases and ID while reviewing a failed save', async () => {
  let state = fixture();
  const commands: Command[] = [];
  const onCommand = async (command: Command) => {
    commands.push(command);
    if (commands.length === 1) { state = { ...state, revision: 2 }; render(); throw new Error('Your records changed in another window.'); }
  };
  const render = () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand, onCategory: () => {} }));
  await act(async () => render());
  await act(async () => button('+ Add category').click());
  const form = container.querySelector<HTMLFormElement>('.expense-plan-newcategory')!;
  const inputs = form.querySelectorAll<HTMLInputElement>('input');
  await fill(inputs[0], 'Pets'); await fill(inputs[1], '50'); await fill(inputs[2], 'Vet');
  const submit = async () => { await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };
  await submit();
  assert.equal(commands[0].expectedRevision, 1);
  assert.equal(button('Add category', form).disabled, true);
  await submit(); assert.equal(commands.length, 1);
  await act(async () => button('Review updated records', form).click());
  assert.deepEqual([...form.querySelectorAll<HTMLInputElement>('input')].map(input => input.value), ['Pets', '50', 'Vet']);
  await submit();
  assert.equal(commands.length, 2);
  assert.equal(commands[1].expectedRevision, 2);
  assert.ok(commands[0].type === 'save_spending_limit' && commands[1].type === 'save_spending_limit');
  assert.deepEqual(commands[1].limit, commands[0].limit);
  assert.equal(commands[1].limit.monthlyCents, 5000);
  assert.equal(commands[1].budgetMonth, '2026-01');
});

test('switching months shows the saved monthly amount and cannot submit the previous month draft', async () => {
  const state = budgetState();
  state.spendingLimits![0].monthlyAmounts = { '2026-09': 25000, '2026-10': 40000 };
  const commands: Command[] = [];
  let month = '2026-09';
  const render = () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month, readOnly: false, onCommand: async command => { commands.push(command); }, onCategory: () => {} }));
  await act(async () => render());
  assert.match(container.textContent!, /For September 2026/);
  assert.match(container.querySelector('.expense-plan-summary')!.textContent!, /\$250 planned for September 2026/);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Edit Food & groceries monthly amount"]')!.click());
  assert.equal(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!.value, '250.00');
  await fill(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!, '125');
  month = '2026-10';
  await act(async () => render());
  assert.match(container.textContent!, /For October 2026/);
  assert.equal(container.querySelector('.expense-plan-editor'), null);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Edit Food & groceries monthly amount"]')!.click());
  assert.equal(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!.value, '400.00');
  await fill(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!, '450');
  await act(async () => visiblePanel().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(commands.length, 1);
  assert.ok(commands[0].type === 'save_spending_limit');
  assert.equal(commands[0].budgetMonth, '2026-10');
  assert.equal(commands[0].limit.monthlyCents, 45000);
  month = '2026-09';
  await act(async () => render());
  assert.match(container.querySelector('.expense-plan-summary')!.textContent!, /\$250 planned for September 2026/);
});


test('occasional categories open dated plans first and preserve saved monthly targets', async () => {
  const state = fixture();
  state.spendingLimits = [{ id: 'personal:digital', entityId: 'personal', name: 'Digital', aliases: [], color: '#ACA7DC', dailyCents: null, weeklyCents: null, monthlyCents: 15000 }];
  state.expensePlanItems = [{ id: 'weekend', entityId: 'personal', categoryId: 'personal:trips', name: 'Montreal weekend', date: '2026-08-15', amountCents: 40000, notes: '' }];
  const commands: Command[] = [];
  await act(async () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand: async command => { commands.push(command); }, onCategory: () => {} })));
  const trips = category('Trips').closest('.expense-plan-category-card')!;
  assert.equal(trips.querySelector('.expense-plan-budget'), null);
  assert.match(trips.textContent!, /1 planned item/);
  assert.ok(container.querySelector('[aria-label^="Edit Digital purchases monthly amount"]'));
  await act(async () => trips.querySelector<HTMLButtonElement>('.expense-plan-items-link')!.click());
  const panel = visiblePanel();
  const children = [...panel.children];
  assert.ok(children.indexOf(panel.querySelector('.expense-plan-details')!) < children.indexOf(panel.querySelector('.expense-plan-recorded')!));
  assert.match(panel.textContent!, /Trip plans.*Montreal weekend.*Aug 15, 2026.*\$400/s);
  await act(async () => button('Set a target for January 2026', panel).click());
  await fill(panel.querySelector<HTMLInputElement>('.expense-plan-editor:not(.expense-plan-item-editor) input')!, '500');
  await act(async () => panel.querySelector<HTMLFormElement>('.expense-plan-editor')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.ok(commands[0].type === 'save_spending_limit');
  assert.equal(commands[0].budgetMonth, '2026-01');
  assert.equal(commands[0].limit.monthlyCents, 50000);
  assert.equal(state.expensePlanItems[0].amountCents, 40000);
});

test('spend comparisons show labelled direction and missing history independently of budget overruns', async () => {
  const state = fixture();
  state.statements = [{ id: 'complete', accountId: 'bank', sourceFile: 'statement.pdf', sha256: 'a'.repeat(64), periodStart: '2025-12-01', periodEnd: '2026-01-31', openingBalanceCents: 0, closingBalanceCents: 0, rows: [] }];
  state.transactions.push({ ...state.transactions[0], id: 'prior-food', date: '2025-12-01', amountCents: 2500 }, { ...state.transactions[0], id: 'digital', category: 'Digital', amountCents: 3000 }, { ...state.transactions[0], id: 'prior-digital', category: 'Digital', date: '2025-12-01', amountCents: 1000 });
  state.spendingLimits = [{ id: 'personal:food', entityId: 'personal', name: 'Food', aliases: [], color: '#E8B975', dailyCents: null, weeklyCents: null, monthlyCents: 500 }];
  await act(async () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand: async () => {}, onCategory: () => {} })));
  const food = category('Food & groceries').closest('.expense-plan-category-card')!;
  assert.match(food.querySelector('.expense-plan-spent')!.textContent!, /\$12.50.*↓ \$12.50 lower/);
  assert.ok(food.querySelector('.expense-plan-spent.is-lower'));
  assert.match(food.textContent!, /\$7.50 over target/);
  assert.ok(category('Digital purchases').closest('.expense-plan-category-card')!.querySelector('.expense-plan-spent.is-higher'));
  assert.match(category('Trips').closest('.expense-plan-category-card')!.querySelector('.expense-plan-spent.is-unavailable')!.textContent!, /No prior records/);
  assert.match(container.querySelector('.expense-plan-comparison-key')!.textContent!, /Dec 2025/);
});

test('incomplete statements label neutral recorded differences instead of favorable lower spending', async () => {
  const state = fixture();
  state.transactions = [{ ...state.transactions[0], id: 'prior', date: '2025-12-01', amountCents: 2500 }];
  await act(async () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: true, onCommand: async () => {}, onCategory: () => {} })));
  const spent = category('Food & groceries').closest('.expense-plan-category-card')!.querySelector('.expense-plan-spent')!;
  assert.match(spent.textContent!, /\$0.*\$25 less recorded/);
  assert.equal(spent.classList.contains('is-lower'), false);
  assert.match(container.querySelector('.expense-plan-comparison-key')!.textContent!, /Statement coverage is incomplete/);
});

test('switching planned records and leaving a hidden dirty category require a discard choice', async () => {
  const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
  const state = fixture();
  state.expensePlanItems = ['Groceries', 'Lunch'].map((name, index) => ({ id: `item-${index}`, name, entityId: 'personal', categoryId: 'personal:food', amountCents: 5000, date: '2026-01-02', notes: '' }));
  await act(async () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand: async () => {}, onCategory: () => {} })));
  await act(async () => category('Food & groceries').click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit Groceries"]')!.click());
  const name = () => container.querySelector<HTMLInputElement>('.expense-plan-item-editor input')!;
  await fill(name(), 'Groceries draft');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit Lunch"]')!.click());
  assert.equal(name().value, 'Groceries draft');
  let dialog = document.querySelector('dialog')!;
  assert.ok(dialog.open);
  await act(async () => button('Keep editing', dialog).click());
  assert.equal(name().value, 'Groceries draft');
  await act(async () => category('Personal care').click());
  let navigated = 0;
  await act(async () => { assert.equal(requestDraftNavigation(() => { navigated++; }), false); });
  assert.equal(navigated, 0);
  dialog = document.querySelector('dialog')!;
  assert.ok(dialog.open);
  assert.equal(dialog.closest('[hidden]'), null);
  await act(async () => button('Keep editing', dialog).click());
  await act(async () => category('Food & groceries').click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit Lunch"]')!.click());
  await act(async () => button('Discard changes', document.querySelector('dialog')!).click());
  assert.equal(name().value, 'Lunch');
});

test('plan links only offer the same owner and persist one bill or recorded expense', async () => {
  const state = fixture();
  state.accounts.push({ ...state.accounts[0], id: 'other-bank', entityId: 'other' });
  state.obligations = [{ id: 'food-bill', entityId: 'personal', name: 'Grocery delivery', amountCents: 1250, dueDate: '2026-01-02', direction: 'out', recurrence: 'once', status: 'planned', accountId: 'bank', category: 'Food' }, { id: 'other-bill', entityId: 'other', name: 'Other owner bill', amountCents: 1250, dueDate: '2026-01-02', direction: 'out', recurrence: 'once', status: 'planned', accountId: 'other-bank', category: 'Food' }];
  state.transactions.push({ ...state.transactions[0], id: 'other-expense', accountId: 'other-bank', description: 'Other expense' });
  const commands: Command[] = [];
  await act(async () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', readOnly: false, onCommand: async command => { commands.push(command); }, onCategory: () => {} })));
  await act(async () => category('Food & groceries').click());
  await act(async () => button('+ Add item', visiblePanel()).click());
  await fill(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-item-editor input')!, 'Food plan');
  const link = visiblePanel().querySelector<HTMLSelectElement>('.expense-plan-item-editor select')!;
  assert.ok(link.querySelector('[value="bill:food-bill"]'));
  assert.ok(link.querySelector('[value="expense:groceries"]'));
  assert.equal(link.querySelector('[value="bill:other-bill"]'), null);
  assert.equal(link.querySelector('[value="expense:other-expense"]'), null);
  await act(async () => { link.value = 'bill:food-bill'; link.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { link.value = 'expense:groceries'; link.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Save item', visiblePanel()).click());
  assert.equal(commands.length, 1);
  assert.ok(commands[0].type === 'save_expense_plan_item');
  assert.equal(commands[0].item.transactionId, 'groceries');
  assert.equal(commands[0].item.obligationId, undefined);
  assert.equal(commands[0].item.separatePaymentConfirmed, undefined);
});

test('a planned-item link opens its category and focuses the visible details', async () => {
  const state = fixture();
  state.expensePlanItems = [{ id: 'trip-1', entityId: 'personal', categoryId: 'personal:trips', name: 'Montreal', amountCents: 40000, date: '2026-01-20', notes: '' }];
  await act(async () => root.render(createElement(ExpensePlan, { state, scope: 'personal', month: '2026-01', initialRecordId: 'trip-1', readOnly: true, onCommand: async () => {}, onCategory: () => {} })));
  assert.equal(visiblePanel().getAttribute('aria-label'), 'Trips details');
  assert.match(visiblePanel().textContent!, /Montreal/);
  await flushFrames();
  assert.equal(document.activeElement, visiblePanel());
});

test('monthly target and category drafts require a choice before replacing them or leaving the page', async () => {
  const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
  await act(async () => root.render(createElement(ExpensePlan, { state: fixture(), scope: 'personal', month: '2026-01', readOnly: false, onCommand: async () => {}, onCategory: () => {} })));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Set Food & groceries monthly amount"]')!.click());
  await fill(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!, '200');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Set Transport monthly amount"]')!.click());
  assert.ok(document.querySelector('dialog')!.open);
  assert.equal(visiblePanel().getAttribute('aria-label'), 'Food & groceries details');
  await act(async () => button('Keep editing', document.querySelector('dialog')!).click());
  assert.equal(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!.value, '200');
  await act(async () => button('Cancel', visiblePanel()).click());
  await act(async () => button('Discard changes', document.querySelector('dialog')!).click());
  await act(async () => container.querySelector<HTMLButtonElement>('.expense-plan-add')!.click());
  await fill(container.querySelector<HTMLInputElement>('.expense-plan-newcategory input')!, 'Pets');
  let navigated = 0;
  await act(async () => { assert.equal(requestDraftNavigation(() => { navigated++; }), false); });
  assert.equal(navigated, 0);
  await act(async () => button('Discard changes', document.querySelector('dialog')!).click());
  assert.equal(navigated, 1);
});

for (const draft of ['monthly target', 'planned item', 'new category'] as const) {
  test(`changing the spending month protects an unsaved ${draft}`, async () => {
    let commands = 0;
    await act(async () => root.render(createElement(Expenses, { state: fixture(), scope: 'personal', initialSection: 'plan', readOnly: false, onCommand: async () => { commands++; }, onOpen: () => {} })));
    const month = () => container.querySelector<HTMLInputElement>('.expense-month-nav input')!.value;
    const originalMonth = month();
    let input: HTMLInputElement;
    if (draft === 'new category') {
      await act(async () => container.querySelector<HTMLButtonElement>('.expense-plan-add')!.click());
      input = container.querySelector<HTMLInputElement>('.expense-plan-newcategory input')!;
    } else {
      await act(async () => category('Food & groceries').click());
      if (draft === 'planned item') {
        await act(async () => button('+ Add item', visiblePanel()).click());
        input = visiblePanel().querySelector<HTMLInputElement>('.expense-plan-item-editor input')!;
      } else {
        await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Set Food & groceries monthly amount"]')!.click());
        input = visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!;
      }
    }
    const value = draft === 'monthly target' ? '345' : 'Unsaved plan';
    await fill(input, value);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Previous spending month"]')!.click());
    assert.equal(month(), originalMonth);
    assert.equal(input.value, value);
    assert.ok(document.querySelector('dialog')!.open);
    await act(async () => button('Keep editing', document.querySelector('dialog')!).click());
    assert.equal(input.isConnected, true);
    assert.equal(input.value, value);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Previous spending month"]')!.click());
    await act(async () => button('Discard changes', document.querySelector('dialog')!).click());
    assert.notEqual(month(), originalMonth);
    assert.equal(input.isConnected, false);
    assert.equal(commands, 0);
  });

  test(`discarding a ${draft} before leaving Budget clears the hidden editor`, async () => {
    let commands = 0;
    await act(async () => root.render(createElement(Expenses, { state:fixture(), scope:'personal', initialSection:'plan', readOnly:false, onCommand:async()=>{commands++;}, onOpen:()=>{} })));
    const openDraft = async () => {
      if (draft === 'new category') {
        await act(async () => container.querySelector<HTMLButtonElement>('.expense-plan-add')!.click());
        return container.querySelector<HTMLInputElement>('.expense-plan-newcategory input')!;
      }
      await act(async () => category('Food & groceries').click());
      if (draft === 'planned item') {
        await act(async () => button('+ Add item', visiblePanel()).click());
        return visiblePanel().querySelector<HTMLInputElement>('.expense-plan-item-editor input')!;
      }
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Set Food & groceries monthly amount"]')!.click());
      return visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!;
    };
    const input = await openDraft();
    await fill(input, draft === 'monthly target' ? '345' : 'Unsaved plan');
    await act(async () => button('Transactions', container.querySelector('[aria-label="Expense views"]')!).click());
    await act(async () => button('Discard changes', document.querySelector('dialog')!).click());
    assert.equal(input.isConnected, false);
    assert.equal(container.querySelector<HTMLElement>('.expense-month-workspace')!.hidden, true);
    await act(async () => button('Budget').click());
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(container.querySelector<HTMLElement>('.expense-month-workspace')!.hidden, false);
    assert.equal((await openDraft()).value, '');
    assert.equal(commands, 0);
  });
}

test('the spending month cannot change while its monthly target is saving', async () => {
  let finish: (() => void) | undefined;
  await act(async () => root.render(createElement(Expenses, { state: fixture(), scope: 'personal', initialSection: 'plan', readOnly: false, onCommand: () => new Promise<void>(resolve => { finish = resolve; }), onOpen: () => {} })));
  const month = () => container.querySelector<HTMLInputElement>('.expense-month-nav input')!.value;
  const originalMonth = month();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Set Food & groceries monthly amount"]')!.click());
  await fill(visiblePanel().querySelector<HTMLInputElement>('.expense-plan-editor input')!, '345');
  await act(async () => button('Save amount', visiblePanel()).click());
  assert.ok(finish);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Previous spending month"]')!.click());
  assert.equal(month(), originalMonth);
  assert.equal(document.querySelector('dialog'), null);
  await act(async () => finish!());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Previous spending month"]')!.click());
  assert.notEqual(month(), originalMonth);
});

test('leaving category review protects an unsaved merchant rule', async () => {
  await act(async () => root.render(createElement(Expenses, { state: fixture(), scope: 'personal', readOnly: false, initialSection: 'activity', onCommand: async () => {}, onOpen: () => {} })));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Categorize transactions"]')!.click());
  await act(async () => {
    const rules = container.querySelector<HTMLDetailsElement>('.category-rules')!;
    rules.open = true;
    rules.dispatchEvent(new Event('toggle'));
  });
  await act(async () => button('Add merchant rule').click());
  const merchant = container.querySelector<HTMLInputElement>('.category-rule-editor input')!;
  await fill(merchant, 'Grocery merchant');
  await act(async () => button('All transactions').click());
  assert.equal(merchant.isConnected, true);
  assert.ok(document.querySelector('dialog')!.open);
  await act(async () => button('Keep editing', document.querySelector('dialog')!).click());
  assert.equal(merchant.value, 'Grocery merchant');
  await act(async () => button('All transactions').click());
  await act(async () => button('Discard changes', document.querySelector('dialog')!).click());
  assert.equal(merchant.isConnected, false);
  assert.equal(button('All transactions').getAttribute('aria-pressed'), 'true');
});
