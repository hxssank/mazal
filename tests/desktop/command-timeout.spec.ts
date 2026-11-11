import { expect, test } from '@playwright/test';
import type { AppState, Command } from '../../shared/types.ts';

for (const savedFirst of [false, true]) test(`a stalled save ${savedFirst ? 'after' : 'before'} commit keeps one expense and releases navigation`, async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  const before = await response.json() as AppState;
  const cash = before.accounts.find(account => account.name === 'Browser test cash')!;
  expect(cash).toBeTruthy();
  const description = `Stalled save ${savedFirst ? 'after' : 'before'} commit ${crypto.randomUUID()}`;
  const sent: Command[] = [];
  let firstHandled = false;
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
  await page.route('**/api/command?workspace=live', async route => {
    sent.push(route.request().postDataJSON() as Command);
    if (sent.length === 1) {
      if (savedFirst) {
        const saved = await route.fetch();
        expect(saved.ok()).toBe(true);
      }
      firstHandled = true;
      return;
    }
    await retryGate;
    await route.continue();
  });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.install();
    await page.addInitScript(() => {
      // Hold React's queued work so a browser frame can precede the dialog removal commit.
      const pending: (() => void)[] = [];
      const scheduling = { hold: false, pending, release() { this.hold = false; pending.splice(0).forEach(deliver => deliver()); } };
      Object.assign(window, { mazalCommitScheduling: scheduling });
      const Channel = window.MessageChannel;
      window.MessageChannel = class extends Channel {
        constructor() {
          super();
          this.port1.addEventListener('message', event => {
            if (!scheduling.hold) return;
            event.stopImmediatePropagation();
            pending.push(() => this.port1.onmessage?.call(this.port1, event));
          });
        }
      };
    });
    await page.goto('/#home');
    const open = page.getByRole('button', { name: 'Add transaction', exact: true });
    // Pointer activation need not focus a button in WebKit.
    await open.evaluate(element => element.addEventListener('pointerdown', event => event.preventDefault(), { once: true }));
    await open.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Description', { exact: true }).fill(description);
    await dialog.getByLabel('Amount · CAD', { exact: true }).fill('12.34');
    await dialog.getByRole('combobox', { name: 'Payment account', exact: true }).selectOption(cash.id);
    await dialog.getByRole('button', { name: 'Add expense', exact: true }).click();
    await expect.poll(() => firstHandled).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled();
    await page.clock.fastForward(60_001);
    const error = dialog.getByRole('alert').filter({ hasText: /timed out/i });
    await expect(error).toBeVisible();
    await expect(error).toBeFocused();
    await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue(description);
    await expect(dialog.getByLabel('Amount · CAD', { exact: true })).toHaveValue('12.34');
    await expect(dialog.getByLabel('Amount · CAD', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeEnabled();
    expect(sent).toHaveLength(1);
    if (savedFirst) await dialog.getByRole('button', { name: 'Review updated records', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm original save', exact: true }).click();
    await expect.poll(() => sent.length).toBe(2);
    await page.evaluate(() => { (window as typeof window & { mazalCommitScheduling: { hold: boolean } }).mazalCommitScheduling.hold = true; });
    releaseRetry();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { mazalCommitScheduling: { pending: unknown[] } }).mazalCommitScheduling.pending.length)).toBeGreaterThan(0);
    const frameBeforeCommit = await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      const dialogOpen = Boolean(document.querySelector('dialog[open]'));
      (window as typeof window & { mazalCommitScheduling: { release: () => void } }).mazalCommitScheduling.release();
      return dialogOpen;
    });
    expect(frameBeforeCommit).toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    expect(sent).toHaveLength(2);
    expect(sent[0].type).toBe('add_transaction');
    expect(sent[1]).toEqual({ ...sent[0], expectedRevision: before.revision + (savedFirst ? 1 : 0) });
    const after = await (await request.get('/api/state?workspace=live')).json() as AppState;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.transactions.filter(transaction => transaction.description === description)).toHaveLength(1);
    expect(after.accounts.find(account => account.id === cash.id)!.balanceCents).toBe(cash.balanceCents - 1234);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Expenses', exact: true }).click();
    await expect(page).toHaveURL(/#expenses$/);
    await page.goBack();
    await expect(page).toHaveURL(/#home$/);
    await expect(page.getByRole('heading', { name: 'Home', exact: true, level: 1 })).toBeFocused();
    await page.reload();
    await expect(open).toBeEnabled();
    expect((await (await request.get('/api/state?workspace=live')).json()).revision).toBe(after.revision);
  } finally {
    releaseRetry();
    let current = await (await request.get('/api/state?workspace=live')).json() as AppState;
    const saved = current.transactions.filter(transaction => transaction.description === description
      && !transaction.reversalOf && !current.transactions.some(other => other.reversalOf === transaction.id));
    for (const transaction of saved) {
      const undone = await request.post('/api/command?workspace=live', { data: {
        type: 'correct_transaction', id: transaction.id, reason: 'Remove isolated save-timeout fixture',
        expectedRevision: current.revision, requestId: crypto.randomUUID(),
      } });
      expect(undone.ok()).toBe(true);
      current = await undone.json() as AppState;
    }
    expect(current.accounts.find(account => account.id === cash.id)!.balanceCents).toBe(cash.balanceCents);
  }
});
