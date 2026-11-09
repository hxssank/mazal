import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';

test('stalled source-file and workbook checks expose keyboard retries without writing records', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname !== '/api/engine/project') writes.push(request.url()); });
  let files = 0;
  let workbook = 0;
  await page.route('**/api/documents?workspace=live', () => { files++; });
  await page.route('**/api/master-workbook/status?workspace=live', () => { workbook++; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/#documents/files');
  await expect.poll(() => files).toBe(1);
  await expect.poll(() => workbook).toBe(1);
  const excel = page.locator('.document-workbook');
  await excel.locator('summary').focus();
  await page.keyboard.press('Enter');
  await page.clock.fastForward(15_001);
  await expect(page.getByRole('alert').filter({ hasText: /timed out after 15 seconds/ })).toBeVisible();
  const retryFiles = page.getByRole('button', { name: 'Retry file list', exact: true });
  const retryWorkbook = page.getByRole('button', { name: 'Retry workbook check', exact: true });
  await expect(retryFiles).toBeEnabled();
  await expect(retryWorkbook).toBeEnabled();
  await expect(excel.getByRole('button', { name: 'Update Excel', exact: true })).toBeDisabled();
  await expect(excel.locator('summary')).toBeFocused();
  await page.unroute('**/api/documents?workspace=live');
  await page.unroute('**/api/master-workbook/status?workspace=live');
  await retryFiles.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'No saved statement files', exact: true })).toBeVisible();
  await retryWorkbook.focus();
  await page.keyboard.press('Enter');
  await expect(excel.getByText('No Excel export yet.', { exact: true })).toBeVisible();
  await expect(excel.getByRole('button', { name: 'Update Excel', exact: true })).toBeEnabled();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/#home$/);
  await page.goBack();
  await expect(page).toHaveURL(/#documents\/files$/);
  await expect(page.getByRole('heading', { name: 'Statements', exact: true, level: 1 })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No saved statement files', exact: true })).toBeVisible();
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
  expect(writes).toEqual([]);
});

test('a stalled file-list refresh keeps the original and open import draft', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const name = 'File list refresh original.csv';
  const bytes = Buffer.from('TransactionDate,PostingDate,Description,Amount\r\n2026-01-02,2026-01-03,Isolated original,-12.34\r\n');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const saved = await request.post('/api/documents?workspace=live', {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Mazal-Document': encodeURIComponent(JSON.stringify({ originalName: name, kind: 'statement', accountId: before.accounts.find(account => account.name === 'Browser test cash')!.id, periodStart: '2026-01-01', periodEnd: '2026-01-31' })),
    },
    data: bytes,
  });
  expect(saved.status()).toBe(201);
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname !== '/api/engine/project') writes.push(request.url()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/#documents/files');
  const original = page.getByRole('link', { name: `Open original ${name}`, exact: true });
  await expect(original).toBeVisible();
  const add = page.getByRole('button', { name: 'Add statement', exact: true });
  await add.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Import a statement', exact: true });
  const opening = dialog.getByLabel('Opening balance · CAD', { exact: true });
  await opening.fill('123.45');
  let reads = 0;
  await page.route('**/api/documents?workspace=live', () => { reads++; });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => reads).toBe(1);
  await page.clock.fastForward(15_001);
  const error = page.getByRole('alert', { includeHidden: true }).filter({ hasText: /^Reading saved statement files timed out after 15 seconds/ });
  await expect(error).toBeVisible();
  await expect(error.getByText('The last loaded file list is still shown.', { exact: true })).toBeVisible();
  await expect(opening).toHaveValue('123.45');
  await expect(opening).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(opening).toBeFocused();
  await expect(opening).toHaveValue('123.45');
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  await expect(original).toBeVisible();
  await page.unroute('**/api/documents?workspace=live');
  await page.getByRole('button', { name: 'Retry file list', exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(original).toBeVisible();
  await page.reload();
  await expect(original).toBeVisible();
  expect(await (await request.get(`/api/documents/${hash}/content?workspace=live`)).body()).toEqual(bytes);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
  expect(writes).toEqual([]);
});
