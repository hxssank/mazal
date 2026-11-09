import { expect, test, type APIRequestContext } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';
import { money } from '../../shared/analytics.ts';
import { buildReviewPeriod } from '../../shared/review-period.ts';

async function savedState(request: APIRequestContext): Promise<AppState> {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  return response.json();
}

test('spending review filters actual records, remembers its period through Back and reload, and makes no writes', async ({ page, request }) => {
  let state = await savedState(request);
  const cash = state.accounts.find(account => account.name === 'Browser test cash')!;
  const date = new Date().toLocaleDateString('en-CA');
  const startingExpenses = buildReviewPeriod(state, cash.entityId, date, 'monthly').expensesCents;
  const prefix = `Review journey ${crypto.randomUUID()}`;
  const added: string[] = [];
  try {
    for (const [description, amountCents, category] of [[`${prefix} groceries`, 4200, 'Food'], [`${prefix} transport`, 1800, 'Transport']] as const) {
      const response = await request.post('/api/command?workspace=live', { data: { type: 'add_transaction', kind: 'expense', accountId: cash.id, date, description, category, amountCents, expectedRevision: state.revision, requestId: crypto.randomUUID() } });
      expect(response.ok()).toBe(true);
      state = await response.json();
      added.push(state.transactions.find(transaction => transaction.description === description)!.id);
    }
    const mutations: string[] = [];
    page.on('request', incoming => { const path = new URL(incoming.url()).pathname; if (path.startsWith('/api/') && !path.startsWith('/api/engine/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(incoming.method())) mutations.push(`${incoming.method()} ${path}`); });
    await page.goto('/#simulations/review');
    const review = page.getByRole('region', { name: 'Spending review', exact: true });
    await expect(review).toBeVisible();
    await review.getByRole('button', { name: 'Monthly', exact: true }).click();
    await expect(review.locator('.review-primary-total strong')).toHaveText(money(startingExpenses + 6000));
    const days = review.locator('.review-chart-day:not(:disabled)');
    await expect(review.locator('.review-chart-day[tabindex="0"]')).toHaveCount(1);
    const last = days.last();
    await last.focus();
    await last.press('Home');
    await expect(days.first()).toBeFocused();
    await days.first().press('End');
    await expect(last).toBeFocused();
    await expect(last).toHaveAttribute('aria-pressed', 'true');
    await expect(review.locator('.review-activity')).toContainText(`${prefix} groceries`);
    await review.locator('.review-category-list button').filter({ hasText: 'Food' }).click();
    await expect(review.locator('.review-activity')).toContainText(`${prefix} groceries`);
    await expect(review.locator('.review-activity')).not.toContainText(`${prefix} transport`);
    await review.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(review.locator('.review-activity')).toContainText(`${prefix} transport`);
    await review.getByRole('button', { name: 'Previous review month', exact: true }).click();
    const period = await review.locator('.review-period-controls > span').innerText();
    await review.getByRole('button', { name: 'Open full activity', exact: true }).click();
    await expect(page).toHaveURL(/#expenses\/activity$/);
    await page.goBack();
    await expect(page).toHaveURL(/#simulations\/review$/);
    await expect(review.locator('.review-period-controls > span')).toHaveText(period);
    await page.reload();
    await expect(review.locator('.review-period-controls > span')).toHaveText(period);
    await expect(review.getByRole('button', { name: 'Monthly', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(mutations).toEqual([]);
    expect(await savedState(request)).toEqual(state);
  } finally {
    for (const id of added) {
      const current = await savedState(request);
      const response = await request.post('/api/command?workspace=live', { data: { type: 'correct_transaction', id, reason: 'Remove isolated review journey fixture', expectedRevision: current.revision, requestId: crypto.randomUUID() } });
      expect(response.ok()).toBe(true);
    }
  }
});

test('planning day selection filters the agenda and resets when the visible week or range changes', async ({ page, request }) => {
  const before = await savedState(request);
  await page.goto('/#simulations');
  const horizon = page.getByRole('region', { name: 'Plan by day', exact: true });
  await expect(horizon).toBeVisible();
  await page.getByRole('combobox', { name: 'Planner date range', exact: true }).selectOption('30');
  const firstDay = horizon.locator('.planner-day-cards button').first();
  await firstDay.click();
  await expect(page.locator('.planner-selected-date')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payments and income' })).toContainText('Browser test rent');
  await horizon.getByRole('button', { name: 'Next planning week', exact: true }).click();
  await expect(page.locator('.planner-selected-date')).toHaveCount(0);
  await expect(horizon.locator('button[aria-pressed="true"]')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Planner date range', exact: true }).selectOption('7');
  await expect(horizon.getByRole('button', { name: 'Previous planning week', exact: true })).toBeDisabled();
  await expect(horizon.getByRole('button', { name: 'Next planning week', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Planner date range', exact: true }).selectOption('30');
  await expect(horizon.getByRole('button', { name: 'Previous planning week', exact: true })).toBeDisabled();
  await horizon.locator('.planner-day-cards button').first().press('End');
  await expect(horizon.locator('button[aria-pressed="true"]')).toBeFocused();
  await expect(horizon.getByRole('button', { name: 'Next planning week', exact: true })).toBeDisabled();
  expect(await savedState(request)).toEqual(before);
});

test('review panels remain visible and usable with reduced motion and a narrow desktop window', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto('/#simulations/review');
  const review = page.getByRole('region', { name: 'Spending review', exact: true });
  await expect(review).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', 'off');
  for (const label of ['Daily', 'Monthly', 'Weekly']) {
    await review.getByRole('button', { name: label, exact: true }).click();
    for (const panel of await review.locator('[data-review-panel]').all()) {
      await expect(panel).toBeVisible();
      await expect(panel).toHaveCSS('opacity', '1');
      await expect(panel).toHaveCSS('transform', 'none');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await review.getByRole('button', { name: /Check account balances/ }).click();
  await expect(page).toHaveURL(/#simulations\/setup$/);
  await expect(page.locator('[data-setup="accounts"]')).toBeVisible();
  await expect(page.locator('[data-setup="accounts"] button').first()).toBeFocused();
});
