import { expect, test } from '@playwright/test';

for (const width of [320, 1440]) test(`Home exposes backup failure and its repair controls at ${width}px without changing records`, async ({ page, request }) => {
  const initial = await request.get('/api/state?workspace=live');
  expect(initial.headers()['x-mazal-data-source']).toBe('sample');
  const before = await initial.json();
  await page.route('**/api/state?**', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'x-mazal-data-source': 'personal' } });
  });
  const mutations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/engine/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(path);
  });
  let status = {
    supported: true, unsupportedReason: null, configured: true, enabled: true, destination: '/synthetic/backups',
    intervalHours: 24, retentionCount: 14, lastAttemptAt: new Date().toISOString(), lastSuccessAt: '2026-10-21T21:36:46.960Z', lastVerifiedAt: '2026-10-21T21:36:46.960Z',
    lastBackupPath: '/synthetic/backups/verified.encrypted.mazal', lastBackupSha256: 'a'.repeat(64),
    lastError: 'The backup destination changed or its drive was replaced. Choose the destination again before backing up.' as string | null,
    nextRunAt: new Date(Date.now() + 60_000).toISOString(), running: false,
  };
  await page.route('**/api/automatic-backup', route => route.fulfill({ json: status }));
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#home');
  const health = page.getByRole('complementary', { name: 'Automatic backup health' });
  await expect(health.getByText('Automatic backups need attention', { exact: true })).toBeVisible();
  await expect(health).toContainText('drive was replaced');
  expect(await health.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `outputs/home-backup-health-${width}.png`, fullPage: true });
  const review = health.getByRole('button', { name: 'Review backups', exact: true });
  await review.click();
  const dialog = page.getByRole('dialog', { name: 'Backups and data', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Automatic backup folder', { exact: true })).toHaveValue('/synthetic/backups');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(review).toBeFocused();
  status = { ...status, lastError: null, lastVerifiedAt: new Date().toISOString() };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(health.getByText('Automatic backup verified', { exact: true })).toBeVisible();
  await expect(health).not.toContainText('drive was replaced');
  expect(mutations).toEqual([]);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});

for (const source of ['sample', 'snapshot']) test(`a ${source} preview does not request or offer automatic backup controls`, async ({ page }) => {
  let reads = 0;
  await page.route('**/api/state?**', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'x-mazal-data-source': source } });
  });
  await page.route('**/api/automatic-backup', async route => { reads++; await route.abort(); });
  await page.goto('/#home');
  await expect(page.locator('.home-record-status')).toContainText(source === 'snapshot' ? 'Saved records preview' : 'Saved records');
  await expect(page.getByRole('complementary', { name: 'Automatic backup health' })).toHaveCount(0);
  expect(reads).toBe(0);
});
