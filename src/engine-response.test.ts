import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState } from '../shared/types.ts';
import type { EngineIdentity } from '../shared/engine.ts';
import { ENGINE_MODEL_VERSION } from '../shared/engine.ts';
import { plannerDefaults } from '../shared/planner-draft.ts';
import { engineFixtureFetch, engineFixtureResult } from './engine-test-fixture.ts';
import { getEngineRun, validateEngineEnvelope, type EngineResultKind } from './services/engine-api.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'localStorage'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) for (const extension of ['.ts', '.tsx']) { const url = new URL(`${specifier}${extension}`, context.parentURL); if (existsSync(url)) return nextResolve(url.href, context); }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Home } = await import('./features/home/Home.tsx');
const { default: Debts } = await import('./features/debts/Debts.tsx');
const { default: Investments } = await import('./features/investments/Investments.tsx');
const { default: SpendingCalendar } = await import('./features/expenses/SpendingCalendar.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });

const identity: EngineIdentity = { workspace: 'live', scope: 'personal', expectedRevision: 1, asOf: '2026-09-26' };
const state: AppState = {
  workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }],
  accounts: [
    { id: 'wallet', entityId: 'personal', name: 'Synthetic wallet', type: 'investment', currency: 'CAD', balanceCents: 100000, reconciledAt: null },
    { id: 'debt', entityId: 'personal', name: 'Synthetic loan', type: 'debt', currency: 'CAD', balanceCents: 100000, reconciledAt: null, debtTerms: { aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 10000, notes: '' } },
  ],
  positions: [{ id: 'position', accountId: 'wallet', liquidSol: '1', stakedSol: '2', rewardsSol: '0', priceCents: 1000, priceDate: '2026-09-26', costBasisCents: 1000 }],
  transactions: [], obligations: [], reserves: [], audit: [], lastBackupAt: null,
};
const props = { state, scope: 'personal', readOnly: false, motion: false, onCommand: async () => {}, onOpen() {}, onNavigate() {}, onAddAccount() {} };
const envelope = (result: unknown, current = identity) => ({ workspace: current.workspace, scope: current.scope, revision: current.expectedRevision, asOf: current.asOf, inputHash: 'synthetic-input-hash', modelVersion: ENGINE_MODEL_VERSION, result });
const plannerDraft = { ...plannerDefaults(state, 'personal', identity.asOf), months: '1', pay: '1000', living: '100', mom: '0', debt: '0', extraDebt: '0', frequency: '26', firstPayday: identity.asOf, investmentReturn: '0' };
const valid = (kind: EngineResultKind): unknown => {
  if (kind === 'comparison') return { status: 'needs_inputs', missingInputs: [{ field: 'reserveCents', message: 'Confirm a reserve.' }], warnings: [], assumptions: {}, bestPolicyId: null, comparisonNote: 'Missing reserve', policies: [] };
  if (kind === 'spending') return { status: 'insufficient_history', completeWeeks: 0, minimumWeeks: 12, weeklyEstimateCents: null, selectedModel: null, models: [], limitations: ['No covered weeks.'] };
  return engineFixtureResult(state, 'personal', identity.asOf, kind, kind === 'daily_plan' ? { days: 30 } : kind === 'planner' ? plannerDraft : kind === 'payoff' ? { input: { balanceCents: 100000, aprPercent: 0, monthlyPaymentCents: 10000 }, extraPaymentCents: 0 } : { month: '2026-09' });
};

for (const kind of ['summary', 'spending_calendar', 'daily_plan', 'payoff', 'planner', 'comparison', 'spending'] as const) {
  test(`${kind} accepts its complete result and rejects empty or unrelated results`, () => {
    const result = valid(kind);
    assert.equal(validateEngineEnvelope(envelope(result), identity, kind).result, result);
    assert.throws(() => validateEngineEnvelope(envelope({}), identity, kind), /incomplete calculation/);
    assert.throws(() => validateEngineEnvelope(envelope({ value: 'wrong response kind' }), identity, kind), /incomplete calculation/);
  });
}

test('current calculations reject earlier or unknown financial engine versions', () => {
  for (const modelVersion of ['mazal-engine-3', 'unknown-model']) {
    assert.throws(() => validateEngineEnvelope({ ...envelope(valid('summary')), modelVersion }, identity, 'summary'), /different financial engine version/);
  }
});

test('browser and Python engine agree on the financial model version', () => {
  const python = readFileSync(new URL('../backend/mazal_engine/__init__.py', import.meta.url), 'utf8');
  assert.equal(python.match(/MODEL_VERSION = "([^"]+)"/)?.[1], ENGINE_MODEL_VERSION);
});

test('production planner contract supports five years and resolves all owners to the personal plan', () => {
  const current = { ...identity, scope: 'all' };
  const result = engineFixtureResult(state, current.scope, current.asOf, 'planner', { ...plannerDraft, months: '60' }) as { error: string; result: { months: unknown[] }; derived: { startingInvestments: number } };
  assert.equal(result.error, '');
  assert.equal(result.result.months.length, 60);
  assert.equal(result.derived.startingInvestments, 100000);
  assert.equal(validateEngineEnvelope(envelope(result, current), current, 'planner').result, result);
});

test('production summary fixture respects the requested historical date', () => {
  const records = structuredClone(state);
  const expense = { id: 'earlier', date: '2026-09-10', description: 'Recorded expense', kind: 'expense' as const, amountCents: 100, accountId: 'wallet', toAccountId: null, category: 'Other', source: '', createdAt: '' };
  records.transactions = [expense, { ...expense, id: 'later', date: '2026-09-30', amountCents: 200 }];
  const result = (asOf: string) => engineFixtureResult(records, 'personal', asOf, 'summary') as { summary: { expensesCents: number } };
  assert.equal(result('2026-09-26').summary.expensesCents, 100);
  assert.equal(result('2026-09-30').summary.expensesCents, 300);
});

test('summary rejects missing debt rows, missing position fields, nonfinite and unsafe money', () => {
  for (const change of [
    (result: any) => { delete result.debtOverview.rows; },
    (result: any) => { delete result.investmentBreakdown.positions; },
    (result: any) => { result.investmentBreakdown.positions.position.totalSol = '3'; },
    ...[null, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(value => (result: any) => { result.summary.netWorthCents = value; }),
  ]) {
    const result = structuredClone(valid('summary'));
    change(result);
    assert.throws(() => validateEngineEnvelope(envelope(result), identity, 'summary'), /incomplete calculation/);
  }
});

test('spending diagnostics accept optional refit identity and reject broken priors or intervals', () => {
  const result = { status: 'ready', completeWeeks: 20, minimumWeeks: 12, weeklyEstimateCents: 10000, selectedModel: 'bayesian', models: [{ id: 'bayesian', converged: true, holdoutMaeCents: 100, prior: { mu: { meanCents: 10000, sigmaCents: 1000 }, sigma: { sigmaCents: 500 }, nu: 4 } }], limitations: [], weeklyPredictiveIntervalCents: [5000, 15000], refitDiagnostics: { converged: true } };
  assert.equal(validateEngineEnvelope(envelope(result), identity, 'spending').result, result);
  assert.throws(() => validateEngineEnvelope(envelope({ ...result, weeklyPredictiveIntervalCents: [15000, 5000] }), identity, 'spending'), /incomplete calculation/);
  assert.throws(() => validateEngineEnvelope(envelope({ ...result, models: [{ id: 'bayesian', converged: true, prior: {} }] }), identity, 'spending'), /incomplete calculation/);
});

test('malformed worker error and progress fields fail before rendering', async () => {
  for (const run of [{ id: 'run1', status: 'running', progress: {} }, { id: 'run1', status: 'failed', error: {} }, { id: 'run1', status: 'failed', error: '' }]) {
    globalThis.fetch = async () => Response.json(run);
    await assert.rejects(getEngineRun('run1', 'live'), /unreadable run status/);
  }
});

for (const page of [
  { name: 'Home', render: () => createElement(Home, props), malformed: { summary: {} } },
  { name: 'Debts', render: () => createElement(Debts, props), malformed: {} },
  { name: 'Investments', render: () => createElement(Investments, props), malformed: { investmentBreakdown: {} } },
  { name: 'Spending calendar', render: () => createElement(SpendingCalendar, { state, scope: 'personal', asOf: identity.asOf }), malformed: { data: {} } },
]) {
  test(`${page.name} shows a retryable error for malformed calculations and recovers`, async () => {
    globalThis.fetch = async (url, init) => {
      const query = new URL(String(url), 'http://localhost');
      const request = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(query.searchParams);
      return Response.json(envelope(page.malformed, { ...identity, scope: request.scope, asOf: request.asOf }));
    };
    await act(async () => root.render(page.render()));
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /incomplete calculation/);
    assert.doesNotMatch(container.textContent!, /NaN|page could not be displayed/);
    if (page.name === 'Debts') assert.match(container.textContent!, /Synthetic loan/);
    if (page.name === 'Investments') assert.match(container.textContent!, /Synthetic wallet/);
    globalThis.fetch = engineFixtureFetch(() => state);
    await act(async () => { for (const button of container.querySelectorAll<HTMLButtonElement>('button')) if (button.textContent === 'Retry calculation') button.click(); });
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.doesNotMatch(container.textContent!, /NaN|incomplete calculation/);
  });
}

test('Investment outage keeps saved positions and controls without a false loading state or stake percentage', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Engine is unavailable' }, { status: 503 });
  await act(async () => root.render(createElement(Investments, props)));
  assert.match(container.textContent!, /Synthetic wallet/);
  assert.match(container.textContent!, /Staked 2 SOL/);
  assert.match(container.textContent!, /Unstaked 1 SOL/);
  assert.match(container.textContent!, /Unavailable/);
  assert.doesNotMatch(container.textContent!, /Calculating/);
  assert.equal(container.querySelector('.portfolio-stake-bar'), null);
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent === 'Update SOL'));
  const accounts = container.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="false"]')!;
  await act(async () => accounts.click());
  assert.equal(accounts.getAttribute('aria-selected'), 'true');
});

test('the cash-holding comparison policy permits its explicit absent investment share', () => {
  const result = { ...(valid('comparison') as Record<string, unknown>), status: 'ready', missingInputs: [], bestPolicyId: 'cash', policies: [{ id: 'cash', name: 'Hold surplus cash', investmentShare: null, eligible: true, netWorthCents: 100000, totalInvestmentContributionsCents: 0, totalInterestCents: 0, lowestCashCents: 100000, reserveGapCents: 0, maxUnfundedCents: 0, debtFreeDate: null, weekly: [], monthly: [], scenarios: [] }] };
  assert.equal(validateEngineEnvelope(envelope(result), identity, 'comparison').result, result);
});


test('daily cash plans reject missing dates, unsafe cash, invalid event amounts and incomplete horizons', () => {
  for (const change of [
    (result: any) => { result.days.pop(); },
    (result: any) => { result.days[1].date = result.days[0].date; },
    (result: any) => { result.cashAfterKnownCents = Number.MAX_SAFE_INTEGER + 1; },
    (result: any) => { result.nextPayday = { date: '2026-02-30', amountCents: null }; },
    (result: any) => { result.status = 'ready'; },
    (result: any) => { result.events = [{ id: 'bad', sourceType: 'debt', sourceId: 'debt', entityId: 'personal', name: 'Debt', date: identity.asOf, effectiveDate: identity.asOf, direction: 'out', amountCents: null, status: 'today', isProjection: false, includedInCashflow: true, accountId: 'debt', note: '' }]; },
  ]) {
    const result = structuredClone(valid('daily_plan'));
    change(result);
    assert.throws(() => validateEngineEnvelope(envelope(result), identity, 'daily_plan'), /incomplete calculation/);
  }
});

test('daily cash plans validate the current payday before offering receipt actions', () => {
  const result = valid('daily_plan') as Record<string, unknown>;
  const receipt = { date: identity.asOf, amountCents: 200_000, receiptStatus: 'unconfirmed' };
  for (const todayPayday of [
    null,
    receipt,
    { ...receipt, amountCents: null },
    { ...receipt, receiptStatus: 'recorded', transactionId: 'recorded-pay' },
  ]) {
    const value = { ...result, todayPayday };
    assert.equal(validateEngineEnvelope(envelope(value), identity, 'daily_plan').result, value);
  }
  for (const todayPayday of [
    undefined,
    {},
    { ...receipt, date: '2026-02-30' },
    { ...receipt, date: '2026-09-27' },
    { ...receipt, amountCents: '200000' },
    { ...receipt, amountCents: -1 },
    { ...receipt, amountCents: Number.MAX_SAFE_INTEGER + 1 },
    { ...receipt, receiptStatus: 'unknown' },
    { ...receipt, receiptStatus: 'recorded' },
    { ...receipt, receiptStatus: 'recorded', transactionId: '' },
    { ...receipt, receiptStatus: 'recorded', transactionId: {} },
    { ...receipt, transactionId: 'contradictory-receipt' },
  ]) {
    assert.throws(() => validateEngineEnvelope(envelope({ ...result, todayPayday }), identity, 'daily_plan'), /incomplete calculation/);
  }
});
