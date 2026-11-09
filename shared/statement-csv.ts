import { parseCSVRecords } from './csv.ts';
import { parseMoneyCents } from './money-input.ts';
import type { StatementSource, StatementSourceRow } from './types.ts';

export const statementCSVHeader = 'TransactionDate,PostingDate,Description,Amount';

export function statementDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`${label} must be a valid date in YYYY-MM-DD format.`);
  return value;
}

export function statementRowsCSV(rows: StatementSourceRow[]): string {
  return ['TransactionDate,PostingDate,Description,Amount,SourcePage,DateBasis', ...rows.map(row => [row.dateBasis === 'posting_only' ? '' : row.transactionDate, row.dateBasis === 'transaction_only' ? '' : row.postingDate, row.description, (row.amountCents / 100).toFixed(2), String(row.sourcePage), row.dateBasis ?? ''].map(value => `"${value.replaceAll('"', '""')}"`).join(','))].join('\n');
}

export function parseStatementCSV(text: string, sourceKind?: StatementSource['sourceKind']): StatementSourceRow[] {
  const records = parseCSVRecords(text.replace(/^\uFEFF/, ''));
  if (!records.length) throw new Error(`The CSV is empty. Include ${statementCSVHeader} headers.`);
  const headers = records[0].map(value => value.trim().toLowerCase());
  const columns = ['transactiondate', 'postingdate', 'description', 'amount'].map(name => headers.indexOf(name));
  if (columns.some(index => index < 0)) throw new Error(`Include ${statementCSVHeader} headers. Both dates are required; use YYYY-MM-DD.`);
  if (new Set(headers).size !== headers.length) throw new Error('The CSV has duplicate column headers.');
  const pageColumn = headers.indexOf('sourcepage');
  const basisColumn = headers.indexOf('datebasis');
  const rows = records.slice(1).map((record, index) => {
    const row = index + 2;
    if (record.length !== headers.length) throw new Error(`Row ${row}: Expected ${headers.length} columns. Put values containing commas inside double quotes.`);
    const basis = basisColumn < 0 ? '' : record[basisColumn].trim();
    if (basis && basis !== 'posting_only' && basis !== 'transaction_only') throw new Error(`Row ${row}: DateBasis must be posting_only or transaction_only.`);
    const dateBasis: StatementSourceRow['dateBasis'] = basis === 'posting_only' ? 'posting_only' : basis === 'transaction_only' ? 'transaction_only' : undefined;
    if (dateBasis !== undefined && sourceKind !== 'bank_activity') throw new Error(`Row ${row}: A single supplied date is only supported for bank activity.`);
    const suppliedTransaction = record[columns[0]].trim(), suppliedPosting = record[columns[1]].trim();
    const transactionDate = statementDate(dateBasis === 'posting_only' ? suppliedPosting : suppliedTransaction, `Row ${row}: Transaction date`);
    const postingDate = statementDate(dateBasis === 'transaction_only' ? suppliedTransaction : suppliedPosting, `Row ${row}: Posting date`);
    if (dateBasis === 'posting_only' && suppliedTransaction && suppliedTransaction !== postingDate || dateBasis === 'transaction_only' && suppliedPosting && suppliedPosting !== transactionDate) throw new Error(`Row ${row}: Single-date bank activity must use its supplied date for both ledger dates.`);
    if (transactionDate > postingDate) throw new Error(`Row ${row}: Posting date cannot precede transaction date.`);
    const description = record[columns[2]];
    if (!description.trim() || description.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(description)) throw new Error(`Row ${row}: Description must contain 1 to 500 characters of text.`);
    const amount = record[columns[3]].trim();
    if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(amount)) throw new Error(`Row ${row}: Amount must be signed dollars with at most two decimal places.`);
    const amountCents = parseMoneyCents(amount.replace(/^\+/, ''), { signed: true, maxCents: 100_000_000_000_000, invalidMessage: `Row ${row}: Amount must be signed dollars with at most two decimal places.`, rangeMessage: `Row ${row}: Amount is too large.` });
    if (amountCents === 0) throw new Error(`Row ${row}: Amount must be nonzero.`);
    const sourcePage = pageColumn < 0 ? 1 : Number(record[pageColumn].trim());
    if (!Number.isSafeInteger(sourcePage) || sourcePage < 1 || sourcePage > 10000) throw new Error(`Row ${row}: SourcePage must be a whole number from 1 to 10,000.`);
    return { id: `row-${index + 1}`, transactionDate, postingDate, description, amountCents, sourcePage, ...(dateBasis === undefined ? {} : { dateBasis }) };
  });
  if (!rows.length) throw new Error('The statement does not contain any transaction rows.');
  return rows;
}

export function statementBalanceCheck(rows: StatementSourceRow[], periodStart: string, periodEnd: string, opening: string, closing: string) {
  statementDate(periodStart, 'Period start');
  statementDate(periodEnd, 'Period end');
  if (periodEnd < periodStart) throw new Error('Period end must be on or after period start.');
  if (!rows.length) throw new Error('Choose a complete statement CSV.');
  if (rows.some(row => row.postingDate < periodStart || row.postingDate > periodEnd)) throw new Error('Every posting date must fall within the statement period. Check the dates or choose the complete file for this period.');
  const openingBalanceCents = parseMoneyCents(opening, { signed: true, maxCents: 100_000_000_000_000, invalidMessage: 'Enter the opening balance from the statement in dollars and cents.', rangeMessage: 'The opening balance is too large.' });
  const closingBalanceCents = parseMoneyCents(closing, { signed: true, maxCents: 100_000_000_000_000, invalidMessage: 'Enter the closing balance from the statement in dollars and cents.', rangeMessage: 'The closing balance is too large.' });
  const rowTotal = rows.reduce((total, row) => total + BigInt(row.amountCents), 0n);
  const difference = BigInt(openingBalanceCents) + rowTotal - BigInt(closingBalanceCents);
  if (rowTotal > BigInt(Number.MAX_SAFE_INTEGER) || rowTotal < BigInt(Number.MIN_SAFE_INTEGER) || difference > BigInt(Number.MAX_SAFE_INTEGER) || difference < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('The statement total is too large.');
  return { openingBalanceCents, closingBalanceCents, rowTotalCents: Number(rowTotal), differenceCents: Number(difference) };
}
