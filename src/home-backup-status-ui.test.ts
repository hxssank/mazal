import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { BackupStatus } from './services/automatic-backup-api.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
  return nextLoad(url, context);
} });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: HomeBackupStatus } = await import('./features/home/HomeBackupStatus.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
const calls: string[] = [];
let opened = 0;
let status: BackupStatus;
beforeEach(async () => {
  await act(async () => root.unmount()); root = createRoot(container);
  calls.length = 0; opened = 0;
  status = { supported: true, unsupportedReason: null, configured: true, enabled: true, destination: '/synthetic/backups', intervalHours: 24, retentionCount: 14, lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(), lastBackupPath: '/synthetic/backups/verified.mazal', lastBackupSha256: 'a'.repeat(64), lastError: null, nextRunAt: new Date(Date.now() + 86_400_000).toISOString(), running: false };
  globalThis.fetch = async (url, init) => { calls.push(`${init?.method} ${url}`); return Response.json(status); };
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });
async function mount() { await act(async () => root.render(createElement(HomeBackupStatus, { onOpen: () => { opened++; } }))); }
function button(label: string): HTMLButtonElement {
  const node = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  assert.ok(node, `Missing ${label} button`); return node;
}

test('Home reports the verified copy and opens backup controls without a write', async () => {
  await mount();
  assert.match(container.textContent!, /Automatic backup verified/);
  assert.match(container.textContent!, /Last verified/);
  assert.equal(container.querySelector('.needs-attention'), null);
  await act(async () => button('Review backups').click());
  assert.equal(opened, 1);
  assert.deepEqual(calls, ['GET /api/automatic-backup']);
});

test('Home shows the failure reason even when automatic backups are enabled', async () => {
  status.lastError = 'The backup destination changed or its drive was replaced.';
  await mount();
  assert.match(container.textContent!, /Automatic backups need attention/);
  assert.match(container.textContent!, /drive was replaced/);
  assert.ok(container.querySelector('.needs-attention'));
  assert.doesNotMatch(container.textContent!, /Automatic backup verified/);
});

test('Home distinguishes an overdue copy, a paused schedule and a running backup', async () => {
  status.lastVerifiedAt = new Date(Date.now() - 25 * 3_600_000).toISOString();
  await mount();
  assert.match(container.textContent!, /Automatic backup overdue/);
  status.enabled = false;
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.match(container.textContent!, /Automatic backups paused/);
  status.enabled = true; status.running = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.match(container.textContent!, /Automatic backup in progress/);
  assert.deepEqual(calls, Array(3).fill('GET /api/automatic-backup'));
});

test('Home offers setup only on a supported runtime and hides unsupported status', async () => {
  status.configured = false; status.enabled = false; status.lastVerifiedAt = null;
  await mount();
  assert.match(container.textContent!, /Automatic backups are not set up/);
  await act(async () => button('Set up backups').click());
  assert.equal(opened, 1);
  status.supported = false;
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.equal(container.innerHTML, '');
});

test('a malformed status replaces the previous success with an actionable error', async () => {
  await mount();
  globalThis.fetch = async () => Response.json({ enabled: true });
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.match(container.textContent!, /Backup status unavailable/);
  assert.doesNotMatch(container.textContent!, /Automatic backup verified/);
  globalThis.fetch = async () => Response.json(status);
  await act(async () => button('Retry backup status').click());
  assert.match(container.textContent!, /Automatic backup verified/);
});

for (const phase of ['fetch', 'body'] as const) test(`a stalled ${phase} times out and a late response cannot overwrite a retry`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await mount();
  let late!: () => void;
  globalThis.fetch = async () => {
    if (phase === 'fetch') return new Promise<Response>(resolve => { late = () => resolve(Response.json(status)); });
    const response = Response.json(status);
    t.mock.method(response, 'json', () => new Promise(resolve => { late = () => resolve(status); }));
    return response;
  };
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => t.mock.timers.tick(15_000));
  assert.match(container.textContent!, /Backup status unavailable/);
  assert.match(container.textContent!, /15 seconds/);
  globalThis.fetch = async () => Response.json({ ...status, enabled: false });
  await act(async () => button('Retry backup status').click());
  assert.match(container.textContent!, /Automatic backups paused/);
  await act(async () => late());
  assert.match(container.textContent!, /Automatic backups paused/);
});

test('unmount aborts its read and removes focus refreshes', async () => {
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => { calls.push('read'); signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); };
  await mount();
  assert.equal(signal?.aborted, false);
  await act(async () => root.unmount());
  assert.equal(signal?.aborted, true);
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.deepEqual(calls, ['read']);
  root = createRoot(container);
});
