import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertMacOSTarget, macOSMinimums, verifyMacOSBundle } from './macos-target.mjs';
import { nativeReleasePlist, verifyBuildIdentity, verifyNodeDependencies } from './build-identity.mjs';
import { installPreparedMacApp, replaceMacAppArchive } from './macos-install.mjs';
import { prepareBundledNativeExecutable } from './native-build-cache.mjs';
import { copyPackageTree as copy } from './package-copy.mjs';
import { assertMatchingBuild, macReleaseStatus, verifyInstalledIdentity } from './mac-release-status.mjs';
import { verifyMacRuntime } from './verify-mac-runtime.mjs';
import { readAgentToken } from './local-agent.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Set(process.argv.slice(2));
if ([...options].some(option => !['--install', '--skip-build'].includes(option))) throw new Error('Use --install to install Mazal, or --skip-build after verifying a current web build.');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This package build requires an Apple silicon Mac.');
const execute = promisify(execFile);
const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

async function unregisterApp(path) {
  try { await execute(launchServices, ['-u', path]); }
  catch (error) { console.warn(`Could not remove temporary app registration ${path}: ${error.message}`); }
}

async function run(command, args, settings = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...settings });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`${basename(command)} failed with exit ${code}.`)));
  });
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function appIsRunning(installed) {
  const executable = join(installed, 'Contents', 'MacOS', 'Mazal');
  const pattern = `^${executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($| )`;
  return new Promise((resolveCheck, reject) => {
    execFile('/usr/bin/pgrep', ['-f', pattern], (error, stdout) => {
      if (error?.code === 1) return resolveCheck(false);
      if (error) return reject(error);
      resolveCheck(Boolean(stdout.trim()));
    });
  });
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await inventory(path, name));
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (target.startsWith('/') || relative(bundle, resolve(dirname(path), target)).startsWith('..')) throw new Error(`Bundled symlink escapes the app: ${name}`);
      files.push({ path: name, symlink: target });
    } else {
      const bytes = await readFile(path);
      files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return files;
}

if (!options.has('--skip-build')) {
  await run('npm', ['run', 'build']);
}
const webBuild = await verifyBuildIdentity(root);
if (process.versions.node !== webBuild.nodeVersion) throw new Error(`Package with Node.js ${webBuild.nodeVersion}; found ${process.versions.node}.`);
await verifyNodeDependencies(root);
await run('uv', ['sync', '--project', 'backend', '--locked', '--check', '--python', webBuild.pythonVersion], { env: { ...process.env, UV_PROJECT_ENVIRONMENT: join(root, 'backend', '.venv') } });
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const plist = await readFile(join(root, 'macos', 'Info.plist'), 'utf8');
const minimumMacOS = plist.match(/<key>LSMinimumSystemVersion<\/key>\s*<string>(\d+\.\d+(?:\.\d+)?)<\/string>/)?.[1];
if (!minimumMacOS) throw new Error('Info.plist must declare the minimum macOS version.');
const swiftTarget = ['-target', `arm64-apple-macosx${minimumMacOS}`];
const nativeEnvironment = { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir(), DEVELOPER_DIR: process.env.DEVELOPER_DIR || (await execute('/usr/bin/xcode-select', ['-p'])).stdout.trim() };
async function nativeOutput(command, args) {
  return (await execute(command, args, { env: nativeEnvironment })).stdout.trim();
}
async function nativeFileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function swiftToolchain() {
  const [compiler, linker, clang, sdkPath, sdkVersion, sdkBuild, systemBuild] = await Promise.all([
    nativeOutput('/usr/bin/xcrun', ['--find', 'swiftc']),
    nativeOutput('/usr/bin/xcrun', ['--find', 'ld']),
    nativeOutput('/usr/bin/xcrun', ['--find', 'clang']),
    nativeOutput('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']),
    nativeOutput('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version']),
    nativeOutput('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-build-version']),
    nativeOutput('/usr/bin/sw_vers', ['-buildVersion']),
  ]);
  const sdk = await realpath(sdkPath);
  const paths = [...new Set(await Promise.all([compiler, join(dirname(compiler), 'swift-frontend'), linker, clang, join(sdk, 'SDKSettings.json')].map(path => realpath(path))))].sort();
  const files = await Promise.all(paths.map(async path => ({ path, sha256: await nativeFileHash(path) })));
  return { compiler, sdk, sdkVersion, sdkBuild, systemBuild, version: await nativeOutput(compiler, ['--version']), environment: nativeEnvironment, files };
}
const toolchain = await swiftToolchain();
async function nativeExecutable(source, output, frameworks) {
  const args = [...swiftTarget, '-sdk', toolchain.sdk, '-swift-version', '5', '-O', ...frameworks.flatMap(name => ['-framework', name]), join(root, source)];
  const readInputs = async () => {
    const currentToolchain = await swiftToolchain();
    if (JSON.stringify(currentToolchain) !== JSON.stringify(toolchain)) throw new Error('The Swift toolchain changed during packaging. Build again.');
    return {
      toolchain: currentToolchain,
      executable: basename(output),
      args,
      sources: await Promise.all([source, 'scripts/build-mac-app.mjs', 'scripts/native-build-cache.mjs', 'scripts/macos-target.mjs'].map(async path => ({ path, sha256: await nativeFileHash(join(root, path)) }))),
    };
  };
  const result = await prepareBundledNativeExecutable({
    cacheDirectory: join(homedir(), 'Library', 'Caches', 'Mazal', 'native-builds'),
    stagingDirectory: staging,
    output,
    readInputs,
    compile: async path => {
      await run(toolchain.compiler, [...args, '-o', path], { env: nativeEnvironment });
      await run('/usr/bin/codesign', ['--force', '--sign', '-', path]);
    },
    verify: async path => {
      await run('/usr/bin/codesign', ['--verify', '--strict', path]);
      assertMacOSTarget(path, macOSMinimums(await nativeOutput('/usr/bin/vtool', ['-show-build', path])), minimumMacOS);
      await run(path, ['--self-test']);
    },
  });
  return { source, path: relative(bundle, output), cacheKey: result.key, cacheSha256: result.sha256, cacheHit: result.cacheHit, durationMs: result.durationMs };
}
const stagingRoot = join(tmpdir(), 'mazal-mac-builds.noindex');
await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
const staging = await mkdtemp(join(stagingRoot, 'build-'));
const bundle = join(staging, 'Mazal.app');
const temporaryApps = new Set([bundle]);
const resources = join(bundle, 'Contents', 'Resources');
const app = join(resources, 'app');
const runtime = join(resources, 'runtime');
try {
  await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(app, { recursive: true });
  await writeFile(join(bundle, 'Contents', 'Info.plist'), nativeReleasePlist(plist, webBuild));
  const nativeBuilds = [];
  nativeBuilds.push(await nativeExecutable('macos/Mazal.swift', join(bundle, 'Contents', 'MacOS', 'Mazal'), ['AppKit', 'WebKit', 'LocalAuthentication', 'Security']));
  nativeBuilds.push(await nativeExecutable('macos/ExtractText.swift', join(runtime, 'mazal-extract'), ['AppKit', 'PDFKit', 'Vision']));
  const iconset = join(staging, 'Mazal.iconset');
  await run('/usr/bin/swift', [join(root, 'macos', 'Icon.swift'), join(root, 'public', 'icon.svg'), iconset]);
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'Mazal.icns')]);
  for (const tree of ['server', 'shared', 'dist']) {
    await copy(join(root, tree), join(app, tree), path => !path.endsWith('.test.ts'));
  }
  for (const name of ['build-workbook.mjs', 'workbook-runtime.mjs', 'workbook-tables.mjs', 'local-agent.mjs', 'bank-update.mjs']) {
    await copy(join(root, 'scripts', name), join(app, 'scripts', name));
  }
  for (const name of ['package.json', 'package-lock.json']) await copy(join(root, name), join(app, name));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev || !path.startsWith('node_modules/')) continue;
    const source = join(root, path);
    if (!(await exists(source))) {
      if (entry.optional) continue;
      throw new Error(`Runtime dependency is missing: ${path}`);
    }
    await copy(source, join(app, path));
  }
  await copy(await realpath(process.execPath), join(runtime, 'node'));
  await chmod(join(runtime, 'node'), 0o755);
  const sourcePython = await realpath(join(root, 'backend', '.venv', 'bin', 'python'));
  const sourcePythonRoot = dirname(dirname(sourcePython));
  await copy(sourcePythonRoot, join(runtime, 'python'), path => !path.split('/').some(part => part === '__pycache__'));
  const backend = join(app, 'backend');
  await copy(join(root, 'backend', 'mazal_engine'), join(backend, 'mazal_engine'), path => !path.split('/').some(part => part === '__pycache__'));
  for (const name of ['pyproject.toml', 'uv.lock', '.python-version']) await copy(join(root, 'backend', name), join(backend, name));
  const libraryName = (await readdir(join(root, 'backend', '.venv', 'lib'))).find(name => /^python3\.13$/.test(name));
  if (!libraryName) throw new Error('The checked Python 3.13 environment is missing. Run npm run engine:setup first.');
  await copy(join(root, 'backend', '.venv', 'lib', libraryName, 'site-packages'), join(backend, '.venv', 'lib', libraryName, 'site-packages'), path => !path.split('/').some(part => part === '__pycache__'));
  await mkdir(join(backend, '.venv', 'bin'), { recursive: true });
  const launcher = '#!/bin/sh\nset -eu\nmazal_bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nmazal_backend_dir=$(CDPATH= cd -- "$mazal_bin_dir/../.." && pwd)\nmazal_resources_dir=$(CDPATH= cd -- "$mazal_backend_dir/../.." && pwd)\nexport PYTHONPATH="$mazal_backend_dir/.venv/lib/python3.13/site-packages:$mazal_backend_dir"\nexport PYTHONDONTWRITEBYTECODE=1\nexec "$mazal_resources_dir/runtime/python/bin/python3.13" "$@"\n';
  await writeFile(join(backend, '.venv', 'bin', 'python'), launcher, { mode: 0o755 });
  await run(join(backend, '.venv', 'bin', 'python'), ['-c', `import sys, fastapi, uvicorn, numpy, scipy, pandas, statsmodels, pymc, arviz, cvxpy, QuantLib; from mazal_engine.app import app; assert sys.version.split()[0] == '${webBuild.pythonVersion}'; config = uvicorn.Config(app, host='127.0.0.1'); config.load(); assert config.loaded; print("Bundled Python imports and financial server configuration passed.")`], { cwd: backend, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MPLCONFIGDIR: join(staging, 'matplotlib') } });
  const nativeCompatibility = await verifyMacOSBundle(bundle, minimumMacOS);
  console.log(`Verified macOS ${minimumMacOS} deployment metadata for ${nativeCompatibility.length} native files.`);
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  const files = await inventory(resources);
  const nativeSources = await Promise.all(['macos/Mazal.swift', 'macos/ExtractText.swift', 'macos/Icon.swift', 'macos/Info.plist', 'scripts/build-mac-app.mjs', 'scripts/native-build-cache.mjs', 'scripts/macos-target.mjs', 'scripts/macos-install.mjs', 'scripts/package-copy.mjs', 'public/icon.svg'].map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })));
  const verifiedBuild = await verifyBuildIdentity(root);
  if (verifiedBuild.sourceSha256 !== webBuild.sourceSha256 || verifiedBuild.assetsSha256 !== webBuild.assetsSha256) throw new Error('Source or web assets changed during native packaging. Build again.');
  await writeFile(join(resources, 'BUILD.json'), `${JSON.stringify({ version: metadata.version, sourceSha256: webBuild.sourceSha256, assetsSha256: webBuild.assetsSha256, builtAt: new Date().toISOString(), architecture: process.arch, nodeVersion: process.version, pythonVersion: webBuild.pythonVersion, minimumMacOS, nativeCompatibility, nativeSources, nativeBuilds, files }, null, 2)}\n`);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const output = bundle;
  const archiveDirectory = join(root, 'artifacts', 'macos');
  await mkdir(archiveDirectory, { recursive: true });
  const legacy = join(archiveDirectory, 'Mazal.app');
  if (await exists(legacy)) {
    if (await appIsRunning(legacy)) throw new Error('Quit the previous workspace build before archiving it.');
    throw new Error(`A previous workspace bundle remains at ${legacy}. Move it to Trash before packaging.`);
  }
  const archiveName = 'Mazal-latest.zip';
  const preparedArchive = join(staging, archiveName);
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', '--noqtn', output, preparedArchive]);
  const extracted = join(staging, 'archive-check');
  await mkdir(extracted);
  await run('/usr/bin/ditto', ['-x', '-k', preparedArchive, extracted]);
  const extractedApp = join(extracted, 'Mazal.app');
  temporaryApps.add(extractedApp);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp]);
  await verifyInstalledIdentity(extractedApp, webBuild);
  const runtimeVerification = await verifyMacRuntime(extractedApp, webBuild);
  assertMatchingBuild(await verifyBuildIdentity(root), webBuild, 'The source after archive verification');
  const archive = join(archiveDirectory, archiveName);
  await rename(preparedArchive, archive);
  console.log(`Verified ZIP and packaged runtime ${archive}`);
  if (options.has('--install')) {
    const applications = join(homedir(), 'Applications');
    const installed = join(applications, 'Mazal.app');
    await mkdir(applications, { recursive: true });
    if (await appIsRunning(installed)) throw new Error('Quit Mazal before installing an update. Your current app was kept.');
    const desktop = join(homedir(), 'Desktop', 'Mazal.app');
    if (await exists(desktop)) {
      const info = await lstat(desktop);
      if (!info.isSymbolicLink() || await readlink(desktop) !== installed) throw new Error('Desktop/Mazal.app already exists and was preserved. Move it before installing the desktop launcher.');
    }
    if (await exists(installed)) {
      const info = await readFile(join(installed, 'Contents', 'Info.plist'), 'utf8');
      if (!info.includes('local.mazal.desktop')) throw new Error('An unrelated Mazal.app exists in Applications. Keep it or move it before installing.');
    }
    const installStagingRoot = join(applications, '.mazal-install.noindex');
    await mkdir(installStagingRoot, { recursive: true, mode: 0o700 });
    const installStaging = await mkdtemp(join(installStagingRoot, 'update-'));
    const prepared = join(installStaging, 'Mazal.app');
    temporaryApps.add(prepared);
    let previous, rollbackArchive;
    try {
      await copy(output, prepared);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', prepared]);
      await verifyInstalledIdentity(prepared, webBuild);
      assertMatchingBuild(await verifyBuildIdentity(root), webBuild, 'The source before installation');
      if (await appIsRunning(installed)) throw new Error('Quit Mazal before installing an update. Your current app was kept.');
      if (await exists(installed)) {
        const backups = join(homedir(), 'Library', 'Application Support', 'Mazal', 'app-archives.noindex');
        await mkdir(backups, { recursive: true });
        rollbackArchive = join(backups, 'Mazal-previous.zip');
        await mkdir(join(installStaging, 'rollback'));
        previous = join(installStaging, 'rollback', 'Mazal.app');
        temporaryApps.add(previous);
        await unregisterApp(installed);
      }
      await installPreparedMacApp(prepared, installed, previous, async path => {
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]);
        await verifyInstalledIdentity(path, webBuild);
        assertMatchingBuild(await verifyBuildIdentity(root), webBuild, 'The source during installation');
        if (previous) {
          const preparedRollback = join(installStaging, 'Mazal-previous.zip');
          await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', '--noqtn', previous, preparedRollback]);
          await replaceMacAppArchive(preparedRollback, rollbackArchive, async archivePath => {
            const verification = join(installStaging, 'rollback-check');
            await mkdir(verification);
            await run('/usr/bin/ditto', ['-x', '-k', archivePath, verification]);
            const rollbackApp = join(verification, 'Mazal.app');
            temporaryApps.add(rollbackApp);
            await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', rollbackApp]);
          });
        }
      });
      if (rollbackArchive) console.log(`Previous installation preserved at ${rollbackArchive}`);
    } finally {
      for (const path of temporaryApps) if (path.startsWith(`${installStaging}/`)) { await unregisterApp(path); temporaryApps.delete(path); }
      if (await exists(installed)) await run(launchServices, ['-f', installed]);
      await rm(installStaging, { recursive: true, force: true });
    }
    const support = join(homedir(), 'Library', 'Application Support', 'Mazal');
    await mkdir(support, { recursive: true, mode: 0o700 });
    const receiptPath = join(support, 'last-install.json');
    const receipt = { installedAt: new Date().toISOString(), version: webBuild.version, sourceSha256: webBuild.sourceSha256, assetsSha256: webBuild.assetsSha256, installed, previous: rollbackArchive, archive, runtimeVerification };
    const saveReceipt = async (status, details = {}) => {
      await writeFile(`${receiptPath}.tmp`, `${JSON.stringify({ ...receipt, status, ...details }, null, 2)}\n`, { mode: 0o600, flush: true });
      await rename(`${receiptPath}.tmp`, receiptPath);
    };
    await saveReceipt('installed-awaiting-verification');
    let running;
    try {
      if (!(await exists(desktop))) await symlink(installed, desktop);
      await run(launchServices, ['-f', installed]);
      const credential = join(support, 'local-agent-token');
      let canVerifyRunning = false;
      if (await exists(join(support, 'data', '.desktop-only')) && await exists(join(support, 'data', 'live.sqlite'))) {
        try { await readAgentToken(credential); canVerifyRunning = true; } catch {}
      }
      if (canVerifyRunning) {
        await run('/usr/bin/open', ['-g', '-a', installed, '--args', '--agent-service']);
        running = await macReleaseStatus(root, installed);
      } else {
        await run('/usr/bin/open', ['-a', installed]);
      }
      assertMatchingBuild(await verifyBuildIdentity(root), webBuild, 'The source after launch');
      await saveReceipt(running ? 'verified' : 'installed-awaiting-setup', running ? { verifiedAt: new Date().toISOString(), running: running.runtime, engineVerification: running.engine } : {});
    } catch (error) {
      await saveReceipt('installed-verification-failed', { failedAt: new Date().toISOString(), error: error.message });
      throw error;
    }
    const result = running
      ? `Installed and running verified build ${webBuild.version} (${webBuild.sourceSha256.slice(0, 12)})\nThe app remains locked. Touch ID or the Mac login password is required to open records.`
      : `Installed build ${webBuild.version} (${webBuild.sourceSha256.slice(0, 12)}), awaiting setup.\nMazal opened normally. Protected records and private local agent access are required before npm run mac:status can verify the running build.`;
    console.log(`${result}\nDesktop launcher ${desktop}\nVerification receipt ${receiptPath}`);
  }
} finally {
  for (const path of temporaryApps) await unregisterApp(path);
  await rm(staging, { recursive: true, force: true });
}
