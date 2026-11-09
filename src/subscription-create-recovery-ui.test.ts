import { CommandRejectedError } from './services/command-errors.ts';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createStore } from '../server/store.ts';
import { executeCommandWithRecovery } from './services/command-recovery.ts';
import type { AppState, Command } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
  return nextLoad(url, context);
} });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Subscriptions } = await import('./features/expenses/Subscriptions.tsx');
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
async function enterSubscription() {
  await fill('Name', 'Music');
  await fill('Amount per charge · CAD', '10');
  await fill('Next payment date', '2026-11-01');
}

test('subscription payment history includes matched transactions and keeps legacy payments once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-subscription-history-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive:true, force:true }); });
  store.command({type:'add_account',entityId:'personal',name:'Bank',accountType:'cash',openingBalanceCents:10000,openingDate:'2026-01-01'});
  const accountId=store.state().accounts[0].id;
  store.command({type:'add_obligation',entityId:'personal',name:'Music',amountCents:1000,dueDate:'2026-08-01',direction:'out',recurrence:'monthly',accountId,category:'Subscriptions',subscription:true,requestId:'music'});
  const obligationId=store.state().obligations[0].id;
  store.command({type:'add_transaction',kind:'expense',accountId,amountCents:750,date:'2026-08-01',description:'Music charge',category:'Subscriptions',requestId:'music-charge'});
  const transactionId=store.state().transactions.find(transaction=>transaction.description==='Music charge')!.id;
  store.command({type:'pay_obligation',id:obligationId,expectedDueDate:'2026-08-01',transactionId,requestId:'link-music'});
  store.command({type:'pay_obligation',id:obligationId,expectedDueDate:'2026-09-01',amountCents:1000,date:'2026-09-01',accountId,requestId:'next-music'});
  const state=store.state();
  const render=()=>root.render(createElement(Subscriptions,{state,scope:'personal',readOnly:true,pending:'',onPay:async()=>{},onCommand:async()=>{}}));
  await act(async()=>render());
  assert.match(container.querySelector('.subscription-history')!.textContent!,/Recorded payments\$17\.502 payments/);
  const legacy=state.transactions.find(transaction=>transaction.source===`Planned payment ${obligationId}`)!;
  delete legacy.plannedPayment;
  await act(async()=>render());
  assert.match(container.querySelector('.subscription-history')!.textContent!,/Recorded payments\$17\.502 payments/);
});

for (const committed of [true, false]) test(`a failed subscription create ${committed ? 'after' : 'before'} commit retries its original identity and amount`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-subscription-create-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let state = store.state();
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
  const render = () => root.render(createElement(Subscriptions, { state, scope: 'personal', readOnly: false, pending: '', onPay: async () => {}, onCommand }));
  await act(async () => render());
  await act(async () => button('Add subscription').click());
  await enterSubscription();
  await submit();
  assert.ok(container.querySelector('dialog'));
  assert.equal(sent.length, 1);
  assert.match(container.textContent!, /The original save is awaiting confirmation/);
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true);
  await fill('Amount per charge · CAD', '12');
  if (committed) {
    assert.equal(button('Confirm original save').disabled, true);
    await submit();
    assert.equal(sent.length, 1);
    await act(async () => button('I reviewed the updated records').click());
  }
  const savedRevision = state.revision;
  await submit();
  assert.equal(container.querySelector('dialog'), null);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].type === 'add_obligation' && sent[1].type === 'add_obligation');
  assert.equal(sent[1].requestId, sent[0].requestId);
  assert.equal(sent[1].amountCents, 1000);
  assert.equal(store.state().obligations.length, 1);
  assert.equal(store.state().obligations[0].amountCents, 1000);
  assert.equal(store.state().revision, savedRevision + (committed ? 0 : 1));
});

test('local validation keeps the create form editable before any save attempt', async () => {
  const state: AppState = { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 1000 }], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
  const sent: Command[] = [];
  await act(async () => root.render(createElement(Subscriptions, { state, scope: 'personal', readOnly: false, pending: '', onPay: async () => {}, onCommand: async command => { sent.push(command); } })));
  await act(async () => button('Add subscription').click());
  await enterSubscription();
  await fill('Amount per charge · CAD', 'invalid');
  await submit();
  assert.equal(sent.length, 0);
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, false);
  await fill('Amount per charge · CAD', '12');
  await submit();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].type === 'add_obligation');
  assert.equal(sent[0].amountCents, 1200);
  assert.equal(sent[0].expectedRevision, 1);
});


test('a confirmed subscription rejection unlocks entries for a corrected new request', async () => {
  const state: AppState = { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
  const sent: Command[] = [];
  await act(async () => root.render(createElement(Subscriptions, { state, scope: 'personal', readOnly: false, pending: '', onPay: async () => {}, onCommand: async command => { sent.push(command); if (sent.length === 1) throw new CommandRejectedError('Subscription needs a different amount.', 400); } })));
  await act(async () => button('Add subscription').click()); await enterSubscription(); await submit();
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, false);
  await fill('Amount per charge · CAD', '12'); await submit();
  assert.equal(sent.length, 2); assert.ok(sent[0].type === 'add_obligation' && sent[1].type === 'add_obligation');
  assert.notEqual(sent[0].requestId, sent[1].requestId); assert.equal(sent[1].amountCents, 1200);
});

test('a new subscription selects an open account and excludes closed payment accounts', async () => {
  const state: AppState = { workspace:'live', revision:1, entities:[{id:'personal',name:'Personal',kind:'personal',ownershipBps:10000}], accounts:[
    {id:'closed',entityId:'personal',name:'Old bank',type:'cash',currency:'CAD',balanceCents:0,reconciledAt:null,closedAt:'2026-01-01'},
    {id:'open',entityId:'personal',name:'Current bank',type:'cash',currency:'CAD',balanceCents:10000,reconciledAt:null},
  ], transactions:[], obligations:[], reserves:[], positions:[], audit:[], lastBackupAt:null };
  const sent:Command[] = [];
  await act(async () => root.render(createElement(Subscriptions, { state, scope:'personal', readOnly:false, pending:'', onPay:async()=>{}, onCommand:async command=>{sent.push(command);} })));
  await act(async () => button('Add subscription').click());
  assert.equal(container.querySelector('dialog option[value="closed"]'), null);
  await enterSubscription();
  await submit();
  assert.ok(sent[0].type==='add_obligation');
  assert.equal(sent[0].accountId,'open');
});
