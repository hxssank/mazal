import { expect, test } from '@playwright/test';

for (const width of [320, 1440]) {
  test(`Home actions open existing details and preserve their state at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/#home');
    await expect(page.locator('.home-outlook-value')).toBeVisible();
    const actions = page.getByRole('group', { name: 'Home quick actions', exact: true });
    await expect(actions).toBeVisible();
    await actions.getByRole('button', { name: /Review balances/ }).click();
    const balances = page.locator('.home-bank-panel details');
    await expect(balances).toHaveAttribute('open', '');
    await expect(balances.locator('summary')).toBeFocused();
    await actions.getByRole('button', { name: /Explore spending/ }).click();
    const calendar = page.locator('.home-calendar-details');
    await expect(calendar).toHaveAttribute('open', '');
    await expect(calendar.locator(':scope > summary')).toBeFocused();
    await expect(balances).toHaveAttribute('open', '');
    await expect(page.getByRole('region', { name: 'Spending calendar', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await actions.getByRole('button', { name: /Record spending/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(actions.getByRole('button', { name: /Record spending/ })).toBeFocused();
    await actions.getByRole('button', { name: /Manage payments/ }).click();
    await expect(page).toHaveURL(/#expenses\/schedule$/);
  });
}
