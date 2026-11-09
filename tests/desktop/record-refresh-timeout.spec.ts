import { expect, test } from '@playwright/test';

test('unchanged records reuse the displayed snapshot and preserve an open draft without downloading history', async ({ page, request }) => {
  await page.addInitScript(() => {
    const reads: { status: number; parsed: boolean }[] = [];
    Object.assign(window, { mazalStateReads: reads });
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname === '/api/state') {
        const read = { status: response.status, parsed: false };
        reads.push(read);
        const json = response.json.bind(response);
        response.json = () => { read.parsed = true; return json(); };
      }
      return response;
    };
  });
  const initialRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  await page.goto('/#home');
  const initial = await initialRead;
  expect(initial.status()).toBe(200);
  expect(initial.headers()['x-mazal-data-source']).toBe('sample');
  const etag = initial.headers().etag;
  expect(etag).toBeTruthy();
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Description', { exact: true }).fill('Draft during unchanged refresh');
  await dialog.getByLabel('Amount · CAD', { exact: true }).fill('12.34');
  const parsedBefore = await page.evaluate(() => (window as typeof window & { mazalStateReads: { parsed: boolean }[] }).mazalStateReads.filter(read => read.parsed).length);

  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const unchanged = await refresh;
  expect(unchanged.request().headers()['if-none-match']).toBe(etag);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { mazalStateReads: { status: number }[] }).mazalStateReads.at(-1)?.status)).toBe(304);
  expect(await page.evaluate(() => (window as typeof window & { mazalStateReads: { parsed: boolean }[] }).mazalStateReads.filter(read => read.parsed).length)).toBe(parsedBefore);
  expect(unchanged.headers().etag).toBe(etag);
  await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('Draft during unchanged refresh');
  await expect(dialog.getByLabel('Amount · CAD', { exact: true })).toHaveValue('12.34');
  await expect(page.getByRole('alert')).toHaveCount(0);

  const checked = await request.get('/api/state?workspace=live', { headers: { 'If-None-Match': etag } });
  expect(checked.status()).toBe(304);
  expect((await checked.body()).byteLength).toBe(0);
  expect(checked.headers()['cache-control']).toBe('no-store');
});

test('a stalled records refresh times out, keeps the open draft, and resumes polling', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/#home');
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Description', { exact: true }).fill('Unsaved expense during refresh');
  await dialog.getByLabel('Amount · CAD', { exact: true }).fill('12.34');

  let stalledReads = 0;
  await page.route('**/api/state?workspace=live', () => {
    stalledReads++;
  });
  await page.clock.fastForward(15_000);
  await expect.poll(() => stalledReads).toBe(1);
  await page.clock.fastForward(15_001);
  const error = page.getByRole('alert', { includeHidden: true }).filter({ hasText: /timed out/i });
  await expect(error).toBeVisible();
  await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('Unsaved expense during refresh');
  await expect(dialog.getByLabel('Amount · CAD', { exact: true })).toHaveValue('12.34');
  await expect(error.getByRole('button', { name: 'Retry', exact: true, includeHidden: true })).toBeEnabled();

  await page.unroute('**/api/state?workspace=live');
  await page.clock.fastForward(15_000);
  await expect(error).toHaveCount(0);
  await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('Unsaved expense during refresh');
  await expect(dialog.getByLabel('Amount · CAD', { exact: true })).toHaveValue('12.34');
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});

test('a stalled initial read exposes Retry and opens records without reloading', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  let stalledReads = 0;
  await page.route('**/api/state?workspace=live', () => { stalledReads++; });
  await page.goto('/#expenses');
  await expect.poll(() => stalledReads).toBe(1);
  await page.clock.fastForward(15_001);
  await expect(page.getByRole('heading', { name: 'Unable to open records' })).toBeVisible();
  await page.unroute('**/api/state?workspace=live');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Expenses', exact: true, level: 1 })).toBeAttached();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add transaction', exact: true })).toBeEnabled();
});
