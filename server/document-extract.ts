import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DocumentError, fileType } from './documents.ts';

export const MAX_EXTRACTION_BYTES = 10 * 1024 * 1024;
export interface ExtractedDocument { pages: { page: number; text: string; method: 'pdf-text' | 'ocr' }[]; warnings: string[] }
const execute = promisify(execFile);
const mimeTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/heic'];

export function validateExtraction(bytes: Buffer, mimeType: string): string {
  if (!bytes.length || bytes.length > MAX_EXTRACTION_BYTES) throw new DocumentError(413, 'Text extraction accepts files up to 10 MiB.');
  if (!mimeTypes.includes(mimeType)) throw new DocumentError(415, 'Choose a PDF, PNG, JPEG, or HEIC original for text extraction.');
  const detected = fileType(bytes);
  if (detected.mimeType !== mimeType) throw new DocumentError(415, 'The document contents do not match its file type.');
  return detected.extension;
}

export function createDocumentExtractor(root: string) {
  let busy = false;
  let developmentHelper: { directory: string; binary: string } | undefined;
  async function helper(): Promise<string> {
    const packaged = join(root, '..', 'runtime', 'mazal-extract');
    if (existsSync(packaged)) return packaged;
    if (developmentHelper) return developmentHelper.binary;
    const source = join(root, 'macos', 'ExtractText.swift');
    if (!existsSync(source)) throw new DocumentError(503, 'Local text extraction is missing from this copy of Mazal. Install the current Mac app or enter details manually.');
    const directory = await mkdtemp(join(tmpdir(), 'mazal-extract-helper-'));
    await chmod(directory, 0o700);
    const binary = join(directory, 'mazal-extract');
    try {
      await execute('/usr/bin/swiftc', ['-swift-version', '5', '-O', '-framework', 'AppKit', '-framework', 'PDFKit', '-framework', 'Vision', join(root, 'macos', 'ExtractText.swift'), '-o', binary], { timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      developmentHelper = { directory, binary };
      return binary;
    } catch {
      await rm(directory, { recursive: true, force: true });
      throw new DocumentError(503, 'Local text extraction needs the Mac app or Apple command line tools. Enter the details manually for now.');
    }
  }
  return {
    async extract(bytes: Buffer, mimeType: string): Promise<ExtractedDocument> {
      const extension = validateExtraction(bytes, mimeType);
      if (process.platform !== 'darwin') throw new DocumentError(503, 'Text extraction runs locally in the Mac app. Enter the details manually on this computer.');
      if (busy) throw new DocumentError(409, 'Another document is being read. Wait for it to finish.');
      busy = true;
      let directory: string | undefined;
      try {
        const binary = await helper();
        directory = await mkdtemp(join(tmpdir(), 'mazal-extract-document-'));
        await chmod(directory, 0o700);
        const path = join(directory, `original${extension}`);
        await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
        const result = await execute(binary, [path], { timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
        const extracted = JSON.parse(result.stdout) as ExtractedDocument;
        if (!Array.isArray(extracted.pages) || !extracted.pages.length || extracted.pages.length > 20 || extracted.pages.some((page, index) => page.page !== index + 1 || typeof page.text !== 'string' || !['pdf-text', 'ocr'].includes(page.method)) || !Array.isArray(extracted.warnings) || extracted.warnings.some(warning => typeof warning !== 'string')) throw new Error('Invalid extraction response.');
        return extracted;
      } catch (error) {
        if (error instanceof DocumentError) throw error;
        if (error && typeof error === 'object' && 'killed' in error && error.killed) throw new DocumentError(408, 'Text extraction took longer than 45 seconds. Try fewer pages or enter details manually.');
        if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') {
          let failure: { error?: unknown; status?: unknown } = {};
          try { failure = JSON.parse(error.stdout); } catch {}
          if (typeof failure.error === 'string' && [400, 413, 422].includes(Number(failure.status))) throw new DocumentError(Number(failure.status), failure.error);
        }
        throw new DocumentError(422, 'This document could not be read. Review the original and enter its details manually.');
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
        busy = false;
      }
    },
    async close(): Promise<void> { if (developmentHelper) { await rm(developmentHelper.directory, { recursive: true, force: true }); developmentHelper = undefined; } },
  };
}
