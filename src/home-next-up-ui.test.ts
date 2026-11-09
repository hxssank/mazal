import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Command, StatementBatch } from '../shared/types.ts';
import type { DailyPlan } from '../shared/engine.ts';
import { ENGINE_MODEL_VERSION } from '../shared/engine.ts';
import { today } from '../shared/analytics.ts';
import { engineFixtureFetch } from './engine-test-fixture.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Home } = await import('./features/home/Home.tsx');
const { default: HomeNextUp } = await import('./features/home/HomeNextUp.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
let state: AppState;
let plan: DailyPlan;
let unavailable = false;
let dailyRequests = 0;
const routes: [string, string | undefined, string | undefined][] = [];
const forms: [string, string | undefined][] = [];
const dateAfter = (days: number) => { const date = new Date(`${today()}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };

function batch(id: string, accountId: string, status: StatementBatch['status'] = 'staged'): StatementBatch {
  return { id, source: { id, accountId, sourceFile: `${id}.pdf`, sha256: id.repeat(64).slice(0, 64), periodStart: today(), periodEnd: today(), openingBalanceCents: 0, closingBalanceCents: 0, rows: [] }, decisions: [], status, createdAt: today(), committedAt: status === 'committed' ? today() : null };
}
function fixture(): AppState {
  return {
    workspace: 'live', revision: 1,
    entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 10000 }],
    accounts: [{ id: 'cash', entityId: 'personal', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }, { id: 'shop-bank', entityId: 'shop', name: 'Shop bank', type: 'cash', currency: 'CAD', balanceCents: 999999, reconciledAt: null }],
    transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
    importBatches: [batch('a', 'cash'), batch('b', 'shop-bank'), batch('c', 'cash', 'committed')],
  };
}
function dailyPlan(): DailyPlan {
  return {
    asOf: today(), endDate: dateAfter(29), horizonDays: 30, status: 'partial',
    cashCents: 100000, protectedCents: 10000, cashAfterKnownCents: 270000,
    knownIncomeCents: 200000, knownOutflowCents: 30000, livingCostsCents: 0,
    lowestCashCents: 70000, lowestCashDate: dateAfter(1), firstShortfallDate: null,
    nextPayday: { date: dateAfter(5), amountCents: 200000 },
    todayPayday: null,
    beforePayday: { endDate: dateAfter(4), knownIncomeCents: 0, knownOutflowCents: 30000, cashAfterKnownCents: 70000 },
    events: [
      { id: 'bill', sourceType: 'obligation', sourceId: 'bill', entityId: 'personal', name: 'Phone bill', date: dateAfter(-2), effectiveDate: today(), direction: 'out', amountCents: 8000, status: 'overdue', isProjection: false, includedInCashflow: true, accountId: 'cash', note: 'Check payment' },
      { id: 'card', sourceType: 'debt', sourceId: 'card', entityId: 'personal', name: 'Card minimum', date: dateAfter(1), effectiveDate: dateAfter(1), direction: 'out', amountCents: null, status: 'upcoming', isProjection: false, includedInCashflow: false, accountId: 'card', note: 'Minimum unknown' },
      { id: 'later', sourceType: 'obligation', sourceId: 'later', entityId: 'personal', name: 'Later bill', date: dateAfter(8), effectiveDate: dateAfter(8), direction: 'out', amountCents: 5000, status: 'upcoming', isProjection: false, includedInCashflow: true, accountId: 'cash', note: '' },
    ],
    days: Array.from({ length: 30 }, (_, index) => ({ date: dateAfter(index), incomeCents: 0, outflowCents: index === 0 ? 8000 : index === 8 ? 5000 : 0, livingCostsCents: 0, closingCashCents: index < 8 ? 92000 : 87000, afterProtectedCents: index < 8 ? 82000 : 77000, eventIds: index === 0 ? ['bill'] : index === 1 ? ['card'] : index === 8 ? ['later'] : [] })), missingInputs: [{ field: 'card.minimum', message: 'Confirm your card minimum.', section: 'debts', sourceId: 'card' }], warnings: [],
  };
}
beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  state = fixture(); plan = dailyPlan(); unavailable = false; dailyRequests = 0; routes.length = 0; forms.length = 0;
  const fallback = engineFixtureFetch(() => state);
  globalThis.fetch = async (url, init) => {
    const request = init?.body ? JSON.parse(String(init.body)) : null;
    if (request?.kind !== 'daily_plan') return fallback(url, init);
    dailyRequests++;
    if (unavailable) throw new Error('Engine offline');
    return Response.json({ workspace: state.workspace, revision: state.revision, scope: request.scope, asOf: request.asOf, inputHash: 'home-test', modelVersion: ENGINE_MODEL_VERSION, result: plan });
  };
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });
async function render(readOnly = false, onCommand: (command: Command) => Promise<void> = async () => {}) {
  await act(async () => root.render(createElement(Home, { state, scope: 'personal', readOnly, motion: false, onNavigate: (view, section, recordId) => { routes.push([view, section, recordId]); }, onOpen: (kind, accountId) => { forms.push([kind, accountId]); }, onCommand })));
}
const nextUp = () => container.querySelector<HTMLElement>('.home-next-up')!;

test('calendar records open in place and closing restores the selected day and focus', async () => {
  state.transactions.push({ id: 'calendar-entry', accountId: 'cash', toAccountId: null, kind: 'expense', amountCents: 1250, category: 'Food', description: 'Calendar coffee', date: today(), source: 'Manual entry', createdAt: `${today()}T12:00:00Z` });
  const commands: Command[] = [];
  await render(false, async command => { commands.push(command); });
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-date="${today()}"]`)!.click());
  const entry = container.querySelector<HTMLButtonElement>('.spend-calendar-entry-button')!;
  assert.ok(entry);
  await act(async () => { entry.focus(); entry.click(); });
  await act(async () => { await import('./components/RecordActions.tsx'); });
  const dialog = container.querySelector<HTMLDialogElement>('dialog')!;
  assert.ok(dialog?.open);
  assert.match(dialog.textContent!, /Calendar coffee/);
  assert.deepEqual(routes, []);
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close record"]')!.click());
  assert.equal(container.querySelector('dialog'), null);
  assert.equal(document.activeElement, entry);
  assert.equal(container.querySelector('.spend-calendar-day.is-selected')?.getAttribute('data-date'), today());
  assert.deepEqual(commands, []);
  await render(true);
  assert.equal(container.querySelector('.spend-calendar-entry-button'), null);
  assert.match(container.querySelector('.spend-calendar-entries')!.textContent!, /Calendar coffee/);
});

async function click(label: string) {
  const button = [...nextUp().querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(label));
  assert.ok(button, `Missing ${label} action`);
  const details = button.closest('details');
  if (details && !details.open) await act(async () => details.querySelector('summary')!.click());
  await act(async () => button.click());
}

test('Home shows actionable dates, unknown amounts and only pending statements in its scope', async () => {
  const original = structuredClone(state);
  await render();
  assert.match(nextUp().textContent!, /\$2,000 expected/);
  assert.match(nextUp().textContent!, /Phone bill.*Past date, check payment.*\$80/);
  assert.match(nextUp().textContent!, /Card minimum.*Amount needed/);
  assert.doesNotMatch(nextUp().textContent!, /Later bill/);
  assert.match(nextUp().textContent!, /1 statement is waiting to be added/);
  await click('Open Planner');
  await click('Edit pay schedule');
  await click('Phone bill');
  await click('Card minimum');
  await click('Review statements');
  assert.deepEqual(routes, [['simulations', undefined, undefined], ['expenses', 'schedule', undefined], ['expenses', 'schedule', 'bill'], ['debts', undefined, 'card'], ['documents', 'imports', 'a']]);
  assert.deepEqual(state, original);
  assert.ok(container.querySelector('.position-value'));
  assert.ok(container.querySelector('.spend-calendar'));
});

test('Home opens with a greeting, compact balances and read-only safe shortcuts', async () => {
  const commands: Command[] = [];
  await render(false, async command => { commands.push(command); });
  assert.match(container.querySelector('.home-welcome h2')!.textContent!, /^Good (morning|afternoon|evening)\.$/);
  assert.equal(container.querySelector('.home-welcome time')?.getAttribute('datetime'), today());
  const disclosures = [...container.querySelectorAll<HTMLDetailsElement>('.home-balance-details')];
  assert.equal(disclosures.length, 2);
  assert.ok(disclosures.every(details => !details.open));
  assert.equal(container.querySelector('.home-bank-total')?.textContent, '$1,000');
  assert.equal(container.querySelector('.position-value')?.textContent, '$1,000');
  assert.equal(container.querySelector('.home-welcome .primary'), null);
  assert.deepEqual(forms, []);
  await act(async () => disclosures[0].querySelector('summary')!.click());
  assert.equal(disclosures[0].open, true);
  assert.deepEqual(commands, []);
  await render(true);
  assert.equal(container.querySelector('.home-welcome .primary'), null);
  await act(async () => container.querySelector<HTMLButtonElement>('.home-welcome .secondary')!.click());
  assert.deepEqual(routes, [['documents', undefined, undefined]]);
  assert.match(container.querySelector('.home-record-status')!.textContent!, /Saved records preview/);
});

test('Home starts with cash and upcoming payments while calendar and forecast details stay collapsed', async () => {
  await render();
  const home = container.querySelector('.mazal-home')!;
  const cards = container.querySelector('.home-position-grid')!;
  const calendar = container.querySelector<HTMLDetailsElement>('.home-calendar-details')!;
  assert.ok(cards.firstElementChild?.classList.contains('home-bank-panel'));
  assert.ok(cards.lastElementChild?.classList.contains('home-worth-summary'));
  assert.ok(cards.children[1]?.classList.contains('home-outlook'));
  assert.equal(cards.nextElementSibling, nextUp());
  assert.ok(nextUp().nextElementSibling?.classList.contains('home-forecast-details'));
  assert.equal((nextUp().nextElementSibling as HTMLDetailsElement).open, false);
  assert.equal(nextUp().nextElementSibling?.nextElementSibling, calendar);
  assert.ok(calendar.nextElementSibling?.classList.contains('home-actions'));
  assert.equal(home.querySelector('[role="tablist"]'), null);
  assert.equal(calendar.open, false);
  await act(async () => calendar.querySelector('summary')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!.click());
  const chosenMonth = container.querySelector('.spend-calendar-navigation h3')!.textContent;
  await act(async () => calendar.querySelector('summary')!.click());
  state = { ...state, revision: 2 };
  await render();
  assert.equal(calendar.open, false);
  await act(async () => calendar.querySelector('summary')!.click());
  assert.equal(container.querySelector('.spend-calendar-navigation h3')!.textContent, chosenMonth);
});

test('Home separates cash, receivables and total debt from net-worth exclusions', async () => {
  addExcludedLoan();
  state.accounts.push({ id: 'owed', entityId: 'personal', name: 'Money owed to me', type: 'receivable', currency: 'CAD', balanceCents: 300000, reconciledAt: null });
  await render();
  assert.equal(container.querySelector('.home-bank-total')?.textContent, '$1,000');
  assert.equal(container.querySelector('.position-value')?.textContent, '$4,000');
  const metrics = container.querySelector<HTMLDetailsElement>('.home-worth-detail')!;
  assert.equal(metrics.open, false);
  await act(async () => metrics.querySelector('summary')!.click());
  const debt = [...metrics.querySelectorAll('button')].find(button => button.textContent?.startsWith('Total debt'))!;
  const receivables = [...metrics.querySelectorAll('button')].find(button => button.textContent?.startsWith('Owed to you'))!;
  assert.match(debt.textContent!, /Total debt\$5,000/);
  assert.match(receivables.textContent!, /Owed to you\$3,000/);
  assert.match(metrics.textContent!, /Total debt includes OSAP, excluded from the net worth above/);
  await act(async () => debt.click());
  await act(async () => receivables.click());
  assert.deepEqual(routes, [['debts', undefined, undefined], ['assets', undefined, undefined]]);
});

test('new saved records refresh totals without closing accounts or discarding a cash preview', async () => {
  await render();
  const details = container.querySelector<HTMLDetailsElement>('.home-bank-panel details')!;
  await act(async () => details.querySelector('summary')!.click());
  const forecast = container.querySelector<HTMLDetailsElement>('.home-forecast-details')!;
  await act(async () => forecast.querySelector('summary')!.click());
  await act(async () => forecast.querySelector<HTMLDetailsElement>('.home-cash-experiment')!.querySelector('summary')!.click());
  await act(async () => [...forecast.querySelectorAll('button')].find(button => button.textContent === '$50')!.click());
  state = { ...state, revision: 2, accounts: state.accounts.map(account => account.id === 'cash' ? { ...account, balanceCents: 125000 } : account) };
  await render();
  assert.equal(details.open, true);
  assert.equal(container.querySelector('.home-bank-total')?.textContent, '$1,250');
  assert.equal(container.querySelector('.position-value')?.textContent, '$1,250');
  assert.equal(forecast.open, true);
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Extra cash spending"]')!.value, '50');
  assert.ok(container.querySelector('.spend-calendar'));
});

test('the net-worth disclosure opens without saving a record', async () => {
  const commands: Command[] = [];
  await render(false, async command => { commands.push(command); });
  const details = container.querySelector<HTMLDetailsElement>('.home-worth-detail')!;
  assert.equal(details.open, false);
  const summary = details.querySelector('summary')!;
  await act(async () => { summary.focus(); summary.click(); });
  assert.equal(details.open, true);
  assert.equal(document.activeElement, summary);
  assert.deepEqual(commands, []);
  assert.deepEqual(routes, []);
});

test('Home keeps missing pay dates and amounts unknown and offers setup', async () => {
  plan.nextPayday = { date: dateAfter(5), amountCents: null };
  await render();
  assert.match(nextUp().querySelector('.home-next-pay')!.textContent!, /Take-home amount not confirmed/);
  assert.doesNotMatch(nextUp().querySelector('.home-next-pay')!.textContent!, /\$0/);
  plan = { ...plan, nextPayday: null, events: [], days: plan.days.map(day => ({ ...day, eventIds: [] })) };
  state = { ...state, revision: 2 };
  await render();
  assert.match(nextUp().textContent!, /Payday not available/);
  assert.match(nextUp().textContent!, /No saved payments through/);
  await click('Review pay schedule');
  assert.deepEqual(routes, [['expenses', 'schedule', undefined]]);
});

test('an engine failure removes old upcoming amounts while keeping Planner and Statements reachable', async () => {
  await render();
  unavailable = true;
  state = { ...state, revision: 2 };
  await render();
  assert.match(nextUp().textContent!, /Python engine is unavailable/);
  assert.match(nextUp().textContent!, /Dates unavailable/);
  assert.doesNotMatch(nextUp().textContent!, /\$2,000|Phone bill/);
  await click('Open Planner');
  await click('Review statements');
  assert.deepEqual(routes, [['simulations', undefined, undefined], ['documents', 'imports', 'a']]);
});


test('Home shares one forecast calculation and opens its details without changing records', async () => {
  const commands: Command[] = [];
  await render(false, async command => { commands.push(command); });
  assert.equal(dailyRequests, 1);
  const outlook = container.querySelector('.home-outlook')!;
  assert.equal(outlook.querySelector('.home-outlook-value')?.textContent, '$700');
  assert.equal(outlook.querySelector('time')?.getAttribute('datetime'), plan.beforePayday.endDate);
  assert.match(outlook.textContent!, /Incomplete forecast.*After \$100 set aside.*Some amounts need confirmation/);
  const forecast = container.querySelector<HTMLDetailsElement>('.home-forecast-details')!;
  forecast.scrollIntoView = () => {};
  await act(async () => outlook.querySelector<HTMLButtonElement>('button')!.click());
  assert.equal(forecast.open, true);
  assert.equal(document.activeElement, forecast.querySelector('summary'));
  assert.deepEqual(commands, []);
  assert.deepEqual(routes, []);
});

test('Home labels a cash shortfall even when the period ends above zero and clears stale forecast amounts on failure', async () => {
  plan.status = 'ready';
  plan.missingInputs = [];
  plan.firstShortfallDate = dateAfter(2);
  await render();
  const outlook = () => container.querySelector('.home-outlook')!;
  assert.ok(outlook().classList.contains('has-shortfall'));
  assert.equal(outlook().querySelector('.home-outlook-value')?.textContent, '$700');
  assert.match(outlook().textContent!, /Check cash or payment timing on/);
  unavailable = true;
  state = { ...state, revision: 2 };
  await render();
  assert.equal(outlook().querySelector('.home-outlook-value'), null);
  assert.match(outlook().textContent!, /Python engine is unavailable/);
  assert.equal(nextUp().querySelector('.home-payment-total'), null);
});

test('payment totals distinguish unknown amounts and update with the selected date window', async () => {
  const event = { ...plan.events[2], id: 'sixth-day', sourceId: 'sixth-day', date: dateAfter(6), effectiveDate: dateAfter(6) };
  plan.events.push(event);
  plan.days[6].eventIds.push(event.id);
  await render();
  const total = () => nextUp().querySelector('.home-payment-total')!;
  assert.equal(total().querySelector('strong')?.textContent, '$80 known');
  assert.match(total().textContent!, /2 payments · 1 amount needed/);
  await click('Next 7 days');
  assert.equal(total().querySelector('strong')?.textContent, '$130 known');
  assert.match(total().textContent!, /3 payments · 1 amount needed/);
  plan.events = [plan.events[1]];
  plan.days = plan.days.map(day => ({ ...day, eventIds: day.eventIds.filter(id => id === 'card') }));
  state = { ...state, revision: 2 };
  await render();
  assert.equal(total().querySelector('strong')?.textContent, 'Total not confirmed');
  assert.match(total().textContent!, /1 payment · 1 amount needed/);
  assert.doesNotMatch(total().textContent!, /\$0/);
});

test('Home bounds its payment summary to the calculated horizon when payday is farther away', async () => {
  plan = { ...plan, nextPayday: { date: dateAfter(59), amountCents: 200000 }, beforePayday: { ...plan.beforePayday, endDate: plan.endDate }, events: [], days: plan.days.map(day => ({ ...day, eventIds: [] })) };
  await render();
  const format = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(date.slice(0, 4) !== today().slice(0, 4) ? { year: 'numeric' as const } : {}), timeZone: 'UTC' });
  const payments = nextUp().querySelector('.home-next-payments')!;
  assert.equal(payments.querySelector('h3')?.textContent, `Payments through ${format(plan.endDate)}`);
  assert.match(payments.textContent!, /No saved payments through/);
  assert.ok(!payments.textContent!.includes(format(plan.nextPayday!.date)));
  assert.ok(nextUp().querySelector('.home-next-pay')!.textContent!.includes(format(plan.nextPayday!.date)));
});

test('the seven-day payment view includes today plus six days and preserves overdue and unknown payments', async () => {
  const edge = { ...plan.events[2], id: 'edge', sourceId: 'edge', name: 'Sixth-day bill', date: dateAfter(6), effectiveDate: dateAfter(6) };
  const outside = { ...edge, id: 'outside', sourceId: 'outside', name: 'Seventh-day bill', date: dateAfter(7), effectiveDate: dateAfter(7) };
  plan.events.push(edge, outside);
  plan.days[6].eventIds.push(edge.id);
  plan.days[7].eventIds.push(outside.id);
  const commands: Command[] = [];
  const original = structuredClone(state);
  await render(false, async command => { commands.push(command); });
  const payments = nextUp().querySelector('.home-next-payments')!;
  assert.doesNotMatch(payments.textContent!, /Sixth-day bill|Seventh-day bill/);
  await click('Next 7 days');
  assert.equal(payments.querySelector('[aria-pressed="true"]')?.textContent, 'Next 7 days');
  assert.match(payments.textContent!, /Phone bill.*Past date, check payment.*\$80/);
  assert.match(payments.textContent!, /Card minimum.*Amount needed/);
  assert.match(payments.textContent!, /Sixth-day bill/);
  assert.doesNotMatch(payments.textContent!, /Seventh-day bill|Later bill/);
  assert.match(nextUp().querySelector('.home-pay-countdown')!.textContent!, /^In 5 days$/);
  await click('Before payday');
  assert.doesNotMatch(payments.textContent!, /Sixth-day bill/);
  assert.deepEqual(commands, []);
  assert.deepEqual(routes, []);
  assert.deepEqual(state, original);
});

test('a shorter payment window keeps urgent forecast warnings visible and survives record refresh', async () => {
  plan.nextPayday = { date: dateAfter(10), amountCents: null };
  plan.beforePayday.endDate = dateAfter(9);
  plan.firstShortfallDate = dateAfter(8);
  await render();
  assert.match(nextUp().querySelector('.home-next-payments')!.textContent!, /Later bill/);
  await click('Next 7 days');
  state = { ...state, revision: 2 };
  await render();
  const payments = nextUp().querySelector('.home-next-payments')!;
  assert.equal(payments.querySelector('[aria-pressed="true"]')?.textContent, 'Next 7 days');
  assert.doesNotMatch(payments.textContent!, /Later bill/);
  assert.match(nextUp().querySelector('.home-review-urgent')!.textContent!, /Review the cash gap/);
  assert.match(nextUp().querySelector('.home-next-pay')!.textContent!, /In 10 days.*Take-home amount not confirmed/);
});

test('more payments expand in Home and each row still opens its saved record', async () => {
  for (let index = 0; index < 3; index++) {
    const event = { ...plan.events[0], id: `more-${index}`, sourceId: `more-${index}`, name: `Extra bill ${index + 1}`, date: dateAfter(2), effectiveDate: dateAfter(2), status: 'upcoming' as const };
    plan.events.push(event);
    plan.days[2].eventIds.push(event.id);
  }
  await render();
  const payments = nextUp().querySelector('.home-next-payments')!;
  assert.equal(payments.querySelectorAll('li').length, 3);
  await click('Show 2 more payments');
  assert.equal(payments.querySelectorAll('li').length, 5);
  assert.equal(payments.querySelector('.home-next-more')?.getAttribute('aria-expanded'), 'true');
  await click('Extra bill 3');
  assert.deepEqual(routes, [['expenses', 'schedule', 'more-2']]);
  await click('Show fewer payments');
  assert.equal(payments.querySelectorAll('li').length, 3);
});

test('payment windows and income countdown cross daylight-saving and month boundaries by calendar day', async () => {
  const asOf = '2026-10-31';
  plan = { ...plan, asOf, endDate: '2026-11-29', nextPayday: { date: '2026-11-02', amountCents: null }, beforePayday: { ...plan.beforePayday, endDate: '2026-11-01' }, events: [], days: plan.days.map((day, index) => ({ ...day, date: new Date(Date.UTC(2026, 9, 31 + index)).toISOString().slice(0, 10), eventIds: [] })) };
  await act(async () => root.render(createElement(HomeNextUp, { state, scope: 'personal', asOf, readOnly: true, engine: { data: plan, envelope: null, loading: false, error: '', retry: () => {} }, onNavigate: () => {}, onOpen: () => {} })));
  assert.equal(nextUp().querySelector('.home-pay-countdown')?.textContent, 'In 2 days');
  assert.match(nextUp().querySelector('.home-next-pay')!.textContent!, /Take-home amount not confirmed/);
  await click('Next 7 days');
  assert.equal(nextUp().querySelector('.home-next-payments h3')?.textContent, 'Payments through Nov 6');
  assert.equal(nextUp().querySelector('.home-next-empty')?.textContent, 'No saved payments through Nov 6.');
});

test('a missing payday names the calculated period and still offers a seven-day payment view', async () => {
  plan = { ...plan, nextPayday: null, beforePayday: { ...plan.beforePayday, endDate: plan.endDate }, events: [], days: plan.days.map(day => ({ ...day, eventIds: [] })) };
  await render();
  assert.equal(nextUp().querySelector('.home-payment-window [aria-pressed="true"]')?.textContent, 'Next 30 days');
  assert.equal(nextUp().querySelector('.home-pay-countdown'), null);
  await click('Next 7 days');
  const end = new Date(`${dateAfter(6)}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  assert.equal(nextUp().querySelector('.home-next-payments h3')!.textContent, `Payments through ${end}`);
});

test('cash balances stay within the selected owner and open the matching balance check', async () => {
  state.accounts[0].balanceCents = -2500;
  await render();
  const cash = container.querySelector('.home-bank-panel')!;
  assert.equal(cash.querySelector('.home-bank-total')?.textContent, '-$25');
  assert.match(cash.textContent!, /Balance needs checking/);
  assert.doesNotMatch(cash.textContent!, /Shop bank|9,999/);
  await act(async () => cash.querySelector<HTMLButtonElement>('[aria-label="Check balance for Bank, -$25"]')!.click());
  await act(async () => cash.querySelector<HTMLButtonElement>('[aria-label="Add cash or bank account"]')!.click());
  assert.deepEqual(forms, [['reconcile', 'cash'], ['account', undefined]]);
});

test('missing bank balances stay unknown and read-only Home cannot edit accounts', async () => {
  state.accounts = state.accounts.filter(account => account.entityId !== 'personal');
  await render();
  assert.equal(container.querySelector('.home-bank-total')?.textContent, 'Not recorded');
  assert.match(container.querySelector('.home-bank-panel')!.textContent!, /Add a bank account/);
  state = fixture();
  await render(true);
  assert.equal(container.querySelector('[aria-label="Add cash or bank account"]'), null);
  const check = container.querySelector<HTMLButtonElement>('[aria-label="Check balance for Bank, $1,000"]')!;
  assert.equal(check.disabled, true);
  await act(async () => check.click());
  assert.deepEqual(forms, []);
  const activity = [...container.querySelectorAll<HTMLButtonElement>('.home-bank-panel button')].find(button => button.textContent?.startsWith('Recent transactions'))!;
  await act(async () => activity.click());
  assert.deepEqual(routes, [['expenses', 'activity', undefined]]);
});

test('closed cash accounts remain reviewable without claiming their balances need checking', async () => {
  state.accounts.push({ ...state.accounts[0], id: 'closed-cash', name: 'Old bank', balanceCents: 0, closedAt: dateAfter(-2), reconciledAt: null });
  await render();
  const cash = container.querySelector('.home-bank-panel')!;
  assert.equal(cash.querySelector('.home-bank-total')?.textContent,'$1,000');
  const closed = cash.querySelector<HTMLButtonElement>('[aria-label="Review closed account Old bank"]')!;
  assert.match(closed.textContent ?? '', /Old bankClosed /);
  assert.doesNotMatch(closed.textContent ?? '', /Balance needs checking/);
  await act(async()=>closed.click());
  assert.deepEqual(forms,[['reconcile','closed-cash']]);
  state = {...state,revision:2,accounts:state.accounts.filter(account=>account.id!=='cash')};
  await render();
  assert.equal(cash.querySelector('.home-bank-total')?.textContent,'$0');
  assert.match(cash.querySelector('.home-bank-note')?.textContent ?? '', /No open cash account/);
});

test('an explicitly valued zero-dollar asset counts as recorded net worth', async () => {
  state.accounts = [];
  state.assets = [{ id: 'item', entityId: 'personal', name: 'Old phone', category: 'Electronics', purchaseDate: null, costCents: 50000, estimatedValueCents: 0, status: 'owned', soldDate: null, saleCents: null, feesCents: 0, notes: '' }];
  await render();
  assert.equal(container.querySelector('.position-value')?.textContent, '$0');
  state = { ...state, revision: 2, assets: [{ ...state.assets[0], estimatedValueCents: null }] };
  await render();
  assert.equal(container.querySelector('.position-value')?.textContent, 'Not recorded');
  assert.match(container.querySelector('.position-equation')?.textContent ?? '', /Add account balances to calculate net worth/);
  assert.doesNotMatch(container.querySelector('.position-equation')?.textContent ?? '', /\$0 assets/);
});

test('coming payments omit linked or recorded expenses while unresolved overlaps keep their review action', async () => {
  state.expensePlanItems = [{ id: 'overlap', entityId: 'personal', categoryId: 'bills', name: 'Phone plan', amountCents: 8000, date: dateAfter(1), notes: '' }];
  const event = { ...plan.events[0], sourceType: 'expense' as const, date: dateAfter(1), effectiveDate: dateAfter(1), status: 'upcoming' as const, includedInCashflow: false };
  plan.events.push({ ...event, id: 'linked', sourceId: 'linked', name: 'Already recorded expense' }, { ...event, id: 'overlap', sourceId: 'overlap', name: 'Phone plan' });
  plan.days[1].eventIds.push('linked', 'overlap');
  plan.missingInputs.push({ field: 'expensePlanItems.overlap.overlap', sourceId: 'overlap', section: 'expenses', message: 'Phone plan matches a bill. Link it or confirm a separate cost.' });
  await render();
  const payments = nextUp().querySelector('.home-next-payments')!;
  assert.match(payments.textContent ?? '', /Phone bill/);
  assert.doesNotMatch(payments.textContent ?? '', /Already recorded expense|Phone plan/);
  assert.match(nextUp().querySelector('.home-review')?.textContent ?? '', /Review Phone plan.*Link it or confirm a separate cost/);
  await click('Review Phone plan');
  assert.deepEqual(routes, [['expenses', 'plan', 'overlap']]);
});

test('an unknown purchase repayment stays visible while its linked expense-plan duplicate stays hidden', async () => {
  state.assetPurchases = [{ id: 'car', entityId: 'personal', name: 'Car', payee: 'Seller', targetCents: 1000000, paidCents: null, paidAsOf: '', monthlyCents: 20000, notes: '' }];
  state.obligations = [{ id: 'installment', entityId: 'personal', name: 'Car installment', amountCents: 20000, dueDate: dateAfter(1), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Transport', assetPurchaseId: 'car' }];
  state.expensePlanItems = [{ id: 'car-plan', entityId: 'personal', categoryId: 'transport', name: 'Car expense plan', amountCents: null, date: dateAfter(1), notes: '', obligationId: 'installment' }];
  const event = { ...plan.events[0], date: dateAfter(1), effectiveDate: dateAfter(1), status: 'upcoming' as const, amountCents: null, includedInCashflow: false };
  plan.events = [
    { ...event, id: 'installment', sourceId: 'installment', name: 'Car installment', note: 'Linked purchase payment, capped at the confirmed remaining cost.' },
    { ...event, id: 'car-plan', sourceType: 'expense', sourceId: 'car-plan', name: 'Car expense plan', note: 'Linked to a bill; the bill supplies its payment schedule.' },
  ];
  plan.days = plan.days.map((day, index) => ({ ...day, eventIds: index === 1 ? ['installment', 'car-plan'] : [] }));
  plan.missingInputs = [{ field: 'assetPurchases.car.paidCents', message: 'Confirm how much has been paid toward Car.', section: 'assets', sourceId: 'car' }];
  await render();
  const payments = nextUp().querySelector('.home-next-payments')!;
  assert.match(payments.textContent ?? '', /Car installment.*Amount needed/);
  assert.doesNotMatch(payments.textContent ?? '', /Car expense plan|No saved payments/);
  assert.match(nextUp().querySelector('.home-review')?.textContent ?? '', /Confirm how much has been paid toward Car/);
  await click('Car installment');
  assert.deepEqual(routes, [['expenses', 'schedule', 'installment']]);
});

test('Home keeps urgent actions visible below compact balances and ordinary review collapsed', async () => {
  plan.todayPayday = { date: today(), amountCents: null, receiptStatus: 'unconfirmed' };
  plan.missingInputs.push({ field: 'paydayReceipt', section: 'pay', sourceId: 'personal', message: 'Confirm today pay.' }, { field: 'reserves', section: 'reserve', message: 'Confirm how much cash to protect.' }, { field: 'accounts.cash.balance', section: 'accounts', sourceId: 'cash', message: 'Check Bank before relying on the cash plan.' });
  state.transactions = [{ id: 'review-me', accountId: 'cash', toAccountId: null, date: today(), createdAt: today(), description: 'Merchant', kind: 'expense', amountCents: 1200, category: 'Uncategorized', source: 'Manual' }, { id: 'other-owner', accountId: 'shop-bank', toAccountId: null, date: today(), createdAt: today(), description: 'Other merchant', kind: 'expense', amountCents: 9900, category: 'Uncategorized', source: 'Manual' }];
  await render();
  assert.equal(container.querySelector('.mazal-home')!.firstElementChild?.className, 'home-welcome');
  assert.ok(container.querySelector('.home-position-grid')!.firstElementChild?.classList.contains('home-bank-panel'));
  assert.ok(container.querySelector('.home-position-grid')!.lastElementChild?.classList.contains('home-worth-summary'));
  assert.ok(nextUp().previousElementSibling?.classList.contains('home-position-grid'));
  assert.ok(nextUp().previousElementSibling?.previousElementSibling?.classList.contains('home-welcome'));
  assert.ok(nextUp().nextElementSibling?.classList.contains('home-forecast-details'));
  assert.equal((nextUp().nextElementSibling as HTMLDetailsElement).open, false);
  assert.ok(nextUp().nextElementSibling?.nextElementSibling?.classList.contains('home-calendar-details'));
  const orderedSections = [...nextUp().children].filter(element => element.matches('.home-review, .home-next-grid'));
  assert.equal(orderedSections[0].className, 'home-review home-review-urgent');
  assert.equal(orderedSections[1].className, 'home-next-grid');
  assert.equal(orderedSections[2].className, 'home-review home-review-queue');
  assert.equal((orderedSections[2] as HTMLDetailsElement).open, false);
  assert.match(orderedSections[0].textContent!, /Confirm today's pay/);
  assert.doesNotMatch(orderedSections[0].textContent!, /Categorize|Review statements/);
  assert.match(orderedSections[2].textContent!, /Categorize 1 expense/);
  assert.match(nextUp().textContent!, /Confirm today's pay.*take-home amount and bank receipt need confirmation/);
  assert.equal([...nextUp().querySelectorAll('strong')].filter(item => item.textContent === "Confirm today's pay").length, 1);
  assert.match(nextUp().textContent!, /Categorize 1 expense/);
  assert.doesNotMatch(nextUp().querySelector('.home-review')!.textContent!, /\$0|Other merchant/);
  await click("Confirm today's pay");
  await click('Categorize 1 expense');
  await click('Confirm protected cash');
  await click('Check Bank balance');
  assert.deepEqual(routes, [['simulations', undefined, `payday:${today()}`], ['expenses', 'activity', 'categories'], ['simulations', undefined, 'setup:reserve']]);
  assert.deepEqual(forms, [['reconcile', 'cash']]);
});

test('an unconfirmed cash gap is the first action and does not claim a complete forecast', async () => {
  plan.firstShortfallDate = dateAfter(1);
  await render();
  const first = nextUp().querySelector<HTMLButtonElement>('.home-review-list button')!;
  assert.match(first.textContent!, /Review the cash gap.*below your \$100 protected amount.*Some amounts still need confirmation/);
  await act(async () => first.click());
  assert.deepEqual(routes, [['simulations', undefined, undefined]]);
});

test('recorded pay removes receipt review and records stay reachable without a staged import', async () => {
  state.importBatches = [];
  plan.todayPayday = { date: today(), amountCents: 200000, receiptStatus: 'recorded', transactionId: 'pay' };
  await render();
  assert.doesNotMatch(nextUp().textContent!, /Confirm today's pay/);
  await act(async () => container.querySelector<HTMLButtonElement>('.home-welcome .secondary')!.click());
  assert.deepEqual(routes, [['documents', undefined, undefined]]);
});

test('Home category review excludes reversed expenses and keeps genuine refunds', async () => {
  const original: AppState['transactions'][number] = { id: 'original', description: 'Canceled purchase', accountId: 'cash', toAccountId: null, kind: 'expense', amountCents: 1000, category: 'Uncategorized', date: today(), createdAt: today(), source: 'Manual entry' };
  state.transactions = [original, { ...original, id: 'reversal', amountCents: -1000, reversalOf: original.id, source: 'Manual reversal' }, { ...original, id: 'refund', description: 'Store refund', amountCents: -200, refundOf: 'past-purchase' }];
  await render();
  assert.match(nextUp().textContent ?? '', /Categorize 1 expense/);
  assert.doesNotMatch(nextUp().textContent ?? '', /Categorize 2 expenses/);
});

test('Home shows dated income before the next recurring paycheck and opens its saved record', async () => {
  const income = { id: 'income', sourceType: 'obligation' as const, sourceId: 'income', entityId: 'personal', name: 'Confirmed one-off pay', date: dateAfter(1), effectiveDate: dateAfter(1), direction: 'in' as const, amountCents: 321000, status: 'upcoming' as const, isProjection: false, includedInCashflow: true, accountId: 'cash', note: 'Recorded income.' };
  plan.events.push(income);
  plan.days[1].eventIds.push(income.id);
  await render();
  const pay = nextUp().querySelector('.home-next-pay')!;
  assert.match(pay.textContent!, /Next expected income.*\$3,210 expected.*Confirmed one-off pay/);
  assert.doesNotMatch(pay.textContent!, /\$2,000/);
  await click('Review income');
  assert.deepEqual(routes, [['expenses', 'schedule', 'income']]);
  state = { ...state, revision: 2 };
  plan.events = plan.events.map(event => event.id === income.id ? { ...event, includedInCashflow: false } : event);
  await render();
  assert.match(nextUp().querySelector('.home-next-pay')!.textContent!, /Next paycheck.*\$2,000 expected/);
  assert.doesNotMatch(nextUp().querySelector('.home-next-pay')!.textContent!, /Confirmed one-off pay/);
});

test('Home distinguishes a same-day deposit timing gap from an end-of-day shortage', async () => {
  plan.firstShortfallDate = dateAfter(1);
  plan.days[1] = { ...plan.days[1], incomeCents: 200000, outflowCents: 150000, closingCashCents: 142000, afterProtectedCents: 132000 };
  await render();
  const first = nextUp().querySelector<HTMLButtonElement>('.home-review-list button')!;
  assert.match(first.textContent!, /Check payment timing.*Payments may leave before \$2,000 arrives that day.*payments leave first/);
  assert.doesNotMatch(first.textContent!, /Known payments bring cash below/);
  state = { ...state, revision: 2 };
  plan.days[1] = { ...plan.days[1], closingCashCents: 5000, afterProtectedCents: -5000 };
  await render();
  assert.match(nextUp().querySelector('.home-review-list button')!.textContent!, /Review the cash gap.*below your \$100 protected amount/);
});

function addExcludedLoan() {
  state.accounts.push({ id: 'osap', entityId: 'personal', name: 'OSAP', type: 'debt', currency: 'CAD', balanceCents: 500000, reconciledAt: null, excludeFromNetWorth: true, evidence: { sourceFile: 'credit-report.pdf', asOf: today(), capturedOn: today(), status: 'credit_report', notes: '' } });
}

test('Home labels the excluded loan, retains full net worth, and hides the included-balance warning', async () => {
  addExcludedLoan();
  await render();
  const card = container.querySelector('.position-card')!;
  assert.equal(card.querySelector('h2')?.textContent, 'Net worth excluding OSAP');
  assert.equal(card.querySelector('.position-value')?.textContent, '$1,000');
  assert.match(card.textContent!, /\$1,000 assets − \$0 owed/);
  assert.match(card.textContent!, /Net worth with all saved accounts is -\$4,000/);
  assert.doesNotMatch(card.textContent!, /Includes an OSAP credit report balance/);
  assert.equal([...card.querySelectorAll('.position-breakdown button')].find(button => button.textContent?.startsWith('Total debt'))?.querySelector('strong')?.textContent, '$5,000');
  await render(true);
  assert.equal([...card.querySelectorAll('button')].some(button => button.textContent === 'Include OSAP'), false);
});

test('restoring an excluded loan disables repeated clicks, reports failure, and retries the same request', async () => {
  addExcludedLoan();
  const commands: Command[] = [];
  let reject: (error: Error) => void = () => {};
  const onCommand = async (command: Command) => {
    commands.push(command);
    if (commands.length === 1) await new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    else {
      state = { ...state, revision: state.revision + 1, accounts: state.accounts.map(account => account.id === 'osap' ? { ...account, excludeFromNetWorth: false } : account) };
    }
  };
  await render(false, onCommand);
  const include = [...container.querySelectorAll('button')].find(button => button.textContent === 'Include OSAP')!;
  await act(async () => { include.click(); include.click(); });
  assert.equal(commands.length, 1);
  assert.equal(include.disabled, true);
  assert.equal(include.textContent, 'Saving…');
  assert.equal(commands[0].type, 'set_net_worth_inclusion');
  assert.equal(commands[0].expectedRevision, 1);
  assert.ok('requestId' in commands[0] && commands[0].requestId);
  await act(async () => reject(new Error('Connection interrupted. Retry to confirm this change.')));
  assert.match(container.querySelector('.position-card [role="alert"]')!.textContent!, /Connection interrupted/);
  assert.equal(include.disabled, false);
  await act(async () => include.click());
  assert.deepEqual(commands[1], commands[0]);
  await render(false, onCommand);
  assert.equal(container.querySelector('.position-header h2')?.textContent, 'Recorded net worth');
  assert.equal(container.querySelector('.position-value')?.textContent, '-$4,000');
  assert.match(container.querySelector('.position-card')!.textContent!, /Includes an OSAP credit report balance/);
  assert.equal(state.accounts.find(account => account.id === 'osap')?.balanceCents, 500000);
});

test('cash forecast payday rows only open receipt confirmation for unconfirmed pay today', async () => {
  const payday = { ...plan.events[0], id: 'forecast-payday', sourceId: 'payday', name: 'Forecast paycheck', sourceType: 'payday' as const, direction: 'in' as const, status: 'upcoming' as const, date: dateAfter(5), effectiveDate: dateAfter(5), amountCents: 200000 };
  plan.events.push(payday);
  plan.days[5].eventIds.push(payday.id);
  await render();
  const input = container.querySelector<HTMLInputElement>('[aria-label="Inspect Home cash forecast date"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const payButton = () => [...container.querySelectorAll<HTMLButtonElement>('.home-cash-day-details button')].find(button => button.textContent?.includes('Forecast paycheck'))!;
  await act(async () => payButton().click());
  assert.deepEqual(routes.pop(), ['expenses', 'schedule', undefined]);
  payday.date = today(); payday.effectiveDate = today();
  plan.days[5].eventIds = [];
  plan.days[0].eventIds.push(payday.id);
  plan.todayPayday = { date: today(), amountCents: 200000, receiptStatus: 'unconfirmed' };
  state = { ...state, revision: 2 };
  await render();
  const refreshed = container.querySelector<HTMLInputElement>('[aria-label="Inspect Home cash forecast date"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(refreshed, '0');
    refreshed.dispatchEvent(new Event('input', { bubbles: true }));
    refreshed.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => payButton().click());
  assert.deepEqual(routes.pop(), ['simulations', undefined, `payday:${today()}`]);
  plan.todayPayday.receiptStatus = 'recorded';
  plan.todayPayday.transactionId = 'recorded-pay';
  state = { ...state, revision: 3 };
  await render();
  await act(async () => payButton().click());
  assert.deepEqual(routes.pop(), ['expenses', 'schedule', undefined]);
});
