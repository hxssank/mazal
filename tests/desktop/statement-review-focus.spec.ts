import { expect, test } from '@playwright/test';
import type { AppState, Command } from '../../shared/types.ts';

test.use({ reducedMotion: 'reduce', viewport: { width: 320, height: 900 } });

test.beforeEach(async ({ page }) => {
  let state: AppState | undefined;
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch();
    expect(response.headers()['x-mazal-data-source']).toBe('sample');
    const saved = await response.json() as AppState;
    state ??= { ...saved, importBatches: [{
      id: 'browser-review-batch', status: 'staged', createdAt: '2026-08-03T12:00:00Z', committedAt: null, decisions: [],
      source: { id: 'browser-review-source', accountId: saved.accounts.find(account => account.type === 'cash')!.id,
        sourceFile: 'Checking-account-statement-2026-08-complete-original-source.csv', sha256: 'a'.repeat(64),
        periodStart: '2026-08-01', periodEnd: '2026-08-02', openingBalanceCents: 500000, closingBalanceCents: 497500,
        rows: [
          { id: 'first', transactionDate: '2026-08-01', postingDate: '2026-08-01', description: 'Browser coffee', amountCents: -500, sourcePage: 1 },
          { id: 'second', transactionDate: '2026-08-02', postingDate: '2026-08-02', description: 'Browser groceries', amountCents: -2000, sourcePage: 1 },
        ],
      },
    }] };
    await route.fulfill({ response, json: state });
  });
  await page.route('**/api/command?*', async route => {
    const command = route.request().postDataJSON() as Command;
    expect(command.type).toBe('review_statement');
    expect(command.expectedRevision).toBe(state!.revision);
    if (command.type !== 'review_statement') throw new Error('Only synthetic classification updates are expected');
    state = { ...state!, revision: state!.revision + 1, importBatches: state!.importBatches!.map(batch => batch.id === command.importId ? { ...batch, decisions: command.decisions } : batch) };
    await route.fulfill({ json: state });
  });
  await page.goto('/#documents/imports');
  await page.getByRole('button', { name: 'Review entries', exact: true }).click();
});

test('long statement filenames remain readable inside a narrow review panel', async ({ page }) => {
  const heading = page.locator('.import-entries > h3');
  await expect(heading).toBeVisible();
  expect(await heading.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.locator('.import-queue').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test('classification, grouped review and extraction return keyboard focus to their controls', async ({ page }) => {
  const first = page.locator('.import-entry').nth(0).getByRole('button');
  const second = page.locator('.import-entry').nth(1).getByRole('button');
  await first.click();
  await page.locator('.import-editor select').first().selectOption('expense');
  await page.getByLabel('Category', { exact: true }).fill('Food');
  await page.getByRole('button', { name: 'Save classification', exact: true }).click();
  await expect(first).toBeFocused();
  await expect(first).toHaveText('expense · Food');
  await second.click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(second).toBeFocused();
  const group = page.getByRole('button', { name: 'Review matching rows together', exact: true });
  await group.click();
  const description = page.locator('.statement-review-tools select').first();
  await expect(description).toBeFocused();
  await description.selectOption('Browser groceries');
  expect(await page.locator('.statement-review-tools .mazal-checkbox').evaluate(element => {
    const checkbox = element.querySelector('input')!.getBoundingClientRect();
    const text = element.querySelector('span')!.getBoundingClientRect();
    return checkbox.width <= 24 && checkbox.right < text.left && Math.abs(checkbox.top - text.top) < 5;
  })).toBe(true);
  expect(await page.locator('.import-editor').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.locator('.statement-review-tools .mazal-checkbox input').check();
  await page.getByRole('button', { name: 'Save selected classifications', exact: true }).click();
  await expect(group).toBeFocused();
  const correction = page.getByRole('button', { name: 'Correct extracted rows', exact: true });
  await correction.click();
  await expect(page.getByLabel('Period start', { exact: true })).toBeFocused();
  expect(await page.locator('.import-editor').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(correction).toBeFocused();
});

for (const mode of ['entry', 'group'] as const) {
  test(`discarding ${mode === 'entry' ? 'an entry' : 'a group'} draft during navigation focuses Source files`, async ({ page }) => {
    if (mode === 'entry') await page.locator('.import-entry').first().getByRole('button').click();
    else await page.getByRole('button', { name: 'Review matching rows together', exact: true }).click();
    const destination = page.getByRole('group', { name: 'Statements sections' }).getByRole('button', { name: /^Source files(?:\s*\d+ waiting)?$/ });
    await destination.click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(destination).toHaveAttribute('aria-pressed', 'true');
    await expect(destination).toBeFocused();
    await expect(page.locator('.import-editor')).toHaveCount(0);
  });
}
