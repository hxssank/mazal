import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState } from '../shared/types.ts';

const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: CompoundingPlan } = await import('./features/planner/CompoundingPlan.tsx');
after(() => hooks.deregister());

function fixture(): AppState {
  return {
    workspace: 'demo', revision: 1,
    entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }],
    accounts: [{ id: 'cash', entityId: 'personal', name: 'Bank account', type: 'cash', currency: 'CAD', balanceCents: 250000, reconciledAt: '2026-11-03' }],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
    roadmap: { growthTarget: 'lifetime_compounding', payAmountCents: 200000, payEveryDays: 14, paydayAnchor: '2026-11-05', planningCashReserveCents: 100000, incomeTransitionPlanned: false, currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: 100000, monthlyDebtMinimumsCents: null, transitionDate: '2027-01-01', transitionMonths: 1, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null },
  };
}

function render(state: AppState, loading = false) {
  return renderToStaticMarkup(createElement(CompoundingPlan, { state, ownerId: state.entities[0].id, plan: null, asOf: '2026-11-03', loading, onSetup() {}, onDebts() {}, onCompare() {} }));
}

test('the lifetime target stays visible without a forecast but does not authorize an investment amount', () => {
  const html = render(fixture());
  assert.match(html, /Lifetime compounding/);
  assert.match(html, /Target saved/);
  assert.match(html, /New investing now<\/dt><dd>Not confirmed<\/dd>/);
  assert.match(html, /Monthly estimate before extra dated costs and unknown payments\./);
});

test('loading hides the investment allowance and unsaved targets stay labelled as previews', () => {
  const state = fixture();
  state.roadmap!.growthTarget = null;
  const html = render(state, true);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Target preview/);
  assert.doesNotMatch(html, /Target saved/);
  assert.match(html, /New investing now<\/dt><dd>Checking…<\/dd>/);
});

test('personal compounding instructions do not appear for a business entity', () => {
  const state = fixture();
  state.entities[0].kind = 'business';
  assert.equal(render(state), '');
});

test('the saved plan shows estimated part-time income and the full-time return date before January', () => {
  const state = fixture();
  state.roadmap = { ...state.roadmap!, incomeTransitionPlanned: true,
    temporaryWorkSchedule: { weeklyHours: 20, fullTimeWeeklyHours: 40, returnDate: '2027-05-01', payPeriodEndLagDays: 5 } };
  const html = render(state);
  assert.match(html, /20 hours a week from Jan\.? 1, 2027/);
  assert.match(html, /Full-time hours resume May 1, 2027/);
  assert.match(html, /estimated take-home averages (?:CA)?\$2,166\.67 a month/);
});
