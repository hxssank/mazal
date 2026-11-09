import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Account, AppState, DebtComponent, DebtTerms, StatementRow } from '../shared/types.ts';

const execute = promisify(execFile);
const runtime = process.execPath;

function debt(id: string, balanceCents: number, terms: Partial<DebtTerms> = {}): Account {
  return { id, name: id, entityId: 'personal', type: 'debt', currency: 'CAD', balanceCents, reconciledAt: null, debtTerms: { aprPercent: 5, rateConfirmed: true, minimumPaymentCents: null, notes: '', ...terms } };
}

function splitDebt(id: string, parts: DebtComponent[]): Account {
  return debt(id, 10000, { minimumPaymentCents: 0, repaymentKind: 'fixed', interestStatus: 'unknown', components: parts });
}

test('workbook preserves effective loan rates, excludes paid-off payments and reconciles 300 signed statement rows', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-builder-regression-'));
  const previews = process.env.MAZAL_WORKBOOK_TEST_PREVIEWS;
  if (!previews) t.after(() => rm(directory, { recursive: true, force: true }));
  const rows: StatementRow[] = Array.from({ length: 300 }, (_, index) => {
    const kind = index % 13 === 0 ? 'payment' : index % 7 === 0 ? 'refund' : 'purchase';
    return { id: `row-${index}`, transactionDate: '2026-01-10', postingDate: '2026-01-11', description: `Statement row ${index}`, amountCents: (kind === 'purchase' ? 1 : -1) * (100 + index), kind, category: kind === 'payment' ? 'Payment' : 'Food', sourcePage: 1 };
  });
  const openingBalanceCents = 100000;
  const closingBalanceCents = openingBalanceCents + rows.reduce((total, row) => total + row.amountCents, 0);
  const state: AppState = {
    workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }],
    accounts: [
      debt('card', closingBalanceCents, { minimumPaymentCents: 2500 }),
      debt('paid-known', 0, { minimumPaymentCents: 40000, paymentDueDate: '2026-01-01' }),
      debt('paid-unknown', 0),
      debt('active-unknown', 5000),
      debt('deferred', 10000, { repaymentStatus: 'in_study', repaymentStatusSource: 'owner', minimumPaymentCents: 9999 }),
      debt('study-ended', 10000, { repaymentStatus: 'in_study', repaymentStatusSource: 'owner', studyEndDate: '2026-08-31', minimumPaymentCents: 9999 }),
      debt('repayment-started', 10000, { repaymentStatus: 'in_study', repaymentStatusSource: 'owner', studyEndDate: '2026-01-01', repaymentStartDate: '2026-09-01', minimumPaymentCents: 3000 }),
      splitDebt('split-known', [{ id: 'federal', balanceCents: 7000, aprPercent: null, rateConfirmed: false, interestStatus: 'interest_free' }, { id: 'ontario', balanceCents: 3000, aprPercent: 10, rateConfirmed: true, interestStatus: 'accruing' }]),
      splitDebt('split-unknown-balance', [{ id: 'federal', balanceCents: null, aprPercent: 0, rateConfirmed: true, interestStatus: 'interest_free' }, { id: 'ontario', balanceCents: 3000, aprPercent: 10, rateConfirmed: true, interestStatus: 'accruing' }]),
      splitDebt('split-mismatch', [{ id: 'federal', balanceCents: 5000, aprPercent: 0, rateConfirmed: true, interestStatus: 'interest_free' }, { id: 'ontario', balanceCents: 3000, aprPercent: 10, rateConfirmed: true, interestStatus: 'accruing' }]),
      splitDebt('split-unknown-rate', [{ id: 'federal', balanceCents: 7000, aprPercent: 0, rateConfirmed: true, interestStatus: 'interest_free' }, { id: 'ontario', balanceCents: 3000, aprPercent: null, rateConfirmed: false, interestStatus: 'accruing' }]),
      splitDebt('split-zero-portion', [{ id: 'federal', balanceCents: 10000, aprPercent: null, rateConfirmed: false, interestStatus: 'interest_free' }, { id: 'ontario', balanceCents: 0, aprPercent: null, rateConfirmed: false, interestStatus: 'unknown' }]),
      splitDebt('split-unconfirmed-rate', [{ id: 'federal', balanceCents: 7000, aprPercent: 0, rateConfirmed: true, interestStatus: 'interest_free' }, { id: 'ontario', balanceCents: 3000, aprPercent: 5, rateConfirmed: false, interestStatus: 'accruing' }]),
      splitDebt('split-missing-portion', [{ id: 'federal', balanceCents: 10000, aprPercent: 0, rateConfirmed: true, interestStatus: 'interest_free' }]),
      debt('interest-free', 8000, { minimumPaymentCents: 0, aprPercent: 10, interestStatus: 'interest_free' }),
      debt('interest-unknown', 8000, { minimumPaymentCents: 0, aprPercent: 10, interestStatus: 'unknown' }),
    ],
    transactions: rows.map(row => ({ id: `tx-${row.id}`, accountId: 'card', toAccountId: null, date: row.transactionDate, postingDate: row.postingDate, description: row.description, kind: row.kind === 'payment' ? 'adjustment' : 'expense', amountCents: row.kind === 'payment' ? -row.amountCents : row.amountCents, category: row.category, source: 'Statement', createdAt: '2026-01-12T00:00:00.000Z', statementId: 'statement', statementRowId: row.id })),
    statements: [{ id: 'statement', accountId: 'card', sourceFile: 'statement.pdf', sha256: 'a'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents, closingBalanceCents, rows }],
    obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
  };
  const input = join(directory, 'snapshot.json');
  const output = join(directory, 'regression.xlsx');
  await writeFile(input, JSON.stringify({ state, documents: [], generatedAt: '2026-09-24T12:00:00.000Z' }));
  const { stdout } = await execute(runtime, [fileURLToPath(new URL('../scripts/build-workbook.mjs', import.meta.url)), '--input', input, '--output', output, ...(previews ? ['--previews', previews] : [])], { timeout: 170000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  assert.equal(result.requiredPaymentsCents, 5500);
  assert.equal(result.unknownPayments, 2);
  assert.equal(result.transactions, 300);
  assert.equal(result.statements, 1);
  assert.equal(result.calculationSubtotals, 0);
  assert.equal(result.effectiveAprPercent['split-known'], 3);
  assert.equal(result.effectiveAprPercent['split-unknown-balance'], null);
  assert.equal(result.effectiveAprPercent['split-mismatch'], null);
  assert.equal(result.effectiveAprPercent['split-unknown-rate'], null);
  assert.equal(result.effectiveAprPercent['split-zero-portion'], 0);
  assert.equal(result.effectiveAprPercent['split-unconfirmed-rate'], 1.5);
  assert.equal(result.effectiveAprPercent['split-missing-portion'], null);
  assert.equal(result.effectiveAprPercent['interest-free'], 0);
  assert.equal(result.effectiveAprPercent['interest-unknown'], null);
  assert.equal(result.formulaErrors, 0);
  assert.deepEqual((await readFile(output)).subarray(0, 4), Buffer.from([80, 75, 3, 4]));
  if (previews) console.log(`Workbook review fixture: ${directory}`);
});

test('a personal workbook with no recorded accounts or spending exports empty totals without formula errors', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-builder-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'snapshot.json');
  const output = join(directory, 'empty.xlsx');
  const state: AppState = { workspace: 'live', revision: 0, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
  await writeFile(input, JSON.stringify({ state, documents: [], generatedAt: '2026-09-24T12:00:00.000Z' }));
  const { stdout } = await execute(runtime, [fileURLToPath(new URL('../scripts/build-workbook.mjs', import.meta.url)), '--input', input, '--output', output], { timeout: 170000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  assert.equal(result.netWorthCents, 0);
  assert.equal(result.requiredPaymentsCents, 0);
  assert.equal(result.unknownPayments, 0);
  assert.equal(result.formulaErrors, 0);
  assert.deepEqual(result.categoryTotals, {});
  assert.equal(result.statementCoverage.accountCount, 0);
  assert.deepEqual((await readFile(output)).subarray(0, 4), Buffer.from([80, 75, 3, 4]));
});
