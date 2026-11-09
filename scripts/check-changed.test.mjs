import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildDependencyGraph, checkChanged, planChangedChecks, projectPath, testFingerprint } from './check-changed.mjs';

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mazal-changed-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': '{"type":"module"}',
    'package-lock.json': '{"lockfileVersion":3}',
    'src/features/home/Home.tsx': "import { amount } from '../../../shared/money'; import './home.css'; export const Home = () => amount;",
    'src/features/home/home.css': '.home { color: red; }',
    'src/app/App.tsx': "export { Home } from '../features/home/Home';",
    'shared/money.ts': 'export const amount = 1;',
    'shared/unrelated.ts': 'export const other = 1;',
    'src/home.test.ts': "await import('./features/home/Home.tsx');",
    'src/app.test.ts': "import './app/App.tsx';",
    'shared/money.test.ts': "import './money.ts';",
    'shared/unrelated.test.ts': "import './unrelated.ts';",
    'tests/desktop/home.spec.ts': "import { test } from '@playwright/test';",
    'scripts/check-changed.mjs': 'export const version = 1;',
    ...extra,
  };
  for (const [file, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), value);
  }
  return root;
}

const quiet = () => {};

test('transitive TS imports, re-exports, dynamic imports and stylesheet changes select related tests', async t => {
  const root = await fixture(t);
  const graph = await buildDependencyGraph(root);
  const money = planChangedChecks(graph, ['shared/money.ts']);
  assert.deepEqual(money.nodeTests, ['shared/money.test.ts', 'src/app.test.ts', 'src/home.test.ts']);
  assert.equal(money.full, false);
  assert.deepEqual(money.browserTests, ['tests/desktop/home.spec.ts']);
  const css = planChangedChecks(graph, ['src/features/home/home.css']);
  assert.deepEqual(css.nodeTests, ['src/app.test.ts', 'src/home.test.ts']);
  assert.deepEqual(planChangedChecks(graph, ['src/home.test.ts']).browserTests, []);
});

test('require and new URL references preserve coverage for removed files and test fixtures', async t => {
  const root = await fixture(t, {
    'server/record.test.ts': "const api = require('./removed'); const data = new URL('./fixture.json', import.meta.url);",
    'server/fixture.json': '{}',
  });
  const graph = await buildDependencyGraph(root);
  assert.deepEqual(planChangedChecks(graph, ['server/removed.ts']).nodeTests, ['server/record.test.ts']);
  assert.deepEqual(planChangedChecks(graph, ['server/fixture.json']).nodeTests, ['server/record.test.ts']);
});

test('configuration and unknown paths fall back to all Node tests while Python requests engine checks', async t => {
  const root = await fixture(t);
  const graph = await buildDependencyGraph(root);
  for (const file of ['package-lock.json', 'scripts/build.mjs', 'unknown.file']) {
    const plan = planChangedChecks(graph, [file]);
    assert.equal(plan.full, true);
    assert.equal(plan.nodeTests.length, 4);
  }
  const python = planChangedChecks(graph, ['backend/mazal_engine/planner.py']);
  assert.equal(python.python, true);
  assert.deepEqual(python.nodeTests, []);
  assert.equal(python.browserTests.length, 1);
});

test('changed paths normalize absolute files and reject files outside the checkout', async t => {
  const root = await fixture(t);
  assert.equal(projectPath(root, join(root, 'shared/money.ts')), 'shared/money.ts');
  assert.throws(() => projectPath(root, '../outside.ts'), /inside the project/);
  assert.throws(() => projectPath(root, root), /inside the project/);
});

test('test fingerprints change for imported sources, dependency locks, runtime, and unresolved file reads', async t => {
  const root = await fixture(t, { 'src/dynamic.test.ts': "import { readFileSync } from 'node:fs'; readFileSync(process.env.FILE);" });
  const before = await buildDependencyGraph(root);
  const home = testFingerprint(before, 'src/home.test.ts', '24.0.0');
  const unrelated = testFingerprint(before, 'shared/unrelated.test.ts', '24.0.0');
  const dynamic = testFingerprint(before, 'src/dynamic.test.ts', '24.0.0');
  await writeFile(join(root, 'shared/money.ts'), 'export const amount = 2;');
  const after = await buildDependencyGraph(root);
  assert.notEqual(testFingerprint(after, 'src/home.test.ts', '24.0.0'), home);
  assert.equal(testFingerprint(after, 'shared/unrelated.test.ts', '24.0.0'), unrelated);
  assert.notEqual(testFingerprint(after, 'src/dynamic.test.ts', '24.0.0'), dynamic);
  assert.notEqual(testFingerprint(after, 'shared/unrelated.test.ts', '24.1.0'), unrelated);
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":4}');
  assert.notEqual(testFingerprint(await buildDependencyGraph(root), 'shared/unrelated.test.ts', '24.0.0'), unrelated);
});

test('only successful unchanged test runs enter the cache, and no-cache forces another run', async t => {
  const root = await fixture(t);
  const paths = ['src/features/home/Home.tsx'];
  const calls = [];
  const runner = async (_command, args) => { calls.push(args); };
  const first = await checkChanged({ root, paths, runner, log: quiet });
  assert.equal(first.tests.length, 2);
  const second = await checkChanged({ root, paths, runner, log: quiet });
  assert.equal(second.tests.length, 0);
  assert.equal(second.cached.length, 2);
  assert.equal(calls.length, 1);
  await checkChanged({ root, paths, runner, noCache: true, log: quiet });
  assert.equal(calls.length, 2);
  await writeFile(join(root, 'src/features/home/home.css'), '.home { color: blue; }');
  await assert.rejects(checkChanged({ root, paths, runner: async () => { throw new Error('Test failed'); }, log: quiet }), /Test failed/);
  const retry = await checkChanged({ root, paths, list: true, runner, log: quiet });
  assert.equal(retry.tests.length, 2);
  assert.equal(calls.length, 2);
});

test('list mode never executes tests or creates a cache, and edits during execution are not cached', async t => {
  const root = await fixture(t);
  const paths = ['shared/money.ts'];
  await checkChanged({ root, paths, list: true, runner: async () => assert.fail('List must not run tests'), log: quiet });
  await assert.rejects(readFile(join(root, 'outputs/changed-checks-cache.json')), { code: 'ENOENT' });
  await checkChanged({ root, paths, runner: async () => { await writeFile(join(root, 'shared/money.ts'), 'export const amount = 3;'); }, log: quiet });
  const after = await checkChanged({ root, paths, list: true, log: quiet });
  assert.equal(after.cached.length, 0);
  assert.equal(after.tests.length, 3);
});

test('default dirty discovery excludes checked configuration so later feature edits select only affected tests', async t => {
  const root = await fixture(t);
  const dirty = ['package.json', 'src/features/home/Home.tsx'];
  const discoverChanges = async () => dirty;
  const runner = async () => {};
  const first = await checkChanged({ root, discoverChanges, runner, log: quiet });
  assert.equal(first.full, true);
  assert.equal(first.tests.length, 4);
  const unchanged = await checkChanged({ root, discoverChanges, runner, log: quiet });
  assert.equal(unchanged.tests.length, 0);
  assert.equal(unchanged.previouslyChecked, 2);
  await writeFile(join(root, 'src/features/home/Home.tsx'), "import { amount } from '../../../shared/money'; import './home.css'; export const Home = () => amount + 1;");
  const next = await checkChanged({ root, discoverChanges, runner, log: quiet });
  assert.equal(next.full, false);
  assert.deepEqual(next.changed, ['src/features/home/Home.tsx']);
  assert.deepEqual(next.tests, ['src/app.test.ts', 'src/home.test.ts']);
  assert.equal(next.previouslyChecked, 1);
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":4}');
  const newContext = await checkChanged({ root, discoverChanges, list: true, log: quiet });
  assert.equal(newContext.previouslyChecked, 0);
  assert.equal(newContext.full, true);
});

test('default baseline does not mark uncovered production files or failed checks as validated', async t => {
  const root = await fixture(t, { 'src/uncovered.ts': 'export const newView = 1;' });
  const discoverChanges = async () => ['src/uncovered.ts'];
  await checkChanged({ root, discoverChanges, runner: async () => assert.fail('No test imports this file'), log: quiet });
  const again = await checkChanged({ root, discoverChanges, list: true, log: quiet });
  assert.equal(again.previouslyChecked, 0);
  assert.deepEqual(again.untested, ['src/uncovered.ts']);
  await assert.rejects(checkChanged({ root, discoverChanges: async () => ['package.json'], runner: async () => { throw new Error('Fail'); }, log: quiet }), /Fail/);
  const failed = await checkChanged({ root, discoverChanges: async () => ['package.json'], list: true, log: quiet });
  assert.equal(failed.previouslyChecked, 0);
  assert.equal(failed.tests.length, 4);
});

test('engine checks have a separate success cache invalidated by backend, lock, and Python environment changes', async t => {
  const root = await fixture(t, {
    'backend/mazal_engine/planner.py': 'def project(): return 1',
    'backend/tests/test_planner.py': 'def test_project(): pass',
    'backend/uv.lock': 'version = 1',
    'backend/.python-version': '3.13.0',
    'scripts/check-engine.mjs': 'export const runEngine = true;',
  });
  const paths = ['backend/mazal_engine/planner.py'];
  let python = 'Python 3.13.0 with pytest 8.0';
  const pythonIdentity = async () => python;
  const calls = [];
  const runner = async (_command, args) => { calls.push(args); };
  assert.equal((await checkChanged({ root, paths, engine: true, runner, pythonIdentity, log: quiet })).engineStatus, 'passed');
  assert.deepEqual(calls, [['scripts/check-engine.mjs', 'lint'], ['scripts/check-engine.mjs', 'test']]);
  assert.equal((await checkChanged({ root, paths, engine: true, runner, pythonIdentity, log: quiet })).engineStatus, 'cached');
  assert.equal(calls.length, 2);
  await writeFile(join(root, 'backend/uv.lock'), 'version = 2');
  await checkChanged({ root, paths, engine: true, runner, pythonIdentity, log: quiet });
  assert.equal(calls.length, 4);
  python = 'Python 3.13.1 with pytest 9.0';
  await checkChanged({ root, discoverChanges: async () => paths, engine: true, runner, pythonIdentity, log: quiet });
  assert.equal(calls.length, 6);
  const unchanged = await checkChanged({ root, discoverChanges: async () => paths, engine: true, runner, pythonIdentity, log: quiet });
  assert.equal(unchanged.previouslyChecked, 1);
  assert.equal(calls.length, 6);
  await checkChanged({ root, paths, engine: true, noCache: true, runner, pythonIdentity, log: quiet });
  assert.equal(calls.length, 8);
});

test('engine failures and edits during validation cannot create a passing engine baseline', async t => {
  const root = await fixture(t, { 'backend/mazal_engine/planner.py': 'def project(): return 1' });
  const paths = ['backend/mazal_engine/planner.py'];
  const pythonIdentity = async () => 'Python test runtime';
  await assert.rejects(checkChanged({ root, paths, engine: true, pythonIdentity, runner: async (_command, args) => { if (args.at(-1) === 'test') throw new Error('Engine failure'); }, log: quiet }), /Engine failure/);
  assert.equal(JSON.parse(await readFile(join(root, 'outputs/changed-checks-cache.json'), 'utf8')).engine, undefined);
  await checkChanged({ root, paths, engine: true, pythonIdentity, runner: async () => { await writeFile(join(root, paths[0]), 'def project(): return 2'); }, log: quiet });
  const next = await checkChanged({ root, discoverChanges: async () => paths, engine: true, pythonIdentity, list: true, log: quiet });
  assert.equal(next.previouslyChecked, 0);
  assert.equal(next.engineStatus, 'planned');
});


test('a failed forced rerun invalidates the older passing result and dirty baseline', async t => {
  const root = await fixture(t);
  const paths = ['src/features/home/Home.tsx'];
  await checkChanged({ root, paths, runner: async () => {}, log: quiet });
  await assert.rejects(checkChanged({ root, paths, noCache: true, runner: async () => { throw new Error('New failure'); }, log: quiet }), /New failure/);
  const next = await checkChanged({ root, discoverChanges: async () => paths, list: true, log: quiet });
  assert.equal(next.previouslyChecked, 0);
  assert.equal(next.cached.length, 0);
  assert.equal(next.tests.length, 2);
});

test('literal launch paths and source file arrays select process and file-reading tests', async t => {
  const root = await fixture(t, {
    'server/index.ts': 'export const server = true;',
    'scripts/start.mjs': "const server = ['server/index.ts'];",
    'server/auth.test.ts': "spawn(process.execPath, ['server/index.ts']);",
    'server/startup.test.ts': "spawn(process.execPath, ['scripts/start.mjs']);",
    'server/lifecycle.test.ts': "fixture.launch(['server/index.ts']);",
    'src/source.test.ts': "for (const file of ['src/features/home/Home.tsx']) readFileSync(file);",
    'src/relative.test.ts': "readFileSync('./features/home/Home.tsx');",
  });
  const graph = await buildDependencyGraph(root);
  assert.deepEqual(planChangedChecks(graph, ['server/index.ts']).nodeTests, ['server/auth.test.ts', 'server/lifecycle.test.ts', 'server/startup.test.ts']);
  assert.deepEqual(planChangedChecks(graph, ['src/features/home/Home.tsx']).nodeTests, ['src/app.test.ts', 'src/home.test.ts', 'src/relative.test.ts', 'src/source.test.ts']);
});

test('a changed dependency still selects checked consumers after unchanged dirty sources leave the default plan', async t => {
  const root = await fixture(t);
  let dirty = ['package.json', 'src/features/home/Home.tsx'];
  const discoverChanges = async () => dirty;
  const runner = async () => {};
  await checkChanged({ root, discoverChanges, runner, log: quiet });
  await writeFile(join(root, 'shared/money.ts'), 'export const amount = 99;');
  dirty = [...dirty, 'shared/money.ts'];
  const next = await checkChanged({ root, discoverChanges, runner, log: quiet });
  assert.deepEqual(next.changed, ['shared/money.ts']);
  assert.equal(next.previouslyChecked, 2);
  assert.deepEqual(next.tests, ['shared/money.test.ts', 'src/app.test.ts', 'src/home.test.ts']);
});
