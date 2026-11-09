import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelease, extractRelease } from './release.mjs';
import { runNpm, run } from './process.mjs';
import { verifyBuildIdentity } from './build-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || arguments_[0]?.startsWith('-')) throw new Error('Usage: npm run release:verify -- [source-release.zip]');
const temporary = await mkdtemp(join(tmpdir(), 'mazal-clean-install-'));
const report = { status: 'running', startedAt: new Date().toISOString(), platform: platform(), architecture: arch(), osRelease: release(), nodeVersion: process.versions.node, checks: [] };
let child;
let serverPort;
let enginePort;
let logs = '';
let reportPath;
async function unusedPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolveClose, reject) => socket.close(error => error ? reject(error) : resolveClose()));
  return port;
}
async function request(base, path, type = 'json') {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(90_000) });
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return type === 'json' ? response.json() : response.text();
}
async function assertClosed(port) {
  if (!port) return;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); await response.arrayBuffer(); }
    catch { return; }
    await delay(100);
  }
  throw new Error(`A release process still listens on port ${port} after shutdown.`);
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (process.platform === 'win32') await run('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Release shutdown exceeded 15 seconds.')), 15_000); })]); }
  catch (error) { child.kill('SIGKILL'); throw error; }
  finally { clearTimeout(timer); }
}
try {
  const archive = arguments_[0] ? resolve(arguments_[0]) : (await createRelease(root, join(temporary, 'package'))).archive;
  const extracted = await extractRelease(archive, temporary);
  const { project, manifest } = extracted;
  report.version = manifest.version;
  report.sourceSha256 = manifest.sourceSha256;
  report.archiveSha256 = extracted.archiveSha256;
  report.archive = arguments_[0] ? archive : 'temporary source release';
  report.checks.push('archive inventory and SHA-256 verification');
  assert.equal(process.versions.node, manifest.nodeVersion, 'Use the Node.js version pinned by this release.');
  for (const path of ['node_modules', 'backend/.venv', 'data', 'dist']) await assert.rejects(access(join(project, path)), { code: 'ENOENT' });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MAZAL_') || key.startsWith('UV_') || ['VIRTUAL_ENV', 'PYTHONHOME', 'PYTHONPATH', 'CONDA_PREFIX', 'NODE_ENV'].includes(key)) delete env[key];
  Object.assign(env, {
    UV_PROJECT_ENVIRONMENT: join(project, 'backend/.venv'),
    UV_PYTHON_INSTALL_DIR: join(temporary, 'python'), UV_PYTHON_PREFERENCE: 'only-managed',
    MAZAL_DATA_DIR: join(temporary, 'data'), MAZAL_MASTER_WORKBOOK: join(temporary, 'workbook', 'Mazal master.xlsx'),
  });
  console.log(`Verifying ${manifest.version} in a fresh installation on ${platform()}/${arch()}.`);
  await runNpm(['run', 'setup'], { cwd: project, env });
  report.pythonVersion = execFileSync(join(project, 'backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), ['--version'], { encoding: 'utf8', env }).trim();
  report.uvVersion = execFileSync('uv', ['--version'], { encoding: 'utf8', env }).trim();
  assert.equal(report.pythonVersion, `Python ${manifest.pythonVersion}`, 'The fresh Python runtime must match the release pin.');
  report.checks.push('fresh npm ci', 'uv lock validation and frozen sync', 'fresh managed Python runtime and virtual environment');
  await runNpm(['run', 'build'], { cwd: project, env });
  const buildIdentity = await verifyBuildIdentity(project, manifest);
  report.assetsSha256 = buildIdentity.assetsSha256;
  report.checks.push('application build');
  serverPort = await unusedPort();
  child = spawn(process.execPath, ['scripts/start.mjs'], { cwd: project, env: { ...env, PORT: String(serverPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const started = new Promise((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error(`Release did not start within 30 seconds.\n${logs}`)), 30_000);
    const collect = bytes => {
      logs = (logs + bytes).slice(-20000);
      const port = logs.match(/Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/);
      if (port) enginePort = Number(port[1]);
      if (logs.includes('Mazal is available')) { clearTimeout(timer); resolveStarted(); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Release exited with ${code}.\n${logs}`)); });
  });
  await started;
  const base = `http://127.0.0.1:${serverPort}`;
  assert.deepEqual(await request(base, '/BUILD.json'), buildIdentity);
  for (const asset of buildIdentity.assets) {
    const response = await fetch(`${base}/${asset.path}`);
    assert.equal(response.status, 200, asset.path);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, asset.bytes, asset.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.path);
  }
  report.checks.push('served source identity and every web asset SHA-256');
  const state = await request(base, '/api/state?workspace=live');
  assert.equal(state.workspace, 'live'); assert.equal(state.revision, 0);
  for (const field of ['accounts', 'transactions', 'positions', 'obligations']) assert.equal(state[field].length, 0, `Fresh installation leaked ${field}.`);
  const documents = await request(base, '/api/documents?workspace=live');
  assert.equal(documents.documents.length, 0);
  const workbook = await request(base, '/api/master-workbook/status?workspace=live');
  assert.equal(workbook.available, false);
  const health = await request(base, '/api/engine/health');
  assert.equal(health.status, 'ok'); assert.equal(typeof health.modelVersion, 'string');
  const query = new URLSearchParams({ workspace: 'live', scope: 'personal', expectedRevision: String(state.revision), asOf: new Date().toISOString().slice(0, 10) });
  const summary = await request(base, `/api/engine/summary?${query}`);
  assert.equal(summary.revision, 0); assert.equal(summary.workspace, 'live'); assert.ok(summary.result.summary);
  assert.equal(summary.result.summary.netWorthCents, 0);
  report.checks.push('empty records and original-file library', 'isolated workbook', 'Python health and financial calculation');
  for (const path of ['/']) {
    const html = await request(base, path, 'text');
    assert.match(html, /<html/);
    const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match => match[1]).filter(value => value.startsWith('/'));
    assert.ok(assets.some(asset => asset.endsWith('.js')), `${path} lacks a built script.`);
    for (const asset of assets) {
      const content = await request(base, asset, 'text');
      assert.ok(content.length > 0, `${asset} is empty.`);
      if (asset.endsWith('.js') || asset.endsWith('.css')) assert.doesNotMatch(content.slice(0, 100), /<!doctype html>/i);
    }
  }
  report.checks.push('production app HTML and assets');
  const archiveResponse = await fetch(`${base}/api/complete-backup`);
  assert.equal(archiveResponse.status, 200, 'Complete backup export');
  const completePreview = await fetch(`${base}/api/complete-backup/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await archiveResponse.arrayBuffer() });
  assert.equal(completePreview.status, 200, 'Complete backup verification');
  const complete = await completePreview.json();
  const completeRestore = await fetch(`${base}/api/complete-backup/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: complete.token, expectedRevision: complete.expectedRevision, confirmation: true }) });
  assert.equal(completeRestore.status, 200, 'Complete backup restoration');
  const recovered = await request(base, '/api/state?workspace=live');
  assert.ok(recovered.revision > state.revision);
  assert.deepEqual(recovered.transactions, state.transactions);
  assert.equal((await request(base, '/api/documents/recovery?workspace=live')).missingOriginals, 0);
  report.checks.push('complete backup verification, restoration and service reopen');
  await stop();
  await assertClosed(serverPort); await assertClosed(enginePort);
  report.checks.push('server and Python process shutdown');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { report.status = 'failed'; report.shutdownError = String(error); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  const output = join(root, 'artifacts', 'releases');
  await mkdir(output, { recursive: true });
  reportPath = join(output, `clean-install-${report.version ?? 'unknown'}-${report.sourceSha256?.slice(0, 12) ?? 'unknown'}-${platform()}-${arch()}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'passed') await rm(temporary, { recursive: true, force: true });
  else console.error(`Installation files retained for diagnosis: ${temporary}\n${report.error ?? report.shutdownError}`);
  console.log(`Clean installation ${report.status}. Report: ${reportPath}`);
}
