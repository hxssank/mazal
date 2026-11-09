import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Command, Transaction } from '../shared/types.ts';

const require=createRequire(import.meta.url);
const {JSDOM}=require('jsdom') as {JSDOM:new(html:string,options:{url:string;pretendToBeVisual:boolean})=>{window:Window&typeof globalThis}};
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLSelectElement','Event','MouseEvent','sessionStorage'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
const hooks=registerHooks({load(url,context,nextLoad){
  if(url.endsWith('.css'))return{format:'module',source:'export default {};',shortCircuit:true};
  if(url.endsWith('.tsx'))return{format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText,shortCircuit:true};
  return nextLoad(url,context);
}});
const {createElement,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {default:Expenses}=await import('./features/expenses/Expenses.tsx');
const {default:CategoryReview}=await import('./features/expenses/CategoryReview.tsx');
const {default:CategoryPicker}=await import('./features/expenses/CategoryPicker.tsx');
const {executeCommandWithRecovery}=await import('./services/command-recovery.ts');
const {createStore}=await import('../server/store.ts');
const {expensePlanTransactionCategory}=await import('../shared/expense-plan.ts');
const {readCategoryReviewSession,updateCategoryReviewSession}=await import('./features/expenses/category-review-session.ts');
const container=document.getElementById('root')!;
let root=createRoot(container);
const transaction=(id:string,accountId='card'):Transaction=>({id,accountId,description:`Merchant ${id}`,toAccountId:null,kind:'expense',amountCents:1000,category:'Uncategorized',date:'2026-08-01',createdAt:'2026-08-01T12:00:00Z',source:'Statement'});
function fixture():AppState{return{workspace:'live',revision:1,entities:[{id:'personal',name:'Personal',kind:'personal',ownershipBps:10000},{id:'business',name:'Shop',kind:'business',ownershipBps:10000}],accounts:[{id:'card',entityId:'personal',name:'Card',type:'debt',currency:'CAD',balanceCents:10000,reconciledAt:null},{id:'shop-card',entityId:'business',name:'Shop card',type:'debt',currency:'CAD',balanceCents:5000,reconciledAt:null}],transactions:[transaction('one'),transaction('two')],obligations:[],reserves:[],positions:[],audit:[],lastBackupAt:null};}
function button(text:string):HTMLButtonElement{const found=[...container.querySelectorAll('button')].find(element=>element.textContent?.trim()===text&&!element.closest('[hidden]'));assert.ok(found,`Missing button ${text}`);return found;}
function categoryButton(label:string):HTMLButtonElement{const found=container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);assert.ok(found,`Missing category button ${label}`);return found;}
async function click(text:string){await act(async()=>button(text).click());}
async function choose(label:string,value:string){await act(async()=>categoryButton(label).click());await pick(value);}
async function pick(value:string){const choice=[...container.querySelectorAll<HTMLButtonElement>('.category-picker-options button')].find(element=>element.dataset.category===value);assert.ok(choice,`Missing category choice ${value}`);await act(async()=>choice.click());}
async function searchCategories(value:string){const input=container.querySelector<HTMLInputElement>('input[aria-label="Search categories"]')!;assert.ok(input);await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
async function searchMerchants(value:string){const input=container.querySelector<HTMLInputElement>('input[aria-label="Search merchants to categorize"]')!;assert.ok(input);await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
function reviewFilter(label:string):HTMLButtonElement{const found=[...container.querySelectorAll<HTMLButtonElement>('[aria-label="Category suggestion filters"] button')].find(element=>element.textContent?.startsWith(label));assert.ok(found,`Missing review filter ${label}`);return found;}
function apply(state:AppState,command:Command):AppState{
  assert.ok(command.type==='categorize_transaction'||command.type==='categorize_transactions');
  const changes=command.type==='categorize_transaction'?[command]:command.changes;
  return{...state,revision:state.revision+1,transactions:state.transactions.map(row=>{
    const change=changes.find(change=>change.id===row.id);
    if(!change)return row;
    const updated={...row,category:change.category};
    if(change.expenseCategory===null)delete updated.expenseCategory;
    else if(change.expenseCategory!==undefined)updated.expenseCategory=change.expenseCategory;
    else if(updated.expenseCategory!==undefined||updated.source.startsWith('Planned payment '))updated.expenseCategory=change.category;
    return updated;
  })};
}

beforeEach(async()=>{await act(async()=>root.unmount());root=createRoot(container);sessionStorage.clear();for(const workspace of ['live','demo'] as const)updateCategoryReviewSession(workspace,()=>({selections:{},lastSave:null}));});
after(async()=>{await act(async()=>root.unmount());hooks.deregister();dom.window.close();});

test('category picker searches grouped choices and applies one click to the batch draft',async()=>{
  const state=fixture();let commands=0;
  state.spendingLimits=[{id:'pets',entityId:'personal',name:'Pets',aliases:['vet'],color:'#aaaaaa',dailyCents:null,weeklyCents:null,monthlyCents:null}];
  await act(async()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async()=>{commands++;}})));
  await act(async()=>categoryButton('Category for Merchant one').click());
  assert.deepEqual([...container.querySelectorAll('.category-picker-group h3')].map(item=>item.textContent),['Everyday essentials','Lifestyle','Occasional spending','Fees & other spending','Your categories']);
  assert.match(container.querySelector('.category-picker-options [data-category="Food"] small')?.textContent??'',/Groceries.*coffee/);
  for(const [query,expected] of [['coffee groceries','Food'],['pharmacy','Personal'],['hotels','Trips'],['service charges','Fees & interest'],['Pets','Pets']]){
    await searchCategories(query);
    assert.deepEqual([...container.querySelectorAll<HTMLButtonElement>('.category-picker-options button')].map(item=>item.dataset.category),[expected]);
  }
  await searchCategories('nothing matches this');
  assert.match(container.querySelector('.category-picker-empty')?.textContent??'',/No matching categories/);
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Clear category search"]')!.click());
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Search categories"]')!.value,'');
  assert.equal(container.querySelector('.category-picker footer'),null);
  await pick('Personal');
  assert.equal(container.querySelector('.category-picker'),null);
  assert.equal(readCategoryReviewSession('live').selections.one.category,'Personal');
  assert.equal(state.transactions[0].category,'Uncategorized');
  assert.equal(commands,0);
});

test('bulk category review submits current expenses and refunds while preserving canceled records in the ledger',async()=>{
  const state=fixture();
  const original=transaction('original');
  const replacement={...transaction('replacement'),replacesId:original.id};
  const refund={...transaction('refund'),amountCents:-200,refundOf:replacement.id};
  state.transactions=[original,{...original,id:'reversal',description:'Reversal: Merchant original',amountCents:-1000,reversalOf:original.id},replacement,refund];
  updateCategoryReviewSession('live',()=>({selections:Object.fromEntries(state.transactions.map(row=>[row.id,{id:row.id,expectedCategory:'Uncategorized',category:'Personal'}])),lastSave:null}));
  const commands:Command[]=[];
  await act(async()=>root.render(createElement(Expenses,{state,scope:'personal',initialSection:'activity',readOnly:false,onCommand:async command=>{commands.push(command);},onOpen:()=>{}})));
  assert.equal(container.querySelectorAll('.expense-entry').length,4);
  assert.match(container.querySelector('.ledger-category-review')?.textContent??'',/^2 uncategorized transactions/);
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Categorize transactions"]')!.click());
  assert.match(container.querySelector('.category-review-heading')?.textContent??'',/2 transactions · 2 merchants/);
  assert.doesNotMatch(container.querySelector('.category-review-groups')?.textContent??'',/Merchant original|Reversal:/);
  await click('Save 2 transactions');
  assert.equal(commands[0]?.type,'categorize_transactions');
  if(commands[0]?.type!=='categorize_transactions')assert.fail('Expected a category batch');
  assert.deepEqual(commands[0].changes.map(change=>change.id),['refund','replacement']);
});

test('transaction history marks canceled originals and only offers category edits for current expenses',async()=>{
  const state=fixture();
  const original=transaction('original');
  const canceled=transaction('canceled');
  const replacement={...transaction('replacement'),replacesId:original.id};
  state.transactions=[original,{...original,id:'reversal',amountCents:-1000,reversalOf:original.id},replacement,canceled,{...canceled,id:'cancellation',amountCents:-1000,reversalOf:canceled.id},{...transaction('refund'),amountCents:-200,refundOf:replacement.id}];
  await act(async()=>root.render(createElement(Expenses,{state,scope:'personal',initialSection:'activity',readOnly:false,onCommand:async()=>{},onOpen:()=>{}})));
  assert.equal(container.querySelectorAll('.expense-entry').length,6);
  assert.match(container.querySelector('[data-record-id="original"]')?.textContent??'',/Corrected · Previous entry canceled/);
  assert.match(container.querySelector('[data-record-id="canceled"]')?.textContent??'',/Reversed · Entry canceled/);
  assert.deepEqual([...container.querySelectorAll('.expense-entry:has(.expense-category-action)')].map(row=>row.getAttribute('data-record-id')).sort(),['refund','replacement']);
  assert.match(container.querySelector('.ledger-totals')?.textContent??'',/Expenses\$8/);
});

test('monthly category details do not offer category edits for corrections or their canceled originals',async()=>{
  const state=fixture();
  const {today}=await import('../shared/analytics.ts');
  const original={...transaction('original'),date:today()};
  const replacement={...transaction('replacement'),date:today(),replacesId:original.id};
  state.transactions=[original,{...original,id:'reversal',description:'Reversal: Merchant original',amountCents:-1000,reversalOf:original.id},replacement];
  await act(async()=>root.render(createElement(Expenses,{state,scope:'personal',initialSection:'plan',readOnly:false,onCommand:async()=>{},onOpen:()=>{}})));
  const other=[...container.querySelectorAll<HTMLButtonElement>('.expense-plan-category-select')].find(element=>element.textContent?.startsWith('Other'))!;
  await act(async()=>other.click());
  const entries=container.querySelector('.expense-plan-detail-panel:not([hidden]) .expense-plan-entries')!;
  assert.equal(entries.querySelectorAll('li').length,3);
  assert.match(entries.textContent??'',/Corrected · Previous entry canceled/);
  assert.deepEqual([...entries.querySelectorAll('.expense-category-action')].map(button=>button.getAttribute('aria-label')),[`Edit category for Merchant replacement on ${today()}`]);
});

test('a category editor blocks a canceled record received while its picker is open',async()=>{
  let state=fixture();let commands=0;
  const render=()=>root.render(createElement(Expenses,{state,scope:'personal',initialSection:'activity',readOnly:false,onCommand:async()=>{commands++;},onOpen:()=>{}}));
  await act(async()=>render());
  await act(async()=>categoryButton('Edit category for Merchant one on 2026-08-01').click());
  state={...state,revision:2,transactions:[...state.transactions,{...state.transactions[0],id:'reversal',amountCents:-1000,reversalOf:'one'}]};
  await act(async()=>render());
  assert.match(container.querySelector('.category-picker-error')?.textContent??'',/This entry was canceled/);
  assert.ok([...container.querySelectorAll<HTMLButtonElement>('.category-picker-options button')].every(button=>button.disabled));
  assert.equal([...container.querySelectorAll('button')].some(button=>button.textContent==='Reload category'),false);
  assert.equal(commands,0);
});

test('the inline category review action moves focus to its persistent view toggle',async()=>{
  await act(async()=>root.render(createElement(Expenses,{state:fixture(),scope:'personal',initialSection:'activity',readOnly:false,onCommand:async()=>{},onOpen:()=>{}})));
  const trigger=container.querySelector<HTMLButtonElement>('.ledger-category-review button')!;
  await act(async()=>{trigger.focus();trigger.click();});
  await act(async()=>new Promise<void>(resolve=>window.requestAnimationFrame(()=>resolve())));
  assert.equal(trigger.isConnected,false);
  assert.equal(document.activeElement?.getAttribute('aria-label'),'Categorize transactions');
  assert.equal(document.activeElement?.getAttribute('aria-pressed'),'true');
});

test('one click applies the category once and closes after the parent callback completes',async()=>{
  let open=true;let closes=0;let finish:()=>void=()=>{};
  const choices:string[]=[];
  const render=()=>root.render(open?createElement(CategoryPicker,{title:'Choose category',context:'Merchant one',value:'',options:['Food','Transport'],onChoose:async category=>{choices.push(category);await new Promise<void>(resolve=>{finish=resolve;});},onClose:()=>{closes++;open=false;render();}}):createElement('p',null,'Picker closed'));
  await act(async()=>render());
  const choice=container.querySelector<HTMLButtonElement>('[data-category="Food"]')!;
  await act(async()=>{choice.click();choice.click();});
  assert.deepEqual(choices,['Food']);
  assert.equal(closes,0);
  assert.equal(container.querySelector('[role="status"]')?.textContent,'Applying category…');
  assert.ok([...container.querySelectorAll<HTMLButtonElement>('.category-picker-options button')].every(option=>option.disabled));
  assert.equal(categoryButton('Close category picker').disabled,true);
  assert.equal(container.querySelector('.category-picker footer'),null);
  await act(async()=>finish());
  assert.equal(closes,1);
  assert.equal(container.querySelector('dialog'),null);
});

for(const changedWhilePending of [false,true])test(`a rejected category choice restores ${changedWhilePending?'the newer':'the original'} saved category and permits retry`,async()=>{
  let value='Food';let closes=0;let rejectSave!:(error:Error)=>void;
  const choices:string[]=[];
  const render=()=>root.render(createElement(CategoryPicker,{title:'Choose category',context:'Merchant one',value,options:['Food','Transport','Personal'],onChoose:async category=>{choices.push(category);if(choices.length===1)await new Promise<void>((_resolve,reject)=>{rejectSave=reject;});},onClose:()=>{closes++;}}));
  const selected=()=>container.querySelector<HTMLButtonElement>('.category-picker-options [aria-pressed="true"]')?.dataset.category;
  await act(async()=>render());
  assert.equal(selected(),'Food');
  await pick('Transport');
  assert.equal(selected(),'Transport');
  assert.equal(categoryButton('Close category picker').disabled,true);
  if(changedWhilePending){value='Personal';await act(async()=>render());}
  await act(async()=>rejectSave(new Error('Category was not saved')));
  assert.equal(selected(),value);
  assert.equal(container.querySelector('[data-category="Transport"]')?.getAttribute('aria-pressed'),'false');
  assert.match(container.querySelector('.category-picker-error')?.textContent??'',/Category was not saved/);
  assert.equal(container.querySelector('.category-picker-pending'),null);
  assert.equal(categoryButton('Close category picker').disabled,false);
  assert.equal(closes,0);
  assert.ok([...container.querySelectorAll<HTMLButtonElement>('.category-picker-options button')].every(option=>!option.disabled));
  await pick('Transport');
  assert.deepEqual(choices,['Transport','Transport']);
  assert.equal(closes,1);
  assert.equal(container.querySelector('.category-picker-error'),null);
});

test('legacy aliases select their merged category without adding duplicate picker choices',async()=>{
  for(const [value,expected] of [['Fuel & convenience','Transport'],['Gym','Personal'],['Health & fitness','Personal']]){
    await act(async()=>root.render(createElement(CategoryPicker,{title:'Choose category',context:'Merchant one',value,options:['Transport','Personal'],onChoose:()=>{},onClose:()=>{}})));
    assert.deepEqual([...container.querySelectorAll<HTMLButtonElement>('.category-picker-options button')].map(option=>option.dataset.category),['Transport','Personal']);
    assert.equal(container.querySelector<HTMLButtonElement>('.category-picker-options [aria-pressed="true"]')?.dataset.category,expected);
  }
  await act(async()=>root.render(createElement(CategoryPicker,{title:'Choose category',context:'Merchant one',value:'Gym',options:['Transport','Personal','Gym'],onChoose:()=>{},onClose:()=>{}})));
  assert.equal(container.querySelector<HTMLButtonElement>('.category-picker-options [aria-pressed="true"]')?.dataset.category,'Gym');
  assert.equal(container.querySelectorAll('.category-picker-options button').length,3);
});

test('merchant suggestions remain explicit choices and expanded instances can use different categories',async()=>{
  let state=fixture();state.transactions=state.transactions.map(row=>({...row,description:'TIM HORTONS #1'}));
  const original=structuredClone(state.transactions);
  const commands:Command[]=[];
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async command=>{commands.push(command);state=apply(state,command);render();}}));
  await act(async()=>render());
  assert.equal(container.querySelectorAll('.category-review-group').length,1);
  const group=container.querySelector('.category-review-group')!;
  assert.ok(group.querySelector('.category-review-controls .category-review-selection')?.contains(categoryButton('Category for TIM HORTONS #1')));
  assert.equal(container.querySelectorAll('.category-review-detail').length,0);
  await act(async()=>categoryButton('Category for TIM HORTONS #1').click());
  assert.match(container.querySelector('.category-picker-recommendation')?.textContent??'',/Suggested for this merchant.*Food & groceries/);
  assert.equal(container.querySelector('.category-picker-options [aria-pressed="true"]'),null);
  await act(async()=>categoryButton('Close category picker').click());
  assert.deepEqual(readCategoryReviewSession('live').selections,{});
  await click('Use Food & groceries');
  assert.equal(Object.keys(readCategoryReviewSession('live').selections).length,2);
  assert.equal(commands.length,0);
  const details=group.querySelector<HTMLDetailsElement>('details')!;
  await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'));});
  assert.equal(container.querySelectorAll('.category-review-detail').length,2);
  await choose('Category for TIM HORTONS #1 on 2026-08-01 two','Personal');
  assert.match(categoryButton('Category for TIM HORTONS #1').textContent??'',/Different categories/);
  assert.deepEqual(state.transactions,original);
  await click('Save 2 transactions');
  assert.equal(commands.length,1);
  assert.deepEqual(state.transactions.map(row=>row.category),['Food','Personal']);
  assert.deepEqual(state.transactions.map(row=>[row.amountCents,row.source,row.date]),original.map(row=>[row.amountCents,row.source,row.date]));
  await click('Undo last save');
  assert.deepEqual(state.transactions,original);
});

test('Apply suggestions sends one current-revision batch, skips manual choices within a merged merchant, and Undo retains drafts',async()=>{
  let state=fixture();state.revision=41;
  state.transactions=[
    {...transaction('manual-fresh'),description:'FRESHCO #9611     _M'},
    {...transaction('auto-fresh'),description:'FRESHCO #9611 MISSISSAUGA'},
    {...transaction('auto-jabal'),description:'Jabal Coffee Ho   _M'},
    {...transaction('manual-other'),description:'Unclear merchant'},
  ];
  const original=structuredClone(state.transactions);
  const commands:Command[]=[];
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async command=>{commands.push(command);state=apply(state,command);render();}}));
  await act(async()=>render());
  const group=categoryButton('Category for FreshCo').closest('article')!;
  assert.equal(group.querySelector('.category-review-variants')?.textContent,'2 statement names grouped');
  const details=group.querySelector<HTMLDetailsElement>('details')!;
  await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'));});
  assert.deepEqual([...group.querySelectorAll('.category-review-detail strong')].map(element=>element.textContent).sort(),original.slice(0,2).map(row=>row.description).sort());
  await choose('Category for FRESHCO #9611     _M on 2026-08-01 manual','Personal');
  await choose('Category for Unclear merchant','Social');
  const drafts=structuredClone(readCategoryReviewSession('live').selections);
  assert.equal(Object.keys(drafts).length,2);
  assert.equal(commands.length,0);
  state={...state,revision:42};
  await act(async()=>render());
  await click('Apply 2 suggestions');
  assert.equal(commands.length,1);
  assert.ok(commands[0].type==='categorize_transactions');
  assert.equal(commands[0].expectedRevision,42);
  assert.ok(commands[0].requestId);
  assert.deepEqual(commands[0].changes.map(change=>change.id).sort(),['auto-fresh','auto-jabal']);
  assert.ok(commands[0].changes.every(change=>change.expectedCategory==='Uncategorized'&&change.expectedExpenseCategory===null&&change.category==='Food'&&change.expenseCategory==='Food'));
  assert.deepEqual(readCategoryReviewSession('live').selections,drafts);
  assert.equal(state.transactions.find(row=>row.id==='manual-fresh')!.category,'Uncategorized');
  assert.equal(state.transactions.find(row=>row.id==='manual-other')!.category,'Uncategorized');
  await click('Undo last save');
  assert.equal(commands.length,2);
  assert.ok(commands[1].type==='categorize_transactions');
  assert.equal(commands[1].expectedRevision,43);
  assert.ok(commands[1].changes.every(change=>change.expectedCategory==='Food'&&change.expectedExpenseCategory==='Food'&&change.category==='Uncategorized'&&change.expenseCategory===null));
  assert.deepEqual(state.transactions,original);
  assert.deepEqual(readCategoryReviewSession('live').selections,drafts);
  assert.equal(readCategoryReviewSession('live').lastSave,null);
});

test('suggestion filters and original-description search restrict the batch to matching supplied rows',async()=>{
  let state=fixture();
  state.transactions=[
    {...transaction('fresh-one'),description:'FRESHCO #9611     _M'},
    {...transaction('fresh-two'),description:'FRESHCO #9611 MISSISSAUGA'},
    {...transaction('jabal'),description:'Jabal Coffee Ho _M'},
    {...transaction('manual'),description:'Unclear merchant'},
    {...transaction('outside'),description:'PITA & HUMMUS TORONTO',date:'2026-07-01'},
  ];
  const commands:Command[]=[];
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions.filter(row=>row.date==='2026-08-01'),readOnly:false,onCommand:async command=>{commands.push(command);state=apply(state,command);render();}}));
  await act(async()=>render());
  assert.equal(reviewFilter('All merchants').textContent,'All merchants3');
  assert.equal(reviewFilter('Suggested').textContent,'Suggested2');
  assert.equal(reviewFilter('Needs a choice').textContent,'Needs a choice1');
  assert.equal(container.querySelectorAll('.category-review-group').length,3);
  assert.equal(button('Apply 3 suggestions').disabled,false);
  await act(async()=>reviewFilter('Needs a choice').click());
  assert.equal(reviewFilter('Needs a choice').getAttribute('aria-pressed'),'true');
  assert.deepEqual([...container.querySelectorAll('.category-review-group h4')].map(element=>element.textContent),['Unclear merchant']);
  assert.equal(container.querySelector('.category-review-auto'),null);
  await act(async()=>reviewFilter('Suggested').click());
  assert.equal(container.querySelectorAll('.category-review-group').length,2);
  await searchMerchants('9611');
  assert.deepEqual([...container.querySelectorAll('.category-review-group h4')].map(element=>element.textContent),['FreshCo']);
  assert.equal(reviewFilter('Suggested').textContent,'Suggested1');
  await click('Apply 2 suggestions');
  assert.equal(commands.length,1);
  assert.ok(commands[0].type==='categorize_transactions');
  assert.deepEqual(commands[0].changes.map(change=>change.id).sort(),['fresh-one','fresh-two']);
  assert.equal(state.transactions.find(row=>row.id==='jabal')!.category,'Uncategorized');
  assert.equal(state.transactions.find(row=>row.id==='outside')!.category,'Uncategorized');
  await searchMerchants('');
  await act(async()=>reviewFilter('All merchants').click());
  assert.deepEqual([...container.querySelectorAll('.category-review-group h4')].map(element=>element.textContent),['Jabal Coffee Ho','Unclear merchant']);
});

test('suggestion batches stop at 5000 and the remaining transaction stays available for the next batch',async()=>{
  let state=fixture();state.transactions=Array.from({length:5001},(_,index)=>({...transaction(`suggested-${String(index).padStart(4,'0')}`),description:'PITA & HUMMUS TORONTO'}));
  const commands:Command[]=[];
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async command=>{commands.push(command);state=apply(state,command);render();}}));
  await act(async()=>render());
  await click('Apply 5000 suggestions');
  assert.equal(commands.length,1);
  assert.ok(commands[0].type==='categorize_transactions');
  assert.equal(commands[0].changes.length,5000);
  assert.equal(new Set(commands[0].changes.map(change=>change.id)).size,5000);
  assert.equal(state.transactions.filter(row=>row.category==='Food').length,5000);
  assert.equal(state.transactions.filter(row=>row.category==='Uncategorized').length,1);
  await click('Apply 1 suggestion');
  assert.equal(commands.length,2);
  assert.ok(commands[1].type==='categorize_transactions');
  assert.equal(commands[1].changes.length,1);
  assert.equal(commands[1].expectedRevision,2);
  assert.equal(state.transactions.filter(row=>row.category==='Food').length,5001);
});

test('read-only review can filter and inspect merged source names but cannot apply suggestions or choices',async()=>{
  const state=fixture();state.transactions=[{...transaction('fresh-one'),description:'FRESHCO #9611 _M'},{...transaction('fresh-two'),description:'FRESHCO #9611 MISSISSAUGA'}];
  let commands=0;
  await act(async()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:true,onCommand:async()=>{commands++;}})));
  assert.equal(button('Apply 2 suggestions').disabled,true);
  assert.equal(button('Use Food & groceries').disabled,true);
  assert.equal(categoryButton('Category for FreshCo').disabled,true);
  await click('Apply 2 suggestions');
  await act(async()=>reviewFilter('Suggested').click());
  assert.equal(reviewFilter('Suggested').getAttribute('aria-pressed'),'true');
  const details=container.querySelector<HTMLDetailsElement>('.category-review-details')!;
  await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'));});
  assert.equal(container.querySelectorAll('.category-review-detail').length,2);
  assert.ok([...container.querySelectorAll<HTMLButtonElement>('.category-review-detail button')].every(element=>element.disabled));
  assert.equal(commands,0);
  assert.deepEqual(readCategoryReviewSession('live').selections,{});
});

test('expense navigation keeps filters and Undo across the Categorize subview',async()=>{
  let state=fixture();state.transactions.push(transaction('business','shop-card'));
  const onCommand=async(command:Command)=>{state=apply(state,command);render();};
  const render=()=>root.render(createElement(Expenses,{state,scope:'all',readOnly:false,onCommand,onOpen:()=>{}}));
  await act(async()=>render());
  const navigation=container.querySelector('nav[aria-label="Expense views"]')!;
  assert.deepEqual([...navigation.querySelectorAll('button')].map(item=>item.textContent?.trim()),['Overview','Bills','Budget','Transactions']);
  assert.equal(container.querySelector('nav[aria-label="Transaction views"]'),null);
  assert.equal(container.querySelector('.expense-review-shortcut'),null);
  await click('Transactions');
  await act(async()=>categoryButton('Categorize transactions').click());
  assert.equal(categoryButton('Categorize transactions').getAttribute('aria-pressed'),'true');
  await click('All transactions');
  assert.equal(button('All transactions').getAttribute('aria-pressed'),'true');
  assert.equal(categoryButton('Categorize transactions').querySelector('span')?.textContent,'2');
  const search=container.querySelector<HTMLInputElement>('input[aria-label="Search transactions"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'Merchant one');search.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(container.querySelectorAll('.expense-entry').length,1);
  await act(async()=>categoryButton('Categorize transactions').click());
  assert.equal(button('Transactions').getAttribute('aria-pressed'),'true');
  assert.equal(container.querySelector('#expense-transactions-panel'),null);
  assert.equal(categoryButton('Categorize transactions').getAttribute('aria-pressed'),'true');
  await choose('Category for Merchant one','Food');
  await click('Save 1 transaction');
  assert.equal(categoryButton('Categorize transactions').querySelector('span')?.textContent,'1');
  await click('All transactions');
  assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Search transactions"]')?.value,'Merchant one');
  assert.equal(container.querySelectorAll('.expense-entry').length,1);
  await click('Undo last save');
  assert.equal(state.transactions[0].category,'Uncategorized');
  assert.equal(categoryButton('Categorize transactions').querySelector('span')?.textContent,'2');
});

test('category choices survive Budget navigation, page unmount, and remain isolated by workspace',async()=>{
  const state=fixture();
  const props={state,scope:'all',readOnly:false,onCommand:async()=>{},onOpen:()=>{}};
  await act(async()=>root.render(createElement(Expenses,props)));
  await click('Transactions');
  await act(async()=>categoryButton('Categorize transactions').click());
  await choose('Category for Merchant one','Food');
  await click('Budget');
  await click('Transactions');
  await act(async()=>categoryButton('Categorize transactions').click());
  assert.match(categoryButton('Category for Merchant one').textContent??'',/Food/);
  await act(async()=>root.render(createElement('div',null,'Home')));
  await act(async()=>root.render(createElement(Expenses,props)));
  await click('Transactions');
  await act(async()=>categoryButton('Categorize transactions').click());
  assert.match(categoryButton('Category for Merchant one').textContent??'',/Food/);
  assert.equal(JSON.parse(sessionStorage.getItem('mazal:category-review:v1:live')!).selections.one.category,'Food');
  const demo={...state,workspace:'demo' as const};
  await act(async()=>root.render(createElement(CategoryReview,{state:demo,rows:demo.transactions,readOnly:false,onCommand:async()=>{}})));
  assert.match(categoryButton('Category for Merchant one').textContent??'',/Choose category/);
  assert.equal(readCategoryReviewSession('live').selections.one.category,'Food');
});

test('saved batch Undo survives navigation and restores the original categories',async()=>{
  let state=fixture();
  const onCommand=async(command:Command)=>{state=apply(state,command);render();};
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand}));
  await act(async()=>render());
  await choose('Category for Merchant one','Food');
  await click('Save 1 transaction');
  assert.equal(state.transactions[0].category,'Food');
  await act(async()=>root.render(createElement('div',null,'Home')));
  await act(async()=>render());
  assert.equal(button('Undo last save').disabled,false);
  await click('Undo last save');
  assert.equal(state.transactions[0].category,'Uncategorized');
  assert.equal(readCategoryReviewSession('live').lastSave,null);
});

test('the category UI saves and undoes a bill reporting snapshot through the persisted store',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mazal-category-ui-'));
  const store=createStore(join(directory,'live.sqlite'),'live');
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const accountId=store.command({type:'add_account',entityId:'personal',name:'Bank',accountType:'cash',openingBalanceCents:10000,openingDate:'2026-01-01'}).accounts[0].id;
  const obligation=store.command({type:'add_obligation',entityId:'personal',accountId,name:'Internet',amountCents:1000,dueDate:'2026-01-01',direction:'out',recurrence:'monthly',category:'Uncategorized'}).obligations[0];
  store.command({type:'pay_obligation',id:obligation.id,expectedDueDate:obligation.dueDate,requestId:'pay-bill'});
  const advanced=store.state().obligations[0];
  store.command({type:'update_obligation',id:advanced.id,expectedDueDate:advanced.dueDate,expectedStatus:'planned',name:advanced.name,amountCents:advanced.amountCents,dueDate:advanced.dueDate,recurrence:advanced.recurrence,accountId,category:'Gym',subscription:true,requestId:'edit-bill'});
  let state=store.state();
  const before=state.transactions.find(row=>row.kind==='expense')!;
  const cashBefore=state.accounts[0].balanceCents;
  const commands:Command[]=[];
  const onCommand=async(command:Command)=>{commands.push(command);state=store.command(command);render();};
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand}));
  assert.equal(before.expenseCategory,'Bills');
  await act(async()=>render());
  await choose('Category for Internet','Food');
  await click('Save 1 transaction');
  const saved=state.transactions.find(row=>row.id===before.id)!;
  assert.equal(saved.category,'Food');
  assert.equal(saved.expenseCategory,'Food');
  assert.equal(expensePlanTransactionCategory(state,'personal',saved),'Food');
  await act(async()=>root.render(createElement('div',null,'Home')));
  await act(async()=>render());
  assert.equal(button('Undo last save').disabled,false);
  await click('Undo last save');
  const undone=state.transactions.find(row=>row.id===before.id)!;
  assert.deepEqual(undone,before);
  assert.equal(expensePlanTransactionCategory(state,'personal',undone),'Bills');
  assert.equal(state.accounts[0].balanceCents,cashBefore);
  assert.equal(commands.length,2);
  store.restore(store.export());
  assert.deepEqual(store.state().transactions.find(row=>row.id===before.id),before);
});

test('a reporting snapshot change disables Undo even when the recorded category stays the same',async()=>{
  let state=fixture();
  const onCommand=async(command:Command)=>{state=apply(state,command);render();};
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand}));
  await act(async()=>render());
  await choose('Category for Merchant one','Food');
  await click('Save 1 transaction');
  state={...state,revision:state.revision+1,transactions:state.transactions.map(row=>row.id==='one'?{...row,expenseCategory:'Bills'}:row)};
  await act(async()=>render());
  assert.equal(state.transactions[0].category,'Food');
  assert.equal(button('Undo last save').disabled,true);
  assert.match(container.textContent??'',/Undo is unavailable/);
});

test('a single-category editor retries an unconfirmed choice at the refreshed revision',async()=>{
  let state=fixture();
  const commands:Command[]=[];
  const onCommand=async(command:Command)=>{commands.push(command);if(commands.length===1){state={...state,revision:2};render();throw new Error('Records changed in another window.');}assert.equal(command.expectedRevision,2);state=apply(state,command);render();};
  const render=()=>root.render(createElement(Expenses,{state,scope:'all',readOnly:false,initialSection:'activity',onCommand,onOpen:()=>{}}));
  await act(async()=>render());
  const edit=container.querySelector<HTMLButtonElement>('button[aria-label="Edit category for Merchant one on 2026-08-01"]')!;
  await act(async()=>edit.click());
  await pick('Food');
  assert.equal(container.querySelector('.category-picker-options button[aria-pressed=true]'),null);
  assert.equal(state.transactions[0].category,'Uncategorized');
  assert.match(container.querySelector('.category-picker-error')?.textContent??'',/Records changed in another window/);
  assert.equal(readCategoryReviewSession('live').attempt?.changes[0]?.category,'Food');
  await pick('Food');
  assert.equal(state.transactions[0].category,'Food');
  assert.equal(commands.length,2);
  assert.ok('requestId' in commands[0]&&'requestId' in commands[1]);
  assert.equal(commands[0].requestId,commands[1].requestId);
});

test('an actual row conflict requires reloading its current category before a single edit can save',async()=>{
  let state=fixture();let sent=0;
  const render=()=>root.render(createElement(Expenses,{state,scope:'all',readOnly:false,initialSection:'activity',onCommand:async()=>{sent++;},onOpen:()=>{}}));
  await act(async()=>render());
  await act(async()=>container.querySelector<HTMLButtonElement>('button[aria-label="Edit category for Merchant one on 2026-08-01"]')!.click());
  state={...state,revision:2,transactions:state.transactions.map(row=>row.id==='one'?{...row,category:'Personal'}:row)};
  await act(async()=>render());
  assert.ok([...container.querySelectorAll<HTMLButtonElement>('.category-picker-options button')].every(option=>option.disabled));
  assert.match(container.textContent??'',/Current category: Personal/);
  await click('Reload category');
  assert.match(container.querySelector('.category-picker-options button[aria-pressed=true]')?.textContent??'',/Personal/);
  assert.ok([...container.querySelectorAll<HTMLButtonElement>('.category-picker-options button')].every(option=>!option.disabled));
  assert.equal(sent,0);
});

test('a committed batch with a lost response is confirmed using the same request and retains Undo',async()=>{
  let state=fixture();let server=state;const sent:Command[]=[];
  const send=async(_workspace:string,command:Command)=>{sent.push(command);if(sent.length===1){server=apply(server,command);throw new Error('Response lost');}return server;};
  const onCommand=async(command:Command)=>{state=await executeCommandWithRecovery('live',command,send,async()=>server,next=>{state=next;render();});render();};
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand}));
  await act(async()=>render());
  await choose('Category for Merchant one','Food');
  await click('Save 1 transaction');
  assert.equal(sent.length,2);
  assert.ok('requestId' in sent[0]&&'requestId' in sent[1]);
  assert.equal(sent[0].requestId,sent[1].requestId);
  assert.equal(state.transactions[0].category,'Food');
  assert.equal(button('Undo last save').disabled,false);
  assert.equal(container.querySelector('[role="alert"]'),null);
  assert.match(container.textContent??'',/Saved 1 category/);
});

test('all-owner review offers custom categories only to the matching owner',async()=>{
  const state=fixture();state.transactions.push(transaction('work','shop-card'));state.spendingLimits=[{id:'pets',entityId:'personal',name:'Pets',aliases:[],color:'#aaaaaa',dailyCents:null,weeklyCents:null,monthlyCents:5000}];
  await act(async()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async()=>{}})));
  await act(async()=>categoryButton('Category for Merchant one (Personal)').click());
  assert.match(container.querySelector('.category-picker-options')?.textContent??'',/Pets/);
  await act(async()=>categoryButton('Close category picker').click());
  await act(async()=>categoryButton('Category for Merchant work (Shop)').click());
  assert.doesNotMatch(container.querySelector('.category-picker-options')?.textContent??'',/Pets/);
});

test('an uncertain batch keeps its request ID when review is left and reopened',async()=>{
  let state=fixture();const sent:Command[]=[];
  const onCommand=async(command:Command)=>{sent.push(command);if(sent.length===1)throw new Error('Local server unavailable');state=apply(state,command);render();};
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand}));
  await act(async()=>render());
  await choose('Category for Merchant one','Food');
  await click('Save 1 transaction');
  await act(async()=>root.render(createElement('div',null,'Home')));
  await act(async()=>render());
  await click('Save 1 transaction');
  assert.ok('requestId' in sent[0]&&'requestId' in sent[1]);
  assert.equal(sent[0].requestId,sent[1].requestId);
  assert.equal(readCategoryReviewSession('live').attempt,undefined);
});

test('matching categories alone cannot claim another window\'s save or enable Undo',async()=>{
  let state=fixture();const newer=apply(state,{type:'categorize_transactions',changes:[{id:'one',expectedCategory:'Uncategorized',category:'Food',expectedExpenseCategory:null,expenseCategory:'Food'}],requestId:'other-window'});let requests=0;
  const onCommand=async(command:Command)=>{await executeCommandWithRecovery('live',command,async()=>{requests++;throw new Error(requests===1?'Records changed':'The transaction category changed.');},async()=>newer,next=>{state=next;render();});};
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand}));
  await act(async()=>render());
  await choose('Category for Merchant one','Food');
  await click('Save 1 transaction');
  assert.equal(requests,2);
  assert.equal(readCategoryReviewSession('live').lastSave,null);
  assert.match(container.querySelector('[role="alert"]')?.textContent??'',/category changed/);
  assert.ok(![...container.querySelectorAll('button')].some(element=>element.textContent==='Undo last save'));
});

test('a remounted review confirms a persisted committed attempt even when its rows have left the review list',async()=>{
  const original=fixture();
  const changes=[{id:'one',expectedCategory:'Uncategorized',category:'Food'}];
  const command={type:'categorize_transactions' as const,changes,requestId:'persisted-request',expectedRevision:original.revision};
  const state=apply(original,command);
  updateCategoryReviewSession('live',()=>({selections:{one:changes[0]},lastSave:null,attempt:{changes,requestId:command.requestId,undo:false}}));
  const sent:Command[]=[];
  await act(async()=>root.render(createElement(CategoryReview,{state,rows:state.transactions.filter(row=>row.category==='Uncategorized'),readOnly:false,onCommand:async request=>{sent.push(request);}})));
  assert.equal(sent.length,1);
  assert.ok('requestId' in sent[0]);
  assert.equal(sent[0].requestId,'persisted-request');
  assert.equal(button('Undo last save').disabled,false);
  assert.equal(readCategoryReviewSession('live').attempt,undefined);
  assert.equal(readCategoryReviewSession('live').lastSave?.[0].id,'one');
});

test('a new session module restores choices and Undo from tab storage',async()=>{
  const change={id:'one',expectedCategory:'Uncategorized',category:'Food',expectedExpenseCategory:null,expenseCategory:'Food'};
  updateCategoryReviewSession('live',()=>({selections:{one:change},lastSave:[change],attempt:{changes:[change],requestId:'stored',undo:false}}));
  const fresh=await import(`./features/expenses/category-review-session.ts?reload=${Date.now()}`) as typeof import('./features/expenses/category-review-session.ts');
  const restored=fresh.readCategoryReviewSession('live');
  assert.deepEqual(restored.selections,{one:change});
  assert.deepEqual(restored.lastSave,[change]);
  assert.equal(restored.attempt?.requestId,'stored');
  assert.deepEqual(fresh.readCategoryReviewSession('demo').selections,{});
});

test('tab storage rejects malformed optional reporting snapshots and accepts legacy changes',async()=>{
  const legacy={id:'one',expectedCategory:'Uncategorized',category:'Food'};
  for(const key of ['expectedExpenseCategory','expenseCategory'])for(const invalid of [0,false,[],{}]){
    const change={...legacy,[key]:invalid};
    sessionStorage.setItem('mazal:category-review:v1:live',JSON.stringify({selections:{one:change},lastSave:[change],attempt:{changes:[change],requestId:'malformed',undo:false}}));
    const fresh=await import(`./features/expenses/category-review-session.ts?invalid=${crypto.randomUUID()}`) as typeof import('./features/expenses/category-review-session.ts');
    assert.deepEqual(fresh.readCategoryReviewSession('live'),{selections:{},lastSave:null});
  }
  sessionStorage.setItem('mazal:category-review:v1:live',JSON.stringify({selections:{one:legacy},lastSave:[legacy]}));
  const fresh=await import(`./features/expenses/category-review-session.ts?legacy=${crypto.randomUUID()}`) as typeof import('./features/expenses/category-review-session.ts');
  assert.deepEqual(fresh.readCategoryReviewSession('live').lastSave,[legacy]);
});

test('an attempted save with a different reporting snapshot is not automatically confirmed on remount',async()=>{
  const state=fixture();
  state.transactions[0]={...state.transactions[0],category:'Food',expenseCategory:'Bills'};
  const changes=[{id:'one',expectedCategory:'Uncategorized',category:'Food',expectedExpenseCategory:null,expenseCategory:'Food'}];
  updateCategoryReviewSession('live',()=>({selections:{one:changes[0]},lastSave:null,attempt:{changes,requestId:'other-snapshot',undo:false}}));
  let calls=0;
  await act(async()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async()=>{calls++;}})));
  assert.equal(calls,0);
  assert.equal(readCategoryReviewSession('live').lastSave,null);
  assert.ok(![...container.querySelectorAll('button')].some(element=>element.textContent==='Check previous save'));
});

test('command recovery checks the reporting snapshot before retrying a failed category save',async()=>{
  const state=fixture();
  state.transactions[0]={...state.transactions[0],category:'Food',expenseCategory:'Bills'};
  for(const batch of [false,true]){
    const change={id:'one',expectedCategory:'Uncategorized',category:'Food',expectedExpenseCategory:null,expenseCategory:'Food'};
    const command:Command=batch?{type:'categorize_transactions',changes:[change],requestId:'batch'}:{type:'categorize_transaction',...change,requestId:'single'};
    let calls=0;
    await assert.rejects(executeCommandWithRecovery('live',command,async()=>{calls++;throw new Error('Lost response');},async()=>state,()=>{}),/Lost response/);
    assert.equal(calls,1);
  }
});

test('failed receipt recovery leaves a visible retry action after remount',async()=>{
  const original=fixture();const changes=[{id:'one',expectedCategory:'Uncategorized',category:'Food'}];
  const state=apply(original,{type:'categorize_transactions',changes,requestId:'receipt'});
  updateCategoryReviewSession('live',()=>({selections:{one:changes[0]},lastSave:null,attempt:{changes,requestId:'receipt',undo:false}}));
  let calls=0;
  await act(async()=>root.render(createElement(CategoryReview,{state,rows:state.transactions.filter(row=>row.category==='Uncategorized'),readOnly:false,onCommand:async command=>{assert.ok('requestId' in command);assert.equal(command.requestId,'receipt');calls++;if(calls===1)throw new Error('Local server unavailable');}})));
  assert.match(container.querySelector('[role="alert"]')?.textContent??'',/Local server unavailable/);
  await click('Check previous save');
  assert.equal(calls,2);
  assert.equal(button('Undo last save').disabled,false);
});

test('monthly category rows save directly and Undo restores the original record without changing money',async()=>{
  let state=fixture();
  const {today}=await import('../shared/analytics.ts');
  state.transactions=state.transactions.map(row=>({...row,date:today()}));
  const original=structuredClone(state);
  const commands:Command[]=[];
  const onCommand=async(command:Command)=>{commands.push(command);state=apply(state,command);render();};
  const render=()=>root.render(createElement(Expenses,{state,scope:'personal',initialSection:'plan',readOnly:false,onCommand,onOpen:()=>{}}));
  await act(async()=>render());
  const other=[...container.querySelectorAll<HTMLButtonElement>('.expense-plan-category-select')].find(element=>element.textContent?.startsWith('Other'))!;
  await act(async()=>other.click());
  await act(async()=>categoryButton(`Edit category for Merchant one on ${today()}`).click());
  assert.equal(container.querySelector('datalist'),null);
  await pick('Food');
  assert.equal(state.transactions[0].category,'Food');
  assert.equal(state.transactions[0].expenseCategory,'Food');
  assert.equal(container.querySelector('dialog'),null);
  assert.deepEqual(state.accounts,original.accounts);
  assert.equal(state.transactions[0].source,original.transactions[0].source);
  await click('Undo last save');
  assert.deepEqual(state.transactions,original.transactions);
  assert.deepEqual(state.accounts,original.accounts);
  assert.equal(commands.length,2);
});

test('category search and Escape leave the transaction untouched and return focus to its row',async()=>{
  const state=fixture();let commands=0;
  await act(async()=>root.render(createElement(Expenses,{state,scope:'personal',readOnly:false,initialSection:'activity',onCommand:async()=>{commands++;},onOpen:()=>{}})));
  const trigger=categoryButton('Edit category for Merchant one on 2026-08-01');
  await act(async()=>{trigger.focus();trigger.click();});
  const search=container.querySelector<HTMLInputElement>('input[aria-label="Search categories"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'social');search.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(container.querySelectorAll('.category-picker-options button').length,1);
  await act(async()=>container.querySelector('dialog')!.dispatchEvent(new Event('cancel',{cancelable:true})));
  assert.equal(container.querySelector('dialog'),null);
  assert.equal(document.activeElement,trigger);
  assert.equal(commands,0);
  assert.equal(state.transactions[0].category,'Uncategorized');
});

test('batch review preserves the reporting category captured before another window changes it',async()=>{
  let state=fixture();let sent:Command|undefined;
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async command=>{sent=command;throw new Error('Reporting category changed. Choose again.');}}));
  await act(async()=>render());
  await choose('Category for Merchant one','Food');
  state={...state,revision:2,transactions:state.transactions.map(row=>row.id==='one'?{...row,expenseCategory:'Bills'}:row)};
  await act(async()=>render());
  await click('Save 1 transaction');
  assert.ok(sent?.type==='categorize_transactions');
  assert.equal(sent.changes[0].expectedExpenseCategory,null);
  assert.match(container.querySelector('[role="alert"]')?.textContent??'',/Reporting category changed/);
  assert.equal(readCategoryReviewSession('live').lastSave,null);
});

test('large merchant batches save 5000 at a time and retain the remaining choice',async()=>{
  let state=fixture();state.transactions=Array.from({length:5001},(_,index)=>({...transaction(`large-${index}`),description:'One merchant'}));
  const sizes:number[]=[];
  const render=()=>root.render(createElement(CategoryReview,{state,rows:state.transactions,readOnly:false,onCommand:async command=>{assert.equal(command.type,'categorize_transactions');if(command.type!=='categorize_transactions')return;sizes.push(command.changes.length);state=apply(state,command);render();}}));
  await act(async()=>render());
  assert.equal(container.querySelectorAll('.category-review-detail').length,0);
  await choose('Category for One merchant','Food');
  await click('Save 5000 transactions');
  assert.equal(state.transactions.filter(row=>row.category==='Food').length,5000);
  assert.equal(Object.keys(readCategoryReviewSession('live').selections).length,1);
  await click('Save 1 transaction');
  assert.deepEqual(sizes,[5000,1]);
});

test('a late single-save response cannot clear a newer category receipt or Undo',async()=>{
  const state=fixture();let finish:()=>void=()=>{};
  const onCommand=()=>new Promise<void>(resolve=>{finish=resolve;});
  await act(async()=>root.render(createElement(Expenses,{state,scope:'personal',readOnly:false,initialSection:'activity',onCommand,onOpen:()=>{}})));
  await act(async()=>categoryButton('Edit category for Merchant one on 2026-08-01').click());
  await pick('Food');
  const newer={id:'two',expectedCategory:'Uncategorized',expectedExpenseCategory:null,category:'Social',expenseCategory:'Social'};
  await act(async()=>updateCategoryReviewSession('live',previous=>({...previous,lastSave:[newer],attempt:{changes:[newer],requestId:'newer',undo:false}})));
  await act(async()=>finish());
  assert.equal(readCategoryReviewSession('live').attempt?.requestId,'newer');
  assert.deepEqual(readCategoryReviewSession('live').lastSave,[newer]);
});

test('a late single Undo response cannot clear a newer save receipt',async()=>{
  const change={id:'one',expectedCategory:'Uncategorized',expectedExpenseCategory:null,category:'Food',expenseCategory:'Food'};
  const state=apply(fixture(),{type:'categorize_transactions',changes:[change],requestId:'initial-save'});
  updateCategoryReviewSession('live',()=>({selections:{},lastSave:[change]}));
  let finish:()=>void=()=>{};
  await act(async()=>root.render(createElement(Expenses,{state,scope:'personal',readOnly:false,initialSection:'activity',onCommand:()=>new Promise<void>(resolve=>{finish=resolve;}),onOpen:()=>{}})));
  await click('Undo last save');
  const newer={id:'two',expectedCategory:'Uncategorized',category:'Social'};
  await act(async()=>updateCategoryReviewSession('live',previous=>({...previous,lastSave:[newer],attempt:{changes:[newer],requestId:'newer-save',undo:false}})));
  await act(async()=>finish());
  assert.equal(readCategoryReviewSession('live').attempt?.requestId,'newer-save');
  assert.deepEqual(readCategoryReviewSession('live').lastSave,[newer]);
});
