import { expect, test } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';

test.use({ reducedMotion: 'reduce' });
test.beforeEach(async ({ page }) => {
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch();
    expect(response.headers()['x-mazal-data-source']).toBe('sample');
    const state = await response.json() as AppState;
    const entityId = state.entities.find(entity => entity.kind === 'personal')!.id;
    await route.fulfill({ response, json: {
      ...state,
      accounts: [...state.accounts, { id:'browser-focus-sol-account', entityId, name:'Browser SOL holding', type:'investment', currency:'CAD', balanceCents:100000, reconciledAt:'2026-01-01' }, { id:'browser-second-sol-account', entityId, name:'Second browser SOL holding', type:'investment', currency:'CAD', balanceCents:20000, reconciledAt:'2026-01-01' }],
      positions: [...state.positions, { id:'browser-focus-sol', accountId:'browser-focus-sol-account', liquidSol:'5', stakedSol:'5', rewardsSol:'0', costBasisCents:100000, priceCents:10000, priceDate:'2026-01-01', priceSource:'Synthetic browser fixture' }, { id:'browser-second-sol', accountId:'browser-second-sol-account', liquidSol:'2', stakedSol:'0', rewardsSol:'0', costBasisCents:20000, priceCents:10000, priceDate:'2026-01-01', priceSource:'Synthetic browser fixture' }],
      wishItems: [...(state.wishItems ?? []), { id:'browser-focus-wish', entityId, name:'Browser wish', costCents:5000, comment:'Synthetic browser fixture', priority:'essential' }],
    } });
  });
});

test('account management loads its dialog layout on a fresh Investments visit', async ({ page }) => {
  await page.goto('/#investments/accounts');
  await page.locator('.investment-accounts').getByRole('button', { name:'Manage account', exact:true }).first().click();
  const dialog = page.locator('dialog.record-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('padding', '0px');
  await expect(dialog.locator('.bill-fields')).toHaveCSS('padding', '24px 25px');
  await dialog.getByRole('button', { name:'Cancel', exact:true }).click();
  await expect(dialog).toBeHidden();
});

test('SOL activity keeps keyboard focus through open, clean cancel and draft discard', async ({ page }) => {
  await page.goto('/#investments');
  const card = page.locator('.portfolio-sol-card').filter({ has: page.getByRole('heading', { name:'Browser SOL holding', exact:true }) });
  const trigger = card.getByRole('button', { name:'Record activity', exact:true });
  await trigger.click();
  const activity = card.getByRole('combobox', { name:'Activity', exact:true });
  await expect(activity).toBeFocused();
  await card.getByRole('button', { name:'Cancel', exact:true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(activity).toBeFocused();
  const quantity = card.getByLabel('SOL quantity', { exact:true });
  await quantity.fill('2');
  const cancel = card.getByRole('button', { name:'Cancel', exact:true });
  await cancel.focus();
  await page.keyboard.press('Enter');
  const discard = page.getByRole('dialog', { name:'Discard unsaved changes?', exact:true });
  await discard.getByRole('button', { name:'Keep editing', exact:true }).click();
  await expect(cancel).toBeFocused();
  await expect(quantity).toHaveValue('2');
  await card.getByRole('button', { name:'Cancel', exact:true }).click();
  await discard.getByRole('button', { name:'Discard changes', exact:true }).click();
  await expect(trigger).toBeFocused();
  await expect(card.locator('.investment-history-form')).toHaveCount(0);
});

test('switching SOL accounts keeps edits until discard without writing records', async ({ page, request }) => {
  const before = await request.get('/api/state?workspace=live');
  expect(before.headers()['x-mazal-data-source']).toBe('sample');
  const saved = await before.json();
  const mutations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/engine/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(path);
  });
  await page.goto('/#investments');
  const card = page.locator('.portfolio-sol-card').filter({ has: page.getByRole('heading', { name:'Browser SOL holding', exact:true }) });
  const trigger = card.getByRole('button', { name:'Update SOL', exact:true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name:'Update SOL holdings', exact:true });
  const account = dialog.getByRole('combobox', { name:'Investment account', exact:true });
  const amount = dialog.getByRole('textbox', { name:'Unstaked SOL', exact:true });
  await expect(amount).toHaveValue('5');
  await amount.fill('3.5');
  await account.focus();
  await account.selectOption('browser-second-sol-account');
  await expect(dialog.getByRole('alert')).toContainText('Discard unsaved changes?');
  await expect(account).toHaveValue('browser-focus-sol-account');
  await dialog.getByRole('button', { name:'Keep editing', exact:true }).click();
  await expect(account).toBeFocused();
  await expect(amount).toHaveValue('3.5');
  await account.selectOption('browser-second-sol-account');
  await dialog.getByRole('button', { name:'Discard changes', exact:true }).click();
  await expect(dialog).toBeVisible();
  await expect(account).toHaveValue('browser-second-sol-account');
  await expect(amount).toHaveValue('2');
  await account.selectOption('browser-focus-sol-account');
  await expect(amount).toHaveValue('5');
  await expect(dialog.getByRole('button', { name:'Keep editing', exact:true })).toHaveCount(0);
  await dialog.getByRole('button', { name:'Cancel', exact:true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(mutations).toEqual([]);
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(saved);
});

test('a narrow wish editor restores its field and removal trigger when keeping changes', async ({ page }) => {
  await page.setViewportSize({ width:320, height:900 });
  await page.goto('/#assets');
  const priorities = page.locator('.asset-planning-disclosures > details').filter({ has: page.locator('summary > span > strong', { hasText: 'Purchase priorities' }) });
  await expect(priorities).not.toHaveAttribute('open', '');
  await priorities.locator('summary').click();
  await page.getByRole('button', { name:'Add wish', exact:true }).click();
  const dialog = page.getByRole('dialog', { name:'Add to wish basket', exact:true });
  await dialog.getByLabel('Item name', { exact:true }).fill('Unsaved browser wish');
  const amount = dialog.getByLabel('Cost · optional · CAD', { exact:true });
  await amount.fill('25');
  await dialog.getByRole('button', { name:'Cancel', exact:true }).click();
  await dialog.getByRole('button', { name:'Keep editing', exact:true }).click();
  await expect(amount).toBeFocused();
  await expect(amount).toHaveValue('25');
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name:'Keep editing', exact:true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(amount).toBeFocused();
  await expect(dialog.getByLabel('Item name', { exact:true })).toHaveValue('Unsaved browser wish');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole('button', { name:'Cancel', exact:true }).click();
  await dialog.getByRole('button', { name:'Discard changes', exact:true }).click();
  await page.getByRole('button', { name:'Edit wish Browser wish', exact:true }).click();
  const edit = page.getByRole('dialog', { name:'Edit wish', exact:true });
  const remove = edit.getByRole('button', { name:'Remove wish', exact:true });
  await remove.click();
  await edit.getByRole('button', { name:'Keep editing', exact:true }).click();
  await expect(remove).toBeFocused();
  await remove.click();
  await page.keyboard.press('Escape');
  await expect(remove).toBeFocused();
  await edit.getByRole('button', { name:'Cancel', exact:true }).click();
  await expect(edit).toBeHidden();
});
