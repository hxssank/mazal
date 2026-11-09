import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState } from '../shared/types.ts';
import type { AllocationComparison, EngineIdentity } from '../shared/engine.ts';
import { ENGINE_MODEL_VERSION } from '../shared/engine.ts';
import { plannerDefaults } from '../shared/planner-draft.ts';
import { today } from '../shared/analytics.ts';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event', 'MouseEvent', 'localStorage'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
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
const { useEngineProject, useEngineSummary } = await import('./services/useEngine.ts');
const { useEngineRun } = await import('./services/useEngineRun.ts');
const { default: FundingComparison } = await import('./features/planner/FundingComparison.tsx');
const { default: Simulations } = await import('./features/planner/Simulations.tsx');
const { engineFixtureFetch, engineFixtureResult } = await import('./engine-test-fixture.ts');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); localStorage.clear(); });
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });
function fixture(): AppState { return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'cash', entityId: 'personal', name: 'Cash', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null }; }
function envelope(identity: EngineIdentity, result: unknown) { return { workspace: identity.workspace, revision: identity.expectedRevision, scope: identity.scope, asOf: identity.asOf, inputHash: 'test-hash', modelVersion: ENGINE_MODEL_VERSION, result }; }
function Probe({ state, scope = 'personal', month = '2026-09', asOf = '2026-09-26' }: { state: AppState; scope?: string; month?: string; asOf?: string }) { const engine = useEngineProject<{ value: string }>(state, scope, asOf, { kind: 'spending_calendar', draft: { month } }); return createElement('p', { role: engine.error ? 'alert' : 'status' }, engine.data?.value ?? (engine.error || 'Loading')); }
function calendarResult(value: string) { return { ...(engineFixtureResult(fixture(), 'personal', '2026-09-26', 'spending_calendar', { month: '2026-09' }) as object), value }; }
function SummaryUnlockProbe({ state }: { state: AppState }) { const engine = useEngineSummary(state, 'personal', '2026-09-26'); return createElement('p', null, engine.error || (engine.data ? 'Ready' : 'Loading')); }
function PlanUnlockProbe({ state }: { state: AppState }) { const engine = useEngineProject(state, 'personal', '2026-09-26', { kind: 'daily_plan', draft: { days: 30 } }); return createElement('p', null, engine.error || (engine.data ? 'Ready' : 'Loading')); }
async function fill(label: string, value: string) { const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; assert.ok(input); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
function button(label: string) { const element = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label); assert.ok(element, `Button ${label} exists`); return element; }

test('late projections cannot replace changed drafts, scopes, workspaces, dates, or revisions', async () => {
  const pending: { identity: EngineIdentity; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = async (_url, init) => new Promise(resolve => pending.push({ identity: JSON.parse(String(init?.body)), signal: init!.signal!, resolve }));
  let state = fixture();
  await act(async () => root.render(createElement(Probe, { state })));
  await act(async () => root.render(createElement(Probe, { state, month: '2026-10' })));
  assert.equal(pending[0].signal.aborted, true);
  await act(async () => pending[0].resolve(Response.json(envelope(pending[0].identity, calendarResult('Old month')))));
  assert.equal(container.textContent, 'Loading');
  await act(async () => pending[1].resolve(Response.json(envelope(pending[1].identity, calendarResult('Current month')))));
  assert.equal(container.textContent, 'Current month');
  state = { ...state, revision: 2 };
  await act(async () => root.render(createElement(Probe, { state, month: '2026-10', scope: 'all', asOf: '2026-09-27' })));
  assert.equal(container.textContent, 'Loading');
  await act(async () => root.render(createElement(Probe, { state: { ...state, workspace: 'demo' }, month: '2026-10', scope: 'all', asOf: '2026-09-27' })));
  assert.equal(pending[2].signal.aborted, true);
  await act(async () => pending[2].resolve(Response.json(envelope(pending[2].identity, calendarResult('Other workspace')))));
  assert.equal(container.textContent, 'Loading');
  await act(async () => pending[3].resolve(Response.json(envelope(pending[3].identity, calendarResult('Sandbox result')))));
  assert.equal(container.textContent, 'Sandbox result');
});

test('a mismatched engine result and an unavailable engine produce visible errors', async () => {
  globalThis.fetch = async (_url, init) => Response.json(envelope({ ...JSON.parse(String(init?.body)), expectedRevision: 500 }, calendarResult('Wrong record values')));
  await act(async () => root.render(createElement(Probe, { state: fixture() })));
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /does not match the current records/);
  assert.doesNotMatch(container.textContent!, /Wrong record/);
  globalThis.fetch = async () => { throw new Error('Unavailable'); };
  await act(async () => root.render(createElement(Probe, { state: { ...fixture(), revision: 2 } })));
  assert.match(container.textContent!, /Python engine is unavailable/);
});

function comparisonResult(): AllocationComparison {
  const checkpoint = { startDate: '2026-09-26', endDate: '2026-09-27', partial: true, incomeCents: 200000, spendingCents: 50000, requiredDebtCents: 10000, extraDebtCents: 5000, investmentCents: 35000, openingCashCents: 100000, closingCashCents: 200000, unfundedCents: 0 };
  return { status: 'ready', missingInputs: [], warnings: ['Taxes and inflation are excluded.'], assumptions: { months: 60, reserveCents: 50000, annualReturnPercent: 0, shockPercent: -30, shockMonth: 3, seed: 42, userInvestmentShare: .5 }, bestPolicyId: 'mixed', comparisonNote: 'Best tested policy under these assumptions.', policies: [{ id: 'mixed', name: 'Mixed allocation', investmentShare: .5, eligible: true, netWorthCents: 1234567, totalInvestmentContributionsCents: 345678, totalInterestCents: 12345, lowestCashCents: 50000, reserveGapCents: 0, maxUnfundedCents: 0, debtFreeDate: '2027-02-01', weekly: [checkpoint], monthly: [{ ...checkpoint, endDate: '2026-09-30', investmentCents: 76543 }], scenarios: [{ id: 'market-shock', name: 'Market falls 30%', netWorthCents: 999999, lossVsBaseCents: 234568, shockLossCents: 10000, investmentGrowthCents: 0, differenceVsCashCents: -1234, maxUnfundedCents: 0, paychecksToReplace: 3 }] }] };
}
function comparisonProps(state = fixture()) { const draft = { ...plannerDefaults(state, 'personal', today()), pay: '2000', living: '500', frequency: '26', firstPayday: today() }; return { state, scope: 'personal', draft }; }
async function confirmReserve() { await fill('Protected cash reserve', '500'); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }

test('comparison requires a confirmed reserve and renders returned weekly, monthly, and setback amounts', async () => {
  let requests = 0;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => { requests++; body = JSON.parse(String(init?.body)); return Response.json({ id: 'run1', status: 'completed', result: envelope(body as unknown as EngineIdentity, comparisonResult()) }); };
  await act(async () => root.render(createElement(FundingComparison, comparisonProps())));
  await act(async () => button('Compare allocations').click());
  assert.equal(requests, 0);
  assert.match(container.textContent!, /Enter and confirm the cash reserve/);
  await confirmReserve();
  await act(async () => button('Compare allocations').click());
  assert.equal(requests, 1);
  assert.equal((body.assumptions as { reserveCents: number }).reserveCents, 50000);
  assert.match(container.textContent!, /\$12,345\.67/);
  assert.match(container.textContent!, /\$350/);
  assert.match(container.textContent!, /Partial period/);
  assert.match(container.textContent!, /Market falls 30%/);
  await act(async () => button('Monthly').click());
  assert.match(container.textContent!, /\$765\.43/);
  await fill('Comparison annual return', '4');
  assert.match(container.textContent!, /Records or assumptions changed/);
  assert.doesNotMatch(container.textContent!, /\$12,345\.67/);
});

test('active comparisons can be cancelled and input changes cancel workers', async () => {
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => { methods.push(init?.method ?? 'GET'); return Response.json({ id: 'run1', status: init?.method === 'DELETE' ? 'cancelled' : 'running' }); };
  await act(async () => root.render(createElement(FundingComparison, comparisonProps())));
  await confirmReserve();
  await act(async () => button('Compare allocations').click());
  assert.ok(container.querySelector('[role="status"]'));
  await act(async () => button('Cancel comparison').click());
  assert.match(container.textContent!, /Comparison cancelled/);
  assert.ok(methods.includes('DELETE'));
  await act(async () => button('Compare allocations').click());
  const deletions = methods.filter(method => method === 'DELETE').length;
  await fill('Comparison market setback', '-25');
  assert.ok(methods.filter(method => method === 'DELETE').length > deletions);
});

test('Planner keeps unsaved inputs after an unrelated category update while requesting a fresh projection', async () => {
  let state = fixture();
  globalThis.fetch = engineFixtureFetch(() => state);
  await act(async () => root.render(createElement(Simulations, { state, scope: 'personal', motion: false })));
  await fill('Pay per paycheck', '2345.67');
  state = { ...state, revision: 2, transactions: [] };
  await act(async () => root.render(createElement(Simulations, { state, scope: 'personal', motion: false })));
  assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Pay per paycheck"]')!.value, '2345.67');
});

test('spending analysis reports insufficient coverage without changing planning assumptions', async () => {
  let body: Record<string, unknown> = {};
  const props = comparisonProps();
  const original = structuredClone(props);
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ id: 'spending1', status: 'completed', result: envelope(body as unknown as EngineIdentity, { status: 'insufficient_history', completeWeeks: 3, minimumWeeks: 12, selectedModel: null, weeklyEstimateCents: null, models: [], limitations: ['Statements must cover every personal spending account.'] }) });
  };
  await act(async () => root.render(createElement(FundingComparison, props)));
  await act(async () => button('Analyze recorded spending').click());
  assert.equal(body.kind, 'spending');
  assert.deepEqual(body.assumptions, { seed: 42 });
  assert.match(container.textContent!, /3 complete weeks available/);
  assert.match(container.textContent!, /not enough covered history/);
  assert.match(container.textContent!, /No spending amount was changed/);
  assert.deepEqual(props, original);
});

test('spending analysis displays chronological validation and model convergence diagnostics', async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ id: 'spending2', status: 'completed', result: envelope(body, { status: 'ready', completeWeeks: 24, minimumWeeks: 12, selectedModel: 'median', weeklyEstimateCents: 12345, models: [{ id: 'median', converged: true, holdoutMaeCents: 500 }, { id: 'local_level', library: 'statsmodels', converged: true, holdoutMaeCents: 1000 }, { id: 'bayesian', library: 'PyMC', converged: false, holdoutMaeCents: null, maxRHat: 1.1, minEffectiveSampleSize: 230, divergences: 2, limitation: 'Posterior diagnostics failed.' }], limitations: ['No amount was applied.'], validation: { method: 'chronological_holdout', trainingWeeks: 18, holdoutWeeks: 6, trainingEnd: '2026-08-09', holdoutStart: '2026-08-10', selectionRule: 'A model must reduce baseline error by at least 5%.' } }) });
  };
  await act(async () => root.render(createElement(FundingComparison, comparisonProps())));
  await act(async () => button('Analyze recorded spending').click());
  const panel = container.querySelector('[aria-label="Spending analysis results"]')!;
  assert.match(panel.textContent!, /\$123\.45 estimated per week/);
  assert.match(panel.textContent!, /trained on 18 weeks/);
  assert.match(panel.textContent!, /statsmodels local level/);
  assert.match(panel.textContent!, /PyMC spending uncertainty/);
  assert.match(panel.textContent!, /Posterior diagnostics failed/);
  assert.match(panel.textContent!, /effective samples 230/);
});

test('scheduled income must be reconciled with regular pay and purchase dates travel with the run', async () => {
  const state = fixture();
  state.obligations = [{ id: 'payday', entityId: 'personal', name: 'Payday', accountId: 'cash', direction: 'in', category: 'Salary', amountCents: 200000, dueDate: today(), recurrence: 'biweekly', status: 'planned' }];
  state.assetPurchases = [{ id: 'car', entityId: 'personal', name: 'Car', payee: 'Family', targetCents: 100000, paidCents: 20000, monthlyCents: 10000, paidAsOf: today(), notes: '' }];
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body); return Response.json({ id: 'run1', status: 'completed', result: envelope(body, comparisonResult()) }); };
  await act(async () => root.render(createElement(FundingComparison, comparisonProps(state))));
  await fill('Protected cash reserve', '500');
  const checkbox = (text: string) => [...container.querySelectorAll('label')].find(item => item.textContent?.includes(text))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => checkbox('Use this confirmed cash reserve').click());
  await act(async () => button('Compare allocations').click());
  assert.equal(bodies.length, 0);
  assert.match(container.textContent!, /Confirm which scheduled income is already covered/);
  await act(async () => checkbox('My regular pay already covers').click());
  await fill('Car first modeled payment', '2026-12-01');
  await act(async () => button('Compare allocations').click());
  assert.deepEqual((bodies[0].assumptions as { additionalIncomeObligationIds: string[] }).additionalIncomeObligationIds, []);
  assert.deepEqual((bodies[0].assumptions as { purchaseFirstPaymentDates: Record<string, string> }).purchaseFirstPaymentDates, { car: '2026-12-01' });
});

function RunProbe({ kind, draftKey = 'same-inputs' }: { kind: 'comparison' | 'spending'; draftKey?: string }) {
  const run = useEngineRun({ workspace: 'live', scope: 'personal', expectedRevision: 1, asOf: '2026-09-26' }, draftKey, kind);
  return createElement('div', { 'data-running': String(run.running) },
    createElement('p', { role: 'status' }, `${run.run?.id ?? 'none'}:${run.run?.status ?? 'idle'}:${run.error}`),
    createElement('button', { onClick: () => run.start({ seed: 42 }) }, 'Start'),
    createElement('button', { onClick: run.cancel }, 'Cancel'));
}

for (const kind of ['comparison', 'spending'] as const) {
  for (const cancelling of [false, true]) {
    test(`${kind} resumes ${cancelling ? 'cancellation' : 'polling'} when unlock precedes a delayed locked response`, async () => {
      let resolveLocked: ((response: Response) => void) | undefined;
      const methods: string[] = [];
      globalThis.fetch = async (_url, init) => {
        const method = init?.method ?? 'GET';
        methods.push(method);
        if (method === 'POST') return Response.json({ id: 'delayed-lock', status: 'running' });
        if (!resolveLocked) return new Promise(resolve => { resolveLocked = resolve; });
        if (method === 'DELETE') return Response.json({ id: 'delayed-lock', status: 'cancelled' });
        const result = kind === 'comparison' ? comparisonResult() : { status: 'insufficient_history', completeWeeks: 0, minimumWeeks: 12, weeklyEstimateCents: null, selectedModel: null, models: [], limitations: [] };
        return Response.json({ id: 'delayed-lock', status: 'completed', result: envelope({ workspace: 'live', scope: 'personal', expectedRevision: 1, asOf: '2026-09-26' }, result) });
      };
      await act(async () => root.render(createElement(RunProbe, { kind })));
      await act(async () => button('Start').click());
      if (cancelling) await act(async () => button('Cancel').click());
      else await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
      assert.ok(resolveLocked, 'a request started before unlock is still in flight');
      await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
      await act(async () => resolveLocked!(Response.json({ error: 'Mazal is locked.' }, { status: 401 })));
      assert.match(container.textContent!, cancelling ? /delayed-lock:cancelled/ : /delayed-lock:completed/);
      assert.doesNotMatch(container.textContent!, /Unlock it/);
      assert.deepEqual(methods, cancelling ? ['POST', 'DELETE', 'DELETE'] : ['POST', 'GET', 'GET']);
    });
  }

  test(`${kind} retains an unlock received during a resumed cancellation request`, async () => {
    let cancellations = 0;
    let resolveLocked: ((response: Response) => void) | undefined;
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') return Response.json({ id: 'resumed-lock', status: 'running' });
      assert.equal(init?.method, 'DELETE');
      cancellations++;
      if (cancellations === 1) return Response.json({ error: 'Mazal is locked.' }, { status: 401 });
      if (cancellations === 2) return new Promise(resolve => { resolveLocked = resolve; });
      return Response.json({ id: 'resumed-lock', status: 'cancelled' });
    };
    await act(async () => root.render(createElement(RunProbe, { kind })));
    await act(async () => button('Start').click());
    await act(async () => button('Cancel').click());
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.ok(resolveLocked);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => resolveLocked!(Response.json({ error: 'Mazal is locked.' }, { status: 401 })));
    assert.match(container.textContent!, /resumed-lock:cancelled/);
    assert.equal(cancellations, 3);
  });

  test(`${kind} resumes a cancellation that supersedes a delayed unlock status request`, async () => {
    let reads = 0;
    let resolveStatus: ((response: Response) => void) | undefined;
    const cancellations: { url: string; resolve: (response: Response) => void }[] = [];
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'POST') return Response.json({ id: 'cancel-during-resume', status: 'running' });
      if (init?.method === 'DELETE') return new Promise(resolve => cancellations.push({ url: String(url), resolve }));
      if (++reads === 1) return Response.json({ error: 'Mazal is locked.' }, { status: 401 });
      return new Promise(resolve => { resolveStatus = resolve; });
    };
    await act(async () => root.render(createElement(RunProbe, { kind })));
    await act(async () => button('Start').click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.ok(resolveStatus, 'the unlock status request is still in flight');
    await act(async () => button('Cancel').click());
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => cancellations[0].resolve(Response.json({ error: 'Mazal is locked.' }, { status: 401 })));
    assert.equal(cancellations.length, 2, 'the newer unlock retries cancellation without waiting for the obsolete status request');
    await act(async () => resolveStatus!(Response.json({ id: 'cancel-during-resume', status: 'running' })));
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.equal(cancellations.length, 2, 'the obsolete status response cannot clear the newer cancellation request marker');
    await act(async () => cancellations[1].resolve(Response.json({ error: 'Mazal is locked.' }, { status: 401 })));
    assert.equal(cancellations.length, 3, 'an unlock during the retry still resumes cancellation');
    await act(async () => cancellations[2].resolve(Response.json({ id: 'cancel-during-resume', status: 'cancelled' })));
    assert.match(container.textContent!, /cancel-during-resume:cancelled/);
    assert.equal(container.querySelector('[data-running]')!.getAttribute('data-running'), 'false');
    assert.ok(cancellations.every(item => item.url.includes('/cancel-during-resume?workspace=live')));
    assert.equal(reads, 2);
  });

  test(`${kind} resumes the same worker after unlocking without creating or cancelling a run`, async () => {
    let unlocked = false;
    const requests: { method: string; url: string }[] = [];
    globalThis.fetch = async (url, init) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, url: String(url) });
      if (method === 'POST') return Response.json({ id: 'locked-worker', status: 'running' });
      if (!unlocked) return Response.json({ error: 'Mazal is locked.' }, { status: 401 });
      const result = kind === 'comparison' ? comparisonResult() : { status: 'insufficient_history', completeWeeks: 0, minimumWeeks: 12, weeklyEstimateCents: null, selectedModel: null, models: [], limitations: [] };
      return Response.json({ id: 'locked-worker', status: 'completed', result: envelope({ workspace: 'live', scope: 'personal', expectedRevision: 1, asOf: '2026-09-26' }, result) });
    };
    await act(async () => root.render(createElement(RunProbe, { kind })));
    await act(async () => button('Start').click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
    assert.match(container.textContent!, /Unlock it to resume this calculation/);
    assert.equal(container.querySelector('[data-running]')!.getAttribute('data-running'), 'true');
    assert.equal(requests.filter(row => row.method === 'DELETE').length, 0);
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.match(container.textContent!, /Unlock it to resume this calculation/);
    unlocked = true;
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    assert.match(container.textContent!, /locked-worker:completed/);
    assert.doesNotMatch(container.textContent!, /Unlock it/);
    assert.equal(container.querySelector('[data-running]')!.getAttribute('data-running'), 'false');
    assert.equal(requests.filter(row => row.method === 'POST').length, 1);
    assert.equal(requests.filter(row => row.method === 'DELETE').length, 0);
    assert.ok(requests.filter(row => row.method === 'GET').every(row => row.url.includes('/locked-worker?')));
  });

  test(`${kind} ignores a status response arriving after cancellation`, async () => {
    let resolvePoll: ((response: Response) => void) | undefined;
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') return Response.json({ id: 'first', status: 'running' });
      if (init?.method === 'DELETE') return Response.json({ id: 'first', status: 'cancelled' });
      return new Promise(resolve => { resolvePoll = resolve; });
    };
    await act(async () => root.render(createElement(RunProbe, { kind })));
    await act(async () => button('Start').click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
    assert.ok(resolvePoll, 'a status request is in flight');
    await act(async () => button('Cancel').click());
    assert.match(container.textContent!, /first:cancelled/);
    await act(async () => resolvePoll!(Response.json({ id: 'first', status: 'running' })));
    assert.match(container.textContent!, /first:cancelled/);
  });

  test(`${kind} preserves a cancellation requested while Mazal is locked`, async () => {
    let unlocked = false;
    const methods: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') return Response.json({ id: 'cancel-after-unlock', status: 'running' });
      if (!unlocked) return Response.json({ error: 'Mazal is locked.' }, { status: 401 });
      return Response.json({ id: 'cancel-after-unlock', status: method === 'DELETE' ? 'cancelled' : 'running' });
    };
    await act(async () => root.render(createElement(RunProbe, { kind })));
    await act(async () => button('Start').click());
    await act(async () => button('Cancel').click());
    assert.match(container.textContent!, /Unlock it to resume this calculation/);
    unlocked = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.match(container.textContent!, /cancel-after-unlock:cancelled/);
    assert.deepEqual(methods, ['POST', 'DELETE', 'DELETE']);
  });

  test(`${kind} ignores old cancellation when the same inputs start a new run`, async () => {
    let created = 0;
    const deletions: ((response: Response) => void)[] = [];
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'DELETE') return new Promise(resolve => deletions.push(resolve));
      return Response.json({ id: `run${++created}`, status: 'running' });
    };
    await act(async () => root.render(createElement(RunProbe, { kind })));
    await act(async () => button('Start').click());
    await act(async () => button('Cancel').click());
    await act(async () => button('Start').click());
    assert.match(container.textContent!, /run2:running/);
    await act(async () => deletions.forEach(resolve => resolve(Response.json({ id: 'run1', status: 'cancelled' }))));
    assert.match(container.textContent!, /run2:running/);
    await act(async () => root.render(null));
    await act(async () => deletions.forEach(resolve => resolve(Response.json({ id: 'run2', status: 'cancelled' }))));
  });

  test(`${kind} cancels a worker whose create response arrives after leaving the page`, async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    const cancelled: string[] = [];
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'DELETE') { cancelled.push(String(url)); return Response.json({ id: 'late-worker', status: 'cancelled' }); }
      return new Promise(resolve => { resolveCreate = resolve; });
    };
    await act(async () => root.render(createElement(RunProbe, { kind })));
    await act(async () => button('Start').click());
    await act(async () => root.render(null));
    await act(async () => resolveCreate!(Response.json({ id: 'late-worker', status: 'queued' })));
    assert.equal(cancelled.length, 1);
    assert.match(cancelled[0], /late-worker/);
  });
}

test('comparison drafts survive navigation and unrelated records while updated recorded income resets only that assumption', async () => {
  let state = fixture();
  state.roadmap = { transitionDate: '2027-01-01', partTimeMonthlyIncomeCents: null } as AppState['roadmap'];
  await act(async () => root.render(createElement(FundingComparison, comparisonProps(state))));
  await confirmReserve();
  await fill('Comparison annual return', '4');
  await fill('Monthly income after the change', '0');
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(FundingComparison, comparisonProps({ ...state, revision: 2 }))));
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Protected cash reserve"]')!.value, '500');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Comparison annual return"]')!.value, '4');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Monthly income after the change"]')!.value, '0');
  let submitted: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => { submitted = JSON.parse(String(init?.body)); return Response.json({ id: 'saved', status: 'completed', result: envelope(submitted as unknown as EngineIdentity, comparisonResult()) }); };
  await act(async () => button('Compare allocations').click());
  assert.deepEqual((submitted.assumptions as { incomeChanges: unknown }).incomeChanges, [{ date: '2027-01-01', monthlyIncomeCents: 0 }]);
  state = { ...state, revision: 3, roadmap: { ...state.roadmap!, partTimeMonthlyIncomeCents: 120000 } };
  await act(async () => root.render(createElement(FundingComparison, comparisonProps(state))));
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Monthly income after the change"]')!.value, '1200.00');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Protected cash reserve"]')!.value, '500');
  await act(async () => root.render(createElement(FundingComparison, comparisonProps({ ...state, workspace: 'demo' }))));
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Protected cash reserve"]')!.value, '');
});

test('blocked browser storage leaves comparison inputs usable and reports the unsaved draft', async () => {
  const prototype = Object.getPrototypeOf(localStorage);
  const original = prototype.setItem;
  prototype.setItem = () => { throw new Error('Storage blocked'); };
  try {
    await act(async () => root.render(createElement(FundingComparison, comparisonProps())));
    await fill('Protected cash reserve', '75');
    assert.match(container.textContent!, /Comparison draft could not be saved/);
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Protected cash reserve"]')!.value, '75');
    const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
    let navigated = false;
    await act(async () => { assert.equal(requestDraftNavigation(() => { navigated = true; }), false); });
    assert.equal(navigated, false);
    const dialog = document.querySelector<HTMLDialogElement>('.draft-discard-dialog')!;
    assert.ok(dialog.open);
    await act(async () => [...dialog.querySelectorAll('button')].find(item => item.textContent === 'Discard changes')!.click());
    assert.equal(navigated, true);
  } finally { prototype.setItem = original; }
});

for (const viaPlanner of [false, true]) for (const savedBeforeFailure of [false, true]) test(`${viaPlanner ? 'Planner comparison' : 'Comparison'} inputs survive changed income records when browser storage ${savedBeforeFailure ? 'stops working' : 'is blocked'}`, async () => {
  let state = fixture();
  state.roadmap = { transitionDate: '2027-01-01', partTimeMonthlyIncomeCents: null, payAmountCents: 100000 } as AppState['roadmap'];
  globalThis.fetch = engineFixtureFetch(() => state);
  const render = () => root.render(viaPlanner ? createElement(Simulations, { state, scope: 'personal', motion: false }) : createElement(FundingComparison, comparisonProps(state)));
  const prototype = Object.getPrototypeOf(localStorage);
  const original = prototype.setItem;
  const blockStorage = () => { prototype.setItem = () => { throw new Error('Storage blocked'); }; };
  try {
    if (!savedBeforeFailure) blockStorage();
    await act(async () => render());
    const disclosure = container.querySelector<HTMLDetailsElement>('.monthly-funding-disclosure');
    if (disclosure) disclosure.open = true;
    if (savedBeforeFailure) {
      await fill('Protected cash reserve', '50');
      await fill('Comparison annual return', '2');
      blockStorage();
    }
    await fill('Protected cash reserve', '75');
    await fill('Comparison annual return', '4');
    const annualReturn = container.querySelector<HTMLInputElement>('[aria-label="Comparison annual return"]')!;
    annualReturn.focus();
    state = { ...state, revision: 2, roadmap: { ...state.roadmap!, partTimeMonthlyIncomeCents: 120000 } };
    await act(async () => render());
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Protected cash reserve"]')!.value, '75');
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Comparison annual return"]'), annualReturn);
    assert.equal(annualReturn.value, '4');
    assert.equal(document.activeElement, annualReturn);
    assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Monthly income after the change"]')!.value, '1200.00');
    if (viaPlanner) {
      assert.equal(container.querySelector('.monthly-funding-disclosure'), disclosure);
      assert.equal(disclosure!.open, true);
      await fill('Pay per paycheck', '9999');
      state = { ...state, revision: 3, roadmap: { ...state.roadmap!, payAmountCents: 250000 } };
      await act(async () => render());
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Pay per paycheck"]')!.value, '2500');
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Protected cash reserve"]')!.value, '75');
      assert.equal(annualReturn.value, '4');
    }
    assert.match(container.textContent!, /Comparison draft could not be saved/);
    const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
    let navigated = false;
    await act(async () => { assert.equal(requestDraftNavigation(() => { navigated = true; }), false); });
    assert.equal(navigated, false);
    const dialog = document.querySelector<HTMLDialogElement>('.draft-discard-dialog')!;
    assert.ok(dialog.open);
    await act(async () => [...dialog.querySelectorAll('button')].find(item => item.textContent === 'Keep editing')!.click());
    assert.equal(annualReturn.value, '4');
    prototype.setItem = original;
    await fill('Comparison market setback', '-25');
    const saved = JSON.parse(localStorage.getItem('mazal.planner.funding.v1.live.personal')!);
    assert.equal(saved.draft.reserve, '75');
    assert.equal(saved.draft.annualReturn, '4');
    assert.equal(saved.draft.transitionIncome, '1200.00');
    assert.equal(saved.draft.transitionSourceKey, JSON.stringify(['2027-01-01', 120000]));
    assert.equal(requestDraftNavigation(() => { navigated = true; }), true);
    assert.equal(navigated, true);
  } finally { prototype.setItem = original; }
});

test('linked purchase bills replace assumed first payment inputs in funding comparisons', async () => {
  const state = fixture();
  state.assetPurchases = [{ id: 'car', entityId: 'personal', name: 'Car', payee: 'Seller', targetCents: 100000, paidCents: 0, monthlyCents: 10000, paidAsOf: today(), notes: '' }];
  state.obligations = [{ id: 'car-bill', assetPurchaseId: 'car', entityId: 'personal', name: 'Car installment', amountCents: 10000, dueDate: today(), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Transport' }];
  await act(async () => root.render(createElement(FundingComparison, comparisonProps(state))));
  assert.equal(container.querySelector('[aria-label="Car first modeled payment"]'), null);
  assert.match(container.querySelector('.funding-purchase-dates')!.textContent!, /Car linked payment schedule.*Car installment.*Uses these saved bill dates/);
  await confirmReserve();
  let submitted: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => { submitted = JSON.parse(String(init?.body)); return Response.json({ id: 'linked-purchase', status: 'completed', result: envelope(submitted as unknown as EngineIdentity, comparisonResult()) }); };
  await act(async () => button('Compare allocations').click());
  assert.deepEqual((submitted.assumptions as { purchaseFirstPaymentDates: unknown }).purchaseFirstPaymentDates, {});
});

for (const [kind, Component] of [['summary', SummaryUnlockProbe], ['daily plan', PlanUnlockProbe]] as const) {
  test(`${kind} retries an interrupted locked read once after unlock without a revision change`, async () => {
    const state = fixture(), successfulFetch = engineFixtureFetch(() => state);
    let requests = 0;
    let resumed: { url: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1]; resolve: (response: Response) => void } | undefined;
    globalThis.fetch = async (url, init) => {
      requests++;
      if (requests === 1) return Response.json({ error: 'Mazal is locked.' }, { status: 401 });
      return new Promise(resolve => { resumed = { url, init, resolve }; });
    };
    await act(async () => root.render(createElement(Component, { state })));
    assert.match(container.textContent!, /Mazal is locked/);
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(requests, 2);
    assert.equal(container.textContent, 'Loading');
    assert.ok(resumed);
    await act(async () => resumed!.resolve(await successfulFetch(resumed!.url, resumed!.init)));
    assert.equal(container.textContent, 'Ready');
    await act(async () => { window.dispatchEvent(new Event('focus')); root.render(createElement(Component, { state: { ...state } })); });
    assert.equal(requests, 2, 'healthy results do not restart on focus or a same-revision refresh');
  });
}

test('an unlock arriving before a delayed 401 response still retries the daily plan', async () => {
  const state = fixture(), successfulFetch = engineFixtureFetch(() => state);
  let requests = 0, rejectLocked: ((response: Response) => void) | undefined;
  globalThis.fetch = async (url, init) => {
    requests++;
    if (requests === 1) return new Promise(resolve => { rejectLocked = resolve; });
    return successfulFetch(url, init);
  };
  await act(async () => root.render(createElement(PlanUnlockProbe, { state })));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => rejectLocked!(Response.json({ error: 'Mazal is locked.' }, { status: 401 })));
  assert.equal(requests, 2);
  assert.equal(container.textContent, 'Ready');
});

test('foreground events do not automatically retry a non-authentication calculation failure', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ error: 'Calculation failed.' }, { status: 500 }); };
  await act(async () => root.render(createElement(SummaryUnlockProbe, { state: fixture() })));
  await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(requests, 1);
  assert.equal(container.textContent, 'Calculation failed.');
});
