import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState } from '../shared/types.ts';
import type { DocumentRestorePreview } from '../shared/recovery.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
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
const { default: DocumentRecovery } = await import('./features/records/DocumentRecovery.tsx');
const { default: Forms } = await import('./features/entries/Forms.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'cash', entityId: 'personal', name: 'Cash', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(element => element.textContent?.trim() === text);
  assert.ok(result, `Missing button ${text}`);
  return result;
}
const nativeFetch = globalThis.fetch;
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); globalThis.fetch = nativeFetch; });

const health = { revision: 1, documents: 0, missingOriginals: 0, damagedOriginals: 0, unlinkedDocuments: 0, missingAccountLinks: 0, statementSources: 0, missingStatementSources: 0, issues: [] };
function archivePreview(): DocumentRestorePreview {
  return { token: 'staged-token', expectedRevision: 1, archiveSha256: 'a'.repeat(64), counts: { documents: 1, reviewSources: 0, newDocuments: 1, existingDocuments: 0, missingOriginals: 0, unresolvedLinks: 1, conflicts: 0 }, documents: [{ id: 'b'.repeat(64), originalName: 'statement.pdf', bytes: 42, status: 'new', originalAccountId: 'old-cash', suggestedAccountId: null, linkReason: 'unresolved' }], reviewSources: [], conflicts: [] };
}
async function mount(preview = archivePreview()) {
  const calls: { url: string; body: unknown; method: string | undefined }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body, method: options?.method });
    if (options?.method === 'DELETE') return Response.json({ status: 'discarded' });
    if (String(url).includes('/preview')) return Response.json(preview);
    if (String(url).includes('/commit')) return Response.json({ status: 'restored', documentsAdded: 1, originalsRepaired: 0, documentsPreserved: 0, reviewSourcesRestored: 0, unlinkedDocuments: 1, archiveSha256: preview.archiveSha256, recovery: { ...health, documents: 1 } });
    return Response.json(health);
  };
  await act(async () => root.render(createElement(DocumentRecovery, { workspace: 'live', revision: 1, accounts: fixture().accounts })));
  return calls;
}
async function upload(size = 10) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [{ name: 'originals.tar.gz', size }], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => button('Verify archive').click());
}
async function chooseAccount(value: string) {
  const input = container.querySelector<HTMLSelectElement>('select')!;
  await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function confirm() { await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }

for (const phase of ['fetch', 'body'] as const) test(`a stalled restore ${phase} keeps the original choices for explicit receipt confirmation`, async t => {
  await mount(); await upload(); await chooseAccount('cash'); await confirm();
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  let completeLate!: () => void;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/commit')) return originalFetch(url, options);
    requests.push(options!);
    if (requests.length > 1) return originalFetch(url, options);
    const response = await originalFetch(url, options);
    const result = await response.json();
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(Response.json(result)); });
    return { ok: true, json: () => new Promise(resolve => { completeLate = () => resolve(result); }) } as Response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Restore original files').click());
  await act(async () => t.mock.timers.tick(179_999));
  assert.equal(requests[0].signal?.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(requests[0].signal?.aborted, true);
  assert.match(container.textContent!, /timed out/);
  assert.equal(requests.length, 1);
  assert.equal(button('Confirm original restore').disabled, false);
  assert.equal(button('Check recovery again').disabled, false);
  assert.equal(button('Clear archive').disabled, true);
  assert.equal(button('Verify archive again').disabled, true);
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.disabled, true);
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'cash');
  assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, true);
  await act(async () => root.render(createElement(DocumentRecovery, { workspace: 'live', revision: 2, accounts: fixture().accounts })));
  assert.equal(button('Confirm original restore').disabled, false);
  assert.doesNotMatch(container.textContent!, /Verify the archive again before restoring/);
  await act(async () => button('Check recovery again').click());
  assert.equal(requests.length, 1);
  await act(async () => completeLate());
  assert.match(container.textContent!, /timed out/);
  assert.equal(button('Clear archive').disabled, true);
  await act(async () => button('Confirm original restore').click());
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(JSON.parse(String(requests[1].body)), { token: 'staged-token', expectedRevision: 1, accountMappings: { ['b'.repeat(64)]: 'cash' } });
  assert.match(container.textContent!, /1 documents restored/);
  assert.equal(container.querySelector('select'), null);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled, false);
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(requests[1].signal?.aborted, false);
});

test('archive verification does not restore files and unresolved links require an explicit choice', async () => {
  const calls = await mount();
  await upload();
  assert.equal(calls.filter(call => call.url.includes('/commit')).length, 0);
  assert.equal(button('Restore original files').disabled, true);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, true);
  await chooseAccount('unlinked');
  await confirm();
  await act(async () => button('Restore original files').click());
  const commit = calls.find(call => call.url.includes('/commit'))!;
  assert.deepEqual(JSON.parse(String(commit.body)), { token: 'staged-token', expectedRevision: 1, accountMappings: { ['b'.repeat(64)]: null } });
  assert.match(container.textContent!, /1 documents restored/);
  assert.equal(container.querySelector('select'), null);
});

test('clearing an archive discards its staged preview before clearing the selected file', async () => {
  const calls = await mount();
  await upload();
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled, true);
  await act(async () => button('Clear archive').click());
  const discarded = calls.filter(call => call.method === 'DELETE');
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].url, '/api/documents/restore/preview?workspace=live&token=staged-token');
  assert.equal(container.querySelector('select'), null);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled, false);
  assert.ok(!container.textContent!.includes('Clear archive'));
});

for (const kind of ['health', 'preview', 'discard'] as const) for (const phase of ['fetch', 'body'] as const) test(`a stalled recovery ${kind} ${phase} request releases controls and ignores its late response`, async t => {
  const calls = await mount();
  if (kind === 'discard') { await upload(); await chooseAccount('cash'); }
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined;
  let attempts = 0;
  let completeLate!: () => void;
  const pending = kind === 'health' ? { ...health, documents: 99 } : kind === 'discard' ? { status: 'discarded' } : archivePreview();
  const matches = (url: string, options?: RequestInit) => kind === 'health' ? url.includes('/recovery?') : kind === 'discard' ? options?.method === 'DELETE' : options?.method === 'POST' && url.includes('/preview?');
  globalThis.fetch = async (url, options) => {
    if (!matches(String(url), options)) return originalFetch(url, options);
    attempts++; request = options;
    const response = Response.json(pending);
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    t.mock.method(response, 'json', () => new Promise(resolve => { completeLate = () => resolve(pending); }));
    return response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  if (kind === 'health') await act(async () => button('Check recovery again').click());
  else if (kind === 'discard') await act(async () => button('Clear archive').click());
  else await upload();
  const duration = kind === 'health' ? 15_000 : kind === 'preview' ? 180_000 : 60_000;
  await act(async () => t.mock.timers.tick(duration - 1));
  assert.equal(request?.signal?.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(request?.signal?.aborted, true);
  assert.match(container.textContent!, /timed out/);
  assert.equal(button(kind === 'health' ? 'Check recovery again' : kind === 'preview' ? 'Verify archive' : 'Clear archive').disabled, false);
  assert.equal(attempts, 1);
  if (kind === 'discard') assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'cash');
  await act(async () => completeLate());
  assert.match(container.textContent!, /timed out/);
  if (kind === 'preview') assert.equal(container.querySelector('select'), null);
  else if (kind === 'discard') assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'cash');
  else assert.doesNotMatch(container.textContent!, /99 documents/);
  let retried: RequestInit | undefined;
  globalThis.fetch = async (url, options) => {
    if (matches(String(url), options)) { attempts++; retried = options; }
    return originalFetch(url, options);
  };
  await act(async () => button(kind === 'health' ? 'Check recovery again' : kind === 'preview' ? 'Verify archive' : 'Clear archive').click());
  assert.equal(attempts, 2);
  assert.doesNotMatch(container.textContent!, /timed out/);
  if (kind === 'preview') assert.ok(container.querySelector('select'));
  if (kind === 'discard') assert.equal(container.querySelector('select'), null);
  await act(async () => t.mock.timers.tick(duration));
  assert.equal(retried?.signal?.aborted, false);
  assert.equal(calls.filter(call => call.url.includes('/commit')).length, 0);
});

test('a preview timeout keeps exact archive bytes for manual retry and cannot replace a newer preview', async t => {
  const calls = await mount();
  const originalFetch = globalThis.fetch;
  const archive = new File([new Uint8Array([31, 139, 8, 0, 10, 20, 30])], 'preserved-originals.tar.gz', { type: 'application/gzip' });
  const bodies: unknown[] = [];
  let completeLate!: (response: Response) => void;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/preview') || options?.method !== 'POST') return originalFetch(url, options);
    bodies.push(options.body);
    if (bodies.length === 1) return new Promise<Response>(resolve => { completeLate = resolve; });
    const current = archivePreview(); current.token = 'new-preview'; current.documents[0].originalName = 'new-preview.pdf';
    return Response.json(current);
  };
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [archive], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Verify archive').click());
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(input.files![0], archive);
  assert.equal(button('Clear archive').disabled, false);
  await act(async () => button('Verify archive').click());
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], archive); assert.equal(bodies[1], archive);
  assert.deepEqual(new Uint8Array(await (bodies[1] as File).arrayBuffer()), new Uint8Array([31, 139, 8, 0, 10, 20, 30]));
  await chooseAccount('cash');
  await act(async () => completeLate(Response.json(archivePreview())));
  assert.match(container.textContent!, /new-preview\.pdf/);
  assert.doesNotMatch(container.textContent!, /statement\.pdf/);
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'cash');
  await act(async () => button('Clear archive').click());
  assert.equal(calls.find(call => call.method === 'DELETE')!.url, '/api/documents/restore/preview?workspace=live&token=new-preview');
  assert.equal(calls.filter(call => call.url.includes('/commit')).length, 0);
});

for (const phase of ['fetch', 'body'] as const) test(`a timed-out ${phase} discard during re-verification keeps choices and never starts another upload`, async t => {
  const calls = await mount(); await upload(); await chooseAccount('cash');
  const originalFetch = globalThis.fetch;
  const tokens: string[] = [];
  let completeLate!: () => void;
  globalThis.fetch = async (url, options) => {
    if (options?.method !== 'DELETE') return originalFetch(url, options);
    tokens.push(String(url));
    const response = Response.json({ status: 'discarded' });
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    t.mock.method(response, 'json', () => new Promise(resolve => { completeLate = () => resolve({ status: 'discarded' }); }));
    return response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Verify archive again').click());
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'cash');
  assert.equal(button('Verify archive again').disabled, false);
  await act(async () => completeLate());
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'cash');
  assert.equal(calls.filter(call => call.method === 'POST' && call.url.includes('/preview')).length, 1);
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'DELETE') tokens.push(String(url));
    return originalFetch(url, options);
  };
  await act(async () => button('Clear archive').click());
  assert.deepEqual(tokens, Array(2).fill('/api/documents/restore/preview?workspace=live&token=staged-token'));
  assert.equal(calls.filter(call => call.url.includes('/commit')).length, 0);
});

test('an unconfirmed discard response preserves the archive and account choices', async () => {
  await mount(); await upload(); await chooseAccount('cash');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => options?.method === 'DELETE' ? Response.json({ status: 'pending' }) : originalFetch(url, options);
  await act(async () => button('Clear archive').click());
  assert.match(container.textContent!, /not confirmed as cleared/);
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'cash');
  assert.equal(button('Clear archive').disabled, false);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled, true);
});

for (const kind of ['health', 'preview', 'discard'] as const) for (const phase of ['fetch', 'body'] as const) test(`canceling a pending recovery ${kind} ${phase} request cannot update another workspace or chain a mutation`, async t => {
  const calls = await mount();
  if (kind === 'discard') { await upload(); await chooseAccount('cash'); }
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined;
  let completeLate!: () => void;
  let attempts = 0;
  globalThis.fetch = async (url, options) => {
    const matches = String(url).includes('workspace=live') && (kind === 'health' ? String(url).includes('/recovery?') : kind === 'discard' ? options?.method === 'DELETE' : options?.method === 'POST');
    if (!matches) return originalFetch(url, options);
    request = options; attempts++;
    const value = kind === 'health' ? { ...health, documents: 99 } : kind === 'preview' ? archivePreview() : { status: 'discarded' };
    const response = Response.json(value);
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    t.mock.method(response, 'json', () => new Promise(resolve => { completeLate = () => resolve(value); }));
    return response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  if (kind === 'health') await act(async () => button('Check recovery again').click());
  else if (kind === 'discard') await act(async () => button('Verify archive again').click());
  else await upload();
  assert.equal(request?.signal?.aborted, false);
  if (phase === 'fetch') await act(async () => root.render(null));
  else await act(async () => root.render(createElement(DocumentRecovery, { workspace: 'demo', revision: 1, accounts: fixture().accounts })));
  assert.equal(request?.signal?.aborted, true);
  assert.equal(request?.signal?.reason.name, 'AbortError');
  await act(async () => completeLate());
  await act(async () => t.mock.timers.tick(180_000));
  assert.doesNotMatch(container.textContent!, /99 documents|statement\.pdf|originals\.tar\.gz|timed out|canceled/);
  if (phase === 'fetch') assert.equal(container.textContent, '');
  else assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled, false);
  assert.equal(attempts, 1);
  assert.equal(calls.filter(call => call.method === 'POST' && call.url.includes('/preview')).length, kind === 'discard' ? 1 : 0);
  assert.equal(calls.filter(call => call.url.includes('/commit')).length, 0);
});

test('verifying again discards the old preview before creating another one', async () => {
  const calls = await mount();
  await upload();
  await act(async () => button('Verify archive again').click());
  assert.deepEqual(calls.filter(call => call.url.includes('/preview')).map(call => call.method), ['POST', 'DELETE', 'POST']);
});

test('failed preview cancellation preserves its file, account choices and retry controls', async () => {
  const calls = await mount();
  await upload(); await chooseAccount('cash');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => options?.method === 'DELETE' ? Response.json({ error: 'Recovery files need inspection.' }, { status: 409 }) : originalFetch(url, options);
  await act(async () => button('Clear archive').click());
  assert.match(container.textContent!, /Recovery files need inspection/);
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'cash');
  assert.equal(button('Clear archive').disabled, false);
  await act(async () => button('Verify archive again').click());
  assert.equal(calls.filter(call => call.method === 'POST' && call.url.includes('/preview')).length, 1);
});

test('verification that returns an old revision retains its preview token so it can be cleared', async () => {
  const stalePreview = archivePreview(); stalePreview.expectedRevision = 0;
  const calls = await mount(stalePreview);
  await upload();
  assert.match(container.textContent!, /Financial records changed during verification/);
  await act(async () => button('Clear archive').click());
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
});

test('account mappings are sent with the verified revision and changing them clears confirmation', async () => {
  const calls = await mount();
  await upload(); await chooseAccount('unlinked'); await confirm();
  await chooseAccount('cash');
  assert.equal(button('Restore original files').disabled, true);
  await confirm(); await act(async () => button('Restore original files').click());
  assert.equal(JSON.parse(String(calls.find(call => call.url.includes('/commit'))!.body)).accountMappings['b'.repeat(64)], 'cash');
});

test('changed financial records prevent committing an old preview', async () => {
  const calls = await mount(); await upload(); await chooseAccount('cash'); await confirm();
  await act(async () => root.render(createElement(DocumentRecovery, { workspace: 'live', revision: 2, accounts: fixture().accounts })));
  assert.match(container.textContent!, /Financial records changed/);
  assert.equal(button('Restore original files').disabled, true);
  assert.equal(calls.filter(call => call.url.includes('/commit')).length, 0);
});

test('conflicts block restore even when all account links can be matched', async () => {
  const preview = archivePreview(); preview.conflicts = ['A review source has different saved bytes.']; preview.counts.conflicts = 1;
  await mount(preview); await upload(); await chooseAccount('cash');
  assert.match(container.textContent!, /different saved bytes/);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, true);
  assert.equal(button('Restore original files').disabled, true);
});

test('a failed commit preserves account choices and retries the same staged archive', async () => {
  const calls = await mount(); await upload(); await chooseAccount('cash'); await confirm();
  const fetch = globalThis.fetch; let failed = false;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/commit') && !failed) { failed = true; return Response.json({ error: 'Connection interrupted. Check recovery status.' }, { status: 503 }); }
    return fetch(url, options);
  };
  await act(async () => button('Restore original files').click());
  assert.match(container.textContent!, /Connection interrupted/);
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'cash');
  await act(async () => button('Confirm original restore').click());
  assert.equal(JSON.parse(String(calls.find(call => call.url.includes('/commit'))!.body)).token, 'staged-token');
});

for (const status of [400, 401, 404, 409, 503]) test(`HTTP ${status} cannot release the choices from an uncertain original restore`, async t => {
  await mount(); await upload(); await chooseAccount('cash'); await confirm();
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/commit')) return originalFetch(url, options);
    requests.push(options!);
    if (requests.length === 1) return new Promise<Response>(() => {});
    if (requests.length === 2) return Response.json({ error: status === 404 ? 'This archive preview expired. Upload the archive again.' : status === 409 ? 'Financial records changed after preview. Preview the archive again.' : 'The original response could not be confirmed.' }, { status });
    return originalFetch(url, options);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Restore original files').click());
  await act(async () => t.mock.timers.tick(180_000));
  await act(async () => button('Confirm original restore').click());
  assert.equal(requests.length, 2);
  assert.equal(button('Clear archive').disabled, true);
  assert.equal(button('Verify archive again').disabled, true);
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.disabled, true);
  assert.equal(button('Confirm original restore').disabled, false);
  assert.match(container.textContent!, /restore may have completed/);
  await act(async () => root.render(createElement(DocumentRecovery, { workspace: 'live', revision: 3, accounts: fixture().accounts })));
  await act(async () => button('Confirm original restore').click());
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].body, requests[2].body);
  assert.match(container.textContent!, /1 documents restored/);
});

for (const failure of ['transport', 'cleanup', 'invalid', 'other archive'] as const) test(`a first restore failure (${failure}) keeps its exact request`, async () => {
  await mount(); await upload(); await chooseAccount('unlinked'); await confirm();
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/commit')) return originalFetch(url, options);
    requests.push(options!);
    if (requests.length > 1) return originalFetch(url, options);
    if (failure === 'transport') throw new TypeError('Failed to fetch');
    if (failure === 'cleanup') return Response.json({ error: 'The completed stage could not be removed.' }, { status: 400 });
    const response = await originalFetch(url, options);
    const result = await response.json();
    return Response.json(failure === 'invalid' ? { ...result, status: 'pending' } : { ...result, archiveSha256: 'c'.repeat(64) });
  };
  await act(async () => button('Restore original files').click());
  assert.equal(requests.length, 1);
  assert.equal(button('Clear archive').disabled, true);
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.value, 'unlinked');
  assert.equal(container.querySelector<HTMLSelectElement>('select')!.disabled, true);
  assert.match(container.textContent!, /restore may have completed/);
  assert.doesNotMatch(container.textContent!, /1 documents restored/);
  await act(async () => button('Confirm original restore').click());
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(JSON.parse(String(requests[1].body)).accountMappings['b'.repeat(64)], null);
  assert.match(container.textContent!, /1 documents restored/);
});

for (const phase of ['fetch', 'body'] as const) test(`canceling a restore ${phase} request prevents its receipt from updating another workspace`, async t => {
  await mount(); await upload(); await chooseAccount('cash'); await confirm();
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined;
  let completeLate!: () => void;
  let attempts = 0;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/commit')) return originalFetch(url, options);
    request = options; attempts++;
    const response = await originalFetch(url, options);
    const result = await response.json();
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(Response.json(result)); });
    return { ok: true, json: () => new Promise(resolve => { completeLate = () => resolve(result); }) } as Response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Restore original files').click());
  assert.equal(request?.signal?.aborted, false);
  if (phase === 'fetch') await act(async () => root.render(null));
  else await act(async () => root.render(createElement(DocumentRecovery, { workspace: 'demo', revision: 1, accounts: fixture().accounts })));
  assert.equal(request?.signal?.aborted, true);
  await act(async () => completeLate());
  await act(async () => t.mock.timers.tick(180_000));
  assert.doesNotMatch(container.textContent!, /documents restored|statement\.pdf|originals\.tar\.gz|timed out|Confirm original restore/);
  assert.equal(attempts, 1);
  if (phase === 'fetch') assert.equal(container.textContent, '');
  else assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled, false);
});

test('an uncertain restore releases Done and preserves its choices through Keep editing', async t => {
  await mount();
  const originalFetch = globalThis.fetch;
  let commits = 0, closed = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/commit')) { commits++; return new Promise<Response>(() => {}); }
    return originalFetch(url, options);
  };
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state: fixture(), onCommand: async () => {}, onClose: () => { closed++; } })));
  const input = container.querySelector<HTMLInputElement>('input[accept=".gz,.tgz,application/gzip"]')!;
  Object.defineProperty(input, 'files', { value: [{ name: 'originals.tar.gz', size: 10 }], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => button('Verify archive').click());
  const account = container.querySelector<HTMLSelectElement>('[aria-label="Account for statement.pdf"]')!;
  await act(async () => { account.value = 'cash'; account.dispatchEvent(new Event('change', { bubbles: true })); });
  const confirmation = container.querySelector<HTMLInputElement>('.document-recovery input[type="checkbox"]')!;
  await act(async () => confirmation.click());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Restore original files').click());
  assert.equal(button('Done').disabled, true);
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(button('Done').disabled, false);
  assert.equal(button('Check recovery again').disabled, false);
  assert.match(container.textContent!, /Closing this window discards only the on-screen choices. It does not undo files already restored/);
  await act(async () => button('Done').click());
  assert.match(container.textContent!, /Discard unsaved changes/);
  await act(async () => button('Keep editing').click());
  assert.equal(account.value, 'cash'); assert.equal(account.disabled, true);
  assert.equal(button('Confirm original restore').disabled, false);
  assert.equal(commits, 1);
  await act(async () => button('Done').click());
  await act(async () => button('Discard changes').click());
  assert.equal(closed, 1);
  assert.equal(commits, 1);
});

for (const operation of ['preview', 'discard', 'commit'] as const) for (const bodyFocus of [false, true]) test(`${operation} timeout focuses its error when recovery still owns ${bodyFocus ? 'body' : 'control'} focus`, async t => {
  await mount(); await upload(); await chooseAccount('cash'); await confirm();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const matches = operation === 'commit' ? String(url).includes('/commit') : operation === 'discard' ? options?.method === 'DELETE' : String(url).includes('/preview') && options?.method === 'POST';
    return matches ? new Promise<Response>(() => {}) : originalFetch(url, options);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const action = button(operation === 'commit' ? 'Restore original files' : operation === 'discard' ? 'Clear archive' : 'Verify archive again');
  action.focus();
  await act(async () => action.click());
  if (bodyFocus) { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); assert.ok(document.activeElement === document.body); }
  await act(async () => t.mock.timers.tick(operation === 'discard' ? 60_000 : 180_000));
  const error = container.querySelector<HTMLElement>('.document-recovery .notice[role="alert"]')!;
  assert.match(error.textContent!, /timed out/);
  assert.ok(document.activeElement === error);
});

for (const focus of ['other editor', 'other editor then blur', 'outside pointer', 'hidden', 'inert', 'CSS hidden'] as const) test(`an archive timeout leaves focus alone for ${focus}`, async t => {
  await mount(); await upload();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes('/preview') && options?.method === 'POST' ? new Promise<Response>(() => {}) : originalFetch(url, options);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const action = button('Verify archive again');
  action.focus();
  await act(async () => action.click());
  document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex');
  const region = container.querySelector<HTMLElement>('.document-recovery')!;
  const other = document.createElement('input'); document.body.append(other);
  t.after(() => other.remove());
  if (focus.startsWith('other editor')) other.focus();
  if (focus === 'other editor then blur') other.blur();
  if (focus === 'outside pointer') other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  if (focus === 'hidden') region.hidden = true;
  if (focus === 'inert') region.setAttribute('inert', '');
  if (focus === 'CSS hidden') region.style.display = 'none';
  const active = document.activeElement;
  await act(async () => t.mock.timers.tick(180_000));
  assert.match(container.textContent!, /timed out/);
  assert.ok(document.activeElement === active);
});

test('background recovery health errors never move focus', async t => {
  await mount();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes('/recovery?') ? new Promise<Response>(() => {}) : originalFetch(url, options);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const action = button('Check recovery again'); action.focus();
  await act(async () => action.click());
  await act(async () => t.mock.timers.tick(15_000));
  assert.match(container.textContent!, /timed out/);
  assert.equal(document.activeElement, action);
});

test('oversized archives are rejected before upload', async () => {
  const calls = await mount(); await upload(256 * 1024 * 1024 + 1);
  assert.match(container.textContent!, /smaller than 256 MiB/);
  assert.equal(calls.filter(call => call.url.includes('/preview')).length, 0);
});

test('invalid archives report hash failures without offering a restore', async () => {
  await mount(); const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes('/preview') ? Response.json({ error: 'Original SHA-256 does not match.' }, { status: 400 }) : fetch(url, options);
  await upload();
  assert.match(container.textContent!, /SHA-256 does not match/);
  assert.equal([...container.querySelectorAll('button')].some(item => item.textContent === 'Restore original files'), false);
});

test('selecting an original archive prevents staging a financial replacement and can be cleared', async () => {
  await mount();
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state: fixture(), onCommand: async () => {}, onClose: () => {} })));
  const archive = container.querySelector<HTMLInputElement>('input[accept=".gz,.tgz,application/gzip"]')!;
  const financial = container.querySelector<HTMLInputElement>('input[accept=".json,.gz,application/json,application/gzip"]')!;
  Object.defineProperty(archive, 'files', { value: [{ name: 'originals.tar.gz', size: 10 }], configurable: true });
  await act(async () => archive.dispatchEvent(new Event('change', { bubbles: true })));
  assert.equal(financial.disabled, true);
  assert.equal(button('Restore Mazal').disabled, true);
  assert.equal(button('Clear archive').disabled, false);
  await act(async () => button('Clear archive').click());
  assert.equal(financial.disabled, false);
  assert.equal(button('Restore Mazal').disabled, false);
});

test('saved account link correction sends only the link and its document revision', async () => {
  await mount(); const saved = { id: 'b'.repeat(64), originalName: 'statement.pdf', accountId: 'missing-account', revision: 7 };
  const calls: unknown[] = []; const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'PATCH') { const patch = JSON.parse(String(options.body)); calls.push(patch); return Response.json({ document: { ...saved, accountId: patch.accountId, revision: 8 } }); }
    if (String(url).includes('/api/documents?')) return Response.json({ documents: [saved] });
    return fetch(url, options);
  };
  await act(async () => button('Review saved account links').click());
  const selectDocument = container.querySelector<HTMLSelectElement>('[aria-label="Saved document"]')!;
  await act(async () => { selectDocument.value = saved.id; selectDocument.dispatchEvent(new Event('change', { bubbles: true })); });
  const selectAccount = container.querySelector<HTMLSelectElement>('[aria-label="Saved account link"]')!;
  await act(async () => { selectAccount.value = 'cash'; selectAccount.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled, true);
  await act(async () => button('Save account link').click());
  assert.deepEqual(calls, [{ expectedRevision: 7, accountId: 'cash' }]);
  assert.match(container.textContent!, /Account link saved/);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled, false);
});

test('a stale document link save keeps the choice after reloading the latest saved links', async () => {
  await mount(); const saved = { id: 'b'.repeat(64), originalName: 'statement.pdf', accountId: null, revision: 7 }; const fetch = globalThis.fetch;
  let patches = 0;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'PATCH') { patches++; return Response.json({ error: 'This document changed in another window.' }, { status: 409 }); }
    if (String(url).includes('/api/documents?')) return Response.json({ documents: [saved] });
    return fetch(url, options);
  };
  await act(async () => button('Review saved account links').click());
  const selectDocument = container.querySelector<HTMLSelectElement>('[aria-label="Saved document"]')!;
  await act(async () => { selectDocument.value = saved.id; selectDocument.dispatchEvent(new Event('change', { bubbles: true })); });
  const selectAccount = container.querySelector<HTMLSelectElement>('[aria-label="Saved account link"]')!;
  await act(async () => { selectAccount.value = 'cash'; selectAccount.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Save account link').click());
  assert.match(container.textContent!, /changed in another window/);
  assert.equal(selectAccount.value, 'cash');
  await act(async () => button('Reload saved links').click());
  assert.equal(selectDocument.value, saved.id);
  assert.equal(selectAccount.value, 'cash');
  assert.match(container.textContent!, /Saved account link: Unlinked/);
  assert.equal(button('Save account link').disabled, false);
  assert.equal(patches, 1);
});
