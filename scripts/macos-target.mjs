import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const machOMagic = new Set(['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

function versionParts(version) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error(`Invalid macOS version: ${version}`);
  const parts = version.split('.').map(Number);
  return [parts[0], parts[1], parts[2] ?? 0];
}

export function macOSMinimums(output) {
  const versions = [];
  for (const block of output.split(/Load command \d+/)) {
    if (/\bcmd LC_BUILD_VERSION\b/.test(block) && /\bplatform MACOS\b/.test(block)) {
      const match = block.match(/^\s*minos (\d+(?:\.\d+)+)\s*$/m);
      if (match) versions.push(match[1]);
    } else if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(block)) {
      const match = block.match(/^\s*version (\d+(?:\.\d+)+)\s*$/m);
      if (match) versions.push(match[1]);
    }
  }
  if (!versions.length) throw new Error('Native file has no macOS deployment version.');
  versions.forEach(versionParts);
  return versions;
}

export function assertMacOSTarget(path, versions, target) {
  const maximum = versionParts(target);
  for (const version of versions) {
    const parts = versionParts(version);
    const difference = parts.map((part, index) => part - maximum[index]).find(value => value !== 0) ?? 0;
    if (difference > 0) throw new Error(`${path} requires macOS ${version}, above the advertised macOS ${target}.`);
  }
}

export async function verifyMacOSBundle(directory, target) {
  versionParts(target);
  const paths = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const file = await open(child, 'r');
        try {
          const header = Buffer.alloc(4);
          await file.read(header, 0, 4, 0);
          if (machOMagic.has(header.toString('hex'))) paths.push(child);
        } finally { await file.close(); }
      }
    }
  }
  await walk(directory);
  if (!paths.length) throw new Error('The Mac bundle has no native executables.');
  const inventory = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
    while (index < paths.length) {
      const path = paths[index++];
      const { stdout } = await execute('/usr/bin/vtool', ['-show-build', path]);
      const minimums = macOSMinimums(stdout);
      const name = relative(directory, path);
      assertMacOSTarget(name, minimums, target);
      inventory.push({ path: name, minimums });
    }
  }));
  return inventory.sort((a, b) => a.path.localeCompare(b.path));
}
