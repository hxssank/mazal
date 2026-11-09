import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, RevisionConflictError } from './store.ts';
import { previewStatementBatches } from '../shared/statement-imports.ts';
import type { StatementDecision, StatementImport, StatementSource, StatementSourceRow } from '../shared/types.ts';

function setup(t:{after:(fn:()=>void)=>void}) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-staging-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive:true, force:true }); });
  const cash = store.command({type:'add_account',entityId:'personal',name:'Bank',accountType:'cash',openingBalanceCents:10000,openingDate:'2026-01-01'}).accounts[0].id;
  const card = store.command({type:'add_account',entityId:'personal',name:'Card',accountType:'debt',openingBalanceCents:5000,openingDate:'2026-01-01'}).accounts.find(a => a.name === 'Card')!.id;
  return {store,path,cash,card};
}
function row(id:string, amountCents:number, description = id, day='10'):StatementSourceRow { return {id,transactionDate:`2026-01-${day}`,postingDate:`2026-01-${day}`,description,amountCents,sourcePage:2}; }
function source(accountId:string, rows:StatementSourceRow[], changes:Partial<StatementSource>={}):StatementSource {
  return {id:'bank-january',accountId,sourceFile:'Bank January.pdf',sha256:'a'.repeat(64),periodStart:'2026-01-01',periodEnd:'2026-01-31',openingBalanceCents:10000,closingBalanceCents:10000+rows.reduce((sum,r)=>sum+r.amountCents,0),rows,...changes};
}
function review(store:ReturnType<typeof createStore>, statement:StatementSource, decisions:StatementDecision[]) {
  store.command({type:'stage_statement',statement,requestId:`stage-${statement.id}`});
  store.command({type:'review_statement',expectedRevision:store.state().revision,importId:statement.id,decisions,requestId:`review-${statement.id}`});
}

test('staging keeps exact source text and reconciliation gaps without changing balances, and survives reopen and restore', t => {
  const {store,path,cash} = setup(t);
  const before = store.state();
  const input = source(cash,[row('a',-2000,'  ORIGINAL SHOP  # 19  ')],{closingBalanceCents:7999});
  const staged = store.command({type:'stage_statement',statement:input,requestId:'stage'});
  assert.deepEqual(staged.accounts,before.accounts);
  assert.deepEqual(staged.transactions,before.transactions);
  assert.deepEqual(staged.importBatches![0].source,input);
  const preview = previewStatementBatches(staged,[input.id]);
  assert.equal(preview.ready,false);
  assert.equal(preview.unreviewedCount,1);
  assert.equal(preview.differences[0].differenceCents,1);
  assert.throws(()=>store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[input.id],requestId:'commit'}),/differs.*1 cents/);
  const backup=store.export();
  store.restore(backup);
  store.close();
  const reopened=createStore(path,'live');
  try { assert.deepEqual(reopened.state().importBatches![0].source,input); assert.deepEqual(reopened.state().accounts,before.accounts); }
  finally { reopened.close(); }
});

test('bank income, expenses and refunds reconcile; category edits leave original rows untouched', t => {
  const {store,cash}=setup(t);
  const input=source(cash,[row('pay',5000),row('shop',-2000,'  Original merchant   '),row('refund',200)]);
  review(store,input,[{rowId:'pay',kind:'income',category:'Salary'},{rowId:'shop',kind:'expense',category:'Shopping'},{rowId:'refund',kind:'refund',category:'Shopping'}]);
  const preview=previewStatementBatches(store.state(),[input.id]);
  assert.equal(preview.ready,true);
  const committed=store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[input.id],requestId:'commit'});
  assert.equal(committed.accounts.find(a=>a.id===cash)!.balanceCents,13200);
  assert.equal(committed.transactions.filter(tx=>tx.kind==='income').reduce((sum,tx)=>sum+tx.amountCents,0),5000);
  assert.equal(committed.transactions.filter(tx=>tx.kind==='expense').reduce((sum,tx)=>sum+tx.amountCents,0),1800);
  const expense=committed.transactions.find(tx=>tx.description==='  Original merchant   ')!;
  store.command({type:'categorize_transaction',id:expense.id,expectedCategory:'Shopping',category:'Groceries',requestId:'recategorize'});
  assert.deepEqual(store.state().importBatches![0].source,input);
  assert.equal(store.state().importBatches![0].decisions.find(d=>d.rowId==='shop')!.category,'Groceries');
  store.restore(store.export());
});

test('raw source identity makes retries idempotent and retains identical legitimate purchases', t => {
  const {store,cash}=setup(t);
  const first=source(cash,[row('page2-line1',-100,'Same shop'),row('page2-line2',-100,'Same shop')]);
  review(store,first,first.rows.map(r=>({rowId:r.id,kind:'expense',category:'Food'})));
  const cmd={type:'commit_statements',expectedRevision:store.state().revision,importIds:[first.id],requestId:'commit'} as const;
  const committed=store.command({...cmd,importIds:[...cmd.importIds]});
  assert.deepEqual(store.command({...cmd,importIds:[...cmd.importIds]}),committed);
  store.command({type:'stage_statement',statement:{...first,id:'renamed',sourceFile:'Renamed.pdf'},requestId:'retry-new-request'});
  assert.equal(store.state().importBatches!.length,1);
  assert.equal(store.state().transactions.filter(tx=>tx.description==='Same shop').length,2);
  const next=source(cash,[{...row('page2-line1',-100,'Same shop'),transactionDate:'2026-02-10',postingDate:'2026-02-10'}],{id:'february',sha256:'b'.repeat(64),periodStart:'2026-02-01',periodEnd:'2026-02-28',openingBalanceCents:9800,closingBalanceCents:9700});
  review(store,next,[{rowId:next.rows[0].id,kind:'expense',category:'Food'}]);
  store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[next.id],requestId:'commit-second'});
  assert.equal(store.state().transactions.filter(tx=>tx.description==='Same shop').length,3);
  const baseline=store.state();
  assert.throws(()=>store.command({type:'stage_statement',statement:{...first,rows:[{...first.rows[0],description:'Changed extraction'},first.rows[1]]},requestId:'changed-source'}),/different extracted rows/);
  assert.deepEqual(store.state(),baseline);
});

test('unmatched and nonreciprocal transfers stay staged, then bank and card post one matched payment', t => {
  const {store,cash,card}=setup(t);
  const bank=source(cash,[row('payment',-1000)]);
  const credit=source(card,[row('purchase',2000),row('received',-1000)],{id:'card-january',sha256:'b'.repeat(64),sourceFile:'Card January.pdf',openingBalanceCents:5000,closingBalanceCents:6000});
  review(store,bank,[{rowId:'payment',kind:'transfer',category:'Card payment'}]);
  const baseline=store.state();
  assert.throws(()=>store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[bank.id],requestId:'unmatched'}),/match this transfer/);
  assert.deepEqual(store.state(),baseline);
  review(store,credit,[{rowId:'purchase',kind:'expense',category:'Food'},{rowId:'received',kind:'transfer',category:'Card payment',match:{importId:bank.id,rowId:'payment'}}]);
  assert.throws(()=>store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[bank.id,credit.id],requestId:'nonreciprocal'}),/both rows must point/);
  store.command({type:'review_statement',expectedRevision:store.state().revision,importId:bank.id,decisions:[{rowId:'payment',kind:'transfer',category:'Card payment',match:{importId:credit.id,rowId:'received'}}],requestId:'bank-match'});
  const result=store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[bank.id,credit.id],requestId:'matched'});
  assert.equal(result.transactions.filter(tx=>tx.kind==='debt_payment').length,1);
  assert.equal(result.transactions.find(tx=>tx.kind==='debt_payment')!.importSources!.length,2);
  assert.equal(result.transactions.filter(tx=>tx.kind==='expense').reduce((sum,tx)=>sum+tx.amountCents,0),2000);
  assert.equal(result.accounts.find(a=>a.id===cash)!.balanceCents,9000);
  assert.equal(result.accounts.find(a=>a.id===card)!.balanceCents,6000);
  store.restore(store.export());
});

test('existing manually recorded transfer is linked without posting either account movement twice', t => {
  const {store,cash,card}=setup(t);
  const moved=store.command({type:'add_transaction',kind:'debt_payment',accountId:cash,toAccountId:card,amountCents:1000,date:'2026-01-10',description:'Manual payment',category:'Card payment',requestId:'manual'});
  const transfer=moved.transactions.find(tx=>tx.kind==='debt_payment')!;
  const bank=source(cash,[row('payment',-1000)]);
  review(store,bank,[{rowId:'payment',kind:'transfer',category:'Card payment',match:{transactionId:transfer.id}}]);
  const result=store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[bank.id],requestId:'link-manual'});
  assert.equal(result.transactions.filter(tx=>tx.source!=='Statement history correction').length,moved.transactions.length);
  assert.equal(result.accounts.find(a=>a.id===cash)!.balanceCents,9000);
  assert.equal(result.accounts.find(a=>a.id===card)!.balanceCents,4000);
  assert.equal(result.transactions.find(tx=>tx.id===transfer.id)!.importSources!.length,1);
  store.restore(store.export());
});

test('bank statement matches legacy card payment without duplicating debt movement or counting payment as expense', t => {
  const {store,cash,card}=setup(t);
  const legacy:StatementImport={...source(card,[row('payment',-1000)],{id:'old-card',sourceFile:'Old card.pdf',sha256:'b'.repeat(64),openingBalanceCents:5000,closingBalanceCents:4000}),rows:[{...row('payment',-1000),kind:'payment',category:'Card payment'}]};
  const before=store.command({type:'import_statement',statement:legacy,requestId:'legacy'});
  const payment=before.transactions.find(tx=>tx.statementRowId==='payment')!;
  const bank=source(cash,[row('bank-payment',-1000)]);
  review(store,bank,[{rowId:'bank-payment',kind:'transfer',category:'Card payment',match:{transactionId:payment.id}}]);
  const result=store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[bank.id],requestId:'match-legacy'});
  assert.equal(result.transactions.filter(tx=>tx.source!=='Statement history correction').length,before.transactions.length);
  assert.equal(result.transactions.find(tx=>tx.id===payment.id)!.kind,'debt_payment');
  assert.equal(result.accounts.find(a=>a.id===card)!.balanceCents,4000);
  assert.equal(result.accounts.find(a=>a.id===cash)!.balanceCents,9000);
  assert.equal(result.transactions.filter(tx=>tx.kind==='expense'||tx.kind==='income').length,0);
  store.restore(store.export());
});

test('historical staged statements preserve newer confirmed balances and commit guards stale revisions', t => {
  const {store,cash}=setup(t);
  const confirmed=store.command({type:'reconcile',accountId:cash,balanceCents:12345,date:'2026-09-01',note:'Latest bank balance',requestId:'confirmed'}).accounts.find(a=>a.id===cash)!;
  const statement=source(cash,[row('purchase',-2000)]);
  review(store,statement,[{rowId:'purchase',kind:'expense',category:'Food'}]);
  const revision=store.state().revision;
  assert.throws(()=>store.command({type:'commit_statements',expectedRevision:revision-1,importIds:[statement.id],requestId:'stale'}),RevisionConflictError);
  const committed=store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[statement.id],requestId:'valid'});
  assert.deepEqual(committed.accounts.find(a=>a.id===cash),confirmed);
  assert.equal(committed.transactions.filter(tx=>tx.kind==='expense').length,1);
});

test('restore rejects missing source links, changed classifications and changed source money atomically', t => {
  const {store,cash}=setup(t);
  const statement=source(cash,[row('purchase',-2000)]);
  review(store,statement,[{rowId:'purchase',kind:'expense',category:'Food'}]);
  store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[statement.id],requestId:'commit'});
  const backup=store.export();
  const baseline=store.state();
  for(const change of [
    (copy:typeof backup)=>{delete copy.data.transactions.find(tx=>tx.importSources)!.importSources;},
    (copy:typeof backup)=>{copy.data.importBatches![0].decisions[0].kind='income';},
    (copy:typeof backup)=>{copy.data.importBatches![0].source.rows[0].amountCents--;copy.data.importBatches![0].source.closingBalanceCents--;},
    (copy:typeof backup)=>{copy.data.importBatches![0].source.rows[0].description='Changed';},
  ]) {const invalid=structuredClone(backup);change(invalid);assert.throws(()=>store.restore(invalid));assert.deepEqual(store.state(),baseline);}
});

test('activity already linked to the other account still requires matching before a historical import', t => {
  const {store,cash,card}=setup(t);
  const moved=store.command({type:'add_transaction',kind:'debt_payment',accountId:cash,toAccountId:card,amountCents:1000,date:'2026-01-10',description:'Payment',category:'Card payment',requestId:'manual'});
  const transfer=moved.transactions.find(tx=>tx.kind==='debt_payment')!;
  const credit=source(card,[row('payment',-1000)],{id:'credit',sha256:'b'.repeat(64),openingBalanceCents:5000,closingBalanceCents:4000});
  review(store,credit,[{rowId:'payment',kind:'transfer',category:'Card payment',match:{transactionId:transfer.id}}]);
  store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[credit.id],requestId:'credit-commit'});
  store.command({type:'reconcile',accountId:cash,balanceCents:12345,date:'2026-09-01',note:'Current',requestId:'current'});
  const bank=source(cash,[row('bank-payment',-1000)]);
  review(store,bank,[{rowId:'bank-payment',kind:'expense',category:'Misclassified payment'}]);
  const baseline=store.state();
  assert.throws(()=>store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[bank.id],requestId:'duplicate-spending'}),/already has activity.*not recorded twice/);
  assert.deepEqual(store.state(),baseline);
  store.command({type:'review_statement',expectedRevision:store.state().revision,importId:bank.id,decisions:[{rowId:'bank-payment',kind:'transfer',category:'Card payment',match:{transactionId:transfer.id}}],requestId:'corrected'});
  store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[bank.id],requestId:'matched'});
  assert.equal(store.state().transactions.filter(tx=>tx.kind==='expense').length,0);
  assert.equal(store.state().transactions.find(tx=>tx.id===transfer.id)!.importSources!.length,2);
});

test('extraction corrections archive earlier rows and decisions, reset review, and cannot alter committed history', t => {
  const {store,cash,path}=setup(t);
  const original=source(cash,[row('purchase',-2001,'  OCR reading  ')],{closingBalanceCents:8000});
  review(store,original,[{rowId:'purchase',kind:'expense',category:'Food'}]);
  const before=store.state();
  const corrected={...original,rows:[{...original.rows[0],amountCents:-2000,description:'  Original merchant  '}]};
  const command={type:'revise_statement',importId:original.id,statement:corrected,reason:'Read amount and merchant from original page 2',requestId:'corrected',expectedRevision:before.revision} as const;
  const result=store.command(command);
  assert.deepEqual(result.accounts,before.accounts);
  assert.deepEqual(result.importBatches![0].source,corrected);
  assert.deepEqual(result.importBatches![0].decisions,[]);
  assert.deepEqual(result.importBatches![0].extractionHistory![0].source,original);
  assert.deepEqual(result.importBatches![0].extractionHistory![0].decisions,before.importBatches![0].decisions);
  assert.deepEqual(store.command(command),result);
  assert.throws(()=>store.command({...command,requestId:'stale-correction'}),RevisionConflictError);
  assert.throws(()=>store.command({...command,statement:{...corrected,sha256:'b'.repeat(64)},expectedRevision:result.revision,requestId:'changed-source'}),/original document SHA-256/);
  assert.throws(()=>store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[original.id],requestId:'unreviewed-correction'}),/need a classification/);
  store.command({type:'review_statement',expectedRevision:store.state().revision,importId:original.id,decisions:[{rowId:'purchase',kind:'expense',category:'Food'}],requestId:'review-correction'});
  store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[original.id],requestId:'commit-corrected'});
  assert.throws(()=>store.command({...command,expectedRevision:store.state().revision,requestId:'edit-committed'}),/Committed.*cannot be revised/);
  store.restore(store.export());
  store.close();
  const reopened=createStore(path,'live');
  try { assert.deepEqual(reopened.state().importBatches![0].extractionHistory![0].source,original);assert.deepEqual(reopened.state().importBatches![0].source,corrected); }
  finally { reopened.close(); }
});

test('review and commit require the revision which the reviewer saw', t => {
  const {store,cash}=setup(t);
  const statement=source(cash,[row('purchase',-2000)]);
  store.command({type:'stage_statement',statement,requestId:'stage'});
  assert.throws(()=>store.command({type:'review_statement',importId:statement.id,decisions:[],requestId:'missing-review-revision'}),/current workspace revision/);
  assert.throws(()=>store.command({type:'commit_statements',importIds:[statement.id],requestId:'missing-commit-revision'}),/current workspace revision/);
});

test('cash transfers between owners balance each owner without creating income or spending', t => {
  const {store,cash}=setup(t);
  const withBusiness=store.command({type:'add_entity',name:'Business',ownershipBps:5000});
  const business=withBusiness.entities.find(entity=>entity.kind==='business')!;
  const withAccount=store.command({type:'add_account',entityId:business.id,name:'Business bank',accountType:'cash',openingBalanceCents:0,openingDate:'2026-01-01'});
  const businessCash=withAccount.accounts.find(account=>account.entityId===business.id)!.id;
  const personal=source(cash,[row('sent',-1000)]);
  const received=source(businessCash,[row('received',1000)],{id:'business',sha256:'b'.repeat(64),openingBalanceCents:0,closingBalanceCents:1000});
  review(store,personal,[{rowId:'sent',kind:'transfer',category:'Owner contribution',match:{importId:received.id,rowId:'received'}}]);
  review(store,received,[{rowId:'received',kind:'transfer',category:'Owner contribution',match:{importId:personal.id,rowId:'sent'}}]);
  const result=store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[personal.id,received.id],requestId:'commit'});
  assert.equal(result.transactions.filter(tx=>tx.kind==='transfer').length,1);
  assert.equal(result.transactions.filter(tx=>tx.kind==='income'||tx.kind==='expense').length,0);
  assert.equal(result.accounts.find(account=>account.id===cash)!.balanceCents,9000);
  assert.equal(result.accounts.find(account=>account.id===businessCash)!.balanceCents,1000);
  store.restore(store.export());
});

test('same transaction date and merchant remain distinct across statements when posting dates differ', t => {
  const {store,cash}=setup(t);
  const january=source(cash,[row('last',-100,'Same shop','31')]);
  const february=source(cash,[{...row('first',-100,'Same shop','31'),postingDate:'2026-02-01'}],{id:'february',sha256:'b'.repeat(64),periodStart:'2026-02-01',periodEnd:'2026-02-28',openingBalanceCents:9900,closingBalanceCents:9800});
  review(store,january,[{rowId:'last',kind:'expense',category:'Food'}]);
  review(store,february,[{rowId:'first',kind:'expense',category:'Food'}]);
  const result=store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[january.id,february.id],requestId:'commit'});
  assert.equal(result.transactions.filter(tx=>tx.description==='Same shop').length,2);
  assert.equal(result.accounts.find(account=>account.id===cash)!.balanceCents,9800);
  const overlap=source(cash,[row('again',-100)],{id:'overlap',sha256:'c'.repeat(64)});
  review(store,overlap,[{rowId:'again',kind:'expense',category:'Food'}]);
  const baseline=store.state();
  assert.throws(()=>store.command({type:'commit_statements',expectedRevision:baseline.revision,importIds:[overlap.id],requestId:'overlap'}),/cannot overlap/);
  assert.deepEqual(store.state(),baseline);
});

test('negative historical source balances remain recorded when a later confirmed cash balance is positive', t => {
  const {store,cash}=setup(t);
  store.command({type:'reconcile',accountId:cash,balanceCents:5000,date:'2026-09-01',note:'Current balance',requestId:'current'});
  const statement=source(cash,[row('overdraft-fee',-200)],{openingBalanceCents:-1000,closingBalanceCents:-1200});
  review(store,statement,[{rowId:'overdraft-fee',kind:'expense',category:'Bank fees'}]);
  const result=store.command({type:'commit_statements',expectedRevision:store.state().revision,importIds:[statement.id],requestId:'historical-overdraft'});
  assert.equal(result.accounts.find(account=>account.id===cash)!.balanceCents,5000);
  assert.equal(result.importBatches![0].source.openingBalanceCents,-1000);
  assert.equal(result.importBatches![0].source.closingBalanceCents,-1200);
  store.restore(store.export());
});
