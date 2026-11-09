import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyBuildIdentity } from './build-identity.mjs';
import { collectRelease } from './release.mjs';
import { runLocalAgent } from './local-agent.mjs';
import { validateEngineEnvelope } from '../src/services/engine-api.ts';

async function packageInventory(directory, bundle, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && entry.name === 'BUILD.json') continue;
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await packageInventory(path, bundle, name));
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || relative(bundle, resolve(dirname(path), target)).startsWith('..')) throw new Error(`A package symlink escapes the app: ${name}`);
      files.push({ path: name, symlink: target });
    } else {
      if (!entry.isFile()) throw new Error(`Unsupported packaged file: ${name}`);
      const digest = createHash('sha256');
      let bytes = 0;
      for await (const chunk of createReadStream(path)) { bytes += chunk.length; digest.update(chunk); }
      files.push({ path: name, bytes, sha256: digest.digest('hex') });
    }
  }
  return files;
}

export function assertMatchingBuild(actual, expected, label) {
  for (const field of ['version', 'sourceSha256', 'assetsSha256']) {
    if (!actual || actual[field] !== expected[field]) throw new Error(`${label} has a different ${field}. Expected ${expected[field]}; found ${actual?.[field] ?? 'unknown'}. Run npm run mac:install to install the current source.`);
  }
}

export async function verifyInstalledIdentity(bundle, expected) {
  const resources = join(bundle, 'Contents', 'Resources');
  for (const path of [bundle, join(bundle, 'Contents'), resources]) if (!(await lstat(path)).isDirectory()) throw new Error('The installed package must use ordinary directories.');
  if (!(await lstat(join(resources, 'BUILD.json'))).isFile()) throw new Error('The package manifest must be a regular file.');
  const native = JSON.parse(await readFile(join(resources, 'BUILD.json'), 'utf8'));
  assertMatchingBuild(native, expected, 'The installed Mac package');
  const web = await verifyBuildIdentity(join(resources, 'app'), expected);
  if (!Array.isArray(native.files) || JSON.stringify(await packageInventory(resources, bundle)) !== JSON.stringify(native.files)) throw new Error('The installed package files changed after packaging. Rebuild and install Mazal.');
  const plist = await readFile(join(bundle, 'Contents', 'Info.plist'), 'utf8');
  for (const [key, value] of [['MazalReleaseVersion', expected.version], ['MazalSourceSHA256', expected.sourceSha256]]) {
    if (plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1] !== value) throw new Error(`The native launcher has a different ${key}. Rebuild and install Mazal.`);
  }
  return { version: web.version, sourceSha256: web.sourceSha256, assetsSha256: web.assetsSha256 };
}

async function engineStatus(root, runtime, agent) {
  const source = await readFile(join(root, 'shared', 'engine.ts'), 'utf8');
  const modelVersion = source.match(/export const ENGINE_MODEL_VERSION = '([^']+)'/)?.[1];
  if (!modelVersion) throw new Error('The current source is missing its financial engine model identity.');
  const read = async path => {
    const response = await agent(['GET', path]);
    try { return JSON.parse(response.body.toString('utf8')); }
    catch { throw new Error(`The financial engine returned an invalid response for ${path.split('?')[0]}.`); }
  };
  const health = await read('/api/engine/health');
  if (health?.status !== 'ok' || health.modelVersion !== modelVersion) throw new Error('The running Python engine is unhealthy or uses a different model from the current source.');
  if (!Number.isSafeInteger(runtime.revision) || runtime.revision < 0) throw new Error('The running app did not report a valid live revision.');
  const now = new Date();
  const asOf = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const query = new URLSearchParams({ workspace: 'live', scope: 'all', expectedRevision: String(runtime.revision), asOf });
  const calculation = await read(`/api/engine/summary?${query}`);
  try {
    if (calculation?.modelVersion !== modelVersion || !/^[a-f0-9]{64}$/.test(calculation.inputHash)) throw new Error('Invalid calculation identity.');
    validateEngineEnvelope(calculation, { workspace: 'live', scope: 'all', expectedRevision: runtime.revision, asOf }, 'summary');
  } catch { throw new Error('The running Python engine did not return a valid calculation for the current live revision.'); }
  return { status: 'ok', modelVersion, revision: calculation.revision, scope: calculation.scope, asOf };
}

export async function macReleaseStatus(root, installed, agent = runLocalAgent, signature = path => promisify(execFile)('/usr/bin/codesign', ['--verify', '--deep', '--strict', path])) {
  const { manifest } = await collectRelease(root);
  const web = await verifyBuildIdentity(root, manifest);
  const installation = await verifyInstalledIdentity(installed, web);
  await signature(installed);
  const arguments_ = ['status', '--expect-source', web.sourceSha256, '--expect-assets', web.assetsSha256];
  const result = await agent(arguments_);
  assertMatchingBuild(result.status?.runtimeBuild?.build, web, 'The running app');
  const engine = await engineStatus(root, result.status, agent);
  const final = await agent(arguments_);
  assertMatchingBuild(final.status?.runtimeBuild?.build, web, 'The running app after engine verification');
  if (final.status.revision !== engine.revision || final.status.runtimeBuild.processId !== result.status.runtimeBuild.processId
    || final.status.runtimeBuild.startedAt !== result.status.runtimeBuild.startedAt) throw new Error('The running app or its records changed during engine verification. Run npm run mac:status again.');
  assertMatchingBuild(await verifyBuildIdentity(root), web, 'The source after runtime verification');
  return { status: 'matched', version: web.version, sourceSha256: web.sourceSha256, assetsSha256: web.assetsSha256, installed, runtime: final.status, installation, engine };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error('Usage: npm run mac:status');
    const root = fileURLToPath(new URL('..', import.meta.url));
    console.log(JSON.stringify(await macReleaseStatus(root, join(homedir(), 'Applications', 'Mazal.app')), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
