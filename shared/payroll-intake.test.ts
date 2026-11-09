import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPaystub, emptyPayrollLine, emptyTimecard, reviewedPayrollImport } from './payroll-intake.ts';
import { payrollIssues, payrollReconciliation } from './payroll.ts';
import { validatePayrollImport } from '../server/payroll.ts';
import type { PayrollSource } from './payroll.ts';

const source: PayrollSource = { id: 'source', filename: 'Original.pdf', sha256: 'a'.repeat(64), kind: 'paystub', mimeType: 'application/pdf', pageCount: 2 };
const stub = () => ({ ...emptyPaystub('stub'), employer: 'Employer', payDate: '2026-09-18', periodStart: '2026-09-01', periodEnd: '2026-09-14', gross: '0.29', net: '0.20', tax: '0.08', deduction: '0.01', hours: '-0.5' });
const input = () => ({ id: 'batch', importedAt: '2026-10-02T12:00:00.000Z', source, paystubs: [stub()], timecards: [] });

test('reviewed payroll preserves exact cents, signed hours and unknown optional values', () => {
  const imported = reviewedPayrollImport(input());
  assert.equal(imported.paystubs[0].grossCents, 29);
  assert.equal(imported.paystubs[0].hours, -0.5);
  assert.equal(imported.paystubs[0].payRate, null);
  assert.equal(imported.paystubs[0].ytd.netCents, null);
  assert.equal(imported.paystubs[0].ytd.hours, null);
  assert.deepEqual(validatePayrollImport(imported), imported);
  const check = payrollReconciliation(imported.paystubs[0]);
  assert.equal(check.netDifferenceCents, 0);
  assert.equal(check.grossDifferenceCents, null);
  assert.equal(check.ytdNetDifferenceCents, null);
  assert.equal(check.isBalanced, false);
  assert.equal(payrollIssues(imported)[0].id, 'reconciliation-stub');
});

test('reviewed intake rejects blank required totals, invalid periods, fractional cents and repeated source pages', () => {
  for (const patch of [{ net: '' }, { hours: '' }, { gross: '0.291' }, { payDate: '2026-02-30' }, { periodEnd: '2026-01-01' }, { sourcePage: '3' }, { payRate: '3e1' }]) assert.throws(() => reviewedPayrollImport({ ...input(), paystubs: [{ ...stub(), ...patch }] }));
  assert.throws(() => reviewedPayrollImport({ ...input(), paystubs: [stub(), { ...stub(), id: 'second' }] }), /different source page/);
});

test('line input retains null source cells and exact rate digits without adding unlisted year-to-date totals', () => {
  const draft = { ...stub(), lineDetailsReviewed: true, earnings: [{ ...emptyPayrollLine(), label: 'Adjustment', amount: '0.29', hours: '-0.5', rate: '12.345600' }] };
  const imported = reviewedPayrollImport({ ...input(), paystubs: [draft] });
  assert.equal(imported.paystubs[0].earnings[0].rate, '12.345600');
  assert.equal(imported.paystubs[0].earnings[0].ytdAmountCents, null);
  assert.deepEqual(validatePayrollImport(imported), imported);
});

test('timecard intake preserves separate system rows and optional source fields', () => {
  const card = { ...emptyTimecard('card'), periodStart: '2026-09-01', periodEnd: '2026-09-07', hours: '37.5', status: 'Submitted' };
  const imported = reviewedPayrollImport({ ...input(), source: { ...source, kind: 'timecards' }, timecards: [card, { ...card, id: 'legacy', sourceRow: '2', system: 'legacy' }] });
  assert.equal(imported.paystubs.length, 0);
  assert.equal(imported.timecards[0].submissionDate, null);
  assert.equal(imported.timecards[0].transferredTo, null);
  assert.equal(imported.timecards[0].sourcePage, 1);
  assert.deepEqual(imported.timecards.map(item => item.system), ['projects', 'legacy']);
  assert.deepEqual(validatePayrollImport(imported), imported);
  assert.throws(() => reviewedPayrollImport({ ...input(), source: { ...source, kind: 'timecards' }, timecards: [{ ...card, sourcePage: '3' }] }), /Source page/);
  const secondPage = reviewedPayrollImport({ ...input(), source: { ...source, kind: 'timecards' }, timecards: [card, { ...card, id: 'page-2', sourcePage: '2' }] });
  assert.deepEqual(validatePayrollImport(secondPage), secondPage);
});
