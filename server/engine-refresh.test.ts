import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import type { AppState } from '../shared/types.ts';
import type { DailyPlan, EngineEnvelope, EngineSummary, PayoffProjection, PlannerProjection, SpendingCalendarProjection } from '../shared/engine.ts';

function engineProcessIds(log: string): string[] {
  return [...stripVTControlCharacters(log).matchAll(/Started server process \[(\d+)\]/g)].map(match => match[1]);
}

test('engine process IDs retain plain and colored startup records', () => {
  const plain = 'INFO:     Started server process [4676]\r\n';
  const colored = '\u001b[32mINFO\u001b[0m:     Started server process [\u001b[36m4676\u001b[0m]\r\n';
  assert.deepEqual(engineProcessIds(plain), ['4676']);
  assert.deepEqual(engineProcessIds(colored), ['4676']);
  assert.deepEqual(engineProcessIds(`${plain}${colored}`), ['4676', '4676']);
  assert.deepEqual(engineProcessIds('INFO:     Application startup complete.'), []);
});

async function availablePort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      assert.ok(address && typeof address === 'object');
      listener.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

test('saved records refresh the running Python engine and projections leave records and originals unchanged', { timeout: 90_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-engine-refresh-'));
  const port = await availablePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.ts', import.meta.url))], {
    env: { ...process.env, PORT: String(port), MAZAL_DATA_DIR: directory, MAZAL_ENGINE_AUTOSTART: '0', MAZAL_MASTER_WORKBOOK: join(directory, 'unused-master.xlsx') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineLog = '';
  child.stderr.on('data', chunk => { engineLog = `${engineLog}${chunk}`.slice(-32_000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    for (const value of engineProcessIds(engineLog)) {
      const pid = Number(value);
      try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The temporary Mazal server did not start.')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`The temporary Mazal server exited with ${code}.`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const state = async (): Promise<AppState> => {
    const response = await fetch(`${base}/api/state?workspace=live`);
    assert.equal(response.status, 200);
    return response.json() as Promise<AppState>;
  };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const summaryResponse = (revision: number) => fetch(`${base}/api/engine/summary?workspace=live&scope=personal&asOf=2026-01-02&expectedRevision=${revision}`);
  const summary = async (revision: number): Promise<EngineEnvelope<EngineSummary>> => {
    const response = await summaryResponse(revision);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<EngineEnvelope<EngineSummary>>;
  };

  const initialState = await state();
  assert.equal(initialState.revision, 0);
  assert.equal(initialState.accounts.length, 0);
  const original = Buffer.from('%PDF-1.7\nSynthetic engine refresh source.\n%%EOF\n');
  const upload = await fetch(`${base}/api/documents?workspace=live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Mazal-Document': encodeURIComponent(JSON.stringify({ originalName: 'engine-refresh-fixture.pdf', kind: 'receipt', notes: 'Synthetic engine integration fixture' })) },
    body: original,
  });
  assert.equal(upload.status, 201);
  const document = (await upload.json()).document;
  const originalPath = join(directory, 'documents', 'live', `${document.id}.original`);
  const originalHash = createHash('sha256').update(readFileSync(originalPath)).digest('hex');
  assert.equal(originalHash, document.sha256);

  const emptySummary = await summary(initialState.revision);
  assert.equal(emptySummary.result.summary.netWorthCents, 0);
  assert.deepEqual(await state(), initialState);
  const logDeadline = Date.now() + 5000;
  while (!engineProcessIds(engineLog).length && Date.now() < logDeadline) await delay(25);
  const firstEnginePid = engineProcessIds(engineLog);
  assert.equal(firstEnginePid.length, 1, engineLog);

  const added = await post('/api/command?workspace=live', { type: 'add_account', entityId: 'personal', name: 'Synthetic cash', accountType: 'cash', openingBalanceCents: 100_000, openingDate: '2026-01-01', expectedRevision: initialState.revision, requestId: 'engine-refresh-cash' });
  assert.equal(added.status, 200);
  const withAccount = await added.json() as AppState;
  assert.equal(withAccount.revision, initialState.revision + 1);
  const stale = await summaryResponse(initialState.revision);
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /records changed/i);
  const accountSummary = await summary(withAccount.revision);
  assert.equal(accountSummary.revision, withAccount.revision);
  assert.equal(accountSummary.result.summary.cashCents, 100_000);
  assert.equal(accountSummary.result.summary.netWorthCents, 100_000);
  assert.notEqual(accountSummary.inputHash, emptySummary.inputHash);

  const expense = await post('/api/command?workspace=live', { type: 'add_transaction', kind: 'expense', accountId: withAccount.accounts[0].id, amountCents: 2500, date: '2026-01-01', description: 'Synthetic food', category: 'Food', expectedRevision: withAccount.revision, requestId: 'engine-refresh-expense' });
  assert.equal(expense.status, 200);
  const saved = await expense.json() as AppState;
  const expenseSummary = await summary(saved.revision);
  assert.equal(expenseSummary.revision, saved.revision);
  assert.equal(expenseSummary.result.summary.cashCents, 97_500);
  assert.equal(expenseSummary.result.summary.expensesCents, 2500);
  assert.notEqual(expenseSummary.inputHash, accountSummary.inputHash);
  const beforeProjection = await state();
  const beforeDocuments = (await (await fetch(`${base}/api/documents?workspace=live`)).json()).documents;

  const identity = { scope: 'personal', asOf: '2026-01-02', expectedRevision: saved.revision };
  const calendarResponse = await post('/api/engine/project?workspace=live', { ...identity, kind: 'spending_calendar', draft: { month: '2026-01' } });
  assert.equal(calendarResponse.status, 200, await calendarResponse.clone().text());
  const calendar = await calendarResponse.json() as EngineEnvelope<SpendingCalendarProjection>;
  assert.equal(calendar.revision, saved.revision);
  assert.equal(calendar.result.data.totalCents, 2500);
  const payoffResponse = await post('/api/engine/project?workspace=live', { ...identity, kind: 'payoff', draft: { input: { balanceCents: 100_000, aprPercent: 0, monthlyPaymentCents: 10_000 }, extraPaymentCents: 10_000 } });
  assert.equal(payoffResponse.status, 200, await payoffResponse.clone().text());
  const payoff = await payoffResponse.json() as EngineEnvelope<PayoffProjection>;
  assert.equal(payoff.result.base.months, 10);
  assert.equal(payoff.result.extra.months, 5);

  const plannerResponse = await post('/api/engine/project?workspace=live', { ...identity, kind: 'planner', draft: {
    pay: '1000', mom: '0', debt: '0', living: '100', firstPayday: '2026-01-02', startMonth: '2026-02', months: '1', frequency: '26',
    investmentReturn: '0', extraDebt: '0', selectedDebtId: '', surplusDestination: 'cash', debts: {},
  } });
  assert.equal(plannerResponse.status, 200, await plannerResponse.clone().text());
  const planner = await plannerResponse.json() as EngineEnvelope<PlannerProjection>;
  assert.equal(planner.revision, saved.revision);
  assert.equal(planner.result.error, '');
  assert.equal(planner.result.input?.startingCashCents, 97_500);
  assert.equal(planner.result.input?.payCents, 100_000);
  assert.equal(planner.result.result?.days.length, 28);
  const dailyResponse = await post('/api/engine/project?workspace=live', { ...identity, kind: 'daily_plan', draft: { days: 7 } });
  assert.equal(dailyResponse.status, 200, await dailyResponse.clone().text());
  const daily = await dailyResponse.json() as EngineEnvelope<DailyPlan>;
  assert.equal(daily.revision, saved.revision);
  assert.equal(daily.result.asOf, identity.asOf);
  assert.equal(daily.result.cashCents, 97_500);
  assert.equal(daily.result.days.length, 7);

  assert.deepEqual(await state(), beforeProjection);
  assert.deepEqual((await (await fetch(`${base}/api/documents?workspace=live`)).json()).documents, beforeDocuments);
  assert.equal(createHash('sha256').update(readFileSync(originalPath)).digest('hex'), originalHash);
  const downloaded = await fetch(`${base}/api/documents/${document.id}/content?workspace=live`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original);
  assert.deepEqual(engineProcessIds(engineLog), firstEnginePid);
  assert.equal(child.exitCode, null);
});
