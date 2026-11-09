import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState } from '../shared/types.ts';

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
const { default: CompleteBackup } = await import('./features/backups/CompleteBackup.tsx');
const { default: Forms } = await import('./features/entries/Forms.tsx');
type Props = Parameters<typeof CompleteBackup>[0];
type Operation = 'export' | 'preview' | 'restore';
const container = document.getElementById('root')!;
let root = createRoot(container);
let downloads: Blob[] = [], clicked: string[] = [];
const nativeFetch = globalThis.fetch;
beforeEach(async t => {
  assert.ok('mock' in t);
  await act(async () => root.unmount()); root = createRoot(container);
  downloads = []; clicked = [];
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => { downloads.push(blob); return `blob:synthetic-${downloads.length}`; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { clicked.push(this.download); });
});
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); globalThis.fetch = nativeFetch; });

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
  assert.ok(result, `Missing button ${label}`);
  return result;
}
const passphrase = 'synthetic passphrase + é';
function preview() {
  return { token: '11111111-1111-4111-8111-111111111111', exportedAt: '2026-10-16T10:00:00.000Z', encrypted: true, archiveSha256: 'a'.repeat(64), expectedRevision: 1, files: 4, bytes: 100, workspaces: { live: { revision: 1, transactions: 3, documents: 1, unlinkedDocuments: 0 }, demo: { revision: 1, transactions: 0, documents: 0, unlinkedDocuments: 0 } }, calculationFiles: 0 };
}
function receipt() { return { status: 'restored', token: preview().token, expectedRevision: 1, previousDirectory: '/synthetic/.mazal-before-22222222-2222-4222-8222-222222222222' }; }
function file() { return new File([new Uint8Array([77, 65, 90, 65, 76, 0, 1, 2])], 'original-complete.mazal', { type: 'application/octet-stream' }); }
function input(label: string): HTMLInputElement {
  const result = [...container.querySelectorAll('label')].find(element => element.querySelector('span')?.textContent === label)?.querySelector('input');
  assert.ok(result, `Missing input ${label}`); return result;
}
async function type(target: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function selectFile(archive = file()) {
  const target = container.querySelector<HTMLInputElement>('input[accept=".mazal,application/octet-stream"]')!;
  Object.defineProperty(target, 'files', { value: [archive], configurable: true });
  await act(async () => target.dispatchEvent(new Event('change', { bubbles: true })));
  return archive;
}
async function mount(props: Partial<Props> = {}) {
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('/api/automatic-backup')) return Response.json({ supported: false, unsupportedReason: 'Automatic backups need the installed macOS app.', configured: false, enabled: false, destination: null, intervalHours: 24, retentionCount: 14, lastAttemptAt: null, lastSuccessAt: null, lastVerifiedAt: null, lastBackupPath: null, lastBackupSha256: null, lastError: null, nextRunAt: null, running: false });
    calls.push({ url: String(url), options });
    if (String(url).includes('/export')) return new Response(new Uint8Array([77, 65, 90, 65, 76]));
    if (String(url).includes('/preview')) return Response.json(preview());
    return Response.json(receipt());
  };
  await act(async () => root.render(createElement(CompleteBackup, { workspace: 'live', revision: 1, ...props })));
  return calls;
}
async function prepare(operation: Operation) {
  const archive = await selectFile();
  await type(input('Backup passphrase, if encrypted'), passphrase);
  if (operation === 'export') {
    await act(async () => input('Encrypt this download with a passphrase').click());
    await type(input('Backup passphrase'), passphrase); await type(input('Repeat passphrase'), passphrase);
  }
  if (operation === 'restore') {
    await act(async () => button('Verify complete backup').click());
    await act(async () => container.querySelector<HTMLInputElement>('.mazal-backup-preview input[type="checkbox"]')!.click());
  }
  return archive;
}
const action = (operation: Operation) => operation === 'export' ? 'Download complete backup' : operation === 'preview' ? 'Verify complete backup' : 'Restore complete backup';

for (const operation of ['export', 'preview', 'restore'] as const) for (const phase of ['fetch', 'body'] as const) test(`${operation} ${phase} deadline preserves drafts and requires one explicit retry`, async t => {
  const busy: boolean[] = [], dirty: boolean[] = []; let restored = 0;
  const props = { onBusyChange: (value: boolean) => busy.push(value), onDirtyChange: (value: boolean) => dirty.push(value), onRestored: () => { restored++; } };
  await mount(props); const archive = await prepare(operation);
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = []; let completeLate!: () => void;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes(`/${operation}?`)) return originalFetch(url, options);
    requests.push(options!);
    if (requests.length > 1) return originalFetch(url, options);
    const response = await originalFetch(url, options);
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    const value = operation === 'export' ? await response.blob() : await response.json();
    t.mock.method(response, operation === 'export' ? 'blob' : 'json', () => new Promise(resolve => { completeLate = () => resolve(value); }));
    return response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button(action(operation)).click());
  assert.equal(busy.at(-1), true);
  await act(async () => t.mock.timers.tick(179_999));
  assert.equal(requests[0].signal?.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(requests[0].signal?.aborted, true);
  assert.equal(busy.at(-1), false); assert.equal(dirty.at(-1), true);
  assert.match(container.textContent!, /timed out/);
  assert.equal(requests.length, 1); assert.equal(restored, 0); assert.equal(downloads.length, 0);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.files![0], archive);
  const retry = operation === 'restore' ? 'Confirm original restore' : action(operation);
  assert.equal(button(retry).disabled, false);
  assert.equal(button('Clear backup').disabled, operation === 'restore');
  if (operation === 'restore') {
    assert.equal(button('Verify complete backup').disabled, true);
    assert.equal(button('Open records to check').disabled, false);
    await act(async () => root.render(createElement(CompleteBackup, { workspace: 'live', revision: 5, ...props })));
    assert.equal(button(retry).disabled, false);
    assert.doesNotMatch(container.textContent!, /Your records changed/);
  } else {
    assert.equal(input('Backup passphrase, if encrypted').value, passphrase);
    if (operation === 'export') { assert.equal(input('Backup passphrase').value, passphrase); assert.equal(input('Repeat passphrase').value, passphrase); }
  }
  await act(async () => button(retry).click());
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(requests[0].headers, requests[1].headers);
  if (operation === 'preview') {
    assert.equal(requests[1].body, archive);
    assert.deepEqual(new Uint8Array(await archive.arrayBuffer()), new Uint8Array([77, 65, 90, 65, 76, 0, 1, 2]));
    assert.equal(new Headers(requests[1].headers).get('X-Mazal-Backup-Passphrase'), encodeURIComponent(passphrase));
    assert.match(container.textContent!, /Backup verified/);
    assert.equal(input('Backup passphrase, if encrypted').value, '');
  } else if (operation === 'export') {
    assert.equal(downloads.length, 1); assert.equal(clicked.length, 1);
    assert.match(clicked[0], /\.encrypted\.mazal$/);
    assert.deepEqual(new Uint8Array(await downloads[0].arrayBuffer()), new Uint8Array([77, 65, 90, 65, 76]));
    assert.equal(input('Backup passphrase').value, ''); assert.equal(input('Repeat passphrase').value, '');
  } else {
    assert.deepEqual(JSON.parse(String(requests[1].body)), { token: preview().token, expectedRevision: 1, confirmation: true });
    assert.equal(restored, 1); assert.equal(dirty.at(-1), false);
    assert.match(container.textContent!, /Complete backup restored and verified/);
  }
  await act(async () => completeLate());
  assert.equal(downloads.length, operation === 'export' ? 1 : 0);
  assert.equal(restored, operation === 'restore' ? 1 : 0);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(container.textContent!, /timed out/);
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(requests[1].signal?.aborted, false);
});

for (const operation of ['export', 'preview', 'restore'] as const) for (const phase of ['fetch', 'body'] as const) test(`canceling ${operation} ${phase} ignores late output and leaves no draft in another workspace`, async t => {
  let restored = 0; const busy: boolean[] = [], dirty: boolean[] = [];
  const props = { onBusyChange: (value: boolean) => busy.push(value), onDirtyChange: (value: boolean) => dirty.push(value), onRestored: () => { restored++; } };
  await mount(props); await prepare(operation);
  const originalFetch = globalThis.fetch;
  let pending: RequestInit | undefined, completeLate!: () => void, attempts = 0;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes(`/${operation}?`)) return originalFetch(url, options);
    attempts++; pending = options;
    const response = await originalFetch(url, options);
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    const value = operation === 'export' ? await response.blob() : await response.json();
    t.mock.method(response, operation === 'export' ? 'blob' : 'json', () => new Promise(resolve => { completeLate = () => resolve(value); }));
    return response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button(action(operation)).click());
  if (phase === 'fetch') await act(async () => root.render(null));
  else await act(async () => root.render(createElement(CompleteBackup, { workspace: 'demo', revision: 1, ...props })));
  assert.equal(pending?.signal?.aborted, true);
  const callbackCounts = [busy.length, dirty.length];
  await act(async () => completeLate());
  await act(async () => t.mock.timers.tick(180_000));
  assert.deepEqual([busy.length, dirty.length], callbackCounts);
  assert.equal(attempts, 1); assert.equal(restored, 0); assert.equal(downloads.length, 0);
  assert.doesNotMatch(container.textContent!, /timed out|Backup verified|Download started|Complete backup restored|Confirm original restore/);
  if (phase === 'fetch') assert.equal(container.textContent, '');
  else { assert.equal(busy.at(-1), false); assert.equal(dirty.at(-1), false); }
});

for (const operation of ['export', 'preview', 'restore'] as const) test(`${operation} also bounds a stalled HTTP error body`, async t => {
  await mount(); await prepare(operation);
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined, completeLate!: () => void, attempts = 0;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes(`/${operation}?`)) return originalFetch(url, options);
    attempts++; request = options;
    return { ok: false, json: () => new Promise(resolve => { completeLate = () => resolve({ error: 'Late server rejection.' }); }) } as Response;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button(action(operation)).click());
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(request?.signal?.aborted, true); assert.equal(attempts, 1);
  assert.match(container.textContent!, /timed out/);
  await act(async () => completeLate());
  assert.match(container.textContent!, /timed out/);
  assert.doesNotMatch(container.textContent!, /Late server rejection/);
  assert.equal(downloads.length, 0);
});

for (const failure of ['transport', '400', '401', '404', '409', '503', 'wrong token', 'wrong revision', 'pending', 'missing safety copy', 'invalid JSON'] as const) test(`restore ${failure} leaves its original request frozen for manual confirmation`, async () => {
  let restored = 0; await mount({ onRestored: () => { restored++; } }); await prepare('restore');
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/restore?')) return originalFetch(url, options);
    requests.push(options!);
    if (requests.length > 1) return originalFetch(url, options);
    if (failure === 'transport') throw new TypeError('Connection lost.');
    if (/^\d+$/.test(failure)) return Response.json({ error: failure === '404' ? 'Verify the complete backup again before restoring.' : 'The restore response could not be confirmed.' }, { status: Number(failure) });
    if (failure === 'invalid JSON') return new Response('not json', { headers: { 'Content-Type': 'application/json' } });
    const result = receipt();
    return Response.json({ ...result, ...(failure === 'wrong token' ? { token: 'other-token' } : failure === 'wrong revision' ? { expectedRevision: 99 } : failure === 'pending' ? { status: 'pending' } : { previousDirectory: null }) });
  };
  await act(async () => button('Restore complete backup').click());
  assert.equal(requests.length, 1); assert.equal(restored, 0);
  assert.match(container.textContent!, /restore may have completed/);
  assert.equal(button('Clear backup').disabled, true);
  assert.equal(button('Verify complete backup').disabled, true);
  assert.equal(button('Download complete backup').disabled, true);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled, true);
  assert.equal(button('Confirm original restore').disabled, false);
  await act(async () => root.render(createElement(CompleteBackup, { workspace: 'live', revision: 6, onRestored: () => { restored++; } })));
  await act(async () => button('Confirm original restore').click());
  assert.equal(requests.length, 2); assert.equal(requests[0].body, requests[1].body);
  assert.equal(restored, 1); assert.match(container.textContent!, /Complete backup restored and verified/);
});

test('an expired receipt after a timed-out restore never unlocks a fresh restore', async t => {
  await mount(); await prepare('restore');
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/restore?')) return originalFetch(url, options);
    requests.push(options!);
    if (requests.length === 1) return new Promise<Response>(() => {});
    return Response.json({ error: 'Verify the complete backup again before restoring.' }, { status: 404 });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Restore complete backup').click());
  await act(async () => t.mock.timers.tick(180_000));
  await act(async () => button('Confirm original restore').click());
  assert.equal(requests.length, 2); assert.equal(requests[0].body, requests[1].body);
  assert.equal(button('Clear backup').disabled, true); assert.equal(button('Verify complete backup').disabled, true);
  assert.equal(button('Open records to check').disabled, false);
  assert.match(container.textContent!, /If Mazal restarted, inspect your records before starting another restore/);
});

test('late verification cannot replace a newer preview or its restore token', async t => {
  await mount(); const archive = await prepare('preview');
  const originalFetch = globalThis.fetch;
  let completeLate!: () => void, attempts = 0, restoredBody: unknown;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/restore?')) { restoredBody = options?.body; return Response.json({ ...receipt(), token: 'new-token' }); }
    if (!String(url).includes('/preview?')) return originalFetch(url, options);
    attempts++;
    if (attempts === 1) return new Promise<Response>(resolve => { completeLate = () => resolve(Response.json(preview())); });
    return Response.json({ ...preview(), token: 'new-token', workspaces: { ...preview().workspaces, live: { ...preview().workspaces.live, transactions: 7 } } });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Verify complete backup').click());
  await act(async () => t.mock.timers.tick(180_000));
  await act(async () => button('Verify complete backup').click());
  await act(async () => completeLate());
  assert.match(container.textContent!, /7 personal transactions/);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.files![0], archive);
  await act(async () => container.querySelector<HTMLInputElement>('.mazal-backup-preview input[type="checkbox"]')!.click());
  await act(async () => button('Restore complete backup').click());
  assert.equal(JSON.parse(String(restoredBody)).token, 'new-token');
});

test('records changing during verification block an initial restore', async () => {
  await mount(); await prepare('preview');
  const originalFetch = globalThis.fetch;
  let finish!: () => void, commits = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/preview?')) return new Promise<Response>(resolve => { finish = () => resolve(Response.json(preview())); });
    if (String(url).includes('/restore?')) commits++;
    return originalFetch(url, options);
  };
  await act(async () => button('Verify complete backup').click());
  await act(async () => root.render(createElement(CompleteBackup, { workspace: 'live', revision: 2 })));
  await act(async () => finish());
  assert.match(container.textContent!, /Your records changed/);
  assert.equal(button('Restore complete backup').disabled, true); assert.equal(commits, 0);
});

for (const [name, bad] of Object.entries({ empty: null, 'missing token': { ...preview(), token: '' }, 'missing workspaces': { ...preview(), workspaces: {} }, 'negative revision': { ...preview(), expectedRevision: -1 } })) test(`invalid preview (${name}) retains the file and passphrase`, async () => {
  await mount(); const archive = await prepare('preview');
  globalThis.fetch = async () => Response.json(bad);
  await act(async () => button('Verify complete backup').click());
  assert.match(container.textContent!, /invalid verification/);
  assert.equal(input('Backup passphrase, if encrypted').value, passphrase);
  assert.equal(container.querySelector<HTMLInputElement>('input[type="file"]')!.files![0], archive);
  assert.equal(button('Clear backup').disabled, false);
  assert.equal(container.querySelector('.mazal-backup-preview'), null);
});

test('export-only passphrases survive a server rejection and explicit retry', async () => {
  await mount();
  await act(async () => input('Encrypt this download with a passphrase').click());
  await type(input('Backup passphrase'), passphrase); await type(input('Repeat passphrase'), passphrase);
  const originalFetch = globalThis.fetch; const bodies: unknown[] = [];
  globalThis.fetch = async (url, options) => {
    bodies.push(options?.body);
    return bodies.length === 1 ? Response.json({ error: 'A complete backup or restore is in progress.' }, { status: 503 }) : originalFetch(url, options);
  };
  await act(async () => button('Download complete backup').click());
  assert.match(container.textContent!, /in progress/);
  assert.equal(input('Backup passphrase').value, passphrase); assert.equal(input('Repeat passphrase').value, passphrase);
  assert.equal(downloads.length, 0); assert.equal(bodies.length, 1);
  await act(async () => button('Download complete backup').click());
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(String(bodies[1])), { passphrase });
  assert.equal(downloads.length, 1); assert.equal(input('Backup passphrase').value, '');
});

test('invalid encryption entries and oversized archives do not dispatch requests', async () => {
  const calls = await mount();
  await act(async () => input('Encrypt this download with a passphrase').click());
  await type(input('Backup passphrase'), 'short'); await type(input('Repeat passphrase'), 'short');
  await act(async () => button('Download complete backup').click());
  assert.match(container.textContent!, /at least 12 characters/);
  const archive = file(); Object.defineProperty(archive, 'size', { value: 256 * 1024 * 1024 + 1 });
  await selectFile(archive);
  await act(async () => button('Verify complete backup').click());
  assert.match(container.textContent!, /smaller than 256 MiB/); assert.equal(calls.length, 0);
});

test('pending complete restore releases Done and keeps its exact request through Keep editing', async t => {
  await mount();
  const state: AppState = { workspace: 'live', revision: 1, entities: [], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = []; let closed = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/restore?')) { bodies.push(options?.body); return bodies.length === 1 ? new Promise<Response>(() => {}) : originalFetch(url, options); }
    return originalFetch(url, options);
  };
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state, onCommand: async () => {}, onClose: () => { closed++; } })));
  await prepare('restore');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Restore complete backup').click());
  assert.equal(button('Done').disabled, true);
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(button('Done').disabled, false);
  assert.equal(button('Clear backup').disabled, true);
  await act(async () => button('Done').click());
  assert.match(container.textContent!, /Discard unsaved changes/);
  await act(async () => button('Keep editing').click());
  assert.equal(bodies.length, 1); assert.equal(button('Confirm original restore').disabled, false);
  await act(async () => button('Confirm original restore').click());
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  await act(async () => button('Done').click());
  assert.equal(closed, 1);
});

test('an export without a selected file keeps both passphrases through timeout and manual retry', async t => {
  const busy: boolean[] = []; await mount({ onBusyChange: value => busy.push(value) });
  await act(async () => input('Encrypt this download with a passphrase').click());
  await type(input('Backup passphrase'), passphrase); await type(input('Repeat passphrase'), passphrase);
  const originalFetch = globalThis.fetch; const bodies: unknown[] = [];
  globalThis.fetch = async (url, options) => {
    bodies.push(options?.body);
    return bodies.length === 1 ? { ok: true, blob: () => new Promise(() => {}) } as Response : originalFetch(url, options);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button('Download complete backup').click());
  await act(async () => t.mock.timers.tick(180_000));
  assert.equal(busy.at(-1), false);
  assert.equal(input('Backup passphrase').value, passphrase); assert.equal(input('Repeat passphrase').value, passphrase);
  assert.equal(input('Encrypt this download with a passphrase').checked, true);
  assert.equal(bodies.length, 1); assert.equal(downloads.length, 0);
  await act(async () => button('Download complete backup').click());
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.equal(downloads.length, 1);
});

for (const operation of ['export', 'preview', 'restore'] as const) for (const bodyFocus of [false, true]) test(`${operation} timeout focuses the error when backup still owns ${bodyFocus ? 'body' : 'control'} focus`, async t => {
  await mount(); await prepare(operation);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes(`/${operation}?`) ? new Promise<Response>(() => {}) : originalFetch(url, options);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const trigger = button(action(operation)); trigger.focus();
  await act(async () => trigger.click());
  if (bodyFocus) { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); assert.ok(document.activeElement === document.body); }
  await act(async () => t.mock.timers.tick(180_000));
  const error = container.querySelector<HTMLElement>('.form-error[role="alert"]')!;
  assert.match(error.textContent!, /timed out/);
  assert.ok(document.activeElement === error);
});

for (const focus of ['another editor', 'another editor then blur', 'outside pointer', 'hidden', 'inert', 'CSS hidden'] as const) test(`complete backup timeout leaves focus alone for ${focus}`, async t => {
  await mount(); await prepare('preview');
  globalThis.fetch = async () => new Promise<Response>(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const trigger = button('Verify complete backup'); trigger.focus();
  await act(async () => trigger.click());
  document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex');
  const region = container.querySelector<HTMLElement>('section')!;
  const other = document.createElement('input'); document.body.append(other); t.after(() => other.remove());
  if (focus.startsWith('another editor')) other.focus();
  if (focus === 'another editor then blur') other.blur();
  if (focus === 'outside pointer') other.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  if (focus === 'hidden') region.hidden = true;
  if (focus === 'inert') region.setAttribute('inert', '');
  if (focus === 'CSS hidden') region.style.display = 'none';
  const active = document.activeElement;
  await act(async () => t.mock.timers.tick(180_000));
  assert.match(container.textContent!, /timed out/); assert.ok(document.activeElement === active);
});

test('an unencrypted complete download omits a passphrase and keeps its filename suffix', async () => {
  const calls = await mount();
  await act(async () => button('Download complete backup').click());
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { passphrase: '' });
  assert.equal(downloads.length, 1); assert.match(clicked[0], /^mazal-complete-\d{4}-\d{2}-\d{2}\.mazal$/);
});
