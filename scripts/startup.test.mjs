import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createServer as createViteServer } from 'vite';

const execute = promisify(execFile);
const config = new URL('../vite.config.ts', import.meta.url).href;

async function launchFixture(t, script, server, vite = 'process.exit(0);') {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-launch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'server'));
  await mkdir(join(directory, 'node_modules/vite/bin'), { recursive: true });
  await copyFile(new URL(script, import.meta.url), join(directory, 'scripts', script));
  await writeFile(join(directory, 'server/index.ts'), server);
  await writeFile(join(directory, 'node_modules/vite/bin/vite.js'), vite);
  return { directory, launch: (options = {}) => execute(process.execPath, [join(directory, 'scripts', script)], { cwd: tmpdir(), timeout: 10_000, ...options }) };
}

test('development API requests use the same configured port as the server', async () => {
  for (const port of ['5191', '54321']) {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `const { default: config } = await import(${JSON.stringify(config)}); console.log(config.server.proxy['/api']);`], { env: { ...process.env, PORT: port } });
    assert.equal(stdout.trim(), `http://127.0.0.1:${port}`);
  }
});

test('the development proxy reaches an isolated API on its configured port', async () => {
  const api = createServer((request, response) => response.end(JSON.stringify({ path: request.url, marker: 'isolated-api' })));
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const previousPort = process.env.PORT;
  process.env.PORT = String(api.address().port);
  let ui;
  try {
    ui = await createViteServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { port: 0, strictPort: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' });
    assert.equal(ui.config.server.proxy['/api'], `http://127.0.0.1:${process.env.PORT}`);
    await ui.listen();
    const response = await fetch(`http://127.0.0.1:${ui.httpServer.address().port}/api/state?workspace=live`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: '/api/state?workspace=live', marker: 'isolated-api' });
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await ui?.close();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  }
});

test('development rejects invalid API ports before starting a proxy', async () => {
  for (const port of ['', '0', '1023', '65536', '5191.5', 'invalid']) {
    await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(config)});`], { env: { ...process.env, PORT: port } }), error => {
      assert.match(error.stderr, /PORT must be an integer between 1024 and 65535/);
      return true;
    });
  }
});

test('production starts from its project directory and sets production mode', async t => {
  const { directory, launch } = await launchFixture(t, 'start.mjs', 'console.log(JSON.stringify({ cwd: process.cwd(), mode: process.env.NODE_ENV, engine: process.env.MAZAL_ENGINE_AUTOSTART }));');
  const { stdout } = await launch();
  const result = JSON.parse(stdout);
  assert.deepEqual({ ...result, cwd: await realpath(result.cwd) }, { cwd: await realpath(directory), mode: 'production', engine: '1' });
});

test('production reports a child terminated by a signal as a failed launch', { skip: process.platform === 'win32' }, async t => {
  const { directory, launch } = await launchFixture(t, 'start.mjs', "process.kill(process.pid, 'SIGTERM');");
  await assert.rejects(launch({ cwd: directory }), error => error.code === 1);
});

test('development stops its watcher and reports failure when Vite is terminated', { skip: process.platform === 'win32' }, async t => {
  const { directory, launch } = await launchFixture(t, 'dev.mjs', 'setInterval(() => {}, 1000);', "process.kill(process.pid, 'SIGTERM');");
  await assert.rejects(launch({ cwd: directory }), error => error.code === 1);
});
