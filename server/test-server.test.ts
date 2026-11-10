import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { availableTestPort, waitForTestServer } from './test-server.ts';

function startChild(t: TestContext, script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return child;
}

test('server startup reports the exit code and stderr from a failed child', { timeout: 10_000 }, async t => {
  const child = startChild(t, `process.stderr.write('EADDRINUSE: fixture listener could not bind\\n', () => process.exit(23));`);
  await assert.rejects(waitForTestServer(child, 'Fixture server', 5000), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Fixture server exited with 23/);
    assert.match(error.message, /EADDRINUSE: fixture listener could not bind/);
    return true;
  });
});

test('startup waits past unrelated stdout until the child announces readiness', { timeout: 10_000 }, async t => {
  const child = startChild(t, `
    process.on('message', message => {
      if (message === 'ready') process.stdout.write('Mazal is available at http://127.0.0.1:12345\\n');
    });
    process.stdout.write('Preparing fixture records\\n');
  `);
  let ready = false;
  const started = waitForTestServer(child, 'Fixture server', 5000).then(() => { ready = true; });
  await once(child.stdout!, 'data');
  assert.equal(ready, false, 'Unrelated startup output must not release requests to the server');
  child.send!('ready');
  await started;
  assert.equal(ready, true);
});

test('startup timeout includes stderr from a child that stays alive without becoming ready', { timeout: 10_000 }, async t => {
  const child = startChild(t, `
    process.on('message', () => process.stderr.write('Fixture is waiting for its database\\n'));
    process.send('booted');
  `);
  await once(child, 'message');
  const start = performance.now();
  const started = waitForTestServer(child, 'Fixture server', 1000);
  child.send!('diagnose');
  await assert.rejects(started, error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Fixture server did not start/);
    assert.match(error.message, /Fixture is waiting for its database/);
    return true;
  });
  assert.ok(performance.now() - start < 5000, 'The startup deadline must bound a live child that never becomes ready');
  assert.equal(child.exitCode, null);
});

test('an OS-allocated fixture port is released for the server to bind', { timeout: 10_000 }, async t => {
  const port = await availableTestPort();
  const server = createServer();
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const listening = once(server, 'listening');
  server.listen(port, '127.0.0.1');
  await listening;
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(address.port, port);
});
