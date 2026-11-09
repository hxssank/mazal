import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { Account, AppState } from '../shared/types.ts';
import type { DocumentMetadata } from '../server/documents.ts';

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
const { default: RecoveryAccountLinks } = await import('./features/records/RecoveryAccountLinks.tsx');
const { default: Forms } = await import('./features/entries/Forms.tsx');
type Props = Parameters<typeof RecoveryAccountLinks>[0];
const container = document.getElementById('root')!;
let root = createRoot(container);
const nativeFetch = globalThis.fetch;
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); globalThis.fetch = nativeFetch; });

const accounts: Account[] = ['cash', 'other'].map(id => ({ id, name: id === 'cash' ? 'Cash' : 'Other account', entityId: 'personal', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }));
function original(): DocumentMetadata {
  return { id: 'b'.repeat(64), sha256: 'b'.repeat(64), originalName: 'synthetic-statement.pdf', mimeType: 'application/pdf', bytes: 42, kind: 'statement', accountId: null, documentDate: '2026-10-16', periodStart: null, periodEnd: null, notes: 'Preserve original metadata', amountCents: 12345, currency: 'CAD', expenseUse: 'personal', merchant: '', createdAt: '2026-10-16T00:00:00.000Z', reviewStatus: 'reviewed', revision: 7 };
}
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(element => element.textContent?.trim() === text);
  assert.ok(result, `Missing button ${text}`); return result;
}
function select(label: string): HTMLSelectElement {
  const result = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`);
  assert.ok(result, `Missing select ${label}`); return result;
}
async function choose(label: string, value: string) {
  const target = select(label);
  await act(async () => { target.value = value; target.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function mount(overrides: Partial<Props> = {}) {
  const state = { documents: [original()], busy: [] as boolean[], dirty: [] as boolean[], saved: 0, calls: [] as { url: string; options: RequestInit | undefined }[] };
  const props: Props = { workspace: 'live', accounts, disabled: false, onBusyChange: value => state.busy.push(value), onDirtyChange: value => state.dirty.push(value), onSaved: () => { state.saved++; }, ...overrides };
  globalThis.fetch = async (url, options) => {
    state.calls.push({ url: String(url), options });
    if (options?.method === 'PATCH') {
      const patch = JSON.parse(String(options.body));
      if (patch.expectedRevision !== state.documents[0].revision) return Response.json({ error: 'This document changed in another window.' }, { status: 409 });
      state.documents[0] = { ...state.documents[0], accountId: patch.accountId, revision: state.documents[0].revision + 1 };
      return Response.json({ document: state.documents[0] });
    }
    return Response.json({ documents: state.documents });
  };
  await act(async () => root.render(createElement(RecoveryAccountLinks, props)));
  return { state, props };
}
async function prepare() {
  await act(async () => button('Review saved account links').click());
  await choose('Saved document', original().id);
  await choose('Saved account link', 'cash');
}
function patches(calls: { options: RequestInit | undefined }[]) { return calls.filter(call => call.options?.method === 'PATCH'); }

for (const operation of ['load', 'save'] as const) for (const phase of ['fetch', 'body'] as const) test(`${operation} ${phase} timeout retains selection, releases busy and ignores a late response`, async t => {
  const { state } = await mount(); await prepare();
  const originalFetch = globalThis.fetch;
  let pending: RequestInit | undefined, completeLate!: () => void, attempts = 0;
  globalThis.fetch = async (url, options) => {
    if ((options?.method === 'PATCH') !== (operation === 'save')) return originalFetch(url, options);
    pending = options; attempts++;
    const value = operation === 'save' ? { document: { ...original(), accountId: 'cash', revision: 8 } } : { documents: [{ ...original(), accountId: 'other', revision: 99 }] };
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(Response.json(value)); });
    return { ok: true, json: () => new Promise(resolve => { completeLate = () => resolve(value); }) } as Response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const duration = operation === 'load' ? 15_000 : 60_000;
  await act(async () => button(operation === 'load' ? 'Reload saved links' : 'Save account link').click());
  assert.equal(state.busy.at(-1), true);
  await act(async () => t.mock.timers.tick(duration - 1));
  assert.equal(pending?.signal?.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(pending?.signal?.aborted, true); assert.equal(state.busy.at(-1), false);
  assert.match(container.textContent!, /timed out/); assert.equal(state.dirty.at(-1), true);
  assert.equal(select('Saved document').value, original().id); assert.equal(select('Saved account link').value, 'cash');
  assert.equal(button('Reload saved links').disabled, false);
  assert.equal(button('Save account link').disabled, operation === 'save');
  await act(async () => completeLate());
  assert.equal(attempts, 1); assert.equal(state.saved, 0);
  assert.match(container.textContent!, /timed out/); assert.match(container.textContent!, /Saved account link: Unlinked/);
  globalThis.fetch = originalFetch;
  await act(async () => button('Reload saved links').click());
  assert.equal(button('Save account link').disabled, false);
  assert.equal(select('Saved document').value, original().id); assert.equal(select('Saved account link').value, 'cash');
  assert.equal(patches(state.calls).length, 0);
  await act(async () => button('Save account link').click());
  assert.equal(patches(state.calls).length, 1); assert.equal(state.saved, 1);
  assert.deepEqual(JSON.parse(String(patches(state.calls)[0].options!.body)), { expectedRevision: 7, accountId: 'cash' });
  assert.deepEqual(state.documents[0], { ...original(), accountId: 'cash', revision: 8 });
  const savedSignal = patches(state.calls)[0].options!.signal;
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(savedSignal?.aborted, false);
});

for (const failure of ['fetch timeout', 'body timeout', 'transport error', 'HTTP error'] as const) test(`a link saved before ${failure} is confirmed by explicit reload without another PATCH`, async t => {
  const { state } = await mount(); await prepare();
  const originalFetch = globalThis.fetch;
  let completeLate: (() => void) | undefined;
  globalThis.fetch = async (url, options) => {
    if (options?.method !== 'PATCH') return originalFetch(url, options);
    const response = await originalFetch(url, options);
    if (failure === 'fetch timeout') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    if (failure === 'transport error') throw new TypeError('Response lost.');
    if (failure === 'HTTP error') return Response.json({ error: 'Confirmation unavailable.' }, { status: 503 });
    const value = await response.json();
    return { ok: true, json: () => new Promise(resolve => { completeLate = () => resolve(value); }) } as Response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Save account link').click());
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(patches(state.calls).length, 1); assert.equal(state.documents[0].accountId, 'cash');
  assert.equal(button('Save account link').disabled, true);
  assert.equal(select('Saved account link').disabled, true);
  assert.equal(button('Discard link change').disabled, true);
  assert.equal(state.dirty.at(-1), true); assert.equal(state.saved, 0);
  await act(async () => button('Reload saved links').click());
  assert.match(container.textContent!, /saved account link matches your choice/);
  assert.match(container.textContent!, /Saved account link: Cash/);
  assert.equal(select('Saved document').value, original().id); assert.equal(select('Saved account link').value, 'cash');
  assert.equal(button('Save account link').disabled, true);
  assert.equal(select('Saved account link').disabled, false);
  assert.equal(state.dirty.at(-1), false); assert.equal(state.saved, 1);
  if (completeLate) await act(async () => completeLate!());
  assert.equal(patches(state.calls).length, 1); assert.equal(state.saved, 1);
  assert.deepEqual(state.documents[0], { ...original(), accountId: 'cash', revision: 8 });
});

test('stale metadata needs explicit reload and review before a new revision is saved', async () => {
  const { state } = await mount(); await prepare();
  state.documents[0] = { ...original(), accountId: 'other', notes: 'Newer saved notes', revision: 10 };
  await act(async () => button('Save account link').click());
  assert.match(container.textContent!, /changed in another window/);
  assert.equal(button('Save account link').disabled, true); assert.equal(patches(state.calls).length, 1);
  await act(async () => button('Reload saved links').click());
  assert.match(container.textContent!, /Saved account link: Other account/);
  assert.equal(select('Saved account link').value, 'cash'); assert.equal(button('Save account link').disabled, false);
  assert.equal(patches(state.calls).length, 1);
  await act(async () => button('Save account link').click());
  assert.equal(patches(state.calls).length, 2);
  assert.deepEqual(JSON.parse(String(patches(state.calls)[1].options!.body)), { expectedRevision: 10, accountId: 'cash' });
  assert.equal(state.documents[0].notes, 'Newer saved notes'); assert.equal(state.documents[0].revision, 11);
});

for (const failure of ['timeout', 'HTTP error', 'invalid list'] as const) test(`reload ${failure} after an uncertain save keeps the draft and cannot unlock another PATCH`, async t => {
  const { state } = await mount(); await prepare();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => options?.method === 'PATCH' ? Promise.reject(new TypeError('Connection lost.')) : originalFetch(url, options);
  await act(async () => button('Save account link').click());
  globalThis.fetch = async () => failure === 'timeout' ? { ok: true, json: () => new Promise(() => {}) } as Response : failure === 'HTTP error' ? Response.json({ error: 'Read unavailable.' }, { status: 503 }) : Response.json({ documents: [{}] });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Reload saved links').click());
  await act(async () => t.mock.timers.tick(15_000));
  assert.equal(state.busy.at(-1), false); assert.equal(state.dirty.at(-1), true);
  assert.equal(select('Saved document').value, original().id); assert.equal(select('Saved account link').value, 'cash');
  assert.equal(button('Save account link').disabled, true);
  assert.equal(button('Reload saved links').disabled, false);
  globalThis.fetch = originalFetch;
  await act(async () => button('Reload saved links').click());
  assert.equal(button('Save account link').disabled, false); assert.equal(patches(state.calls).length, 0);
});

for (const operation of ['load', 'save'] as const) for (const phase of ['fetch', 'body'] as const) test(`canceling ${operation} ${phase} cannot publish a result or callbacks into another workspace`, async t => {
  const { state, props } = await mount(); await prepare();
  const originalFetch = globalThis.fetch;
  let pending: RequestInit | undefined, completeLate!: () => void, attempts = 0;
  globalThis.fetch = async (url, options) => {
    if ((options?.method === 'PATCH') !== (operation === 'save')) return originalFetch(url, options);
    attempts++; pending = options;
    const value = operation === 'save' ? { document: { ...original(), accountId: 'cash', revision: 8 } } : { documents: [{ ...original(), originalName: 'Late document.pdf' }] };
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(Response.json(value)); });
    return { ok: true, json: () => new Promise(resolve => { completeLate = () => resolve(value); }) } as Response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button(operation === 'load' ? 'Reload saved links' : 'Save account link').click());
  if (phase === 'fetch') await act(async () => root.render(null));
  else await act(async () => root.render(createElement(RecoveryAccountLinks, { ...props, workspace: 'demo' })));
  assert.equal(pending?.signal?.aborted, true);
  const callbackCounts = [state.busy.length, state.dirty.length, state.saved];
  await act(async () => completeLate());
  await act(async () => t.mock.timers.tick(60_000));
  assert.deepEqual([state.busy.length, state.dirty.length, state.saved], callbackCounts);
  assert.doesNotMatch(container.textContent!, /Late document|synthetic-statement|timed out|Account link saved/);
  assert.equal(attempts, 1);
  if (phase === 'fetch') assert.equal(container.textContent, '');
  else { assert.equal(state.busy.at(-1), false); assert.equal(state.dirty.at(-1), false); assert.equal(button('Review saved account links').disabled, false); }
});

for (const operation of ['load', 'save'] as const) test(`${operation} guards duplicate clicks before its disabled state renders`, async t => {
  await mount(); if (operation === 'save') await prepare();
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return new Promise<Response>(() => {}); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const trigger = button(operation === 'load' ? 'Review saved account links' : 'Save account link');
  await act(async () => { trigger.click(); trigger.click(); });
  assert.equal(attempts, 1);
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(attempts, 1);
});

test('a missing selected document keeps its desired account and never selects another file', async () => {
  const { state } = await mount(); await prepare();
  state.documents = [{ ...original(), id: 'c'.repeat(64), sha256: 'c'.repeat(64), originalName: 'Different original.pdf' }];
  await act(async () => button('Reload saved links').click());
  assert.match(container.textContent!, /selected document is no longer/);
  assert.equal(select('Saved document').value, original().id);
  assert.match(select('Saved document').selectedOptions[0].textContent!, /synthetic-statement.pdf.*no longer saved/);
  assert.equal(select('Saved account link').value, 'cash'); assert.equal(select('Saved account link').disabled, true);
  assert.equal(button('Save account link').disabled, true); assert.equal(state.dirty.at(-1), true);
  assert.equal(patches(state.calls).length, 0);
  await act(async () => button('Discard link change').click());
  assert.equal(select('Saved document').value, ''); assert.equal(state.dirty.at(-1), false);
  await choose('Saved document', state.documents[0].id);
  assert.equal(select('Saved document').value, state.documents[0].id); assert.equal(patches(state.calls).length, 0);
});

test('an ordinary reload retains the selected document and desired account while updating saved details', async () => {
  const { state } = await mount(); await prepare();
  state.documents[0] = { ...original(), accountId: 'other', originalName: 'Updated saved name.pdf', revision: 9 };
  await act(async () => button('Reload saved links').click());
  assert.equal(select('Saved document').value, original().id); assert.equal(select('Saved account link').value, 'cash');
  assert.match(container.textContent!, /Updated saved name.pdf/); assert.match(container.textContent!, /Saved account link: Other account/);
  assert.equal(button('Save account link').disabled, false); assert.equal(state.dirty.at(-1), true);
  assert.equal(patches(state.calls).length, 0);
  await act(async () => button('Discard link change').click());
  assert.equal(select('Saved account link').value, 'other'); assert.equal(state.dirty.at(-1), false);
});

for (const malformed of ['different document', 'different account', 'old revision', 'missing document'] as const) test(`a save confirmation with ${malformed} requires a fresh read`, async () => {
  const { state } = await mount(); await prepare();
  const originalFetch = globalThis.fetch;
  const value = { ...original(), accountId: 'cash', revision: 8, ...(malformed === 'different document' ? { id: 'c'.repeat(64) } : malformed === 'different account' ? { accountId: 'other' } : malformed === 'old revision' ? { revision: 7 } : {}) };
  let attempts = 0;
  globalThis.fetch = async (url, options) => options?.method === 'PATCH' ? (attempts++, Response.json(malformed === 'missing document' ? {} : { document: value })) : originalFetch(url, options);
  await act(async () => button('Save account link').click());
  assert.match(container.textContent!, /invalid save confirmation/);
  assert.equal(button('Save account link').disabled, true); assert.equal(select('Saved account link').value, 'cash');
  assert.equal(attempts, 1); assert.equal(state.saved, 0);
  await act(async () => button('Reload saved links').click());
  assert.equal(button('Save account link').disabled, false); assert.equal(attempts, 1);
});

test('unlinked account changes retain null and the exact opened metadata revision', async () => {
  const { state } = await mount(); state.documents[0].accountId = 'cash';
  await act(async () => button('Review saved account links').click());
  await choose('Saved document', original().id); await choose('Saved account link', 'unlinked');
  await act(async () => button('Save account link').click());
  assert.deepEqual(JSON.parse(String(patches(state.calls)[0].options!.body)), { expectedRevision: 7, accountId: null });
  assert.deepEqual(state.documents[0], { ...original(), revision: 8 });
  assert.equal(button('Save account link').disabled, true); assert.equal(state.saved, 1);
});

for (const operation of ['load', 'save'] as const) for (const bodyFocus of [false, true]) test(`${operation} timeout focuses its error when links still own ${bodyFocus ? 'body' : 'control'} focus`, async t => {
  await mount(); await prepare();
  globalThis.fetch = async () => new Promise<Response>(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const trigger = button(operation === 'load' ? 'Reload saved links' : 'Save account link'); trigger.focus();
  await act(async () => trigger.click());
  if (bodyFocus) { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); assert.ok(document.activeElement === document.body); }
  await act(async () => t.mock.timers.tick(operation === 'load' ? 15_000 : 60_000));
  const error = container.querySelector<HTMLElement>('.recovery-account-links [role="alert"]')!;
  assert.match(error.textContent!, /timed out/); assert.ok(document.activeElement === error);
});

for (const focus of ['other editor', 'other editor then blur', 'outside pointer', 'hidden', 'inert', 'CSS hidden'] as const) test(`a link timeout leaves focus alone for ${focus}`, async t => {
  await mount(); await prepare();
  globalThis.fetch = async () => new Promise<Response>(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const trigger = button('Save account link'); trigger.focus();
  await act(async () => trigger.click());
  document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex');
  const region = container.querySelector<HTMLElement>('.recovery-account-links')!;
  const other = document.createElement('input'); document.body.append(other); t.after(() => other.remove());
  if (focus.startsWith('other editor')) other.focus();
  if (focus === 'other editor then blur') other.blur();
  if (focus === 'outside pointer') other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  if (focus === 'hidden') region.hidden = true;
  if (focus === 'inert') region.setAttribute('inert', '');
  if (focus === 'CSS hidden') region.style.display = 'none';
  const active = document.activeElement;
  await act(async () => t.mock.timers.tick(60_000));
  assert.match(container.textContent!, /timed out/); assert.ok(document.activeElement === active);
});

test('a saved-link timeout releases Forms Done and retains the choice through Keep editing', async t => {
  const { state } = await mount();
  const appState: AppState = { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts, transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
  const originalFetch = globalThis.fetch; let patchesSent = 0;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'PATCH') { patchesSent++; return new Promise<Response>(() => {}); }
    return originalFetch(url, options);
  };
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state: appState, onCommand: async () => {}, onClose: () => {} })));
  await prepare();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Save account link').click());
  assert.equal(button('Done').disabled, true);
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(button('Done').disabled, false); assert.equal(button('Save account link').disabled, true);
  await act(async () => button('Done').click());
  assert.match(container.textContent!, /Discard unsaved changes/);
  await act(async () => button('Keep editing').click());
  assert.equal(select('Saved document').value, original().id); assert.equal(select('Saved account link').value, 'cash');
  assert.equal(button('Reload saved links').disabled, false); assert.equal(patchesSent, 1);
  await act(async () => button('Reload saved links').click());
  assert.equal(button('Save account link').disabled, false); assert.equal(patchesSent, 1); assert.equal(patches(state.calls).length, 0);
});
