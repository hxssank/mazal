import test from 'node:test';
import assert from 'node:assert/strict';
import { autoCategorizeTransaction, categoryRuleMatches, previewCategoryRule, resolveCategoryRules, validateCategoryRule, validateCategoryRules } from './category-rules.ts';
import type { CategoryRule } from './category-rules.ts';
import type { Transaction } from './types.ts';

const context={entities:[{id:'personal'},{id:'shop'}],accounts:[{id:'card',entityId:'personal',type:'debt'},{id:'cash',entityId:'personal',type:'cash'},{id:'business',entityId:'shop',type:'cash'}]};
const rule:CategoryRule={id:'fuel',entityId:'personal',accountId:null,match:'contains',merchant:'PETRO-CANADA',category:'Fuel & convenience',enabled:true};
const row:Transaction={id:'tx',date:'2026-09-01',description:'PETRO-CANADA 123 TORONTO',kind:'expense',amountCents:1234,accountId:'card',toAccountId:null,category:'Uncategorized',source:'Statement original.csv',createdAt:'2026-09-01T12:00:00.000Z',statementId:'statement',statementRowId:'source-row',importSources:[{importId:'source',rowId:'original'}]};

test('merchant matches normalize case and spacing while enforcing owner and account',()=>{
  assert.equal(categoryRuleMatches(rule,{...row,description:'  petro-canada   123  TORONTO '},context.accounts),true);
  assert.equal(categoryRuleMatches({...rule,match:'exact'},row,context.accounts),false);
  assert.equal(categoryRuleMatches({...rule,match:'exact',merchant:' petro-canada  123 TORONTO'},row,context.accounts),true);
  assert.equal(categoryRuleMatches(rule,{...row,accountId:'business'},context.accounts),false);
  assert.equal(categoryRuleMatches({...rule,accountId:'cash'},row,context.accounts),false);
  assert.equal(categoryRuleMatches(rule,{...row,kind:'transfer'},context.accounts),false);
  assert.equal(categoryRuleMatches({...rule,merchant:''},row,context.accounts),false);
});

test('automatic rules change only uncategorized expenses and preserve source evidence',()=>{
  const before=structuredClone(row);
  const result=autoCategorizeTransaction([rule],row,context.accounts);
  assert.deepEqual(result,{...row,category:'Fuel & convenience',expenseCategory:'Fuel & convenience'});
  assert.deepEqual(row,before);
  for(const changed of [{...row,category:'Other'},{...row,expenseCategory:'Bills'},{...row,kind:'income' as const}]) assert.equal(autoCategorizeTransaction([rule],changed,context.accounts),changed);
  for(const [rules,transaction] of [[[{...rule,enabled:false}],row],[[rule],{...row,accountId:'business'}]] as const) {
    assert.deepEqual(autoCategorizeTransaction([...rules],transaction,context.accounts),{...transaction,category:'Transport',expenseCategory:'Transport'});
  }
});

test('built-in merchant categories fill only uncategorized expenses without mutating the input',()=>{
  const food={...row,description:'PITA & HUMMUS TORONTO'};
  const before=structuredClone(food);
  assert.deepEqual(autoCategorizeTransaction([],food,context.accounts),{...food,category:'Food',expenseCategory:'Food'});
  assert.deepEqual(food,before);
  const refund={...food,description:'Jabal Coffee Ho   _M',amountCents:-200};
  assert.deepEqual(autoCategorizeTransaction([],refund,context.accounts),{...refund,category:'Food',expenseCategory:'Food'});
  for(const unchanged of [{...food,category:'Social'},{...food,expenseCategory:'Bills'},{...food,kind:'income' as const},{...food,kind:'transfer' as const},{...food,description:'METRO 854'},{...food,description:'Unknown merchant'}]) {
    assert.equal(autoCategorizeTransaction([],unchanged,context.accounts),unchanged);
  }
});

test('conflicting categories leave expenses uncategorized and same-category overlaps agree',()=>{
  const other={...rule,id:'other',match:'exact' as const,merchant:row.description,category:'Food'};
  assert.equal(resolveCategoryRules([rule,other],row,context.accounts).kind,'conflict');
  assert.equal(autoCategorizeTransaction([rule,other],row,context.accounts),row);
  assert.equal(resolveCategoryRules([rule,{...other,category:'fuel & convenience'}],row,context.accounts).kind,'match');
  const preview=previewCategoryRule(rule,[row],context.accounts,[other]);
  assert.deepEqual(preview[0].conflictCategories,['Food','Fuel & convenience']);
});

test('preview keeps stale-write snapshots and does not overwrite original transaction data',()=>{
  const existing={...row,category:'Other',expenseCategory:'Bills'};
  const preview=previewCategoryRule(rule,[existing,{...existing,id:'owned-by-business',accountId:'business'}],context.accounts);
  assert.equal(preview.length,1);
  assert.deepEqual(preview[0].change,{id:'tx',expectedCategory:'Other',expectedExpenseCategory:'Bills',category:'Fuel & convenience',expenseCategory:'Fuel & convenience'});
  existing.category='Digital';
  assert.equal(preview[0].transaction.category,'Other');
  assert.equal(preview[0].change.expectedCategory,'Other');
  assert.equal(previewCategoryRule(rule,[{...row,category:rule.category}],context.accounts).length,0);
});

test('rule previews skip reversed expenses while retaining replacements and refunds',()=>{
  const transactions=[row,{...row,id:'reversal',amountCents:-row.amountCents,reversalOf:row.id},{...row,id:'replacement',replacesId:row.id},{...row,id:'refund',amountCents:-200,refundOf:'replacement'}];
  assert.deepEqual(previewCategoryRule(rule,transactions,context.accounts).map(item=>item.change.id),['replacement','refund']);
});

test('rule validation rejects missing ownership, unsafe accounts and malformed fields',()=>{
  assert.deepEqual(validateCategoryRule(rule,context),rule);
  for(const bad of [{...rule,entityId:'missing'},{...rule,accountId:'business'},{...rule,accountId:'missing'},{...rule,accountId:undefined},{...rule,match:'regex'},{...rule,enabled:'true'},{...rule,merchant:' '},{...rule,category:'Uncategorized'}]) assert.throws(()=>validateCategoryRule(bad,context));
  assert.throws(()=>validateCategoryRules([rule,rule],context),/Duplicate/);
  assert.throws(()=>validateCategoryRules(Array.from({length:1001},(_,i)=>({...rule,id:String(i)})),context),/at most/);
});
