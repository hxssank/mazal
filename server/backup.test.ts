import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { BackupError, decodeBackup, type BackupContentType } from './backup.ts';

test('encoded backups preserve UTF-8 JSON through plain and gzip decoding', () => {
  const original = { description: 'Café payment', amountCents: 123, source: { text: 'Original source.' } };
  const json = Buffer.from(JSON.stringify(original));
  assert.deepEqual(decodeBackup(json, 'application/json', 0), original);
  assert.deepEqual(decodeBackup(gzipSync(json), 'application/gzip', 0), original);
  const wrapped = Buffer.concat([Buffer.from('prefix'), json, Buffer.from('suffix')]);
  assert.deepEqual(decodeBackup(wrapped.subarray(6, 6 + json.length), 'application/json', 0), original);
});

test('encoded backup limits cover compressed input and decompressed output', () => {
  const limit = 128;
  const tooLarge = Buffer.alloc(limit + 1, 32);
  for (const type of ['application/json', 'application/gzip'] as const) {
    assert.throws(() => decodeBackup(tooLarge, type, 0, limit), error => error instanceof BackupError && error.status === 413);
  }
  assert.throws(() => decodeBackup(gzipSync(tooLarge), 'application/gzip', 0, limit), error => error instanceof BackupError && error.status === 413);
  const atLimit = Buffer.from(`{"source":"${'x'.repeat(limit - 13)}"}`);
  assert.equal(atLimit.length, limit);
  assert.deepEqual(decodeBackup(atLimit, 'application/json', 0, limit), JSON.parse(atLimit.toString()));
});

test('encoded backups reject invalid content types, revisions, gzip, JSON and UTF-8', () => {
  const json = Buffer.from('{}');
  assert.throws(() => decodeBackup(json, 'text/plain' as BackupContentType, 0), error => error instanceof BackupError && error.status === 415);
  for (const revision of [undefined, null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => decodeBackup(json, 'application/json', revision), error => error instanceof BackupError && error.status === 400);
  }
  for (const bytes of [Buffer.from('broken gzip'), gzipSync(json).subarray(0, 10)]) {
    assert.throws(() => decodeBackup(bytes, 'application/gzip', 0), /compressed backup is incomplete or invalid/);
  }
  assert.throws(() => decodeBackup(Buffer.from('{"incomplete":'), 'application/json', 0), /not valid JSON/);
  const invalidUtf8 = Buffer.concat([Buffer.from('{"source":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  for (const [bytes, type] of [[invalidUtf8, 'application/json'], [gzipSync(invalidUtf8), 'application/gzip']] as const) {
    assert.throws(() => decodeBackup(bytes, type, 0), /not valid JSON/);
  }
});
