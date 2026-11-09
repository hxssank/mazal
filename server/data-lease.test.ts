import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireDataLease } from './data-lease.ts';

test('one server owns a data directory across aliases and complete restore swaps', t => {
  const parent = mkdtempSync(join(tmpdir(), 'mazal-data-lease-')); t.after(() => rmSync(parent, {recursive:true,force:true}));
  const directory = join(parent, 'data'), alias = join(parent, 'alias'); mkdirSync(directory); symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const lease = acquireDataLease(alias);
  try {
    assert.equal(lease.directory, realpathSync(directory));
    assert.throws(() => acquireDataLease(directory), /Another Mazal server/);
    assert.throws(() => acquireDataLease(alias), /Another Mazal server/);
    renameSync(directory, join(parent, 'previous')); mkdirSync(directory);
    assert.throws(() => acquireDataLease(directory), /Another Mazal server/);
  } finally { lease.close(); }
  acquireDataLease(directory).close();
});

test('the operating system releases a server lease after a process crash', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'mazal-data-crash-')); t.after(() => rmSync(parent, {recursive:true,force:true}));
  const directory = join(parent, 'data'); mkdirSync(directory);
  const module = new URL('./data-lease.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {acquireDataLease} from ${JSON.stringify(module)}; const lease=acquireDataLease(process.argv[1]); console.log('ready'); setInterval(()=>{},1000);`, directory], {stdio:['ignore','pipe','pipe']});
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise<void>((resolve,reject) => { child.stdout.once('data',()=>resolve()); child.once('error',reject); child.once('exit',code=>reject(new Error(`Lease helper exited ${code}`))); });
  assert.throws(() => acquireDataLease(directory), /Another Mazal server/);
  const exit = new Promise<void>(resolve => child.once('exit',()=>resolve())); child.kill('SIGKILL'); await exit;
  acquireDataLease(directory).close();
});
