import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectWorkbook } from './workbook-inspect.ts';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Account, AppState, StatementImport, Transaction } from '../shared/types.ts';

const execute = promisify(execFile);
const runtime = process.execPath;
const builder = fileURLToPath(new URL('../scripts/build-workbook.mjs', import.meta.url));

interface Cell { value: string | number | null; formula: string | null; type: string; style: string }
interface Sheet { id: string; relationship: string; cells: Record<string, Cell>; pane: Record<string, string> | null; columns: Record<string, string>[]; tables: string[] }
interface Table { sheet: string; id: string; reference: string; headers: string[]; rows: Record<string, Cell>[]; style: Record<string, string> | null }
interface WorkbookXml { sheets: Record<string, Sheet>; tables: Record<string, Table> }


function account(id: string, balanceCents: number, type: Account['type'] = 'cash'): Account {
  return { id, name: `Account ${id}`, entityId: 'personal', type, currency: 'CAD', balanceCents, reconciledAt: '2026-09-24', ...(type === 'debt' ? { debtTerms: { aprPercent: 5, rateConfirmed: true, minimumPaymentCents: 2500, paymentDueDate: '2026-10-01', notes: '' } } : {}) };
}

function transaction(index: number): Transaction {
  const date = new Date(Date.UTC(2026, 0, 1 + index % 267)).toISOString().slice(0, 10);
  return { id: `transaction-${index}`, accountId: 'cash', toAccountId: null, date, description: `Purchase ${index}`, kind: 'expense', amountCents: index % 17 === 0 ? -225 : 100 + index, category: index % 3 === 0 ? 'Food' : 'Transport', source: 'Manual entry', createdAt: `${date}T12:00:00.000Z` };
}

function statement(id: string, date: string, amountCents: number): StatementImport {
  return { id, accountId: 'card', sourceFile: `${id}.pdf`, sha256: id.padEnd(64, '0'), periodStart: date.slice(0, 8) + '01', periodEnd: date, openingBalanceCents: 0, closingBalanceCents: amountCents, rows: [{ id: `row-${id}`, transactionDate: date, postingDate: date, description: `Statement ${id}`, amountCents, kind: 'purchase', category: 'Food', sourcePage: 1 }] };
}

function fixture(grown = false): AppState {
  const statements = grown ? [statement('older', '2025-12-31', 300), statement('kept', '2026-09-20', 1750)] : [statement('removed', '2026-08-31', 500), statement('kept', '2026-09-20', 1000)];
  const transactions = Array.from({ length: grown ? 720 : 12 }, (_, index) => transaction(index + (grown ? 1 : 0)));
  transactions[0] = { ...transactions[0], description: grown ? 'Changed purchase' : transactions[0].description, amountCents: grown ? 3210 : transactions[0].amountCents, ...(grown ? { expenseCategory: 'Bills' } : {}) };
  return {
    workspace: 'live', revision: grown ? 2 : 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }],
    accounts: grown ? [account('added', 20000), account('card', 10000, 'debt'), { ...account('cash', 75000), name: 'Renamed cash' }] : [account('cash', 50000), account('card', 10000, 'debt'), account('removed', 3000)],
    transactions: [...transactions.reverse(), ...statements.map(item => ({ id: `transaction-${item.id}`, accountId: 'card', toAccountId: null, date: item.rows[0].transactionDate, postingDate: item.rows[0].postingDate, description: item.rows[0].description, kind: 'expense' as const, amountCents: item.rows[0].amountCents, category: 'Food', source: 'Statement', createdAt: '2026-09-24T12:00:00.000Z', statementId: item.id, statementRowId: item.rows[0].id }))],
    statements,
    obligations: Array.from({ length: grown ? 35 : 1 }, (_, index) => ({ id: `bill-${index}`, entityId: 'personal', name: `Bill ${index}`, amountCents: 1250 + index, dueDate: '2026-10-01', direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Bills' })),
    reserves: Array.from({ length: grown ? 25 : 1 }, (_, index) => ({ id: `reserve-${index}`, entityId: 'personal', name: `Reserve ${index}`, amountCents: 500 + index })),
    moneyOwed: [{ id: 'owed', entityId: 'personal', name: 'Repayment fixture', amountCents: 10000, comment: '', payments: [{ id: 'repayment', amountCents: grown ? 2750 : 1500, date: '2026-09-01', comment: '' }] }],
    assetPurchases: [{ id: 'purchase', entityId: 'personal', name: 'Purchase fixture', payee: 'Seller', targetCents: 40000, monthlyCents: 2000, paidCents: grown ? 10000 : 8000, paidAsOf: '2026-09-01', notes: '' }],
    assets: [{ id: 'item', entityId: 'personal', name: 'Owned fixture', category: 'Other', purchaseDate: '2026-01-01', costCents: 4000, estimatedValueCents: 3000, status: 'owned', soldDate: null, saleCents: null, feesCents: 100, notes: '' }],
    expenseFunds: [{ id: 'fund', entityId: 'personal', name: 'Savings fixture', targetCents: 10000, savedCents: 2500, targetDate: '2026-12-01' }],
    expensePlanItems: [{ id: 'planned', entityId: 'personal', name: 'Planned fixture', categoryId: 'personal:food', amountCents: 2500, date: '2026-10-01', notes: '' }],
    wishItems: [{ id: 'wish', entityId: 'personal', name: 'Wish fixture', costCents: 20000, comment: '' }],
    sourceFacts: [{ id: 'fact', label: 'Recorded fixture', value: grown ? 'Changed value' : 'Initial value', asOf: '2026-09-24', sourceFile: 'Owner confirmation', note: '' }],
    positions: [], audit: [], lastBackupAt: null,
  };
}

async function inspect(path: string): Promise<WorkbookXml> {
  return inspectWorkbook(path);
}

async function exportSnapshot(directory: string, state: AppState, name: string, existing?: string) {
  const input = join(directory, `${name}.json`);
  const output = join(directory, `${name}.xlsx`);
  await writeFile(input, JSON.stringify({ state, documents: [], generatedAt: '2026-09-24T12:00:00.000Z' }));
  const { stdout } = await execute(runtime, [builder, '--input', input, '--output', output, ...(existing ? ['--existing', existing] : [])], { timeout: 170000, maxBuffer: 1024 * 1024 });
  return { output, xml: await inspect(output), summary: JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown> };
}

function cellBeside(xml: WorkbookXml, sheetName: string, label: string): Cell {
  const sheet = xml.sheets[sheetName];
  const labelEntry = Object.entries(sheet.cells).find(([reference, cell]) => /^A\d+$/.test(reference) && cell.value === label);
  assert.ok(labelEntry, `${sheetName} must include ${label}`);
  return sheet.cells[`B${labelEntry[0].slice(1)}`];
}

function assertNoFormulaErrors(xml: WorkbookXml): void {
  for (const [name, sheet] of Object.entries(xml.sheets)) for (const [reference, cell] of Object.entries(sheet.cells)) assert.notEqual(cell.type, 'e', `${name}!${reference} contains ${cell.value}`);
}

test('workbook tables grow, refresh by record ID, shrink, and include appended rows in summaries', { timeout: 540000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-workbook-scaling-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await exportSnapshot(directory, fixture(), 'original');
  const state = fixture(true);
  const grown = await exportSnapshot(directory, state, 'grown', original.output);

  await t.test('separate named tables accept new and earlier records without stale rows or misplaced links', () => {
    const ledger = grown.xml.tables.TableTransactions;
    assert.ok(ledger, 'Transactions must have a stable named table');
    assert.equal(ledger.rows.length, state.transactions.length);
    assert.deepEqual(new Set(ledger.rows.map(row => row['Transaction ID'].value)), new Set(state.transactions.map(transaction => transaction.id)));
    assert.equal(ledger.rows.some(row => row['Transaction ID'].value === 'transaction-0'), false);
    const changed = ledger.rows.find(row => row['Transaction ID'].value === 'transaction-1')!;
    assert.equal(changed.Description.value, 'Changed purchase');
    assert.equal(changed.Amount.value, 32.1);
    assert.equal(changed.Category.value, 'Bills');
    assert.equal(changed['Imported category'].value, 'Transport');
    const dates = ledger.rows.map(row => row.Date.value as number);
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'Unsorted and backdated inputs must export newest first');
    assert.equal(ledger.rows.at(-1)!['Transaction ID'].value, 'transaction-older');

    const accounts = grown.xml.tables.TableAccounts;
    assert.deepEqual(new Set(accounts.rows.map(row => row['Account ID'].value)), new Set(state.accounts.map(account => account.id)));
    assert.equal(accounts.rows.find(row => row['Account ID'].value === 'cash')!.Balance.value, 750);
    assert.equal(cellBeside(grown.xml, 'Home', 'Personal cash').value, 950);
    assert.equal(changed.Account.value, 'Renamed cash');
    assert.equal(Math.round(Number(cellBeside(grown.xml, 'Expenses', 'All recorded expenses').value) * 100), state.transactions.reduce((sum, transaction) => sum + transaction.amountCents, 0));
    assert.equal(grown.summary.formulaErrors, 0);
    assertNoFormulaErrors(grown.xml);

    for (const [tableName, expected] of [['TableBills', 35], ['TableReserves', 25], ['TableRepayments', 1], ['TableReceivables', 1], ['TableOwneditems', 1], ['TableSources', 2]] as const) {
      const table = grown.xml.tables[tableName];
      assert.ok(table, `${tableName} must exist`);
      assert.equal(table.rows.length, expected);
      assert.deepEqual(grown.xml.sheets[table.sheet].tables, [tableName], `${table.sheet} needs room to grow without another table below it`);
    }
    assert.equal(grown.xml.tables.TableRepayments.rows[0].Amount.value, 27.5);
    assert.equal(cellBeside(grown.xml, 'Home', 'Owed to you').value, 72.5);
    for (const row of grown.xml.tables.TableSources.rows) assert.equal(row.Difference.value, 0, 'Reordered statement IDs must still reconcile');
    const movement = new Map(grown.xml.tables.TableSources.rows.map(row => [row['Statement ID'].value, row['Ledger movement'].value]));
    assert.deepEqual(movement, new Map([['kept', 17.5], ['older', 3]]));
    const sourceValues = Object.values(grown.xml.sheets.Sources.cells).map(cell => cell.value);
    assert.equal(sourceValues.includes('removed'), false);
  });

  await t.test('refresh retains worksheet identity, table names, widths, panes and header styles', () => {
    for (const [name, before] of Object.entries(original.xml.sheets)) {
      const after = grown.xml.sheets[name];
      assert.ok(after, `${name} must survive refresh`);
      assert.equal(after.id, before.id, `${name} worksheet ID changed`);
      assert.deepEqual(after.pane, before.pane, `${name} frozen headers changed`);
      assert.deepEqual(after.columns, before.columns, `${name} column widths changed`);
      assert.equal(after.cells.A1.style, before.cells.A1.style, `${name} title style changed`);
      for (const tableName of before.tables) {
        const oldTable = original.xml.tables[tableName];
        const newTable = grown.xml.tables[tableName];
        assert.ok(newTable, `${tableName} must survive refresh`);
        assert.deepEqual(newTable.headers, oldTable.headers, `${tableName} column schema changed`);
        assert.deepEqual(newTable.style, oldTable.style, `${tableName} table style changed`);
        const oldHeader = oldTable.reference.split(':')[0];
        const newHeader = newTable.reference.split(':')[0];
        assert.equal(after.cells[newHeader].style, before.cells[oldHeader].style, `${tableName} header style changed`);
      }
    }
  });

  await t.test('expanded tables recalculate spending and account summaries', async () => {
    const appendScript = join(directory, 'append.mjs');
    const appendedOutput = join(directory, 'appended.xlsx');
    const accountTable = grown.xml.tables.TableAccounts;
    const accountValues = accountTable.rows.map(row => accountTable.headers.map(header => row[header].value));
    const accountDataRange = accountTable.reference.replace(/([A-Z]+)(\d+):/, (_, column: string, row: string) => `${column}${Number(row) + 1}:`);
    const formulas = Object.entries(grown.xml.sheets).flatMap(([name, sheet]) => Object.entries(sheet.cells).flatMap(([reference, cell]) => cell.formula ? [[name, reference, `=${cell.formula}`]] : []));
    await writeFile(appendScript, `import { Workbook } from ${JSON.stringify(new URL('../scripts/workbook-runtime.mjs', import.meta.url).href)};
const workbook = await Workbook.read(process.argv[2]);
const append = (sheetName, tableName, fields) => {
  const sheet = workbook.worksheets.getItem(sheetName);
  const table = sheet.tables.items.find(table => table.name === tableName);
  const headers = table.getHeaderRowRange().values[0];
  table.rows.add(null, [headers.map(header => fields[header] ?? null)]);
};
append('Transactions', 'TableTransactions', { Date: new Date('2026-09-01T00:00:00Z'), Account: 'Renamed cash', Description: 'Excel appended purchase', Type: 'Expense', Amount: 12.34, 'Imported category': 'New category fixture', Category: 'New category fixture', 'Transaction ID': 'excel-appended' });
append('Accounts', 'TableAccounts', { Account: 'Excel appended cash', Type: 'Cash', Balance: 45.67, 'Account ID': 'excel-account' });
workbook.worksheets.getItem('Accounts').getRange(${JSON.stringify(accountDataRange)}).values = ${JSON.stringify(accountValues.reverse())};
// Recalculate after editing the exported tables.
const formulas = ${JSON.stringify(formulas)};
for (let pass = 0; pass < 2; pass++) for (const [name, reference, formula] of formulas) workbook.worksheets.getItem(name).getRange(reference).formulas = [[formula]];
await workbook.write(process.argv[3]);
`);
    await execute(runtime, [appendScript, grown.output, appendedOutput], { timeout: 170000, maxBuffer: 1024 * 1024 });
    const appended = await inspect(appendedOutput);
    assert.equal(appended.tables.TableTransactions.rows.length, grown.xml.tables.TableTransactions.rows.length + 1);
    assert.equal(appended.tables.TableAccounts.rows.length, grown.xml.tables.TableAccounts.rows.length + 1);
    assert.equal(Math.round(Number(cellBeside(appended, 'Expenses', 'All recorded expenses').value) * 100), Math.round(Number(cellBeside(grown.xml, 'Expenses', 'All recorded expenses').value) * 100) + 1234);
    assert.equal(Math.round(Number(cellBeside(appended, 'Home', 'Personal cash').value) * 100), 99567);
    const debt = appended.tables.TableDebts.rows.find(row => row['Account ID'].value === 'card')!;
    assert.equal(debt.Debt.value, 'Account card');
    assert.equal(debt['Balance owed'].value, 100, 'Sorting Accounts must preserve the debt lookup by account ID');
    assertNoFormulaErrors(appended);
  });

  await t.test('shrinking tables removes old values, formulas and summaries', async () => {
    const reduced = structuredClone(state);
    reduced.revision = 3;
    reduced.transactions = [transaction(25)];
    reduced.statements = [];
    reduced.obligations = [];
    reduced.reserves = [];
    reduced.moneyOwed = [];
    reduced.assetPurchases = [];
    reduced.assets = [];
    reduced.expenseFunds = [];
    reduced.expensePlanItems = [];
    reduced.wishItems = [];
    reduced.sourceFacts = [];
    const shrunk = await exportSnapshot(directory, reduced, 'shrunk', grown.output);
    assert.deepEqual(shrunk.xml.tables.TableTransactions.rows.map(row => row['Transaction ID'].value), ['transaction-25']);
    assert.equal(cellBeside(shrunk.xml, 'Expenses', 'All recorded expenses').value, 1.25);
    assert.equal(cellBeside(shrunk.xml, 'Home', 'Owed to you').value, 0);
    assert.equal(cellBeside(shrunk.xml, 'Home', 'Car and purchase equity').value, 0);
    assert.equal(cellBeside(shrunk.xml, 'Home', 'Owned items').value, 0);
    const values = Object.values(shrunk.xml.sheets).flatMap(sheet => Object.values(sheet.cells).map(cell => cell.value));
    for (const deleted of ['Changed purchase', 'transaction-older', 'transaction-kept', 'Bill 34', 'Reserve 24', 'Repayment fixture', 'Purchase fixture', 'Owned fixture', 'Savings fixture', 'Planned fixture', 'Wish fixture', 'Changed value']) assert.equal(values.includes(deleted), false, `${deleted} must be removed when its record is deleted`);
    for (const name of Object.keys(grown.xml.sheets)) assert.ok(shrunk.xml.sheets[name], `${name} must stay available after its collection becomes empty`);
    assertNoFormulaErrors(shrunk.xml);
  });
});
