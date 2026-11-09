import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
type AnimationRecord = { element: HTMLElement; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean; finish: () => void; cancel: () => void };
const animations: AnimationRecord[] = [];
const animate = function (this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const record: AnimationRecord = { element: this, keyframes, options, cancelled: false, finish: resolve, cancel: () => { record.cancelled = true; reject(new Error('Cancelled')); } };
  animations.push(record);
  return { finished, cancel: record.cancel } as unknown as Animation;
};
HTMLElement.prototype.animate = animate as typeof HTMLElement.prototype.animate;
HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 20, top: 30, width: 120, height: 40, right: 140, bottom: 70, x: 20, y: 30, toJSON() {} };
};
const { createElement, act, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: useGlassClicks } = await import('./hooks/useGlassClicks.ts');
const container = document.getElementById('root')!;
let root = createRoot(container);

function Probe({ motion = true, show = true }: { motion?: boolean; show?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useGlassClicks(ref, motion);
  return createElement('div', { ref },
    show && createElement('button', { className: 'button primary', id: 'action' }, createElement('span', null, 'Save')),
    createElement('button', { className: 'button', disabled: true, id: 'disabled' }, 'Disabled'),
    createElement('button', { className: 'button', 'aria-disabled': true, id: 'aria-disabled' }, 'Unavailable'),
    createElement('button', { id: 'plain' }, 'Plain'),
    createElement('nav', { className: 'workspace-tabs' }, ...Array.from({ length: 8 }, (_, index) => createElement('button', { key: index, id: `tab-${index}` }, `Tab ${index}`))),
    createElement('details', null, createElement('summary', { className: 'toolbar-add-toggle', id: 'summary' }, 'More')));
}

function control(id = 'action') { return container.querySelector<HTMLElement>(`#${id}`)!; }
function click(element = control(), detail = 1, clientX = 50, clientY = 42) {
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail, clientX, clientY });
  element.dispatchEvent(event);
  return event;
}
function wave(id = 'action') { return control(id).querySelector<HTMLElement>('.glass-click-wave'); }

beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  hidden = false;
  animations.length = 0;
  HTMLElement.prototype.animate = animate as typeof HTMLElement.prototype.animate;
});
after(async () => { await act(async () => root.unmount()); dom.window.close(); });

test('pointer clicks start at the click point without changing focus or suppressing the click', async () => {
  await act(async () => root.render(createElement(Probe)));
  control().focus();
  let received = 0;
  control().addEventListener('click', () => { received++; });
  const event = click(control().firstElementChild as HTMLElement);
  assert.equal(received, 1);
  assert.equal(event.defaultPrevented, false);
  assert.equal(document.activeElement, control());
  assert.equal(wave()?.style.left, '30px');
  assert.equal(wave()?.style.top, '12px');
  assert.equal(wave()?.getAttribute('aria-hidden'), 'true');
  assert.equal(wave()?.style.pointerEvents, 'none');
  assert.ok(Number.parseFloat(wave()!.style.width) >= 180);
  assert.equal(animations[0].options.duration, 560);
  assert.match(animations[0].keyframes[0].transform as string, /translate\(-50%, -50%\)/);
  assert.equal(animations[0].keyframes.at(-1)?.opacity, 0);
});

test('keyboard and programmatic activation use the control center', async () => {
  await act(async () => root.render(createElement(Probe)));
  control().click();
  assert.equal(wave()?.style.left, '60px');
  assert.equal(wave()?.style.top, '20px');
  click(control('tab-0'), 0);
  assert.equal(wave('tab-0')?.style.left, '60px');
  assert.equal(wave('tab-0')?.style.top, '20px');
});

test('disabled, unrelated and inert controls do not animate', async () => {
  await act(async () => root.render(createElement(Probe)));
  for (const id of ['disabled', 'aria-disabled', 'plain']) click(control(id));
  control().setAttribute('inert', '');
  click();
  assert.equal(animations.length, 0);
});

test('repeated clicks replace the prior wave and completion cannot remove its replacement', async () => {
  await act(async () => root.render(createElement(Probe)));
  click();
  const previous = wave();
  click();
  await Promise.resolve();
  assert.equal(animations[0].cancelled, true);
  assert.equal(previous?.isConnected, false);
  assert.equal(control().querySelectorAll('.glass-click-wave').length, 1);
  const replacement = wave();
  animations[0].finish();
  await Promise.resolve();
  assert.equal(wave(), replacement);
  animations[1].finish();
  await Promise.resolve();
  assert.equal(wave(), null);
});

test('at most six controls retain a wave during rapid clicking', async () => {
  await act(async () => root.render(createElement(Probe)));
  for (let index = 0; index < 8; index++) click(control(`tab-${index}`));
  assert.equal(container.querySelectorAll('.glass-click-wave').length, 6);
  assert.equal(animations.filter(animation => animation.cancelled).length, 2);
  assert.equal(wave('tab-0'), null);
  assert.equal(wave('tab-7')?.isConnected, true);
});

test('pausing motion cancels active waves and resuming permits new clicks', async () => {
  await act(async () => root.render(createElement(Probe)));
  click();
  await act(async () => root.render(createElement(Probe, { motion: false })));
  assert.equal(wave(), null);
  assert.equal(animations[0].cancelled, true);
  click();
  assert.equal(animations.length, 1);
  await act(async () => root.render(createElement(Probe)));
  click();
  assert.equal(animations.length, 2);
});

test('hidden documents cancel waves and cannot start more until visible', async () => {
  await act(async () => root.render(createElement(Probe)));
  click();
  hidden = true;
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(wave(), null);
  assert.equal(animations[0].cancelled, true);
  click();
  assert.equal(animations.length, 1);
  hidden = false;
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  click();
  assert.equal(animations.length, 2);
});

test('route removal cancels a detached control without retaining its wave', async () => {
  await act(async () => root.render(createElement(Probe)));
  click();
  const detached = control();
  await act(async () => root.render(createElement(Probe, { show: false })));
  assert.equal(detached.querySelector('.glass-click-wave'), null);
  assert.equal(animations[0].cancelled, true);
});

test('unmount cancels all waves and detaches listeners', async () => {
  await act(async () => root.render(createElement(Probe)));
  click();
  click(control('tab-0'));
  const detached = control();
  await act(async () => root.unmount());
  assert.equal(animations.every(animation => animation.cancelled), true);
  assert.equal(detached.querySelector('.glass-click-wave'), null);
  click(detached);
  assert.equal(animations.length, 2);
  root = createRoot(container);
});

test('cancelled animations remove their wave and missing animation support leaves controls usable', async () => {
  await act(async () => root.render(createElement(Probe)));
  click();
  animations[0].cancel();
  await Promise.resolve();
  assert.equal(wave(), null);
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: undefined });
  const event = click();
  assert.equal(event.defaultPrevented, false);
  assert.equal(wave(), null);
});
