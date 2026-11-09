import type { ImportRow } from './types.ts';

export function parseCSVRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  const pushRow = () => {
    row.push(field);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
    if (rows.length > 5001) throw new Error('Import up to 5,000 transactions at a time.');
    row = [];
    field = '';
    closedQuote = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; closedQuote = true; }
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        field += '\n';
        line += 1;
      } else field += character;
      continue;
    }
    if (character === ',') {
      row.push(field);
      field = '';
      closedQuote = false;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      pushRow();
      line += 1;
    } else if (character === '"' && field.length === 0 && !closedQuote) quoted = true;
    else if (closedQuote && /[ \t]/.test(character)) continue;
    else if (character === '"' || closedQuote) throw new Error(`CSV line ${line} has an unexpected character beside a quote.`);
    else field += character;
  }
  if (quoted) throw new Error(`CSV line ${line} has an unclosed quoted field.`);
  pushRow();
  return rows;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function cents(value: string, row: number): number {
  const normalized = value.trim().replace(/^([+-]?)\$\s*/, '$1');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Row ${row}: Amount must be signed dollars with at most two decimal places, such as -42.50.`);
  }
  const sign = normalized.startsWith('-') ? -1n : 1n;
  const unsigned = normalized.replace(/^[+-]/, '').replaceAll(',', '');
  const [dollars, fraction = ''] = unsigned.split('.');
  const amount = (BigInt(dollars) * 100n + BigInt(fraction.padEnd(2, '0'))) * sign;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER) || amount === 0n) {
    throw new Error(`Row ${row}: Amount must be nonzero and within the supported range.`);
  }
  return Number(amount);
}

export function parseCSV(text: string): ImportRow[] {
  const parsed = parseCSVRecords(text.replace(/^\uFEFF/, ''));
  if (parsed.length === 0) throw new Error('The CSV is empty. Include Date, Description, and Amount headers.');
  const headers = parsed[0].map((header) => header.trim().toLowerCase());
  const indexes = {
    date: headers.indexOf('date'), description: headers.indexOf('description'),
    amount: headers.indexOf('amount'), category: headers.indexOf('category'),
  };
  if (indexes.date < 0 || indexes.description < 0 || indexes.amount < 0) {
    throw new Error('Include Date, Description, and Amount headers. Dates must use YYYY-MM-DD.');
  }
  if (new Set(headers).size !== headers.length) throw new Error('The CSV has duplicate column headers.');
  return parsed.slice(1).map((record, index) => {
    const row = index + 2;
    if (record.length !== headers.length) throw new Error(`Row ${row}: Expected ${headers.length} columns. Put values containing commas inside double quotes.`);
    const date = record[indexes.date].trim();
    const description = record[indexes.description].trim();
    if (!validDate(date)) throw new Error(`Row ${row}: Date must be a valid calendar date in YYYY-MM-DD format.`);
    if (!description) throw new Error(`Row ${row}: Description is required.`);
    const result: ImportRow = { date, description, amountCents: cents(record[indexes.amount], row) };
    if (indexes.category >= 0 && record[indexes.category].trim()) result.category = record[indexes.category].trim();
    return result;
  });
}
