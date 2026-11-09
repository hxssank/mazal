import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Command } from '../shared/types.ts';
import { money, today } from '../shared/analytics.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLDialogElement', 'Event', 'MouseEvent', 'localStorage'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) for (const extension of ['.ts', '.tsx']) {
      const url = new URL(specifier + extension, context.parentURL);
      if (existsSync(url)) return nextResolve(url.href, context);
    }
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
const { default: Planner } = await import('./features/planner/Planner.tsx');
const { engineFixtureFetch, engineFixtureResult } = await import('./engine-test-fixture.ts');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
let state: AppState;
let commands: Command[];
let navigation: { view: string; section?: string; recordId?: string }[];
let opened: { kind: string; accountId?: string }[];
let recorded: { kind: string; accountId?: string }[];
let commandHandler: (command: Command) => Promise<void>;

function offsetDate(days: number): string {
  const value = new Date(today() + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function fixture(): AppState {
  return {
    workspace: 'live', revision: 7,
    entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }],
    accounts: [{ id: 'cash', entityId: 'personal', name: 'Chequing', type: 'cash', currency: 'CAD', balanceCents: 200000, reconciledAt: today() }],
    transactions: [], obligations: [{ id: 'phone', entityId: 'personal', name: 'Phone bill', amountCents: 25000, dueDate: offsetDate(1), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Phone' }],
    reserves: [{ id: 'buffer', entityId: 'personal', name: 'Cash buffer', amountCents: 10000 }], positions: [], audit: [], lastBackupAt: null,
    roadmap: { currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: 0, monthlyDebtMinimumsCents: null, transitionDate: '', transitionMonths: 0, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, payAmountCents: 100000, payEveryDays: 14, paydayAnchor: offsetDate(7) },
  };
}
beforeEach(async () => {
  await act(async () => root.unmount()); root = createRoot(container); localStorage.clear(); dom.window.sessionStorage.clear();
  state = fixture(); commands = []; navigation = []; opened = []; recorded = [];
  commandHandler = async command => { commands.push(command); };
  globalThis.fetch = engineFixtureFetch(() => state);
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });
async function render(scope = 'personal', readOnly = false) {
  await act(async () => root.render(createElement(Planner, {
    key: state.workspace + ':' + scope, state, scope, motion: false, readOnly,
    onCommand: command => commandHandler(command),
    onNavigate: (view, section, recordId) => { navigation.push({ view, section, ...(recordId ? { recordId } : {}) }); },
    onOpen: (kind, accountId) => { opened.push({ kind, accountId }); },
    onRecord: (kind, accountId) => { recorded.push({ kind, accountId }); },
  })));
}
function button(name: string | RegExp, context: ParentNode = container): HTMLButtonElement {
  const value = [...context.querySelectorAll<HTMLButtonElement>('button')].find(item => !item.closest('[hidden]') && (typeof name === 'string' ? item.textContent?.trim() === name : name.test(item.textContent ?? '')));
  assert.ok(value, 'Missing visible button ' + name);
  return value;
}
async function click(name: string | RegExp, context: ParentNode = container) { await act(async () => button(name, context).click()); }
async function fill(input: HTMLInputElement, value: string) {
  assert.ok(input, 'Input exists');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function frame() { await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))); }

test('Plan setup navigation keeps keyboard focus while the pay shortcut focuses its setup control', async () => {
  await render();
  const setup = button('Plan setup');
  await act(async () => { setup.focus(); setup.click(); });
  await frame();
  assert.equal(setup.getAttribute('aria-pressed'), 'true');
  assert.ok(document.activeElement === setup, 'Section navigation must retain focus on Plan setup');
  await click('Your plan');
  await click('Edit schedule');
  await frame();
  assert.equal(setup.getAttribute('aria-pressed'), 'true');
  assert.ok(document.activeElement === button('Edit', container.querySelector('.expense-pay-card')!), 'The pay shortcut focuses the pay schedule control');
});

test('hidden planning amount drafts block app navigation until the user keeps or discards them', async () => {
  const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
  await render(); await click('Plan setup'); await frame();
  const living = container.querySelector<HTMLElement>('section[aria-label="Monthly living costs"]')!;
  await click('Edit', living); await fill(living.querySelector('input')!, '123.45');
  await click('Your plan');
  let left = 0;
  await act(async () => { assert.equal(requestDraftNavigation(() => { left++; }), false); });
  assert.equal(left, 0); assert.ok(document.querySelector('dialog.draft-discard-dialog[open]'));
  await click('Keep editing', document);
  await click('Plan setup'); await frame();
  assert.equal(living.querySelector<HTMLInputElement>('input')!.value, '123.45');
  await act(async () => { requestDraftNavigation(() => { left++; }); });
  await click('Discard changes', document);
  assert.equal(left, 1); assert.equal(living.querySelector('form'), null); assert.deepEqual(commands, []);
});

test('pay schedule and cash reserve cancel buttons preserve edited values until discard', async () => {
  await render(); await click('Plan setup'); await frame();
  const pay = container.querySelector<HTMLElement>('.expense-pay-card')!;
  await click('Edit', pay); await fill(pay.querySelector('input')!, '2222'); await click('Cancel', pay);
  await click('Keep editing', document);
  assert.equal(pay.querySelector<HTMLInputElement>('input')!.value, '2222');
  await click('Cancel', pay); await click('Discard changes', document); assert.equal(pay.querySelector('form'), null);
  const reserve = container.querySelector<HTMLElement>('section[aria-label="Cash to protect"]')!;
  await click('Set amount', reserve); await fill(reserve.querySelector('input')!, '200'); await click('Cancel', reserve);
  await click('Keep editing', document); assert.equal(reserve.querySelector<HTMLInputElement>('input')!.value, '200');
  await click('Cancel', reserve); await click('Discard changes', document); assert.equal(reserve.querySelector('form'), null);
  assert.deepEqual(commands, []);
});

for (const kind of ['pay', 'living', 'reserve'] as const) test(`${kind} setup returns focus after cancel, discard, and save`, async () => {
  await render(); await click('Plan setup'); await frame();
  const card = container.querySelector<HTMLElement>(kind === 'pay' ? '.expense-pay-card' : `section[aria-label="${kind === 'living' ? 'Monthly living costs' : 'Cash to protect'}"]`)!;
  const editLabel = kind === 'reserve' ? 'Set amount' : 'Edit';
  const submitLabel = kind === 'pay' ? 'Save schedule' : kind === 'living' ? 'Save living costs' : 'Save cash reserve';
  await click(editLabel, card);
  assert.equal(document.activeElement, card.querySelector('input'));
  button('Cancel', card).focus(); await click('Cancel', card); await frame();
  assert.equal(document.activeElement, button(editLabel, card));
  await click(editLabel, card); await fill(card.querySelector('input')!, '2222');
  button('Cancel', card).focus(); await click('Cancel', card); await click('Discard changes', document); await frame();
  assert.equal(document.activeElement, button(editLabel, card)); assert.equal(commands.length, 0);
  await click(editLabel, card); await fill(card.querySelector('input')!, '3333');
  button(submitLabel, card).focus(); await click(submitLabel, card); await frame();
  assert.equal(card.querySelector('form'), null);
  assert.equal(document.activeElement, button(editLabel, card));
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, kind === 'pay' ? 'update_pay_schedule' : kind === 'living' ? 'update_living_costs' : 'update_planning_reserve');
});

for (const kind of ['pay', 'reserve'] as const) test(`reloading saved ${kind} settings keeps focus in the reopened form`, async () => {
  await render(); await click('Plan setup'); await frame();
  const card = container.querySelector<HTMLElement>(kind === 'pay' ? '.expense-pay-card' : 'section[aria-label="Cash to protect"]')!;
  await click(kind === 'pay' ? 'Edit' : 'Set amount', card); await fill(card.querySelector('input')!, '2222');
  state = { ...state, revision: state.revision + 1, roadmap: { ...state.roadmap!, payAmountCents: 400000, planningCashReserveCents: 50000 } };
  await render();
  await click(kind === 'pay' ? 'Load saved schedule' : 'Load saved amount', card);
  await click('Discard changes', document); await frame();
  const input = card.querySelector<HTMLInputElement>('input')!;
  assert.equal(input.value, kind === 'pay' ? '4000' : '500');
  assert.equal(document.activeElement, input); assert.equal(commands.length, 0);
});

test('scenario drafts block navigation if browser storage fails after an edit', async () => {
  const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
  const storage = Object.getPrototypeOf(localStorage);
  const original = storage.setItem;
  try {
    storage.setItem = () => { throw new Error('Storage unavailable'); };
    await render(); await click('Compare options');
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Pay per paycheck"]');
    assert.ok(input); await fill(input, '3210');
    let left = 0;
    await act(async () => { assert.equal(requestDraftNavigation(() => { left++; }), false); });
    assert.equal(left, 0);
    await click('Keep editing', document); assert.equal(input.value, '3210');
    await act(async () => { requestDraftNavigation(() => { left++; }); });
    await click('Discard changes', document); assert.equal(left, 1); assert.deepEqual(commands, []);
  } finally { storage.setItem = original; }
});

test('daily plan previews cash separately from the next pay and changing the range never records money', async () => {
  const before = structuredClone(state);
  await render();
  assert.match(container.querySelector('.planner-big-money')?.textContent ?? '', /\$1,650.*remaining/);
  assert.match(container.querySelector('.planner-payday')?.textContent ?? '', /\$1,000/);
  assert.match(container.querySelector('.planner-event')?.textContent ?? '', /Phone bill.*\$250/);
  const range = container.querySelector<HTMLSelectElement>('select[aria-label="Planner date range"]')!;
  await act(async () => { range.value = '90'; range.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.match(container.querySelector('.planner-timeline')?.textContent ?? '', /Next 90 days/);
  await click('Money in');
  assert.ok([...container.querySelectorAll('.planner-event')].every(event => event.classList.contains('is-in')));
  await click('Record income', container.querySelector('.planner-payday')!);
  assert.deepEqual(recorded, [{ kind: 'income', accountId: undefined }]);
  assert.equal(commands.length, 0);
  assert.deepEqual(state, before);
});

test('range totals follow the look-ahead selection and include living costs once', async () => {
  state.roadmap!.monthlyEssentialsCents = 31000;
  const before = structuredClone(state);
  await render();
  const range = container.querySelector<HTMLSelectElement>('select[aria-label="Planner date range"]')!;
  await act(async () => { range.value = '7'; range.dispatchEvent(new Event('change', { bubbles: true })); });
  const shortPlan = engineFixtureResult(state, 'personal', today(), 'daily_plan', { days: 30 }) as import('../shared/engine.ts').DailyPlan;
  const week = shortPlan.days.slice(0, 7);
  const overview = () => container.querySelector('.planner-range-overview')!;
  const values = () => [...overview().querySelectorAll('dd')].map(value => value.textContent);
  assert.deepEqual(values(), [money(week.reduce((sum, day) => sum + day.incomeCents, 0)), money(week.reduce((sum, day) => sum + day.outflowCents, 0)), money(week.at(-1)!.afterProtectedCents)]);
  assert.ok(overview().textContent?.includes(`Includes ${money(week.reduce((sum, day) => sum + day.livingCostsCents, 0))} planned living costs`));
  await act(async () => { range.value = '90'; range.dispatchEvent(new Event('change', { bubbles: true })); });
  const longPlan = engineFixtureResult(state, 'personal', today(), 'daily_plan', { days: 90 }) as import('../shared/engine.ts').DailyPlan;
  assert.deepEqual(values(), [money(longPlan.knownIncomeCents), money(longPlan.knownOutflowCents), money(longPlan.days.at(-1)!.afterProtectedCents)]);
  assert.deepEqual(commands, []);
  assert.deepEqual(state, before);
});

test('earlier scheduled income leads the pay card and records against its saved obligation', async () => {
  state.obligations.push({ id: 'one-off-pay', entityId: 'personal', name: 'One-off paycheck', amountCents: 75000, dueDate: offsetDate(2), direction: 'in', recurrence: 'once', status: 'planned', accountId: 'cash', category: 'Pay', additionalToPay: true });
  const before = structuredClone(state);
  await render();
  const card = container.querySelector<HTMLElement>('.planner-payday')!;
  const date = new Date(offsetDate(2) + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
  assert.match(card.textContent ?? '', /Next expected income.*\$750.*One-off paycheck/s);
  assert.ok(card.textContent?.includes(date));
  assert.match(container.querySelector('.planner-balance')?.textContent ?? '', /Before your next regular payday/);
  assert.match(container.querySelector('.planner-big-money')?.textContent ?? '', /\$2,400.*remaining/);
  assert.match(container.querySelector('select[aria-label="Planner date range"] option:checked')?.textContent ?? '', /Before next regular payday/);
  await click('Record received', card);
  const dialog = container.querySelector<HTMLDialogElement>('.record-dialog')!;
  assert.ok(dialog.open);
  assert.match(dialog.textContent ?? '', /Record received income.*One-off paycheck.*\$750/s);
  assert.equal(commands.length, 0);
  await click('Record payment', dialog);
  assert.equal(commands[0].type, 'pay_obligation');
  if (commands[0].type !== 'pay_obligation') assert.fail('Expected income obligation command');
  assert.equal(commands[0].id, 'one-off-pay');
  assert.equal(commands[0].expectedDueDate, offsetDate(2));
  assert.equal(commands[0].amountCents, 75000);
  assert.equal(commands[0].expectedRevision, 7);
  assert.equal(recorded.length, 0);
  assert.deepEqual(state, before);
});

for (const unknown of [false, true]) test(`${unknown ? 'unknown' : 'excluded'} incoming events do not replace the regular pay card`, async () => {
  state.obligations.push({ id: 'excluded-pay', entityId: 'personal', name: 'Unconfirmed income', amountCents: 75000, dueDate: offsetDate(1), direction: 'in', recurrence: 'once', status: 'planned', accountId: 'cash', category: 'Pay', additionalToPay: false });
  if (unknown) {
    const fixtureFetch = engineFixtureFetch(() => state);
    globalThis.fetch = async (...args) => {
      const response = await fixtureFetch(...args);
      const envelope = await response.json();
      const event = envelope.result.events.find((row: { sourceId: string }) => row.sourceId === 'excluded-pay');
      event.amountCents = null;
      envelope.result.status = 'partial';
      envelope.result.missingInputs.push({ field: 'obligations.excluded-pay.amountCents', message: 'Confirm the incoming amount.', section: 'pay', sourceId: 'excluded-pay' });
      return Response.json(envelope);
    };
  }
  await render();
  const card = container.querySelector<HTMLElement>('.planner-payday')!;
  assert.match(card.textContent ?? '', /Next expected pay.*\$1,000/s);
  assert.doesNotMatch(card.textContent ?? '', /Unconfirmed income|\$750|Next expected income/);
  await click('Record income', card);
  assert.deepEqual(recorded, [{ kind: 'income', accountId: undefined }]);
  assert.equal(commands.length, 0);
});

test('recording a scheduled payment confirms the actual date and keeps the saved occurrence and revision', async () => {
  const before = structuredClone(state);
  await render();
  await click('Record paid', container.querySelector('.planner-agenda')!);
  const dialog = container.querySelector<HTMLDialogElement>('.record-dialog')!;
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent ?? '', /Record a payment.*Phone bill.*Actual amount.*Actual payment date.*Chequing.*money that has moved/s);
  assert.equal(commands.length, 0);
  await click('Cancel', dialog);
  assert.equal(container.querySelector('.record-dialog'), null);
  assert.equal(commands.length, 0);
  await click('Record paid', container.querySelector('.planner-agenda')!);
  await click('Record payment');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'pay_obligation');
  if (commands[0].type !== 'pay_obligation') assert.fail('Expected payment command');
  assert.equal(commands[0].id, 'phone');
  assert.equal(commands[0].expectedDueDate, before.obligations[0].dueDate);
  assert.equal(commands[0].expectedRevision, 7);
  assert.equal(commands[0].amountCents, before.obligations[0].amountCents);
  assert.equal(commands[0].date, today());
  assert.ok(commands[0].requestId);
  assert.equal(container.querySelector('.record-dialog'), null);
  assert.deepEqual(state, before);
});

test('a stale payment confirmation cannot submit after the saved records change', async () => {
  await render();
  await click('Record paid', container.querySelector('.planner-agenda')!);
  state = { ...state, revision: 8, obligations: state.obligations.map(row => ({ ...row, amountCents: 27000 })) };
  await render();
  assert.equal(button('Record payment').disabled, true);
  assert.match(container.querySelector('.record-dialog [role=status]')?.textContent ?? '', /Records changed/);
  await click('Record payment');
  assert.equal(commands.length, 0);
  await click('Cancel', container.querySelector('.record-dialog')!);
  await click('Record paid', container.querySelector('.planner-agenda')!);
  assert.match(container.querySelector('.record-dialog')?.textContent ?? '', /\$270/);
  await click('Record payment');
  assert.equal(commands[0].expectedRevision, 8);
});

test('a failed payment remains reviewable and retrying keeps the same request id', async () => {
  commandHandler = async command => { commands.push(command); if (commands.length === 1) throw new Error('Save could not be confirmed.'); };
  await render();
  await click('Record paid', container.querySelector('.planner-agenda')!);
  await click('Record payment');
  assert.match(container.querySelector('.record-dialog [role=alert]')?.textContent ?? '', /Save could not be confirmed/);
  assert.equal(button('Confirm original save').disabled, false);
  await click('Confirm original save');
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], commands[1]);
});

test('setup preserves unsaved pay and living costs when switching planner sections', async () => {
  await render();
  await click('Plan setup');
  await click('Edit', container.querySelector('.planner-living')!);
  await fill(container.querySelector<HTMLInputElement>('input[aria-label="Monthly living costs"]')!, '123.45');
  await click('Edit', container.querySelector('.expense-pay-card')!);
  await fill(container.querySelector<HTMLInputElement>('.expense-pay-form input')!, '987.65');
  await click('Your plan');
  await click('Plan setup');
  assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Monthly living costs"]')?.value, '123.45');
  assert.equal(container.querySelector<HTMLInputElement>('.expense-pay-form input')?.value, '987.65');
  assert.equal(commands.length, 0);
});

test('living-cost edits retain a draft after a revision change and require reviewing that change before saving', async () => {
  await render();
  await click('Plan setup');
  await click('Edit', container.querySelector('.planner-living')!);
  await fill(container.querySelector<HTMLInputElement>('input[aria-label="Monthly living costs"]')!, '123.45');
  state = { ...state, revision: 8, roadmap: { ...state.roadmap!, monthlyEssentialsCents: 50000 } };
  await render();
  assert.equal(button('Save living costs').disabled, true);
  assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Monthly living costs"]')?.value, '123.45');
  await click('Save living costs');
  assert.equal(commands.length, 0);
  await click('Keep my amount');
  await click('Save living costs');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'update_living_costs');
  if (commands[0].type !== 'update_living_costs') assert.fail('Expected living-cost update');
  assert.equal(commands[0].monthlyEssentialsCents, 12345);
  assert.equal(commands[0].expectedRevision, 8);
});

test('missing inputs open the matching account, dated expense, and overdue bill', async () => {
  state.accounts[0].reconciledAt = null;
  state.expensePlanItems = [{ id: 'repair', entityId: 'personal', categoryId: 'transport', name: 'Car repair', amountCents: null, date: offsetDate(2), notes: '' }];
  state.obligations[0].dueDate = offsetDate(-1);
  await render();
  const checklist = container.querySelector('.planner-checklist')!;
  await click(/Check Chequing/, checklist);
  assert.deepEqual(opened, [{ kind: 'reconcile', accountId: 'cash' }]);
  await click(/Add the cost of Car repair/, checklist);
  assert.deepEqual(navigation.at(-1), { view: 'expenses', section: 'plan', recordId: 'repair' });
  await click(/Review Phone bill/, checklist);
  await frame();
  const editor = container.querySelector<HTMLDialogElement>('.bill-dialog')!;
  assert.ok(editor);
  assert.equal(editor.open, true);
  assert.equal(editor.querySelector<HTMLInputElement>('input')?.value, 'Phone bill');
  assert.equal(commands.length, 0);
});

test('missing cash setup opens account creation and remains disabled in a snapshot', async () => {
  state.accounts = []; state.obligations = [];
  await render();
  const checklist = container.querySelector('.planner-checklist')!;
  await click(/Add a cash account/, checklist);
  assert.deepEqual(opened, [{ kind: 'account', accountId: undefined }]);
  assert.deepEqual(navigation, []);
  await render('personal', true);
  assert.equal(button(/Add a cash account/, checklist).disabled, true);
  await click(/Add a cash account/, checklist);
  assert.equal(opened.length, 1);
  assert.equal(commands.length, 0);
});

test('closed cash history stays labeled and an open account is required for plan setup', async () => {
  const active = state.accounts[0];
  state.accounts.push({ ...active, id:'closed-cash', name:'Old bank', balanceCents:0, reconciledAt:null, closedAt:offsetDate(-2) });
  await render();
  assert.match(container.querySelector('.planner-checklist')?.textContent ?? '', /No missing inputs/);
  await click('Plan setup');
  const closed = container.querySelector<HTMLButtonElement>('[aria-label="Review closed account Old bank"]')!;
  assert.equal(closed.textContent,'Review');
  assert.match(closed.parentElement?.textContent ?? '', /Old bankClosed /);
  assert.doesNotMatch(closed.parentElement?.textContent ?? '', /Balance not checked/);
  state = {...state,revision:state.revision+1,accounts:state.accounts.filter(account=>account.id!==active.id),obligations:[]};
  await render();
  assert.match(container.querySelector('.planner-setup')?.textContent ?? '', /No open cash account/);
  await click('Add cash account');
  assert.deepEqual(opened,[{kind:'account',accountId:undefined}]);
  await click('Your plan');
  assert.match(container.querySelector('.planner-checklist')?.textContent ?? '', /Add an open cash account/);
  assert.equal(commands.length,0);
});

test('a named missing debt detail opens that debt instead of the default account', async () => {
  state.accounts.push({ id: 'card', entityId: 'personal', name: 'Credit card', type: 'debt', currency: 'CAD', balanceCents: 600000, reconciledAt: today(), debtTerms: { aprPercent: 12, rateConfirmed: true, minimumPaymentCents: null, notes: '' } });
  await render();
  await click(/Review Credit card terms/, container.querySelector('.planner-checklist')!);
  assert.deepEqual(navigation, [{ view: 'debts', section: undefined, recordId: 'card' }]);
  assert.equal(commands.length, 0);
});

test('a complete forecast still explains a same-day payment timing gap', async () => {
  state.accounts[0].balanceCents = 20000;
  state.roadmap = { ...state.roadmap!, paydayAnchor: offsetDate(1) };
  await render();
  const checklist = container.querySelector('.planner-checklist')!;
  assert.match(checklist.textContent ?? '', /No missing inputs.*cash or payment-timing gap/s);
  const timeline = container.querySelector<HTMLDetailsElement>('.planner-timeline')!;
  assert.equal(timeline.open, false);
  assert.match(timeline.querySelector('summary')?.textContent ?? '', /Check payment timing.*Bills may leave before \$1,000 arrives that day/s);
  assert.doesNotMatch(container.querySelector('.planner-timeline-heading')?.textContent ?? '', /Known commitments exceed unreserved cash/);
  assert.equal(commands.length, 0);
});

test('calculation failure hides the forecast, keeps saved setup accessible, and can be retried', async () => {
  globalThis.fetch = async () => { throw new Error('Engine offline'); };
  await render();
  assert.match(container.querySelector('.planner-empty[role=alert]')?.textContent ?? '', /could not be calculated/);
  assert.equal(container.querySelector('.planner-big-money'), null);
  await click('View saved setup');
  await frame();
  assert.ok(button('Edit', container.querySelector('.planner-living')!));
  await click('Your plan');
  globalThis.fetch = engineFixtureFetch(() => state);
  await click('Retry calculation');
  assert.match(container.querySelector('.planner-big-money')?.textContent ?? '', /\$1,650/);
  assert.equal(container.querySelector('.planner-empty[role=alert]'), null);
  assert.equal(commands.length, 0);
});

test('cash timeline labels use cash after protected reserves', async () => {
  state.obligations = [];
  await render();
  const plan = engineFixtureResult(state, 'personal', today(), 'daily_plan', { days: 30 }) as { lowestCashCents: number; protectedCents: number };
  assert.match(container.querySelector('.planner-timeline')?.textContent ?? '', new RegExp(money(plan.lowestCashCents - plan.protectedCents).replace(/[$.]/g, '\\$&')));
  const timeline = container.querySelector<HTMLDetailsElement>('.planner-timeline')!;
  assert.equal(timeline.open, false);
  await act(async () => timeline.querySelector('summary')!.click());
  assert.equal(timeline.open, true);
  assert.match(timeline.querySelector('svg[role="img"]')?.getAttribute('aria-label') ?? '', /\$1,900/);
});

test('zero cash protection is an explicit saved amount and clears the unknown reserve warning', async () => {
  state.reserves = [];
  await render();
  await click(/Confirm how much cash to protect/, container.querySelector('.planner-checklist')!);
  await frame();
  const protection = container.querySelector<HTMLElement>('[aria-label="Cash to protect"]')!;
  assert.ok(protection);
  await click('Set amount', protection);
  await fill(container.querySelector<HTMLInputElement>('input[aria-label="Cash to protect"]')!, '0');
  await click('Save cash reserve');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'update_planning_reserve');
  if (commands[0].type !== 'update_planning_reserve') assert.fail('Expected reserve setting');
  assert.equal(commands[0].amountCents, 0);
  assert.equal(commands[0].expectedRevision, 7);
  state = { ...state, revision: 8, roadmap: { ...state.roadmap!, planningCashReserveCents: 0 } };
  await render();
  assert.match(protection.querySelector('.planner-setup-amount')?.textContent ?? '', /\$0/);
  await click('Your plan');
  assert.doesNotMatch(container.querySelector('.planner-checklist')?.textContent ?? '', /Confirm how much cash to protect/);
  assert.equal(state.reserves.length, 0);
});

test('business setup does not expose edits to the personal pay schedule or living-cost settings', async () => {
  state.entities.push({ id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 5000 });
  state.accounts.push({ id: 'shop-cash', entityId: 'shop', name: 'Business chequing', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: today() });
  state.reserves.push({ id: 'shop-buffer', entityId: 'shop', name: 'Business reserve', amountCents: 10000 });
  await render('shop');
  await click('Plan setup');
  assert.equal(container.querySelector('.expense-pay-card'), null);
  assert.equal(container.querySelector('[aria-label="Monthly living costs"]'), null);
  assert.equal(container.querySelector('[aria-label="Cash to protect"]'), null);
  assert.match(container.querySelector('.planner-cash-accounts')?.textContent ?? '', /Business chequing/);
  assert.equal(commands.length, 0);
});

test('the paycheck calendar has one Tab stop and arrow keys move the selected day', async () => {
  state.roadmap = { ...state.roadmap!, monthlyFamilyPaymentCents: 0, monthlyDebtMinimumsCents: 0 };
  const before = structuredClone(state);
  await render();
  await click('Compare options');
  await act(async () => { await import('./features/planner/Simulations.tsx'); });
  const calendar = container.querySelector<HTMLDetailsElement>('.monthly-calendar-disclosure')!;
  assert.ok(calendar);
  await act(async () => calendar.querySelector('summary')!.click());
  const days = [...calendar.querySelectorAll<HTMLButtonElement>('.monthly-calendar-days button')];
  const tabStops = () => days.filter(day => day.tabIndex === 0);
  assert.ok(days.length > 31);
  assert.match(calendar.querySelector('.monthly-calendar-selection')?.textContent ?? '', /Starting balances/);
  assert.deepEqual(tabStops(), [days[0]]);
  assert.equal(days.some(day => day.getAttribute('aria-pressed') === 'true'), false);
  days[0].focus();
  const arrow = new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  await act(async () => days[0].dispatchEvent(arrow));
  assert.equal(arrow.defaultPrevented, true);
  assert.equal(document.activeElement, days[7]);
  assert.equal(days[7].getAttribute('aria-pressed'), 'true');
  assert.deepEqual(tabStops(), [days[7]]);
  await click('End of plan');
  assert.deepEqual(tabStops(), [days.at(-1)]);
  assert.equal(days.at(-1)?.getAttribute('aria-pressed'), 'true');
  await act(async () => days.at(-1)!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, days.at(-1));
  assert.deepEqual(tabStops(), [days.at(-1)]);
  assert.deepEqual(state, before);
  assert.equal(commands.length, 0);
});

test('comparison drafts remain mounted across planner tabs after opening from the navigation', async () => {
  await render();
  assert.equal(container.querySelector('.planner-scenarios'), null);
  await click('Compare options');
  await act(async () => { await import('./features/planner/Simulations.tsx'); });
  const panel = container.querySelector<HTMLElement>('.planner-scenarios')!;
  assert.ok(panel);
  assert.equal(panel.hidden, false);
  const payInput = panel.querySelector<HTMLInputElement>('input[aria-label="Pay per paycheck"]')!;
  await fill(payInput, '2345.67');
  const funding = panel.querySelector<HTMLDetailsElement>('.monthly-funding-disclosure')!;
  await act(async () => funding.querySelector('summary')!.click());
  assert.equal(funding.open, true);
  await click('Your plan');
  assert.equal(panel.hidden, true);
  assert.equal(container.querySelector('input[aria-label="Pay per paycheck"]'), payInput);
  await click('Plan setup');
  assert.equal(panel.hidden, true);
  await click('Compare options');
  assert.equal(panel.hidden, false);
  assert.equal(panel.querySelector('input[aria-label="Pay per paycheck"]'), payInput);
  assert.equal(payInput.value, '2345.67');
  assert.equal(funding.open, true);
  assert.equal(commands.length, 0);

  state = { ...state, workspace: 'demo' };
  await render();
  assert.equal(container.querySelector('.planner-scenarios'), null);
  await click('Compare options');
  const freshInput = container.querySelector<HTMLInputElement>('input[aria-label="Pay per paycheck"]')!;
  assert.notEqual(freshInput, payInput);
  assert.equal(freshInput.value, '1000');
});

test('an extra debt payment displays the number of days saved as an earlier payoff', async () => {
  state.accounts.push({ id: 'card', entityId: 'personal', name: 'Credit card', type: 'debt', currency: 'CAD', balanceCents: 600000, reconciledAt: today(), debtTerms: { aprPercent: 12, rateConfirmed: true, minimumPaymentCents: 10000, notes: '' } });
  state.roadmap = { ...state.roadmap!, monthlyFamilyPaymentCents: 0, monthlyDebtMinimumsCents: 100000, loanAccountId: 'card' };
  await render();
  await click('Compare options');
  await act(async () => { await import('./features/planner/Simulations.tsx'); });
  const insights = container.querySelector<HTMLDetailsElement>('.monthly-insights')!;
  assert.ok(insights);
  await act(async () => insights.querySelector('summary')!.click());
  assert.match(insights.textContent ?? '', /Your priority debt finishes [1-9]\d* days earlier\./);
  assert.equal(commands.length, 0);
});


test('a snapshot keeps forecasts and comparison drafts available while disabling record changes', async () => {
  await render('personal', true);
  assert.match(container.querySelector('.planner-big-money')?.textContent ?? '', /\$1,650/);
  for (const name of ['Add bill or income', 'Record paid', 'Record income']) {
    assert.equal(button(name).disabled, true);
    await click(name);
  }
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Edit Phone bill"]')?.disabled, true);
  assert.equal(container.querySelector('dialog'), null);
  await click('View schedule');
  await frame();
  assert.equal(container.querySelector('.expense-pay-card button'), null);
  for (const panel of container.querySelectorAll('.planner-living')) assert.equal(panel.querySelector<HTMLButtonElement>('button')?.disabled, true);
  assert.equal(button('Add reserve').disabled, true);
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Check balance for Chequing"]')?.disabled, true);
  assert.equal(container.querySelector('.bill-row-actions'), null);
  await click('Compare options');
  await act(async () => { await import('./features/planner/Simulations.tsx'); });
  const pay = container.querySelector<HTMLInputElement>('input[aria-label="Pay per paycheck"]')!;
  assert.ok(pay);
  assert.equal(pay.disabled, false);
  await fill(pay, '2345.67');
  assert.equal(pay.value, '2345.67');
  assert.equal(commands.length, 0);
  assert.equal(opened.length, 0);
  assert.equal(recorded.length, 0);
});

test('switching a planner to a snapshot removes an open payment confirmation and saved-input editor', async () => {
  await render();
  await click('Record paid', container.querySelector('.planner-agenda')!);
  await render('personal', true);
  assert.equal(container.querySelector('.record-dialog'), null);
  assert.equal(commands.length, 0);
  await render();
  await click('Cancel', container.querySelector('.record-dialog')!);
  await click('Plan setup');
  await click('Edit', container.querySelector('.planner-living')!);
  await fill(container.querySelector<HTMLInputElement>('input[aria-label="Monthly living costs"]')!, '123.45');
  await render('personal', true);
  assert.equal(container.querySelector('.planner-living form'), null);
  assert.match(container.querySelector('.planner-living .planner-setup-amount')?.textContent ?? '', /\$0/);
  assert.equal(commands.length, 0);
});

test('an incomplete forecast puts missing inputs before its estimate and focuses the full checklist', async () => {
  state.roadmap!.monthlyEssentialsCents = null;
  await render();
  const warning = container.querySelector('.planner-incomplete')!;
  assert.match(warning.textContent!, /Forecast incomplete.*known costs only/);
  const forecast = container.querySelector('.planner-overview')!;
  assert.ok(warning.compareDocumentPosition(forecast) & 4);
  assert.match(forecast.querySelector('h2')!.textContent!, /Cash after known costs|Forecast cash gap/);
  const checklist = container.querySelector<HTMLDetailsElement>('.planner-checklist')!;
  assert.equal(checklist.open, false);
  await click('Review missing inputs'); await frame();
  assert.equal(checklist.open, true);
  assert.equal(document.activeElement, checklist);
});


test('spending review keeps its selected period and category while newer records arrive', async () => {
  state.transactions = [
    { id: 'food', accountId: 'cash', toAccountId: null, kind: 'expense', amountCents: 4200, category: 'Food', description: 'Weekly groceries', date: today(), source: 'Manual', createdAt: today() },
    { id: 'refund', accountId: 'cash', toAccountId: null, kind: 'expense', amountCents: -1200, category: 'Food', description: 'Grocery refund', date: today(), source: 'Manual', createdAt: today() },
    { id: 'payment', accountId: 'cash', toAccountId: 'loan', kind: 'debt_payment', amountCents: 5000, category: 'Debt payment', description: 'Loan payment', date: today(), source: 'Manual', createdAt: today() },
  ];
  await render();
  await click('Spending review');
  const review = container.querySelector<HTMLElement>('.home-review-workspace')!;
  assert.match(review.querySelector('.review-primary-total')!.textContent!, /\$30/);
  assert.match(review.querySelector('.review-activity')!.textContent!, /Loan payment/);
  await click('Monthly', review);
  const category = review.querySelector<HTMLButtonElement>('.review-category-list button')!;
  await act(async () => { category.focus(); category.click(); });
  assert.doesNotMatch(review.querySelector('.review-activity')!.textContent!, /Loan payment/);
  assert.match(review.querySelector('.review-activity')!.textContent!, /Grocery refund/);
  const selectedMonth = review.querySelector('.review-period-controls > span')!.textContent;
  state = { ...state, revision: state.revision + 1, transactions: [...state.transactions, { ...state.transactions[0], id: 'more-food', description: 'New groceries', amountCents: 1000 }] };
  await render();
  assert.equal(review.getAttribute('data-cadence'), 'monthly');
  assert.equal(review.querySelector('.review-period-controls > span')!.textContent, selectedMonth);
  assert.equal(category.getAttribute('aria-pressed'), 'true');
  assert.equal(document.activeElement, category);
  assert.match(review.querySelector('.review-primary-total')!.textContent!, /\$40/);
  assert.match(review.querySelector('.review-activity')!.textContent!, /New groceries/);
  await click('Clear filters', review);
  assert.match(review.querySelector('.review-activity')!.textContent!, /Loan payment/);
  assert.deepEqual(commands, []);
});

test('review navigation remembers a historical month without changing saved records', async () => {
  await render('personal', true);
  await click('Spending review');
  await click('Monthly');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Previous review month"]')!.click());
  const label = container.querySelector('.review-period-controls > span')!.textContent;
  await click('Your plan');
  await click('Spending review');
  assert.equal(container.querySelector('.review-period-controls > span')!.textContent, label);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render('personal', true);
  await click('Spending review');
  assert.equal(container.querySelector('.home-review-workspace')!.getAttribute('data-cadence'), 'monthly');
  assert.equal(container.querySelector('.review-period-controls > span')!.textContent, label);
  await click('This month');
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Next review month"]')!.disabled, true);
  assert.deepEqual(commands, []);
});

test('selecting a forecast day filters payments and survives a record refresh without moving focus', async () => {
  await render();
  const days = container.querySelectorAll<HTMLButtonElement>('.planner-day-cards button');
  await act(async () => { days[1].focus(); days[1].click(); });
  assert.match(container.querySelector('.planner-agenda')!.textContent!, /Phone bill/);
  assert.equal(container.querySelectorAll('.planner-agenda .planner-event').length, 1);
  state = { ...state, revision: state.revision + 1 };
  await render();
  assert.equal(container.querySelector('.planner-day-cards button[aria-pressed="true"]')!.id, days[1].id);
  assert.equal(document.activeElement, days[1]);
  await act(async () => days[0].click());
  assert.equal(container.querySelectorAll('.planner-agenda .planner-event').length, 0);
  await click('Show all dates', container.querySelector('.planner-horizon')!);
  assert.equal(container.querySelectorAll('.planner-agenda .planner-event').length, 1);
  assert.deepEqual(commands, []);
});


test('planner keeps spending review in forecast details and bill management in Expenses', async () => {
  await render();
  const navigationTabs = container.querySelector('[aria-label="Planner sections"]')!;
  assert.equal(navigationTabs.querySelectorAll('button').length, 3);
  assert.doesNotMatch(navigationTabs.textContent!, /Spending review/);
  const details = container.querySelector<HTMLDetailsElement>('.planner-method')!;
  assert.equal(details.open, false);
  await act(async () => details.querySelector('summary')!.click());
  await click('Spending review', details);
  assert.equal(container.querySelector('.planner-spending-review')!.hasAttribute('hidden'), false);
  assert.match(container.querySelector('.planner-review-location')!.textContent!, /Past spending/);
  assert.equal(button('Spending review', navigationTabs).getAttribute('aria-pressed'), 'true');
  await click('Your plan');
  assert.equal(navigationTabs.querySelectorAll('button').length, 3);
  await click('Plan setup');
  assert.equal(container.querySelector('.planner-setup .expense-bills'), null);
  await click('Manage bills', container.querySelector('.planner-bill-location')!);
  assert.deepEqual(navigation, [{ view: 'expenses', section: 'schedule' }]);
  assert.deepEqual(commands, []);
});
