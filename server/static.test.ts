import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { staticFile } from './static.ts';

test('production pages resolve their own directory index and missing assets never return app HTML', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-static-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'reports'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<html>Mazal</html>');
  writeFileSync(join(directory, 'reports', 'index.html'), '<html>Saved reports</html>');
  writeFileSync(join(directory, 'assets', 'main.js'), 'export {};');
  for (const route of ['/reports', '/reports/', '/reports/index.html']) assert.deepEqual(staticFile(directory, route), { status: 200, path: join(directory, 'reports', 'index.html') });
  assert.deepEqual(staticFile(directory, '/'), { status: 200, path: join(directory, 'index.html') });
  assert.deepEqual(staticFile(directory, '/expenses'), { status: 200, path: join(directory, 'index.html') });
  assert.deepEqual(staticFile(directory, '/assets/main.js'), { status: 200, path: join(directory, 'assets', 'main.js') });
  for (const route of ['/assets/missing.js', '/assets/missing', '/missing.css', '/reports/missing.js']) assert.equal(staticFile(directory, route).status, 404);
  assert.equal(staticFile(directory, '/%2e%2e/private.txt').status, 403);
  assert.equal(staticFile(directory, '/bad%encoding').status, 400);
});

test('an unbuilt project returns an actionable service error', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-unbuilt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(staticFile(directory, '/').status, 503);
});

test('static files cannot escape the build through file, directory or fallback symlinks', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-static-links-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'dist');
  const outside = join(directory, 'private');
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(join(root, 'reports'));
  writeFileSync(join(outside, 'index.html'), 'private data');
  writeFileSync(join(root, 'app.js'), 'export {};');
  symlinkSync(join(outside, 'index.html'), join(root, 'secret.txt'));
  symlinkSync(outside, join(root, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(outside, 'index.html'), join(root, 'reports', 'index.html'));
  symlinkSync(join(outside, 'index.html'), join(root, 'index.html'));
  symlinkSync(join(root, 'app.js'), join(root, 'linked-app.js'));
  for (const path of ['/secret.txt', '/linked-directory', '/linked-directory/index.html', '/reports', '/', '/expenses']) {
    assert.equal(staticFile(root, path).status, 403, path);
  }
  assert.deepEqual(staticFile(root, '/linked-app.js'), { status: 200, path: join(root, 'linked-app.js') });
});
