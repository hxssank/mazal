import { execFile } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const base = 'http://127.0.0.1:5196';
const execute = promisify(execFile);
const usage = 'Use status [--expect-source SHA256] [--expect-assets SHA256], or METHOD /api/path [--body-file file] [--content-type type] [--output file].';
export class LocalAgentError extends Error {}

export async function readAgentToken(path, uid = process.getuid?.()) {
  let file;
  try {
    if (!Number.isInteger(uid)) throw new Error('Unsupported owner check');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.size < 64 || info.size > 129) throw new Error('Invalid credential metadata');
    const bytes = Buffer.alloc(130);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const token = bytes.toString('utf8', 0, bytesRead);
    if (!/^[a-f0-9]{64,128}\n?$/i.test(token)) throw new Error('Invalid credential contents');
    return token.trim();
  } catch {
    throw new LocalAgentError('Local agent access needs an existing private credential owned by your Mac account with permissions 0600.');
  } finally { await file?.close(); }
}

export function parseAgentArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  if (args[0] === 'status') {
    const command = { mode: 'status' };
    for (let index = 1; index < args.length; index += 2) {
      const name = args[index], value = args[index + 1];
      const key = name === '--expect-source' ? 'expectedSource' : name === '--expect-assets' ? 'expectedAssets' : null;
      if (!key || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || Object.hasOwn(command, key)) throw new LocalAgentError(usage);
      command[key] = value;
    }
    return command;
  }
  const [verb, path, ...flags] = args;
  const method = verb?.toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method) || typeof path !== 'string') throw new LocalAgentError(usage);
  let url;
  try {
    if (/[\u0000-\u0020\u007f\\#]/.test(path) || !path.startsWith('/api/')) throw new Error();
    url = new URL(path, base);
    const rawPath = path.split('?')[0];
    const decoded = decodeURIComponent(url.pathname);
    if (url.origin !== base || url.pathname !== rawPath || !decoded.startsWith('/api/') || /^\/api\/desktop(?:\/|$)/i.test(decoded) || /[\u0000-\u0020\u007f\\%]/.test(decoded)) throw new Error();
    if (url.pathname.split('/').some(part => {
      const value = decodeURIComponent(part);
      return value === '.' || value === '..' || value.includes('/') || value.includes('\\');
    })) throw new Error();
  } catch { throw new LocalAgentError('Choose a local /api/ path outside /api/desktop. URLs, redirects and path escapes are not accepted.'); }
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index], value = flags[index + 1];
    if (!['--body-file', '--content-type', '--output'].includes(name) || !value || value.startsWith('--') || Object.hasOwn(options, name)) throw new LocalAgentError(usage);
    options[name] = value;
  }
  if (options['--body-file'] && ['GET', 'HEAD'].includes(method)) throw new LocalAgentError('GET and HEAD cannot send a body file.');
  if (options['--content-type'] && (!options['--body-file'] || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/.test(options['--content-type']))) throw new LocalAgentError('Use --content-type with a body file and a valid media type.');
  return { mode: 'request', method, url: url.href, bodyFile: options['--body-file'], output: options['--output'], contentType: options['--content-type'] ?? 'application/json' };
}

async function startInstalledApp(appPath) {
  if (process.platform !== 'darwin') throw new LocalAgentError('Automatic startup requires the installed Mazal Mac app.');
  try { await execute('/usr/bin/open', ['-g', '-a', appPath, '--args', '--agent-service'], { timeout: 10_000 }); }
  catch { throw new LocalAgentError('The installed Mazal app could not start. Check that Mazal.app exists in your Applications folder.'); }
}

async function rejectRedirect(response) {
  if (response.redirected || response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new LocalAgentError('Mazal returned a redirect. Local agent requests never follow redirects.');
  }
}

async function readProof(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new LocalAgentError('Mazal returned an invalid service proof.');
  let length = 0;
  const parts = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > 4096) { await reader.cancel(); throw new Error(); }
      parts.push(item.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch { throw new LocalAgentError('Mazal returned an invalid service proof.'); }
  finally { reader.releaseLock(); }
}

async function proveService(token, dependencies) {
  const challenge = dependencies.randomBytes(32).toString('hex');
  let response;
  try {
    response = await dependencies.fetch(`${base}/api/desktop/agent-health?challenge=${challenge}`, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(2000) });
  } catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') return false;
    throw new LocalAgentError('Mazal did not answer the local service check. No credential was sent.');
  }
  await rejectRedirect(response);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new LocalAgentError(`Mazal rejected the service check with HTTP ${response.status}. No credential was sent.`);
  }
  const result = await readProof(response);
  const expected = createHmac('sha256', token).update(`mazal-local-agent:${challenge}`).digest();
  if (result?.ready !== true || typeof result.proof !== 'string' || !/^[a-f0-9]{64}$/.test(result.proof) || !timingSafeEqual(Buffer.from(result.proof, 'hex'), expected)) throw new LocalAgentError('The local service could not prove it is Mazal. No credential was sent.');
  return true;
}

async function runtimeBuildStatus(token, dependencies) {
  let response;
  try {
    response = await dependencies.fetch(`${base}/api/build-status`, { method: 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(2000), headers: { Authorization: `Bearer ${token}` } });
  } catch { throw new LocalAgentError('Mazal did not answer the running build check. No request was retried.'); }
  await rejectRedirect(response);
  if (!response.ok) {
    await response.body?.cancel();
    throw new LocalAgentError(`Mazal returned HTTP ${response.status} for the running build check. Its running build could not be confirmed.`);
  }
  let value;
  try { value = await response.json(); } catch {}
  if (value?.format !== 'mazal-runtime-build' || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.processId) || value.processId <= 0
    || typeof value.startedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.startedAt) || !Number.isFinite(Date.parse(value.startedAt))
    || !['available', 'missing', 'invalid'].includes(value.identityStatus)) throw new LocalAgentError('Mazal returned an invalid running build status.');
  let build = null;
  if (value.identityStatus === 'available') {
    const identity = value.build;
    if (!identity || typeof identity.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(identity.version)
      || !['sourceSha256', 'assetsSha256'].every(key => typeof identity[key] === 'string' && /^[a-f0-9]{64}$/.test(identity[key]))
      || !['nodeVersion', 'pythonVersion'].every(key => typeof identity[key] === 'string' && /^\d+\.\d+\.\d+$/.test(identity[key]))) throw new LocalAgentError('Mazal returned an invalid running build identity.');
    build = { version: identity.version, sourceSha256: identity.sourceSha256, assetsSha256: identity.assetsSha256, nodeVersion: identity.nodeVersion, pythonVersion: identity.pythonVersion };
  } else if (value.build !== null) throw new LocalAgentError('Mazal returned an invalid running build identity.');
  return { format: value.format, schemaVersion: value.schemaVersion, startedAt: value.startedAt, processId: value.processId, identityStatus: value.identityStatus, build };
}

export async function runLocalAgent(args, options = {}) {
  const command = parseAgentArguments(args);
  if (command.mode === 'help') return { body: Buffer.from(`${usage}\n`) };
  const dependencies = { fetch: globalThis.fetch, randomBytes, delay, now: Date.now, readToken: readAgentToken, startApp: startInstalledApp, ...options };
  const tokenPath = options.tokenPath ?? join(homedir(), 'Library', 'Application Support', 'Mazal', 'local-agent-token');
  const appPath = options.appPath ?? join(homedir(), 'Applications', 'Mazal.app');
  let body;
  if (command.bodyFile) {
    try { body = await readFile(command.bodyFile); }
    catch { throw new LocalAgentError('The request body file could not be read. No request was sent.'); }
  }
  const token = await dependencies.readToken(tokenPath);
  if (!await proveService(token, dependencies)) {
    await dependencies.startApp(appPath);
    const deadline = dependencies.now() + (options.startupTimeoutMs ?? 30_000);
    while (!await proveService(token, dependencies)) {
      if (dependencies.now() >= deadline) throw new LocalAgentError('Mazal did not start within the allowed time. No API request was sent.');
      await dependencies.delay(Math.min(200, deadline - dependencies.now()));
    }
  }
  const request = command.mode === 'status' ? { method: 'GET', url: `${base}/api/state?workspace=live` } : command;
  let response;
  try {
    response = await dependencies.fetch(request.url, { method: request.method, redirect: 'manual', signal: AbortSignal.timeout(options.requestTimeoutMs ?? 90_000), headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': command.contentType }) }, ...(body === undefined ? {} : { body }) });
  } catch { throw new LocalAgentError('The API request failed and was not retried. If it changes records, check the saved result before retrying.'); }
  await rejectRedirect(response);
  if (!response.ok) {
    await response.body?.cancel();
    throw new LocalAgentError(`Mazal returned HTTP ${response.status}. The request was not retried.`);
  }
  let bytes;
  try { bytes = Buffer.from(await response.arrayBuffer()); }
  catch { throw new LocalAgentError('The response was interrupted. The request was not retried; check saved records before repeating a change.'); }
  if (command.mode === 'status') {
    let state;
    try { state = JSON.parse(bytes.toString('utf8')); } catch {}
    if (!Number.isSafeInteger(state?.revision) || state.revision < 0) throw new LocalAgentError('Mazal returned an invalid status response.');
    let browser;
    try { browser = await dependencies.fetch(`${base}/`, { redirect: 'manual', signal: AbortSignal.timeout(2000) }); }
    catch { throw new LocalAgentError('Mazal did not answer the browser protection check.'); }
    await rejectRedirect(browser);
    await browser.body?.cancel();
    if (browser.status !== 401) throw new LocalAgentError(`Mazal's browser protection check returned HTTP ${browser.status}; expected HTTP 401.`);
    const runtimeBuild = await runtimeBuildStatus(token, dependencies);
    for (const [expected, key, label] of [[command.expectedSource, 'sourceSha256', 'source'], [command.expectedAssets, 'assetsSha256', 'web assets']]) {
      if (!expected) continue;
      if (!runtimeBuild.build) throw new LocalAgentError(`The running build identity is ${runtimeBuild.identityStatus}; the expected ${label} could not be confirmed. Restart the verified installed app before continuing.`);
      if (runtimeBuild.build[key] !== expected) throw new LocalAgentError(`The running ${label} SHA-256 is ${runtimeBuild.build[key]}; expected ${expected}. Restart the verified installed app before continuing.`);
    }
    return { status: { serverHealthy: true, revision: state.revision, protectedUi: browser.status === 401, unauthenticatedUiStatus: browser.status, runtimeBuild } };
  }
  if (command.output) {
    try { await writeFile(command.output, bytes, { flag: 'wx', mode: 0o600 }); }
    catch { throw new LocalAgentError('The output file could not be created. Existing files were preserved; the API request was not retried.'); }
    return { status: { status: response.status, output: resolve(command.output), bytes: bytes.length } };
  }
  return { body: bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runLocalAgent(process.argv.slice(2));
    process.stdout.write(result.body ?? `${JSON.stringify(result.status, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof LocalAgentError ? error.message : 'Local agent access failed. No request was retried.');
    process.exitCode = 1;
  }
}
