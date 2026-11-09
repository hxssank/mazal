import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAssetMoney } from './asset-planning.ts';

test('asset amounts parse decimal cents without rounding large values', () => {
  assert.equal(parseAssetMoney('4500'), 450000);
  assert.equal(parseAssetMoney(' 12.9 '), 1290);
  assert.equal(parseAssetMoney('000.01'), 1);
  assert.equal(parseAssetMoney('0'), 0);
  assert.equal(parseAssetMoney('999999999999.99'), 99999999999999);
  assert.equal(parseAssetMoney('1000000000000.00'), 100000000000000);
  for (const value of ['', ' ', '-1', '1.001', '1e3', 'Infinity', 'NaN', '1000000000000.01', '12,50']) assert.throws(() => parseAssetMoney(value, 'Cost'), /Cost/);
});
