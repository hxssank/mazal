import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutomaticBackupService, type AutomaticBackupCredentials } from './automatic-backup.ts';
import { createCompleteBackupService, decodeCompleteBackup } from './complete-backup.ts';
import { createStore } from './store.ts';
import { createDocumentStore } from './documents.ts';
import { BackupError } from './backup.ts';

function setup(t: test.TestContext, real = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mazal-automatic-test-')));
  const directory = join(root, 'data'), destination = join(root, 'destination');
  mkdirSync(directory); mkdirSync(destination);
  const secrets = new Map<string, string>();
  const credentials: AutomaticBackupCredentials = { get: async id => { const secret = secrets.get(id); if (!secret) throw new Error('Missing synthetic key'); return secret; }, set: async (id, key) => { secrets.set(id, key); }, delete: async id => { secrets.delete(id); } };
  let clock = new Date('2026-10-19T12:00:00.000Z');
  let failure = false;
  let exports = 0;
  let verifierFailure = false;
  if (real) for (const workspace of ['live', 'demo'] as const) { createStore(join(directory, `${workspace}.sqlite`), workspace).close(); createDocumentStore(join(directory, 'documents', workspace)).close(); }
  const complete = real ? createCompleteBackupService(directory, { open: async () => {}, close: async () => {} }) : undefined;
  const options = {
    dataDirectory: directory, credentials, now: () => clock,
    exportArchive: async (key: string) => { exports++; if (failure) throw new BackupError(413, 'Complete backups support up to 180 MiB of records and evidence.'); return complete ? complete.exportArchive(key) : Buffer.from(`MAZAL-ENCRYPTED-1\nSynthetic encrypted archive ${exports}`); },
    exclusive: async <T>(operation: () => Promise<T>) => operation(),
    ...(real ? {} : { verifyArchive: async () => { if (verifierFailure) throw new Error('Synthetic verifier failure'); } }),
  };
  let service = createAutomaticBackupService(options);
  t.after(async () => { await service.close(); complete?.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, destination, secrets, options, get service() { return service; }, advance: (hours: number) => { clock = new Date(clock.getTime() + hours * 3600000); }, fail: (value: boolean) => { failure = value; }, failVerification: (value: boolean) => { verifierFailure = value; }, exports: () => exports, reopen: async () => { await service.close(); service = createAutomaticBackupService(options); return service; } };
}

function interruptStorageSetup(fixture: ReturnType<typeof setup>, point: 'created' | 'pinned'): void {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createAutomaticBackupService } from './server/automatic-backup.ts';
    const [dataDirectory, destination, point] = process.argv.slice(1);
    const mkdir = fs.mkdirSync, write = fs.writeFileSync;
    fs.mkdirSync = (path, ...args) => { const result = mkdir(path, ...args); if (point === 'created' && String(path).endsWith('/Mazal backups')) process.exit(73); return result; };
    fs.writeFileSync = (path, ...args) => { if (point === 'pinned' && String(path).endsWith('/.mazal-owner')) process.exit(73); return write(path, ...args); };
    syncBuiltinESMExports();
    const service = createAutomaticBackupService({ dataDirectory, credentials: { get: async () => { throw new Error('Missing synthetic key'); }, set: async () => { throw new Error('Setup should stop before creating a key'); }, delete: async () => {} }, exportArchive: async () => { throw new Error('Setup should stop before export'); }, exclusive: operation => operation() });
    await service.configure({ destination });
  `, fixture.directory, fixture.destination, point], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 73, child.stderr);
}

test('automatic backups encrypt, verify saved database/original bytes, persist status, and recover their key after restart', async t => {
  const fixture = setup(t, true);
  const documents = createDocumentStore(join(fixture.directory, 'documents/live'));
  const original = Buffer.from('%PDF-1.4\nSynthetic protected evidence');
  const document = documents.upload(original, { originalName: 'synthetic.pdf' }).document; documents.close();
  const before = readFileSync(join(fixture.directory, 'live.sqlite'));
  const status = await fixture.service.configure({ destination: fixture.destination });
  assert.equal(status.running, false); assert.equal(status.enabled, true); assert.ok(status.lastVerifiedAt); assert.ok(status.lastBackupPath);
  assert.ok(before.equals(readFileSync(join(fixture.directory, 'live.sqlite'))));
  const key = await fixture.service.recoveryKey(); assert.equal(key.passphrase.length, 64);
  const bytes = readFileSync(status.lastBackupPath);
  assert.equal(bytes.includes(original), false);
  const { manifest, encrypted } = await decodeCompleteBackup(bytes, key.passphrase); assert.equal(encrypted, true);
  assert.ok(Buffer.from(manifest.files.find(file => file.path.endsWith(`${document.id}.original`))!.content, 'base64').equals(original));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), status.lastBackupSha256);
  assert.equal(readFileSync(join(fixture.root, '.data.automatic-backup.json'), 'utf8').includes(key.passphrase), false);
  assert.equal(JSON.stringify(status).includes(key.passphrase), false);
  assert.equal(statSync(status.lastBackupPath).mode & 0o777, 0o600);
  const reopened = await fixture.reopen(); assert.equal(reopened.status().lastBackupPath, status.lastBackupPath);
  assert.deepEqual(await reopened.recoveryKey(), key);
  await reopened.disable(); assert.equal(reopened.status().enabled, false); assert.deepEqual(await reopened.recoveryKey(), key);
  fixture.advance(48); await reopened.tick(); assert.equal(fixture.exports(), 1);
  assert.deepEqual(readdirSync(fixture.root).filter(name => name.startsWith('.mazal-restore-')), []);
});

test('failed first setup retains its error across restart and can retry the same destination', async t => {
  const fixture = setup(t); fixture.failVerification(true);
  await assert.rejects(fixture.service.configure({ destination: fixture.destination }), /automatic backup failed/);
  assert.equal(fixture.service.status().configured, false); assert.match(fixture.service.status().lastError!, /failed/);
  assert.equal(existsSync(join(fixture.destination, 'Mazal backups')), false);
  assert.equal(fixture.secrets.size, 0);
  await fixture.reopen(); assert.match(fixture.service.status().lastError!, /failed/);
  fixture.failVerification(false);
  assert.equal((await fixture.service.configure({ destination: fixture.destination })).enabled, true);
});

test('first setup recovers repeated crashes after directory creation and after pinning its identity', async t => {
  const fixture = setup(t, true);
  const storage = join(fixture.destination, 'Mazal backups');
  const journal = join(fixture.root, '.data.automatic-backup.json.setup');
  interruptStorageSetup(fixture, 'created');
  assert.deepEqual(readdirSync(storage), []);
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).storage, undefined);
  interruptStorageSetup(fixture, 'pinned');
  const pinned = JSON.parse(readFileSync(journal, 'utf8'));
  assert.equal(pinned.storage.inode, statSync(storage, { bigint: true }).ino.toString());
  assert.deepEqual(readdirSync(storage), []);
  interruptStorageSetup(fixture, 'pinned');
  assert.equal(readFileSync(journal, 'utf8'), JSON.stringify(pinned));
  await fixture.reopen();
  const status = await fixture.service.configure({ destination: fixture.destination });
  assert.equal(status.enabled, true); assert.ok(status.lastVerifiedAt); assert.ok(status.lastBackupPath);
  assert.equal(readFileSync(join(storage, '.mazal-owner'), 'utf8'), pinned.ownerId);
  const key = await fixture.service.recoveryKey();
  assert.equal((await decodeCompleteBackup(readFileSync(status.lastBackupPath), key.passphrase)).encrypted, true);
  assert.equal(existsSync(journal), false);
});

test('failed setup resumes after crashes while removing its empty folder without losing its saved key', async t => {
  for (const point of ['marker-removed', 'folder-removed'] as const) await t.test(point, async childTest => {
    const fixture = setup(childTest);
    const keyFile = join(fixture.root, 'synthetic-keychain.json');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { createAutomaticBackupService } from './server/automatic-backup.ts';
      const [dataDirectory, destination, keyFile, point] = process.argv.slice(1);
      const remove = fs.rmSync, rmdir = fs.rmdirSync;
      fs.rmSync = (path, ...args) => { const result = remove(path, ...args); if (point === 'marker-removed' && String(path).endsWith('/.mazal-owner')) process.exit(74); return result; };
      fs.rmdirSync = (path, ...args) => { const result = rmdir(path, ...args); if (point === 'folder-removed' && String(path).endsWith('/Mazal backups')) process.exit(74); return result; };
      syncBuiltinESMExports();
      const credentials = {
        get: async id => { const saved = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : {}; if (!saved[id]) throw new Error('Missing synthetic key'); return saved[id]; },
        set: async (id, key) => fs.writeFileSync(keyFile, JSON.stringify({ [id]: key }), { mode: 0o600 }),
        delete: async () => { throw new Error('The key must survive until cleanup finishes'); },
      };
      const service = createAutomaticBackupService({ dataDirectory, credentials, exportArchive: async () => { throw new Error('Synthetic export failure'); }, exclusive: operation => operation() });
      await service.configure({ destination });
    `, fixture.directory, fixture.destination, keyFile, point], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 74, child.stderr);
    const journal = join(fixture.root, '.data.automatic-backup.json.setup');
    assert.equal(JSON.parse(readFileSync(journal, 'utf8')).cleanup, true);
    const keys = JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, string>;
    for (const [id, key] of Object.entries(keys)) fixture.secrets.set(id, key);
    await fixture.reopen();
    const status = await fixture.service.configure({ destination: fixture.destination });
    assert.equal(status.enabled, true); assert.ok(status.lastBackupPath);
    const key = await fixture.service.recoveryKey(); assert.equal(key.passphrase, keys[key.credentialId]);
    assert.equal(existsSync(journal), false);
  });
});

test('a disappearing setup folder keeps its key and journal when saved bytes may still exist', async t => {
  const fixture = setup(t);
  const storage = join(fixture.destination, 'Mazal backups'), moved = join(fixture.destination, 'disconnected-backups');
  const name = `mazal-auto-2026-10-19T12-00-00-000Z-${randomUUID()}.encrypted.mazal`;
  const bytes = Buffer.from('Synthetic encrypted evidence that must keep its key');
  const service = createAutomaticBackupService({ ...fixture.options, exportArchive: async () => {
    writeFileSync(join(storage, name), bytes);
    renameSync(storage, moved);
    throw new Error('Synthetic destination interruption');
  } });
  t.after(() => service.close());
  await assert.rejects(service.configure({ destination: fixture.destination }), /automatic backup failed/);
  assert.equal(fixture.secrets.size, 1);
  const key = [...fixture.secrets.values()][0];
  assert.ok(readFileSync(join(moved, name)).equals(bytes));
  assert.ok(existsSync(join(fixture.root, '.data.automatic-backup.json.setup')));
  await service.close(); renameSync(moved, storage); await fixture.reopen();
  assert.equal((await fixture.service.configure({ destination: fixture.destination })).enabled, true);
  assert.equal((await fixture.service.recoveryKey()).passphrase, key);
  assert.ok(readFileSync(join(storage, name)).equals(bytes));
});

test('interrupted setup preserves nonempty folders and missing or changed ownership markers', async t => {
  for (const fault of ['nonempty', 'foreign-marker', 'marker-link'] as const) await t.test(fault, async child => {
    const fixture = setup(child);
    interruptStorageSetup(fixture, 'created');
    const storage = join(fixture.destination, 'Mazal backups');
    const marker = join(storage, '.mazal-owner');
    if (fault === 'nonempty') writeFileSync(join(storage, 'personal.txt'), 'Keep this evidence');
    if (fault === 'foreign-marker') writeFileSync(marker, randomUUID());
    if (fault === 'marker-link') { const foreign = join(fixture.root, 'foreign-owner'); writeFileSync(foreign, randomUUID()); symlinkSync(foreign, marker); }
    const before = readdirSync(storage);
    const journal = readFileSync(join(fixture.root, '.data.automatic-backup.json.setup'), 'utf8');
    await fixture.reopen();
    await assert.rejects(fixture.service.configure({ destination: fixture.destination }), /another configuration/);
    assert.deepEqual(readdirSync(storage), before);
    assert.equal(readFileSync(join(fixture.root, '.data.automatic-backup.json.setup'), 'utf8'), journal);
    assert.equal(fixture.exports(), 0); assert.equal(fixture.secrets.size, 0);
  });
});

test('interrupted setup rejects a replaced destination or pinned storage directory', async t => {
  for (const fault of ['destination', 'storage'] as const) await t.test(fault, async child => {
    const fixture = setup(child);
    interruptStorageSetup(fixture, 'pinned');
    const replaced = fault === 'destination' ? fixture.destination : join(fixture.destination, 'Mazal backups');
    const preserved = `${replaced}-preserved`;
    renameSync(replaced, preserved); mkdirSync(replaced);
    await fixture.reopen();
    await assert.rejects(fixture.service.configure({ destination: fixture.destination }), /destination changed/);
    assert.deepEqual(readdirSync(replaced), []);
    assert.ok(existsSync(preserved)); assert.equal(fixture.exports(), 0); assert.equal(fixture.secrets.size, 0);
  });
});

test('interrupted setup refuses journal or directory changes while checking Keychain', async t => {
  for (const fault of ['journal', 'storage', 'content'] as const) await t.test(fault, async child => {
    const fixture = setup(child);
    interruptStorageSetup(fixture, 'created');
    const storage = join(fixture.destination, 'Mazal backups');
    const journal = join(fixture.root, '.data.automatic-backup.json.setup');
    let changedJournal: string | undefined;
    const credentials = { ...fixture.options.credentials, get: async () => {
      if (fault === 'journal') { const saved = JSON.parse(readFileSync(journal, 'utf8')); changedJournal = JSON.stringify({ ...saved, ownerId: randomUUID() }); writeFileSync(journal, changedJournal); }
      if (fault === 'storage') { renameSync(storage, `${storage}-preserved`); mkdirSync(storage); }
      if (fault === 'content') writeFileSync(join(storage, 'personal.txt'), 'Keep this evidence');
      throw new Error('Missing synthetic key');
    } };
    const service = createAutomaticBackupService({ ...fixture.options, credentials });
    child.after(() => service.close());
    await assert.rejects(service.configure({ destination: fixture.destination }), /journal changed|destination changed|no longer empty/);
    assert.equal(existsSync(join(storage, '.mazal-owner')), false);
    if (changedJournal) assert.equal(readFileSync(journal, 'utf8'), changedJournal);
    if (fault === 'content') assert.equal(readFileSync(join(storage, 'personal.txt'), 'utf8'), 'Keep this evidence');
    assert.equal(fixture.exports(), 0); assert.equal(fixture.secrets.size, 0);
  });
});

test('first setup preserves journals changed during credential or archive creation', async t => {
  for (const point of ['set', 'get', 'export'] as const) await t.test(point, async child => {
    const fixture = setup(child);
    const journal = join(fixture.root, '.data.automatic-backup.json.setup');
    let changed = '';
    const replaceJournal = () => { const saved = JSON.parse(readFileSync(journal, 'utf8')); changed = JSON.stringify({ ...saved, ownerId: randomUUID() }); writeFileSync(journal, changed); };
    const credentials = { ...fixture.options.credentials,
      set: async (id: string, key: string) => { await fixture.options.credentials.set(id, key); if (point === 'set') replaceJournal(); },
      get: async (id: string) => { const key = await fixture.options.credentials.get(id); if (point === 'get') replaceJournal(); return key; },
    };
    const service = createAutomaticBackupService({ ...fixture.options, credentials, exportArchive: async key => {
      const bytes = await fixture.options.exportArchive(key); if (point === 'export') replaceJournal(); return bytes;
    } });
    child.after(() => service.close());
    await assert.rejects(service.configure({ destination: fixture.destination }), /journal changed/);
    assert.equal(readFileSync(journal, 'utf8'), changed);
    assert.equal(service.status().configured, false);
    assert.equal(fixture.secrets.size, 1);
    assert.ok(existsSync(join(fixture.destination, 'Mazal backups', '.mazal-owner')));
  });
});

test('fresh setup does not claim an existing unowned folder, even when it is empty', async t => {
  const fixture = setup(t);
  const storage = join(fixture.destination, 'Mazal backups'); mkdirSync(storage);
  await assert.rejects(fixture.service.configure({ destination: fixture.destination }), /another configuration/);
  assert.deepEqual(readdirSync(storage), []);
  assert.equal(existsSync(join(fixture.root, '.data.automatic-backup.json.setup')), false);
  writeFileSync(join(storage, 'personal.txt'), 'Keep this evidence');
  await assert.rejects(fixture.service.configure({ destination: fixture.destination }), /another configuration/);
  assert.equal(readFileSync(join(storage, 'personal.txt'), 'utf8'), 'Keep this evidence');
  assert.equal(fixture.exports(), 0);
});

test('a saved recovery key repairs missing Keychain access only after decrypting the recorded backup', async t => {
  const fixture = setup(t, true); await fixture.service.configure({ destination: fixture.destination });
  const key = await fixture.service.recoveryKey(); fixture.secrets.clear();
  await assert.rejects(fixture.service.configure({ destination: fixture.destination }), /Enter your saved recovery key/);
  await assert.rejects(fixture.service.configure({ destination: fixture.destination, passphrase: 'An incorrect synthetic recovery key' }), /incorrect|damaged/);
  assert.equal(fixture.secrets.size, 0);
  await fixture.service.configure({ destination: fixture.destination, passphrase: key.passphrase });
  assert.deepEqual(await fixture.service.recoveryKey(), key);
});

test('a process restart resumes interrupted first setup with its original key and preserves its saved archive', async t => {
  const fixture = setup(t, true);
  const keyFile = join(fixture.root, 'synthetic-keychain.json');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createAutomaticBackupService } from './server/automatic-backup.ts';
    import { createCompleteBackupService } from './server/complete-backup.ts';
    const [directory, destination, keyFile] = process.argv.slice(1);
    const credentials = {
      get: async id => { const values = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : {}; if (!values[id]) throw new Error('Missing key'); return values[id]; },
      set: async (id, key) => fs.writeFileSync(keyFile, JSON.stringify({ [id]: key }), { mode: 0o600 }),
      delete: async () => {}
    };
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { rename(from, to); if (String(to).endsWith('.encrypted.mazal')) process.exit(73); };
    syncBuiltinESMExports();
    const complete = createCompleteBackupService(directory, { open: async () => {}, close: async () => {} });
    const service = createAutomaticBackupService({ dataDirectory: directory, credentials, exportArchive: key => complete.exportArchive(key), exclusive: operation => operation() });
    await service.configure({ destination });
  `, fixture.directory, fixture.destination, keyFile], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 73, child.stderr);
  const storage = join(fixture.destination, 'Mazal backups');
  const oldName = readdirSync(storage).find(name => name.endsWith('.mazal'))!;
  assert.ok(oldName);
  const oldBytes = readFileSync(join(storage, oldName));
  const keys = JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, string>;
  await fixture.reopen(); assert.match(fixture.service.status().lastError!, /interrupted/);
  await assert.rejects(fixture.service.configure({ destination: fixture.destination }), /already saved backup bytes/);
  assert.equal(fixture.secrets.size, 0);
  for (const [id, key] of Object.entries(keys)) fixture.secrets.set(id, key);
  const next = await fixture.service.configure({ destination: fixture.destination });
  assert.equal(next.enabled, true);
  const recovered = await fixture.service.recoveryKey();
  assert.equal(recovered.passphrase, keys[recovered.credentialId]);
  assert.ok(readFileSync(join(storage, oldName)).equals(oldBytes));
  assert.equal((await decodeCompleteBackup(oldBytes, recovered.passphrase)).encrypted, true);
  assert.equal((await decodeCompleteBackup(readFileSync(next.lastBackupPath!), recovered.passphrase)).encrypted, true);
  assert.equal(existsSync(join(fixture.root, '.data.automatic-backup.json.setup')), false);
});

test('reconfiguration preserves the recovery key and previous setup when its first copy fails', async t => {
  const fixture = setup(t); const before = await fixture.service.configure({ destination: fixture.destination, passphrase: 'Synthetic durable recovery key' });
  const key = await fixture.service.recoveryKey();
  await assert.rejects(fixture.service.configure({ destination: fixture.destination, passphrase: 'A different synthetic recovery key' }), /Keep the existing recovery key/);
  assert.deepEqual(await fixture.service.recoveryKey(), key);
  const other = join(fixture.root, 'other'); mkdirSync(other); fixture.fail(true);
  await assert.rejects(fixture.service.configure({ destination: other }), /180 MiB/);
  assert.equal(fixture.service.status().destination, before.destination); assert.ok(existsSync(before.lastBackupPath!));
  fixture.fail(false); await fixture.service.configure({ destination: other });
  assert.deepEqual(await fixture.service.recoveryKey(), key); assert.ok(existsSync(before.lastBackupPath!));
});

test('destination changes recover crashes without losing the previous backups or recovery key', async t => {
  for (const point of ['created', 'pinned', 'marker-removed', 'folder-removed', 'archive-installed', 'committed'] as const) await t.test(point, async childTest => {
    const fixture = setup(childTest);
    const before = await fixture.service.configure({ destination: fixture.destination });
    const key = await fixture.service.recoveryKey();
    const oldBytes = readFileSync(before.lastBackupPath!);
    const destination = join(fixture.root, 'new-destination'); mkdirSync(destination);
    await fixture.service.close();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { createAutomaticBackupService } from './server/automatic-backup.ts';
      const [dataDirectory, destination, point, savedKeys] = process.argv.slice(1);
      const keys = JSON.parse(savedKeys);
      const mkdir = fs.mkdirSync, write = fs.writeFileSync, remove = fs.rmSync, rmdir = fs.rmdirSync, rename = fs.renameSync;
      fs.mkdirSync = (path, ...args) => { const result = mkdir(path, ...args); if (point === 'created' && String(path).endsWith('/Mazal backups')) process.exit(73); return result; };
      fs.writeFileSync = (path, ...args) => { if (point === 'pinned' && String(path).endsWith('/.mazal-owner')) process.exit(73); return write(path, ...args); };
      fs.rmSync = (path, ...args) => { const result = remove(path, ...args); if (point === 'marker-removed' && String(path).endsWith('/.mazal-owner')) process.exit(73); return result; };
      fs.rmdirSync = (path, ...args) => { const result = rmdir(path, ...args); if (point === 'folder-removed' && String(path).endsWith('/Mazal backups')) process.exit(73); return result; };
      fs.renameSync = (from, to) => { const result = rename(from, to); if (point === 'archive-installed' && String(to).endsWith('.encrypted.mazal') || point === 'committed' && String(to).endsWith('.automatic-backup.json')) process.exit(73); return result; };
      syncBuiltinESMExports();
      const service = createAutomaticBackupService({ dataDirectory,
        credentials: { get: async id => keys[id], set: async () => { throw new Error('Reconfiguration must keep its key'); }, delete: async () => { throw new Error('Reconfiguration must not delete its key'); } },
        exportArchive: async () => { if (point.endsWith('-removed')) throw new Error('Synthetic export failure'); return Buffer.from('MAZAL-ENCRYPTED-1\\nSynthetic encrypted archive'); },
        verifyArchive: async () => {}, exclusive: operation => operation(),
      });
      await service.configure({ destination });
    `, fixture.directory, destination, point, JSON.stringify(Object.fromEntries(fixture.secrets))], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 73, child.stderr);
    const journal = join(fixture.root, '.data.automatic-backup.json.setup');
    assert.ok(existsSync(journal));
    const storage = join(destination, 'Mazal backups');
    const interruptedArchive = point === 'archive-installed' ? readdirSync(storage).find(name => name.endsWith('.mazal')) : undefined;
    const interruptedBytes = interruptedArchive ? readFileSync(join(storage, interruptedArchive)) : undefined;
    await fixture.reopen();
    if (point !== 'committed') {
      assert.equal(fixture.service.status().destination, before.destination);
      assert.match(fixture.service.status().lastError!, /interrupted/);
      await assert.rejects(fixture.service.configure({ destination: fixture.destination }), /original destination/);
    }
    const status = await fixture.service.configure({ destination });
    assert.equal(status.destination, destination); assert.equal(status.lastError, null);
    assert.deepEqual(await fixture.service.recoveryKey(), key);
    assert.ok(readFileSync(before.lastBackupPath!).equals(oldBytes));
    assert.ok(existsSync(status.lastBackupPath!));
    if (interruptedArchive) assert.ok(readFileSync(join(storage, interruptedArchive)).equals(interruptedBytes!));
    assert.equal(existsSync(journal), false);
  });
});

test('interrupted destination changes preserve replaced folders and foreign contents', async t => {
  for (const fault of ['storage', 'contents', 'owner'] as const) await t.test(fault, async childTest => {
    const fixture = setup(childTest);
    const before = await fixture.service.configure({ destination: fixture.destination });
    const key = await fixture.service.recoveryKey();
    const destination = join(fixture.root, 'new-destination'); mkdirSync(destination);
    const storage = join(destination, 'Mazal backups'); mkdirSync(storage);
    const identify = (path: string) => { const info = statSync(path, { bigint: true }); return { path, device: String(info.dev), inode: String(info.ino) }; };
    const configuration = JSON.parse(readFileSync(join(fixture.root, '.data.automatic-backup.json'), 'utf8')).configuration;
    const journal = join(fixture.root, '.data.automatic-backup.json.setup');
    const saved = JSON.stringify({ version: 1, ownerId: configuration.ownerId, credentialId: key.credentialId, destination: identify(destination), storage: identify(storage) });
    writeFileSync(journal, saved);
    if (fault === 'storage') { renameSync(storage, `${storage}-preserved`); mkdirSync(storage); }
    if (fault === 'contents') writeFileSync(join(storage, 'personal.txt'), 'Keep this evidence');
    if (fault === 'owner') writeFileSync(join(storage, '.mazal-owner'), randomUUID());
    const names = readdirSync(storage);
    await fixture.reopen();
    await assert.rejects(fixture.service.configure({ destination }), /destination changed|another configuration/);
    assert.deepEqual(readdirSync(storage), names);
    assert.equal(readFileSync(journal, 'utf8'), saved);
    assert.deepEqual(await fixture.service.recoveryKey(), key);
    assert.ok(existsSync(before.lastBackupPath!));
  });
});

test('daily catch-up and retention delete only verified app-owned copies after a new copy succeeds', async t => {
  const fixture = setup(t); await fixture.service.configure({ destination: fixture.destination });
  const storage = join(fixture.destination, 'Mazal backups');
  writeFileSync(join(storage, 'personal-file.txt'), 'Keep this file');
  await fixture.service.tick(); assert.equal(fixture.exports(), 1);
  fixture.advance(23); await fixture.service.tick(); assert.equal(fixture.exports(), 1);
  fixture.advance(1); await fixture.service.tick(); assert.equal(fixture.exports(), 2);
  for (let index = 0; index < 14; index++) { fixture.advance(24); await fixture.service.tick(); }
  assert.equal(readdirSync(storage).filter(name => name.endsWith('.mazal')).length, 14);
  const names = readdirSync(storage); fixture.fail(true); fixture.advance(24); await fixture.service.tick();
  assert.deepEqual(readdirSync(storage), names); assert.match(fixture.service.status().lastError!, /180 MiB/);
  const calls = fixture.exports(); await fixture.service.tick(); assert.equal(fixture.exports(), calls);
  fixture.fail(false); fixture.advance(0.25); await fixture.service.tick(); assert.equal(fixture.exports(), calls + 1);
  assert.equal(readFileSync(join(storage, 'personal-file.txt'), 'utf8'), 'Keep this file');
});

test('a missing or replaced destination fails without creating a fallback folder or deleting backups', async t => {
  const fixture = setup(t); const before = await fixture.service.configure({ destination: fixture.destination });
  const away = join(fixture.root, 'disconnected'); renameSync(fixture.destination, away);
  await assert.rejects(fixture.service.run(), /unavailable/); assert.equal(existsSync(fixture.destination), false);
  mkdirSync(fixture.destination);
  await assert.rejects(fixture.service.run(), /destination changed/); assert.deepEqual(readdirSync(fixture.destination), []);
  assert.ok(existsSync(join(away, 'Mazal backups', before.lastBackupPath!.split('/').at(-1)!)));
});

test('setup refuses the live data folder, its children, and symbolic link destinations', async t => {
  const fixture = setup(t); const child = join(fixture.directory, 'nested'); mkdirSync(child);
  await assert.rejects(fixture.service.configure({ destination: fixture.directory }), /outside/);
  await assert.rejects(fixture.service.configure({ destination: child }), /outside/);
  const linked = join(fixture.root, 'linked'); symlinkSync(fixture.destination, linked, 'dir');
  await assert.rejects(fixture.service.configure({ destination: linked }), /symbolic links/);
  assert.equal(fixture.exports(), 0);
});

test('corrupt persisted settings cannot silently disable protection or overwrite evidence', async t => {
  const fixture = setup(t); const path = join(fixture.root, '.data.automatic-backup.json'); writeFileSync(path, 'damaged settings');
  await fixture.reopen(); assert.match(fixture.service.status().lastError!, /could not be read/);
  await assert.rejects(fixture.service.configure({ destination: fixture.destination }), /could not be read/);
  assert.equal(readFileSync(path, 'utf8'), 'damaged settings');
});

test('concurrent automatic operations are rejected while the existing result remains observable', async t => {
  const fixture = setup(t); let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const service = createAutomaticBackupService({ ...fixture.options, exportArchive: async key => { await paused; return fixture.options.exportArchive(key); } });
  const configuring = service.configure({ destination: fixture.destination });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(service.status().running, true);
  await assert.rejects(service.configure({ destination: fixture.destination }), /already running/);
  release(); await configuring; await service.close();
});
