import assert from 'node:assert/strict';
import test from 'node:test';
import { payrollBankMatch, payrollReconciliation, payrollSumCents, payrollTimecardOverlaps, payrollTotals } from './payroll.ts';
import type { PayrollPaystub, PayrollTimecard } from './payroll.ts';
import type { AppState, Transaction } from './types.ts';

const stub: PayrollPaystub = {
  id: 'stub', sourceId: 'pdf', sourcePage: 1, payDate: '2026-08-06', periodStart: '2026-07-12', periodEnd: '2026-07-25',
  sequence: 'PAY001', employer: 'Example Company', payFrequency: 'Biweekly', payRate: '30.1234',
  grossCents: 9037, netCents: 7037, taxCents: 1500, deductionCents: 500, hours: 3,
  earnings: [
    { label: 'Regular correction', hours: -2, rate: '30.1234', amountCents: -6025, ytdHours: 8, ytdAmountCents: 24099 },
    { label: 'Advance timesheet', hours: 5, rate: '30.1234', amountCents: 15062, ytdHours: 5, ytdAmountCents: 15062 },
    { label: 'Holiday', hours: null, rate: null, amountCents: null, ytdHours: 1, ytdAmountCents: 3012 },
  ],
  taxes: [{ label: 'Tax', amountCents: 1500, ytdAmountCents: 7000 }], deductions: [{ label: 'Union', amountCents: 500, ytdAmountCents: 1000 }],
  ytd: { grossCents: 42173, netCents: 34173, taxCents: 7000, deductionCents: 1000, hours: 14 },
  paymentMethod: 'Direct deposit', vacationBalanceCents: null, vacationAccruedCents: 362,
};

function state(transactions: Transaction[]): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'business', name: 'Shop', kind: 'business', ownershipBps: 10000 }],
    accounts: [{ id: 'cash', entityId: 'personal', name: 'Cash', type: 'cash', currency: 'CAD', balanceCents: 10000, reconciledAt: null }, { id: 'shop', entityId: 'business', name: 'Shop cash', type: 'cash', currency: 'CAD', balanceCents: 10000, reconciledAt: null }],
    transactions, obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
function income(overrides: Partial<Transaction> = {}): Transaction {
  return { id: 'deposit', date: stub.payDate, description: 'PAYROLL DEPOSIT', kind: 'income', amountCents: stub.netCents, accountId: 'cash', toAccountId: null, category: 'Payroll', source: 'Statement', createdAt: '2026-08-07T12:00:00.000Z', ...overrides };
}

test('payroll totals and reconciliation retain signed corrections, blank current lines and decimal rate precision', () => {
  assert.deepEqual(payrollTotals([stub]), { paystubCount: 1, grossCents: 9037, netCents: 7037, taxCents: 1500, deductionCents: 500, hours: 3 });
  assert.equal(payrollReconciliation(stub).isBalanced, true);
  assert.equal(stub.payRate, '30.1234');
  const discrepancy = payrollReconciliation({ ...stub, grossCents: stub.grossCents + 1 });
  assert.equal(discrepancy.grossDifferenceCents, 1);
  assert.equal(discrepancy.netDifferenceCents, 1);
  assert.equal(discrepancy.isBalanced, false);
  assert.equal(stub.earnings[2].amountCents, null);
  const wrongYtdHours = payrollReconciliation({ ...stub, ytd: { ...stub.ytd, hours: 8000 } });
  assert.equal(wrongYtdHours.ytdHoursDifference, 7986);
  assert.equal(wrongYtdHours.isBalanced, false);
  const unknownYtdHours = payrollReconciliation({ ...stub, earnings: stub.earnings.map((row, index) => index ? row : { ...row, ytdHours: null }) });
  assert.equal(unknownYtdHours.ytdHoursDifference, null);
  assert.equal(unknownYtdHours.isBalanced, false);
});

test('safe payroll addition preserves cancellation before checking the final integer limit', () => {
  assert.equal(payrollSumCents([Number.MAX_SAFE_INTEGER, 100, -100]), Number.MAX_SAFE_INTEGER);
  assert.throws(() => payrollSumCents([Number.MAX_SAFE_INTEGER, 1]), /exceeds/);
  assert.throws(() => payrollSumCents([0.5]), /whole cents/);
  assert.throws(() => payrollTotals([{ ...stub, hours: Infinity }]), /finite/);
});

test('deposit matching requires personal cash, income, payroll evidence, exact cents and a matching pay or posting date', () => {
  const unrelated = [income({ id: 'expense', kind: 'expense' }), income({ id: 'shop', accountId: 'shop' }), income({ id: 'amount', amountCents: stub.netCents + 1 }), income({ id: 'later', date: '2026-08-07' }), income({ id: 'refund', description: 'STORE REFUND', category: 'Refund' })];
  const records = state(unrelated);
  const before = structuredClone(records);
  assert.equal(payrollBankMatch(records, stub).status, 'unmatched');
  assert.deepEqual(records, before);
  const posted = income({ date: '2026-08-05', postingDate: stub.payDate });
  assert.deepEqual(payrollBankMatch(state([...unrelated, posted]), stub).transactions, [posted]);
  assert.equal(payrollBankMatch(state([posted]), stub).status, 'matched');
  assert.equal(payrollBankMatch(state([income({ description: 'Example Company payment', category: 'Other' })]), stub).status, 'matched');
  assert.equal(payrollBankMatch(state([income({ description: 'Other Employer payroll' })]), stub).status, 'unmatched');
  assert.equal(payrollBankMatch(state([income({ description: 'Example Company refund' })]), stub).status, 'unmatched');
  assert.equal(payrollBankMatch(state([income(), income({ id: 'second' })]), stub).status, 'ambiguous');
  assert.equal(payrollBankMatch(state([income({ amountCents: 0 })]), { ...stub, netCents: 0 }).status, 'unmatched');
});

test('a bank deposit cannot count as matched to two imported paystubs', () => {
  const records = state([income()]);
  records.payrollImports = [{ id: 'import', importedAt: '2026-10-01T12:00:00.000Z', schemaVersion: 1, currency: 'CAD', archive: { filename: 'Payroll.zip', sha256: 'a'.repeat(64) }, sources: [], timecards: [], issues: [], paystubs: [stub, { ...stub, id: 'second-employer', employer: 'Another Company' }] }];
  assert.equal(payrollBankMatch(records, stub).status, 'ambiguous');
  assert.equal(payrollBankMatch(records, records.payrollImports[0].paystubs[1]).status, 'ambiguous');
});

test('overlapping timecards form review groups without adding hours or changing source rows', () => {
  const card = (id: string, periodStart: string, periodEnd: string, system: PayrollTimecard['system'] = 'legacy'): PayrollTimecard => ({ id, sourceId: 'image', sourceRow: 1, periodStart, periodEnd, hours: 40, status: 'Approved', submissionDate: null, transferredTo: null, system });
  const cards = [card('new-2', '2026-07-05', '2026-07-11', 'projects'), card('old', '2026-06-25', '2026-07-01'), card('new-1', '2026-06-28', '2026-07-04', 'projects'), card('old-2', '2026-07-02', '2026-07-08'), card('next', '2026-07-12', '2026-07-18', 'projects')];
  const before = structuredClone(cards);
  assert.deepEqual(payrollTimecardOverlaps(cards), [{ periodStart: '2026-06-25', periodEnd: '2026-07-11', timecardIds: ['old', 'new-1', 'old-2', 'new-2'], systems: ['legacy', 'projects'] }]);
  assert.deepEqual(cards, before);
});
