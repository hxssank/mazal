import { expect, test } from '@playwright/test';

test('a stalled projection exposes Retry and preserves the planner draft through recovery and navigation', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json();
  const mutations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/engine/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(path);
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/#simulations/compare');
  const pay = page.getByRole('textbox', { name: 'Pay per paycheck', exact: true });
  await expect(pay).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Calculating from current records' })).toHaveCount(0);
  let stalledRequests = 0;
  const engineRoute = '**/api/engine/project?workspace=live';
  await page.route(engineRoute, async route => {
    if (route.request().postDataJSON()?.kind === 'planner') stalledRequests++;
    else await route.continue();
  });
  await pay.fill('2345.67');
  await expect.poll(() => stalledRequests).toBeGreaterThan(0);
  await page.clock.fastForward(125_001);
  const error = page.getByRole('alert').filter({ hasText: /timed out/i });
  await expect(error).toBeVisible();
  await expect(pay).toHaveValue('2345.67');
  await expect(pay).toBeFocused();
  await page.unroute(engineRoute);
  const retryResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/engine/project' && response.request().postDataJSON()?.kind === 'planner' && response.ok());
  await error.getByRole('button', { name: 'Retry calculation', exact: true }).click();
  await retryResponse;
  await expect(error).toHaveCount(0);
  await expect(pay).toHaveValue('2345.67');
  await page.reload();
  await expect(pay).toHaveValue('2345.67');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/#home$/);
  await page.goBack();
  await expect(page).toHaveURL(/#simulations\/compare$/);
  await expect(pay).toHaveValue('2345.67');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', 'off');
  expect(mutations).toEqual([]);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});
