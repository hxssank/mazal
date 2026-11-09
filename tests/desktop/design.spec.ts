import { expect, test } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';

for (const width of [320, 1440]) {
  test(`Planner pay setup has its layout on a fresh ${width}px visit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#simulations/setup');
    const card = page.getByRole('region', { name: 'Pay schedule', exact: true });
    await expect(card.locator('header')).toHaveCSS('display', 'flex');
    await expect(card.locator('.expense-pay-value')).toHaveCSS('display', 'grid');
    await expect(card.getByRole('button', { name: 'Set up', exact: true })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect(await card.locator('.expense-pay-value > span').evaluate(element => getComputedStyle(element).color === getComputedStyle(document.querySelector('.planner-setup-card p')!).color)).toBe(true);
    await card.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(card.getByLabel('Take-home pay per paycheck', { exact: true })).toBeFocused();
    await expect(card.locator('form')).toHaveCSS('display', 'grid');
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    for (const input of await card.locator('input').all()) {
      const bounds = (await input.boundingBox())!;
      const parent = (await card.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(parent.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(parent.x + parent.width);
    }
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Set up', exact: true })).toBeFocused();
  });
}

test('summary panels and dialogs retain readable text and keyboard focus', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/, level: 2 })).toBeVisible();
  for (const selector of ['.home-bank-total', '.home-outlook-value', '.position-value']) {
    const amount = page.locator(selector);
    await expect(amount).toBeVisible();
    const contrast = await amount.evaluate(element => {
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
          const channel = Number(value) / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const text = luminance(getComputedStyle(element).color);
      const background = luminance(getComputedStyle(element.closest('section')!).backgroundColor);
      return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  }
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const reducedTransparency = await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches);
  if (reducedTransparency) {
    await expect(dialog).toHaveCSS('backdrop-filter', 'none');
    await expect(dialog).toHaveCSS('background-color', 'rgb(20, 33, 61)');
    await expect(dialog).toHaveCSS('background-image', 'none');
  } else {
    await expect(dialog).toHaveCSS('backdrop-filter', /blur\(.+\) saturate\(.+\)/);
  }
  await expect(dialog).toHaveCSS('color', 'rgb(237, 242, 250)');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add transaction', exact: true })).toBeFocused();
});

test('motion pause persists through navigation and reload, and system settings stop animation', async ({ page }) => {
  await page.goto('/');
  const shell = page.locator('.app-shell');
  await expect(shell).toHaveAttribute('data-motion', 'on');
  await page.locator('.navigation-more-toggle').click();
  await page.getByRole('button', { name: 'Pause animations' }).click();
  await expect(shell).toHaveAttribute('data-motion', 'off');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Debts', exact: true }).click();
  await expect(page.locator('.glass-click-wave')).toHaveCount(0);
  await expect(page.locator('.nav-glass-indicator')).toHaveCSS('transition-duration', '0s');
  await page.reload();
  await expect(shell).toHaveAttribute('data-motion', 'off');
  await page.locator('.navigation-more-toggle').click();
  await page.getByRole('button', { name: 'Resume animations' }).click();
  await expect(shell).toHaveAttribute('data-motion', 'on');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(shell).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('.glass-click-wave')).toHaveCount(0);
  await expect(page.locator('.nav-glass-indicator')).toHaveCSS('transition-duration', '0s');
});

test('a narrow bill form keeps keyboard focus and its draft when cancelling a discard', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto('/');
  await page.getByLabel('More add options', { exact: true }).click();
  await page.getByRole('button', { name: 'Bill or expected income', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add bill or income', exact: true });
  const name = dialog.getByLabel('Name', { exact: true });
  await expect(name).toBeFocused();
  await name.fill('Review draft');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Review draft');
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Review draft');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(dialog).toBeHidden();
});

for (const width of [320, 390]) {
  test(`transaction choices remain readable in a ${width}px dialog`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (const name of ['Expense', 'Income', 'Transfer', 'Debt payment']) {
      const choice = dialog.getByRole('button', { name, exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      expect(await choice.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const animatedWidths = await choice.evaluate(element => {
        const box = element.getBoundingClientRect();
        const widths: { scroll: number; client: number }[] = [];
        for (const fraction of [.5, .95]) {
          element.dispatchEvent(new MouseEvent('click', {
            bubbles: true, detail: 1, clientX: box.left + box.width * fraction, clientY: box.top + box.height / 2,
          }));
          const animation = element.querySelector('.glass-click-wave')?.getAnimations()[0];
          if (!animation) throw new Error('Expected a click wave while motion is enabled.');
          animation.pause();
          for (const time of [0, 280, 559]) {
            animation.currentTime = time;
            widths.push({ scroll: element.scrollWidth, client: element.clientWidth });
          }
          animation.finish();
        }
        return widths;
      });
      for (const { scroll, client } of animatedWidths) expect(scroll).toBeLessThanOrEqual(client + 1);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}

for (const width of [320, 1440]) {
  test(`account management opens with readable names and fields at ${width}px on a fresh Home visit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const accountName = 'Household savings for travel and annual expenses';
    await page.route('**/api/state?*', async route => {
      const response = await route.fetch();
      expect(response.headers()['x-mazal-data-source']).toBe('sample');
      const state = await response.json() as AppState;
      await route.fulfill({ response, json: { ...state, accounts: state.accounts.map((account, index) => index === 0 ? { ...account, name: accountName } : account) } });
    });
    await page.goto('/');
    const manage = page.locator('.navigation-more-toggle');
    await manage.click();
    await page.getByRole('button', { name: 'Manage accounts', exact: true }).click();
    const directory = page.locator('dialog.account-directory');
    await expect(directory).toBeVisible();
    await expect(directory.getByRole('heading', { name: 'Manage accounts', exact: true })).toHaveCSS('color', 'rgb(237, 242, 250)');
    const name = directory.getByRole('heading', { name: accountName, exact: true });
    expect((await name.boundingBox())!.width).toBeGreaterThan(180);
    expect(await directory.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const edit = directory.getByRole('button', { name: `Manage ${accountName}`, exact: true });
    await edit.click();
    const editor = page.getByRole('dialog', { name: `Manage ${accountName}`, exact: true });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('heading')).toHaveCSS('color', 'rgb(237, 242, 250)');
    await expect(editor.locator('.bill-fields > p').first()).toHaveCSS('color', 'rgb(164, 177, 196)');
    await expect(editor.getByLabel('Account name', { exact: true })).toHaveCSS('color', 'rgb(237, 242, 250)');
    await expect(editor.locator('.bill-field select option').first()).toHaveCSS('background-color', 'rgb(20, 28, 40)');
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(edit).toBeFocused();
    await directory.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(directory).toBeHidden();
    await expect(manage).toBeFocused();
  });
}
