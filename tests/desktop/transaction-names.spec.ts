import { createHash } from 'node:crypto';
import { parseStatementCSV } from '../../shared/statement-csv.ts';
import { expect, test } from '@playwright/test';
import type { AppState, Command } from '../../shared/types.ts';

test.use({ reducedMotion: 'reduce' });

test('rename an imported transaction, search its note, reload and restore the bank name', async ({ page, request }) => {
  const response = await request.get('/api/state?workspace=live');
  expect(response.headers()['x-mazal-data-source']).toBe('sample');
  let state = await response.json() as AppState;
  const send = async (command: Command) => {
    const response = await request.post('/api/command?workspace=live', { data: { ...command, expectedRevision: state.revision, requestId: crypto.randomUUID() } });
    expect(response.ok(), await response.text()).toBe(true);
    state = await response.json() as AppState;
  };
  const suffix = crypto.randomUUID();
  await send({ type: 'add_account', entityId: 'personal', name: `Name test card ${suffix}`, accountType: 'debt', openingBalanceCents: 0, openingDate: '2026-01-01' });
  const account = state.accounts.find(row => row.name === `Name test card ${suffix}`)!;
  const description = `BANK MERCHANT ${suffix}`;
  const sourceFile = `name-test-${suffix}.csv`;
  const bytes = Buffer.from(`TransactionDate,PostingDate,Description,Amount\r\n2026-01-10,2026-01-12,${description},12.34\r\n`);
  const rows = parseStatementCSV(bytes.toString('utf8'));
  const uploaded = await request.post('/api/documents?workspace=live', { headers: {
    'Content-Type': 'application/octet-stream',
    'X-Mazal-Document': encodeURIComponent(JSON.stringify({ originalName: sourceFile, kind: 'statement', accountId: account.id, periodStart: '2026-01-01', periodEnd: '2026-01-31' })),
  }, data: bytes });
  expect(uploaded.status()).toBe(201);
  const importId = `name-statement-${suffix}`;
  await send({ type: 'stage_statement', requestId: '', statement: {
    id: importId, accountId: account.id, sourceFile, sha256: createHash('sha256').update(bytes).digest('hex'), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 0, closingBalanceCents: 1234, rows,
  } });
  await send({ type: 'review_statement', importId, decisions: [{ rowId: rows[0].id, kind: 'expense', category: 'Uncategorized' }], requestId: '' });
  await send({ type: 'commit_statements', importIds: [importId], requestId: '' });
  const original = state.transactions.find(row => row.description === description)!;
  const balances = state.accounts.map(row => [row.id, row.balanceCents]);
  await page.goto('/#expenses/activity');
  await page.getByRole('textbox', { name: 'Search transactions', exact: true }).fill(description);
  const entry = page.locator(`[data-record-id="${original.id}"]`);
  await entry.getByRole('button', { name: `View record for ${description}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Transaction details', exact: true });
  await expect(dialog.getByText(`Original description: ${description}`, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save name and note', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Transaction name', exact: true }).fill('Home internet');
  await dialog.getByRole('textbox', { name: 'Note', exact: true }).fill('Monthly connection for shared home office');
  await expect(dialog.getByRole('combobox', { name: 'Action', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Save name and note', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const trigger = entry.getByRole('button', { name: 'View record for Home internet', exact: true });
  await expect(trigger).toBeFocused();
  await expect(entry.getByText(description, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('textbox', { name: 'Search transactions', exact: true }).fill('shared home office');
  await expect(entry.getByText('Home internet', { exact: true })).toBeVisible();
  await trigger.click();
  await expect(dialog.getByRole('textbox', { name: 'Transaction name', exact: true })).toHaveValue('Home internet');
  await dialog.getByRole('textbox', { name: 'Transaction name', exact: true }).fill('Unsaved label');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Transaction name', exact: true })).toHaveValue('Unsaved label');
  await dialog.getByRole('textbox', { name: 'Transaction name', exact: true }).fill('');
  await page.screenshot({ path: 'artifacts/transaction-names-20261019/editor.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Save name and note', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(entry.getByRole('button', { name: `View record for ${description}`, exact: true })).toBeFocused();
  const after = await (await request.get('/api/state?workspace=live')).json() as AppState;
  const { note, ...restored } = after.transactions.find(row => row.id === original.id)!;
  expect(note).toBe('Monthly connection for shared home office');
  expect(restored).toEqual(original);
  expect(after.accounts.map(row => [row.id, row.balanceCents])).toEqual(balances);
});
