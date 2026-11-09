import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DailyPlan } from './engine.ts';
import { projectHomeCash } from './home-cash-preview.ts';

function plan(): DailyPlan {
  return {
    asOf: '2026-10-15', endDate: '2026-10-17', horizonDays: 3, status: 'ready',
    cashCents: 10000, protectedCents: 2000, cashAfterKnownCents: 13000,
    knownIncomeCents: 20000, knownOutflowCents: 15000, livingCostsCents: 3000,
    lowestCashCents: 1000, lowestCashDate: '2026-10-16', firstShortfallDate: '2026-10-16',
    nextPayday: { date: '2026-10-16', amountCents: 20000 }, todayPayday: null,
    beforePayday: { endDate: '2026-10-15', knownIncomeCents: 0, knownOutflowCents: 1000, cashAfterKnownCents: 7000 },
    events: [], missingInputs: [], warnings: [],
    days: [
      { date: '2026-10-15', incomeCents: 0, outflowCents: 1000, livingCostsCents: 1000, closingCashCents: 9000, afterProtectedCents: 7000, eventIds: [] },
      { date: '2026-10-16', incomeCents: 20000, outflowCents: 8000, livingCostsCents: 1000, closingCashCents: 21000, afterProtectedCents: 19000, eventIds: ['payday'] },
      { date: '2026-10-17', incomeCents: 0, outflowCents: 6000, livingCostsCents: 1000, closingCashCents: 15000, afterProtectedCents: 13000, eventIds: [] },
    ],
  };
}

test('cash preview preserves the cash gap before a same-day deposit', () => {
  const result = projectHomeCash(plan());
  assert.equal(result.days[1].baselineCents, 19000);
  assert.equal(result.days[1].previewCents, 19000);
  assert.equal(result.days[1].beforeIncomeCents, -1000);
  assert.equal(result.lowestCents, -1000);
  assert.equal(result.lowestDate, '2026-10-16');
  assert.equal(result.firstShortfallDate, '2026-10-16');
  assert.equal(result.openingCents, 8000);
  assert.equal(result.endingCents, 13000);
});

test('extra spending shifts the chosen date and later dates exactly once', () => {
  const result = projectHomeCash(plan(), { extraSpendCents: 15000, spendDate: '2026-10-17' });
  assert.deepEqual(result.days.map(day => day.previewCents), [7000, 19000, -2000]);
  assert.deepEqual(result.days.map(day => day.extraSpendCents), [0, 0, 15000]);
  assert.deepEqual(result.days.map(day => day.baselineCents), [7000, 19000, 13000]);
  assert.equal(result.lowestCents, -2000);
  assert.equal(result.lowestDate, '2026-10-17');
  assert.equal(result.firstShortfallDate, '2026-10-16');
  assert.equal(result.baselineEndingCents, 13000);
  assert.equal(result.endingCents, -2000);
  assert.equal(result.outflowCents, 30000);
});

test('spending today changes every forecast day but does not change saved opening cash', () => {
  const result = projectHomeCash(plan(), { extraSpendCents: 8000 });
  assert.equal(result.spendDate, '2026-10-15');
  assert.equal(result.openingCents, 8000);
  assert.deepEqual(result.days.map(day => day.previewCents), [-1000, 11000, 5000]);
  assert.deepEqual(result.days.map(day => day.extraSpendCents), [8000, 0, 0]);
  assert.equal(result.lowestCents, -9000);
  assert.equal(result.firstShortfallDate, '2026-10-15');
});

test('a filtered window uses only its days and counts living costs within total outflow', () => {
  const result = projectHomeCash(plan(), { endDate: '2026-10-15' });
  assert.equal(result.endDate, '2026-10-15');
  assert.equal(result.days.length, 1);
  assert.equal(result.incomeCents, 0);
  assert.equal(result.outflowCents, 1000);
  assert.equal(result.livingCostsCents, 1000);
  assert.equal(result.endingCents, 7000);
  assert.equal(result.lowestCents, 7000);
  assert.equal(result.firstShortfallDate, null);
  const full = projectHomeCash(plan());
  assert.equal(full.incomeCents, 20000);
  assert.equal(full.outflowCents, 15000);
  assert.equal(full.livingCostsCents, 3000);
});

test('spending outside the selected window has no effect until that date is included', () => {
  const source = plan();
  const options = { extraSpendCents: 4000, spendDate: '2026-10-16' };
  const before = projectHomeCash(source, { ...options, endDate: '2026-10-15' });
  assert.equal(before.endingCents, 7000);
  assert.equal(before.outflowCents, 1000);
  assert.deepEqual(before.days.map(day => day.extraSpendCents), [0]);
  const through = projectHomeCash(source, { ...options, endDate: '2026-10-16' });
  assert.equal(through.endingCents, 15000);
  assert.equal(through.outflowCents, 13000);
  assert.equal(through.lowestCents, -5000);
});

test('partial plans and unknown events remain unchanged and are not converted to zero', () => {
  const source = plan();
  source.status = 'partial';
  source.events.push({ id: 'unknown', sourceType: 'obligation', sourceId: 'bill', entityId: 'personal', name: 'Unknown bill', date: '2026-10-15', effectiveDate: '2026-10-15', direction: 'out', amountCents: null, status: 'today', isProjection: false, includedInCashflow: false, accountId: 'cash', note: '' });
  source.days[0].eventIds.push('unknown');
  source.missingInputs.push({ field: 'obligations.bill.amountCents', message: 'Confirm the bill amount.', section: 'expenses', sourceId: 'bill' });
  const original = structuredClone(source);
  const result = projectHomeCash(source, { extraSpendCents: 1000 });
  assert.equal(result.outflowCents, 16000);
  assert.deepEqual(result.days[0].eventIds, ['unknown']);
  assert.equal(source.events[0].amountCents, null);
  assert.deepEqual(source, original);
  result.days[0].eventIds.push('local-only');
  result.days[0].outflowCents = 1;
  assert.deepEqual(source, original);
});

test('opening cash participates in the minimum even when the first day receives money', () => {
  const source = plan();
  source.cashCents = 1000;
  source.days = [{ ...source.days[0], incomeCents: 5000, outflowCents: 0, livingCostsCents: 0, closingCashCents: 6000, afterProtectedCents: 4000 }];
  const result = projectHomeCash(source);
  assert.equal(result.lowestCents, -1000);
  assert.equal(result.lowestDate, source.asOf);
  assert.equal(result.firstShortfallDate, source.asOf);
  assert.equal(result.endingCents, 4000);
});

test('an empty plan returns opening cash and rejects spending without a forecast day', () => {
  const source = plan();
  source.days = [];
  const result = projectHomeCash(source);
  assert.deepEqual(result.days, []);
  assert.equal(result.lowestCents, 8000);
  assert.equal(result.lowestDate, source.asOf);
  assert.equal(result.endingCents, 8000);
  assert.equal(result.baselineEndingCents, 8000);
  assert.equal(result.firstShortfallDate, null);
  assert.equal(result.incomeCents, 0);
  assert.equal(result.outflowCents, 0);
  assert.equal(result.livingCostsCents, 0);
  assert.throws(() => projectHomeCash(source, { extraSpendCents: 1 }), /forecast day/);
});

test('invalid spending amounts and invalid dates fail instead of producing a misleading preview', () => {
  for (const extraSpendCents of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => projectHomeCash(plan(), { extraSpendCents }), /nonnegative whole amount/);
  }
  for (const value of ['2026-10-14', '2026-10-18', '2026-02-30', '2026-1-15', 'not a date']) {
    assert.throws(() => projectHomeCash(plan(), { endDate: value }), /end date/);
    assert.throws(() => projectHomeCash(plan(), { spendDate: value }), /spending date/);
  }
  const invalid = plan();
  invalid.asOf = '2026-02-30';
  assert.throws(() => projectHomeCash(invalid), /invalid date range/);
  const unordered = plan();
  unordered.days.reverse();
  assert.throws(() => projectHomeCash(unordered), /unordered days/);
  const missing = plan();
  missing.days.splice(1, 1);
  assert.throws(() => projectHomeCash(missing, { extraSpendCents: 1, spendDate: '2026-10-16' }), /forecast day/);
});

test('unsafe cent arithmetic fails for balances, totals, and scenario subtraction', () => {
  const opening = plan();
  opening.cashCents = -Number.MAX_SAFE_INTEGER;
  assert.throws(() => projectHomeCash(opening), /supported amount/);
  const totals = plan();
  totals.days[0].outflowCents = Number.MAX_SAFE_INTEGER;
  assert.throws(() => projectHomeCash(totals), /supported amount/);
  const subtraction = plan();
  subtraction.days[0].afterProtectedCents = -1;
  assert.throws(() => projectHomeCash(subtraction, { extraSpendCents: Number.MAX_SAFE_INTEGER }), /supported amount/);
  const invalid = plan();
  invalid.days[0].incomeCents = .5;
  assert.throws(() => projectHomeCash(invalid), /supported amount/);
});
