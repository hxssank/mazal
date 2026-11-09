import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { JSDOM } = require('jsdom');

interface Cell { value: string | number | null; formula: string | null; type: string; style: string }
interface Sheet { id: string; relationship: string; cells: Record<string, Cell>; pane: Record<string, string> | null; columns: Record<string, string>[]; tables: string[] }
interface Table { sheet: string; id: string; reference: string; headers: string[]; rows: Record<string, Cell>[]; style: Record<string, string> | null }
const column = (number: number): string => { let result = ''; for (; number; number = Math.floor((number - 1) / 26)) result = String.fromCharCode(65 + (number - 1) % 26) + result; return result; };
const attributes = (node: Element | null): Record<string, string> | null => node ? Object.fromEntries([...node.attributes].map(item => [item.name, item.value])) : null;
const elements = (node: Document | Element, name: string): Element[] => [...node.getElementsByTagName(name)];

export async function inspectWorkbook(path: string): Promise<{ sheets: Record<string, Sheet>; tables: Record<string, Table> }> {
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = async (name: string): Promise<Document> => new JSDOM(await zip.file(name).async('string'), { contentType: 'text/xml' }).window.document;
  const relationships = async (source: string): Promise<Map<string, string>> => {
    const name = posix.join(posix.dirname(source), '_rels', posix.basename(source) + '.rels');
    if (!zip.file(name)) return new Map();
    return new Map(elements(await xml(name), 'Relationship').map(item => { const target = item.getAttribute('Target')!; return [item.getAttribute('Id')!, target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(source), target))]; }));
  };
  const book = await xml('xl/workbook.xml'), targets = await relationships('xl/workbook.xml');
  const strings = zip.file('xl/sharedStrings.xml') ? elements(await xml('xl/sharedStrings.xml'), 'si').map(item => item.textContent ?? '') : [];
  const styles = await xml('xl/styles.xml');
  const formats = new Map(elements(styles, 'numFmt').map(item => [item.getAttribute('numFmtId'), item.getAttribute('formatCode')]));
  const styleKey = (index: string): string => {
    const item = styles.getElementsByTagName('cellXfs')[0].children[Number(index)];
    const result = { ...attributes(item) };
    for (const [key, group] of [['fontId', 'fonts'], ['fillId', 'fills'], ['borderId', 'borders']]) if (result[key]) result[key] = styles.getElementsByTagName(group)[0].children[Number(result[key])].outerHTML;
    if (result.numFmtId) result.numFmtId = formats.get(result.numFmtId) ?? result.numFmtId;
    return createHash('sha256').update(JSON.stringify([result, [...item.children].map(child => child.outerHTML)])).digest('hex');
  };
  const result: { sheets: Record<string, Sheet>; tables: Record<string, Table> } = { sheets: {}, tables: {} };
  for (const sheet of elements(book, 'sheet')) {
    const name = sheet.getAttribute('name')!, relationship = sheet.getAttribute('r:id')!, source = targets.get(relationship)!;
    const document = await xml(source), cells: Record<string, Cell> = {};
    for (const cell of elements(document, 'c')) {
      const kind = cell.getAttribute('t') ?? 'n';
      const raw = cell.getElementsByTagName('v')[0]?.textContent ?? null;
      let value: Cell['value'] = raw;
      if (kind === 's') value = strings[Number(raw)];
      else if (kind === 'inlineStr') value = cell.getElementsByTagName('is')[0]?.textContent ?? '';
      else if (!['str', 'e'].includes(kind) && raw !== null) value = Number(raw);
      cells[cell.getAttribute('r')!] = { value, formula: cell.getElementsByTagName('f')[0]?.textContent ?? null, type: kind, style: styleKey(cell.getAttribute('s') ?? '0') };
    }
    const record: Sheet = { id: sheet.getAttribute('sheetId')!, relationship, cells, pane: attributes(document.getElementsByTagName('pane')[0] ?? null), columns: elements(document, 'col').map(item => attributes(item)!), tables: [] };
    const tableTargets = await relationships(source);
    for (const part of elements(document, 'tablePart')) {
      const table = (await xml(tableTargets.get(part.getAttribute('r:id')!)!)).documentElement;
      const tableName = table.getAttribute('name')!, reference = table.getAttribute('ref')!;
      const headers = elements(table, 'tableColumn').map(item => item.getAttribute('name')!);
      const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(reference)!;
      const firstColumn = [...match[1]].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
      const blank: Cell = { value: null, formula: null, type: 'n', style: '' };
      const rows = Array.from({ length: Number(match[4]) - Number(match[2]) }, (_, index) => Object.fromEntries(headers.map((header, offset) => [header, cells[`${column(firstColumn + offset)}${Number(match[2]) + index + 1}`] ?? blank])));
      result.tables[tableName] = { sheet: name, id: table.getAttribute('id')!, reference, headers, rows, style: attributes(table.getElementsByTagName('tableStyleInfo')[0] ?? null) };
      record.tables.push(tableName);
    }
    result.sheets[name] = record;
  }
  return result;
}
