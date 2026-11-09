import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { DailyPlan, DailyPlanEvent } from '../shared/engine.ts';
import type { HomeNavigate } from './features/home/HomeNextUp.tsx';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: HomeCashPreview } = await import('./features/home/HomeCashPreview.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
let plan: DailyPlan;
const routes: Parameters<HomeNavigate>[] = [];
const openedEvents: DailyPlanEvent[] = [];
const dateAfter = (days: number) => { const date = new Date('2026-10-15T12:00:00Z'); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };

function dailyPlan(): DailyPlan {
  const events: DailyPlanEvent[] = [
    { id: 'bill-instance', sourceType: 'obligation', sourceId: 'bill', entityId: 'personal', name: 'Car payment', date: dateAfter(3), effectiveDate: dateAfter(3), direction: 'out', amountCents: 30000, status: 'upcoming', isProjection: false, includedInCashflow: true, accountId: 'cash', note: '' },
    { id: 'unknown-instance', sourceType: 'debt', sourceId: 'unknown', entityId: 'personal', name: 'Card minimum', date: dateAfter(3), effectiveDate: dateAfter(3), direction: 'out', amountCents: null, status: 'upcoming', isProjection: false, includedInCashflow: false, accountId: 'card', note: 'Minimum unknown' },
    { id: 'excluded-instance', sourceType: 'expense', sourceId: 'excluded', entityId: 'personal', name: 'Subscription on card', date: dateAfter(3), effectiveDate: dateAfter(3), direction: 'out', amountCents: 4500, status: 'upcoming', isProjection: true, includedInCashflow: false, accountId: 'card', note: 'Paid from credit' },
    { id: 'pay-instance', sourceType: 'payday', sourceId: 'pay', entityId: 'personal', name: 'Payday', date: dateAfter(10), effectiveDate: dateAfter(10), direction: 'in', amountCents: 200000, status: 'upcoming', isProjection: true, includedInCashflow: true, accountId: 'cash', note: '' },
  ];
  return {
    asOf: dateAfter(0), endDate: dateAfter(29), horizonDays: 30, status: 'partial',
    cashCents: 100000, protectedCents: 10000, cashAfterKnownCents: 240000,
    knownIncomeCents: 200000, knownOutflowCents: 30000, livingCostsCents: 30000,
    lowestCashCents: 60000, lowestCashDate: dateAfter(9), firstShortfallDate: null,
    nextPayday: { date: dateAfter(10), amountCents: 200000 }, todayPayday: null,
    beforePayday: { endDate: dateAfter(9), knownIncomeCents: 0, knownOutflowCents: 30000, cashAfterKnownCents: 60000 },
    events,
    days: Array.from({ length: 30 }, (_, index) => {
      const closingCashCents = 100000 - (index + 1) * 1000 - (index >= 3 ? 30000 : 0) + (index >= 10 ? 200000 : 0);
      return { date: dateAfter(index), incomeCents: index === 10 ? 200000 : 0, outflowCents: index === 3 ? 30000 : 0, livingCostsCents: 1000, closingCashCents, afterProtectedCents: closingCashCents - 10000, eventIds: events.filter(event => event.effectiveDate === dateAfter(index)).map(event => event.id) };
    }),
    missingInputs: [{ field: 'card.minimum', message: 'Confirm your card minimum.', section: 'debts', sourceId: 'unknown' }], warnings: [],
  };
}
beforeEach(async () => {
  await act(async () => root.unmount()); root = createRoot(container);
  plan = dailyPlan(); routes.length = 0; openedEvents.length = 0;
});
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });
async function render(value: DailyPlan | null = plan) {
  await act(async () => root.render(createElement(HomeCashPreview, { plan: value, onNavigate: (...route) => { routes.push(route); }, onEvent: event => { openedEvents.push(event); } })));
}
function input(label: string) {
  const node = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(node, `Missing ${label} input`);
  return node;
}
async function fill(label: string, value: string) {
  const node = input(label);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label);
  assert.ok(button, `Missing ${label} action`);
  await act(async () => button.click());
}
const selectedAmount = () => container.querySelector('.home-cash-selected-amount')!.textContent;

async function chooseSpendDate(value: string) {
  const label = [...container.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.startsWith('Spend date'));
  assert.ok(label, 'Missing Spend date label');
  const node = document.getElementById(label.htmlFor) as HTMLSelectElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('change', { bubbles: true })); });
}

test('the date control changes daily details, bounds shorter periods and focuses the lowest day', async () => {
  await render();
  const slider = input('Inspect Home cash forecast date');
  assert.equal(slider.type, 'range');
  assert.equal(slider.max, '29');
  assert.equal(selectedAmount(), '$890');
  await act(async () => slider.focus());
  assert.equal(document.activeElement, slider);
  await fill('Inspect Home cash forecast date', '3');
  assert.equal(selectedAmount(), '$560');
  assert.match(slider.getAttribute('aria-valuetext')!, /Oct 18, \$560, end of day after reserves/);
  assert.match(container.querySelector('.home-cash-day-details')!.textContent!, /Car payment/);
  await fill('Inspect Home cash forecast date', '20');
  await click('Next 7 days');
  assert.equal(slider.max, '6');
  assert.equal(slider.value, '6');
  assert.equal(selectedAmount(), '$530');
  assert.equal(container.querySelector('[aria-label="Cash forecast period"] [aria-pressed="true"]')!.textContent, 'Next 7 days');
  await click('Next 14 days');
  assert.equal(slider.max, '13');
  await click('Jump to lowest balance');
  assert.equal(slider.value, '10');
  assert.equal(document.activeElement, slider);
  assert.equal(selectedAmount(), '$2,490');
  assert.match(container.querySelector('.home-cash-day-totals')!.textContent!, /Before deposits \$490/);
});

test('spending previews preserve cents, apply from the chosen date and reset without changing saved data', async () => {
  const original = structuredClone(plan);
  await render();
  await click('$50');
  assert.equal(input('Extra cash spending').value, '50');
  assert.equal(selectedAmount(), '$840');
  assert.match(container.querySelector('.home-cash-impact')!.textContent!, /\$2,250/);
  assert.ok(container.querySelector('.home-cash-baseline'));
  await fill('Extra cash spending', '12.34');
  await fill('Inspect Home cash forecast date', '3');
  assert.equal(selectedAmount(), '$547.66');
  await chooseSpendDate(dateAfter(4));
  assert.equal(input('Inspect Home cash forecast date').value, '4');
  assert.equal(selectedAmount(), '$537.66');
  assert.match(container.querySelector('.home-cash-day-details')!.textContent!, /Extra spending preview\$12.34/);
  await fill('Inspect Home cash forecast date', '3');
  assert.equal(selectedAmount(), '$560');
  await click('Reset preview');
  assert.equal(input('Extra cash spending').value, '');
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, plan.asOf);
  assert.equal(selectedAmount(), '$560');
  assert.equal(container.querySelector('.home-cash-baseline'), null);
  assert.deepEqual(plan, original);
  assert.deepEqual(routes, []);
  assert.deepEqual(openedEvents, []);
});

test('partial forecasts retain unknown and excluded events and open their source records', async () => {
  await render();
  await fill('Inspect Home cash forecast date', '3');
  const details = container.querySelector('.home-cash-day-details')!;
  const buttons = [...details.querySelectorAll<HTMLButtonElement>('li button')];
  assert.equal(buttons.length, 3);
  assert.match(buttons[1].textContent!, /Card minimum.*Not included in forecast.*Amount needed/);
  assert.doesNotMatch(buttons[1].textContent!, /\$0/);
  assert.match(buttons[2].textContent!, /Subscription on card.*Not included in forecast.*\$45/);
  assert.match(container.querySelector('.home-cash-footnote')!.textContent!, /Incomplete forecast. Unknown amounts are not included./);
  for (const button of buttons) await act(async () => button.click());
  assert.deepEqual(openedEvents, plan.events.slice(0, 3));
  await click('Review 1 missing detail');
  assert.deepEqual(routes, [['simulations']]);
  assert.equal(selectedAmount(), '$560');
});

test('a plan refresh hides stale cash during loading and retains the date, period and spending amount', async () => {
  await render();
  await click('Next 7 days');
  await fill('Extra cash spending', '12.34');
  await chooseSpendDate(dateAfter(2));
  await fill('Inspect Home cash forecast date', '3');
  assert.equal(selectedAmount(), '$547.66');
  await render(null);
  assert.equal(container.querySelector('.home-cash-preview'), null);
  assert.equal(container.textContent, '');
  const refreshed = { ...plan, cashCents: plan.cashCents + 25000, days: plan.days.map(day => ({ ...day, closingCashCents: day.closingCashCents + 25000, afterProtectedCents: day.afterProtectedCents + 25000 })) };
  await render(refreshed);
  assert.equal(input('Extra cash spending').value, '12.34');
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, dateAfter(2));
  assert.equal(input('Inspect Home cash forecast date').value, '3');
  assert.equal(input('Inspect Home cash forecast date').max, '6');
  assert.equal(selectedAmount(), '$797.66');
  assert.equal(container.querySelector('[aria-label="Cash forecast period"] [aria-pressed="true"]')!.textContent, 'Next 7 days');
});

test('invalid spending amounts show a correction instead of a financial result and recover in place', async () => {
  await render();
  for (const value of ['-1', '12.345', '1000000.01']) {
    await fill('Extra cash spending', value);
    assert.equal(input('Extra cash spending').getAttribute('aria-invalid'), 'true');
    assert.equal(selectedAmount(), 'Check amount');
    assert.ok(container.querySelector('[role="alert"]'));
    assert.equal(container.querySelector('.home-cash-impact')!.textContent, 'Correct the amount to see its effect.');
    assert.equal(container.querySelector('.home-cash-baseline'), null);
  }
  await fill('Extra cash spending', '.25');
  assert.equal(input('Extra cash spending').getAttribute('aria-invalid'), 'false');
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(selectedAmount(), '$889.75');
});


test('a collapsed spending preview identifies amounts outside the selected dates and invalid input', async () => {
  await render();
  await fill('Extra cash spending', '50');
  await chooseSpendDate(dateAfter(20));
  await click('Next 7 days');
  const experiment = container.querySelector<HTMLDetailsElement>('.home-cash-experiment')!;
  assert.equal(experiment.open, false);
  assert.match(experiment.querySelector('summary')!.textContent!, /Purchase on Nov 4 is outside this view/);
  assert.match(container.querySelector('.home-cash-readout small')!.textContent!, /End of day/);
  assert.equal(container.querySelector('.home-cash-baseline'), null);
  await fill('Extra cash spending', '-1');
  assert.match(experiment.querySelector('summary')!.textContent!, /Check your preview amount/);
});
