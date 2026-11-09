import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fsPromises, { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { createRecordsPreview } from './preview-records.mjs';
import { deferTestCleanup, trackTestResource, closeTestResource } from '../server/test-cleanup.ts';

const execute = promisify(execFile);
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');

test('records preview can be imported from a stdin maintenance script without starting a server', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const exited = once(child, 'exit');
  child.stdin.end(`import { createRecordsPreview } from ${JSON.stringify(new URL('./preview-records.mjs', import.meta.url).href)}; console.log(typeof createRecordsPreview);`);
  assert.deepEqual(await exited, [0, null], errors);
  assert.equal(output.trim(), 'function');
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-preview-test-'));
  deferTestCleanup(t, () => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  await mkdir(source);
  const database = trackTestResource(t, new DatabaseSync(join(source, 'live.sqlite')));
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE workspace_meta (id INTEGER PRIMARY KEY, workspace TEXT, revision INTEGER);
    INSERT INTO workspace_meta VALUES (1, 'live', 140);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, type TEXT);
    CREATE TABLE positions (id TEXT PRIMARY KEY);
    INSERT INTO accounts VALUES ('cash', 'cash');`);
  return { directory, source, database };
}

test('records preview copies WAL records and originals without auth files or source writes', async t => {
  const { source } = await fixture(t);
  const documents = join(source, 'documents', 'live');
  const sources = join(source, 'source-documents');
  await mkdir(documents, { recursive: true });
  await mkdir(sources);
  const metadata = trackTestResource(t, new DatabaseSync(join(documents, 'documents.sqlite')));
  metadata.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE documents (id TEXT PRIMARY KEY, metadata TEXT);
    INSERT INTO documents VALUES ('document', '{"originalName":"statement.pdf"}');`);
  const documentName = `${'a'.repeat(64)}.original`;
  await writeFile(join(documents, documentName), '%PDF-1.4 fixture');
  await writeFile(join(documents, '.session'), 'do not copy');
  await writeFile(join(source, '.desktop-only'), 'do not copy');
  await writeFile(join(source, 'session.json'), 'do not copy');
  const sourceNames = ['statement.csv', 'statement.json', 'statement.pdf', 'receipt.png', 'receipt.jpg', 'receipt.jpeg', 'receipt.heic', 'bank-activity-dom.txt'];
  for (const name of sourceNames) await writeFile(join(sources, name), `source fixture ${name}`);
  await writeFile(join(sources, '.session.json'), 'do not copy');
  const originalFiles = [join(source, 'live.sqlite'), join(source, 'live.sqlite-wal'), join(documents, 'documents.sqlite'), join(documents, 'documents.sqlite-wal'), join(documents, documentName), ...sourceNames.map(name => join(sources, name))];
  const before = await Promise.all(originalFiles.map(hash));
  const preview = trackTestResource(t, await createRecordsPreview(source));
  assert.equal(preview.revision, 140);
  if (process.platform !== 'win32') assert.equal((await stat(preview.directory)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(preview.directory)).sort(), ['documents', 'live.sqlite', 'source-documents']);
  assert.deepEqual((await readdir(join(preview.directory, 'documents', 'live'))).sort(), [documentName, 'documents.sqlite']);
  assert.deepEqual((await readdir(join(preview.directory, 'source-documents'))).sort(), [...sourceNames].sort());
  const copied = new DatabaseSync(join(preview.directory, 'live.sqlite'));
  try {
    assert.equal(copied.prepare("SELECT COUNT(*) AS count FROM accounts WHERE type = 'investment'").get().count, 0);
    assert.equal(copied.prepare('SELECT COUNT(*) AS count FROM positions').get().count, 0);
    assert.equal(copied.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 1);
    copied.exec('UPDATE workspace_meta SET revision = 141');
  } finally { copied.close(); }
  const copiedMetadata = new DatabaseSync(join(preview.directory, 'documents', 'live', 'documents.sqlite'), { readOnly: true });
  try { assert.equal(copiedMetadata.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 1); }
  finally { copiedMetadata.close(); }
  assert.equal(await hash(join(preview.directory, 'documents', 'live', documentName)), before[4]);
  for (const [index, name] of sourceNames.entries()) assert.equal(await hash(join(preview.directory, 'source-documents', name)), before[5 + index]);
  assert.deepEqual(await Promise.all(originalFiles.map(hash)), before);
  await closeTestResource(preview);
  await preview.close();
  await assert.rejects(access(preview.directory), { code: 'ENOENT' });
});

test('records preview opens a checkpointed WAL database in a read-only folder without creating source sidecars', { skip: process.platform === 'win32' }, async t => {
  const { directory, source } = await fixture(t);
  const isolated = join(directory, 'readonly');
  await mkdir(isolated);
  const sourceReader = new DatabaseSync(join(source, 'live.sqlite'), { readOnly: true });
  const { backup } = await import('node:sqlite');
  try { await backup(sourceReader, join(isolated, 'live.sqlite')); }
  finally { sourceReader.close(); }
  const saved = join(isolated, 'live.sqlite');
  const writer = new DatabaseSync(saved);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.close();
  await chmod(saved, 0o400);
  await chmod(isolated, 0o500);
  const before = await hash(saved);
  try {
    const direct = new DatabaseSync(saved, { readOnly: true });
    try { assert.throws(() => direct.prepare('SELECT * FROM workspace_meta').get(), error => error.code === 'ERR_SQLITE_ERROR' && [8, 14].includes(error.errcode & 0xff)); }
    finally { direct.close(); }
    const preview = await createRecordsPreview(isolated);
    try {
      assert.equal(preview.revision, 140);
      const copied = new DatabaseSync(join(preview.directory, 'live.sqlite'), { readOnly: true });
      try {
        assert.equal(copied.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 1);
        assert.equal(copied.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      } finally { copied.close(); }
      assert.equal(await hash(saved), before);
      assert.deepEqual(await readdir(isolated), ['live.sqlite']);
      assert.equal((await stat(saved)).mode & 0o777, 0o400);
    } finally { await preview.close(); }
  } finally { await chmod(isolated, 0o700); await chmod(saved, 0o600); }
});

test('records preview refuses to copy a readable WAL when its shared-memory file cannot be created', { skip: process.platform === 'win32' }, async t => {
  const { directory, source } = await fixture(t);
  const isolated = join(directory, 'readonly');
  await mkdir(isolated);
  const saved = join(isolated, 'live.sqlite');
  await copyFile(join(source, 'live.sqlite'), saved);
  await copyFile(join(source, 'live.sqlite-wal'), `${saved}-wal`);
  assert.ok((await stat(`${saved}-wal`)).size > 0);
  await chmod(isolated, 0o500);
  const before = await Promise.all([saved, `${saved}-wal`].map(hash));
  try {
    await assert.rejects(createRecordsPreview(isolated), /SQLite cannot read the saved database with the current folder permissions/);
    assert.deepEqual(await Promise.all([saved, `${saved}-wal`].map(hash)), before);
    assert.deepEqual((await readdir(isolated)).sort(), ['live.sqlite', 'live.sqlite-wal']);
  } finally { await chmod(isolated, 0o700); }
});

for (const change of ['database', 'wal', 'rollback journal']) test(`records preview rejects a ${change} change during a checkpointed copy`, { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-preview-race-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const saved = join(source, 'live.sqlite');
  const writer = new DatabaseSync(saved);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE workspace_meta (id INTEGER PRIMARY KEY, workspace TEXT, revision INTEGER); INSERT INTO workspace_meta VALUES (1, 'live', 140);");
  writer.close();
  await chmod(source, 0o500);
  const originalCopy = copyFile;
  let intercepted = false;
  const copied = t.mock.method(fsPromises, 'copyFile', async (...args) => {
    await originalCopy(...args);
    if (args[0] !== saved) return;
    intercepted = true;
    await chmod(source, 0o700);
    if (change === 'database') {
      const updated = new DatabaseSync(saved);
      try { updated.exec('UPDATE workspace_meta SET revision = 141'); }
      finally { updated.close(); }
    } else await writeFile(`${saved}${change === 'wal' ? '-wal' : '-journal'}`, 'A journal appeared during the copy');
    await chmod(source, 0o500);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createRecordsPreview(source), /Saved records changed while the preview was being copied/);
    assert.equal(intercepted, true);
  } finally {
    copied.mock.restore();
    syncBuiltinESMExports();
    await chmod(source, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

test('records preview refuses a missing or non-personal source instead of seeding records', async t => {
  const { directory, source, database } = await fixture(t);
  const missing = join(directory, 'missing');
  await assert.rejects(createRecordsPreview(missing), /saved records database is missing/);
  await assert.rejects(access(missing), { code: 'ENOENT' });
  database.exec("UPDATE workspace_meta SET workspace = 'demo'");
  await assert.rejects(createRecordsPreview(source), /saved personal records/);
});

async function launcher(t, startSource) {
  const fixtureState = await fixture(t);
  const scripts = join(fixtureState.directory, 'scripts');
  await mkdir(scripts);
  const script = join(scripts, 'preview-records.mjs');
  await copyFile(new URL('./preview-records.mjs', import.meta.url), script);
  await writeFile(join(scripts, 'start.mjs'), startSource);
  return { ...fixtureState, script, env: { ...process.env, MAZAL_SOURCE_DATA_DIR: fixtureState.source, MAZAL_DATA_DIR: join(fixtureState.directory, 'not-the-source'), MAZAL_MASTER_WORKBOOK: join(fixtureState.directory, 'never-write.xlsx'), MAZAL_SAMPLE_PREVIEW: '1', MAZAL_DESKTOP_TOKEN: 'fixture-only', MAZAL_DESKTOP_PARENT_PID: '99999', PORT: '5297' } };
}

test('records launcher isolates its child environment and removes the copy after exit', async t => {
  const { script, env, source } = await launcher(t, `console.log(JSON.stringify({ directory: process.env.MAZAL_DATA_DIR, workbook: process.env.MAZAL_MASTER_WORKBOOK, preview: process.env.MAZAL_RECORDS_PREVIEW, sample: process.env.MAZAL_SAMPLE_PREVIEW ?? null, auth: Object.keys(process.env).filter(key => key.startsWith('MAZAL_DESKTOP_')), source: process.env.MAZAL_SOURCE_DATA_DIR ?? null, port: process.env.PORT }));`);
  const { stdout } = await execute(process.execPath, [script], { cwd: tmpdir(), env, timeout: 10000 });
  assert.match(stdout, /revision 140/);
  const child = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.notEqual(child.directory, source);
  assert.notEqual(child.directory, env.MAZAL_DATA_DIR);
  assert.equal(child.workbook, join(child.directory, 'preview.xlsx'));
  assert.equal(child.preview, '1');
  assert.equal(child.sample, null);
  assert.equal(child.source, null);
  assert.deepEqual(child.auth, []);
  assert.equal(child.port, '5297');
  await assert.rejects(access(child.directory), { code: 'ENOENT' });
  await assert.rejects(access(env.MAZAL_MASTER_WORKBOOK), { code: 'ENOENT' });
  await access(join(source, 'live.sqlite'));
});

test('records launcher forwards termination before deleting its temporary copy', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const { script, env } = await launcher(t, `import { existsSync } from 'node:fs';
    process.on('SIGTERM', () => { console.log(JSON.stringify({ copiedBeforeExit: existsSync(process.env.MAZAL_DATA_DIR) })); process.exit(0); });
    console.log(JSON.stringify({ ready: process.env.MAZAL_DATA_DIR }));
    setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  deferTestCleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
    }
  });
  let output = '';
  const exited = once(child, 'exit');
  const directory = await new Promise((resolveReady, reject) => {
    child.stdout.on('data', bytes => {
      output += bytes;
      const ready = output.split('\n').find(line => line.startsWith('{"ready":'));
      if (ready) resolveReady(JSON.parse(ready).ready);
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Preview exited before readiness: ${code}`)));
  });
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  assert.match(output, /"copiedBeforeExit":true/);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
