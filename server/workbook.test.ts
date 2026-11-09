import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbookService, type WorkbookSnapshot } from './workbook.ts';

function snapshot(revision = 1): WorkbookSnapshot {
  return { generatedAt: new Date().toISOString(), documents: [], state: { workspace: 'live', revision, entities: [], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null } };
}
const bytes = Buffer.from('PK\x03\x04test workbook');

test('Excel export records the source revision, detects stale data and archives the previous file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-workbook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'master.xlsx');
  let captured: WorkbookSnapshot | undefined;
  const existingInputs: Array<{ path: string; bytes: Buffer } | undefined> = [];
  const service = createWorkbookService(path, async (input, output, existing) => {
    captured = JSON.parse(await readFile(input, 'utf8'));
    existingInputs.push(existing ? { path: existing, bytes: await readFile(existing) } : undefined);
    await writeFile(output, bytes);
  });
  const first = snapshot();
  const status = await service.refresh(first);
  assert.deepEqual(captured, first);
  assert.equal(status.revision, 1);
  assert.equal(status.stale, false);
  assert.equal(status.modified, false);
  assert.equal(existingInputs[0], undefined);
  assert.equal((await service.status(snapshot(2))).stale, true);
  const previousManifest = await readFile(`${path}.json`);
  await service.refresh(snapshot(2));
  assert.notEqual(existingInputs[1]?.path, path);
  assert.deepEqual(existingInputs[1]?.bytes, bytes);
  assert.ok(existingInputs[1]?.path.startsWith(join(directory, '.excel-')));
  const archives = await readdir(join(directory, 'Archive'));
  assert.equal(archives.length, 1);
  assert.deepEqual(await readFile(join(directory, 'Archive', archives[0], 'Mazal master.xlsx')), bytes);
  assert.deepEqual(await readFile(join(directory, 'Archive', archives[0], 'Mazal master.xlsx.json')), previousManifest);
  assert.equal((await service.status(snapshot(2))).revision, 2);
  assert.equal((await readdir(directory)).some(name => name.startsWith('.excel-')), false);
});

test('Excel export never overwrites local edits or an unmanaged workbook', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-workbook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'master.xlsx');
  let calls = 0;
  const service = createWorkbookService(path, async (_, output) => { calls++; await writeFile(output, bytes); });
  await writeFile(path, 'user workbook');
  await assert.rejects(service.refresh(snapshot()), /local edits or no export record/);
  assert.equal(calls, 0);
  assert.equal(await readFile(path, 'utf8'), 'user workbook');
  await rm(path);
  await service.refresh(snapshot());
  const previousManifest = await readFile(`${path}.json`);
  await writeFile(path, 'updated by user');
  assert.equal((await service.status()).modified, true);
  await assert.rejects(service.refresh(snapshot(2)), /local edits/);
  assert.equal(await readFile(path, 'utf8'), 'updated by user');
  assert.deepEqual(await readFile(`${path}.json`), previousManifest);
});

for (const layoutVersion of [undefined, 9]) test(`workbook layout ${layoutVersion ?? 'unversioned'} needs a refresh even when app records have not changed`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-workbook-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'master.xlsx');
  const service = createWorkbookService(path, async (_, output) => { await writeFile(output, bytes); });
  const current = snapshot();
  await service.refresh(current);
  const manifest = JSON.parse(await readFile(`${path}.json`, 'utf8'));
  if (layoutVersion === undefined) delete manifest.layoutVersion;
  else manifest.layoutVersion = layoutVersion;
  await writeFile(`${path}.json`, JSON.stringify(manifest));
  assert.equal((await service.status(current)).stale, true);
  assert.equal((await service.status(current)).modified, false);
  await service.refresh({ ...current, generatedAt: new Date(Date.now() + 1).toISOString() });
  assert.equal((await service.status(current)).stale, false);
});

test('a failed or competing export preserves the previous workbook and releases the generator', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-workbook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'master.xlsx');
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let fail = false;
  const service = createWorkbookService(path, async (_, output) => {
    if (fail) { entered?.(); await new Promise<void>(resolve => { release = resolve; }); throw new Error('renderer failed'); }
    await writeFile(output, bytes);
  });
  await service.refresh(snapshot());
  const previousManifest = await readFile(`${path}.json`);
  fail = true;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = service.refresh(snapshot(2));
  const failed = assert.rejects(pending, /renderer failed/);
  await started;
  await assert.rejects(service.refresh(snapshot(2)), /already being generated/);
  release!();
  await failed;
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readFile(`${path}.json`), previousManifest);
  assert.equal((await service.status()).revision, 1);
  fail = false;
  await service.refresh(snapshot(2));
  assert.equal((await service.status()).revision, 2);
});

test('an edit made while Excel renders wins over the generated export', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-workbook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'master.xlsx');
  let changed = false;
  const service = createWorkbookService(path, async (_, output, existing) => {
    await writeFile(output, bytes);
    if (changed) {
      assert.ok(existing);
      assert.notEqual(existing, path);
      await writeFile(path, 'local edit during export');
      assert.deepEqual(await readFile(existing), bytes);
    }
  });
  await service.refresh(snapshot());
  changed = true;
  await assert.rejects(service.refresh(snapshot(2)), /changed during export/);
  assert.equal(await readFile(path, 'utf8'), 'local edit during export');
});

test('a completed competing refresh wins even when its workbook bytes are unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-workbook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'master.xlsx');
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let pause = false;
  const slow = createWorkbookService(path, async (_, output) => {
    if (pause) { entered?.(); await new Promise<void>(resolve => { release = resolve; }); }
    await writeFile(output, bytes);
  });
  const fast = createWorkbookService(path, async (_, output) => { await writeFile(output, bytes); });
  await slow.refresh({ ...snapshot(), generatedAt: '2026-09-24T00:00:01.000Z' });
  pause = true;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = slow.refresh({ ...snapshot(2), generatedAt: '2026-09-24T00:00:02.000Z' });
  const rejected = assert.rejects(pending, /export record changed during export/);
  await started;
  await fast.refresh({ ...snapshot(3), generatedAt: '2026-09-24T00:00:03.000Z' });
  const newerManifest = await readFile(`${path}.json`);
  release!();
  await rejected;
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readFile(`${path}.json`), newerManifest);
  assert.equal((await slow.status()).revision, 3);
  assert.equal((await readdir(directory)).some(name => name.startsWith('.excel-')), false);
});

test('Excel must be closed before rendering or replacing the managed workbook', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-workbook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'master.xlsx');
  const lock = join(directory, '~$master.xlsx');
  let calls = 0;
  let openDuringRender = false;
  const service = createWorkbookService(path, async (_, output) => {
    calls++;
    await writeFile(output, bytes);
    if (openDuringRender) await writeFile(lock, 'Excel lock');
  });
  await service.refresh(snapshot());
  const previousManifest = await readFile(`${path}.json`);
  await writeFile(lock, 'Excel lock');
  await assert.rejects(service.refresh(snapshot(2)), /open in Excel\. Save and close/);
  assert.equal(calls, 1);
  await rm(lock);
  openDuringRender = true;
  await assert.rejects(service.refresh(snapshot(2)), /open in Excel\. Save and close/);
  assert.equal(calls, 2);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readFile(`${path}.json`), previousManifest);
  assert.equal((await readdir(directory)).some(name => name.startsWith('.excel-')), false);
  await rm(lock);
  openDuringRender = false;
  await service.refresh(snapshot(2));
  assert.equal((await service.status()).revision, 2);
});
