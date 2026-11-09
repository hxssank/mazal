import assert from 'node:assert/strict';
import test from 'node:test';
import { engineCheckArguments } from './check-engine.mjs';

test('engine checks retain full defaults when no target is supplied', () => {
  assert.deepEqual(engineCheckArguments('test'), ['-m', 'pytest', 'tests']);
  assert.deepEqual(engineCheckArguments('lint'), ['-m', 'ruff', 'check', '.']);
  assert.throws(() => engineCheckArguments('unknown'), /Choose test or lint/);
});

test('selected Python tests replace the full suite and accept either path spelling', () => {
  for (const path of ['tests/test_planner.py', 'backend/tests/test_planner.py', './backend/tests/test_planner.py', 'backend\\tests\\test_planner.py']) {
    assert.deepEqual(engineCheckArguments('test', [path, '-q']), ['-m', 'pytest', 'tests/test_planner.py', '-q']);
  }
  assert.deepEqual(engineCheckArguments('test', ['backend/tests/test_planner.py::test_example', '--maxfail=1']), [
    '-m', 'pytest', 'tests/test_planner.py::test_example', '--maxfail=1',
  ]);
});

test('pytest filters and opaque option values pass through without adding all tests', () => {
  assert.deepEqual(engineCheckArguments('test', ['-q', '-k', 'planner and not slow']), [
    '-m', 'pytest', '-q', '-k', 'planner and not slow',
  ]);
  assert.deepEqual(engineCheckArguments('test', ['-k', 'backend/tests', '-o', 'testpaths=tests', '--ignore=backend/tests/test_slow.py']), [
    '-m', 'pytest', '-k', 'backend/tests', '-o', 'testpaths=tests', '--ignore=tests/test_slow.py',
  ]);
  assert.deepEqual(engineCheckArguments('test', ['--ignore', 'backend/tests/test_slow.py', 'backend/tests/test_planner.py']), [
    '-m', 'pytest', '--ignore', 'tests/test_slow.py', 'tests/test_planner.py',
  ]);
});

test('Ruff accepts selected modules and forwards rule/config options', () => {
  assert.deepEqual(engineCheckArguments('lint', ['backend/mazal_engine/planner.py', '--select', 'F', '--ignore', 'F401']), [
    '-m', 'ruff', 'check', 'mazal_engine/planner.py', '--select', 'F', '--ignore', 'F401',
  ]);
  assert.deepEqual(engineCheckArguments('lint', ['mazal_engine/planner.py', '--config=backend/pyproject.toml']), [
    '-m', 'ruff', 'check', 'mazal_engine/planner.py', '--config=pyproject.toml',
  ]);
});

test('backend path normalization keeps selectors and rejects escaping targets', () => {
  assert.deepEqual(engineCheckArguments('test', ['--', './backend/tests/../tests/test_planner.py::test_example[param]']), [
    '-m', 'pytest', '--', 'tests/test_planner.py::test_example[param]',
  ]);
  assert.deepEqual(engineCheckArguments('test', ['backend/tests/test_planner.py::test_example[folder\\file]']), [
    '-m', 'pytest', 'tests/test_planner.py::test_example[folder\\file]',
  ]);
  for (const path of ['backend/../src', '../src', 'tests/../../src']) {
    assert.throws(() => engineCheckArguments('test', [path]), /inside backend/);
  }
});
