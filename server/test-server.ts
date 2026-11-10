import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';

export async function availableTestPort(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      assert.ok(address && typeof address === 'object');
      listener.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

export function waitForTestServer(child: ChildProcess, label: string, timeoutMs: number): Promise<void> {
  assert.ok(child.stdout && child.stderr, 'The test server must pipe stdout and stderr.');
  let output = '', stdout = '';
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener('error', failed);
      child.removeListener('close', closed);
      if (error) reject(error);
      else resolve();
    };
    const failed = (error: Error) => finish(new Error(`${label} could not start: ${error.message}. ${output}`));
    const closed = (code: number | null) => finish(new Error(`${label} exited with ${code}. ${output}`));
    const timer = setTimeout(() => finish(new Error(`${label} did not start. ${output}`)), timeoutMs);
    child.stdout!.on('data', bytes => {
      output = `${output}${bytes}`.slice(-32_000);
      stdout = `${stdout}${bytes}`.slice(-32_000);
      if (stdout.includes('Mazal is available')) finish();
    });
    child.stderr!.on('data', bytes => { output = `${output}${bytes}`.slice(-32_000); });
    child.once('error', failed);
    child.once('close', closed);
  });
}
