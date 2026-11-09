import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import type { AppState, StatementBatch, StatementImport, StatementRow, Transaction } from '../shared/types.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as { JSDOM: new(html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: Window & typeof globalThis } };
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
  return nextLoad(url, context);
} });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ReviewPast } = await import('./features/expenses/ReviewPast.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);

function entry(id: string, kind: StatementRow['kind'], amountCents: number, description: string, date = '2026-08-05'): StatementRow {
  return { id, kind, amountCents, description, transactionDate: date, postingDate: date, category: kind === 'purchase' ? 'Shopping' : '', sourcePage: 2 };
}
function statement(rows = [entry('purchase', 'purchase', 3000, 'STORE'), entry('refund', 'refund', -500, 'STORE', '2026-08-06'), entry('payment', 'payment', -10000, 'CARD PAYMENT', '2026-08-07'), entry('interest', 'interest', 200, 'INTEREST', '2026-08-08')], patch: Partial<StatementImport> = {}): StatementImport {
  return { id: 'card-aug', accountId: 'card', sourceFile: 'Card August.pdf', sha256: 'a'.repeat(64), periodStart: '2026-08-01', periodEnd: '2026-08-31', openingBalanceCents: 20000, closingBalanceCents: 20000 + rows.reduce((sum, row) => sum + row.amountCents, 0), rows, ...patch };
}
function legacyTransactions(source: StatementImport): Transaction[] {
  return source.rows.map(row => ({ id: `${source.id}-${row.id}`, date: row.transactionDate, postingDate: row.postingDate, description: row.description, kind: row.kind === 'payment' ? 'adjustment' : 'expense', amountCents: row.kind === 'payment' ? -row.amountCents : row.amountCents, accountId: source.accountId, toAccountId: null, category: row.category, source: source.sourceFile, createdAt: '2026-09-01T00:00:00Z', statementId: source.id, statementRowId: row.id }));
}
function fixture(source = statement()): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'business', name: 'Shop', kind: 'business', ownershipBps: 5000 }], accounts: [{ id: 'card', entityId: 'personal', name: 'Personal card', type: 'debt', currency: 'CAD', balanceCents: 99999, reconciledAt: null }, { id: 'bank', entityId: 'personal', name: 'Personal bank', type: 'cash', currency: 'CAD', balanceCents: 50000, reconciledAt: null }, { id: 'shop-card', entityId: 'business', name: 'Business card', type: 'debt', currency: 'CAD', balanceCents: 0, reconciledAt: null }], transactions: legacyTransactions(source), statements: [source], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
async function render(state: AppState, scope = 'all', onTransactions?: () => void) { await act(async () => root.render(createElement(ReviewPast, { state, scope, onTransactions }))); }
function button(name: string | RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(element => typeof name === 'string' ? element.textContent?.trim() === name : name.test(element.textContent ?? ''));
  assert.ok(found, `Missing button ${name}`);
  return found;
}
async function click(name: string | RegExp) { await act(async () => button(name).click()); }
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type=search]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function select(label: string, value: string) {
  const control = [...container.querySelectorAll('label')].find(element => element.textContent?.startsWith(label))?.querySelector('select');
  assert.ok(control, `Missing select ${label}`);
  await act(async () => { control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); });
}
const rowText = () => [...container.querySelectorAll('tbody tr')].map(row => row.textContent ?? '');
const results = () => container.querySelector('.past-review-results')?.textContent ?? '';
const amounts = () => [...container.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')?.textContent, item.querySelector('dd')?.firstChild?.textContent]);

beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });

test('daily, weekly and monthly review use transaction dates across month and daylight-saving boundaries', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T17:00:00Z') });
  const source = statement([
    entry('older', 'purchase', 100, 'BEFORE WEEK', '2026-10-26'),
    { ...entry('start', 'purchase', 200, 'WEEK START', '2026-10-27'), postingDate: '2026-11-01' },
    entry('october', 'purchase', 300, 'MONTH END', '2026-10-31'),
    entry('refund', 'refund', -400, 'MONTH REFUND', '2026-11-01'),
    entry('today', 'purchase', 500, 'TODAY PURCHASE', '2026-11-02'),
    entry('future', 'purchase', 600, 'FUTURE ENTRY', '2026-11-03'),
  ], { periodStart: '2026-10-01', periodEnd: '2026-11-03' });
  const state = fixture(source);
  const before = structuredClone(state);
  await render(state);
  assert.equal(rowText().length, 6);
  await click('Today');
  assert.equal(rowText().length, 1);
  assert.match(rowText()[0], /TODAY PURCHASE/);
  assert.match(results(), /Charges \$5/);
  await click('Last 7 days');
  assert.equal(rowText().length, 4);
  assert.match(rowText().join(' '), /WEEK START/);
  assert.doesNotMatch(rowText().join(' '), /BEFORE WEEK|FUTURE ENTRY/);
  assert.match(container.querySelector('.records-review-period p')!.textContent!, /Oct 27 to Nov 2/);
  assert.match(button(/^Purchases/).textContent!, /3$/);
  await click('This month');
  assert.equal(rowText().length, 2);
  assert.match(results(), /Charges \$5.*Payments & credits \$4/);
  await select('Month', '2026-10');
  assert.equal(rowText().length, 3);
  assert.equal(button('This month').getAttribute('aria-pressed'), 'false');
  await click('All dates');
  assert.equal(rowText().length, 6);
  assert.deepEqual(state, before);
});

test('record refresh preserves the review period, search and keyboard focus without changing records', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T17:00:00Z') });
  const source = statement([entry('one', 'purchase', 1000, 'COFFEE', '2026-11-01')], { periodStart: '2026-11-01', periodEnd: '2026-11-02' });
  const state = fixture(source);
  await render(state);
  await click('Last 7 days');
  await search('coffee');
  const input = container.querySelector<HTMLInputElement>('input[type=search]')!;
  input.focus();
  const nextSource = statement([...source.rows, entry('two', 'refund', -200, 'COFFEE REFUND', '2026-11-02')], { periodStart: source.periodStart, periodEnd: source.periodEnd });
  const next = { ...fixture(nextSource), revision: 2 };
  const before = structuredClone(next);
  await render(next);
  assert.equal(button('Last 7 days').getAttribute('aria-pressed'), 'true');
  assert.equal(input.value, 'coffee');
  assert.equal(document.activeElement, input);
  assert.equal(rowText().length, 2);
  assert.match(results(), /Charges \$10.*Payments & credits \$2/);
  assert.deepEqual(next, before);
});

test('a selected review filter remains removable when its date period has no issues', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-02T17:00:00Z') });
  const source = statement([entry('old', 'purchase', 100, 'NEEDS CATEGORY', '2026-10-01'), entry('today', 'purchase', 200, 'REVIEWED TODAY', '2026-11-02')], { periodStart: '2026-10-01', periodEnd: '2026-11-02' });
  const state = fixture(source);
  state.transactions[0].category = 'Uncategorized';
  await render(state);
  await click(/^Needs review/);
  await click('Today');
  assert.equal(button(/^Needs review/).getAttribute('aria-pressed'), 'true');
  assert.match(button(/^Needs review/).textContent!, /0$/);
  assert.match(container.textContent!, /No transactions match these filters/);
  await click(/^Needs review/);
  assert.equal(rowText().length, 1);
  assert.match(rowText()[0], /REVIEWED TODAY/);
});

test('legacy statement shows actual rows newest first, corrected categories, signed amounts and PDF pages', async () => {
  const state = fixture();
  state.transactions[0].category = 'Fuel & convenience';
  const before = structuredClone(state);
  await render(state);
  assert.equal([...container.querySelectorAll('select')].find(control => control.closest('label')?.textContent?.startsWith('Sort'))?.value, 'newest');
  assert.deepEqual(amounts(), [['Opening balance', '$200'], ['Charges', '$32'], ['Payments & credits', '$105'], ['Closing balance', '$127']]);
  assert.equal(container.querySelector('.past-review-closing small')?.textContent, '$73 lower');
  assert.match(rowText()[0], /INTEREST.*\+\$2/);
  assert.match(rowText()[1], /CARD PAYMENT.*−\$100/);
  assert.match(rowText()[3], /STORE.*Fuel & convenience.*\+\$30/);
  assert.equal(container.querySelector('[role=alert]'), null);
  const link = container.querySelector<HTMLAnchorElement>('.past-review-pdf')!;
  assert.match(link.textContent!, /Open original source/);
  assert.equal(new URL(link.href).searchParams.get('workspace'), 'live');
  assert.equal(new URL(link.href).searchParams.get('file'), 'Card August.pdf');
  assert.equal(new URL(container.querySelector<HTMLAnchorElement>('.past-review-description a')!.href).hash, '#page=2');
  assert.deepEqual(state, before);
});

test('search, type filters and sort work together and show totals for the full result set', async () => {
  const source = statement([entry('one', 'purchase', 1000, 'PETRO CANADA', '2026-08-02'), entry('two', 'purchase', 2500, 'PETRO CANADA', '2026-08-03'), entry('refund', 'refund', -300, 'PETRO CANADA', '2026-08-04'), entry('elsewhere', 'purchase', 7000, 'OTHER', '2026-08-10')]);
  await render(fixture(source));
  await search('petro');
  assert.equal(rowText().length, 3);
  assert.match(results(), /3 transactions.*Charges \$35.*Payments & credits \$3/);
  await click(/^Purchases/);
  assert.equal(rowText().length, 2);
  assert.match(results(), /2 transactions.*Charges \$35.*Payments & credits \$0/);
  await select('Sort', 'largest');
  assert.match(rowText()[0], /\+\$25/);
  await search('does not exist');
  assert.match(container.textContent ?? '', /No transactions match/);
  await click('Show all transactions');
  assert.equal(rowText().length, 4);
});

test('pagination preserves distinct matching charges and resets after filtering or changing statements', async () => {
  const first = statement(Array.from({ length: 32 }, (_, index) => entry(`row-${index}`, 'purchase', 100, 'SAME DESCRIPTION', '2026-08-05')));
  const second = statement([entry('other', 'purchase', 500, 'PREVIOUS STATEMENT')], { id: 'card-jul', sha256: 'b'.repeat(64), periodStart: '2026-07-01', periodEnd: '2026-07-31' });
  const state = fixture(first);
  state.statements!.push(second);
  state.transactions.push(...legacyTransactions(second));
  await render(state);
  assert.equal(rowText().length, 15);
  assert.match(results(), /33 transactions.*Across 2 sources/);
  await select('Choose statement', 'statement:card-aug');
  assert.match(results(), /32 transactions.*Charges \$32/);
  await click('Next');
  await click('Next');
  assert.equal(rowText().length, 2);
  assert.equal(button('Next').disabled, true);
  await search('same');
  assert.equal(rowText().length, 15);
  await select('Sort', 'largest');
  await select('Choose statement', 'statement:card-jul');
  assert.match(rowText()[0], /PREVIOUS STATEMENT/);
  assert.equal(container.querySelector<HTMLInputElement>('input')?.value, '');
  assert.equal([...container.querySelectorAll('select')].at(-1)?.value, 'newest');
});

test('opening a nested statement moves focus to its heading while source selection keeps dropdown focus', async () => {
  const state = fixture();
  const second = statement([entry('other', 'purchase', 500, 'PREVIOUS STATEMENT')], { id: 'card-jul', sha256: 'b'.repeat(64), periodStart: '2026-07-01', periodEnd: '2026-07-31' });
  state.statements!.push(second); state.transactions.push(...legacyTransactions(second));
  const before = structuredClone(state);
  await render(state);
  const sourceButton = button('View statement');
  sourceButton.focus(); await act(async () => sourceButton.click());
  const heading = container.querySelector<HTMLElement>('.past-review-statement-heading h3')!;
  assert.equal(sourceButton.isConnected, false);
  assert.equal(document.activeElement, heading);
  assert.equal(heading.textContent, 'Personal card');
  assert.match(container.querySelector('.past-review-pdf')!.getAttribute('href')!, /Card%20August.pdf/);
  const selector = container.querySelector<HTMLSelectElement>('.past-review-selection select')!;
  selector.focus(); await select('Choose statement', 'all');
  assert.equal(document.activeElement, selector);
  assert.equal(container.querySelector('.past-review-statement'), null);
  assert.deepEqual(state, before);
});

test('merchant totals preserve exact descriptions and focus the opened transactions', async () => {
  const source = statement([entry('one', 'purchase', 1000, 'AUTO SPA'), entry('two', 'purchase', 1000, 'AUTO SPA'), entry('refund', 'refund', -200, 'AUTO SPA'), entry('other', 'purchase', 4000, 'AUTO SPA NORTH'), entry('same-payment', 'payment', -500, 'AUTO SPA')]);
  const state = fixture(source), before = structuredClone(state);
  await render(state);
  await click('By merchant');
  assert.equal(rowText().length, 2);
  assert.match(rowText()[0], /AUTO SPA NORTH.*\$40/);
  assert.match(rowText()[1], /AUTO SPA3 transactions.*\$20.*\$2/);
  const merchant = button(/^AUTO SPA3 transactions/);
  merchant.focus(); await act(async () => merchant.click());
  assert.equal(merchant.isConnected, false);
  assert.equal(document.activeElement, container.querySelector('.past-review-activity-header h3'));
  assert.equal(rowText().length, 3);
  assert.ok(rowText().every(row => !row.includes('NORTH') && !row.includes('Payment')));
  assert.match(results(), /Charges \$20.*Payments & credits \$2/);
  assert.deepEqual(state, before);
});

function cashBatch(): StatementBatch {
  return { id: 'bank-aug', status: 'committed', createdAt: '2026-09-01', committedAt: '2026-09-01', source: { id: 'bank-aug', accountId: 'bank', sourceFile: 'Bank.pdf', sha256: 'c'.repeat(64), periodStart: '2026-08-01', periodEnd: '2026-08-31', openingBalanceCents: 10000, closingBalanceCents: 12000, rows: [{ id: 'expense', description: 'Groceries', amountCents: -2000, transactionDate: '2026-08-02', postingDate: '2026-08-02', sourcePage: 1 }, { id: 'income', description: 'Pay', amountCents: 10000, transactionDate: '2026-08-03', postingDate: '2026-08-03', sourcePage: 1 }, { id: 'refund', description: 'Store return', amountCents: 1000, transactionDate: '2026-08-04', postingDate: '2026-08-04', sourcePage: 1 }, { id: 'payment', description: 'Card payment', amountCents: -5000, transactionDate: '2026-08-05', postingDate: '2026-08-05', sourcePage: 1 }, { id: 'transfer', description: 'Savings transfer', amountCents: -2000, transactionDate: '2026-08-06', postingDate: '2026-08-06', sourcePage: 1 }] }, decisions: [{ rowId: 'expense', kind: 'expense', category: 'Food' }, { rowId: 'income', kind: 'income', category: 'Salary' }, { rowId: 'refund', kind: 'refund', category: 'Shopping' }, { rowId: 'payment', kind: 'transfer', category: '' }, { rowId: 'transfer', kind: 'transfer', category: '' }] };
}
function batchTransactions(batch: StatementBatch): Transaction[] {
  return batch.source.rows.map(row => { const decision = batch.decisions.find(item => item.rowId === row.id)!; return { id: `tx-${batch.id}-${row.id}`, date: row.transactionDate, description: row.description, kind: row.id === 'payment' ? 'debt_payment' : decision.kind === 'transfer' ? 'transfer' : decision.kind === 'income' ? 'income' : 'expense', amountCents: Math.abs(row.amountCents), accountId: batch.source.accountId, toAccountId: row.id === 'payment' ? 'card' : decision.kind === 'transfer' ? 'savings' : null, category: decision.category, source: batch.source.sourceFile, createdAt: '2026-09-01', importSources: [{ importId: batch.id, rowId: row.id }] }; });
}

test('committed cash statements keep cash signs and separate purchases, income, payments and transfers', async () => {
  const state = fixture();
  const batch = cashBatch();
  state.statements = [];
  state.importBatches = [batch];
  state.transactions = batchTransactions(batch);
  state.transactions[0].category = 'Corrected food';
  await render(state);
  assert.deepEqual(amounts(), [['Opening balance', '$100'], ['Money in', '$110'], ['Money out', '$90'], ['Closing balance', '$120']]);
  assert.equal(container.querySelector('.past-review-closing small')?.textContent, '$20 higher');
  assert.equal(container.querySelector('[role=alert]'), null);
  await click(/^Purchases/);
  assert.match(rowText()[0], /Corrected food.*−\$20/);
  await click(/^Payments/);
  assert.equal(rowText().length, 1);
  assert.match(rowText()[0], /Card payment.*−\$50/);
  await click(/^Income/);
  assert.match(rowText()[0], /Pay.*Salary.*\+\$100/);
  await click(/^Transfers/);
  assert.match(rowText()[0], /Savings transfer.*−\$20/);
  await click('By merchant');
  assert.equal(rowText().length, 2);
  assert.ok(rowText().every(row => !row.includes('Pay') && !row.includes('transfer')));
});

test('owner scope, workspace and statement changes reset review controls without weighting source amounts', async () => {
  const state = fixture();
  const business = statement([entry('business', 'purchase', 8000, 'BUSINESS ONLY')], { id: 'shop-aug', accountId: 'shop-card', sha256: 'd'.repeat(64) });
  state.statements!.push(business);
  state.transactions.push(...legacyTransactions(business));
  await render(state, 'personal');
  await search('STORE');
  await render(state, 'business');
  assert.equal(container.querySelector<HTMLInputElement>('input')?.value, '');
  assert.equal(rowText().length, 1);
  assert.match(rowText()[0], /BUSINESS ONLY.*\+\$80/);
  assert.equal(container.querySelector('.past-review-selection select'), null);
  await search('missing');
  await render({ ...state, workspace: 'demo' }, 'business');
  assert.equal(rowText().length, 1);
  assert.equal(new URL(container.querySelector<HTMLAnchorElement>('.past-review-pdf')!.href).searchParams.get('workspace'), 'demo');
  await render(state, 'unknown');
  assert.match(container.textContent ?? '', /No recorded statements yet/);
});

test('missing transaction links and mismatched closing balances remain visible for both source formats', async () => {
  const state = fixture();
  const payment = state.transactions.find(row => row.statementRowId === 'payment')!;
  Object.assign(payment, { kind: 'debt_payment', accountId: 'bank', toAccountId: 'card' });
  await render(state);
  assert.equal(container.querySelector('[role=alert]'), null);
  payment.toAccountId = 'shop-card';
  state.statements![0].closingBalanceCents++;
  await render(state);
  assert.match(container.querySelector('[role=alert]')?.textContent ?? '', /do not match.*1 entry is missing/);
  assert.equal(container.querySelector('.past-review-closing small'), null);
  const batch = cashBatch();
  batch.source.closingBalanceCents++;
  state.statements = [];
  state.importBatches = [batch];
  state.transactions = batchTransactions(batch).slice(1);
  await render(state);
  assert.match(container.querySelector('[role=alert]')?.textContent ?? '', /do not match.*1 entry is missing/);
  assert.equal(rowText().length, 5);
});

test('duplicate source records appear once while staged imports stay out of recorded statements', async () => {
  const state = fixture();
  const source = state.statements![0];
  const duplicate: StatementBatch = { id: 'duplicate', source, decisions: source.rows.map(row => ({ rowId: row.id, kind: row.kind === 'purchase' ? 'expense' : row.kind === 'payment' ? 'transfer' : row.kind, category: row.category })), status: 'committed', committedAt: '2026-09-01', createdAt: '2026-09-01' };
  state.importBatches = [duplicate, { ...cashBatch(), status: 'staged' }];
  state.transactions = batchTransactions(duplicate);
  await render(state);
  assert.equal(container.querySelector('.past-review-selection select'), null);
  assert.match(results(), /4 transactions/);
  assert.equal(rowText().length, 4);
});

test('batch totals reject unsafe gross amounts even when the net statement balance reconciles', async () => {
  const batch = cashBatch();
  batch.source.openingBalanceCents = 0;
  batch.source.closingBalanceCents = 0;
  batch.source.rows = Array.from({ length: 4 }, (_, index) => ({ id: `large-${index}`, description: 'Large entry', transactionDate: '2026-08-01', postingDate: '2026-08-01', sourcePage: 1, amountCents: index < 2 ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER }));
  batch.decisions = batch.source.rows.map(row => ({ rowId: row.id, kind: row.amountCents > 0 ? 'income' : 'expense', category: '' }));
  const state = fixture();
  state.statements = [];
  state.importBatches = [batch];
  state.transactions = batchTransactions(batch);
  await assert.rejects(render(state), /Statement totals exceed the supported amount in cents/);
});

test('reviewed JSON and CSV source movements keep signs and open their actual source without PDF labels', async () => {
  for (const extension of ['json', 'csv']) {
    const batch = cashBatch();
    batch.source.sourceFile = `Bank review.${extension}`;
    batch.decisions = batch.decisions.map(decision => decision.rowId === 'payment' ? { ...decision, kind: 'movement', category: 'Card payment' } : decision);
    const state = fixture();
    state.statements = [];
    state.importBatches = [batch];
    state.transactions = batchTransactions(batch).map(transaction => transaction.id.endsWith('-payment') ? { ...transaction, kind: 'adjustment', toAccountId: null, balanceChanges: { bank: -5000 } } : transaction);
    await render(state);
    const sourceLink = container.querySelector<HTMLAnchorElement>('.past-review-pdf')!;
    assert.match(sourceLink.textContent!, /Open original source/);
    assert.equal(new URL(sourceLink.href).searchParams.get('file'), `Bank review.${extension}`);
    await click(/^Account movements/);
    assert.equal(rowText().length, 1);
    assert.match(rowText()[0], /Card payment.*Account movement.*−\$50/);
    const rowLink = container.querySelector<HTMLAnchorElement>('.past-review-description a')!;
    assert.equal(rowLink.textContent, 'Original source');
    assert.equal(new URL(rowLink.href).hash, '');
    assert.equal(container.querySelector('[role=alert]'), null);
  }
});

test('archive search spans sources and accounts, then opens the exact statement with unchanged source amounts', async () => {
  const first = statement([entry('same-id', 'purchase', 3025, 'LOCAL STORE', '2026-08-05')]);
  const second = statement([entry('same-id', 'purchase', 4050, 'LOCAL STORE', '2026-07-05')], { id: 'card-jul', sha256: 'b'.repeat(64), periodStart: '2026-07-01', periodEnd: '2026-07-31' });
  const state = fixture(first);
  const bank = cashBatch();
  state.statements!.push(second);
  state.transactions.push(...legacyTransactions(second), ...batchTransactions(bank));
  state.importBatches = [bank];
  const before = structuredClone(state);
  await render(state);
  assert.match(results(), /7 transactions.*Across 3 sources/);
  assert.equal(container.querySelector('.past-review-amounts'), null);
  await search('local store');
  assert.equal(rowText().length, 2);
  assert.ok(rowText().every(row => row.includes('Personal card')));
  await select('Month', '2026-07');
  assert.equal(rowText().length, 1);
  assert.match(rowText()[0], /Jul 5, 2026.*\+\$40.50/);
  await click('View statement');
  assert.match(container.querySelector('.past-review-statement')?.textContent ?? '', /Jul 1, 2026 to Jul 31, 2026/);
  assert.equal(new URL(container.querySelector<HTMLAnchorElement>('.past-review-pdf')!.href).searchParams.get('sha'), 'b'.repeat(64));
  await click(/^Personal bank1 source/);
  assert.equal(rowText().length, 5);
  assert.match(container.querySelector('.past-review-statement')?.textContent ?? '', /Money in\$110Money out\$90/);
  await search('20.00');
  assert.equal(rowText().length, 2);
  assert.deepEqual(state, before);
});

test('review filter exposes missing links and purchase categories without hiding payments or changing records', async () => {
  const state = fixture();
  state.transactions = state.transactions.filter(row => row.statementRowId !== 'interest');
  state.transactions[0].category = 'Uncategorized';
  let opened = 0;
  const before = structuredClone(state);
  await render(state, 'all', () => { opened++; });
  await click(/^Needs review/);
  assert.equal(rowText().length, 3);
  assert.match(rowText().join(' '), /Transaction link missing/);
  assert.match(rowText().join(' '), /Category missing/);
  assert.ok(rowText().every(row => !row.includes('CARD PAYMENT')));
  await click(/^Edit categories in Expenses/);
  assert.equal(opened, 1);
  await click('Clear filters');
  await click(/^Payments/);
  assert.match(rowText()[0], /CARD PAYMENT/);
  assert.deepEqual(state, before);
});

test('archive warnings identify the source with a balance mismatch and preserve overlapping source rows', async () => {
  const first = statement([entry('first', 'purchase', 3000, 'STORE')]);
  const second = statement([entry('first', 'purchase', 3000, 'STORE')], { id: 'overlap', sha256: 'e'.repeat(64), closingBalanceCents: 1 });
  const state = fixture(first);
  state.statements!.push(second);
  state.transactions.push(...legacyTransactions(second));
  await render(state);
  assert.equal(rowText().length, 2);
  assert.match(container.querySelector('[role=alert]')?.textContent ?? '', /1 source has a closing balance/);
  assert.match(container.querySelector('.past-review-source')?.textContent ?? '', /Overlapping statements can include the same transaction/);
  await click(/^Check Personal card/);
  assert.match(container.querySelector('[role=alert]')?.textContent ?? '', /do not match/);
  assert.equal(container.querySelector('.past-review-closing small'), null);
  assert.equal(new URL(container.querySelector<HTMLAnchorElement>('.past-review-pdf')!.href).searchParams.get('sha'), 'e'.repeat(64));
});

test('compact account selection shares filters and selected state with the desktop account buttons', async () => {
  const state = fixture();
  const batch = cashBatch();
  state.importBatches = [batch];
  state.transactions.push(...batchTransactions(batch));
  await render(state);
  const accountSelect = container.querySelector<HTMLSelectElement>('.past-review-account-select select')!;
  assert.ok(accountSelect);
  assert.equal(container.querySelector('label[for="' + accountSelect.id + '"] > span')?.textContent, 'Account');
  assert.equal(accountSelect.value, 'all');
  assert.match(accountSelect.options[0].textContent ?? '', /All accounts.*2 sources/);
  assert.match([...accountSelect.options].find(option => option.value === 'bank')?.textContent ?? '', /Personal bank.*1 source.*Latest Aug 31, 2026/);
  await search('STORE');
  await select('Account', 'bank');
  assert.equal(container.querySelector<HTMLInputElement>('input[type=search]')?.value, '');
  assert.equal(rowText().length, 5);
  assert.equal(button(/^Personal bank1 source/).getAttribute('aria-pressed'), 'true');
  await click(/^Personal card1 source/);
  assert.equal(accountSelect.value, 'card');
  assert.equal(rowText().length, 4);
  await select('Account', 'all');
  assert.equal(rowText().length, 9);
  assert.equal(button(/^All accounts2 sources/).getAttribute('aria-pressed'), 'true');
});

for (const dateBasis of ['posting_only', 'transaction_only'] as const) test(`source history labels the absent date for ${dateBasis}`, async () => {
  const state = fixture();
  const source = statement([entry('single-date', 'purchase', 3000, 'ONE BANK DATE')]);
  state.statements = [];
  state.transactions = [];
  state.importBatches = [{ id: source.id, source: { ...source, sourceKind: 'bank_activity', observedOn: source.periodEnd, rows: source.rows.map(row => ({ ...row, dateBasis })) }, status: 'committed', createdAt: '2026-09-01T12:00:00Z', committedAt: '2026-09-01T12:00:00Z', decisions: [{ rowId: 'single-date', kind: 'expense', category: 'Shopping' }] }];
  await render(state);
  const dateCell = container.querySelector('.past-review-date')!.textContent!;
  assert.match(dateCell, /Aug 5, 2026/);
  assert.match(dateCell, dateBasis === 'posting_only' ? /Posting date only; transaction date not supplied/ : /Transaction date only; posting date not supplied/);
  assert.doesNotMatch(dateCell, /Bank activity Aug/);
});
