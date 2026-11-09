import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Transaction } from '../shared/types.ts';

const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLSelectElement','Event','MouseEvent','sessionStorage'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
HTMLElement.prototype.scrollIntoView=()=>{};
const hooks=registerHooks({load(url,context,nextLoad){
  if(url.endsWith('.css'))return{format:'module',source:'export default {};',shortCircuit:true};
  if(url.endsWith('.tsx'))return{format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText,shortCircuit:true};
  return nextLoad(url,context);
}});
const {createElement,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {default:Expenses}=await import('./features/expenses/Expenses.tsx');
const container=document.getElementById('root')!;
let root=createRoot(container);
let commands=0;

const transaction=(id:string,accountId='bank',category='Food',date='2026-01-10'):Transaction=>({id,accountId,toAccountId:null,description:`Merchant ${id}`,kind:'expense',amountCents:1000,category,date,createdAt:`${date}T12:00:00Z`,source:'Manual'});
function fixture():AppState{return{
  workspace:'live',revision:1,
  entities:[{id:'personal',name:'Personal',kind:'personal',ownershipBps:10000},{id:'business',name:'Shop',kind:'business',ownershipBps:10000}],
  accounts:[{id:'bank',entityId:'personal',name:'Chequing',type:'cash',currency:'CAD',balanceCents:100000,reconciledAt:null},{id:'card',entityId:'personal',name:'Card',type:'debt',currency:'CAD',balanceCents:2000,reconciledAt:null},{id:'shop',entityId:'business',name:'Shop card',type:'debt',currency:'CAD',balanceCents:1000,reconciledAt:null}],
  transactions:[transaction('food'),transaction('transport','bank','Transport'),transaction('card-food','card'),transaction('old-food','bank','Food','2025-12-01'),{...transaction('pay'),kind:'income',category:'Income',amountCents:200000},transaction('shop-food','shop')],
  obligations:[],reserves:[],positions:[],audit:[],lastBackupAt:null,
};}
function input(label:string):HTMLInputElement{return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;}
function select(label:string):HTMLSelectElement{return container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;}
async function fill(label:string,value:string){await act(async()=>{const control=input(label);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(control,value);control.dispatchEvent(new Event('input',{bubbles:true}));});}
async function choose(label:string,value:string){await act(async()=>{const control=select(label);control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}));});}
async function click(label:string){const button=container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);assert.ok(button,`Missing button ${label}`);await act(async()=>{button.focus();button.click();});}
function ids(){return[...container.querySelectorAll<HTMLElement>('.expense-entry')].map(row=>row.dataset.recordId).sort();}
async function render(state=fixture()){await act(async()=>root.render(createElement(Expenses,{state,scope:'personal',initialSection:'activity',readOnly:false,onCommand:async()=>{commands++;},onOpen:()=>{}})));}

beforeEach(async()=>{await act(async()=>root.unmount());root=createRoot(container);sessionStorage.clear();commands=0;});
after(async()=>{await act(async()=>root.unmount());hooks.deregister();dom.window.close();});

test('individual ledger filters widen results without dropping the other selections or changing records',async()=>{
  const state=fixture();const original=JSON.stringify(state);
  await render(state);
  const filters=container.querySelector<HTMLDetailsElement>('.ledger-filter-details')!;
  const totals=container.querySelector<HTMLDetailsElement>('.ledger-totals-details')!;
  assert.equal(filters.open,false);
  assert.equal(totals.open,false);
  assert.ok(totals.contains(container.querySelector('[aria-label="Export 5 filtered transactions to CSV"]')));
  await act(async()=>filters.querySelector('summary')!.click());
  assert.equal(filters.open,true);
  await choose('Transaction date range','month');
  await fill('Transaction month','2026-01');
  await choose('Transaction account','bank');
  await choose('Expense category','food');
  assert.deepEqual(ids(),['food']);
  assert.match(container.querySelector('.ledger-totals')!.textContent!,/Expenses\$10/);

  await act(async()=>filters.querySelector('summary')!.click());
  assert.equal(filters.open,false);
  await click('Remove account filter: Chequing');
  assert.equal(filters.open,true);
  assert.deepEqual(ids(),['card-food','food']);
  assert.equal(document.activeElement,select('Transaction account'));
  assert.equal(select('Expense category').value,'food');
  assert.equal(select('Transaction date range').value,'month');
  assert.match(container.querySelector('.ledger-totals')!.textContent!,/Expenses\$20/);

  await click('Remove month filter: January 2026');
  assert.deepEqual(ids(),['card-food','food','old-food']);
  assert.equal(document.activeElement,select('Transaction date range'));
  await click('Remove category filter: Food');
  assert.deepEqual(ids(),['card-food','food','old-food','transport']);
  assert.equal(select('Transaction type').value,'expense');
  assert.equal(document.activeElement,select('Expense category'));

  await choose('Expense category','food');
  await click('Remove type filter: Expense');
  assert.deepEqual(ids(),['card-food','food','old-food']);
  assert.equal(select('Expense category').value,'food');
  assert.equal(select('Transaction type').value,'all');
  assert.equal(document.activeElement,select('Transaction type'));
  await click('Remove category filter: Food');
  assert.deepEqual(ids(),['card-food','food','old-food','pay','transport']);
  assert.equal(container.querySelector('[aria-label="Active transaction filters"]'),null);
  assert.equal(commands,0);
  assert.equal(JSON.stringify(state),original);
});

test('clearing a search restores the filtered list and keyboard focus, while reset restores the full scoped list',async()=>{
  await render();
  await act(async()=>container.querySelector('.ledger-filter-details > summary')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  await choose('Transaction account','card');
  await fill('Search transactions','no such merchant');
  assert.deepEqual(ids(),[]);
  assert.match(container.querySelector('.expense-friendly-empty')!.textContent!,/Clear the search or remove a filter/);
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Export 0 filtered transactions to CSV"]')!.disabled,true);
  await click('Clear transaction search');
  assert.equal(input('Search transactions').value,'');
  assert.equal(document.activeElement,input('Search transactions'));
  assert.deepEqual(ids(),['card-food']);
  assert.equal(select('Transaction account').value,'card');

  await fill('Search transactions','another missing merchant');
  await click('Remove search filter: another missing merchant');
  assert.equal(document.activeElement,input('Search transactions'));
  assert.deepEqual(ids(),['card-food']);
  await fill('Search transactions','missing');
  const reset=[...container.querySelectorAll<HTMLButtonElement>('.expense-friendly-empty button')].find(button=>button.textContent==='Show all transactions')!;
  await act(async()=>reset.click());
  assert.deepEqual(ids(),['card-food','food','old-food','pay','transport']);
  assert.equal(select('Transaction account').value,'all');
  assert.equal(input('Search transactions').value,'');
  assert.equal(container.querySelector('[aria-label="Active transaction filters"]'),null);
  assert.equal(commands,0);
});

test('ledger totals count statement movements separately from manual corrections and recorded spending',async()=>{
  const state=fixture();
  state.transactions=[
    transaction('purchase'),
    {...transaction('refund'),amountCents:-125},
    {...transaction('statement-payment'),kind:'adjustment',statementId:'statement',category:'Card payment',amountCents:25000},
    {...transaction('import-movement'),kind:'adjustment',importSources:[{importId:'import',rowId:'row'}],amountCents:50000},
    {...transaction('manual-correction'),kind:'adjustment',amountCents:250},
    {...transaction('manual-payment'),kind:'debt_payment',toAccountId:'card',amountCents:2000},
  ];
  const original=JSON.stringify(state);
  await render(state);
  const totals=container.querySelector('.ledger-totals')!.textContent!;
  assert.match(totals,/Expenses\$8\.752 entries/);
  assert.match(totals,/Debt payments\$201 entry/);
  assert.match(totals,/Statement account movements2/);
  assert.match(totals,/Other account entries1/);
  assert.equal(ids().length,6);
  assert.equal(commands,0);
  assert.equal(JSON.stringify(state),original);
});
