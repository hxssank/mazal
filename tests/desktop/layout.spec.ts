import { expect, test, type Page } from '@playwright/test';

const pages = [
  { name: 'Home', route: 'home' },
  { name: 'Expenses', route: 'expenses' },
  { name: 'Work & pay', route: 'pay' },
  { name: 'Debts', route: 'debts' },
  { name: 'Investments', route: 'investments' },
  { name: 'Assets', route: 'assets' },
  { name: 'Planner', route: 'simulations' },
  { name: 'Statements', route: 'documents' },
];

async function sectionButton(page: Page, section: typeof pages[number]) {
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  return navigation.getByRole('button', { name: section.name, exact: true });
}

async function expectNavigationFit(page: Page, rows: number) {
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect.poll(() => navigation.evaluate(element => {
    const buttons = [...element.querySelectorAll('button')];
    const boxes = buttons.map(button => button.getBoundingClientRect());
    const selected = element.querySelector('[aria-current="page"]')?.getBoundingClientRect();
    const indicator = element.querySelector('.nav-glass-indicator')?.getBoundingClientRect();
    return {
      destinations: buttons.length,
      rows: new Set(boxes.map(box => Math.round(box.top))).size,
      allVisible: boxes.every(box => box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight),
      labelsFit: buttons.every((button, index) => {
        const label = button.querySelector('span')!.getBoundingClientRect();
        return label.left >= boxes[index].left && label.right <= boxes[index].right;
      }),
      noHorizontalScroll: element.scrollWidth <= element.clientWidth + 1 && element.scrollLeft === 0,
      indicatorFits: !!selected && !!indicator && ['left', 'top', 'width', 'height'].every(key => Math.abs(selected[key as keyof DOMRect] as number - (indicator[key as keyof DOMRect] as number)) <= 1),
    };
  })).toEqual({ destinations: 8, rows, allVisible: true, labelsFit: true, noHorizontalScroll: true, indicatorFits: true });
}

test('main pages remain reachable by keyboard without desktop overflow', async ({ page, request }) => {
  const width = 1440;
  const response = await request.get('/api/state');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  for (const section of pages) {
    await (await sectionButton(page, section)).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#${section.route}$`));
    const heading = section.name === 'Home' ? page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/, level: 2 }) : page.getByRole('heading', { name: section.name, level: 1, exact: true });
    await expect(heading).toBeVisible();
    if (section.name !== 'Home') await expect(heading).toBeFocused();
    await expectNavigationFit(page, 1);
    await expect.poll(() => page.evaluate(() => ({
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
    }))).toEqual({ body: width, document: width });
  }
  expect(errors).toEqual([]);
});

test('desktop navigation stays above content with full-width workspace', async ({ page }) => {
  const width = 1440;
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/, level: 2 })).toBeVisible();
  const toolbar = await page.locator('.glass-toolbar').boundingBox();
  const main = await page.getByRole('main').boundingBox();
  const navigation = await page.getByRole('navigation', { name: 'Main navigation' }).boundingBox();
  expect(toolbar).not.toBeNull();
  expect(main).not.toBeNull();
  expect(navigation).not.toBeNull();
  expect(toolbar!.x).toBeGreaterThanOrEqual(0);
  expect(toolbar!.width).toBeGreaterThan(width - 100);
  expect(toolbar!.height).toBeLessThan(150);
  expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(main!.y + 1);
  expect(navigation!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height);
  expect(navigation!.y + navigation!.height).toBeLessThanOrEqual(main!.y);
  expect(main!.x).toBe(0);
  const navButtons = await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button').all();
  const buttonRows = await Promise.all(navButtons.map(button => button.boundingBox()));
  expect(new Set(buttonRows.map(bounds => bounds!.y)).size).toBe(1);
});

for (const width of [320, 390, 768]) {
  test(`main pages fit a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    for (const section of pages) {
      await (await sectionButton(page, section)).click();
      await expect(section.name === 'Home' ? page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/, level: 2 }) : page.getByRole('heading', { name: section.name, level: 1, exact: true })).toBeVisible();
      await expect(page.locator('.page-body .loading-panel')).toHaveCount(0);
      await expectNavigationFit(page, 2);
      await expect.poll(() => page.evaluate(() => ({ body: document.body.scrollWidth, document: document.documentElement.scrollWidth }))).toEqual({ body: width, document: width });
    }
  });
}

for (const width of [320, 390, 768]) {
  test(`toolbar menus stay within a ${width}px viewport and Escape restores focus`, async ({ page, browserName }) => {
    const height = 900;
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/, level: 2 })).toBeVisible();
    for (const kind of ['add', 'more']) {
      const trigger = kind === 'add' ? page.locator('.toolbar-add .quick-add > summary') : page.locator('.navigation-more-toggle');
      const menu = kind === 'add' ? page.locator('.toolbar-add .quick-add-panel') : page.locator('.navigation-more-panel');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      const bounds = await menu.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
      await page.keyboard.press(browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
      await expect(menu.getByRole('button').first()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      if (kind === 'more') await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      else await expect(page.locator('.toolbar-add .quick-add')).not.toHaveAttribute('open', '');
      await expect(trigger).toBeFocused();
    }
  });
}
