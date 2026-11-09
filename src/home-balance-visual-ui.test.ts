import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: HomeBalanceVisual } = await import('./features/home/HomeBalanceVisual.tsx');
const { gsap } = await import('gsap');
const container = document.getElementById('root')!;
let root = createRoot(container);
let opened = 0;
beforeEach(async () => {
  await act(async () => root.unmount()); root = createRoot(container); opened = 0;
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});
after(async () => { await act(async () => root.unmount()); gsap.ticker.sleep(); hooks.deregister(); dom.window.close(); });
async function render(assetsCents: number | null | undefined, liabilitiesCents: number | null | undefined, motion = false) {
  await act(async () => root.render(createElement(HomeBalanceVisual, { assetsCents, liabilitiesCents, motion, onDetails: () => { opened++; } })));
}
async function frame() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 70)); }); }

test('asset and debt controls expose exact values on focus and open the existing breakdown', async () => {
  await render(30000, 10000);
  assert.equal(container.querySelector<HTMLElement>('.home-balance-segment.assets')!.style.width, '75%');
  assert.equal(container.querySelector<HTMLElement>('.home-balance-segment.owed')!.style.width, '25%');
  assert.equal(container.querySelector('[role="tooltip"]'), null);
  const assets = container.querySelector<HTMLButtonElement>('[data-segment="assets"]')!;
  const owed = container.querySelector<HTMLButtonElement>('[data-segment="owed"]')!;
  assert.equal(assets.getAttribute('aria-label'), 'Assets $300');
  assert.equal(owed.getAttribute('aria-label'), 'Owed $100');
  await act(async () => assets.focus());
  assert.match(container.querySelector('[role="tooltip"]')!.textContent!, /Assets\$300/);
  await act(async () => assets.click());
  await act(async () => owed.focus());
  assert.match(container.querySelector('[role="tooltip"]')!.textContent!, /Owed\$100/);
  await act(async () => owed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(container.querySelector('[role="tooltip"]'), null);
  await act(async () => owed.click());
  assert.equal(opened, 2);
  await act(async () => owed.blur());
  assert.equal(container.querySelector('[role="tooltip"]'), null);
  await render(30012, 10000);
  assert.equal(assets.getAttribute('aria-label'), 'Assets $300.12');
});

test('zero, unknown and negative balances do not create a misleading share or invalid width', async () => {
  for (const [assets, owed] of [[0, 0], [null, 10000], [20000, undefined], [NaN, 0], [Infinity, 100], [-5000, 20000], [5000, -1000]] as const) {
    await render(assets, owed, true);
    assert.deepEqual([...container.querySelectorAll<HTMLElement>('.home-balance-segment')].map(segment => segment.style.width), ['0%', '0%']);
    assert.equal(container.querySelector('.home-balance-sweep'), null);
    assert.equal(container.querySelector('.home-balance-visual')!.getAttribute('data-motion'), 'off');
    assert.doesNotMatch(container.textContent!, /NaN|Infinity/);
  }
  await render(-5000, 20000);
  assert.equal(container.querySelector('[data-segment="assets"]')!.getAttribute('aria-label'), 'Assets -$50');
  await render(0, 20000);
  assert.equal(container.querySelector<HTMLElement>('.home-balance-segment.assets')!.style.width, '0%');
  assert.equal(container.querySelector<HTMLElement>('.home-balance-segment.owed')!.style.width, '100%');
});

test('GSAP moves the rail sweep, pauses in a hidden document and resets when motion is disabled', async () => {
  await render(30000, 10000, true);
  const sweep = container.querySelector<HTMLElement>('.home-balance-sweep')!;
  const initial = sweep.style.transform;
  await frame();
  assert.notEqual(sweep.style.transform, initial);
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  const paused = sweep.style.transform;
  await frame();
  assert.equal(sweep.style.transform, paused);
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await frame();
  assert.notEqual(sweep.style.transform, paused);
  await render(30000, 10000, false);
  assert.equal(container.querySelector('.home-balance-visual')!.getAttribute('data-motion'), 'off');
  assert.equal(sweep.style.transform, '');
  for (const fill of container.querySelectorAll<HTMLElement>('.home-balance-fill')) assert.equal(fill.style.transform, '');
  assert.equal(container.querySelector('[data-segment="assets"]')!.getAttribute('aria-label'), 'Assets $300');
});
