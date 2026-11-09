import { expect, test } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';
import { money, summarize } from '../../shared/analytics.ts';
import { displayNetWorth } from '../../shared/net-worth.ts';

test('Home starts with cash and upcoming payments and keeps analysis behind disclosures', async ({ page }) => {
  await page.goto('/#home');
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/, level: 2 })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Home view' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Cash in your accounts', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recorded net worth', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Coming up', exact: true })).toBeVisible();
  await expect(page.locator('.home-balance-details')).toHaveCount(2);
  await expect(page.locator('.home-balance-details[open]')).toHaveCount(0);
  await expect(page.locator('.home-review-queue[open]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Check balance for Browser test cash/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Spending calendar', exact: true })).toBeHidden();
  await expect(page.locator('.home-calendar-details')).not.toHaveAttribute('open', '');
  await expect(page.locator('.home-forecast-details')).not.toHaveAttribute('open', '');
  await expect(page.locator('.home-cash-preview')).toBeHidden();
  await expect(page.locator('.home-worth-summary')).toHaveCSS('background-image', 'none');
  await expect.poll(() => page.locator('.home-position-grid').evaluate(element => {
    const cash = element.querySelector('.home-bank-panel')!.getBoundingClientRect();
    const worth = element.querySelector('.home-worth-summary')!.getBoundingClientRect();
    const calendar = document.querySelector('.home-calendar-details')!.getBoundingClientRect();
    const forecast = document.querySelector('.home-forecast-details')!.getBoundingClientRect();
    const actions = document.querySelector('.home-next-up')!.getBoundingClientRect();
    return cash.right <= worth.left && Math.abs(cash.top - worth.top) < 1 && actions.top >= Math.max(cash.bottom, worth.bottom) && forecast.top >= actions.bottom && calendar.top >= actions.bottom && calendar.left >= forecast.right;
  })).toBe(true);
  await expect(page.locator('.home-next-up')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'outputs/home-welcome-desktop.png', fullPage: true });
  await page.locator('.home-bank-panel summary').click();
  const checkBalance = page.getByRole('button', { name: /^Check balance for Browser test cash/ });
  await expect(checkBalance).toBeVisible();
  await checkBalance.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(checkBalance).toBeFocused();
  const spending = page.getByRole('region', { name: 'Spending calendar', exact: true });
  await page.locator('.home-calendar-details > summary').press('Enter');
  await expect(spending).toBeVisible();
  await spending.getByRole('button', { name: 'Previous month', exact: true }).click();
  const month = await spending.locator('.spend-calendar-navigation h3').innerText();
  await page.locator('.home-bank-panel summary').click();
  await expect(page.locator('.home-bank-panel details')).not.toHaveAttribute('open', '');
  await expect(spending.locator('.spend-calendar-navigation h3')).toHaveText(month);
});

test('reduced motion leaves Home and its disclosures visible after navigation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#home');
  const shell = page.locator('.app-shell');
  await expect(shell).toHaveAttribute('data-motion', 'off');
  await page.locator('.navigation-more-toggle').click();
  await expect(page.getByRole('button', { name: 'Animation off: Reduce Motion is enabled in system settings' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('.home-welcome')).toHaveCSS('opacity', '1');
  await page.locator('.home-bank-panel summary').click();
  await expect(page.locator('.home-bank-list')).toHaveCSS('opacity', '1');
  await expect(page.locator('.home-bank-list')).toHaveCSS('transform', 'none');
  await page.getByRole('button', { name: 'Review records', exact: true }).click();
  await expect(page).toHaveURL(/#documents$/);
  await expect(page.getByRole('group', { name: 'Statements sections' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('.home-welcome')).toHaveCSS('opacity', '1');
  await expect(page.locator('.home-welcome')).toHaveCSS('transform', 'none');
  await expect(page.getByRole('region', { name: 'Spending calendar', exact: true })).toBeHidden();
  await page.locator('.home-calendar-details > summary').click();
  await expect(page.getByRole('region', { name: 'Spending calendar', exact: true })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Home view' })).toHaveCount(0);
  await expect(page.locator('.glass-click-wave')).toHaveCount(0);
});

test('opening net-worth details preserves balances and Pause removes motion without hiding records', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const scope = before.entities.find(entity => entity.kind === 'personal')!.id;
  const summary = summarize(before, scope);
  const netWorth = displayNetWorth(before, summary, scope);
  await page.goto('/#home');
  const detail = page.locator('.home-worth-detail');
  await expect(detail).not.toHaveAttribute('open', '');
  await detail.locator('summary').press('Enter');
  await expect(detail).toHaveAttribute('open', '');
  await expect(page.locator('.position-value')).toHaveText(money(netWorth.netWorthCents));
  await page.locator('.navigation-more-toggle').click();
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', 'off');
  await page.keyboard.press('Escape');
  await expect(page.locator('.home-bank-total')).toHaveText(money(summary.cashCents));
  await expect(page.locator('.position-value')).toHaveCSS('opacity', '1');
  await page.locator('.home-calendar-details > summary').click();
  await expect(page.getByRole('region', { name: 'Spending calendar', exact: true })).toBeVisible();
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});

test('Home polls newer sample records within 20 seconds without losing disclosures or the selected month', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const account = before.accounts.find(item => item.name === 'Browser test cash')!;
  expect(account).toBeTruthy();
  await page.goto('/#home');
  const accounts = page.locator('.home-bank-panel details');
  await accounts.locator('summary').click();
  const calendar = page.getByRole('region', { name: 'Spending calendar', exact: true });
  await page.locator('.home-calendar-details > summary').click();
  await calendar.getByRole('button', { name: 'Previous month', exact: true }).click();
  const month = await calendar.locator('.spend-calendar-navigation h3').innerText();
  const date = await page.locator('.home-welcome time').getAttribute('datetime');
  const description = `Home refresh fixture ${crypto.randomUUID()}`;
  let transactionId: string | undefined;
  try {
    const saved = await request.post('/api/command?workspace=live', { data: {
      type: 'add_transaction', kind: 'expense', accountId: account.id, amountCents: 2500,
      date, description, category: 'Food', expectedRevision: before.revision, requestId: crypto.randomUUID(),
    } });
    expect(saved.ok()).toBe(true);
    const changed = await saved.json() as AppState;
    transactionId = changed.transactions.find(item => item.description === description)?.id;
    expect(transactionId).toBeTruthy();
    const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state', { timeout: 20_000 });
    expect((await (await checked).json()).revision).toBe(changed.revision);
    await expect(calendar).toBeVisible();
    await expect(calendar.locator('.spend-calendar-navigation h3')).toHaveText(month);
    await expect(accounts).toHaveAttribute('open', '');
    await expect(page.locator('.home-bank-total')).toHaveText(money(summarize(before, account.entityId).cashCents - 2500));
    await expect(accounts.getByRole('button', { name: /^Check balance for Browser test cash/ })).toContainText(money(account.balanceCents - 2500));
  } finally {
    if (transactionId) {
      const current = await (await request.get('/api/state?workspace=live')).json() as AppState;
      const undone = await request.post('/api/command?workspace=live', { data: {
        type: 'correct_transaction', id: transactionId, reason: 'Remove isolated Home refresh fixture',
        expectedRevision: current.revision, requestId: crypto.randomUUID(),
      } });
      expect(undone.ok()).toBe(true);
      expect((await undone.json() as AppState).accounts.find(item => item.id === account.id)!.balanceCents).toBe(account.balanceCents);
    }
  }
});
