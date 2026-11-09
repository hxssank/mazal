import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertMacOSTarget, macOSMinimums } from './macos-target.mjs';
import { installPreparedMacApp, replaceMacAppArchive } from './macos-install.mjs';

test('macOS deployment parsing ignores SDK and linker versions across native slices', () => {
  const versions = macOSMinimums(`binary (architecture arm64):
Load command 9
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 14.0
      sdk 26.0
     tool LD
  version 1267.0
binary (architecture x86_64):
Load command 8
      cmd LC_VERSION_MIN_MACOSX
  version 10.13
      sdk 14.0
`);
  assert.deepEqual(versions, ['14.0', '10.13']);
  assert.doesNotThrow(() => assertMacOSTarget('numerical-library.so', versions, '14.0'));
});

test('bundled runtimes cannot exceed the advertised target, including patch versions', () => {
  assert.throws(() => assertMacOSTarget('Mazal', ['26.0'], '14.0'), /requires macOS 26.0/);
  assert.throws(() => assertMacOSTarget('node', ['13.5'], '13.0'), /requires macOS 13.5/);
  assert.throws(() => assertMacOSTarget('runtime', ['14.0.1'], '14.0'), /requires macOS 14.0.1/);
  assert.doesNotThrow(() => assertMacOSTarget('runtime', ['14.0.0', '13.5'], '14.0'));
});

test('a native file without macOS deployment metadata cannot pass verification', () => {
  assert.throws(() => macOSMinimums('Load command 1\ncmd LC_BUILD_VERSION\nplatform IOS\nminos 14.0'), /no macOS deployment/);
  assert.throws(() => macOSMinimums('unrecognized binary'), /no macOS deployment/);
  assert.throws(() => assertMacOSTarget('Mazal', ['14.0'], 'latest'), /Invalid macOS version/);
});

test('native installation checks the destination and restores the previous app when verification fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-install-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prepared = join(directory, 'prepared.app');
  const installed = join(directory, 'installed.app');
  const previous = join(directory, 'previous.app');
  for (const [path, value] of [[prepared, 'new'], [installed, 'old']]) {
    await mkdir(path);
    await writeFile(join(path, 'identity'), value);
  }
  await assert.rejects(installPreparedMacApp(prepared, installed, previous, async path => {
    assert.equal(path, installed);
    assert.equal(await readFile(join(path, 'identity'), 'utf8'), 'new');
    throw new Error('Destination signature failed');
  }), /Destination signature failed/);
  assert.equal(await readFile(join(installed, 'identity'), 'utf8'), 'old');
  assert.equal(await readFile(join(prepared, 'identity'), 'utf8'), 'new');
  await installPreparedMacApp(prepared, installed, previous, async path => {
    assert.equal(await readFile(join(path, 'identity'), 'utf8'), 'new');
  });
  assert.equal(await readFile(join(installed, 'identity'), 'utf8'), 'new');
  assert.equal(await readFile(join(previous, 'identity'), 'utf8'), 'old');
});

test('a failed rollback archive verification keeps the old archive and restores the installed app', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-archive-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prepared = join(directory, 'prepared.app');
  const installed = join(directory, 'installed.app');
  const previous = join(directory, 'previous.app');
  const preparedArchive = join(directory, 'prepared.zip');
  const archive = join(directory, 'Mazal-previous.zip');
  for (const [path, value] of [[prepared, 'new'], [installed, 'old']]) {
    await mkdir(path);
    await writeFile(join(path, 'identity'), value);
  }
  await writeFile(preparedArchive, 'invalid archive');
  await writeFile(archive, 'known rollback');
  await assert.rejects(installPreparedMacApp(prepared, installed, previous, async () => {
    await replaceMacAppArchive(preparedArchive, archive, async path => {
      assert.equal(path, preparedArchive);
      throw new Error('Archive signature failed');
    });
  }), /Archive signature failed/);
  assert.equal(await readFile(join(installed, 'identity'), 'utf8'), 'old');
  assert.equal(await readFile(join(prepared, 'identity'), 'utf8'), 'new');
  assert.equal(await readFile(archive, 'utf8'), 'known rollback');
});

test('verified app archives replace the single rollback file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-archive-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prepared = join(directory, 'prepared.zip');
  const archive = join(directory, 'Mazal-previous.zip');
  await writeFile(prepared, 'new rollback');
  await writeFile(archive, 'old rollback');
  await replaceMacAppArchive(prepared, archive, async path => {
    assert.equal(await readFile(path, 'utf8'), 'new rollback');
    assert.equal(await readFile(archive, 'utf8'), 'old rollback');
  });
  assert.equal(await readFile(archive, 'utf8'), 'new rollback');
  await assert.rejects(readFile(prepared), { code: 'ENOENT' });
});
