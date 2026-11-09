import { expect, test } from '@playwright/test';

for (const width of [320, 1440]) {
  test(`search filters destinations and navigates by keyboard at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Search pages and actions', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Search and quick actions' });
    const search = dialog.getByRole('combobox');
    await expect(search).toBeFocused();
    await search.fill('bills');
    await expect(dialog.getByRole('option')).toHaveCount(2);
    await search.press('ArrowUp');
    await expect(dialog.getByRole('option', { name: /^Expenses/ })).toHaveAttribute('aria-selected', 'true');
    await search.press('ArrowDown');
    await expect(dialog.getByRole('option', { name: /^Bills and payments/ })).toHaveAttribute('aria-selected', 'true');
    await search.press('Enter');
    await expect(page).toHaveURL(/#expenses\/schedule$/);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Expenses', exact: true })).toBeFocused();
    await trigger.click();
    await search.fill('no such action exists');
    await expect(dialog.getByText('No matching pages or actions')).toBeVisible();
    await search.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await search.press('Escape');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await search.fill('bills');
    await search.press('Enter');
    await expect(page.getByRole('heading', { name: 'Expenses', exact: true })).toBeFocused();
  });
}

test('search opens forms without writing records or stacking over a draft', async ({ page, request }) => {
  const before = await (await request.get('/api/state')).json();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: 'Search pages and actions' });
  await search.fill('record transfer');
  await search.press('Enter');
  const form = page.getByRole('dialog');
  await expect(form).toHaveCount(1);
  await expect(form.getByRole('button', { name: 'Transfer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await form.getByLabel('Description', { exact: true }).fill('Unsaved transfer');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: 'Search pages and actions' })).toHaveCount(0);
  await expect(form.getByLabel('Description', { exact: true })).toHaveValue('Unsaved transfer');
  await page.keyboard.press('Escape');
  await form.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Search pages and actions', exact: true })).toBeFocused();
  const after = await (await request.get('/api/state')).json();
  expect(after.revision).toBe(before.revision);
});

test('dark theme stays dark under a light system preference, including forms', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const shell = page.locator('.app-shell');
  await expect(shell).toHaveCSS('color-scheme', 'dark');
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCSS('color-scheme', 'dark');
  await expect(dialog.getByLabel('Description', { exact: true })).toHaveCSS('color-scheme', 'dark');
  const background = await dialog.evaluate(element => getComputedStyle(element).backgroundColor);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(dialog).toHaveCSS('background-color', background);
});
