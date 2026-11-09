import test,{after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createRequire,registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {createStore} from '../server/store.ts';
import {today} from '../shared/analytics.ts';
import type {Command} from '../shared/types.ts';
const require=createRequire(import.meta.url),{JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLSelectElement','HTMLTextAreaElement','HTMLDialogElement','Event'] as const)Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
const hooks=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('.')&&!/\.[a-z]+$/.test(specifier)&&context.parentURL)for(const ext of ['.ts','.tsx']){const url=new URL(specifier+ext,context.parentURL);if(existsSync(url))return next(url.href,context);}return next(specifier,context);},load(url,context,next){if(url.endsWith('.css'))return {format:'module',source:'export default {};',shortCircuit:true};if(url.endsWith('.tsx'))return{format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText,shortCircuit:true};return next(url,context);}});
const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client');
const {PaymentRecorder,TransactionEditor,ReserveEditor,AccountEditor}=await import('./components/RecordActions.tsx');
const {default:AccountDirectory}=await import('./features/accounts/AccountDirectory.tsx');
const container=document.getElementById('root')!;let root=createRoot(container);
beforeEach(async()=>{await act(async()=>root.unmount());root=createRoot(container);});
after(async()=>{await act(async()=>root.unmount());hooks.deregister();dom.window.close();});
function setup(t:{after:(fn:()=>void)=>void}){const directory=mkdtempSync(join(tmpdir(),'mazal-record-ui-')),store=createStore(join(directory,'live.sqlite'),'live');t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});store.command({type:'add_account',entityId:'personal',name:'Bank',accountType:'cash',openingBalanceCents:100000,openingDate:'2026-01-01'});return store;}
function field(label:string){const node=[...container.querySelectorAll('label')].find(node=>node.textContent?.startsWith(label));assert.ok(node,`Missing ${label}`);const input=node.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea');assert.ok(input);return input;}
async function fill(label:string,value:string){const input=field(label);await act(async()=>{const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(input instanceof HTMLSelectElement?'change':'input',{bubbles:true}));});}
async function submit(){await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}
function button(label:string){const element=[...container.querySelectorAll('button')].find(item=>item.textContent===label);assert.ok(element,`Missing ${label}`);return element;}
async function frame(){await act(async()=>new Promise<void>(resolve=>window.requestAnimationFrame(()=>resolve())));}

for(const removed of [false,true])test(`record dialog returns to its pointer opener${removed?' fallback after the opener is removed':''}`,async t=>{
  const store=setup(t);
  const state=store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000});
  const previous=document.createElement('button'),opener=document.createElement('button');
  previous.textContent='Previous focus';opener.textContent='Open reserve';
  document.body.append(previous,opener);previous.focus();
  t.after(()=>{previous.remove();opener.remove();});
  let open=true;
  const render=()=>root.render(createElement('main',{tabIndex:-1},createElement('h1',{tabIndex:-1},'Home'),open?createElement(ReserveEditor,{state,reserve:state.reserves[0],returnFocusTo:opener,onClose:()=>{open=false;if(removed)opener.remove();render();},onCommand:async()=>{assert.fail('Closing an unchanged reserve must not save');}}):null));
  await act(async()=>render());
  await act(async()=>button('Cancel').click());
  await frame();
  assert.equal(document.activeElement,removed?container.querySelector('h1'):opener);
});

test('closing a record opened without a focused control returns focus to the page heading',async t=>{
  const store=setup(t);
  const state=store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000});
  let open=true;
  const render=()=>root.render(createElement('main',{tabIndex:-1},createElement('h1',{tabIndex:-1},'Home'),open?createElement(ReserveEditor,{state,reserve:state.reserves[0],onClose:()=>{open=false;render();},onCommand:async()=>{assert.fail('Closing an unchanged reserve must not save');}}):null));
  assert.equal(document.activeElement,document.body);
  await act(async()=>render());
  await act(async()=>button('Cancel').click());
  await frame();
  assert.equal(document.activeElement,container.querySelector('h1'));
});

for(const escape of [false,true])test(`keeping a reserve draft with ${escape?'Escape':'Keep editing'} restores the edited field`,async t=>{
  const store=setup(t);
  store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000});
  const state=store.state(),before=structuredClone(state);let closed=0;
  await act(async()=>root.render(createElement(ReserveEditor,{state,reserve:state.reserves[0],onClose:()=>{closed++;},onCommand:async()=>{assert.fail('Keeping a draft must not save');}})));
  assert.equal(document.activeElement,field('Reserve name'));
  const amount=field('Amount');amount.focus();await fill('Amount','250.00');
  await act(async()=>button('Cancel').click());
  assert.equal(document.activeElement,button('Keep editing'));
  await act(async()=>{if(escape)container.querySelector('dialog')!.dispatchEvent(new Event('cancel',{cancelable:true}));else button('Keep editing').click();});
  await frame();
  assert.equal(document.activeElement,amount);assert.equal(amount.value,'250.00');assert.equal(closed,0);
  assert.deepEqual(store.state(),before);
});

for(const edited of [false,true])test(`reviewing a changed reserve ${edited?'preserves edited entries':'loads its current name and amount'}`,async t=>{
  const store=setup(t);
  store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000});
  let state=store.state();const reserve=state.reserves[0],sent:Command[]=[];
  const render=()=>root.render(createElement(ReserveEditor,{state,reserve,onClose:()=>{},onCommand:async command=>{sent.push(command);state=store.command(command);}}));
  await act(async()=>render());
  if(edited){await fill('Reserve name','My reserve');await fill('Amount','300.00');}
  state=store.command({type:'update_reserve',id:reserve.id,expected:reserve,name:'Updated buffer',amountCents:25000,requestId:'reserve-elsewhere',expectedRevision:state.revision});
  const current=state.reserves[0],revision=state.revision;
  await act(async()=>render());
  assert.equal(button('Save reserve').disabled,true);assert.match(container.textContent!,/Saved reserve: Updated buffer.*\$250/);
  await submit();assert.equal(sent.length,0);
  await act(async()=>button('Use updated records').click());
  assert.equal(field('Reserve name').value,edited?'My reserve':'Updated buffer');
  assert.equal(field('Amount').value,edited?'300.00':'250.00');
  await submit();assert.equal(sent.length,1);assert.ok(sent[0].type==='update_reserve');
  assert.deepEqual(sent[0].expected,current);assert.equal(sent[0].expectedRevision,revision);
  assert.equal(state.reserves[0].amountCents,edited?30000:25000);assert.equal(state.accounts[0].balanceCents,100000);
});

test('a changed reserve requires choosing release again after reviewing its latest values',async t=>{
  const store=setup(t);
  store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000});
  let state=store.state();const reserve=state.reserves[0],sent:Command[]=[];
  const render=()=>root.render(createElement(ReserveEditor,{state,reserve,onClose:()=>{},onCommand:async command=>{sent.push(command);state=store.command(command);}}));
  await act(async()=>render());await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  state=store.command({type:'update_reserve',id:reserve.id,expected:reserve,name:'Rent reserve',amountCents:50000,requestId:'reserve-elsewhere',expectedRevision:state.revision});
  const revision=state.revision;
  await act(async()=>render());assert.equal(button('Release reserve').disabled,true);
  await submit();assert.equal(sent.length,0);
  await act(async()=>button('Use updated records').click());
  assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,false);
  assert.equal(field('Reserve name').value,'Rent reserve');assert.equal(field('Amount').value,'500.00');
  await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await submit();
  assert.equal(sent.length,1);assert.equal(sent[0].type,'remove_reserve');assert.equal(sent[0].expectedRevision,revision);
  assert.equal(state.reserves.length,0);assert.equal(state.accounts[0].balanceCents,100000);
});

test('reserve release rejects a change that arrived after the last review',async t=>{
  const {CommandRejectedError}=await import('./services/command-errors.ts');
  const store=setup(t);
  store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000});
  let state=store.state();const reserve=state.reserves[0],sent:Command[]=[];let closed=0;
  const render=()=>root.render(createElement(ReserveEditor,{state,reserve,onClose:()=>{closed++;},onCommand:async command=>{
    sent.push(command);
    try{state=store.command(command);}catch(error){state=store.state();render();throw new CommandRejectedError(error instanceof Error?error.message:'Records changed',409);}
  }}));
  await act(async()=>render());await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const revision=state.revision;
  store.command({type:'update_reserve',id:reserve.id,expected:reserve,name:'Rent reserve',amountCents:50000,requestId:'reserve-race',expectedRevision:revision});
  await submit();
  assert.equal(sent.length,1);assert.equal(sent[0].expectedRevision,revision);assert.equal(closed,0);
  assert.equal(store.state().reserves[0].amountCents,50000);assert.equal(button('Release reserve').disabled,true);
  button('Use updated records').focus();await act(async()=>button('Use updated records').click());await frame();
  assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,false);
  assert.equal(document.activeElement,field('Reserve name'));
  assert.equal(field('Reserve name').value,'Rent reserve');assert.equal(field('Amount').value,'500.00');
  assert.equal(sent.length,1);assert.equal(store.state().accounts[0].balanceCents,100000);
});

for(const release of [false,true])test(`a removed reserve blocks ${release?'release':'editing'} after reviewing records`,async t=>{
  const store=setup(t);
  store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000});
  let state=store.state();const reserve=state.reserves[0],sent:Command[]=[];
  const render=()=>root.render(createElement(ReserveEditor,{state,reserve,onClose:()=>{},onCommand:async command=>{sent.push(command);}}));
  await act(async()=>render());
  if(release)await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());else await fill('Amount','300.00');
  state=store.command({type:'remove_reserve',id:reserve.id,expectedRevision:state.revision});
  await act(async()=>render());await act(async()=>button('Use updated records').click());
  assert.match(container.textContent!,/This reserve is no longer available/);
  assert.equal(button(release?'Release reserve':'Save reserve').disabled,true);
  await submit();assert.equal(sent.length,0);assert.equal(store.state().accounts[0].balanceCents,100000);
});

for(const release of [false,true])for(const savedFirst of [false,true])test(`an uncertain reserve ${release?'release':'edit'} retries the original request ${savedFirst?'after':'before'} commit`,async t=>{
  const store=setup(t);
  store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000});
  let state=store.state();const reserve=state.reserves[0],sent:Command[]=[];let closed=0;
  const render=()=>root.render(createElement(ReserveEditor,{state,reserve,onClose:()=>{closed++;},onCommand:async command=>{
    sent.push(command);
    if(sent.length===1){if(savedFirst)state=store.command(command);render();throw new Error('Connection lost');}
    state=store.command(command);
  }}));
  await act(async()=>render());
  field('Amount').focus();
  if(release)await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());else await fill('Amount','300.00');
  await submit();assert.equal(field('Amount').closest('fieldset')!.disabled,true);
  await act(async()=>button('Cancel').click());await act(async()=>button('Keep editing').click());await frame();
  assert.equal(document.activeElement,button('Confirm original save'));
  await submit();assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);assert.equal(closed,1);
  assert.equal(state.reserves.length,release?0:1);if(!release)assert.equal(state.reserves[0].amountCents,30000);
  assert.equal(state.accounts[0].balanceCents,100000);
});

for(const edited of [true,false])test(`reviewing a renamed account ${edited?'preserves the edited name':'loads the new saved name'} before saving`,async t=>{
  const store=setup(t);
  let state=store.state();const account=state.accounts[0],sent:Command[]=[];
  const render=()=>root.render(createElement(AccountEditor,{state,account,onClose:()=>{},onCommand:async command=>{sent.push(command);state=store.command(command);}}));
  await act(async()=>render());
  if(edited)await fill('Account name','My bank label');
  state=store.command({type:'rename_account',accountId:account.id,name:'Bank renamed elsewhere',expectedName:account.name,expectedRevision:state.revision,requestId:'other-name'});
  await act(async()=>render());
  assert.equal(button('Save').disabled,true);
  await act(async()=>button('Use updated records').click());
  assert.equal(field('Account name').value,edited?'My bank label':'Bank renamed elsewhere');
  await submit();
  assert.equal(sent.length,1);
  assert.ok(sent[0].type==='rename_account');
  assert.equal(sent[0].expectedName,'Bank renamed elsewhere');
  assert.equal(store.state().accounts[0].name,edited?'My bank label':'Bank renamed elsewhere');
});

test('reviewing a concurrently closed account requires choosing its next action again',async t=>{
  const store=setup(t);
  store.command({type:'add_account',entityId:'personal',name:'Empty bank',accountType:'cash',openingBalanceCents:0,openingDate:'2026-01-01'});
  let state=store.state();const account=state.accounts.find(item=>item.name==='Empty bank')!,sent:Command[]=[];
  const render=()=>root.render(createElement(AccountEditor,{state,account,onClose:()=>{},onCommand:async command=>{sent.push(command);state=store.command(command);}}));
  await act(async()=>render());
  await fill('Change','status');
  state=store.command({type:'set_account_closed',accountId:account.id,closed:true,expectedRevision:state.revision,requestId:'close-elsewhere'});
  await act(async()=>render());
  await act(async()=>button('Use updated records').click());
  assert.equal(field('Change').value,'rename');
  assert.match(container.textContent!,/Reopen account/);
  await fill('Change','status');
  await submit();
  assert.equal(sent.length,1);
  assert.ok(sent[0].type==='set_account_closed');
  assert.equal(sent[0].closed,false);
  assert.equal(Boolean(store.state().accounts.find(item=>item.id===account.id)!.closedAt),false);
});

test('returning from account management focuses the same account in the directory',async t=>{
  const store=setup(t);
  store.command({type:'add_account',entityId:'personal',name:'Second bank',accountType:'cash',openingBalanceCents:0,openingDate:'2026-01-01'});
  await act(async()=>root.render(createElement(AccountDirectory,{state:store.state(),onClose:()=>{},onCommand:async()=>{}})));
  const manage=[...container.querySelectorAll<HTMLButtonElement>('.account-directory-row button')][1];
  manage.focus();
  await act(async()=>manage.click());
  await act(async()=>button('Cancel').click());
  assert.equal(document.activeElement?.closest('.account-directory-row')?.querySelector('h3')?.textContent,'Second bank');
});

test('a concurrent reversal blocks a correction after reviewing the refreshed records',async t=>{
  const store=setup(t),bank=store.state().accounts[0].id;
  store.command({type:'add_transaction',kind:'expense',accountId:bank,amountCents:2000,date:today(),description:'Incorrect purchase',category:'Food',requestId:'expense'});
  let state=store.state();const transaction=state.transactions.find(item=>item.description==='Incorrect purchase')!,sent:Command[]=[];
  const render=()=>root.render(createElement(TransactionEditor,{state,transaction,onClose:()=>{},onCommand:async command=>{sent.push(command);store.command(command);}}));
  await act(async()=>render());
  await fill('Action','correct');await fill('Reason','Correct amount');
  state=store.command({type:'correct_transaction',id:transaction.id,reason:'Reversed elsewhere',expectedRevision:state.revision,requestId:'reverse-elsewhere'});
  await act(async()=>render());
  await act(async()=>button('Use updated records').click());
  assert.equal(button('Save correction').disabled,true);
  assert.match((field('Action') as HTMLSelectElement).selectedOptions[0].textContent!,/no longer available/i);
  await submit();
  assert.equal(sent.length,0);
});

for(const edited of [false,true])test(`reviewing a recategorized transaction ${edited?'preserves an edited category':'loads its saved category'} before an amount correction`,async t=>{
  const store=setup(t),account=store.state().accounts[0].id;
  let state=store.command({type:'add_transaction',kind:'expense',accountId:account,amountCents:2000,date:today(),description:'Purchase to correct',category:'Food',requestId:'expense'});
  const original=state.transactions.find(item=>item.description==='Purchase to correct')!,sent:Command[]=[];
  const render=()=>root.render(createElement(TransactionEditor,{state,transaction:state.transactions.find(item=>item.id===original.id)!,onClose:()=>{},onCommand:async command=>{sent.push(command);state=store.command(command);}}));
  await act(async()=>render());
  await fill('Action','correct');await fill('Amount','15.00');await fill('Reason','Correct receipt amount');
  if(edited)await fill('Category','My category');
  state=store.command({type:'categorize_transaction',id:original.id,expectedCategory:'Food',category:'Transport',requestId:'category-elsewhere',expectedRevision:state.revision});
  const revision=state.revision;
  await act(async()=>render());assert.equal(button('Save correction').disabled,true);
  await act(async()=>button('Use updated records').click());
  assert.equal(field('Category').value,edited?'My category':'Transport');
  assert.equal(field('Amount').value,'15.00');
  await submit();assert.equal(sent.length,1);assert.equal(sent[0].expectedRevision,revision);
  const replacement=state.transactions.find(item=>item.replacesId===original.id)!;
  assert.equal(replacement.category,edited?'My category':'Transport');assert.equal(replacement.amountCents,1500);
  assert.equal(state.accounts[0].balanceCents,98500);
});

for(const savedFirst of [true,false])test(`payment uncertain ${savedFirst?'after':'before'} commit pins actual details and retries one occurrence`,async t=>{
  const store=setup(t),account=store.state().accounts[0].id;
  store.command({type:'add_obligation',entityId:'personal',name:'Phone',amountCents:2000,dueDate:today(),direction:'out',recurrence:'monthly',accountId:account,category:'Bills',requestId:'bill'});
  let state=store.state();const sent:Command[]=[];let closed=0;
  const render=()=>root.render(createElement(PaymentRecorder,{state,obligation:state.obligations[0],onClose:()=>{closed++;},onCommand:async command=>{sent.push(command);if(sent.length===1){if(savedFirst)state=store.command(command);render();throw new Error('Connection lost');}state=store.command(command);}}));
  await act(async()=>render());await fill('Actual amount','17.25');await submit();
  assert.equal(field('Actual amount').closest('fieldset')!.disabled,true);
  assert.equal(button('Confirm original save').disabled,false);await submit();
  assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);assert.equal(closed,1);
  assert.equal(store.state().accounts[0].balanceCents,98275);assert.equal(store.state().transactions.filter(tx=>tx.plannedPayment).length,1);
});
test('refreshing a paid recurring bill cannot retarget an open payment draft to its next occurrence',async t=>{
  const store=setup(t),account=store.state().accounts[0].id;
  store.command({type:'add_obligation',entityId:'personal',name:'Phone',amountCents:2000,dueDate:today(),direction:'out',recurrence:'monthly',accountId:account,category:'Bills',requestId:'bill'});
  let state=store.state();const original=state.obligations[0],sent:Command[]=[];
  const render=()=>root.render(createElement(PaymentRecorder,{state,obligation:state.obligations[0],onClose:()=>{},onCommand:async command=>{sent.push(command);state=store.command(command);}}));
  await act(async()=>render());await fill('Actual amount','17.25');
  state=store.command({type:'pay_obligation',id:original.id,expectedDueDate:original.dueDate,amountCents:1725,date:today(),accountId:account,expectedRevision:state.revision,requestId:'paid-elsewhere'});
  const afterPayment=structuredClone(state);
  assert.notEqual(state.obligations[0].dueDate,original.dueDate);
  await act(async()=>render());
  assert.equal(button('Record payment').disabled,true);
  await act(async()=>button('Use updated records').click());
  assert.equal(button('Record payment').disabled,true,'the old occurrence remains unavailable after reviewing refreshed records');
  assert.match(container.textContent!,new RegExp(`Due ${original.dueDate}`));
  assert.equal(field('Actual amount').value,'17.25');
  await submit();assert.equal(sent.length,0);
  assert.deepEqual(store.state(),afterPayment);
  await act(async()=>root.render(null));await act(async()=>render());
  assert.equal(button('Record payment').disabled,false);
  assert.match(container.textContent!,new RegExp(`Due ${state.obligations[0].dueDate}`));
  assert.equal(field('Actual amount').value,'20.00');
});

test('a same-date purchase linkage change cannot turn an open bill payment into an asset contribution',async t=>{
  const store=setup(t),account=store.state().accounts[0].id;
  store.command({type:'save_asset_purchase',purchase:{id:'laptop',entityId:'personal',name:'Laptop',payee:'Store',targetCents:100000,monthlyCents:2000,paidCents:0,paidAsOf:today(),notes:''},expected:null,requestId:'purchase'});
  store.command({type:'add_obligation',entityId:'personal',name:'Equipment',amountCents:2000,dueDate:today(),direction:'out',recurrence:'monthly',accountId:account,category:'Bills',requestId:'bill'});
  let state=store.state();const original=state.obligations[0],sent:Command[]=[];
  const render=()=>root.render(createElement(PaymentRecorder,{state,obligation:state.obligations[0],onClose:()=>{},onCommand:async command=>{sent.push(command);state=store.command(command);}}));
  await act(async()=>render());await fill('Actual amount','17.25');
  state=store.command({type:'update_obligation',id:original.id,expectedDueDate:original.dueDate,expectedStatus:'planned',name:original.name,amountCents:original.amountCents,dueDate:original.dueDate,recurrence:original.recurrence,accountId:account,category:original.category,assetPurchaseId:'laptop',requestId:'link-elsewhere',expectedRevision:state.revision});
  const afterLink=structuredClone(state);
  await act(async()=>render());await act(async()=>button('Use updated records').click());
  assert.equal(button('Record payment').disabled,true);
  assert.match(container.textContent!,/Close this form and review the current schedule/);
  assert.equal(field('Actual amount').value,'17.25');
  await submit();assert.equal(sent.length,0);
  assert.deepEqual(store.state(),afterLink);
});

test('an unrelated refresh keeps the opened bill payment draft reviewable',async t=>{
  const store=setup(t),account=store.state().accounts[0].id;
  store.command({type:'add_obligation',entityId:'personal',name:'Phone',amountCents:2000,dueDate:today(),direction:'out',recurrence:'monthly',accountId:account,category:'Bills',requestId:'bill'});
  let state=store.state();const sent:Command[]=[];
  const render=()=>root.render(createElement(PaymentRecorder,{state,obligation:state.obligations[0],onClose:()=>{},onCommand:async command=>{sent.push(command);state=store.command(command);}}));
  await act(async()=>render());await fill('Actual amount','17.25');
  state=store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000});
  await act(async()=>render());await act(async()=>button('Use updated records').click());
  assert.equal(button('Record payment').disabled,false);
  await submit();assert.equal(sent.length,1);
  assert.equal(store.state().accounts[0].balanceCents,98275);
});

test('matching the existing payment from the dialog never posts cash twice',async t=>{
  const store=setup(t),account=store.state().accounts[0].id;
  store.command({type:'add_transaction',kind:'expense',accountId:account,amountCents:2500,date:today(),description:'Internet paid',category:'Bills',requestId:'tx'});
  store.command({type:'add_obligation',entityId:'personal',name:'Internet',amountCents:3000,dueDate:today(),direction:'out',recurrence:'once',accountId:'',category:'Bills',requestId:'bill'});
  const state=store.state(),tx=state.transactions.find(tx=>tx.description==='Internet paid')!;
  await act(async()=>root.render(createElement(PaymentRecorder,{state,obligation:state.obligations[0],onClose:()=>{},onCommand:async command=>{store.command(command);}})));
  await fill('Payment record','match');await fill('Recorded transaction',tx.id);await submit();assert.equal(store.state().accounts[0].balanceCents,97500);assert.equal(store.state().transactions.length,state.transactions.length);assert.equal(store.state().obligations[0].status,'paid');
});
test('correction and reserve release retain original financial history',async t=>{
  const store=setup(t),account=store.state().accounts[0].id;
  store.command({type:'add_transaction',kind:'expense',accountId:account,amountCents:2000,date:today(),description:'Wrong amount',category:'Food',requestId:'tx'});
  let state=store.state();const tx=state.transactions.find(tx=>tx.description==='Wrong amount')!;
  await act(async()=>root.render(createElement(TransactionEditor,{state,transaction:tx,onClose:()=>{},onCommand:async command=>{store.command(command);}})));
  await fill('Action','correct');await fill('Amount','12.50');await fill('Reason','Receipt correction');await submit();assert.equal(store.state().accounts[0].balanceCents,98750);assert.ok(store.state().transactions.some(item=>item.id===tx.id));
  await act(async()=>root.unmount());root=createRoot(container);
  store.command({type:'add_reserve',entityId:'personal',name:'Buffer',amountCents:10000,requestId:'reserve'});state=store.state();
  await act(async()=>root.render(createElement(ReserveEditor,{state,reserve:state.reserves[0],onClose:()=>{},onCommand:async command=>{store.command(command);}})));
  await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await submit();assert.equal(store.state().reserves.length,0);assert.equal(store.state().accounts[0].balanceCents,98750);
});

for(const sourceType of ['investment','receivable'] as const)test(`transfer correction displays and uses its ${sourceType} source`,async t=>{
  const store=setup(t),bank=store.state().accounts[0].id;
  store.command({type:'add_account',entityId:'personal',name:'Transfer source',accountType:sourceType,openingBalanceCents:100000,openingDate:'2026-01-01'});
  const source=store.state().accounts.find(account=>account.name==='Transfer source')!.id;
  store.command({type:'add_account',entityId:'personal',name:'SOL wallet',accountType:'investment',openingBalanceCents:0,openingDate:'2026-01-01'});
  const sol=store.state().accounts.find(account=>account.name==='SOL wallet')!.id;
  store.command({type:'save_sol',accountId:sol,liquidSol:'1',stakedSol:'0',costBasisCents:10000,priceCents:10000,priceDate:today(),requestId:'sol'});
  store.command({type:'add_transaction',kind:'transfer',accountId:source,toAccountId:bank,amountCents:2500,date:today(),description:'Transfer to bank',category:'Transfer',requestId:'transfer'});
  const state=store.state(),tx=state.transactions.find(item=>item.description==='Transfer to bank')!,sent:Command[]=[];
  await act(async()=>root.render(createElement(TransactionEditor,{state,transaction:tx,onClose:()=>{},onCommand:async command=>{sent.push(command);store.command(command);}})));
  await fill('Action','correct');
  assert.equal(field('Account').value,source);
  assert.equal((field('Account') as HTMLSelectElement).selectedOptions[0].textContent,'Transfer source');
  assert.equal(field('Destination').value,bank);
  assert.equal((field('Account') as HTMLSelectElement).querySelector(`option[value="${sol}"]`),null);
  assert.equal((field('Destination') as HTMLSelectElement).querySelector(`option[value="${sol}"]`),null);
  await fill('Account',bank);
  assert.equal(field('Destination').value,'');
  await fill('Reason','Corrected amount');
  await submit();
  assert.equal(sent.length,0);
  assert.match(container.textContent!,/Choose a different available destination account/);
  await fill('Account',source);
  await fill('Destination',bank);
  await fill('Amount','12.50');
  await submit();
  assert.equal(sent.length,1);
  assert.equal(store.state().accounts.find(account=>account.id===bank)!.balanceCents,101250);
  assert.equal(store.state().accounts.find(account=>account.id===source)!.balanceCents,98750);
  const corrected=store.state().transactions.find(item=>item.replacesId===tx.id)!;
  assert.equal(corrected.accountId,source);
  assert.equal(corrected.toAccountId,bank);
});

test('group review and extraction correction preserve original identity and earlier decisions',async t=>{
  const {default:StatementTools}=await import('./features/records/StatementTools.tsx');
  const store=setup(t),account=store.state().accounts[0].id;
  store.command({type:'stage_statement',requestId:'stage',statement:{id:'statement',accountId:account,sourceFile:'Bank.csv',sha256:'a'.repeat(64),periodStart:'2026-01-01',periodEnd:'2026-01-31',openingBalanceCents:100000,closingBalanceCents:99900,rows:[{id:'one',transactionDate:'2026-01-02',postingDate:'2026-01-02',description:'Shop',amountCents:-50,sourcePage:1},{id:'two',transactionDate:'2026-01-03',postingDate:'2026-01-03',description:'Shop',amountCents:-50,sourcePage:1}]}});
  let state=store.state();const render=()=>root.render(createElement(StatementTools,{state,batch:state.importBatches![0],readOnly:false,onCommand:async command=>{state=store.command(command);render();}}));
  await act(async()=>render());await act(async()=>button('Review matching rows together').click());await fill('Exact description','Shop');
  for(const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))await act(async()=>checkbox.click());
  await fill('Category','Groceries');await submit();assert.equal(store.state().importBatches![0].decisions.length,2);assert.equal(store.state().transactions.length,1);
  await act(async()=>button('Correct extracted rows').click());await fill('Reason for correction','Corrected statement transcription');await fill('Corrected CSV rows','TransactionDate,PostingDate,Description,Amount,SourcePage\n2026-01-02,2026-01-02,Shop corrected,-0.50,1\n2026-01-03,2026-01-03,Shop,-0.50,1');await submit();
  const batch=store.state().importBatches![0];assert.equal(batch.source.sha256,'a'.repeat(64));assert.equal(batch.source.sourceFile,'Bank.csv');assert.equal(batch.extractionHistory?.[0].decisions.length,2);assert.equal(batch.extractionHistory?.[0].source.rows[0].description,'Shop');assert.equal(batch.source.rows[0].description,'Shop corrected');assert.equal(batch.decisions.length,0);assert.equal(store.state().accounts[0].balanceCents,100000);
});

test('extraction correction keeps the missing source date explicit instead of asserting both dates', async t => {
  const { default: StatementTools } = await import('./features/records/StatementTools.tsx');
  const store = setup(t), account = store.state().accounts[0].id;
  store.command({ type: 'stage_statement', requestId: 'single-stage', statement: { id: 'single-date', accountId: account, sourceFile: 'Bank activity.json', sha256: 'a'.repeat(64), sourceKind: 'bank_activity', observedOn: '2026-01-31', periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 100000, closingBalanceCents: 99900, rows: [{ id: 'row-1', transactionDate: '2026-01-02', postingDate: '2026-01-02', dateBasis: 'posting_only', description: 'Shop', amountCents: -100, sourcePage: 1 }] } });
  let state = store.state();
  const render = () => root.render(createElement(StatementTools, { state, batch: state.importBatches![0], readOnly: false, onCommand: async command => { state = store.command(command); render(); } }));
  await act(async () => render());
  await act(async () => button('Correct extracted rows').click());
  assert.match(field('Corrected CSV rows').value, /"","2026-01-02","Shop","-1.00","1","posting_only"/);
  assert.match(container.textContent!, /Leave the other source date blank/);
  await fill('Corrected CSV rows', field('Corrected CSV rows').value.replace('Shop', 'Shop corrected'));
  await fill('Reason for correction', 'Full merchant description');
  await submit();
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(store.state().importBatches![0].source.rows[0].dateBasis, 'posting_only');
  assert.equal(store.state().importBatches![0].extractionHistory![0].source.rows[0].dateBasis, 'posting_only');
});

function stageReviewStatement(store:ReturnType<typeof createStore>){
  store.command({type:'stage_statement',requestId:'review-stage',statement:{id:'review-statement',accountId:store.state().accounts[0].id,sourceFile:'Review.csv',sha256:'b'.repeat(64),periodStart:'2026-01-01',periodEnd:'2026-01-31',openingBalanceCents:100000,closingBalanceCents:99900,rows:[{id:'one',transactionDate:'2026-01-02',postingDate:'2026-01-02',description:'Shop',amountCents:-50,sourcePage:1},{id:'two',transactionDate:'2026-01-03',postingDate:'2026-01-03',description:'Shop',amountCents:-50,sourcePage:1}]}});
}

test('an unrelated refresh retains and saves a statement correction at the new revision',async t=>{
  const {default:StatementTools}=await import('./features/records/StatementTools.tsx');
  const store=setup(t);stageReviewStatement(store);
  let state=store.state();const sent:Command[]=[];
  const render=()=>root.render(createElement(StatementTools,{state,batch:state.importBatches![0],readOnly:false,onCommand:async command=>{sent.push(command);state=store.command(command);render();}}));
  await act(async()=>render());await act(async()=>button('Correct extracted rows').click());
  await fill('Corrected CSV rows',field('Corrected CSV rows').value.replace('Shop','Shop corrected'));
  await fill('Reason for correction','Merchant name from original file');
  state=store.command({type:'rename_account',accountId:state.accounts[0].id,name:'Renamed bank',expectedName:'Bank',expectedRevision:state.revision,requestId:'unrelated-rename'});
  const refreshedRevision=state.revision;
  await act(async()=>render());
  assert.match(field('Corrected CSV rows').value,/Shop corrected/);
  assert.equal(field('Reason for correction').value,'Merchant name from original file');
  assert.equal(button('Save corrected extraction').disabled,false);
  assert.doesNotMatch(container.textContent!,/saved statement changed/);
  await submit();
  assert.equal(sent.length,1);assert.equal(sent[0].expectedRevision,refreshedRevision);
  assert.equal(store.state().importBatches![0].source.rows[0].description,'Shop corrected');
  assert.equal(store.state().accounts[0].balanceCents,100000);
});

test('changed statement evidence requires review and preserves edited fields while updating untouched fields',async t=>{
  const {default:StatementTools}=await import('./features/records/StatementTools.tsx');
  const store=setup(t);stageReviewStatement(store);
  let state=store.state();const sent:Command[]=[];
  const render=()=>root.render(createElement(StatementTools,{state,batch:state.importBatches![0],readOnly:false,onCommand:async command=>{sent.push(command);state=store.command(command);render();}}));
  await act(async()=>render());await act(async()=>button('Correct extracted rows').click());
  await fill('Corrected CSV rows',field('Corrected CSV rows').value.replace('Shop','My corrected merchant'));
  await fill('Reason for correction','Confirmed merchant spelling');
  const original=state.importBatches![0];
  state=store.command({type:'revise_statement',importId:original.id,statement:{...original.source,periodStart:'2025-12-31',rows:original.source.rows.map(row=>({...row,description:'Updated saved merchant'}))},reason:'Period and extracted merchant corrected elsewhere',expectedRevision:state.revision,requestId:'other-extraction'});
  await act(async()=>render());
  assert.equal(button('Save corrected extraction').disabled,true);
  assert.match(field('Current saved CSV rows').value,/Updated saved merchant/);
  assert.match(field('Corrected CSV rows').value,/My corrected merchant/);
  assert.equal(field('Reason for correction').value,'Confirmed merchant spelling');
  await submit();assert.equal(sent.length,0);
  await act(async()=>button('Keep my edited values').click());
  assert.equal(field('Period start').value,'2025-12-31');
  assert.match(field('Corrected CSV rows').value,/My corrected merchant/);
  assert.equal(button('Save corrected extraction').disabled,false);
  await submit();
  const batch=store.state().importBatches![0];
  assert.equal(sent.length,1);assert.equal(batch.source.periodStart,'2025-12-31');
  assert.equal(batch.source.rows[0].description,'My corrected merchant');
  assert.equal(batch.source.sha256,original.source.sha256);
  assert.equal(batch.extractionHistory!.at(-1)!.source.rows[0].description,'Updated saved merchant');
  assert.equal(store.state().accounts[0].balanceCents,100000);
});

test('group review keeps its selected rows and preserves another saved classification after explicit review',async t=>{
  const {default:StatementTools}=await import('./features/records/StatementTools.tsx');
  const store=setup(t);stageReviewStatement(store);
  let state=store.state();
  const render=()=>root.render(createElement(StatementTools,{state,batch:state.importBatches![0],readOnly:false,onCommand:async command=>{state=store.command(command);render();}}));
  await act(async()=>render());await act(async()=>button('Review matching rows together').click());
  await fill('Exact description','Shop');
  await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await fill('Category','My groceries');
  state=store.command({type:'review_statement',importId:state.importBatches![0].id,decisions:[{rowId:'two',kind:'expense',category:'Other saved category'}],expectedRevision:state.revision,requestId:'other-classification'});
  await act(async()=>render());
  assert.equal(button('Save selected classifications').disabled,true);
  assert.match(field('Current saved classifications').value,/Other saved category/);
  await act(async()=>button('Keep my classification').click());
  assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,true);
  assert.equal(field('Category').value,'My groceries');
  await submit();
  assert.deepEqual(store.state().importBatches![0].decisions.map(row=>[row.rowId,row.category]).sort(),[['one','My groceries'],['two','Other saved category']]);
});

test('a refreshed statement never rewrites an uncertain extraction save attempt',async t=>{
  const {default:StatementTools}=await import('./features/records/StatementTools.tsx');
  const store=setup(t);stageReviewStatement(store);
  let state=store.state();const sent:Command[]=[];
  const render=()=>root.render(createElement(StatementTools,{state,batch:state.importBatches![0],readOnly:false,onCommand:async command=>{sent.push(command);state=store.command(command);render();if(sent.length===1)throw new Error('Connection lost after saving');}}));
  await act(async()=>render());await act(async()=>button('Correct extracted rows').click());
  await fill('Corrected CSV rows',field('Corrected CSV rows').value.replace('Shop','Corrected merchant'));
  await fill('Reason for correction','Verified original');await submit();
  state=store.command({type:'rename_account',accountId:state.accounts[0].id,name:'Renamed bank',expectedName:'Bank',expectedRevision:state.revision,requestId:'after-uncertain-save'});
  await act(async()=>render());
  assert.equal(button('Confirm original save').disabled,false);
  assert.equal(field('Corrected CSV rows').closest('fieldset')!.disabled,true);
  await submit();
  assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);
  assert.equal(store.state().importBatches![0].extractionHistory!.length,1);
  assert.equal(store.state().importBatches![0].source.rows[0].description,'Corrected merchant');
});

test('transaction name and note edit preserves source details and supports clearing the name',async t=>{
  const store=setup(t),accountId=store.state().accounts[0].id;
  store.command({type:'add_transaction',kind:'expense',accountId,amountCents:1234,date:'2026-01-10',description:'BANK ORIGINAL 123',category:'Uncategorized',requestId:'name-fixture'});
  let state=store.state();const original=state.transactions.find(row=>row.kind==='expense')!,sent:Command[]=[];
  const render=()=>root.render(createElement(TransactionEditor,{state,transaction:state.transactions.find(row=>row.id===original.id)!,onClose:()=>{},onCommand:async command=>{sent.push(command);state=store.command(command);}}));
  await act(async()=>render());assert.equal(button('Save name and note').disabled,true);
  assert.match(container.textContent??'',/Original description: BANK ORIGINAL 123/);
  await fill('Transaction name','Home internet');await fill('Note','Monthly service for work');assert.equal(field('Action').disabled,true);await fill('Action','refund');assert.equal(field('Action').value,'annotate');await submit();
  assert.equal(sent[0].type,'annotate_transaction');
  const saved=state.transactions.find(row=>row.id===original.id)!;
  const {displayName,note,...preserved}=saved;assert.deepEqual(preserved,original);
  assert.equal(displayName,'Home internet');assert.equal(note,'Monthly service for work');assert.equal(state.accounts[0].balanceCents,98766);
  await act(async()=>root.unmount());root=createRoot(container);await act(async()=>render());
  assert.equal(field('Transaction name').value,'Home internet');await fill('Transaction name','');await submit();
  const reset=state.transactions.find(row=>row.id===original.id)!;assert.equal(reset.displayName,undefined);assert.equal(reset.note,note);assert.equal(reset.description,original.description);
});

test('transaction annotation keeps the draft during a refresh and retries an uncertain save once',async t=>{
  const store=setup(t),accountId=store.state().accounts[0].id;
  store.command({type:'add_transaction',kind:'expense',accountId,amountCents:1000,date:'2026-01-10',description:'BANK ORIGINAL',category:'Uncategorized',requestId:'refresh-name-fixture'});
  let state=store.state();const transaction=state.transactions.find(row=>row.kind==='expense')!,sent:Command[]=[];let closed=0;
  const render=()=>root.render(createElement(TransactionEditor,{state,transaction,onClose:()=>{closed++;},onCommand:async command=>{sent.push(command);state=store.command(command);if(sent.length===1)throw new Error('Response lost');}}));
  await act(async()=>render());await fill('Transaction name','Weekly groceries');
  state=store.command({type:'annotate_transaction',id:transaction.id,displayName:'Groceries',note:'Shared household',expectedDisplayName:null,expectedNote:null,requestId:'rename-elsewhere',expectedRevision:state.revision});
  await act(async()=>render());assert.equal(button('Save name and note').disabled,true);
  await act(async()=>button('Use updated records').click());assert.equal(field('Transaction name').value,'Weekly groceries');assert.equal(field('Note').value,'Shared household');
  await submit();assert.equal(closed,0);assert.equal(field('Transaction name').matches(':disabled'),true);
  await act(async()=>render());await submit();assert.deepEqual(sent[1],sent[0]);assert.equal(closed,1);
  assert.equal(state.transactions.find(row=>row.id===transaction.id)!.displayName,'Weekly groceries');assert.equal(state.accounts[0].balanceCents,99000);
});

test('resetting annotation edits restores action choice without saving or changing money',async t=>{
  const store=setup(t);const transaction=store.state().transactions[0];const sent:Command[]=[];
  await act(async()=>root.render(createElement(TransactionEditor,{state:store.state(),transaction,onClose:()=>{},onCommand:async command=>{sent.push(command);}})));
  await fill('Transaction name','New name');assert.equal(field('Action').disabled,true);
  await act(async()=>button('Reset name and note edits').click());assert.equal(field('Transaction name').value,'');assert.equal(field('Action').disabled,false);assert.equal(button('Save name and note').disabled,true);assert.equal(sent.length,0);
});
