import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatementCSV, statementBalanceCheck } from './statement-csv.ts';

const header = 'TransactionDate,PostingDate,Description,Amount';
test('complete statement CSV keeps posting dates, exact descriptions, repeated rows and signed movements', () => {
  const rows = parseStatementCSV(`\uFEFF${header},Category\r\n2026-01-01,2026-01-03,"  Coffee, shop  ",-1.20,Food\r\n2026-01-01,2026-01-03,"  Coffee, shop  ",-1.20,Food\r\n2026-01-04,2026-01-05,Refund,+1.20,Food\r\n2026-01-08,2026-01-08,Card payment,-100.00,Transfer`);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { id: 'row-1', transactionDate: '2026-01-01', postingDate: '2026-01-03', description: '  Coffee, shop  ', amountCents: -120, sourcePage: 1 });
  assert.equal(rows[1].amountCents, -120);
  assert.equal(rows[2].amountCents, 120);
  assert.equal(rows[3].amountCents, -10000);
  assert.equal(rows.some(row => 'category' in row || 'kind' in row), false);
  assert.deepEqual(statementBalanceCheck(rows, '2026-01-01', '2026-01-31', '200.00', '98.80'), { openingBalanceCents: 20000, closingBalanceCents: 9880, rowTotalCents: -10120, differenceCents: 0 });
});
test('statement CSV rejects missing posting dates and malformed entries instead of inventing or dropping them', () => {
  assert.throws(() => parseStatementCSV('Date,Description,Amount\n2026-01-01,Shop,-1'), /Both dates are required/);
  for (const [line, message] of [
    ['2026-02-29,2026-03-01,Shop,1', /valid date/],
    ['2026-01-02,2026-01-01,Shop,1', /cannot precede/],
    ['2026-01-01,,Shop,1', /Posting date/],
    ['2026-01-01,2026-01-01,Shop,0', /nonzero/],
    ['2026-01-01,2026-01-01,Shop,1.001', /two decimal/],
    ['2026-01-01,2026-01-01,Shop,+-1.00', /two decimal/],
    ['2026-01-01,2026-01-01,Shop,1000000000000.01', /too large/],
  ] as const) assert.throws(() => parseStatementCSV(`${header}\n${line}`), message);
});
test('statement balance check requires explicit zero balances, full period coverage and exact cents', () => {
  const rows = parseStatementCSV(`${header}\n2026-01-01,2026-01-02,Purchase,10\n2026-01-03,2026-01-04,Payment,-10`);
  assert.throws(() => statementBalanceCheck(rows, '2026-01-01', '2026-01-31', '', '0'), /opening balance/);
  assert.throws(() => statementBalanceCheck(rows, '2026-01-01', '2026-01-31', '0', ''), /closing balance/);
  assert.throws(() => statementBalanceCheck(rows, '2026-01-03', '2026-01-31', '0', '0'), /Every posting date/);
  assert.equal(statementBalanceCheck(rows, '2026-01-01', '2026-01-31', '0', '0').differenceCents, 0);
  assert.equal(statementBalanceCheck(rows, '2026-01-01', '2026-01-31', '0', '0.01').differenceCents, -1);
});

test('bank activity CSV round trip leaves the unknown source date blank and retains its basis', async () => {
  const { statementRowsCSV } = await import('./statement-csv.ts');
  const rows = (['posting_only', 'transaction_only'] as const).map((dateBasis, index) => ({ id: `row-${index + 1}`, transactionDate: '2026-01-02', postingDate: '2026-01-02', dateBasis, description: 'Single bank date', amountCents: -100, sourcePage: 2 }));
  const csv = statementRowsCSV(rows);
  assert.match(csv, /"","2026-01-02","Single bank date","-1.00","2","posting_only"/);
  assert.match(csv, /"2026-01-02","","Single bank date","-1.00","2","transaction_only"/);
  assert.deepEqual(parseStatementCSV(csv, 'bank_activity'), rows);
  assert.throws(() => parseStatementCSV(csv), /only supported for bank activity/);
  assert.throws(() => parseStatementCSV(`${header},DateBasis\n2026-01-01,2026-01-02,Shop,-1,posting_only`, 'bank_activity'), /must use its supplied date/);
  assert.throws(() => parseStatementCSV(`${header},DateBasis\n2026-01-01,2026-01-01,Shop,-1,unknown`, 'bank_activity'), /DateBasis must/);
});
