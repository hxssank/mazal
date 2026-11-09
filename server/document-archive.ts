import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { DocumentError, MAX_DOCUMENT_BYTES, sourceFilename, sourceExtensions, fileType, validateArchivedDocument, type DocumentMetadata } from './documents.ts';
import { MAX_DOCUMENT_ARCHIVE_BYTES } from '../shared/recovery.ts';
export { sourceFilename } from './documents.ts';

export interface ArchivedSource { sha256: string; sourceFiles: string[]; bytes: number; mimeType: string; originalPath: string }
export interface DecodedDocumentArchive { manifest: Record<string, unknown>; documents: (DocumentMetadata & { originalPath: string })[]; reviewSources: ArchivedSource[]; files: Map<string, Buffer> }
function fail(message: string): never { throw new DocumentError(400, message); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('The archive manifest is invalid.');
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export function decodeDocumentArchive(input: Uint8Array, maximum = MAX_DOCUMENT_ARCHIVE_BYTES): DecodedDocumentArchive {
  if (!input.byteLength || input.byteLength > maximum) throw new DocumentError(413, 'Document archives support up to 256 MiB of compressed or uncompressed data.');
  let tar: Buffer;
  try { tar = gunzipSync(input, { maxOutputLength: maximum }); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') throw new DocumentError(413, 'Document archives support up to 256 MiB of uncompressed data.');
    return fail('Choose a complete Mazal .tar.gz original-file archive.');
  }
  if (tar.length % 512 !== 0) fail('The archive has an incomplete tar record.');
  const files = new Map<string, Buffer>();
  let ended = false;
  const field = (buffer: Buffer): string => {
    const end = buffer.indexOf(0);
    if (end >= 0 && buffer.subarray(end).some(byte => byte !== 0)) fail('The archive contains an invalid tar field.');
    return buffer.subarray(0, end < 0 ? undefined : end).toString('ascii');
  };
  const octal = (buffer: Buffer): number => {
    const text = buffer.toString('ascii').replace(/\0/g, '').trim();
    if (!/^[0-7]+$/.test(text)) fail('The archive contains an invalid tar number.');
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value)) fail('The archive contains an oversized tar number.');
    return value;
  };
  for (let offset = 0; offset < tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || tar.subarray(offset).some(byte => byte !== 0)) fail('The archive has an invalid end marker.');
      ended = true; break;
    }
    if (header.length !== 512 || field(header.subarray(257, 263)) !== 'ustar' || header.subarray(263, 265).toString('ascii') !== '00') fail('The archive must contain ordinary ustar file records.');
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(header.subarray(148, 156)) !== checksum) fail('The archive tar checksum does not match.');
    if (![0, 48].includes(header[156]) || field(header.subarray(157, 257)) || field(header.subarray(345, 500))) fail('The archive cannot contain directories, links, or extended paths.');
    const name = field(header.subarray(0, 100));
    if (!/^(manifest\.json|originals\/[a-f0-9]{64}\.(pdf|png|jpg|heic|csv)|review-sources\/[a-f0-9]{64}\.(csv|json|pdf|png|jpg|heic))$/.test(name)) fail('The archive contains a file outside the allowed original-file paths.');
    if (files.has(name) || files.size >= 10001) fail('The archive contains duplicate paths or too many files.');
    const size = octal(header.subarray(124, 136));
    if (size > (name === 'manifest.json' ? 16 * 1024 * 1024 : MAX_DOCUMENT_BYTES)) throw new DocumentError(413, 'An archive entry exceeds its size limit.');
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length || tar.subarray(offset + 512 + size, next).some(byte => byte !== 0)) fail('The archive contains an incomplete file or invalid padding.');
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset = next;
  }
  if (!ended || !files.has('manifest.json')) fail('The archive is missing its manifest or end marker.');
  let manifest: Record<string, unknown>;
  try { manifest = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get('manifest.json')!))); }
  catch { return fail('The archive manifest is not valid UTF-8 JSON.'); }
  if (manifest.format !== 'mazal-document-library' || manifest.version !== 1 || !Array.isArray(manifest.documents) || manifest.documents.length > 10000 || (manifest.reviewSources !== undefined && !Array.isArray(manifest.reviewSources))) fail('Choose a Mazal version 1 original-file archive.');
  if (typeof manifest.exportedAt !== 'string' || !Number.isFinite(Date.parse(manifest.exportedAt)) || new Date(manifest.exportedAt).toISOString() !== manifest.exportedAt) fail('The archive export date is invalid.');
  const used = new Set(['manifest.json']);
  const documents = manifest.documents.map(value => {
    const raw = object(value);
    const path = raw.originalPath;
    if (typeof path !== 'string' || !path.startsWith('originals/') || used.has(path) || !files.has(path)) fail('An archived document is missing or listed more than once.');
    const document = validateArchivedDocument(raw, files.get(path)!);
    const extension = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/heic': 'heic', 'text/csv; charset=utf-8': 'csv' }[document.mimeType];
    if (path !== `originals/${document.sha256}.${extension}`) fail('An archived document path does not match its identity.');
    used.add(path);
    return { ...document, originalPath: path };
  });
  const aliases = new Set<string>();
  const reviewSources = ((manifest.reviewSources ?? []) as unknown[]).map(value => {
    const raw = object(value);
    if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256) || !Array.isArray(raw.sourceFiles) || !raw.sourceFiles.length || raw.sourceFiles.length > 10000) fail('An archived review source has an invalid identity.');
    if (!Object.hasOwn(sourceExtensions, String(raw.mimeType))) fail('An archived review source has an invalid file type.');
    const originalPath = `review-sources/${raw.sha256}.${sourceExtensions[String(raw.mimeType)]}`;
    const bytes = files.get(originalPath);
    if (raw.originalPath !== originalPath || used.has(originalPath) || !bytes || raw.bytes !== bytes.length || hash(bytes) !== raw.sha256) fail('An archived review source is missing, duplicated, or has a different size or SHA-256.');
    if (!['text/csv; charset=utf-8', 'application/json; charset=utf-8'].includes(String(raw.mimeType)) && fileType(bytes).mimeType !== raw.mimeType) fail('An archived source does not match its file type.');
    const sourceFiles = raw.sourceFiles.map(value => {
      const name = sourceFilename(value);
      const key = name.normalize('NFC').toLowerCase();
      if (aliases.has(key)) fail('Review sources have duplicate or case-colliding destination names.');
      if (documents.length + aliases.size >= 10000) fail('The archive would restore more than 10,000 original files.');
      aliases.add(key); return name;
    });
    if (!Array.isArray(raw.restorePaths) || JSON.stringify(raw.restorePaths) !== JSON.stringify(sourceFiles.map(name => `source-documents/${name}`))) fail('An archived review source has an invalid restore path.');
    used.add(originalPath);
    return { sha256: raw.sha256, sourceFiles, bytes: bytes.length, mimeType: raw.mimeType as string, originalPath };
  });
  if (used.size !== files.size) fail('The archive contains files that are absent from its manifest.');
  return { manifest, documents, reviewSources, files };
}
