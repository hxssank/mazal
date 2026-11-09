import { CommandRejectedError } from './services/command-errors.ts';
import test, { after, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createStore } from '../server/store.ts';
import type { AssetPurchase, Command, TrackedAsset } from '../shared/types.ts';

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
const { default: Forms } = await import('./features/entries/Forms.tsx');
const { default: AssetEditor } = await import('./features/assets/AssetEditor.tsx');
const { default: AssetPlanning } = await import('./features/assets/AssetPlanning.tsx');
const { default: AssetPurchases } = await import('./features/assets/AssetPurchases.tsx');
const { default: InvestmentHistory } = await import('./features/investments/InvestmentHistory.tsx');
const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
const container = document.getElementById('root')!;
let root = createRoot(container);
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(element => element.textContent?.trim() === text);
  assert.ok(result, `Missing button ${text}`);
  return result;
}
async function fill(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  assert.ok(input, `Missing field ${name}`);
  await fillInput(input, value);
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });


function isolated(t:TestContext) {
 const directory=mkdtempSync(join(tmpdir(),'mazal-quality-ui-'));
 const store=createStore(join(directory,'test.sqlite'),'live');
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 store.command({type:'add_account',entityId:'personal',name:'SOL',accountType:'investment',openingBalanceCents:0,openingDate:'2026-01-01'});
 const accountId=store.state().accounts[0].id;
 store.command({type:'save_sol',accountId,liquidSol:'0',stakedSol:'10',costBasisCents:100000,priceCents:10000,priceDate:'2026-01-01',priceSource:'Quote',requestId:'initial'});
 return {store,accountId};
}

async function fillInput(input:HTMLInputElement, value:string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function choose(selector:string,value:string) {
  const input = container.querySelector<HTMLSelectElement>(selector)!;
  assert.ok(input, `Missing selection ${selector}`);
  await act(async () => { input.value = value; input.dispatchEvent(new Event('change', {bubbles:true})); });
}
function trackedAsset():TrackedAsset {
  return {id:'drill',entityId:'personal',name:'Drill',category:'Tools',purchaseDate:'2026-01-01',costCents:10000,estimatedValueCents:9000,status:'owned',soldDate:null,saleCents:null,feesCents:0,notes:''};
}

test('SOL activity focuses its first field on open and restores its trigger after clean cancel', async t => {
  const { store } = isolated(t);
  const state = store.state(); const original = structuredClone(state);
  let commands = 0;
  await act(async () => root.render(createElement(InvestmentHistory, { state, position:state.positions[0], readOnly:false, onCommand:async () => { commands++; } })));
  await act(async () => { button('Record activity').focus(); button('Record activity').click(); });
  assert.ok(document.activeElement === container.querySelector('select[id$="-kind"]'));
  await act(async () => { button('Cancel').focus(); button('Cancel').click(); });
  assert.equal(container.querySelector('.investment-history-form'), null);
  assert.ok(document.activeElement === button('Record activity'));
  assert.equal(commands, 0);
  assert.deepEqual(state, original);
});

test('discarding SOL activity for navigation does not focus its hidden former panel', async t => {
  const { store } = isolated(t);
  const state = store.state();
  let hidden = false;
  const render = () => root.render(createElement('div', null,
    createElement('button', { id:'destination' }, 'Destination'),
    createElement('section', { hidden }, createElement(InvestmentHistory, { state, position:state.positions[0], readOnly:false, onCommand:async () => { assert.fail('Navigation must not save'); } }))));
  await act(async () => render());
  await act(async () => button('Record activity').click());
  await fillInput(container.querySelector<HTMLInputElement>('input[id$="-quantity"]')!, '1');
  const destination = container.querySelector<HTMLButtonElement>('#destination')!;
  await act(async () => { requestDraftNavigation(() => { hidden = true; render(); destination.focus(); }); });
  const discard = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(item => item.textContent?.trim() === 'Discard changes')!;
  await act(async () => discard.click());
  assert.equal(container.querySelector('section')!.hidden, true);
  assert.ok(document.activeElement === destination);
});

test('reviewing a stale SOL price edit preserves a concurrent staking reward',async t=>{
  const {store,accountId}=isolated(t);
  let state=store.state();
  const render=()=>root.render(createElement(Forms,{kind:'sol',state,accountId,onCommand:async(command:Command)=>{state=store.command(command);render();},onClose:()=>{}}));
  await act(async()=>render());
  await fill('price','200');
  await fill('priceDate','2026-01-03');
  state=store.command({type:'add_sol_reward',positionId:state.positions[0].id,sol:'1',date:'2026-01-02',requestId:'other-window'});
  await act(async()=>render());
  assert.equal(button('Save SOL holdings').disabled,true);
  await act(async()=>button('Review updated records').click());
  assert.equal(container.querySelector<HTMLInputElement>('[name="stakedSol"]')!.value,'11');
  assert.equal(container.querySelector<HTMLInputElement>('[name="price"]')!.value,'200');
  await submit();
  const position=store.state().positions[0];
  assert.equal(position.stakedSol,'11');
  assert.equal(position.rewardsSol,'1');
  assert.equal(position.priceCents,20000);
  assert.deepEqual(position.history?.map(entry=>entry.kind),['snapshot','reward','price']);
  assert.equal(store.state().accounts.find(account=>account.id===accountId)!.balanceCents,220000);
});

test('SOL activity retries reuse the request after review and a completed identical activity gets a new request',async t=>{
  const {store}=isolated(t);
  let state=store.state();
  const sent:Command[]=[];
  const render=()=>root.render(createElement(InvestmentHistory,{state,position:state.positions[0],readOnly:false,onCommand:async(command:Command)=>{
    sent.push(command);state=store.command(command);render();
    if(sent.length===1)throw new Error('Response lost after commit.');
  }}));
  await act(async()=>render());
  await act(async()=>button('Record activity').click());
  await choose('select[id$="-kind"]','fee');
  await fillInput(container.querySelector<HTMLInputElement>('input[id$="-fee"]')!,'1');
  await submit();
  assert.equal(button('Confirm original save').disabled,true);
  await act(async()=>button('Use updated records').click());
  await submit();
  assert.equal(sent.length,2);
  assert.ok(document.activeElement === button('Record activity'));
  assert.ok(sent[0].type==='record_sol_activity'&&sent[1].type==='record_sol_activity');
  assert.equal(sent[0].requestId,sent[1].requestId);
  assert.equal(sent[0].expectedRevision,sent[1].expectedRevision);
  assert.equal(store.state().positions[0].history?.filter(entry=>entry.kind==='fee').length,1);
  await act(async()=>button('Record activity').click());
  await fillInput(container.querySelector<HTMLInputElement>('input[id$="-fee"]')!,'1');
  await submit();
  assert.equal(sent.length,3);
  assert.ok(document.activeElement === button('Record activity'));
  assert.ok(sent[2].type==='record_sol_activity');
  assert.notEqual(sent[2].requestId,sent[1].requestId);
  assert.equal(store.state().positions[0].history?.filter(entry=>entry.kind==='fee').length,2);
});

for (const committed of [true, false]) test(`a SOL activity failure ${committed ? 'after' : 'before'} commit retries its original amount`,async t=>{
  const {store}=isolated(t);
  let state=store.state();
  const sent:Command[]=[];
  const render=()=>root.render(createElement(InvestmentHistory,{state,position:state.positions[0],readOnly:false,onCommand:async(command:Command)=>{
    sent.push(command);
    if(sent.length===1&&!committed)throw new Error('Could not confirm the save.');
    state=store.command(command);render();
    if(sent.length===1)throw new Error('Response lost after commit.');
  }}));
  await act(async()=>render());
  await act(async()=>button('Record activity').click());
  await choose('select[id$="-kind"]','fee');
  await fillInput(container.querySelector<HTMLInputElement>('input[id$="-fee"]')!,'1');
  await submit();
  assert.equal(container.querySelector<HTMLFieldSetElement>('.investment-history-entry')!.disabled,true);
  await fillInput(container.querySelector<HTMLInputElement>('input[id$="-fee"]')!,'2');
  if(committed)await act(async()=>button('Use updated records').click());
  await submit();
  assert.equal(sent.length,2);
  assert.deepEqual(sent[0],sent[1]);
  assert.equal(store.state().positions[0].history?.filter(entry=>entry.kind==='fee').length,1);
  assert.equal(store.state().positions[0].history?.at(-1)?.feeCents,100);
});

test('an unsaved investment activity guards reload, cancel and page navigation', async t => {
  const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
  const { store } = isolated(t);
  const state = store.state();
  await act(async () => root.render(createElement(InvestmentHistory, { state, position: state.positions[0], readOnly: false, onCommand: async () => {} })));
  await act(async () => button('Record activity').click());
  await fillInput(container.querySelector<HTMLInputElement>('input[id$="-quantity"]')!, '2');
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  let navigated = 0;
  await act(async () => { requestDraftNavigation(() => { navigated++; }); });
  assert.equal(navigated, 0);
  const confirmation = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === label)!;
  await act(async () => confirmation('Keep editing').click());
  assert.equal(container.querySelector<HTMLInputElement>('input[id$="-quantity"]')!.value, '2');
  await act(async () => button('Cancel').click());
  await act(async () => confirmation('Discard changes').click());
  assert.equal(container.querySelector('.investment-history-form'), null);
  assert.equal(store.state().positions[0].history?.length, state.positions[0].history?.length);
});

for (const resolution of ['saved','mine'] as const) test(`repeated SOL reviews retain unresolved conflicts until choosing ${resolution}`,async t=>{
  const {store,accountId}=isolated(t);
  let state=store.state();
  const sent:Command[]=[];
  const render=()=>root.render(createElement(Forms,{kind:'sol',state,accountId,onCommand:async(command:Command)=>{sent.push(command);state=store.command(command);render();},onClose:()=>{}}));
  const updatePrice=(priceCents:number)=>store.command({type:'save_sol',accountId,liquidSol:'0',stakedSol:'10',costBasisCents:100000,priceCents,priceDate:'2026-01-01',priceSource:'Quote',requestId:`price-${priceCents}`});
  await act(async()=>render());
  await fill('price','110');
  state=updatePrice(12000);
  await act(async()=>render());
  await act(async()=>button('Review updated records').click());
  assert.ok(button('Use saved price per sol'));
  state=store.command({type:'add_reserve',entityId:'personal',name:'Another update',amountCents:100});
  await act(async()=>render());
  await act(async()=>button('Review updated records').click());
  assert.equal(button('Save SOL holdings').disabled,true);
  assert.ok(button('Keep my price per sol'));
  await submit();
  assert.equal(sent.length,0);
  state=updatePrice(13000);
  await act(async()=>render());
  await act(async()=>button('Review updated records').click());
  assert.match(container.textContent!,/Saved 130.00/);
  assert.equal(container.querySelector<HTMLInputElement>('[name="price"]')!.value,'110');
  await act(async()=>button(resolution==='saved'?'Use saved price per sol':'Keep my price per sol').click());
  await submit();
  assert.equal(sent.length,1);
  assert.equal(store.state().positions[0].priceCents,resolution==='saved'?13000:11000);
});

test('an asset editor recovers from a rejected stale revision without losing its unchanged-record draft',async t=>{
  const {store}=isolated(t);
  const asset=trackedAsset();
  store.command({type:'save_asset',asset});
  let state=store.state();
  const sent:Command[]=[];
  const render=()=>root.render(createElement(AssetEditor,{asset,recordSale:false,state,onCommand:async(command:Command)=>{sent.push(command);try{state=store.command(command);}catch(error){state=store.state();render();throw error;}},onClose:()=>{}}));
  await act(async()=>render());
  await fillInput(container.querySelector<HTMLInputElement>('.asset-editor-name input')!,'Drill edited');
  store.command({type:'add_reserve',entityId:'personal',name:'New reserve',amountCents:100});
  await submit();
  assert.equal(button('Save changes').disabled,true);
  await act(async()=>button('Review updated records').click());
  assert.equal(container.querySelector<HTMLInputElement>('.asset-editor-name input')!.value,'Drill edited');
  await submit();
  assert.equal(sent.length,2);
  assert.notEqual(sent[0].expectedRevision,sent[1].expectedRevision);
  assert.equal(store.state().assets?.[0].name,'Drill edited');
});

test('loading a changed asset keeps its concurrent value when making a fresh edit',async t=>{
  const {store}=isolated(t);
  const asset=trackedAsset();
  store.command({type:'save_asset',asset});
  let state=store.state();
  const sent:Command[]=[];
  const render=()=>root.render(createElement(AssetEditor,{asset,recordSale:false,state,onCommand:async(command:Command)=>{sent.push(command);state=store.command(command);},onClose:()=>{}}));
  await act(async()=>render());
  await fillInput(container.querySelector<HTMLInputElement>('.asset-editor-name input')!,'My draft');
  state=store.command({type:'save_asset',asset:{...asset,name:'Updated elsewhere',estimatedValueCents:9500}});
  await act(async()=>render());
  await submit();
  assert.equal(sent.length,0);
  await act(async()=>button('Load saved item').click());
  assert.equal(container.querySelector<HTMLInputElement>('.asset-editor-name input')!.value,'Updated elsewhere');
  await fillInput(container.querySelector<HTMLInputElement>('.asset-editor-name input')!,'Fresh edit');
  await submit();
  assert.equal(store.state().assets?.[0].estimatedValueCents,9500);
  assert.equal(store.state().assets?.[0].name,'Fresh edit');
});

test('a purchase editor reviews a rejected stale revision and preserves its draft',async t=>{
  const {store}=isolated(t);
  const purchase:AssetPurchase={id:'car',entityId:'personal',name:'Car',payee:'Seller',targetCents:100000,monthlyCents:10000,paidCents:10000,paidAsOf:'2026-01-01',notes:''};
  store.command({type:'save_asset_purchase',purchase,expected:null,requestId:'purchase'});
  let state=store.state();
  const sent:Command[]=[];
  const render=()=>root.render(createElement(AssetPurchases,{state,purchases:state.assetPurchases!,readOnly:false,onAddAccount:()=>{},onCommand:async(command:Command)=>{sent.push(command);try{state=store.command(command);}catch(error){state=store.state();render();throw new CommandRejectedError(error instanceof Error ? error.message : 'Save rejected.',409);}}}));
  await act(async()=>render());
  await act(async()=>button('Edit purchase').click());
  await fillInput(container.querySelector<HTMLInputElement>('dialog input')!,'My car');
  store.command({type:'add_reserve',entityId:'personal',name:'Other update',amountCents:100});
  await submit();
  assert.equal(button('Save purchase').disabled,true);
  await act(async()=>button('Review updated records').click());
  assert.equal(container.querySelector<HTMLInputElement>('dialog input')!.value,'My car');
  await submit();
  assert.equal(sent.length,2);
  assert.notEqual(sent[0].expectedRevision,sent[1].expectedRevision);
  assert.ok(sent[0].type==='save_asset_purchase'&&sent[1].type==='save_asset_purchase');
  assert.notEqual(sent[0].requestId,sent[1].requestId);
  assert.equal(store.state().assetPurchases?.[0].name,'My car');
  assert.equal(store.state().assetPurchases?.[0].paidCents,10000);
});

test('a wish editor loads a concurrent saved amount before making a fresh edit',async t=>{
  const {store}=isolated(t);
  const item={id:'wish',entityId:'personal',name:'Drill',costCents:10000,comment:''};
  store.command({type:'save_wish_item',item,expected:null,requestId:'wish'});
  let state=store.state();
  const sent:Command[]=[];
  const render=()=>root.render(createElement(AssetPlanning,{state,readOnly:false,onCommand:async(command:Command)=>{sent.push(command);try{state=store.command(command);}catch(error){state=store.state();render();throw error;}}}));
  await act(async()=>render());
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Edit wish Drill"]')!.click());
  await fillInput(container.querySelector<HTMLInputElement>('dialog input')!,'My old draft');
  store.command({type:'save_wish_item',item:{...item,costCents:12000,name:'Saved drill'},expected:item,requestId:'other-window'});
  await submit();
  assert.equal(button('Save wish').disabled,true);
  await act(async()=>button('Load saved record').click());
  assert.equal(container.querySelector<HTMLInputElement>('dialog input')!.value,'Saved drill');
  assert.equal(container.querySelector<HTMLInputElement>('.planning-amount input')!.value,'120.00');
  await fillInput(container.querySelector<HTMLInputElement>('dialog input')!,'Fresh name');
  await submit();
  assert.equal(sent.length,2);
  assert.notEqual(sent[0].expectedRevision,sent[1].expectedRevision);
  assert.ok(sent[0].type==='save_wish_item'&&sent[1].type==='save_wish_item');
  assert.notEqual(sent[0].requestId,sent[1].requestId);
  assert.equal(store.state().wishItems?.[0].costCents,12000);
  assert.equal(store.state().wishItems?.[0].name,'Fresh name');
});

for (const kind of ['sale','repayment'] as const) test(`reviewing a ${kind} clears confirmation tied to an earlier bank balance`,async t=>{
  const {store}=isolated(t);
  store.command({type:'add_account',entityId:'personal',name:'Cash',accountType:'cash',openingBalanceCents:100000,openingDate:'2026-01-02'});
  const cashId=store.state().accounts.find(account=>account.type==='cash')!.id;
  store.command({type:'reconcile',accountId:cashId,balanceCents:100000,date:'2026-01-02',note:'Initial bank balance',requestId:'initial-balance'});
  const asset=trackedAsset();
  store.command({type:'save_asset',asset});
  store.command({type:'save_money_owed',tab:{id:'tab',entityId:'personal',name:'Alex',amountCents:10000,comment:'',payments:[]},expected:null,requestId:'tab'});
  let state=store.state();
  const sent:Command[]=[];
  const onCommand=async(command:Command)=>{sent.push(command);state=store.command(command);render();};
  const render=()=>root.render(kind==='sale'?createElement(AssetEditor,{asset,recordSale:true,state,onCommand,onClose:()=>{}}):createElement(AssetPlanning,{state,readOnly:false,onCommand}));
  await act(async()=>render());
  if(kind==='sale') {
    await fillInput(container.querySelector<HTMLInputElement>('[aria-label="Sale amount in CAD"]')!,'80');
    await fillInput(container.querySelectorAll<HTMLInputElement>('input[type="date"]')[1],'2026-01-02');
    await choose('[aria-label="Sale proceeds cash account"]',cashId);
  } else {
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Record payment from Alex"]')!.click());
    await fillInput(container.querySelector<HTMLInputElement>('.planning-amount input')!,'80');
    await fillInput(container.querySelector<HTMLInputElement>('dialog input[type="date"]')!,'2026-01-02');
    await choose('[aria-label="Repayment cash account"]',cashId);
  }
  const confirmation=()=>container.querySelector<HTMLInputElement>('.cash-posting-confirmation input')!;
  await act(async()=>confirmation().click());
  assert.equal(confirmation().checked,true);
  state=store.command({type:'reconcile',accountId:cashId,balanceCents:120000,date:'2026-01-02',note:'New bank balance',requestId:'new-balance'});
  await act(async()=>render());
  await act(async()=>button('Review updated records').click());
  assert.equal(confirmation().checked,false);
  await submit();
  assert.equal(sent.length,0);
  assert.equal(store.state().accounts.find(account=>account.id===cashId)!.balanceCents,120000);
  await act(async()=>confirmation().click());
  await submit();
  assert.equal(sent.length,1);
  assert.equal(store.state().accounts.find(account=>account.id===cashId)!.balanceCents,128000);
});

test('reviewing SOL activity clears confirmation tied to an earlier cash balance',async t=>{
  const {store}=isolated(t);
  store.command({type:'add_account',entityId:'personal',name:'Cash',accountType:'cash',openingBalanceCents:100000,openingDate:'2026-01-02'});
  const cashId=store.state().accounts.find(account=>account.type==='cash')!.id;
  store.command({type:'reconcile',accountId:cashId,balanceCents:100000,date:'2026-01-02',note:'Initial cash balance',requestId:'initial-balance'});
  let state=store.state();
  const sent:Command[]=[];
  const render=()=>root.render(createElement(InvestmentHistory,{state,position:state.positions[0],readOnly:false,onCommand:async(command:Command)=>{sent.push(command);state=store.command(command);render();}}));
  await act(async()=>render());
  await act(async()=>button('Record activity').click());
  await choose('select[id$="-kind"]','fee');
  await fillInput(container.querySelector<HTMLInputElement>('input[id$="-fee"]')!,'10');
  await fillInput(container.querySelector<HTMLInputElement>('input[type="date"]')!,'2026-01-02');
  await choose('select[id$="-cash"]',cashId);
  const confirmation=()=>container.querySelector<HTMLInputElement>('.investment-history-confirm input')!;
  await act(async()=>confirmation().click());
  assert.equal(confirmation().checked,true);
  state=store.command({type:'reconcile',accountId:cashId,balanceCents:120000,date:'2026-01-02',note:'New cash balance',requestId:'new-balance'});
  await act(async()=>render());
  await act(async()=>button('Use updated records').click());
  assert.equal(confirmation().checked,false);
  await submit();
  assert.equal(sent.length,0);
  assert.equal(store.state().accounts.find(account=>account.id===cashId)!.balanceCents,120000);
  await act(async()=>confirmation().click());
  await submit();
  assert.equal(sent.length,1);
  assert.equal(store.state().accounts.find(account=>account.id===cashId)!.balanceCents,119000);
});

test('a closed cash selection in SOL activity remains explicit until replaced or unlinked',async t=>{
  const {store}=isolated(t);
  store.command({type:'add_account',entityId:'personal',name:'Old bank',accountType:'cash',openingBalanceCents:0,openingDate:'2026-01-02'});
  const cashId=store.state().accounts.find(account=>account.type==='cash')!.id;
  let state=store.state();
  const sent:Command[]=[];
  const render=()=>root.render(createElement(InvestmentHistory,{state,position:state.positions[0],readOnly:false,onCommand:async(command:Command)=>{sent.push(command);state=store.command(command);render();}}));
  await act(async()=>render());
  await act(async()=>button('Record activity').click());
  await choose('select[id$="-kind"]','fee');
  await fillInput(container.querySelector<HTMLInputElement>('input[id$="-fee"]')!,'10');
  await choose('select[id$="-cash"]',cashId);
  state=store.command({type:'set_account_closed',accountId:cashId,closed:true,expectedRevision:state.revision,requestId:'close-bank'});
  await act(async()=>render());
  await act(async()=>button('Use updated records').click());
  const selected=container.querySelector<HTMLSelectElement>('select[id$="-cash"]')!.selectedOptions[0];
  assert.match(selected.textContent!, /Old bank.*unavailable/i);
  assert.match(container.querySelector('.investment-history-preview')!.textContent!, /selected cash account is closed or unavailable/);
  assert.equal(button('Save activity').disabled,true);
  await submit();
  assert.equal(sent.length,0);
  await choose('select[id$="-cash"]','');
  assert.equal(button('Save activity').disabled,false);
  await submit();
  assert.equal(sent.length,1);
  assert.ok(sent[0].type==='record_sol_activity');
  assert.equal(sent[0].cashAccountId,undefined);
});

test('discarding SOL activity before another action clears the still-mounted draft',async t=>{
  const {store}=isolated(t);
  const state=store.state();
  await act(async()=>root.render(createElement(InvestmentHistory,{state,position:state.positions[0],readOnly:false,onCommand:async()=>{}})));
  await act(async()=>button('Record activity').click());
  await fillInput(container.querySelector<HTMLInputElement>('input[id$="-quantity"]')!,'1');
  let continued=0;
  await act(async()=>{requestDraftNavigation(()=>{continued++;});});
  const discard=[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent?.trim()==='Discard changes')!;
  await act(async()=>discard.click());
  assert.equal(continued,1);
  assert.equal(Boolean(container.querySelector('.investment-history-form')),false);
  await act(async()=>{requestDraftNavigation(()=>{continued++;});});
  assert.equal(continued,2);
  assert.equal(document.querySelector('dialog'),null);
});
