import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCSV } from './csv.ts';

test('CSV reads BOM, mixed-case headers, signed dollars, exact cents and optional categories', () => {
  assert.deepEqual(parseCSV('\uFEFFdate,DESCRIPTION,Amount,Category\r\n2026-09-20,Salary,"$1,234.56",Income\r\n2026-09-21,Coffee,-$4.05,Food\r\n2026-09-22,Interest,+0.10,\r\n'), [
    { date: '2026-09-20', description: 'Salary', amountCents: 123_456, category: 'Income' },
    { date: '2026-09-21', description: 'Coffee', amountCents: -405, category: 'Food' },
    { date: '2026-09-22', description: 'Interest', amountCents: 10 },
  ]);
});

test('CSV preserves quoted commas, doubled quotes and multiline descriptions and skips blank records', () => {
  const input = '\nDate,Description,Amount\n\n2026-02-28,"Groceries, including ""rice""",-12.34\r\n2026-03-01,"Two\r\nlines",1\n,,\n';
  assert.deepEqual(parseCSV(input), [
    { date: '2026-02-28', description: 'Groceries, including "rice"', amountCents: -1234 },
    { date: '2026-03-01', description: 'Two\nlines', amountCents: 100 },
  ]);
});

test('CSV rejects ambiguous dates, impossible dates and nonleap February 29', () => {
  for (const date of ['09/10/2026', '2026-2-01', '2026-02-29', '2026-04-31', '2026-13-01']) {
    assert.throws(() => parseCSV(`Date,Description,Amount\n${date},Test,-1`), /Date must be a valid calendar date/);
  }
  assert.equal(parseCSV('Date,Description,Amount\n2028-02-29,Leap,1')[0].date, '2028-02-29');
});

test('CSV rejects precision loss, exponent notation, zero and broken thousand separators', () => {
  for (const amount of ['1.001', '1e4', '0', '-0.00', 'NaN', '12,34.00', '90071992547409.92']) {
    assert.throws(() => parseCSV(`Date,Description,Amount\n2026-09-22,Test,"${amount}"`), /Amount/);
  }
  assert.equal(parseCSV('Date,Description,Amount\n2026-09-22,Test,0.29')[0].amountCents, 29);
  assert.equal(parseCSV('Date,Description,Amount\n2026-09-22,Test,90071992547409.91')[0].amountCents, Number.MAX_SAFE_INTEGER);
});

test('CSV fails as a whole when any row is invalid', () => {
  assert.throws(() => parseCSV('Date,Description,Amount\n2026-09-20,Valid,1\n2026-09-21,,2'), /Row 3: Description is required/);
  assert.throws(() => parseCSV('Date,Description,Amount\n2026-09-20,Too,many,1'), /Expected 3 columns/);
});

test('CSV rejects missing or duplicate headers and malformed quoted fields', () => {
  assert.throws(() => parseCSV(''), /CSV is empty/);
  assert.throws(() => parseCSV('Date,Memo,Amount'), /Include Date, Description, and Amount/);
  assert.throws(() => parseCSV('Date,Description,Amount,Amount'), /duplicate column headers/);
  assert.throws(() => parseCSV('Date,Description,Amount\n2026-09-22,"Open quote,1'), /unclosed quoted field/);
  assert.throws(() => parseCSV('Date,Description,Amount\n2026-09-22,"Closed"junk,1'), /unexpected character/);
  assert.throws(() => parseCSV('Date,Description,Amount\n2026-09-22,Unquoted"quote,1'), /unexpected character/);
});

test('CSV accepts 5,000 records and rejects record 5,001', () => {
  const header = 'Date,Description,Amount\n';
  const record = '2026-09-22,Record,-1\n';
  assert.equal(parseCSV(header + record.repeat(5000)).length, 5000);
  assert.throws(() => parseCSV(header + record.repeat(5001)), /5,000 transactions/);
});
