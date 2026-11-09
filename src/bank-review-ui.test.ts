import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, StatementBatch, Transaction } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const extension of ['.ts', '.tsx']) {
        const url = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(url)) return nextResolve(url.href, context);
      }
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
const { default: BankReview } = await import('./features/records/BankReview.tsx');
const { default: DocumentLibrary } = await import('./features/records/DocumentLibrary.tsx');
const container = document.getElementById('root')!;
const originalFetch = globalThis.fetch;
let root = createRoot(container);
let requests: { url: string; method: string }[] = [];
beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  requests = [];
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    requests.push({ url, method: options?.method ?? 'GET' });
    if (url.startsWith('/api/documents?')) return Response.json({ documents: [], storage: { usedBytes: 0, freeBytes: 100000, limitPerFileBytes: 25000000, documentCount: 0 } });
    if (url.startsWith('/api/master-workbook/status?')) return Response.json({ available: true, fileName: 'Synthetic.xlsx', lastUpdatedAt: '2026-03-01T12:00:00Z', revision: 1, stale: false, modified: false });
    throw new Error(`Unexpected request ${url}`);
  };
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });

function emptyState(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'business', name: 'Business', kind: 'business', ownershipBps: 5000 }], accounts: [{ id: 'bank', name: 'Example bank', entityId: 'personal', type: 'cash', currency: 'CAD', balanceCents: 50000, reconciledAt: null }, { id: 'card', name: 'Example card', entityId: 'personal', type: 'debt', currency: 'CAD', balanceCents: 10000, reconciledAt: null }, { id: 'business-bank', name: 'Business bank', entityId: 'business', type: 'cash', currency: 'CAD', balanceCents: 50000, reconciledAt: null }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null, importBatches: [] };
}
interface Row { id: string; date: string; description: string; amount: number; kind: 'income' | 'expense' | 'refund' | 'movement'; category: string }
function addSource(state: AppState, id: string, accountId: string, periodStart: string, periodEnd: string, openingBalanceCents: number, entries: Row[], extension = 'pdf'): StatementBatch {
  const debt = state.accounts.find(account => account.id === accountId)!.type === 'debt';
  const source = { id, accountId, periodStart, periodEnd, openingBalanceCents, closingBalanceCents: openingBalanceCents + entries.reduce((sum, row) => sum + row.amount, 0), sourceFile: `${id}.${extension}`, sha256: String(state.importBatches!.length + 1).padStart(64, '0'), rows: entries.map(row => ({ id: row.id, transactionDate: row.date, postingDate: row.date, description: row.description, amountCents: row.amount, sourcePage: 2 })) };
  const batch: StatementBatch = { id, source, status: 'committed', createdAt: '2026-04-01T12:00:00Z', committedAt: '2026-04-01T12:00:00Z', decisions: entries.map(row => ({ rowId: row.id, kind: row.kind, category: row.category })) };
  state.importBatches!.push(batch);
  state.transactions.push(...entries.map((row): Transaction => ({ id: `${id}-${row.id}`, date: row.date, postingDate: row.date, description: row.description, accountId, toAccountId: null, kind: row.kind === 'movement' ? 'adjustment' : row.kind === 'income' ? 'income' : 'expense', amountCents: row.kind === 'refund' ? -Math.abs(row.amount) : Math.abs(row.amount), category: row.category, source: source.sourceFile, createdAt: '2026-04-01T12:00:00Z', importSources: [{ importId: id, rowId: row.id }], balanceChanges: { [accountId]: row.amount } })));
  assert.ok(!debt || entries.every(row => row.kind !== 'income'));
  return batch;
}
function fixture(): AppState {
  const state = emptyState();
  addSource(state, 'bank-january', 'bank', '2026-01-01', '2026-01-31', 10000, [
    { id: 'salary', date: '2026-01-05', description: 'Example payroll', amount: 20000, kind: 'income', category: 'Salary' },
    { id: 'food', date: '2026-01-10', description: 'Example groceries', amount: -5000, kind: 'expense', category: 'Food' },
    { id: 'move', date: '2026-01-15', description: 'Example transfer', amount: -1000, kind: 'movement', category: 'Account transfer' },
  ]);
  addSource(state, 'bank-february', 'bank', '2026-02-01', '2026-02-28', 24000, [
    { id: 'refund', date: '2026-02-04', description: 'Example grocery refund', amount: 2000, kind: 'refund', category: 'Food' },
    { id: 'food', date: '2026-02-10', description: 'Example groceries', amount: -4000, kind: 'expense', category: 'Food' },
    { id: 'move', date: '2026-02-15', description: 'Example incoming transfer', amount: 1000, kind: 'movement', category: 'Account transfer' },
  ], 'json');
  addSource(state, 'card-march', 'card', '2026-03-01', '2026-03-31', 0, [
    { id: 'purchase', date: '2026-03-05', description: 'Example purchase', amount: 10000, kind: 'expense', category: 'Shopping' },
    { id: 'payment', date: '2026-03-15', description: 'Example card payment', amount: -2500, kind: 'movement', category: 'Card payment' },
  ]);
  addSource(state, 'business-march', 'business-bank', '2026-03-01', '2026-03-31', 0, [{ id: 'income', date: '2026-03-01', description: 'Business receipt', amount: 50000, kind: 'income', category: 'Sales' }]);
  return state;
}

test('an observed balance shows the later bank posting date without claiming later coverage', async () => {
  const state = emptyState();
  const batch = addSource(state, 'weekend', 'bank', '2026-09-25', '2026-09-26', 10000, [{ id: 'purchase', date: '2026-09-26', description: 'Weekend purchase', amount: -3000, kind: 'expense', category: 'Food' }], 'json');
  batch.source.sourceKind = 'bank_activity';
  batch.source.observedOn = '2026-09-26';
  batch.source.rows[0].postingDate = '2026-09-28';
  await render(state);
  assert.match(container.textContent!, /observed bank balance already includes entries with later posting dates/);
  assert.match(container.textContent!, /Bank posting date Sep 28, 2026/);
  assert.match(container.textContent!, /2 covered days/);
  assert.doesNotMatch(container.textContent!, /A separate posting date was not supplied/);
});
async function render(state: AppState, scope = 'personal') { await act(async () => root.render(createElement(BankReview, { state, scope }))); }
function control(label: string): HTMLSelectElement | HTMLInputElement {
  const item = [...container.querySelectorAll('.bank-review label')].find(element => element.textContent?.startsWith(label))?.querySelector<HTMLSelectElement | HTMLInputElement>('select,input');
  assert.ok(item, `Missing bank review control ${label}`);
  return item;
}
async function select(label: string, value: string) {
  const item = control(label) as HTMLSelectElement;
  await act(async () => { item.value = value; item.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function search(value: string) {
  const item = control('Search bank entries') as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(item, value); item.dispatchEvent(new Event('input', { bubbles: true })); });
}
function total(label: string) {
  const item = [...container.querySelectorAll('.bank-review-totals > div')].find(element => element.querySelector('dt')?.textContent === label);
  assert.ok(item, `Missing total ${label}`);
  return item.querySelector('dd')!.textContent;
}
const rows = () => [...container.querySelectorAll('.bank-review table')].find(table => table.querySelector('caption')?.textContent === 'Bank source entries')?.querySelectorAll('tbody tr') ?? [];
function button(label: string) {
  const item = [...container.querySelectorAll<HTMLButtonElement>('.bank-review button')].find(element => element.textContent === label);
  assert.ok(item, `Missing bank review button ${label}`);
  return item;
}

test('bank review starts with the latest personal cash month and switches month and account totals', async () => {
  const state = fixture();
  const unchanged = structuredClone(state);
  await render(state);
  assert.equal(control('Review account').value, 'bank');
  assert.deepEqual([...control('Review account').querySelectorAll('option')].map(option => option.value), ['bank', 'card']);
  assert.equal(control('Review month').value, '2026-02');
  assert.equal(total('Deposits'), '$30');
  assert.equal(total('Withdrawals'), '$40');
  assert.equal(total('Net change'), '-$10');
  assert.equal(total('Closing source balance'), '$230');
  assert.match(container.textContent!, /Classified spending after refunds: \$20/);
  await select('Review month', '2026-01');
  assert.equal(total('Deposits'), '$200');
  assert.equal(total('Withdrawals'), '$60');
  assert.match(container.textContent!, /Classified income \$200/);
  await select('Review month', 'all');
  assert.equal(total('Deposits'), '$230');
  assert.equal(total('Withdrawals'), '$100');
  assert.equal(rows().length, 6);
  await select('Review account', 'card');
  assert.equal(control('Review month').value, '2026-03');
  assert.equal(total('Debt added'), '$100');
  assert.equal(total('Debt reduced'), '$25');
  assert.equal(total('Closing source balance'), '$75');
  assert.equal(rows().length, 2);
  assert.deepEqual(state, unchanged);
  assert.equal(requests.length, 0);
});

test('source query and classification filters keep signed refunds and totals independent of the table filter', async () => {
  const state = fixture();
  await render(state);
  await search('  EXAMPLE GROCERY  ');
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent!, /refund.*\$20/);
  await search('food');
  assert.equal(rows().length, 2);
  await select('Bank entry type', 'spending');
  assert.equal(rows().length, 2);
  assert.match(rows()[0].textContent!, /groceries.*-\$40/);
  assert.equal(total('Deposits'), '$30');
  assert.equal(total('Withdrawals'), '$40');
  await select('Bank entry type', 'movement');
  assert.equal(rows().length, 0);
  assert.match(container.querySelector('[role="status"]')!.textContent!, /0 matching entries/);
  await search('');
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent!, /incoming transfer/);
  const source = rows()[0].querySelector<HTMLAnchorElement>('a')!;
  assert.equal(source.textContent, 'Original');
  assert.equal(new URL(source.href).searchParams.get('file'), 'bank-february.json');
  assert.equal(new URL(source.href).searchParams.get('workspace'), 'live');
  assert.equal(new URL(source.href).searchParams.get('sha'), state.importBatches![1].source.sha256);
});

test('pagination retains every distinct source entry and resets when search, type or month changes', async () => {
  const state = emptyState();
  const entries: Row[] = Array.from({ length: 58 }, (_, index) => ({ id: String(index).padStart(2, '0'), date: '2026-02-15', description: `Purchase ${index}`, amount: -100, kind: 'expense', category: index % 2 ? 'Food' : 'Transport' }));
  addSource(state, 'many-entries', 'bank', '2026-02-01', '2026-02-28', 10000, entries);
  await render(state);
  assert.equal(rows().length, 25);
  assert.equal(button('Previous').disabled, true);
  assert.match(container.querySelector('[role="status"]')!.textContent!, /58 matching entries/);
  await act(async () => button('Next').click());
  await act(async () => button('Next').click());
  assert.equal(rows().length, 8);
  assert.equal(button('Next').disabled, true);
  assert.match(container.querySelector('nav[aria-label="Bank review pages"]')!.textContent!, /3 \/ 3/);
  await search('Transport');
  assert.equal(rows().length, 25);
  assert.equal(button('Previous').disabled, true);
  assert.match(container.querySelector('[role="status"]')!.textContent!, /29 matching entries/);
  await act(async () => button('Next').click());
  assert.equal(rows().length, 4);
  await select('Bank entry type', 'spending');
  assert.equal(rows().length, 25);
  assert.equal(button('Previous').disabled, true);
  await search('');
  await act(async () => button('Next').click());
  await select('Review month', 'all');
  assert.equal(rows().length, 25);
  assert.equal(button('Previous').disabled, true);
  assert.equal(total('Withdrawals'), '$58');
});

test('no sources and out-of-scope sources leave the other document controls available', async () => {
  const state = emptyState();
  await render(state);
  assert.equal(container.querySelector('.bank-review'), null);
  await render(fixture(), 'missing-owner');
  assert.equal(container.querySelector('.bank-review'), null);
  await act(async () => root.render(createElement(DocumentLibrary, { state, scope: 'personal', onCommand: async () => { throw new Error('Browsing must not write records.'); } })));
  assert.equal(container.querySelector('.bank-review'), null);
  assert.match(container.textContent!, /No recorded statements yet/);
  assert.match(container.querySelector('.document-workbook')!.textContent!, /Master Excel/);
  assert.ok(requests.every(request => request.method === 'GET'));
});

test('an overlapping bank source reports the error while individual statements and workbook controls remain usable', async () => {
  const state = fixture();
  addSource(state, 'overlapping-bank', 'bank', '2026-02-01', '2026-02-28', 10000, []);
  const before = structuredClone(state);
  await act(async () => root.render(createElement(DocumentLibrary, { state, scope: 'personal', onCommand: async () => { throw new Error('Browsing must not write records.'); } })));
  const history = container.querySelector<HTMLDetailsElement>('.document-account-history')!;
  assert.equal(history.open, false);
  await act(async () => history.querySelector('summary')!.click());
  assert.equal(history.open, true);
  const error = container.querySelector('.bank-review [role="alert"]');
  assert.match(error?.textContent ?? '', /sources overlap.*transaction archive.*each source separately/);
  assert.ok(container.querySelector('.past-review'));
  const selection = container.querySelector<HTMLSelectElement>('.past-review-selection select')!;
  assert.equal(selection.value, 'all');
  await act(async () => { selection.value = 'import:bank-february'; selection.dispatchEvent(new Event('change', { bubbles: true })); });
  const source = container.querySelector<HTMLAnchorElement>('.past-review-pdf')!;
  assert.ok(source);
  assert.equal(new URL(source.href).searchParams.get('workspace'), 'live');
  assert.equal(new URL(source.href).searchParams.get('file'), 'bank-february.json');
  assert.equal(new URL(source.href).searchParams.get('sha'), state.importBatches![1].source.sha256);
  assert.match(container.querySelector('.past-review-closing')?.textContent ?? '', /Closing balance\$230/);
  assert.equal(container.querySelectorAll('.past-review-table tbody tr').length, 3);

  const filesButton = [...container.querySelectorAll<HTMLButtonElement>('.document-navigation button')].find(item => item.textContent === 'Source files')!;
  const filesPanel = document.getElementById(filesButton.getAttribute('aria-controls')!)!;
  assert.equal(filesPanel.hidden, true);
  await act(async () => filesButton.click());
  assert.equal(filesPanel.hidden, false);
  const workbook = filesPanel.querySelector<HTMLDetailsElement>('.document-workbook')!;
  assert.equal(workbook.open, false);
  await act(async () => workbook.querySelector('summary')!.click());
  assert.equal(workbook.open, true);
  assert.equal(workbook.querySelector('a')?.getAttribute('href'), '/api/master-workbook?workspace=live');
  const update = [...workbook.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Update Excel')!;
  assert.ok(update);
  assert.equal(update.disabled, false);
  assert.ok(requests.every(request => request.method === 'GET'));
  assert.deepEqual(state, before);
});

for (const dateBasis of ['posting_only', 'transaction_only'] as const) test(`bank review labels the absent source date for ${dateBasis}`, async () => {
  const state = emptyState();
  const batch = addSource(state, 'single-date', 'bank', '2026-09-25', '2026-09-26', 10000, [{ id: 'purchase', date: '2026-09-26', description: 'One bank date', amount: -3000, kind: 'expense', category: 'Food' }], 'json');
  batch.source.sourceKind = 'bank_activity';
  batch.source.observedOn = '2026-09-26';
  batch.source.rows[0].dateBasis = dateBasis;
  await render(state);
  const dateCell = rows()[0].querySelector('td')!.textContent!;
  assert.match(dateCell, /Sep 26, 2026/);
  assert.match(dateCell, dateBasis === 'posting_only' ? /Posting date only; transaction date not supplied/ : /Transaction date only; posting date not supplied/);
  assert.doesNotMatch(dateCell, /Bank posting date/);
});
