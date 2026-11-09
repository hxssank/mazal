import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { Workspace } from '../shared/types.ts';
import type { CalculationStorageUsage } from '../shared/engine.ts';

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
const { default: CalculationStorage } = await import('./features/planner/CalculationStorage.tsx');
const { default: Forms } = await import('./features/entries/Forms.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const nativeFetch = globalThis.fetch;
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); globalThis.fetch = nativeFetch; });

const finishedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const activeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const archiveId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function usage(workspace: Workspace = 'live'): CalculationStorageUsage {
  const run = { id: finishedId, workspace, status: 'completed' as const, kind: 'comparison', revision: 7, scope: 'personal', asOf: '2026-09-27', createdAt: '2026-09-27T12:00:00Z', bytes: 300, fileCount: 3, archivable: true };
  return {
    workspace, runBytes: 600, archiveBytes: 120, totalBytes: 720, unreadableEntryCount: 0, unclassifiedBytes: 0,
    runs: [run, { ...run, id: activeId, status: 'running', archivable: false }],
    archives: [{ id: archiveId, workspace, createdAt: '2026-09-27T11:00:00Z', runIds: [finishedId], runCount: 1, bytes: 100, uncompressedBytes: 300, sha256: 'd'.repeat(64), restoredRunCount: 0, retainedBytes: 0, metadataBytes: 20 }],
    limits: { runsPerArchive: 20, uncompressedBytesPerArchive: 128 * 1024 * 1024 },
  };
}
function button(text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
  assert.ok(element, `Missing button ${text}`);
  return element;
}
function selection(index = 0): HTMLInputElement { return container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]; }
async function render(workspace: Workspace = 'live', callbacks = {}) {
  await act(async () => root.render(createElement(CalculationStorage, { workspace, ...callbacks })));
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('loading and selecting evidence never archives automatically, and active runs cannot be selected', async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const dirty: boolean[] = [];
  let archived = false;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? 'GET', body: options?.body });
    if (String(url).includes('/archive?')) { archived = true; return Response.json({ workspace: 'live', archiveId, archivedRunCount: 1 }); }
    const result = usage();
    if (archived) result.runs = result.runs.filter(run => run.id !== finishedId);
    return Response.json(result);
  };
  await render('live', { onDirtyChange: (value: boolean) => dirty.push(value) });
  assert.equal(button('Archive selected calculations').disabled, true);
  assert.equal(selection(1).disabled, true);
  await click(selection(1));
  await click(selection());
  assert.equal(dirty.at(-1), true);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  await click(button('Archive selected calculations (1)'));
  const mutations = calls.filter(call => call.method === 'POST');
  assert.deepEqual(mutations, [{ url: '/api/engine/storage/archive?workspace=live', method: 'POST', body: JSON.stringify({ runIds: [finishedId] }) }]);
  assert.equal(selection().checked, false);
  assert.equal(dirty.at(-1), false);
});

test('archive downloads and explicit restore stay in the selected workspace', async () => {
  let restored = false;
  const mutations: { url: string; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') { mutations.push({ url: String(url), body: options.body }); restored = true; return Response.json({ workspace: 'demo', archiveId }); }
    const result = usage('demo');
    if (restored) result.archives[0].restoredRunCount = 1;
    return Response.json(result);
  };
  await render('demo');
  const link = container.querySelector<HTMLAnchorElement>('a[download]')!;
  assert.equal(link.getAttribute('href'), `/api/engine/storage/archives/${archiveId}/download?workspace=demo`);
  assert.equal(mutations.length, 0);
  await click(button('Restore calculations'));
  assert.deepEqual(mutations, [{ url: '/api/engine/storage/restore?workspace=demo', body: JSON.stringify({ archiveId }) }]);
  assert.equal(button('Already restored').disabled, true);
  assert.match(container.textContent!, /The ZIP archive remains saved/);
});

test('an archive failure preserves selection and releases busy state for an explicit retry', async () => {
  const busy: boolean[] = [];
  const response = pending<Response>();
  globalThis.fetch = async (_url, options) => options?.method === 'POST' ? response.promise : Response.json(usage());
  await render('live', { onBusyChange: (value: boolean) => busy.push(value) });
  await click(selection());
  await click(button('Archive selected calculations (1)'));
  assert.equal(busy.at(-1), true);
  assert.equal(selection().disabled, true);
  assert.equal(button('Refresh storage').disabled, true);
  await act(async () => response.resolve(Response.json({ error: 'The disk is full. Existing evidence was kept.' }, { status: 503 })));
  assert.equal(busy.at(-1), false);
  assert.equal(selection().checked, true);
  assert.equal(button('Archive selected calculations (1)').disabled, false);
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /disk is full/);
});

test('unmounting during an archive releases parent guards and ignores the eventual response', async () => {
  const busy: boolean[] = [];
  const dirty: boolean[] = [];
  const response = pending<Response>();
  let reads = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') return response.promise;
    reads++;
    return Response.json(usage());
  };
  await render('live', { onBusyChange: (value: boolean) => busy.push(value), onDirtyChange: (value: boolean) => dirty.push(value) });
  await click(selection()); await click(button('Archive selected calculations (1)'));
  await act(async () => root.unmount());
  assert.equal(busy.at(-1), false); assert.equal(dirty.at(-1), false);
  await act(async () => response.resolve(Response.json({ workspace: 'live', archiveId })));
  assert.equal(reads, 1);
  root = createRoot(container);
});

test('late reads from the previous workspace cannot replace the current evidence', async () => {
  const old = pending<Response>();
  globalThis.fetch = async url => String(url).includes('workspace=live') ? old.promise : Response.json({ ...usage('demo'), runs: [], archives: [], totalBytes: 0, runBytes: 0, archiveBytes: 0 });
  await render('live');
  await render('demo');
  await act(async () => old.resolve(Response.json(usage('live'))));
  assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(container.querySelector('a[download]'), null);
  assert.match(container.textContent!, /No unpacked calculations in this workspace/);
  assert.doesNotMatch(container.textContent!, new RegExp(finishedId));
});

test('late archive success cannot replace a newly selected workspace or issue another read for the old workspace', async () => {
  const response = pending<Response>();
  const urls: string[] = [];
  globalThis.fetch = async (url, options) => {
    urls.push(String(url));
    if (options?.method === 'POST') return response.promise;
    return Response.json(usage(String(url).includes('workspace=demo') ? 'demo' : 'live'));
  };
  await render(); await click(selection()); await click(button('Archive selected calculations (1)'));
  await render('demo');
  await act(async () => response.resolve(Response.json({ workspace: 'live', archiveId })));
  assert.deepEqual(urls, ['/api/engine/storage?workspace=live', '/api/engine/storage/archive?workspace=live', '/api/engine/storage?workspace=demo']);
  assert.equal(selection().checked, false);
  assert.match(container.querySelector('a[download]')!.getAttribute('href')!, /workspace=demo$/);
  assert.doesNotMatch(container.textContent!, /Selected calculations were verified/);
});

test('unreadable and interrupted evidence stays visible with its retained byte counts', async () => {
  const result = usage();
  result.unreadableEntryCount = 1; result.unclassifiedBytes = 2048; result.archives[0].retainedBytes = 1024;
  globalThis.fetch = async () => Response.json(result);
  await render();
  assert.match(container.textContent!, /Another 2\.0 KB of unclassified calculation evidence remains on disk/);
  assert.match(container.textContent!, /interrupted move retained 1\.0 KB/);
  assert.match(container.textContent!, /Existing files were kept/);
});

function completedUsage(operation: 'archive' | 'restore', completed: boolean) {
  const result = usage();
  if (completed && operation === 'archive') result.runs = result.runs.filter(run => run.id !== finishedId);
  if (completed && operation === 'restore') result.archives[0].restoredRunCount = 1;
  return result;
}
function stalledResponse(value: unknown, phase: 'fetch' | 'body') {
  const response = Response.json(value);
  const deferred = pending<unknown>();
  if (phase === 'fetch') return { response: deferred.promise as Promise<Response>, finish: () => deferred.resolve(response) };
  response.json = () => deferred.promise;
  return { response: Promise.resolve(response), finish: () => deferred.resolve(value) };
}

for (const phase of ['fetch', 'body'] as const) test(`a stalled initial storage ${phase} releases Refresh without automatically retrying`, async t => {
  const delayed = stalledResponse(usage(), phase);
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, options) => { calls.push(options!); return calls.length === 1 ? delayed.response : Response.json(usage()); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render();
  await act(async () => t.mock.timers.tick(124_999));
  assert.equal(calls[0].signal?.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(calls[0].signal?.aborted, true);
  assert.equal(button('Refresh storage').disabled, false);
  assert.match(container.textContent!, /125 seconds/);
  assert.equal(calls.length, 1);
  await click(button('Refresh storage'));
  await act(async () => delayed.finish());
  assert.equal(calls.length, 2); assert.equal(selection().disabled, false);
  assert.doesNotMatch(container.textContent!, /125 seconds/);
  await act(async () => t.mock.timers.tick(125_000));
  assert.equal(calls[1].signal?.aborted, false);
});

for (const operation of ['archive', 'restore'] as const) for (const phase of ['fetch', 'body'] as const) for (const completed of [false, true]) test(`${operation} ${phase} timeout ${completed ? 'after' : 'before'} update reconciles with GET before another mutation`, async t => {
  const delayed = stalledResponse({ workspace: 'live', archiveId }, phase);
  const reconciled = pending<Response>();
  const calls: { method: string; options: RequestInit }[] = [];
  const busy: boolean[] = [], dirty: boolean[] = [];
  let writes = 0, reads = 0;
  globalThis.fetch = async (_url, options) => {
    const method = options?.method ?? 'GET'; calls.push({ method, options: options! });
    if (method === 'POST') { writes++; return writes === 1 ? delayed.response : Response.json({ workspace: 'live', archiveId }); }
    reads++;
    return reads === 2 ? reconciled.promise : Response.json(completedUsage(operation, writes > 0));
  };
  await render('live', { onBusyChange: (value: boolean) => busy.push(value), onDirtyChange: (value: boolean) => dirty.push(value) });
  await click(selection());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const action = button(operation === 'archive' ? 'Archive selected calculations (1)' : 'Restore calculations');
  await act(async () => { action.click(); action.click(); });
  assert.equal(writes, 1); assert.equal(busy.at(-1), true);
  await act(async () => t.mock.timers.tick(125_000));
  assert.equal(busy.at(-1), false); assert.equal(reads, 2); assert.equal(writes, 1);
  assert.equal(calls.find(call => call.method === 'POST')!.options.signal?.aborted, true);
  assert.equal(selection().checked, true); assert.equal(dirty.at(-1), true);
  assert.equal(button('Archive selected calculations (1)').disabled, true);
  assert.equal(button('Restore calculations').disabled, true);
  assert.match(container.textContent!, /update may have completed/);
  await act(async () => delayed.finish());
  assert.equal(writes, 1); assert.equal(reads, 2);
  await act(async () => reconciled.resolve(Response.json(completedUsage(operation, completed))));
  assert.equal(button('Refresh storage').disabled, false);
  if (operation === 'archive' && completed) {
    assert.equal(selection().checked, false); assert.equal(dirty.at(-1), false);
    assert.equal(button('Archive selected calculations').disabled, true);
  } else {
    assert.equal(selection().checked, true); assert.equal(dirty.at(-1), true);
    if (operation === 'restore' && completed) assert.equal(button('Already restored').disabled, true);
    else {
      await click(button(operation === 'archive' ? 'Archive selected calculations (1)' : 'Restore calculations'));
      assert.equal(writes, 2);
    }
  }
  assert.equal(calls.filter(call => call.method === 'POST').length, completed ? 1 : 2);
});

for (const outcome of ['success', 'uncertain'] as const) for (const phase of ['fetch', 'body'] as const) test(`${outcome} archive with a stalled reconciliation ${phase} keeps cached evidence and Done usable`, async t => {
  const delayed = stalledResponse(completedUsage('archive', true), phase);
  const calls: { method: string; options: RequestInit }[] = [];
  let reads = 0, writes = 0, closed = 0;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('/api/engine/storage')) return Response.json({ error: 'Synthetic unavailable service.' }, { status: 503 });
    const method = options?.method ?? 'GET'; calls.push({ method, options: options! });
    if (method === 'POST') { writes++; if (outcome === 'uncertain') throw new TypeError('Connection lost.'); return Response.json({ workspace: 'live', archiveId }); }
    reads++;
    return reads === 2 ? delayed.response : Response.json(completedUsage('archive', reads > 2));
  };
  const state = { workspace: 'live' as const, revision: 1, entities: [], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state, onCommand: async () => {}, onClose: () => { closed++; } })));
  await click(container.querySelector<HTMLInputElement>('.calculation-storage input[type="checkbox"]')!);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await click(button('Archive selected calculations (1)'));
  assert.equal(button('Done').disabled, false); assert.equal(writes, 1); assert.equal(reads, 2);
  assert.equal(button('Archive selected calculations (1)').disabled, true);
  await act(async () => t.mock.timers.tick(125_000));
  assert.match(container.querySelector('.calculation-storage')!.textContent!, /125 seconds/);
  assert.equal(button('Done').disabled, false); assert.equal(button('Refresh storage').disabled, false);
  assert.equal(container.querySelector<HTMLInputElement>('.calculation-storage input[type="checkbox"]')!.checked, true);
  await click(button('Done'));
  assert.match(container.textContent!, /Discard unsaved changes/);
  await click(button('Keep editing'));
  assert.equal(closed, 0); assert.equal(writes, 1);
  await click(button('Refresh storage'));
  await act(async () => delayed.finish());
  assert.equal(writes, 1); assert.equal(reads, 3);
  assert.equal(container.querySelector<HTMLInputElement>('.calculation-storage input[type="checkbox"]')!.checked, false);
  await click(button('Done')); assert.equal(closed, 1);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

for (const failure of ['HTTP rejection', 'invalid JSON', 'invalid usage', 'wrong workspace'] as const) test(`a refresh ${failure} retains the selection and blocks updates until a valid read`, async () => {
  let reads = 0, writes = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') writes++;
    reads++;
    if (reads !== 2) return Response.json(usage());
    if (failure === 'HTTP rejection') return Response.json({ error: 'Storage check failed.' }, { status: 503 });
    if (failure === 'invalid JSON') return new Response('not json');
    if (failure === 'wrong workspace') return Response.json(usage('demo'));
    return Response.json({ workspace: 'live' });
  };
  await render(); await click(selection()); await click(button('Refresh storage'));
  assert.equal(selection().checked, true); assert.equal(button('Archive selected calculations (1)').disabled, true);
  assert.match(container.textContent!, /Refresh storage/);
  await click(button('Refresh storage'));
  assert.equal(selection().checked, true); assert.equal(button('Archive selected calculations (1)').disabled, false); assert.equal(writes, 0);
});

for (const operation of ['read', 'archive', 'restore', 'reconciliation'] as const) for (const phase of ['fetch', 'body'] as const) test(`canceling ${operation} ${phase} aborts the request and ignores its late result`, async t => {
  const delayed = stalledResponse(operation === 'archive' || operation === 'restore' ? { workspace: 'live', archiveId } : usage(), phase);
  let reads = 0, writes = 0; let stalledOptions: RequestInit | undefined;
  const busy: boolean[] = [], dirty: boolean[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('workspace=demo')) return Response.json(usage('demo'));
    const writing = options?.method === 'POST';
    if (writing) writes++; else reads++;
    if (operation === 'read' || writing && operation !== 'reconciliation' || operation === 'reconciliation' && reads > 1) { stalledOptions = options; return delayed.response; }
    return Response.json(writing ? { workspace: 'live', archiveId } : usage());
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const callbacks = { onBusyChange: (value: boolean) => busy.push(value), onDirtyChange: (value: boolean) => dirty.push(value) };
  await render('live', callbacks);
  if (operation !== 'read') { await click(selection()); await click(button(operation === 'restore' ? 'Restore calculations' : 'Archive selected calculations (1)')); }
  if (phase === 'fetch') await act(async () => root.render(null));
  else await render('demo', callbacks);
  assert.equal(stalledOptions?.signal?.aborted, true);
  const counts = [reads, writes, busy.length, dirty.length];
  await act(async () => delayed.finish());
  await act(async () => t.mock.timers.tick(125_000));
  assert.deepEqual([reads, writes, busy.length, dirty.length], counts);
  assert.equal(busy.at(-1), false); assert.equal(dirty.at(-1), false);
  assert.doesNotMatch(container.textContent!, /125 seconds|may have completed|were verified|were restored/);
  if (phase === 'body') { assert.equal(selection().checked, false); assert.match(container.querySelector('a[download]')!.getAttribute('href')!, /workspace=demo$/); }
});

for (const operation of ['refresh', 'archive', 'restore', 'reconciliation'] as const) for (const bodyFocus of [false, true]) test(`${operation} timeout restores owned ${bodyFocus ? 'body' : 'control'} focus to its error`, async t => {
  let reads = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') return operation === 'reconciliation' ? Response.json({ workspace: 'live', archiveId }) : new Promise<Response>(() => {});
    reads++;
    return reads === 1 ? Response.json(usage()) : new Promise<Response>(() => {});
  };
  await render(); await click(selection());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const action = button(operation === 'refresh' ? 'Refresh storage' : operation === 'restore' ? 'Restore calculations' : 'Archive selected calculations (1)');
  await act(async () => { action.focus(); action.click(); });
  if (bodyFocus) { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); }
  await act(async () => t.mock.timers.tick(125_000));
  assert.ok(document.activeElement === container.querySelector('[role="alert"][tabindex]'));
});

for (const focus of ['another editor', 'another editor then blur', 'outside pointer', 'hidden', 'inert', 'CSS hidden'] as const) test(`a storage timeout leaves focus alone for ${focus}`, async t => {
  globalThis.fetch = async (_url, options) => options?.method === 'POST' ? new Promise<Response>(() => {}) : Response.json(usage());
  await render(); await click(selection());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const action = button('Archive selected calculations (1)');
  await act(async () => { action.focus(); action.click(); });
  document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex');
  const section = container.querySelector<HTMLElement>('section')!;
  const other = document.createElement('input'); document.body.append(other); t.after(() => other.remove());
  if (focus.startsWith('another editor')) other.focus();
  if (focus === 'another editor then blur') other.blur();
  if (focus === 'outside pointer') other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  if (focus === 'hidden') section.hidden = true;
  if (focus === 'inert') section.setAttribute('inert', '');
  if (focus === 'CSS hidden') section.style.display = 'none';
  const active = document.activeElement;
  await act(async () => t.mock.timers.tick(125_000));
  assert.ok(document.activeElement === active);
});

test('an initial background storage error never moves focus from its region', async t => {
  globalThis.fetch = async () => new Promise<Response>(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render();
  const section = container.querySelector<HTMLElement>('section')!; section.tabIndex = -1; section.focus();
  await act(async () => t.mock.timers.tick(125_000));
  assert.ok(document.activeElement === section);
});

for (const operation of ['read', 'archive', 'restore'] as const) test(`a stalled ${operation} HTTP error body reaches its deadline without retrying a mutation`, async t => {
  let reads = 0, writes = 0; let stalledOptions: RequestInit | undefined;
  const delayed = pending<unknown>();
  globalThis.fetch = async (_url, options) => {
    const writing = options?.method === 'POST';
    if (writing) writes++; else reads++;
    if (operation === 'read' && reads === 1 || writing) { stalledOptions = options; return { ok: false, json: () => delayed.promise } as Response; }
    return Response.json(usage());
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render();
  if (operation !== 'read') { await click(selection()); await click(button(operation === 'archive' ? 'Archive selected calculations (1)' : 'Restore calculations')); }
  await act(async () => t.mock.timers.tick(125_000));
  assert.equal(stalledOptions?.signal?.aborted, true); assert.equal(writes, operation === 'read' ? 0 : 1);
  assert.match(container.textContent!, /125 seconds/);
  await act(async () => delayed.resolve({ error: 'Late server rejection.' }));
  assert.doesNotMatch(container.textContent!, /Late server rejection/);
  assert.equal(reads, operation === 'read' ? 1 : 2);
});

for (const failure of ['400', '503', 'invalid JSON', 'wrong workspace'] as const) test(`an archive ${failure} response requires a fresh usage read and keeps the selection`, async () => {
  const read = pending<Response>(); let reads = 0, writes = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      writes++;
      if (/^\d+$/.test(failure)) return Response.json({ error: 'Archive not confirmed.' }, { status: Number(failure) });
      return failure === 'invalid JSON' ? new Response('not json') : Response.json({ workspace: 'demo', archiveId });
    }
    reads++; return reads === 1 ? Response.json(usage()) : read.promise;
  };
  await render(); await click(selection()); await click(button('Archive selected calculations (1)'));
  assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(selection().checked, true);
  assert.equal(button('Archive selected calculations (1)').disabled, true);
  assert.match(container.textContent!, /update may have completed/);
  assert.doesNotMatch(container.textContent!, /were verified and moved/);
  await act(async () => read.resolve(Response.json(usage())));
  assert.equal(selection().checked, true); assert.equal(button('Archive selected calculations (1)').disabled, false); assert.equal(writes, 1);
});

test('a current usage response removes only selected runs that are no longer archivable', async () => {
  let reads = 0;
  globalThis.fetch = async () => {
    const result = usage();
    if (++reads > 1) result.runs[0] = { ...result.runs[0], status: 'running', archivable: false };
    return Response.json(result);
  };
  await render(); await click(selection()); await click(button('Refresh storage'));
  assert.equal(selection().checked, false); assert.equal(selection().disabled, true);
  assert.equal(button('Archive selected calculations').disabled, true);
});

for (const operation of ['archive', 'restore'] as const) test(`successful ${operation} and reconciliation clear every request timer`, async t => {
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, options) => { calls.push(options!); return Response.json(options?.method === 'POST' ? { workspace: 'live', archiveId } : usage()); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await render(); await click(selection()); await click(button(operation === 'archive' ? 'Archive selected calculations (1)' : 'Restore calculations'));
  assert.equal(calls.length, 3);
  await act(async () => t.mock.timers.tick(250_000));
  assert.ok(calls.every(call => call.signal?.aborted === false));
  assert.doesNotMatch(container.textContent!, /125 seconds/);
});
