import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, Command, StatementImport, StatementSource } from '../shared/types.ts';
import type { DocumentList, DocumentMetadata } from '../server/documents.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal=function(){this.open=true;};
HTMLDialogElement.prototype.close=function(){this.open=false;};
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
const { createElement, act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: DocumentLibrary } = await import('./features/records/DocumentLibrary.tsx');
const { default: ImportQueue } = await import('./features/records/ImportQueue.tsx');
const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
interface RequestRecord { url: string; options: RequestInit }
let requests: RequestRecord[] = [];
let respond: (request: RequestRecord) => Response | Promise<Response>;

beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  window.history.replaceState(null, '', '/');
  requests = [];
  respond = request => {
    if (request.url.startsWith('/api/documents?')) return json(library());
    if (request.url.startsWith('/api/master-workbook/status?')) return json(workbook());
    throw new Error(`Unexpected mocked request: ${request.url}`);
  };
  globalThis.fetch = async (input, options = {}) => {
    const request = { url: String(input), options };
    requests.push(request);
    return respond(request);
  };
});
after(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  hooks.deregister();
  dom.window.close();
});

test('the completed intake route opens Import review and can reopen it after switching tabs', async () => {
  window.history.replaceState(null, '', '#documents/imports');
  await act(async () => root.render(createElement(DocumentLibrary, { state: fixture(), scope: 'personal', onCommand: async () => {}, onTransactions: () => {}, onImportStatement: () => {} })));
  const navigation = () => [...container.querySelectorAll<HTMLButtonElement>('.document-navigation button')];
  assert.equal(navigation()[1].getAttribute('aria-pressed'), 'true');
  await act(async () => navigation()[0].click());
  assert.equal(navigation()[0].getAttribute('aria-pressed'), 'true');
  await act(async () => window.dispatchEvent(new Event('mazal:open-import-review')));
  assert.equal(navigation()[1].getAttribute('aria-pressed'), 'true');
  assert.match(container.querySelector('.document-section:not([hidden])')!.textContent!, /No statements waiting for review/);
});

function fixture(): AppState {
  return { workspace: 'live', revision: 41, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'shop', name: 'Shop', kind: 'business', ownershipBps: 5000 }], accounts: [{ id: 'card', entityId: 'personal', name: 'Personal card', type: 'debt', currency: 'CAD', balanceCents: 0, reconciledAt: null }, { id: 'shop-card', entityId: 'shop', name: 'Shop card', type: 'debt', currency: 'CAD', balanceCents: 0, reconciledAt: null }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
function documentFile(id: string, patch: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return { id, sha256: id, originalName: `${id}.pdf`, mimeType: 'application/pdf', bytes: 100, kind: 'statement', accountId: 'card', documentDate: '2026-08-31', periodStart: '2026-08-01', periodEnd: '2026-08-31', notes: '', amountCents: null, currency: 'CAD', expenseUse: 'personal', merchant: '', createdAt: '2026-09-01T12:00:00Z', reviewStatus: 'reviewed', revision: 0, ...patch };
}
function library(documents: DocumentMetadata[] = []): DocumentList {
  return { documents, storage: { usedBytes: documents.length * 100, freeBytes: 100000, limitPerFileBytes: 25000000, documentCount: documents.length } };
}
function source(id: string): StatementSource {
  return { id, accountId: 'card', sourceFile: `${id}.pdf`, sha256: id, periodStart: '2026-08-01', periodEnd: '2026-08-31', openingBalanceCents: 0, closingBalanceCents: 0, rows: [] };
}
function workbook(patch: Record<string, unknown> = {}) {
  return { available: true, fileName: 'Mazal.xlsx', lastUpdatedAt: '2026-09-01T12:00:00Z', revision: 41, modified: false, stale: false, ...patch };
}
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function render(state = fixture(), scope = 'personal') {
  await act(async () => root.render(createElement(DocumentLibrary, { state, scope, onCommand: async () => { throw new Error('Document browsing must not send a command.'); } })));
}
function updateButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Update Excel');
  assert.ok(button, 'Update Excel button is available');
  return button;
}
const posts = () => requests.filter(request => request.options.method === 'POST');

test('record overview shows scoped review counts before the archive and opens the matching section', async () => {
  const state = fixture();
  state.statements = [source('recorded') as StatementImport];
  state.importBatches = [
    { id: 'recorded-copy', source: source('recorded'), decisions: [], status: 'committed', createdAt: '2026-09-01T12:00:00Z', committedAt: '2026-09-01T12:00:00Z' },
    { id: 'pending', source: { ...source('pending'), rows: [{ id: 'one', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'First entry', amountCents: 1000, sourcePage: 1 }] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null },
    { id: 'shop-pending', source: { ...source('shop-pending'), accountId: 'shop-card' }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null },
  ];
  respond = request => json(request.url.startsWith('/api/documents?') ? library([documentFile('waiting'), documentFile('recorded'), documentFile('pending')]) : workbook());
  const before = structuredClone(state);
  await render(state);
  const overview = container.querySelector('.records-overview')!;
  assert.equal(overview.closest('details, [hidden]'), null);
  assert.ok(overview.compareDocumentPosition(container.querySelector('.document-navigation')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  const review = [...container.querySelectorAll<HTMLButtonElement>('.records-heading-actions button')].find(button => button.textContent === 'Review statements');
  assert.ok(review);
  await act(async () => review.click());
  assert.equal(container.querySelectorAll('.document-navigation button')[1].getAttribute('aria-pressed'), 'true');
  const cards = [...overview.querySelectorAll<HTMLButtonElement>('button')];
  assert.match(cards[0].textContent!, /1statement.*1 extracted entry/);
  assert.match(cards[1].textContent!, /1source.*1 account/);
  assert.match(cards[2].textContent!, /1original/);
  await act(async () => cards[0].click());
  assert.equal(container.querySelectorAll('.document-navigation button')[1].getAttribute('aria-pressed'), 'true');
  await act(async () => cards[2].click());
  assert.equal(container.querySelectorAll('.document-navigation button')[2].getAttribute('aria-pressed'), 'true');
  await act(async () => cards[1].click());
  assert.equal(container.querySelectorAll('.document-navigation button')[0].getAttribute('aria-pressed'), 'true');
  assert.equal(posts().length, 0);
  assert.deepEqual(state, before);
});

test('the originals overview keeps unavailable and loading file counts unknown, then recovers after retry', async () => {
  const pending = deferred<Response>();
  respond = request => request.url.startsWith('/api/documents?') ? pending.promise : json(workbook());
  await render();
  const card = () => container.querySelector('.records-files-card')!;
  assert.equal(card().querySelector('.records-card-number')!.textContent, 'Loading');
  await act(async () => pending.resolve(json({ error: 'Files unavailable' }, 503)));
  assert.equal(card().querySelector('.records-card-number')!.textContent, 'Check files');
  const warning = container.querySelector('.records-file-warning')!;
  assert.ok(warning);
  assert.equal(warning.closest('details, [hidden]'), null);
  await act(async () => warning.querySelector<HTMLButtonElement>('button')!.click());
  assert.equal(container.querySelectorAll('.document-navigation button')[2].getAttribute('aria-pressed'), 'true');
  respond = request => json(request.url.startsWith('/api/documents?') ? library([documentFile('recovered')]) : workbook());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry file list')!.click());
  assert.equal(card().querySelector('.records-card-number')!.textContent, '1original');
  assert.equal(posts().length, 0);
});

for (const target of ['files', 'workbook'] as const) for (const phase of ['fetch', 'body'] as const) test(`a stalled ${target} ${phase} read times out, retries, and ignores its late response`, async t => {
  const older = deferred<Response>();
  const olderBody = deferred<unknown>();
  const path = target === 'files' ? '/api/documents?' : '/api/master-workbook/status?';
  const response = json({});
  if (phase === 'body') t.mock.method(response, 'json', () => olderBody.promise);
  respond = request => request.url.startsWith(path) ? phase === 'fetch' ? older.promise : response : json(request.url.startsWith('/api/documents?') ? library() : workbook());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = fixture();
  const before = structuredClone(state);
  await render(state);
  const first = requests.find(request => request.url.startsWith(path))!;
  await act(async () => t.mock.timers.tick(14_999));
  assert.equal(first.options.signal!.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(first.options.signal!.aborted, true);
  assert.match(container.textContent!, /timed out after 15 seconds/);
  if (target === 'files') assert.equal(container.querySelector('.records-files-card .records-card-number')!.textContent, 'Check files');
  else assert.equal(updateButton().disabled, true);
  assert.equal(requests.filter(request => request.url.startsWith(path)).length, 1);
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === (target === 'files' ? 'Retry file list' : 'Retry workbook check'))!;
  assert.ok(retry); assert.equal(retry.disabled, false);
  respond = request => json(request.url.startsWith('/api/documents?') ? library([documentFile('recovered')]) : workbook({ stale: true }));
  await act(async () => retry.click());
  assert.doesNotMatch(container.textContent!, /timed out/);
  if (target === 'files') assert.match(container.querySelector('.statement-files')!.textContent!, /recovered\.pdf/);
  else { assert.equal(updateButton().disabled, false); assert.match(container.textContent!, /New records are available for Excel/); }
  const late = target === 'files' ? library([documentFile('late-original')]) : workbook({ modified: true });
  await act(async () => { if (phase === 'fetch') older.resolve(json(late)); else olderBody.resolve(late); });
  assert.doesNotMatch(container.textContent!, /late-original\.pdf|Excel contains local edits|timed out/);
  assert.equal(requests.filter(request => request.url.startsWith(path)).length, 2);
  const latest = requests.filter(request => request.url.startsWith(path)).at(-1)!;
  await act(async () => t.mock.timers.tick(15_000));
  assert.equal(latest.options.signal!.aborted, false);
  assert.equal(posts().length, 0);
  assert.deepEqual(state, before);
});

test('a file-list refresh timeout retains cached originals and the open classification draft', async t => {
  const state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('staged'), closingBalanceCents: 1000, rows: [
    { id: 'entry', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'Grocery purchase', amountCents: 1000, sourcePage: 1 },
  ] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  const before = structuredClone(state);
  respond = request => json(request.url.startsWith('/api/documents?') ? library([documentFile('cached-original')]) : workbook());
  await render(state);
  const findButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!;
  await act(async () => findButton('Review entries').click());
  await act(async () => findButton('Classify').click());
  const input = container.querySelector<HTMLInputElement>('.import-editor input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unsaved groceries'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const body = deferred<unknown>();
  const response = json({});
  t.mock.method(response, 'json', () => body.promise);
  respond = request => request.url.startsWith('/api/documents?') ? response : json(workbook());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => window.dispatchEvent(new Event('online')));
  await act(async () => t.mock.timers.tick(15_000));
  assert.match(container.textContent!, /timed out after 15 seconds.*last loaded file list is still shown/s);
  assert.ok(container.querySelector('a[aria-label="Open original cached-original.pdf"]'));
  assert.equal(input.value, 'Unsaved groceries');
  respond = request => json(request.url.startsWith('/api/documents?') ? library([documentFile('latest-original')]) : workbook());
  await act(async () => findButton('Retry file list').click());
  await act(async () => body.resolve(library([documentFile('obsolete-original')])));
  assert.ok(container.querySelector('a[aria-label="Open original latest-original.pdf"]'));
  assert.doesNotMatch(container.textContent!, /obsolete-original|timed out/);
  assert.equal(input.value, 'Unsaved groceries');
  assert.equal(requests.filter(request => request.url.startsWith('/api/master-workbook/status?')).length, 1);
  assert.equal(posts().length, 0);
  assert.deepEqual(state, before);
});

for (const change of ['revision', 'workspace', 'unmount'] as const) test(`${change} cancellation of pending file and workbook bodies stays silent and ignores late results`, async t => {
  const documentsBody = deferred<unknown>();
  const workbookBody = deferred<unknown>();
  const documentsResponse = json({});
  const workbookResponse = json({});
  t.mock.method(documentsResponse, 'json', () => documentsBody.promise);
  t.mock.method(workbookResponse, 'json', () => workbookBody.promise);
  respond = request => request.url.startsWith('/api/documents?') ? documentsResponse : workbookResponse;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render();
  const oldRequests = [...requests];
  assert.equal(oldRequests.length, 2);
  respond = request => json(request.url.startsWith('/api/documents?') ? library([documentFile('current-original')]) : workbook({ available: false, lastUpdatedAt: null }));
  if (change === 'unmount') await act(async () => root.render(null));
  else await render({ ...fixture(), ...(change === 'revision' ? { revision: 42 } : { workspace: 'demo' as const }) });
  for (const request of oldRequests) {
    assert.equal(request.options.signal!.aborted, true);
    assert.equal(request.options.signal!.reason.name, 'AbortError');
  }
  await act(async () => {
    documentsBody.resolve(library([documentFile('late-original')]));
    workbookBody.resolve(workbook({ modified: true }));
  });
  await act(async () => t.mock.timers.tick(15_000));
  assert.doesNotMatch(container.textContent!, /late-original|Excel contains local edits|timed out|Could not check|Could not load/);
  if (change === 'unmount') assert.equal(container.textContent, '');
  else assert.ok(container.querySelector('a[aria-label="Open original current-original.pdf"]'));
  assert.equal(requests.length, change === 'unmount' ? 2 : 4);
  assert.equal(posts().length, 0);
});

test('saved statements exclude screenshots, receipts, and other owners while keeping unassigned files accessible', async () => {
  const files = [documentFile('personal-statement'), documentFile('shop-statement', { accountId: 'shop-card' }), documentFile('unassigned-statement', { accountId: null }), documentFile('receipt', { kind: 'receipt' }), documentFile('screenshot', { kind: 'other', originalName: 'Balance.png', mimeType: 'image/png' })];
  respond = request => json(request.url.startsWith('/api/documents?') ? library(files) : workbook());
  await render();
  const section = container.querySelector('.statement-files')!;
  assert.ok(section);
  assert.equal(section.querySelectorAll('li').length, 2);
  assert.match(section.textContent!, /personal-statement\.pdf/);
  assert.match(section.textContent!, /unassigned-statement\.pdf/);
  assert.doesNotMatch(section.textContent!, /shop-statement|receipt|Balance\.png/);
  assert.equal(section.querySelector('a')?.getAttribute('href'), '/api/documents/personal-statement/content?workspace=live');
  await render(fixture(), 'shop');
  assert.match(container.querySelector('.statement-files')!.textContent!, /shop-statement\.pdf/);
  assert.doesNotMatch(container.querySelector('.statement-files')!.textContent!, /personal-statement\.pdf/);
  assert.equal(posts().length, 0);
});

test('legacy, committed, and staged statement files do not reappear as not yet recorded', async () => {
  const state = fixture();
  state.statements = [source('legacy') as StatementImport];
  state.importBatches = ['committed', 'staged'].map(id => ({ id, source: source(id), decisions: [], status: id === 'committed' ? 'committed' : 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: id === 'committed' ? '2026-09-01T12:00:00Z' : null }));
  respond = request => json(request.url.startsWith('/api/documents?') ? library(['legacy', 'committed', 'staged', 'waiting'].map(id => documentFile(id))) : workbook());
  await render(state);
  const section = container.querySelector('.statement-files')!;
  assert.equal(section.querySelectorAll('li').length, 1);
  assert.match(section.textContent!, /waiting\.pdf/);
  assert.doesNotMatch(section.textContent!, /legacy\.pdf|committed\.pdf|staged\.pdf/);
  assert.equal(posts().length, 0);
});

test('pending CSV and JSON entries link to their original source files', async () => {
  const state = fixture();
  state.importBatches = ['Bank & account.csv', 'Bank activity.json'].map((name, index) => ({ id: `batch-${index}`, source: { ...source(`source-${index}`), sourceFile: name }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }));
  await act(async () => root.render(createElement(ImportQueue, { state, scope: 'personal', onCommand: async () => {} })));
  const links = [...container.querySelectorAll<HTMLAnchorElement>('.import-batches a')];
  assert.equal(links.length, 2);
  for (const [index, link] of links.entries()) {
    const url = new URL(link.href);
    assert.equal(url.pathname, '/api/source');
    assert.equal(url.searchParams.get('file'), state.importBatches[index].source.sourceFile);
    assert.equal(url.searchParams.get('sha'), `source-${index}`);
    assert.equal(url.searchParams.get('workspace'), 'live');
  }
});

test('staged originals stay visible in Source files and lead to their pending review', async () => {
  const state = fixture();
  state.importBatches = [{ id: 'staged', source: source('staged'), decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  respond = request => json(request.url.startsWith('/api/documents?') ? library([documentFile('staged')]) : workbook());
  await render(state);
  const section = container.querySelector('.statement-staged-files')!;
  assert.ok(section);
  assert.match(section.textContent!, /Waiting for entry review/);
  assert.match(section.textContent!, /staged.pdf/);
  assert.doesNotMatch(container.textContent!, /No saved statement files/);
  assert.equal(section.querySelector('a')!.getAttribute('aria-label'), 'Open original staged.pdf');
  assert.equal(section.querySelector('a')!.getAttribute('href'), '/api/source?file=staged.pdf&sha=staged&workspace=live');
  await act(async () => section.querySelector<HTMLButtonElement>('button')!.click());
  assert.equal(container.querySelectorAll('.document-navigation button')[1].getAttribute('aria-pressed'), 'true');
  assert.equal(document.activeElement, container.querySelectorAll('.document-navigation button')[1]);
  await render(state, 'shop');
  assert.equal(container.querySelector('.statement-staged-files'), null);
  assert.equal(posts().length, 0);
});

test('pending classifications retain drafts and preserve other row changes after a refresh', async () => {
  let state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('statement'), closingBalanceCents: 3000, rows: [
    { id: 'first', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'First purchase', amountCents: 1000, sourcePage: 1 },
    { id: 'second', transactionDate: '2026-08-02', postingDate: '2026-08-02', description: 'Second purchase', amountCents: 2000, sourcePage: 1 },
  ] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  const commands: Command[] = [];
  const draw = () => root.render(createElement(ImportQueue, { state, scope: 'personal', onCommand: async command => { commands.push(command); } }));
  const findButton = (label: string) => {
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === label);
    assert.ok(button, `Missing ${label}`);
    return button;
  };
  await act(async () => draw());
  await act(async () => findButton('Review entries').click());
  await act(async () => findButton('Classify').click());
  const select = container.querySelector<HTMLSelectElement>('.import-editor select')!;
  await act(async () => { select.value = 'expense'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const input = container.querySelector<HTMLInputElement>('.import-editor input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Food'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  state = { ...state, revision: 42, importBatches: [{ ...state.importBatches[0], decisions: [{ rowId: 'second', kind: 'expense', category: 'Transport' }] }] };
  await act(async () => draw());
  assert.equal(input.value, 'Food');
  assert.equal(findButton('Save classification').disabled, true);
  await act(async () => findButton('Save classification').click());
  assert.equal(commands.length, 0);
  await act(async () => findButton('Keep my classification').click());
  await act(async () => findButton('Save classification').click());
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'review_statement');
  if (commands[0].type !== 'review_statement') assert.fail('Expected a statement classification');
  assert.equal(commands[0].expectedRevision, 42);
  assert.deepEqual(commands[0].decisions, [{ rowId: 'second', kind: 'expense', category: 'Transport' }, { rowId: 'first', kind: 'expense', category: 'Food' }]);
});

test('opening another statement entry cannot discard an unsaved classification', async () => {
  const state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('statement'), closingBalanceCents: 3000, rows: [
    { id: 'first', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'First purchase', amountCents: 1000, sourcePage: 1 },
    { id: 'second', transactionDate: '2026-08-02', postingDate: '2026-08-02', description: 'Second purchase', amountCents: 2000, sourcePage: 1 },
  ] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  const commands: Command[] = [];
  await act(async () => root.render(createElement(ImportQueue, { state, scope: 'personal', onCommand: async command => { commands.push(command); } })));
  const findButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  await act(async () => findButton('Review entries').click());
  const entryButtons = [...container.querySelectorAll<HTMLButtonElement>('.import-entry button')];
  await act(async () => entryButtons[0].click());
  const category = container.querySelector<HTMLInputElement>('.import-editor input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(category, 'Groceries'); category.dispatchEvent(new Event('input', { bubbles: true })); });
  for (const entryButton of entryButtons) {
    await act(async () => entryButton.click());
    assert.equal(container.querySelector<HTMLInputElement>('.import-editor input')!.value, 'Groceries');
    assert.match(container.querySelector('.import-editor')!.textContent!, /First purchase/);
  }
  assert.match(container.querySelector('.import-editor')!.textContent!, /Save or cancel this classification before editing another entry/);
  await act(async () => findButton('Cancel').click());
  assert.match(document.body.textContent!,/Discard unsaved changes/);
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent==='Discard changes')!.click());
  await act(async () => entryButtons[1].click());
  assert.match(container.querySelector('.import-editor')!.textContent!, /Second purchase/);
  assert.equal(container.querySelector<HTMLInputElement>('.import-editor input')!.value, '');
  assert.equal(commands.length, 0);
});

test('closing statement entries after discard clears the classification draft', async () => {
  const state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('statement'), closingBalanceCents: 1000, rows: [{ id: 'row', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'Purchase', amountCents: 1000, sourcePage: 1 }] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  await act(async () => root.render(createElement(ImportQueue, { state, scope: 'personal', onCommand: async () => {} })));
  const findButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  await act(async () => findButton('Review entries').click());
  await act(async () => findButton('Classify').click());
  await act(async () => findButton('Close entries').click());
  await act(async () => findButton('Discard changes').click());
  assert.equal(Boolean(container.querySelector('.import-editor')), false);
  assert.equal(Boolean(container.querySelector('.import-entries')), false);
});

test('a classification draft survives when another window records the last pending statement', async () => {
  const state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('statement'), closingBalanceCents: 1000, rows: [{ id: 'row', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'Purchase', amountCents: 1000, sourcePage: 1 }] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  window.history.replaceState(null, '', '#documents/imports');
  await render(state);
  const findButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  await act(async () => findButton('Review entries').click());
  await act(async () => findButton('Classify').click());
  const input = container.querySelector<HTMLInputElement>('.import-editor input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Draft category'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await render({ ...state, revision: state.revision + 1, importBatches: [{ ...state.importBatches[0], status: 'committed', committedAt: '2026-09-02T12:00:00Z' }] });
  assert.equal(container.querySelector<HTMLInputElement>('.import-editor input')?.value, 'Draft category');
  assert.match(container.querySelector('.import-editor')!.textContent!, /no longer pending/);
  assert.equal(findButton('Save classification').disabled, true);
  await act(async () => findButton('Cancel').click());
  await act(async () => findButton('Discard changes').click());
  assert.equal(Boolean(container.querySelector('.import-editor')), false);
});

test('opening an individual classification asks before replacing a grouped review', async () => {
  const state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('statement'), closingBalanceCents: 1000, rows: [{ id: 'row', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'Purchase', amountCents: 1000, sourcePage: 1 }] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  await act(async () => root.render(createElement(ImportQueue, { state, scope: 'personal', onCommand: async () => {} })));
  const findButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  await act(async () => findButton('Review entries').click());
  await act(async () => findButton('Review matching rows together').click());
  await act(async () => findButton('Classify').click());
  assert.match(document.body.textContent!, /Discard unsaved changes/);
  await act(async () => findButton('Keep editing').click());
  assert.match(container.querySelector('.import-editor')!.textContent!, /Classify selected rows/);
  await act(async () => findButton('Classify').click());
  await act(async () => findButton('Discard changes').click());
  assert.match(container.querySelector('.import-editor')!.textContent!, /Classify entry/);
  await act(async () => findButton('Cancel').click());
  await act(async () => findButton('Discard changes').click());
  await act(async () => findButton('Close entries').click());
  assert.equal(document.querySelector('.draft-discard-dialog'), null);
});

test('grouped review blocks recording and survives an external commit of the last statement', async () => {
  const state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('statement'), closingBalanceCents: 1000, rows: [{ id: 'row', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'Purchase', amountCents: 1000, sourcePage: 1 }] }, decisions: [{ rowId: 'row', kind: 'expense', category: 'Saved category' }], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  window.history.replaceState(null, '', '#documents/imports');
  await render(state);
  const findButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  assert.equal(findButton('Record 1 statement').disabled, false);
  await act(async () => findButton('Review entries').click());
  await act(async () => findButton('Review matching rows together').click());
  const input = container.querySelector<HTMLInputElement>('.statement-review-tools input:not([type=checkbox])')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Grouped draft'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(findButton('Record 1 statement').disabled, true);
  await render({ ...state, revision: state.revision + 1, importBatches: [{ ...state.importBatches[0], status: 'committed', committedAt: '2026-09-02T12:00:00Z' }] });
  assert.equal(container.querySelector<HTMLInputElement>('.statement-review-tools input:not([type=checkbox])')?.value, 'Grouped draft');
  assert.equal(findButton('Save selected classifications').disabled, true);
  assert.match(container.querySelector('.statement-review-tools [role=status]')!.textContent!, /no longer pending/);
  await act(async () => findButton('Cancel').click());
  await act(async () => findButton('Discard changes').click());
  assert.equal(Boolean(container.querySelector('.import-editor')), false);
  assert.equal(posts().length, 0);
});

test('switching workspaces aborts old reads and ignores delayed document and workbook responses', async () => {
  const oldDocuments = deferred<Response>();
  const oldWorkbook = deferred<Response>();
  respond = request => {
    if (request.url === '/api/documents?workspace=live') return oldDocuments.promise;
    if (request.url === '/api/master-workbook/status?workspace=live') return oldWorkbook.promise;
    if (request.url === '/api/documents?workspace=demo') return json(library([documentFile('demo-statement')]));
    if (request.url === '/api/master-workbook/status?workspace=demo') return json(workbook({ available: false, lastUpdatedAt: null }));
    throw new Error(`Unexpected mocked request: ${request.url}`);
  };
  await render();
  const oldReads = requests.filter(request => request.url.endsWith('workspace=live'));
  assert.equal(oldReads.length, 2);
  await render({ ...fixture(), workspace: 'demo' });
  assert.ok(oldReads.every(request => request.options.signal?.aborted));
  await act(async () => {
    oldDocuments.resolve(json(library([documentFile('late-live-statement')])));
    oldWorkbook.resolve(json(workbook()));
  });
  assert.match(container.textContent!, /demo-statement\.pdf/);
  assert.doesNotMatch(container.textContent!, /late-live-statement\.pdf|Download Excel/);
  assert.match(container.textContent!, /Your Excel workbook is in the live workspace/);
  assert.equal(posts().length, 0);
});

test('Master Excel starts collapsed and rendering or opening it never refreshes the workbook', async () => {
  await render();
  const details = container.querySelector<HTMLDetailsElement>('.document-workbook')!;
  assert.equal(details.open, false);
  assert.equal(updateButton().disabled, false);
  await act(async () => details.querySelector('summary')!.click());
  assert.equal(details.open, true);
  await render({ ...fixture(), revision: 42 });
  assert.equal(posts().length, 0);
  assert.ok(requests.every(request => !request.options.method || request.options.method === 'GET'));
});

test('statement sections start at the archive and preserve import drafts while switching sections', async () => {
  const state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('staged'), closingBalanceCents: 1000, rows: [
    { id: 'entry', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'Grocery purchase', amountCents: 1000, sourcePage: 1 },
  ] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  await render(state);
  const navigation = [...container.querySelectorAll<HTMLButtonElement>('.document-navigation button')];
  const panel = (button: HTMLButtonElement) => document.getElementById(button.getAttribute('aria-controls')!)!;
  assert.equal(navigation[0].textContent, 'Statement archive');
  assert.equal(navigation[0].getAttribute('aria-pressed'), 'true');
  assert.equal(panel(navigation[0]).hidden, false);
  assert.equal(panel(navigation[1]).hidden, true);
  assert.match(navigation[1].textContent!, /Import review1/);
  const findButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  await act(async () => navigation[1].click());
  await act(async () => findButton('Review entries').click());
  await act(async () => findButton('Classify').click());
  const input = container.querySelector<HTMLInputElement>('.import-editor input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Groceries'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => navigation[2].click());
  assert.equal(panel(navigation[1]).hidden, true);
  assert.equal(panel(navigation[2]).hidden, false);
  await act(async () => navigation[1].click());
  assert.equal(panel(navigation[1]).hidden, false);
  assert.equal(container.querySelector<HTMLInputElement>('.import-editor input')?.value, 'Groceries');
  assert.equal(posts().length, 0);
});

test('local Excel edits disable the update button and cannot send a refresh', async () => {
  respond = request => json(request.url.startsWith('/api/documents?') ? library() : workbook({ modified: true }));
  await render();
  assert.equal(updateButton().disabled, true);
  assert.match(container.textContent!, /Excel contains local edits/);
  await act(async () => updateButton().click());
  assert.equal(posts().length, 0);
});

test('missing workbook status disables updating while loading and after a failed status read', async () => {
  const pendingStatus = deferred<Response>();
  respond = request => request.url.startsWith('/api/documents?') ? json(library()) : pendingStatus.promise;
  await render();
  assert.equal(updateButton().disabled, true);
  assert.match(container.textContent!, /Checking Excel/);
  await act(async () => updateButton().click());
  assert.equal(posts().length, 0);
  await act(async () => pendingStatus.resolve(json({ error: 'Status unavailable' }, 503)));
  assert.equal(updateButton().disabled, true);
  assert.match(container.textContent!, /Could not check the saved workbook/);
  await act(async () => updateButton().click());
  assert.equal(posts().length, 0);
  respond = request => json(request.url.startsWith('/api/documents?') ? library() : workbook());
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Retry workbook check')!;
  await act(async () => retry.click());
  assert.doesNotMatch(container.textContent!, /Could not check the saved workbook/);
  assert.equal(updateButton().disabled, false);
  assert.equal(posts().length, 0);
});

test('returning to Statements refreshes saved files without repeating workbook checks', async () => {
  await render();
  assert.equal(container.querySelector('.statement-files'), null);
  respond = request => json(request.url.startsWith('/api/documents?') ? library([documentFile('new-statement')]) : workbook());
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.match(container.querySelector('.statement-files')!.textContent!, /new-statement\.pdf/);
  assert.equal(requests.filter(request => request.url.startsWith('/api/documents?')).length, 2);
  assert.equal(requests.filter(request => request.url.startsWith('/api/master-workbook/status?')).length, 1);
  assert.equal(posts().length, 0);
});

test('a refreshed document read aborts earlier reads and does not replace a pending classification draft', async () => {
  const older = deferred<Response>();
  let documentReads = 0;
  respond = request => {
    if (request.url.startsWith('/api/documents?')) return ++documentReads === 1 ? older.promise : json(library([documentFile('latest-statement')]));
    return json(workbook());
  };
  const state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('staged'), closingBalanceCents: 1000, rows: [
    { id: 'entry', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'Grocery purchase', amountCents: 1000, sourcePage: 1 },
  ] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  await render(state);
  const findButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
  await act(async () => findButton('Review entries').click());
  await act(async () => findButton('Classify').click());
  const input = container.querySelector<HTMLInputElement>('.import-editor input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Food'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => window.dispatchEvent(new Event('online')));
  assert.equal(requests.find(request => request.url.startsWith('/api/documents?'))!.options.signal?.aborted, true);
  await act(async () => older.resolve(json(library([documentFile('outdated-statement')]))));
  assert.equal(input.value, 'Food');
  assert.match(container.querySelector('.statement-files')!.textContent!, /latest-statement\.pdf/);
  assert.doesNotMatch(container.textContent!, /outdated-statement\.pdf/);
  assert.equal(posts().length, 0);
});

for (const phase of ['fetch', 'body'] as const) test(`a stalled Excel update ${phase} times out and checks status before another explicit update`, async t => {
  const pending = deferred<Response>();
  const pendingBody = deferred<unknown>();
  const pendingStatus = deferred<Response>();
  const response = json({});
  if (phase === 'body') t.mock.method(response, 'json', () => pendingBody.promise);
  let statusReads = 0;
  respond = request => {
    if (request.url.startsWith('/api/documents?')) return json(library());
    if (request.url.startsWith('/api/master-workbook/status?')) return ++statusReads === 1 ? json(workbook({ stale: true })) : pendingStatus.promise;
    if (request.options.method === 'POST') return phase === 'fetch' ? pending.promise : response;
    throw new Error(`Unexpected mocked request: ${request.url}`);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = fixture();
  const before = structuredClone(state);
  await render(state);
  await act(async () => updateButton().click());
  const request = posts()[0];
  await act(async () => t.mock.timers.tick(179_999));
  assert.match(container.textContent!, /Updating Excel…/);
  await act(async () => t.mock.timers.tick(1));
  assert.doesNotMatch(container.textContent!, /Updating Excel…/);
  assert.equal(request.options.signal?.aborted, true);
  assert.match(container.textContent!, /Updating Excel timed out after 3 minutes.*The update may still finish/);
  assert.equal(updateButton().disabled, true);
  assert.equal(statusReads, 2);
  assert.equal(posts().length, 1);
  await act(async () => updateButton().click());
  assert.equal(posts().length, 1);
  await act(async () => pendingStatus.resolve(json(workbook({ revision: 41 }))));
  assert.equal(updateButton().disabled, false);
  assert.match(container.textContent!, /Updating Excel timed out/);
  await act(async () => {
    if (phase === 'fetch') pending.resolve(json(workbook({ modified: true })));
    else pendingBody.resolve(workbook({ modified: true }));
  });
  assert.doesNotMatch(container.textContent!, /Excel updated from your saved records|Excel contains local edits/);
  assert.match(container.textContent!, /Updating Excel timed out/);
  assert.equal(posts().length, 1);
  respond = request => json(request.url.startsWith('/api/documents?') ? library() : workbook());
  await act(async () => updateButton().click());
  assert.equal(posts().length, 2);
  assert.match(container.textContent!, /Excel updated from your saved records/);
  assert.doesNotMatch(container.textContent!, /Updating Excel timed out/);
  assert.deepEqual(state, before);
});

for (const focus of ['workbook', 'body', 'elsewhere', 'left-and-blurred', 'outside-click', 'closed', 'hidden', 'unmounted'] as const) test(`an Excel timeout restores only workbook-owned focus: ${focus}`, async t => {
  const pending = deferred<Response>();
  respond = request => request.options.method === 'POST' ? pending.promise : json(request.url.startsWith('/api/documents?') ? library() : workbook());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.document-navigation button')].find(button => button.textContent!.startsWith('Source files'))!.click());
  const region = container.querySelector<HTMLDetailsElement>('.document-workbook')!;
  region.open = true;
  const button = updateButton();
  button.focus();
  await act(async () => button.click());
  const outside = document.createElement('input');
  document.body.append(outside);
  try {
    if (focus === 'body' || focus === 'outside-click') {
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
      assert.equal(document.activeElement?.tagName, 'BODY');
    }
    if (focus === 'elsewhere' || focus === 'left-and-blurred') outside.focus();
    if (focus === 'left-and-blurred') outside.blur();
    if (focus === 'outside-click') outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    if (focus === 'closed') region.open = false;
    if (focus === 'hidden') await act(async () => container.querySelector<HTMLButtonElement>('.document-navigation button')!.click());
    if (focus === 'unmounted') await act(async () => root.render(null));
    const before = document.activeElement;
    await act(async () => t.mock.timers.tick(180_000));
    const error = container.querySelector<HTMLElement>('.document-workbook [role="alert"]');
    if (focus === 'workbook' || focus === 'body') {
      assert.ok(error);
      assert.equal(error.tabIndex, -1);
      assert.ok(document.activeElement === error, 'the workbook error receives focus');
    } else {
      assert.ok(document.activeElement === before, 'focus outside the visible workbook is unchanged');
      if (focus === 'unmounted') assert.equal(error, null);
      else assert.notEqual(document.activeElement, error);
    }
    assert.equal(posts().length, 1);
  } finally { outside.remove(); }
});

for (const phase of ['fetch', 'body'] as const) test(`a failed post-timeout workbook ${phase} check requires retry and preserves the local-edit block`, async t => {
  const pendingUpdate = deferred<Response>();
  const pendingStatus = deferred<Response>();
  const pendingStatusBody = deferred<unknown>();
  const response = json({});
  if (phase === 'body') t.mock.method(response, 'json', () => pendingStatusBody.promise);
  let statusReads = 0;
  respond = request => {
    if (request.url.startsWith('/api/documents?')) return json(library());
    if (request.options.method === 'POST') return pendingUpdate.promise;
    if (++statusReads === 1) return json(workbook());
    if (statusReads === 2) return phase === 'fetch' ? pendingStatus.promise : response;
    return json(workbook({ modified: true }));
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render();
  await act(async () => updateButton().click());
  await act(async () => t.mock.timers.tick(180_000));
  const statusRequest = requests.filter(request => request.url.startsWith('/api/master-workbook/status?')).at(-1)!;
  assert.equal(updateButton().disabled, true);
  assert.ok(container.querySelector('a[href="/api/master-workbook?workspace=live"]'));
  await act(async () => t.mock.timers.tick(15_000));
  assert.equal(statusRequest.options.signal?.aborted, true);
  assert.match(container.textContent!, /Checking the saved workbook timed out after 15 seconds/);
  assert.match(container.textContent!, /Updating Excel timed out after 3 minutes/);
  assert.equal(updateButton().disabled, true);
  await act(async () => updateButton().click());
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry workbook check')!;
  await act(async () => retry.click());
  assert.match(container.textContent!, /Excel contains local edits/);
  assert.match(container.textContent!, /Updating Excel timed out after 3 minutes/);
  assert.doesNotMatch(container.textContent!, /Checking the saved workbook timed out/);
  assert.equal(updateButton().disabled, true);
  await act(async () => {
    if (phase === 'fetch') pendingStatus.resolve(json(workbook()));
    else pendingStatusBody.resolve(workbook());
    pendingUpdate.resolve(json(workbook()));
  });
  assert.equal(updateButton().disabled, true);
  assert.match(container.textContent!, /Excel contains local edits/);
  assert.doesNotMatch(container.textContent!, /Excel updated from your saved records/);
  assert.equal(posts().length, 1);
  assert.equal(statusReads, 3);
});

for (const delayed of [false, true]) test(`an Excel update timeout invalidates a ${delayed ? 'pending' : 'completed'} status read from a newer record revision`, async t => {
  const pendingUpdate = deferred<Response>();
  const earlierStatus = deferred<Response>();
  const recoveredStatus = deferred<Response>();
  let statusReads = 0;
  respond = request => {
    if (request.url.startsWith('/api/documents?')) return json(library());
    if (request.options.method === 'POST') return pendingUpdate.promise;
    if (++statusReads === 1) return json(workbook());
    if (statusReads === 2) return delayed ? earlierStatus.promise : json(workbook());
    return recoveredStatus.promise;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render();
  await act(async () => updateButton().click());
  await act(async () => t.mock.timers.tick(179_000));
  await render({ ...fixture(), revision: 42 });
  const earlierRequest = requests.filter(request => request.url.startsWith('/api/master-workbook/status?'))[1];
  await act(async () => t.mock.timers.tick(1_000));
  assert.equal(statusReads, 3);
  assert.equal(earlierRequest.options.signal?.aborted, true);
  assert.equal(updateButton().disabled, true);
  if (delayed) await act(async () => earlierStatus.resolve(json(workbook())));
  assert.equal(updateButton().disabled, true);
  await act(async () => recoveredStatus.resolve(json(workbook({ revision: 41, stale: true }))));
  assert.equal(updateButton().disabled, false);
  assert.match(container.textContent!, /New records are available for Excel/);
  assert.match(container.textContent!, /Updating Excel timed out/);
  respond = request => json(request.url.startsWith('/api/documents?') ? library() : workbook({ revision: 42 }));
  await act(async () => updateButton().click());
  assert.equal(posts().length, 2);
  assert.deepEqual(JSON.parse(String(posts()[1].options.body)), { expectedRevision: 42 });
  await act(async () => pendingUpdate.resolve(json(workbook({ revision: 41, modified: true }))));
  assert.doesNotMatch(container.textContent!, /Excel contains local edits|New records are available for Excel/);
});

for (const change of ['workspace', 'unmount'] as const) for (const phase of ['fetch', 'body'] as const) test(`${change} aborts an Excel update ${phase} and suppresses its late completion`, async t => {
  const pending = deferred<Response>();
  const body = deferred<unknown>();
  const response = json({});
  if (phase === 'body') t.mock.method(response, 'json', () => body.promise);
  respond = request => request.options.method === 'POST' ? phase === 'fetch' ? pending.promise : response : json(request.url.startsWith('/api/documents?') ? library() : workbook({ available: false, lastUpdatedAt: null }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render();
  await act(async () => updateButton().click());
  const request = posts()[0];
  if (change === 'unmount') await act(async () => root.render(null));
  else await render({ ...fixture(), workspace: 'demo' });
  assert.equal(request.options.signal?.aborted, true);
  assert.equal(request.options.signal?.reason.name, 'AbortError');
  const requestCount = requests.length;
  await act(async () => {
    if (phase === 'fetch') pending.resolve(json(workbook({ modified: true })));
    else body.resolve(workbook({ modified: true }));
  });
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(requests.length, requestCount);
  assert.equal(posts().length, 1);
  assert.doesNotMatch(container.textContent!, /Excel updated|timed out|Excel contains local edits/);
  if (change === 'unmount') assert.equal(container.textContent, '');
  else assert.match(container.textContent!, /Your Excel workbook is in the live workspace/);
});

for (const failure of ['network', 'unreadable-body'] as const) test(`an Excel update with a ${failure} failure checks status without sending another update`, async () => {
  const recovery = deferred<Response>();
  let statusReads = 0;
  respond = request => {
    if (request.url.startsWith('/api/documents?')) return json(library());
    if (request.options.method === 'POST') {
      if (failure === 'network') throw new TypeError('Connection interrupted.');
      return new Response('not json');
    }
    return ++statusReads === 1 ? json(workbook()) : recovery.promise;
  };
  await render();
  await act(async () => updateButton().click());
  assert.match(container.textContent!, /The update may still finish.*Check the saved workbook status/);
  assert.equal(updateButton().disabled, true);
  assert.equal(posts().length, 1);
  await act(async () => recovery.resolve(json(workbook())));
  assert.equal(updateButton().disabled, false);
  assert.equal(posts().length, 1);
  assert.doesNotMatch(container.textContent!, /Excel updated from your saved records/);
});

test('an explicit Excel update posts the current workspace revision once and reports success', async t => {
  const completed = deferred<Response>();
  respond = request => {
    if (request.url.startsWith('/api/documents?')) return json(library());
    if (request.url.startsWith('/api/master-workbook/status?')) return json(workbook({ stale: true }));
    if (request.url === '/api/master-workbook/refresh?workspace=live' && request.options.method === 'POST') return completed.promise;
    throw new Error(`Unexpected mocked request: ${request.url}`);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render({ ...fixture(), revision: 73 });
  assert.equal(posts().length, 0);
  await act(async () => updateButton().click());
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].url, '/api/master-workbook/refresh?workspace=live');
  assert.deepEqual(posts()[0].options.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(String(posts()[0].options.body)), { expectedRevision: 73 });
  const busy = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Updating Excel…')!;
  assert.equal(busy.disabled, true);
  await act(async () => busy.click());
  assert.equal(posts().length, 1);
  await act(async () => completed.resolve(json(workbook({ revision: 73 }))));
  assert.equal(updateButton().disabled, false);
  assert.match(container.querySelector('[role="status"]')!.textContent!, /Excel updated from your saved records/);
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(posts()[0].options.signal?.aborted, false);
  assert.equal(requests.filter(request => request.url.startsWith('/api/master-workbook/status?')).length, 1);
  assert.doesNotMatch(container.textContent!, /timed out/);
});

for (const delayed of [false, true]) test(`an Excel export rechecks status after a ${delayed ? 'pending' : 'completed'} newer read`, async () => {
  const exported = deferred<Response>();
  const previousStatus = deferred<Response>();
  let statusReads = 0;
  respond = request => {
    if (request.url.startsWith('/api/documents?')) return json(library());
    if (request.url.startsWith('/api/master-workbook/status?')) {
      statusReads++;
      if (statusReads === 2 && delayed) return previousStatus.promise;
      return json(statusReads < 3 ? workbook({ available: false, lastUpdatedAt: null }) : workbook({ revision: 41, stale: true }));
    }
    if (request.url === '/api/master-workbook/refresh?workspace=live' && request.options.method === 'POST') return exported.promise;
    throw new Error(`Unexpected mocked request: ${request.url}`);
  };
  await render();
  await act(async () => updateButton().click());
  await render({ ...fixture(), revision: 42 });
  assert.equal(statusReads, 2);
  const previousRead = requests.filter(request => request.url.startsWith('/api/master-workbook/status?'))[1];
  await act(async () => exported.resolve(json(workbook({ revision: 41, stale: false }))));
  assert.equal(statusReads, 3);
  assert.equal(previousRead.options.signal?.aborted, true);
  if (delayed) await act(async () => previousStatus.resolve(json(workbook({ available: false, lastUpdatedAt: null }))));
  assert.match(container.textContent!, /Download Excel/);
  assert.match(container.textContent!, /New records are available for Excel/);
  assert.doesNotMatch(container.textContent!, /No Excel export yet/);
  assert.equal(updateButton().disabled, false);
  assert.equal(posts().length, 1);
});

test('a completed export from the previous workspace does not change the current workbook state', async () => {
  const exported = deferred<Response>();
  respond = request => {
    if (request.url.startsWith('/api/documents?')) return json(library());
    if (request.url.startsWith('/api/master-workbook/status?')) return json(workbook({ available: false, lastUpdatedAt: null }));
    if (request.url === '/api/master-workbook/refresh?workspace=live' && request.options.method === 'POST') return exported.promise;
    throw new Error(`Unexpected mocked request: ${request.url}`);
  };
  await render();
  await act(async () => updateButton().click());
  await render({ ...fixture(), workspace: 'demo' });
  const countBeforeExport = requests.length;
  await act(async () => exported.resolve(json(workbook())));
  assert.equal(requests.length, countBeforeExport);
  assert.doesNotMatch(container.textContent!, /Download Excel|Excel updated from your saved records/);
  assert.match(container.textContent!, /Your Excel workbook is in the live workspace/);
  assert.equal(posts().length, 1);
});


test('snapshot statements remain browseable while imports, classifications, and workbook updates are disabled', async () => {
  const state = fixture();
  state.importBatches = [{ id: 'batch', source: { ...source('staged'), closingBalanceCents: 1000, rows: [
    { id: 'entry', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'Grocery purchase', amountCents: 1000, sourcePage: 1 },
  ] }, decisions: [{ rowId: 'entry', kind: 'expense', category: 'Groceries' }], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  const commands: Command[] = [];
  let opened = 0;
  await act(async () => root.render(createElement(DocumentLibrary, { state, scope: 'personal', readOnly: true, onCommand: async command => { commands.push(command); }, onImportStatement: () => { opened++; } })));
  const button = (name: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === name);
    assert.ok(found, 'Missing button ' + name);
    return found;
  };
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.document-navigation button')[1].click());
  assert.equal(button('Import another statement').disabled, true);
  assert.equal(button('Record 1 statement').disabled, true);
  await act(async () => { button('Import another statement').click(); button('Record 1 statement').click(); button('Review entries').click(); });
  assert.match(container.querySelector('.import-entries')?.textContent ?? '', /Grocery purchase/);
  const classify = container.querySelector<HTMLButtonElement>('.import-entry button')!;
  assert.equal(classify.disabled, true);
  await act(async () => classify.click());
  assert.equal(Boolean(container.querySelector('.import-editor')), false);
  assert.equal(container.querySelector('.import-batches a')?.getAttribute('href'), '/api/source?workspace=live&file=staged.pdf&sha=staged');
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.document-navigation button')[2].click());
  assert.equal(updateButton().disabled, true);
  await act(async () => updateButton().click());
  assert.equal(container.querySelector<HTMLAnchorElement>('.document-workbook-actions a')?.textContent, 'Download Excel');
  assert.equal(commands.length, 0);
  assert.equal(opened, 0);
  assert.equal(posts().length, 0);
});

test('an unavailable snapshot workbook directs the user to the personal app', async () => {
  respond = request => json(request.url.startsWith('/api/documents?') ? library() : workbook({ available: false, lastUpdatedAt: null }));
  await act(async () => root.render(createElement(DocumentLibrary, { state: fixture(), scope: 'personal', readOnly: true, onCommand: async () => {} })));
  assert.match(container.querySelector('.document-workbook')?.textContent ?? '', /Open Mazal\.app to view or update master Excel\./);
  assert.doesNotMatch(container.querySelector('.document-workbook')?.textContent ?? '', /No Excel export yet/);
  assert.equal(updateButton().disabled, true);
  assert.equal(posts().length, 0);
});

test('empty Statements offers a direct import action in its initial view', async () => {
  let imports = 0;
  await act(async () => root.render(createElement(DocumentLibrary, { state: fixture(), scope: 'personal', onCommand: async () => {}, onImportStatement: () => { imports++; } })));
  const visible = container.querySelector('.document-section:not([hidden])')!;
  const action = [...container.querySelectorAll<HTMLButtonElement>('.records-heading-actions button')].find(item => item.textContent === 'Add statement');
  assert.ok(action);
  assert.equal(visible.querySelector('.document-import-heading'), null);
  await act(async () => action.click());
  assert.equal(imports, 1);
});

function focusReviewFixture(): AppState {
  const state = fixture();
  state.importBatches = [{ id: 'focus-batch', source: { ...source('focus-source'), closingBalanceCents: 2000, rows: [
    { id: 'first', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'First purchase', amountCents: 1000, sourcePage: 1 },
    { id: 'second', transactionDate: '2026-08-02', postingDate: '2026-08-02', description: 'Second purchase', amountCents: 1000, sourcePage: 1 },
  ] }, decisions: [], status: 'staged', createdAt: '2026-09-01T12:00:00Z', committedAt: null }];
  return state;
}
function reviewButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
  assert.ok(button, `Missing ${label}`);
  return button;
}

test('saving and discarding an entry classification return focus to that entry', async () => {
  const state = focusReviewFixture();
  const commands: Command[] = [];
  await act(async () => root.render(createElement(ImportQueue, { state, scope: 'personal', onCommand: async command => { commands.push(command); } })));
  await act(async () => reviewButton('Review entries').click());
  const entries = [...container.querySelectorAll<HTMLButtonElement>('.import-entry button')];
  entries[0].focus();
  await act(async () => entries[0].click());
  const type = container.querySelector<HTMLSelectElement>('.import-editor select')!;
  await act(async () => { type.value = 'expense'; type.dispatchEvent(new Event('change', { bubbles: true })); });
  reviewButton('Save classification').focus();
  await act(async () => reviewButton('Save classification').click());
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'review_statement');
  assert.ok(document.activeElement === entries[0], 'Saved entry receives focus');
  await act(async () => entries[1].click());
  reviewButton('Cancel').focus();
  await act(async () => reviewButton('Cancel').click());
  await act(async () => reviewButton('Discard changes').click());
  assert.ok(document.activeElement === entries[1], 'Discarded entry receives focus');
  assert.equal(commands.length, 1);
});

test('grouped review and extraction editors focus their fields and return to their opening buttons', async () => {
  const { default: StatementTools } = await import('./features/records/StatementTools.tsx');
  const state = focusReviewFixture();
  const commands: Command[] = [];
  await act(async () => root.render(createElement(StatementTools, { state, batch: state.importBatches![0], readOnly: false, onCommand: async command => { commands.push(command); } })));
  const group = reviewButton('Review matching rows together');
  group.focus();
  await act(async () => group.click());
  const description = container.querySelector<HTMLSelectElement>('.import-editor select')!;
  assert.ok(document.activeElement === description, 'Description receives focus');
  await act(async () => { description.value = 'First purchase'; description.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => container.querySelector<HTMLInputElement>('.mazal-checkbox input')!.click());
  reviewButton('Save selected classifications').focus();
  await act(async () => reviewButton('Save selected classifications').click());
  assert.ok(document.activeElement === group, 'Grouped review button receives focus');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'review_statement');
  const extraction = reviewButton('Correct extracted rows');
  extraction.focus();
  await act(async () => extraction.click());
  assert.ok(document.activeElement === container.querySelector('.import-editor input[type="date"]'), 'Period start receives focus');
  reviewButton('Cancel').focus();
  await act(async () => reviewButton('Cancel').click());
  await act(async () => reviewButton('Discard changes').click());
  assert.ok(document.activeElement === extraction, 'Extraction button receives focus');
  assert.equal(commands.length, 1);
});

for (const mode of ['entry', 'group'] as const) {
  test(`discarding ${mode === 'entry' ? 'an entry' : 'a group'} draft while changing sections focuses the destination`, async () => {
    const state = focusReviewFixture();
    function RoutedDocuments() {
      const [section, setSection] = useState<'imports' | 'files' | undefined>('imports');
      return createElement(DocumentLibrary, { state, scope: 'personal', initialSection: section,
        onSectionChange: next => { requestDraftNavigation(() => setSection(next)); },
        onCommand: async () => { assert.fail('Discard must not write records'); },
      });
    }
    await act(async () => root.render(createElement(RoutedDocuments)));
    await act(async () => reviewButton('Review entries').click());
    await act(async () => reviewButton(mode === 'entry' ? 'Classify' : 'Review matching rows together').click());
    const destination = reviewButton('Source files');
    destination.focus();
    await act(async () => destination.click());
    await act(async () => reviewButton('Discard changes').click());
    assert.equal(destination.getAttribute('aria-pressed'), 'true');
    assert.ok(document.activeElement === destination, 'The selected section receives focus');
    assert.equal(document.activeElement?.closest('[hidden]'), null);
  });
}
