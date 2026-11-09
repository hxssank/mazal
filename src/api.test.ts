import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, Command } from '../shared/types.ts';
import { loadState, sendCommand, StateRequestError } from './services/api.ts';
import { CommandRejectedError, isConfirmedCommandRejection } from './services/command-errors.ts';

const state: AppState = {
  workspace: 'live', revision: 1, entities: [], accounts: [], transactions: [],
  obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null,
};

test('state reads bypass the cache and forward cancellation', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/state?workspace=live');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return Response.json(state);
  });
  assert.deepEqual(await loadState('live', controller.signal), state);
});

test('a stalled state request times out and the next read can recover', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal: AbortSignal | undefined;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requestSignal = options.signal!;
    return new Promise<Response>(() => {});
  });
  const pending = loadState('live');
  const rejected = assert.rejects(pending, /timed out after 15 seconds.*Retry/);
  t.mock.timers.tick(14_999);
  assert.equal(requestSignal!.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(requestSignal!.aborted, true);
  fetchMock.mock.mockImplementation(async () => Response.json(state));
  assert.deepEqual(await loadState('live'), state);
});

test('the state deadline also bounds a stalled response body and ignores its late result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completeBody!: (value: unknown) => void;
  const response = Response.json(state, { headers: { 'X-Mazal-Data-Source': 'snapshot' } });
  t.mock.method(response, 'json', () => new Promise(resolve => { completeBody = resolve; }));
  t.mock.method(globalThis, 'fetch', async () => response);
  const sources: string[] = [];
  const pending = loadState('live', undefined, source => sources.push(source));
  const rejected = assert.rejects(pending, /timed out after 15 seconds/);
  await Promise.resolve();
  t.mock.timers.tick(15_000);
  await rejected;
  completeBody(state);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(sources, []);
});

test('external cancellation aborts a stalled state read with the caller reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requestSignal = options.signal!;
    return new Promise<Response>(() => {});
  });
  const pending = loadState('live', controller.signal);
  const reason = new DOMException('Replaced by a newer refresh', 'AbortError');
  const rejected = assert.rejects(pending, error => error === reason);
  controller.abort(reason);
  await rejected;
  assert.equal(requestSignal!.reason, reason);
  t.mock.timers.tick(15_000);
  assert.equal(requestSignal!.reason, reason);
});

test('completed state reads remove their deadline and external cancellation listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requestSignal = options.signal!;
    return Response.json(state);
  });
  assert.deepEqual(await loadState('live', controller.signal), state);
  controller.abort();
  t.mock.timers.tick(15_000);
  assert.equal(requestSignal!.aborted, false);
});

test('sample and snapshot data are identified independently of the workspace name without changing saved records', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(state, { headers: { 'X-Mazal-Data-Source': 'sample' } }));
  const sources: string[] = [];
  assert.deepEqual(await loadState('live', undefined, source => sources.push(source)), state);
  fetchMock.mock.mockImplementation(async () => Response.json(state));
  await loadState('live', undefined, source => sources.push(source));
  fetchMock.mock.mockImplementation(async () => Response.json(state, { headers: { 'X-Mazal-Data-Source': 'snapshot' } }));
  assert.deepEqual(await loadState('live', undefined, source => sources.push(source)), state);
  fetchMock.mock.mockImplementation(async () => Response.json({ ...state, workspace: 'demo' }));
  await loadState('demo', undefined, source => sources.push(source));
  assert.deepEqual(sources, ['sample', 'personal', 'snapshot', 'sample']);
});

test('conditional reads reuse only their exact validated baseline without parsing an unchanged body', async t => {
  const etag = '"records-one"';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(state, { headers: { ETag: etag } }));
  const baseline = await loadState('live');
  const response = new Response(null, { status: 304, headers: { ETag: etag } });
  const body = t.mock.method(response, 'json', async () => { throw new Error('An unchanged response has no JSON body.'); });
  fetchMock.mock.mockImplementation(async (_url: RequestInfo | URL, options: RequestInit = {}) => {
    assert.equal(new Headers(options.headers).get('If-None-Match'), etag);
    assert.equal(options.cache, 'no-store');
    return response;
  });
  const sources: string[] = [];
  assert.equal(await loadState('live', undefined, source => sources.push(source), baseline), baseline);
  assert.equal(body.mock.callCount(), 0);
  assert.deepEqual(sources, ['personal']);
});

test('a changed response replaces its token and accepts updated backup metadata at the same revision', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(state, { headers: { ETag: '"before-backup"' } }));
  const baseline = await loadState('live');
  const updated = { ...state, lastBackupAt: '2026-10-19T12:00:00.000Z' };
  fetchMock.mock.mockImplementation(async (_url: RequestInfo | URL, options: RequestInit = {}) => {
    assert.equal(new Headers(options.headers).get('If-None-Match'), '"before-backup"');
    return Response.json(updated, { headers: { ETag: '"after-backup"' } });
  });
  const next = await loadState('live', undefined, undefined, baseline);
  assert.notEqual(next, baseline);
  assert.deepEqual(next, updated);
  fetchMock.mock.mockImplementation(async (_url: RequestInfo | URL, options: RequestInit = {}) => {
    assert.equal(new Headers(options.headers).get('If-None-Match'), '"after-backup"');
    return new Response(null, { status: 304, headers: { ETag: '"after-backup"' } });
  });
  assert.equal(await loadState('live', undefined, undefined, next), next);
});

test('conditional tokens cannot cross workspaces or follow copied and mutation-returned state', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(state, { headers: { ETag: '"live-records"' } }));
  const baseline = await loadState('live');
  fetchMock.mock.mockImplementation(async (url: RequestInfo | URL, options: RequestInit = {}) => {
    assert.equal(new Headers(options.headers).get('If-None-Match'), null);
    return Response.json({ ...state, workspace: String(url).includes('workspace=demo') ? 'demo' : 'live' });
  });
  await loadState('demo', undefined, undefined, baseline);
  await loadState('live', undefined, undefined, { ...baseline });
  const changed = await sendCommand('live', { type: 'remove_reserve', id: 'old', expectedRevision: 1 }, baseline);
  await loadState('live', undefined, undefined, changed);
});

test('a source change on an unchanged response requires a full read before reusing records', async t => {
  const etag = '"same-records"';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(state, { headers: { ETag: etag } }));
  const baseline = await loadState('live');
  let reads = 0;
  fetchMock.mock.mockImplementation(async (_url: RequestInfo | URL, options: RequestInit = {}) => {
    reads++;
    assert.equal(new Headers(options.headers).get('If-None-Match'), reads === 1 ? etag : null);
    return reads === 1 ? new Response(null, { status: 304, headers: { ETag: etag, 'X-Mazal-Data-Source': 'snapshot' } }) : Response.json(state, { headers: { ETag: etag, 'X-Mazal-Data-Source': 'snapshot' } });
  });
  const sources: string[] = [];
  const next = await loadState('live', undefined, source => sources.push(source), baseline);
  assert.notEqual(next, baseline);
  assert.deepEqual(next, state);
  assert.equal(reads, 2);
  assert.deepEqual(sources, ['snapshot']);
});

test('unexpected unchanged responses never substitute an unrelated baseline', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 304, headers: { ETag: '"unmatched"' } }));
  await assert.rejects(loadState('live'), /incomplete records/);
  await assert.rejects(loadState('live', undefined, undefined, state), /incomplete records/);
  fetchMock.mock.mockImplementation(async () => Response.json(state, { headers: { ETag: '"matching"' } }));
  const baseline = await loadState('live');
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 304, headers: { ETag: '"unmatched"' } }));
  await assert.rejects(loadState('live', undefined, undefined, baseline), /incomplete records/);
});

test('conditional reads still require authentication and do not hide a locked response', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(state, { headers: { ETag: '"records"' } }));
  const baseline = await loadState('live');
  const sources: string[] = [];
  fetchMock.mock.mockImplementation(async () => Response.json({ error: 'Mazal is locked.' }, { status: 401 }));
  await assert.rejects(loadState('live', undefined, source => sources.push(source), baseline), error => error instanceof StateRequestError && error.status === 401);
  assert.deepEqual(sources, []);
});

test('cancellation rejects a late unchanged response before notifying the data source', async t => {
  const etag = '"records"';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(state, { headers: { ETag: etag } }));
  const baseline = await loadState('live');
  const controller = new AbortController();
  let complete!: (response: Response) => void;
  fetchMock.mock.mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
  const sources: string[] = [];
  const pending = loadState('live', controller.signal, source => sources.push(source), baseline);
  const reason = new DOMException('Newer read started', 'AbortError');
  const rejected = assert.rejects(pending, error => error === reason);
  controller.abort(reason);
  await rejected;
  complete(new Response(null, { status: 304, headers: { ETag: etag } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sources, []);
});

test('a conditional source-change retry shares the original deadline and ignores its late body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const etag = '"records"';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(state, { headers: { ETag: etag } }));
  const baseline = await loadState('live');
  let reads = 0;
  let complete!: (response: Response) => void;
  let retrySignal: AbortSignal | undefined;
  fetchMock.mock.mockImplementation(async (_url: RequestInfo | URL, options: RequestInit = {}) => {
    if (++reads === 1) return new Response(null, { status: 304, headers: { ETag: etag, 'X-Mazal-Data-Source': 'snapshot' } });
    retrySignal = options.signal!;
    return new Promise<Response>(resolve => { complete = resolve; });
  });
  const sources: string[] = [];
  const pending = loadState('live', undefined, source => sources.push(source), baseline);
  const rejected = assert.rejects(pending, /timed out after 15 seconds/);
  await Promise.resolve();
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(retrySignal!.aborted, true);
  const response = Response.json(state, { headers: { ETag: etag, 'X-Mazal-Data-Source': 'snapshot' } });
  const body = t.mock.method(response, 'json', async () => state);
  complete(response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(body.mock.callCount(), 0);
  assert.deepEqual(sources, []);
});

test('aborted reads retain the cancellation instead of reporting a server outage', async t => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async () => { throw controller.signal.reason; });
  await assert.rejects(loadState('live', controller.signal), { name: 'AbortError' });
});

test('HTML proxy errors and disconnected reads report how to recover', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(loadState('live'), /Check that the local server is running/);
  fetchMock.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(loadState('live'), /Check that the local server is running/);
});

test('cancellation while reading the response body retains AbortError', async t => {
  const controller = new AbortController();
  const response = Response.json(state);
  t.mock.method(response, 'json', async () => {
    controller.abort();
    throw controller.signal.reason;
  });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(loadState('live', controller.signal), { name: 'AbortError' });
});

test('successful responses reject the wrong workspace, missing lists and unsafe revisions', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ ...state, workspace: 'demo' }));
  await assert.rejects(loadState('live'), /incomplete records/);
  for (const invalid of [{ ...state, accounts: null }, { ...state, revision: -1 }, { ...state, revision: 1.5 }, null]) {
    fetchMock.mock.mockImplementation(async () => Response.json(invalid));
    await assert.rejects(loadState('live'), /incomplete records/);
  }
});

test('commands preserve request identity and revision and return the saved state', async t => {
  const command: Command = {
    type: 'add_transaction', requestId: 'same-request', expectedRevision: 0,
    kind: 'expense', accountId: 'cash', amountCents: 100, date: '2026-09-01',
    description: 'Test purchase', category: 'Other',
  };
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/command?workspace=live');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(String(options.body)), command);
    return Response.json(state);
  });
  assert.deepEqual(await sendCommand('live', command), state);
});

test('a stalled command times out as an uncertain save and preserves its identity for a manual retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const command: Command = { type: 'add_reserve', entityId: 'personal', name: 'Buffer', amountCents: 500, requestId: 'same-reserve', expectedRevision: 1 };
  const requests: RequestInit[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requests.push(options);
    return new Promise<Response>(() => {});
  });
  const rejected = assert.rejects(sendCommand('live', command, state), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 60 seconds.*could not confirm whether the change was saved/);
    assert.equal(isConfirmedCommandRejection(error), false);
    return true;
  });
  t.mock.timers.tick(59_999);
  assert.equal(requests[0].signal!.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(requests[0].signal!.aborted, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(String(requests[0].body)), command);
  fetchMock.mock.mockImplementation(async (_url: string, options: RequestInit) => {
    requests.push(options);
    return Response.json({ ...state, revision: 2 });
  });
  assert.equal((await sendCommand('live', command, state)).revision, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body, requests[0].body);
  assert.deepEqual(requests[1].headers, requests[0].headers);
  assert.equal(requests[1].signal!.aborted, false);
});

test('a late command response cannot read a body or report success after its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete!: (response: Response) => void;
  const response = Response.json({ ...state, revision: 2 });
  const readBody = t.mock.method(response, 'json', async () => ({ ...state, revision: 2 }));
  const fetchMock = t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { complete = resolve; }));
  let accepted = false;
  const pending = sendCommand('live', { type: 'remove_reserve', id: 'old', expectedRevision: 1 });
  void pending.then(() => { accepted = true; }, () => {});
  const rejected = assert.rejects(pending, /could not confirm whether the change was saved/);
  t.mock.timers.tick(60_000);
  await rejected;
  complete(response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted, false);
  assert.equal(readBody.mock.callCount(), 0);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('the command deadline bounds a stalled body and prevents late delta recovery reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completeBody!: (value: unknown) => void;
  const response = Response.json(state);
  t.mock.method(response, 'json', () => new Promise(resolve => { completeBody = resolve; }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response);
  let accepted = false;
  const pending = sendCommand('live', { type: 'remove_reserve', id: 'old', expectedRevision: 1 }, state);
  void pending.then(() => { accepted = true; }, () => {});
  const rejected = assert.rejects(pending, error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 60 seconds/);
    assert.equal(isConfirmedCommandRejection(error), false);
    return true;
  });
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  await rejected;
  completeBody({ format: 'mazal-state-changes', workspace: 'live', baseRevision: 5, revision: 6, changes: { reserves: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted, false);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('the command deadline also cancels an in-progress delta recovery read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete!: (response: Response) => void;
  let readSignal: AbortSignal | undefined;
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, options: RequestInit) => {
    requests.push(url);
    if (url.includes('/command')) return new Promise<Response>(resolve => { complete = resolve; });
    readSignal = options.signal!;
    return new Promise<Response>(() => {});
  });
  const pending = sendCommand('live', { type: 'remove_reserve', id: 'old', expectedRevision: 1 }, state);
  const rejected = assert.rejects(pending, /timed out after 60 seconds.*could not confirm whether the change was saved/);
  t.mock.timers.tick(55_000);
  complete(Response.json({ format: 'mazal-state-changes', workspace: 'live', baseRevision: 5, revision: 6, changes: { reserves: [] } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readSignal!.aborted, false);
  t.mock.timers.tick(5_000);
  await rejected;
  assert.equal(readSignal!.aborted, true);
  assert.deepEqual(requests, ['/api/command?workspace=live', '/api/state?workspace=live']);
});

test('completed commands clear their deadlines and keep confirmed rejections typed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    signals.push(options.signal!);
    return Response.json(state);
  });
  assert.deepEqual(await sendCommand('live', { type: 'remove_reserve', id: 'old', expectedRevision: 1 }), state);
  fetchMock.mock.mockImplementation(async (_url: string, options: RequestInit) => {
    signals.push(options.signal!);
    return Response.json({ error: 'Records changed in another window.' }, { status: 409 });
  });
  await assert.rejects(sendCommand('live', { type: 'remove_reserve', id: 'old', expectedRevision: 1 }), error => {
    assert.ok(error instanceof CommandRejectedError);
    assert.equal(error.status, 409);
    assert.equal(isConfirmedCommandRejection(error), true);
    return true;
  });
  t.mock.timers.tick(180_000);
  assert.deepEqual(signals.map(signal => signal.aborted), [false, false]);
});

test('backup restore bypasses the command envelope and sends its revision separately', async t => {
  const backup = { format: 'mazal-backup', version: 1, workspace: 'live', data: {} };
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/backup/restore?workspace=live');
    assert.equal(options.method, 'POST');
    assert.equal((options.headers as Record<string, string>)['X-Mazal-Revision'], '1');
    assert.deepEqual(JSON.parse(String(options.body)), backup);
    return Response.json({ ...state, revision: 2 });
  });
  assert.equal((await sendCommand('live', { type: 'restore', backup, expectedRevision: 1 })).revision, 2);
});

test('backup restore has a longer bounded wait without changing its backup or revision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backup = { format: 'mazal-backup', version: 1, workspace: 'live', data: {} };
  let request: RequestInit | undefined;
  const fetchMock = t.mock.method(globalThis, 'fetch', (url: string, options: RequestInit) => {
    assert.equal(url, '/api/backup/restore?workspace=live');
    request = options;
    return new Promise<Response>(() => {});
  });
  const rejected = assert.rejects(sendCommand('live', { type: 'restore', backup, expectedRevision: 1 }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 3 minutes.*could not confirm whether the change was saved/);
    assert.equal(isConfirmedCommandRejection(error), false);
    return true;
  });
  t.mock.timers.tick(60_000);
  assert.equal(request!.signal!.aborted, false);
  t.mock.timers.tick(119_999);
  assert.equal(request!.signal!.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(request!.signal!.aborted, true);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal((request!.headers as Record<string, string>)['X-Mazal-Revision'], '1');
  assert.deepEqual(JSON.parse(String(request!.body)), backup);
});

test('server validation and revision conflict messages reach the form', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Records changed in another window.' }, { status: 409 }));
  await assert.rejects(sendCommand('live', { type: 'remove_reserve', id: 'reserve' }), /changed in another window/);
});

test('uncertain writes ask for a refresh and never retry automatically', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(sendCommand('live', { type: 'remove_reserve', id: 'reserve' }), /could not confirm whether the change was saved/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('non-JSON write responses do not claim that the operation failed before saving', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Bad gateway', { status: 502 }));
  await assert.rejects(sendCommand('live', { type: 'remove_reserve', id: 'reserve' }), /Refresh your records before trying again/);
});

test('command changes merge only into their exact baseline and preserve unchanged ledger records', async t => {
  const baseline = { ...state, revision: 5 };
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal((options.headers as Record<string, string>)['X-Mazal-State-Changes'], '1');
    return Response.json({ format: 'mazal-state-changes', workspace: 'live', baseRevision: 5, revision: 6, changes: { reserves: [{ id: 'buffer', entityId: 'personal', name: 'Buffer', amountCents: 500 }] } });
  });
  const result = await sendCommand('live', { type: 'add_reserve', entityId: 'personal', name: 'Buffer', amountCents: 500, expectedRevision: 5 }, baseline);
  assert.equal(result.revision, 6);
  assert.equal(result.transactions, baseline.transactions);
  assert.equal(result.reserves[0].amountCents, 500);
  assert.equal(baseline.reserves.length, 0);
});

test('a delta with a different baseline reads the latest state instead of mixing revisions', async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requests.push(url);
    return Response.json(url.includes('/command')
      ? { format: 'mazal-state-changes', workspace: 'live', baseRevision: 5, revision: 6, changes: { reserves: [] } }
      : { ...state, revision: 7 });
  });
  assert.equal((await sendCommand('live', { type: 'remove_reserve', id: 'old' }, state)).revision, 7);
  assert.deepEqual(requests, ['/api/command?workspace=live', '/api/state?workspace=live']);
});

test('malformed command changes cannot replace the workspace, revision or collections', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  for (const changes of [{ workspace: 'demo' }, { revision: 100 }, { transactions: null }, { unexpected: [] }]) {
    fetchMock.mock.mockImplementation(async () => Response.json({ format: 'mazal-state-changes', workspace: 'live', baseRevision: 1, revision: 2, changes }));
    await assert.rejects(sendCommand('live', { type: 'remove_reserve', id: 'old' }, state), /incomplete records/);
  }
});
