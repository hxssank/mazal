import { expect, test, type Page } from '@playwright/test';
import type { AppState } from '../../shared/types.ts';
import type { PayrollImport, PayrollPaystub } from '../../shared/payroll.ts';

function paystub(id: string, payDate: string, page: number): PayrollPaystub {
  return {
    id, sourceId: 'browser-pay-source', sourcePage: page, payDate, periodStart: payDate, periodEnd: payDate,
    sequence: `BROWSER-${id}`, employer: 'Browser payroll fixture', payFrequency: 'Bi-weekly', payRate: '25.0000',
    grossCents: 200000, netCents: 150000, taxCents: 40000, deductionCents: 10000, hours: 80,
    earnings: [{ label: 'Regular hours', hours: 80, rate: '25.0000', amountCents: 200000, ytdHours: 80, ytdAmountCents: 200000 }],
    taxes: [{ label: 'Income tax', amountCents: 40000, ytdAmountCents: 40000 }],
    deductions: [{ label: 'Pension', amountCents: 10000, ytdAmountCents: 10000 }],
    ytd: { grossCents: 200000, netCents: 150000, taxCents: 40000, deductionCents: 10000, hours: 80 },
    paymentMethod: 'Direct deposit', vacationBalanceCents: null, vacationAccruedCents: 8000,
  };
}

function payrollFixture(): PayrollImport {
  return {
    id: 'browser-payroll-import', importedAt: '2026-02-01T12:00:00Z', schemaVersion: 1, currency: 'CAD',
    archive: { filename: 'Browser-payroll.zip', sha256: 'a'.repeat(64) },
    sources: [
      { id: 'browser-pay-source', filename: 'Browser-pay-statements.pdf', sha256: 'b'.repeat(64), mimeType: 'application/pdf', kind: 'paystub', pageCount: 3 },
      { id: 'browser-hours-source', filename: 'Browser-timecards.png', sha256: 'c'.repeat(64), mimeType: 'image/png', kind: 'timecards', pageCount: 1 },
    ],
    paystubs: [paystub('first', '2026-01-01', 1), paystub('second', '2026-01-15', 2), paystub('third', '2026-01-29', 3)],
    timecards: [
      { id: 'browser-legacy', sourceId: 'browser-hours-source', sourceRow: 1, periodStart: '2026-01-05', periodEnd: '2026-01-11', hours: 40, status: 'Approved', submissionDate: '2026-01-12', transferredTo: null, system: 'legacy' },
      { id: 'browser-projects', sourceId: 'browser-hours-source', sourceRow: 2, periodStart: '2026-01-08', periodEnd: '2026-01-14', hours: 37.5, status: 'Submitted', submissionDate: null, transferredTo: 'Payroll', system: 'projects' },
    ],
    issues: [{ id: 'browser-overlap', severity: 'review', title: 'Review overlapping timecards', detail: 'These synthetic rows cover overlapping dates. Keep each source separate.', sourceIds: ['browser-hours-source'], paystubIds: ['second'], timecardIds: ['browser-legacy', 'browser-projects'] }],
  };
}

async function addSyntheticPayroll(page: Page) {
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch();
    expect(response.headers()['x-mazal-data-source']).toBe('sample');
    const state = await response.json() as AppState;
    await route.fulfill({ response, json: { ...state, payrollImports: [...(state.payrollImports ?? []), payrollFixture()] } });
  });
}

const sections = [
  { name: 'Pay statements', route: 'statements', content: '.work-pay-history' },
  { name: /^Work hours$/, route: 'hours', content: '.work-pay-hours' },
  { name: /^Review & sources/, route: 'review', content: '.work-pay-review' },
] as const;

test.use({ reducedMotion: 'reduce' });
test.beforeEach(async ({ page }) => { await addSyntheticPayroll(page); });

test('the latest work-period end uses all saved timecards and survives navigation', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json();
  const payroll = payrollFixture();
  payroll.timecards[0] = { ...payroll.timecards[0], periodStart: '2026-01-01', periodEnd: '2026-01-31', submissionDate: '2026-02-01' };
  await page.route('**/api/state?*', async route => {
    const response = await route.fetch();
    expect(response.headers()['x-mazal-data-source']).toBe('sample');
    const state = await response.json() as AppState;
    await route.fulfill({ response, json: { ...state, payrollImports: [payroll] } });
  });
  await page.goto('/#pay/statements');
  const latestEnd = page.locator('.pay-review-hours-shortcut time');
  await expect(latestEnd).toHaveAttribute('datetime', '2026-01-31');
  await page.getByRole('button', { name: 'Browse 2 saved timecards', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#pay\/hours$/);
  await expect(page.getByRole('button', { name: 'Browse 2 saved timecards', exact: true })).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Work and pay sections' }).getByRole('button', { name: 'Work hours', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Projects timecards', exact: true })).toContainText('Jan 8 to Jan 14, 2026');
  await expect(page.getByRole('region', { name: 'Legacy timecards', exact: true })).toContainText('Jan 1 to Jan 31, 2026');
  expect(await page.locator('.work-pay-hours [role="region"]').evaluateAll(regions => regions.map(region => region.getAttribute('aria-label')))).toEqual(['Projects timecards', 'Legacy timecards']);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/#pay\/hours$/);
  await expect(page.getByRole('heading', { name: 'Work & pay', exact: true, level: 1 })).toBeFocused();
  await expect(latestEnd).toHaveAttribute('datetime', '2026-01-31');
  await page.reload();
  await expect(latestEnd).toHaveAttribute('datetime', '2026-01-31');
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Work & pay', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await (await request.get('/api/state?workspace=live')).json()).toEqual(before);
});

test('populated payroll sections retain their URLs through refresh, Back and Forward', async ({ page }) => {
  await page.goto('/#pay/statements');
  const navigation = page.getByRole('navigation', { name: 'Work and pay sections' });
  for (const section of sections) {
    const button = navigation.getByRole('button', { name: section.name, exact: true });
    await button.focus();
    await button.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#pay/${section.route}$`));
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toBeFocused();
    await expect(page.locator(section.content)).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`#pay/${section.route}$`));
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(section.content)).toBeVisible();
  }
  for (const section of [...sections].reverse().slice(1)) {
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`#pay/${section.route}$`));
    await expect(navigation.getByRole('button', { name: section.name, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(section.content)).toBeVisible();
  }
  for (const section of sections.slice(1)) {
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`#pay/${section.route}$`));
    await expect(navigation.getByRole('button', { name: section.name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByRole('button', { name: 'Jan 15 pay', exact: true }).click();
  await expect(page).toHaveURL(/#pay\/statements$/);
  await expect(page.locator('.work-pay-detail')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/#pay\/review$/);
  await expect(navigation.getByRole('button', { name: /^Review & sources/ })).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(/#pay\/statements$/);
  await expect(navigation.getByRole('button', { name: 'Pay statements', exact: true })).toBeFocused();
  await page.getByRole('button', { name: /1 review item linked/ }).click();
  await expect(page.locator('.work-pay-review-heading h2')).toBeFocused();
});

test('populated payroll fits 320px and keyboard users can inspect every timecard column', async ({ page }) => {
  const width = 320;
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/#pay/statements');
  const navigation = page.getByRole('navigation', { name: 'Work and pay sections' });
  for (const section of sections) {
    await navigation.getByRole('button', { name: section.name, exact: true }).click();
    await expect(page.locator(section.content)).toBeVisible();
    await expect.poll(() => page.evaluate(() => ({ body: document.body.scrollWidth, document: document.documentElement.scrollWidth }))).toEqual({ body: width, document: width });
    if (section.route === 'statements') {
      await expect.poll(() => page.locator('.work-pay-total > strong').evaluateAll(amounts => amounts.every(amount => {
        const element = amount as HTMLElement;
        const bounds = element.getBoundingClientRect();
        const total = element.parentElement!.getBoundingClientRect();
        return element.scrollWidth <= element.clientWidth + 1 && bounds.right <= total.right && bounds.left >= total.left;
      }))).toBe(true);
      await page.keyboard.press('Tab');
      const row = page.locator('.work-pay-history-row').first();
      await row.focus();
      await expect(row).toBeFocused();
      await expect.poll(() => row.evaluate(element => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset) };
      })).toEqual({ style: 'solid', width: 2, offset: -3 });
      const earnings = page.getByRole('region', { name: 'Current earnings for Jan 29, 2026', exact: true });
      await earnings.focus();
      await expect(earnings).toBeFocused();
      await page.locator('.work-pay-ytd > summary').click();
      const yearToDate = page.getByRole('region', { name: 'Year-to-date earnings for Jan 29, 2026', exact: true });
      await yearToDate.focus();
      await expect(yearToDate).toBeFocused();
    }
    if (section.route === 'hours') {
      for (const name of ['Projects timecards', 'Legacy timecards']) {
        const table = page.getByRole('region', { name, exact: true });
        await expect(table).toHaveAttribute('tabindex', '0');
        expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
        await table.focus();
        await expect(table).toBeFocused();
        const start = await table.evaluate(element => element.scrollLeft);
        await expect.poll(async () => {
          await page.keyboard.press('ArrowRight');
          return table.evaluate(element => element.scrollLeft);
        }).toBeGreaterThan(start);
      }
    }
  }
});

test('Statements and Work & pay have separate navigation while pay links survive reload and history', async ({ page }) => {
  await page.goto('/#pay/hours');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  const pay = navigation.getByRole('button', { name: 'Work & pay', exact: true });
  const statements = navigation.getByRole('button', { name: 'Statements', exact: true });
  await expect(pay).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Work & pay', exact: true, level: 1 })).toBeVisible();
  await expect(statements).not.toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.work-pay-nav [aria-pressed="true"]')).toHaveText('Work hours');
  await statements.click();
  await expect(page).toHaveURL(/#documents$/);
  await expect(page.getByRole('heading', { name: 'Statements', exact: true, level: 1 })).toBeFocused();
  await expect(page.getByRole('group', { name: 'Statements sections' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#pay\/hours$/);
  await expect(page.locator('.work-pay-nav [aria-pressed="true"]')).toHaveText('Work hours');
  await page.reload();
  await expect(pay).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.work-pay-nav [aria-pressed="true"]')).toHaveText('Work hours');
  await page.goForward();
  await expect(page).toHaveURL(/#documents$/);
  await expect(statements).toHaveAttribute('aria-current', 'page');
  await expect(pay).not.toHaveAttribute('aria-current', 'page');
});
