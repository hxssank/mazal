function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value) {
    value -= 1;
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function sameValue(left, right) {
  if (left == null && right == null) return true;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  return left === right;
}

function tableBounds(table) {
  const address = table.getHeaderRowRange().address.split('!').at(-1).replaceAll('$', '');
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(address);
  if (!match) throw new Error(`Cannot read the header range for ${table.name}.`);
  const number = letters => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
  return { left: number(match[1]), right: number(match[3] ?? match[1]), top: Number(match[2]), bottom: Number(match[2]) + table.getDataRows().length };
}

export function syncTable({ sheet, tableName, header, headers, rows }) {
  if (!Number.isInteger(header) || header < 1) throw new Error('The table header must be a positive row number.');
  if (typeof tableName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) throw new Error('The table needs a stable Excel table name.');
  if (!Array.isArray(headers) || !headers.length || headers.some(value => typeof value !== 'string' || !value.trim())) throw new Error(`${tableName} needs nonblank column names.`);
  if (new Set(headers.map(value => value.toLowerCase())).size !== headers.length) throw new Error(`${tableName} column names must be unique.`);
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== headers.length)) throw new Error(`${tableName} rows must match its column count.`);
  const normalized = rows.map(row => row.map(value => value ?? null));
  const values = normalized.length ? normalized : [headers.map(() => null)];
  const first = header + 1;
  const last = header + values.length;
  const end = columnName(headers.length - 1);
  const range = `A${header}:${end}${last}`;
  const dataRange = `A${first}:${end}${last}`;
  let table = sheet.tables.items.find(item => item.name === tableName);
  const created = !table;
  let previousRows = [];
  let previousFormulas = [];
  if (table) {
    const bounds = tableBounds(table);
    const previousHeaders = table.getHeaderRowRange().values[0];
    if (bounds.left !== 1 || bounds.right !== headers.length || bounds.top !== header || headers.some((value, index) => previousHeaders[index] !== value)) {
      throw new Error(`${tableName} has a different location or columns. Migrate the workbook layout before syncing it.`);
    }
    previousRows = table.getDataRows();
    if (previousRows.length) previousFormulas = sheet.getRange(`A${first}:${end}${header + previousRows.length}`).formulas;
  }
  for (const other of sheet.tables.items) {
    if (other.name === tableName) continue;
    const bounds = tableBounds(other);
    if (bounds.left <= headers.length && bounds.right >= 1 && bounds.top <= last && bounds.bottom >= header) {
      throw new Error(`${tableName} would overlap ${other.name}.`);
    }
  }

  const appendedRows = table ? Math.max(0, values.length - previousRows.length) : values.length;
  const removedRows = Math.max(0, previousRows.length - values.length);
  const recreated = Boolean(table && removedRows);
  if (recreated) {
    const settings = {
      style: table.style,
      showHeaders: table.showHeaders,
      showTotals: table.showTotals,
      showBandedColumns: table.showBandedColumns,
      showFilterButton: table.showFilterButton,
    };
    table.delete();
    sheet.getRange(`A${last + 1}:${end}${header + previousRows.length}`).clear({ applyTo: 'contents' });
    table = sheet.tables.add(range, true, tableName);
    for (const [key, value] of Object.entries(settings)) if (value !== undefined) table[key] = value;
  } else if (table && appendedRows) {
    table.rows.add(null, values.slice(previousRows.length));
  }

  let changedRows = 0;
  let changedStart = -1;
  const commonRows = table ? Math.min(previousRows.length, values.length) : values.length;
  const flush = next => {
    if (changedStart < 0) return;
    sheet.getRange(`A${first + changedStart}:${end}${first + next - 1}`).values = values.slice(changedStart, next);
    changedStart = -1;
  };
  for (let index = 0; index < commonRows; index += 1) {
    const previous = previousRows[index];
    const changed = !previous || values[index].some((value, column) => !sameValue(previous[column], value) || Boolean(previousFormulas[index]?.[column]));
    if (changed) {
      changedRows += 1;
      if (changedStart < 0) changedStart = index;
    } else flush(index);
  }
  flush(commonRows);
  if (!table) {
    sheet.getRange(`A${header}:${end}${header}`).values = [headers];
    table = sheet.tables.add(range, true, tableName);
  }
  return { table, header, first, last, end, range, dataRange, rowCount: rows.length, tableRowCount: values.length, created, recreated, changedRows, appendedRows, removedRows };
}
