import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureBuildStatus } from './build-status.ts';

const identity = { format: 'mazal-web-build', schemaVersion: 1, version: '0.2.0-rc.3', sourceSha256: 'a'.repeat(64), assetsSha256: 'b'.repeat(64), nodeVersion: '24.22.0', pythonVersion: '3.13.16', assets: [{ path: 'index.html' }] };

function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'mazal-build-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist'));
  return { root, path: join(root, 'dist', 'BUILD.json') };
}

test('runtime identity remains the startup build after metadata is replaced or removed', t => {
  const { root, path } = fixture(t);
  writeFileSync(path, JSON.stringify(identity));
  const status = captureBuildStatus(root);
  assert.equal(status.identityStatus, 'available');
  assert.equal(status.processId, process.pid);
  assert.ok(Number.isFinite(Date.parse(status.startedAt)));
  const { format: _format, schemaVersion: _schemaVersion, assets: _assets, ...expected } = identity;
  assert.deepEqual(status.build, expected);
  writeFileSync(path, JSON.stringify({ ...identity, sourceSha256: 'c'.repeat(64) }));
  assert.equal(status.build!.sourceSha256, identity.sourceSha256);
  assert.equal(captureBuildStatus(root).build!.sourceSha256, 'c'.repeat(64));
  rmSync(path);
  assert.deepEqual(status.build, expected);
  assert.ok(Object.isFrozen(status));
  assert.ok(Object.isFrozen(status.build));
  assert.throws(() => Object.assign(status.build!, { sourceSha256: 'd'.repeat(64) }), TypeError);
});

test('missing startup metadata never becomes a claimed running identity when a build appears later', t => {
  const { root, path } = fixture(t);
  const status = captureBuildStatus(root);
  assert.equal(status.identityStatus, 'missing');
  assert.equal(status.build, null);
  writeFileSync(path, JSON.stringify(identity));
  assert.equal(status.build, null);
  assert.equal(captureBuildStatus(root).identityStatus, 'available');
});

test('malformed or incomplete metadata reports unavailable identity without exposing its contents', t => {
  const { root, path } = fixture(t);
  for (const content of ['secret invalid JSON', 'null', '[]', '{}', ...[
    { format: 'other' }, { schemaVersion: 2 }, { version: '' }, { sourceSha256: 'secret' }, { assetsSha256: null }, { nodeVersion: null }, { pythonVersion: '3.13' },
  ].map(change => JSON.stringify({ ...identity, ...change }))]) {
    writeFileSync(path, content);
    const status = captureBuildStatus(root);
    assert.equal(status.identityStatus, 'invalid');
    assert.equal(status.build, null);
    assert.equal(JSON.stringify(status).includes('secret'), false);
  }
});
