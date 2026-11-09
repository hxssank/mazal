import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { validatePayrollImport, validatePayrollImports, validatePayrollLinks } from './payroll.ts';
import { payrollBankMatch, payrollIssueReview, payrollReconciliation } from '../shared/payroll.ts';
import type { PayrollImport } from '../shared/payroll.ts';
import type { Command } from '../shared/types.ts';

function fixture(): PayrollImport {
  return {
    id: 'import-1', importedAt: '2026-10-01T12:00:00.000Z', schemaVersion: 1, currency: 'CAD', archive: { filename: 'Payroll.zip', sha256: 'a'.repeat(64) },
    sources: [{ id: 'pdf', filename: 'Pay.pdf', sha256: 'b'.repeat(64), mimeType: 'application/pdf', kind: 'paystub', pageCount: 1 }, { id: 'image', filename: 'Hours.png', sha256: 'c'.repeat(64), mimeType: 'image/png', kind: 'timecards', pageCount: 1 }],
    paystubs: [{ id: 'stub', sourceId: 'pdf', sourcePage: 1, payDate: '2026-08-06', periodStart: '2026-07-12', periodEnd: '2026-07-25', sequence: 'TEST001', employer: 'Example Company', payFrequency: 'Biweekly', payRate: '30.1234',
      grossCents: 9037, netCents: 7037, taxCents: 1500, deductionCents: 500, hours: 3,
      earnings: [{ label: 'Regular', hours: 5, rate: '30.1234', amountCents: 15062, ytdHours: 5, ytdAmountCents: 15062 }, { label: 'Advance correction', hours: -2, rate: '30.1234', amountCents: -6025, ytdHours: -2, ytdAmountCents: -6025 }, { label: 'Holiday', hours: null, rate: null, amountCents: null, ytdHours: 0, ytdAmountCents: 0 }],
      taxes: [{ label: 'Tax', amountCents: 1500, ytdAmountCents: 1500 }], deductions: [{ label: 'Union', amountCents: 500, ytdAmountCents: 500 }],
      ytd: { grossCents: 9037, netCents: 7037, taxCents: 1500, deductionCents: 500, hours: 3 }, paymentMethod: 'Deposit', vacationBalanceCents: null, vacationAccruedCents: 362 }],
    timecards: [{ id: 'card', sourceId: 'image', sourceRow: 1, periodStart: '2026-07-12', periodEnd: '2026-07-18', hours: 5, status: 'Approved', submissionDate: '2026-07-20', transferredTo: null, system: 'legacy' }],
    issues: [{ id: 'review', severity: 'review', title: 'Correction recorded', detail: 'The payroll correction is negative. Keep the signed source value.', sourceIds: ['pdf', 'image'], paystubIds: ['stub'], timecardIds: ['card'] }],
  };
}
function setup(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-payroll-'));
  const path = join(directory, 'live.sqlite');
  const stores = [createStore(path, 'live')];
  t.after(() => { for (const store of stores) try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { store: stores[0], reopen: () => { const store = createStore(path, 'live'); stores.push(store); return store; } };
}

test('payroll imports survive retries, restart and backup restore without posting income or replacing planning', t => {
  const { store, reopen } = setup(t);
  const accountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  store.command({ type: 'add_transaction', accountId, kind: 'income', date: '2026-08-06', amountCents: 7037, category: 'Payroll', description: 'PAYROLL DEPOSIT', requestId: 'income' });
  store.command({ type: 'update_pay_schedule', payAmountCents: 90000, payEveryDays: 14, paydayAnchor: '2026-10-01' });
  const before = store.state();
  const original = fixture();
  const command: Command = { type: 'import_payroll', import: original, requestId: 'import-payroll', expectedRevision: before.revision };
  const saved = store.command(command);
  assert.equal(saved.revision, before.revision + 1);
  assert.deepEqual(saved.payrollImports, [original]);
  for (const field of ['accounts', 'transactions', 'obligations', 'roadmap', 'statements', 'importBatches'] as const) assert.deepEqual(saved[field], before[field]);
  assert.deepEqual(store.command(command), saved);
  assert.throws(() => store.command({ ...command, import: { ...original, importedAt: '2026-10-02T12:00:00.000Z' } }), /different operation/);
  const backup = store.export();
  store.close();
  const restarted = reopen();
  assert.deepEqual(restarted.state().payrollImports, [original]);
  assert.deepEqual(restarted.command(command).payrollImports, [original]);
  assert.deepEqual(restarted.restore(backup, restarted.state().revision).payrollImports, [original]);
  assert.deepEqual(restarted.state().accounts, before.accounts);
  const olderBackup = structuredClone(backup);
  delete olderBackup.data.payrollImports;
  assert.deepEqual(restarted.restore(olderBackup, restarted.state().revision).payrollImports, []);
});

test('payroll import rejects stale revisions, missing request identity and duplicates without partial writes', t => {
  const { store } = setup(t);
  const original = fixture();
  const command: Command = { type: 'import_payroll', import: original, requestId: 'import-payroll', expectedRevision: 0 };
  store.command(command);
  const before = store.state();
  assert.throws(() => store.command({ ...command, requestId: 'stale' }), /changed in another window/);
  assert.throws(() => store.command({ ...command, requestId: 'duplicate', expectedRevision: before.revision }), /Duplicate payroll import ID/);
  assert.throws(() => store.command({ ...command, expectedRevision: undefined, requestId: 'missing-revision' }), /current workspace revision/);
  const missingRequest = { ...command, expectedRevision: before.revision } as Record<string, unknown>;
  delete missingRequest.requestId;
  assert.throws(() => store.command(missingRequest as Command), /request ID/);
  assert.deepEqual(store.state(), before);
});

test('new archive names cannot import duplicate original hashes or contradict an existing employer pay period', () => {
  const original = fixture();
  const duplicateArchive = { ...fixture(), id: 'import-2' };
  assert.throws(() => validatePayrollImports([original, duplicateArchive]), /archive SHA-256/);
  const second = fixture();
  second.id = 'import-2'; second.archive.sha256 = 'd'.repeat(64);
  assert.throws(() => validatePayrollImports([original, second]), /source SHA-256/);
  second.sources = second.sources.map((source, index) => ({ ...source, id: source.id + '-2', sha256: (index ? 'e' : 'f').repeat(64) }));
  second.paystubs[0] = { ...second.paystubs[0], id: 'stub-2', sourceId: 'pdf-2', employer: '  EXAMPLE   company ', netCents: 9999 };
  second.timecards[0] = { ...second.timecards[0], id: 'card-2', sourceId: 'image-2' };
  second.issues = [];
  assert.throws(() => validatePayrollImports([original, second]), /employer and pay period/);
});

test('validation preserves source discrepancies, signed adjustments and null cells instead of correcting them', () => {
  const original = fixture();
  original.paystubs[0].grossCents += 1;
  const saved = validatePayrollImport(original);
  assert.deepEqual(saved, original);
  assert.equal(payrollReconciliation(saved.paystubs[0]).grossDifferenceCents, 1);
  assert.equal(saved.paystubs[0].earnings[1].hours, -2);
  assert.equal(saved.paystubs[0].earnings[2].amountCents, null);
});

test('validation rejects broken source references, unsafe source names, invalid dates and nonfinite money or hours', () => {
  const edits: Array<(value: PayrollImport) => void> = [
    value => { value.sources[0].filename = '../Pay.pdf'; }, value => { value.sources[0].filename = 'CON.pdf'; },
    value => { value.sources[0].sha256 = 'abc'; }, value => { value.sources[0].mimeType = 'image/png'; },
    value => { value.paystubs[0].sourceId = 'missing'; }, value => { value.paystubs[0].sourcePage = 2; },
    value => { value.paystubs[0].payDate = '2026-02-30'; }, value => { value.paystubs[0].periodEnd = '2026-01-01'; },
    value => { value.paystubs[0].netCents = 1.5; }, value => { value.paystubs[0].grossCents = Number.MAX_SAFE_INTEGER; },
    value => { value.paystubs[0].hours = Infinity; }, value => { value.paystubs[0].payRate = '3e1'; },
    value => { value.timecards[0].sourceId = 'pdf'; }, value => { value.timecards[0].submissionDate = '2026-13-01'; },
    value => { value.issues[0].paystubIds = ['missing']; }, value => { value.importedAt = '2026-10-01'; },
  ];
  for (const edit of edits) { const invalid = fixture(); edit(invalid); assert.throws(() => validatePayrollImport(invalid)); }
});

test('backup restore rejects broken payroll references before replacing existing financial records', t => {
  const { store } = setup(t);
  store.command({ type: 'import_payroll', import: fixture(), requestId: 'payroll', expectedRevision: 0 });
  const backup = store.export();
  const before = store.state();
  backup.data.payrollImports![0].issues[0].sourceIds = ['missing'];
  assert.throws(() => store.restore(backup, before.revision), /missing source ID/);
  assert.deepEqual(store.state(), before);
});

test('confirmed deposit links retain note history, survive restart and cannot reuse a bank deposit', t => {
  const { store, reopen } = setup(t);
  const accountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-01-01' }).accounts[0].id;
  const transactionId = store.command({ type: 'add_transaction', accountId, kind: 'income', date: '2026-08-07', amountCents: 7037, category: 'Salary', description: 'EMPLOYER', requestId: 'deposit' }).transactions[0].id;
  const payroll = fixture();
  payroll.sources[0].pageCount = 2;
  payroll.paystubs.push({ ...structuredClone(payroll.paystubs[0]), id: 'second-stub', sourcePage: 2, employer: 'Second employer' });
  store.command({ type: 'import_payroll', import: payroll, requestId: 'import', expectedRevision: store.state().revision });
  const before = store.state();
  const command: Command = { type: 'link_payroll_deposit', importId: payroll.id, paystubId: 'stub', transactionId, note: 'Checked employer and posting date against the bank statement.', requestId: 'link', expectedRevision: before.revision };
  const linked = store.command(command);
  assert.deepEqual(linked.accounts, before.accounts);
  assert.deepEqual(linked.transactions, before.transactions);
  assert.deepEqual(store.command(command), linked);
  const event = linked.payrollImports![0].bankLinks![0];
  assert.equal(event.note, command.note);
  assert.match(event.reviewedAt, /^\d{4}-.*Z$/);
  assert.equal(payrollBankMatch(linked, payroll.paystubs[0]).status, 'confirmed');
  assert.throws(() => store.command({ ...command, paystubId: 'second-stub', requestId: 'reuse', expectedRevision: linked.revision }), /Duplicate confirmed payroll deposit/);
  store.close();
  const restarted = reopen();
  assert.deepEqual(restarted.state().payrollImports, linked.payrollImports);
  const unlinked = restarted.command({ type: 'unlink_payroll_deposit', importId: payroll.id, paystubId: 'stub', note: 'Reopened to check employer name.', requestId: 'unlink', expectedRevision: linked.revision });
  assert.equal(unlinked.payrollImports![0].bankLinks!.length, 2);
  assert.deepEqual(unlinked.payrollImports![0].bankLinks![0], event);
  assert.equal(unlinked.payrollImports![0].bankLinks![1].transactionId, null);
  assert.deepEqual(unlinked.transactions, before.transactions);
});

test('deposit confirmation rejects wrong amount, debt accounts, reversed income and forged imported reviews', t => {
  const { store } = setup(t);
  const accountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-01-01' }).accounts[0].id;
  store.command({ type: 'add_transaction', accountId, kind: 'income', date: '2026-08-06', amountCents: 7038, category: 'Salary', description: 'Payroll', requestId: 'deposit' });
  store.command({ type: 'import_payroll', import: fixture(), requestId: 'import', expectedRevision: store.state().revision });
  const before = store.state();
  assert.throws(() => store.command({ type: 'link_payroll_deposit', importId: 'import-1', paystubId: 'stub', transactionId: before.transactions[0].id, note: 'Checked.', requestId: 'bad-link', expectedRevision: before.revision }), /exactly the paystub net amount/);
  assert.deepEqual(store.state(), before);
  const imported = fixture();
  imported.bankLinks = [{ id: 'event', paystubId: 'stub', transactionId: 'deposit', reviewedAt: '2026-10-02T12:00:00.000Z', note: 'Checked.' }];
  const state = { ...before, transactions: [{ ...before.transactions[0], id: 'deposit', amountCents: 7037 }], payrollImports: [imported] };
  validatePayrollLinks([imported], state);
  assert.throws(() => validatePayrollLinks([imported], { ...state, accounts: state.accounts.map(account => ({ ...account, type: 'debt' })) }), /cash income/);
  assert.throws(() => validatePayrollLinks([imported], { ...state, transactions: [...state.transactions, { ...state.transactions[0], id: 'reversal', amountCents: -7037, reversalOf: 'deposit' }] }), /Unlink/);
  imported.id = 'forged';
  assert.throws(() => store.command({ type: 'import_payroll', import: imported, requestId: 'forged-import', expectedRevision: before.revision }), /source records first/);
});

test('payroll issues resolve and reopen with immutable notes, including calculated discrepancies', t => {
  const { store, reopen } = setup(t);
  const original = fixture(); original.paystubs[0].netCents += 1;
  store.command({ type: 'import_payroll', import: original, requestId: 'import', expectedRevision: 0 });
  const before = store.state();
  const resolved = store.command({ type: 'review_payroll_issue', importId: original.id, issueId: 'reconciliation-stub', status: 'resolved', note: 'Employer confirmed a one-cent rounding adjustment.', requestId: 'resolve', expectedRevision: before.revision });
  assert.equal(payrollIssueReview(resolved.payrollImports![0], 'reconciliation-stub')?.status, 'resolved');
  assert.deepEqual(resolved.payrollImports![0].paystubs, before.payrollImports![0].paystubs);
  assert.throws(() => store.command({ type: 'review_payroll_issue', importId: original.id, issueId: 'missing', status: 'resolved', note: 'Checked.', requestId: 'missing', expectedRevision: resolved.revision }), /not found/);
  store.close();
  const restarted = reopen();
  const opened = restarted.command({ type: 'review_payroll_issue', importId: original.id, issueId: 'reconciliation-stub', status: 'open', note: 'Requested a corrected original.', requestId: 'reopen', expectedRevision: resolved.revision });
  assert.equal(opened.payrollImports![0].issueReviews!.length, 2);
  assert.equal(payrollIssueReview(opened.payrollImports![0], 'reconciliation-stub')?.status, 'open');
  assert.deepEqual(opened.accounts, before.accounts);
  assert.deepEqual(opened.transactions, before.transactions);
  const badBackup = restarted.export();
  const beforeRestore = restarted.state();
  badBackup.data.payrollImports![0].issueReviews![0].issueId = 'missing';
  assert.throws(() => restarted.restore(badBackup, opened.revision), /missing issue/);
  assert.deepEqual(restarted.state(), beforeRestore);
});
