import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeDocumentArchive } from './document-archive.ts';
import { DocumentError } from './documents.ts';

const { directory, bytes } = workerData as { directory: string; bytes: Uint8Array };
try {
  const decoded = decodeDocumentArchive(bytes);
  const directories = new Set([directory]);
  for (const [name, contents] of decoded.files) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    directories.add(dirname(path));
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600, flush: true });
  }
  if (process.platform !== 'win32') for (const path of directories) {
    const descriptor = openSync(path, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  parentPort!.postMessage({ archiveSha256: createHash('sha256').update(bytes).digest('hex'), manifest: decoded.manifest, documents: decoded.documents, reviewSources: decoded.reviewSources });
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  parentPort!.postMessage({ error: { status: error instanceof DocumentError ? error.status : 500, message: error instanceof DocumentError ? error.message : 'Mazal could not stage the original-file archive.' } });
}
parentPort!.close();
