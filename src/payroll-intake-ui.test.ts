import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createStore } from '../server/store.ts';
import { createDocumentStore } from '../server/documents.ts';
import { emptyPaystub, reviewedPayrollImport } from '../shared/payroll-intake.ts';
import type { Command } from '../shared/types.ts';
import type { PayrollImport } from '../shared/payroll.ts';
import { CommandRejectedError } from './services/command-errors.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLDialogElement', 'Event'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) for (const extension of ['.ts', '.tsx']) {
      const url = new URL(`${specifier}${extension}`, context.parentURL);
      if (existsSync(url)) return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: PayrollIntake } = await import('./features/pay/PayrollIntake.tsx');
const { default: PayrollReview } = await import('./features/pay/PayrollReview.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); globalThis.fetch = originalFetch; });
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });
function button(label: string) { const node = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label); assert.ok(node, `Missing button ${label}`); return node; }
async function click(label: string) { await act(async () => button(label).click()); }
async function fill(label: string, value: string) {
  const node = [...container.querySelectorAll('label')].find(item => item.firstChild?.textContent?.trim() === label)?.querySelector('input,textarea,select');
  assert.ok(node, `Missing input ${label}`);
  const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
async function enterPaystub() {
  for (const [label, value] of [['Employer', 'Example Employer'], ['Pay date', '2026-09-18'], ['Period start', '2026-09-01'], ['Period end', '2026-09-14'], ['Gross pay', '2000.29'], ['Net pay', '1500.20'], ['Taxes', '400.08'], ['Deductions', '100.01'], ['Payroll hours', '80']]) await fill(label, value);
}
async function chooseFile(bytes: string, filename = 'Payroll.pdf') {
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([bytes], filename, { type: 'application/pdf' })] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); for (let index = 0; index < 30 && (index === 0 || container.textContent?.includes('Reading original…')); index++) await new Promise(resolve => setTimeout(resolve, 5)); });
}
function setup(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-payroll-ui-'));
  const store = createStore(join(directory, 'finance.sqlite'), 'live');
  const documents = createDocumentStore(join(directory, 'documents'), () => true);
  t.after(() => { store.close(); documents.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, documents };
}

test('payroll intake preserves original bytes and reviewed nulls, and retries uncertain saves with the same request', async t => {
  const { store, documents } = setup(t);
  const before = store.state();
  let uploads = 0, closes = 0;
  const sent: Command[] = [];
  const completed: PayrollImport[] = [];
  const bytes = '%PDF-1.4\nOriginal payroll evidence\n';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/documents?workspace=live'); uploads++;
    const headers = options!.headers as Record<string, string>;
    const metadata = JSON.parse(decodeURIComponent(headers['X-Mazal-Document']));
    const content = Buffer.from(options!.body as ArrayBuffer);
    assert.equal(content.toString(), bytes);
    return new Response(JSON.stringify(documents.upload(content, metadata)), { status: 201 });
  };
  const onCommand = async (command: Command) => { sent.push(command); store.command(command); if (sent.length === 1) throw new Error('Reply was interrupted. Retry the same reviewed import.'); };
  await act(async () => root.render(createElement(PayrollIntake, { state: before, onCommand, onClose: () => { closes++; }, onSaved: batch => { completed.push(batch); } })));
  await chooseFile(bytes); await enterPaystub(); await click('Review entered records');
  assert.match(container.querySelector('.payroll-intake-preview')!.textContent!, /Net \$1,500\.20/);
  assert.equal(document.activeElement, container.querySelector('.payroll-intake-preview h3'));
  await act(async () => container.querySelector<HTMLInputElement>('.payroll-intake-preview input[type=checkbox]')!.click());
  await submit();
  assert.match(container.querySelector('[role=alert]')!.textContent!, /Reply was interrupted/);
  assert.equal(button('Edit values').disabled, true);
  assert.equal(completed.length, 0);
  await submit();
  assert.equal(closes, 1); assert.equal(uploads, 1); assert.equal(sent.length, 2);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].id, sent[0].type === 'import_payroll' && sent[0].import.id);
  assert.deepEqual(sent[0], sent[1]);
  const saved = store.state();
  assert.equal(saved.payrollImports!.length, 1);
  const imported = saved.payrollImports![0];
  assert.equal(imported.paystubs[0].netCents, 150020);
  assert.equal(imported.paystubs[0].ytd.netCents, null);
  assert.equal(documents.content(imported.sources[0].sha256).bytes.toString(), bytes);
  assert.deepEqual(saved.accounts, before.accounts); assert.deepEqual(saved.transactions, before.transactions);
});

test('a rejected payroll import releases the reviewed values for correction', async t => {
  const { store, documents } = setup(t);
  globalThis.fetch = async (_url, options) => {
    const metadata = JSON.parse(decodeURIComponent((options!.headers as Record<string, string>)['X-Mazal-Document']));
    return Response.json(documents.upload(Buffer.from(options!.body as ArrayBuffer), metadata), { status: 201 });
  };
  await act(async () => root.render(createElement(PayrollIntake, { state: store.state(), onCommand: async () => { throw new CommandRejectedError('The payroll values were rejected.', 400); }, onClose: () => {} })));
  await chooseFile('%PDF-1.4\nPay'); await enterPaystub(); await click('Review entered records');
  await act(async () => container.querySelector<HTMLInputElement>('.payroll-intake-preview input[type=checkbox]')!.click());
  await submit();
  assert.match(container.querySelector('[role=alert]')!.textContent!, /were rejected/);
  assert.equal(button('Edit values').disabled, false);
  await click('Edit values');
  await fill('Taxes', '400.09');
  assert.equal(Boolean(container.querySelector('.payroll-intake-preview')), false);
});

test('an untouched payroll draft closes directly and gives the record type keyboard focus', async t => {
  const { store } = setup(t); let closes = 0;
  await act(async () => root.render(createElement(PayrollIntake, { state: store.state(), onCommand: async () => {}, onClose: () => { closes++; }, initialKind: 'timecards' })));
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'timecards');
  assert.equal(document.activeElement, container.querySelector('select'));
  await click('Cancel');
  assert.equal(closes, 1);
  assert.doesNotMatch(document.body.textContent!, /Discard unsaved changes/);
});

for (const kind of ['paystub', 'timecards'] as const) test(`${kind} draft protection retains partial values entered before selecting a source`, async t => {
  const { store } = setup(t); let closes = 0;
  await act(async () => root.render(createElement(PayrollIntake, { state: store.state(), onCommand: async () => {}, onClose: () => { closes++; }, initialKind: kind })));
  const label = kind === 'paystub' ? 'Taxes' : 'Source status';
  const value = kind === 'paystub' ? '12.34' : 'Submitted';
  await fill(label, value);
  await click('Cancel');
  assert.equal(closes, 0);
  assert.match(document.body.textContent!, /Discard unsaved changes/);
  await click('Keep editing');
  const input = [...container.querySelectorAll('label')].find(item => item.firstChild?.textContent?.trim() === label)!.querySelector('input')!;
  assert.equal(input.value, value);
  await click('Cancel'); await click('Discard changes');
  assert.equal(closes, 1);
});

test('payroll preview rejects a page count beyond the saved-source limit', async t => {
  const { store } = setup(t);
  await act(async () => root.render(createElement(PayrollIntake, { state: store.state(), onCommand: async () => {}, onClose: () => {} })));
  await chooseFile('%PDF-1.4\nPay'); await enterPaystub(); await fill('Pages in original', '1001');
  await click('Review entered records');
  assert.match(container.querySelector('[role=alert]')!.textContent!, /between 1 and 1,000 pages/);
  assert.equal(container.querySelector('.payroll-intake-preview'), null);
});

test('payroll intake keeps the draft when records change and does not upload before review', async t => {
  const { store } = setup(t); let uploads = 0, commands = 0, closes = 0;
  globalThis.fetch = async () => { uploads++; throw new Error('No upload expected.'); };
  const props = { state: store.state(), onCommand: async () => { commands++; }, onClose: () => { closes++; } };
  await act(async () => root.render(createElement(PayrollIntake, props)));
  await chooseFile('%PDF-1.4\nPay'); await enterPaystub(); await click('Review entered records');
  await act(async () => container.querySelector<HTMLInputElement>('.payroll-intake-preview input[type=checkbox]')!.click());
  await act(async () => root.render(createElement(PayrollIntake, { ...props, state: { ...props.state, revision: 2 } })));
  await submit(); assert.equal(uploads, 0); assert.equal(commands, 0);
  assert.match(container.querySelector('[role=alert]')!.textContent!, /updated records/);
  await click('Cancel'); assert.match(document.body.textContent!, /Discard unsaved changes/); assert.equal(closes, 0);
  await click('Keep editing'); assert.match(container.textContent!, /Net \$1,500\.20/);
});

test('local extraction shows source page text without filling amounts or writing payroll', async t => {
  const { store } = setup(t);
  const before = store.state();
  let extractionCalls = 0, commands = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/document-extract?workspace=live');
    assert.equal((options!.headers as Record<string, string>)['Content-Type'], 'application/pdf');
    assert.equal(Buffer.from(options!.body as ArrayBuffer).toString(), '%PDF-1.4\nPay');
    extractionCalls++;
    return new Response(JSON.stringify({ pages: [{ page: 1, text: 'Net pay $1,500.20\nPeriod 2026-09-01 to 2026-09-14', method: 'pdf-text' }], warnings: ['Check each amount against the original.'] }), { status: 200 });
  };
  await act(async () => root.render(createElement(PayrollIntake, { state: before, onCommand: async () => { commands++; }, onClose: () => {} })));
  await chooseFile('%PDF-1.4\nPay'); await click('Extract text on this Mac');
  assert.equal(extractionCalls, 1); assert.equal(commands, 0);
  assert.match(container.querySelector('.payroll-extracted-text pre')!.textContent!, /Net pay \$1,500.20/);
  const netInput = [...container.querySelectorAll('label')].find(label => label.firstChild?.textContent === 'Net pay')!.querySelector('input')!;
  assert.equal(netInput.value, '');
  assert.deepEqual(store.state(), before);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Local extraction is unavailable. Enter values from the original.' }), { status: 503 });
  await fill('Net pay', '123.45'); await click('Extract text on this Mac');
  assert.match(container.querySelector('[role=alert]')!.textContent!, /Local extraction is unavailable/);
  assert.equal(netInput.value, '123.45');
});

for (const phase of ['fetch', 'body'] as const) test(`payroll extraction ${phase} timeout unlocks the draft and ignores a late result`, async t => {
  const { store } = setup(t);
  const requests: RequestInit[] = [];
  let completeLate!: () => void;
  globalThis.fetch = async (_url, options) => {
    requests.push(options!);
    const result = { pages: [{ page: 1, text: requests.length === 1 ? 'Late extraction' : 'Retried extraction', method: 'pdf-text' }], warnings: [] };
    const response = Response.json(result);
    if (requests.length > 1) return response;
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    t.mock.method(response, 'json', () => new Promise(resolve => { completeLate = () => resolve(result); }));
    return response;
  };
  await act(async () => root.render(createElement(PayrollIntake, { state: store.state(), onCommand: async () => { assert.fail('Extraction must not save payroll.'); }, onClose: () => {} })));
  await chooseFile('%PDF-1.4\nPay'); await fill('Net pay', '123.45');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await click('Extract text on this Mac');
  assert.equal(button('Cancel').disabled, true);
  await act(async () => t.mock.timers.tick(119_999));
  assert.equal(requests[0].signal!.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(requests[0].signal!.aborted, true);
  const error = container.querySelector('[role=alert]')!;
  assert.match(error.textContent!, /timed out after 2 minutes/);
  assert.equal(document.activeElement, error);
  assert.equal(button('Cancel').disabled, false);
  const net = [...container.querySelectorAll('label')].find(label => label.firstChild?.textContent === 'Net pay')!.querySelector('input')!;
  assert.equal(net.value, '123.45');
  const status = { ready: false, dirty: false, busy: false };
  window.dispatchEvent(new dom.window.CustomEvent('mazal:check-drafts', { detail: status }));
  assert.equal(status.dirty, true); assert.equal(status.busy, false);
  assert.equal(requests.length, 1);
  await click('Extract text on this Mac');
  assert.equal(requests.length, 2);
  assert.match(container.querySelector('pre')!.textContent!, /Retried extraction/);
  await act(async () => completeLate());
  assert.match(container.querySelector('pre')!.textContent!, /Retried extraction/);
  assert.equal(net.value, '123.45');
});

for (const scenario of [
  { phase: 'fetch', persisted: false },
  { phase: 'fetch', persisted: true },
  { phase: 'body', persisted: true },
] as const) test(`payroll upload ${scenario.phase} timeout ${scenario.persisted ? 'after' : 'before'} persistence retains reviewed values and imports once on retry`, async t => {
  const { store, documents } = setup(t);
  const before = store.state();
  const bytes = '%PDF-1.4\nPayroll timeout evidence';
  const requests: RequestInit[] = [];
  const sent: Command[] = [];
  let completeLate!: () => void;
  let closes = 0;
  globalThis.fetch = async (_url, options) => {
    requests.push(options!);
    const metadata = JSON.parse(decodeURIComponent(new Headers(options!.headers).get('X-Mazal-Document')!));
    const result = requests.length > 1 || scenario.persisted ? documents.upload(Buffer.from(options!.body as ArrayBuffer), metadata) : null;
    const response = Response.json(result, { status: 201 });
    if (requests.length > 1) return response;
    if (scenario.phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    t.mock.method(response, 'json', () => new Promise(resolve => { completeLate = () => resolve(result); }));
    return response;
  };
  await act(async () => root.render(createElement(PayrollIntake, { state: before, onCommand: async command => { sent.push(command); store.command(command); }, onClose: () => { closes++; } })));
  await chooseFile(bytes); await enterPaystub(); await click('Review entered records');
  await act(async () => container.querySelector<HTMLInputElement>('.payroll-intake-preview input[type=checkbox]')!.click());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await submit();
  assert.equal(button('Cancel').disabled, true);
  await act(async () => t.mock.timers.tick(59_999));
  assert.equal(requests[0].signal!.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(requests[0].signal!.aborted, true);
  const error = container.querySelector('[role=alert]')!;
  assert.match(error.textContent!, /timed out after 60 seconds.*original may already be saved.*No payroll records were added/s);
  assert.equal(document.activeElement, error);
  assert.equal(button('Cancel').disabled, false);
  assert.equal(button('Save reviewed payroll').disabled, false);
  assert.match(container.querySelector('.payroll-intake-preview')!.textContent!, /Net \$1,500\.20/);
  assert.equal(requests.length, 1); assert.equal(sent.length, 0); assert.equal(closes, 0);
  assert.equal(documents.list().documents.length, scenario.persisted ? 1 : 0);
  await act(async () => completeLate());
  assert.equal(sent.length, 0); assert.equal(closes, 0);
  await submit();
  assert.equal(requests.length, 2); assert.equal(sent.length, 1); assert.equal(closes, 1);
  assert.equal(new Headers(requests[1].headers).get('X-Mazal-Document'), new Headers(requests[0].headers).get('X-Mazal-Document'));
  assert.deepEqual(Buffer.from(requests[1].body as ArrayBuffer), Buffer.from(requests[0].body as ArrayBuffer));
  const saved = store.state();
  assert.equal(saved.payrollImports!.length, 1); assert.equal(saved.revision, before.revision + 1);
  assert.deepEqual(saved.accounts, before.accounts); assert.deepEqual(saved.transactions, before.transactions);
  assert.equal(documents.list().documents.length, 1);
  assert.equal(documents.content(saved.payrollImports![0].sources[0].sha256).bytes.toString(), bytes);
});

test('unmounting payroll intake aborts an upload and prevents a late payroll import', async t => {
  const { store, documents } = setup(t);
  let signal!: AbortSignal;
  let completeLate!: () => void;
  globalThis.fetch = async (_url, options) => {
    signal = options!.signal!;
    const metadata = JSON.parse(decodeURIComponent(new Headers(options!.headers).get('X-Mazal-Document')!));
    const response = Response.json(documents.upload(Buffer.from(options!.body as ArrayBuffer), metadata), { status: 201 });
    return new Promise(resolve => { completeLate = () => resolve(response); });
  };
  await act(async () => root.render(createElement(PayrollIntake, { state: store.state(), onCommand: async () => { assert.fail('An unmounted intake must not submit payroll.'); }, onClose: () => { assert.fail('An unmounted intake must not close another dialog.'); } })));
  await chooseFile('%PDF-1.4\nPay'); await enterPaystub(); await click('Review entered records');
  await act(async () => container.querySelector<HTMLInputElement>('.payroll-intake-preview input[type=checkbox]')!.click());
  await submit();
  await act(async () => root.render(null));
  assert.equal(signal.aborted, true);
  await act(async () => completeLate());
  assert.equal(store.state().payrollImports!.length, 0);
});

test('payroll review confirms an existing deposit and resolves then reopens issues with saved notes', async t => {
  const { store } = setup(t);
  let state = store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-01-01' });
  state = store.command({ type: 'add_transaction', accountId: state.accounts[0].id, kind: 'income', date: '2026-09-19', amountCents: 150020, description: 'Employer deposit', category: 'Salary', requestId: 'deposit' });
  const draft = { ...emptyPaystub('stub'), employer: 'Employer', payDate: '2026-09-18', periodStart: '2026-09-01', periodEnd: '2026-09-14', gross: '2000.29', net: '1500.20', tax: '400.08', deduction: '100.01', hours: '80' };
  const imported = reviewedPayrollImport({ id: 'import', importedAt: '2026-09-20T12:00:00.000Z', source: { id: 'source', filename: 'Pay.pdf', sha256: 'a'.repeat(64), mimeType: 'application/pdf', kind: 'paystub', pageCount: 1 }, paystubs: [draft], timecards: [] });
  state = store.command({ type: 'import_payroll', import: imported, expectedRevision: state.revision, requestId: 'import' });
  const before = structuredClone(state);
  const onCommand = async (command: Command) => { state = store.command(command); };
  const render = async (issue = false) => act(async () => root.render(createElement(PayrollReview, { key: issue ? 'issue' : 'pay', state, batch: state.payrollImports![0], ...(issue ? { issueId: 'reconciliation-stub' } : { paystub: imported.paystubs[0] }), onCommand })));
  await render(); await fill('Recorded deposit', state.transactions[0].id); await fill('Review note', 'Verified next-day bank posting and employer.'); await submit();
  assert.equal(state.payrollImports![0].bankLinks![0].transactionId, state.transactions[0].id);
  await render(true); await fill('Review note', 'Checked totals against the original; detail lines not transcribed.'); await submit();
  assert.equal(state.payrollImports![0].issueReviews![0].status, 'resolved');
  await render(true); assert.match(container.textContent!, /Resolved/);
  assert.doesNotMatch(container.textContent!, /Records changed while this review was open/);
  assert.equal(button('Reopen issue').disabled, false);
  await fill('Review note', 'Reopened to enter complete detail.'); await submit();
  assert.equal(state.payrollImports![0].issueReviews![1].status, 'open');
  assert.deepEqual(state.accounts, before.accounts); assert.deepEqual(state.transactions, before.transactions);
});

for (const action of ['issue', 'deposit'] as const) test(`retrying an uncertain payroll ${action} review confirms the original action`, async t => {
  const { store } = setup(t);
  let state = store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-01-01' });
  state = store.command({ type: 'add_transaction', accountId: state.accounts[0].id, kind: 'income', date: '2026-09-19', amountCents: 150020, description: 'Employer deposit', category: 'Salary', requestId: 'deposit' });
  const draft = { ...emptyPaystub('stub'), employer: 'Employer', payDate: '2026-09-18', periodStart: '2026-09-01', periodEnd: '2026-09-14', gross: '2000.29', net: '1500.20', tax: '400.08', deduction: '100.01', hours: '80' };
  const imported = reviewedPayrollImport({ id: 'import', importedAt: '2026-09-20T12:00:00.000Z', source: { id: 'source', filename: 'Pay.pdf', sha256: 'a'.repeat(64), mimeType: 'application/pdf', kind: 'paystub', pageCount: 1 }, paystubs: [draft], timecards: [] });
  state = store.command({ type: 'import_payroll', import: imported, expectedRevision: state.revision, requestId: 'import' });
  const sent: Command[] = [];
  const onCommand = async (command: Command) => {
    sent.push(command); state = store.command(command); draw();
    if (sent.length === 1) throw new Error('Reply lost after the review saved.');
  };
  const draw = () => root.render(createElement(PayrollReview, { state, batch: state.payrollImports![0], ...(action === 'issue' ? { issueId: 'reconciliation-stub' } : { paystub: imported.paystubs[0] }), onCommand }));
  await act(async () => draw());
  if (action === 'deposit') await fill('Recorded deposit', state.transactions[0].id);
  await fill('Review note', 'Checked the original and bank evidence.'); await submit();
  const savedRevision = state.revision;
  assert.match(container.querySelector('[role=alert]')!.textContent!, /Reply lost/);
  await click('I reviewed the updated records'); await submit();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, sent[0].type);
  assert.equal('requestId' in sent[1] && sent[1].requestId, 'requestId' in sent[0] && sent[0].requestId);
  assert.equal(state.revision, savedRevision);
  if (action === 'issue') assert.equal(state.payrollImports![0].issueReviews!.at(-1)!.status, 'resolved');
  else assert.equal(state.payrollImports![0].bankLinks!.at(-1)!.transactionId, state.transactions[0].id);
});
