import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

export function staticFile(directory: string, pathname: string): { path: string; status: 200 } | { error: string; status: 400 | 403 | 404 | 503 } {
  const root = resolve(directory);
  let requested: string;
  try { requested = resolve(root, `.${decodeURIComponent(pathname)}`); }
  catch { return { status: 400, error: 'Invalid path encoding.' }; }
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) return { status: 403, error: 'Invalid path.' };
  const contained = (path: string): boolean => {
    if (!existsSync(path)) return true;
    const realRoot = realpathSync(root);
    const realPath = realpathSync(path);
    return realPath === realRoot || realPath.startsWith(`${realRoot}${sep}`);
  };
  if (!contained(requested)) return { status: 403, error: 'Invalid path.' };
  if (existsSync(requested) && statSync(requested).isDirectory()) requested = join(requested, 'index.html');
  if (!contained(requested)) return { status: 403, error: 'Invalid path.' };
  if (existsSync(requested) && statSync(requested).isFile()) return { status: 200, path: requested };
  if (requested !== join(root, 'index.html') && (extname(requested) || pathname.includes('/assets/'))) return { status: 404, error: 'File was not found.' };
  const fallback = join(root, 'index.html');
  if (!contained(fallback)) return { status: 403, error: 'Invalid path.' };
  return existsSync(fallback) && statSync(fallback).isFile() ? { status: 200, path: fallback } : { status: 503, error: 'Build Mazal with npm run build, or start npm run dev.' };
}
