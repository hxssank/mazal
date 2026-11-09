import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyCents } from './money-input.ts';
import { parseAssetMoney } from './asset-planning.ts';

const messages = {invalidMessage:'Invalid amount', rangeMessage:'Amount too large'};

test('money input converts decimal text without floating point rounding', () => {
  for (const [value, expected] of [['0',0], ['0.01',1], ['12.30',1230], [' 0012.3 ',1230], ['90071992547409.91',Number.MAX_SAFE_INTEGER]] as const) {
    assert.equal(parseMoneyCents(value,messages),expected);
  }
  assert.throws(() => parseMoneyCents('90071992547409.92',messages), /Amount too large/);
  assert.equal(parseMoneyCents('1000000000000.00',{...messages,maxCents:100_000_000_000_000}),100_000_000_000_000);
  assert.throws(() => parseMoneyCents('1000000000000.01',{...messages,maxCents:100_000_000_000_000}), /Amount too large/);
});

test('money input rejects missing values and unsupported precision or notation', () => {
  for (const value of ['', ' ', '.', '1.', '1.001', '1e2', '1,000', '+1', '-1', '-0', 'NaN', 'Infinity', '.5']) {
    assert.throws(() => parseMoneyCents(value,messages), /Invalid amount/, value);
  }
  assert.throws(() => parseMoneyCents(' 1 ',{...messages,trim:false}), /Invalid amount/);
});

test('form-specific sign and leading decimal rules remain explicit', () => {
  const options={...messages,signed:true,leadingDecimal:true};
  assert.equal(parseMoneyCents('-.01',options),-1);
  assert.equal(parseMoneyCents('.50',options),50);
  assert.equal(parseMoneyCents('-0',options),0);
  assert.equal(parseMoneyCents('-90071992547409.91',options),-Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseMoneyCents('-90071992547409.92',options), /Amount too large/);
  assert.throws(() => parseMoneyCents('--1',options), /Invalid amount/);
  assert.throws(() => parseMoneyCents('-.',options), /Invalid amount/);
  assert.throws(() => parseAssetMoney('.50','Cost'), /Cost must be a nonnegative amount/);
  assert.equal(parseAssetMoney(' 0.00 ','Cost'),0);
  assert.throws(() => parseAssetMoney('1000000000000.01','Cost'), /Cost exceeds the supported amount/);
});
