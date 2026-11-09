import { expect, test } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';

test('a saved income change preserves comparison edits when browser storage is blocked', async ({ page, request }) => {
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
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('mazal.planner.funding.')) throw new DOMException('Storage blocked', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  let updated = false;
  await page.route('**/api/state?workspace=live', async route => {
    const headers = route.request().headers();
    delete headers['if-none-match'];
    const response = await route.fetch({ headers });
    expect(response.status()).toBe(200);
    expect(response.headers()['x-mazal-data-source']).toBe('sample');
    const state = await response.json() as AppState;
    await route.fulfill({ response, headers: { ...response.headers(), etag: `"funding-draft-${state.revision}-${updated ? 'updated' : 'initial'}"` }, json: {
      ...state,
      revision: state.revision + (updated ? 1 : 0),
      roadmap: { ...state.roadmap, incomeTransitionPlanned:true, transitionDate:'2027-01-01', partTimeMonthlyIncomeCents:updated ? 120000 : null },
    } });
  });
  await page.goto('/#simulations/compare');
  await page.locator('.monthly-funding-disclosure > summary').click();
  const comparison = page.locator('.funding-comparison');
  const reserve = comparison.getByRole('textbox', { name:'Protected cash reserve', exact:true });
  const annualReturn = comparison.getByRole('textbox', { name:'Comparison annual return', exact:true });
  await reserve.fill('75');
  await annualReturn.fill('4');
  await expect(comparison).toContainText('Comparison draft could not be saved in this browser');
  updated = true;
  await page.clock.fastForward(60_000);
  await expect(comparison.getByRole('textbox', { name:'Monthly income after the change', exact:true })).toHaveValue('1200.00');
  await expect(reserve).toBeVisible();
  await expect(reserve).toHaveValue('75');
  await expect(annualReturn).toHaveValue('4');
  await page.getByRole('navigation', { name:'Main navigation' }).getByRole('button', { name:'Home', exact:true }).click();
  const discard = page.getByRole('dialog', { name:'Discard unsaved changes?', exact:true });
  await discard.getByRole('button', { name:'Keep editing', exact:true }).click();
  await expect(reserve).toHaveValue('75');
  await expect(page).toHaveURL(/#simulations\/compare$/);
  await page.getByRole('navigation', { name:'Main navigation' }).getByRole('button', { name:'Home', exact:true }).click();
  await discard.getByRole('button', { name:'Discard changes', exact:true }).click();
  await expect(page).toHaveURL(/#home$/);
  expect(mutations).toEqual([]);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});
