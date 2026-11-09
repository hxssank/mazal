import test, { after, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'Event', 'localStorage']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
let reducedMotion = false;
let hidden = false;
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const requestFrame = (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id; };
const cancelFrame = (id: number) => { frames.delete(id); };
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
const mediaListeners = new Set<() => void>();
const media = () => ({
  get matches() { return reducedMotion; },
  addEventListener(_type: string, listener: () => void) { mediaListeners.add(listener); },
  removeEventListener(_type: string, listener: () => void) { mediaListeners.delete(listener); },
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, matchMedia: media, requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame });
window.requestAnimationFrame = requestFrame;
window.cancelAnimationFrame = cancelFrame;
window.matchMedia = media as unknown as typeof window.matchMedia;
window.scrollTo = () => {};
HTMLElement.prototype.scrollIntoView = () => {};
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
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
const { createElement, act, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('./app/App.tsx');
const { default: Atmosphere } = await import('./components/Atmosphere.tsx');
const { default: useGlassAppearance } = await import('./hooks/useGlassAppearance.ts');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
const state: AppState = { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };

beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  localStorage.clear();
  reducedMotion = false;
  hidden = false;
  frames.clear();
  mediaListeners.clear();
  globalThis.fetch = async () => Response.json(state);
  window.history.replaceState(null, '', '/');
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });

for (const oldPalette of ['tide', 'dusk']) {
  test(`System styling replaces saved ${oldPalette} without restoring the retired palette picker`, async () => {
    localStorage.setItem('mazal.glass.palette', oldPalette);
    await act(async () => root.render(createElement(App)));
    assert.equal(container.querySelector('.app-shell')?.getAttribute('data-palette'), 'dark');
    assert.equal(container.querySelector('.atmosphere-aurora'), null);
    assert.equal(container.querySelector('[aria-label="Light palette"], .glass-palette'), null);
    assert.equal(container.querySelector('.atmosphere-tide, .atmosphere-dusk'), null);
    assert.equal(container.querySelector('.app-shell')?.getAttribute('data-motion'), 'on');
  });
}

test('a saved motion pause survives system setting changes', async () => {
  localStorage.setItem('mazal.glass.motion', 'off');
  await act(async () => root.render(createElement(App)));
  assert.equal(container.querySelector('.app-shell')?.getAttribute('data-motion'), 'off');
  await act(async () => { reducedMotion = true; mediaListeners.forEach(listener => listener()); });
  await act(async () => { reducedMotion = false; mediaListeners.forEach(listener => listener()); });
  assert.equal(container.querySelector('.app-shell')?.getAttribute('data-motion'), 'off');
  assert.equal(localStorage.getItem('mazal.glass.motion'), 'off');
});

test('system reduced motion controls animation on load and when its setting changes', async () => {
  reducedMotion = true;
  await act(async () => root.render(createElement(App)));
  assert.equal(container.querySelector('.app-shell')?.getAttribute('data-motion'), 'off');
  await act(async () => { reducedMotion = false; mediaListeners.forEach(listener => listener()); });
  assert.equal(container.querySelector('.app-shell')?.getAttribute('data-motion'), 'on');
  await act(async () => { reducedMotion = true; mediaListeners.forEach(listener => listener()); });
  assert.equal(container.querySelector('.app-shell')?.getAttribute('data-motion'), 'off');
});

test('the More menu exposes pause, resume, and system reduced motion', async () => {
  await act(async () => root.render(createElement(App)));
  await act(async () => container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!.click());
  const control = () => container.querySelector<HTMLButtonElement>('.motion-toggle')!;
  assert.equal(control().getAttribute('aria-label'), 'Pause animations');
  assert.equal(control().getAttribute('aria-pressed'), 'true');
  await act(async () => control().click());
  assert.equal(control().getAttribute('aria-label'), 'Resume animations');
  assert.equal(control().getAttribute('aria-pressed'), 'false');
  assert.equal(localStorage.getItem('mazal.glass.motion'), 'off');
  await act(async () => control().click());
  await setReducedMotion(true);
  assert.equal(control().disabled, true);
  assert.match(control().getAttribute('aria-label')!, /Reduce Motion is enabled in system settings/);
  assert.equal(control().getAttribute('aria-pressed'), 'false');
  assert.equal(localStorage.getItem('mazal.glass.motion'), 'on');
});

test('a sample preview identifies its balances before showing the finance pages', async () => {
  globalThis.fetch = async () => Response.json(state, { headers: { 'X-Mazal-Data-Source': 'sample' } });
  await act(async () => root.render(createElement(App)));
  const banner = container.querySelector('[aria-label="Sample data preview"]');
  assert.ok(banner);
  assert.match(banner.textContent!, /not your financial records/);
  assert.equal(container.querySelector('.page-content')?.firstElementChild, banner);
  await act(async () => root.unmount());
  root = createRoot(container);
  globalThis.fetch = async () => Response.json(state);
  await act(async () => root.render(createElement(App)));
  assert.equal(container.querySelector('[aria-label="Sample data preview"]'), null);
});

test('a records preview shows zero investments and disables actions that save records', async () => {
  globalThis.fetch = async () => Response.json(state, { headers: { 'X-Mazal-Data-Source': 'snapshot' } });
  window.history.replaceState(null, '', '/#investments');
  await act(async () => root.render(createElement(App)));
  const banner = container.querySelector('[aria-label="Read-only records preview"]');
  assert.ok(banner);
  assert.match(banner.textContent!, /copy of your saved records/);
  assert.equal(container.querySelector<HTMLButtonElement>('.toolbar-record')?.disabled, true);
  assert.match(container.textContent!, /No investment accounts/);
  assert.doesNotMatch(container.textContent!, /Index portfolio|18,200/);
  assert.equal(container.querySelector('[aria-label="Sample data preview"]'), null);
});

test('switching from samples to records replaces sample balances even at a lower revision', async () => {
  const sample = { ...state, revision: 10, accounts: [{ id: 'example', entityId: 'personal', name: 'Sample investment', type: 'investment', currency: 'CAD', balanceCents: 10000 }] };
  globalThis.fetch = async () => Response.json(sample, { headers: { 'X-Mazal-Data-Source': 'sample' } });
  window.history.replaceState(null, '', '/#investments');
  await act(async () => root.render(createElement(App)));
  assert.match(container.textContent!, /Sample investment/);
  globalThis.fetch = async () => Response.json(state, { headers: { 'X-Mazal-Data-Source': 'snapshot' } });
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.match(container.textContent!, /No investment accounts/);
  assert.doesNotMatch(container.textContent!, /Sample investment/);
  assert.equal(container.querySelector<HTMLButtonElement>('.toolbar-record')?.disabled, true);
});


function AppearanceProbe() {
  const ref = useRef<HTMLDivElement>(null);
  const appearance = useGlassAppearance(ref);
  return createElement('div', { ref, 'data-motion': String(appearance.motion), 'data-reduced': String(appearance.reducedMotion) },
    createElement('button', { onClick: appearance.toggleMotion, disabled: appearance.reducedMotion }, 'Toggle motion'),
    createElement('article', { className: 'position-card' }, 'Account'));
}

async function advance(timestamp: number) {
  await act(async () => {
    const queued = [...frames.values()];
    frames.clear();
    queued.forEach(callback => callback(timestamp));
  });
}

async function setReducedMotion(value: boolean) {
  await act(async () => { reducedMotion = value; [...mediaListeners].forEach(listener => listener()); });
}

async function setHidden(value: boolean) {
  await act(async () => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); });
}

function movePointer(target: EventTarget, pointerType = 'mouse') {
  const event = new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 150 });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
}

function canvasTrace(t: TestContext) {
  type Trace = { paints: number; images: number[][]; curves: number[][]; transform: number[] };
  const traces = new Map<HTMLCanvasElement, Trace>();
  t.mock.method(HTMLCanvasElement.prototype, 'getContext', function (this: HTMLCanvasElement) {
    const trace: Trace = traces.get(this) ?? { paints: 0, images: [], curves: [], transform: [] };
    traces.set(this, trace);
    const gradient = () => ({ addColorStop() {} });
    return {
      createLinearGradient: gradient, createRadialGradient: gradient,
      fillRect() { trace.paints++; },
      drawImage(_image: unknown, ...coordinates: number[]) { trace.images.push(coordinates); },
      bezierCurveTo(...coordinates: number[]) { trace.curves.push(coordinates); },
      setTransform(...coordinates: number[]) { trace.transform = coordinates; },
      beginPath() {}, moveTo() {}, closePath() {}, fill() {}, stroke() {},
    } as unknown as CanvasRenderingContext2D;
  });
  return () => traces.get(container.querySelector('canvas')!)!;
}

test('motion can be paused, restored after a reload, and resumed', async () => {
  await act(async () => root.render(createElement(AppearanceProbe)));
  const motion = () => container.firstElementChild?.getAttribute('data-motion');
  assert.equal(motion(), 'true');
  await act(async () => container.querySelector('button')!.click());
  assert.equal(motion(), 'false');
  assert.equal(localStorage.getItem('mazal.glass.motion'), 'off');
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(AppearanceProbe)));
  assert.equal(motion(), 'false');
  await act(async () => container.querySelector('button')!.click());
  assert.equal(motion(), 'true');
  assert.equal(localStorage.getItem('mazal.glass.motion'), 'on');
});

test('reduced motion stops effects without overwriting the saved choice', async () => {
  localStorage.setItem('mazal.glass.motion', 'on');
  reducedMotion = true;
  await act(async () => root.render(createElement(AppearanceProbe)));
  assert.equal(container.firstElementChild?.getAttribute('data-motion'), 'false');
  assert.equal(container.querySelector('button')!.disabled, true);
  await act(async () => container.querySelector('button')!.click());
  assert.equal(localStorage.getItem('mazal.glass.motion'), 'on');
  await setReducedMotion(false);
  assert.equal(container.firstElementChild?.getAttribute('data-motion'), 'true');
  await act(async () => container.querySelector('button')!.click());
  await setReducedMotion(true);
  await setReducedMotion(false);
  assert.equal(container.firstElementChild?.getAttribute('data-motion'), 'false');
  assert.equal(localStorage.getItem('mazal.glass.motion'), 'off');
});

test('motion controls still work when browser storage is unavailable', async t => {
  t.mock.method(dom.window.Storage.prototype, 'getItem', () => { throw new Error('Storage is blocked'); });
  t.mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new Error('Storage is blocked'); });
  await act(async () => root.render(createElement(AppearanceProbe)));
  await act(async () => container.querySelector('button')!.click());
  assert.equal(container.firstElementChild?.getAttribute('data-motion'), 'false');
  await act(async () => container.querySelector('button')!.click());
  assert.equal(container.firstElementChild?.getAttribute('data-motion'), 'true');
});

test('motion preferences follow changes from another window', async () => {
  await act(async () => root.render(createElement(AppearanceProbe)));
  await act(async () => window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'mazal.glass.motion', newValue: 'off' })));
  assert.equal(container.firstElementChild?.getAttribute('data-motion'), 'false');
  await act(async () => window.dispatchEvent(new dom.window.StorageEvent('storage', { key: null, newValue: null })));
  assert.equal(container.firstElementChild?.getAttribute('data-motion'), 'true');
});

test('pointer lighting stops on pause, hidden documents, and unmount', async () => {
  await act(async () => root.render(createElement(AppearanceProbe)));
  const panel = container.querySelector<HTMLElement>('.position-card')!;
  movePointer(panel, 'touch');
  assert.equal(frames.size, 0);
  movePointer(panel);
  assert.equal(frames.size, 1);
  await advance(0);
  assert.equal(panel.hasAttribute('data-glass-lit'), true);
  assert.equal(panel.style.getPropertyValue('--glass-x'), '300px');
  movePointer(panel);
  await act(async () => container.querySelector('button')!.click());
  assert.equal(frames.size, 0);
  assert.equal(panel.hasAttribute('data-glass-lit'), false);
  assert.equal(panel.style.getPropertyValue('--glass-x'), '');
  movePointer(panel);
  assert.equal(frames.size, 0);
  await act(async () => container.querySelector('button')!.click());
  movePointer(panel);
  await setHidden(true);
  assert.equal(frames.size, 0);
  movePointer(panel);
  assert.equal(frames.size, 0);
  await setHidden(false);
  movePointer(panel);
  assert.equal(frames.size, 1);
  await act(async () => root.render(null));
  assert.equal(frames.size, 0);
  assert.equal(mediaListeners.size, 0);
  movePointer(panel);
  assert.equal(frames.size, 0);
});

test('the canvas animates satin bands at no more than 30 frames per second', async t => {
  const trace = canvasTrace(t);
  await act(async () => root.render(createElement(Atmosphere, { motion: true })));
  assert.equal(frames.size, 1);
  await advance(0);
  const initialCurve = [...trace().curves[0]];
  const initialCurves = trace().curves.length;
  const initialImages = trace().images.length;
  assert.ok(initialCurves > 0);
  assert.equal(trace().paints, 1);
  await advance(16);
  assert.equal(trace().paints, 1);
  await advance(34);
  assert.equal(trace().paints, 2);
  assert.equal(trace().images.length, initialImages * 2);
  assert.notDeepEqual(trace().curves[initialCurves], initialCurve);
  assert.equal(trace().curves.length, initialCurves * 2);
  assert.equal(frames.size, 1);
  assert.equal(container.firstElementChild?.getAttribute('aria-hidden'), 'true');
  assert.equal(container.querySelector('.atmosphere-grain'), null);
});

test('wallpaper bands reshape independently within eight seconds', async t => {
  const trace = canvasTrace(t);
  await act(async () => root.render(createElement(Atmosphere, { motion: true })));
  await advance(0);
  const initialCurves = [...trace().curves];
  const initialLights = [...trace().images];
  for (let timestamp = 50; timestamp <= 8000; timestamp += 50) await advance(timestamp);
  const curves = trace().curves.slice(-initialCurves.length);
  const offsets = curves.map((curve, index) => curve.map((value, axis) => value - initialCurves[index][axis]));
  offsets.forEach((offset, index) => assert.ok(Math.hypot(...offset) > 10, `Band curve ${index} must visibly move in eight seconds`));
  assert.notDeepEqual(offsets[0], offsets[3]);
  const lights = trace().images.slice(-initialLights.length);
  lights.forEach((light, index) => assert.ok(Math.hypot(light[0] - initialLights[index][0], light[1] - initialLights[index][1]) > 5));
});

test('the canvas paints one still frame when paused and restarts when resumed', async t => {
  const trace = canvasTrace(t);
  await act(async () => root.render(createElement(Atmosphere, { motion: false })));
  await advance(0);
  assert.equal(trace().paints, 1);
  const curveCount = trace().curves.length;
  const imageCount = trace().images.length;
  assert.equal(frames.size, 0);
  movePointer(window);
  assert.equal(frames.size, 0);
  await act(async () => root.render(createElement(Atmosphere, { motion: true })));
  await advance(34);
  assert.equal(frames.size, 1);
  await advance(68);
  const pausedCurves = trace().curves.slice(-curveCount);
  const pausedImages = trace().images.slice(-imageCount);
  await act(async () => root.render(createElement(Atmosphere, { motion: false })));
  await advance(102);
  assert.equal(frames.size, 0);
  assert.deepEqual(trace().curves.slice(-curveCount), pausedCurves);
  assert.deepEqual(trace().images.slice(-imageCount), pausedImages);
});

test('paused wallpaper starts with the same geometry after remounting', async t => {
  const trace = canvasTrace(t);
  await act(async () => root.render(createElement(Atmosphere, { motion: false })));
  await advance(0);
  const curves = trace().curves;
  const images = trace().images;
  assert.ok(curves.length > 0);
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(Atmosphere, { motion: false })));
  await advance(34);
  assert.deepEqual(trace().curves, curves);
  assert.deepEqual(trace().images, images);
  assert.equal(frames.size, 0);
});

test('the canvas honors reduced motion on load and cancels an active animation when it changes', async t => {
  const trace = canvasTrace(t);
  reducedMotion = true;
  await act(async () => root.render(createElement(Atmosphere, { motion: true })));
  await advance(0);
  assert.equal(trace().paints, 1);
  assert.equal(frames.size, 0);
  await setReducedMotion(false);
  await advance(34);
  assert.equal(frames.size, 1);
  await setReducedMotion(true);
  await advance(68);
  assert.equal(frames.size, 0);
  movePointer(window);
  assert.equal(frames.size, 0);
});

test('hidden documents and unmounted canvases do not keep animation callbacks or listeners', async t => {
  const trace = canvasTrace(t);
  await act(async () => root.render(createElement(Atmosphere, { motion: true })));
  await advance(0);
  await setHidden(true);
  assert.equal(frames.size, 0);
  movePointer(window);
  window.dispatchEvent(new Event('resize'));
  assert.equal(frames.size, 0);
  await advance(5000);
  assert.equal(trace().paints, 1);
  await setHidden(false);
  await advance(5034);
  assert.equal(trace().paints, 2);
  assert.equal(frames.size, 1);
  await act(async () => root.render(null));
  assert.equal(frames.size, 0);
  assert.equal(mediaListeners.size, 0);
  window.dispatchEvent(new Event('resize'));
  document.dispatchEvent(new Event('visibilitychange'));
  movePointer(window);
  assert.equal(frames.size, 0);
});

test('canvas rendering limits pixel density and total drawing area', async t => {
  canvasTrace(t);
  const original = ['innerWidth', 'innerHeight', 'devicePixelRatio'].map(key => [key, Object.getOwnPropertyDescriptor(window, key)!] as const);
  t.after(() => original.forEach(([key, descriptor]) => Object.defineProperty(window, key, descriptor)));
  Object.defineProperties(window, { innerWidth: { configurable: true, value: 1200 }, innerHeight: { configurable: true, value: 800 }, devicePixelRatio: { configurable: true, value: 3 } });
  await act(async () => root.render(createElement(Atmosphere, { motion: false })));
  const canvas = container.querySelector('canvas')!;
  assert.equal(canvas.width, 1800);
  assert.equal(canvas.height, 1200);
  Object.defineProperties(window, { innerWidth: { configurable: true, value: 5120 }, innerHeight: { configurable: true, value: 2880 } });
  window.dispatchEvent(new Event('resize'));
  assert.ok(canvas.width * canvas.height <= 3_000_000);
  assert.equal(frames.size, 1);
  await advance(0);
  assert.equal(frames.size, 0);
});
