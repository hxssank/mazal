import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { canMatchStatementTransaction, previewStatementBatches } from '../shared/statement-imports.ts';
import type { Command, StatementDecision, StatementSource } from '../shared/types.ts';

function setup(t:{after:(fn:()=>void)=>void}) {
  const directory = mkdtempSync(join(tmpdir(),'mazal-statement-match-'));
  const path = join(directory,'live.sqlite');
  const store = createStore(path,'live');
  t.after(()=>{ try { store.close(); } catch {} rmSync(directory,{recursive:true,force:true}); });
  const command = (input:Command) => store.command({...input,expectedRevision:store.state().revision});
  const account = command({type:'add_account',entityId:'personal',name:'Bank',accountType:'cash',openingBalanceCents:10000,openingDate:'2026-01-01'}).accounts[0].id;
  const source = (amounts:number[], changes:Partial<StatementSource> = {}):StatementSource => ({id:'january',accountId:account,sourceFile:'Synthetic January.pdf',sha256:'a'.repeat(64),periodStart:'2026-01-01',periodEnd:'2026-01-31',openingBalanceCents:10000,closingBalanceCents:10000+amounts.reduce((sum,amount)=>sum+amount,0),rows:amounts.map((amountCents,index)=>({id:`row${index}`,transactionDate:'2026-01-10',postingDate:'2026-01-12',description:`  BANK ORIGINAL ${index}  `,amountCents,sourcePage:1})),...changes});
  const stage = (statement:StatementSource, decisions:StatementDecision[]) => {
    command({type:'stage_statement',statement,requestId:'stage'});
    command({type:'review_statement',importId:statement.id,decisions,requestId:'review'});
  };
  return {store,path,command,account,source,stage};
}

for (const kind of ['expense','income'] as const) test(`matching a manual ${kind} preserves its identity and links without posting twice`, t => {
  const {store,path,command,account,source,stage} = setup(t);
  command({type:'add_transaction',kind,accountId:account,amountCents:1000,date:'2026-01-10',description:'My original description',category:kind === 'expense' ? 'Food' : 'Salary',requestId:'manual',...(kind === 'income' ? {paydayDate:'2026-01-10'} : {})});
  const original = store.state().transactions.find(tx=>tx.source === 'Manual entry')!;
  const statement = source([kind === 'expense' ? -1000 : 1000]);
  stage(statement,[{rowId:'row0',kind,category:original.category,match:{transactionId:original.id}}]);
  assert.equal(previewStatementBatches(store.state(),['january']).ready,true);
  const before = store.export();
  const request:Command = {type:'commit_statements',importIds:['january'],requestId:'commit',expectedRevision:store.state().revision};
  const committed = store.command(request);
  assert.equal(committed.accounts[0].balanceCents,statement.closingBalanceCents);
  const linked = committed.transactions.find(tx=>tx.id === original.id)!;
  for (const key of ['date','description','category','amountCents','source','createdAt','paydayDate'] as const) assert.equal(linked[key],original[key]);
  assert.equal(linked.postingDate,'2026-01-12');
  assert.equal(linked.balanceDates?.[account],'2026-01-12');
  assert.deepEqual(linked.importSources,[{importId:'january',rowId:'row0'}]);
  assert.deepEqual(committed.importBatches![0].source,statement);
  assert.deepEqual(store.export().data.entries.filter(entry=>entry.transactionId === original.id),before.data.entries.filter(entry=>entry.transactionId === original.id));
  assert.equal(committed.transactions.filter(tx=>tx.kind === kind).length,1);
  assert.deepEqual(store.command(request),store.state());
  store.restore(store.export());
  store.close();
  const reopened = createStore(path,'live');
  try { assert.equal(reopened.state().transactions.find(tx=>tx.id === original.id)?.description,original.description); }
  finally { reopened.close(); }
});

for (const legacy of [false,true]) test(`${legacy ? 'Legacy' : 'Current'} bill payments link to bank evidence without advancing or paying the bill again`,t=>{
  const {store,command,account,source,stage} = setup(t);
  command({type:'add_obligation',entityId:'personal',name:'Phone',accountId:account,amountCents:1000,dueDate:'2026-01-10',direction:'out',recurrence:'monthly',category:'Bills',requestId:'bill'});
  const bill = store.state().obligations[0];
  command({type:'pay_obligation',id:bill.id,expectedDueDate:bill.dueDate,date:'2026-01-10',requestId:'pay'});
  if (legacy) {
    const backup = store.export();
    backup.data.transactions.forEach(tx=>{delete tx.plannedPayment;});
    store.restore(backup);
  }
  const before = store.state();
  const payment = before.transactions.find(tx=>tx.source === `Planned payment ${bill.id}`)!;
  stage(source([-1000]),[{rowId:'row0',kind:'expense',category:payment.category,match:{transactionId:payment.id}}]);
  command({type:'commit_statements',importIds:['january'],requestId:'commit'});
  assert.equal(store.state().accounts[0].balanceCents,9000);
  assert.deepEqual(store.state().obligations,before.obligations);
  assert.deepEqual(store.state().transactions.find(tx=>tx.id === payment.id)?.plannedPayment,payment.plannedPayment);
  store.restore(store.export());
});

test('historical card charges and refunds link without changing a later confirmed balance',t=>{
  const {store,command,source,stage} = setup(t);
  const account = command({type:'add_account',entityId:'personal',name:'Card',accountType:'debt',openingBalanceCents:10000,openingDate:'2026-01-01'}).accounts.find(item=>item.name === 'Card')!.id;
  command({type:'add_transaction',kind:'expense',accountId:account,amountCents:1000,date:'2026-01-10',description:'Purchase',category:'Food',requestId:'charge'});
  const charge = store.state().transactions.find(tx=>tx.kind === 'expense')!;
  command({type:'record_refund',id:charge.id,accountId:account,amountCents:200,date:'2026-01-10',reason:'Returned item',requestId:'refund'});
  const refund = store.state().transactions.find(tx=>tx.refundOf)!;
  command({type:'reconcile',accountId:account,balanceCents:5000,date:'2026-02-10',note:'Later bank balance',requestId:'confirm'});
  const confirmed = store.state().accounts.find(item=>item.id === account)!;
  stage(source([1000,-200],{accountId:account}),[{rowId:'row0',kind:'expense',category:'Food',match:{transactionId:charge.id}},{rowId:'row1',kind:'refund',category:'Food',match:{transactionId:refund.id}}]);
  assert.equal(previewStatementBatches(store.state(),['january']).ready,true);
  const state = command({type:'commit_statements',importIds:['january'],requestId:'commit'});
  assert.deepEqual(state.accounts.find(item=>item.id === account),confirmed);
  assert.equal(state.transactions.filter(tx=>tx.kind === 'expense').length,2);
  assert.equal(state.transactions.filter(tx=>(tx.balanceDates?.[account] ?? tx.postingDate ?? tx.date) <= '2026-01-31').reduce((sum,tx)=>sum+(tx.balanceChanges?.[account] ?? 0),0),10800);
  const linked = state.transactions.find(tx=>tx.id === charge.id)!;
  assert.equal(canMatchStatementTransaction(state,state.importBatches![0],state.importBatches![0].source.rows[0],'expense',linked),false);
  store.restore(store.export());
});

test('preview identifies unmatched manual activity before commit and a neutral reversal pair permits import',t=>{
  const {store,command,account,source,stage} = setup(t);
  command({type:'add_transaction',kind:'expense',accountId:account,amountCents:1000,date:'2026-01-10',description:'Manual expense',category:'Food',requestId:'manual'});
  const original = store.state().transactions.find(tx=>tx.kind === 'expense')!;
  stage(source([-1000]),[{rowId:'row0',kind:'expense',category:'Food'}]);
  const preview = previewStatementBatches(store.state(),['january']);
  assert.equal(preview.ready,false);
  assert.match(preview.issues.join(' '),/Unmatched: Manual expense/);
  assert.throws(()=>command({type:'commit_statements',importIds:['january'],requestId:'rejected'}),/Unmatched: Manual expense/);
  command({type:'correct_transaction',id:original.id,reason:'Replace manual entry with bank evidence',requestId:'reverse'});
  assert.equal(previewStatementBatches(store.state(),['january']).ready,true);
  const state = command({type:'commit_statements',importIds:['january'],requestId:'commit'});
  assert.equal(state.accounts[0].balanceCents,9000);
  assert.equal(state.transactions.filter(tx=>tx.kind === 'expense').reduce((sum,tx)=>sum+tx.amountCents,0),1000);
  assert.ok(state.transactions.some(tx=>tx.reversalOf === original.id));
  store.restore(store.export());
});

test('a corrected replacement and manual refund retain their correction links after matching',t=>{
  const {store,command,account,source,stage} = setup(t);
  command({type:'add_transaction',kind:'expense',accountId:account,amountCents:2000,date:'2026-01-10',description:'Original',category:'Food',requestId:'manual'});
  const original = store.state().transactions.find(tx=>tx.kind === 'expense')!;
  command({type:'correct_transaction',id:original.id,reason:'Correct receipt',replacement:{kind:'expense',accountId:account,amountCents:1000,date:'2026-01-10',description:'Corrected',category:'Food'},requestId:'correction'});
  const replacement = store.state().transactions.find(tx=>tx.replacesId)!;
  command({type:'record_refund',id:replacement.id,accountId:account,amountCents:200,date:'2026-01-10',reason:'Returned item',requestId:'refund'});
  const refund = store.state().transactions.find(tx=>tx.refundOf)!;
  stage(source([-1000,200]),[{rowId:'row0',kind:'expense',category:'Food',match:{transactionId:replacement.id}},{rowId:'row1',kind:'refund',category:'Food',match:{transactionId:refund.id}}]);
  assert.equal(previewStatementBatches(store.state(),['january']).ready,true);
  command({type:'commit_statements',importIds:['january'],requestId:'commit'});
  assert.equal(store.state().accounts[0].balanceCents,9200);
  assert.equal(store.state().transactions.find(tx=>tx.id === replacement.id)?.replacesId,original.id);
  assert.equal(store.state().transactions.find(tx=>tx.id === refund.id)?.refundOf,replacement.id);
  const backup = store.export();
  store.restore(backup);
  const broken = structuredClone(backup);
  broken.data.importBatches![0].decisions[0].match = {transactionId:refund.id};
  assert.throws(()=>store.restore(broken),/eligible recorded/);
});

test('matching rejects reversed entries, wrong accounts, amounts, dates, kinds, categories and duplicate matches',t=>{
  const {store,command,account,source,stage} = setup(t);
  command({type:'add_transaction',kind:'expense',accountId:account,amountCents:1000,date:'2026-01-10',description:'Manual',category:'Food',requestId:'manual'});
  const original = store.state().transactions.find(tx=>tx.kind === 'expense')!;
  const statement = source([-1000,-1000]);
  stage(statement,[{rowId:'row0',kind:'expense',category:'Food',match:{transactionId:original.id}},{rowId:'row1',kind:'expense',category:'Food',match:{transactionId:original.id}}]);
  assert.match(previewStatementBatches(store.state(),['january']).issues.join(' '),/two rows cannot match/);
  const state = store.state(), batch = state.importBatches![0], row = statement.rows[0];
  for (const change of [{accountId:'other'},{amountCents:999},{date:'2026-01-01'},{kind:'income' as const},{source:'Some other import'}]) assert.equal(canMatchStatementTransaction(state,batch,row,'expense',{...original,...change}),false);
  command({type:'review_statement',importId:'january',decisions:[{rowId:'row0',kind:'expense',category:'Other',match:{transactionId:original.id}},{rowId:'row1',kind:'expense',category:'Food'}],requestId:'wrong-category'});
  assert.match(previewStatementBatches(store.state(),['january']).issues.join(' '),/keep the matched transaction category/);
  command({type:'correct_transaction',id:original.id,reason:'Reverse',requestId:'reverse'});
  assert.equal(canMatchStatementTransaction(store.state(),batch,row,'expense',original),false);
  assert.match(previewStatementBatches(store.state(),['january']).issues.join(' '),/reversed/);
});

test('preview and commit agree about opening balances and activity after the statement',t=>{
  const {store,command,account,source,stage} = setup(t);
  stage(source([-1000],{openingBalanceCents:11000,closingBalanceCents:10000}),[{rowId:'row0',kind:'expense',category:'Food'}]);
  assert.match(previewStatementBatches(store.state(),['january']).issues.join(' '),/opening balance/);
  assert.throws(()=>command({type:'commit_statements',importIds:['january'],requestId:'bad-opening'}),/opening balance/);
  command({type:'add_transaction',kind:'income',accountId:account,amountCents:1000,date:'2026-02-10',description:'Later income',category:'Salary',requestId:'later'});
  assert.match(previewStatementBatches(store.state(),['january']).issues.join(' '),/later transactions/);
  assert.throws(()=>command({type:'commit_statements',importIds:['january'],requestId:'bad-later'}),/later transactions/);
});

test('matching a checked entry after a completed reconciliation requires reopening its checks',t=>{
  const {store,command,account,source,stage} = setup(t);
  command({type:'add_transaction',kind:'expense',accountId:account,amountCents:1000,date:'2026-01-10',description:'Manual expense',category:'Food',requestId:'manual'});
  const original = store.state().transactions.find(tx=>tx.kind === 'expense')!;
  const checked = store.state().transactions.map(tx=>tx.id);
  command({type:'save_reconciliation',accountId:account,date:'2026-01-10',balanceCents:9000,clearedTransactionIds:checked,finish:true,requestId:'checks'});
  stage(source([-1000]),[{rowId:'row0',kind:'expense',category:'Food',match:{transactionId:original.id}}]);
  const before = store.state();
  const preview = previewStatementBatches(before,['january']);
  assert.equal(preview.ready,false);
  assert.match(preview.issues.join(' '),/Manual expense.*2026-01-12.*2026-01-10.*Reopen/);
  assert.throws(()=>command({type:'commit_statements',importIds:['january'],requestId:'blocked'}),/Reopen the saved transaction checks/);
  assert.deepEqual(store.state(),before);
  command({type:'reopen_reconciliation',accountId:account,requestId:'reopen'});
  assert.equal(previewStatementBatches(store.state(),['january']).ready,true);
  const saved = command({type:'commit_statements',importIds:['january'],requestId:'commit'});
  assert.equal(saved.accounts[0].balanceCents,9000);
  assert.deepEqual(new Set(saved.accounts[0].clearedTransactionIds),new Set(checked));
  assert.equal(saved.transactions.filter(tx=>tx.kind === 'expense').length,1);
  assert.equal(saved.transactions.find(tx=>tx.id === original.id)?.balanceDates?.[account],'2026-01-12');
  store.restore(store.export());
});

for (const observed of [false,true]) test(`matching within completed checks uses the ${observed ? 'observed balance' : 'posting'} date`,t=>{
  const {store,command,account,source,stage} = setup(t);
  command({type:'add_transaction',kind:'expense',accountId:account,amountCents:1000,date:'2026-01-10',description:'Manual expense',category:'Food',requestId:'manual'});
  const original = store.state().transactions.find(tx=>tx.kind === 'expense')!;
  const date = observed ? '2026-01-10' : '2026-01-12';
  command({type:'save_reconciliation',accountId:account,date,balanceCents:9000,clearedTransactionIds:store.state().transactions.map(tx=>tx.id),finish:true,requestId:'checks'});
  const reconciliation = store.state().accounts[0].reconciliation;
  stage(source([-1000],observed ? {sourceKind:'bank_activity',observedOn:date,periodEnd:date} : {}),[{rowId:'row0',kind:'expense',category:'Food',match:{transactionId:original.id}}]);
  assert.equal(previewStatementBatches(store.state(),['january']).ready,true);
  const saved = command({type:'commit_statements',importIds:['january'],requestId:'commit'});
  assert.deepEqual(saved.accounts[0].reconciliation,reconciliation);
  assert.equal(saved.transactions.find(tx=>tx.id === original.id)?.balanceDates?.[account],date);
  store.restore(store.export());
});
