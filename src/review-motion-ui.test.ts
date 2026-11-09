import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 20, top: 30, width: 200, height: 100, right: 220, bottom: 130, x: 20, y: 30, toJSON() {} };
};
const { createElement, act, StrictMode, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { gsap } = await import('gsap');
const { default: useReviewMotion } = await import('./hooks/useReviewMotion.ts');
const container = document.getElementById('root')!;
let root = createRoot(container);

function Probe({ motion = true, period = 'daily', amount = '$1,234.56' }: { motion?: boolean; period?: string; amount?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useReviewMotion(ref, motion, period);
  return createElement('div', { ref }, createElement('section', { 'data-review-panel': '', style: { opacity: .85 } },
    createElement('strong', { 'data-review-value': '' }, amount),
    createElement('div', { 'data-review-bar': '', style: { height: '42%' } }),
    createElement('div', { 'data-review-meter': '', style: { width: '37%' } }),
    createElement('button', null, 'Review records')));
}
async function render(props: Parameters<typeof Probe>[0] = {}) {
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe, props))));
}
function element(selector: string) { return container.querySelector<HTMLElement>(selector)!; }
function panel() { return element('[data-review-panel]'); }
function value() { return element('[data-review-value]'); }
function pointer(type: string, target = panel(), pointerType = 'mouse') {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 70, clientY: 80 });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
  return event;
}
async function frame() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); }); }
function finish(targets: HTMLElement[] = [...container.querySelectorAll<HTMLElement>('*')]) {
  gsap.getTweensOf(targets).forEach(tween => tween.progress(1));
}
function assertRestored(target = panel()) {
  assert.equal(target.style.transform, '');
  assert.equal(target.style.opacity, '0.85');
  for (const property of ['--pointer-x', '--pointer-y', '--review-hover']) assert.equal(target.style.getPropertyValue(property), '');
  for (const child of target.querySelectorAll<HTMLElement>('*')) {
    assert.equal(child.style.transform, '');
    assert.equal(child.style.transformOrigin, '');
    assert.equal(child.style.textShadow, '');
  }
}
beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  hidden = false;
});
after(async () => { await act(async () => root.unmount()); gsap.ticker.sleep(); dom.window.close(); });

test('entrances preserve the exact amounts and chart sizes, then restore authored styles', async () => {
  await render();
  assert.equal(value().textContent, '$1,234.56');
  assert.notEqual(element('[data-review-bar]').style.transform, '');
  assert.notEqual(element('[data-review-meter]').style.transform, '');
  finish();
  assertRestored();
  assert.equal(value().textContent, '$1,234.56');
  assert.equal(element('[data-review-bar]').style.height, '42%');
  assert.equal(element('[data-review-meter]').style.width, '37%');
});

test('record updates highlight the actual new text without replacing it or replaying cards', async () => {
  await render();
  finish();
  await render({ amount: '$1,194.11' });
  assert.equal(value().textContent, '$1,194.11');
  assert.notEqual(value().style.textShadow, '');
  assert.equal(panel().style.transform, '');
  finish();
  assertRestored();
  await render({ amount: '$1,194.11' });
  assert.equal(gsap.getTweensOf(value()).length, 0);
  assert.equal(value().textContent, '$1,194.11');
});

test('pointer effects preserve button focus and activation and ignore touch input', async () => {
  await render();
  finish();
  const button = element('button');
  button.focus();
  let clicks = 0;
  button.addEventListener('click', () => { clicks++; });
  assert.equal(pointer('pointerover', button).defaultPrevented, false);
  await frame();
  assert.equal(panel().style.getPropertyValue('--pointer-x'), '25%');
  assert.equal(panel().style.getPropertyValue('--pointer-y'), '50%');
  assert.equal(document.activeElement, button);
  button.click();
  assert.equal(clicks, 1);
  pointer('pointerout', button);
  finish();
  assertRestored();
  pointer('pointerover', button, 'touch');
  pointer('pointermove', button, 'touch');
  await frame();
  assertRestored();
});

test('pausing during entrance and hover clears active and queued work across StrictMode remounts', async () => {
  await render();
  pointer('pointerover');
  await render({ amount: '$1,000' });
  const target = panel();
  await render({ motion: false, amount: '$1,000' });
  await frame();
  assertRestored(target);
  pointer('pointerover');
  await frame();
  assertRestored(target);
  assert.equal(gsap.getTweensOf([target, ...target.querySelectorAll<HTMLElement>('*')]).length, 0);
  await render();
  finish();
  pointer('pointerover');
  assert.equal(gsap.getTweensOf(panel()).length, 1);
  await act(async () => root.render(null));
  pointer('pointerover', target);
  await frame();
  assertRestored(target);
});

test('hidden documents skip new animations and clear in-flight effects without changing data', async () => {
  hidden = true;
  await render();
  assertRestored();
  await render({ amount: '$15.03' });
  pointer('pointerover');
  await frame();
  assertRestored();
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  await render({ amount: '$20.05' });
  assert.notEqual(value().style.textShadow, '');
  pointer('pointerover');
  await frame();
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assertRestored();
  assert.equal(value().textContent, '$20.05');
  assert.equal(gsap.getTweensOf([...container.querySelectorAll<HTMLElement>('*')]).length, 0);
});

test('switching the review period resets hover and starts fresh chart entrances', async () => {
  await render();
  finish();
  pointer('pointerover');
  await frame();
  await render({ period: 'weekly' });
  assert.equal(panel().style.getPropertyValue('--pointer-x'), '');
  assert.equal(panel().style.getPropertyValue('--review-hover'), '');
  assert.notEqual(element('[data-review-bar]').style.transform, '');
  assert.equal(value().style.textShadow, '');
  finish();
  assertRestored();
});
