import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AppState, Command, Workspace } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useWorkspaceRecords } = await import('./app/useWorkspaceRecords.ts');
const originalFetch = globalThis.fetch;
const container = document.getElementById('root')!;
let root = createRoot(container);
let records: ReturnType<typeof useWorkspaceRecords>;
let resets = 0;

function Harness({ workspace = 'live' }: { workspace?: Workspace }) {
  records = useWorkspaceRecords(workspace, { onResetForms: () => { resets++; } });
  return null;
}

function fixture(revision = 1, workspace: Workspace = 'live'): AppState {
  return { workspace, revision, entities: [], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const change: Command = { type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 0, openingDate: '2026-11-03' };

beforeEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  resets = 0;
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close(); });

test('record refreshes use the current conditional token and preserve form state', async () => {
  const tokens: (string | null)[] = [];
  globalThis.fetch = async (_url, init) => {
    const token = new Headers(init?.headers).get('If-None-Match');
    tokens.push(token);
    return token ? new Response(null, { status: 304, headers: { ETag: '"records-1"' } }) : Response.json(fixture(), { headers: { ETag: '"records-1"' } });
  };
  await act(async () => root.render(createElement(Harness)));
  const initial = records.state;
  assert.equal(resets, 1);
  await act(async () => root.render(createElement(Harness)));
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.deepEqual(tokens, [null, '"records-1"']);
  assert.equal(records.state, initial);
  assert.equal(records.notice, '');
  assert.equal(resets, 1);
  await act(async () => records.refresh());
  assert.equal(records.notice, 'Records refreshed.');
  assert.ok(records.lastChecked instanceof Date);
});

test('background polling waits for the first snapshot so an initial load keeps Retry available', async t => {
  let poll!: () => void;
  t.mock.method(window, 'setInterval', (callback: () => void) => { poll = callback; return 1; });
  t.mock.method(window, 'clearInterval', () => {});
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return reads === 1 ? Response.json({ error: 'Records unavailable' }, { status: 503 }) : Response.json(fixture());
  };
  await act(async () => root.render(createElement(Harness)));
  assert.equal(records.state, null);
  assert.match(records.error, /Records unavailable/);
  await act(async () => poll());
  assert.equal(reads, 1);
  assert.equal(records.refreshing, false);
  await act(async () => records.refresh());
  assert.deepEqual(records.state, fixture());
  await act(async () => poll());
  assert.equal(reads, 3);
});

test('a delayed refresh cannot replace a newer saved revision', async () => {
  const pending = deferred<Response>();
  let reads = 0;
  let sent: Command | undefined;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      sent = JSON.parse(String(init.body));
      return Response.json(fixture(3));
    }
    return ++reads === 1 ? Response.json(fixture(1)) : pending.promise;
  };
  await act(async () => root.render(createElement(Harness)));
  let refresh!: Promise<void>;
  await act(async () => { refresh = records.refresh(false); });
  await act(async () => records.command(change));
  assert.equal(sent?.expectedRevision, 1);
  assert.equal(records.state?.revision, 3);
  await act(async () => { pending.resolve(Response.json(fixture(2))); await refresh; });
  assert.equal(records.state?.revision, 3);
  assert.equal(records.notice, 'Saved.');
  assert.equal(resets, 1);
});

test('switching to a snapshot replaces personal records and disables writes and background reads', async () => {
  let source = 'personal';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(fixture(source === 'personal' ? 8 : 2), { headers: { 'X-Mazal-Data-Source': source } });
  };
  await act(async () => root.render(createElement(Harness)));
  source = 'snapshot';
  await act(async () => records.refresh(false));
  assert.equal(records.state?.revision, 2);
  assert.equal(records.readOnly, true);
  assert.equal(resets, 2);
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.equal(calls, 2);
  await assert.rejects(records.command(change), /read-only/);
  assert.equal(calls, 2);
});

test('a foreground event retries an in-flight locked read once the first response arrives', async () => {
  const pending = deferred<Response>();
  let reads = 0;
  globalThis.fetch = async () => ++reads === 1 ? Response.json(fixture(1)) : reads === 2 ? pending.promise : Response.json(fixture(2));
  await act(async () => root.render(createElement(Harness)));
  let refresh!: Promise<void>;
  await act(async () => { refresh = records.refresh(false); });
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.equal(reads, 2);
  await act(async () => { pending.resolve(Response.json({ error: 'Locked' }, { status: 401 })); await refresh; });
  assert.equal(reads, 3);
  assert.equal(records.state?.revision, 2);
  assert.equal(records.error, '');
  assert.equal(records.refreshing, false);
});

test('a newer manual refresh aborts and ignores the previous read', async () => {
  const pending = deferred<Response>();
  let reads = 0;
  let previousSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => {
    reads++;
    if (reads === 2) { previousSignal = init?.signal; return pending.promise; }
    return Response.json(fixture(reads === 1 ? 1 : 4));
  };
  await act(async () => root.render(createElement(Harness)));
  let first!: Promise<void>;
  await act(async () => { first = records.refresh(false); });
  await act(async () => { await records.refresh(); await first; });
  assert.equal(previousSignal?.aborted, true);
  await act(async () => { pending.resolve(Response.json(fixture(9))); });
  assert.equal(records.state?.revision, 4);
  assert.equal(records.error, '');
  assert.equal(records.refreshing, false);
});

test('workspace changes ignore an old save response and unmount removes refresh subscriptions', async () => {
  const pending = deferred<Response>();
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (init?.method === 'POST') return pending.promise;
    return Response.json(fixture(1, String(url).includes('workspace=demo') ? 'demo' : 'live'));
  };
  await act(async () => root.render(createElement(Harness)));
  let save!: Promise<void>;
  await act(async () => { save = records.command(change); });
  await act(async () => root.render(createElement(Harness, { workspace: 'demo' })));
  await act(async () => { pending.resolve(Response.json(fixture(12))); await save; });
  assert.equal(records.state?.workspace, 'demo');
  assert.equal(records.state?.revision, 1);
  assert.equal(records.notice, '');
  assert.equal(resets, 2);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.equal(calls, 3);
});
