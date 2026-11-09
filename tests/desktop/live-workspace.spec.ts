import { expect, test } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';
import { money, today } from '../../shared/analytics.ts';
import { spendingCalendar } from '../../shared/spending-calendar.ts';

test('Expenses refreshes saved changes within 15 seconds without closing its daily view', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const account = before.accounts.find(item => item.name === 'Browser test cash')!;
  const date = today();
  const originalSpending = spendingCalendar(before, account.entityId, date.slice(0, 7), date).totalCents;
  await page.clock.install();
  await page.goto('/#expenses');
  const total = page.locator('.expense-dashboard-total strong');
  await expect(total).toHaveText(money(originalSpending));
  const details = page.locator('.expense-spending-details');
  await details.locator('summary').click();
  const selectedDay = page.locator(`.expense-daily-column[data-date="${date}"]`);
  await selectedDay.click();
  await expect(page.locator('.record-freshness')).toContainText('Balances update when you add or import records');
  const description = `Live refresh fixture ${crypto.randomUUID()}`;
  let transactionId: string | undefined;
  try {
    const saved = await request.post('/api/command?workspace=live', { data: {
      type: 'add_transaction', kind: 'expense', accountId: account.id, amountCents: 1250,
      date, description, category: 'Food', expectedRevision: before.revision, requestId: crypto.randomUUID(),
    } });
    expect(saved.ok()).toBe(true);
    const changed = await saved.json() as AppState;
    transactionId = changed.transactions.find(item => item.description === description)?.id;
    expect(transactionId).toBeTruthy();
    const checked = page.waitForResponse(result => new URL(result.url()).pathname === '/api/state');
    await page.clock.fastForward(15_000);
    await checked;
    await expect(total).toHaveText(money(originalSpending + 1250));
    await expect(details).toHaveAttribute('open', '');
    await expect(selectedDay).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.record-freshness')).toHaveAttribute('data-status', 'ready');
  } finally {
    if (transactionId) {
      const current = await (await request.get('/api/state?workspace=live')).json() as AppState;
      const undone = await request.post('/api/command?workspace=live', { data: {
        type: 'correct_transaction', id: transactionId, reason: 'Remove isolated refresh fixture',
        expectedRevision: current.revision, requestId: crypto.randomUUID(),
      } });
      expect(undone.ok()).toBe(true);
    }
  }
});

test('Home balance comparison opens the existing breakdown and respects the motion switch', async ({ page }) => {
  await page.goto('/#home');
  await expect(page.locator('.home-bank-total')).toContainText('$');
  await page.getByRole('button', { name: /^Assets \$/ }).click();
  await expect(page.locator('.home-worth-detail')).toHaveAttribute('open', '');
  await page.locator('.home-worth-detail > summary').click();
  await page.getByRole('button', { name: 'Settings and data', exact: true }).click();
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('.home-balance-visual')).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('.home-bank-total')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'outputs/live-workspace-home.png', fullPage: true });
});
