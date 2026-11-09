import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { inspectWorkbook } from './workbook-inspect.ts';

const { Workbook } = await import(new URL('../scripts/workbook-runtime.mjs', import.meta.url).href);

test('portable formulas calculate dated criteria, blanks, wildcard escapes and exact ID lookups', () => {
  const workbook = Workbook.create(), sheet = workbook.worksheets.add('Records');
  sheet.getRange('A1:C5').values = [['ID', 'Amount', 'Date'], ['TableTest[Amount]', 2, new Date('2026-09-01T00:00:00Z')], ['Abc', 3, new Date('2026-09-02T00:00:00Z')], ['Ab?', 4, new Date('2026-10-01T00:00:00Z')], ['Empty', null, null]];
  sheet.tables.add('A1:C5', true, 'TableTest');
  sheet.getRange('E1:E6').formulas = [
    ['=SUMIFS(TableTest[Amount],TableTest[ID],"Ab?")'],
    ['=SUMIFS(TableTest[Amount],TableTest[ID],"Ab~?")'],
    ['=_xlfn.XLOOKUP("TableTest[Amount]",TableTest[ID],TableTest[Amount])'],
    ['=COUNTIFS(TableTest[Amount],"<>")'],
    ['=SUMIFS(TableTest[Amount],TableTest[Date],">="&DATE(2026,9,1),TableTest[Date],"<"&DATE(2026,10,1))'],
    ['=IF(COUNT(B5)=0,"",B5)'],
  ];
  assert.deepEqual(sheet.getRange('E1:E6').values, [[7], [4], [2], [3], [5], ['']]);
});

test('portable workbook updates retain unrelated content, cached formulas, styles, tables and frozen panes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-portable-workbook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = join(directory, 'original.xlsx'), updated = join(directory, 'updated.xlsx');
  const workbook = Workbook.create(), sheet = workbook.worksheets.add('Personal notes');
  sheet.getRange('A1:B2').values = [['Note', 'Amount'], ['Preserve this', 3]];
  sheet.tables.add('A1:B2', true, 'TableNotes').style = 'TableStyleMedium2';
  sheet.getRange('A1:B2').format = { font: { name: 'Arial', size: 14, color: '#135724' }, columnWidth: 27 };
  sheet.freezePanes.freezeRows(1);
  sheet.native.getCell('D1').value = { formula: 'UNSUPPORTED_USER_FORMULA(1)', result: 99 };
  await workbook.write(original, []);
  const reopened = await Workbook.read(original);
  const own = reopened.worksheets.add('Generated');
  own.getRange('A1').formulas = [['=SUM(TableNotes[Amount])']];
  await reopened.write(updated, [{ sheet: 'Generated', cell: 'A1' }]);
  const before = await inspectWorkbook(original), after = await inspectWorkbook(updated);
  assert.deepEqual(after.sheets['Personal notes'], before.sheets['Personal notes']);
  assert.deepEqual(after.tables.TableNotes, before.tables.TableNotes);
  assert.equal(after.sheets.Generated.cells.A1.value, 3);
  assert.equal(after.sheets['Personal notes'].cells.D1.formula, 'UNSUPPORTED_USER_FORMULA(1)');
  assert.equal(after.sheets['Personal notes'].cells.D1.value, 99);
});

test('portable export rejects missing formula references and cycles before producing a workbook', () => {
  const workbook = Workbook.create(), sheet = workbook.worksheets.add('Check');
  sheet.getRange('A1').formulas = [['=SUM(MissingTable[Amount])']];
  assert.throws(() => workbook.recalculate(), /Missing table/);
  sheet.getRange('A1:B1').formulas = [['=B1', '=A1']];
  assert.throws(() => workbook.recalculate(), error => error instanceof Error && error.message.includes('Circular workbook formula'));
  sheet.getRange('A1:B1').values = [[0, 5]];
  sheet.getRange('C1').formulas = [['=SUM(A1:B1)']];
  assert.equal(sheet.getRange('C1').values[0][0], 5);
});

test('legacy prefixed spreadsheet XML and absolute internal relationships retain table data, formulas and styles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-legacy-workbook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = join(directory, 'original.xlsx'), legacy = join(directory, 'legacy.xlsx'), updated = join(directory, 'updated.xlsx');
  const workbook = Workbook.create(), sheet = workbook.worksheets.add('Records');
  sheet.getRange('A1:C3').values = [['Note', 'Amount', 'Date'], ['Literal <x:tag>', 7, new Date('2026-09-01T00:00:00Z')], ['Kept', 4, new Date('2026-09-02T00:00:00Z')]];
  sheet.tables.add('A1:C3', true, 'TableLegacy').style = 'TableStyleMedium2';
  sheet.getRange('A1:C3').format = { font: { name: 'Arial', size: 13, color: '#135724' }, columnWidth: 27 };
  sheet.getRange('C2:C3').setNumberFormat('dd mmm yyyy');
  sheet.native.getCell('E1').value = { formula: 'UNSUPPORTED_USER_FORMULA("<x:tag>")', result: 11 };
  sheet.native.getCell('E2').value = { text: 'Document', hyperlink: '/external-document.pdf' };
  await workbook.write(original, []);
  const zip = await JSZip.loadAsync(await readFile(original));
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const xml = await entry.async('string');
    if (entry.name.endsWith('.rels')) {
      zip.file(entry.name, xml.replace(/<Relationship\b[^>]*>/g, relationship => relationship.includes('TargetMode="External"') ? relationship : relationship.replace(/Target="([^"]*)"/, (_, target: string) => `Target="/${posix.normalize(posix.join(posix.dirname(posix.dirname(entry.name)), target))}"`)));
    } else if (entry.name.startsWith('xl/') && entry.name.endsWith('.xml') && xml.includes('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')) {
      zip.file(entry.name, xml.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, '<$1x:$2'));
    }
  }
  await writeFile(legacy, await zip.generateAsync({ type: 'nodebuffer' }));
  const reopened = await Workbook.read(legacy);
  const restored = reopened.worksheets.getItem('Records');
  assert.equal(restored.native.getCell('E2').value.hyperlink, '/external-document.pdf');
  restored.showGridLines = false;
  restored.freezePanes.freezeRows(1);
  const generated = reopened.worksheets.add('Generated');
  generated.getRange('A1').formulas = [['=SUM(TableLegacy[Amount])']];
  await reopened.write(updated, [{ sheet: 'Generated', cell: 'A1' }]);
  const before = await inspectWorkbook(original), after = await inspectWorkbook(updated);
  assert.deepEqual(after.tables.TableLegacy, before.tables.TableLegacy);
  assert.deepEqual(after.sheets.Records.cells, before.sheets.Records.cells);
  assert.deepEqual(after.sheets.Records.columns, before.sheets.Records.columns);
  assert.equal(after.sheets.Records.pane?.ySplit, '1');
  assert.equal(after.sheets.Generated.cells.A1.value, 11);
});
