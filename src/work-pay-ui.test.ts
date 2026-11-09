import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState } from '../shared/types.ts';
import type { PayrollImport, PayrollPaystub } from '../shared/payroll.ts';
import { validatePayrollImport } from '../server/payroll.ts';
import { createGuardedHistory } from './app/guarded-history.ts';
import { requestDraftNavigation } from './hooks/draft-protection.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
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
const { default: WorkPay } = await import('./features/pay/WorkPay.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
let requestCount = 0;

function paystub(id: string, payDate: string, patch: Partial<PayrollPaystub> = {}): PayrollPaystub {
  return { id, sourceId: 'pay-source', sourcePage: 1, payDate, periodStart: payDate, periodEnd: payDate, sequence: `REF-${id}`, employer: 'Example Employer', payFrequency: 'Bi-weekly', payRate: '25.0000', grossCents: 200000, netCents: 150000, taxCents: 40000, deductionCents: 10000, hours: 80,
    earnings: [{ label: 'Regular', hours: 80, rate: '25.0000', amountCents: 200000, ytdHours: 80, ytdAmountCents: 200000 }],
    taxes: [{ label: 'Income tax', amountCents: 40000, ytdAmountCents: 40000 }], deductions: [{ label: 'Pension', amountCents: 10000, ytdAmountCents: 10000 }],
    ytd: { grossCents: 200000, netCents: 150000, taxCents: 40000, deductionCents: 10000, hours: 80 }, paymentMethod: 'Direct Deposit', vacationBalanceCents: null, vacationAccruedCents: 8000, ...patch };
}
function fixture(): AppState {
  const payroll: PayrollImport = { id: 'sample-import', importedAt: '2026-02-01T12:00:00Z', schemaVersion: 1, currency: 'CAD', archive: { filename: 'Sample-pay.zip', sha256: 'a'.repeat(64) },
    sources: [{ id: 'pay-source', filename: 'Sample-pay.pdf', sha256: 'b'.repeat(64), mimeType: 'application/pdf', kind: 'paystub', pageCount: 3 }, { id: 'hour-source', filename: 'Sample-hours.png', sha256: 'c'.repeat(64), mimeType: 'image/png', kind: 'timecards', pageCount: 1 }],
    paystubs: [paystub('old', '2025-12-31'), paystub('first', '2026-01-15', { sourcePage: 2, grossCents: 100000, netCents: 75000, taxCents: 20000, deductionCents: 5000, hours: 40, earnings: [{ label: 'Regular', hours: 40, rate: '25.0000', amountCents: 100000, ytdHours: 40, ytdAmountCents: 100000 }], taxes: [{ label: 'Income tax', amountCents: 20000, ytdAmountCents: 20000 }], deductions: [{ label: 'Pension', amountCents: 5000, ytdAmountCents: 5000 }], ytd: { grossCents: 100000, netCents: 75000, taxCents: 20000, deductionCents: 5000, hours: 40 } }), paystub('second', '2026-01-29', { sourcePage: 3,
      earnings: [{ label: 'Regular', hours: 88, rate: '25.0000', amountCents: 220000, ytdHours: 128, ytdAmountCents: 320000 }, { label: 'Advance correction', hours: -8, rate: '25.0000', amountCents: -20000, ytdHours: -8, ytdAmountCents: 0 }, { label: 'Prior bonus', hours: null, rate: null, amountCents: null, ytdHours: null, ytdAmountCents: 10000 }],
      taxes: [{ label: 'Income tax', amountCents: 40000, ytdAmountCents: 60000 }], deductions: [{ label: 'Pension', amountCents: 10000, ytdAmountCents: 20000 }], ytd: { grossCents: 330000, netCents: 250000, taxCents: 60000, deductionCents: 20000, hours: 120 } })],
    timecards: [{ id: 'legacy', sourceId: 'hour-source', sourceRow: 1, periodStart: '2026-01-05', periodEnd: '2026-01-11', hours: 40, status: 'Approved', submissionDate: '2026-01-12', transferredTo: null, system: 'legacy' }, { id: 'projects', sourceId: 'hour-source', sourceRow: 2, periodStart: '2026-01-08', periodEnd: '2026-01-14', hours: 37.5, status: 'Submitted', submissionDate: null, transferredTo: 'Payroll', system: 'projects' }],
    issues: [{ id: 'overlapping-timecards', severity: 'review', title: 'Timecard periods overlap', detail: 'The two schedules cover some of the same dates. Review the source before adding work hours.', sourceIds: ['hour-source'], paystubIds: ['first'], timecardIds: ['legacy', 'projects'] }, { id: 'source-note', severity: 'info', title: 'Original values retained', detail: 'The source contains signed corrections.', sourceIds: ['pay-source'], paystubIds: ['second'], timecardIds: [] }] };
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'cash', entityId: 'personal', name: 'Sample chequing', type: 'cash', currency: 'CAD', balanceCents: 900000, reconciledAt: '2026-01-31' }], transactions: [{ id: 'recorded-deposit', date: '2026-01-29', description: 'Payroll deposit', kind: 'income', amountCents: 150000, accountId: 'cash', toAccountId: null, category: 'Salary', source: 'Sample bank statement', createdAt: '2026-02-01T12:00:00Z' }], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null, payrollImports: [payroll] };
}
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); requestCount = 0; globalThis.fetch = async () => { requestCount++; throw new Error('Work and pay browsing must not send a network request.'); }; });
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });
async function render(state = fixture()) { await act(async () => root.render(createElement(WorkPay, { state }))); }
function button(label: string | RegExp, scope: ParentNode = container): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.getAttribute('aria-label') ?? item.textContent ?? ''));
  assert.ok(result, `Missing button ${label}`); return result;
}
async function click(label: string | RegExp, scope: ParentNode = container) { await act(async () => button(label, scope).click()); }
async function choose(select: HTMLSelectElement, value: string) { assert.ok(select); await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) { assert.ok(input); await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function until(check: () => boolean) {
  for (let count = 0; count < 100; count++) {
    if (check()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
  }
  assert.ok(check(), 'Payroll navigation did not reach the expected state.');
}
async function renderRouted(t: { after: (callback: () => void) => void }, hash = '#pay', state = fixture(), onCommand?: (command: import('../shared/types.ts').Command) => Promise<void>) {
  window.history.replaceState(null, '', hash);
  const readSection = (): 'pay' | 'hours' | 'review' | undefined => {
    const section = window.location.hash.split('/')[1];
    return section === 'statements' ? 'pay' : section === 'hours' || section === 'review' ? section : undefined;
  };
  let section = readSection();
  const navigation = createGuardedHistory({ window, requestNavigation: requestDraftNavigation, onNavigate: () => { section = readSection(); draw(); } });
  const changeSection = (next: 'pay' | 'hours' | 'review') => navigation.navigate(`#pay/${next === 'pay' ? 'statements' : next}`);
  const draw = () => root.render(createElement(WorkPay, { state, initialSection: section, onSectionChange: changeSection, onCommand }));
  t.after(() => navigation.dispose());
  await act(async () => draw());
  return { remount: async () => { await act(async () => root.unmount()); root = createRoot(container); await act(async () => draw()); } };
}

test('the latest statement distinguishes a possible bank match from confirmed receipt and keeps work periods separate', async () => {
  const state = fixture(); const before = structuredClone(state);
  await render(state);
  const latest = container.querySelector('.pay-review-latest')!;
  assert.match(latest.textContent!, /Latest pay statement.*Jan 29, 2026.*\$1,500\.00/);
  assert.match(latest.textContent!, /Amount\/date match.*Check its bank source/);
  assert.doesNotMatch(latest.textContent!, /Deposit confirmed|unpaid/);
  assert.match(container.querySelector('.pay-review-hours-shortcut')!.textContent!, /2timecards.*Jan 14, 2026.*Systems remain separate/);
  assert.doesNotMatch(container.querySelector('.pay-review-start')!.textContent!, /77\.5/);
  await render({ ...state, revision: 2, transactions: [] });
  assert.match(container.querySelector('.pay-review-latest')!.textContent!, /No deposit in records.*Receipt in your bank is not confirmed/);
  assert.deepEqual(state, before);
  assert.equal(requestCount, 0);
});

test('bank confirmation counts only reviewed deposits and follows the selected pay period', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-30T17:00:00Z') });
  const state = fixture();
  await render(state);
  assert.match(container.querySelector('.pay-bank-coverage')!.textContent!, /0 of 3 statements confirmed.*1 statement has a possible deposit match/);
  assert.equal(container.querySelector('.pay-bank-coverage-meter')!.getAttribute('aria-valuenow'), '0');
  const confirmed = structuredClone(state);
  confirmed.revision = 2;
  confirmed.payrollImports![0].bankLinks = [{ id: 'reviewed-deposit', paystubId: 'second', transactionId: 'recorded-deposit', reviewedAt: '2026-01-30T12:00:00Z', note: 'Checked against bank statement.' }];
  const original = structuredClone(confirmed);
  await render(confirmed);
  assert.match(container.querySelector('.pay-bank-coverage')!.textContent!, /1 of 3 statements confirmed/);
  await click('Monthly review');
  assert.match(container.querySelector('.pay-bank-coverage')!.textContent!, /1 of 2 statements confirmed/);
  assert.equal(container.querySelector('.pay-bank-coverage-meter')!.getAttribute('aria-valuemax'), '2');
  await click('Review bank evidence');
  assert.match(container.querySelector('.work-pay-detail')!.getAttribute('aria-label')!, /Jan 15, 2026/);
  assert.equal(document.activeElement, container.querySelector('.work-pay-detail'));
  assert.deepEqual(confirmed, original);
  assert.equal(requestCount, 0);
});

test('the latest work-period end includes longer overlapping periods without reordering timecards', async () => {
  const state = fixture();
  const batch = state.payrollImports![0];
  batch.importedAt = '2026-02-01T12:00:00.000Z';
  batch.paystubs = []; batch.issues = [];
  batch.sources = batch.sources.filter(source => source.kind === 'timecards');
  batch.timecards = batch.timecards.map((card, index) => ({ ...card, system: 'projects', periodStart: index === 0 ? '2026-01-01' : '2026-01-08', periodEnd: index === 0 ? '2026-01-31' : '2026-01-14' }));
  state.payrollImports = [validatePayrollImport(batch)];
  const before = structuredClone(state);
  await render(state);
  const overview = container.querySelector('.pay-review-hours-shortcut')!;
  assert.equal(overview.querySelector('time')!.getAttribute('datetime'), '2026-01-31');
  assert.match(overview.textContent!, /2timecards.*Latest period ends Jan 31, 2026/);
  const rows = [...container.querySelectorAll('.work-pay-timecard-group tbody tr')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent!, /Jan 8 to Jan 14, 2026/);
  assert.match(rows[1].textContent!, /Jan 1 to Jan 31, 2026/);
  assert.deepEqual(state, before);
  assert.equal(requestCount, 0);
});

test('monthly pay review filters totals by pay date and latest-statement access clears an older month', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-30T17:00:00Z') });
  const state = fixture(); const before = structuredClone(state);
  await render(state);
  await click('Monthly review');
  const month = container.querySelector<HTMLInputElement>('input[aria-label="Payroll review month"]')!;
  assert.equal(month.value, '2026-01');
  assert.match(container.querySelector('.work-pay-net')!.textContent!, /\$2,250\.00/);
  assert.equal(container.querySelectorAll('.work-pay-history-row').length, 2);
  await fill(month, '2025-12');
  assert.match(container.querySelector('.work-pay-net')!.textContent!, /\$1,500\.00/);
  assert.equal(container.querySelectorAll('.work-pay-history-row').length, 1);
  assert.match(container.querySelector('.work-pay-detail')!.getAttribute('aria-label')!, /Dec 31, 2025/);
  await click('Inspect latest statement');
  assert.equal(button('All imported pay').getAttribute('aria-pressed'), 'true');
  assert.match(container.querySelector('.work-pay-detail')!.getAttribute('aria-label')!, /Jan 29, 2026/);
  assert.equal(document.activeElement, container.querySelector('.work-pay-detail'));
  button('Inspect latest statement').focus();
  await click('Inspect latest statement');
  assert.equal(document.activeElement, container.querySelector('.work-pay-detail'), 'Already selected latest statement still receives keyboard focus');
  await choose(container.querySelector('select[aria-label="Pay statement year"]')!, '2026');
  button('Inspect latest statement').focus();
  await click('Inspect latest statement');
  assert.equal(document.activeElement, container.querySelector('.work-pay-detail'), 'Clearing only the year filter still focuses the statement');
  await click('This year');
  assert.match(container.querySelector('.work-pay-net')!.textContent!, /\$2,250\.00/);
  assert.deepEqual(state, before);
  assert.equal(requestCount, 0);
});

test('a current year with no payroll records does not fall back to earlier statements', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-15T17:00:00Z') });
  await render();
  await click('This year');
  assert.equal(container.querySelectorAll('.work-pay-history-row').length, 0);
  assert.equal(container.querySelector('.work-pay-detail'), null);
  assert.match(container.querySelector('.work-pay-period')!.textContent!, /2027.*No pay dates in this range/);
  assert.match(container.querySelector('.work-pay-net')!.textContent!, /\$0\.00.*No pay statements in this period/);
  assert.equal(requestCount, 0);
});

test('review filters keep source notes mounted and guard unsaved review decisions', async () => {
  const state = fixture(); const before = structuredClone(state);
  await act(async () => root.render(createElement(WorkPay, { state, onCommand: async () => { assert.fail('Browsing must not save a review'); } })));
  await click(/Review & sources/);
  const sourceNote = container.querySelector<HTMLElement>('.work-pay-issue.info')!;
  assert.equal(sourceNote.hidden, true);
  await click(/^All source notes/);
  assert.equal(sourceNote.hidden, false);
  const input = container.querySelector<HTMLTextAreaElement>('.work-pay-issue.review textarea')!;
  await fill(input, 'Check against the original before resolving.');
  await click(/^All source notes/);
  assert.equal(document.querySelector('.draft-discard-dialog'), null);
  await click(/^Open items/);
  assert.ok(document.querySelector('.draft-discard-dialog'));
  await click('Keep editing', document);
  assert.equal(input.value, 'Check against the original before resolving.');
  assert.equal(sourceNote.hidden, false);
  assert.equal(sourceNote, container.querySelector('.work-pay-issue.info'));
  assert.deepEqual(state, before);
  assert.equal(requestCount, 0);
});

test('payroll tables expose named keyboard scrolling regions for earnings and each timecard system', async () => {
  await render();
  const current = container.querySelector<HTMLElement>('.work-pay-lines .work-pay-table-scroll')!;
  assert.equal(current.getAttribute('role'), 'region');
  assert.equal(current.getAttribute('aria-label'), 'Current earnings for Jan 29, 2026');
  assert.equal(current.tabIndex, 0);
  current.focus();
  assert.equal(document.activeElement, current);
  container.querySelector<HTMLDetailsElement>('.work-pay-ytd')!.open = true;
  const year = container.querySelector<HTMLElement>('.work-pay-ytd .work-pay-table-scroll')!;
  assert.equal(year.getAttribute('role'), 'region');
  assert.equal(year.getAttribute('aria-label'), 'Year-to-date earnings for Jan 29, 2026');
  assert.equal(year.tabIndex, 0);
  year.focus();
  assert.equal(document.activeElement, year);
  await click('Work hours');
  const tables = [...container.querySelectorAll<HTMLElement>('.work-pay-timecard-group .work-pay-table-scroll')];
  assert.deepEqual(tables.map(table => table.getAttribute('aria-label')), ['Projects timecards', 'Legacy timecards']);
  for (const table of tables) {
    assert.equal(table.getAttribute('role'), 'region');
    assert.equal(table.tabIndex, 0);
    table.focus();
    assert.equal(document.activeElement, table);
  }
  assert.equal(requestCount, 0);
});

test('payroll subsection URLs restore the selected view through remount, Back and Forward', async t => {
  const state = fixture(); const before = structuredClone(state);
  const routed = await renderRouted(t, '#pay/hours', state);
  assert.equal(button('Work hours').getAttribute('aria-pressed'), 'true');
  await click(/Review & sources/);
  assert.equal(window.location.hash, '#pay/review');
  await routed.remount();
  assert.equal(button(/Review & sources/).getAttribute('aria-pressed'), 'true');
  await act(async () => window.history.back());
  await until(() => button('Work hours').getAttribute('aria-pressed') === 'true');
  assert.equal(window.location.hash, '#pay/hours');
  await act(async () => window.history.forward());
  await until(() => button(/Review & sources/).getAttribute('aria-pressed') === 'true');
  await click('Jan 15 pay');
  assert.equal(window.location.hash, '#pay/statements');
  assert.match(container.querySelector('.work-pay-detail')!.getAttribute('aria-label')!, /Jan 15, 2026/);
  assert.equal(document.activeElement, container.querySelector('.work-pay-detail'));
  await click(/1 review item linked/);
  assert.equal(window.location.hash, '#pay/review');
  assert.equal(document.activeElement, container.querySelector('.work-pay-review-heading h2'));
  assert.deepEqual(state, before);
  assert.equal(requestCount, 0);
});

test('payroll section navigation and browser history retain review drafts until one discard is accepted', async t => {
  const state = fixture(); const before = structuredClone(state);
  let commands = 0;
  await renderRouted(t, '#pay', state, async () => { commands++; });
  let note = container.querySelector<HTMLTextAreaElement>('.payroll-review-control textarea')!;
  await fill(note, 'Keep this source review.');
  await click('Pay statements');
  assert.equal(document.querySelector('.draft-discard-dialog'), null);
  await click('Work hours');
  assert.ok(document.querySelector('.draft-discard-dialog'));
  assert.equal(window.location.hash, '#pay');
  await click('Keep editing', document);
  assert.equal(note.value, 'Keep this source review.');
  await click('Work hours');
  await click('Discard changes', document);
  assert.equal(window.location.hash, '#pay/hours');
  assert.equal(document.querySelector('.draft-discard-dialog'), null);
  assert.equal(button('Work hours').getAttribute('aria-pressed'), 'true');
  await act(async () => window.history.back());
  await until(() => button('Pay statements').getAttribute('aria-pressed') === 'true');
  note = container.querySelector<HTMLTextAreaElement>('.payroll-review-control textarea')!;
  await fill(note, 'Keep this second note.');
  note.focus();
  await act(async () => window.history.forward());
  await until(() => !!document.querySelector('.draft-discard-dialog') && window.location.hash === '#pay');
  await click('Keep editing', document);
  assert.equal(note.value, 'Keep this second note.');
  await until(() => document.activeElement === note);
  await act(async () => window.history.forward());
  await until(() => !!document.querySelector('.draft-discard-dialog') && window.location.hash === '#pay');
  await click('Discard changes', document);
  await until(() => button('Work hours').getAttribute('aria-pressed') === 'true');
  assert.equal(window.location.hash, '#pay/hours');
  assert.equal(document.querySelector('.draft-discard-dialog'), null);
  assert.deepEqual(state, before);
  assert.equal(commands, 0);
  assert.equal(requestCount, 0);
});

test('payroll history restores subsection focus after a linked statement unmounts', async t => {
  await renderRouted(t, '#pay/hours');
  const review = button(/Review & sources/);
  review.focus();
  await click(/Review & sources/);
  assert.equal(document.activeElement, review);
  await click('Jan 15 pay');
  assert.equal(document.activeElement, container.querySelector('.work-pay-detail'));
  await act(async () => window.history.back());
  await until(() => button(/Review & sources/).getAttribute('aria-pressed') === 'true');
  assert.equal(window.location.hash, '#pay/review');
  assert.ok(document.activeElement === button(/Review & sources/), 'Back restores focus to the selected review section');
  await act(async () => window.history.forward());
  await until(() => button('Pay statements').getAttribute('aria-pressed') === 'true');
  assert.ok(document.activeElement === button('Pay statements'), 'Forward restores focus to the selected pay section');
  await click(/1 review item linked/);
  assert.equal(document.activeElement, container.querySelector('.work-pay-review-heading h2'));
  const hours = button('Work hours');
  hours.focus();
  await click('Work hours');
  assert.equal(document.activeElement, hours);
  assert.equal(requestCount, 0);
});

test('payroll restores its section when outgoing and return routes arrive before the next render', async () => {
  const state = fixture(); const before = structuredClone(state);
  const requested: string[] = [];
  const changeSection = (next: 'pay' | 'hours' | 'review') => {
    requested.push(next);
    root.render(createElement(WorkPay, { state, initialSection: next, onSectionChange: changeSection }));
    root.render(createElement(WorkPay, { state, initialSection: 'review', onSectionChange: changeSection }));
  };
  await act(async () => root.render(createElement(WorkPay, { state, initialSection: 'review', onSectionChange: changeSection })));
  await click('Jan 15 pay');
  assert.deepEqual(requested, ['pay']);
  assert.equal(button(/Review & sources/).getAttribute('aria-pressed'), 'true');
  assert.equal(container.querySelector('.work-pay-detail'), null);
  assert.ok(document.activeElement === button(/Review & sources/), 'The return route restores focus to its selected section');
  assert.deepEqual(state, before);
  assert.equal(requestCount, 0);
});

test('an explicit pay-statements route survives refresh for timecard-only records', async t => {
  const state = fixture();
  state.payrollImports![0].paystubs = [];
  state.payrollImports![0].issues = [];
  const routed = await renderRouted(t, '#pay', state);
  assert.equal(button('Work hours').getAttribute('aria-pressed'), 'true');
  await click('Pay statements');
  assert.equal(window.location.hash, '#pay/statements');
  await routed.remount();
  assert.equal(button('Pay statements').getAttribute('aria-pressed'), 'true');
  assert.match(container.textContent!, /No pay statements saved yet/);
  assert.equal(requestCount, 0);
});

test('pay summary uses pay-date filters while original YTD remains tied to the selected statement', async () => {
  await render();
  assert.match(container.querySelector('.work-pay-net')!.textContent!, /\$3,750\.00/);
  assert.match(container.querySelector('.work-pay-period')!.textContent!, /Dec 31, 2025 to Jan 29, 2026/);
  await choose(container.querySelector('select[aria-label="Pay statement year"]')!, '2026');
  assert.match(container.querySelector('.work-pay-net')!.textContent!, /\$2,250\.00/);
  assert.equal(container.querySelectorAll('.work-pay-history-row').length, 2);
  assert.match(container.querySelector('.work-pay-ytd')!.textContent!, /\$2,500\.00/);
  assert.match(container.querySelector('.work-pay-ytd')!.textContent!, /do not change with the period filter/);
  assert.equal(container.querySelector('.work-pay-vacation dd')!.textContent, 'Not listed');
});

test('history search, ordering and chart selection inspect the matching original source page', async () => {
  await render();
  const trend = container.querySelector<HTMLDetailsElement>('.work-pay-trend')!;
  assert.equal(trend.open, false);
  await choose(container.querySelector('select[aria-label="Sort pay statements"]')!, 'oldest');
  assert.match(container.querySelector('.work-pay-history-row')!.textContent!, /Dec 31, 2025/);
  await fill(container.querySelector('input[type="search"]')!, 'REF-first');
  assert.equal(container.querySelectorAll('.work-pay-history-row').length, 1);
  assert.match(container.querySelector('.work-pay-detail')!.getAttribute('aria-label')!, /Jan 15, 2026/);
  assert.equal(container.querySelector('.work-pay-detail > header a')!.getAttribute('href'), `/api/documents/${'b'.repeat(64)}/content?workspace=live#page=2`);
  await act(async () => trend.querySelector('summary')!.click());
  assert.equal(trend.open, true);
  await click(/View pay statement for Jan 29, 2026/);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="search"]')!.value, '');
  assert.match(container.querySelector('.work-pay-detail')!.getAttribute('aria-label')!, /Jan 29, 2026/);
  assert.equal(document.activeElement, container.querySelector('.work-pay-detail'));
  assert.equal(container.querySelectorAll('.work-pay-bar[aria-pressed="true"]').length, 1);
  await fill(container.querySelector('input[type="search"]')!, 'nothing-like-this');
  assert.match(container.textContent!, /No matching statements/);
  assert.equal(container.querySelector('.work-pay-detail'), null);
  await click('Clear search');
  assert.equal(container.querySelectorAll('.work-pay-history-row').length, 3);
});

test('signed corrections, unknown current amounts and recorded deposits stay separate from worked hours', async () => {
  const state = fixture(); const before = structuredClone(state);
  await render(state);
  const detail = container.querySelector('.work-pay-detail')!;
  assert.match(detail.textContent!, /Amount\/date match/);
  assert.match(detail.textContent!, /Sample chequing/);
  assert.match(detail.querySelector('.work-pay-negative')!.textContent!, /Advance correction-8\$25\.0000-\$200\.00/);
  assert.doesNotMatch(detail.querySelector('.work-pay-lines table')!.textContent!, /Prior bonus/);
  assert.match(detail.querySelector('.work-pay-ytd-only')!.textContent!, /1 earning type appears only/);
  assert.match(detail.querySelector('.work-pay-ytd')!.textContent!, /Prior bonusNot listed\$100\.00/);
  assert.match(detail.textContent!, /not a total of hours worked/);
  await click(/Inspect Jan 15, 2026/);
  assert.match(container.querySelector('.work-pay-detail')!.textContent!, /No deposit in records/);
  assert.doesNotMatch(container.querySelector('.work-pay-detail')!.textContent!, /unpaid|overdue/);
  assert.deepEqual(state, before);
  assert.equal(requestCount, 0);
});

test('work hours keep overlapping source systems separate and filters preserve original rows', async () => {
  await render(); await click('Work hours');
  assert.equal(container.querySelectorAll('.work-pay-timecard-group').length, 2);
  assert.match(container.querySelector('.work-pay-hours-note')!.textContent!, /same dates/);
  assert.doesNotMatch(container.querySelector('.work-pay-hours')!.textContent!, /77\.5/);
  assert.equal(container.querySelectorAll('.work-pay-timecard-group tbody tr').length, 2);
  const filters = container.querySelectorAll<HTMLSelectElement>('.work-pay-hour-filters select');
  await choose(filters[0], 'projects');
  assert.equal(container.querySelectorAll('.work-pay-timecard-group').length, 1);
  assert.match(container.querySelector('.work-pay-timecard-group')!.textContent!, /37\.5/);
  assert.match(container.querySelector('.work-pay-timecard-group')!.textContent!, /Not listed/);
  assert.equal(container.querySelector('.work-pay-timecard-group td a')!.getAttribute('href'), `/api/documents/${'c'.repeat(64)}/content?workspace=live`);
  await choose(filters[1], 'Approved');
  assert.match(container.textContent!, /No timecards match these filters/);
  assert.equal(container.querySelectorAll('.work-pay-timecard-group').length, 0);
  await click('Clear timecard filters');
  assert.equal(container.querySelectorAll('.work-pay-timecard-group tbody tr').length, 2);
  assert.equal(filters[0].value, 'all');
  assert.equal(filters[1].value, 'all');
  assert.equal(requestCount, 0);
});

test('timecard-only records open Work hours and explain the missing pay statements', async () => {
  const state = fixture();
  state.payrollImports![0].paystubs = [];
  state.payrollImports![0].issues = [];
  await render(state);
  assert.equal(container.querySelector('.work-pay-nav button[aria-pressed="true"]')!.textContent, 'Work hours');
  assert.equal(container.querySelectorAll('.work-pay-timecard-group tbody tr').length, 2);
  await click('Pay statements');
  assert.match(container.textContent!, /No pay statements saved yet/);
  assert.equal(container.querySelector('.work-pay-overview'), null);
  assert.equal(requestCount, 0);
});

test('pay-only records show a timecard empty state and recover when a selected year disappears', async () => {
  let state = fixture();
  state.payrollImports![0].timecards = [];
  await render(state);
  await choose(container.querySelector('select[aria-label="Pay statement year"]')!, '2026');
  state = { ...state, payrollImports: [{ ...state.payrollImports![0], paystubs: [state.payrollImports![0].paystubs[0]] }] };
  await render(state);
  assert.equal(container.querySelector<HTMLSelectElement>('select[aria-label="Pay statement year"]')!.value, 'all');
  assert.equal(container.querySelectorAll('.work-pay-history-row').length, 1);
  await click('Work hours');
  assert.match(container.textContent!, /No timecards saved yet/);
  assert.equal(container.querySelector('.work-pay-hour-filters'), null);
  assert.equal(container.querySelector('.work-pay-timecard-group'), null);
  assert.equal(requestCount, 0);
});

test('review links return to the specific statement and all source links point to saved files', async () => {
  await render(); await click(/Review & sources/);
  assert.match(container.querySelector('.work-pay-review-heading')!.textContent!, /1 item to check/);
  assert.equal(container.querySelectorAll('.work-pay-issue.review').length, 1);
  assert.equal(container.querySelectorAll('.work-pay-issue.info').length, 1);
  const links = [...container.querySelectorAll<HTMLAnchorElement>('.work-pay-sources a')];
  assert.equal(links.length, 2);
  assert.ok(links.every(link => link.getAttribute('href')?.startsWith('/api/documents/') && link.rel === 'noreferrer' && link.target === '_blank'));
  await click('Jan 15 pay');
  assert.equal(container.querySelector('.work-pay-nav button[aria-pressed="true"]')!.textContent, 'Pay statements');
  assert.match(container.querySelector('.work-pay-detail')!.getAttribute('aria-label')!, /Jan 15, 2026/);
  await click(/1 review item linked/);
  assert.ok(container.querySelector('.work-pay-review'));
});

test('resolved payroll reviews keep their source history without an open-warning label', async () => {
  const state = fixture();
  state.payrollImports![0].issueReviews = [{ id: 'review', issueId: 'overlapping-timecards', status: 'resolved', reviewedAt: '2026-02-02T12:00:00Z', note: 'Checked the original rows.' }];
  await render(state); await click(/Review & sources/);
  assert.match(container.querySelector('.work-pay-review-heading')!.textContent!, /No open review items/);
  const issue = [...container.querySelectorAll('.work-pay-issue')].find(node => node.textContent?.includes('Timecard periods overlap'))!;
  assert.match(issue.textContent!, /Resolved/);
  assert.doesNotMatch(issue.textContent!, /Needs review/);
  assert.equal(container.querySelectorAll('.work-pay-sources a').length, 2);
});

test('the empty state does not invent pay, forecast income or offer an unsafe posting action', async () => {
  const state = fixture(); delete state.payrollImports;
  await render(state);
  assert.match(container.textContent!, /Keep work hours and pay in one place/);
  assert.equal(container.querySelector('.work-pay-overview'), null);
  assert.equal(container.querySelectorAll('button').length, 0);
  assert.equal(requestCount, 0);
});

test('the first imported records do not remount an open payroll draft during refresh', async () => {
  const initial = fixture(); delete initial.payrollImports;
  const props = { state: initial, onCommand: async () => {} };
  await act(async () => root.render(createElement(WorkPay, props)));
  await click('Add payroll records');
  const employer = [...container.querySelectorAll('label')].find(label => label.firstChild?.textContent === 'Employer')!.querySelector('input')!;
  await fill(employer, 'Unsaved employer');
  const dialogBefore = container.querySelector('.payroll-intake');
  await act(async () => root.render(createElement(WorkPay, { ...props, state: { ...fixture(), revision: 2 } })));
  assert.equal(container.querySelector('.payroll-intake'), dialogBefore);
  assert.equal(employer.value, 'Unsaved employer');
  assert.match(container.querySelector('.payroll-intake')!.textContent!, /Records changed while this form was open/);
  assert.equal(requestCount, 0);
});

test('saving the first timecards opens the saved Work hours section', async () => {
  let state = fixture(); delete state.payrollImports;
  let saved = 0;
  const onCommand = async (command: import('../shared/types.ts').Command) => {
    assert.equal(command.type, 'import_payroll');
    if (command.type !== 'import_payroll') assert.fail('Expected payroll records');
    saved++;
    state = { ...state, revision: state.revision + 1, payrollImports: [command.import] };
    draw();
  };
  const draw = () => root.render(createElement(WorkPay, { state, onCommand }));
  globalThis.fetch = async (_url, options) => {
    requestCount++;
    const bytes = Buffer.from(options!.body as ArrayBuffer);
    return Response.json({ document: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mimeType: 'application/pdf', originalName: 'Timecards.pdf' } }, { status: 201 });
  };
  await act(async () => draw()); await click('Add payroll records');
  await choose(container.querySelector('.payroll-intake select')!, 'timecards');
  for (const [label, value] of [['Period start', '2026-01-05'], ['Period end', '2026-01-11'], ['Hours', '37.5'], ['Source status', 'Approved']]) {
    const input = [...container.querySelectorAll('label')].find(node => node.firstChild?.textContent === label)!.querySelector('input')!;
    await fill(input, value);
  }
  const file = container.querySelector<HTMLInputElement>('.payroll-intake input[type=file]')!;
  Object.defineProperty(file, 'files', { configurable: true, value: [new File(['%PDF-1.4\nTimecards'], 'Timecards.pdf', { type: 'application/pdf' })] });
  await act(async () => {
    file.dispatchEvent(new Event('change', { bubbles: true }));
    for (let index = 0; index < 30 && (index === 0 || container.textContent?.includes('Reading original…')); index++) await new Promise(resolve => setTimeout(resolve, 5));
  });
  await click('Review entered records');
  await act(async () => container.querySelector<HTMLInputElement>('.payroll-intake-preview input[type=checkbox]')!.click());
  await act(async () => container.querySelector('.payroll-intake form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(saved, 1);
  assert.equal(requestCount, 1);
  assert.equal(container.querySelector('.payroll-intake'), null);
  assert.equal(container.querySelector('.work-pay-nav button[aria-pressed="true"]')!.textContent, 'Work hours');
  assert.match(container.querySelector('.work-pay-timecard-group')!.textContent!, /37.5/);
});

test('runtime arithmetic differences appear in the statement and review even without a saved issue', async () => {
  const state = fixture();
  state.payrollImports![0].paystubs[2].netCents += 100;
  await render(state);
  assert.match(container.querySelector('.work-pay-arithmetic-warning')!.textContent!, /Gross less taxes and deductions differs from the reported total by -\$1\.00/);
  await click(/Review & sources/);
  assert.equal(container.querySelectorAll('.work-pay-issue.review').length, 2);
  assert.match(container.querySelector('.work-pay-issues')!.textContent!, /Jan 29, 2026 totals need review/);
});

test('a year-to-date advance row does not imply a current payroll correction', async () => {
  const state = fixture();
  state.payrollImports![0].paystubs = [paystub('clean-current', '2026-02-12', { earnings: [{ label: 'Regular', hours: 80, rate: '25.0000', amountCents: 200000, ytdHours: 80, ytdAmountCents: 200000 }, { label: 'Advance', hours: null, rate: null, amountCents: null, ytdHours: 0, ytdAmountCents: 0 }] })];
  await render(state);
  assert.equal(container.querySelector('.work-pay-adjustment-note'), null);
  assert.doesNotMatch(container.querySelector('.work-pay-lines table')!.textContent!, /Advance/);
  assert.match(container.querySelector('.work-pay-ytd')!.textContent!, /Advance/);
});

test('same-day pay statements have distinct accessible names that include their amounts and deposit status', async () => {
  const state = fixture();
  state.payrollImports![0].paystubs.push(paystub('same-day-bonus', '2026-01-29', { sequence: 'BONUS-REF', netCents: 25000 }));
  await render(state);
  const rows = [...container.querySelectorAll<HTMLButtonElement>('.work-pay-history-row')];
  const sameDay = rows.filter(row => row.getAttribute('aria-label')!.includes('Jan 29, 2026'));
  assert.equal(sameDay.length, 2);
  assert.notEqual(sameDay[0].getAttribute('aria-label'), sameDay[1].getAttribute('aria-label'));
  const regular = sameDay.find(row => row.getAttribute('aria-label')!.includes('REF-second'))!;
  const bonus = sameDay.find(row => row.getAttribute('aria-label')!.includes('BONUS-REF'))!;
  assert.ok(regular);
  assert.ok(bonus);
  assert.match(regular.getAttribute('aria-label')!, /Example Employer.*net \$1,500\.00.*Amount\/date match.*80 payroll hours/);
  assert.match(bonus.getAttribute('aria-label')!, /net \$250\.00.*No deposit in records/);
  assert.equal(requestCount, 0);
});

test('review links move keyboard focus to the opened statement and back to the review heading', async () => {
  await render();
  await click(/Review & sources/);
  const issueLink = button('Jan 15 pay');
  issueLink.focus();
  await act(async () => issueLink.click());
  const detail = container.querySelector<HTMLElement>('.work-pay-detail')!;
  assert.ok(document.activeElement === detail, 'the opened pay statement receives keyboard focus');
  assert.match(detail.getAttribute('aria-label')!, /Jan 15, 2026/);
  const reviewLink = button(/1 review item linked/);
  reviewLink.focus();
  await act(async () => reviewLink.click());
  assert.ok(document.activeElement === container.querySelector('.work-pay-review-heading h2'), 'the review heading receives keyboard focus');
  assert.equal(requestCount, 0);
});

test('a newer payroll import preserves the active statement and its unsaved review note', async () => {
  let state = fixture();
  const draw = () => root.render(createElement(WorkPay, { state, onCommand: async () => {} }));
  await act(async () => draw());
  const detail = container.querySelector('.work-pay-detail');
  const note = container.querySelector<HTMLTextAreaElement>('.payroll-review-control textarea')!;
  await fill(note, 'Checked employer; verifying the bank date.');
  const batch = state.payrollImports![0];
  state = { ...state, revision: 2, payrollImports: [{ ...batch, paystubs: [...batch.paystubs, paystub('newer', '2026-02-12')] }] };
  await act(async () => draw());
  assert.equal(container.querySelector('.work-pay-detail'), detail);
  assert.match(detail!.querySelector('h2')!.textContent!, /Jan 29, 2026/);
  assert.equal(note.value, 'Checked employer; verifying the bank date.');
  assert.equal(document.querySelector('.draft-discard-dialog'), null);
  assert.match(container.querySelector('.payroll-review-control')!.textContent!, /Records changed/);
});

test('adding payroll records requires resolving an existing review draft first', async () => {
  await act(async () => root.render(createElement(WorkPay, { state: fixture(), onCommand: async () => {} })));
  const note = container.querySelector<HTMLTextAreaElement>('.payroll-review-control textarea')!;
  await fill(note, 'Keep this bank-review note.');
  await click('Add payroll records');
  assert.ok(document.querySelector('.draft-discard-dialog'));
  assert.equal(container.querySelector('.payroll-intake'), null);
  await click('Keep editing', document);
  assert.equal(note.value, 'Keep this bank-review note.');
  await click('Add payroll records');
  await click('Discard changes', document);
  assert.ok(container.querySelector('.payroll-intake'));
  assert.equal(note.value, '');
});

test('work-period lookup groups overlapping evidence without changing records', async () => {
  const state = fixture(); const before = structuredClone(state);
  await render(state);
  const lookup = container.querySelector<HTMLDetailsElement>('.payroll-lookup')!;
  assert.ok(lookup);
  const dates = lookup.querySelectorAll<HTMLInputElement>('input[type=date]');
  await fill(dates[0], '2026-01-08');
  await fill(dates[1], '2026-01-15');
  assert.match(lookup.textContent!, /Timecards \(2\)/);
  assert.match(lookup.textContent!, /Statements with overlapping periods \(1\)/);
  assert.match(lookup.textContent!, /Timecard periods overlap/);
  assert.match(lookup.textContent!, /does not prove these hours were paid/);
  assert.match(lookup.textContent!, /Latest saved statement: 2026-01-29/);
  assert.deepEqual(state, before);
  assert.equal(requestCount, 0);
});
