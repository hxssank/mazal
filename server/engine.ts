import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { EngineError } from './engine-contract.ts';
export { EngineError, type EngineTransport } from './engine-contract.ts';

const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

async function availablePort(): Promise<number> {
  const socket = createServer();
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') { socket.close(); reject(new Error('Could not reserve an engine port.')); return; }
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => signalProcess(child, 'SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    signalProcess(child, 'SIGTERM');
  });
}

export function createEngineService(root: string, dataDirectory: string) {
  const backend = join(root, 'backend');
  const key = randomBytes(32).toString('hex');
  let child: ChildProcess | undefined;
  let starting: Promise<string> | undefined;
  let endpoint: string | undefined;
  let closed = false;

  async function launch(): Promise<string> {
    if (closed) throw new EngineError(503, 'The financial engine is shutting down.');
    const enginePort = await availablePort();
    if (closed) throw new EngineError(503, 'The financial engine is shutting down.');
    const runDirectory = join(dataDirectory, 'engine-runs');
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    if (closed) throw new EngineError(503, 'The financial engine is shutting down.');
    const processChild = spawn(join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), ['-m', 'uvicorn', 'mazal_engine.app:app', '--host', '127.0.0.1', '--port', String(enginePort), '--no-access-log'], {
      cwd: backend,
      env: { ...process.env, MAZAL_ENGINE_KEY: key, MAZAL_ENGINE_PARENT_PID: String(process.pid), MAZAL_ENGINE_RUN_DIR: runDirectory, MAZAL_ENGINE_CACHE_DIR: join(dataDirectory, 'engine-cache'), PYTENSOR_FLAGS: `base_compiledir=${join(dataDirectory, 'engine-cache', 'pytensor')}`, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child = processChild;
    let launchFailure = false;
    processChild.on('error', () => { launchFailure = true; });
    processChild.stderr?.on('data', chunk => process.stderr.write(chunk));
    processChild.once('exit', () => {
      if (process.platform !== 'win32') signalProcess(processChild, 'SIGKILL');
      if (child === processChild) { child = undefined; endpoint = undefined; }
    });
    const url = `http://127.0.0.1:${enginePort}`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (closed || launchFailure || processChild.exitCode !== null || processChild.signalCode !== null) throw new EngineError(503, 'The financial engine could not start. Check the local Python environment and retry.');
        try {
          const response = await fetch(`${url}/health`, { headers: { 'X-Mazal-Engine-Key': key }, signal: AbortSignal.timeout(1000) });
          if (response.ok) { await response.arrayBuffer(); endpoint = url; return url; }
          await response.arrayBuffer();
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new EngineError(503, 'The financial engine did not become ready within 60 seconds. Retry the calculation.');
    } catch (error) {
      await stopProcess(processChild);
      if (child === processChild) child = undefined;
      throw error;
    }
  }

  function start(): Promise<string> {
    if (closed) return Promise.reject(new EngineError(503, 'The financial engine is shutting down.'));
    if (endpoint) return Promise.resolve(endpoint);
    if (!starting) starting = launch().catch(error => { throw error instanceof EngineError ? error : new EngineError(503, 'The financial engine could not start. Check the local Python environment and retry.'); }).finally(() => { starting = undefined; });
    return starting;
  }

  async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const url = await start();
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, { method, headers: { 'X-Mazal-Engine-Key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch { throw new EngineError(503, 'The financial engine is unavailable. Your saved records are unchanged. Retry the calculation.'); }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new EngineError(503, 'The financial engine returned an incomplete response. Retry the calculation.'); }
    if (!response.ok) {
      const details = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const message = typeof details.error === 'string' ? details.error : typeof details.detail === 'string' ? details.detail : 'The financial engine could not complete this calculation.';
      throw new EngineError(response.status >= 500 || [401, 403].includes(response.status) ? 503 : response.status, message);
    }
    return payload;
  }

  async function close(): Promise<void> {
    closed = true;
    if (child) await stopProcess(child);
    await starting?.catch(() => {});
    endpoint = undefined;
  }

  async function download(path: string): Promise<Response> {
    const url = await start();
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, { headers: { 'X-Mazal-Engine-Key': key }, signal: AbortSignal.timeout(120_000) });
    } catch { throw new EngineError(503, 'The calculation archive could not be downloaded. Retry the download.'); }
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => ({}));
      const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'The calculation archive could not be downloaded.';
      throw new EngineError(response.status >= 500 || [401, 403].includes(response.status) ? 503 : response.status, message);
    }
    return response;
  }

  return { start, request, download, close };
}
