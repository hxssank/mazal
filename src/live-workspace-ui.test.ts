import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) });
let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
HTMLElement.prototype.getClientRects = function () { return [{ width: 200, height: 100 }] as unknown as DOMRectList; };
const animations: { target: HTMLElement; cancelled: boolean; finished: boolean; onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: () => void }[] = [];
HTMLElement.prototype.animate = function () {
  const animation = { target: this, cancelled: false, finished: false, onfinish: null as (() => void) | null, oncancel: null as (() => void) | null, cancel() { this.cancelled = true; this.oncancel?.(); } };
  animations.push(animation);
  return animation as unknown as Animation;
};
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createElement: h, act, useRef, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: useLiveMotion } = await import('./hooks/useLiveMotion.ts');
const { default: AnimatedValue } = await import('./components/AnimatedValue.tsx');
const { default: RecordFreshness } = await import('./components/RecordFreshness.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
function Probe({ motion = true, value = 12345, extra = false, open = false }: { motion?: boolean; value?: number | null; extra?: boolean; open?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLiveMotion(ref, motion, 'expenses');
  return h('div', { ref }, h('div', { className: 'page-body' },
    h('section', { 'data-motion-enter': '', className: 'first' }, h(AnimatedValue, { value })),
    extra && h('section', { 'data-motion-enter': '', className: 'late' }, 'Loaded later'),
    h('details', { open }, h('summary', null, h(AnimatedValue, { value })), h('section', { className: 'detail', 'data-motion-enter': '' }, h(AnimatedValue, { value })))));
}
async function render(props: Parameters<typeof Probe>[0] = {}) {
  await act(async () => root.render(h(StrictMode, null, h(Probe, props))));
  await frame();
}
async function frame() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); }); }
function finish() { animations.forEach(animation => { animation.finished = true; animation.onfinish?.(); }); }
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); hidden = false; animations.length = 0; });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });

test('values stay exact, late sections enter once, and changing values does not replay panels', async () => {
  await render();
  assert.equal(container.querySelector('.animated-value')!.textContent, '$123.45');
  assert.ok(animations.some(animation => animation.target.matches('.first')));
  assert.ok(!animations.some(animation => animation.target.matches('.detail')));
  finish(); animations.length = 0;
  await render({ value: 67890, extra: true });
  assert.equal(container.querySelector('.animated-value')!.textContent, '$678.90');
  assert.ok(animations.some(animation => animation.target.matches('.late')));
  assert.equal(animations.filter(animation => animation.target.matches('.first')).length, 0);
  assert.equal(animations.filter(animation => animation.target.matches('.animated-value')).length, 2);
  assert.ok(animations.some(animation => animation.target.closest('summary')));
  finish(); animations.length = 0;
  await render({ value: 67890, extra: true, open: true });
  assert.equal(animations.filter(animation => animation.target.matches('.detail')).length, 1);
  assert.equal(animations.filter(animation => animation.target.matches('.animated-value')).length, 0);
});

test('pause, hidden windows and unmount cancel active effects and preserve values', async () => {
  await render();
  await render({ value: 67890 });
  await render({ motion: false, value: 67890 });
  assert.ok(animations.every(animation => animation.cancelled || animation.finished));
  const count = animations.length;
  await render({ motion: false, value: 100 });
  assert.equal(animations.length, count);
  assert.equal(container.querySelector('.animated-value')!.textContent, '$1');
  await render();
  hidden = true;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(container.firstElementChild!.getAttribute('data-window-hidden'), 'true');
  assert.ok(animations.every(animation => animation.cancelled || animation.finished));
  const hiddenCount = animations.length;
  await render({ value: 500 });
  assert.equal(animations.length, hiddenCount);
  hidden = false;
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await frame();
  await render({ value: 600 });
  assert.ok(animations.length > hiddenCount);
  await act(async () => root.render(null));
  assert.ok(animations.every(animation => animation.cancelled || animation.finished));
});

test('unknown and nonfinite values remain unknown while zero is a recorded amount', async () => {
  for (const value of [null, undefined, NaN, Infinity]) {
    await act(async () => root.render(h(AnimatedValue, { value })));
    assert.equal(container.textContent, 'Not recorded');
  }
  await act(async () => root.render(h(AnimatedValue, { value: 0 })));
  assert.equal(container.textContent, '$0');
});

test('record freshness identifies fixed snapshots and failed refreshes without claiming bank sync', async () => {
  let refreshes = 0;
  const props = { checked: new Date('2026-11-02T20:00:00Z'), refreshing: false, error: false, onRefresh: () => { refreshes++; } };
  await act(async () => root.render(h(RecordFreshness, { ...props, source: 'snapshot' })));
  assert.match(container.textContent!, /Saved copy/);
  assert.doesNotMatch(container.textContent!, /Auto-refresh|Checked/);
  assert.equal(container.querySelector('button'), null);
  await act(async () => root.render(h(RecordFreshness, { ...props, source: 'personal' })));
  assert.match(container.textContent!, /Balances update when you add or import records/);
  await act(async () => container.querySelector('button')!.click());
  assert.equal(refreshes, 1);
  await act(async () => root.render(h(RecordFreshness, { ...props, source: 'personal', error: true })));
  assert.match(container.textContent!, /Refresh failed. Showing last loaded records./);
  assert.equal(container.querySelector('time'), null);
  await act(async () => root.render(h(RecordFreshness, { ...props, source: 'sample', refreshing: true })));
  assert.match(container.textContent!, /Sample records/);
  assert.equal(container.querySelector('button')!.disabled, true);
});
