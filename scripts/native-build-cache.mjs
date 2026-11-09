import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { copyPackageTree } from './package-copy.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Native cache file must be a regular file: ${path}`);
  return readFile(path);
}

export async function prepareNativeExecutable({ cacheDirectory, output, readInputs, compile, verify, report = console.log }) {
  const started = performance.now();
  const inputs = await readInputs();
  const serializedInputs = JSON.stringify(inputs);
  const key = hash(serializedInputs);
  const entry = join(cacheDirectory, key);
  let hit = false;
  let bytes;
  try {
    const info = await lstat(entry);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native cache entry must be a directory.');
    const manifest = JSON.parse(await regularFile(join(entry, 'BUILD.json')));
    if (manifest.schemaVersion !== 1 || manifest.key !== key || JSON.stringify(manifest.inputs) !== serializedInputs) throw new Error('Native cache identity does not match.');
    bytes = await regularFile(join(entry, 'executable'));
    if (hash(bytes) !== manifest.sha256) throw new Error('Native cache executable checksum does not match.');
    await writeFile(output, bytes, { mode: 0o755 });
    await verify(output);
    hit = true;
  } catch (error) {
    if (error.code !== 'ENOENT') report(`Rebuilding ${basename(output)} because its native cache could not be verified: ${error.message}`);
    await rm(output, { force: true });
  }
  if (!hit) {
    await compile(output);
    await verify(output);
    bytes = await regularFile(output);
  }
  if (JSON.stringify(await readInputs()) !== serializedInputs) throw new Error(`Native build inputs changed while preparing ${basename(output)}. Build again.`);
  const sha256 = hash(bytes);
  if (!hit) {
    let pending;
    try {
      await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
      pending = await mkdtemp(join(cacheDirectory, '.pending-'));
      await writeFile(join(pending, 'executable'), bytes, { mode: 0o755 });
      await writeFile(join(pending, 'BUILD.json'), `${JSON.stringify({ schemaVersion: 1, key, inputs, sha256 }, null, 2)}\n`);
      await rm(entry, { recursive: true, force: true });
      await rename(pending, entry);
    } catch (error) {
      report(`Could not save the native cache for ${basename(output)}; its staged executable passed verification: ${error.message}`);
    } finally {
      if (pending) await rm(pending, { recursive: true, force: true }).catch(error => report(`Could not remove native cache staging ${pending}: ${error.message}`));
    }
  }
  const durationMs = Math.round(performance.now() - started);
  report(`${hit ? 'Reused' : 'Compiled'} ${basename(output)}; native verification passed in ${durationMs} ms.`);
  return { key, sha256, cacheHit: hit, durationMs };
}

export async function prepareBundledNativeExecutable({ stagingDirectory, output, readInputs, ...settings }) {
  const nativeDirectory = join(stagingDirectory, 'native');
  await mkdir(nativeDirectory, { recursive: true });
  const standalone = join(nativeDirectory, basename(output));
  const result = await prepareNativeExecutable({
    ...settings,
    output: standalone,
    readInputs: async () => ({ signingContext: 'standalone-v2', inputs: await readInputs() }),
  });
  await copyPackageTree(standalone, output);
  return result;
}
