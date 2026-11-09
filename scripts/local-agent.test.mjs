import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalAgentError, parseAgentArguments, readAgentToken, runLocalAgent } from './local-agent.mjs';

const token = 'a7'.repeat(32);
const base = 'http://127.0.0.1:5196';
const refused = () => new Error('Connection refused', { cause: { code: 'ECONNREFUSED' } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const runtimeBuild = { format: 'mazal-runtime-build', schemaVersion: 1, startedAt: '2026-10-19T12:00:00.000Z', processId: 1234, identityStatus: 'available', build: { version: '0.2.0-rc.3', sourceSha256: 'a'.repeat(64), assetsSha256: 'b'.repeat(64), nodeVersion: '24.22.0', pythonVersion: '3.13.16' } };

function proof(url, secret = token) {
  const challenge = new URL(url).searchParams.get('challenge');
  assert.match(challenge, /^[a-f0-9]{64}$/);
  return json({ ready: true, proof: createHmac('sha256', secret).update(`mazal-local-agent:${challenge}`).digest('hex') });
}

function fixture(handler = (url) => {
  if (url.startsWith(`${base}/api/desktop/agent-health?`)) return proof(url);
  if (url === `${base}/api/state?workspace=live`) return json({ revision: 17, privateValue: 'must not appear in status' });
  if (url === `${base}/api/build-status`) return json(runtimeBuild);
  if (url === `${base}/`) return new Response('Locked', { status: 401 });
  throw new Error('Unexpected request');
}) {
  const calls = [], starts = [];
  const options = {
    readToken: async () => token,
    fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init); },
    startApp: async path => { starts.push(path); },
  };
  return { options, calls, starts };
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'mazal-agent-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('credentials require a private regular same-owner file and preserve token case', { skip: !process.getuid }, async t => {
  const root = await directory(t), path = join(root, 'credential');
  await writeFile(path, `${token.toUpperCase()}\n`, { mode: 0o600 });
  assert.equal(await readAgentToken(path), token.toUpperCase());
  await assert.rejects(readAgentToken(path, process.getuid() + 1), LocalAgentError);
  await chmod(path, 0o644);
  await assert.rejects(readAgentToken(path), /private credential/);
  await chmod(path, 0o600);
  for (const content of ['a'.repeat(63), 'a'.repeat(130), 'not-a-credential', `${token}\n\n`, `${token}\r\n`]) {
    await writeFile(path, content);
    await assert.rejects(readAgentToken(path), error => error instanceof LocalAgentError && !error.message.includes(content));
  }
  await mkdir(join(root, 'directory'));
  await assert.rejects(readAgentToken(join(root, 'directory')), /private credential/);
  await assert.rejects(readAgentToken(join(root, 'missing')), /private credential/);
});

test('credential reads refuse symlinks without reading their target', { skip: !process.getuid }, async t => {
  const root = await directory(t), target = join(root, 'private'), link = join(root, 'link');
  await writeFile(target, token, { mode: 0o600 });
  await symlink(target, link);
  await assert.rejects(readAgentToken(link), /private credential/);
  assert.equal(await readFile(target, 'utf8'), token);
});

test('credentials fail closed when file ownership cannot be checked', async t => {
  const root = await directory(t), path = join(root, 'credential');
  await writeFile(path, token, { mode: 0o600 });
  await assert.rejects(readAgentToken(path, NaN), /private credential/);
  if (!process.getuid) await assert.rejects(readAgentToken(path), /private credential/);
});

test('request validation permits local API paths and blocks desktop access and path escapes', () => {
  assert.deepEqual(parseAgentArguments(['status']), { mode: 'status' });
  assert.equal(parseAgentArguments(['get', '/api/state?workspace=live']).url, `${base}/api/state?workspace=live`);
  for (const path of ['http://example.com/api/state', '//example.com/api/state', '/', '/api', '/api/desktop', '/api/desktop/unlock', '/api/%64esktop/lock', '/api/DESKTOP/lock', '/api/../api/state', '/api/%2e%2e/state', '/api/desktop%2funlock', '/api/%252e%252e/state', '/api/state#fragment', '/api/state\n', '/api/state\\escape']) {
    assert.throws(() => parseAgentArguments(['POST', path]), LocalAgentError, path);
  }
  for (const args of [[], ['TRACE', '/api/state'], ['status', '--output', 'out'], ['GET', '/api/state', '--body-file', 'body'], ['POST', '/api/action', '--output'], ['POST', '/api/action', '--unknown', 'value'], ['POST', '/api/action', '--output', 'a', '--output', 'b'], ['POST', '/api/action', '--content-type', 'application/json'], ['POST', '/api/action', '--body-file', 'body', '--content-type', 'application/json\r\nAuthorization: secret']]) {
    assert.throws(() => parseAgentArguments(args), LocalAgentError);
  }
});

test('status authenticates only after service proof and reports browser protection without unlocking', async () => {
  const { options, calls, starts } = fixture();
  const result = await runLocalAgent(['status'], options);
  assert.deepEqual(result, { status: { serverHealthy: true, revision: 17, protectedUi: true, unauthenticatedUiStatus: 401, runtimeBuild } });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].init.headers, undefined);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[2].init.headers, undefined);
  assert.equal(calls[3].url, `${base}/api/build-status`);
  assert.equal(calls[3].init.headers.Authorization, `Bearer ${token}`);
  assert.ok(calls.every(call => call.init.redirect === 'manual' && call.init.signal));
  assert.deepEqual(starts, []);
  assert.ok(calls.every(call => !call.url.includes(token)));
});

test('status compares both expected build hashes and rejects invalid expectation flags before connecting', async () => {
  const args = ['status', '--expect-source', runtimeBuild.build.sourceSha256, '--expect-assets', runtimeBuild.build.assetsSha256];
  assert.deepEqual(parseAgentArguments(args), { mode: 'status', expectedSource: runtimeBuild.build.sourceSha256, expectedAssets: runtimeBuild.build.assetsSha256 });
  const { options } = fixture();
  assert.equal((await runLocalAgent(args, options)).status.runtimeBuild.build.sourceSha256, runtimeBuild.build.sourceSha256);
  for (const flag of ['--expect-source', '--expect-assets']) {
    await assert.rejects(runLocalAgent(['status', flag, 'c'.repeat(64)], options), /running .* SHA-256.*expected/);
    for (const invalid of [undefined, 'short', 'x'.repeat(64), 'A'.repeat(64)]) assert.throws(() => parseAgentArguments(['status', flag, ...(invalid === undefined ? [] : [invalid])]), LocalAgentError);
    assert.throws(() => parseAgentArguments(['status', flag, 'a'.repeat(64), flag, 'b'.repeat(64)]), LocalAgentError);
  }
  assert.throws(() => parseAgentArguments(['status', '__proto__', 'a'.repeat(64)]), LocalAgentError);
});

test('unknown running identity remains visible and cannot pass an expected-build check', async () => {
  for (const identityStatus of ['missing', 'invalid']) {
    const unknown = { ...runtimeBuild, identityStatus, build: null };
    const { options } = fixture(url => {
      if (url.includes('/agent-health?')) return proof(url);
      if (url.includes('/api/state?')) return json({ revision: 17 });
      if (url.endsWith('/api/build-status')) return json(unknown);
      return new Response('Locked', { status: 401 });
    });
    assert.deepEqual((await runLocalAgent(['status'], options)).status.runtimeBuild, unknown);
    for (const flag of ['--expect-source', '--expect-assets']) await assert.rejects(runLocalAgent(['status', flag, 'a'.repeat(64)], options), /could not be confirmed/);
  }
});

test('runtime build checks reject redirects, malformed identities and unavailable endpoints without exposing responses', async () => {
  const responses = [
    () => new Response(token, { status: 404 }),
    () => new Response(token, { status: 302, headers: { Location: 'http://example.com' } }),
    () => new Response(token),
    () => json({ ...runtimeBuild, build: null }),
    () => json({ ...runtimeBuild, identityStatus: 'missing' }),
    () => json({ ...runtimeBuild, processId: 0 }),
    () => json({ ...runtimeBuild, startedAt: token }),
    () => json({ ...runtimeBuild, build: { ...runtimeBuild.build, sourceSha256: token.slice(0, 63) } }),
    () => json({ ...runtimeBuild, build: { ...runtimeBuild.build, assetsSha256: null } }),
    () => { throw new Error(token); },
  ];
  for (const response of responses) {
    const { options, calls } = fixture(url => {
      if (url.includes('/agent-health?')) return proof(url);
      if (url.includes('/api/state?')) return json({ revision: 17 });
      if (url.endsWith('/api/build-status')) return response();
      return new Response('Locked', { status: 401 });
    });
    await assert.rejects(runLocalAgent(['status'], options), error => error instanceof LocalAgentError && !error.message.includes(token));
    assert.equal(calls.filter(call => call.url.endsWith('/api/build-status')).length, 1);
    assert.ok(calls.every(call => call.url.startsWith(`${base}/`)));
  }
});

test('status fails when the unauthenticated browser is open or cannot prove protection', async () => {
  for (const status of [200, 404, 500]) {
    const { options } = fixture(url => {
      if (url.includes('/agent-health?')) return proof(url);
      if (url.includes('/api/state?')) return json({ revision: 17 });
      return new Response('', { status });
    });
    await assert.rejects(runLocalAgent(['status'], options), /expected HTTP 401/);
  }
});

test('invalid service proofs never receive the bearer credential or trigger startup', async () => {
  const responses = [
    url => proof(url, 'wrong-secret'),
    () => json({ ready: false, proof: 'a'.repeat(64) }),
    () => json({ ready: true, proof: 'abc' }),
    () => new Response('not-json'),
    () => new Response('a'.repeat(4097)),
    () => new Response('', { status: 401 }),
    () => new Response('', { status: 302, headers: { Location: 'http://example.com' } }),
  ];
  for (const response of responses) {
    const { options, calls, starts } = fixture(response);
    await assert.rejects(runLocalAgent(['GET', '/api/state'], options), LocalAgentError);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers, undefined);
    assert.deepEqual(starts, []);
  }
});

test('service check errors other than a refused connection fail closed', async () => {
  const { options, calls, starts } = fixture(() => { throw new Error(`Untrusted network text ${token}`); });
  await assert.rejects(runLocalAgent(['GET', '/api/state'], options), error => error instanceof LocalAgentError && !error.message.includes(token));
  assert.equal(calls.length, 1);
  assert.deepEqual(starts, []);
});

test('an absent service starts the installed app once and waits for proof before sending a request', async () => {
  let probes = 0, time = 0;
  const { options, calls, starts } = fixture(url => {
    if (url.includes('/agent-health?')) {
      if (++probes <= 3) throw refused();
      return proof(url);
    }
    return json({ okay: true });
  });
  const result = await runLocalAgent(['GET', '/api/state'], { ...options, appPath: '/installed/Mazal.app', now: () => time, delay: async ms => { time += ms; } });
  assert.deepEqual(starts, ['/installed/Mazal.app']);
  assert.equal(time, 400);
  assert.equal(calls.filter(call => call.init.headers?.Authorization).length, 1);
  assert.deepEqual(JSON.parse(result.body), { okay: true });
});

test('startup has a deadline and sends no API request when the service stays absent', async () => {
  let time = 0;
  const { options, calls, starts } = fixture(() => { throw refused(); });
  await assert.rejects(runLocalAgent(['POST', '/api/action'], { ...options, startupTimeoutMs: 450, now: () => time, delay: async ms => { time += ms; } }), /did not start/);
  assert.equal(time, 450);
  assert.equal(starts.length, 1);
  assert.ok(calls.every(call => !call.init.headers));
  assert.ok(calls.length < 10);
});

test('an untrusted listener that appears during startup receives no bearer credential', async () => {
  let probes = 0;
  const { options, calls, starts } = fixture(url => {
    if (++probes === 1) throw refused();
    return proof(url, 'other-service');
  });
  await assert.rejects(runLocalAgent(['POST', '/api/action'], options), /could not prove/);
  assert.equal(starts.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.init.headers));
});

test('a request body and binary response stay intact and output files are private', async t => {
  const root = await directory(t), body = join(root, 'body'), output = join(root, 'output');
  await writeFile(body, Buffer.from([0, 1, 255]));
  const { options, calls } = fixture(url => url.includes('/agent-health?') ? proof(url) : new Response(Buffer.from([2, 0, 255])));
  const result = await runLocalAgent(['POST', '/api/action', '--body-file', body, '--content-type', 'application/octet-stream', '--output', output], options);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].init.body, Buffer.from([0, 1, 255]));
  assert.equal(calls[1].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(await readFile(output), Buffer.from([2, 0, 255]));
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(result.status, { status: 200, output, bytes: 3 });
});

test('JSON is the default body type and existing output files are preserved', async t => {
  const root = await directory(t), body = join(root, 'body'), output = join(root, 'output');
  await writeFile(body, '{"expectedRevision":17}');
  await writeFile(output, 'original');
  const { options, calls } = fixture(url => url.includes('/agent-health?') ? proof(url) : json({ saved: true }));
  await assert.rejects(runLocalAgent(['POST', '/api/action', '--body-file', body, '--output', output], options), /Existing files were preserved/);
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(await readFile(output, 'utf8'), 'original');
});

test('missing body files and invalid credentials do not contact or start the app', async t => {
  const root = await directory(t), { options, calls, starts } = fixture();
  await assert.rejects(runLocalAgent(['POST', '/api/action', '--body-file', join(root, 'missing')], options), /No request was sent/);
  await assert.rejects(runLocalAgent(['GET', '/api/state'], { ...options, readToken: async () => { throw new LocalAgentError('Invalid credential'); } }), /Invalid credential/);
  assert.deepEqual(calls, []);
  assert.deepEqual(starts, []);
});

test('a dispatched mutation is never retried and raw request errors never expose the token', async () => {
  const { options, calls, starts } = fixture(url => {
    if (url.includes('/agent-health?')) return proof(url);
    throw new Error(`Failed Authorization: Bearer ${token}`);
  });
  await assert.rejects(runLocalAgent(['POST', '/api/action'], options), error => error instanceof LocalAgentError && /not retried/.test(error.message) && !error.message.includes(token));
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.deepEqual(starts, []);
});

test('API redirects are refused after one dispatch and HTTP errors do not reveal response content', async () => {
  for (const response of [() => new Response('', { status: 307, headers: { Location: 'http://example.com' } }), () => new Response(`Secret ${token}`, { status: 500 })]) {
    const { options, calls } = fixture(url => url.includes('/agent-health?') ? proof(url) : response());
    await assert.rejects(runLocalAgent(['POST', '/api/action'], options), error => error instanceof LocalAgentError && !error.message.includes(token));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.redirect, 'manual');
    assert.ok(calls.every(call => call.url.startsWith(`${base}/`)));
  }
});

test('an interrupted response never retries the mutation or prints the stream error', async () => {
  const { options, calls } = fixture(url => {
    if (url.includes('/agent-health?')) return proof(url);
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error(token)); } }));
  });
  await assert.rejects(runLocalAgent(['PATCH', '/api/action'], options), error => error instanceof LocalAgentError && /not retried/.test(error.message) && !error.message.includes(token));
  assert.equal(calls.filter(call => call.init.method === 'PATCH').length, 1);
});
