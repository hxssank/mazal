import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { previewCategoryRule } from '../shared/category-rules.ts';
import { reverseCategoryChanges } from '../shared/category-review.ts';
import type { CategoryRule } from '../shared/category-rules.ts';
import type { Command, StatementSource } from '../shared/types.ts';

const rule:CategoryRule={id:'fuel-rule',entityId:'personal',accountId:null,match:'contains',merchant:'PETRO-CANADA',category:'Fuel & convenience',enabled:true};
function setup(t:{after:(fn:()=>void)=>void}) {
  const directory=mkdtempSync(join(tmpdir(),'mazal-category-rules-'));
  const path=join(directory,'live.sqlite');
  const store=createStore(path,'live');
  t.after(()=>{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});});
  store.command({type:'add_account',entityId:'personal',name:'Cash',accountType:'cash',openingBalanceCents:100000,openingDate:'2026-01-01'});
  const accountId=store.state().accounts.find(account=>account.type==='cash')!.id;
  return {store,path,accountId};
}

test('merchant rules persist, restore and retry without changing balances or existing transactions',t=>{
  const {store,path}=setup(t);
  const before=store.state();
  const save:Command={type:'save_category_rule',rule,expected:null,requestId:'create-rule',expectedRevision:before.revision};
  store.command(save);
  const saved=store.state();
  store.command(save);
  assert.deepEqual(store.state(),saved);
  assert.deepEqual(saved.accounts,before.accounts);
  assert.deepEqual(saved.transactions,before.transactions);
  const backup=store.export();
  store.close();
  const reopened=createStore(path,'live');
  t.after(()=>reopened.close());
  assert.deepEqual(reopened.state().categoryRules,[rule]);
  reopened.restore(backup);
  assert.deepEqual(reopened.state().categoryRules,[rule]);
  const remove:Command={type:'delete_category_rule',id:rule.id,expected:rule,requestId:'delete-rule'};
  reopened.command(remove);
  const removed=reopened.state();
  reopened.command(remove);
  assert.deepEqual(reopened.state(),removed);
  assert.deepEqual(removed.categoryRules,[]);
});

test('rule edits and deletes reject stale snapshots, duplicate IDs and cross-owner accounts',t=>{
  const {store}=setup(t);
  store.command({type:'save_category_rule',rule,expected:null,requestId:'create-rule'});
  const updated={...rule,merchant:'ESSO'};
  store.command({type:'save_category_rule',rule:updated,expected:rule,requestId:'edit-rule'});
  store.command({type:'add_entity',name:'Shop',ownershipBps:10000});
  const entityId=store.state().entities.find(entity=>entity.kind==='business')!.id;
  store.command({type:'add_account',entityId,name:'Shop cash',accountType:'cash',openingBalanceCents:0,openingDate:'2026-01-01'});
  const businessAccount=store.state().accounts.find(account=>account.entityId===entityId)!.id;
  const before=store.state();
  assert.throws(()=>store.command({type:'save_category_rule',rule,expected:rule,requestId:'stale-edit'}),/changed or was removed/);
  assert.throws(()=>store.command({type:'delete_category_rule',id:rule.id,expected:rule,requestId:'stale-delete'}),/changed or was removed/);
  assert.throws(()=>store.command({type:'save_category_rule',rule,expected:null,requestId:'duplicate'}),/already exists/);
  assert.throws(()=>store.command({type:'save_category_rule',rule:{...updated,entityId},expected:updated,requestId:'move-owner'}),/cannot move/);
  assert.throws(()=>store.command({type:'save_category_rule',rule:{...updated,accountId:businessAccount},expected:updated,requestId:'cross-owner'}),/belonging/);
  assert.throws(()=>store.command({type:'save_category_rule',rule:updated,expected:rule,requestId:'create-rule'}),/request ID was already used/);
  assert.deepEqual(store.state(),before);
});

test('saved rules override built-ins for new expenses and conflicting rules leave a reviewable record',t=>{
  const {store,accountId}=setup(t);
  const add=(requestId:string,category='Uncategorized')=>store.command({type:'add_transaction',kind:'expense',accountId,amountCents:1000,date:'2026-09-01',description:'PETRO-CANADA TORONTO',category,requestId});
  add('before-rule');
  store.command({type:'save_category_rule',rule,expected:null,requestId:'create-rule'});
  add('new-expense');
  add('manual-category','Other');
  const conflict={...rule,id:'other-rule',category:'Food'};
  store.command({type:'save_category_rule',rule:conflict,expected:null,requestId:'conflict-rule'});
  add('conflicting-expense');
  const expenses=store.state().transactions.filter(row=>row.kind==='expense');
  assert.deepEqual(expenses.map(row=>row.category).sort(),['Fuel & convenience','Other','Transport','Uncategorized'].sort());
  assert.equal(store.state().accounts.find(account=>account.id===accountId)!.balanceCents,96000);
  assert.ok(expenses.every(row=>row.description==='PETRO-CANADA TORONTO'));
});

test('bulk preview application supports stale-write rejection and undo without changing source evidence',t=>{
  const {store,accountId}=setup(t);
  store.command({type:'import_rows',accountId,rows:[{date:'2026-09-01',description:'PETRO-CANADA TORONTO',amountCents:-1200,category:'Other'}],requestId:'import'});
  const before=store.state();
  const changes=previewCategoryRule(rule,before.transactions,before.accounts).map(row=>row.change);
  assert.equal(changes.length,1);
  store.command({type:'categorize_transactions',changes,expectedRevision:before.revision,requestId:'apply'});
  const saved=store.state();
  const after=saved.transactions.find(row=>row.id===changes[0].id)!;
  const original=before.transactions.find(row=>row.id===changes[0].id)!;
  assert.deepEqual(after,{...original,category:rule.category,expenseCategory:rule.category});
  assert.deepEqual(saved.accounts,before.accounts);
  assert.throws(()=>store.command({type:'categorize_transactions',changes,expectedRevision:saved.revision,requestId:'stale'}),/category changed/);
  store.command({type:'categorize_transactions',changes:reverseCategoryChanges(changes),expectedRevision:saved.revision,requestId:'undo'});
  assert.deepEqual(store.state().transactions,before.transactions);
  assert.deepEqual(store.state().accounts,before.accounts);
});

test('imported uncategorized expenses retain their raw source when a rule fills the category',t=>{
  const {store,accountId}=setup(t);
  store.command({type:'save_category_rule',rule,expected:null,requestId:'create-rule'});
  const rows=[{date:'2026-09-01',description:'  PETRO-CANADA TORONTO ',amountCents:-1200}];
  store.command({type:'import_rows',accountId,rows,requestId:'import'});
  const saved=store.state();
  store.command({type:'import_rows',accountId,rows,requestId:'import'});
  assert.deepEqual(store.state(),saved);
  const imported=saved.transactions.find(row=>row.kind==='expense')!;
  assert.equal(imported.description,'PETRO-CANADA TORONTO');
  assert.equal(imported.category,rule.category);
  assert.ok(imported.source.length>0);
  assert.equal(saved.accounts.find(account=>account.id===accountId)!.balanceCents,98800);
});

test('built-in categories fill CSV imports while explicit and unknown categories stay unchanged',t=>{
  const {store,accountId}=setup(t);
  const command:Command={type:'import_rows',accountId,rows:[
    {date:'2026-09-01',description:'PITA & HUMMUS TORONTO',amountCents:-1200},
    {date:'2026-09-01',description:'Jabal Coffee Ho   _M',amountCents:-300,category:'Social'},
    {date:'2026-09-01',description:'METRO 854',amountCents:-500},
  ],requestId:'builtin-csv'};
  const saved=store.command(command);
  assert.deepEqual(store.command(command),saved);
  const expenses=saved.transactions.filter(row=>row.kind==='expense').sort((a,b)=>a.description.localeCompare(b.description));
  assert.deepEqual(expenses.map(row=>[row.description,row.category,row.expenseCategory]),[
    ['Jabal Coffee Ho   _M','Social',undefined],
    ['METRO 854','Uncategorized',undefined],
    ['PITA & HUMMUS TORONTO','Food','Food'],
  ]);
  assert.equal(saved.accounts.find(account=>account.id===accountId)!.balanceCents,98000);
});

test('staged imports apply built-ins after saved rules and preserve source rows, refunds and conflicts',t=>{
  const {store,accountId}=setup(t);
  const mealRule={...rule,id:'meals',merchant:'TIM HORTONS',category:'Work meals'};
  for(const savedRule of [mealRule,{...rule,merchant:'ESSO'},{...rule,id:'conflict',merchant:'ESSO',category:'Food'}]) {
    store.command({type:'save_category_rule',rule:savedRule,expected:null,requestId:`rule-${savedRule.id}`});
  }
  const source:StatementSource={id:'january',accountId,sourceFile:'Bank.pdf',sha256:'a'.repeat(64),periodStart:'2026-01-01',periodEnd:'2026-01-31',openingBalanceCents:100000,closingBalanceCents:96700,rows:[
    {id:'food',transactionDate:'2026-01-10',postingDate:'2026-01-11',description:'  PITA & HUMMUS TORONTO ',amountCents:-1200,sourcePage:1},
    {id:'refund',transactionDate:'2026-01-10',postingDate:'2026-01-11',description:'Jabal Coffee Ho   _M',amountCents:200,sourcePage:1},
    {id:'saved-rule',transactionDate:'2026-01-10',postingDate:'2026-01-11',description:'TIM HORTONS',amountCents:-300,sourcePage:1},
    {id:'conflict',transactionDate:'2026-01-10',postingDate:'2026-01-11',description:'ESSO',amountCents:-500,sourcePage:1},
    {id:'explicit',transactionDate:'2026-01-10',postingDate:'2026-01-11',description:'STARBUCKS',amountCents:-700,sourcePage:1},
    {id:'unknown',transactionDate:'2026-01-10',postingDate:'2026-01-11',description:'METRO 854',amountCents:-800,sourcePage:1},
  ]};
  const original=structuredClone(source);
  const before=store.state();
  store.command({type:'stage_statement',statement:source,requestId:'stage'});
  const reviewed=store.command({type:'review_statement',importId:source.id,decisions:source.rows.map(row=>({rowId:row.id,kind:row.id==='refund'?'refund':'expense',category:row.id==='explicit'?'Social':'Uncategorized'})),requestId:'review',expectedRevision:store.state().revision});
  assert.deepEqual(reviewed.accounts,before.accounts);
  assert.deepEqual(reviewed.transactions,before.transactions);
  assert.equal(reviewed.importBatches![0].decisions[0].category,'Uncategorized');
  const command:Command={type:'commit_statements',importIds:[source.id],requestId:'commit',expectedRevision:reviewed.revision};
  const saved=store.command(command);
  assert.deepEqual(store.command(command),saved);
  assert.deepEqual(source,original);
  assert.deepEqual(saved.importBatches![0].source,original);
  assert.deepEqual(saved.importBatches![0].decisions.map(row=>row.category),['Food','Food','Work meals','Uncategorized','Social','Uncategorized']);
  const expected=['Food','Food','Work meals','Uncategorized','Social','Uncategorized'];
  for(const [index,row] of source.rows.entries()) {
    const transaction=saved.transactions.find(transaction=>transaction.importSources?.some(ref=>ref.importId===source.id&&ref.rowId===row.id))!;
    assert.equal(transaction.description,row.description);
    assert.equal(transaction.category,expected[index]);
    assert.equal(transaction.expenseCategory,index<3?expected[index]:undefined);
    assert.equal(transaction.amountCents,-row.amountCents);
    assert.deepEqual(transaction.importSources,[{importId:source.id,rowId:row.id}]);
  }
  assert.equal(saved.accounts.find(account=>account.id===accountId)!.balanceCents,96700);
});

test('planned payments keep their reporting category before automatic merchant rules run',t=>{
  const {store,accountId}=setup(t);
  store.command({type:'save_category_rule',rule,expected:null,requestId:'create-rule'});
  store.command({type:'add_obligation',entityId:'personal',name:'PETRO-CANADA TORONTO',amountCents:1000,dueDate:'2026-09-01',direction:'out',recurrence:'monthly',accountId,category:'Uncategorized'});
  const obligation=store.state().obligations[0];
  store.command({type:'pay_obligation',id:obligation.id,expectedDueDate:obligation.dueDate,requestId:'planned-payment'});
  const payment=store.state().transactions.find(row=>row.kind==='expense')!;
  assert.equal(payment.category,'Uncategorized');
  assert.equal(payment.expenseCategory,'Bills');
  assert.equal(store.state().accounts.find(account=>account.id===accountId)!.balanceCents,99000);
});
