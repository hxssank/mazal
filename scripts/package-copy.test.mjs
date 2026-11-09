import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyPackageTree, verifyPackageCopy } from './package-copy.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mazal-package-copy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const destination = join(directory, 'copied');
  await mkdir(join(source, 'protocols', 'http'), { recursive: true });
  await writeFile(join(source, 'protocols', 'http', '__init__.py'), '');
  await writeFile(join(source, 'protocols', 'http', 'h11_impl.py'), 'class H11Protocol: pass\n');
  await writeFile(join(source, 'server.py'), 'from protocols.http.h11_impl import H11Protocol\n');
  return { source, destination };
}

test('package copying preserves regular files, empty modules, and nested directories', async t => {
  const { source, destination } = await fixture(t);
  await copyPackageTree(source, destination);
  await verifyPackageCopy(source, destination);
  assert.equal(await readFile(join(destination, 'protocols', 'http', 'h11_impl.py'), 'utf8'), 'class H11Protocol: pass\n');
  assert.equal((await lstat(join(destination, 'protocols', 'http', '__init__.py'))).size, 0);
  await copyPackageTree(join(source, 'server.py'), join(destination, 'single.py'));
  assert.equal(await readFile(join(destination, 'single.py'), 'utf8'), await readFile(join(source, 'server.py'), 'utf8'));
});

test('package copying preserves executable files and source directory modes', { skip: process.platform === 'win32' }, async t => {
  const { source, destination } = await fixture(t);
  await chmod(join(source, 'server.py'), 0o751);
  await chmod(join(source, 'protocols'), 0o750);
  await mkdir(join(destination, 'protocols'), { recursive: true, mode: 0o700 });
  await copyPackageTree(source, destination);
  assert.equal((await lstat(join(destination, 'server.py'))).mode & 0o777, 0o751);
  assert.equal((await lstat(join(destination, 'protocols'))).mode & 0o777, 0o750);
  await verifyPackageCopy(source, destination);
  await chmod(join(destination, 'server.py'), 0o640);
  await assert.rejects(verifyPackageCopy(source, destination), /executable permissions differ.*server\.py/);
});

test('package copying preserves relative symlinks and verification rejects changed targets', async t => {
  const { source, destination } = await fixture(t);
  try { await symlink('protocols/http/h11_impl.py', join(source, 'http.py')); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('Windows requires symlink permission for this test.');
    return;
  }
  await copyPackageTree(source, destination);
  assert.equal(await readlink(join(destination, 'http.py')), 'protocols/http/h11_impl.py');
  await rm(join(destination, 'http.py'));
  await symlink('server.py', join(destination, 'http.py'));
  await assert.rejects(verifyPackageCopy(source, destination), /symlink differs.*http\.py/);
});

test('package copy and verification use the same async filter and prune excluded directories', async t => {
  const { source, destination } = await fixture(t);
  await mkdir(join(source, '__pycache__'));
  await writeFile(join(source, '__pycache__', 'server.pyc'), 'excluded bytecode');
  await writeFile(join(source, 'server.test.ts'), 'excluded test');
  const filter = async (path, target) => {
    assert.ok(target.startsWith(destination));
    return !path.endsWith('__pycache__') && !path.endsWith('.test.ts');
  };
  await copyPackageTree(source, destination, filter);
  await verifyPackageCopy(source, destination, filter);
  await assert.rejects(lstat(join(destination, '__pycache__')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(destination, 'server.test.ts')), { code: 'ENOENT' });
  await assert.rejects(verifyPackageCopy(source, destination), /copy is missing/);
});

test('package verification rejects a missing nested runtime module or empty package marker', async t => {
  const { source, destination } = await fixture(t);
  await copyPackageTree(source, destination);
  const module = join(destination, 'protocols', 'http', 'h11_impl.py');
  await rm(module);
  await assert.rejects(verifyPackageCopy(source, destination), /copy is missing.*h11_impl\.py/);
  await copyPackageTree(source, destination);
  await rm(join(destination, 'protocols', 'http', '__init__.py'));
  await assert.rejects(verifyPackageCopy(source, destination), /copy is missing.*__init__\.py/);
});

test('package verification rejects same-size corrupt files and file type replacements', async t => {
  const { source, destination } = await fixture(t);
  await copyPackageTree(source, destination);
  const module = join(destination, 'protocols', 'http', 'h11_impl.py');
  await writeFile(module, 'class H12Protocol: pass\n');
  await assert.rejects(verifyPackageCopy(source, destination), /file contents differ.*h11_impl\.py/);
  await rm(module);
  await mkdir(module);
  await assert.rejects(verifyPackageCopy(source, destination), /not a regular file.*h11_impl\.py/);
});
