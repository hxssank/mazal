import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import JSZip from 'jszip';
import { createDocumentStore, type DocumentMetadata } from '../../server/documents.ts';
import { createStore } from '../../server/store.ts';

const original = Buffer.from('%PDF-1.4\nIsolated account-link original.\n');
const test = base.extend<{ recoveryServer: { url: string; data: string; document: DocumentMetadata; runId: string; evidence: Record<string, string> } }>({
  recoveryServer: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'mazal-recovery-controls-browser-'));
    const data = join(directory, 'data');
    await mkdir(data);
    let snapshot;
    let document!: DocumentMetadata;
    for (const workspace of ['live', 'demo'] as const) {
      const store = createStore(join(data, `${workspace}.sqlite`), workspace);
      if (workspace === 'live') snapshot = store.command({ type: 'add_account', entityId: 'personal', name: 'Isolated recovery cash', accountType: 'cash', openingBalanceCents: 50000, openingDate: '2026-10-16' });
      store.close();
      const documents = createDocumentStore(join(data, 'documents', workspace));
      if (workspace === 'live') document = documents.upload(original, { originalName: 'Isolated account-link original.pdf', kind: 'other' }).document;
      documents.close();
    }
    const runId = randomUUID();
    const evidence = {
      'input.json': JSON.stringify({ snapshot, kind: 'comparison', scope: 'personal', asOf: '2026-10-16', evidence: 'isolated calculation evidence '.repeat(100) }),
      'status.json': JSON.stringify({ id: runId, workspace: 'live', status: 'completed', result: { fixture: true } }),
      'output.json': JSON.stringify({ status: 'completed', result: { fixture: true } }),
    };
    const run = join(data, 'engine-runs', runId);
    await mkdir(run, { recursive: true });
    for (const [name, bytes] of Object.entries(evidence)) await writeFile(join(run, name), bytes);
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const url = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MAZAL_')));
    const child = spawn(process.execPath, ['server/index.ts'], { cwd: process.cwd(), env: { ...env, NODE_ENV: 'production', PORT: String(port), MAZAL_DATA_DIR: data, MAZAL_MASTER_WORKBOOK: join(directory, 'workbook.xlsx'), MAZAL_ENGINE_AUTOSTART: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    child.stdout.on('data', bytes => { logs = (logs + bytes).slice(-12000); });
    child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-12000); });
    try {
      await expect.poll(async () => {
        if (child.exitCode !== null) throw new Error(logs);
        try { return (await fetch(`${url}/api/state?workspace=live`)).status; } catch { return 0; }
      }, { timeout: 15000 }).toBe(200);
      const state = await (await fetch(`${url}/api/state?workspace=live`)).json();
      expect(state.accounts.map((account: { name: string }) => account.name)).toEqual(['Isolated recovery cash']);
      expect((await (await fetch(`${url}/api/engine/storage?workspace=live`)).json()).runs.map((item: { id: string }) => item.id)).toEqual([runId]);
      await use({ url, data, document, runId, evidence });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test('a stalled account-link read releases Done and can retry from the keyboard', async ({ page, request, recoveryServer }) => {
  const before = await (await request.get(`${recoveryServer.url}/api/state?workspace=live`)).json();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const initial = page.waitForResponse(response => new URL(response.url()).pathname === '/api/documents' && response.request().method() === 'GET');
  await page.goto(`${recoveryServer.url}/?setup=restore#documents/files`);
  await initial;
  let reads = 0;
  await page.route('**/api/documents?workspace=live', () => { reads++; });
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  const links = dialog.locator('.recovery-account-links');
  await links.getByRole('button', { name: 'Review saved account links', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => reads).toBe(1);
  await page.clock.fastForward(15_001);
  await expect(links.getByRole('alert')).toContainText('timed out');
  await expect(links.getByRole('alert')).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  await page.unroute('**/api/documents?workspace=live');
  await links.getByRole('button', { name: 'Review saved account links', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(links.getByLabel('Saved document', { exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Statements', level: 1, exact: true })).toBeFocused();
  await page.reload();
  expect(await (await request.get(`${recoveryServer.url}/api/state?workspace=live`)).json()).toEqual(before);
});

for (const savedFirst of [false, true]) test(`a document link response lost ${savedFirst ? 'after' : 'before'} saving requires a fresh read before any new write`, async ({ page, request, recoveryServer }) => {
  const { url, document } = recoveryServer;
  const before = await (await request.get(`${url}/api/state?workspace=live`)).json();
  const cash = before.accounts[0].id;
  const patches: unknown[] = [];
  let handled = false;
  await page.route(`**/api/documents/${document.id}?workspace=live`, async route => {
    patches.push(route.request().postDataJSON());
    if (patches.length === 1) { if (savedFirst) expect((await route.fetch()).status()).toBe(200); handled = true; return; }
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(`${url}/?setup=restore#documents/files`);
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  const links = dialog.locator('.recovery-account-links');
  await links.getByRole('button', { name: 'Review saved account links', exact: true }).click();
  await links.getByLabel('Saved document', { exact: true }).selectOption(document.id);
  const account = links.getByLabel('Saved account link', { exact: true });
  await account.selectOption(cash);
  let reads = 0;
  let holdReads = true;
  await page.route('**/api/documents?workspace=live', async route => { reads++; if (!holdReads) await route.continue(); });
  const save = links.getByRole('button', { name: 'Save account link', exact: true });
  await save.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => handled).toBe(true);
  await page.clock.fastForward(60_001);
  await expect(links.getByRole('alert')).toContainText('timed out');
  await expect(links.getByRole('alert')).toBeFocused();
  await expect(save).toBeDisabled();
  await expect(account).toHaveValue(cash);
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  expect(patches).toHaveLength(1);
  expect(reads).toBe(0);
  const reload = links.getByRole('button', { name: 'Reload saved links', exact: true });
  await reload.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => reads).toBe(1);
  await page.clock.fastForward(15_001);
  await expect(links.getByRole('alert')).toContainText('timed out');
  await expect(links.getByRole('alert')).toBeFocused();
  await expect(account).toHaveValue(cash);
  await expect(save).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(links.getByRole('alert')).toBeFocused();
  holdReads = false;
  await reload.focus();
  await page.keyboard.press('Enter');
  await expect(account).toHaveValue(cash);
  if (savedFirst) {
    await expect(links.getByRole('status')).toContainText('matches your choice');
    await expect(save).toBeDisabled();
    expect(patches).toHaveLength(1);
  } else {
    await expect(save).toBeEnabled();
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(links.getByRole('status')).toContainText('Account link saved');
    expect(patches).toEqual([{ expectedRevision: document.revision, accountId: cash }, { expectedRevision: document.revision, accountId: cash }]);
  }
  const stored = (await (await request.get(`${url}/api/documents?workspace=live`)).json()).documents.find((item: DocumentMetadata) => item.id === document.id);
  expect(stored.accountId).toBe(cash);
  expect(stored.revision).toBe(document.revision + 1);
  expect(await (await request.get(`${url}/api/documents/${document.id}/content?workspace=live`)).body()).toEqual(original);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  expect(patches).toHaveLength(savedFirst ? 1 : 2);
  expect(await (await request.get(`${url}/api/state?workspace=live`)).json()).toEqual(before);
});

test('a stalled storage read does not steal an encryption draft focus and can refresh', async ({ page, request, recoveryServer }) => {
  const before = await (await request.get(`${recoveryServer.url}/api/state?workspace=live`)).json();
  let reads = 0;
  await page.route('**/api/engine/storage?workspace=live', () => { reads++; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(`${recoveryServer.url}/?setup=restore#documents/files`);
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  await dialog.getByLabel('Encrypt this download with a passphrase', { exact: true }).check();
  const password = dialog.getByLabel('Backup passphrase', { exact: true });
  await password.fill('isolated storage draft');
  await expect.poll(() => reads).toBe(1);
  await page.clock.fastForward(125_001);
  const storage = dialog.locator('.calculation-storage');
  await expect(storage.getByRole('alert')).toContainText('125 seconds');
  await expect(password).toBeFocused();
  await expect(password).toHaveValue('isolated storage draft');
  await page.unroute('**/api/engine/storage?workspace=live');
  await storage.getByRole('button', { name: 'Refresh storage', exact: true }).click();
  await expect(storage.getByRole('checkbox')).toHaveCount(1);
  await expect(password).toHaveValue('isolated storage draft');
  expect(await (await request.get(`${recoveryServer.url}/api/state?workspace=live`)).json()).toEqual(before);
});

for (const archivedFirst of [false, true]) test(`an archive response lost ${archivedFirst ? 'after' : 'before'} moving evidence reconciles before retry and preserves restored bytes`, async ({ page, request, recoveryServer }) => {
  const { url, data, runId, evidence } = recoveryServer;
  const before = await (await request.get(`${url}/api/state?workspace=live`)).json();
  const archives: unknown[] = [];
  const restores: unknown[] = [];
  let handled = false;
  let restoreHandled = false;
  let holdReads = false;
  let reads = 0;
  await page.route('**/api/engine/storage/archive?workspace=live', async route => {
    archives.push(route.request().postDataJSON());
    if (archives.length === 1) {
      if (archivedFirst) expect((await route.fetch()).status()).toBe(200);
      holdReads = true; handled = true; return;
    }
    await route.continue();
  });
  await page.route('**/api/engine/storage?workspace=live', async route => { if (holdReads) { reads++; return; } await route.continue(); });
  await page.route('**/api/engine/storage/restore?workspace=live', async route => {
    restores.push(route.request().postDataJSON());
    expect((await route.fetch()).status()).toBe(200);
    restoreHandled = true;
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(`${url}/?setup=restore#documents/files`);
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  const storage = dialog.locator('.calculation-storage');
  await storage.getByRole('checkbox').check();
  const archive = storage.getByRole('button', { name: 'Archive selected calculations (1)', exact: true });
  await archive.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => handled).toBe(true);
  await page.clock.fastForward(125_001);
  await expect(storage.getByRole('alert').filter({ hasText: /125 seconds/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  await expect.poll(() => reads).toBe(1);
  await page.clock.fastForward(125_001);
  await expect(storage.getByRole('checkbox')).toBeChecked();
  await expect(storage.getByRole('button', { name: 'Archive selected calculations (1)', exact: true })).toBeDisabled();
  expect(archives).toHaveLength(1);
  holdReads = false;
  await storage.getByRole('button', { name: 'Refresh storage', exact: true }).focus();
  await page.keyboard.press('Enter');
  if (!archivedFirst) {
    await expect(archive).toBeEnabled();
    await archive.focus();
    await page.keyboard.press('Enter');
  }
  await expect(storage.getByRole('checkbox')).toHaveCount(0);
  await expect(storage.getByRole('link', { name: 'Download ZIP', exact: true })).toBeVisible();
  expect(archives).toEqual(Array.from({ length: archivedFirst ? 1 : 2 }, () => ({ runIds: [runId] })));
  const usage = await (await request.get(`${url}/api/engine/storage?workspace=live`)).json();
  expect(usage.archives).toHaveLength(1);
  expect(usage.runs).toHaveLength(0);
  const saved = usage.archives[0];
  const zip = await JSZip.loadAsync(await (await request.get(`${url}/api/engine/storage/archives/${saved.id}/download?workspace=live`)).body());
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  for (const item of manifest.files) expect(await zip.file(item.path)!.async('string')).toBe(evidence[item.path.split('/').at(-1)!]);
  await storage.getByRole('button', { name: 'Restore calculations', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => restoreHandled).toBe(true);
  await page.clock.fastForward(125_001);
  await expect(storage.getByRole('button', { name: 'Already restored', exact: true })).toBeDisabled();
  expect(restores).toEqual([{ archiveId: saved.id }]);
  for (const [name, bytes] of Object.entries(evidence)) expect(await readFile(join(data, 'engine-runs', runId, name), 'utf8')).toBe(bytes);
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  expect(restores).toHaveLength(1);
  expect(await (await request.get(`${url}/api/state?workspace=live`)).json()).toEqual(before);
});
