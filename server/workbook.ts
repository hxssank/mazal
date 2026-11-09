import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AppState } from '../shared/types.ts';
import type { DocumentMetadata } from './documents.ts';

export interface WorkbookSnapshot { state: AppState; documents: DocumentMetadata[]; generatedAt: string }
export const WORKBOOK_LAYOUT_VERSION = 10;
export interface WorkbookManifest { format: 'mazal-workbook'; version: 1; layoutVersion?: number; revision: number; documentsDigest: string; sha256: string; generatedAt: string }
export interface WorkbookStatus {
  available: boolean;
  fileName: string;
  lastUpdatedAt: string | null;
  revision?: number;
  stale?: boolean;
  modified?: boolean;
}
export class WorkbookError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const execute = promisify(execFile);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const activeReplacements = new Set<string>();
interface WorkbookPending {
  format:'mazal-workbook-pending'; version:1; temporary:string;
  previousWorkbookSha256:string|null; previousManifestSha256:string|null;
  nextWorkbookSha256:string; nextManifestSha256:string; nextManifest:string;
}
export function documentsDigest(documents: DocumentMetadata[]): string {
  return digest(JSON.stringify([...documents].sort((a, b) => a.id.localeCompare(b.id))));
}
async function optionalBytes(path: string): Promise<Buffer | null> {
  try { return (await stat(path)).isFile() ? await readFile(path) : null; }
  catch (error) { if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return null; throw error; }
}
async function syncFile(path: string): Promise<void> {
  const file = await open(path, process.platform === 'win32' ? 'r+' : 'r');
  try { await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path:string):Promise<void> {
  if (process.platform !== 'win32') await syncFile(path);
}
async function renderWorkbook(inputPath: string, outputPath: string, existingPath?: string): Promise<void> {
  const builder = fileURLToPath(new URL('../scripts/build-workbook.mjs', import.meta.url));
  try {
    await execute(process.execPath, [builder, '--input', inputPath, '--output', outputPath, ...(existingPath ? ['--existing', existingPath] : [])], { timeout: 180_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    console.error('Workbook generation failed:', error instanceof Error ? error.message : error);
    throw new WorkbookError(503, 'Excel could not be generated. The previous workbook is unchanged.');
  }
}

export function createWorkbookService(path: string, render = renderWorkbook) {
  const manifestPath = `${path}.json`;
  const pendingPath = `${path}.pending.json`;
  const replacementKey = resolve(path);
  const excelLockPath = join(dirname(path), `~$${basename(path)}`);
  let running = false;
  async function requireClosedWorkbook(): Promise<void> {
    if (await optionalBytes(excelLockPath)) throw new WorkbookError(409, 'The workbook is open in Excel. Save and close it, then update Excel again.');
  }
  function manifest(bytes: Buffer | null): WorkbookManifest | null {
    if (!bytes) return null;
    try {
      const value = JSON.parse(bytes.toString('utf8')) as WorkbookManifest;
      return value.format === 'mazal-workbook' && value.version === 1 && Number.isSafeInteger(value.revision)
        && /^[a-f0-9]{64}$/.test(value.sha256) && /^[a-f0-9]{64}$/.test(value.documentsDigest) ? value : null;
    } catch { return null; }
  }
  const hash = (bytes:Buffer|null) => bytes ? digest(bytes) : null;
  async function clearPending(temporary:string):Promise<void> {
    await rm(temporary, {recursive:true, force:true});
    await rm(pendingPath, {force:true});
    await syncDirectory(dirname(path));
  }
  async function recoverPending():Promise<void> {
    const pendingBytes = await optionalBytes(pendingPath);
    if (!pendingBytes) return;
    if (activeReplacements.has(replacementKey)) throw new WorkbookError(409, 'Excel is already being generated. Wait for that export to finish.');
    activeReplacements.add(replacementKey);
    try {
      await requireClosedWorkbook();
      const invalid = () => new WorkbookError(409, 'An interrupted Excel export needs review. The workbook and export record were kept.');
      let pending:WorkbookPending;
      try { pending = JSON.parse(pendingBytes.toString('utf8')) as WorkbookPending; } catch { throw invalid(); }
      const validHash = (value:unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
      if (!pending || pending.format !== 'mazal-workbook-pending' || pending.version !== 1
        || typeof pending.temporary !== 'string' || !/^\.excel-[a-zA-Z0-9]+$/.test(pending.temporary)
        || ![pending.previousWorkbookSha256,pending.previousManifestSha256].every(value => value === null || validHash(value))
        || !validHash(pending.nextWorkbookSha256) || !validHash(pending.nextManifestSha256)
        || typeof pending.nextManifest !== 'string' || digest(pending.nextManifest) !== pending.nextManifestSha256
        || manifest(Buffer.from(pending.nextManifest))?.sha256 !== pending.nextWorkbookSha256) throw invalid();
      const temporary = join(dirname(path), pending.temporary);
      const currentHash = hash(await optionalBytes(path));
      const currentManifestHash = hash(await optionalBytes(manifestPath));
      if (currentHash === pending.nextWorkbookSha256 && currentManifestHash === pending.nextManifestSha256) {
        await clearPending(temporary);
      } else if (currentHash === pending.nextWorkbookSha256 && currentManifestHash === pending.previousManifestSha256) {
        await mkdir(temporary, {recursive:true, mode:0o700});
        const recoveredManifest = join(temporary, 'recovered-manifest.json');
        await writeFile(recoveredManifest, pending.nextManifest, {mode:0o600});
        await syncFile(recoveredManifest);
        await requireClosedWorkbook();
        if (hash(await optionalBytes(path)) !== currentHash || hash(await optionalBytes(manifestPath)) !== currentManifestHash) throw invalid();
        await rename(recoveredManifest, manifestPath);
        await syncDirectory(dirname(path));
        await clearPending(temporary);
      } else if (currentHash === pending.previousWorkbookSha256 && currentManifestHash === pending.previousManifestSha256) {
        await clearPending(temporary);
      } else throw invalid();
    } finally { activeReplacements.delete(replacementKey); }
  }
  async function status(snapshot?: Pick<WorkbookSnapshot, 'state' | 'documents'>): Promise<WorkbookStatus> {
    if (!activeReplacements.has(replacementKey)) await recoverPending();
    const bytes = await optionalBytes(path);
    const base: WorkbookStatus = { available: !!bytes, fileName: 'Mazal master.xlsx', lastUpdatedAt: bytes ? (await stat(path)).mtime.toISOString() : null };
    if (!bytes) return base;
    const saved = manifest(await optionalBytes(manifestPath));
    if (!saved) return base;
    return { ...base, revision: saved.revision, modified: saved.sha256 !== digest(bytes), ...(snapshot ? { stale: saved.layoutVersion !== WORKBOOK_LAYOUT_VERSION || snapshot.state.revision !== saved.revision || documentsDigest(snapshot.documents) !== saved.documentsDigest } : {}) };
  }
  async function refresh(snapshot: WorkbookSnapshot): Promise<WorkbookStatus> {
    if (snapshot.state.workspace !== 'live') throw new WorkbookError(400, 'Export Excel from the live workspace.');
    if (running) throw new WorkbookError(409, 'Excel is already being generated. Wait for that export to finish.');
    running = true;
    let temporary: string | undefined;
    let pendingInstalled = false;
    try {
      await requireClosedWorkbook();
      await recoverPending();
      const previous = await optionalBytes(path);
      const previousManifestBytes = await optionalBytes(manifestPath);
      const previousManifest = manifest(previousManifestBytes);
      if (previous && (!previousManifest || digest(previous) !== previousManifest.sha256)) throw new WorkbookError(409, 'The workbook has local edits or no export record. Review those changes before replacing it.');
      async function requireUnchangedWorkbook(): Promise<void> {
        const current = await optionalBytes(path);
        if ((current ? digest(current) : null) !== (previous ? digest(previous) : null)) throw new WorkbookError(409, 'The workbook changed during export. Your existing file was kept.');
        const currentManifestBytes = await optionalBytes(manifestPath);
        if ((currentManifestBytes ? digest(currentManifestBytes) : null) !== (previousManifestBytes ? digest(previousManifestBytes) : null)) throw new WorkbookError(409, 'The workbook export record changed during export. Your existing file was kept.');
        await requireClosedWorkbook();
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      temporary = await mkdtemp(join(dirname(path), '.excel-'));
      const inputPath = join(temporary, 'snapshot.json');
      const outputPath = join(temporary, 'workbook.xlsx');
      const existingPath = previous ? join(temporary, 'existing.xlsx') : undefined;
      await writeFile(inputPath, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
      if (existingPath) await writeFile(existingPath, previous!, { mode: 0o600, flag: 'wx' });
      await render(inputPath, outputPath, existingPath);
      const output = await readFile(outputPath);
      if (output.length < 4 || !output.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new WorkbookError(500, 'The Excel export was incomplete. The previous workbook is unchanged.');
      await requireUnchangedWorkbook();
      if (previous) {
        const archive = join(dirname(path), 'Archive', `${snapshot.generatedAt.replace(/[:.]/g, '-')}-excel`);
        await mkdir(archive, { recursive: true, mode: 0o700 });
        await writeFile(join(archive, 'Mazal master.xlsx'), previous, { mode: 0o600, flag: 'wx' });
        await writeFile(join(archive, 'Mazal master.xlsx.json'), previousManifestBytes!, { mode: 0o600, flag: 'wx' });
        await syncFile(join(archive, 'Mazal master.xlsx'));
        await syncFile(join(archive, 'Mazal master.xlsx.json'));
        await syncDirectory(archive);
        await syncDirectory(dirname(archive));
      }
      const metadata: WorkbookManifest = { format: 'mazal-workbook', version: 1, layoutVersion: WORKBOOK_LAYOUT_VERSION, revision: snapshot.state.revision, documentsDigest: documentsDigest(snapshot.documents), sha256: digest(output), generatedAt: snapshot.generatedAt };
      const temporaryManifest = join(temporary, 'manifest.json');
      await writeFile(temporaryManifest, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
      await chmod(outputPath, 0o600);
      await syncFile(outputPath);
      await syncFile(temporaryManifest);
      const pending:WorkbookPending = {format:'mazal-workbook-pending', version:1, temporary:basename(temporary), previousWorkbookSha256:hash(previous), previousManifestSha256:hash(previousManifestBytes), nextWorkbookSha256:metadata.sha256, nextManifestSha256:digest(JSON.stringify(metadata)), nextManifest:JSON.stringify(metadata)};
      const temporaryPending = join(temporary, 'pending.json');
      await writeFile(temporaryPending, JSON.stringify(pending), {mode:0o600, flag:'wx'});
      await syncFile(temporaryPending);
      await syncDirectory(temporary);
      if (activeReplacements.has(replacementKey)) throw new WorkbookError(409, 'Excel is already being generated. Wait for that export to finish.');
      activeReplacements.add(replacementKey);
      try {
        await requireUnchangedWorkbook();
        await link(temporaryPending, pendingPath);
        pendingInstalled = true;
        await syncDirectory(dirname(path));
        await requireUnchangedWorkbook();
        await rename(outputPath, path);
        await syncDirectory(dirname(path));
        await rename(temporaryManifest, manifestPath);
        await syncDirectory(dirname(path));
        await clearPending(temporary);
        pendingInstalled = false;
      } finally {
        activeReplacements.delete(replacementKey);
      }
      return status(snapshot);
    } finally {
      running = false;
      if (temporary && !pendingInstalled) await rm(temporary, { recursive: true, force: true });
    }
  }
  return { status, refresh };
}
