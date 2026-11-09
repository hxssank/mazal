import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createStore } from '../server/store.ts';
import { executeCommandWithRecovery } from './services/command-recovery.ts';
import { requestDraftNavigation } from './hooks/draft-protection.ts';
import type { AppState, Command } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector<HTMLElement>('button,input,select')?.focus(); };
HTMLDialogElement.prototype.close = function () { this.open = false; };
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
  return nextLoad(url, context);
} });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { BillEditor } = await import('./features/expenses/ExpenseBills.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });
function field(label: string): HTMLInputElement {
  const input = [...container.querySelectorAll('label')].find(item => item.querySelector('span')?.textContent === label)?.querySelector('input');
  assert.ok(input, `Missing ${label}`);
  return input;
}
async function fill(label: string, value: string) {
  const input = field(label);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
function button(label: string): HTMLButtonElement {
  const item = [...container.querySelectorAll('button')].find(entry => entry.textContent?.trim() === label);
  assert.ok(item, `Missing ${label}`);
  return item;
}
async function enterBill() {
  await fill('Name', 'Phone');
  await fill('Amount per payment · CAD', '100');
  await fill('Next payment date', '2026-11-01');
}
function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
async function nextFrame() { await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))); }

for (const focusAccount of [false, true]) test(`the bill editor focuses ${focusAccount ? 'the requested payment account' : 'Name'} after opening`, async () => {
  await act(async () => root.render(createElement(BillEditor, { state: fixture(), scope: 'personal', focusAccount, onCommand: async () => { assert.fail('Opening must not save'); }, onClose: () => {} })));
  const target = focusAccount ? [...container.querySelectorAll('label')].find(label => label.textContent?.startsWith('Pay from'))!.querySelector('select') : field('Name');
  assert.ok(document.activeElement === target);
  assert.equal(container.querySelector<HTMLDialogElement>('dialog')!.open, true);
});

for (const action of ['Keep editing', 'Escape']) test(`${action} restores the edited bill field without changing or saving the draft`, async () => {
  const state = fixture(); const before = structuredClone(state);
  let closed = 0; let commands = 0;
  await act(async () => root.render(createElement(BillEditor, { state, scope: 'personal', onCommand: async () => { commands++; }, onClose: () => { closed++; } })));
  await enterBill();
  const amount = field('Amount per payment · CAD');
  amount.focus();
  await act(async () => { const cancel = button('Cancel'); cancel.focus(); cancel.click(); });
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true);
  assert.ok(document.activeElement === button('Keep editing'));
  await act(async () => {
    if (action === 'Escape') container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    else button('Keep editing').click();
  });
  await nextFrame();
  assert.ok(document.activeElement === amount, 'Keeping the draft returns focus to the edited amount');
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, false);
  assert.equal(field('Name').value, 'Phone');
  assert.equal(amount.value, '100');
  assert.equal(field('Next payment date').value, '2026-11-01');
  assert.equal(container.querySelector<HTMLDialogElement>('dialog')!.open, true);
  assert.equal(closed, 0); assert.equal(commands, 0);
  assert.deepEqual(state, before);
});

test('keeping a bill cancels pending navigation while a later discard resumes it once', async () => {
  let navigated = 0; let commands = 0;
  await act(async () => root.render(createElement(BillEditor, { state: fixture(), scope: 'personal', onCommand: async () => { commands++; }, onClose: () => { assert.fail('Navigation must use its own continuation'); } })));
  await fill('Name', 'Keep this bill');
  field('Name').focus();
  await act(async () => { requestDraftNavigation(() => { navigated++; }); });
  await act(async () => button('Keep editing').click());
  await nextFrame();
  assert.ok(document.activeElement === field('Name'));
  assert.equal(navigated, 0);
  await act(async () => { requestDraftNavigation(() => { navigated++; }); });
  await act(async () => button('Discard').click());
  assert.equal(navigated, 1); assert.equal(commands, 0);
});

for (const committed of [true, false]) test(`a failed create ${committed ? 'after' : 'before'} commit retries its original identity and amount`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-bill-create-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let state = store.state();
  let closed = 0;
  const sent: Command[] = [];
  const onCommand = async (command: Command) => {
    sent.push(command);
    state = await executeCommandWithRecovery('live', command, async (_workspace, entry) => {
      if (sent.length === 1) {
        if (committed) store.command(entry);
        throw new Error('Response lost');
      }
      return store.command(entry);
    }, async () => store.state(), recovered => { state = recovered; render(); });
    render();
  };
  const render = () => root.render(createElement(BillEditor, { state, scope: 'personal', onCommand, onClose: () => { closed++; } }));
  await act(async () => render());
  await enterBill();
  await submit();
  assert.equal(closed, 0);
  assert.equal(sent.length, 1);
  assert.match(container.textContent!, /Confirm the original save for Phone, \$100/);
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true);
  await fill('Amount per payment · CAD', '110');
  if (committed) {
    assert.equal(button('Confirm original save').disabled, true);
    await submit();
    assert.equal(sent.length, 1);
    await act(async () => button('Review updated records').click());
  }
  await act(async () => button('Cancel').click());
  await act(async () => button('Keep checking').click());
  await nextFrame();
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true);
  assert.ok(document.activeElement === button('Confirm original save'));
  assert.equal(sent.length, 1);
  const savedRevision = state.revision;
  await submit();
  assert.equal(closed, 1);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].type === 'add_obligation' && sent[1].type === 'add_obligation');
  assert.equal(sent[1].requestId, sent[0].requestId);
  assert.equal(sent[1].amountCents, 10000);
  assert.equal(store.state().obligations.length, 1);
  assert.equal(store.state().obligations[0].amountCents, 10000);
  assert.equal(store.state().revision, savedRevision + (committed ? 0 : 1));
});

test('local validation keeps the create form editable before any save attempt', async () => {
  const state = fixture();
  const sent: Command[] = [];
  await act(async () => root.render(createElement(BillEditor, { state, scope: 'personal', onCommand: async command => { sent.push(command); }, onClose: () => {} })));
  await enterBill();
  await fill('Amount per payment · CAD', 'invalid');
  await submit();
  assert.equal(sent.length, 0);
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, false);
  await fill('Amount per payment · CAD', '110');
  await submit();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].type === 'add_obligation');
  assert.equal(sent[0].amountCents, 11000);
  assert.equal(sent[0].expectedRevision, 1);
});
