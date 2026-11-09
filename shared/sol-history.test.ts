import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSolActivity, solLamports, solMarketValue, solQuantity, summarizeSolHistory, validateSolHistory } from './sol-history.ts';
import type { SolHistoryEntry, SolPosition } from './types.ts';

const position:SolPosition = { id:'sol', accountId:'wallet', liquidSol:'2', stakedSol:'8', rewardsSol:'0', costBasisCents:100000, priceCents:12000, priceDate:'2026-01-01', priceSource:'Manual entry' };
function entry(kind:SolHistoryEntry['kind'], changes:Partial<SolHistoryEntry> = {}):SolHistoryEntry {
  return { ...position, id:crypto.randomUUID(), date:'2026-01-01', kind, quantitySol:'0', amountCents:0, feeCents:0, transactionIds:[], priceSource:'Manual entry', ...changes };
}

test('SOL quantity arithmetic retains lamports and rounds valuations only at cents', () => {
  assert.equal(solQuantity(solLamports('123.000000001')), '123.000000001');
  assert.equal(solMarketValue({ liquidSol:'0.000000001', stakedSol:'0', priceCents:10000 }), 0);
  const result = calculateSolActivity(position, { kind:'reward', quantitySol:'0.000000001', feeCents:0 });
  assert.equal(result.snapshot.stakedSol, '8.000000001');
  assert.equal(result.snapshot.rewardsSol, '0.000000001');
  assert.equal(result.snapshot.costBasisCents, position.costBasisCents);
  assert.throws(() => solLamports('0.0000000001'), /9 decimals/);
});

test('purchases include fees in recorded cost while partial sales remove average cost', () => {
  const buy = calculateSolActivity(position, { kind:'buy', quantitySol:'2', feeCents:500 });
  assert.equal(buy.snapshot.liquidSol, '4');
  assert.equal(buy.snapshot.costBasisCents, 124500);
  assert.equal(buy.cashDeltaCents, -24500);
  const sell = calculateSolActivity(buy.snapshot, { kind:'sell', quantitySol:'3', feeCents:100 });
  assert.equal(sell.snapshot.costBasisCents, 93375);
  assert.equal(sell.cashDeltaCents, 35900);
  assert.throws(() => calculateSolActivity(position, { kind:'sell', quantitySol:'3', feeCents:0 }), /unstaked/);
  assert.throws(() => calculateSolActivity(position, { kind:'sell', quantitySol:'1', feeCents:13000 }), /cover/);
});

test('selling an entire liquid holding clears remaining cost without residue', () => {
  const sell = calculateSolActivity({ ...position, stakedSol:'0', costBasisCents:10001 }, { kind:'sell', quantitySol:'2', feeCents:0 });
  assert.equal(sell.snapshot.costBasisCents, 0);
  assert.equal(sell.snapshot.liquidSol, '0');
});

test('history attributes price moves and rewards, excluding opening balances and corrections', () => {
  const opening = entry('snapshot');
  const quote = entry('price', { priceCents:13000 });
  const correction = entry('correction', { priceCents:13000, liquidSol:'3' });
  const buy = entry('buy', { priceCents:13000, liquidSol:'4', costBasisCents:113100, quantitySol:'1', amountCents:13000, feeCents:100 });
  const reward = entry('reward', { ...buy, id:'reward', kind:'reward', liquidSol:'4', stakedSol:'8.5', rewardsSol:'0.5', quantitySol:'0.5', amountCents:6500, feeCents:0 });
  const p = { ...position, ...reward, id:'sol', history:[opening, quote, correction, buy, reward] };
  validateSolHistory(p);
  const summary = summarizeSolHistory(p);
  assert.equal(summary.openingValueCents, 120000);
  assert.equal(summary.marketChangeCents, 10000);
  assert.equal(summary.correctionsCents, 13000);
  assert.equal(summary.purchasesCents, 13000);
  assert.equal(summary.rewardsCents, 6500);
  assert.equal(summary.resultCents, 16400);
  assert.equal(summarizeSolHistory(position).startDate, null);
});

test('history rejects fabricated quantity changes, later-dated quotes and changed cost', () => {
  const opening = entry('snapshot');
  const price = entry('price', { liquidSol:'3' });
  assert.throws(() => validateSolHistory({ ...position, liquidSol:'3', history:[opening, price] }), /cannot change holdings/);
  assert.throws(() => validateSolHistory({ ...position, history:[{ ...opening, priceDate:'2026-01-02' }] }), /dated after/);
  const buy = entry('buy', { liquidSol:'3', quantitySol:'1', amountCents:12000 });
  assert.throws(() => validateSolHistory({ ...position, liquidSol:'3', history:[opening, buy] }), /cost/);
});
