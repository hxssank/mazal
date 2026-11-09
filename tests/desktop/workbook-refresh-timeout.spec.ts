import { expect, test } from '@playwright/test';

for (const savedFirst of [false, true]) test(`an Excel response lost ${savedFirst ? 'after' : 'before'} writing checks status before another update`, async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json();
  const posts: unknown[] = [];
  let handled = false;
  let holdStatus = false;
  let statusReads = 0;
  await page.route('**/api/master-workbook/refresh?workspace=live', async route => {
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) {
      if (savedFirst) expect((await route.fetch()).status()).toBe(200);
      holdStatus = true;
      handled = true;
      return;
    }
    await route.continue();
  });
  await page.route('**/api/master-workbook/status?workspace=live', async route => {
    if (holdStatus) { statusReads++; return; }
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/#documents/files');
  const excel = page.locator('.document-workbook');
  await excel.locator('summary').focus();
  await page.keyboard.press('Enter');
  const update = excel.getByRole('button', { name: 'Update Excel', exact: true });
  await expect(update).toBeEnabled();
  await update.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => handled).toBe(true);
  await page.clock.fastForward(180_001);
  await expect(excel.getByRole('alert').filter({ hasText: /timed out after 3 minutes/ })).toBeVisible();
  await expect(excel.getByRole('alert')).toBeFocused();
  await expect.poll(() => statusReads).toBe(1);
  await expect(update).toBeDisabled();
  await page.clock.fastForward(15_001);
  const retry = excel.getByRole('button', { name: 'Retry workbook check', exact: true });
  await expect(retry).toBeEnabled();
  await expect(update).toBeDisabled();
  expect(posts).toHaveLength(1);
  holdStatus = false;
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(update).toBeEnabled();
  expect(posts).toHaveLength(1);
  if (savedFirst) {
    await expect(excel.getByRole('link', { name: 'Download Excel', exact: true })).toBeVisible();
    const status = await (await request.get('/api/master-workbook/status?workspace=live')).json();
    expect(status.available).toBe(true);
    expect(status.revision).toBe(before.revision);
    expect(status.modified).toBe(false);
  }
  await update.focus();
  await page.keyboard.press('Enter');
  await expect(excel.getByRole('status')).toHaveText('Excel updated from your saved records.');
  expect(posts).toEqual([{ expectedRevision: before.revision }, { expectedRevision: before.revision }]);
  const workbook = await request.get('/api/master-workbook?workspace=live');
  expect(workbook.status()).toBe(200);
  expect((await workbook.body()).subarray(0, 2).toString()).toBe('PK');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Statements', exact: true, level: 1 })).toBeFocused();
  await page.reload();
  await excel.locator('summary').click();
  await expect(excel.getByRole('link', { name: 'Download Excel', exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});

test('an Excel timeout preserves the active import draft and its keyboard focus', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json();
  let writes = 0;
  await page.route('**/api/master-workbook/refresh?workspace=live', () => { writes++; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/#documents/files');
  const excel = page.locator('.document-workbook');
  await excel.locator('summary').click();
  await excel.getByRole('button', { name: 'Update Excel', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  const add = page.getByRole('button', { name: 'Add statement', exact: true });
  await add.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Import a statement', exact: true });
  const opening = dialog.getByLabel('Opening balance · CAD', { exact: true });
  await opening.fill('123.45');
  await page.clock.fastForward(180_001);
  await expect(excel.getByRole('alert', { includeHidden: true })).toContainText('Updating Excel timed out after 3 minutes.');
  await expect(opening).toHaveValue('123.45');
  await expect(opening).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(opening).toBeFocused();
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(writes).toBe(1);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});
