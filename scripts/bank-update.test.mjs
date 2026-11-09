import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../server/store.ts';
import { bankImplementationHash, bankStateHash, executeBankUpdate, loadBankUpdatePlan, parseBankUpdateArguments, rehearseBankUpdate, runBankUpdate, validateBankUpdatePlan } from './bank-update.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mazal-bank-update-test-'));
  const sourceDirectory = join(root, 'source-documents');
  mkdirSync(sourceDirectory);
  const store = createStore(join(root, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const command = input => store.command({ ...input, expectedRevision: store.state().revision });
  const cash = command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' }).accounts[0].id;
  const card = command({ type: 'add_account', entityId: 'personal', name: 'Card', accountType: 'debt', openingBalanceCents: 5000, openingDate: '2026-01-01' }).accounts.find(account => account.name === 'Card').id;
  const source = { id: 'bank', accountId: cash, sourceFile: 'original.json', sourceKind: 'bank_activity', observedOn: '2026-01-03', periodStart: '2026-01-02', periodEnd: '2026-01-03', openingBalanceCents: 10000, closingBalanceCents: 9000,
    rows: [{ id: 'first', transactionDate: '2026-01-02', postingDate: '2026-01-02', description: 'Original purchase', amountCents: -1000, sourcePage: 1 }] };
  const saveSource = (value, directory) => {
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(join(directory, value.sourceFile), bytes);
    return { ...value, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const original = saveSource(source, sourceDirectory);
  command({ type: 'stage_statement', statement: original, requestId: 'stage' });
  command({ type: 'review_statement', importId: source.id, decisions: [{ rowId: 'first', kind: 'expense', category: 'Food' }], requestId: 'review' });
  command({ type: 'commit_statements', importIds: [source.id], requestId: 'commit' });
  const baseline = store.state();
  const backup = store.export();
  const replacement = saveSource({ ...source, sourceFile: 'new.json', observedOn: '2026-01-04', periodEnd: '2026-01-04', closingBalanceCents: 6000,
    rows: [...source.rows, { id: 'payment', transactionDate: '2026-01-04', postingDate: '2026-01-04', description: 'Payment to card', amountCents: -3000, sourcePage: 1 }] }, root);
  const plan = { format: 'mazal-bank-update', version: 1, id: 'fixture-update', baseline: { stateFile: 'baseline.json', revision: baseline.revision, stateSha256: bankStateHash(baseline) },
    sources: [{ file: 'new.json', sourceFile: 'new.json', sha256: replacement.sha256 }], steps: [
      { id: 'payment', capture: 'card-payment', command: { type: 'add_transaction', kind: 'debt_payment', accountId: cash, toAccountId: card, amountCents: 3000, date: '2026-01-04', description: 'Card payment', category: 'Debt repayment' } },
      { id: 'bank-rows', command: { type: 'extend_bank_activity', sourceId: source.id, expectedSource: original, replacementSource: replacement,
        decisions: [{ rowId: 'payment', kind: 'transfer', category: 'Debt repayment', match: { transactionId: { $transaction: 'card-payment' } } }], reason: 'Reviewed bank activity' } },
    ], expect: { transactionDelta: 1, accountBalancesCents: { [cash]: 6000, [card]: 2000 } } };
  const planPath = join(root, 'plan.json'), backupPath = join(root, 'backup.json');
  writeFileSync(join(root, 'baseline.json'), JSON.stringify(baseline));
  writeFileSync(backupPath, JSON.stringify(backup));
  const savePlan = () => writeFileSync(planPath, JSON.stringify(plan));
  savePlan();
  const loaded = () => loadBankUpdatePlan(planPath);
  const adapter = { state: async () => store.state(), command: async input => store.command(input) };
  const runDirectory = join(root, 'run');
  const execute = (options = {}) => executeBankUpdate(loaded(), { adapter, sourceDirectory, runDirectory, ...options });
  return { root, store, command, baseline, backupPath, sourceDirectory, runDirectory, plan, planPath, savePlan, loaded, adapter, execute, cash, card };
}

test('preview verifies hashes and exposes the full reviewed steps without changing records or sources', async t => {
  const f = fixture(t);
  const before = bankStateHash(f.store.state());
  const preview = await runBankUpdate(['preview', '--plan', f.planPath]);
  assert.equal(preview.writes, false);
  assert.deepEqual(preview.steps, f.plan.steps);
  assert.equal(bankStateHash(f.store.state()), before);
  assert.deepEqual(readdirSync(f.sourceDirectory), ['original.json']);
});

test('one payment is captured and matched, with immutable originals and saved command responses', async t => {
  const f = fixture(t);
  const original = readFileSync(join(f.sourceDirectory, 'original.json'));
  const result = await f.execute();
  assert.equal(result.complete, true);
  assert.equal(result.revision, f.baseline.revision + 2);
  const payment = f.store.state().transactions.find(transaction => transaction.kind === 'debt_payment');
  assert.equal(payment.importSources.length, 1);
  const command = JSON.parse(readFileSync(join(f.runDirectory, '002-bank-rows-command.json')));
  assert.equal(command.decisions[0].match.transactionId, payment.id);
  assert.equal(command.requestId, 'bank-update:fixture-update:bank-rows');
  assert.deepEqual(readFileSync(join(f.sourceDirectory, 'original.json')), original);
  assert.equal(JSON.parse(readFileSync(join(f.runDirectory, '002-bank-rows-response.json'))).revision, result.revision);
  assert.deepEqual(await f.execute({ resume: true }), result);
  assert.equal(f.store.state().transactions.filter(transaction => transaction.kind === 'debt_payment').length, 1);
});

test('an interrupted successful payment resumes only with the exact saved request and creates no duplicate', async t => {
  const f = fixture(t);
  let calls = 0;
  const interrupted = { ...f.adapter, command: async input => { const response = f.store.command(input); if (++calls === 1) throw new Error('Lost response'); return response; } };
  await assert.rejects(f.execute({ adapter: interrupted }), /Lost response/);
  assert.equal(f.store.state().revision, f.baseline.revision + 1);
  assert.equal(existsSync(join(f.runDirectory, '001-payment-command.json')), true);
  assert.equal(existsSync(join(f.runDirectory, '001-payment-response.json')), false);
  await assert.rejects(f.execute(), /--resume/);
  const result = await f.execute({ resume: true });
  assert.equal(result.complete, true);
  assert.equal(f.store.state().transactions.filter(transaction => transaction.kind === 'debt_payment').length, 1);
});

test('an interrupted request before dispatch resumes from its unchanged baseline', async t => {
  const f = fixture(t);
  await assert.rejects(f.execute({ adapter: { ...f.adapter, command: async () => { throw new Error('Not dispatched'); } } }), /Not dispatched/);
  assert.equal(f.store.state().revision, f.baseline.revision);
  assert.equal((await f.execute({ resume: true })).complete, true);
});

test('a missing response plus an unrelated revision cannot repeat a payment', async t => {
  const f = fixture(t);
  await assert.rejects(f.execute({ adapter: { ...f.adapter, command: async () => { throw new Error('Not dispatched'); } } }), /Not dispatched/);
  f.command({ type: 'add_transaction', kind: 'expense', accountId: f.cash, amountCents: 100, date: '2026-01-04', description: 'Concurrent purchase', category: 'Food', requestId: 'concurrent' });
  await assert.rejects(f.execute({ resume: true }), /revision|changed/i);
  assert.equal(f.store.state().transactions.some(transaction => transaction.kind === 'debt_payment'), false);
});

test('intervening revisions after a committed request stop resume before any more commands', async t => {
  const f = fixture(t);
  await assert.rejects(f.execute({ adapter: { ...f.adapter, command: async input => { f.store.command(input); throw new Error('Lost response'); } } }), /Lost response/);
  f.command({ type: 'add_transaction', kind: 'expense', accountId: f.cash, amountCents: 100, date: '2026-01-04', description: 'Concurrent purchase', category: 'Food', requestId: 'concurrent' });
  const revision = f.store.state().revision;
  await assert.rejects(f.execute({ resume: true }), /intervening changes/);
  assert.equal(f.store.state().revision, revision);
});

test('a changed initial baseline rejects before adding source files or issuing commands', async t => {
  const f = fixture(t);
  f.command({ type: 'add_transaction', kind: 'expense', accountId: f.cash, amountCents: 100, date: '2026-01-04', description: 'Concurrent purchase', category: 'Food', requestId: 'concurrent' });
  await assert.rejects(f.execute(), /baseline changed/);
  assert.deepEqual(readdirSync(f.sourceDirectory), ['original.json']);
});

test('changed source bytes, missing originals and filename collisions reject without replacing files', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'new.json'), 'changed');
  assert.throws(f.loaded, /hash changed/);
  assert.equal(f.store.state().revision, f.baseline.revision);
  const second = fixture(t);
  writeFileSync(join(second.sourceDirectory, 'new.json'), 'previous original');
  await assert.rejects(second.execute(), /already exists/);
  assert.equal(readFileSync(join(second.sourceDirectory, 'new.json'), 'utf8'), 'previous original');
  const third = fixture(t);
  rmSync(join(third.sourceDirectory, 'original.json'));
  await assert.rejects(third.execute(), /missing or changed/);
});

test('plan and journal changes cannot resume the saved update', async t => {
  const f = fixture(t);
  await assert.rejects(f.execute({ adapter: { ...f.adapter, command: async () => { throw new Error('Not dispatched'); } } }), /Not dispatched/);
  const commandPath = join(f.runDirectory, '001-payment-command.json');
  const saved = JSON.parse(readFileSync(commandPath));
  writeFileSync(commandPath, JSON.stringify({ ...saved, amountCents: 4000 }));
  await assert.rejects(f.execute({ resume: true }), /saved command/);
  f.plan.steps[0].command.amountCents = 4000;
  f.savePlan();
  await assert.rejects(f.execute({ resume: true }), /different plan/);
  assert.equal(f.store.state().revision, f.baseline.revision);
});

test('rehearsal restores only into a new isolated store and verifies persistence', async t => {
  const f = fixture(t);
  const before = bankStateHash(f.store.state());
  const runDirectory = join(f.root, 'rehearsal');
  const result = await rehearseBankUpdate(f.loaded(), { backupPath: f.backupPath, sourceDirectory: f.sourceDirectory, runDirectory });
  assert.equal(result.complete, true);
  assert.equal(result.persistedReadBack, true);
  assert.equal(result.planSha256, f.loaded().planSha256);
  assert.equal(result.baselineStateSha256, bankStateHash(f.baseline));
  assert.equal(bankStateHash(f.store.state()), before);
  assert.deepEqual(readdirSync(f.sourceDirectory), ['original.json']);
  await assert.rejects(rehearseBankUpdate(f.loaded(), { backupPath: f.backupPath, sourceDirectory: f.sourceDirectory, runDirectory }), /new directory/);
});

test('rehearsal catches wrong reviewed balances before an apply receipt can exist', async t => {
  const f = fixture(t);
  f.plan.expect.accountBalancesCents[f.cash] = 9999;
  f.savePlan();
  const runDirectory = join(f.root, 'rehearsal');
  await assert.rejects(rehearseBankUpdate(f.loaded(), { backupPath: f.backupPath, sourceDirectory: f.sourceDirectory, runDirectory }), /final balance/);
  assert.equal(existsSync(join(runDirectory, 'receipt.json')), false);
  assert.equal(bankStateHash(f.store.state()), bankStateHash(f.baseline));
});

test('historical rehearsal can use an archive that already contains the matching newer source', async t => {
  const f = fixture(t);
  writeFileSync(join(f.sourceDirectory, 'new.json'), readFileSync(join(f.root, 'new.json')));
  const before = readFileSync(join(f.sourceDirectory, 'new.json'));
  const receipt = await rehearseBankUpdate(f.loaded(), { backupPath: f.backupPath, sourceDirectory: f.sourceDirectory, runDirectory: join(f.root, 'rehearsal') });
  assert.equal(receipt.complete, true);
  assert.deepEqual(readFileSync(join(f.sourceDirectory, 'new.json')), before);
  assert.equal(f.store.state().revision, f.baseline.revision);
});

test('apply requires a matching rehearsal before reaching the local agent', async t => {
  const f = fixture(t);
  const receipt = join(f.root, 'receipt.json');
  writeFileSync(receipt, JSON.stringify({ format: 'mazal-bank-update-rehearsal', version: 1, complete: true, persistedReadBack: true, planSha256: 'bad', baselineStateSha256: bankStateHash(f.baseline) }));
  await assert.rejects(runBankUpdate(['apply', '--plan', f.planPath, '--rehearsal', receipt, '--run-directory', f.runDirectory]), /exact plan/);
  assert.equal(existsSync(f.runDirectory), false);
});

test('plans reject restore commands, unsafe filenames, caller revisions and forward captures', t => {
  const f = fixture(t);
  for (const change of [
    plan => { plan.steps[0].command.type = 'restore'; },
    plan => { plan.sources[0].sourceFile = '../original.json'; },
    plan => { plan.steps[0].command.expectedRevision = 7; },
    plan => { plan.steps[0].command.requestId = 'chosen'; },
    plan => { plan.steps[1].command.decisions[0].match.transactionId.$transaction = 'unknown'; },
    plan => { plan.steps[1].id = plan.steps[0].id; },
    plan => { delete plan.id; },
    plan => { delete plan.steps[0].id; },
  ]) { const plan = structuredClone(f.plan); change(plan); assert.throws(() => validateBankUpdatePlan(plan)); }
});

test('implementation identity includes command code and the dependency lock but ignores test edits', t => {
  const root = mkdtempSync(join(tmpdir(), 'mazal-bank-implementation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['server', 'shared', 'scripts']) mkdirSync(join(root, folder));
  for (const path of ['package-lock.json', 'server/store.ts', 'shared/types.ts', 'scripts/bank-update.mjs', 'scripts/local-agent.mjs']) writeFileSync(join(root, path), 'original');
  const before = bankImplementationHash(root);
  writeFileSync(join(root, 'server/store.test.ts'), 'new test');
  assert.equal(bankImplementationHash(root), before);
  writeFileSync(join(root, 'server/store.ts'), 'changed command');
  assert.notEqual(bankImplementationHash(root), before);
  writeFileSync(join(root, 'server/store.ts'), 'original');
  writeFileSync(join(root, 'package-lock.json'), 'changed dependency');
  assert.notEqual(bankImplementationHash(root), before);
});

test('historical evidence missing outside the update is reported without blocking the reviewed sources', async t => {
  const f = fixture(t);
  f.baseline.statements.push({ sourceFile: 'historical.pdf', sha256: 'a'.repeat(64) });
  f.plan.baseline.stateSha256 = bankStateHash(f.baseline);
  writeFileSync(join(f.root, 'baseline.json'), JSON.stringify(f.baseline));
  f.savePlan();
  const adapter = { state: async () => ({ ...f.store.state(), statements: f.baseline.statements }), command: async input => ({ ...f.store.command(input), statements: f.baseline.statements }) };
  const result = await f.execute({ adapter });
  assert.equal(result.updateSourceHashesVerified, true);
  assert.deepEqual(result.unavailableHistoricalSources, [{ sourceFile: 'historical.pdf', sha256: 'a'.repeat(64), status: 'missing' }]);
});

test('content-addressed historical document originals satisfy source coverage and stay unchanged', async t => {
  const f = fixture(t);
  const bytes = Buffer.from('Historical PDF bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const documents = join(f.root, 'documents', 'live');
  mkdirSync(documents, { recursive: true });
  const path = join(documents, `${sha256}.original`);
  writeFileSync(path, bytes);
  f.baseline.statements.push({ sourceFile: 'historical.pdf', sha256 });
  f.plan.baseline.stateSha256 = bankStateHash(f.baseline);
  writeFileSync(join(f.root, 'baseline.json'), JSON.stringify(f.baseline));
  f.savePlan();
  const adapter = { state: async () => ({ ...f.store.state(), statements: f.baseline.statements }), command: async input => ({ ...f.store.command(input), statements: f.baseline.statements }) };
  const result = await f.execute({ adapter });
  assert.deepEqual(result.unavailableHistoricalSources, []);
  assert.equal(result.documentOriginalFilesPreserved, 1);
  assert.deepEqual(readFileSync(path), bytes);
});

test('a changed document original stops before any command', async t => {
  const f = fixture(t);
  const documents = join(f.root, 'documents', 'live');
  mkdirSync(documents, { recursive: true });
  writeFileSync(join(documents, `${'a'.repeat(64)}.original`), 'changed');
  await assert.rejects(f.execute(), /document original no longer matches/);
  assert.equal(f.store.state().revision, f.baseline.revision);
});

test('source symlinks are rejected', async t => {
  const f = fixture(t);
  rmSync(join(f.root, 'new.json'));
  symlinkSync(join(f.sourceDirectory, 'original.json'), join(f.root, 'new.json'));
  assert.throws(f.loaded, /regular file/);
});

test('arguments make writes explicit and require all mode-specific paths', () => {
  assert.equal(parseBankUpdateArguments(['--help']).mode, 'help');
  assert.equal(parseBankUpdateArguments(['preview', '--plan', 'plan.json']).mode, 'preview');
  assert.equal(parseBankUpdateArguments(['apply', '--plan', 'plan.json', '--rehearsal', 'receipt.json', '--run-directory', 'run', '--resume']).resume, true);
  for (const args of [[], ['plan.json'], ['apply', '--plan', 'plan.json'], ['preview', '--plan', 'p', '--resume'], ['preview', '--plan', 'p', '--plan', 'q']]) assert.throws(() => parseBankUpdateArguments(args));
});
