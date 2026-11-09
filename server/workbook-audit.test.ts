import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectWorkbook } from './workbook-inspect.ts';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Account, AppState, StatementImport } from '../shared/types.ts';

const execute = promisify(execFile);
const runtime = process.execPath;

interface Cell { value: string | number | null; formula: string | null; type: string }
type Sheets = Record<string, Record<string, Cell>>;


function account(id: string, type: Account['type'], balanceCents: number, entityId = 'personal'): Account {
  return { id, entityId, name: id, type, currency: 'CAD', balanceCents, reconciledAt: null };
}

function statement(id: string, rowId: string, amountCents: number, page: number): StatementImport {
  return {
    id, accountId: 'card', sourceFile: `${id}.pdf`, sha256: String(page).repeat(64),
    periodStart: '2026-09-01', periodEnd: '2026-09-24', openingBalanceCents: 0, closingBalanceCents: amountCents,
    rows: [{ id: rowId, transactionDate: '2026-09-20', postingDate: '2026-09-21', description: `Purchase ${page}`, amountCents, kind: 'purchase', category: page === 1 ? 'Uncategorized' : 'Food', sourcePage: page }],
  };
}

function fixture(): AppState {
  const statements = [statement('a:b', 'c', 1000, 1), statement('a', 'b:c', 2000, 2)];
  return {
    workspace: 'live', revision: 1,
    entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'business', name: 'Business private owner', kind: 'business', ownershipBps: 5000 }],
    accounts: [
      { ...account('cash', 'cash', 5000), reconciledAt: '2026-09-20', evidence: { balanceCents: 7000, asOf: '2026-09-01', capturedOn: '2026-09-24', status: 'bank', sourceFile: 'Bank.pdf', notes: 'Original bank balance before later recorded activity.' } },
      { ...account('card', 'debt', 3000), evidence: { balanceCents: 0, asOf: '2026-09-02', capturedOn: '2026-09-24', status: 'credit_report', sourceFile: 'Credit report.pdf', notes: 'Reported source amount needs current lender confirmation.' }, debtTerms: { aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 0, notes: '' } },
      { ...account('student', 'debt', 10000), debtTerms: { aprPercent: 10, rateConfirmed: true, minimumPaymentCents: 1000, notes: '', interestStatus: 'interest_free', repaymentStatus: 'in_study', repaymentStatusSource: 'lender', studyEndDate: '2026-09-24' } },
      account('Business private cash', 'cash', 500000, 'business'),
      account('Business private investment', 'investment', 12345, 'business'),
      { ...account('Business private debt', 'debt', 40000, 'business'), debtTerms: { aprPercent: 15, rateConfirmed: true, minimumPaymentCents: 3000, notes: '' } },
    ],
    transactions: [
      ...statements.map((source, index) => ({ id: `transaction-${index}`, accountId: 'card', toAccountId: null, date: source.rows[0].transactionDate, postingDate: source.rows[0].postingDate, description: source.rows[0].description, kind: 'expense' as const, amountCents: source.rows[0].amountCents, category: source.rows[0].category, ...(index === 0 ? { expenseCategory: 'Bills' } : {}), source: 'Statement', createdAt: '2026-09-21T00:00:00.000Z', statementId: source.id, statementRowId: source.rows[0].id })),
      { id: 'business-transaction', accountId: 'Business private cash', toAccountId: null, date: '2026-09-20', description: 'Business private transaction', kind: 'expense', amountCents: 10000, category: 'Food', source: 'Statement', createdAt: '2026-09-20T00:00:00.000Z', statementId: 'business-statement', statementRowId: 'business-row' },
    ],
    statements: [...statements, { ...statement('business-statement', 'business-row', 10000, 3), accountId: 'Business private cash' }],
    importBatches: [{ id: 'business-import', source: { ...statement('business-import', 'import-row', 5000, 4), accountId: 'Business private cash', sourceFile: 'Business private import.pdf' }, decisions: [], status: 'staged', createdAt: '2026-09-24T00:00:00.000Z', committedAt: null }],
    obligations: [{ id: 'business-bill', entityId: 'business', name: 'Business private bill', amountCents: 5000, dueDate: '2026-09-26', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'Business private cash', category: 'Bills' }],
    reserves: [{ id: 'business-reserve', entityId: 'business', name: 'Business private reserve', amountCents: 4000 }],
    positions: [{ id: 'business-position', accountId: 'Business private investment', liquidSol: '1', stakedSol: '2', rewardsSol: '0', costBasisCents: 10000, priceCents: 5000, priceDate: '2026-09-24' }],
    moneyOwed: [{ id: 'owed', entityId: 'personal', name: 'Personal receivable', amountCents: 3000, payments: [], comment: '' }, { id: 'business-owed', entityId: 'business', name: 'Business private receivable', amountCents: 30000, payments: [], comment: '' }],
    assetPurchases: [{ id: 'purchase', entityId: 'personal', name: 'Personal purchase', payee: 'Seller', targetCents: 9000, monthlyCents: 1000, paidCents: 4000, paidAsOf: '2026-09-24', notes: '' }, { id: 'business-purchase', entityId: 'business', name: 'Business private purchase', payee: 'Seller', targetCents: 90000, monthlyCents: 10000, paidCents: 40000, paidAsOf: '2026-09-24', notes: '' }],
    assets: [{ id: 'held', entityId: 'personal', name: 'Personal item', category: 'Other', purchaseDate: '2026-01-01', costCents: 3000, estimatedValueCents: 2000, feesCents: 0, status: 'owned', soldDate: null, saleCents: null, notes: '' }, { id: 'business-held', entityId: 'business', name: 'Business private item', category: 'Other', purchaseDate: '2026-01-01', costCents: 30000, estimatedValueCents: 20000, feesCents: 0, status: 'owned', soldDate: null, saleCents: null, notes: '' }],
    expenseFunds: [{ id: 'business-fund', entityId: 'business', name: 'Business private fund', targetCents: 10000, savedCents: 1000, targetDate: '2026-12-01' }],
    expensePlanItems: [{ id: 'business-plan', entityId: 'business', name: 'Business private spending', amountCents: 2000, date: '2026-10-01', notes: '', categoryId: 'business:food' }],
    wishItems: [{ id: 'business-wish', entityId: 'business', name: 'Business private wish', costCents: 50000, comment: '' }],
    spendingLimits: [
      { id: 'business:food', entityId: 'business', name: 'Business private budget', dailyCents: null, weeklyCents: null, monthlyCents: 10000, aliases: ['Food'], color: '#112233' },
      { id: 'personal:food', entityId: 'personal', name: 'Food', dailyCents: 1000, weeklyCents: 5000, monthlyCents: 30000, monthlyAmounts: { '2026-08': null, '2026-09': 25000, '2026-10': 0 }, aliases: ['Groceries'], color: '#112233' },
    ],
    sourceFacts: [
      { id: 'payday-confirmation', label: 'Confirmed payday', value: '$1,750 received', asOf: '2026-09-24', sourceFile: 'Owner confirmation', note: 'The owner confirmed this deposit arrived.' },
      { id: 'september-commitments', label: 'September commitments', value: '$600 remaining', asOf: '2026-09-24', sourceFile: 'Owner confirmation', note: 'The car payment was paid. Only the remaining commitment is outstanding.' },
      { id: 'source-error-text', label: 'Unresolved source field', value: '#N/A', asOf: null, sourceFile: 'Owner confirmation', note: 'The original source contains this literal value.' },
    ],
    roadmap: { currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: '2027-01-01', transitionMonths: 4, monthlyExtraDebtCents: 0, loanAccountId: 'student', loanAprPercent: 10, loanMonthlyPaymentCents: null },
    audit: [], lastBackupAt: null,
  };
}

function rowFor(sheets: Sheets, name: string, label: string): number {
  const cell = Object.entries(sheets[name]).find(([reference, cell]) => /^A\d+$/.test(reference) && cell.value === label);
  assert.ok(cell, `${name} must contain ${label}`);
  return Number(cell[0].slice(1));
}

function columnFor(sheets: Sheets, name: string, label: string): string {
  const cell = Object.entries(sheets[name]).find(([, cell]) => cell.value === label);
  assert.ok(cell, `${name} must contain the ${label} column`);
  return cell[0].replace(/\d+/g, '');
}

test('workbook keeps saved meaning and personal records across export edge cases', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-workbook-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = fixture();
  state.roadmap!.temporaryWorkSchedule = { weeklyHours: 15, fullTimeWeeklyHours: 37.5, returnDate: '2027-09-01', payPeriodEndLagDays: 8 };
  state.roadmap!.payAmountCents = 180000;
  state.transactions[0].displayName = 'Home internet';
  state.transactions[0].note = 'Monthly service for the apartment';
  state.assets!.push(
    { id: 'unknown-item', entityId: 'personal', name: 'Unknown resale item', category: 'Tools', purchaseDate: null, costCents: null, estimatedValueCents: null, feesCents: 0, status: 'owned', soldDate: null, saleCents: null, notes: 'Cost and resale value not confirmed.' },
    { id: 'zero-item', entityId: 'personal', name: 'Zero resale item', category: 'Tools', purchaseDate: null, costCents: 10000, estimatedValueCents: 0, feesCents: 0, status: 'owned', soldDate: null, saleCents: null, notes: '' },
  );
  state.wishItems!.push(
    { id: 'essential-wish', entityId: 'personal', name: 'Glasses', costCents: null, priority: 'essential', comment: 'Price unconfirmed.' },
    { id: 'optional-wish', entityId: 'personal', name: 'Free optional item', costCents: 0, priority: 'optional', comment: '' },
  );
  const input = join(directory, 'snapshot.json');
  const output = join(directory, 'audit.xlsx');
  await writeFile(input, JSON.stringify({ state, documents: [], generatedAt: '2026-09-25T01:30:00.000Z' }));
  const { stdout } = await execute(runtime, [fileURLToPath(new URL('../scripts/build-workbook.mjs', import.meta.url)), '--input', input, '--output', output], { env: { ...process.env, TZ: 'America/Toronto' }, timeout: 170000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  const inspected = await inspectWorkbook(output);
  const cells: Sheets = Object.fromEntries(Object.entries(inspected.sheets).map(([name, sheet]) => [name, sheet.cells]));
  const headers = Object.values(inspected.tables).flatMap(table => table.headers);

  await t.test('the plan exports both work schedules, the payroll lag and the estimated part-time deposit', () => {
    const value = (label: string) => cells.Plan[`B${rowFor(cells, 'Plan', label)}`].value;
    assert.equal(value('Part-time weekly hours'), 15);
    assert.equal(value('Full-time weekly hours'), 37.5);
    assert.equal(value('Return to full-time work'), (Date.UTC(2027, 8, 1) - Date.UTC(1899, 11, 30)) / 86400000);
    assert.equal(value('Pay period end to payday'), 8);
    assert.equal(value('Part-time take-home estimate'), 720);
  });

  await t.test('unknown asset values and dates export blank while zero values and purchase priorities survive', () => {
    const unknown = rowFor(cells, 'Owned items', 'Unknown resale item');
    const zero = rowFor(cells, 'Owned items', 'Zero resale item');
    assert.equal(cells['Owned items'][`C${unknown}`]?.value ?? null, null);
    assert.equal(cells['Owned items'][`D${unknown}`]?.value ?? null, null);
    assert.ok([null, ''].includes(cells['Owned items'][`H${unknown}`]?.value as null | string));
    assert.equal(cells['Owned items'][`J${unknown}`]?.value ?? null, null);
    assert.equal(cells['Owned items'][`D${zero}`].value, 0);
    assert.equal(cells['Owned items'][`H${zero}`].value, 0);
    const essential = rowFor(cells, 'Wish list', 'Glasses');
    const optional = rowFor(cells, 'Wish list', 'Free optional item');
    assert.equal(cells['Wish list'][`B${essential}`]?.value ?? null, null);
    assert.equal(cells['Wish list'][`C${essential}`].value, 'Essential\nPrice unconfirmed.');
    assert.equal(cells['Wish list'][`B${optional}`].value, 0);
    assert.equal(cells['Wish list'][`C${optional}`].value, 'Optional');
  });

  await t.test('recorded balances retain their separate source amount and date without turning a source date into confirmation', () => {
    const serial = (value: string) => (Date.parse(`${value}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
    const cash = rowFor(cells, 'Accounts', 'cash');
    assert.equal(cells.Accounts[`C${cash}`].value, 50);
    assert.equal(cells.Accounts[`D${cash}`].value, serial('2026-09-20'));
    assert.equal(cells.Accounts[`G${cash}`].value, 'cash', 'Existing account ID column must retain its location.');
    assert.equal(cells.Accounts[`H${cash}`].value, 70);
    assert.equal(cells.Accounts[`I${cash}`].value, serial('2026-09-01'));
    const card = rowFor(cells, 'Accounts', 'card');
    assert.equal(cells.Accounts[`C${card}`].value, 30);
    assert.equal(cells.Accounts[`D${card}`]?.value ?? null, null);
    assert.equal(cells.Accounts[`H${card}`].value, 0);
    assert.equal(cells.Accounts[`I${card}`].value, serial('2026-09-02'));
    const student = rowFor(cells, 'Accounts', 'student');
    assert.equal(cells.Accounts[`H${student}`]?.value ?? null, null);
    assert.equal(cells.Accounts[`I${student}`]?.value ?? null, null);
  });

  await t.test('budgets export dated amounts and the undated fallback without losing zero or unset', () => {
    for (const [label, expected] of [['Undated baseline', 300], ['2026-08', null], ['2026-09', 250], ['2026-10', 0]] as const) {
      const entry = Object.entries(cells.Budgets).find(([reference, cell]) => /^B\d+$/.test(reference) && cell.value === label);
      assert.ok(entry, `Budget ${label} is present`);
      const row = entry[0].slice(1);
      assert.equal(cells.Budgets[`A${row}`].value, 'Food');
      assert.equal(cells.Budgets[`C${row}`]?.value ?? null, expected);
    }
  });

  await t.test('a saved scenario APR stays distinct from an interest-free effective APR', () => {
    assert.equal(cells.Plan[`B${rowFor(cells, 'Plan', 'Selected debt APR')}`].value, 0.1);
    assert.equal(result.effectiveAprPercent.student, 0);
    assert.equal(result.scenarioAprPercent, 10);
  });

  await t.test('debt status uses the local date before midnight in Toronto', () => {
    assert.equal(result.asOfDate, '2026-09-24');
    const row = rowFor(cells, 'Debts', 'student');
    assert.equal(cells.Debts[`D${row}`].value, 0);
    assert.equal(result.unknownPayments, 0);
    assert.equal(result.requiredPaymentsCents, 0);
  });

  await t.test('the stored report category overrides raw Uncategorized', () => {
    const row = Object.entries(cells.Transactions).find(([, cell]) => cell.value === 'transaction-0')?.[0].replace(/\D+/g, '');
    assert.ok(row);
    assert.equal(cells.Transactions[`${columnFor(cells, 'Transactions', 'Imported category')}${row}`].value, 'Uncategorized');
    assert.equal(cells.Transactions[`${columnFor(cells, 'Transactions', 'Category')}${row}`].value, 'Bills');
    assert.equal(cells.Expenses[`B${rowFor(cells, 'Expenses', 'Bills')}`].value, 10);
  });

  await t.test('transaction names and notes export beside unchanged source descriptions', () => {
    const row = Object.entries(cells.Transactions).find(([, cell]) => cell.value === 'transaction-0')?.[0].replace(/\D+/g, '');
    assert.ok(row);
    assert.equal(cells.Transactions[`${columnFor(cells, 'Transactions', 'Description')}${row}`].value, state.transactions[0].description);
    assert.equal(cells.Transactions[`${columnFor(cells, 'Transactions', 'Name')}${row}`].value, 'Home internet');
    assert.equal(cells.Transactions[`${columnFor(cells, 'Transactions', 'Notes')}${row}`].value, 'Monthly service for the apartment');
  });

  await t.test('ordinary uncategorized rows remain visible when no reporting snapshot exists', async () => {
    const unclassified = fixture();
    delete unclassified.transactions[0].expenseCategory;
    const unclassifiedInput = join(directory, 'unclassified.json');
    const unclassifiedOutput = join(directory, 'unclassified.xlsx');
    await writeFile(unclassifiedInput, JSON.stringify({ state: unclassified, documents: [], generatedAt: '2026-09-25T01:30:00.000Z' }));
    const exported = await execute(runtime, [fileURLToPath(new URL('../scripts/build-workbook.mjs', import.meta.url)), '--input', unclassifiedInput, '--output', unclassifiedOutput], { env: { ...process.env, TZ: 'America/Toronto' }, timeout: 170000, maxBuffer: 1024 * 1024 });
    const summary = JSON.parse(exported.stdout.trim().split('\n').at(-1)!);
    assert.deepEqual(summary.categoryTotals, { Food: 2000, Uncategorized: 1000 });
  });

  await t.test('statement identifiers cannot collide when they contain colons', () => {
    assert.equal(result.statements, 2);
    for (const [label, expected] of [['ST01', 10], ['ST02', 20]] as const) {
      const row = rowFor(cells, 'Sources', label);
      assert.equal(cells.Sources[`F${row}`].value, expected);
      assert.equal(cells.Sources[`H${row}`].value, 0);
    }
    const sourceColumn = columnFor(cells, 'Transactions', 'Source');
    const sourceLabels = Object.entries(cells.Transactions).filter(([key]) => key.replace(/\d+/g, '') === sourceColumn).map(([, cell]) => cell.value);
    assert.ok(sourceLabels.includes('ST01, p. 1'));
    assert.ok(sourceLabels.includes('ST02, p. 2'));
  });

  await t.test('personal exports omit business rows and redundant ownership columns', () => {
    const values = Object.values(cells).flatMap(sheet => Object.values(sheet).map(cell => cell.value));
    assert.equal(values.some(value => typeof value === 'string' && value.includes('Business private')), false);
    for (const label of ['Business cash', 'Your share', 'Your amount', 'Your equity', 'Your receivable', 'Your value']) assert.equal(values.includes(label), false, `${label} should not appear in a personal export`);
    assert.equal(headers.includes('Owner'), false, 'Tables should not have an Owner column');
    assert.equal(cells.Investments, undefined);
    assert.equal(result.exportScope, 'personal');
    assert.equal(result.transactions, 2);
    assert.equal(result.netWorthCents, 1000);
    assert.equal(cells.Home[`B${rowFor(cells, 'Home', 'Net worth')}`].value, 10);
  });

  await t.test('reported source facts retain the user-recorded values and qualifications', () => {
    for (const fact of state.sourceFacts!) {
      const row = rowFor(cells, 'Reported figures', fact.label);
      assert.equal(cells['Reported figures'][`B${row}`].value, fact.value);
      assert.equal(cells['Reported figures'][`E${row}`].value, fact.note);
    }
    assert.equal(result.formulaErrors, 0);
    for (const [name, sheet] of Object.entries(cells)) for (const [reference, cell] of Object.entries(sheet)) assert.notEqual(cell.type, 'e', `${name}!${reference} contains ${cell.value}`);
  });
});
