import { expect, test } from '@playwright/test';

test('a payment deep link opens one modal and closing it restores navigation', async ({ page, request }) => {
  const response = await request.get('/api/state');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const state = await response.json();
  const rent = state.obligations.find((item: { name: string }) => item.name === 'Browser test rent');
  expect(rent).toBeTruthy();
  await page.goto(`/#expenses/schedule?record=${encodeURIComponent(rent.id)}`);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close payment editor' }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(/#home$/);
  await expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeFocused();
  await navigation.getByRole('button', { name: 'Expenses', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#expenses$/);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('a scheduled debt opens its account and preselects it for recording a payment', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  const loan = state.accounts.find((item: { name: string }) => item.name === 'Browser test lower-rate loan');
  expect(loan).toBeTruthy();
  await page.goto('/#expenses/schedule');
  await page.getByRole('region', { name: 'Upcoming schedule', exact: true }).getByRole('link', { name: 'Review Browser test lower-rate loan on Debts', exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`#debts\\?record=${loan.id}$`));
  await expect(page.locator('#debt-payoff')).toHaveAttribute('aria-label', 'Browser test lower-rate loan payoff calculator');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Debt account', { exact: true })).toHaveValue(loan.id);
});

const sections = [
  { name: 'Expenses', route: 'expenses', groupRole: 'navigation', groupName: 'Expense views', itemRole: 'button', selected: 'aria-pressed', first: 'Transactions', firstRoute: 'expenses/activity', second: 'Bills', secondRoute: 'expenses/schedule' },
  { name: 'Planner', route: 'simulations', groupRole: 'navigation', groupName: 'Planner sections', itemRole: 'button', selected: 'aria-pressed', first: 'Plan setup', firstRoute: 'simulations/setup', second: 'Compare options', secondRoute: 'simulations/compare' },
  { name: 'Investments', route: 'investments', groupRole: 'tablist', groupName: 'Investments section', itemRole: 'tab', selected: 'aria-selected', first: /^Accounts/, firstRoute: 'investments/accounts', second: /^Investments/, secondRoute: 'investments' },
  { name: 'Statements', route: 'documents', groupRole: 'group', groupName: 'Statements sections', itemRole: 'button', selected: 'aria-pressed', first: /^Source files(?:\s*\d+ waiting)?$/, firstRoute: 'documents/files', second: /^Import review(?:\s*\d+)?$/, secondRoute: 'documents/imports' },
] as const;

for (const dirty of [false, true]) {
  test(`Back from a ${dirty ? 'dirty' : 'clean'} transaction form restores destination focus without saving`, async ({ page, request }) => {
    const response = await request.get('/api/state');
    expect(response.headers()['x-mazal-data-source']).toBe('sample');
    const before = await response.json();
    await page.goto('/#home');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Expenses', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Expenses', exact: true, level: 1 })).toBeFocused();
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    if (dirty) await dialog.getByLabel('Description', { exact: true }).fill('Unsaved keyboard navigation check');
    await page.goBack();
    if (dirty) await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page).toHaveURL(/#home$/);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeFocused();
    const after = await (await request.get('/api/state')).json();
    expect(after.revision).toBe(before.revision);
  });
}

for (const section of sections) {
  test(`${section.name} subsection URLs survive refresh and browser history`, async ({ page }) => {
    await page.goto(`/#${section.route}`);
    const group = page.getByRole(section.groupRole, { name: section.groupName });
    const first = group.getByRole(section.itemRole, { name: section.first, exact: typeof section.first === 'string' });
    const second = group.getByRole(section.itemRole, { name: section.second, exact: typeof section.second === 'string' });
    await first.focus();
    await first.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#${section.firstRoute}$`));
    await expect(first).toHaveAttribute(section.selected, 'true');
    await expect(first).toBeFocused();
    await second.click();
    await expect(page).toHaveURL(new RegExp(`#${section.secondRoute}$`));
    await expect(second).toHaveAttribute(section.selected, 'true');
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`#${section.firstRoute}$`));
    await expect(first).toHaveAttribute(section.selected, 'true');
    await page.reload();
    await expect(first).toHaveAttribute(section.selected, 'true');
    await expect(page).toHaveURL(new RegExp(`#${section.firstRoute}$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`#${section.secondRoute}$`));
    await expect(second).toHaveAttribute(section.selected, 'true');
  });
}
