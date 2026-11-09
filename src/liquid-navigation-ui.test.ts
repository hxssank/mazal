import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const requestFrame = (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id; };
const cancelFrame = (id: number) => { frames.delete(id); };
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame });
window.requestAnimationFrame = requestFrame;
window.cancelAnimationFrame = cancelFrame;

class ObservedResize {
  static instances: ObservedResize[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; ObservedResize.instances.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.disconnected = true; this.targets.clear(); }
  trigger() { this.callback([], this as unknown as ResizeObserver); }
}

type Box = { left: number; top: number; width: number; height: number };
let layout: Record<string, Box>;
let scrollLeft = 0;
let scrollTop = 0;
const border = { left: 2, top: 1 };
const originalBounds = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function () {
  const box = layout[this.dataset.box ?? ''];
  if (!box) return originalBounds.call(this);
  const left = box.left - (this.tagName === 'BUTTON' ? scrollLeft : 0);
  const top = box.top - (this.tagName === 'BUTTON' ? scrollTop : 0);
  return { ...box, left, top, right: left + box.width, bottom: top + box.height, x: left, y: top, toJSON() { return {}; } };
};
for (const [property, get] of Object.entries({ scrollLeft: () => scrollLeft, scrollTop: () => scrollTop, clientLeft: () => border.left, clientTop: () => border.top })) {
  Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get });
}

const { createElement, act, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: useLiquidNavigation } = await import('./hooks/useLiquidNavigation.ts');
const container = document.getElementById('root')!;
let root = createRoot(container);

function Navigation({ active = 'home', motion = true, items = ['home', 'spending', 'planner'] }: { active?: string; motion?: boolean; items?: string[] }) {
  const ref = useRef<HTMLElement>(null);
  useLiquidNavigation(ref, active, motion);
  return createElement('nav', { ref, 'data-box': 'nav' },
    createElement('span', { className: 'nav-glass-indicator', 'aria-hidden': true }),
    ...items.map(item => createElement('button', { key: item, 'data-box': item, 'aria-current': active === item ? 'page' : undefined }, item)));
}

async function render(props: Parameters<typeof Navigation>[0] = {}) {
  await act(async () => root.render(createElement(Navigation, props)));
  return container.querySelector('nav')!;
}
async function advance() {
  await act(async () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
  });
}
function indicator(nav: HTMLElement) {
  return ['--nav-x', '--nav-y', '--nav-width', '--nav-height'].map(property => nav.style.getPropertyValue(property));
}

beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  frames.clear();
  ObservedResize.instances = [];
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ObservedResize });
  scrollLeft = 0;
  scrollTop = 0;
  layout = {
    nav: { left: 100, top: 40, width: 400, height: 52 },
    home: { left: 108, top: 47, width: 80, height: 38 },
    spending: { left: 194, top: 47, width: 108, height: 38 },
    planner: { left: 308, top: 47, width: 94, height: 38 },
  };
});
after(async () => { await act(async () => root.unmount()); dom.window.close(); });

test('the indicator fits the selected button inside the navigation border before painting', async () => {
  const nav = await render();
  assert.deepEqual(indicator(nav), ['6px', '6px', '80px', '38px']);
  assert.equal(nav.hasAttribute('data-glass-ready'), true);
  assert.equal(nav.getAttribute('data-glass-motion'), 'on');
  assert.equal(frames.size, 0);
  assert.deepEqual([...ObservedResize.instances[0].targets], [nav, ...nav.querySelectorAll('button')]);
});

test('changing the active page updates the indicator without recreating the observer', async () => {
  const nav = await render();
  await render({ active: 'planner' });
  assert.deepEqual(indicator(nav), ['206px', '6px', '94px', '38px']);
  assert.equal(ObservedResize.instances.length, 1);
  assert.equal(frames.size, 0);
});

test('horizontal and vertical scrolling preserve the selected button content coordinates', async () => {
  scrollLeft = 120;
  scrollTop = 20;
  const nav = await render({ active: 'planner' });
  assert.deepEqual(indicator(nav), ['206px', '6px', '94px', '38px']);
  scrollLeft = 180;
  scrollTop = 5;
  nav.dispatchEvent(new Event('scroll'));
  await advance();
  assert.deepEqual(indicator(nav), ['206px', '6px', '94px', '38px']);
  assert.equal(frames.size, 0);
});

test('responsive reflow and button resizing share one queued measurement', async () => {
  const nav = await render({ active: 'spending' });
  layout.nav = { left: 20, top: 100, width: 280, height: 94 };
  layout.spending = { left: 28, top: 145, width: 126, height: 42 };
  const observer = ObservedResize.instances[0];
  observer.trigger();
  observer.trigger();
  window.dispatchEvent(new Event('resize'));
  assert.equal(frames.size, 1);
  await advance();
  assert.deepEqual(indicator(nav), ['6px', '44px', '126px', '42px']);
  assert.equal(frames.size, 0);
});

test('the resize fallback works when ResizeObserver is unavailable', async () => {
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: undefined });
  const nav = await render();
  layout.home.width = 104;
  window.dispatchEvent(new Event('resize'));
  await advance();
  assert.deepEqual(indicator(nav), ['6px', '6px', '104px', '38px']);
});

test('paused motion still tracks the active page and does not queue an animation loop', async () => {
  const nav = await render({ motion: false });
  assert.equal(nav.getAttribute('data-glass-motion'), 'off');
  await render({ active: 'spending', motion: false });
  assert.deepEqual(indicator(nav), ['92px', '6px', '108px', '38px']);
  assert.equal(frames.size, 0);
  await render({ active: 'spending', motion: true });
  assert.equal(nav.getAttribute('data-glass-motion'), 'on');
  assert.equal(ObservedResize.instances.length, 1);
});

test('missing or hidden active buttons hide the indicator until they can be measured', async () => {
  const nav = await render({ active: 'unknown' });
  assert.equal(nav.hasAttribute('data-glass-ready'), false);
  layout.home.width = 0;
  await render();
  assert.equal(nav.hasAttribute('data-glass-ready'), false);
  layout.home.width = 80;
  ObservedResize.instances[0].trigger();
  await advance();
  assert.equal(nav.hasAttribute('data-glass-ready'), true);
  assert.deepEqual(indicator(nav), ['6px', '6px', '80px', '38px']);
});

test('active page changes refresh observed buttons when navigation entries change', async () => {
  const nav = await render();
  const removed = nav.querySelector('[data-box="planner"]')!;
  layout.accounts = { left: 308, top: 47, width: 116, height: 38 };
  await render({ active: 'accounts', items: ['home', 'spending', 'accounts'] });
  const observer = ObservedResize.instances[0];
  assert.equal(observer.targets.has(removed), false);
  assert.equal(observer.targets.has(nav.querySelector('[data-box="accounts"]')!), true);
  assert.deepEqual(indicator(nav), ['206px', '6px', '116px', '38px']);
});

test('unmount cancels pending work, disconnects observation and clears listeners and styles', async () => {
  const nav = await render();
  const observer = ObservedResize.instances[0];
  observer.trigger();
  assert.equal(frames.size, 1);
  await act(async () => root.render(null));
  assert.equal(observer.disconnected, true);
  assert.equal(frames.size, 0);
  assert.deepEqual(indicator(nav), ['', '', '', '']);
  assert.equal(nav.hasAttribute('data-glass-ready'), false);
  assert.equal(nav.hasAttribute('data-glass-motion'), false);
  window.dispatchEvent(new Event('resize'));
  nav.dispatchEvent(new Event('scroll'));
  observer.trigger();
  assert.equal(frames.size, 0);
});
