import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { DailyPlan, EngineEnvelope } from '../../shared/engine.ts';
import type { AppState } from '../../shared/types.ts';

const dollars = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);

async function openForecast(page: Page, request: APIRequestContext) {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const mutations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/engine/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(`${request.method()} ${path}`);
  });
  const forecast = page.waitForResponse(response => new URL(response.url()).pathname === '/api/engine/project' && response.request().postDataJSON()?.kind === 'daily_plan' && response.ok());
  await page.goto('/#home');
  const plan = (await (await forecast).json() as EngineEnvelope<DailyPlan>).result;
  const cash = page.getByRole('region', { name: 'Cash ahead', exact: true });
  await page.locator('.home-forecast-details > summary').click();
  await expect(cash).toBeVisible();
  await expect(cash.getByRole('textbox', { name: 'Extra cash spending', exact: true })).toBeHidden();
  await cash.locator('.home-cash-experiment > summary').click();
  expect(plan.days).toHaveLength(30);
  return { before, plan, cash, mutations };
}

async function expectUnchanged(request: APIRequestContext, before: AppState, mutations: string[]) {
  expect(mutations).toEqual([]);
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  expect(await response.json()).toEqual(before);
}

test('keyboard date scrubbing and a spending preview update cash without saving records', async ({ page, request }) => {
  const { before, plan, cash, mutations } = await openForecast(page, request);
  const slider = cash.getByRole('slider', { name: 'Inspect Home cash forecast date' });
  const amount = cash.getByRole('textbox', { name: 'Extra cash spending', exact: true });
  const selected = cash.locator('.home-cash-selected-amount');
  await expect(selected).toHaveText(dollars(plan.days[0].afterProtectedCents));
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toHaveValue('1');
  await expect(slider).toBeFocused();
  await expect(selected).toHaveText(dollars(plan.days[1].afterProtectedCents));
  await expect(slider).toHaveAttribute('aria-valuetext', new RegExp(`${dollars(plan.days[1].afterProtectedCents).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, end of day after reserves`));
  await amount.fill('12.34');
  await expect(selected).toHaveText(dollars(plan.days[1].afterProtectedCents - 1234));
  await expect(cash.locator('.home-cash-baseline')).toHaveCount(1);
  await cash.locator('.home-cash-experiment > summary').click();
  await expect(amount).toBeHidden();
  await expect(cash.locator('.home-cash-experiment > summary')).toContainText('$12.34 purchase preview is active');
  await expect(selected).toHaveText(dollars(plan.days[1].afterProtectedCents - 1234));
  await cash.locator('.home-cash-experiment > summary').press('Enter');
  await expect(amount).toHaveValue('12.34');
  await cash.getByRole('combobox', { name: 'Spend date', exact: true }).selectOption(plan.days[4].date);
  await expect(slider).toHaveValue('4');
  await expect(selected).toHaveText(dollars(plan.days[4].afterProtectedCents - 1234));
  await expect(cash.locator('.home-cash-day-details')).toContainText('Extra spending preview');
  await slider.press('ArrowLeft');
  await expect(slider).toHaveValue('3');
  await expect(selected).toHaveText(dollars(plan.days[3].afterProtectedCents));
  await cash.getByRole('button', { name: 'Reset preview', exact: true }).click();
  await expect(amount).toHaveValue('');
  await expect(cash.getByRole('combobox', { name: 'Spend date', exact: true })).toHaveValue(plan.asOf);
  await expect(cash.locator('.home-cash-baseline')).toHaveCount(0);
  await expect(slider).toHaveValue('3');
  await expect(selected).toHaveText(dollars(plan.days[3].afterProtectedCents));
  await amount.fill('25');
  await page.reload();
  await page.locator('.home-forecast-details > summary').click();
  await expect(cash).toBeVisible();
  await expect(amount).toBeHidden();
  await cash.locator('.home-cash-experiment > summary').click();
  await expect(amount).toHaveValue('');
  await expect(slider).toHaveValue('0');
  await expectUnchanged(request, before, mutations);
});

test('a shorter period bounds the date control and selected payments open their saved record', async ({ page, request }) => {
  const { before, cash, mutations } = await openForecast(page, request);
  const rent = before.obligations.find(item => item.name === 'Browser test rent')!;
  expect(rent).toBeTruthy();
  const slider = cash.getByRole('slider', { name: 'Inspect Home cash forecast date' });
  await slider.press('End');
  await expect(slider).toHaveValue('29');
  await cash.getByRole('group', { name: 'Cash forecast period' }).getByRole('button', { name: 'Next 7 days', exact: true }).click();
  await expect(slider).toHaveAttribute('max', '6');
  await expect(slider).toHaveValue('6');
  const lowestDate = await cash.locator('.home-cash-lowest small').innerText();
  await cash.getByRole('button', { name: 'Jump to lowest balance', exact: true }).click();
  await expect(slider).toBeFocused();
  expect(await slider.getAttribute('aria-valuetext')).toContain(lowestDate);
  await slider.press('Home');
  await expect(slider).toHaveValue('0');
  await cash.locator('.home-cash-day-details').getByRole('button', { name: /Browser test rent/ }).click();
  await expect(page).toHaveURL(new RegExp(`#expenses/schedule\\?record=${encodeURIComponent(rent.id)}$`));
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close payment editor', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('.home-forecast-details > summary').click();
  await expect(cash).toBeVisible();
  await cash.locator('.home-cash-experiment > summary').click();
  await expect(cash.getByRole('textbox', { name: 'Extra cash spending', exact: true })).toHaveValue('');
  await expectUnchanged(request, before, mutations);
});

test('reduced motion leaves the cash chart and its controls usable after navigation', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { before, plan, cash, mutations } = await openForecast(page, request);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', 'off');
  await expect(cash).toHaveCSS('opacity', '1');
  await expect(cash).toHaveCSS('transform', 'none');
  await expect(cash.locator('.home-cash-chart')).toBeVisible();
  const slider = cash.getByRole('slider', { name: 'Inspect Home cash forecast date' });
  await cash.getByRole('group', { name: 'Try a spending amount' }).getByRole('button', { name: '$250', exact: true }).click();
  await expect(cash.getByRole('textbox', { name: 'Extra cash spending', exact: true })).toHaveValue('250');
  await slider.press('ArrowRight');
  await expect(slider).toHaveValue('1');
  await expect(cash.locator('.home-cash-selected-amount')).toHaveText(dollars(plan.days[1].afterProtectedCents - 25000));
  await page.getByRole('button', { name: 'Review records', exact: true }).click();
  await expect(page).toHaveURL(/#documents$/);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.locator('.home-forecast-details > summary').click();
  await expect(cash).toBeVisible();
  await expect(cash).toHaveCSS('opacity', '1');
  await expect(cash).toHaveCSS('transform', 'none');
  await cash.locator('.home-cash-experiment > summary').click();
  await expect(cash.getByRole('textbox', { name: 'Extra cash spending', exact: true })).toHaveValue('');
  await slider.press('ArrowRight');
  await expect(slider).toHaveValue('1');
  await expect(cash.locator('.home-cash-selected-amount')).toHaveText(dollars(plan.days[1].afterProtectedCents));
  await expectUnchanged(request, before, mutations);
});
