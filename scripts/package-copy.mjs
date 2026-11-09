import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function checkCopy(source, destination, filter, setDirectoryModes = false) {
  if (filter && !await filter(source, destination)) return;
  const original = await lstat(source);
  let copied;
  try { copied = await lstat(destination); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Package copy is missing: ${destination}`, { cause: error });
  }
  if (original.isDirectory()) {
    if (!copied.isDirectory()) throw new Error(`Package copy is not a directory: ${destination}`);
    if (process.platform !== 'win32') {
      if (setDirectoryModes) await chmod(destination, original.mode & 0o777);
      else if ((original.mode & 0o777) !== (copied.mode & 0o777)) throw new Error(`Package copy directory permissions differ: ${destination}`);
    }
    for (const name of (await readdir(source)).sort()) {
      await checkCopy(join(source, name), join(destination, name), filter, setDirectoryModes);
    }
  } else if (original.isSymbolicLink()) {
    if (!copied.isSymbolicLink() || await readlink(source) !== await readlink(destination)) throw new Error(`Package copy symlink differs: ${destination}`);
  } else if (original.isFile()) {
    if (!copied.isFile()) throw new Error(`Package copy is not a regular file: ${destination}`);
    if (original.size !== copied.size) throw new Error(`Package copy file size differs: ${destination}`);
    if (process.platform !== 'win32' && (original.mode & 0o111) !== (copied.mode & 0o111)) throw new Error(`Package copy executable permissions differ: ${destination}`);
    const [sourceHash, destinationHash] = await Promise.all([hashFile(source), hashFile(destination)]);
    if (sourceHash !== destinationHash) throw new Error(`Package copy file contents differ: ${destination}`);
  } else {
    throw new Error(`Package copy source has an unsupported file type: ${source}`);
  }
}

export async function verifyPackageCopy(source, destination, filter) {
  await checkCopy(source, destination, filter);
}

export async function copyPackageTree(source, destination, filter) {
  await cp(source, destination, { recursive: true, verbatimSymlinks: true, filter });
  await checkCopy(source, destination, filter, true);
}
