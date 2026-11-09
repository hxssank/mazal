import ExcelJS from 'exceljs';
import FormulaParser from 'fast-formula-parser';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

async function workbookBytes(path) {
  const bytes = await readFile(path), zip = await JSZip.loadAsync(bytes);
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  let changed = false;
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir && entry.name.endsWith('.rels')) {
      const xml = await entry.async('string');
      const normalized = xml.replace(/<Relationship\b[^>]*>/g, relationship => relationship.includes('TargetMode="External"') ? relationship : relationship.replace(/Target="\/([^"]*)"/, (_, target) => `Target="${posix.relative(posix.dirname(posix.dirname(entry.name)), target)}"`));
      if (normalized !== xml) { zip.file(entry.name, normalized); changed = true; }
      continue;
    }
    if (entry.dir || !entry.name.startsWith('xl/') || !entry.name.endsWith('.xml')) continue;
    const xml = await entry.async('string');
    const root = /<([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)\b([^>]*)>/.exec(xml);
    if (!root || !root[3].includes(`xmlns:${root[1]}="${namespace}"`)) continue;
    const prefix = root[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declarations = [...xml.matchAll(new RegExp(`xmlns:${prefix}="([^"]*)"`, 'g'))];
    if (declarations.some(match => match[1] !== namespace)) throw new Error(`Workbook XML rebinds the spreadsheet namespace in ${entry.name}.`);
    // ExcelJS expects unprefixed spreadsheet elements; older Mazal exports use x:.
    let normalized = xml.replace(new RegExp(`<(/?)${prefix}:(?=[A-Za-z_])`, 'g'), '<$1');
    if (!/\sxmlns=/.test(root[3])) normalized = normalized.replace(`<${root[2]}`, `<${root[2]} xmlns="${namespace}"`);
    zip.file(entry.name, normalized);
    changed = true;
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : bytes;
}

const serialDate = value => (value.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
const column = number => { let result = ''; for (; number; number = Math.floor((number - 1) / 26)) result = String.fromCharCode(65 + (number - 1) % 26) + result; return result; };
const columnNumber = name => [...name].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
const bounds = address => {
  const match = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(address);
  if (!match) throw new Error(`Invalid workbook range ${address}.`);
  return { left: columnNumber(match[1]), top: Number(match[2]), right: columnNumber(match[3] ?? match[1]), bottom: Number(match[4] ?? match[2]) };
};
const color = value => ({ argb: `FF${value.replace('#', '')}` });
const font = value => ({ ...value, ...(value.color ? { color: color(value.color) } : {}) });
const unpack = value => value && typeof value === 'object' && 'value' in value ? value.value : value;
const flat = value => [unpack(value)].flat(Infinity);
function matches(value, criterion) {
  const raw = unpack(criterion);
  const match = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(String(raw));
  const op = match[1] ?? '=';
  const expected = match[2] !== '' && Number.isFinite(Number(match[2])) ? Number(match[2]) : match[2];
  const actual = value == null ? typeof expected === 'number' ? 0 : '' : value;
  if (typeof expected === 'string' && ['=', '<>'].includes(op)) {
    let pattern = '';
    for (let index = 0; index < expected.length; index++) {
      const char = expected[index];
      if (char === '~' && index + 1 < expected.length) pattern += expected[++index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else pattern += char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    const same = new RegExp(`^${pattern}$`, 'i').test(String(actual));
    return op === '<>' ? !same : same;
  }
  if (op === '<>') return actual !== expected;
  if (op === '<') return actual < expected;
  if (op === '>') return actual > expected;
  if (op === '<=') return actual <= expected;
  if (op === '>=') return actual >= expected;
  return typeof expected === 'string' ? String(actual).toLowerCase() === expected.toLowerCase() : actual === expected;
}
function matchingRows(criteria) {
  const pairs = [];
  for (let index = 0; index < criteria.length; index += 2) pairs.push([flat(criteria[index]), criteria[index + 1]]);
  if (!pairs.length || pairs.some(([values]) => values.length !== pairs[0][0].length)) throw new Error('Mismatched formula criteria ranges.');
  return pairs[0][0].map((_, index) => pairs.every(([values, criterion]) => matches(values[index], criterion)));
}

class Range {
  constructor(sheet, address) { this.sheet = sheet; this.localAddress = address; this.address = `'${sheet.name}'!${address}`; Object.assign(this, bounds(address)); }
  cells(fn) { for (let row = this.top; row <= this.bottom; row++) for (let col = this.left; col <= this.right; col++) fn(this.sheet.native.getCell(row, col), row, col); }
  matrix(fn) { return Array.from({ length: this.bottom - this.top + 1 }, (_, r) => Array.from({ length: this.right - this.left + 1 }, (_, c) => fn(this.sheet.native.getCell(this.top + r, this.left + c)))); }
  get values() { return this.matrix(cell => this.sheet.book.value(this.sheet.name, cell.row, cell.col)); }
  set values(values) { this.cells((cell, r, c) => { cell.value = values[r - this.top]?.[c - this.left] ?? null; }); this.sheet.book.invalidate(); }
  get formulas() { return this.matrix(cell => cell.formula ? `=${cell.formula}` : null); }
  set formulas(values) { this.cells((cell, r, c) => { const formula = values[r - this.top]?.[c - this.left]; cell.value = formula ? { formula: formula.replace(/^=/, '') } : null; }); this.sheet.book.invalidate(); }
  setNumberFormat(value) { this.cells(cell => { cell.numFmt = value; }); }
  clear() { this.cells(cell => { cell.value = null; }); this.sheet.book.invalidate(); }
  set format(value) { for (const [key, setting] of Object.entries(value)) this.applyFormat(key, setting); }
  get format() { return new Proxy({ autofitRows: () => this.autofitRows() }, { set: (_, key, value) => { this.applyFormat(key, value); return true; } }); }
  applyFormat(key, value) {
    if (key === 'rowHeight') { for (let row = this.top; row <= this.bottom; row++) this.sheet.native.getRow(row).height = value; return; }
    if (key === 'columnWidth') { for (let col = this.left; col <= this.right; col++) this.sheet.native.getColumn(col).width = value; return; }
    this.cells(cell => {
      if (key === 'font') cell.font = font(value);
      else if (key === 'fill') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: color(value) };
      else if (key === 'borders') {
        const borders = {};
        for (const [side, setting] of Object.entries(value)) for (const edge of side === 'insideVertical' ? ['left', 'right'] : [side]) borders[edge] = { ...setting, color: color(setting.color) };
        cell.border = { ...cell.border, ...borders };
      } else { const mapped = { horizontalAlignment: 'horizontal', verticalAlignment: 'vertical' }[key] ?? key; cell.alignment = { ...cell.alignment, [mapped]: value }; }
    });
  }
  autofitRows() {
    for (let row = this.top; row <= this.bottom; row++) {
      let lines = 1;
      for (let col = this.left; col <= this.right; col++) { const cell = this.sheet.native.getCell(row, col); if (cell.formula) continue; const width = this.sheet.native.getColumn(col).width ?? 12; lines = Math.max(lines, ...String(cell.value ?? '').split('\n').map(line => Math.ceil(line.length / Math.max(width - 2, 1)))); }
      this.sheet.native.getRow(row).height = Math.max(this.sheet.native.getRow(row).height ?? 15, Math.min(180, lines * 15 + 8));
    }
  }
  get conditionalFormats() { return { add: (type, rule) => this.sheet.native.addConditionalFormatting({ ref: this.localAddress, rules: [{ type, operator: rule.operator, formulae: [String(rule.formula)], style: { fill: { type: 'pattern', pattern: 'solid', fgColor: color(rule.format.fill) }, font: font(rule.format.font) } }] }) }; }
}

class Table {
  constructor(sheet, native) { this.sheet = sheet; this.native = native; }
  get name() { return this.native.name; }
  getHeaderRowRange() { const b = bounds(this.native.table.ref); return this.sheet.getRange(`${column(b.left)}${b.top}:${column(b.left + this.native.table.columns.length - 1)}${b.top}`); }
  dataRows(fn) { const header = this.getHeaderRowRange(); const length = this.native.table.rows.length; return length ? this.sheet.getRange(`${column(header.left)}${header.top + 1}:${column(header.right)}${header.top + length}`).matrix(fn) : []; }
  getDataRows() { return this.dataRows(cell => cell.formula ? cell.result ?? null : cell.value); }
  get rows() { return { add: (_, rows) => { this.native.table.rows = this.dataRows(cell => structuredClone(cell.value)); for (const row of rows) this.native.addRow(row); this.native.commit(); this.sheet.book.invalidate(); } }; }
  get style() { return structuredClone(this.native.table.style); }
  set style(value) { this.native.table.style = typeof value === 'string' ? { theme: value, showRowStripes: true } : value; }
  get showHeaders() { return this.native.table.headerRow; }
  set showHeaders(value) { this.native.table.headerRow = value; }
  get showTotals() { return this.native.table.totalsRow; }
  set showTotals(value) { this.native.table.totalsRow = value; }
  get showBandedColumns() { return this.native.table.style.showColumnStripes; }
  set showBandedColumns(value) { this.native.table.style.showColumnStripes = value; }
  get showFilterButton() { return this.native.table.columns.every(item => item.filterButton !== false); }
  set showFilterButton(value) { for (const item of this.native.table.columns) item.filterButton = value; }
  delete() { this.sheet.native.removeTable(this.name); this.sheet.book.invalidate(); }
}

class Sheet {
  constructor(book, native) { this.book = book; this.native = native; }
  get name() { return this.native.name; }
  delete() { this.book.native.removeWorksheet(this.native.id); this.book.invalidate(); }
  getRange(address) { return new Range(this, address); }
  set showGridLines(value) { this.native.views = [{ ...(this.native.views?.[0] ?? {}), showGridLines: value }]; }
  get freezePanes() { const freeze = (key, value) => { this.native.views = [{ ...(this.native.views?.[0] ?? {}), state: 'frozen', [key]: value }]; }; return { freezeRows: value => freeze('ySplit', value), freezeColumns: value => freeze('xSplit', value) }; }
  get tables() {
    const sheet = this;
    return { get items() { return Object.values(sheet.native.tables).map(native => new Table(sheet, native)); }, add(address, headers, name) {
      const range = sheet.getRange(address), values = range.matrix(cell => structuredClone(cell.value));
      const native = sheet.native.addTable({ name, ref: `${column(range.left)}${range.top}`, headerRow: headers, totalsRow: false, columns: values[0].map(name => ({ name: String(name), filterButton: true })), rows: values.slice(1), style: { theme: 'TableStyleLight1', showRowStripes: true } });
      sheet.book.invalidate(); return new Table(sheet, native);
    } };
  }
}

export class Workbook {
  constructor(native = new ExcelJS.Workbook()) { this.native = native; this.cache = new Map(); this.active = new Set(); this.parsers = []; this.depth = 0; }
  static create() { return new Workbook(); }
  static async read(path) {
    const native = new ExcelJS.Workbook();
    await native.xlsx.load(await workbookBytes(path));
    for (const sheet of native.worksheets) for (const table of Object.values(sheet.tables)) {
      const area = bounds(table.table.tableRef);
      table.worksheet = sheet;
      table.table.ref = `${column(area.left)}${area.top}`;
      table.table.rows = Array.from({ length: area.bottom - area.top - Number(table.table.totalsRow) }, (_, r) => Array.from({ length: area.right - area.left + 1 }, (_, c) => sheet.getCell(area.top + r + 1, area.left + c).value));
      table.validate();
    }
    return new Workbook(native);
  }
  get worksheets() { const book = this; return { get items() { return book.native.worksheets.map(sheet => new Sheet(book, sheet)); }, getItem(name) { const sheet = book.native.getWorksheet(name); if (!sheet) throw new Error(`Missing workbook sheet ${name}.`); return new Sheet(book, sheet); }, add(name) { return new Sheet(book, book.native.addWorksheet(name)); } }; }
  invalidate() { this.cache.clear(); }
  formulaText(text) {
    return text.replace(/"(?:[^"]|"")*"|_xlfn\.XLOOKUP|([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]/g, (token, tableName, header) => {
      if (!tableName) return token === '_xlfn.XLOOKUP' ? 'XLOOKUP' : token;
      for (const sheet of this.worksheets.items) {
        const table = sheet.tables.items.find(item => item.name === tableName);
        if (!table) continue;
        const start = table.getHeaderRowRange();
        const index = table.native.table.columns.findIndex(item => item.name === header);
        if (index < 0) throw new Error(`Missing column ${tableName}[${header}].`);
        const col = column(start.left + index);
        return `'${sheet.name.replaceAll("'", "''")}'!${col}${start.top + 1}:${col}${start.top + Math.max(1, table.native.table.rows.length)}`;
      }
      throw new Error(`Missing table ${tableName}.`);
    });
  }
  parser(depth) {
    if (this.parsers[depth]) return this.parsers[depth];
    return this.parsers[depth] = new FormulaParser({
      functions: {
        MIN: (...values) => { const numbers = values.flatMap(flat).filter(value => typeof value === 'number'); return numbers.length ? numbers.reduce((minimum, value) => Math.min(minimum, value), Infinity) : 0; },
        MAX: (...values) => { const numbers = values.flatMap(flat).filter(value => typeof value === 'number'); return numbers.length ? numbers.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : 0; },
        COUNTA: (...values) => values.flatMap(flat).filter(value => value !== null && value !== undefined && value !== '').length,
        SUMIFS: (values, ...criteria) => { const amounts = flat(values); return matchingRows(criteria).reduce((sum, included, index) => sum + (included && typeof amounts[index] === 'number' ? amounts[index] : 0), 0); },
        COUNTIFS: (...criteria) => matchingRows(criteria).filter(Boolean).length,
        XLOOKUP: (value, keys, values, fallback) => { const key = unpack(value), index = flat(keys).findIndex(item => item === key); return index < 0 ? fallback === undefined ? FormulaParser.FormulaError.NA : unpack(fallback) : flat(values)[index] ?? 0; },
      },
      onCell: ({ sheet, row, col }) => this.numericValue(sheet, row, col),
      onRange: ({ sheet, from, to }) => Array.from({ length: to.row - from.row + 1 }, (_, r) => Array.from({ length: to.col - from.col + 1 }, (_, c) => this.numericValue(sheet, from.row + r, from.col + c))),
    });
  }
  numericValue(sheet, row, col) { const value = this.value(sheet, row, col); return value instanceof Date ? serialDate(value) : value; }
  value(sheet, row, col) {
    const cell = this.native.getWorksheet(sheet)?.getCell(row, col);
    if (!cell) throw new Error(`Missing workbook cell ${sheet}!${column(col)}${row}.`);
    if (!cell.formula) return cell.value?.richText ? cell.value.richText.map(item => item.text).join('') : cell.value?.text ?? cell.value;
    const key = `${sheet}!${cell.address}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.active.has(key)) throw new Error(`Circular workbook formula at ${key}.`);
    this.active.add(key);
    const depth = this.depth++;
    try {
      const result = this.parser(depth).parse(this.formulaText(cell.formula), { sheet, row, col });
      if (result instanceof Error || result && typeof result === 'object') throw new Error(`Formula ${key} failed: ${String(result)}`);
      if (typeof result === 'number' && !Number.isFinite(result)) throw new Error(`Formula ${key} is not finite.`);
      this.cache.set(key, result); cell.value = { formula: cell.formula, result }; return result;
    } finally { this.depth--; this.active.delete(key); }
  }
  recalculate(locations) {
    this.invalidate();
    if (locations) { for (const location of locations) { const cell = this.native.getWorksheet(location.sheet).getCell(location.cell); this.value(location.sheet, cell.row, cell.col); } }
    else for (const sheet of this.native.worksheets) sheet.eachRow(row => row.eachCell(cell => { if (cell.formula) this.value(sheet.name, cell.row, cell.col); }));
  }
  async write(path, locations) { this.recalculate(locations); this.native.calcProperties.fullCalcOnLoad = true; await this.native.xlsx.writeFile(path); }
}
