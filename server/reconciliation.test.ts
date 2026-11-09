import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from './store.ts';
import type { Command } from '../shared/types.ts';
import { clearedBalance, reconciliationRows } from '../shared/reconciliation.ts';

function setup(t:{after:(cleanup:()=>void)=>void}) {
  const directory=mkdtempSync(join(tmpdir(),'mazal-reconciliation-'));
  const path=join(directory,'live.sqlite');
  let store=createStore(path,'live');
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const add=(name:string,accountType:'cash'|'debt',openingBalanceCents:number)=>store.command({type:'add_account',entityId:'personal',name,accountType,openingBalanceCents,openingDate:'2026-01-01'}).accounts.find(account=>account.name===name)!.id;
  return {get store(){return store;},add,restart:()=>{store.close();store=createStore(path,'live');}};
}
function save(store:ReturnType<typeof createStore>,accountId:string,clearedTransactionIds:string[],balanceCents:number,finish=true,date='2026-01-31',requestId=crypto.randomUUID()) {
  return store.command({type:'save_reconciliation',accountId,clearedTransactionIds,balanceCents,date,finish,requestId,expectedRevision:store.state().revision});
}

test('checking a statement does not post money and separates pending entries from the checked balance',t=>{
  const fixture=setup(t),store=fixture.store;
  const id=fixture.add('Cash','cash',100000);
  const opening=store.state().transactions[0].id;
  store.command({type:'add_transaction',kind:'expense',accountId:id,amountCents:2000,date:'2026-01-10',description:'Posted purchase',category:'Food',requestId:'posted'});
  const posted=store.state().transactions.find(row=>row.description==='Posted purchase')!.id;
  store.command({type:'add_transaction',kind:'expense',accountId:id,amountCents:3000,date:'2026-01-11',description:'Pending purchase',category:'Food',requestId:'pending'});
  const before=store.export();
  const state=save(store,id,[opening,posted],98000);
  assert.equal(state.accounts[0].balanceCents,95000);
  assert.equal(state.accounts[0].reconciliation?.balanceCents,98000);
  assert.deepEqual(store.export().data.entries,before.data.entries);
  assert.equal(state.transactions.length,3);
  assert.equal(clearedBalance(reconciliationRows(state,id,'2026-01-31'),state.accounts[0],new Set([opening,posted])),98000);
});

test('a mismatched balance cannot finish and a draft can be saved without inventing an adjustment',t=>{
  const {store,add}=setup(t),id=add('Cash','cash',100000),opening=store.state().transactions[0].id;
  const before=store.state();
  assert.throws(()=>save(store,id,[opening],99000),/must match/);
  assert.deepEqual(store.state(),before);
  const saved=save(store,id,[opening],99000,false);
  assert.equal(saved.accounts[0].reconciliation,undefined);
  assert.deepEqual(saved.accounts[0].clearedTransactionIds,[opening]);
  assert.equal(saved.transactions.length,1);
});

test('a transfer clears independently in each account and debt balances use positive amounts owed',t=>{
  const {store,add}=setup(t),cash=add('Cash','cash',100000),card=add('Card','debt',50000);
  store.command({type:'add_transaction',kind:'debt_payment',accountId:cash,toAccountId:card,amountCents:12000,date:'2026-01-10',description:'Card payment',category:'',requestId:'payment'});
  let state=store.state();
  const payment=state.transactions.find(row=>row.description==='Card payment')!;
  assert.equal(payment.balanceChanges?.[cash],-12000);
  assert.equal(payment.balanceChanges?.[card],-12000);
  const cashIds=reconciliationRows(state,cash,'2026-01-31').map(row=>row.id);
  state=save(store,cash,cashIds,88000);
  assert.equal(state.accounts.find(account=>account.id===card)!.reconciliation,undefined);
  const cardIds=reconciliationRows(state,card,'2026-01-31').map(row=>row.id);
  state=save(store,card,cardIds,38000);
  assert.equal(state.accounts.find(account=>account.id===card)!.reconciliation?.balanceCents,38000);
});

test('saved checks, locks, and signed corrections survive restart and restore',t=>{
  const fixture=setup(t),id=fixture.add('Cash','cash',100000);
  fixture.store.command({type:'reconcile',accountId:id,balanceCents:90000,date:'2026-01-20',note:'Confirmed missing opening amount',requestId:'adjust'});
  let state=fixture.store.state();
  assert.equal(state.transactions.find(row=>row.kind==='adjustment')!.balanceChanges?.[id],-10000);
  const ids=state.transactions.map(row=>row.id);
  save(fixture.store,id,ids,90000);
  const backup=fixture.store.export();
  assert.equal(backup.data.transactions[0].balanceChanges,undefined);
  fixture.restart();
  assert.equal(fixture.store.state().accounts[0].reconciliation?.balanceCents,90000);
  assert.throws(()=>save(fixture.store,id,[],0),/Reopen/);
  fixture.store.command({type:'reopen_reconciliation',accountId:id,expectedRevision:fixture.store.state().revision,requestId:'reopen'});
  state=fixture.store.state();
  assert.equal(state.accounts[0].reconciliation,undefined);
  assert.deepEqual(state.accounts[0].clearedTransactionIds,[...ids].sort());
  state=fixture.store.restore(backup,state.revision);
  assert.equal(state.accounts[0].reconciliation?.balanceCents,90000);
  const bad=structuredClone(backup);
  bad.data.accounts[0].reconciliation!.balanceCents=91000;
  assert.throws(()=>fixture.store.restore(bad,state.revision),/do not match/);
});

test('reconciliation rejects missing, duplicate, foreign, and future references without changing records',t=>{
  const {store,add}=setup(t),cash=add('Cash','cash',1000),other=add('Other','cash',3000);
  const cashId=store.state().transactions.find(row=>row.accountId===cash)!.id;
  const otherId=store.state().transactions.find(row=>row.accountId===other)!.id;
  const before=store.state();
  assert.throws(()=>save(store,cash,['missing'],1000),/does not belong/);
  assert.throws(()=>save(store,cash,[cashId,cashId],1000),/distinct/);
  assert.throws(()=>save(store,cash,[otherId],3000),/does not belong/);
  assert.throws(()=>save(store,cash,[cashId],1000,true,'2199-01-01'),/future/);
  assert.throws(()=>save(store,cash,[cashId],1000,true,'2026-02-30'),/valid statement date/);
  assert.deepEqual(store.state(),before);
});

test('reconciliation requires revision and retry identity, rejects stale updates, and replays once',t=>{
  const {store,add}=setup(t),id=add('Cash','cash',1000);
  const command:Extract<Command,{type:'save_reconciliation'}>={type:'save_reconciliation',accountId:id,date:'2026-01-31',balanceCents:1000,clearedTransactionIds:store.state().transactions.map(row=>row.id),finish:true,requestId:'check',expectedRevision:store.state().revision};
  assert.throws(()=>store.command({...command,requestId:undefined} as unknown as Command),/request ID/i);
  assert.throws(()=>store.command({...command,expectedRevision:undefined}),/Refresh/);
  const state=store.command(command);
  assert.deepEqual(store.command(command),state);
  assert.throws(()=>store.command({...command,requestId:'stale'}),/changed/);
});

test('finishing an earlier statement preserves checks for later pending activity',t=>{
  const {store,add}=setup(t),id=add('Cash','cash',1000);
  store.command({type:'add_transaction',kind:'income',accountId:id,amountCents:2000,date:'2026-02-01',description:'Later income',category:'Pay',requestId:'income'});
  const ids=store.state().transactions.map(row=>row.id);
  const state=save(store,id,ids,1000);
  assert.equal(state.accounts[0].clearedTransactionIds?.length,2);
  assert.equal(state.accounts[0].reconciliation?.transactionIds.length,1);
});
