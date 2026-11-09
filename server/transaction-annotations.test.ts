import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import type { Command, StatementSource } from '../shared/types.ts';
import { transactionLabel } from '../shared/transaction-label.ts';
import { canMatchStatementTransaction } from '../shared/statement-imports.ts';

type Annotation = Extract<Command, { type: 'annotate_transaction' }>;

function setup(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-annotations-'));
  const path = join(directory, 'live.sqlite');
  let store = createStore(path, 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (input: Command) => store.command({ ...input, expectedRevision: store.state().revision });
  const accountId = command({ type: 'add_account', entityId: 'personal', name: 'Card', accountType: 'debt', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const source: StatementSource = { id: 'january', accountId, sourceFile: 'Synthetic January.pdf', sha256: 'a'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 11000, rows: [{ id: 'purchase', transactionDate: '2026-01-10', postingDate: '2026-01-12', description: '  BANK ORIGINAL  ', amountCents: 1000, sourcePage: 1 }] };
  const addManual = () => command({ type: 'add_transaction', kind: 'expense', accountId, amountCents: 1000, date: '2026-01-10', description: 'BANK ORIGINAL', category: 'Uncategorized', requestId: 'manual' }).transactions.find(tx => tx.kind === 'expense')!;
  const annotate = (id: string, displayName: string | null = 'Home internet', note: string | null = 'Monthly service'): Annotation => {
    const current = store.state().transactions.find(tx => tx.id === id)!;
    return { type: 'annotate_transaction', id, expectedDisplayName: current.displayName ?? null, expectedNote: current.note ?? null, displayName, note, requestId: crypto.randomUUID(), expectedRevision: store.state().revision };
  };
  return { get store() { return store; }, command, accountId, source, addManual, annotate, restart: () => { store.close(); store = createStore(path, 'live'); } };
}

test('transaction names and notes persist and search without changing money or source text', t => {
  const fixture = setup(t);
  const original = fixture.addManual();
  const before = fixture.store.export();
  const input = fixture.annotate(original.id, '  Home internet  ', '  Monthly service\n50% employer reimbursement  ');
  const saved = fixture.store.command(input);
  const renamed = saved.transactions.find(tx => tx.id === original.id)!;
  assert.equal(transactionLabel(renamed), 'Home internet');
  assert.equal(renamed.note, 'Monthly service\n50% employer reimbursement');
  const { displayName: _name, note: _note, ...preserved } = renamed;
  assert.deepEqual(preserved, original);
  const backup = fixture.store.export();
  assert.deepEqual(backup.data.entries, before.data.entries);
  assert.deepEqual(backup.data.accounts, before.data.accounts);
  assert.equal(saved.audit[0]?.action, 'annotate_transaction');
  assert.match(saved.audit[0].description, /Home internet/);
  for (const search of ['BANK ORIGINAL', 'home internet', 'employer reimbursement', '50%']) assert.equal(fixture.store.transactions({ search }).rows[0]?.id, original.id);
  assert.equal(fixture.store.transactions({ search: '50_' }).total, 0);
  fixture.restart();
  assert.equal(transactionLabel(fixture.store.state().transactions.find(tx => tx.id === original.id)!), 'Home internet');
  assert.equal(fixture.store.command(input).revision, saved.revision);
  assert.throws(() => fixture.store.command({ ...input, displayName: 'Different name' }), /different operation/);
  fixture.store.restore(backup, fixture.store.state().revision);
  assert.deepEqual(fixture.store.state().transactions.find(tx => tx.id === original.id), renamed);
});

for (const legacy of [false, true]) test(`names and notes on ${legacy ? 'legacy' : 'current'} statement records preserve source rows and completed reconciliation`, t => {
  const fixture = setup(t);
  if (legacy) {
    fixture.command({ type: 'import_statement', requestId: 'statement', statement: { ...fixture.source, rows: fixture.source.rows.map(row => ({ ...row, description: row.description.trim(), kind: 'purchase', category: 'Uncategorized' })) } });
  } else {
    fixture.command({ type: 'stage_statement', statement: fixture.source, requestId: 'stage' });
    fixture.command({ type: 'review_statement', importId: fixture.source.id, decisions: [{ rowId: 'purchase', kind: 'expense', category: 'Uncategorized' }], requestId: 'review' });
    fixture.command({ type: 'commit_statements', importIds: [fixture.source.id], requestId: 'commit' });
  }
  fixture.command({ type: 'save_reconciliation', accountId: fixture.accountId, date: '2026-01-31', balanceCents: 11000, clearedTransactionIds: fixture.store.state().transactions.map(tx => tx.id), finish: true, requestId: 'reconcile' });
  const before = fixture.store.export();
  const original = fixture.store.state().transactions.find(tx => tx.kind === 'expense')!;
  fixture.store.command(fixture.annotate(original.id));
  const after = fixture.store.export();
  for (const key of ['entries', 'accounts', 'statements', 'importBatches', 'originalImports', 'importKeys'] as const) assert.deepEqual(after.data[key], before.data[key]);
  const { displayName, note, ...preserved } = after.data.transactions.find(tx => tx.id === original.id)!;
  assert.equal(displayName, 'Home internet');
  assert.equal(note, 'Monthly service');
  assert.deepEqual(preserved, before.data.transactions.find(tx => tx.id === original.id));
  fixture.store.restore(after, fixture.store.state().revision);
  assert.equal(fixture.store.state().accounts[0].reconciliation?.balanceCents, 11000);
  assert.equal(fixture.store.state().transactions.find(tx => tx.id === original.id)?.description, original.description);
});

test('renaming a manual transaction does not alter statement matching and survives a later source link', t => {
  const fixture = setup(t);
  const original = fixture.addManual();
  fixture.store.command(fixture.annotate(original.id));
  fixture.command({ type: 'stage_statement', statement: fixture.source, requestId: 'stage' });
  let state = fixture.store.state();
  assert.equal(canMatchStatementTransaction(state, state.importBatches![0], fixture.source.rows[0], 'expense', state.transactions.find(tx => tx.id === original.id)!), true);
  fixture.command({ type: 'review_statement', importId: fixture.source.id, decisions: [{ rowId: 'purchase', kind: 'expense', category: 'Uncategorized', match: { transactionId: original.id } }], requestId: 'review' });
  state = fixture.command({ type: 'commit_statements', importIds: [fixture.source.id], requestId: 'commit' });
  const matched = state.transactions.find(tx => tx.id === original.id)!;
  assert.equal(matched.displayName, 'Home internet');
  assert.equal(matched.note, 'Monthly service');
  assert.equal(matched.description, original.description);
  assert.equal(state.accounts[0].balanceCents, 11000);
  assert.deepEqual(matched.importSources, [{ importId: fixture.source.id, rowId: 'purchase' }]);
});

test('annotations reject stale edits, missing guards, controls, and oversized values atomically', t => {
  const fixture = setup(t);
  const original = fixture.addManual();
  const input = fixture.annotate(original.id);
  fixture.store.command(input);
  const before = fixture.store.state();
  const valid = fixture.annotate(original.id, 'Updated name', 'Updated note');
  const invalid = [
    { ...valid, expectedRevision: valid.expectedRevision! - 1 },
    { ...valid, expectedRevision: undefined },
    { ...valid, requestId: undefined },
    { ...valid, expectedDisplayName: null },
    { ...valid, expectedNote: null },
    { ...valid, expectedDisplayName: undefined },
    { ...valid, id: 'missing' },
    { ...valid, displayName: 'x'.repeat(201) },
    { ...valid, note: 'x'.repeat(1001) },
    { ...valid, displayName: 'Name\n' },
    { ...valid, displayName: 'Name\twith tab' },
    { ...valid, displayName: 'Name\u007f' },
    { ...valid, note: 'Note\u0000' },
    { ...valid, note: 'Note\u0085' },
    { ...valid, displayName: 'Home internet', note: 'Monthly service' },
  ];
  for (const request of invalid) {
    assert.throws(() => fixture.store.command(request as Command));
    assert.deepEqual(fixture.store.state(), before);
  }
});

test('blank annotations remove overrides and invalid restored annotations leave the workspace intact', t => {
  const fixture = setup(t);
  const original = fixture.addManual();
  fixture.store.command(fixture.annotate(original.id));
  const backup = fixture.store.export();
  const before = fixture.store.state();
  for (const change of [{ displayName: 'x'.repeat(201) }, { note: 'x'.repeat(1001) }, { displayName: 'bad\nname' }, { note: 'bad\u0000note' }]) {
    const invalid = structuredClone(backup);
    Object.assign(invalid.data.transactions.find(tx => tx.id === original.id)!, change);
    assert.throws(() => fixture.store.restore(invalid, before.revision));
    assert.deepEqual(fixture.store.state(), before);
  }
  fixture.store.command(fixture.annotate(original.id, '   ', '\n \t'));
  const reset = fixture.store.state().transactions.find(tx => tx.id === original.id)!;
  assert.equal(Object.hasOwn(reset, 'displayName'), false);
  assert.equal(Object.hasOwn(reset, 'note'), false);
  assert.equal(transactionLabel(reset), original.description);
  assert.deepEqual(reset, original);
});

test('a manual correction retains user context through a changed description and later refund', t => {
  const fixture = setup(t);
  const entry = fixture.addManual();
  fixture.store.command(fixture.annotate(entry.id));
  const original = fixture.store.state().transactions.find(tx => tx.id === entry.id)!;
  const before = fixture.store.export();
  const correction: Command = { type: 'correct_transaction', id: original.id, reason: 'Receipt shows eight dollars', replacement: { kind: 'expense', accountId: fixture.accountId, amountCents: 800, date: original.date, description: 'Corrected receipt description', category: 'Bills' }, requestId: 'correct-annotated', expectedRevision: fixture.store.state().revision };
  const corrected = fixture.store.command(correction);
  assert.equal(fixture.store.command(correction).revision, corrected.revision);
  const replacement = corrected.transactions.find(tx => tx.replacesId === original.id)!;
  const reversal = corrected.transactions.find(tx => tx.reversalOf === original.id)!;
  assert.equal(replacement.description, 'Corrected receipt description');
  assert.equal(replacement.displayName, original.displayName);
  assert.equal(replacement.note, original.note);
  assert.equal(replacement.correctionReason, correction.reason);
  assert.equal(reversal.description, `Reversal: ${original.description}`);
  assert.equal(reversal.amountCents, -original.amountCents);
  assert.equal(reversal.correctionReason, correction.reason);
  assert.equal(corrected.accounts[0].balanceCents, 10800);
  assert.deepEqual(corrected.transactions.find(tx => tx.id === original.id), original);
  const afterCorrection = fixture.store.export();
  const originalEntries = before.data.entries.filter(item => item.transactionId === original.id);
  assert.deepEqual(afterCorrection.data.entries.filter(item => item.transactionId === original.id), originalEntries);
  for (const line of originalEntries) assert.equal(afterCorrection.data.entries.find(item => item.transactionId === reversal.id && item.accountId === line.accountId)?.debitCents, -line.debitCents);
  assert.equal(corrected.audit.filter(item => item.action === 'correct_transaction').length, 1);
  assert.match(corrected.audit.find(item => item.action === 'correct_transaction')!.description, /BANK ORIGINAL/);
  const refunded = fixture.command({ type: 'record_refund', id: replacement.id, accountId: fixture.accountId, amountCents: 200, date: original.date, reason: 'Partial service credit', requestId: 'refund-corrected' });
  const refund = refunded.transactions.find(tx => tx.refundOf === replacement.id)!;
  assert.equal(refund.description, `Refund: ${replacement.description}`);
  assert.equal(refund.amountCents, -200);
  assert.equal(refund.correctionReason, 'Partial service credit');
  assert.equal(refunded.accounts[0].balanceCents, 10600);
  assert.deepEqual(refunded.transactions.find(tx => tx.id === original.id), original);
  assert.deepEqual(refunded.transactions.find(tx => tx.id === replacement.id), replacement);
  assert.equal(refunded.audit.filter(item => item.action === 'record_refund').length, 1);
  assert.match(refunded.audit.find(item => item.action === 'record_refund')!.description, /Corrected receipt description/);
  fixture.store.restore(fixture.store.export(), refunded.revision);
  assert.deepEqual(fixture.store.state().transactions.find(tx => tx.id === replacement.id), replacement);
});
