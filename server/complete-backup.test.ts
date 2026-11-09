import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, RevisionConflictError } from './store.ts';
import { createDocumentStore } from './documents.ts';
import { createDocumentRecovery } from './document-recovery.ts';
import { createCompleteBackupService, decodeCompleteBackup, encodeCompleteBackup, recoverCompleteRestore } from './complete-backup.ts';
import { BackupError } from './backup.ts';
import JSZip from 'jszip';
import { gzipSync } from 'node:zlib';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mazal-complete-test-'));
  const directory = join(root, 'data'); mkdirSync(directory);
  for (const workspace of ['live', 'demo'] as const) {
    createStore(join(directory, `${workspace}.sqlite`), workspace).close();
    createDocumentStore(join(directory, 'documents', workspace)).close();
  }
  const service = createCompleteBackupService(directory, { close: async () => {}, open: async () => {} });
  return { root, directory, service };
}

test('complete backups verify database, originals and calculation evidence, encrypt and restore atomically with a replay receipt', async () => {
  const fixture = setup();
  try {
    const documents = createDocumentStore(join(fixture.directory, 'documents/live'));
    const bytes = Buffer.from('%PDF-1.4\nSynthetic complete backup original.');
    const original = documents.upload(bytes, { originalName: 'evidence.pdf' }).document; documents.close();
    const run = join(fixture.directory, 'engine-runs', randomUUID()); mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'input.json'), '{"snapshot":{"workspace":"live"}}');
    writeFileSync(join(run, 'status.json'), '{"status":"completed"}');
    const before = readFileSync(join(fixture.directory, 'live.sqlite'));
    const archive = await fixture.service.exportArchive('correct horse battery staple');
    assert.ok(before.equals(readFileSync(join(fixture.directory, 'live.sqlite'))), 'export must not change live records');
    assert.equal(archive.includes(Buffer.from('Synthetic complete backup original')), false);
    await assert.rejects(decodeCompleteBackup(archive, 'incorrect passphrase'), /incorrect|damaged/);
    const damaged = Buffer.from(archive); damaged[damaged.length - 1] ^= 1;
    await assert.rejects(decodeCompleteBackup(damaged, 'correct horse battery staple'), /incorrect|damaged/);
    const preview = await fixture.service.preview(archive, 'correct horse battery staple');
    assert.equal(preview.workspaces.live.documents, 1); assert.equal(preview.calculationFiles, 2);
    const request = { token: preview.token, expectedRevision: preview.expectedRevision, confirmation: true };
    const result = await fixture.service.restore(request);
    assert.equal(result.status, 'restored'); assert.ok(existsSync(result.previousDirectory));
    assert.deepEqual(await fixture.service.restore(request), result);
    const recovered = createDocumentStore(join(fixture.directory, 'documents/live'));
    assert.ok(recovered.content(original.id).bytes.equals(bytes)); recovered.close();
    const store = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    assert.ok(store.state().revision > preview.expectedRevision); assert.equal(store.state().audit[0].action, 'complete_restore');
    const restored = store.state();
    assert.throws(() => store.command({ type: 'update_living_costs', monthlyEssentialsCents: 99999, expectedRevision: preview.expectedRevision }), RevisionConflictError);
    assert.deepEqual(store.state(), restored); store.close();
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('complete preview rejects missing, corrupted and traversing evidence and refuses changed records before replacement', async () => {
  const fixture = setup();
  try {
    const archive = await fixture.service.exportArchive();
    const { manifest } = await decodeCompleteBackup(archive);
    for (const corrupt of [
      { ...manifest, files: manifest.files.slice(1) },
      { ...manifest, files: manifest.files.map((file, index) => index ? file : { ...file, path: '../outside.sqlite' }) },
      { ...manifest, files: manifest.files.map((file, index) => index ? file : { ...file, sha256: '0'.repeat(64) }) },
      { ...manifest, files: [...manifest.files, manifest.files[0]] },
    ]) await assert.rejects(decodeCompleteBackup(await encodeCompleteBackup(corrupt)));
    const preview = await fixture.service.preview(archive);
    const store = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    store.command({ type: 'add_account', entityId: 'personal', name: 'After preview', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-10-02', requestId: randomUUID(), expectedRevision: 0 }); store.close();
    await assert.rejects(fixture.service.restore({ token: preview.token, expectedRevision: 0, confirmation: true }), /changed after verification/);
    const staged = join(fixture.root, `.mazal-restore-${preview.token}`);
    assert.ok(existsSync(staged)); fixture.service.close(); assert.equal(existsSync(staged), false);
    const current = createStore(join(fixture.directory, 'live.sqlite'), 'live'); assert.equal(current.state().accounts[0].name, 'After preview'); current.close();
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('complete preview rejects hash-consistent empty databases and missing saved tables without changing current records', async () => {
  const fixture = setup();
  try {
    const store = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    store.command({ type: 'add_reserve', entityId: 'personal', name: 'Keep this reserve', amountCents: 12345 }); store.close();
    const documents = createDocumentStore(join(fixture.directory, 'documents/live'));
    documents.upload(Buffer.from('%PDF-1.4\nKeep this original.'), { originalName: 'evidence.pdf' }); documents.close();
    const { manifest } = await decodeCompleteBackup(await fixture.service.exportArchive());
    const before = new Map(manifest.files.map(file => [file.path, readFileSync(join(fixture.directory, file.path))]));
    const databases = manifest.files.filter(file => file.path.endsWith('.sqlite'));
    const faults = databases.flatMap(file => ['empty', 'unrelated-schema'].map(fault => ({ path: file.path, fault })));
    faults.push(
      { path: 'live.sqlite', fault: 'DROP TABLE workspace_meta' },
      { path: 'live.sqlite', fault: 'DELETE FROM workspace_meta' },
      { path: 'live.sqlite', fault: 'DROP TABLE reserves' },
      { path: 'live.sqlite', fault: 'omit-reserves' },
      { path: 'demo.sqlite', fault: 'omit-assets' },
      { path: 'documents/live/documents.sqlite', fault: 'DROP TABLE documents' },
    );
    for (const { path, fault } of faults) {
      const original = manifest.files.find(file => file.path === path)!;
      const damagedPath = join(fixture.root, 'damaged.sqlite');
      writeFileSync(damagedPath, fault === 'empty' || fault === 'unrelated-schema' ? Buffer.alloc(0) : Buffer.from(original.content, 'base64'));
      if (fault !== 'empty') {
        const database = new DatabaseSync(damagedPath);
        try {
          if (fault.startsWith('omit-')) {
            const row = database.prepare('SELECT settings FROM workspace_meta WHERE id=1').get() as { settings: string };
            const settings = JSON.parse(row.settings);
            settings.presentCollections = settings.presentCollections.filter((name: string) => name !== fault.slice(5));
            database.prepare('UPDATE workspace_meta SET settings=? WHERE id=1').run(JSON.stringify(settings));
          } else database.exec(fault === 'unrelated-schema' ? 'CREATE TABLE unrelated(value TEXT)' : fault);
        }
        finally { database.close(); }
      }
      const bytes = readFileSync(damagedPath);
      const damaged = { ...original, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') };
      const archive = await encodeCompleteBackup({ ...manifest, files: manifest.files.map(file => file.path === path ? damaged : file) });
      await assert.rejects(fixture.service.preview(archive), (error: unknown) => error instanceof BackupError && error.status === 400, `${path}: ${fault}`);
      for (const [savedPath, savedBytes] of before) assert.deepEqual(readFileSync(join(fixture.directory, savedPath)), savedBytes, `${path}: ${fault} changed ${savedPath}`);
      assert.equal(readdirSync(fixture.root).some(name => name.startsWith('.mazal-restore-')), false);
      rmSync(damagedPath);
    }
  } finally { fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('complete preview rejects scalar revision and collection overrides before replacing current records', async () => {
  const fixture = setup();
  try {
    const store = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    store.command({ type: 'update_living_costs', monthlyEssentialsCents: 12345 });
    const current = store.state(); store.close();
    const { manifest } = await decodeCompleteBackup(await fixture.service.exportArchive());
    const before = new Map(manifest.files.map(file => [file.path, readFileSync(join(fixture.directory, file.path))]));
    const original = manifest.files.find(file => file.path === 'live.sqlite')!;
    for (const fault of ['revision', 'reserves', 'payrollImports', 'null-scalar', 'array-scalar'] as const) {
      const path = join(fixture.root, 'invalid-settings.sqlite');
      writeFileSync(path, Buffer.from(original.content, 'base64'));
      const database = new DatabaseSync(path);
      try {
        const settings = JSON.parse((database.prepare('SELECT settings FROM workspace_meta WHERE id=1').get() as { settings: string }).settings);
        if (fault === 'null-scalar') settings.scalar = null;
        else if (fault === 'array-scalar') settings.scalar = [];
        else settings.scalar[fault] = fault === 'revision' ? current.revision : [];
        database.prepare('UPDATE workspace_meta SET settings=? WHERE id=1').run(JSON.stringify(settings));
      } finally { database.close(); }
      const bytes = readFileSync(path);
      const damaged = { ...original, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') };
      const archive = await encodeCompleteBackup({ ...manifest, files: manifest.files.map(file => file === original ? damaged : file) });
      await assert.rejects(fixture.service.preview(archive), (error: unknown) => error instanceof BackupError && error.status === 400 && /storage metadata/.test(error.message), fault);
      for (const [savedPath, saved] of before) assert.deepEqual(readFileSync(join(fixture.directory, savedPath)), saved, fault);
      assert.equal(readdirSync(fixture.root).some(name => name.startsWith('.mazal-restore-') || name.startsWith('.mazal-before-')), false);
      rmSync(path);
    }
    const reopened = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    try { assert.deepEqual(reopened.state(), current); } finally { reopened.close(); }
  } finally { fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

for (const fault of ['DELETE FROM workspace_meta', 'DROP TABLE workspace_meta']) test(`complete preview rejects stale leftover legacy records after ${fault}`, async () => {
  const fixture = setup();
  try {
    const store = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    const first = store.command({ type: 'add_reserve', entityId: 'personal', name: 'Saved reserve', amountCents: 12345 });
    const legacy = store.export();
    store.command({ type: 'update_reserve', id: first.reserves[0].id, expected: first.reserves[0], name: 'Saved reserve', amountCents: 54321, expectedRevision: first.revision, requestId: randomUUID() });
    const current = store.state(); store.close();
    const { manifest } = await decodeCompleteBackup(await fixture.service.exportArchive());
    const before = new Map(manifest.files.map(file => [file.path, readFileSync(join(fixture.directory, file.path))]));
    const entry = manifest.files.find(file => file.path === 'live.sqlite')!;
    const damagedPath = join(fixture.root, 'missing-metadata.sqlite');
    writeFileSync(damagedPath, Buffer.from(entry.content, 'base64'));
    const damaged = new DatabaseSync(damagedPath);
    try {
      damaged.exec('CREATE TABLE workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), workspace TEXT NOT NULL, document TEXT NOT NULL)');
      damaged.prepare('INSERT INTO workspace_state VALUES(1,?,?)').run('live', JSON.stringify(legacy.data));
      assert.equal((damaged.prepare('SELECT json_extract(data, \'$.amountCents\') AS amount FROM reserves').get() as { amount: number }).amount, 54321);
      damaged.exec(fault);
    } finally { damaged.close(); }
    const bytes = readFileSync(damagedPath);
    Object.assign(entry, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') });
    await assert.rejects(fixture.service.preview(await encodeCompleteBackup(manifest)), (error: unknown) => error instanceof BackupError && error.status === 400 && /workspace metadata/.test(error.message));
    for (const [path, saved] of before) assert.deepEqual(readFileSync(join(fixture.directory, path)), saved);
    const reopened = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    try { assert.deepEqual(reopened.state(), current); } finally { reopened.close(); }
  } finally { fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('complete backups still restore legacy records, older document tables, and absent empty optional tables', async () => {
  const source = setup();
  const target = setup();
  try {
    const store = createStore(join(source.directory, 'live.sqlite'), 'live');
    store.command({ type: 'add_reserve', entityId: 'personal', name: 'Legacy reserve', amountCents: 12345 });
    const saved = store.export(); store.close();
    const documents = createDocumentStore(join(source.directory, 'documents/live'));
    const original = Buffer.from('%PDF-1.4\nLegacy original.');
    const document = documents.upload(original, { originalName: 'legacy.pdf' }).document; documents.close();
    const { manifest } = await decodeCompleteBackup(await source.service.exportArchive());
    const legacyPath = join(source.root, 'legacy.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    try {
      legacy.exec('CREATE TABLE workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), workspace TEXT NOT NULL, document TEXT NOT NULL)');
      legacy.prepare('INSERT INTO workspace_state VALUES(1,?,?)').run('live', JSON.stringify(saved.data));
    } finally { legacy.close(); }
    const documentPath = join(source.root, 'old-documents.sqlite');
    writeFileSync(documentPath, Buffer.from(manifest.files.find(file => file.path === 'documents/live/documents.sqlite')!.content, 'base64'));
    const oldDocuments = new DatabaseSync(documentPath);
    try { oldDocuments.exec('DROP TABLE document_recoveries'); } finally { oldDocuments.close(); }
    const optionalPath = join(source.root, 'optional-tables.sqlite');
    writeFileSync(optionalPath, Buffer.from(manifest.files.find(file => file.path === 'demo.sqlite')!.content, 'base64'));
    const optional = new DatabaseSync(optionalPath);
    try {
      assert.equal((optional.prepare('SELECT COUNT(*) AS count FROM category_rules').get() as { count: number }).count, 0);
      const row = optional.prepare('SELECT settings FROM workspace_meta WHERE id=1').get() as { settings: string };
      const settings = JSON.parse(row.settings);
      settings.presentCollections = settings.presentCollections.filter((name: string) => name !== 'categoryRules');
      optional.prepare('UPDATE workspace_meta SET settings=? WHERE id=1').run(JSON.stringify(settings));
      optional.exec('DROP TABLE category_rules');
    } finally { optional.close(); }
    for (const [path, replacement] of [['live.sqlite', legacyPath], ['documents/live/documents.sqlite', documentPath], ['demo.sqlite', optionalPath]]) {
      const file = manifest.files.find(file => file.path === path)!;
      const bytes = readFileSync(replacement);
      Object.assign(file, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') });
    }
    const preview = await target.service.preview(await encodeCompleteBackup(manifest));
    assert.equal(preview.workspaces.live.documents, 1);
    await target.service.restore({ token: preview.token, expectedRevision: preview.expectedRevision, confirmation: true });
    const restored = createStore(join(target.directory, 'live.sqlite'), 'live');
    try { assert.deepEqual(restored.export().data.reserves, saved.data.reserves); } finally { restored.close(); }
    assert.deepEqual(readFileSync(join(target.directory, 'documents/live', `${document.id}.original`)), original);
  } finally { source.service.close(); target.service.close(); rmSync(source.root, { recursive: true, force: true }); rmSync(target.root, { recursive: true, force: true }); }
});

test('complete restore invalidates document edits opened against the replaced metadata', async () => {
  for (const [archivedRevision, currentRevision] of [[1, 1], [1, 3], [3, 1]]) {
    const source = setup();
    const target = setup();
    try {
      const bytes = Buffer.from('%PDF-1.4\nDocument metadata revision fixture.');
      let id = '';
      for (const workspace of ['live', 'demo']) {
        for (const [fixture, notes, revision] of [[source, 'Archived notes', archivedRevision], [target, 'Current notes', currentRevision]] as const) {
          const documents = createDocumentStore(join(fixture.directory, 'documents', workspace));
          try {
            const uploaded = documents.upload(bytes, { originalName: 'evidence.pdf' }).document;
            id = uploaded.id;
            for (let expectedRevision = 0; expectedRevision < revision; expectedRevision++) documents.patch(id, { notes, expectedRevision });
          } finally { documents.close(); }
        }
      }
      const preview = await target.service.preview(await source.service.exportArchive());
      await target.service.restore({ token: preview.token, expectedRevision: preview.expectedRevision, confirmation: true });
      for (const workspace of ['live', 'demo']) {
        const documents = createDocumentStore(join(target.directory, 'documents', workspace));
        try {
          const restored = documents.content(id).document;
          assert.equal(restored.notes, 'Archived notes');
          assert.throws(() => documents.patch(id, { notes: 'Unsaved edit from before restore', expectedRevision: currentRevision }), /changed in another window/);
          assert.equal(documents.content(id).document.notes, 'Archived notes');
          assert.equal(restored.revision, Math.max(currentRevision, archivedRevision) + 1);
          assert.equal(documents.patch(id, { notes: 'Reviewed restored notes', expectedRevision: restored.revision }).notes, 'Reviewed restored notes');
        } finally { documents.close(); }
      }
    } finally { source.service.close(); target.service.close(); rmSync(source.root, { recursive: true, force: true }); rmSync(target.root, { recursive: true, force: true }); }
  }
});

test('complete restore keeps document revisions above removed drafts after restart and reinsertion', async () => {
  for (const method of ['complete', 'upload', 'library']) for (const staleRevision of [0, 1]) {
    const fixture = setup();
    const bytes = Buffer.from('%PDF-1.4\nRemoved and restored document.');
    const documentDirectory = join(fixture.directory, 'documents/live');
    let restarted: ReturnType<typeof createCompleteBackupService> | undefined;
    try {
      const emptyArchive = await fixture.service.exportArchive();
      const original = createDocumentStore(documentDirectory);
      const document = original.upload(bytes, { originalName: 'evidence.pdf' }).document;
      const library = gzipSync(Buffer.concat([...original.export()]));
      original.close();
      const populatedArchive = await fixture.service.exportArchive();
      const edited = createDocumentStore(documentDirectory);
      try { for (let revision = 0; revision < staleRevision; revision++) edited.patch(document.id, { notes: 'Current notes', expectedRevision: revision }); }
      finally { edited.close(); }
      const emptyPreview = await fixture.service.preview(emptyArchive);
      await fixture.service.restore({ token: emptyPreview.token, expectedRevision: emptyPreview.expectedRevision, confirmation: true });
      fixture.service.close();
      restarted = createCompleteBackupService(fixture.directory, { close: async () => {}, open: async () => {} });
      if (method === 'complete') {
        const preview = await restarted.preview(populatedArchive);
        await restarted.restore({ token: preview.token, expectedRevision: preview.expectedRevision, confirmation: true });
      }
      const documents = createDocumentStore(documentDirectory);
      try {
        if (method === 'upload') documents.upload(bytes, { originalName: 'evidence.pdf' });
        if (method === 'library') {
          const financePath = join(fixture.directory, 'live.sqlite');
          const finance = createStore(financePath, 'live');
          try {
            const recovery = createDocumentRecovery({ directory: documentDirectory, sourceDirectory: join(fixture.directory, 'source-documents'), financePath, documents });
            const preview = await recovery.preview(library, async () => finance.state());
            recovery.commit({ token: preview.token, expectedRevision: preview.expectedRevision }, finance.state());
          } finally { finance.close(); }
        }
        const restored = documents.content(document.id).document;
        assert.ok(restored.revision > staleRevision, `${method} must invalidate removed document revision ${staleRevision}`);
        assert.throws(() => documents.patch(document.id, { notes: 'Stale draft', expectedRevision: staleRevision }), /changed in another window/);
        assert.deepEqual(documents.content(document.id).bytes, bytes);
        assert.equal(documents.patch(document.id, { notes: 'Fresh draft', expectedRevision: restored.revision }).notes, 'Fresh draft');
      } finally { documents.close(); }
    } finally { restarted?.close(); fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('complete export refuses pending and interrupted document recoveries without changing their evidence', async () => {
  for (const workspace of ['live', 'demo'] as const) for (const interrupted of [false, true]) {
    const fixture = setup();
    const documentDirectory = join(fixture.directory, 'documents', workspace);
    const financePath = join(fixture.directory, `${workspace}.sqlite`);
    const finance = createStore(financePath, workspace);
    const documents = createDocumentStore(documentDirectory);
    try {
      const stage = join(documentDirectory, '.recovery', randomUUID());
      mkdirSync(join(stage, 'originals'), { recursive: true });
      const original = Buffer.from('%PDF-1.4\nPending recovery original.');
      const sha256 = createHash('sha256').update(original).digest('hex');
      const evidence = [
        [join(stage, 'originals', `${sha256}.pdf`), original],
        [join(stage, 'owner.json'), Buffer.from(interrupted ? '{"pid":' : JSON.stringify({ pid: process.pid }))],
        [join(stage, 'pending.json'), Buffer.from('[{"kind":')],
      ] as const;
      for (const [path, bytes] of evidence) writeFileSync(path, bytes);
      const recovery = createDocumentRecovery({ directory: documentDirectory, sourceDirectory: join(fixture.directory, 'source-documents'), financePath, documents });
      const before = finance.state();
      assert.equal(recovery.health(before).incompleteRecoveries, interrupted ? 1 : 0);
      await assert.rejects(fixture.service.exportArchive(), (error: unknown) => error instanceof BackupError && error.status === 409 && /pending original-file recovery/.test(error.message));
      for (const [path, bytes] of evidence) assert.deepEqual(readFileSync(path), bytes);
      assert.deepEqual(finance.state(), before);
      assert.deepEqual(readdirSync(fixture.root), ['data'], 'rejection must not create a backup staging folder');
    } finally { documents.close(); finance.close(); fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('complete export permits empty document recovery folders', async () => {
  const fixture = setup();
  try {
    for (const workspace of ['live', 'demo']) mkdirSync(join(fixture.directory, 'documents', workspace, '.recovery'));
    const { manifest } = await decodeCompleteBackup(await fixture.service.exportArchive());
    assert.equal(manifest.files.length, 4);
    for (const workspace of ['live', 'demo']) assert.deepEqual(readdirSync(join(fixture.directory, 'documents', workspace, '.recovery')), []);
  } finally { fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('complete export refuses a file count that its restore decoder cannot accept', async () => {
  const fixture = setup();
  try {
    const run = join(fixture.directory, 'engine-runs', randomUUID()); mkdirSync(run, { recursive: true });
    for (let index = 0; index < 19997; index++) writeFileSync(join(run, `evidence-${index}.json`), '{}');
    await assert.rejects(fixture.service.exportArchive(), (error: unknown) => error instanceof BackupError && error.status === 413 && /20,000/.test(error.message));
    assert.equal(readdirSync(run).length, 19997);
    assert.deepEqual(readdirSync(fixture.root), ['data'], 'rejection must not leave a backup staging folder');
  } finally { fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('complete export tolerates abandoned verified previews but preserves and rejects recovery install journals', async () => {
  const fixture = setup();
  const finance = createStore(join(fixture.directory, 'live.sqlite'), 'live');
  const documents = createDocumentStore(join(fixture.directory, 'documents/live'));
  try {
    const recovery = createDocumentRecovery({ directory: join(fixture.directory, 'documents/live'), sourceDirectory: join(fixture.directory, 'source-documents'), financePath: join(fixture.directory, 'live.sqlite'), documents });
    const archive = gzipSync(Buffer.concat([...documents.export()]));
    const abandoned = await recovery.preview(archive, async () => finance.state());
    const latest = await recovery.preview(archive, async () => finance.state());
    recovery.commit({ token: latest.token, expectedRevision: latest.expectedRevision }, finance.state());
    const stage = join(fixture.directory, 'documents/live/.recovery', abandoned.token);
    const marker = readFileSync(join(stage, 'preview.json'));
    const { manifest } = await decodeCompleteBackup(await fixture.service.exportArchive());
    assert.ok(manifest.files.every(file => !file.path.includes('/.recovery/')));
    assert.deepEqual(readFileSync(join(stage, 'preview.json')), marker);
    const pending = Buffer.from('[{"kind":');
    writeFileSync(join(stage, 'pending.json'), pending);
    await assert.rejects(fixture.service.exportArchive(), (error: unknown) => error instanceof BackupError && error.status === 409);
    assert.deepEqual(readFileSync(join(stage, 'pending.json')), pending);
    rmSync(join(stage, 'pending.json'));
    for (const invalid of ['{', JSON.stringify({ version: 1, token: randomUUID() })]) {
      writeFileSync(join(stage, 'preview.json'), invalid);
      await assert.rejects(fixture.service.exportArchive(), (error: unknown) => error instanceof BackupError && error.status === 409);
    }
  } finally { documents.close(); finance.close(); fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('complete backups preserve plain-text bank captures with exact hashes through verification and restore', async () => {
  const fixture = setup();
  try {
    const bytes = Buffer.from('Account activity\r\n2026-10-15\tCaf\u00e9 purchase\t12.34\r\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = 'source-documents/bank-activity-dom.txt';
    mkdirSync(join(fixture.directory, 'source-documents'));
    writeFileSync(join(fixture.directory, path), bytes);
    const archive = await fixture.service.exportArchive();
    const { manifest } = await decodeCompleteBackup(archive);
    const original = manifest.files.find(file => file.path === path);
    assert.ok(original);
    assert.equal(original.sha256, sha256);
    assert.deepEqual(Buffer.from(original.content, 'base64'), bytes);
    for (const invalidPath of ['source-documents/../bank-activity-dom.txt', 'source-documents/nested/bank-activity-dom.txt', 'documents/live/bank-activity-dom.txt', 'payroll-originals/bank-activity-dom.txt', ...[':', '<', '>', '"', '|', '?', '*'].map(character => `source-documents/bank${character}capture.txt`)]) {
      await assert.rejects(decodeCompleteBackup(await encodeCompleteBackup({ ...manifest, files: manifest.files.map(file => file === original ? { ...file, path: invalidPath } : file) })), /invalid or duplicate file/);
    }
    const preview = await fixture.service.preview(archive);
    await fixture.service.restore({ token: preview.token, expectedRevision: preview.expectedRevision, confirmation: true });
    assert.deepEqual(readFileSync(join(fixture.directory, path)), bytes);
    assert.equal(createHash('sha256').update(readFileSync(join(fixture.directory, path))).digest('hex'), sha256);
  } finally { fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('complete backups preserve payroll ZIP originals as opaque files through verification and restore', async () => {
  const fixture = setup();
  try {
    const zip = new JSZip();
    zip.file('payroll/statement.csv', 'Pay date,Net pay\n2026-01-30,1234.56\n');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = `payroll-originals/${sha256}.zip`;
    mkdirSync(join(fixture.directory, 'payroll-originals'));
    writeFileSync(join(fixture.directory, path), bytes);
    const archive = await fixture.service.exportArchive();
    const { manifest } = await decodeCompleteBackup(archive);
    const original = manifest.files.find(file => file.path === path);
    assert.ok(original);
    assert.equal(original.sha256, sha256);
    assert.deepEqual(Buffer.from(original.content, 'base64'), bytes);
    for (const invalidPath of [`payroll-originals/../${sha256}.zip`, `source-documents/${sha256}.zip`, `payroll-originals/nested/${sha256}.zip`]) {
      await assert.rejects(decodeCompleteBackup(await encodeCompleteBackup({ ...manifest, files: manifest.files.map(file => file === original ? { ...file, path: invalidPath } : file) })), /invalid or duplicate file/);
    }
    rmSync(join(fixture.directory, path));
    const preview = await fixture.service.preview(archive);
    await fixture.service.restore({ token: preview.token, expectedRevision: preview.expectedRevision, confirmation: true });
    assert.deepEqual(readFileSync(join(fixture.directory, path)), bytes);
    assert.equal(existsSync(join(fixture.directory, 'payroll-originals/payroll')), false);
  } finally { fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a journal cleanup failure rolls back records and cannot replay a successful restore receipt', async t => {
  const fixture = setup();
  const remove = rmSync;
  let restoreRemove: (() => void) | undefined;
  try {
    const store = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    const first = store.command({ type: 'add_reserve', entityId: 'personal', name: 'Saved reserve', amountCents: 12345 }); store.close();
    const archive = await fixture.service.exportArchive();
    const updated = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    updated.command({ type: 'update_reserve', id: first.reserves[0].id, expected: first.reserves[0], name: 'Saved reserve', amountCents: 54321, expectedRevision: first.revision, requestId: randomUUID() });
    const before = updated.state(); updated.close();
    const preview = await fixture.service.preview(archive);
    const request = { token: preview.token, expectedRevision: preview.expectedRevision, confirmation: true };
    let failed = false;
    const mock = t.mock.method(fs, 'rmSync', (path: Parameters<typeof rmSync>[0], options?: Parameters<typeof rmSync>[1]) => {
      if (!failed && String(path) === join(fixture.root, '.data.complete-restore.json')) {
        failed = true;
        throw Object.assign(new Error('Synthetic journal cleanup failure'), { code: 'EIO' });
      }
      remove(path, options);
    });
    restoreRemove = () => { mock.mock.restore(); syncBuiltinESMExports(); };
    syncBuiltinESMExports();
    await assert.rejects(fixture.service.restore(request), /Synthetic journal cleanup failure/);
    assert.equal(failed, true);
    restoreRemove(); restoreRemove = undefined;
    await assert.rejects(fixture.service.restore(request), (error: unknown) => error instanceof BackupError && error.status === 404 && /Verify the complete backup again/.test(error.message));
    const current = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    try { assert.deepEqual(current.state(), before); } finally { current.close(); }
    assert.equal(existsSync(join(fixture.root, '.data.complete-restore.json')), false);
    const fresh = await fixture.service.preview(archive);
    const confirmed = { token: fresh.token, expectedRevision: fresh.expectedRevision, confirmation: true };
    const result = await fixture.service.restore(confirmed);
    assert.equal(result.status, 'restored');
    assert.deepEqual(await fixture.service.restore(confirmed), result);
    const restored = createStore(join(fixture.directory, 'live.sqlite'), 'live');
    try { assert.equal(restored.state().reserves[0].amountCents, 12345); } finally { restored.close(); }
  } finally { restoreRemove?.(); fixture.service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a failed reopen rolls back the entire installation and interrupted swaps recover the previous folder', async () => {
  const fixture = setup();
  try {
    const archive = await fixture.service.exportArchive(); let attempts = 0;
    const failing = createCompleteBackupService(fixture.directory, { close: async () => {}, open: async () => { if (++attempts === 1) throw new Error('Synthetic reopen failure'); } });
    const preview = await failing.preview(archive);
    await assert.rejects(failing.restore({ token: preview.token, expectedRevision: 0, confirmation: true }), /reopen failure/);
    const store = createStore(join(fixture.directory, 'live.sqlite'), 'live'); assert.equal(store.state().revision, 0); store.close();
    const previous = join(fixture.root, `.mazal-before-${randomUUID()}`), stage = join(fixture.root, `.mazal-restore-${randomUUID()}`);
    const originalHash = createHash('sha256').update(readFileSync(join(fixture.directory, 'live.sqlite'))).digest('hex');
    renameSync(fixture.directory, previous); mkdirSync(fixture.directory);
    writeFileSync(join(fixture.root, '.data.complete-restore.json'), JSON.stringify({ version: 1, previous: basename(previous), stage: basename(stage) }));
    recoverCompleteRestore(fixture.directory);
    assert.equal(createHash('sha256').update(readFileSync(join(fixture.directory, 'live.sqlite'))).digest('hex'), originalHash);
    assert.ok(existsSync(stage), 'interrupted replacement is preserved');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
