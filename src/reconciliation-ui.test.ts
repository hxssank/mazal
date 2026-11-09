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
const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
const { default: Forms } = await import('./features/entries/Forms.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });

function transaction(id: string, description: string, kind: Transaction['kind'], amountCents: number, delta: number): Transaction {
  return { id, description, kind, amountCents, accountId: 'cash', toAccountId: null, date: '2026-01-01', createdAt: '2026-01-01T12:00:00Z', category: kind === 'opening' ? 'Balance adjustment' : 'Food', source: 'Manual', balanceChanges: { cash: delta } };
}
function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'cash', entityId: 'personal', name: 'Cash', type: 'cash', currency: 'CAD', balanceCents: 9000, reconciledAt: null }], transactions: [transaction('opening', 'Opening balance', 'opening', 10000, 10000), transaction('groceries', 'Groceries', 'expense', 1000, -1000)], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
function button(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === label);
  assert.ok(item, `Button ${label} exists`);
  return item;
}
function checkbox(description: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="Check ${description}"]`);
  assert.ok(input, `Check ${description} exists`);
  return input;
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
function totals() { return container.querySelector('.reconciliation-totals')!.textContent!; }

test('closed account reconciliation cannot start a balance correction on a different account', async () => {
  const state = fixture();
  state.accounts[0].closedAt='2026-01-01';
  state.accounts.push({...state.accounts[0],id:'open',name:'Current bank',closedAt:undefined});
  await act(async () => root.render(createElement(Forms, { kind:'reconcile', state, accountId:'cash', onCommand:async()=>{}, onClose:()=>{} })));
  assert.equal(button('Adjust balance').disabled,true);
  assert.match(container.textContent!,/Reopen this account in Manage accounts before adjusting/);
});

test('a missing requested reconciliation account never selects another account silently', async () => {
  const commands:Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind:'reconcile', state:fixture(), accountId:'removed', onCommand:async command=>{commands.push(command);}, onClose:()=>{} })));
  const select = container.querySelector<HTMLSelectElement>('select')!;
  assert.equal(select.value, '');
  assert.match(container.textContent!, /selected account is unavailable/);
  assert.equal(button('Adjust balance').disabled, true);
  assert.equal(button('Finish reconciliation').disabled, true);
  await submit();
  assert.equal(commands.length, 0);
  await act(async () => { select.value='cash'; select.dispatchEvent(new Event('change', {bubbles:true})); });
  assert.equal(select.value, 'cash');
  assert.equal(container.querySelector<HTMLInputElement>('[name="statementBalance"]')!.value, '90.00');
});

test('a removed reconciliation account requires discard before choosing a replacement for its draft', async () => {
  let state = fixture();
  const render = () => root.render(createElement(Forms, { kind:'reconcile', state, accountId:'cash', onCommand:async()=>{}, onClose:()=>{} }));
  await act(async () => render());
  await fill(container.querySelector<HTMLInputElement>('[name="statementBalance"]')!, '75');
  state = { ...state, revision:2, accounts:[{ ...state.accounts[0], id:'replacement', name:'Replacement', balanceCents:12000 }] };
  await act(async () => render());
  const select = container.querySelector<HTMLSelectElement>('select')!;
  assert.equal(select.value, '');
  assert.equal(button('Adjust balance').disabled, true);
  await act(async () => { select.value='replacement'; select.dispatchEvent(new Event('change', {bubbles:true})); });
  assert.equal(container.querySelector<HTMLInputElement>('[name="statementBalance"]')!.value, '75');
  assert.ok(document.querySelector('dialog.draft-discard-dialog')?.hasAttribute('open'));
  await act(async () => button('Discard changes').click());
  assert.equal(select.value, 'replacement');
  assert.equal(container.querySelector<HTMLInputElement>('[name="statementBalance"]')!.value, '120.00');
});

test('checked entries explain the difference and finishing saves checks without a balance adjustment', async () => {
  const commands: Command[] = [];
  let closed = 0;
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state: fixture(), accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => { closed++; } })));
  assert.match(container.textContent!, /Reconcile account/);
  assert.equal(button('Finish reconciliation').disabled, true);
  await act(async () => checkbox('Opening balance').click());
  assert.match(totals(), /Checked balance\$100Difference-\$10/);
  assert.equal(button('Finish reconciliation').disabled, true);
  await act(async () => checkbox('Groceries').click());
  assert.match(totals(), /Checked balance\$90Difference\$0/);
  assert.equal(button('Finish reconciliation').disabled, false);
  await submit();
  assert.equal(commands.length, 1);
  assert.ok(commands[0].type === 'save_reconciliation');
  assert.equal(commands[0].balanceCents, 9000);
  assert.equal(commands[0].finish, true);
  assert.deepEqual(commands[0].clearedTransactionIds, ['groceries', 'opening']);
  assert.equal(closed, 1);
});

test('a historical negative balance can be reconciled while the current balance is positive', async () => {
  const state = fixture();
  state.transactions[1] = transaction('groceries', 'Groceries', 'expense', 12000, -12000);
  state.transactions.push({ ...transaction('pay', 'Pay', 'income', 11000, 11000), date: '2026-02-01' });
  const commands: Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => {} })));
  await fill(container.querySelector<HTMLInputElement>('input[type="date"]')!, '2026-01-31');
  await fill(container.querySelector<HTMLInputElement>('input[name="statementBalance"]')!, '-20.00');
  await act(async () => checkbox('Opening balance').click());
  await act(async () => checkbox('Groceries').click());
  assert.match(totals(), /Checked balance-\$20Difference\$0/);
  assert.equal(button('Finish reconciliation').disabled, false);
  await submit();
  assert.equal(commands.length, 1);
  assert.ok(commands[0].type === 'save_reconciliation');
  assert.equal(commands[0].balanceCents, -2000);
  assert.deepEqual(commands[0].clearedTransactionIds, ['groceries', 'opening']);
  assert.equal(state.accounts[0].balanceCents, 9000);
});

test('explicit cash and credit account adjustments accept a negative observed balance', async () => {
  for (const type of ['cash', 'debt', 'payable'] as const) {
    await act(async () => root.unmount());
    root = createRoot(container);
    const state = fixture();
    state.accounts[0].type = type;
    const commands: Command[] = [];
    await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => {} })));
    await fill(container.querySelector<HTMLInputElement>('input[name="statementBalance"]')!, '-12.34');
    await act(async () => button('Adjust balance').click());
    await fill(container.querySelector<HTMLInputElement>('input[name="note"]')!, 'Confirmed statement balance');
    await submit();
    assert.equal(commands.length, 1);
    assert.ok(commands[0].type === 'reconcile');
    assert.equal(commands[0].balanceCents, -1234);
  }
});

test('reviewing a refreshed checkpoint preserves its locked entries and the local unchecked-period draft', async () => {
  let state = fixture();
  const commands: Command[] = [];
  const render = () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => {} }));
  await act(async () => render());
  await act(async () => checkbox('Groceries').click());
  state = { ...state, revision: 2, accounts: [{ ...state.accounts[0], clearedTransactionIds: ['opening'], reconciliation: { date: '2026-01-01', balanceCents: 10000, transactionIds: ['opening'] } }] };
  await act(async () => render());
  assert.equal(button('Save checks').disabled, true);
  await submit();
  assert.equal(commands.length, 0);
  await act(async () => button('Review updated records').click());
  assert.equal(checkbox('Groceries').checked, true);
  assert.match(totals(), /Checked balance\$90Difference\$0/);
  const showReconciled = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes('Show reconciled'))!;
  await act(async () => showReconciled.click());
  assert.equal(checkbox('Opening balance').checked, true);
  assert.equal(checkbox('Opening balance').disabled, true);
  await submit();
  assert.equal(commands[0].expectedRevision, 2);
  assert.ok(commands[0].type === 'save_reconciliation');
  assert.deepEqual(commands[0].clearedTransactionIds, ['groceries', 'opening']);
});

test('existing reconciled entries stay checked while the next statement is completed', async () => {
  const state = fixture();
  state.accounts[0].clearedTransactionIds = ['opening'];
  state.accounts[0].reconciliation = { date: '2026-01-01', balanceCents: 10000, transactionIds: ['opening'] };
  const commands: Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => {} })));
  assert.equal(container.querySelector('[aria-label="Check Opening balance"]'), null);
  assert.match(totals(), /Checked balance\$100Difference-\$10/);
  await act(async () => checkbox('Groceries').click());
  await submit();
  assert.ok(commands[0].type === 'save_reconciliation');
  assert.deepEqual(commands[0].clearedTransactionIds, ['groceries', 'opening']);
});

test('reviewing updated records merges independent transaction checks saved in another tab', async () => {
  let state = fixture();
  const commands: Command[] = [];
  const render = () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => {} }));
  await act(async () => render());
  await act(async () => checkbox('Groceries').click());
  state = { ...state, revision: 2, accounts: [{ ...state.accounts[0], clearedTransactionIds: ['opening'] }] };
  await act(async () => render());
  await act(async () => button('Review updated records').click());
  assert.equal(checkbox('Opening balance').checked, true);
  assert.equal(checkbox('Groceries').checked, true);
  assert.match(totals(), /Checked balance\$90Difference\$0/);
  await submit();
  assert.ok(commands[0].type === 'save_reconciliation');
  assert.deepEqual(commands[0].clearedTransactionIds, ['groceries', 'opening']);
  assert.equal(commands[0].expectedRevision, 2);
});

test('reviewing updated records preserves local removals and adopts remote removals of untouched checks', async () => {
  let state = fixture();
  state.transactions.push(transaction('coffee', 'Coffee', 'expense', 500, -500));
  state.accounts[0].clearedTransactionIds = ['opening', 'groceries'];
  const commands: Command[] = [];
  const render = () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => {} }));
  await act(async () => render());
  await act(async () => checkbox('Groceries').click());
  state = { ...state, revision: 2, accounts: [{ ...state.accounts[0], clearedTransactionIds: ['groceries', 'coffee'] }] };
  await act(async () => render());
  await act(async () => button('Review updated records').click());
  assert.equal(checkbox('Opening balance').checked, false);
  assert.equal(checkbox('Groceries').checked, false);
  assert.equal(checkbox('Coffee').checked, true);
  await act(async () => button('Save checks').click());
  assert.ok(commands[0].type === 'save_reconciliation');
  assert.deepEqual(commands[0].clearedTransactionIds, ['coffee']);
  assert.equal(commands[0].finish, false);
});

test('balance adjustment opens only from the explicit action and carries its account, date and amount', async () => {
  const commands: Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state: fixture(), accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => {} })));
  assert.equal(container.querySelector('input[name="note"]'), null);
  await fill(container.querySelector<HTMLInputElement>('input[name="statementBalance"]')!, '85');
  await fill(container.querySelector<HTMLInputElement>('input[type="date"]')!, '2026-01-31');
  assert.equal(commands.length, 0);
  await act(async () => button('Adjust balance').click());
  assert.equal(container.querySelector<HTMLInputElement>('input[name="balance"]')!.value, '85');
  assert.equal(container.querySelector<HTMLInputElement>('input[name="date"]')!.value, '2026-01-31');
  await fill(container.querySelector<HTMLInputElement>('input[name="note"]')!, 'Missing opening amount confirmed');
  await submit();
  assert.equal(commands.length, 1);
  assert.ok(commands[0].type === 'reconcile');
  assert.equal(commands[0].accountId, 'cash');
  assert.equal(commands[0].balanceCents, 8500);
  assert.equal(commands[0].date, '2026-01-31');
});

test('a balance adjustment never substitutes a different owner account while carrying the old amount', async () => {
  const state = fixture();
  state.entities.push({ id: 'business', name: 'Business', kind: 'business', ownershipBps: 5000 });
  state.accounts.push({ id: 'business-cash', entityId: 'business', name: 'Business cash', type: 'cash', currency: 'CAD', balanceCents: 250000, reconciledAt: null });
  const commands: Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'business-cash', onCommand: async command => { commands.push(command); }, onClose: () => {} })));
  const selectedAccount = container.querySelector<HTMLSelectElement>('select')!.value;
  const enteredBalance = container.querySelector<HTMLInputElement>('input[name="statementBalance"]')!.value;
  await act(async () => button('Adjust balance').click());
  await fill(container.querySelector<HTMLInputElement>('input[name="note"]')!, 'Confirmed opening amount');
  await submit();
  assert.ok(commands[0].type === 'reconcile');
  assert.equal(commands[0].accountId, selectedAccount);
  assert.equal(commands[0].balanceCents, Math.round(Number(enteredBalance) * 100));
});

test('dates before the recorded opening explain the missing history and block finishing or adjustment', async () => {
  const state = fixture();
  state.transactions[0].date = '2026-09-01';
  const commands: Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => {} })));
  const date = container.querySelector<HTMLInputElement>('input[type="date"]')!;
  assert.equal(date.min, '2026-09-01');
  assert.doesNotMatch(container.textContent!, /Review earlier statements in Statements/);
  await fill(date, '2026-01-31');
  await fill(container.querySelector<HTMLInputElement>('input[name="statementBalance"]')!, '0');
  assert.match(container.textContent!, /Opening balance is dated 2026-09-01\. Review earlier statements in Statements\./);
  assert.match(totals(), /Difference\$0/);
  assert.equal(button('Finish reconciliation').disabled, true);
  assert.equal(button('Adjust balance').disabled, true);
  await submit();
  assert.equal(commands.length, 0);
  await fill(date, '2026-09-01');
  assert.doesNotMatch(container.textContent!, /Review earlier statements in Statements/);
  assert.equal(button('Adjust balance').disabled, false);
});

test('the statement date minimum keeps the later completed checkpoint after an earlier opening', async () => {
  const state = fixture();
  state.accounts[0].clearedTransactionIds = ['opening'];
  state.accounts[0].reconciliation = { date: '2026-03-31', balanceCents: 10000, transactionIds: ['opening'] };
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'cash', onCommand: async () => {}, onClose: () => {} })));
  assert.equal(container.querySelector<HTMLInputElement>('input[type="date"]')!.min, '2026-03-31');
});

test('changing a statement amount requires an explicit discard when cancelling', async () => {
  let closed = 0;
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state: fixture(), accountId: 'cash', onCommand: async () => {}, onClose: () => { closed++; } })));
  await fill(container.querySelector<HTMLInputElement>('input[name="statementBalance"]')!, '85');
  await act(async () => button('Cancel').click());
  assert.equal(closed, 0);
  assert.match(document.body.textContent!, /Discard unsaved changes/);
  await act(async () => button('Keep editing').click());
  assert.equal(container.querySelector<HTMLInputElement>('input[name="statementBalance"]')!.value, '85');
  await act(async () => button('Cancel').click());
  await act(async () => button('Discard changes').click());
  assert.equal(closed, 1);
});

test('saving checks and adjusting balances respect the completed checkpoint and require a date', async () => {
  const state = fixture();
  state.accounts[0].clearedTransactionIds = ['opening'];
  state.accounts[0].reconciliation = { date: '2026-03-31', balanceCents: 10000, transactionIds: ['opening'] };
  const commands: Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state, accountId: 'cash', onCommand: async command => { commands.push(command); }, onClose: () => {} })));
  await act(async () => checkbox('Groceries').click());
  await fill(container.querySelector<HTMLInputElement>('input[type="date"]')!, '2026-02-28');
  assert.equal(button('Save checks').disabled, true);
  assert.equal(button('Finish reconciliation').disabled, true);
  await submit();
  assert.equal(commands.length, 0);
  await fill(container.querySelector<HTMLInputElement>('input[type="date"]')!, '');
  assert.equal(button('Save checks').disabled, true);
  assert.equal(button('Adjust balance').disabled, true);
});


test('navigation preserves reconciliation checks until discard is confirmed', async () => {
  await act(async () => root.render(createElement(Forms, { kind: 'reconcile', state: fixture(), accountId: 'cash', onCommand: async () => {}, onClose: () => {} })));
  await act(async () => checkbox('Groceries').click());
  let navigations=0;
  await act(async () => { assert.equal(requestDraftNavigation(()=>{navigations++;}),false); });
  assert.equal(navigations,0);
  await act(async () => button('Keep editing').click());
  assert.equal(checkbox('Groceries').checked,true);
  await act(async () => { requestDraftNavigation(()=>{navigations++;}); });
  await act(async () => button('Discard changes').click());
  assert.equal(navigations,1);
});
