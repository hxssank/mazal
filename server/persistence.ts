import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StatementBatch, Transaction, TransactionKind, Workspace } from '../shared/types.ts';
import type { StoredData } from './store.ts';

interface Column { name: string; field: string; sql: string; nullable?: boolean }
interface Collection { key: string; table: string; columns?: Column[]; constraints?: string[]; keyField?: string; scalar?: boolean }
interface SavedRow { id: string; position: number; data: string; value: Record<string, unknown> }
const reference = (table: string) => `REFERENCES ${table}(id) DEFERRABLE INITIALLY DEFERRED`;
const owner: Column = { name: 'entity_id', field: 'entityId', sql: `TEXT NOT NULL ${reference('entities')}` };
const account: Column = { name: 'account_id', field: 'accountId', sql: `TEXT NOT NULL ${reference('accounts')}` };
const collections: Collection[] = [
  { key: 'entities', table: 'entities', columns: [{ name: 'name', field: 'name', sql: 'TEXT NOT NULL' }, { name: 'kind', field: 'kind', sql: "TEXT NOT NULL CHECK(kind IN ('personal', 'business'))" }, { name: 'ownership_bps', field: 'ownershipBps', sql: 'INTEGER NOT NULL CHECK(ownership_bps BETWEEN 0 AND 10000)' }] },
  { key: 'accounts', table: 'accounts', columns: [owner, { name: 'name', field: 'name', sql: 'TEXT NOT NULL' }, { name: 'type', field: 'type', sql: 'TEXT NOT NULL' }, { name: 'currency', field: 'currency', sql: "TEXT NOT NULL CHECK(currency = 'CAD')" }, { name: 'reconciled_at', field: 'reconciledAt', sql: 'TEXT', nullable: true }] },
  { key: 'statements', table: 'statements', columns: [account, { name: 'source_sha256', field: 'sha256', sql: 'TEXT NOT NULL CHECK(length(source_sha256) = 64)' }, { name: 'period_start', field: 'periodStart', sql: 'TEXT NOT NULL' }, { name: 'period_end', field: 'periodEnd', sql: 'TEXT NOT NULL' }, { name: 'opening_balance_cents', field: 'openingBalanceCents', sql: 'INTEGER NOT NULL' }, { name: 'closing_balance_cents', field: 'closingBalanceCents', sql: 'INTEGER NOT NULL' }], constraints: ['UNIQUE(account_id, source_sha256)', 'CHECK(period_start <= period_end)'] },
  { key: 'transactions', table: 'transactions', columns: [account, { name: 'to_account_id', field: 'toAccountId', sql: `TEXT ${reference('accounts')}`, nullable: true }, { name: 'date', field: 'date', sql: 'TEXT NOT NULL' }, { name: 'created_at', field: 'createdAt', sql: 'TEXT NOT NULL' }, { name: 'kind', field: 'kind', sql: 'TEXT NOT NULL' }, { name: 'category', field: 'category', sql: 'TEXT NOT NULL' }, { name: 'description', field: 'description', sql: 'TEXT NOT NULL' }, { name: 'amount_cents', field: 'amountCents', sql: 'INTEGER NOT NULL' }, { name: 'statement_id', field: 'statementId', sql: 'TEXT', nullable: true }, { name: 'statement_row_id', field: 'statementRowId', sql: 'TEXT', nullable: true }], constraints: ['FOREIGN KEY(statement_id, statement_row_id) REFERENCES statement_rows(statement_id, id) DEFERRABLE INITIALLY DEFERRED', 'UNIQUE(statement_id, statement_row_id)', 'CHECK((statement_id IS NULL) = (statement_row_id IS NULL))'] },
  { key: 'entries', table: 'journal_entries', columns: [account, { name: 'transaction_id', field: 'transactionId', sql: `TEXT NOT NULL ${reference('transactions')}` }, { name: 'debit_cents', field: 'debitCents', sql: 'INTEGER NOT NULL' }] },
  { key: 'obligations', table: 'obligations', columns: [owner, { name: 'due_date', field: 'dueDate', sql: 'TEXT NOT NULL' }, { name: 'status', field: 'status', sql: 'TEXT NOT NULL' }] },
  { key: 'reserves', table: 'reserves', columns: [owner] },
  { key: 'positions', table: 'positions', columns: [account] },
  { key: 'audit', table: 'audit_events', columns: [{ name: 'date', field: 'date', sql: 'TEXT NOT NULL' }, { name: 'action', field: 'action', sql: 'TEXT NOT NULL' }] },
  { key: 'requests', table: 'request_log', columns: [{ name: 'digest', field: 'digest', sql: 'TEXT NOT NULL' }] },
  { key: 'importKeys', table: 'import_keys', scalar: true },
  { key: 'originalImports', table: 'original_imports' },
  { key: 'spendingLimits', table: 'spending_limits', columns: [owner] },
  { key: 'categoryRules', table: 'category_rules', columns: [owner] },
  { key: 'assets', table: 'assets', columns: [owner] },
  { key: 'expenseFunds', table: 'expense_funds', columns: [owner] },
  { key: 'expensePlanItems', table: 'expense_plan_items', columns: [owner] },
  { key: 'assetPurchases', table: 'asset_purchases', columns: [owner] },
  { key: 'wishItems', table: 'wish_items', columns: [owner] },
  { key: 'moneyOwed', table: 'money_owed', columns: [owner] },
  { key: 'sourceFacts', table: 'source_facts' },
  { key: 'cashPostings', table: 'cash_postings', keyField: 'transactionId', columns: [account, { name: 'transaction_id', field: 'transactionId', sql: `TEXT NOT NULL ${reference('transactions')}` }] },
  { key: 'importBatches', table: 'import_batches', columns: [{ name: 'account_id', field: 'source.accountId', sql: `TEXT NOT NULL ${reference('accounts')}` }, { name: 'source_sha256', field: 'source.sha256', sql: 'TEXT NOT NULL CHECK(length(source_sha256) = 64)' }, { name: 'period_start', field: 'source.periodStart', sql: 'TEXT NOT NULL' }, { name: 'period_end', field: 'source.periodEnd', sql: 'TEXT NOT NULL' }, { name: 'status', field: 'status', sql: "TEXT NOT NULL CHECK(status IN ('staged', 'committed'))" }, { name: 'created_at', field: 'createdAt', sql: 'TEXT NOT NULL' }], constraints: ['UNIQUE(account_id, source_sha256)', 'CHECK(period_start <= period_end)'] },
];
const collectionKeys = new Set(collections.map(collection => collection.key));
export const storageCollectionTables: Record<string, string> = Object.fromEntries(collections.map(collection => [collection.key, collection.table]));
const reservedScalarKeys = new Set([...collectionKeys, 'payrollImports', 'revision']);

export function readStorageSettings(serialized: string): { scalar: Record<string, unknown>; presentCollections: string[] } {
  const settings: unknown = JSON.parse(serialized);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Storage has invalid settings metadata.');
  const { scalar, presentCollections } = settings as Record<string, unknown>;
  if (!scalar || typeof scalar !== 'object' || Array.isArray(scalar) || !Array.isArray(presentCollections) || presentCollections.some(name => typeof name !== 'string')) throw new Error('Storage has invalid settings metadata.');
  if (Object.entries(scalar).some(([key, value]) => reservedScalarKeys.has(key) || presentCollections.includes(key) || Array.isArray(value))) throw new Error('Storage scalar settings cannot contain revisions or record collections.');
  return { scalar: scalar as Record<string, unknown>, presentCollections };
}

export function validateStorageCollections(database: DatabaseSync, names: string[]): void {
  const tables = new Set((database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]).map(table => table.name));
  const requireTables = (required: string[]) => {
    if (required.some(name => !tables.has(name))) throw new Error('Storage is missing a declared collection table. Existing records were kept for inspection.');
  };
  requireTables(names.map(name => Object.hasOwn(storageCollectionTables, name) ? storageCollectionTables[name] : 'collection_records'));
  for (const { key, table } of collections) {
    if (!names.includes(key) && tables.has(table) && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error('Storage has saved records missing from its collection metadata. Existing records were kept for inspection.');
  }
  if (tables.has('collection_records')) {
    const extra = database.prepare('SELECT DISTINCT collection FROM collection_records').all() as { collection: string }[];
    if (extra.some(row => !names.includes(row.collection))) throw new Error('Storage has saved records missing from its collection metadata. Existing records were kept for inspection.');
  }
  if (names.includes('statements')) requireTables(['statement_rows']);
  if (names.includes('importBatches')) requireTables(['import_source_rows', 'import_decisions', 'transaction_import_sources']);
}

export interface TransactionQuery { accountId?: string; entityId?: string; kind?: TransactionKind; category?: string; from?: string; to?: string; search?: string; limit?: number; offset?: number }
export interface TransactionPage { revision: number; rows: Transaction[]; total: number; amountCents: number; limit: number; offset: number }

function fieldValue(value: Record<string, unknown>, field: string): SQLInputValue {
  let result: unknown = value;
  for (const part of field.split('.')) result = (result as Record<string, unknown> | undefined)?.[part];
  return (result ?? null) as SQLInputValue;
}

function rows(data: StoredData | undefined, collection: Collection): SavedRow[] {
  const items = (data as unknown as Record<string, unknown> | undefined)?.[collection.key] as unknown[] | undefined;
  return (items ?? []).map((item, position) => {
    const value = collection.scalar ? { value: item } : item as Record<string, unknown>;
    const id = String(collection.scalar ? item : value[collection.keyField ?? 'id'] ?? position);
    let payload = collection.key === 'statements' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'rows')) : value;
    if (collection.key === 'importBatches') {
      const { decisions: _decisions, source, ...header } = value;
      const { rows: _rows, ...sourceHeader } = source as Record<string, unknown>;
      payload = { ...header, source: sourceHeader };
    }
    return { id, position, value: payload, data: JSON.stringify(payload) };
  });
}

function metadata(data: StoredData): string {
  const scalar: Record<string, unknown> = {};
  const presentCollections: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'revision') continue;
    if (Array.isArray(value)) presentCollections.push(key);
    else scalar[key] = value;
  }
  return JSON.stringify({ scalar, presentCollections });
}

function extraRows(data: StoredData | undefined): SavedRow[] {
  const result: SavedRow[] = [];
  for (const [collection, items] of Object.entries(data ?? {})) {
    if (!Array.isArray(items) || collectionKeys.has(collection)) continue;
    items.forEach((value: unknown, position: number) => {
      const key = value && typeof value === 'object' && 'id' in value ? value.id : position;
      result.push({ id: JSON.stringify([collection, key]), position, data: JSON.stringify(value), value: { collection } });
    });
  }
  return result;
}

function statementRows(data: StoredData | undefined): SavedRow[] {
  return (data?.statements ?? []).flatMap(statement => statement.rows.map((row, position) => ({ id: JSON.stringify([statement.id, row.id]), position, data: JSON.stringify(row), value: { ...row, statementId: statement.id } })));
}

function importRows(data: StoredData | undefined, decisions = false): SavedRow[] {
  const batches = (data as StoredData & { importBatches?: StatementBatch[] } | undefined)?.importBatches ?? [];
  return batches.flatMap(batch => (decisions ? batch.decisions : batch.source.rows).map((value, position) => {
    const rowId = 'rowId' in value ? value.rowId : value.id;
    return { id: JSON.stringify([batch.id, rowId]), position, data: JSON.stringify(value), value: { batchId: batch.id, rowId, accountId: batch.source.accountId, ...value } };
  }));
}

function importLinks(data: StoredData | undefined): SavedRow[] {
  return (data?.transactions ?? []).flatMap(transaction => (transaction.importSources ?? []).map((source, position) => ({ id: JSON.stringify([source.importId, source.rowId]), position, data: JSON.stringify({ transactionId: transaction.id, ...source }), value: { transactionId: transaction.id, ...source } })));
}

function changes(before: SavedRow[], after: SavedRow[], remove: (row: SavedRow) => void, upsert: (row: SavedRow) => void): void {
  const previous = new Map(before.map(row => [row.id, row]));
  const next = new Map(after.map(row => [row.id, row]));
  for (const row of before) if (!next.has(row.id)) remove(row);
  for (const row of after) {
    const old = previous.get(row.id);
    if (!old || old.position !== row.position || old.data !== row.data) upsert(row);
  }
}

export function createPersistence(database: DatabaseSync, workspace: Workspace, initialize: () => StoredData, validate: (data: unknown) => StoredData, saveMigrationBackup: (data: StoredData) => string, saveLegacyArchive: (rows: Record<string, unknown>[]) => string) {
  database.exec('PRAGMA foreign_keys=ON');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS workspace_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1), workspace TEXT NOT NULL CHECK(workspace IN ('live', 'demo')),
      schema_version INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), settings TEXT NOT NULL CHECK(json_valid(settings))
    ) STRICT;`);
    const existing = database.prepare('SELECT workspace, schema_version, settings FROM workspace_meta WHERE id = 1').get() as { workspace: string; schema_version: number; settings: string } | undefined;
    if (existing && existing.workspace !== workspace) throw new Error('Database belongs to a different workspace.');
    if (existing && existing.schema_version !== 2) throw new Error('This database uses an unsupported storage version.');
    if (existing) validateStorageCollections(database, readStorageSettings(existing.settings).presentCollections);
    for (const collection of collections) {
      const columns = collection.columns ?? [];
      database.exec(`CREATE TABLE IF NOT EXISTS ${collection.table} (
        id TEXT PRIMARY KEY NOT NULL, position INTEGER NOT NULL CHECK(position >= 0), data TEXT NOT NULL CHECK(json_valid(data))
        ${columns.map(column => `, ${column.name} ${column.sql}`).join('')}
        ${columns.map(column => `, CHECK(${column.name} IS json_extract(data, '$.${column.field}'))`).join('')}
        ${collection.key === 'originalImports' ? '' : `, CHECK(id IS json_extract(data, '$.${collection.scalar ? 'value' : collection.keyField ?? 'id'}'))`}
        ${(collection.constraints ?? []).map(constraint => `, ${constraint}`).join('')}
      ) STRICT;`);
    }
    database.exec(`CREATE TABLE IF NOT EXISTS statement_rows (
      statement_id TEXT NOT NULL REFERENCES statements(id) DEFERRABLE INITIALLY DEFERRED,
      id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0),
      transaction_date TEXT NOT NULL, posting_date TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      kind TEXT NOT NULL, source_page INTEGER NOT NULL CHECK(source_page > 0), data TEXT NOT NULL CHECK(json_valid(data)),
      PRIMARY KEY(statement_id, id), CHECK(id IS json_extract(data, '$.id')),
      CHECK(transaction_date IS json_extract(data, '$.transactionDate')), CHECK(posting_date IS json_extract(data, '$.postingDate')),
      CHECK(amount_cents IS json_extract(data, '$.amountCents')), CHECK(kind IS json_extract(data, '$.kind')),
      CHECK(source_page IS json_extract(data, '$.sourcePage'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collection_records (id TEXT PRIMARY KEY NOT NULL, collection TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0), data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
    CREATE TABLE IF NOT EXISTS import_source_rows (
      batch_id TEXT NOT NULL REFERENCES import_batches(id) DEFERRABLE INITIALLY DEFERRED,
      id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED,
      position INTEGER NOT NULL CHECK(position >= 0), transaction_date TEXT NOT NULL, posting_date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, source_page INTEGER NOT NULL CHECK(source_page > 0), data TEXT NOT NULL CHECK(json_valid(data)),
      PRIMARY KEY(batch_id, id), CHECK(id IS json_extract(data, '$.id')),
      CHECK(transaction_date IS json_extract(data, '$.transactionDate')), CHECK(posting_date IS json_extract(data, '$.postingDate')),
      CHECK(amount_cents IS json_extract(data, '$.amountCents')), CHECK(source_page IS json_extract(data, '$.sourcePage'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS import_decisions (
      batch_id TEXT NOT NULL, row_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0),
      kind TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(batch_id, row_id),
      FOREIGN KEY(batch_id, row_id) REFERENCES import_source_rows(batch_id, id) DEFERRABLE INITIALLY DEFERRED,
      CHECK(row_id IS json_extract(data, '$.rowId')), CHECK(kind IS json_extract(data, '$.kind'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS transaction_import_sources (
      batch_id TEXT NOT NULL, row_id TEXT NOT NULL, transaction_id TEXT NOT NULL REFERENCES transactions(id) DEFERRABLE INITIALLY DEFERRED,
      position INTEGER NOT NULL CHECK(position >= 0), PRIMARY KEY(batch_id, row_id),
      FOREIGN KEY(batch_id, row_id) REFERENCES import_source_rows(batch_id, id) DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
    CREATE INDEX IF NOT EXISTS transactions_date ON transactions(date DESC, created_at DESC, position ASC);
    CREATE INDEX IF NOT EXISTS transactions_account_date ON transactions(account_id, date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS transactions_destination_date ON transactions(to_account_id, date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS transactions_kind_date ON transactions(kind, date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS transactions_category_date ON transactions(category, date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS accounts_entity ON accounts(entity_id);
    CREATE INDEX IF NOT EXISTS journal_entries_account ON journal_entries(account_id);
    CREATE INDEX IF NOT EXISTS journal_entries_transaction ON journal_entries(transaction_id);
    CREATE INDEX IF NOT EXISTS statements_account_period ON statements(account_id, period_start, period_end);
    CREATE INDEX IF NOT EXISTS statement_rows_posting_date ON statement_rows(posting_date);
    CREATE INDEX IF NOT EXISTS obligations_due_date ON obligations(status, due_date);
    CREATE INDEX IF NOT EXISTS audit_events_date ON audit_events(date);
    CREATE INDEX IF NOT EXISTS import_batches_account_period ON import_batches(account_id, period_start, period_end);
    CREATE INDEX IF NOT EXISTS import_source_rows_account_date ON import_source_rows(account_id, posting_date);
    CREATE INDEX IF NOT EXISTS transaction_import_sources_transaction ON transaction_import_sources(transaction_id);
    CREATE INDEX IF NOT EXISTS collection_records_collection ON collection_records(collection, position);`);
    const hasLegacy = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_state'").get();
    if (!existing) {
      const legacy = hasLegacy ? database.prepare('SELECT workspace, document FROM workspace_state WHERE id = 1').get() as { workspace: string; document: string } | undefined : undefined;
      if (legacy && legacy.workspace !== workspace) throw new Error('Database belongs to a different workspace.');
      const raw = legacy ? JSON.parse(legacy.document) as StoredData : initialize();
      const canonical = validate(raw);
      if (legacy) saveMigrationBackup(raw);
      save(canonical);
      const migrated = load();
      if (!isDeepStrictEqual(canonical, migrated) || !isDeepStrictEqual(canonical, validate(migrated))) throw new Error('Storage migration verification failed.');
    } else validate(load());
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('Storage contains broken references.');
    if (hasLegacy) {
      if (existing) saveMigrationBackup(load());
      saveLegacyArchive(database.prepare('SELECT * FROM workspace_state').all());
      database.exec('DROP TABLE workspace_state');
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  function load(): StoredData {
    const meta = database.prepare('SELECT revision, settings FROM workspace_meta WHERE id = 1').get() as { revision: number; settings: string };
    const { scalar, presentCollections } = readStorageSettings(meta.settings);
    validateStorageCollections(database, presentCollections);
    const data: Record<string, unknown> = { ...scalar, revision: meta.revision };
    for (const collection of collections) {
      if (!presentCollections.includes(collection.key)) continue;
      data[collection.key] = (database.prepare(`SELECT data FROM ${collection.table} ORDER BY position`).all() as { data: string }[]).map(row => {
        const value = JSON.parse(row.data) as Record<string, unknown>;
        return collection.scalar ? value.value : value;
      });
    }
    const statementMap = new Map((data.statements as StoredData['statements'] ?? []).map(statement => { statement.rows = []; return [statement.id, statement]; }));
    for (const row of database.prepare('SELECT statement_id, data FROM statement_rows ORDER BY statement_id, position').all() as { statement_id: string; data: string }[]) statementMap.get(row.statement_id)!.rows.push(JSON.parse(row.data));
    const batchMap = new Map((data.importBatches as StatementBatch[] ?? []).map(batch => { batch.source.rows = []; batch.decisions = []; return [batch.id, batch]; }));
    for (const row of database.prepare('SELECT batch_id, data FROM import_source_rows ORDER BY batch_id, position').all() as { batch_id: string; data: string }[]) batchMap.get(row.batch_id)!.source.rows.push(JSON.parse(row.data));
    for (const row of database.prepare('SELECT batch_id, data FROM import_decisions ORDER BY batch_id, position').all() as { batch_id: string; data: string }[]) batchMap.get(row.batch_id)!.decisions.push(JSON.parse(row.data));
    for (const key of presentCollections) if (!collectionKeys.has(key)) data[key] = [];
    for (const row of database.prepare('SELECT collection, data FROM collection_records ORDER BY collection, position').all() as { collection: string; data: string }[]) (data[row.collection] as unknown[]).push(JSON.parse(row.data));
    return data as unknown as StoredData;
  }

  function save(data: StoredData, before?: StoredData): void {
    for (const collection of collections) {
      const key = collection.key as keyof StoredData;
      if (before && before[key] === data[key]) continue;
      const columns = collection.columns ?? [];
      const names = ['id', 'position', 'data', ...columns.map(column => column.name)];
      const remove = database.prepare(`DELETE FROM ${collection.table} WHERE id = ?`);
      const upsert = database.prepare(`INSERT INTO ${collection.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT(id) DO UPDATE SET ${names.slice(1).map(name => `${name} = excluded.${name}`).join(', ')}`);
      changes(rows(before, collection), rows(data, collection), row => { remove.run(row.id); }, row => { upsert.run(row.id, row.position, row.data, ...columns.map(column => fieldValue(row.value, column.field))); });
    }
    if (!before || before.statements !== data.statements) {
    const removeStatementRow = database.prepare('DELETE FROM statement_rows WHERE statement_id = ? AND id = ?');
    const upsertStatementRow = database.prepare(`INSERT INTO statement_rows (statement_id, id, position, transaction_date, posting_date, amount_cents, kind, source_page, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(statement_id, id) DO UPDATE SET position = excluded.position, transaction_date = excluded.transaction_date, posting_date = excluded.posting_date, amount_cents = excluded.amount_cents, kind = excluded.kind, source_page = excluded.source_page, data = excluded.data`);
    changes(statementRows(before), statementRows(data), row => { removeStatementRow.run(row.value.statementId as string, row.value.id as string); }, row => {
      const value = row.value;
      upsertStatementRow.run(value.statementId as string, value.id as string, row.position, value.transactionDate as string, value.postingDate as string, value.amountCents as number, value.kind as string, value.sourcePage as number, row.data);
    });
    }
    if (!before || before.importBatches !== data.importBatches) {
    const removeImportRow = database.prepare('DELETE FROM import_source_rows WHERE batch_id = ? AND id = ?');
    const upsertImportRow = database.prepare('INSERT INTO import_source_rows (batch_id, id, account_id, position, transaction_date, posting_date, amount_cents, source_page, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(batch_id, id) DO UPDATE SET account_id = excluded.account_id, position = excluded.position, transaction_date = excluded.transaction_date, posting_date = excluded.posting_date, amount_cents = excluded.amount_cents, source_page = excluded.source_page, data = excluded.data');
    changes(importRows(before), importRows(data), row => { removeImportRow.run(row.value.batchId as string, row.value.rowId as string); }, row => {
      const value = row.value;
      upsertImportRow.run(value.batchId as string, value.rowId as string, value.accountId as string, row.position, value.transactionDate as string, value.postingDate as string, value.amountCents as number, value.sourcePage as number, row.data);
    });
    const removeDecision = database.prepare('DELETE FROM import_decisions WHERE batch_id = ? AND row_id = ?');
    const upsertDecision = database.prepare('INSERT INTO import_decisions (batch_id, row_id, position, kind, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(batch_id, row_id) DO UPDATE SET position = excluded.position, kind = excluded.kind, data = excluded.data');
    changes(importRows(before, true), importRows(data, true), row => { removeDecision.run(row.value.batchId as string, row.value.rowId as string); }, row => { upsertDecision.run(row.value.batchId as string, row.value.rowId as string, row.position, row.value.kind as string, row.data); });
    }
    if (!before || before.transactions !== data.transactions) {
    const removeLink = database.prepare('DELETE FROM transaction_import_sources WHERE batch_id = ? AND row_id = ?');
    const upsertLink = database.prepare('INSERT INTO transaction_import_sources (batch_id, row_id, transaction_id, position) VALUES (?, ?, ?, ?) ON CONFLICT(batch_id, row_id) DO UPDATE SET transaction_id = excluded.transaction_id, position = excluded.position');
    changes(importLinks(before), importLinks(data), row => { removeLink.run(row.value.importId as string, row.value.rowId as string); }, row => { upsertLink.run(row.value.importId as string, row.value.rowId as string, row.value.transactionId as string, row.position); });
    }
    const removeExtra = database.prepare('DELETE FROM collection_records WHERE id = ?');
    const upsertExtra = database.prepare('INSERT INTO collection_records (id, collection, position, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET collection = excluded.collection, position = excluded.position, data = excluded.data');
    changes(extraRows(before), extraRows(data), row => { removeExtra.run(row.id); }, row => { upsertExtra.run(row.id, row.value.collection as string, row.position, row.data); });
    const settings = metadata(data);
    if (!before || before.revision !== data.revision || metadata(before) !== settings) database.prepare('INSERT INTO workspace_meta (id, workspace, schema_version, revision, settings) VALUES (1, ?, 2, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, settings = excluded.settings').run(workspace, data.revision, settings);
  }

  function transactions(query: TransactionQuery = {}): TransactionPage {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Choose a page size from 1 to 500 and a nonnegative offset.');
    for (const key of ['accountId', 'entityId', 'category', 'search'] as const) {
      const value = query[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > 500 || /[\u0000-\u001f]/u.test(value))) throw new Error('Transaction filters must contain text of at most 500 characters.');
    }
    if (query.kind !== undefined && !['income', 'expense', 'transfer', 'debt_payment', 'opening', 'adjustment'].includes(query.kind)) throw new Error('Choose a supported transaction kind.');
    for (const value of [query.from, query.to]) if (value !== undefined && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error('Transaction date filters must be valid YYYY-MM-DD dates.');
    if (query.from && query.to && query.from > query.to) throw new Error('The start date must not follow the end date.');
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, column] of [['kind', 't.kind'], ['category', 't.category'], ['from', 't.date >='], ['to', 't.date <=']] as const) {
      if (query[key] === undefined) continue;
      if (typeof query[key] !== 'string' || query[key]!.length > 500) throw new Error('Invalid transaction filter.');
      where.push(`${column}${key === 'from' || key === 'to' ? '' : ' ='} ?`);
      values.push(query[key]!);
    }
    if (query.accountId !== undefined) { where.push('(t.account_id = ? OR t.to_account_id = ?)'); values.push(query.accountId, query.accountId); }
    if (query.entityId !== undefined) { where.push('(a.entity_id = ? OR destination.entity_id = ?)'); values.push(query.entityId, query.entityId); }
    if (query.search !== undefined) {
      where.push("(t.description LIKE ? ESCAPE '\\' OR t.category LIKE ? ESCAPE '\\' OR json_extract(t.data, '$.displayName') LIKE ? ESCAPE '\\' OR json_extract(t.data, '$.note') LIKE ? ESCAPE '\\')");
      const pattern = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
      values.push(pattern, pattern, pattern, pattern);
    }
    const selection = `FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts destination ON destination.id = t.to_account_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const aggregate = database.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(t.amount_cents), 0) AS amountCents ${selection}`);
    aggregate.setReadBigInts(true);
    const sums = aggregate.get(...values) as { total: bigint; amountCents: bigint };
    if (sums.amountCents > BigInt(Number.MAX_SAFE_INTEGER) || sums.amountCents < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('This filtered total exceeds safe integer precision. Narrow the date range.');
    const totals = { total: Number(sums.total), amountCents: Number(sums.amountCents) };
    const result = database.prepare(`SELECT t.data ${selection} ORDER BY t.date DESC, t.created_at DESC, t.position ASC LIMIT ? OFFSET ?`).all(...values, limit, offset) as { data: string }[];
    const { revision } = database.prepare('SELECT revision FROM workspace_meta WHERE id = 1').get() as { revision: number };
    return { revision, rows: result.map(row => JSON.parse(row.data) as Transaction), ...totals, limit, offset };
  }
  return { load, save, transactions };
}
