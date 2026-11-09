import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('automatic backup setup, run, pause and recovery-key download use JSON without changing financial records', async ({ page, request }) => {
  const initial = await request.get('/api/state?workspace=live');
  expect(initial.headers()['x-mazal-data-source']).toBe('sample');
  const before = await initial.json();
  const documentsBefore = await (await request.get('/api/documents?workspace=live')).json();
  const destination = '/synthetic-external-drive/Backups';
  const credentialId = '11111111-1111-4111-8111-111111111111';
  const passphrase = 'synthetic browser recovery key never used for real backups';
  const requests: { path: string; body: unknown }[] = [];
  const financialMutations: string[] = [];
  let statusReads = 0;
  let status: Record<string, unknown> = {
    supported: true, unsupportedReason: null, configured: false, enabled: false, destination: null,
    intervalHours: 24, retentionCount: 14, lastAttemptAt: null, lastSuccessAt: null, lastVerifiedAt: null,
    lastBackupPath: null, lastBackupSha256: null, lastError: null, nextRunAt: null, running: false,
  };
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/automatic-backup') && !path.startsWith('/api/engine/') && !['GET', 'HEAD'].includes(request.method())) financialMutations.push(path);
  });
  await page.route('**/api/automatic-backup**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      expect(path).toBe('/api/automatic-backup');
      statusReads++;
      await route.fulfill({ json: status });
      return;
    }
    expect(request.method()).toBe('POST');
    expect(request.headers()['content-type']).toBe('application/json');
    const body = request.postDataJSON();
    requests.push({ path, body });
    if (path === '/api/automatic-backup/configure') {
      expect(body).toEqual({ destination });
      status = { ...status, configured: true, enabled: true, destination, lastAttemptAt: '2026-10-19T12:00:00.000Z', lastSuccessAt: '2026-10-19T12:00:00.000Z', lastVerifiedAt: '2026-10-19T12:00:01.000Z', lastBackupPath: `${destination}/Mazal backups/first.encrypted.mazal`, lastBackupSha256: 'a'.repeat(64), nextRunAt: '2026-10-20T12:00:00.000Z' };
    } else {
      expect(body).toEqual({});
      if (path === '/api/automatic-backup/run') status = { ...status, lastAttemptAt: '2026-10-19T13:00:00.000Z', lastSuccessAt: '2026-10-19T13:00:00.000Z', lastVerifiedAt: '2026-10-19T13:00:01.000Z', lastBackupPath: `${destination}/Mazal backups/second.encrypted.mazal`, lastBackupSha256: 'b'.repeat(64), nextRunAt: '2026-10-20T13:00:00.000Z' };
      else if (path === '/api/automatic-backup/disable') status = { ...status, enabled: false, nextRunAt: null };
      else if (path === '/api/automatic-backup/recovery-key') {
        await route.fulfill({ json: { credentialId, passphrase } });
        return;
      } else throw new Error(`Unexpected automatic backup request: ${path}`);
    }
    await route.fulfill({ json: status });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?setup=restore#documents/files');
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  const backup = dialog.locator('.mazal-automatic-backup');
  await expect(backup.getByRole('heading', { name: 'Automatic complete backups', exact: true })).toBeVisible();
  await expect(backup.getByText('Automatic backups are not set up', { exact: true })).toBeVisible();
  await backup.getByLabel('Automatic backup folder', { exact: true }).fill(destination);
  await backup.getByRole('button', { name: 'Set up daily backups', exact: true }).click();
  await expect(backup.getByText('Daily backups enabled', { exact: true })).toBeVisible();
  await expect(backup.getByText(`${destination}/Mazal backups/first.encrypted.mazal`, { exact: true })).toBeVisible();
  await backup.getByRole('button', { name: 'Back up now', exact: true }).click();
  await expect(backup.getByText(`${destination}/Mazal backups/second.encrypted.mazal`, { exact: true })).toBeVisible();

  const downloading = page.waitForEvent('download');
  await backup.getByRole('button', { name: 'Save recovery key', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`mazal-recovery-key-${credentialId}.txt`);
  const savedKey = await readFile((await download.path())!, 'utf8');
  expect(savedKey).toContain(`Key ID: ${credentialId}`);
  expect(savedKey).toContain(`Passphrase: ${passphrase}`);
  expect(savedKey).toContain('outside this Mac');
  await expect(backup).not.toContainText(passphrase);

  await backup.getByRole('button', { name: 'Pause automatic backups', exact: true }).click();
  await expect(backup.getByText('Automatic backups paused', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(backup.getByText('Automatic backups paused', { exact: true })).toBeVisible();
  await expect(backup.getByLabel('Automatic backup folder', { exact: true })).toHaveValue(destination);
  await expect(backup.getByText(`${destination}/Mazal backups/second.encrypted.mazal`, { exact: true })).toBeVisible();
  expect(statusReads).toBeGreaterThanOrEqual(2);
  expect(requests).toEqual([
    { path: '/api/automatic-backup/configure', body: { destination } },
    { path: '/api/automatic-backup/run', body: {} },
    { path: '/api/automatic-backup/recovery-key', body: {} },
    { path: '/api/automatic-backup/disable', body: {} },
  ]);
  expect(financialMutations).toEqual([]);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
  const documentsAfter = await (await request.get('/api/documents?workspace=live')).json();
  expect(documentsAfter.documents).toEqual(documentsBefore.documents);
  expect(documentsAfter.storage).toMatchObject({
    documentCount: documentsBefore.storage.documentCount,
    usedBytes: documentsBefore.storage.usedBytes,
    limitPerFileBytes: documentsBefore.storage.limitPerFileBytes,
  });
});
