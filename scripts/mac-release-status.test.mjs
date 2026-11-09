import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertMatchingBuild, macReleaseStatus, verifyInstalledIdentity } from './mac-release-status.mjs';
import { collectRelease } from './release.mjs';
import { writeBuildIdentity } from './build-identity.mjs';
import { ENGINE_MODEL_VERSION } from '../shared/engine.ts';

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'mazal-package-identity-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'source');
  const paths = ['.gitignore', '.node-version', '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'tsconfig.ui.json', 'tsconfig.server.json', 'vite.config.ts', 'playwright.config.ts', 'backend/pyproject.toml', 'backend/uv.lock', 'backend/.python-version', 'public/icon.svg', 'public/fonts/OFL.txt', 'public/fonts/barlow-condensed-bold.ttf', 'src/App.tsx', 'shared/types.ts', 'server/index.ts', 'scripts/setup.mjs', 'backend/mazal_engine/app.py', 'backend/tests/test_app.py', 'macos/Mazal.swift', 'tests/desktop/navigation.spec.ts'];
  for (const path of paths) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), 'synthetic release fixture');
  }
  const version = '0.2.0-rc.3';
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'mazal', version }));
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  await writeFile(join(source, '.node-version'), '24.22.0\n');
  await writeFile(join(source, 'backend/.python-version'), '3.13.16\n');
  const modelVersion = ENGINE_MODEL_VERSION;
  await writeFile(join(source, 'shared/engine.ts'), `export const ENGINE_MODEL_VERSION = '${modelVersion}';\n`);
  const assets = new Map([['index.html', '<html><script src="/app.js"></script></html>'], ['app.js', 'console.log("synthetic build")']]);
  await mkdir(join(source, 'dist'));
  for (const [path, content] of assets) await writeFile(join(source, 'dist', path), content);
  const { manifest } = await collectRelease(source);
  const expected = await writeBuildIdentity(source, manifest);
  const directory = join(temporary, 'Mazal.app');
  const resources = join(directory, 'Contents', 'Resources');
  const dist = join(resources, 'app', 'dist');
  const contents = new Map([
    ...[...assets].map(([path, content]) => [`app/dist/${path}`, content]),
    ['app/dist/BUILD.json', JSON.stringify(expected)],
    ['app/server/index.ts', 'synthetic server source'],
    ['app/backend/mazal_engine/app.py', 'synthetic Python source'],
    ['runtime/node', 'synthetic bundled runtime'],
  ]);
  const files = [];
  for (const [path, content] of [...contents].sort(([a], [b]) => a.localeCompare(b))) {
    await mkdir(dirname(join(resources, path)), { recursive: true });
    await writeFile(join(resources, path), content);
    files.push({ path, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
  }
  const native = { ...expected, files };
  await writeFile(join(resources, 'BUILD.json'), JSON.stringify(native));
  await writeFile(join(directory, 'Contents', 'Info.plist'), `<plist><dict><key>MazalReleaseVersion</key><string>${expected.version}</string><key>MazalSourceSHA256</key><string>${expected.sourceSha256}</string></dict></plist>`);
  const runtime = { serverHealthy: true, revision: 17, protectedUi: true, unauthenticatedUiStatus: 401, runtimeBuild: { format: 'mazal-runtime-build', schemaVersion: 1, startedAt: '2026-10-19T12:00:00.000Z', processId: 1234, identityStatus: 'available', build: expected } };
  const zeros = keys => Object.fromEntries(keys.split(' ').map(key => [key, 0]));
  const summary = {
    summary: zeros('assetsCents liabilitiesCents netWorthCents cashCents investmentsCents receivablesCents physicalAssetsCents purchaseEquityCents availableCents reservedCents committedCents incomeCents expensesCents personalAvailableCents'),
    trackedAssetsCents: 0,
    debtOverview: { ...zeros('debtCents creditCents monthlyInterestCents unknownInterestCount deferredCents repayingCents'), highestRateAccountId: null, largestBalanceAccountId: null, rows: [] },
    investmentBreakdown: { solValueCents: 0, otherValueCents: 0, positions: {} },
    debtPaymentSummary: zeros('paidThisMonthCents reversedThisMonthCents'),
    priorityComparison: { reductionCents: 0, priorityAnnualSavedCents: null, largestAnnualSavedCents: null },
  };
  const agent = async args => {
    if (args[0] === 'status') return { status: runtime };
    assert.equal(args[0], 'GET');
    const url = new URL(args[1], 'http://127.0.0.1');
    if (url.pathname === '/api/engine/health') return { body: Buffer.from(JSON.stringify({ status: 'ok', modelVersion })) };
    assert.equal(url.pathname, '/api/engine/summary');
    assert.equal(url.searchParams.get('workspace'), 'live');
    assert.equal(url.searchParams.get('scope'), 'all');
    assert.equal(url.searchParams.get('expectedRevision'), String(runtime.revision));
    return { body: Buffer.from(JSON.stringify({ workspace: 'live', scope: 'all', revision: runtime.revision, asOf: url.searchParams.get('asOf'), modelVersion, inputHash: 'e'.repeat(64), result: summary })) };
  };
  return { directory, resources, dist, expected, native, source, runtime, contents, modelVersion, agent };
}

test('same release version cannot hide a different source or asset build', () => {
  const expected = { version: '0.2.0-rc.3', sourceSha256: 'a'.repeat(64), assetsSha256: 'b'.repeat(64) };
  assert.doesNotThrow(() => assertMatchingBuild(expected, expected, 'Runtime'));
  assert.throws(() => assertMatchingBuild({ ...expected, sourceSha256: 'c'.repeat(64) }, expected, 'Runtime'), /different sourceSha256/);
  assert.throws(() => assertMatchingBuild({ ...expected, assetsSha256: 'd'.repeat(64) }, expected, 'Runtime'), /different assetsSha256/);
  assert.throws(() => assertMatchingBuild(null, expected, 'Runtime'), /unknown/);
});

test('installation identity checks the package, web assets and native launcher', async t => {
  const { directory, resources, dist, expected, native } = await fixture(t);
  assert.equal((await verifyInstalledIdentity(directory, expected)).sourceSha256, expected.sourceSha256);
  await writeFile(join(resources, 'BUILD.json'), JSON.stringify({ ...native, sourceSha256: 'b'.repeat(64) }));
  await assert.rejects(verifyInstalledIdentity(directory, expected), /different sourceSha256/);
  await writeFile(join(resources, 'BUILD.json'), JSON.stringify(native));
  await writeFile(join(dist, 'index.html'), 'changed web assets');
  await assert.rejects(verifyInstalledIdentity(directory, expected), /assets changed/);
});

test('an old native launcher cannot pass using copied new web metadata', async t => {
  const { directory, expected } = await fixture(t);
  const plist = join(directory, 'Contents', 'Info.plist');
  await writeFile(plist, (await readFile(plist, 'utf8')).replace(expected.sourceSha256, 'b'.repeat(64)));
  await assert.rejects(verifyInstalledIdentity(directory, expected), /native launcher/);
});

test('unchanged version and manifests cannot hide changed backend or bundled runtime bytes', async t => {
  const { directory, resources, expected, native, contents } = await fixture(t);
  for (const path of ['app/server/index.ts', 'app/backend/mazal_engine/app.py', 'runtime/node']) {
    await writeFile(join(resources, path), 'changed executable code');
    await assert.rejects(verifyInstalledIdentity(directory, expected), /package files changed/);
    assert.deepEqual(JSON.parse(await readFile(join(resources, 'BUILD.json'), 'utf8')), native);
    await writeFile(join(resources, path), contents.get(path));
    assert.equal((await verifyInstalledIdentity(directory, expected)).sourceSha256, expected.sourceSha256);
  }
});

test('status verifies the installed and running build plus a current live Python calculation', async t => {
  const { directory, source, expected, runtime, agent, modelVersion } = await fixture(t);
  const calls = [];
  const result = await macReleaseStatus(source, directory, async args => {
    calls.push(['agent', args]);
    return agent(args);
  }, async path => { calls.push(['signature', path]); });
  const statusArguments = ['status', '--expect-source', expected.sourceSha256, '--expect-assets', expected.assetsSha256];
  assert.deepEqual(calls.slice(0, 3), [['signature', directory], ['agent', statusArguments], ['agent', ['GET', '/api/engine/health']]]);
  assert.match(calls[3][1][1], /^\/api\/engine\/summary\?workspace=live&scope=all&expectedRevision=17&asOf=\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(calls[4], ['agent', statusArguments]);
  assert.equal(calls.length, 5);
  assert.equal(result.status, 'matched');
  assert.equal(result.sourceSha256, expected.sourceSha256);
  assert.equal(result.assetsSha256, expected.assetsSha256);
  assert.equal(result.installed, directory);
  assert.deepEqual(result.runtime, runtime);
  assert.deepEqual(result.engine, { status: 'ok', modelVersion, revision: runtime.revision, scope: 'all', asOf: new URL(calls[3][1][1], 'http://127.0.0.1').searchParams.get('asOf') });
  assert.equal(JSON.stringify(result).includes('netWorthCents'), false);
});

test('a new installed package cannot hide an old running process with the same version', async t => {
  const { directory, source, expected, runtime } = await fixture(t);
  for (const change of [{ sourceSha256: 'b'.repeat(64) }, { assetsSha256: 'c'.repeat(64) }]) {
    const oldRuntime = { ...runtime, runtimeBuild: { ...runtime.runtimeBuild, build: { ...expected, ...change } } };
    let checks = 0;
    await assert.rejects(macReleaseStatus(source, directory, async () => ({ status: oldRuntime }), async () => { checks++; }), /The running app has a different/);
    assert.equal(checks, 1);
  }
});

test('a rejected native signature stops status before contacting the running service', async t => {
  const { directory, source } = await fixture(t);
  let contacted = false;
  await assert.rejects(macReleaseStatus(source, directory, async () => { contacted = true; throw new Error('Unexpected service request'); }, async path => {
    assert.equal(path, directory);
    throw new Error('Invalid code signature');
  }), /Invalid code signature/);
  assert.equal(contacted, false);
});

test('source edits without a version change reject stale builds before checking the installation', async t => {
  const { directory, source } = await fixture(t);
  await writeFile(join(source, 'server/index.ts'), 'changed synthetic server source');
  let contacted = false, checked = false;
  await assert.rejects(macReleaseStatus(source, directory, async () => { contacted = true; }, async () => { checked = true; }), /web build does not match the current source/);
  assert.equal(contacted, false);
  assert.equal(checked, false);
});

test('a rebuilt source with the same version rejects an older installed package before contacting its process', async t => {
  const { directory, source, expected } = await fixture(t);
  await writeFile(join(source, 'server/index.ts'), 'newer synthetic server source');
  const { manifest } = await collectRelease(source);
  const rebuilt = await writeBuildIdentity(source, manifest);
  assert.equal(rebuilt.version, expected.version);
  assert.notEqual(rebuilt.sourceSha256, expected.sourceSha256);
  let contacted = false, checked = false;
  await assert.rejects(macReleaseStatus(source, directory, async () => { contacted = true; }, async () => { checked = true; }), /installed Mac package has a different sourceSha256/);
  assert.equal(contacted, false);
  assert.equal(checked, false);
});

test('source changes while checking the running process cannot produce a matched result', async t => {
  for (const rebuild of [false, true]) {
    const { directory, source, agent } = await fixture(t);
    await assert.rejects(macReleaseStatus(source, directory, async args => {
      if (args[0] === 'status') {
        await writeFile(join(source, 'server/index.ts'), 'source changed during status request');
        if (rebuild) await writeBuildIdentity(source, (await collectRelease(source)).manifest);
      }
      return agent(args);
    }, async () => {}), rebuild ? /source after runtime verification has a different sourceSha256/ : /web build does not match the current source/);
  }
});

test('healthy Node cannot hide unavailable, unhealthy or mismatched Python', async t => {
  const { directory, source, agent, modelVersion } = await fixture(t);
  for (const health of [null, { status: 'failed', modelVersion }, { status: 'ok', modelVersion: 'old-model' }]) {
    await assert.rejects(macReleaseStatus(source, directory, async args => args[1] === '/api/engine/health'
      ? { body: Buffer.from(JSON.stringify(health)) } : agent(args), async () => {}), /Python engine is unhealthy or uses a different model/);
  }
  await assert.rejects(macReleaseStatus(source, directory, async args => {
    if (args[1] === '/api/engine/health') throw new Error('Mazal returned HTTP 503.');
    return agent(args);
  }, async () => {}), /HTTP 503/);
});

test('healthy Python cannot hide failed or invalid live calculations', async t => {
  const { directory, source, agent } = await fixture(t);
  for (const change of [
    { workspace: 'demo' }, { scope: 'personal' }, { revision: 16 }, { asOf: '2000-01-01' },
    { modelVersion: 'old-model' }, { inputHash: 'invalid' }, { result: {} },
    { result: { summary: { netWorthCents: null } } }, { result: { summary: { netWorthCents: 12345 } } },
  ]) {
    await assert.rejects(macReleaseStatus(source, directory, async args => {
      const response = await agent(args);
      return args[1]?.startsWith('/api/engine/summary?') ? { body: Buffer.from(JSON.stringify({ ...JSON.parse(response.body), ...change })) } : response;
    }, async () => {}), /valid calculation for the current live revision/);
  }
  for (const response of [{ body: Buffer.from('{broken') }, { body: Buffer.from('null') }]) {
    await assert.rejects(macReleaseStatus(source, directory, async args => args[1]?.startsWith('/api/engine/summary?') ? response : agent(args), async () => {}), /invalid response|valid calculation/);
  }
  await assert.rejects(macReleaseStatus(source, directory, async args => {
    if (args[1]?.startsWith('/api/engine/summary?')) throw new Error('Mazal returned HTTP 409.');
    return agent(args);
  }, async () => {}), /HTTP 409/);
});

test('record changes or a restarted server during engine verification cannot pass status', async t => {
  const { directory, source, agent, runtime } = await fixture(t);
  for (const change of [
    { revision: runtime.revision + 1 },
    { runtimeBuild: { ...runtime.runtimeBuild, processId: runtime.runtimeBuild.processId + 1 } },
    { runtimeBuild: { ...runtime.runtimeBuild, startedAt: '2026-10-20T12:00:00.000Z' } },
    { runtimeBuild: { ...runtime.runtimeBuild, build: { ...runtime.runtimeBuild.build, sourceSha256: 'a'.repeat(64) } } },
  ]) {
    let statusReads = 0;
    await assert.rejects(macReleaseStatus(source, directory, async args => args[0] === 'status' && ++statusReads === 2
      ? { status: { ...runtime, ...change } } : agent(args), async () => {}), /changed during engine verification|after engine verification has a different/);
  }
});
