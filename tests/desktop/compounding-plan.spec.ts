import { expect, test } from '@playwright/test';

for (const width of [320, 1440]) test(`the lifetime target and plan remain usable at ${width}px without changing records`, async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json();
  await page.route('**/api/state?**', async route => {
    const response = await route.fetch();
    const state = await response.json();
    state.roadmap = { ...state.roadmap, growthTarget: 'lifetime_compounding' };
    await route.fulfill({ response, json: state });
  });
  const mutations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/engine/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(path);
  });
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#simulations');
  const target = page.getByRole('region', { name: 'Lifetime compounding', exact: true });
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute('aria-busy', 'false');
  await expect(target).toContainText('Target saved');
  await expect(target).toContainText('extra dated costs and unknown payments');
  const steps = target.locator('summary').filter({ hasText: 'Your compounding plan' });
  await steps.focus();
  await page.keyboard.press('Enter');
  await expect(target.getByRole('heading', { name: 'Monthly plan in CAD' })).toBeVisible();
  expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await target.locator('summary').filter({ hasText: 'What consistent contributions could build' }).click();
  await expect(target.getByRole('table')).toBeVisible();
  await expect(target).toContainText('Returns are not guaranteed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `outputs/compounding-plan-${width}.png`, fullPage: true });
  await target.getByRole('button', { name: 'Review saved assumptions', exact: true }).click();
  await expect(page).toHaveURL(/#simulations\/setup$/);
  await page.getByRole('button', { name: 'Your plan', exact: true }).click();
  await target.getByRole('button', { name: 'Compare debt and investing', exact: true }).click();
  await expect(page).toHaveURL(/#simulations\/compare$/);
  await expect(page.getByRole('heading', { name: 'Explore debt, cash and investing' })).toBeVisible();
  expect(mutations).toEqual([]);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});
