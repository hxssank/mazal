import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DocumentError, MAX_DOCUMENT_BYTES, fileType, sourceFilename } from './documents.ts';
import type { DocumentArchiveSource } from './documents.ts';
import { MAX_DOCUMENT_ARCHIVE_BYTES } from '../shared/recovery.ts';
import type { AppState } from '../shared/types.ts';

interface ReviewSource { sourceFile: string; sha256: string; accountId?: string }

export function statementReviewSources(state: AppState, financePath: string): ReviewSource[] {
  const sources: ReviewSource[] = [...state.statements ?? [], ...(state.importBatches ?? []).map(batch => batch.source)];
  const database = new DatabaseSync(financePath, { readOnly: true });
  try {
    const hasHistory = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'original_imports'").get();
    const archived = hasHistory ? database.prepare('SELECT data FROM original_imports ORDER BY position').all() as { data: string }[] : [];
    const pending: unknown[] = archived.map(row => JSON.parse(row.data).source);
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value)) { for (const item of value) pending.push(item); continue; }
      const record = value as Record<string, unknown>;
      if (typeof record.sourceFile === 'string' && typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256)) {
        const accountId = typeof record.accountId === 'string' ? record.accountId : undefined;
        if (!sources.some(source => source.sourceFile === record.sourceFile && source.sha256 === record.sha256 && (accountId === undefined || source.accountId === accountId))) sources.push({ sourceFile: record.sourceFile, sha256: record.sha256, ...(accountId ? { accountId } : {}) });
      }
      for (const item of Object.values(record)) pending.push(item);
    }
  } finally { database.close(); }
  return [...new Map(sources.map(source => [JSON.stringify([source.sourceFile, source.sha256, source.accountId]), source])).values()];
}

export function readReviewSource(directory: string, source: { sourceFile: string; sha256: string }): { bytes: Buffer; mimeType: string; originalName: string } {
  const name = source.sourceFile;
  const extension = typeof name === 'string' ? extname(name).toLowerCase() : '';
  if (!name || name !== basename(name) || name.includes('\\') || /[\u0000-\u001f]/u.test(name) || !['.csv', '.json', '.pdf', '.png', '.jpg', '.jpeg', '.heic'].includes(extension) || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new DocumentError(404, 'Review source was not found.');
  const path = join(directory, name);
  let bytes: Buffer;
  try {
    const details = lstatSync(path);
    if (!details.isFile()) throw new DocumentError(404, 'Review source was not found.');
    if (details.size > MAX_DOCUMENT_BYTES) throw new DocumentError(413, 'The review source exceeds 25 MB.');
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw new DocumentError(404, 'The original review source is missing from this computer.');
    throw error;
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentError(413, 'The review source exceeds 25 MB.');
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new DocumentError(409, 'The original review source changed. Restore the file matching the saved statement SHA-256.');
  return { bytes, mimeType: extension === '.csv' ? 'text/csv; charset=utf-8' : extension === '.json' ? 'application/json; charset=utf-8' : fileType(bytes).mimeType, originalName: name };
}

export function reviewSourcesForArchive(directory: string, sources: { sourceFile: string; sha256?: string }[]): DocumentArchiveSource[] {
  const checked = new Set<string>();
  const originals = new Map<string, DocumentArchiveSource>();
  let totalBytes = 0;
  const withPreviews = sources.flatMap(source => {
    const preview = source.sourceFile.replace(/\.heic$/i, '.png');
    return preview !== source.sourceFile && existsSync(join(directory, preview)) ? [source, { sourceFile: preview }] : [source];
  });
  for (const source of withPreviews) {
    let name = sourceFilename(source.sourceFile);
    if (/\.heic$/i.test(name) && !existsSync(join(directory, name)) && existsSync(join(directory, name.replace(/\.heic$/i, '.png')))) name = name.replace(/\.heic$/i, '.png');
    const key = JSON.stringify([name, source.sha256]);
    if (checked.has(key)) continue;
    if (!existsSync(join(directory, name))) throw new DocumentError(404, 'The original source is missing from this computer.');
    const details = lstatSync(join(directory, name));
    if (!details.isFile() || details.size > MAX_DOCUMENT_BYTES) throw new DocumentError(413, 'A source original is not an ordinary file within the 25 MB limit.');
    const bytes = readFileSync(join(directory, name));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (source.sha256 && sha256 !== source.sha256) throw new DocumentError(409, 'A source original does not match its saved SHA-256.');
    const extension = extname(name).toLowerCase();
    const mimeType = extension === '.json' ? 'application/json; charset=utf-8' : extension === '.csv' ? 'text/csv; charset=utf-8' : fileType(bytes).mimeType;
    const original = { bytes, mimeType };
    checked.add(key);
    const saved = originals.get(sha256);
    if (saved) { if (!saved.sourceFiles.includes(name)) saved.sourceFiles.push(name); }
    else {
      totalBytes += original.bytes.length;
      if (totalBytes > MAX_DOCUMENT_ARCHIVE_BYTES) throw new DocumentError(413, 'The original-file library exceeds the 256 MiB restore archive limit. Quit Mazal, then copy its full data folder to back it up.');
      originals.set(sha256, { sha256, sourceFiles: [name], mimeType: original.mimeType, bytes: original.bytes });
    }
  }
  return [...originals.values()];
}
