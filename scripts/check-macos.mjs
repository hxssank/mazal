import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';

if (process.platform !== 'darwin') throw new Error('Native macOS checks require a Mac.');
const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
if (!architecture) throw new Error(`Unsupported Mac architecture: ${process.arch}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plist = await readFile(join(root, 'macos', 'Info.plist'), 'utf8');
const minimumMacOS = plist.match(/<key>LSMinimumSystemVersion<\/key>\s*<string>(\d+\.\d+(?:\.\d+)?)<\/string>/)?.[1];
if (!minimumMacOS) throw new Error('Info.plist must declare the minimum macOS version.');
const directory = await mkdtemp(join(tmpdir(), 'mazal-native-check-'));
try {
  for (const [name, frameworks] of [
    ['Mazal', ['AppKit', 'WebKit', 'LocalAuthentication', 'Security']],
    ['ExtractText', ['AppKit', 'PDFKit', 'Vision']],
  ]) {
    const executable = join(directory, name);
    await run('/usr/bin/swiftc', ['-target', `${architecture}-apple-macosx${minimumMacOS}`, '-swift-version', '5', '-O', ...frameworks.flatMap(framework => ['-framework', framework]), join(root, 'macos', `${name}.swift`), '-o', executable]);
    await run(executable, ['--self-test']);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
