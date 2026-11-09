import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function details(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function databaseMetadata(database, required) {
  if (!required) { database.prepare('PRAGMA schema_version').get(); return undefined; }
  const metadata = database.prepare('SELECT workspace, revision FROM workspace_meta WHERE id = 1').get();
  if (metadata?.workspace !== 'live' || !Number.isSafeInteger(metadata.revision) || metadata.revision < 0) throw new Error('The source must contain saved personal records with a valid revision.');
  return metadata;
}

async function copyCheckpointedDatabase(source, destination, readMetadata, cause) {
  const journals = [`${source}-wal`, `${source}-journal`];
  const hasJournal = async () => (await Promise.all(journals.map(details))).some(Boolean);
  const inaccessible = () => new Error('SQLite cannot read the saved database with the current folder permissions. Open Mazal and retry, or allow the preview to access its saved-data folder.', { cause });
  const before = await stat(source, { bigint: true });
  if (await hasJournal()) throw inaccessible();
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const after = await stat(source, { bigint: true });
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key]) || await hasJournal()) {
    throw new Error('Saved records changed while the preview was being copied. No preview was opened. Retry when Mazal has finished saving.', { cause });
  }
  const copied = new DatabaseSync(destination);
  try {
    copied.exec('PRAGMA query_only=ON');
    const checks = copied.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error('The copied records did not pass the database integrity check. No preview was opened.');
    return databaseMetadata(copied, readMetadata);
  } finally { copied.close(); }
}

async function copyDatabase(source, destination, readMetadata = false) {
  if (!(await details(source))?.isFile()) throw new Error('The saved records database is missing or is not a regular file.');
  let database;
  let sourceRead = false;
  try {
    database = new DatabaseSync(source, { readOnly: true });
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
    const metadata = databaseMetadata(database, readMetadata);
    sourceRead = true;
    await backup(database, destination);
    await chmod(destination, 0o600);
    return metadata;
  } catch (error) {
    if (sourceRead || error.code !== 'ERR_SQLITE_ERROR' || ![8, 14].includes(error.errcode & 0xff)) throw error;
    database?.close();
    database = undefined;
    return await copyCheckpointedDatabase(source, destination, readMetadata, error);
  } finally { database?.close(); }
}

async function copyOriginals(source, destination, matches) {
  const directory = await details(source);
  if (!directory) return;
  if (!directory.isDirectory()) throw new Error('The original-file directory must be a regular directory.');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !matches(entry.name)) continue;
    const copied = join(destination, entry.name);
    await copyFile(join(source, entry.name), copied);
    await chmod(copied, 0o600);
  }
}

export async function createRecordsPreview(sourceDirectory) {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-records-preview-'));
  await chmod(directory, 0o700);
  try {
    const { revision } = await copyDatabase(join(sourceDirectory, 'live.sqlite'), join(directory, 'live.sqlite'), true);
    const sourceDocuments = join(sourceDirectory, 'documents', 'live');
    const previewDocuments = join(directory, 'documents', 'live');
    const documentDatabase = join(sourceDocuments, 'documents.sqlite');
    if (await details(documentDatabase)) {
      await mkdir(previewDocuments, { recursive: true, mode: 0o700 });
      await copyDatabase(documentDatabase, join(previewDocuments, 'documents.sqlite'));
    }
    await copyOriginals(sourceDocuments, previewDocuments, name => /^[a-f0-9]{64}\.original$/.test(name));
    await copyOriginals(join(sourceDirectory, 'source-documents'), join(directory, 'source-documents'), name => !name.startsWith('.') && /\.(csv|json|pdf|png|jpe?g|heic|txt)$/i.test(name));
    let cleanup;
    return { directory, revision, close: () => cleanup ??= rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function runRecordsPreview() {
  let child;
  let stopped;
  let preview;
  const stop = signal => { stopped ??= signal; child?.kill(signal); };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    preview = await createRecordsPreview(resolve(process.env.MAZAL_SOURCE_DATA_DIR || join(root, 'data')));
    if (stopped) return 0;
    const env = {};
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith('MAZAL_DESKTOP_') && !['MAZAL_SAMPLE_PREVIEW', 'MAZAL_SOURCE_DATA_DIR'].includes(key)) env[key] = process.env[key];
    }
    Object.assign(env, { MAZAL_DATA_DIR: preview.directory, MAZAL_RECORDS_PREVIEW: '1', MAZAL_MASTER_WORKBOOK: join(preview.directory, 'preview.xlsx'), PORT: process.env.PORT ?? '5197' });
    console.log(`Opening a read-only preview of saved records at revision ${preview.revision}. Restart this command to copy newer records.`);
    return await new Promise((resolveExit, reject) => {
      child = spawn(process.execPath, [join(root, 'scripts', 'start.mjs')], { cwd: root, stdio: 'inherit', env });
      child.once('error', reject);
      child.once('exit', code => resolveExit(stopped ? 0 : code ?? 1));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    await preview?.close();
  }
}

if (process.argv[1] && process.argv[1] !== '-' && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  try { process.exitCode = await runRecordsPreview(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
