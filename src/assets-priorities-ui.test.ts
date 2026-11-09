import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Command, TrackedAsset } from '../shared/types.ts';
import { createStore } from '../server/store.ts';
import { executeCommandWithRecovery } from './services/command-recovery.ts';
import { CommandRejectedError } from './services/command-errors.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable:true });
Object.defineProperty(dom.window, 'matchMedia', { value:() => ({matches:false,addEventListener(){},removeEventListener(){}}), configurable:true });
dom.window.scrollTo=()=>{};
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
const { default: AssetEditor } = await import('./features/assets/AssetEditor.tsx');
const { default: AssetPlanning } = await import('./features/assets/AssetPlanning.tsx');
const { default: AssetPurchases } = await import('./features/assets/AssetPurchases.tsx');
const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
const { default: Assets } = await import('./features/assets/Assets.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);

beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });
const fixture = (): AppState => ({ workspace:'live', revision:1, entities:[{id:'personal',name:'Personal',kind:'personal',ownershipBps:10000}], accounts:[], transactions:[], obligations:[], reserves:[], positions:[], audit:[], lastBackupAt:null, assets:[], wishItems:[], moneyOwed:[] });
const printer = (unknown = false): TrackedAsset => ({ id:'printer', entityId:'personal', name:'Example printer', category:'Toys', purchaseDate:unknown?null:'2026-09-20', costCents:95000, estimatedValueCents:unknown?null:90000, status:'owned', soldDate:null, saleCents:null, feesCents:0, notes:'' });
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); });
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))); }
async function nextFrame() { await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))); }

for (const editor of ['wish', 'repayment'] as const) for (const action of ['Keep editing', 'Escape'] as const) test(`${action} restores the last ${editor} field after clicking Cancel`, async () => {
  const state = fixture();
  state.moneyOwed = [{ id:'alex', entityId:'personal', name:'Alex', amountCents:10000, comment:'', payments:[] }];
  const original = structuredClone(state);
  let commands = 0;
  await act(async () => root.render(createElement(AssetPlanning, { state, readOnly:false, onCommand:async () => { commands++; } })));
  const byText = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
  await act(async () => { if (editor === 'wish') byText('Add wish').click(); else container.querySelector<HTMLButtonElement>('[aria-label="Record payment from Alex"]')!.click(); });
  const dialog = container.querySelector<HTMLDialogElement>('dialog')!;
  const amount = dialog.querySelector<HTMLInputElement>('.planning-amount input')!;
  await fill(amount, '25');
  amount.focus();
  await act(async () => { byText('Cancel').focus(); byText('Cancel').click(); });
  assert.ok(document.activeElement === byText('Keep editing'));
  assert.equal(dialog.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true);
  await act(async () => { if (action === 'Escape') dialog.dispatchEvent(new Event('cancel', { cancelable:true })); else byText('Keep editing').click(); });
  await nextFrame();
  assert.ok(document.activeElement === amount, 'Keeping the draft restores the last edited field');
  assert.equal(amount.value, '25');
  assert.equal(dialog.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, false);
  assert.equal(dialog.open, true);
  assert.equal(commands, 0);
  assert.deepEqual(state, original);
});

for (const action of ['Keep editing', 'Escape'] as const) test(`${action} returns to Remove wish after cancelling its confirmation`, async () => {
  const state = fixture();
  state.wishItems = [{ id:'drill', entityId:'personal', name:'Drill', costCents:5000, comment:'', priority:'essential' }];
  const original = structuredClone(state);
  let commands = 0;
  await act(async () => root.render(createElement(AssetPlanning, { state, readOnly:false, onCommand:async () => { commands++; } })));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit wish Drill"]')!.click());
  const remove = () => container.querySelector<HTMLButtonElement>('.planning-remove')!;
  await act(async () => { remove().focus(); remove().click(); });
  const keep = container.querySelector<HTMLButtonElement>('.portfolio-discard-actions button')!;
  assert.ok(document.activeElement === keep);
  await act(async () => { if (action === 'Escape') container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable:true })); else keep.click(); });
  await nextFrame();
  assert.ok(document.activeElement === remove());
  assert.equal(container.querySelector('.portfolio-discard-message'), null);
  assert.equal(commands, 0);
  assert.deepEqual(state, original);
});

for (const editor of ['owned item', 'wish', 'purchase'] as const) test(`a dirty ${editor} protects reload and app navigation until discard`, async () => {
  const state = fixture();
  const onCommand = async () => {};
  const byText = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
  await act(async () => {
    if (editor === 'owned item') root.render(createElement(AssetEditor, { state, asset: null, recordSale: false, onCommand, onClose: () => {} }));
    else if (editor === 'wish') root.render(createElement(AssetPlanning, { state, readOnly: false, onCommand }));
    else root.render(createElement(AssetPurchases, { state, purchases: [], readOnly: false, onCommand, onAddAccount: () => {} }));
  });
  if (editor !== 'owned item') await act(async () => byText(editor === 'wish' ? 'Add wish' : 'Add purchase').click());
  const name = container.querySelector<HTMLInputElement>('dialog input')!;
  await fill(name, 'Unsaved name');
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  let navigated = 0;
  await act(async () => { assert.equal(requestDraftNavigation(() => { navigated++; }), false); });
  assert.equal(navigated, 0);
  assert.match(container.querySelector('dialog')!.textContent!, /Discard unsaved changes/);
  await act(async () => byText('Keep editing').click());
  assert.equal(name.value, 'Unsaved name');
  await act(async () => { requestDraftNavigation(() => { navigated++; }); });
  await act(async () => byText(editor === 'purchase' ? 'Discard' : 'Discard changes').click());
  assert.equal(navigated, 1);
  await act(async () => root.unmount());
  root = createRoot(container);
  const afterClose = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(afterClose);
  assert.equal(afterClose.defaultPrevented, false);
});

test('purchase priorities put essential items first and preserve unknown prices and legacy priority', async () => {
  const state=fixture();
  state.wishItems=[{id:'toy',entityId:'personal',name:'Optional toy',costCents:0,comment:'',priority:'optional'},{id:'legacy',entityId:'personal',name:'Old idea',costCents:5000,comment:''},{id:'glasses',entityId:'personal',name:'New glasses',costCents:null,comment:'',priority:'essential'}];
  await act(async () => root.render(createElement(AssetPlanning,{state,readOnly:true,onCommand:async()=>{}})));
  const groups=[...container.querySelectorAll('.wish-priority-group')];
  assert.deepEqual(groups.map(group=>group.getAttribute('aria-label')),['Essential purchases','Optional purchases','Unassigned purchases']);
  assert.match(groups[0].textContent!,/New glassesPrice needed/);
  assert.doesNotMatch(groups[0].textContent!,/\$0/);
  assert.match(groups[1].textContent!,/Optional toy\$0/);
  assert.match(groups[2].textContent!,/Old idea\$50/);
  assert.match(container.querySelector('.asset-planning-total')!.textContent!,/\$50Known prices · 2 of 3 items/);
});

test('wish editor saves essential priority with an unknown price and can return it to unassigned', async () => {
  const state=fixture();
  const commands:Command[]=[];
  state.wishItems=[{id:'glasses',entityId:'personal',name:'New glasses',costCents:null,comment:''}];
  const render=()=>root.render(createElement(AssetPlanning,{state,readOnly:false,onCommand:async command=>{commands.push(command);}}));
  await act(async () => render());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit wish New glasses"]')!.click());
  const price=container.querySelector<HTMLInputElement>('.planning-amount input')!;
  assert.equal(price.value,'');
  assert.equal(price.required,false);
  await act(async () => { const select=container.querySelector<HTMLSelectElement>('[aria-label="Purchase priority"]')!; select.value='essential'; select.dispatchEvent(new Event('change',{bubbles:true})); });
  await submit();
  assert.equal(commands[0].type,'save_wish_item');
  if(commands[0].type!=='save_wish_item')return;
  assert.equal(commands[0].item.costCents,null);
  assert.equal(commands[0].item.priority,'essential');
  assert.equal(commands[0].expectedRevision,1);
  assert.equal(commands[0].expected?.priority,undefined);
  state.wishItems=[commands[0].item];
  state.revision=2;
  await act(async () => render());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit wish New glasses"]')!.click());
  await act(async () => { const select=container.querySelector<HTMLSelectElement>('[aria-label="Purchase priority"]')!; select.value=''; select.dispatchEvent(new Event('change',{bubbles:true})); });
  await fill(container.querySelector<HTMLInputElement>('.planning-amount input')!,'0');
  await submit();
  assert.equal(commands[1].type,'save_wish_item');
  if(commands[1].type!=='save_wish_item')return;
  assert.equal(commands[1].item.costCents,0);
  assert.equal(commands[1].item.priority,undefined);
});

test('owned inventory shows purchase cost without inventing resale loss or purchase dates', async () => {
  const state=fixture(); state.assets=[printer(true)];
  await act(async () => root.render(createElement(Assets,{state,readOnly:true,onCommand:async()=>{},onOpen:()=>{}})));
  const item=container.querySelector('.portfolio-asset-card')!;
  assert.match(item.textContent!,/Example printerPurchase date not enteredPurchase cost\$950/);
  assert.match(item.textContent!,/Resale estimateNot confirmed/);
  assert.equal(item.querySelector('.assets-item-result'),null);
  assert.equal(container.querySelector('.assets-inventory-totals'),null);
  assert.doesNotMatch(item.textContent!,/Invalid Date|NaN/);
});

test('asset editor preserves unknown fields and accepts an explicit zero resale estimate', async () => {
  const state=fixture(); const asset=printer(true); state.assets=[asset]; const commands:Command[]=[];
  const render=()=>root.render(createElement(AssetEditor,{asset,recordSale:false,state,onCommand:async command=>{commands.push(command);},onClose:()=>{}}));
  await act(async () => render());
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Purchase date"]')!.value,'');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Resale estimate in CAD"]')!.value,'');
  await submit();
  assert.equal(commands[0].type,'save_asset');
  if(commands[0].type!=='save_asset')return;
  assert.equal(commands[0].asset.purchaseDate,null);
  assert.equal(commands[0].asset.estimatedValueCents,null);
  await fill(container.querySelector<HTMLInputElement>('[aria-label="Resale estimate in CAD"]')!,'0');
  await submit();
  assert.equal(commands[1].type,'save_asset');
  if(commands[1].type==='save_asset')assert.equal(commands[1].asset.estimatedValueCents,0);
});

test('asset editor keeps blank purchase cost unknown and distinguishes a confirmed zero cost', async () => {
  const state=fixture(); const asset={...printer(),costCents:null}; state.assets=[asset]; const commands:Command[]=[];
  await act(async () => root.render(createElement(AssetEditor,{asset,recordSale:false,state,onCommand:async command=>{commands.push(command);},onClose:()=>{}})));
  const cost=container.querySelector<HTMLInputElement>('[aria-label="Purchase cost in CAD"]')!;
  assert.equal(cost.value,'');
  assert.equal(cost.required,false);
  await submit();
  assert.equal(commands[0].type,'save_asset');
  if(commands[0].type!=='save_asset')return;
  assert.equal(commands[0].asset.costCents,null);
  assert.equal(commands[0].asset.estimatedValueCents,90000);
  await fill(cost,'0');
  await submit();
  assert.equal(commands[1].type,'save_asset');
  if(commands[1].type==='save_asset')assert.equal(commands[1].asset.costCents,0);
});

test('unknown purchase costs never appear as zero or gains in owned items and sales', async () => {
  const state=fixture();
  state.assets=[{...printer(),costCents:null},{...printer(),id:'sold',name:'Sold printer',costCents:null,status:'sold',soldDate:'2026-09-21',saleCents:100000}];
  const render=()=>root.render(createElement(Assets,{state,readOnly:true,onCommand:async()=>{},onOpen:()=>{}}));
  await act(async () => render());
  const owned=container.querySelector('.assets-item-owned')!;
  const sold=container.querySelector('.assets-item-sold')!;
  assert.match(owned.textContent!,/Purchase costNot confirmed/);
  assert.match(owned.textContent!,/Resale estimate\$900/);
  assert.match(sold.textContent!,/Sale price\$1,000Purchase costNot confirmed/);
  assert.equal(container.querySelectorAll('.assets-item-result').length,0);
  assert.doesNotMatch(container.querySelector('.assets-inventory-totals')!.textContent!,/\$0|\+\$/);
  assert.match(container.querySelector('.assets-inventory-totals')!.textContent!,/Purchase costNot confirmed0 of 1 costs recorded/);
  assert.match(container.querySelector('.assets-inventory-totals')!.textContent!,/1 completed saleNot confirmed/);
  state.assets.push({...printer(),id:'known',costCents:0});
  await act(async () => render());
  assert.match(container.querySelector('.assets-inventory-totals')!.textContent!,/Purchase cost\$01 of 2 costs recorded/);
});

test('known item values keep cost and resale separate and show only the actual difference', async () => {
  const state=fixture(); state.assets=[printer()];
  await act(async () => root.render(createElement(Assets,{state,readOnly:true,onCommand:async()=>{},onOpen:()=>{}})));
  const item=container.querySelector('.portfolio-asset-card')!;
  assert.match(item.textContent!,/Bought Sep 20, 2026Purchase cost\$950/);
  assert.match(item.textContent!,/Resale estimate\$900/);
  assert.match(item.querySelector('.assets-item-result')!.textContent!,/Estimated gain or loss-\$50/);
  assert.equal(container.querySelector('.assets-summary-card'),null);
  assert.equal(container.querySelectorAll('.portfolio-asset-card').length,1);
});

test('moving a wish to owned items confirms actual cost and retries a lost response without posting cash twice', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-wish-conversion-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let state = store.command({ type: 'save_wish_item', item: { id: 'wish', entityId: 'personal', name: 'New glasses', costCents: null, comment: 'Prescription confirmed', priority: 'essential' }, expected: null, requestId: crypto.randomUUID() });
  const before = structuredClone(state);
  const sent: Command[] = [];
  const onCommand = async (command: Command) => {
    sent.push(command);
    state = await executeCommandWithRecovery('live', command, async (_workspace, entry) => {
      const saved = store.command(entry);
      if (sent.length === 1) throw new Error('Response lost');
      return saved;
    }, async () => store.state(), recovered => { state = recovered; render(); });
    render();
  };
  const render = () => root.render(createElement(AssetPlanning, { state, readOnly: false, onCommand }));
  const byText = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
  await act(async () => render());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add New glasses to owned items"]')!.click());
  const cost = container.querySelector<HTMLInputElement>('[aria-label="Purchase cost in CAD"]')!;
  assert.equal(cost.value, '');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Purchase date"]')!.value, '');
  await fill(cost, '300');
  await submit();
  assert.equal(sent.length, 1);
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true);
  assert.ok(sent[0].type === 'convert_wish_to_asset');
  assert.equal(sent[0].asset.costCents, 30000);
  assert.equal(sent[0].asset.estimatedValueCents, null);
  assert.equal(sent[0].asset.purchaseDate, null);
  const savedRevision = state.revision;
  await act(async () => byText('Review updated records').click());
  await submit();
  assert.equal(sent.length, 2);
  assert.ok(sent[1].type === 'convert_wish_to_asset');
  assert.equal(sent[1].requestId, sent[0].requestId);
  assert.equal(store.state().revision, savedRevision);
  assert.equal(store.state().wishItems!.length, 0);
  assert.equal(store.state().assets!.length, 1);
  assert.deepEqual(store.state().accounts, before.accounts);
  assert.deepEqual(store.state().transactions, before.transactions);
});

for (const committed of [true, false]) test(`a purchase contribution with a lost response ${committed ? 'after' : 'before'} commit confirms one original payment`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-purchase-retry-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.command({ type:'add_account', entityId:'personal', name:'Bank', accountType:'cash', openingBalanceCents:100000, openingDate:'2026-01-01' });
  let state = store.command({ type:'save_asset_purchase', expected:null, requestId:'purchase', purchase:{ id:'car', entityId:'personal', name:'Car', payee:'Seller', targetCents:100000, monthlyCents:10000, paidCents:10000, paidAsOf:'2026-01-01', notes:'' } });
  const sent:Command[] = [];
  const render = () => root.render(createElement(AssetPurchases, { state, purchases:state.assetPurchases!, readOnly:false, onAddAccount:()=>{}, onCommand:async command => {
    sent.push(command);
    if (sent.length === 1) {
      if (committed) state = store.command(command);
      render();
      throw new Error('Response lost');
    }
    state = store.command(command);
    render();
  } }));
  const byText = (text:string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
  await act(async () => render());
  await act(async () => byText('Record contribution').click());
  await submit();
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true);
  assert.match(container.textContent!, /The original save needs confirmation/);
  assert.equal(byText('Confirm original save').disabled, false);
  assert.equal(byText('Load saved purchase'), undefined);
  await submit();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(store.state().accounts.find(account=>account.type==='cash')!.balanceCents, 90000);
  assert.equal(store.state().assetPurchases![0].paidCents, 20000);
  assert.equal(store.state().transactions.filter(transaction=>transaction.source==='Asset contribution').length, 1);
  assert.equal(container.querySelector('dialog'), null);
});

test('a confirmed purchase rejection unlocks the draft and creates a corrected request', async () => {
  const state = fixture();
  const sent:Command[] = [];
  const byText = (text:string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
  await act(async () => root.render(createElement(AssetPurchases, { state, purchases:[], readOnly:false, onAddAccount:()=>{}, onCommand:async command => { sent.push(command); if(sent.length===1) throw new CommandRejectedError('Choose a different purchase name.',400); } })));
  await act(async () => byText('Add purchase').click());
  const inputs = [...container.querySelectorAll<HTMLInputElement>('dialog input')];
  for (const [index,value] of [[0,'Car'],[1,'Seller'],[2,'1000'],[3,'100']] as const) await fill(inputs[index],value);
  await submit();
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, false);
  await fill(inputs[0],'New car');
  await submit();
  assert.equal(sent.length,2);
  assert.ok(sent[0].type==='save_asset_purchase'&&sent[1].type==='save_asset_purchase');
  assert.notEqual(sent[0].requestId,sent[1].requestId);
  assert.equal(sent[1].purchase.name,'New car');
});

test('new asset sales and purchase contributions exclude closed cash accounts', async () => {
  const state = fixture();
  state.accounts = [{ id:'closed', entityId:'personal', name:'Old bank', type:'cash', currency:'CAD', balanceCents:0, reconciledAt:null, closedAt:'2026-01-01' }];
  const asset = printer();
  state.assets = [asset];
  await act(async () => root.render(createElement(AssetEditor, { state, asset, recordSale:true, onCommand:async()=>{}, onClose:()=>{} })));
  assert.equal(container.querySelector('select[aria-label="Sale proceeds cash account"] option[value="closed"]'), null);
  assert.match(container.textContent!, /Add a cash account before recording this sale/);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(createElement(AssetPurchases, { state, purchases:[{ id:'car', entityId:'personal', name:'Car', payee:'Seller', targetCents:100000, monthlyCents:10000, paidCents:10000, paidAsOf:'2026-01-01', notes:'' }], readOnly:false, onCommand:async()=>{}, onAddAccount:()=>{} })));
  assert.match(container.textContent!, /Add a cash account to record contributions/);
  assert.equal([...container.querySelectorAll('button')].some(button=>button.textContent?.trim()==='Record contribution'), false);
});

test('repayments exclude closed cash accounts and explain when no receiving account is available', async () => {
  const state = fixture();
  state.accounts = [{ id:'closed', entityId:'personal', name:'Old bank', type:'cash', currency:'CAD', balanceCents:0, reconciledAt:null, closedAt:'2026-01-01' }];
  state.moneyOwed = [{ id:'alex', entityId:'personal', name:'Alex', amountCents:10000, comment:'', payments:[] }];
  await act(async () => root.render(createElement(AssetPlanning, { state, section:'owed', readOnly:false, onCommand:async()=>{} })));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Record payment from Alex"]')!.click());
  assert.equal(container.querySelector('select[aria-label="Repayment cash account"] option[value="closed"]'), null);
  assert.match(container.textContent!, /Add a cash account before recording a repayment/);
});

test('owed notes stay in a closed disclosure with balance and repayment actions outside it', async () => {
  const state = fixture();
  const comment = 'Saved note with the exact original wording.\nAnother saved line.';
  state.moneyOwed = [{ id:'alex', entityId:'personal', name:'Alex', amountCents:10000, comment, payments:[] }];
  await act(async () => root.render(createElement(AssetPlanning, { state, section:'owed', readOnly:false, onCommand:async()=>{} })));
  const notes = container.querySelector<HTMLDetailsElement>('details.owed-notes')!;
  assert.equal(notes.open, false);
  assert.equal(notes.querySelector('summary')?.getAttribute('aria-label'), 'Notes for Alex');
  assert.equal(notes.querySelector('p')?.textContent, comment);
  assert.equal(container.querySelector('[aria-label="Record payment from Alex"]')!.closest('details'), null);
  assert.equal(container.querySelector('.owed-person > strong')!.textContent, '$100');
  await act(async () => notes.querySelector('summary')!.click());
  assert.equal(notes.open, true);
  assert.equal(notes.querySelector('p')?.textContent, comment);
  assert.equal(state.moneyOwed[0].comment, comment);
});
