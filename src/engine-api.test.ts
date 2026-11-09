import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineIdentity } from '../shared/engine.ts';
import { cancelEngineRun, EngineRequestError, getEngineRun, getEngineSummary, projectEngine, startEngineRun } from './services/engine-api.ts';

const identity: EngineIdentity = { workspace: 'demo', scope: 'personal', expectedRevision: 1, asOf: '2026-10-16' };
const run = { id: 'test-run', workspace: 'demo', status: 'running' };
const deadline = 125_000;
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

test('stalled engine reads allow cold startup, then time out without retrying and can recover on demand', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal: AbortSignal | undefined;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requestSignal = options.signal!;
    return new Promise<Response>(() => {});
  });
  const pending = getEngineRun(run.id, 'demo');
  const rejected = assert.rejects(pending, /timed out after 125 seconds.*Retry/);
  t.mock.timers.tick(120_000);
  assert.equal(requestSignal!.aborted, false);
  t.mock.timers.tick(4_999);
  assert.equal(requestSignal!.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(requestSignal!.aborted, true);
  t.mock.timers.tick(deadline);
  assert.equal(fetchMock.mock.callCount(), 1);
  fetchMock.mock.mockImplementation(async () => Response.json(run));
  assert.deepEqual(await getEngineRun(run.id, 'demo'), run);
});

for (const [name, start] of [
  ['summary', () => getEngineSummary(identity)],
  ['projection', () => projectEngine(identity, { kind: 'daily_plan', draft: { days: 30 } })],
  ['run creation', () => startEngineRun(identity, { seed: 42 })],
  ['run cancellation', () => cancelEngineRun(run.id, 'demo')],
] as const) test(`${name} requests also stop waiting at the engine deadline`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(() => {}));
  const rejected = assert.rejects(start(), /timed out after 125 seconds/);
  t.mock.timers.tick(deadline);
  await rejected;
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('a stalled engine response body times out and its late result cannot resolve the request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completeBody!: (value: unknown) => void;
  const response = Response.json(run);
  t.mock.method(response, 'json', () => new Promise(resolve => { completeBody = resolve; }));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => response);
  const pending = getEngineRun(run.id, 'demo');
  let resolved = false;
  void pending.then(() => { resolved = true; }, () => {});
  const rejected = assert.rejects(pending, /timed out after 125 seconds/);
  await flush();
  t.mock.timers.tick(deadline);
  await rejected;
  completeBody(run);
  await flush();
  assert.equal(resolved, false);
  assert.equal(fetchMock.mock.callCount(), 1);
});

for (const stage of ['fetch', 'body'] as const) test(`caller cancellation settles a stalled engine ${stage} with the original reason`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const caller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const response = Response.json(run);
  t.mock.method(response, 'json', () => new Promise(() => {}));
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requestSignal = options.signal!;
    return stage === 'body' ? response : new Promise<Response>(() => {});
  });
  const pending = getEngineRun(run.id, 'demo', caller.signal);
  const reason = new DOMException('Replaced by another calculation', 'AbortError');
  const rejected = assert.rejects(pending, error => error === reason);
  await flush();
  caller.abort(reason);
  await rejected;
  assert.equal(requestSignal!.reason, reason);
  t.mock.timers.tick(deadline);
  assert.equal(requestSignal!.reason, reason);
});

test('an already cancelled engine request never starts a fetch', async t => {
  const caller = new AbortController();
  const reason = new DOMException('Page closed', 'AbortError');
  caller.abort(reason);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json(run));
  await assert.rejects(getEngineRun(run.id, 'demo', caller.signal), error => error === reason);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('cancellation reported by response.json keeps the caller reason', async t => {
  const caller = new AbortController();
  const reason = new DOMException('Page closed during response', 'AbortError');
  const response = Response.json(run);
  t.mock.method(response, 'json', async () => { caller.abort(reason); throw reason; });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(getEngineRun(run.id, 'demo', caller.signal), error => error === reason);
});

test('completed engine requests remove their deadline and caller cancellation listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const caller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requestSignal = options.signal!;
    assert.equal(options.cache, 'no-store');
    return Response.json(run);
  });
  assert.deepEqual(await getEngineRun(run.id, 'demo', caller.signal), run);
  caller.abort();
  t.mock.timers.tick(deadline);
  assert.equal(requestSignal!.aborted, false);
});

test('engine errors preserve HTTP status and distinguish network and unreadable responses', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Unlock Mazal.' }, { status: 401 }));
  for (const status of [401, 409, 503]) {
    fetchMock.mock.mockImplementation(async () => Response.json({ error: `Engine status ${status}` }, { status }));
    await assert.rejects(getEngineRun(run.id, 'demo'), error => error instanceof EngineRequestError && error.status === status && error.message === `Engine status ${status}`);
  }
  fetchMock.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(getEngineRun(run.id, 'demo'), /Python engine is unavailable/);
  fetchMock.mock.mockImplementation(async () => new Response('<html>Unavailable</html>', { status: 502 }));
  await assert.rejects(getEngineRun(run.id, 'demo'), /unreadable result/);
  assert.equal(fetchMock.mock.callCount(), 5);
});

for (const stage of ['fetch', 'body'] as const) for (const cancellation of ['timeout', 'caller'] as const) test(`late run creation ${stage} after ${cancellation} cancels its active worker once`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const caller = new AbortController();
  let completeFetch!: (response: Response) => void;
  let completeBody!: (value: unknown) => void;
  const response = Response.json(run);
  if (stage === 'body') t.mock.method(response, 'json', () => new Promise(resolve => { completeBody = resolve; }));
  const requests: { url: string; method: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests.push({ url, method: options.method! });
    if (options.method === 'DELETE') return Response.json({ ...run, status: 'cancelled' });
    assert.deepEqual(JSON.parse(String(options.body)), { ...identity, kind: 'comparison', assumptions: { seed: 42 } });
    return stage === 'body' ? response : new Promise<Response>(resolve => { completeFetch = resolve; });
  });
  const pending = startEngineRun(identity, { seed: 42 }, caller.signal);
  const reason = new DOMException('No longer needed', 'AbortError');
  const rejected = assert.rejects(pending, error => cancellation === 'caller' ? error === reason : error instanceof Error && /timed out after 125 seconds/.test(error.message));
  await flush();
  if (cancellation === 'caller') caller.abort(reason);
  else t.mock.timers.tick(deadline);
  await rejected;
  assert.equal(requests.length, 1);
  if (stage === 'body') completeBody({ ...run, status: 'queued' });
  else completeFetch(response);
  await flush();
  assert.deepEqual(requests, [{ url: '/api/engine/runs?workspace=demo', method: 'POST' }, { url: '/api/engine/runs/test-run?workspace=demo', method: 'DELETE' }]);
  t.mock.timers.tick(deadline);
  assert.equal(requests.length, 2);
});

for (const value of [
  { ...run, workspace: 'live' },
  { id: run.id, status: 'running' },
  { ...run, id: '../wrong' },
  { ...run, progress: {} },
  { ...run, status: 'completed' },
  { ...run, status: 'cancelled' },
]) test(`late run cleanup ignores ${JSON.stringify(value)}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete!: (response: Response) => void;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { complete = resolve; }));
  const rejected = assert.rejects(startEngineRun(identity, { seed: 42 }), /timed out after 125 seconds/);
  t.mock.timers.tick(deadline);
  await rejected;
  complete(Response.json(value));
  await flush();
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('late run cleanup failure never retries or changes the original timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete!: (response: Response) => void;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    if (options.method === 'DELETE') throw new TypeError('Service stopped');
    return new Promise<Response>(resolve => { complete = resolve; });
  });
  const rejected = assert.rejects(startEngineRun(identity, { seed: 42 }), /timed out after 125 seconds/);
  t.mock.timers.tick(deadline);
  await rejected;
  complete(Response.json(run));
  await flush();
  t.mock.timers.tick(deadline);
  assert.equal(fetchMock.mock.callCount(), 2);
});
