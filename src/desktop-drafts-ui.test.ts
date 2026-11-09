import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { beginDraftOperation, requestDraftNavigation, useDraftProtection } = await import('./hooks/draft-protection.ts');
const query = JSON.parse(readFileSync(new URL('../macos/Mazal.swift', import.meta.url), 'utf8').match(/static let query = ("[^\n]+")/)![1]) as string;
const status = () => JSON.parse(JSON.stringify(dom.window.eval(query)));
let root = createRoot(document.getElementById('root')!);
let discardRequests = 0;
let continuation: ReturnType<typeof useDraftProtection>;
function Draft({ dirty, busy = false }: { dirty: boolean; busy?: boolean }) {
  continuation = useDraftProtection({ dirty, busy, onRequestDiscard: () => { discardRequests++; } });
  return null;
}
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(document.getElementById('root')!); discardRequests = 0; });
after(async () => { await act(async () => root.unmount()); dom.window.close(); });

test('native query reads current dirty and busy state without discarding or navigating', async () => {
  await act(async () => root.render(createElement(Draft, { dirty: false })));
  assert.deepEqual(status(), { ready: true, dirty: false, busy: false });
  await act(async () => root.render(createElement(Draft, { dirty: true })));
  assert.deepEqual(status(), { ready: true, dirty: true, busy: false });
  assert.equal(discardRequests, 0);
  await act(async () => root.render(createElement(Draft, { dirty: true, busy: true })));
  assert.deepEqual(status(), { ready: true, dirty: true, busy: true });
  let navigated = false;
  requestDraftNavigation(() => { navigated = true; });
  assert.equal(navigated, false);
  assert.equal(discardRequests, 0);
});

test('native checks preserve an existing discard continuation and remove unmounted guards', async () => {
  await act(async () => root.render(createElement(Draft, { dirty: true })));
  let navigated = false;
  requestDraftNavigation(() => { navigated = true; });
  assert.equal(discardRequests, 1);
  assert.equal(status().dirty, true);
  continuation.keepEditing();
  assert.equal(navigated, false);
  assert.equal(status().dirty, true);
  await act(async () => root.render(null));
  assert.deepEqual(status(), { ready: true, dirty: false, busy: false });
});

test('native query includes legacy beforeunload guards and reports a missing app guard', () => {
  const legacy = (event: Event) => event.preventDefault();
  window.addEventListener('beforeunload', legacy);
  try { assert.equal(status().dirty, true); }
  finally { window.removeEventListener('beforeunload', legacy); }
  const unloaded = new JSDOM('', { runScripts: 'outside-only' });
  try { assert.deepEqual(JSON.parse(JSON.stringify(unloaded.window.eval(query))), { ready: false, dirty: false, busy: false }); }
  finally { unloaded.window.close(); }
});

test('operation tokens block native queries, unload and navigation before any React commit', async () => {
  await act(async () => root.render(createElement(Draft, { dirty: false })));
  const first = beginDraftOperation();
  const second = beginDraftOperation();
  try {
    assert.equal(status().busy, true);
    const unload = new Event('beforeunload', { cancelable: true });
    assert.equal(window.dispatchEvent(unload), false);
    let navigated = false;
    assert.equal(requestDraftNavigation(() => { navigated = true; }), false);
    assert.equal(continuation.requestChange(() => { navigated = true; }), false);
    assert.equal(navigated, false);
    assert.equal(discardRequests, 0);
    first(); first();
    assert.equal(status().busy, true, 'releasing one token twice cannot release the other save');
    await assert.rejects((async () => { try { throw new Error('Recovery rejected'); } finally { second(); } })(), /Recovery rejected/);
    assert.equal(status().busy, false);
    assert.equal(window.dispatchEvent(new Event('beforeunload', { cancelable: true })), true);
    assert.equal(requestDraftNavigation(() => { navigated = true; }), true);
    assert.equal(navigated, true);
  } finally { first(); second(); }
});

test('a command started after a discard prompt blocks its saved navigation continuation', async () => {
  await act(async () => root.render(createElement(Draft, { dirty: true })));
  let navigated = false;
  requestDraftNavigation(() => { navigated = true; });
  assert.equal(discardRequests, 1);
  const finish = beginDraftOperation();
  try { continuation.discard(); assert.equal(navigated, false); }
  finally { finish(); }
  requestDraftNavigation(() => { navigated = true; });
  continuation.discard();
  assert.equal(navigated, true);
  navigated = false;
  continuation.requestChange(() => { navigated = true; });
  const finishClose = beginDraftOperation();
  try { continuation.discard(); assert.equal(navigated, false, 'an editor close continuation is also blocked'); }
  finally { finishClose(); }
});
