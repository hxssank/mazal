import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import JSZip from 'jszip';
import { allowedReleasePath, collectRelease, createRelease, extractRelease } from './release.mjs';
import { nativeReleasePlist, verifyBuildIdentity, verifyNodeDependencies, writeBuildIdentity } from './build-identity.mjs';

test('application, Python package, native bundle and engine model identities agree', async () => {
  const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [packageText, project, pythonLock, plist, pythonModel, browserModel] = await Promise.all([
    read('package.json'), read('backend/pyproject.toml'), read('backend/uv.lock'),
    read('macos/Info.plist'), read('backend/mazal_engine/__init__.py'), read('shared/engine.ts'),
  ]);
  const version = JSON.parse(packageText).version;
  const release = /^(\d+\.\d+\.\d+)(?:-rc\.(\d+))?$/.exec(version);
  assert.ok(release, 'Native releases require a stable or rc version');
  const pythonVersion = version.replace('-rc.', 'rc');
  assert.equal(project.match(/^version\s*=\s*"([^"]+)"/m)?.[1], pythonVersion, 'Python project version');
  const enginePackage = pythonLock.split('[[package]]').find(entry => /^name = "mazal-engine"$/m.test(entry));
  assert.equal(enginePackage?.match(/^version = "([^"]+)"/m)?.[1], pythonVersion, 'Python lockfile version');
  assert.equal(plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1], release[1], 'Native version');
  assert.equal(plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1], release[2] ?? '1', 'Native build number');
  const model = pythonModel.match(/^MODEL_VERSION = "([^"]+)"/m)?.[1];
  assert.ok(model, 'Python model identity');
  assert.equal(browserModel.match(/export const ENGINE_MODEL_VERSION = '([^']+)'/)?.[1], model, 'Browser and Python model identities');
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const paths = ['.gitignore', '.node-version', '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'tsconfig.ui.json', 'tsconfig.server.json', 'vite.config.ts', 'backend/pyproject.toml', 'backend/uv.lock', 'backend/.python-version', 'public/icon.svg', 'public/fonts/OFL.txt', 'public/fonts/barlow-condensed-bold.ttf', 'src/App.tsx', 'shared/types.ts', 'server/index.ts', 'scripts/setup.mjs', 'backend/mazal_engine/app.py', 'backend/tests/test_app.py'];
  paths.push('macos/Mazal.swift');
  paths.push('src/features/backups/AutomaticBackup.tsx', 'src/features/backups/CompleteBackup.tsx');
  paths.push('playwright.config.ts', 'tests/desktop/navigation.spec.ts');
  for (const path of paths) { const absolute = join(source, path); await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, 'synthetic release fixture'); }
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'mazal', version: '0.2.0-rc.1' }));
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({ version: '0.2.0-rc.1', packages: { '': { version: '0.2.0-rc.1' } } }));
  await writeFile(join(source, '.node-version'), '24.15.0\n');
  await writeFile(join(source, 'backend/.python-version'), '3.13.15\n');
  return { directory, source };
}

test('source release excludes private data, runtime caches, experiments, and unexpected file formats', async t => {
  const { directory, source } = await fixture(t);
  for (const path of ['.env', 'data/live.sqlite', 'backups/live.json', 'source-documents/bank.csv', 'sandboxes/experiment.ts', 'node_modules/private.js', 'backend/.venv/private.py', 'backend/mazal_engine/__pycache__/private.py', 'src/data/private.ts', 'src/private.json', 'src/features/backups/data/private.ts', 'src/features/backups/backups/private.ts', 'src/features/backups/private.json']) {
    const absolute = join(source, path); await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, 'PRIVATE_DATA_SENTINEL');
    assert.equal(allowedReleasePath(path), false);
  }
  const result = await createRelease(source, join(directory, 'release'));
  const extracted = await extractRelease(result.archive, directory);
  assert.equal(extracted.manifest.sourceSha256, result.manifest.sourceSha256);
  const zip = await JSZip.loadAsync(await readFile(result.archive));
  for (const entry of Object.values(zip.files)) assert.doesNotMatch(await entry.async('string'), /PRIVATE_DATA_SENTINEL/);
  assert.equal(await readFile(join(extracted.project, 'src/App.tsx'), 'utf8'), 'synthetic release fixture');
  assert.equal(await readFile(join(extracted.project, 'src/features/backups/AutomaticBackup.tsx'), 'utf8'), 'synthetic release fixture');
  assert.equal(await readFile(join(extracted.project, 'src/features/backups/CompleteBackup.tsx'), 'utf8'), 'synthetic release fixture');
  assert.equal(await readFile(join(extracted.project, 'macos/Mazal.swift'), 'utf8'), 'synthetic release fixture');
  assert.equal(await readFile(join(extracted.project, 'playwright.config.ts'), 'utf8'), 'synthetic release fixture');
  assert.equal(await readFile(join(extracted.project, 'tests/desktop/navigation.spec.ts'), 'utf8'), 'synthetic release fixture');
  assert.match(await readFile(join(extracted.project, 'INSTALL.txt'), 'utf8'), /npm run setup/);
});

test('identical source creates identical archives and changed files produce a different checkpoint', async t => {
  const { directory, source } = await fixture(t);
  const first = await createRelease(source, join(directory, 'release'));
  const again = await createRelease(source, join(directory, 'release'));
  assert.equal(first.archiveSha256, again.archiveSha256);
  await writeFile(join(source, 'src/App.tsx'), 'changed synthetic source');
  const changed = await createRelease(source, join(directory, 'release'));
  assert.notEqual(changed.manifest.sourceSha256, first.manifest.sourceSha256);
  assert.notEqual(changed.archive, first.archive);
});

test('verification rejects tampered files before extracting any content', async t => {
  const { directory, source } = await fixture(t);
  const release = await createRelease(source, join(directory, 'release'));
  const zip = await JSZip.loadAsync(await readFile(release.archive));
  zip.file('mazal-0.2.0-rc.1/src/App.tsx', 'tampered', { createFolders: false });
  const archive = join(directory, 'tampered.zip');
  await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  const destination = join(directory, 'destination'); await mkdir(destination);
  await assert.rejects(extractRelease(archive, destination), /hash mismatch/);
  assert.deepEqual(await readdir(destination), []);
});

test('release collection rejects source symlinks and mismatched package versions', async t => {
  const { directory, source } = await fixture(t);
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({ version: 'other' }));
  await assert.rejects(collectRelease(source), /versions must match/);
  if (process.platform === 'win32') return;
  await writeFile(join(directory, 'private.ts'), 'outside-source');
  await symlink(join(directory, 'private.ts'), join(source, 'src/leak.ts'));
  await assert.rejects(collectRelease(source), /symlinks/);
});

test('release collection requires exact runtime pins', async t => {
  const { source } = await fixture(t);
  await writeFile(join(source, 'backend/.python-version'), '3.13\n');
  await assert.rejects(collectRelease(source), /exact major.minor.patch/);
  await writeFile(join(source, 'backend/.python-version'), '3.13.15\n');
  await writeFile(join(source, '.node-version'), '24\n');
  await assert.rejects(collectRelease(source), /exact major.minor.patch/);
});

test('build identity rejects stale source and changed, missing or extra web assets', async t => {
  const { source } = await fixture(t);
  const { manifest } = await collectRelease(source);
  await mkdir(join(source, 'dist/assets'), { recursive: true });
  await writeFile(join(source, 'dist/index.html'), '<script src="/assets/app.js"></script>');
  await writeFile(join(source, 'dist/assets/app.js'), 'console.log("built")');
  const identity = await writeBuildIdentity(source, manifest);
  assert.deepEqual(await verifyBuildIdentity(source), identity);
  assert.equal(identity.sourceSha256, manifest.sourceSha256);
  await writeFile(join(source, 'dist/assets/app.js'), 'changed');
  await assert.rejects(verifyBuildIdentity(source), /assets changed/);
  await writeFile(join(source, 'dist/assets/app.js'), 'console.log("built")');
  await writeFile(join(source, 'dist/assets/unexpected.js'), 'extra');
  await assert.rejects(verifyBuildIdentity(source), /assets changed/);
  await rm(join(source, 'dist/assets/unexpected.js'));
  await rm(join(source, 'dist/assets/app.js'));
  await assert.rejects(verifyBuildIdentity(source), /assets changed/);
  await writeFile(join(source, 'dist/assets/app.js'), 'console.log("built")');
  await writeFile(join(source, 'src/App.tsx'), 'updated source');
  await assert.rejects(verifyBuildIdentity(source), /does not match/);
  await assert.rejects(writeBuildIdentity(source, manifest), /Source changed during/);
});

test('build dependencies reject packages that differ from the lockfile and allow absent optional packages', async t => {
  const { source } = await fixture(t);
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({ packages: {
    '': { version: '0.2.0-rc.1' },
    'node_modules/react': { version: '19.3.1' },
    'node_modules/platform-helper': { version: '1.0.0', optional: true },
  } }));
  await assert.rejects(verifyNodeDependencies(source), /Cannot read installed dependency node_modules\/react/);
  await mkdir(join(source, 'node_modules/react'), { recursive: true });
  await writeFile(join(source, 'node_modules/react/package.json'), JSON.stringify({ version: '19.3.0' }));
  await assert.rejects(verifyNodeDependencies(source), /lockfile requires 19.3.1/);
  await writeFile(join(source, 'node_modules/react/package.json'), JSON.stringify({ version: '19.3.1' }));
  await verifyNodeDependencies(source);
  await mkdir(join(source, 'node_modules/platform-helper'), { recursive: true });
  await assert.rejects(verifyNodeDependencies(source), /Cannot read installed dependency node_modules\/platform-helper/);
  await writeFile(join(source, 'node_modules/platform-helper/package.json'), JSON.stringify({ version: '0.9.0' }));
  await assert.rejects(verifyNodeDependencies(source), /lockfile requires 1.0.0/);
});

test('native release metadata follows the verified build and rejects untrusted version text', () => {
  const plist = '<plist><dict>\n<key>CFBundleShortVersionString</key><string>0.1.0</string>\n<key>CFBundleVersion</key><string>1</string>\n</dict>\n</plist>';
  const identity = { version: '0.2.0-rc.2', sourceSha256: 'b'.repeat(64) };
  const output = nativeReleasePlist(plist, identity);
  assert.match(output, /<key>CFBundleShortVersionString<\/key><string>0.2.0<\/string>/);
  assert.match(output, /<key>CFBundleVersion<\/key><string>2<\/string>/);
  assert.match(output, /<key>MazalReleaseVersion<\/key><string>0.2.0-rc.2<\/string>/);
  assert.ok(output.includes(`<key>MazalSourceSHA256</key><string>${identity.sourceSha256}</string>`));
  assert.throws(() => nativeReleasePlist(plist, { ...identity, version: '0.2.0-<bad>' }), /native release/);
  assert.throws(() => nativeReleasePlist(plist, { ...identity, sourceSha256: 'bad' }), /native release/);
});
