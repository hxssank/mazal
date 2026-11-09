import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, RevisionConflictError, type StoredData } from './store.ts';
import { deferTestCleanup, trackTestResource, closeTestResource } from './test-cleanup.ts';

function setup(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-persistence-'));
  deferTestCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'live.sqlite');
  const store = trackTestResource(t, createStore(path, 'live'));
  return { directory, path, store };
}

function populated(t: { after: (cleanup: () => void) => void }) {
  const context = setup(t);
  const { store } = context;
  const card = store.command({ type: 'add_account', entityId: 'personal', name: 'Visa', accountType: 'debt', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const cash = store.command({ type: 'add_account', entityId: 'personal', name: 'Chequing', accountType: 'cash', openingBalanceCents: 20000, openingDate: '2026-01-01' }).accounts.find(account => account.name === 'Chequing')!.id;
  store.command({ type: 'import_statement', requestId: 'statement', statement: {
    id: 'january', accountId: card, sourceFile: 'January.pdf', sha256: '1'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 10900,
    rows: [
      { id: 'purchase', transactionDate: '2026-01-02', postingDate: '2026-01-03', description: 'Coffee 100% organic', amountCents: 1200, kind: 'purchase', category: 'Food', sourcePage: 2 },
      { id: 'refund', transactionDate: '2026-01-04', postingDate: '2026-01-05', description: 'Coffee refund', amountCents: -300, kind: 'refund', category: 'Food', sourcePage: 2 },
    ],
  } });
  store.command({ type: 'set_debt_terms', accountId: card, terms: { aprPercent: null, rateConfirmed: false, minimumPaymentCents: null, notes: 'Unknown terms', paymentDueDate: null } });
  store.command({ type: 'add_transaction', accountId: cash, toAccountId: card, date: '2026-02-01', amountCents: 500, kind: 'debt_payment', category: 'Payment', description: 'Card payment', requestId: 'payment' });
  return { ...context, card, cash };
}

function legacyDatabase(path: string, data: StoredData): void {
  const database = new DatabaseSync(path);
  try {
    database.exec('CREATE TABLE workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), workspace TEXT NOT NULL, document TEXT NOT NULL)');
    database.prepare('INSERT INTO workspace_state VALUES (1, ?, ?)').run('live', JSON.stringify(data));
  } finally { database.close(); }
}

for (const fault of ['revision', 'reserves', 'payrollImports', 'declared-collection', 'array-value', 'null-scalar', 'array-scalar'] as const) {
  test(`storage rejects ${fault} scalar metadata without rewriting saved records`, t => {
    const { store, path } = setup(t);
    store.command({ type: 'update_living_costs', monthlyEssentialsCents: 12345 });
    const before = store.state();
    closeTestResource(store);
    const database = trackTestResource(t, new DatabaseSync(path));
    const settings = JSON.parse((database.prepare('SELECT settings FROM workspace_meta WHERE id=1').get() as { settings: string }).settings);
    if (fault === 'null-scalar') settings.scalar = null;
    else if (fault === 'array-scalar') settings.scalar = [];
    else if (fault === 'declared-collection') { settings.presentCollections.push('extraRecords'); settings.scalar.extraRecords = {}; }
    else if (fault === 'array-value') settings.scalar.extraRecords = [];
    else settings.scalar[fault] = fault === 'revision' ? before.revision : null;
    database.prepare('UPDATE workspace_meta SET settings=? WHERE id=1').run(JSON.stringify(settings));
    const saved = database.prepare('SELECT revision, settings FROM workspace_meta WHERE id=1').get();
    const records = database.prepare('SELECT * FROM audit_events ORDER BY position').all();
    closeTestResource(database);
    assert.throws(() => trackTestResource(t, createStore(path, 'live')), /Storage .*settings/);
    const unchanged = trackTestResource(t, new DatabaseSync(path, { readOnly: true }));
    try {
      assert.deepEqual(unchanged.prepare('SELECT revision, settings FROM workspace_meta WHERE id=1').get(), saved);
      assert.deepEqual(unchanged.prepare('SELECT * FROM audit_events ORDER BY position').all(), records);
    } finally { closeTestResource(unchanged); }
  });
}

for (const fault of ['omitted-wishes', 'missing-wish-table', 'omitted-generic-records'] as const) {
  test(`storage rejects ${fault} before startup can hide saved records`, t => {
    const { store, path } = setup(t);
    store.command({ type: 'save_wish_item', item: { id: 'saved-wish', entityId: 'personal', name: 'Saved wish', costCents: 12345, comment: '' }, expected: null, requestId: 'saved-wish' });
    closeTestResource(store);
    const database = trackTestResource(t, new DatabaseSync(path));
    const settings = JSON.parse((database.prepare('SELECT settings FROM workspace_meta WHERE id=1').get() as { settings: string }).settings);
    if (fault === 'missing-wish-table') database.exec('DROP TABLE wish_items');
    else {
      const collection = fault === 'omitted-wishes' ? 'wishItems' : 'payrollImports';
      if (fault === 'omitted-generic-records') database.prepare('INSERT INTO collection_records(id,collection,position,data) VALUES(?,?,0,?)').run(JSON.stringify([collection, 'saved-import']), collection, JSON.stringify({ id: 'saved-import' }));
      settings.presentCollections = settings.presentCollections.filter((name: string) => name !== collection);
      database.prepare('UPDATE workspace_meta SET settings=? WHERE id=1').run(JSON.stringify(settings));
    }
    const snapshot = (db: DatabaseSync) => ({
      schema: db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(),
      metadata: db.prepare('SELECT * FROM workspace_meta').all(),
      wishes: fault === 'missing-wish-table' ? [] : db.prepare('SELECT * FROM wish_items').all(),
      extra: db.prepare('SELECT * FROM collection_records ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_events ORDER BY position').all(),
    });
    const before = snapshot(database);
    closeTestResource(database);
    assert.throws(() => trackTestResource(t, createStore(path, 'live')), /Storage .*collection/);
    const unchanged = trackTestResource(t, new DatabaseSync(path, { readOnly: true }));
    try { assert.deepEqual(snapshot(unchanged), before); } finally { closeTestResource(unchanged); }
  });
}

for (const missingTable of [false, true]) {
  test(`storage opens an undeclared empty optional collection with its table ${missingTable ? 'absent' : 'present'}`, t => {
    const { store, path } = setup(t);
    store.command({ type: 'add_reserve', entityId: 'personal', name: 'Keep reserve', amountCents: 12345 });
    const before = store.state();
    closeTestResource(store);
    const database = trackTestResource(t, new DatabaseSync(path));
    const settings = JSON.parse((database.prepare('SELECT settings FROM workspace_meta WHERE id=1').get() as { settings: string }).settings);
    settings.presentCollections = settings.presentCollections.filter((name: string) => name !== 'wishItems');
    database.prepare('UPDATE workspace_meta SET settings=? WHERE id=1').run(JSON.stringify(settings));
    if (missingTable) database.exec('DROP TABLE wish_items');
    closeTestResource(database);
    const reopened = trackTestResource(t, createStore(path, 'live'));
    try { assert.deepEqual(reopened.state(), before); } finally { closeTestResource(reopened); }
  });
}

test('storage refuses omitted collections changed by another connection before reading or exporting them', t => {
  const { store, path } = setup(t);
  store.command({ type: 'save_wish_item', item: { id: 'saved-wish', entityId: 'personal', name: 'Saved wish', costCents: 12345, comment: '' }, expected: null, requestId: 'saved-wish' });
  const database = trackTestResource(t, new DatabaseSync(path));
  const settings = JSON.parse((database.prepare('SELECT settings FROM workspace_meta WHERE id=1').get() as { settings: string }).settings);
  settings.presentCollections = settings.presentCollections.filter((name: string) => name !== 'wishItems');
  database.prepare('UPDATE workspace_meta SET settings=? WHERE id=1').run(JSON.stringify(settings));
  assert.throws(() => store.state(), /Storage .*collection metadata/);
  assert.throws(() => store.export(), /Storage .*collection metadata/);
  assert.equal((database.prepare('SELECT COUNT(*) AS count FROM wish_items').get() as { count: number }).count, 1);
});

test('current scalar settings preserve roadmap values and backup dates while the table owns revision', t => {
  const { store, path } = setup(t);
  store.command({ type: 'update_living_costs', monthlyEssentialsCents: 12345 });
  store.command({ type: 'update_pay_schedule', payAmountCents: 200000, payEveryDays: 14, paydayAnchor: '2026-10-01' });
  const saved = store.export();
  closeTestResource(store);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  assert.deepEqual(reopened.export().data.roadmap, saved.data.roadmap);
  assert.equal(reopened.state().revision, saved.data.revision);
  const database = trackTestResource(t, new DatabaseSync(path, { readOnly: true }));
  try {
    const row = database.prepare('SELECT revision, settings FROM workspace_meta WHERE id=1').get() as { revision: number; settings: string };
    const settings = JSON.parse(row.settings);
    assert.equal(Object.hasOwn(settings.scalar, 'revision'), false);
    assert.equal(settings.scalar.lastBackupAt, reopened.state().lastBackupAt);
    assert.equal(row.revision, reopened.state().revision);
    assert.ok(settings.presentCollections.includes('payrollImports'));
  } finally { closeTestResource(database); }
});

test('migration verifies every record and archives the old snapshot before removing its redundant table', t => {
  const { store, directory } = populated(t);
  const before = store.export();
  const state = store.state();
  const path = join(directory, 'legacy.sqlite');
  legacyDatabase(path, before.data);
  const migrated = trackTestResource(t, createStore(path, 'live'));
  assert.deepEqual(migrated.state(), state);
  const database = trackTestResource(t, new DatabaseSync(path, { readOnly: true }));
  assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workspace_state'").get(), undefined);
  const legacyFiles = readdirSync(join(directory, 'backups/live')).filter(name => name.includes('legacy-storage-archive'));
  assert.equal(legacyFiles.length, 1);
  const legacy = JSON.parse(readFileSync(join(directory, 'backups/live', legacyFiles[0]), 'utf8'));
  assert.deepEqual(legacy.rows, [{ id: 1, workspace: 'live', document: JSON.stringify(before.data) }]);
  assert.equal((database.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, before.data.transactions.length);
  assert.equal((database.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n, before.data.entries.length);
  assert.equal((database.prepare('SELECT COUNT(*) AS n FROM statement_rows').get() as { n: number }).n, 2);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  const backups = readdirSync(join(directory, 'backups/live')).filter(name => name.includes('before-relational-migration'));
  assert.equal(backups.length, 1);
  const archive = JSON.parse(readFileSync(join(directory, 'backups/live', backups[0]), 'utf8'));
  assert.deepEqual(archive.data, before.data);
  const exported = migrated.export();
  assert.deepEqual({ ...exported.data, lastBackupAt: before.data.lastBackupAt }, before.data);
  const recovered = trackTestResource(t, createStore(join(directory, 'recovered.sqlite'), 'live'));
  const recovery = recovered.restore(archive);
  assert.deepEqual(recovery.accounts, state.accounts);
  assert.deepEqual(recovery.transactions, state.transactions);
  assert.deepEqual(recovery.statements, state.statements);
});

test('invalid migration rolls back every new table and leaves the original document unchanged', t => {
  const { store, directory } = populated(t);
  const invalid = store.export().data;
  invalid.entries[0].debitCents++;
  const path = join(directory, 'invalid.sqlite');
  legacyDatabase(path, invalid);
  assert.throws(() => trackTestResource(t, createStore(path, 'live')), /journal transaction does not balance/);
  const database = trackTestResource(t, new DatabaseSync(path));
  assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workspace_meta'").get(), undefined);
  assert.equal((database.prepare('SELECT document FROM workspace_state').get() as { document: string }).document, JSON.stringify(invalid));
  assert.equal(readdirSync(join(directory, 'backups/live')).filter(name => name.includes('before-relational-migration')).length, 0);
});

test('normalized records remain authoritative after migration and reopening', t => {
  const { store, directory } = populated(t);
  const backup = store.export();
  const path = join(directory, 'legacy.sqlite');
  legacyDatabase(path, backup.data);
  const migrated = trackTestResource(t, createStore(path, 'live'));
  const newState = migrated.command({ type: 'add_reserve', entityId: 'personal', name: 'Buffer', amountCents: 1000 });
  closeTestResource(migrated);
  const database = trackTestResource(t, new DatabaseSync(path));
  database.exec('CREATE TABLE workspace_state (id INTEGER PRIMARY KEY CHECK(id=1), workspace TEXT NOT NULL, document TEXT NOT NULL)');
  database.prepare('INSERT INTO workspace_state VALUES (1, ?, ?)').run('live', '{}');
  closeTestResource(database);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  assert.deepEqual(reopened.state(), newState);
  assert.equal(readdirSync(join(directory, 'backups/live')).filter(name => name.includes('before-relational-migration')).length, 2);
  const archiveFiles = readdirSync(join(directory, 'backups/live')).filter(name => name.includes('legacy-storage-archive'));
  assert.equal(archiveFiles.length, 2);
  assert.ok(archiveFiles.some(name => JSON.parse(readFileSync(join(directory, 'backups/live', name), 'utf8')).rows[0].document === '{}'));
  const current = trackTestResource(t, new DatabaseSync(path, { readOnly: true }));
  try { assert.equal(current.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workspace_state'").get(), undefined); }
  finally { closeTestResource(current); }
});

test('legacy cleanup leaves both databases intact when recovery files cannot be saved', t => {
  const { store, directory, path } = populated(t);
  const before = store.export();
  closeTestResource(store);
  legacyDatabase(path, before.data);
  const backupDirectory = join(directory, 'backups/live');
  rmSync(backupDirectory, { recursive: true });
  writeFileSync(backupDirectory, 'A file blocks this recovery directory.');
  assert.throws(() => trackTestResource(t, createStore(path, 'live')));
  const database = trackTestResource(t, new DatabaseSync(path, { readOnly: true }));
  try {
    assert.equal((database.prepare('SELECT document FROM workspace_state').get() as { document: string }).document, JSON.stringify(before.data));
    assert.equal((database.prepare('SELECT revision FROM workspace_meta').get() as { revision: number }).revision, before.data.revision);
    assert.equal((database.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, before.data.transactions.length);
    assert.deepEqual(database.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
  } finally { closeTestResource(database); }
});

test('a category correction updates only that transaction and statement row, with no journal or account rewrites', t => {
  const { store, path } = populated(t);
  const transaction = store.state().transactions.find(row => row.statementRowId === 'purchase')!;
  const database = trackTestResource(t, new DatabaseSync(path));
  database.exec('CREATE TABLE observed_changes (table_name TEXT NOT NULL, record_id TEXT NOT NULL)');
  for (const table of ['entities', 'accounts', 'transactions', 'journal_entries', 'statements', 'statement_rows']) {
    database.exec(`CREATE TRIGGER observe_${table} AFTER UPDATE ON ${table} BEGIN INSERT INTO observed_changes VALUES ('${table}', NEW.id); END`);
  }
  const command = { type: 'categorize_transaction', id: transaction.id, expectedCategory: 'Food', category: 'Coffee', requestId: 'category' } as const;
  const state = store.command(command);
  assert.deepEqual(database.prepare('SELECT table_name, record_id FROM observed_changes ORDER BY table_name').all().map(row => ({ ...row })), [
    { table_name: 'statement_rows', record_id: 'purchase' },
    { table_name: 'transactions', record_id: transaction.id },
  ]);
  database.exec('DELETE FROM observed_changes');
  assert.deepEqual(store.command(command), state);
  assert.equal(database.prepare('SELECT * FROM observed_changes').all().length, 0);
  assert.throws(() => database.prepare('UPDATE transactions SET amount_cents = amount_cents + 1 WHERE id = ?').run(transaction.id), /CHECK constraint/);
});

test('two connections reject stale writes and restore without losing the newer records', t => {
  const { store, path } = populated(t);
  const second = trackTestResource(t, createStore(path, 'live'));
  const backup = store.export();
  const expectedRevision = second.state().revision;
  const state = store.command({ type: 'add_reserve', entityId: 'personal', name: 'Buffer', amountCents: 1000, expectedRevision });
  assert.throws(() => second.command({ type: 'add_reserve', entityId: 'personal', name: 'Stale', amountCents: 100, expectedRevision }), RevisionConflictError);
  assert.throws(() => second.restore(backup, expectedRevision), RevisionConflictError);
  assert.deepEqual(second.state(), state);
  const restored = second.restore(backup, state.revision);
  assert.equal(restored.revision, state.revision + 1);
  assert.deepEqual(store.state(), restored);
  assert.deepEqual(restored.accounts, state.accounts);
});

test('SQL transaction pages filter both transfer accounts, preserve signed refunds and return stable totals', t => {
  const { store, card, cash } = populated(t);
  const page = store.transactions({ kind: 'expense', from: '2026-01-01', to: '2026-01-31', limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.amountCents, 900);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].amountCents, -300);
  assert.equal(page.revision, store.state().revision);
  assert.equal(store.transactions({ kind: 'expense', limit: 1, offset: 1 }).rows[0].amountCents, 1200);
  assert.equal(store.transactions({ accountId: card, kind: 'debt_payment' }).total, 1);
  assert.equal(store.transactions({ accountId: cash, kind: 'debt_payment' }).total, 1);
  assert.equal(store.transactions({ search: '100%' }).total, 1);
  assert.equal(store.transactions({ search: '%' }).total, 1);
  assert.equal(store.transactions({ search: "' OR 1=1 --" }).total, 0);
  assert.equal(store.transactions({ entityId: 'personal', category: 'Food' }).total, 2);
  assert.throws(() => store.transactions({ limit: 501 }), /page size/);
  assert.throws(() => store.transactions({ offset: -1 }), /page size/);
  assert.throws(() => store.transactions({ from: '2026-02-30' }), /valid YYYY-MM-DD/);
  assert.throws(() => store.transactions({ from: '2026-02-01', to: '2026-01-01' }), /start date/);
});

test('review decisions persist separately from unchanged source rows and survive backup restoration', t => {
  const { store, path } = setup(t);
  const accountId = store.command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const source = {
    id: 'bank-january', accountId, sourceFile: 'bank.pdf', sha256: '2'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 8800,
    rows: [{ id: 'coffee', transactionDate: '2026-01-02', postingDate: '2026-01-03', description: 'COFFEE ORIGINAL TEXT', amountCents: -1200, sourcePage: 3 }],
  };
  const staged = store.command({ type: 'stage_statement', statement: source, requestId: 'stage' });
  const database = trackTestResource(t, new DatabaseSync(path));
  database.exec("CREATE TABLE source_updates (id TEXT); CREATE TRIGGER observe_source_update AFTER UPDATE ON import_source_rows BEGIN INSERT INTO source_updates VALUES (NEW.id); END;");
  const state = store.command({ type: 'review_statement', importId: source.id, decisions: [{ rowId: 'coffee', kind: 'expense', category: 'Coffee' }], expectedRevision: staged.revision, requestId: 'review' });
  assert.deepEqual(state.importBatches![0].source, source);
  assert.equal(database.prepare('SELECT * FROM source_updates').all().length, 0);
  assert.equal((database.prepare('SELECT COUNT(*) AS n FROM import_decisions').get() as { n: number }).n, 1);
  assert.equal((database.prepare('SELECT COUNT(*) AS n FROM import_source_rows').get() as { n: number }).n, 1);
  const backup = store.export();
  store.command({ type: 'commit_statements', importIds: [source.id], expectedRevision: state.revision, requestId: 'commit' });
  assert.equal((database.prepare('SELECT COUNT(*) AS n FROM transaction_import_sources').get() as { n: number }).n, 1);
  store.restore(backup);
  assert.equal((database.prepare('SELECT COUNT(*) AS n FROM transaction_import_sources').get() as { n: number }).n, 0);
  assert.deepEqual(store.state().importBatches, state.importBatches);
  assert.equal(database.prepare('SELECT * FROM source_updates').all().length, 0);
});

test('statement row identity is scoped to its source, including after categorization and restoration', t => {
  const { store, card } = populated(t);
  const january = store.state().statements![0];
  store.command({ type: 'import_statement', requestId: 'february', statement: {
    id: 'february', accountId: card, sourceFile: 'February.pdf', sha256: '3'.repeat(64), periodStart: '2026-02-02', periodEnd: '2026-02-28', openingBalanceCents: 10400, closingBalanceCents: 11100,
    rows: [{ ...january.rows[0], transactionDate: '2026-02-02', postingDate: '2026-02-03', description: 'Different source same row ID', amountCents: 700 }],
  } });
  const transaction = store.state().transactions.find(tx => tx.statementId === 'february')!;
  store.command({ type: 'categorize_transaction', id: transaction.id, expectedCategory: 'Food', category: 'Household', requestId: 'february-category' });
  const backup = store.export();
  store.restore(backup);
  const statements = store.state().statements!;
  assert.equal(statements[0].rows[0].category, 'Food');
  assert.equal(statements[1].rows[0].category, 'Household');
  assert.equal(statements[0].rows[0].id, statements[1].rows[0].id);
});

test('strict persisted fields reject invalid SQL types and startup validation rejects malformed records', t => {
  const { store, path } = populated(t);
  const database = trackTestResource(t, new DatabaseSync(path));
  database.exec('PRAGMA foreign_keys = ON');
  const id = store.state().transactions.find(tx => tx.statementRowId === 'purchase')!.id;
  assert.throws(() => database.prepare("UPDATE transactions SET amount_cents = 'not cents' WHERE id = ?").run(id), /cannot store TEXT/);
  assert.throws(() => database.prepare("UPDATE transactions SET account_id = 'missing', data = json_set(data, '$.accountId', 'missing') WHERE id = ?").run(id), /FOREIGN KEY constraint/);
  const backup = store.export();
  const invalid = structuredClone(backup);
  (invalid.data.transactions[0] as unknown as Record<string, unknown>).amountCents = '1200';
  const before = store.state();
  assert.throws(() => store.restore(invalid), /whole number/);
  assert.deepEqual(store.state(), before);
  closeTestResource(store);
  database.prepare("UPDATE transactions SET created_at = 'invalid date', data = json_set(data, '$.createdAt', 'invalid date') WHERE id = ?").run(id);
  closeTestResource(database);
  assert.throws(() => trackTestResource(t, createStore(path, 'live')), /valid ISO timestamp/);
});
