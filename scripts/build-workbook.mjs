import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { categoryLimits, isUncategorized, transactionCategoryMatcher } from '../shared/expense-categories.ts';
import { debtPaymentStatus, debtPaymentSummary, isInStudy, requiredDebtPaymentCents } from '../shared/debt-status.ts';
import { effectiveDebtApr } from '../shared/debt-model.ts';
import { assertWorkbookFormulaResults, excelSumExpression } from '../shared/workbook-formulas.ts';
import { syncTable } from './workbook-tables.mjs';
import { statementCoverage, statementRowKey } from '../shared/statement-imports.ts';
import { Workbook } from './workbook-runtime.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (!['--input', '--output', '--previews', '--existing'].includes(flag) || !process.argv[index + 1]) throw new Error('Use --input snapshot.json --output workbook.xlsx [--previews directory].');
  options[flag.slice(2)] = path.resolve(process.argv[index + 1]);
}
if (!options.input || !options.output) throw new Error('The snapshot input and workbook output paths are required.');
try { await fs.access(options.output); throw new Error('The output already exists. Write a new workbook before replacing the saved export.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const { state: snapshot, documents, generatedAt } = JSON.parse(await fs.readFile(options.input, 'utf8'));
assert.ok(snapshot && Array.isArray(snapshot.accounts) && Array.isArray(snapshot.transactions) && Array.isArray(documents), 'The snapshot needs state and documents.');
assert.ok(Number.isInteger(snapshot.revision) && Number.isFinite(Date.parse(generatedAt)), 'The snapshot needs a revision and generation date.');
const personalEntities = new Set(snapshot.entities.filter(entity => entity.kind === 'personal').map(entity => entity.id));
const personalAccounts = new Set(snapshot.accounts.filter(account => personalEntities.has(account.entityId)).map(account => account.id));
const state = { ...snapshot,
  entities: snapshot.entities.filter(entity => personalEntities.has(entity.id)),
  accounts: snapshot.accounts.filter(account => personalAccounts.has(account.id)),
  transactions: snapshot.transactions.filter(transaction => personalAccounts.has(transaction.accountId) || personalAccounts.has(transaction.toAccountId)),
  statements: (snapshot.statements ?? []).filter(statement => personalAccounts.has(statement.accountId)),
  importBatches: (snapshot.importBatches ?? []).filter(batch => personalAccounts.has(batch.source.accountId)),
  positions: (snapshot.positions ?? []).filter(position => personalAccounts.has(position.accountId)),
  roadmap: snapshot.roadmap?.loanAccountId && !personalAccounts.has(snapshot.roadmap.loanAccountId)
    ? { ...snapshot.roadmap, loanAccountId: null, loanAprPercent: null, loanMonthlyPaymentCents: null } : snapshot.roadmap,
};
for (const collection of ['assetPurchases', 'moneyOwed', 'assets', 'spendingLimits', 'obligations', 'reserves', 'expenseFunds', 'expensePlanItems', 'wishItems']) {
  state[collection] = (snapshot[collection] ?? []).filter(record => personalEntities.has(record.entityId));
}
{
  let workbook;
  let updating = false;
  if (options.existing) {
    const previous = await Workbook.read(options.existing);
    const layout = previous.worksheets.items.some(sheet => sheet.name === 'Home') ? previous.worksheets.getItem('Home').getRange('D3').values[0][0] : null;
    assert.ok(typeof layout === 'string' && /^Mazal layout \d+$/.test(layout), 'The existing workbook is not a recognized Mazal export. Its worksheets were kept.');
    workbook = previous;
    updating = layout === 'Mazal layout 9' || layout === 'Mazal layout 10';
    if (!updating) {
      const generatedSheets = new Set(['Home', 'Transactions', 'Expenses', 'Monthly spending', 'Accounts', 'Debts', 'Assets', 'Receivables', 'Plan', 'Sources', 'Documents', 'Investments', 'Payment terms', 'Loan portions', 'Lender figures', 'Repayments', 'Owned items', 'Statement coverage', 'Budgets', 'Bills', 'Reserves', 'Savings goals', 'Planned spending', 'Wish list', 'Statement entries', 'Pending imports', 'Reported figures', 'Balance notes']);
      for (const sheet of previous.worksheets.items) if (generatedSheets.has(sheet.name)) sheet.delete();
    }
  }
  workbook ??= Workbook.create();
  const names = ['Home', 'Transactions', 'Expenses', 'Monthly spending', 'Accounts', 'Debts', 'Assets', 'Receivables', 'Plan', 'Sources', 'Documents'];
  if (state.positions?.length) names.splice(4, 0, 'Investments');
  const priorSheets = new Set(workbook.worksheets.items.map(sheet => sheet.name));
  const sheets = new Map(workbook.worksheets.items.map(sheet => [sheet.name, sheet]));
  for (const name of names) if (!sheets.has(name)) sheets.set(name, workbook.worksheets.add(name));
  const font = 'Helvetica Neue';
  const ink = '#202B35';
  const muted = '#596673';
  const money = '#,##0.00_);(#,##0.00);0.00_)';
  const dateFormat = 'dd mmm yyyy';
  const generated = new Date(generatedAt);
  const cutoff = `${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, '0')}-${String(generated.getDate()).padStart(2, '0')}`;
  const date = value => value ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null;
  const dollars = value => value == null ? null : value / 100;
  const text = value => typeof value === 'string' && /^[=+@]/.test(value) ? `'${value}` : value;
  const col = index => { let value = index + 1, result = ''; while (value) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); } return result; };
  const owners = state.entities;
  const accounts = state.accounts;
  const newest = (field, tie = 'id') => (a, b) => (b[field] ?? '').localeCompare(a[field] ?? '') || (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || String(a[tie] ?? '').localeCompare(String(b[tie] ?? ''));
  const transactions = [...state.transactions].sort(newest('date'));
  for (const [collection, field] of [['obligations', 'dueDate'], ['expenseFunds', 'targetDate'], ['expensePlanItems', 'date'], ['sourceFacts', 'asOf']]) state[collection] = [...(state[collection] ?? [])].sort(newest(field));
  const purchases = [...state.assetPurchases].sort(newest('paidAsOf'));
  const receivables = state.moneyOwed ?? [];
  const heldAssets = [...state.assets].sort((a, b) => (b.soldDate ?? b.purchaseDate ?? '').localeCompare(a.soldDate ?? a.purchaseDate ?? '') || a.id.localeCompare(b.id));
  const accountMap = new Map(snapshot.accounts.map(account => [account.id, account]));
  const categoryMatchers = new Map(owners.map(owner => [owner.id, transactionCategoryMatcher(state, owner.id, categoryLimits(state, owner.id))]));
  const appCategory = transaction => transaction.kind !== 'expense' ? '' : transaction.expenseCategory === undefined && isUncategorized(transaction.category) && !transaction.source.startsWith('Planned payment ') ? 'Uncategorized' : categoryMatchers.get(accountMap.get(transaction.accountId)?.entityId)(transaction).name;
  const accountName = id => accountMap.get(id)?.name ?? purchases.find(purchase => `asset-purchase:${purchase.id}` === id)?.name ?? '';
  const sourceDocuments = documents.filter(document => document.accountId ? personalAccounts.has(document.accountId) : document.expenseUse !== 'business').sort(newest('documentDate', 'sha256'));
  const sourceRefs = new Map(sourceDocuments.map((document, index) => [document.sha256, `S${String(index + 1).padStart(2, '0')}`]));
  const fileRefs = new Map(sourceDocuments.map(document => [document.originalName.toLowerCase(), sourceRefs.get(document.sha256)]));
  const sourceRef = name => !name || name === 'Owner confirmation' ? 'Your confirmation' : fileRefs.get(name.toLowerCase()) ?? name;
  const accountNote = (note = '') => note
    .replace(/Bank balance \$[\d,.]+; quoted total payoff \$[\d,.]+ is separate\./g, 'Balance and payoff are separate figures.')
    .replace(/\$[\d,.]+ is the credit report balance, not a verified current lender balance\./g, 'The credit report balance needs current lender confirmation.')
    .replace(/Owner confirmed \$[\d,.]+ owed to/g, 'Owner confirmed the balance owed to')
    .replace(/Owner confirmed \$[\d,.]+ planned for/g, 'Payment planned for');
  const purchaseNote = (note = '') => note
    .replace(/\$[\d,.]+ ownership target\.\s*/g, '')
    .replace(/\$[\d,.]+ monthly payments/g, 'Monthly payments')
    .replace(/Starting amount confirmed at \$[\d,.]+\.\s*/g, '')
    .replace(/September payment of \$[\d,.]+ planned/g, 'September payment planned');
  const statements = (state.statements ?? []).map(statement => ({ ...statement, status: 'Recorded' }));
  const importAliases = new Map();
  for (const batch of state.importBatches ?? []) {
    const existing = statements.find(statement => statement.accountId === batch.source.accountId && statement.sha256 === batch.source.sha256);
    if (existing) { importAliases.set(batch.id, existing.id); continue; }
    const decisions = new Map(batch.decisions.map(decision => [decision.rowId, decision]));
    statements.push({ ...batch.source, id: batch.id, status: batch.status === 'committed' ? 'Recorded' : 'Pending', rows: batch.source.rows.map(row => ({ ...row, kind: decisions.get(row.id)?.kind ?? 'unreviewed', category: decisions.get(row.id)?.category ?? '' })) });
    importAliases.set(batch.id, batch.id);
  }
  statements.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.accountId.localeCompare(b.accountId));
  const statementRefs = new Map(statements.map((statement, index) => [statement.id, `ST${String(index + 1).padStart(2, '0')}`]));
  const entryMap = new Map(statements.flatMap(statement => statement.rows.map(row => [statementRowKey(statement.id, row.id), row])));
  const transactionBySource = new Map();
  transactions.forEach((transaction, index) => {
    if (transaction.statementId) transactionBySource.set(statementRowKey(transaction.statementId, transaction.statementRowId), index + 6);
    for (const reference of transaction.importSources ?? []) transactionBySource.set(statementRowKey(importAliases.get(reference.importId) ?? reference.importId, reference.rowId), index + 6);
  });
  const previews = [];
  const nextRows = new Map();
  const blocks = new Map();
  let tableNumber = 0;
  const widthsBySheet = new Map();
  const formulaCells = [];

  function init(name, subtitle, widths) {
    if (!sheets.has(name)) sheets.set(name, workbook.worksheets.add(name));
    const sheet = sheets.get(name);
    widthsBySheet.set(name, widths);
    sheet.showGridLines = false;
    const end = col(widths.length - 1);
    sheet.getRange(`A1:${end}3`).format = { font: { name: font, size: 11, color: ink }, rowHeight: 23, verticalAlignment: 'center' };
    sheet.getRange('A1').values = [[name]];
    sheet.getRange('A1').format.font = { name: font, size: 19, bold: true, color: ink };
    sheet.getRange(`A1:${end}1`).format.rowHeight = 33;
    sheet.getRange(`A1:${end}1`).format.borders = { bottom: { style: 'thin', color: '#ADB7C1' } };
    sheet.getRange('A2').values = [[subtitle]];
    sheet.getRange(`A2:${end}2`).format.font = { name: font, size: 10, color: muted, italic: true };
    if (!updating || !priorSheets.has(name)) widths.forEach((width, index) => { sheet.getRange(`${col(index)}1:${col(index)}3`).format.columnWidth = width; });
    nextRows.set(name, 5);
    sheet.freezePanes.freezeRows(5);
    return sheet;
  }

  const tableName = name => `Table${name.replace(/[^A-Za-z0-9]/g, '')}`;
  const tableRef = (name, column) => `${tableName(name)}[${column}]`;
  const literal = value => `"${String(value).replace(/"/g, '""')}"`;
  const lookup = (name, column, keyColumn, key) => `_xlfn.XLOOKUP(${key},${tableRef(name, keyColumn)},${tableRef(name, column)},"")`;
  const valueById = (name, column, id) => lookup(name, column, 'Account ID', literal(id));
  const blankValueById = (name, column, id) => `IF(COUNTIFS(${tableRef(name, 'Account ID')},${literal(id)},${tableRef(name, column)},"<>")=0,"",${valueById(name, column, id)})`;

  function block(name, label, headers, rows, formats = {}, options = {}) {
    if (!nextRows.has(name)) init(name, `${label || name}. CAD. Newest dated records appear first.`, [38, 26, 24, 24, 25, 30, 32, 45, 25, 30, 45, 30]);
    const sheet = sheets.get(name);
    const start = nextRows.get(name);
    const header = start;
    const first = header + 1;
    const last = Math.max(first, first + rows.length - 1);
    const end = col(headers.length - 1);
    sheet.getRange(`A${start}:${end}${last}`).format = { font: { name: font, size: 11, color: ink }, rowHeight: 27, verticalAlignment: 'center' };
    sheet.getRange(`A${header}:${end}${header}`).values = [headers];
    if (options.filter === false && rows.length) sheet.getRange(`A${first}:${end}${last}`).values = rows.map(row => row.map(value => text(value ?? null)));
    if (options.filter !== false) {
      const synced = syncTable({ sheet, tableName: tableName(name), header, headers, rows: rows.map(row => row.map(value => text(value ?? null))) });
      if (synced.created) synced.table.style = 'TableStyleLight1';
      sheet.freezePanes.freezeRows(header);
      tableNumber++;
    }
    sheet.getRange(`A${header}:${end}${header}`).format = { fill: '#263746', font: { name: font, size: 11, bold: true, color: '#FFFFFF' }, wrapText: true, rowHeight: 34, horizontalAlignment: 'center', verticalAlignment: 'center', borders: { insideVertical: { style: 'thin', color: '#FFFFFF' } } };
    if (rows.length) {
      sheet.getRange(`A${first}:${end}${last}`).format.wrapText = true;
      sheet.getRange(`A${first}:${end}${last}`).format.verticalAlignment = 'top';
      sheet.getRange(`A${first}:${end}${last}`).format.rowHeight = options.rowHeight ?? 33;
      for (const [letter, format] of Object.entries(formats)) {
        sheet.getRange(`${letter}${first}:${letter}${last}`).setNumberFormat(format);
        sheet.getRange(`${letter}${first}:${letter}${last}`).format.horizontalAlignment = 'right';
      }
    }
    const result = { sheet, name, start, header, first, last, count: rows.length, end };
    nextRows.set(name, last + 3);
    previews.push({ ...result, label });
    if (options.key) blocks.set(options.key, result);
    return result;
  }

  function formula(name, cell, value, format = money) {
    const range = sheets.get(name).getRange(cell);
    range.formulas = [[value]];
    formulaCells.push({ sheet: name, cell, formula: value });
    range.setNumberFormat(format);
    range.format.font = { name: font, size: 11, color: value.includes("'!") ? '#008000' : ink };
    range.format.horizontalAlignment = format === '@' ? 'left' : 'right';
  }
  const ref = (name, cell) => `'${name}'!${cell}`;
  const pendingSums = [];
  const sumAt = (name, cell, label, terms) => pendingSums.push({ name, cell, label, terms });
  const formatRows = block => {
    if (!block.count) return;
    const body = block.sheet.getRange(`A${block.first}:${block.end}${block.last}`);
    if (block.count <= 500) body.format.autofitRows();
  };

  init('Home', `CAD. Personal records as of ${cutoff}. App revision ${state.revision}.`, [34, 21, 68, 20]);
  const home = block('Home', '', ['Recorded position', 'Amount', 'What it includes'], [
    ['Net worth', null, 'Recorded personal assets less debt.'],
    ['Personal cash', null, 'Recorded cash balance before planned bills and reserves.'],
    ['Investments', null, 'Recorded investment account balances.'],
    ['Owed to you', null, 'Receivable accounts and remaining repayments.'],
    ['Car and purchase equity', null, 'Recorded purchase and repair contributions.'],
    ['Owned items', null, 'Estimated resale value less sale fees. Sold items are excluded.'],
    ['Debt', null, 'Debt and payable account balances.'],
  ], { B: money }, { filter: false });
  const overview = block('Home', 'Use this workbook', ['Sheet', 'Use', 'Entry point'], [
    ['Expenses', 'Recorded spending', 'Category totals and monthly totals reference Transactions.'],
    ['Debts', 'Balances and next payments', 'Blank minimums and dates still need confirmation.'],
    ['Assets', 'Purchase equity', 'Recorded contributions. Repayments are on Receivables.'],
    ['Plan', 'Saved baseline', 'Pay schedule, saved scenario inputs and planned purchases. Browser-local drafts are excluded.'],
    ['Accounts', 'Recorded and source balances', 'Compare recorded balances with the source amount and its date. Rates and due dates appear on Debts.'],
    ['Transactions', 'Recorded activity', 'One ledger, including source references and refunds.'],
    ['Sources', 'Statement checks', 'Recorded and pending statement periods. Original files are on Documents.'],
  ], {}, { filter: false });
  overview.sheet.getRange(`B${overview.first}:B${overview.last}`).format.wrapText = true;

  init('Accounts', 'CAD. Balance is the recorded amount, including later activity. Source balance and date retain the original evidence.', [37, 19, 19, 19, 21, 45, 50, 19, 19]);
  const accountBlock = block('Accounts', '', ['Account', 'Type', 'Balance', 'Last confirmed', 'Source', 'Qualification', 'Account ID', 'Source balance', 'Source as of'], accounts.map(account => [
    account.name, { cash: 'Cash', investment: 'Investment', debt: 'Debt', receivable: 'Receivable', payable: 'Payable' }[account.type], dollars(account.balanceCents),
    date(account.reconciledAt), sourceRef(account.evidence?.sourceFile), account.evidence?.status === 'credit_report' ? 'Credit report. Current lender balance and reporting date are unconfirmed.' : account.reconciledAt ? 'Recorded balance includes activity saved after the last confirmation.' : 'No recorded balance confirmation. Refer to the separate source amount and date when available.', account.id,
    dollars(account.evidence?.balanceCents), date(account.evidence?.asOf),
  ]), { C: money, D: dateFormat, H: money, I: dateFormat });
  const debtAccounts = accounts.filter(account => ['debt', 'payable'].includes(account.type));
  const interestLabels = { accruing: 'Accruing', interest_free: 'Interest-free', unknown: 'Unknown' };
  const repaymentLabels = { fixed: 'Fixed monthly payment', revolving: 'Statement minimum changes', interest_only: 'Interest only', one_off: 'One payment on the due date' };
  const termsBlock = block('Payment terms', 'Payment terms', ['Account', 'Effective APR', 'Rate confirmed', 'Recorded minimum', 'Payment due', 'Terms dated', 'Source', 'Notes', 'Payment status', 'Return to study', 'Account ID'], debtAccounts.map(account => {
    const terms = account.debtTerms;
    const source = statements.find(statement => statement.accountId === account.id && statement.periodEnd === terms?.statementDate);
    const statusNote = isInStudy(account) ? `Payment deferral ${terms.repaymentStatusSource === 'lender' ? 'confirmed by lender' : 'reported by owner'}${terms.repaymentStatusAsOf ? ` on ${terms.repaymentStatusAsOf}` : ''}.` : '';
    const status = { paid_off: 'Paid off', in_study: 'In study', repaying: 'Repaying', needs_confirmation: 'Needs confirmation' }[debtPaymentStatus(account, cutoff)];
    const datedTerms = [terms?.studyEndDate ? `Study period ends ${terms.studyEndDate}.` : '', terms?.repaymentStartDate ? `Repayment starts ${terms.repaymentStartDate}.` : ''].filter(Boolean).join(' ');
    const apr = effectiveDebtApr(account);
    const modelTerms = [terms?.repaymentKind ? `${repaymentLabels[terms.repaymentKind]}.` : '', terms?.interestStatus ? `Account interest status: ${interestLabels[terms.interestStatus]}.${terms?.components?.length ? ' Portion terms apply.' : ''}` : '', terms?.aprPercent != null && apr !== terms.aprPercent ? `Recorded account APR ${terms.aprPercent}%.` : '', terms?.components?.length && apr === null ? 'Loan portions are incomplete or do not match the total balance.' : ''].filter(Boolean).join(' ');
    return [null, terms?.components?.length || apr === null ? null : apr / 100, effectiveDebtApr(account, true) === null ? 'No' : 'Yes', dollars(terms?.minimumPaymentCents), date(terms?.paymentDueDate), date(terms?.statementDate), source ? sourceRef(source.sourceFile) : sourceRef(account.evidence?.sourceFile), [accountNote(terms?.notes), statusNote, datedTerms, modelTerms].filter(Boolean).join(' ') || null, status, terms?.schoolReturnMonth ?? null, account.id];
  }), { B: '0.00%', D: money, E: dateFormat, F: dateFormat });
  const termsRows = new Map(debtAccounts.map((account, index) => [account.id, termsBlock.first + index]));
  debtAccounts.forEach((account, index) => formula('Payment terms', `A${termsBlock.first + index}`, `=${valueById('Accounts', 'Account', account.id)}`, '@'));
  const loanParts = debtAccounts.flatMap(account => (account.debtTerms?.components ?? []).map(part => ({ account, part })));
  if (loanParts.length || sheets.has('Loan portions')) {
    const components = block('Loan portions', 'Loan portions', ['Account', 'Portion', 'Balance', 'Recorded APR', 'Rate confirmed', 'Interest status', 'Effective APR', 'Account ID', 'Interest amount', 'Usable', 'Confirmed'], loanParts.map(({ account, part }) => [null, part.id === 'federal' ? 'Federal' : 'Ontario', dollars(part.balanceCents), part.aprPercent === null ? null : part.aprPercent / 100, part.rateConfirmed ? 'Yes' : 'No', interestLabels[part.interestStatus], null, account.id, null, null, null]), { C: money, D: '0.00%', G: '0.00%' });
    const partRows = new Map();
    loanParts.forEach(({ account }, index) => {
      const row = components.first + index;
      formula('Loan portions', `A${row}`, `=${valueById('Accounts', 'Account', account.id)}`, '@');
      formula('Loan portions', `G${row}`, `=IF(COUNT(C${row})=0,"",IF(C${row}=0,0,IF(F${row}="Interest-free",0,IF(AND(F${row}="Accruing",COUNT(D${row})=1),D${row},""))))`, '0.00%');
      formula('Loan portions', `I${row}`, `=IF(COUNT(C${row},G${row})=2,C${row}*G${row},0)`);
      formula('Loan portions', `J${row}`, `=IF(COUNT(C${row},G${row})=2,1,0)`, '0');
      formula('Loan portions', `K${row}`, `=IF(OR(C${row}=0,F${row}="Interest-free",E${row}="Yes"),1,0)`, '0');
      partRows.set(account.id, [...(partRows.get(account.id) ?? []), row]);
    });
    for (const [accountId] of partRows) {
      const key = literal(accountId);
      const balance = valueById('Accounts', 'Balance', accountId);
      const termsRow = termsRows.get(accountId);
      const ids = tableRef('Loan portions', 'Account ID');
      formula('Payment terms', `B${termsRow}`, `=IF(AND(COUNTIF(${ids},${key})=2,SUMIFS(${tableRef('Loan portions', 'Usable')},${ids},${key})=2,ROUND(SUMIFS(${tableRef('Loan portions', 'Balance')},${ids},${key})*100,0)=ROUND(${balance}*100,0)),IF(${balance}<=0,0,SUMIFS(${tableRef('Loan portions', 'Interest amount')},${ids},${key})/${balance}),"")`, '0.00%');
      formula('Payment terms', `C${termsRow}`, `=IF(AND(COUNT(B${termsRow})=1,SUMIFS(${tableRef('Loan portions', 'Confirmed')},${ids},${key})=2),"Yes","No")`, '@');
    }
  }

  const creditAccounts = accounts.filter(account => ['creditLimitCents', 'availableCreditCents', 'payoffCents'].some(key => account.evidence?.[key] != null));
  if (creditAccounts.length || sheets.has('Lender figures')) {
    const credit = block('Lender figures', 'Other lender figures', ['Account', 'Credit limit', 'Available credit', 'Payoff quote', 'Dated', 'Source', 'Account ID'], creditAccounts.map(account => [null, dollars(account.evidence.creditLimitCents), dollars(account.evidence.availableCreditCents), dollars(account.evidence.payoffCents), date(account.evidence.asOf), sourceRef(account.evidence.sourceFile), account.id]), { B: money, C: money, D: money, E: dateFormat });
    creditAccounts.forEach((account, index) => formula('Lender figures', `A${credit.first + index}`, `=${valueById('Accounts', 'Account', account.id)}`, '@'));
  }
  sheets.get('Accounts').freezePanes.freezeRows(5);

  init('Debts', 'CAD. In-study balances stay in total debt; regular payments are excluded. Blank payment terms remain unknown.', [38, 19, 16, 21, 18, 60]);
  const debtTotals = block('Debts', 'Totals', ['Measure', 'Amount'], [['Debt owed', null], ['Known payments', null], ['Missing minimums', null]], {}, { filter: false });
  formula('Debts', `B${debtTotals.first}`, '=SUM(TableDebts[Balance owed])');
  formula('Debts', `B${debtTotals.first + 1}`, '=SUM(TableDebts[Required payment])');
  formula('Debts', `B${debtTotals.first + 2}`, '=COUNTA(TableDebts[Account ID])-COUNT(TableDebts[Required payment])', '0');
  const debtBlock = block('Debts', '', ['Debt', 'Balance owed', 'APR', 'Required payment', 'Payment due', 'Status / needs confirmation', 'Account ID'], debtAccounts.map(account => [null, null, null, null, null, account.balanceCents <= 0 ? 'Paid off.' : [
    debtPaymentStatus(account, cutoff) === 'in_study' ? 'In study. No regular payment planned. Confirm eligible enrolment with the lender.' : null,
    debtPaymentStatus(account, cutoff) === 'needs_confirmation' ? 'Study period ended. Confirm repayment start and minimum.' : null,
    account.evidence?.status === 'credit_report' ? 'Current lender balance.' : null,
    effectiveDebtApr(account) === null ? account.debtTerms?.components?.length ? 'Interest rate or loan portions.' : 'Interest rate.' : effectiveDebtApr(account, true) === null ? 'Rate is unconfirmed.' : null,
    debtPaymentStatus(account, cutoff) === 'repaying' && account.debtTerms?.minimumPaymentCents == null ? 'Minimum payment.' : null,
    debtPaymentStatus(account, cutoff) === 'repaying' && account.debtTerms?.paymentDueDate && account.debtTerms.paymentDueDate < cutoff ? 'Due date has passed. Check the next statement.' : null,
    debtPaymentStatus(account, cutoff) === 'repaying' && !account.debtTerms?.paymentDueDate ? 'Payment date.' : null,
  ].filter(Boolean).join(' ') || null, account.id]), { B: money, C: '0.00%', D: money, E: dateFormat });
  debtAccounts.forEach((account, index) => {
    const row = debtBlock.first + index;
    formula('Debts', `A${row}`, `=${valueById('Accounts', 'Account', account.id)}`, '@');
    formula('Debts', `B${row}`, `=${valueById('Accounts', 'Balance', account.id)}`);
    const termsRow = termsRows.get(account.id);
    formula('Debts', `C${row}`, `=${blankValueById('Payment terms', 'Effective APR', account.id)}`, '0.00%');
    const paymentStatus = valueById('Payment terms', 'Payment status', account.id);
    formula('Debts', `D${row}`, `=IF(OR(B${row}<=0,${paymentStatus}="In study"),0,IF(${paymentStatus}="Needs confirmation","",${blankValueById('Payment terms', 'Recorded minimum', account.id)}))`, money);
    formula('Debts', `E${row}`, `=IF(OR(B${row}<=0,${paymentStatus}="In study",${paymentStatus}="Needs confirmation"),"",${blankValueById('Payment terms', 'Payment due', account.id)})`, dateFormat);
  });

  init('Assets', 'CAD. Purchase equity, owned items and money owed to you each count once in Home.', [34, 22, 21, 20, 20, 22, 20, 58, 45, 38]);
  const purchaseBlock = block('Assets', 'Purchase agreements', ['Asset', 'Payee', 'Agreed price', 'Paid / equity', 'Still to pay', 'Monthly payment', 'Paid as of', 'Terms', 'Record ID'], purchases.map(record => [record.name, record.payee, dollars(record.targetCents), dollars(record.paidCents), null, dollars(record.monthlyCents), date(record.paidAsOf), purchaseNote(record.notes), record.id]), { C: money, D: money, E: money, F: money, G: dateFormat });
  purchases.forEach((record, index) => {
    const row = purchaseBlock.first + index;
    formula('Assets', `E${row}`, `=IF(COUNT(D${row})=0,"",MAX(0,ROUND(C${row}-D${row},2)))`);
  });
  const owedBlock = block('Receivables', 'Money owed to you', ['Person or group', 'Original amount', 'Received', 'Remaining', 'Counted value', 'Last payment', 'Counted in', 'Note', 'Record ID'], receivables.map(record => [record.name, dollars(record.amountCents), null, null, null, date(record.payments.map(payment => payment.date).sort().at(-1)), accounts.some(account => account.id === record.id && account.entityId === record.entityId && account.type === 'receivable') ? 'Accounts' : 'Assets', record.comment, record.id]), { B: money, C: money, D: money, E: money, F: dateFormat });
  const repayments = receivables.flatMap(record => record.payments.map(payment => ({ ...payment, receivable: record }))).sort(newest('date'));
  let repaymentBlock;
  repaymentBlock = block('Repayments', 'Repayments received', ['Person or group', 'Date', 'Amount', 'Cash account', 'Note', 'Record ID', 'Receivable ID'], repayments.map(payment => [payment.receivable.name, date(payment.date), dollars(payment.amountCents), accountName(payment.cashAccountId), payment.comment, payment.id, payment.receivable.id]), { B: dateFormat, C: money });
  receivables.forEach((record, index) => {
    const row = owedBlock.first + index;
    formula('Receivables', `C${row}`, `=SUMIFS(TableRepayments[Amount],TableRepayments[Receivable ID],I${row})`);
    formula('Receivables', `D${row}`, `=MAX(0,ROUND(B${row}-C${row},2))`);
    formula('Receivables', `E${row}`, `=IF(G${row}="Accounts",0,D${row})`);
  });
  let heldBlock;
  if (heldAssets.length || sheets.has('Owned items')) {
    heldBlock = block('Owned items', 'Owned items and sales', ['Asset', 'Status', 'Cost', 'Estimated value', 'Sale fees', 'Sale proceeds', 'Net proceeds', 'Counted value', 'Note', 'Purchased', 'Sold', 'Record ID'], heldAssets.map(record => [record.name, record.status, dollars(record.costCents), dollars(record.estimatedValueCents), dollars(record.feesCents), dollars(record.saleCents), null, null, record.notes, date(record.purchaseDate), date(record.soldDate), record.id]), { C: money, D: money, E: money, F: money, G: money, H: money, J: dateFormat, K: dateFormat });
    heldAssets.forEach((record, index) => {
      const row = heldBlock.first + index;
      formula('Owned items', `G${row}`, `=IF(COUNT(F${row})=0,"",ROUND(F${row}-E${row},2))`);
      const duplicate = purchases.some(purchase => purchase.id === record.id && purchase.entityId === record.entityId);
      formula('Owned items', `H${row}`, duplicate ? '=0' : `=IF(B${row}="sold",0,IF(COUNT(D${row})=0,"",ROUND(MAX(0,D${row}-E${row}),2)))`);
    });
  }

  init('Transactions', 'CAD. Personal transactions appear once. Description preserves the source text; Name and Notes are saved in Mazal. Negative expenses are refunds.', [17, 36, 58, 22, 18, 27, 33, 21, 34, 17, 40, 24, 40, 58]);
  const labels = { income: 'Income', expense: 'Expense', transfer: 'Transfer', debt_payment: 'Debt payment', opening: 'Opening balance', adjustment: 'Balance adjustment' };
  const transactionBlock = block('Transactions', '', ['Date', 'Account', 'Description', 'Type', 'Amount', 'Category', 'To account', 'Statement', 'Source', 'Posted', 'Transaction ID', 'Imported category', 'Name', 'Notes'], transactions.map(transaction => {
    const refs = [...(transaction.statementId ? [{ statementId: transaction.statementId, rowId: transaction.statementRowId }] : []), ...(transaction.importSources ?? []).map(reference => ({ statementId: importAliases.get(reference.importId) ?? reference.importId, rowId: reference.rowId }))];
    const sources = refs.map(reference => {
      const source = entryMap.get(statementRowKey(reference.statementId, reference.rowId));
      return source ? `${statementRefs.get(reference.statementId)}, p. ${source.sourcePage}` : null;
    }).filter(Boolean);
    return [date(transaction.date), accountName(transaction.accountId), transaction.description, labels[transaction.kind], dollars(transaction.amountCents), appCategory(transaction), accountName(transaction.toAccountId), [...new Set(refs.map(reference => statementRefs.get(reference.statementId)).filter(Boolean))].join(', '), sources.join('; ') || transaction.source, date(transaction.postingDate), transaction.id, transaction.category || 'Uncategorized', transaction.displayName || '', transaction.note || ''];
  }), { A: dateFormat, E: money, J: dateFormat });
  assert.equal(transactionBlock.first, 6);
  sheets.get('Transactions').freezePanes.freezeRows(5);
  sheets.get('Transactions').freezePanes.freezeColumns(2);
  const txRange = letter => tableRef('Transactions', { A: 'Date', D: 'Type', E: 'Amount', L: 'Category' }[letter]);

  init('Expenses', 'CAD. Recorded expenses and refunds. Category is editable in Mazal; imported labels remain on Transactions.', [28, 18, 14, 21, 22]);
  const expenses = transactions.filter(transaction => transaction.kind === 'expense');
  const dates = expenses.map(transaction => transaction.date).sort();
  const controls = block('Expenses', '', ['Period', 'Date', 'Basis'], [['From', date(dates[0] ?? cutoff), 'First recorded transaction date.'], ['Through', date(dates.at(-1) ?? cutoff), 'Latest recorded transaction date.']], { B: dateFormat }, { filter: false });
  formula('Expenses', `B${controls.first}`, '=IF(COUNT(TableTransactions[Date])=0,"",MIN(TableTransactions[Date]))', dateFormat);
  formula('Expenses', `B${controls.last}`, '=IF(COUNT(TableTransactions[Date])=0,"",MAX(TableTransactions[Date]))', dateFormat);
  controls.sheet.getRange(`B${controls.first}:B${controls.last}`).format.font = { name: font, size: 11, color: '#0000FF' };
  const categories = [...new Set(expenses.map(appCategory))].sort((a, b) => a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b));
  const expenseHeaders = ['Category', 'Spending', 'Entries', 'Refunds included'];
  const expenseColumns = { count: 'C', refunds: 'D' };
  const expenseFormats = { B: money, C: '#,##0', D: money };
  const expenseTotal = block('Expenses', '', ['Total', ...expenseHeaders.slice(1)], [['All recorded expenses', ...Array(expenseHeaders.length - 1).fill(null)]], expenseFormats, { filter: false });
  formula('Expenses', `B${expenseTotal.first}`, '=SUMIFS(TableTransactions[Amount],TableTransactions[Type],"Expense")');
  formula('Expenses', `C${expenseTotal.first}`, '=COUNTIF(TableTransactions[Type],"Expense")', '#,##0');
  formula('Expenses', `D${expenseTotal.first}`, '=SUMIFS(TableTransactions[Amount],TableTransactions[Type],"Expense",TableTransactions[Amount],"<0")');
  const categoryBlock = block('Expenses', 'By app category', expenseHeaders, categories.map(category => [category, ...Array(expenseHeaders.length - 1).fill(null)]), expenseFormats);
  const expenseCriteria = `${txRange('D')},"Expense",${txRange('A')},">="&$B$${controls.first},${txRange('A')},"<="&$B$${controls.last}`;
  categories.forEach((category, index) => {
    const row = categoryBlock.first + index;
    formula('Expenses', `B${row}`, `=SUMIFS(${txRange('E')},${expenseCriteria},${txRange('L')},A${row})`);
    formula('Expenses', `${expenseColumns.count}${row}`, `=COUNTIFS(${expenseCriteria},${txRange('L')},A${row})`, '#,##0');
    formula('Expenses', `${expenseColumns.refunds}${row}`, `=SUMIFS(${txRange('E')},${expenseCriteria},${txRange('L')},A${row},${txRange('E')},"<0")`);
  });
  const months = [...new Set(expenses.map(transaction => transaction.date.slice(0, 7)))].sort().reverse();
  const monthEnd = 'D';
  const monthCount = 'C';
  const monthHeaders = ['Month', 'Spending', 'Entries', 'Next month'];
  const monthBlock = block('Monthly spending', 'Recorded months', monthHeaders, months.map(month => [date(`${month}-01`), ...Array(monthHeaders.length - 1).fill(null)]), { A: 'mmm yyyy', B: money, C: '#,##0', D: dateFormat });
  months.forEach((month, index) => {
    const row = monthBlock.first + index;
    formula('Monthly spending', `${monthEnd}${row}`, `=DATE(YEAR(A${row}),MONTH(A${row})+1,1)`, dateFormat);
    const criteria = `${txRange('D')},"Expense",${txRange('A')},">="&A${row},${txRange('A')},"<"&${monthEnd}${row}`;
    formula('Monthly spending', `B${row}`, `=SUMIFS(${txRange('E')},${criteria})`);
    formula('Monthly spending', `${monthCount}${row}`, `=COUNTIFS(${criteria})`, '#,##0');
  });
  const currentMonth = cutoff.slice(0, 7);
  const coverage = statementCoverage(state, 'all', currentMonth);
  block('Statement coverage', `Statement coverage for ${currentMonth}`, ['Account', 'Covered days', 'Calendar days', 'Meaning'], coverage.accounts.map(account => [accountName(account.accountId), account.coveredDays, account.totalDays, account.coveredDays === 0 ? 'No recorded statement covers this month. Spending may be missing.' : account.coveredDays < account.totalDays ? 'Partial statement coverage. Uncovered days are unknown.' : 'Recorded statements cover the calendar month.']), { B: '0', C: '0' });
  if (state.spendingLimits?.length || sheets.has('Budgets')) {
    init('Budgets', 'CAD. Dated amounts apply only to that month. The undated baseline applies to other months. Blank amounts are unset.', [32, 25, 24, 24, 24, 50]);
    block('Budgets', 'Saved budgets', ['Category', 'Budget month', 'Monthly limit', 'Daily limit', 'Weekly limit', 'Matching categories'], state.spendingLimits.flatMap(record => [
      ...Object.entries(record.monthlyAmounts ?? {}).sort(([a], [b]) => b.localeCompare(a)).map(([month, amount]) => [record.name, month, dollars(amount), null, null, record.aliases.join(', ')]),
      [record.name, 'Undated baseline', dollars(record.monthlyCents), dollars(record.dailyCents), dollars(record.weeklyCents), record.aliases.join(', ')],
    ]), { C: money, D: money, E: money });
  }

  init('Plan', 'CAD. Saved baseline. Browser-local planner drafts are excluded. Blank amounts are unknown. Planned payments do not change balances.', [38, 24, 24, 78, 26, 23, 36, 26]);
  const plan = { ...state.roadmap, ...state.roadmap?.temporaryWorkSchedule };
  const planning = [
    ['Take-home pay', 'payAmountCents', 'CAD / payday', 'Expected deposit. Confirm against actual income.'],
    ['Pay interval', 'payEveryDays', 'Days', 'Saved pay schedule.'],
    ['Pay schedule start', 'paydayAnchor', 'Date', 'Saved anchor date. Repeat using the pay interval. Confirm deposits against recorded income.'],
    ['Current monthly income', 'currentMonthlyIncomeCents', 'CAD / month', 'Blank until income is confirmed.'],
    ['Income after transition', 'partTimeMonthlyIncomeCents', 'CAD / month', 'Estimated monthly take-home during the changed schedule.'],
    ['Monthly essentials', 'monthlyEssentialsCents', 'CAD / month', 'Budget assumption. Recorded spending is on Expenses.'],
    ['Monthly debt payments', 'monthlyDebtMinimumsCents', 'CAD / month', 'Budget assumption. Account minimums are on Debts.'],
    ['Family payment', 'monthlyFamilyPaymentCents', 'CAD / month', 'Linked to the purchase agreement when the amounts match.'],
    ['Income transition', 'transitionDate', 'Date', 'Saved planning date.'],
    ['Transition period', 'transitionMonths', 'Months', 'Saved planning period.'],
    ['Extra debt payment', 'monthlyExtraDebtCents', 'CAD / month', 'Extra payment above the saved baseline.'],
    ['Selected debt', 'loanAccountId', 'Account', 'Priority debt for the app simulation.'],
    ['Selected debt APR', 'loanAprPercent', 'APR', 'Saved scenario rate. Linked to account terms only when the effective rates match.'],
    ['Selected debt payment', 'loanMonthlyPaymentCents', 'CAD / month', 'Scenario payment. Blank until confirmed.'],
    ['Part-time weekly hours', 'weeklyHours', 'Hours / week', 'Average hours from the income transition until the return to full-time work.'],
    ['Full-time weekly hours', 'fullTimeWeeklyHours', 'Hours / week', 'Usual hours before and after part-time work.'],
    ['Return to full-time work', 'returnDate', 'Date', 'First day back on the full-time work schedule.'],
    ['Pay period end to payday', 'payPeriodEndLagDays', 'Days', 'Calendar days from the last day of a pay period to its payday.'],
    ['Part-time take-home estimate', 'partTimePayCents', 'CAD / payday', 'For a whole part-time pay period. A period spanning either change uses both schedules.'],
  ];
  const planBlock = block('Plan', 'Pay and simulation', ['Setting', 'Value', 'Unit', 'Meaning'], planning.map(([label, key, unit, note]) => [label, plan[key] == null ? null : key.endsWith('Cents') ? dollars(plan[key]) : unit === 'Date' ? date(plan[key]) : unit === 'Account' ? accountName(plan[key]) : unit === 'APR' ? plan[key] / 100 : plan[key], unit, note]), {}, { filter: false });
  const planRows = new Map(planning.map(([, key], index) => [key, planBlock.first + index]));
  planning.forEach(([, key, unit], index) => {
    const row = planBlock.first + index;
    const format = unit === 'Date' ? dateFormat : unit === 'APR' ? '0.00%' : key.endsWith('Cents') ? money : unit === 'Account' ? '@' : unit === 'Hours / week' ? '0.##' : '0';
    const range = planBlock.sheet.getRange(`B${row}`);
    range.setNumberFormat(format);
    range.format.horizontalAlignment = unit === 'Account' ? 'left' : 'right';
  });
  const regularPay = `B${planRows.get('payAmountCents')}`;
  const partTimeHours = `B${planRows.get('weeklyHours')}`;
  const fullTimeHours = `B${planRows.get('fullTimeWeeklyHours')}`;
  formula('Plan', `B${planRows.get('partTimePayCents')}`, `=IF(AND(COUNT(${regularPay},${partTimeHours},${fullTimeHours})=3,${fullTimeHours}>0),ROUND(${regularPay}*${partTimeHours}/${fullTimeHours},2),"")`);
  const selectedDebt = debtAccounts.find(account => account.id === plan.loanAccountId);
  if (selectedDebt) {
    formula('Plan', `B${planRows.get('loanAccountId')}`, `=${valueById('Accounts', 'Account', selectedDebt.id)}`, '@');
    if (plan.loanAprPercent != null && plan.loanAprPercent === effectiveDebtApr(selectedDebt)) formula('Plan', `B${planRows.get('loanAprPercent')}`, `=${valueById('Payment terms', 'Effective APR', selectedDebt.id)}`, '0.00%');
    else if (plan.loanAprPercent != null) planBlock.sheet.getRange(`D${planRows.get('loanAprPercent')}`).values = [['Saved scenario override. Differs from the account effective APR.']];
    if (plan.loanMonthlyPaymentCents != null && plan.loanMonthlyPaymentCents === selectedDebt.debtTerms?.minimumPaymentCents) formula('Plan', `B${planRows.get('loanMonthlyPaymentCents')}`, `=${valueById('Payment terms', 'Recorded minimum', selectedDebt.id)}`);
  }
  const familyPurchase = purchases.find(purchase => /mom/i.test(purchase.payee));
  if (familyPurchase && plan.monthlyFamilyPaymentCents === familyPurchase.monthlyCents) formula('Plan', `B${planRows.get('monthlyFamilyPaymentCents')}`, `=${lookup('Assets', 'Monthly payment', 'Record ID', literal(familyPurchase.id))}`);
  else if (familyPurchase && plan.monthlyFamilyPaymentCents != null) planBlock.sheet.getRange(`D${planRows.get('monthlyFamilyPaymentCents')}`).values = [['Scenario override. Differs from the purchase agreement.']];
  if (state.obligations?.length || sheets.has('Bills')) block('Bills', 'Bills and expected income', ['Item', 'Amount', 'Due', 'Direction', 'Frequency', 'Status', 'Account', 'Category'], state.obligations.map(record => [record.name, dollars(record.amountCents), date(record.dueDate), record.direction === 'in' ? 'Income' : record.subscription ? 'Subscription' : 'Bill', { once: 'Once', monthly: 'Monthly', biweekly: 'Every two weeks' }[record.recurrence], record.status, accountName(record.accountId), record.category]), { B: money, C: dateFormat });
  if (state.reserves?.length || sheets.has('Reserves')) block('Reserves', 'Reserved cash', ['Purpose', 'Amount', 'Treatment'], state.reserves.map(record => [record.name, dollars(record.amountCents), 'Already part of account cash.']), { B: money });
  if (state.expenseFunds?.length || sheets.has('Savings goals')) {
    const funds = block('Savings goals', 'Savings goals', ['Goal', 'Target', 'Saved', 'Remaining', 'Target date'], state.expenseFunds.map(record => [record.name, dollars(record.targetCents), dollars(record.savedCents), null, date(record.targetDate)]), { B: money, C: money, D: money, E: dateFormat });
    state.expenseFunds.forEach((_, index) => formula('Savings goals', `D${funds.first + index}`, `=MAX(0,B${funds.first + index}-C${funds.first + index})`));
  }
  if (state.expensePlanItems?.length || sheets.has('Planned spending')) block('Planned spending', 'Planned spending', ['Item', 'Amount', 'Note', 'Date', 'Category'], state.expensePlanItems.map(record => [record.name, dollars(record.amountCents), record.notes, date(record.date), categoryLimits(state, record.entityId).find(limit => limit.id === record.categoryId)?.name ?? 'Uncategorized']), { B: money, D: dateFormat });
  if (state.wishItems?.length || sheets.has('Wish list')) block('Wish list', 'Wish list', ['Item', 'Expected cost', 'Note'], state.wishItems.map(record => [record.name, dollars(record.costCents), [record.priority === 'essential' ? 'Essential' : record.priority === 'optional' ? 'Optional' : '', record.comment].filter(Boolean).join('\n')]), { B: money });

  if (state.positions?.length || sheets.has('Investments')) {
    init('Investments', 'CAD and SOL. Account balances already include recorded investment value. These quantities are not added again in Home.', [38, 25, 25, 25, 22, 19, 21]);
    block('Investments', '', ['Account', 'Liquid SOL', 'Staked SOL', 'Rewards SOL', 'CAD per SOL', 'Price date', 'Cost basis'], state.positions.map(record => [accountName(record.accountId), record.liquidSol, record.stakedSol, record.rewardsSol, dollars(record.priceCents), date(record.priceDate), dollars(record.costBasisCents)]), { E: money, F: dateFormat, G: money });
    sheets.get('Investments').getRange('A3').values = [['SOL quantities are text to preserve precision beyond 15 digits.']];
  }

  const statementLinks = statements.filter(statement => statement.status === 'Recorded').flatMap(statement => statement.rows.map(entry => {
    const transactionRow = transactionBySource.get(statementRowKey(statement.id, entry.id));
    assert.ok(transactionRow, 'A recorded statement entry is missing from Transactions.');
    const transaction = transactions[transactionRow - 6];
    assert.equal(Math.abs(transaction.amountCents), Math.abs(entry.amountCents), 'Statement and ledger amounts must match.');
    return { statement, entry, transaction, sign: entry.amountCents === transaction.amountCents ? 1 : -1 };
  })).sort((a, b) => newest('transactionDate')(a.entry, b.entry));
  const links = block('Statement entries', '', ['Statement ID', 'Entry ID', 'Transaction ID', 'Date', 'Description', 'Sign', 'Ledger amount', 'Signed movement'], statementLinks.map(({ statement, entry, transaction, sign }) => [statement.id, entry.id, transaction.id, date(entry.transactionDate), entry.description, sign, null, null]), { D: dateFormat, F: '0', G: money, H: money });
  statementLinks.forEach((_, index) => {
    const row = links.first + index;
    formula('Statement entries', `G${row}`, `=_xlfn.XLOOKUP(C${row},TableTransactions[Transaction ID],TableTransactions[Amount])`);
    formula('Statement entries', `H${row}`, `=F${row}*G${row}`);
  });
  init('Sources', 'Original documents and qualifications. Statement movement links directly to the single Transactions ledger.', [14, 35, 17, 17, 18, 18, 18, 18, 10, 28, 42]);
  const statementBlock = block('Sources', 'Statement reconciliation', ['Statement', 'Account', 'From', 'Through', 'Opening', 'Ledger movement', 'Closing', 'Difference', 'Entries', 'Source / status', 'Statement ID'], statements.map(statement => [statementRefs.get(statement.id), accountName(statement.accountId), date(statement.periodStart), date(statement.periodEnd), dollars(statement.openingBalanceCents), null, dollars(statement.closingBalanceCents), null, statement.rows.length, `${sourceRefs.get(statement.sha256) ?? sourceRef(statement.sourceFile)} / ${statement.status}`, statement.id]), { C: dateFormat, D: dateFormat, E: money, F: money, G: money, H: money, I: '#,##0' });
  statements.forEach((statement, index) => {
    const row = statementBlock.first + index;
    if (statement.status === 'Recorded') {
      formula('Sources', `F${row}`, `=SUMIFS(TableStatemententries[Signed movement],TableStatemententries[Statement ID],K${row})`);
      formula('Sources', `H${row}`, `=ROUND(E${row}+F${row}-G${row},2)`);
      assert.equal(statement.openingBalanceCents + statement.rows.reduce((total, entry) => total + entry.amountCents, 0), statement.closingBalanceCents, 'Recorded statements must reconcile before export.');
    } else {
      statementBlock.sheet.getRange(`F${row}`).values = [[null]];
      statementBlock.sheet.getRange(`H${row}`).values = [[null]];
    }
  });
  if (statements.length) statementBlock.sheet.getRange(`H${statementBlock.first}:H${statementBlock.last}`).conditionalFormats.add('cellIs', { operator: 'notEqual', formula: 0, format: { fill: '#FBE7E2', font: { color: '#922B18' } } });
  const pendingRows = statements.filter(statement => statement.status === 'Pending').flatMap(statement => statement.rows.map(entry => [statementRefs.get(statement.id), date(entry.transactionDate), date(entry.postingDate), entry.description, dollars(entry.amountCents), entry.kind, entry.category || 'Uncategorized', entry.sourcePage])).sort((a, b) => b[1] - a[1]);
  if (pendingRows.length || sheets.has('Pending imports')) block('Pending imports', 'Pending imports, excluded from recorded totals', ['Statement', 'Date', 'Posted', 'Original description', 'Amount', 'Review type', 'Category', 'Page'], pendingRows, { B: dateFormat, C: dateFormat, E: money, H: '0' });
  block('Documents', 'Original documents', ['Source', 'File', 'Document date', 'Description', 'Open original'], sourceDocuments.map(document => [sourceRefs.get(document.sha256), document.originalName, date(document.documentDate), document.notes, `http://127.0.0.1:5191/api/documents/${document.id}/content?workspace=${encodeURIComponent(state.workspace)}`]), { C: dateFormat }, { rowHeight: 76 });
  const facts = (state.sourceFacts ?? []).map(fact => [fact.label, fact.value, date(fact.asOf), sourceRef(fact.sourceFile), fact.note]);
  if (facts.length || sheets.has('Reported figures')) block('Reported figures', 'Reported figures and history', ['Subject', 'Reported value', 'As of', 'Source', 'Qualification'], facts, { C: dateFormat });
  const evidenceNotes = accounts.filter(account => account.evidence?.notes).map(account => [account.name, account.evidence.notes, date(account.evidence.asOf), sourceRef(account.evidence.sourceFile), account.id]);
  if (evidenceNotes.length || sheets.has('Balance notes')) block('Balance notes', 'Balance qualifications', ['Account', 'Qualification', 'As of', 'Source', 'Account ID'], evidenceNotes, { C: dateFormat });

  const homeSums = [
    'SUMIF(TableAccounts[Type],"Cash",TableAccounts[Balance])',
    'SUMIF(TableAccounts[Type],"Investment",TableAccounts[Balance])',
    'SUMIF(TableAccounts[Type],"Receivable",TableAccounts[Balance])+SUM(TableReceivables[Counted value])',
    'SUM(TableAssets[Paid / equity])',
    sheets.has('Owned items') ? 'SUM(TableOwneditems[Counted value])' : '0',
    'SUMIF(TableAccounts[Type],"Debt",TableAccounts[Balance])+SUMIF(TableAccounts[Type],"Payable",TableAccounts[Balance])',
  ];
  formula('Home', `B${home.first}`, `=SUM(B${home.first + 1}:B${home.first + 5})-B${home.first + 6}`);
  homeSums.forEach((expression, index) => formula('Home', `B${home.first + index + 1}`, `=${expression}`));
  sheets.get('Home').getRange('D3').values = [['Mazal layout 10']];
  sheets.get('Home').getRange('A3').values = [['Update records in Mazal, then refresh this export. Excel edits do not sync back.']];
  sheets.get('Home').getRange(`A${home.first}:C${home.first}`).format.font = { name: font, size: 12, bold: true, color: ink };
  sheets.get('Home').getRange(`A${home.first}:C${home.first}`).format.rowHeight = 38;

  const subtotalRows = new Map();
  for (const job of pendingSums) {
    let subtotalNumber = 0;
    const expression = excelSumExpression(job.terms, subtotal => {
      const rows = subtotalRows.get(job.name) ?? [];
      const row = nextRows.get(job.name) + 2 + rows.length;
      rows.push([`${job.label}, subtotal ${++subtotalNumber}`, subtotal]);
      subtotalRows.set(job.name, rows);
      return ref(job.name, `B${row}`);
    });
    formula(job.name, job.cell, `=${expression}`);
  }
  for (const [name, rows] of subtotalRows) {
    const subtotals = block(name, 'Calculation subtotals', ['Calculation', 'Amount'], rows.map(([label]) => [label, null]), { B: money }, { filter: false });
    rows.forEach(([, expression], index) => formula(name, `B${subtotals.first + index}`, `=${expression}`));
  }
  for (const location of formulaCells) sheets.get(location.sheet).getRange(location.cell).formulas = [[location.formula]];
  for (const item of previews) formatRows(item);
  workbook.recalculate(formulaCells);
  assertWorkbookFormulaResults(formulaCells.map(location => ({ ...location, value: sheets.get(location.sheet).getRange(location.cell).values[0][0] })));
  const getNumber = (name, cell) => {
    const value = sheets.get(name).getRange(cell).values[0][0];
    assert.equal(typeof value, 'number', `${name}!${cell} must calculate a numeric result.`);
    return value;
  };
  const roundCents = value => Math.round(value * 100);
  let netWorthCents = accounts.reduce((total, account) => total + account.balanceCents * (['debt', 'payable'].includes(account.type) ? -1 : 1), 0);
  for (const purchase of purchases) if (purchase.paidCents !== null) netWorthCents += purchase.paidCents;
  for (const record of receivables) if (!accounts.some(account => account.id === record.id && account.entityId === record.entityId && account.type === 'receivable')) netWorthCents += Math.max(0, record.amountCents - record.payments.reduce((total, payment) => total + payment.amountCents, 0));
  for (const record of heldAssets) if (record.status !== 'sold' && record.estimatedValueCents !== null && !purchases.some(purchase => purchase.id === record.id && purchase.entityId === record.entityId)) netWorthCents += Math.max(0, record.estimatedValueCents - record.feesCents);
  assert.equal(roundCents(getNumber('Home', `B${home.first}`)), netWorthCents, 'Home net worth must match personal balances and asset counting.');
  assert.equal(roundCents(getNumber('Expenses', `B${expenseTotal.first}`)), expenses.reduce((total, transaction) => total + transaction.amountCents, 0), 'Expense totals must preserve refunds and exclude transfers and payments.');
  categories.forEach((category, index) => {
    const selected = expenses.filter(transaction => appCategory(transaction) === category);
    assert.equal(roundCents(getNumber('Expenses', `B${categoryBlock.first + index}`)), selected.reduce((total, transaction) => total + transaction.amountCents, 0), `The ${category} total must match the app category rules.`);
    assert.equal(getNumber('Expenses', `${expenseColumns.count}${categoryBlock.first + index}`), selected.length);
  });
  debtAccounts.forEach((account, index) => {
    const apr = effectiveDebtApr(account);
    const exportedApr = sheets.get('Debts').getRange(`C${debtBlock.first + index}`).values[0][0];
    if (apr === null) assert.ok(exportedApr === null || exportedApr === '', 'Unknown or unreconciled loan portions must keep APR blank.');
    else assert.ok(Math.abs(getNumber('Debts', `C${debtBlock.first + index}`) * 100 - apr) < 1e-10, 'Workbook APR must match the app interest model.');
    assert.equal(sheets.get('Payment terms').getRange(`C${termsRows.get(account.id)}`).values[0][0], effectiveDebtApr(account, true) === null ? 'No' : 'Yes', 'Rate confirmation must follow the applicable loan portions.');
    const required = account.balanceCents > 0 ? requiredDebtPaymentCents(account, cutoff) : 0;
    if (required !== null) assert.equal(roundCents(getNumber('Debts', `D${debtBlock.first + index}`)), required, 'Paid-off and deferred debts must not add a required payment.');
  });
  const paymentSummary = debtPaymentSummary(debtAccounts, cutoff);
  assert.equal(roundCents(getNumber('Debts', `B${debtTotals.first + 1}`)), paymentSummary.recordedMinimumsCents, 'Required payments must match the app.');
  assert.equal(getNumber('Debts', `B${debtTotals.first + 2}`), paymentSummary.unknownPayments, 'Paid-off and deferred debts must not count as missing minimums.');
  statements.forEach((statement, index) => { if (statement.status === 'Recorded') assert.equal(getNumber('Sources', `H${statementBlock.first + index}`), 0, 'Recorded statement reconciliation must be zero.'); });
  if (options.previews) {
    await fs.mkdir(options.previews, { recursive: true, mode: 0o700 });
    const manifest = [];
    for (const [index, item] of previews.entries()) {
      const first = item.start === 5 ? 1 : item.start;
      const last = Math.min(item.last, item.first + 14);
      const range = `A${first}:${item.end}${last}`;
      const filename = `${item.name.toLowerCase()}-${String(index + 1).padStart(2, '0')}.svg`;
      const values = sheets.get(item.name).getRange(range).values;
      const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${values[0].length * 220}" height="${values.length * 32}"><rect width="100%" height="100%" fill="white"/>${values.flatMap((row, r) => row.map((value, c) => `<text x="${c * 220 + 8}" y="${r * 32 + 21}" font-family="sans-serif" font-size="11">${escape(value instanceof Date ? value.toISOString().slice(0, 10) : value)}</text>`)).join('')}</svg>`;
      await fs.writeFile(path.join(options.previews, filename), svg);
      manifest.push({ sheet: item.name, label: item.label, range, filename });
    }
    await fs.writeFile(path.join(options.previews, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  await fs.mkdir(path.dirname(options.output), { recursive: true, mode: 0o700 });
  await workbook.write(options.output, formulaCells);
  await fs.chmod(options.output, 0o600);
  const scenarioApr = sheets.get('Plan').getRange(`B${planRows.get('loanAprPercent')}`).values[0][0];
  console.log(JSON.stringify({ output: options.output, revision: state.revision, asOfDate: cutoff, exportScope: 'personal', formulaErrors: 0, scenarioAprPercent: typeof scenarioApr === 'number' ? scenarioApr * 100 : null, categoryTotals: Object.fromEntries(categories.map((category, index) => [category, roundCents(getNumber('Expenses', `B${categoryBlock.first + index}`))])), statementCoverage: coverage, sheets: sheets.size, updateMode: updating ? 'tables' : 'migration', transactions: transactions.length, sources: sourceDocuments.length, statements: statements.length, netWorthCents, requiredPaymentsCents: roundCents(getNumber('Debts', `B${debtTotals.first + 1}`)), unknownPayments: getNumber('Debts', `B${debtTotals.first + 2}`), calculationSubtotals: [...subtotalRows.values()].reduce((total, rows) => total + rows.length, 0), effectiveAprPercent: Object.fromEntries(debtAccounts.map((account, index) => { const apr = sheets.get('Debts').getRange(`C${debtBlock.first + index}`).values[0][0]; return [account.id, typeof apr === 'number' ? apr * 100 : null]; })) }));
}
