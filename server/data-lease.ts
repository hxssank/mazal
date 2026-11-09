import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function acquireDataLease(directory: string): { directory: string; close(): void } {
  const requested = resolve(directory);
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  const canonical = existsSync(requested) ? realpathSync(requested) : join(realpathSync(dirname(requested)), basename(requested));
  const path = join(dirname(canonical), `.${basename(canonical)}.mazal-server.sqlite`);
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('The Mazal server lease must be an ordinary local file.');
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(pid INTEGER NOT NULL); DELETE FROM owner;');
    database.prepare('INSERT INTO owner(pid) VALUES(?)').run(process.pid);
  } catch (error) {
    database?.close();
    if (error instanceof Error && 'code' in error && String(error.code).includes('SQLITE')) throw new Error('Another Mazal server is using this data folder. Close that app or server before opening these records.');
    throw error;
  }
  let closed = false;
  return { directory: canonical, close() { if (closed) return; closed = true; database!.close(); } };
}
