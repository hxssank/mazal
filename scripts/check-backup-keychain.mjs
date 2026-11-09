import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeBackupCredentials } from '../server/automatic-backup.ts';

if (process.platform !== 'darwin') throw new Error('The backup Keychain check requires macOS and an unlocked login keychain.');
const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
if (!architecture) throw new Error(`Unsupported Mac architecture: ${process.arch}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'mazal-keychain-check-'));
const executable = join(directory, 'Mazal');
const replacement = join(directory, 'Mazal-next');
const credentials = nativeBackupCredentials(executable);
const entries = [];
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed with status ${result.status}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
try {
  const source = await readFile(join(root, 'macos', 'Mazal.swift'), 'utf8');
  const plist = await readFile(join(root, 'macos', 'Info.plist'), 'utf8');
  const minimum = plist.match(/<key>LSMinimumSystemVersion<\/key>\s*<string>(\d+\.\d+(?:\.\d+)?)<\/string>/)?.[1];
  assert.ok(minimum, 'Info.plist must declare the minimum macOS version.');
  for (const [build, output] of [['A', executable], ['B', replacement]]) {
    const path = join(directory, `Mazal-${build}.swift`);
    await writeFile(path, `import Foundation\nif CommandLine.arguments.contains("--keychain-check-build") { print("${build}"); exit(0) }\n${source}`);
    run('/usr/bin/swiftc', ['-target', `${architecture}-apple-macosx${minimum}`, '-swift-version', '5', '-O', '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'LocalAuthentication', '-framework', 'Security', path, '-o', output]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.mazal.desktop', output]);
    assert.equal(run(output, ['--keychain-check-build']).trim(), build);
    run(output, ['--self-test']);
  }
  assert.notEqual(createHash('sha256').update(await readFile(executable)).digest('hex'), createHash('sha256').update(await readFile(replacement)).digest('hex'));
  const cases = [
    ['generated', randomBytes(32).toString('hex')],
    ['quoted Unicode and newline', 'Synthetic "recovery" key \\ 漢字 😀\nsecond line\n'],
    ['minimum emoji', '😀'.repeat(6)],
    ['minimum combining text', 'a\u0301'.repeat(6)],
    ['maximum ASCII', 'a'.repeat(1024)],
    ['maximum emoji', '😀'.repeat(512)],
    ['maximum CJK', '漢'.repeat(1024)],
  ];
  for (const [name, passphrase] of cases) {
    const id = randomUUID();
    entries.push({ name, id, passphrase });
    await assert.rejects(credentials.get(id), /missing from Keychain/);
    await credentials.set(id, passphrase);
    assert.equal(await credentials.get(id), passphrase, `${name} must round-trip in build A`);
  }
  const legacy = { name: 'legacy encoding', id: randomUUID(), passphrase: 'Synthetic legacy recovery key 😀\n' };
  entries.push(legacy);
  const encoded = `MAZAL-BACKUP-KEY-V1:${Buffer.from(legacy.passphrase).toString('base64')}`;
  run('/usr/bin/security', ['-i'], { input: `add-generic-password -s com.mazal.automatic-backup -a ${legacy.id} -T /usr/bin/security -w ${encoded}\n` });
  await rename(replacement, executable);
  assert.equal(run(executable, ['--keychain-check-build']).trim(), 'B');
  for (const { name, id, passphrase } of entries) {
    assert.equal(await credentials.get(id), passphrase, `${name} must survive replacement by build B`);
    await credentials.set(id, passphrase);
    await assert.rejects(credentials.set(id, 'Synthetic different recovery key'), /Keychain/);
    assert.equal(await credentials.get(id), passphrase, `${name} must reject replacement keys`);
  }
  for (const passphrase of ['a'.repeat(11), 'a'.repeat(1025), '😀'.repeat(513)]) {
    const id = randomUUID();
    entries.push({ name: 'invalid length', id, passphrase });
    await assert.rejects(credentials.set(id, passphrase), /Keychain/);
    await assert.rejects(credentials.get(id), /missing from Keychain/);
  }
  console.log(`Backup Keychain checks passed for ${cases.length} passphrases, legacy encoding, replaced builds, repeat saves, and rejected key changes.`);
} finally {
  const failures = [];
  for (const { id } of entries) {
    try {
      await credentials.delete(id);
      await assert.rejects(credentials.get(id), /missing from Keychain/);
    } catch (error) { failures.push({ id, error: error.message }); }
  }
  await rm(directory, { recursive: true, force: true });
  if (failures.length) throw new Error(`Synthetic Keychain cleanup needs attention: ${JSON.stringify(failures)}`);
}
