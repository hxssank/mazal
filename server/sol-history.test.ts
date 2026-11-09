import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { summarizeSolHistory } from '../shared/sol-history.ts';
import type { Command } from '../shared/types.ts';

type Store = ReturnType<typeof createStore>;
function setup(t:{after:(fn:()=>void)=>void}) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-sol-history-'));
  const path = join(directory, 'test.sqlite');
  let store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive:true, force:true }); });
  const add = (name:string, accountType:'cash'|'investment', openingBalanceCents:number) => store.command({ type:'add_account', entityId:'personal', name, accountType, openingBalanceCents, openingDate:'2026-01-01' }).accounts.find(item => item.name === name)!.id;
  const cash = add('Cash', 'cash', 100000);
  const investment = add('SOL', 'investment', 0);
  store.command({ type:'save_sol', accountId:investment, liquidSol:'5', stakedSol:'5', costBasisCents:80000, priceCents:10000, priceDate:'2026-01-01', priceSource:'Opening statement', requestId:'initial' });
  return { get store() { return store; }, cash, investment, reopen() { store.close(); store = createStore(path, 'live'); return store; } };
}
function amount(store:Store, accountId:string) { return store.state().accounts.find(account => account.id === accountId)!.balanceCents; }
function activity(store:Store, changes:Partial<Extract<Command,{type:'record_sol_activity'}>> = {}):Extract<Command,{type:'record_sol_activity'}> {
  return { type:'record_sol_activity', positionId:store.state().positions[0].id, kind:'buy', quantitySol:'1', priceCents:12000, feeCents:100, priceSource:'Exchange receipt', date:'2026-01-02', requestId:crypto.randomUUID(), ...changes };
}

test('linked SOL purchases, sales, rewards and fees preserve balances, quantities and remaining cost', t => {
  const { store, cash, investment } = setup(t);
  store.command(activity(store, { cashAccountId:cash }));
  assert.equal(amount(store, cash), 87900);
  assert.equal(amount(store, investment), 132000);
  assert.equal(store.state().positions[0].costBasisCents, 92100);
  store.command(activity(store, { kind:'sell', quantitySol:'2', priceCents:15000, feeCents:200, cashAccountId:cash, date:'2026-01-03' }));
  assert.equal(amount(store, cash), 117700);
  assert.equal(amount(store, investment), 135000);
  assert.equal(store.state().positions[0].costBasisCents, 75355);
  store.command(activity(store, { kind:'reward', quantitySol:'0.5', priceCents:15000, feeCents:0, date:'2026-01-04' }));
  assert.equal(amount(store, investment), 142500);
  assert.equal(store.state().positions[0].costBasisCents, 75355);
  store.command(activity(store, { kind:'fee', quantitySol:'0', feeCents:50, cashAccountId:cash, date:'2026-01-05' }));
  assert.equal(amount(store, cash), 117650);
  assert.equal(amount(store, investment), 142500);
  const summary = summarizeSolHistory(store.state().positions[0]);
  assert.equal(summary.purchasesCents, 12000);
  assert.equal(summary.salesCents, 30000);
  assert.equal(summary.rewardsCents, 7500);
  assert.equal(summary.marketChangeCents, 53000);
  assert.equal(summary.feesCents, 350);
  assert.equal(summary.resultCents, 60150);
  assert.equal(amount(store, cash) + amount(store, investment) - 200000, summary.resultCents);
});

test('balance corrections and initial snapshots do not become earnings', t => {
  const { store, investment } = setup(t);
  store.command({ type:'save_sol', accountId:investment, liquidSol:'6', stakedSol:'5', costBasisCents:90000, priceCents:15000, priceDate:'2026-01-02', priceSource:'Manual quote', requestId:'correct' });
  const position = store.state().positions[0];
  assert.deepEqual(position.history!.map(entry => entry.kind), ['snapshot','correction']);
  const summary = summarizeSolHistory(position);
  assert.equal(summary.marketChangeCents, 0);
  assert.equal(summary.correctionsCents, 65000);
  assert.equal(summary.purchasesCents, 0);
  assert.equal(summary.resultCents, 0);
});

test('correcting quantity and price together cannot manufacture earnings on unchanged portfolio value', t => {
  const { store, investment } = setup(t);
  store.command({ type:'save_sol', accountId:investment, liquidSol:'1', stakedSol:'0', costBasisCents:80000, priceCents:100000, priceDate:'2026-01-02', priceSource:'Corrected statement', requestId:'correct-quantity-and-price' });
  const position = store.state().positions[0];
  assert.equal(amount(store, investment), 100000);
  assert.deepEqual(position.history!.map(entry => entry.kind), ['snapshot','correction']);
  assert.equal(summarizeSolHistory(position).resultCents, 0);
  assert.equal(summarizeSolHistory(position).marketChangeCents, 0);
  assert.equal(summarizeSolHistory(position).correctionsCents, 0);
  const backup = store.export();
  store.restore(backup);
  assert.equal(store.state().positions[0].priceSource, 'Corrected statement');
});

test('price-only updates attribute valuation changes to market movement', t => {
  const { store, investment } = setup(t);
  store.command({ type:'save_sol', accountId:investment, liquidSol:'5', stakedSol:'5', costBasisCents:80000, priceCents:12000, priceDate:'2026-01-02', priceSource:'Closing quote', requestId:'quote-only' });
  const summary = summarizeSolHistory(store.state().positions[0]);
  assert.equal(summary.marketChangeCents, 20000);
  assert.equal(summary.correctionsCents, 0);
  assert.equal(summary.resultCents, 20000);
});

test('legacy positions start with their saved snapshot and retain reward quote dates', t => {
  const { store } = setup(t);
  const legacy = store.export();
  delete legacy.data.positions[0].history;
  delete legacy.data.positions[0].priceSource;
  store.restore(legacy);
  assert.equal(store.state().positions[0].history, undefined);
  store.command({ type:'add_sol_reward', positionId:store.state().positions[0].id, sol:'0.1', date:'2026-01-03', requestId:'legacy-reward' });
  const position = store.state().positions[0];
  assert.deepEqual(position.history!.map(entry => entry.kind), ['snapshot','reward']);
  assert.equal(position.history![0].date, '2026-01-01');
  assert.equal(position.history![1].priceDate, '2026-01-01');
  assert.equal(summarizeSolHistory(position).resultCents, 1000);
});

test('SOL history, cash effects and request IDs survive restart and backup restore', t => {
  const fixture = setup(t);
  const command = activity(fixture.store, { cashAccountId:fixture.cash, requestId:'repeat-buy' });
  fixture.store.command(command);
  const backup = fixture.store.export();
  const expected = structuredClone(fixture.store.state().positions);
  fixture.reopen().command(command);
  assert.deepEqual(fixture.store.state().positions, expected);
  assert.equal(amount(fixture.store, fixture.cash), 87900);
  fixture.store.command(activity(fixture.store, { kind:'fee', quantitySol:'0', feeCents:50, date:'2026-01-03', cashAccountId:fixture.cash }));
  fixture.store.restore(backup);
  fixture.store.command(command);
  assert.deepEqual(fixture.store.state().positions, expected);
  assert.equal(amount(fixture.store, fixture.cash), 87900);
});

test('invalid sales, owner links, dates and insufficient cash roll back quote and history changes', t => {
  const { store, cash } = setup(t);
  store.command({ type:'add_entity', name:'Business', ownershipBps:5000 });
  const entityId = store.state().entities.find(entity => entity.name === 'Business')!.id;
  store.command({ type:'add_account', name:'Business cash', entityId, accountType:'cash', openingBalanceCents:100000, openingDate:'2026-01-01' });
  const wrongCash = store.state().accounts.find(account => account.name === 'Business cash')!.id;
  const before = store.state();
  for (const command of [
    activity(store, { kind:'sell', quantitySol:'6', cashAccountId:cash }),
    activity(store, { quantitySol:'10', cashAccountId:cash }),
    activity(store, { cashAccountId:wrongCash }),
    activity(store, { date:'2025-12-31' }),
    activity(store, { date:'2199-01-01' }),
    activity(store, { quantitySol:'0.0000000001' }),
    activity(store, { kind:'reward', feeCents:0, cashAccountId:cash }),
  ]) {
    assert.throws(() => store.command(command));
    assert.deepEqual(store.state(), before);
  }
});

test('same-day reconciled cash needs explicit after-check confirmation for SOL trades', t => {
  const { store, cash } = setup(t);
  store.command({ type:'reconcile', accountId:cash, balanceCents:100000, date:'2026-01-02', note:'Bank statement', requestId:'cash-check' });
  const command = activity(store, { cashAccountId:cash });
  assert.throws(() => store.command(command), /after the cash balance check/);
  store.command({ ...command, afterBalanceConfirmation:true });
  assert.equal(amount(store, cash), 87900);
});

test('unlinked trades and fees leave cash alone and identify missing cash links', t => {
  const { store, cash } = setup(t);
  store.command(activity(store));
  store.command(activity(store, { kind:'fee', quantitySol:'0', feeCents:200, date:'2026-01-03' }));
  assert.equal(amount(store, cash), 100000);
  assert.equal(store.state().positions[0].history!.at(-1)!.transactionIds.length, 0);
  assert.equal(summarizeSolHistory(store.state().positions[0]).feesCents, 300);
});

test('backup restore rejects edited activity quantities, journal links and valuation sources', t => {
  const { store, cash } = setup(t);
  store.command(activity(store, { cashAccountId:cash }));
  const backup = store.export();
  for (const mutate of [
    (copy:typeof backup) => { copy.data.positions[0].history!.at(-1)!.quantitySol = '2'; },
    (copy:typeof backup) => { copy.data.positions[0].history!.at(-1)!.transactionIds = []; },
    (copy:typeof backup) => { copy.data.positions[0].history!.at(-1)!.priceSource = 'Different source'; },
    (copy:typeof backup) => { copy.data.positions[0].history![1].liquidSol = '9'; },
  ]) {
    const copy = structuredClone(backup);
    mutate(copy);
    const before = store.state();
    assert.throws(() => store.restore(copy), /SOL/);
    assert.deepEqual(store.state(), before);
  }
});

test('fractional SOL trades keep the investment journal equal to the rounded holding value', t => {
  const { store, cash, investment } = setup(t);
  store.command(activity(store, { quantitySol:'0.00009', priceCents:15001, feeCents:0, cashAccountId:cash }));
  store.command(activity(store, { kind:'sell', quantitySol:'0.00004', priceCents:15001, feeCents:0, cashAccountId:cash, date:'2026-01-03' }));
  const backup = store.export();
  store.restore(backup);
  assert.equal(amount(store, investment), 150011);
});

test('restore rejects future SOL snapshot and quote dates without blocking later valid activity', t => {
  const { store } = setup(t);
  const backup = store.export();
  for (const mutate of [
    (copy:typeof backup) => { copy.data.positions[0].history![0].date = '2199-01-01'; },
    (copy:typeof backup) => { copy.data.positions[0].priceDate = '2199-01-01'; },
    (copy:typeof backup) => { copy.data.positions[0].history![0].priceDate = '2199-01-01'; },
    (copy:typeof backup) => { delete copy.data.positions[0].history; copy.data.positions[0].priceDate = '2199-01-01'; },
  ]) {
    const copy = structuredClone(backup);
    mutate(copy);
    const before = store.state();
    assert.throws(() => store.restore(copy), /future/);
    assert.deepEqual(store.state(), before);
  }
  store.command(activity(store));
  assert.equal(store.state().positions[0].liquidSol, '6');
});
