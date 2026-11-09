import test from 'node:test';
import assert from 'node:assert/strict';
import { findPayrollRecords } from './payroll-lookup.ts';
import type { PayrollImport } from './payroll.ts';

const batch = {
  id: 'batch',
  timecards: [
    { id: 'early', periodStart: '2026-06-11', periodEnd: '2026-06-17' },
    { id: 'later', periodStart: '2026-06-25', periodEnd: '2026-07-01' },
  ],
  paystubs: [{ id: 'pay', periodStart: '2026-06-11', periodEnd: '2026-06-24', payDate: '2026-07-09', lineDetailsReviewed: false, grossCents: 0, netCents: 0, taxCents: 0, deductionCents: 0, hours: 0, earnings: [], taxes: [], deductions: [], ytd: { grossCents: null, netCents: null, taxCents: null, deductionCents: null, hours: null } }],
  issues: [{ id: 'missing', severity: 'review', title: 'Missing timecard', detail: 'Review', sourceIds: [], timecardIds: [], paystubIds: ['pay'] }],
} as unknown as PayrollImport;

test('finds a statement and linked missing-timecard review even when no timecard exists', () => {
  const result = findPayrollRecords([batch], '2026-06-18', '2026-06-24')!;
  assert.deepEqual(result.cards, []);
  assert.deepEqual(result.pays.map(item => item.pay.id), ['pay']);
  assert.ok(result.issues.some(item => item.issue.id === 'missing'));
});

test('includes overlapping boundary dates and rejects invalid ranges', () => {
  const result = findPayrollRecords([batch], '2026-06-17', '2026-06-25')!;
  assert.deepEqual(result.cards.map(item => item.card.id), ['early', 'later']);
  assert.equal(findPayrollRecords([batch], '2026-06-25', '2026-06-17'), null);
  assert.equal(findPayrollRecords([batch], '2026-02-30', '2026-03-01'), null);
});
