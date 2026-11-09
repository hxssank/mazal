import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { prepareBundledNativeExecutable, prepareNativeExecutable } from './native-build-cache.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-native-cache-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDirectory = join(directory, 'cache');
  const output = join(directory, 'Mazal');
  const state = { inputs: { source: 'source-v1', compiler: 'swift-v1', sdk: 'sdk-v1', args: ['-target', 'arm64-apple-macosx14.0'] }, compiled: 0, verified: 0, reports: [] };
  const settings = {
    cacheDirectory,
    output,
    readInputs: async () => structuredClone(state.inputs),
    compile: async path => { state.compiled += 1; await writeFile(path, 'verified native executable', { mode: 0o755 }); },
    verify: async path => { state.verified += 1; assert.equal(await readFile(path, 'utf8'), 'verified native executable'); },
    report: message => state.reports.push(message),
  };
  return { directory, cacheDirectory, output, state, settings };
}

test('a native cache hit skips compilation but verifies a new executable copy', async t => {
  const { cacheDirectory, output, state, settings } = await fixture(t);
  const first = await prepareNativeExecutable(settings);
  await rm(output);
  const second = await prepareNativeExecutable(settings);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.key, first.key);
  assert.equal(second.sha256, first.sha256);
  assert.equal(state.compiled, 1);
  assert.equal(state.verified, 2);
  assert.notEqual((await lstat(output)).ino, (await lstat(join(cacheDirectory, first.key, 'executable'))).ino);
  if (process.platform !== 'win32') assert.equal((await lstat(output)).mode & 0o111, 0o111);
});

test('source, compiler, SDK, and deployment target changes each invalidate the native cache', async t => {
  const { state, settings } = await fixture(t);
  const keys = new Set([(await prepareNativeExecutable(settings)).key]);
  for (const change of [{ source: 'source-v2' }, { compiler: 'swift-v2' }, { sdk: 'sdk-v2' }, { args: ['-target', 'arm64-apple-macosx15.0'] }]) {
    Object.assign(state.inputs, change);
    const result = await prepareNativeExecutable(settings);
    assert.equal(result.cacheHit, false);
    assert.equal(keys.has(result.key), false);
    keys.add(result.key);
  }
  assert.equal(state.compiled, 5);
});

test('corrupted native cache bytes are rebuilt before execution', async t => {
  const { cacheDirectory, state, settings } = await fixture(t);
  const first = await prepareNativeExecutable(settings);
  await writeFile(join(cacheDirectory, first.key, 'executable'), 'corrupt');
  const result = await prepareNativeExecutable(settings);
  assert.equal(result.cacheHit, false);
  assert.equal(state.compiled, 2);
  assert.equal(state.verified, 2);
  assert.match(state.reports.join('\n'), /checksum does not match/);
  assert.equal((await prepareNativeExecutable(settings)).cacheHit, true);
});

test('a failed cached signature or self-test triggers a verified rebuild', async t => {
  const { state, settings } = await fixture(t);
  await prepareNativeExecutable(settings);
  const verify = settings.verify;
  let fail = true;
  settings.verify = async path => {
    if (fail) { fail = false; throw new Error('signature or self-test failed'); }
    await verify(path);
  };
  assert.equal((await prepareNativeExecutable(settings)).cacheHit, false);
  assert.equal(state.compiled, 2);
  assert.match(state.reports.join('\n'), /signature or self-test failed/);
});

test('failed freshly compiled native checks never publish a cache entry', async t => {
  const { cacheDirectory, settings } = await fixture(t);
  settings.verify = async () => { throw new Error('fresh self-test failed'); };
  await assert.rejects(prepareNativeExecutable(settings), /fresh self-test failed/);
  await assert.rejects(lstat(cacheDirectory), { code: 'ENOENT' });
});

test('source or toolchain changes during preparation fail without publishing stale native bytes', async t => {
  const { cacheDirectory, state, settings } = await fixture(t);
  const verify = settings.verify;
  settings.verify = async path => { await verify(path); state.inputs.source = 'changed-during-build'; };
  await assert.rejects(prepareNativeExecutable(settings), /inputs changed/);
  await assert.rejects(lstat(cacheDirectory), { code: 'ENOENT' });
});

test('native cache symlinks cannot redirect the cache reader to a different executable', async t => {
  const { directory, cacheDirectory, state, settings } = await fixture(t);
  const first = await prepareNativeExecutable(settings);
  const cached = join(cacheDirectory, first.key, 'executable');
  const outside = join(directory, 'outside');
  await writeFile(outside, 'verified native executable');
  await rm(cached);
  await symlink(outside, cached);
  assert.equal((await prepareNativeExecutable(settings)).cacheHit, false);
  assert.equal(state.compiled, 2);
  assert.match(state.reports.join('\n'), /must be a regular file/);
  assert.equal((await lstat(cached)).isSymbolicLink(), false);
  assert.deepEqual(await readdir(cacheDirectory), [first.key]);
});

test('unavailable cache storage does not reject a verified staged executable', async t => {
  const { cacheDirectory, output, state, settings } = await fixture(t);
  await writeFile(cacheDirectory, 'a file occupies the optional cache directory');
  const result = await prepareNativeExecutable(settings);
  assert.equal(result.cacheHit, false);
  assert.equal(state.compiled, 1);
  assert.equal(state.verified, 1);
  assert.equal(await readFile(output, 'utf8'), 'verified native executable');
  assert.match(state.reports.join('\n'), /Could not save the native cache/);
});

test('concurrent native cache publishers keep both verified outputs usable', async t => {
  const { directory, cacheDirectory, state, settings } = await fixture(t);
  let waiting = 0;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const compile = settings.compile;
  settings.compile = async path => {
    await compile(path);
    waiting += 1;
    if (waiting === 2) release();
    await ready;
  };
  const secondOutput = join(directory, 'second-Mazal');
  const results = await Promise.all([
    prepareNativeExecutable(settings),
    prepareNativeExecutable({ ...settings, output: secondOutput }),
  ]);
  assert.equal(state.compiled, 2);
  assert.equal(state.verified, 2);
  assert.equal(results[0].key, results[1].key);
  assert.equal(await readFile(secondOutput, 'utf8'), 'verified native executable');
  assert.deepEqual(await readdir(cacheDirectory), [results[0].key]);
  assert.equal((await prepareNativeExecutable(settings)).cacheHit, true);
});

test('native cache signatures remain reusable when bundle Info.plist changes', { skip: process.platform !== 'darwin' }, async t => {
  const { directory, state, settings } = await fixture(t);
  const execute = promisify(execFile);
  const source = join(directory, 'native.c');
  await writeFile(source, 'int main(void) { return 0; }\n');
  settings.compile = async path => {
    state.compiled += 1;
    await execute('/usr/bin/clang', [source, '-o', path]);
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', path]);
  };
  settings.verify = async path => {
    state.verified += 1;
    await execute('/usr/bin/codesign', ['--verify', '--strict', path]);
    await execute(path, ['--self-test']);
  };
  const results = [];
  for (const version of ['1', '2']) {
    const stagingDirectory = join(directory, `release-${version}`);
    const bundle = join(stagingDirectory, 'Mazal.app');
    const output = join(bundle, 'Contents', 'MacOS', 'Mazal');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.mazal.cache-test</string><key>CFBundleExecutable</key><string>Mazal</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string><key>MazalSourceSHA256</key><string>release-${version}</string></dict></plist>`);
    results.push(await prepareBundledNativeExecutable({ ...settings, stagingDirectory, output }));
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  }
  assert.equal(state.compiled, 1);
  assert.equal(state.verified, 2);
  assert.deepEqual(results.map(result => result.cacheHit), [false, true]);
  assert.equal(results[0].key, results[1].key);
  assert.equal(results[0].sha256, results[1].sha256);
});
