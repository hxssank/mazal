import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectRelease } from './release.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyNodeDependencies(directory) {
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!path.startsWith('node_modules/') || entry.link || typeof entry.version !== 'string') throw new Error(`Unsupported locked dependency: ${path}`);
    let installed;
    try { installed = JSON.parse(await readFile(join(directory, path, 'package.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT' && entry.optional) {
        try { await lstat(join(directory, path)); }
        catch (missing) { if (missing.code === 'ENOENT') continue; throw missing; }
      }
      throw new Error(`Cannot read installed dependency ${path}. Run npm ci.`, { cause: error });
    }
    if (installed.version !== entry.version) throw new Error(`${path} is ${installed.version}; the lockfile requires ${entry.version}. Run npm ci.`);
  }
}

async function assets(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!prefix && entry.name === 'BUILD.json') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await assets(absolute, path));
    else {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Build assets must be regular files: ${path}`);
      const bytes = await readFile(absolute);
      files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return files;
}

export async function writeBuildIdentity(directory, expectedSource) {
  const { manifest } = await collectRelease(directory);
  if (manifest.sourceSha256 !== expectedSource.sourceSha256) throw new Error('Source changed during the build. Build again before packaging.');
  const files = await assets(join(directory, 'dist'));
  if (!files.some(file => file.path === 'index.html') || !files.some(file => file.path.endsWith('.js'))) throw new Error('The web build is incomplete.');
  const identity = { format: 'mazal-web-build', schemaVersion: 1, version: manifest.version, sourceSha256: manifest.sourceSha256, nodeVersion: manifest.nodeVersion, pythonVersion: manifest.pythonVersion, assetsSha256: hash(JSON.stringify(files)), assets: files };
  await writeFile(join(directory, 'dist', 'BUILD.json'), `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

export async function verifyBuildIdentity(directory, expectedSource) {
  const manifest = expectedSource ?? (await collectRelease(directory)).manifest;
  const dist = join(directory, 'dist');
  if ((await lstat(dist)).isSymbolicLink() || !(await lstat(join(dist, 'BUILD.json'))).isFile() || (await lstat(join(dist, 'BUILD.json'))).isSymbolicLink()) throw new Error('Build metadata must be a regular file in the build directory.');
  const identity = JSON.parse(await readFile(join(dist, 'BUILD.json'), 'utf8'));
  if (identity.format !== 'mazal-web-build' || identity.schemaVersion !== 1 || identity.version !== manifest.version || identity.sourceSha256 !== manifest.sourceSha256 || identity.nodeVersion !== manifest.nodeVersion || identity.pythonVersion !== manifest.pythonVersion) throw new Error('The web build does not match the current source. Run npm run build.');
  const files = await assets(dist);
  if (JSON.stringify(files) !== JSON.stringify(identity.assets) || hash(JSON.stringify(files)) !== identity.assetsSha256) throw new Error('Web build assets changed after the build. Run npm run build.');
  return identity;
}

export function nativeReleasePlist(plist, identity) {
  const match = /^(\d+\.\d+\.\d+)(?:-rc\.(\d+))?$/.exec(identity.version);
  if (!match || !/^[a-f0-9]{64}$/.test(identity.sourceSha256)) throw new Error('The native release needs a stable or rc version and a source SHA-256.');
  let output = plist;
  for (const [key, value] of Object.entries({ CFBundleShortVersionString: match[1], CFBundleVersion: match[2] ?? '1' })) {
    const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    if (!pattern.test(output)) throw new Error(`Info.plist is missing ${key}.`);
    output = output.replace(pattern, (_, opening, closing) => `${opening}${value}${closing}`);
  }
  if (/<key>Mazal(?:ReleaseVersion|SourceSHA256)<\/key>/.test(output)) throw new Error('Native release identity is generated during packaging.');
  return output.replace('</dict>\n</plist>', `  <key>MazalReleaseVersion</key><string>${identity.version}</string>\n  <key>MazalSourceSHA256</key><string>${identity.sourceSha256}</string>\n</dict>\n</plist>`);
}
