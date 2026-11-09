import { CommandRejectedError } from './services/command-errors.ts';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Command, Transaction } from '../shared/types.ts';
import type { CategoryRule } from '../shared/category-rules.ts';

const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom') as {JSDOM:new(html:string,options:{url:string;pretendToBeVisual:boolean})=>{window:Window&typeof globalThis}};
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLSelectElement','Event','MouseEvent','sessionStorage'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
const hooks=registerHooks({load(url,context,nextLoad){
  if(url.endsWith('.css'))return{format:'module',source:'export default {};',shortCircuit:true};
  if(url.endsWith('.tsx'))return{format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText,shortCircuit:true};
  return nextLoad(url,context);
}});
const {createElement,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {default:CategoryReview}=await import('./features/expenses/CategoryReview.tsx');
const {updateCategoryReviewSession}=await import('./features/expenses/category-review-session.ts');
const {requestDraftNavigation}=await import('./hooks/draft-protection.ts');
const container=document.getElementById('root')!;
let root=createRoot(container);
const rule:CategoryRule={id:'rule',entityId:'personal',accountId:null,match:'contains',merchant:'PETRO',category:'Fuel & convenience',enabled:true};
const row=(id:string,category='Uncategorized',accountId='cash'):Transaction=>({id,category,accountId,date:'2026-09-01',description:'PETRO-CANADA TORONTO',amountCents:1000,kind:'expense',toAccountId:null,source:'statement.csv',createdAt:'2026-09-01T12:00:00.000Z'});
function fixture():AppState {
  return {workspace:'live',revision:1,entities:[{id:'personal',name:'Personal',kind:'personal',ownershipBps:10000},{id:'business',name:'Shop',kind:'business',ownershipBps:10000}],accounts:[{id:'cash',entityId:'personal',name:'Personal cash',type:'cash',currency:'CAD',balanceCents:10000,reconciledAt:null},{id:'shop',entityId:'business',name:'Shop cash',type:'cash',currency:'CAD',balanceCents:5000,reconciledAt:null}],transactions:[row('one'),row('two','Other'),row('three','Uncategorized','shop')],obligations:[],reserves:[],positions:[],audit:[],lastBackupAt:null,categoryRules:[rule]};
}
function button(text:string):HTMLButtonElement {
  const found=[...container.querySelectorAll('button')].find(element=>element.textContent?.trim()===text);
  assert.ok(found,`Missing button ${text}`);return found;
}
async function click(text:string){await act(async()=>button(text).click());}
async function openRule(){await act(async()=>{const details=container.querySelector<HTMLDetailsElement>('.category-rules')!;details.open=true;details.dispatchEvent(new Event('toggle'));});await act(async()=>container.querySelector<HTMLButtonElement>('.category-rules-item')!.click());}
function apply(state:AppState,command:Command):AppState {
  assert.equal(command.type,'categorize_transactions');
  if(command.type!=='categorize_transactions')return state;
  return {...state,revision:state.revision+1,transactions:state.transactions.map(transaction=>{
    const change=command.changes.find(item=>item.id===transaction.id);
    if(!change)return transaction;
    const next={...transaction,category:change.category};
    if(change.expenseCategory===null)delete next.expenseCategory;else if(change.expenseCategory!==undefined)next.expenseCategory=change.expenseCategory;
    return next;
  })};
}
beforeEach(async()=>{await act(async()=>root.unmount());root=createRoot(container);sessionStorage.clear();updateCategoryReviewSession('live',()=>({selections:{},lastSave:null}));});
after(async()=>{await act(async()=>root.unmount());hooks.deregister();dom.window.close();});

test('rule preview selects only uncategorized owned rows, applies through the category batch and reuses Undo',async()=>{
  let state=fixture();const before=structuredClone(state);const commands:Command[]=[];
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async command=>{commands.push(command);state=apply(state,command);render();}}));
  await act(async()=>render());await openRule();await click('Preview existing expenses');
  assert.equal(commands.length,0);
  const preview=container.querySelector('.category-rule-preview')!;
  assert.match(preview.textContent??'',/2 matching expenses would change/);
  assert.match(preview.textContent??'',/Uncategorized → Fuel & convenience/);
  assert.match(preview.textContent??'',/Other → Fuel & convenience/);
  const checks=[...preview.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  assert.deepEqual(checks.map(input=>input.checked),[true,false]);
  await click('Apply 1 change');
  assert.equal(state.transactions[0].category,'Fuel & convenience');
  assert.equal(state.transactions[1].category,'Other');
  assert.equal(state.transactions[2].category,'Uncategorized');
  assert.equal(commands[0].expectedRevision,before.revision);
  await click('Undo last save');
  assert.deepEqual(state.transactions,before.transactions);
  assert.deepEqual(state.accounts,before.accounts);
});

test('rule preview blocks conflicting rules and stale previews before a command is sent',async()=>{
  let state=fixture();state.categoryRules=[rule,{...rule,id:'conflict',category:'Food'}];let sent=0;
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async()=>{sent++;}}));
  await act(async()=>render());await openRule();await click('Preview existing expenses');
  assert.match(container.querySelector('.category-rules-conflicts')?.textContent??'',/1 expense has conflicting rules/);
  assert.ok([...container.querySelectorAll<HTMLInputElement>('.category-rule-preview input')].every(input=>input.disabled));
  assert.equal(button('Apply 0 changes').disabled,true);
  state={...state,revision:2,categoryRules:[rule]};await act(async()=>render());
  assert.match(container.querySelector('.category-rule-preview')?.textContent??'',/Records changed/);
  await click('Preview existing expenses');
  assert.equal(button('Apply 1 change').disabled,false);
  state={...state,revision:3};await act(async()=>render());
  assert.equal(button('Apply 1 change').disabled,true);
  assert.equal(sent,0);
});

test('failed rule saves retain the original snapshot and reuse the request ID on retry',async()=>{
  const state=fixture();const commands:Command[]=[];
  await act(async()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async command=>{commands.push(command);if(commands.length===1)throw new Error('Connection lost.');}})));
  await openRule();
  await act(async()=>container.querySelector<HTMLInputElement>('.category-rule-checkbox input')!.click());
  await click('Save rule');
  assert.match(container.textContent??'',/Connection lost/);
  assert.equal(container.querySelector<HTMLInputElement>('.category-rule-checkbox input')!.disabled,true);
  await click('Confirm original save');
  assert.equal(commands.length,2);
  assert.deepEqual(commands[0],commands[1]);
  assert.ok(commands[0].type==='save_category_rule'&&commands[1].type==='save_category_rule');
  assert.deepEqual(commands[0].expected,rule);
  assert.equal(commands[0].rule.enabled,false);
  assert.equal(commands[0].requestId,commands[1].requestId);
});


test('a changed merchant rule guards record switches, close, reload and page navigation',async()=>{
  const state=fixture();
  await act(async()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async()=>{}})));
  await openRule();
  await act(async()=>container.querySelector<HTMLInputElement>('.category-rule-checkbox input')!.click());
  const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  await click('Add merchant rule');
  assert.equal(container.querySelector<HTMLInputElement>('.category-rule-checkbox input')!.checked,false);
  let keep=[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button=>button.textContent==='Keep editing')!;
  assert.ok(keep);await act(async()=>keep.click());
  await click('Close editor');
  assert.ok(container.querySelector('.category-rule-editor'));
  keep=[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button=>button.textContent==='Keep editing')!;
  await act(async()=>keep.click());
  let navigated=false;await act(async()=>{assert.equal(requestDraftNavigation(()=>{navigated=true;}),false);});
  assert.equal(navigated,false);
  const discard=[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button=>button.textContent==='Discard changes')!;
  await act(async()=>discard.click());
  assert.equal(navigated,true);assert.equal(container.querySelector('.category-rule-editor'),null);
});


test('a confirmed rule rejection unlocks the editor while uncertain failures remain pinned',async()=>{
  const state=fixture();const commands:Command[]=[];
  await act(async()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async command=>{commands.push(command);if(commands.length===1)throw new CommandRejectedError('Merchant rule conflicts.',400);}})));
  await openRule();await click('Save rule');
  const enabled=container.querySelector<HTMLInputElement>('.category-rule-checkbox input')!;
  assert.equal(enabled.disabled,false);await act(async()=>enabled.click());await click('Save rule');
  assert.equal(commands.length,2);assert.ok(commands[0].type==='save_category_rule'&&commands[1].type==='save_category_rule');
  assert.notEqual(commands[0].requestId,commands[1].requestId);assert.equal(commands[1].rule.enabled,false);
});
