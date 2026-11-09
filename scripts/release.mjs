import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixedFiles = [
  '.gitignore', '.node-version', '.github/workflows/ci.yml',
  'package.json', 'package-lock.json', 'index.html',
  'tsconfig.json', 'tsconfig.ui.json', 'tsconfig.server.json', 'vite.config.ts', 'playwright.config.ts',
  'backend/pyproject.toml', 'backend/uv.lock', 'backend/.python-version',
  'public/icon.svg', 'public/fonts/OFL.txt', 'public/fonts/barlow-condensed-bold.ttf',
];
const sourceTrees = new Map([
  ['src', new Set(['.ts', '.tsx', '.css'])], ['shared', new Set(['.ts'])],
  ['server', new Set(['.ts'])], ['scripts', new Set(['.mjs'])],
  ['backend/mazal_engine', new Set(['.py'])], ['backend/tests', new Set(['.py'])],
  ['macos', new Set(['.swift', '.plist'])],
  ['tests/desktop', new Set(['.ts'])],
]);
const excludedDirectories = new Set(['node_modules', 'data', 'backups', 'source-documents', 'artifacts', 'outputs', 'sandboxes', 'runtime', 'dist', '__pycache__']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHash = files => hash(JSON.stringify(files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))));
const releaseVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value);
export function allowedReleasePath(path) {
  if (typeof path !== 'string') return false;
  if (fixedFiles.includes(path) || path === 'INSTALL.txt') return true;
  const parts = path.split('/');
  if (parts.some(part => !part || part.startsWith('.') || excludedDirectories.has(part)) || path.includes('\\')) return false;
  return [...sourceTrees].some(([tree, extensions]) => path.startsWith(`${tree}/`) && extensions.has(extname(path)));
}

function installInstructions(version, nodeVersion, pythonVersion) {
  return `Mazal ${version}\n\nLocal release candidate. Install Node.js ${nodeVersion} and uv 0.13.1 on PATH.\nSetup installs Python ${pythonVersion} and the dependencies pinned in both lockfiles.\nInternet access is required for the first installation. No administrator access is required.\n\nFrom this extracted directory, run these commands in Terminal or PowerShell:\n\n  npm run setup\n  npm run build\n  npm start\n\nOpen http://127.0.0.1:5191.\nKeep the terminal open. Press Ctrl+C to stop Mazal and its Python engine.\n\nThis archive contains source code, tests, and dependency locks. It contains no saved\nfinancial records, original documents, workbook, or installed dependencies.\nNew installations keep records in the data directory beside package.json.\nIn Backups and data, restore the financial backup first. Choose the separate\noriginal-file archive and select Verify archive. Review the document and account\nlinks, including any Leave unlinked choices, then select Restore original files.\nUse Check recovery again and review any remaining file or account-link issues.\n\nOptional environment settings, set before npm start:\n  PORT: local HTTP port, default 5191\n  MAZAL_DATA_DIR: absolute location for records and original documents\n  MAZAL_MASTER_WORKBOOK: absolute path for Excel export\nExcel is written only when Update Excel is requested.\n\nVerification:\n  npm run check:release\n  npm run release:verify -- /absolute/path/to/this-release.zip\n\nRELEASE.json contains the source SHA-256 and a hash for every included file.\nThe ZIP's companion .sha256 file verifies the downloaded archive.\nThese hashes detect changes; they are not a digital publisher signature.\n`;
}

export async function collectRelease(directory) {
  const collected = new Map();
  async function add(path) {
    const parts = path.split('/');
    for (let length = 1; length < parts.length; length++) if ((await lstat(join(directory, ...parts.slice(0, length)))).isSymbolicLink()) throw new Error(`Release source cannot contain symlinks: ${path}`);
    const absolute = join(directory, path);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release source must be a regular file: ${path}`);
    collected.set(path, await readFile(absolute));
  }
  async function walk(tree) {
    if ((await lstat(join(directory, tree))).isSymbolicLink()) throw new Error(`Release source cannot contain symlinks: ${tree}`);
    for (const entry of await readdir(join(directory, tree), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || excludedDirectories.has(entry.name)) continue;
      const path = `${tree}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Release source cannot contain symlinks: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (allowedReleasePath(path)) await add(path);
    }
  }
  for (const path of fixedFiles) await add(path);
  for (const tree of sourceTrees.keys()) await walk(tree);
  const metadata = JSON.parse(collected.get('package.json').toString());
  const lock = JSON.parse(collected.get('package-lock.json').toString());
  if (!releaseVersion(metadata.version) || lock.version !== metadata.version || lock.packages?.['']?.version !== metadata.version) throw new Error('Package and lockfile release versions must match.');
  const nodeVersion = collected.get('.node-version').toString().trim();
  const pythonVersion = collected.get('backend/.python-version').toString().trim();
  if (![nodeVersion, pythonVersion].every(version => /^\d+\.\d+\.\d+$/.test(version))) throw new Error('Release runtimes must be pinned to exact major.minor.patch versions.');
  collected.set('INSTALL.txt', Buffer.from(installInstructions(metadata.version, nodeVersion, pythonVersion)));
  const files = [...collected].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
  return { collected, manifest: { format: 'mazal-source-release', schemaVersion: 1, version: metadata.version, nodeVersion, pythonVersion, sourceSha256: sourceHash(files), files } };
}

export async function createRelease(directory = root, outputDirectory = join(root, 'artifacts', 'releases')) {
  const { collected, manifest } = await collectRelease(directory);
  const zip = new JSZip();
  const prefix = `mazal-${manifest.version}`;
  const options = { date: new Date('1980-01-01T00:00:00Z'), createFolders: false, unixPermissions: 0o100644 };
  for (const { path } of manifest.files) zip.file(`${prefix}/${path}`, collected.get(path), options);
  zip.file(`${prefix}/RELEASE.json`, `${JSON.stringify(manifest, null, 2)}\n`, options);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' });
  const name = `${prefix}-${manifest.sourceSha256.slice(0, 12)}.zip`;
  await mkdir(outputDirectory, { recursive: true });
  const archive = join(outputDirectory, name);
  try { await writeFile(archive, bytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || !bytes.equals(await readFile(archive))) throw error; }
  await writeFile(`${archive}.sha256`, `${hash(bytes)}  ${name}\n`);
  return { archive, archiveSha256: hash(bytes), manifest };
}

export async function extractRelease(archive, destination) {
  const bytes = await readFile(archive);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries = Object.values(zip.files);
  const manifests = entries.filter(entry => /^[^/]+\/RELEASE\.json$/.test(entry.name));
  if (manifests.length !== 1) throw new Error('The release needs exactly one manifest.');
  const manifest = JSON.parse(await manifests[0].async('string'));
  if (manifest.format !== 'mazal-source-release' || manifest.schemaVersion !== 1 || !releaseVersion(manifest.version) || !Array.isArray(manifest.files)) throw new Error('Unrecognized release manifest.');
  const prefix = `mazal-${manifest.version}/`;
  const expected = new Map();
  for (const item of manifest.files) {
    if (!item || !allowedReleasePath(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256) || expected.has(`${prefix}${item.path}`)) throw new Error('Invalid file in the release manifest.');
    expected.set(`${prefix}${item.path}`, item);
  }
  if (sourceHash(manifest.files) !== manifest.sourceSha256 || entries.length !== expected.size + 1) throw new Error('The release inventory does not match its source hash.');
  const contents = [];
  for (const entry of entries) {
    if (entry.dir || entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name || (entry.unixPermissions & 0o170000) === 0o120000) throw new Error('Unsafe archive entry.');
    if (entry.name === `${prefix}RELEASE.json`) continue;
    const expectedFile = expected.get(entry.name);
    if (!expectedFile) throw new Error(`Unexpected release file: ${entry.name}`);
    const content = await entry.async('nodebuffer');
    if (content.length !== expectedFile.bytes || hash(content) !== expectedFile.sha256) throw new Error(`Release hash mismatch: ${expectedFile.path}`);
    contents.push([expectedFile.path, content]);
  }
  for (const path of fixedFiles) if (!expected.has(`${prefix}${path}`)) throw new Error(`Release is missing ${path}`);
  const project = join(destination, `mazal-${manifest.version}`);
  await mkdir(project, { recursive: false });
  for (const [path, content] of contents) { const target = join(project, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { flag: 'wx' }); }
  await writeFile(join(project, 'RELEASE.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { project, manifest, archiveSha256: hash(bytes) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await createRelease();
  console.log(`Source release: ${result.archive}\nSHA-256: ${result.archiveSha256}\nSource SHA-256: ${result.manifest.sourceSha256}\nFiles: ${result.manifest.files.length}`);
}
