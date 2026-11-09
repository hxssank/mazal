import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Command, StatementDecision, StatementSource, StatementSourceRow } from '../shared/types.ts';
import { createStore } from './store.ts';
import { deferTestCleanup, trackTestResource, closeTestResource } from './test-cleanup.ts';
import { createDocumentStore } from './documents.ts';
import { createDocumentRecovery } from './document-recovery.ts';
import { createCompleteBackupService } from './complete-backup.ts';

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-05T16:00:00Z') });
  const directory = mkdtempSync(join(tmpdir(), 'mazal-extend-activity-'));
  deferTestCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'live.sqlite');
  const originals = join(directory, 'source-documents');
  mkdirSync(originals);
  const store = trackTestResource(t, createStore(path, 'live'));
  const command = (input: Command) => store.command({ ...input, expectedRevision: store.state().revision });
  const accountId = command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const save = (source: StatementSource): StatementSource => {
    const bytes = JSON.stringify({ ...source, sha256: undefined });
    writeFileSync(join(originals, source.sourceFile), bytes);
    return { ...source, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const source = save({ id: 'observed', accountId, sourceFile: 'original.json', sha256: '', sourceKind: 'bank_activity', observedOn: '2026-01-03',
    periodStart: '2026-01-02', periodEnd: '2026-01-03', openingBalanceCents: 10000, closingBalanceCents: 9000,
    rows: [{ id: 'original-row', transactionDate: '2026-01-02', postingDate: '2026-01-02', description: 'Original purchase', amountCents: -1000, sourcePage: 1 }] });
  const commit = (statement: StatementSource, decisions: StatementDecision[]) => {
    command({ type: 'stage_statement', statement, requestId: `stage-${statement.id}` });
    command({ type: 'review_statement', importId: statement.id, decisions, requestId: `review-${statement.id}` });
    command({ type: 'commit_statements', importIds: [statement.id], requestId: `commit-${statement.id}` });
  };
  const row = (id: string, amountCents: number, date = '2026-01-04'): StatementSourceRow => ({ id, transactionDate: date, postingDate: date, description: `Bank ${id}`, amountCents, sourcePage: 1 });
  const extension = (rows: StatementSourceRow[], decisions?: StatementDecision[], changes: Partial<StatementSource> = {}): Extract<Command, { type: 'extend_bank_activity' }> => {
    const previous = store.state().importBatches!.find(batch => batch.id === source.id)!.source;
    const replacementSource = save({ ...previous, sourceFile: 'updated.json', periodEnd: '2026-01-04', observedOn: '2026-01-04',
      rows: [...previous.rows, ...rows], closingBalanceCents: previous.closingBalanceCents + rows.reduce((sum, item) => sum + item.amountCents, 0), ...changes });
    return { type: 'extend_bank_activity', sourceId: previous.id, expectedSource: previous, replacementSource,
      decisions: decisions ?? rows.map(item => ({ rowId: item.id, kind: 'expense', category: 'Food' })), reason: 'New authenticated bank observation', requestId: 'extend', expectedRevision: store.state().revision };
  };
  return { store, path, originals, command, accountId, source, save, commit, row, extension };
}

test('an extension imports a late row, matches a manual payment and offsets balance-only reconciliation without losing history', t => {
  const { store, path, command, accountId, source, commit, row, extension } = setup(t);
  commit(source, [{ rowId: 'original-row', kind: 'expense', category: 'Food' }]);
  command({ type: 'add_transaction', kind: 'expense', accountId, amountCents: 1000, date: '2026-01-04', description: 'Already entered', category: 'Food', requestId: 'manual' });
  const payment = store.state().transactions.find(transaction => transaction.description === 'Already entered')!;
  command({ type: 'reconcile', accountId, balanceCents: 6500, date: '2026-01-04', note: 'Balance observed before new rows were imported', requestId: 'balance' });
  const before = store.export().data;
  const request = extension([row('late-row', -500, '2026-01-03'), row('manual-row', -1000), row('new-row', -1000)], [
    { rowId: 'late-row', kind: 'expense', category: 'Food' },
    { rowId: 'manual-row', kind: 'expense', category: 'Food', match: { transactionId: payment.id } },
    { rowId: 'new-row', kind: 'expense', category: 'Food' },
  ]);
  const state = store.command(request);
  assert.equal(state.accounts[0].balanceCents, 6500);
  assert.equal(state.accounts[0].evidence?.sourceFile, 'updated.json');
  assert.equal(state.importBatches![0].source.rows.length, 4);
  assert.deepEqual(state.importBatches![0].decisions[0], before.importBatches![0].decisions[0]);
  assert.deepEqual(store.export().data.originalImports.at(-1)!.source, {
    format: 'mazal-bank-activity-extension', version: 1, requestId: 'extend', reason: request.reason,
    previousBatch: before.importBatches![0], replacementSource: request.replacementSource, appendedDecisions: request.decisions,
  });
  for (const transaction of before.transactions) {
    const updated = store.export().data.transactions.find(item => item.id === transaction.id)!;
    if (transaction.id !== payment.id) assert.deepEqual(updated, transaction);
    assert.deepEqual(store.export().data.entries.filter(entry => entry.transactionId === transaction.id), before.entries.filter(entry => entry.transactionId === transaction.id));
  }
  assert.deepEqual(state.transactions.find(transaction => transaction.id === payment.id)?.importSources, [{ importId: source.id, rowId: 'manual-row' }]);
  assert.deepEqual(store.command(request), state);
  store.restore(store.export());
  closeTestResource(store);
  const reopened = trackTestResource(t, createStore(path, 'live'));
  try { assert.equal(reopened.state().accounts[0].balanceCents, 6500); assert.deepEqual(reopened.state().importBatches![0].source, request.replacementSource); }
  finally { closeTestResource(reopened); }
});

test('an appended transfer links the existing payment without posting either account twice', t => {
  const { store, command, accountId, source, commit, row, extension } = setup(t);
  commit(source, [{ rowId: 'original-row', kind: 'expense', category: 'Food' }]);
  const card = command({ type: 'add_account', entityId: 'personal', name: 'Card', accountType: 'debt', openingBalanceCents: 2000, openingDate: '2026-01-01' }).accounts.find(account => account.name === 'Card')!;
  command({ type: 'add_transaction', kind: 'debt_payment', accountId, toAccountId: card.id, amountCents: 1000, date: '2026-01-04', description: 'Card payment', category: 'Card payment', requestId: 'payment' });
  const payment = store.state().transactions.find(transaction => transaction.kind === 'debt_payment')!;
  const before = store.export().data.entries;
  const state = store.command(extension([row('payment-row', -1000)], [{ rowId: 'payment-row', kind: 'transfer', category: 'Card payment', match: { transactionId: payment.id } }]));
  assert.equal(state.accounts.find(account => account.id === accountId)?.balanceCents, 8000);
  assert.equal(state.accounts.find(account => account.id === card.id)?.balanceCents, 1000);
  assert.deepEqual(store.export().data.entries.filter(entry => entry.transactionId === payment.id), before.filter(entry => entry.transactionId === payment.id));
});

test('recovery and complete backups detect missing originals from earlier bank activity observations', async t => {
  const { store, path, originals, source, commit, row, extension } = setup(t);
  commit(source, [{ rowId: 'original-row', kind: 'expense', category: 'Food' }]);
  store.command(extension([row('new-row', -500)]));
  const directory = dirname(path);
  closeTestResource(trackTestResource(t, createStore(join(directory, 'demo.sqlite'), 'demo')));
  closeTestResource(trackTestResource(t, createDocumentStore(join(directory, 'documents', 'demo'))));
  const documentDirectory = join(directory, 'documents', 'live');
  const documents = trackTestResource(t, createDocumentStore(documentDirectory));
  const backup = trackTestResource(t, createCompleteBackupService(directory, { close: async () => {}, open: async () => {} }));
  const recovery = createDocumentRecovery({ directory: documentDirectory, sourceDirectory: originals, financePath: path, documents });
  assert.equal(recovery.health(store.state()).missingStatementSources, 0);
  rmSync(join(originals, source.sourceFile));
  assert.equal(recovery.health(store.state()).missingStatementSources, 1);
  await assert.rejects(backup.exportArchive(), /missing originals|damaged evidence/);
});

test('distinct bank descriptions allow equal amounts on the same dates without changing earlier rows', t => {
  const { store, source, save, commit, row, extension } = setup(t);
  const initial = save({ ...source, rows: [{ ...source.rows[0], description: 'SEND E-TFR ***Dna' }] });
  commit(initial, [{ rowId: 'original-row', kind: 'movement', category: 'Transfer' }]);
  const before = store.export().data;
  const rows = [
    { ...row('new-transfer', -1000, '2026-01-02'), description: 'SEND E-TFR ***uzf' },
    { ...row('new-card-payment', -1000, '2026-01-02'), description: 'TD VISA W7W3Y3' },
  ];
  const state = store.command(extension(rows, rows.map(item => ({ rowId: item.id, kind: 'movement', category: 'Transfer' }))));
  assert.equal(state.accounts[0].balanceCents, 7000);
  assert.equal(state.transactions.length, before.transactions.length + 2);
  assert.deepEqual(state.importBatches![0].source.rows, [...initial.rows, ...rows]);
  for (const transaction of before.transactions) assert.deepEqual(store.export().data.transactions.find(item => item.id === transaction.id), transaction);
  for (const entry of before.entries) assert.deepEqual(store.export().data.entries.find(item => item.id === entry.id), entry);
});

test('stale sources, changed prior rows, duplicates and invalid periods reject atomically', t => {
  const { store, source, commit, row, extension, save } = setup(t);
  commit(source, [{ rowId: 'original-row', kind: 'expense', category: 'Food' }]);
  const base = extension([row('new-row', -500)]);
  const variants: Partial<typeof base>[] = [
    { expectedSource: { ...source, closingBalanceCents: 8999 } },
    { replacementSource: { ...base.replacementSource, rows: [{ ...source.rows[0], amountCents: -999 }, base.replacementSource.rows[1]] } },
    { replacementSource: { ...base.replacementSource, rows: [source.rows[0], { ...source.rows[0], id: 'duplicate' }], closingBalanceCents: 8000 }, decisions: [{ rowId: 'duplicate', kind: 'expense', category: 'Food' }] },
    { replacementSource: { ...base.replacementSource, rows: [source.rows[0], { ...source.rows[0], id: 'formatted-duplicate', description: 'ORIGINAL   PURCHASE' }], closingBalanceCents: 8000 }, decisions: [{ rowId: 'formatted-duplicate', kind: 'expense', category: 'Food' }] },
    { replacementSource: { ...base.replacementSource, rows: [source.rows[0], row('new-row', -500), { ...row('new-row', -500), id: 'new-duplicate' }], closingBalanceCents: 8000 }, decisions: [{ rowId: 'new-row', kind: 'expense', category: 'Food' }, { rowId: 'new-duplicate', kind: 'expense', category: 'Food' }] },
    { replacementSource: { ...base.replacementSource, periodStart: '2026-01-01' } },
    { replacementSource: { ...base.replacementSource, closingBalanceCents: 1 } },
    { decisions: [] },
    { dateCorrectionRowIds: ['original-row'], replacementSource: { ...base.replacementSource, rows: [{ ...source.rows[0], transactionDate: '2026-01-03', postingDate: '2026-01-03' }, base.replacementSource.rows[1]] } },
  ];
  const before = store.state();
  for (const [index, variant] of variants.entries()) {
    const replacementSource = save({ ...base.replacementSource, ...variant.replacementSource });
    assert.throws(() => store.command({ ...base, ...variant, replacementSource, requestId: `bad-${index}` }), /source changed|preserve every|duplicates|start date|reconcile|Review every|Date corrections/);
    assert.deepEqual(store.state(), before);
  }
});

test('source file tampering and missing original files reject before changing records', t => {
  const { store, originals, source, commit, row, extension } = setup(t);
  commit(source, [{ rowId: 'original-row', kind: 'expense', category: 'Food' }]);
  const request = extension([row('new-row', -500)]);
  const before = store.state();
  writeFileSync(join(originals, 'updated.json'), '{"changed":true}');
  assert.throws(() => store.command(request), /review source changed/);
  assert.deepEqual(store.state(), before);
  rmSync(join(originals, 'original.json'));
  assert.throws(() => store.command(request), /source is missing/);
  assert.deepEqual(store.state(), before);
});

test('unmatched manual activity and overlap with a later statement reject atomically', t => {
  const { store, command, accountId, source, commit, row, extension, save } = setup(t);
  commit(source, [{ rowId: 'original-row', kind: 'expense', category: 'Food' }]);
  command({ type: 'add_transaction', kind: 'expense', accountId, amountCents: 100, date: '2026-01-04', description: 'Unlinked payment', category: 'Food', requestId: 'manual' });
  const request = extension([row('new-row', -500)]);
  const before = store.state();
  assert.throws(() => store.command(request), /Unmatched: Unlinked payment/);
  assert.deepEqual(store.state(), before);
  const manual = before.transactions.find(transaction => transaction.description === 'Unlinked payment')!;
  const later = save({ ...source, id: 'next', sourceFile: 'next.json', periodStart: '2026-01-04', periodEnd: '2026-01-04', observedOn: '2026-01-04', openingBalanceCents: 9000, closingBalanceCents: 8900, rows: [row('next-row', -100)] });
  commit(later, [{ rowId: 'next-row', kind: 'expense', category: 'Food', match: { transactionId: manual.id } }]);
  assert.throws(() => command({ ...request, requestId: 'overlap' }), /cannot overlap/);
});

test('declared single-date transfer refinement preserves both accounts and archives the former date', t => {
  const { store, command, accountId, source, save, commit, row, extension } = setup(t);
  const card = command({ type: 'add_account', entityId: 'personal', name: 'Card', accountType: 'debt', openingBalanceCents: 2000, openingDate: '2026-01-01' }).accounts.find(account => account.name === 'Card')!;
  command({ type: 'add_transaction', kind: 'debt_payment', accountId, toAccountId: card.id, amountCents: 1000, date: '2026-01-02', description: 'Card payment', category: 'Card payment', requestId: 'payment' });
  const payment = store.state().transactions.find(transaction => transaction.kind === 'debt_payment')!;
  const initial = save({ ...source, rows: [{ ...source.rows[0], description: 'Bank payment', dateBasis: 'transaction_only' }] });
  commit(initial, [{ rowId: 'original-row', kind: 'transfer', category: 'Card payment', match: { transactionId: payment.id } }]);
  const before = store.export().data;
  const request = extension([row('new-row', -500)]);
  request.dateCorrectionRowIds = ['original-row'];
  const { dateBasis: _basis, ...oldRow } = initial.rows[0];
  request.replacementSource = save({ ...request.replacementSource, rows: [{ ...oldRow, transactionDate: '2026-01-03', postingDate: '2026-01-04' }, request.replacementSource.rows[1]] });
  const state = store.command(request);
  assert.equal(state.accounts.find(account => account.id === accountId)?.balanceCents, 8500);
  assert.equal(state.accounts.find(account => account.id === card.id)?.balanceCents, 1000);
  assert.deepEqual(store.export().data.transactions.find(transaction => transaction.id === payment.id), before.transactions.find(transaction => transaction.id === payment.id));
  assert.equal(state.transactions.find(transaction => transaction.id === payment.id)?.balanceDates?.[accountId], '2026-01-04');
  assert.equal((store.export().data.originalImports.at(-1)!.source as { previousBatch: { source: StatementSource } }).previousBatch.source.rows[0].postingDate, '2026-01-02');
  store.restore(store.export());
});
