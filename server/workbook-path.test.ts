import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { masterWorkbookPath } from './workbook-path.ts';

test('the workbook path prefers the reviewed finance folder, retains the older location and honors overrides', t => {
  const home = mkdtempSync(join(tmpdir(), 'mazal-workbook-path-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const current = join(home, 'Desktop', 'Mazal', 'Finance', 'Workbook', 'Mazal master.xlsx');
  const previous = join(home, 'Documents', 'Mazal', 'Mazal master.xlsx');
  assert.equal(masterWorkbookPath(home, ''), current);
  mkdirSync(dirname(previous), { recursive: true });
  writeFileSync(previous, 'older workbook');
  assert.equal(masterWorkbookPath(home, ''), previous);
  mkdirSync(dirname(current), { recursive: true });
  writeFileSync(current, 'reviewed workbook');
  assert.equal(masterWorkbookPath(home, ''), current);
  assert.equal(masterWorkbookPath(home, 'custom/master.xlsx'), resolve('custom/master.xlsx'));
});
