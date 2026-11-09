import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { deferTestCleanup, trackTestResource, closeTestResource } from './test-cleanup.ts';
import type { Command, StatementImport, StatementSource } from '../shared/types.ts';
import { summarizeSolHistory } from '../shared/sol-history.ts';

function setup(t:{after:(cleanup:()=>void)=>void},accountType:'cash'|'debt') {
  const directory=mkdtempSync(join(tmpdir(),'mazal-quality-ledger-'));
  deferTestCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const path=join(directory,'test.sqlite');
  const store=trackTestResource(t, createStore(path,'live'));
  const accountId=store.command({type:'add_account',entityId:'personal',name:'Statement account',accountType,openingBalanceCents:10000,openingDate:'2026-01-01'}).accounts[0].id;
  store.command({type:'save_category_rule',rule:{id:'fuel',entityId:'personal',accountId:null,match:'contains',merchant:'PETRO',category:'Fuel & convenience',enabled:true},expected:null,requestId:'rule'});
  return {store,path,accountId};
}

test('merchant rules fill staged statement categories without changing source facts or posting twice',t=>{
  const {store,path,accountId}=setup(t,'cash');
  const source:StatementSource={id:'january',accountId,sourceFile:'Bank.pdf',sha256:'a'.repeat(64),periodStart:'2026-01-01',periodEnd:'2026-01-31',openingBalanceCents:10000,closingBalanceCents:7500,rows:[
    {id:'fuel',transactionDate:'2026-01-02',postingDate:'2026-01-03',description:'  PETRO-CANADA  TORONTO ',amountCents:-2000,sourcePage:1},
    {id:'manual',transactionDate:'2026-01-02',postingDate:'2026-01-03',description:'PETRO-CANADA SHOP',amountCents:-500,sourcePage:1},
  ]};
  store.command({type:'stage_statement',statement:source,requestId:'stage'});
  store.command({type:'review_statement',importId:source.id,decisions:[{rowId:'fuel',kind:'expense',category:'Uncategorized'},{rowId:'manual',kind:'expense',category:'Food'}],requestId:'review',expectedRevision:store.state().revision});
  const command:Command={type:'commit_statements',importIds:[source.id],requestId:'commit',expectedRevision:store.state().revision};
  const saved=store.command(command);
  assert.deepEqual(store.command(command),saved);
  assert.equal(saved.accounts[0].balanceCents,7500);
  assert.deepEqual(saved.importBatches![0].source,source);
  assert.deepEqual(saved.importBatches![0].decisions.map(row=>row.category),['Fuel & convenience','Food']);
  const fuel=saved.transactions.find(row=>row.importSources?.some(ref=>ref.rowId==='fuel'))!;
  assert.equal(fuel.category,'Fuel & convenience');
  assert.equal(fuel.expenseCategory,'Fuel & convenience');
  assert.equal(fuel.description,source.rows[0].description);
  assert.deepEqual(fuel.importSources,[{importId:source.id,rowId:'fuel'}]);
  const backup=store.export();
  store.restore(backup);
  closeTestResource(store);
  const reopened=trackTestResource(t, createStore(path,'live'));
  assert.deepEqual(reopened.state().transactions,saved.transactions);
  assert.deepEqual(reopened.state().importBatches,saved.importBatches);
});

test('merchant rules fill legacy statement categories and preserve refund signs and source identity',t=>{
  const {store,accountId}=setup(t,'debt');
  const statement:StatementImport={id:'january',accountId,sourceFile:'Card.pdf',sha256:'b'.repeat(64),periodStart:'2026-01-01',periodEnd:'2026-01-31',openingBalanceCents:10000,closingBalanceCents:11500,rows:[
    {id:'fuel',transactionDate:'2026-01-02',postingDate:'2026-01-03',description:'PETRO-CANADA TORONTO',amountCents:2000,sourcePage:1,kind:'purchase',category:'Uncategorized'},
    {id:'refund',transactionDate:'2026-01-04',postingDate:'2026-01-05',description:'PETRO-CANADA REFUND',amountCents:-500,sourcePage:1,kind:'refund',category:'Uncategorized'},
  ]};
  const original=structuredClone(statement);
  const command:Command={type:'import_statement',statement,requestId:'import'};
  const saved=store.command(command);
  assert.deepEqual(statement,original);
  assert.deepEqual(store.command(command),saved);
  assert.equal(saved.accounts[0].balanceCents,11500);
  assert.equal(saved.statements![0].sha256,original.sha256);
  assert.deepEqual(saved.statements![0].rows,original.rows.map(row=>({...row,category:'Fuel & convenience'})));
  const expenses=saved.transactions.filter(row=>row.kind==='expense');
  assert.equal(expenses.length,2);
  assert.equal(expenses.reduce((sum,row)=>sum+row.amountCents,0),1500);
  assert.ok(expenses.every(row=>row.category==='Fuel & convenience'&&row.statementId===statement.id));
  store.restore(store.export());
  assert.deepEqual(store.state().transactions,saved.transactions);
  const retried=store.command({...command,requestId:'import-again'});
  assert.deepEqual(retried.transactions,saved.transactions);
  assert.deepEqual(retried.accounts,saved.accounts);
});

test('restored SOL history cannot relabel price gains as corrections while retaining the original journal',t=>{
  const {store}=setup(t,'cash');
  const accountId=store.command({type:'add_account',entityId:'personal',name:'SOL',accountType:'investment',openingBalanceCents:0,openingDate:'2026-01-01'}).accounts.find(account=>account.name==='SOL')!.id;
  const initial:Extract<Command,{type:'save_sol'}>={type:'save_sol',accountId,liquidSol:'1',stakedSol:'0',costBasisCents:10000,priceCents:10000,priceDate:'2026-01-01',requestId:'initial'};
  store.command(initial);
  store.command({...initial,priceCents:20000,priceDate:'2026-01-02',requestId:'quote'});
  const valid=store.export();
  const before=store.state();
  assert.equal(summarizeSolHistory(before.positions[0]).resultCents,10000);
  const changed=structuredClone(valid);
  changed.data.positions[0].history![1].kind='correction';
  assert.throws(()=>store.restore(changed),/invalid journal reference for its activity kind/);
  assert.deepEqual(store.state(),before);
  store.restore(valid);
  assert.equal(summarizeSolHistory(store.state().positions[0]).resultCents,10000);
  const legacy=store.export();
  delete legacy.data.positions[0].history;
  store.restore(legacy);
  assert.equal(store.state().positions[0].history,undefined);
});
