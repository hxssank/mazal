import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import type { AppState, Command } from '../../shared/types.ts';
import type { DocumentList } from '../../server/documents.ts';
import { createStore } from '../../server/store.ts';

const test = base.extend<{ payrollServer: string }>({
  payrollServer: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'mazal-payroll-browser-'));
    const data = join(directory, 'data');
    await mkdir(data);
    const store = createStore(join(data, 'live.sqlite'), 'live');
    try { store.command({ type: 'add_account', entityId: 'personal', name: 'Isolated payroll cash', accountType: 'cash', openingBalanceCents: 50000, openingDate: '2026-01-01' }); }
    finally { store.close(); }
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const address = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MAZAL_')));
    const child = spawn(process.execPath, ['server/index.ts'], {
      cwd: process.cwd(), env: { ...env, NODE_ENV: 'production', PORT: String(port), MAZAL_DATA_DIR: data, MAZAL_MASTER_WORKBOOK: join(directory, 'workbook.xlsx'), MAZAL_SAMPLE_PREVIEW: '1', MAZAL_ENGINE_AUTOSTART: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', bytes => { logs += bytes; });
    child.stderr.on('data', bytes => { logs += bytes; });
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(logs);
        try { return (await fetch(`${address}/api/state?workspace=live`)).status; } catch { return 0; }
      }, { timeout: 15000 }).toBe(200);
      await use(address);
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
});

for (const savedFirst of [false, true]) test(`payroll extraction and an upload stalled ${savedFirst ? 'after' : 'before'} persistence retain the review and import once`, async ({ page, request, payrollServer }) => {
  const stateUrl = `${payrollServer}/api/state?workspace=live`;
  const response = await request.get(stateUrl);
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const name = `Payroll timeout ${savedFirst ? 'after' : 'before'}.pdf`;
  const bytes = Buffer.from(`%PDF-1.4\nSynthetic payroll timeout ${savedFirst ? 'after' : 'before'} persistence\n`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const sent: Command[] = [];
  const uploads: { bytes: Buffer | null; metadata: string }[] = [];
  let extractionCalls = 0;
  let uploadHandled = false;
  await page.route('**/api/document-extract?workspace=live', async route => {
    extractionCalls++;
    if (extractionCalls === 1) return;
    await route.fulfill({ json: { pages: [{ page: 1, text: 'Synthetic payroll source text', method: 'pdf-text' }], warnings: [] } });
  });
  await page.route('**/api/documents?workspace=live', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    uploads.push({ bytes: route.request().postDataBuffer(), metadata: route.request().headers()['x-mazal-document'] });
    if (uploads.length === 1) {
      if (savedFirst) expect((await route.fetch()).status()).toBe(201);
      uploadHandled = true;
      return;
    }
    await route.continue();
  });
  await page.route('**/api/command?workspace=live', async route => {
    sent.push(route.request().postDataJSON() as Command);
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(`${payrollServer}/#pay/statements`);
  await page.getByRole('button', { name: 'Add payroll records', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add payroll records', exact: true });
  await dialog.getByLabel('Original PDF or image', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(dialog.getByRole('button', { name: 'Review entered records', exact: true })).toBeEnabled();
  await dialog.getByLabel('Net pay', { exact: true }).fill('1500.20');
  await dialog.getByRole('button', { name: 'Extract text on this Mac', exact: true }).click();
  await expect.poll(() => extractionCalls).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.clock.fastForward(120_001);
  await expect(dialog.getByRole('alert')).toContainText('Text extraction timed out after 2 minutes');
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(dialog.getByLabel('Net pay', { exact: true })).toHaveValue('1500.20');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  expect(extractionCalls).toBe(1); expect(sent).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Extract text on this Mac', exact: true }).click();
  await expect(dialog.locator('pre')).toHaveText('Synthetic payroll source text');
  for (const [label, value] of [['Employer', 'Synthetic payroll employer'], ['Pay date', '2026-09-18'], ['Period start', '2026-09-01'], ['Period end', '2026-09-14'], ['Gross pay', '2000.29'], ['Taxes', '400.08'], ['Deductions', '100.01'], ['Payroll hours', '80']]) {
    await dialog.getByLabel(label, { exact: true }).fill(value);
  }
  await dialog.getByRole('button', { name: 'Review entered records', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Review before saving', exact: true })).toBeFocused();
  await dialog.getByLabel('I checked these records against the original file.', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save reviewed payroll', exact: true }).click();
  await expect.poll(() => uploadHandled).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.clock.fastForward(60_001);
  await expect(dialog.getByRole('alert')).toContainText('The original upload timed out after 60 seconds');
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Save reviewed payroll', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('region', { name: 'Reviewed payroll values', exact: true })).toContainText('Net $1,500.20');
  expect(uploads).toHaveLength(1); expect(sent).toHaveLength(0);
  await page.keyboard.press('Escape');
  const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true });
  await expect(discard.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeFocused();
  await dialog.getByRole('button', { name: 'Save reviewed payroll', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(uploads).toHaveLength(2); expect(uploads[0].bytes).toEqual(bytes); expect(uploads[1]).toEqual(uploads[0]);
  expect(sent).toHaveLength(1); expect(sent[0].type).toBe('import_payroll');
  const after = await (await request.get(stateUrl)).json() as AppState;
  expect(after.payrollImports!.filter(batch => batch.sources.some(source => source.sha256 === hash))).toHaveLength(1);
  expect(after.accounts).toEqual(before.accounts); expect(after.transactions).toEqual(before.transactions);
  expect(after.revision).toBe(before.revision + 1);
  const library = await (await request.get(`${payrollServer}/api/documents?workspace=live`)).json() as DocumentList;
  expect(library.documents.filter(document => document.sha256 === hash)).toHaveLength(1);
  expect(await (await request.get(`${payrollServer}/api/documents/${hash}/content?workspace=live`)).body()).toEqual(bytes);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add payroll records', exact: true })).toBeEnabled();
  expect((await (await request.get(stateUrl)).json()).revision).toBe(after.revision);
  expect(sent).toHaveLength(1);
});
