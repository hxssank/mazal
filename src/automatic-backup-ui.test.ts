import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Event'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
  return nextLoad(url, context);
} });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: AutomaticBackup } = await import('./features/backups/AutomaticBackup.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const nativeFetch = globalThis.fetch;
const noChange = () => {};
const initial = { supported: true, unsupportedReason: null, configured: false, enabled: false, destination: null, intervalHours: 24, retentionCount: 14, lastAttemptAt: null, lastSuccessAt: null, lastVerifiedAt: null, lastBackupPath: null, lastBackupSha256: null, lastError: null, nextRunAt: null, running: false };
const configured = { ...initial, configured: true, enabled: true, destination: '/synthetic/Backups', lastSuccessAt: '2026-10-19T12:00:00Z', lastVerifiedAt: '2026-10-19T12:00:00Z', lastBackupPath: '/synthetic/Backups/Mazal backups/complete.mazal', lastBackupSha256: 'a'.repeat(64), nextRunAt: '2026-10-20T12:00:00Z' };
beforeEach(async () => {
  await act(async () => root.unmount()); root = createRoot(container);
  delete (window as unknown as Record<string, unknown>).webkit;
});
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); globalThis.fetch = nativeFetch; });
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  assert.ok(result, `Missing button ${label}`); return result;
}
const folder = () => container.querySelector<HTMLInputElement>('input[type="text"]')!;
async function type(value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(folder(), value); folder().dispatchEvent(new Event('input', { bubbles: true })); });
}
async function mount(options: Partial<Parameters<typeof AutomaticBackup>[0]> = {}) {
  await act(async () => root.render(createElement(AutomaticBackup, { disabled: false, onBusyChange: noChange, onDirtyChange: noChange, ...options })));
}

test('setup uses a generated key, shows the verified copy and clears the destination draft', async () => {
  const calls: { url: string; body: unknown }[] = [], dirty: boolean[] = [], busy: boolean[] = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), body: options?.body }); return Response.json(options?.method === 'POST' ? configured : initial); };
  await mount({ onBusyChange: value => busy.push(value), onDirtyChange: value => dirty.push(value) });
  assert.match(container.textContent!, /not set up/);
  await type('/synthetic/Backups'); assert.equal(dirty.at(-1), true);
  await act(async () => button('Set up daily backups').click());
  assert.deepEqual(JSON.parse(String(calls[1].body)), { destination: '/synthetic/Backups' });
  assert.equal(calls[1].url, '/api/automatic-backup/configure');
  assert.match(container.textContent!, /Daily backups enabled/); assert.match(container.textContent!, /complete\.mazal/);
  assert.equal(dirty.at(-1), false); assert.equal(busy.at(-1), false);
  assert.ok(button('Save recovery key')); assert.match(container.textContent!, /losing this Mac/);
});

for (const phase of ['fetch', 'body'] as const) test(`uncertain configure ${phase} blocks repeats until a fresh status and ignores late completion`, async t => {
  let posts = 0, reads = 0, late!: () => void;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'GET') { reads++; return Response.json(reads === 1 ? initial : configured); }
    posts++;
    const response = Response.json({ ...configured, destination: '/late/wrong' });
    if (phase === 'fetch') return new Promise<Response>(resolve => { late = () => resolve(response); });
    t.mock.method(response, 'json', () => new Promise(resolve => { late = () => resolve({ ...configured, destination: '/late/wrong' }); }));
    return response;
  };
  await mount(); await type('/synthetic/Backups');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Set up daily backups').click());
  await act(async () => t.mock.timers.tick(180_000));
  assert.match(container.textContent!, /timed out/); assert.equal(button('Set up daily backups').disabled, true);
  assert.equal(folder().value, '/synthetic/Backups'); assert.equal(posts, 1);
  await act(async () => button('Check backup status').click());
  assert.match(container.textContent!, /Daily backups enabled/); assert.equal(button('Back up now').disabled, false);
  await act(async () => late());
  assert.equal(folder().value, '/synthetic/Backups'); assert.doesNotMatch(container.textContent!, /late\/wrong/); assert.equal(posts, 1);
});

test('a status timeout preserves last verification and can retry', async t => {
  let reads = 0;
  globalThis.fetch = async () => { reads++; return reads === 2 ? new Promise<Response>(() => {}) : Response.json(configured); };
  await mount(); t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Check backup status').click());
  await act(async () => t.mock.timers.tick(15_000));
  assert.match(container.textContent!, /15 seconds/); assert.match(container.textContent!, /complete\.mazal/);
  assert.equal(button('Back up now').disabled, true);
  await act(async () => button('Check backup status').click());
  assert.equal(button('Back up now').disabled, false);
});

test('refresh adopts a destination changed in another window without marking an untouched form dirty', async () => {
  let current = configured;
  const dirty: boolean[] = [];
  globalThis.fetch = async () => Response.json(current);
  await mount({ onDirtyChange: value => dirty.push(value) });
  assert.equal(folder().value, configured.destination); assert.equal(dirty.at(-1), false);
  current = { ...configured, destination: '/synthetic/Changed elsewhere' };
  await act(async () => button('Check backup status').click());
  assert.equal(folder().value, current.destination); assert.equal(dirty.at(-1), false);
  await act(async () => button('Check backup status').click());
  assert.equal(folder().value, current.destination); assert.equal(dirty.at(-1), false);
});

test('refresh preserves an edited destination when another window changes the saved folder', async () => {
  let current = configured;
  const dirty: boolean[] = [];
  globalThis.fetch = async () => Response.json(current);
  await mount({ onDirtyChange: value => dirty.push(value) });
  await type('/synthetic/My draft');
  current = { ...configured, destination: '/synthetic/Changed elsewhere' };
  await act(async () => button('Check backup status').click());
  assert.equal(folder().value, '/synthetic/My draft'); assert.equal(dirty.at(-1), true);
  await type(current.destination);
  assert.equal(dirty.at(-1), false);
  current = { ...configured, destination: '/synthetic/Changed again' };
  await act(async () => button('Check backup status').click());
  assert.equal(folder().value, current.destination); assert.equal(dirty.at(-1), false);
});

test('run and pause report server errors and preserve the previous verified copy', async () => {
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') { assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json'); assert.deepEqual(JSON.parse(String(options.body)), {}); }
    return Response.json(options?.method === 'POST' ? { error: 'The backup volume is disconnected.' } : configured, { status: options?.method === 'POST' ? 503 : 200 });
  };
  await mount();
  await act(async () => button('Back up now').click());
  assert.match(container.textContent!, /volume is disconnected/); assert.match(container.textContent!, /complete\.mazal/);
  assert.equal(button('Pause automatic backups').disabled, true);
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') { assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json'); assert.deepEqual(JSON.parse(String(options.body)), {}); }
    return Response.json(options?.method === 'POST' ? { ...configured, enabled: false, nextRunAt: null } : configured);
  };
  await act(async () => button('Check backup status').click());
  await act(async () => button('Pause automatic backups').click());
  assert.match(container.textContent!, /Automatic backups paused/); assert.ok(button('Resume daily backups')); assert.ok(button('Save recovery key'));
});

test('recovery key is downloaded only on request and never rendered or saved in browser storage', async t => {
  const passphrase = 'synthetic secret only in download';
  const credentialId = '11111111-1111-4111-8111-111111111111';
  const blobs: Blob[] = [], paths: string[] = [], downloads: string[] = [];
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => { blobs.push(blob); return 'blob:synthetic-key'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { downloads.push(this.download); });
  globalThis.fetch = async (url, options) => {
    paths.push(String(url));
    if (String(url).endsWith('/recovery-key')) { assert.equal(options?.method, 'POST'); assert.equal(new Headers(options.headers).get('Content-Type'), 'application/json'); assert.deepEqual(JSON.parse(String(options.body)), {}); }
    return Response.json(String(url).endsWith('/recovery-key') ? { credentialId, passphrase } : configured);
  };
  await mount(); assert.equal(paths.length, 1);
  await act(async () => button('Save recovery key').click());
  assert.equal(paths[1], '/api/automatic-backup/recovery-key'); assert.equal(blobs.length, 1);
  assert.match(await blobs[0].text(), /synthetic secret only in download/); assert.equal(downloads[0], `mazal-recovery-key-${credentialId}.txt`);
  assert.doesNotMatch(container.textContent!, /synthetic secret/); assert.equal(window.localStorage.length, 0); assert.equal(window.sessionStorage.length, 0);
});

test('unsupported platforms do not offer setup and a native folder picker changes only the draft', async () => {
  globalThis.fetch = async () => Response.json({ ...initial, supported: false, unsupportedReason: 'Use the installed macOS app.' });
  await mount(); assert.match(container.textContent!, /Use the installed macOS app/); assert.equal(folder(), null);
  await act(async () => root.unmount()); root = createRoot(container);
  let picks = 0;
  Object.assign(window, { webkit: { messageHandlers: { mazalBackupFolder: { postMessage: async (body: unknown) => { assert.deepEqual(body, { action: 'chooseBackupFolder' }); picks++; return '/synthetic/Chosen'; } } } } });
  globalThis.fetch = async () => Response.json(initial);
  await mount(); await act(async () => button('Choose backup folder').click());
  assert.equal(folder().value, '/synthetic/Chosen'); assert.equal(picks, 1); assert.match(container.textContent!, /not set up/);
});

test('disabled controls and unmount stop backup setup and discard late status', async () => {
  let resolve!: (value: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(done => { resolve = done; });
  await mount({ disabled: true });
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => resolve(Response.json(configured)));
  assert.equal(container.textContent, '');
});

test('a saved recovery key is retained after an uncertain repair and cleared only after confirmed setup', async () => {
  const secret = 'synthetic existing backup key';
  let attempts = 0; const dirty: boolean[] = [];
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'GET') return Response.json(configured);
    assert.deepEqual(JSON.parse(String(options?.body)), { destination: configured.destination, passphrase: secret });
    attempts++;
    return attempts === 1 ? Response.json({ error: 'Keychain could not confirm the repair.' }, { status: 503 }) : Response.json(configured);
  };
  await mount({ onDirtyChange: value => dirty.push(value) });
  const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, secret); key.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(dirty.at(-1), true);
  await act(async () => button('Save backup folder').click());
  assert.equal(key.value, secret); assert.equal(button('Save backup folder').disabled, true);
  await act(async () => button('Check backup status').click());
  await act(async () => button('Save backup folder').click());
  assert.equal(key.value, ''); assert.equal(dirty.at(-1), false); assert.equal(attempts, 2);
  assert.equal(window.localStorage.length, 0);
});
