import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import { decodeCompleteBackup } from '../../server/complete-backup.ts';
import { createDocumentStore } from '../../server/documents.ts';
import { createStore } from '../../server/store.ts';

const test = base.extend<{ backupServer: string }>({
  backupServer: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'mazal-complete-browser-'));
    const data = join(directory, 'data');
    await mkdir(data);
    for (const workspace of ['live', 'demo'] as const) {
      const store = createStore(join(data, `${workspace}.sqlite`), workspace);
      if (workspace === 'live') store.command({ type: 'add_account', entityId: 'personal', name: 'Isolated complete-backup cash', accountType: 'cash', openingBalanceCents: 50000, openingDate: '2026-10-16' });
      store.close();
      createDocumentStore(join(data, 'documents', workspace)).close();
    }
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const address = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MAZAL_')));
    const child = spawn(process.execPath, ['server/index.ts'], {
      cwd: process.cwd(), env: { ...env, NODE_ENV: 'production', PORT: String(port), MAZAL_DATA_DIR: data, MAZAL_MASTER_WORKBOOK: join(directory, 'workbook.xlsx'), MAZAL_ENGINE_AUTOSTART: '0' },
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
      const state = await (await fetch(`${address}/api/state?workspace=live`)).json();
      expect(state.accounts.map((account: { name: string }) => account.name)).toEqual(['Isolated complete-backup cash']);
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

test('an encrypted complete-backup download can recover from a timeout without losing its passphrases', async ({ page, request, backupServer }) => {
  const stateUrl = `${backupServer}/api/state?workspace=live`;
  const before = await (await request.get(stateUrl)).json();
  const requests: unknown[] = [];
  await page.route('**/api/complete-backup/export?workspace=live', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length > 1) await route.continue();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(`${backupServer}/?setup=restore#documents/files`);
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  const backup = dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Complete backup', exact: true }) });
  await backup.getByLabel('Encrypt this download with a passphrase', { exact: true }).check();
  const passphrase = 'isolated browser backup passphrase';
  await backup.getByLabel('Backup passphrase', { exact: true }).fill(passphrase);
  await backup.getByLabel('Repeat passphrase', { exact: true }).fill(passphrase);
  const download = backup.getByRole('button', { name: 'Download complete backup', exact: true });
  await download.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => requests.length).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  await page.clock.fastForward(180_001);
  await expect(backup.getByRole('alert')).toContainText('timed out');
  await expect(backup.getByRole('alert')).toBeFocused();
  await expect(download).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  await expect(backup.getByLabel('Backup passphrase', { exact: true })).toHaveValue(passphrase);
  await expect(backup.getByLabel('Repeat passphrase', { exact: true })).toHaveValue(passphrase);
  expect(requests).toHaveLength(1);
  const saved = page.waitForEvent('download');
  await download.focus();
  await page.keyboard.press('Enter');
  const result = await saved;
  expect(result.suggestedFilename()).toMatch(/\.encrypted\.mazal$/);
  const archive = await readFile((await result.path())!);
  const decoded = await decodeCompleteBackup(archive, passphrase);
  expect(decoded.encrypted).toBe(true);
  expect(decoded.manifest.files.some(file => file.path === 'live.sqlite')).toBe(true);
  await expect(backup.getByLabel('Backup passphrase', { exact: true })).toHaveValue('');
  await expect(backup.getByLabel('Repeat passphrase', { exact: true })).toHaveValue('');
  expect(requests).toEqual([{ passphrase }, { passphrase }]);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Statements', level: 1, exact: true })).toBeFocused();
  await page.reload();
  expect(await (await request.get(stateUrl)).json()).toEqual(before);
});

test('a complete-backup verification timeout preserves its selected bytes and passphrase for explicit retry', async ({ page, request, backupServer }) => {
  const before = await (await request.get(`${backupServer}/api/state?workspace=live`)).json();
  const passphrase = 'isolated encrypted restore passphrase';
  const exported = await request.post(`${backupServer}/api/complete-backup/export?workspace=live`, { data: { passphrase } });
  expect(exported.status()).toBe(200);
  const archive = await exported.body();
  let verified = 0;
  let firstVerificationFinished = false;
  await page.route('**/api/complete-backup/preview?workspace=live', async route => {
    verified++;
    if (verified === 1) { expect((await route.fetch({ postData: archive })).status()).toBe(200); firstVerificationFinished = true; return; }
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(`${backupServer}/?setup=restore#documents/files`);
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  const backup = dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Complete backup', exact: true }) });
  const file = backup.getByLabel('Verify or restore a complete backup (.mazal)', { exact: true });
  await file.setInputFiles({ name: 'fixture.encrypted.mazal', mimeType: 'application/octet-stream', buffer: archive });
  const password = backup.getByLabel('Backup passphrase, if encrypted', { exact: true });
  await password.fill(passphrase);
  const verify = backup.getByRole('button', { name: 'Verify complete backup', exact: true });
  await verify.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => firstVerificationFinished).toBe(true);
  await page.clock.fastForward(180_001);
  await expect(backup.getByRole('alert')).toContainText('timed out');
  await expect(backup.getByRole('alert')).toBeFocused();
  await expect(password).toHaveValue(passphrase);
  expect(Buffer.from(await file.evaluate(async (input: HTMLInputElement) => Array.from(new Uint8Array(await input.files![0].arrayBuffer()))))).toEqual(archive);
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(backup.getByRole('alert')).toBeFocused();
  await verify.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => verified).toBe(2);
  await expect(backup.getByText('Backup verified', { exact: true })).toBeVisible();
  await expect(password).toHaveValue('');
  expect(verified).toBe(2);
  await backup.getByRole('button', { name: 'Clear backup', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await (await request.get(`${backupServer}/api/state?workspace=live`)).json()).toEqual(before);
});

for (const savedFirst of [false, true]) test(`a legacy restore response lost ${savedFirst ? 'after' : 'before'} replacement cannot repeat over later records`, async ({ page, request, backupServer }) => {
  const stateUrl = `${backupServer}/api/state?workspace=live`;
  const exported = await request.get(`${backupServer}/api/backup?workspace=live`);
  expect(exported.status()).toBe(200);
  const archive = await exported.body();
  const before = await (await request.get(stateUrl)).json();
  const commits: string[] = [];
  let handled = false;
  await page.route('**/api/backup/restore?workspace=live', async route => {
    commits.push(route.request().headers()['x-mazal-revision']);
    if (commits.length === 1) {
      if (savedFirst) expect((await route.fetch()).status()).toBe(200);
      handled = true;
      return;
    }
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(`${backupServer}/?setup=restore#documents/files`);
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  const file = dialog.getByLabel('Mazal backup (.json or .json.gz)', { exact: true });
  await file.setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: archive });
  await dialog.getByLabel('Replace the My finances workspace with this backup.', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await expect.poll(() => handled).toBe(true);
  const interim = await (await request.get(stateUrl)).json();
  expect(interim.revision).toBe(before.revision + (savedFirst ? 1 : 0));
  const expense = await request.post(`${backupServer}/api/command?workspace=live`, { data: {
    type: 'add_transaction', kind: 'expense', accountId: interim.accounts[0].id, amountCents: 1234,
    date: '2026-10-16', category: 'Other', description: 'Saved after the uncertain restore',
    expectedRevision: interim.revision, requestId: `legacy-restore-later-expense-${savedFirst}`,
  } });
  expect(expense.status()).toBe(200);
  const saved = await (await request.get(stateUrl)).json();
  expect(saved.transactions.some((entry: { description: string }) => entry.description === 'Saved after the uncertain restore')).toBe(true);
  await page.clock.fastForward(180_001);
  await expect(dialog.getByRole('alert').filter({ hasText: /could not confirm whether the backup restore completed/ })).toBeVisible();
  await expect(dialog.getByRole('alert').filter({ hasText: /could not confirm whether the backup restore completed/ })).toBeFocused();
  await expect(file).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Review updated records', exact: true })).toBeDisabled();
  expect(commits).toEqual([String(before.revision)]);
  await dialog.getByRole('button', { name: 'Close and check records', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  expect(commits).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close and check records', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close and check records', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Statements', exact: true, level: 1 })).toBeVisible();
  expect(commits).toHaveLength(1);
  expect(await (await request.get(stateUrl)).json()).toEqual(saved);
});

for (const savedFirst of [false, true]) test(`a complete restore response lost ${savedFirst ? 'after' : 'before'} replacement confirms the original request once`, async ({ page, request, backupServer }) => {
  const stateUrl = `${backupServer}/api/state?workspace=live`;
  const archived = await (await request.get(stateUrl)).json();
  const exported = await request.post(`${backupServer}/api/complete-backup/export?workspace=live`, { data: { passphrase: '' } });
  expect(exported.status()).toBe(200);
  const archive = await exported.body();
  expect((await request.post(`${backupServer}/api/command?workspace=live`, { data: { type: 'add_account', entityId: 'personal', name: 'Created after isolated backup', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-10-16', expectedRevision: archived.revision, requestId: `complete-browser-${savedFirst}` } })).status()).toBe(200);
  const before = await (await request.get(stateUrl)).json();
  const commits: unknown[] = [];
  let handled = false;
  await page.route('**/api/complete-backup/restore?workspace=live', async route => {
    commits.push(route.request().postDataJSON());
    if (commits.length === 1) {
      if (savedFirst) expect((await route.fetch()).status()).toBe(200);
      handled = true;
      return;
    }
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto(`${backupServer}/?setup=restore#documents/files`);
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  const backup = dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Complete backup', exact: true }) });
  await backup.getByLabel('Verify or restore a complete backup (.mazal)', { exact: true }).setInputFiles({ name: 'fixture.mazal', mimeType: 'application/octet-stream', buffer: archive });
  await backup.getByRole('button', { name: 'Verify complete backup', exact: true }).click();
  await expect(backup.getByText('Backup verified', { exact: true })).toBeVisible();
  await backup.getByLabel('Replace both workspaces, originals, and calculation evidence with this backup. Keep the previous data folder as a safety copy.', { exact: true }).check();
  await backup.getByRole('button', { name: 'Restore complete backup', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => handled).toBe(true);
  await page.clock.fastForward(180_001);
  await expect(backup.getByRole('alert')).toContainText('timed out');
  await expect(backup.getByRole('alert')).toBeFocused();
  await expect(backup.getByRole('button', { name: 'Clear backup', exact: true })).toBeDisabled();
  await expect(backup.getByRole('button', { name: 'Verify complete backup', exact: true })).toBeDisabled();
  expect(commits).toHaveLength(1);
  const interim = await (await request.get(stateUrl)).json();
  expect(interim.revision).toBe(before.revision + (savedFirst ? 1 : 0));
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(backup.getByRole('alert')).toBeFocused();
  await backup.getByRole('button', { name: 'Confirm original restore', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(backup.getByRole('status')).toContainText('Complete backup restored and verified');
  expect(commits).toHaveLength(2);
  expect(commits[1]).toEqual(commits[0]);
  const restored = await (await request.get(stateUrl)).json();
  expect(restored.accounts).toEqual(archived.accounts);
  expect(restored.revision).toBe(before.revision + 1);
  expect(restored.audit.filter((entry: { action: string }) => entry.action === 'complete_restore')).toHaveLength(1);
  await backup.getByRole('button', { name: 'Open restored records', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Statements', exact: true, level: 1 })).toBeVisible();
  expect(commits).toHaveLength(2);
  expect(await (await request.get(stateUrl)).json()).toEqual(restored);
});
