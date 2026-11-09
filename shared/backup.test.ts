import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readBackupFile, serializeBackup } from './backup.ts';

test('plain and compressed backups preserve Unicode and unknown original source fields', async () => {
  const backup = { name: 'Café 存款', original: { source: ['unmodified', 123] } };
  const json = serializeBackup(backup);
  assert.deepEqual(await readBackupFile(new Blob([json])), backup);
  assert.deepEqual(await readBackupFile(new Blob([gzipSync(json)])), backup);
});

test('export and restore enforce the same uncompressed byte limit, including Unicode', async () => {
  const backup = { value: 'é'.repeat(300) };
  const json = JSON.stringify(backup);
  const bytes = Buffer.byteLength(json);
  assert.equal(serializeBackup(backup, bytes), json);
  assert.deepEqual(await readBackupFile(new Blob([json]), bytes), backup);
  assert.throws(() => serializeBackup(backup, bytes - 1), /256 MiB/);
  await assert.rejects(readBackupFile(new Blob([json]), bytes - 1), /256 MiB/);
  await assert.rejects(readBackupFile(new Blob([gzipSync(json)]), bytes - 1), /256 MiB/);
});

test('invalid JSON and truncated compressed backups never become restore objects', async () => {
  await assert.rejects(readBackupFile(new Blob(['{"incomplete":'])), SyntaxError);
  await assert.rejects(readBackupFile(new Blob([gzipSync('{"valid":true}').subarray(0, 12)])));
});
