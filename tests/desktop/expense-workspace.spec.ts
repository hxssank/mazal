import { expect, test, type Page } from '@playwright/test';
import type { AppState, Transaction } from '../../shared/types.ts';
import { today } from '../../shared/analytics.ts';
import { shiftCalendarMonth } from '../../shared/spending-calendar.ts';
import { ENGINE_MODEL_VERSION } from '../../shared/engine.ts';
import { engineFixtureResult } from '../../src/engine-test-fixture.ts';

function expenseFixture(saved: AppState): AppState {
  const state = structuredClone(saved);
  const cash = state.accounts.find(account => account.name === 'Browser test cash')!;
  const debt = state.accounts.find(account => account.name === 'Browser test lower-rate loan')!;
  expect(cash).toBeTruthy();
  expect(debt).toBeTruthy();
  const date = today();
  const previous = `${shiftCalendarMonth(date.slice(0, 7), -1)}-01`;
  const entry = (id: string, amountCents: number, category: string, patch: Partial<Transaction> = {}): Transaction => ({
    id, date, description: id, kind: 'expense', accountId: cash.id, toAccountId: null,
    amountCents, category, source: 'Browser fixture', createdAt: `${date}T12:00:00Z`, ...patch,
  });
  state.transactions = [
    entry('Workspace groceries', 12345, 'Food'),
    entry('Workspace grocery refund', -2345, 'Food', { refundOf: 'Workspace groceries' }),
    entry('Workspace transit', 5000, 'Transport'),
    entry('Workspace groceries previous month', 4000, 'Food', { date: previous, createdAt: `${previous}T12:00:00Z` }),
    entry('Workspace car contribution', 180000, 'Asset purchase', { kind: 'transfer', toAccountId: 'asset-purchase:browser-car' }),
    entry('Workspace debt payment', 30000, 'Debt repayment', { kind: 'debt_payment', toAccountId: debt.id }),
    entry('Workspace paycheck', 300000, 'Payroll', { kind: 'income' }),
  ];
  return state;
}

async function showExpenseFixture(page: Page, state: AppState): Promise<() => number> {
  let writes = 0;
  page.on('request', request => {
    if (['/api/command', '/api/backup/restore'].includes(new URL(request.url()).pathname)) writes++;
  });
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch();
    expect(response.headers()['x-mazal-data-source']).toBe('sample');
    await route.fulfill({ response, json: state });
  });
  await page.route(/\/api\/engine\/(summary|project)\?/, async route => {
    const url = new URL(route.request().url());
    const request = route.request().method() === 'POST' ? route.request().postDataJSON() : Object.fromEntries(url.searchParams);
    const scope = request.scope ?? 'personal';
    const asOf = request.asOf;
    const kind = url.pathname.endsWith('/summary') ? 'summary' : request.kind;
    await route.fulfill({ json: {
      workspace: state.workspace, revision: state.revision, scope, asOf,
      inputHash: 'browser-expense-fixture', modelVersion: ENGINE_MODEL_VERSION,
      result: engineFixtureResult(state, scope, asOf, kind, request.draft),
    } });
  });
  return () => writes;
}

test.use({ reducedMotion: 'reduce' });

test('Bills expands fixed installments across the selected range and explains unconfirmed payment periods', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const state = structuredClone(before);
  const cash = state.accounts.find(account => account.name === 'Browser test cash')!;
  const loan = state.accounts.find(account => account.name === 'Browser test lower-rate loan')!;
  loan.name = 'Fixed installment review';
  loan.balanceCents = 100000;
  loan.debtTerms = { aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 10000, repaymentKind: 'fixed', paymentDueDate: '2026-10-25', statementDate: '2026-09-30', notes: '' };
  state.accounts = [cash, loan];
  state.obligations = [];
  state.transactions = [];
  state.assetPurchases = [];
  const writes = await showExpenseFixture(page, state);
  await page.clock.setFixedTime(new Date('2026-10-20T12:00:00'));
  await page.goto('/#expenses/schedule');
  const totals = page.getByLabel('Schedule totals', { exact: true });
  const agenda = page.getByRole('region', { name: 'Upcoming schedule' });
  for (const [days, amount, count] of [[30, '$100', 1], [60, '$200', 2], [90, '$300', 3]] as const) {
    await page.getByRole('combobox', { name: 'Schedule date range' }).selectOption(String(days));
    await expect(totals.locator('strong')).toHaveText(amount);
    await expect(agenda.getByRole('heading', { name: loan.name, exact: true })).toHaveCount(count);
  }
  await expect(agenda.getByText('Debt payment · projected monthly repeat', { exact: true })).toHaveCount(2);
  loan.debtTerms.statementDate = null;
  state.transactions = [{
    id: 'payment-without-statement', date: '2026-10-19', description: 'Recorded loan payment',
    kind: 'debt_payment', accountId: cash.id, toAccountId: loan.id, amountCents: 2500,
    category: 'Debt repayment', source: 'Browser fixture', createdAt: '2026-10-19T12:00:00Z',
  }];
  await page.reload();
  await expect(agenda.getByText('Debt payment · payment period unconfirmed', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Schedule details needed' })).toContainText('Recorded payments have not reduced this amount because their payment period is unknown.');
  expect(writes()).toBe(0);
  expect((await (await request.get('/api/state?workspace=live')).json()).revision).toBe(before.revision);
});

test('saving a manual expense correction preserves a refreshed category and history, then returns focus', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const cash = before.accounts.find(account => account.name === 'Browser test cash')!;
  const description = `Browser correction expense ${crypto.randomUUID()}`;
  try {
    await page.goto('/#expenses');
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
    const form = page.getByRole('dialog');
    await form.getByRole('textbox', { name: 'Description', exact: true }).fill(description);
    await form.getByRole('textbox', { name: 'Amount · CAD', exact: true }).fill('12.34');
    await form.getByRole('combobox', { name: 'Category · optional', exact: true }).fill('Food');
    await form.getByRole('button', { name: 'Add expense', exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.reload();
    await page.getByText('Explore daily spending', { exact: true }).click();
    const expenseTrigger = page.getByRole('button', { name: `Open ${description}, $12.34`, exact: true });
    await expenseTrigger.click();
    await form.getByRole('button', { name: 'Close record', exact: true }).click();
    await expect(expenseTrigger).toBeFocused();
    await expect(page.locator('.expense-spending-details')).toHaveAttribute('open', '');
    await expenseTrigger.click();
    await form.getByRole('combobox', { name: 'Action', exact: true }).selectOption('correct');
    await form.getByRole('textbox', { name: 'Amount · CAD', exact: true }).fill('10.00');
    await form.getByRole('textbox', { name: 'Reason', exact: true }).fill('Correct amount from receipt');
    const current = await (await request.get('/api/state?workspace=live')).json() as AppState;
    const expense = current.transactions.find(transaction => transaction.description === description)!;
    const recategorized = await request.post('/api/command?workspace=live', { data: {
      type: 'categorize_transaction', id: expense.id, expectedCategory: 'Food', category: 'Transport',
      expectedRevision: current.revision, requestId: crypto.randomUUID(),
    } });
    expect(recategorized.ok()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(form.getByRole('button', { name: 'Save correction', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: 'Use updated records', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'Category', exact: true })).toHaveValue('Transport');
    await expect(form.getByRole('textbox', { name: 'Amount · CAD', exact: true })).toHaveValue('10.00');
    await form.getByRole('button', { name: 'Save correction', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Open ${description}, $10`, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Expenses', level: 1, exact: true })).toBeFocused();
    const after = await (await request.get('/api/state?workspace=live')).json() as AppState;
    expect(after.accounts.find(account => account.id === cash.id)!.balanceCents).toBe(cash.balanceCents - 1000);
    const original = after.transactions.find(transaction => transaction.description === description && transaction.amountCents === 1234)!;
    expect(after.transactions.find(transaction => transaction.reversalOf === original.id)!.amountCents).toBe(-1234);
    expect(after.transactions.find(transaction => transaction.replacesId === original.id)).toMatchObject({ amountCents: 1000, category: 'Transport' });
  } finally {
    const current = await (await request.get('/api/state?workspace=live')).json() as AppState;
    const active = current.transactions.find(transaction => transaction.description === description
      && !transaction.reversalOf && !current.transactions.some(other => other.reversalOf === transaction.id));
    if (active) {
      const undone = await request.post('/api/command?workspace=live', { data: {
        type: 'correct_transaction', id: active.id, reason: 'Remove isolated correction fixture',
        expectedRevision: current.revision, requestId: crypto.randomUUID(),
      } });
      expect(undone.ok()).toBe(true);
      expect((await undone.json() as AppState).accounts.find(account => account.id === cash.id)!.balanceCents).toBe(cash.balanceCents);
    }
  }
});

test('Overview keeps records behind review and opens the selected month and category without changing saved records', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const writes = await showExpenseFixture(page, expenseFixture(before));
  await page.goto('/#expenses');
  const views = page.getByRole('navigation', { name: 'Expense views' });
  const dashboard = page.locator('.expense-dashboard');
  await expect(views.getByRole('button')).toHaveText(['Overview', 'Bills', 'Budget', 'Transactions']);
  await expect(views.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Set Food & groceries monthly amount', exact: true })).toBeHidden();
  await expect(dashboard.getByLabel('Spending month', { exact: true })).toHaveValue(today().slice(0, 7));
  await expect(dashboard.locator('.expense-dashboard-total strong')).toHaveText('$150');
  await expect(dashboard.locator('.expense-daily-plot')).toBeHidden();
  await expect(dashboard.locator('.expense-dashboard-recent')).toBeHidden();
  await expect(page.getByRole('region', { name: 'Transactions', exact: true })).toHaveCount(0);
  await dashboard.getByText('Explore daily spending', { exact: true }).click();
  await expect(dashboard.locator('.expense-daily-plot')).toBeVisible();
  await expect(dashboard.locator('.expense-recent-list li')).toHaveCount(3);
  await expect(dashboard.locator('[data-transaction-id="Workspace grocery refund"]')).toContainText('Refund');
  const food = dashboard.locator('.expense-category-list').getByRole('button', { name: /Food & groceries/ });
  await food.click();
  await expect(dashboard.locator('.expense-selected-total')).toHaveText('$100');
  await expect(dashboard.locator('.expense-dashboard-total strong')).toHaveText('$150');
  const story = dashboard.locator('.expense-category-story');
  await expect(story).toContainText('Charges');
  await expect(story).toContainText('$123.45');
  await expect(story).toContainText('Refunds');
  await expect(story).toContainText('-$23.45');
  await expect(story).toContainText('Workspace groceries');
  await dashboard.getByRole('button', { name: 'All spending', exact: true }).click();
  await expect(food).toHaveAttribute('aria-pressed', 'false');
  await expect(story).toHaveCount(0);
  await expect(dashboard.locator('.expense-selected-total')).toHaveCount(0);
  const foodSegment = dashboard.getByRole('button', { name: 'Show Food & groceries spending, $100', exact: true });
  await foodSegment.click();
  await expect(foodSegment).toHaveAttribute('aria-pressed', 'true');
  await expect(food).toHaveAttribute('aria-pressed', 'true');
  await expect(story).toBeVisible();
  await expect(dashboard.locator('.expense-selected-total')).toHaveText('$100');
  await expect(page).toHaveURL(/#expenses$/);
  await foodSegment.click();
  await expect(story).toHaveCount(0);
  await page.screenshot({ path: 'outputs/expense-workspace-fixture.png', fullPage: true });
  await page.getByRole('button', { name: 'Previous spending month', exact: true }).click();
  const previous = shiftCalendarMonth(today().slice(0, 7), -1);
  await expect(dashboard.getByLabel('Spending month', { exact: true })).toHaveValue(previous);
  await dashboard.locator('.expense-category-list').getByRole('button', { name: /Food & groceries/ }).click();
  await expect(page).toHaveURL(/#expenses$/);
  await expect(dashboard.locator('.expense-category-list').getByRole('button', { name: /Food & groceries/ })).toHaveAttribute('aria-pressed', 'true');
  await dashboard.getByRole('button', { name: 'Review Food & groceries transactions', exact: true }).click();
  await expect(page).toHaveURL(/#expenses\/activity$/);
  await expect(page.getByLabel('Transaction month', { exact: true })).toHaveValue(previous);
  await expect(page.getByLabel('Expense category', { exact: true })).toHaveValue('food');
  const filterToggle = page.locator('.ledger-filter-details > summary');
  await expect(page.getByLabel('Search transactions', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Transaction account', { exact: true })).toBeHidden();
  await expect(filterToggle).toContainText('3');
  await filterToggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Transaction account', { exact: true })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Transaction account', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Export 1 filtered transactions to CSV', exact: true })).toBeHidden();
  await expect(page.locator('.expense-entry')).toHaveCount(1);
  await expect(page.locator('.expense-entry')).toContainText('Workspace groceries previous month');
  await page.locator('.ledger-totals-details > summary').click();
  await expect(page.locator('.ledger-totals dd')).toHaveText('$40');
  await expect(page.getByRole('button', { name: 'Export 1 filtered transactions to CSV', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#expenses$/);
  await expect(views.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dashboard.getByLabel('Spending month', { exact: true })).toHaveValue(previous);
  await dashboard.getByRole('button', { name: /^Review transactions/ }).click();
  await expect(page).toHaveURL(/#expenses\/activity$/);
  await expect(page.getByLabel('Expense category', { exact: true })).toHaveValue('all');
  await expect(page.getByLabel('Transaction month', { exact: true })).toHaveValue(previous);
  await page.getByRole('button', { name: 'Remove type filter: Expense', exact: true }).click();
  await expect(page.getByLabel('Transaction type', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Transaction type', { exact: true })).toHaveValue('all');
  await expect(page.getByLabel('Transaction month', { exact: true })).toHaveValue(previous);
  expect(writes()).toBe(0);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});

test('a planned-item link keeps the chosen category and month through transaction review and Back', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const state = expenseFixture(before);
  const ownerId = state.accounts.find(account => account.name === 'Browser test cash')!.entityId;
  state.expensePlanItems = [{ id: 'workspace-groceries-plan', entityId: ownerId, categoryId: `${ownerId}:food`, name: 'Weekly groceries', amountCents: 5000, date: today(), notes: '' }];
  const writes = await showExpenseFixture(page, state);
  await page.goto('/#expenses/plan?record=workspace-groceries-plan');
  const food = page.getByRole('region', { name: 'Food & groceries details', exact: true });
  await expect(food).toBeVisible();
  const previous = shiftCalendarMonth(today().slice(0, 7), -1);
  await page.getByRole('button', { name: 'Previous spending month', exact: true }).click();
  await food.getByRole('button', { name: 'View transactions', exact: true }).click();
  await expect(page).toHaveURL(/#expenses\/activity\?record=workspace-groceries-plan$/);
  await expect(page.getByLabel('Expense category', { exact: true })).toHaveValue('food');
  await expect(page.getByLabel('Transaction month', { exact: true })).toHaveValue(previous);
  await expect(page.locator('.expense-entry')).toHaveCount(1);
  await expect(page.locator('.expense-entry')).toContainText('Workspace groceries previous month');
  await page.goBack();
  await expect(page).toHaveURL(/#expenses\/plan\?record=workspace-groceries-plan$/);
  await expect(food).toBeVisible();
  await page.getByRole('button', { name: 'Next spending month', exact: true }).click();
  await page.locator('.expense-plan-category-select').filter({ hasText: 'Transport' }).click();
  await page.getByRole('region', { name: 'Transport details', exact: true }).getByRole('button', { name: 'View transactions', exact: true }).click();
  await expect(page.getByLabel('Expense category', { exact: true })).toHaveValue('transport');
  await expect(page.locator('.expense-entry')).toHaveCount(1);
  await expect(page.locator('.expense-entry')).toContainText('Workspace transit');
  await page.getByRole('navigation', { name: 'Expense views' }).getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL(/#expenses$/);
  await expect(page.locator('.expense-dashboard')).toBeVisible();
  expect(writes()).toBe(0);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});

test('composition reveals a category outside the first six and keeps its details in view without horizontal overflow', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const state = expenseFixture(before);
  const expense = state.transactions.find(transaction => transaction.id === 'Workspace groceries')!;
  state.transactions = ['Food', 'Transport', 'Housing', 'Bills', 'Personal', 'Subscriptions', 'Digital', 'Career'].map((category, index) => ({
    ...expense, id: `Workspace ${category}`, description: `Workspace ${category}`, category, amountCents: (8 - index) * 1000,
  }));
  const writes = await showExpenseFixture(page, state);
  await page.goto('/#expenses');
  for (const width of [1440, 1024]) {
    await test.step(`${width}px desktop viewport`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      const dashboard = page.locator('.expense-dashboard');
      const tile = dashboard.locator('.expense-category-list').getByRole('button', { name: /Career & learning/ });
      await expect(dashboard.locator('.expense-category-row')).toHaveCount(6);
      await expect(tile).toHaveCount(0);
      await expect(dashboard.getByRole('button', { name: 'Show 2 more categories', exact: true })).toHaveAttribute('aria-expanded', 'false');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const segment = dashboard.getByRole('button', { name: 'Show Career & learning spending, $10', exact: true });
      await segment.click();
      await expect(dashboard.locator('.expense-category-row')).toHaveCount(8);
      await expect(tile).toBeVisible();
      await expect(tile).toHaveAttribute('aria-pressed', 'true');
      await expect(segment).toHaveAttribute('aria-pressed', 'true');
      await expect(dashboard.getByRole('button', { name: 'Show fewer categories', exact: true })).toHaveAttribute('aria-expanded', 'true');
      const story = dashboard.getByRole('region', { name: 'Career & learning spending details', exact: true });
      await expect(story).toBeInViewport({ ratio: 0.999 });
      await expect(story.locator('.expense-selected-total')).toHaveText('$10');
      await expect(story).toContainText('Workspace Career');
      await expect(page).toHaveURL(/#expenses$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
  expect(writes()).toBe(0);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});

test('bill disclosures show known charges with keyboard controls and leave saved records unchanged', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const state = expenseFixture(before);
  const expense = state.transactions.find(transaction => transaction.id === 'Workspace groceries')!;
  state.transactions.push(
    { ...expense, id: 'Workspace GoodLife', description: 'GOODLIFE FITNESS', category: 'Personal', amountCents: 3841 },
    { ...expense, id: 'Workspace ChatGPT', description: 'CHATGPT SUBSCRIPTION', category: 'Subscriptions', amountCents: 3163 },
  );
  const writes = await showExpenseFixture(page, state);
  await page.goto('/#expenses');
  const quickView = page.locator('.expense-regular-details');
  await expect(quickView).not.toHaveAttribute('open', '');
  await quickView.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(quickView).toHaveAttribute('open', '');
  const gym = page.locator('.expense-bill-card').filter({ has: page.getByRole('heading', { name: 'GoodLife', exact: true }) });
  const chatgpt = page.locator('.expense-bill-card').filter({ has: page.getByRole('heading', { name: 'ChatGPT', exact: true }) });
  const toggle = gym.getByRole('button', { name: /(?:Show|Hide) GoodLife details/ });
  const sibling = chatgpt.getByRole('button', { name: 'Show ChatGPT details', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(gym.getByRole('button', { name: 'Set up bill', exact: true })).toBeHidden();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(gym.getByRole('button', { name: 'Set up bill', exact: true })).toBeVisible();
  await expect(gym).toContainText('$38.41');
  await expect(sibling).toHaveAttribute('aria-expanded', 'false');
  await expect(chatgpt.getByRole('button', { name: 'Set up bill', exact: true })).toBeHidden();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(gym.getByRole('button', { name: 'Set up bill', exact: true })).toBeHidden();
  await expect(toggle).toBeFocused();
  expect(writes()).toBe(0);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});

test('recorded gym and ChatGPT charges require a chosen schedule and never post a second expense during setup', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const cash = before.accounts.find(account => account.name === 'Browser test cash')!;
  const merchants = [
    { name: 'GoodLife', description: `GOODLIFE Browser recurring fixture ${crypto.randomUUID()}`, amountCents: 3841, recurrence: 'biweekly', category: 'Personal' },
    { name: 'ChatGPT', description: `CHATGPT Browser recurring fixture ${crypto.randomUUID()}`, amountCents: 3163, recurrence: 'monthly', category: 'Subscriptions' },
  ];
  const addedObligationIds: string[] = [];
  const command = async (data: Record<string, unknown>) => {
    const current = await (await request.get('/api/state?workspace=live')).json() as AppState;
    const result = await request.post('/api/command?workspace=live', { data: { ...data, expectedRevision: current.revision, requestId: crypto.randomUUID() } });
    expect(result.ok()).toBe(true);
    return await result.json() as AppState;
  };
  try {
    for (const merchant of merchants) await command({ type: 'add_transaction', kind: 'expense', accountId: cash.id, amountCents: merchant.amountCents, date: today(), description: merchant.description, category: merchant.category });
    const recorded = await (await request.get('/api/state?workspace=live')).json() as AppState;
    let writes = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/command') writes++; });
    await page.goto('/#expenses');
    await page.locator('.expense-regular-details > summary').click();
    for (const merchant of merchants) {
      const card = page.locator('.expense-bill-card').filter({ has: page.getByRole('heading', { name: merchant.name, exact: true }) });
      await expect(card).toContainText('Schedule needed');
      await card.getByRole('button', { name: `Show ${merchant.name} details`, exact: true }).click();
      await card.getByRole('button', { name: 'Set up bill', exact: true }).click();
      const form = page.getByRole('dialog');
      await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(merchant.name);
      await expect(form.getByRole('textbox', { name: 'Amount per payment · CAD', exact: true })).toHaveValue((merchant.amountCents / 100).toFixed(2));
      const date = form.getByLabel('Next payment date', { exact: true });
      const recurrence = form.getByRole('combobox', { name: 'Repeats', exact: true });
      await expect(date).toHaveValue('');
      await expect(recurrence).toHaveValue('');
      await expect(recurrence.locator('option[value="once"]')).toHaveCount(0);
      const priorWrites = writes;
      await form.getByRole('button', { name: 'Add to schedule', exact: true }).click();
      await expect(date).toBeFocused();
      expect(writes).toBe(priorWrites);
      await date.fill(today());
      await form.getByRole('button', { name: 'Add to schedule', exact: true }).click();
      await expect(form.getByRole('alert')).toContainText('Choose how often this bill repeats.');
      expect(writes).toBe(priorWrites);
      await recurrence.selectOption(merchant.recurrence);
      await form.getByRole('combobox', { name: 'Pay from · optional', exact: true }).selectOption(cash.id);
      await form.getByRole('button', { name: 'Add to schedule', exact: true }).click();
      await expect(form).toHaveCount(0);
      expect(writes).toBe(priorWrites + 1);
      await expect(card).not.toContainText('Schedule needed');
      const saved = await (await request.get('/api/state?workspace=live')).json() as AppState;
      const obligation = saved.obligations.find(item => item.name === merchant.name && !before.obligations.some(existing => existing.id === item.id))!;
      expect(obligation).toMatchObject({ amountCents: merchant.amountCents, dueDate: today(), recurrence: merchant.recurrence, status: 'planned', accountId: cash.id, subscription: true });
      addedObligationIds.push(obligation.id);
      expect(saved.transactions).toEqual(recorded.transactions);
      expect(saved.accounts.find(account => account.id === cash.id)!.balanceCents).toBe(recorded.accounts.find(account => account.id === cash.id)!.balanceCents);
    }
  } finally {
    for (const id of addedObligationIds) await command({ type: 'set_obligation_status', id, status: 'cancelled' });
    for (const merchant of merchants) {
      const current = await (await request.get('/api/state?workspace=live')).json() as AppState;
      const transaction = current.transactions.find(entry => entry.description === merchant.description && !entry.reversalOf && !current.transactions.some(other => other.reversalOf === entry.id));
      if (transaction) await command({ type: 'correct_transaction', id: transaction.id, reason: 'Remove isolated recurring bill fixture' });
    }
  }
});

test('adding a recurring bill offers only repeat schedules and keeps the saved bill on the overview', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const name = `Browser recurring bill ${crypto.randomUUID()}`;
  let obligationId = '';
  try {
    await page.goto('/#expenses');
    await page.locator('.expense-regular-details > summary').click();
    await page.getByRole('button', { name: /^Add a recurring bill/ }).click();
    const form = page.getByRole('dialog');
    const recurrence = form.getByRole('combobox', { name: 'Repeats', exact: true });
    await expect(recurrence).toHaveValue('monthly');
    await expect(recurrence.locator('option')).toHaveText(['Every month', 'Every two weeks']);
    await expect(form.getByLabel('Next payment date', { exact: true })).toHaveValue('');
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await form.getByRole('textbox', { name: 'Amount per payment · CAD', exact: true }).fill('45.00');
    await form.getByRole('button', { name: 'Add to schedule', exact: true }).click();
    await expect(form.getByLabel('Next payment date', { exact: true })).toBeFocused();
    await form.getByLabel('Next payment date', { exact: true }).fill(today());
    await form.getByRole('button', { name: 'Add to schedule', exact: true }).click();
    await expect(form).toHaveCount(0);
    const card = page.locator('.expense-bill-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card).toContainText('Monthly');
    await expect(card).toContainText('$45');
    const saved = await (await request.get('/api/state?workspace=live')).json() as AppState;
    const obligation = saved.obligations.find(item => item.name === name)!;
    expect(obligation).toMatchObject({ recurrence: 'monthly', dueDate: today(), amountCents: 4500, status: 'planned' });
    obligationId = obligation.id;
    expect(saved.transactions).toEqual(before.transactions);
    expect(saved.accounts).toEqual(before.accounts);
    await page.reload();
    await page.locator('.expense-regular-details > summary').click();
    await expect(card).toBeVisible();
  } finally {
    if (obligationId) {
      const current = await (await request.get('/api/state?workspace=live')).json() as AppState;
      const result = await request.post('/api/command?workspace=live', { data: { type: 'set_obligation_status', id: obligationId, status: 'cancelled', expectedRevision: current.revision, requestId: crypto.randomUUID() } });
      expect(result.ok()).toBe(true);
    }
  }
});

test('Budget and Bills remain reachable through direct links, refresh, and browser history without writing records', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const writes = await showExpenseFixture(page, expenseFixture(before));
  await page.goto('/#expenses/plan');
  const views = page.getByRole('navigation', { name: 'Expense views' });
  const budget = views.getByRole('button', { name: 'Budget', exact: true });
  const bills = views.getByRole('button', { name: 'Bills', exact: true });
  await expect(budget).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Set Food & groceries monthly amount', exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#expenses\/plan$/);
  await expect(budget).toHaveAttribute('aria-pressed', 'true');
  await bills.click();
  await expect(page).toHaveURL(/#expenses\/schedule$/);
  await expect(bills).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Upcoming schedule', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Upcoming schedule', exact: true }).getByRole('link', { name: 'Review Browser test lower-rate loan on Debts', exact: true }).first()).toBeVisible();
  await page.locator('.schedule-management-details > summary').click();
  const management = page.getByRole('navigation', { name: 'Schedule management' });
  await expect(management).toBeVisible();
  await expect(management.getByRole('button', { name: /^Bills & income/ })).toHaveAttribute('aria-pressed', 'true');
  await management.getByRole('button', { name: /^Subscriptions/ }).click();
  await expect(management.getByRole('button', { name: /^Subscriptions/ })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.schedule-income-details > summary').click();
  await expect(page.getByRole('region', { name: 'Pay schedule', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#expenses\/plan$/);
  await expect(budget).toHaveAttribute('aria-pressed', 'true');
  await page.goForward();
  await expect(page).toHaveURL(/#expenses\/schedule$/);
  await expect(bills).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(bills).toHaveAttribute('aria-pressed', 'true');
  expect(writes()).toBe(0);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});
