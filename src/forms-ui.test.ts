import { CommandRejectedError } from './services/command-errors.ts';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createStore } from '../server/store.ts';
import type { AppState, Command } from '../shared/types.ts';
import { executeCommandWithRecovery } from './services/command-recovery.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const extension of ['.ts', '.tsx']) {
        const url = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(url)) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    if (url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Forms } = await import('./features/entries/Forms.tsx');
const { default: ExpenseBills } = await import('./features/expenses/ExpenseBills.tsx');
const { default: Subscriptions } = await import('./features/expenses/Subscriptions.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'cash', entityId: 'personal', name: 'Cash', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(element => element.textContent?.trim() === text);
  assert.ok(result, `Missing button ${text}`);
  return result;
}
async function fill(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  assert.ok(input, `Missing field ${name}`);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); });

test('a stale transaction form preserves entries and reviews the new revision before saving', async () => {
  let state = fixture();
  const sent: Command[] = [];
  let closed = 0;
  const render = () => root.render(createElement(Forms, { kind: 'transaction', state, onCommand: async command => { sent.push(command); }, onClose: () => { closed++; } }));
  await act(async () => render());
  await fill('description', 'Groceries');
  await fill('amount', '12.34');
  state = { ...state, revision: 2, accounts: state.accounts.map(account => ({ ...account, balanceCents: 90000 })) };
  await act(async () => render());
  assert.equal(button('Add expense').disabled, true);
  await submit();
  assert.equal(sent.length, 0);
  await act(async () => button('Review updated records').click());
  assert.equal(button('Add expense').disabled, false);
  assert.equal(container.querySelector<HTMLInputElement>('input[name="description"]')!.value, 'Groceries');
  assert.match(container.textContent!, /\$887\.66/);
  await submit();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].expectedRevision, 2);
  assert.ok(sent[0].type === 'add_transaction');
  assert.equal(sent[0].amountCents, 1234);
  assert.equal(closed, 1);
});

test('a recovered write retries with the original request ID after reviewing refreshed records', async () => {
  let state = fixture();
  const sent: Command[] = [];
  const onCommand = async (command: Command) => {
    sent.push(command);
    if (sent.length === 1) {
      state = { ...state, revision: 2 };
      render();
      throw new Error('Could not confirm the save.');
    }
  };
  const render = () => root.render(createElement(Forms, { kind: 'transaction', state, onCommand, onClose: () => {} }));
  await act(async () => render());
  await fill('description', 'Groceries');
  await fill('amount', '12.34');
  await submit();
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /confirm the save/);
  await act(async () => button('Review updated records').click());
  await submit();
  assert.equal(sent.length, 2);
  assert.ok(sent[0].type === 'add_transaction' && sent[1].type === 'add_transaction');
  assert.equal(sent[0].requestId, sent[1].requestId);
  assert.equal(sent[1].expectedRevision, 2);
});

for (const kind of ['account', 'reserve'] as const) for (const committed of [true, false]) test(`retrying ${kind} creation after failure ${committed ? 'after' : 'before'} commit pins the amount and keeps one saved record`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-form-retry-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let state = store.state();
  const sent: Command[] = [];
  let closed = 0;
  const onCommand = async (command: Command) => {
    state = await executeCommandWithRecovery('live', command, async (_workspace, entry) => {
      sent.push(entry);
      if (sent.length === 1 && !committed) throw new Error('Response lost before commit.');
      const saved = store.command(entry);
      if (sent.length === 1) throw new Error('Response lost after commit.');
      return saved;
    }, async () => store.state(), recovered => { state = recovered; render(); });
    render();
  };
  const render = () => root.render(createElement(Forms, { kind, state, onCommand, onClose: () => { closed++; } }));
  await act(async () => render());
  await fill('name', kind === 'account' ? 'Savings' : 'Emergency fund');
  await fill(kind === 'account' ? 'opening' : 'amount', '100');
  await submit();
  assert.equal(closed, 0);
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Response lost/);
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true);
  await fill('name', 'Changed after failure');
  await fill(kind === 'account' ? 'opening' : 'amount', '120');
  const savedRevision = state.revision;
  if (committed) await act(async () => button('Review updated records').click());
  await submit();
  assert.equal(closed, 1);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].type === 'add_account' || sent[0].type === 'add_reserve');
  assert.ok(sent[1].type === sent[0].type);
  assert.ok(sent[0].requestId);
  assert.equal(sent[1].requestId, sent[0].requestId);
  assert.equal(state.revision, savedRevision + (committed ? 0 : 1));
  const records = kind === 'account' ? state.accounts : state.reserves;
  assert.equal(records.length, 1);
  assert.equal(kind === 'account' ? state.accounts[0].balanceCents : state.reserves[0].amountCents, 10000);
});

test('a failed absolute SOL update cannot overwrite a reward added before its retry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-sol-form-retry-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let state = store.command({ type: 'add_account', entityId: 'personal', name: 'SOL', accountType: 'investment', openingBalanceCents: 0, openingDate: '2026-01-01', requestId: 'sol-account' });
  const accountId = state.accounts[0].id;
  state = store.command({ type: 'save_sol', accountId, liquidSol: '0', stakedSol: '10', costBasisCents: 100000, priceCents: 10000, priceDate: '2026-01-01', requestId: 'initial' });
  const sent: Command[] = [];
  const onCommand = async (command: Command) => {
    sent.push(command);
    state = await executeCommandWithRecovery('live', command, async (_workspace, entry) => {
      if (sent.length === 1) {
        store.command({ type: 'add_sol_reward', positionId: state.positions[0].id, sol: '1', date: '2026-01-02', requestId: 'concurrent-reward' });
        throw new Error('Response lost before update.');
      }
      return store.command(entry);
    }, async () => store.state(), recovered => { state = recovered; render(); });
  };
  const render = () => root.render(createElement(Forms, { kind: 'sol', accountId, state, onCommand, onClose: () => {} }));
  await act(async () => render());
  await fill('price', '110');
  await submit();
  assert.equal(state.positions[0].stakedSol, '11');
  await act(async () => button('Review updated records').click());
  await submit();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(store.state().positions[0].stakedSol, '11');
  assert.equal(store.state().positions[0].priceCents, 10000);
  assert.match(container.textContent!, /Records changed|changed in another|changed since|updated records/);
});

test('switching SOL accounts preserves edits until discard and keeps clean account changes clean', async () => {
  const state = fixture();
  state.accounts = ['first', 'second'].map(id => ({ ...state.accounts[0], id, name: `${id} wallet`, type: 'investment' }));
  state.positions = state.accounts.map((account, index) => ({ id: `holding-${account.id}`, accountId: account.id, liquidSol: index ? '7' : '1', stakedSol: index ? '8' : '2', rewardsSol: '0', costBasisCents: index ? 150000 : 30000, priceCents: 10000, priceDate: '2026-01-01', priceSource: 'Statement' }));
  const sent: Command[] = [];
  let closed = 0;
  await act(async () => root.render(createElement(Forms, { kind: 'sol', accountId: 'first', state, onCommand: async command => { sent.push(command); }, onClose: () => { closed++; } })));
  const account = container.querySelector<HTMLSelectElement>('select[aria-label="Investment account"]')!;
  const liquid = container.querySelector<HTMLInputElement>('input[name="liquidSol"]')!;
  async function choose(value: string) {
    await act(async () => { account.focus(); account.value = value; account.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  await fill('liquidSol', '3.5');
  await choose('second');
  assert.match(container.textContent!, /Discard unsaved changes/);
  assert.equal(account.value, 'first');
  assert.equal(liquid.value, '3.5');
  assert.equal(document.activeElement, button('Keep editing'));
  await act(async () => { button('Keep editing').click(); await new Promise(resolve => window.requestAnimationFrame(resolve)); });
  assert.equal(account.value, 'first');
  assert.equal(liquid.value, '3.5');
  assert.equal(document.activeElement, account);
  await choose('second');
  await act(async () => { button('Discard changes').click(); await new Promise(resolve => window.requestAnimationFrame(resolve)); });
  assert.equal(account.value, 'second');
  assert.equal(liquid.value, '7');
  assert.equal(container.querySelector<HTMLInputElement>('input[name="stakedSol"]')!.value, '8');
  assert.equal(container.querySelector<HTMLInputElement>('input[name="costBasis"]')!.value, '1500.00');
  assert.equal(document.activeElement, account);
  await choose('first');
  assert.equal(liquid.value, '1');
  assert.doesNotMatch(container.textContent!, /Discard unsaved changes/);
  await choose('second');
  assert.equal(liquid.value, '7');
  assert.doesNotMatch(container.textContent!, /Discard unsaved changes/);
  await act(async () => button('Cancel').click());
  assert.equal(closed, 1);
  assert.deepEqual(sent, []);
});

for (const kind of ['bill', 'subscription'] as const) for (const changedField of ['amountCents', 'name', 'accountId'] as const) test(`${kind} editor preserves a concurrent ${changedField} change after conflict recovery`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-obligation-conflict-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['Chequing', 'Savings']) store.command({ type: 'add_account', entityId: 'personal', name, accountType: 'cash', openingBalanceCents: 100000, openingDate: '2026-01-01' });
  let state = store.state();
  state = store.command({ type: 'add_obligation', entityId: 'personal', name: 'Phone', amountCents: 1000, dueDate: '2026-11-01', direction: 'out', recurrence: 'monthly', accountId: state.accounts[0].id, category: 'Bills', subscription: kind === 'subscription', requestId: 'create-schedule' });
  const original = state.obligations[0];
  let attempts = 0;
  const onCommand = async (command: Command) => {
    attempts++;
    state = await executeCommandWithRecovery('live', { ...command, expectedRevision: state.revision }, async (_workspace, entry) => store.command(entry), async () => store.state(), recovered => { state = recovered; render(); });
    render();
  };
  const render = () => root.render(createElement(kind === 'bill' ? ExpenseBills : Subscriptions, { state, scope: 'personal', readOnly: false, pending: '', onCommand, onPay: async () => {} }));
  await act(async () => render());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit Phone"]')!.click());
  const nameInput = container.querySelector<HTMLInputElement>('dialog input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, 'My phone plan'); nameInput.dispatchEvent(new Event('input', { bubbles: true })); });
  const external = store.command({ type: 'update_obligation', id: original.id, expectedDueDate: original.dueDate, expectedStatus: 'planned', name: original.name, amountCents: original.amountCents, dueDate: original.dueDate, recurrence: original.recurrence, accountId: original.accountId, category: original.category, subscription: original.subscription, [changedField]: changedField === 'amountCents' ? 2000 : changedField === 'name' ? 'Updated elsewhere' : state.accounts[1].id, expectedRevision: state.revision, requestId: 'external-change' });
  await submit();
  assert.equal(attempts, 1);
  assert.equal(button('Save changes').disabled, true);
  assert.match(container.querySelector('dialog')!.textContent!, /changed\. Close this editor and reopen/);
  assert.equal(nameInput.value, 'My phone plan');
  await submit();
  assert.equal(attempts, 1);
  assert.deepEqual(store.state().obligations[0], external.obligations[0]);
});

test('account creation has no ownership parameter and always uses the personal profile', async () => {
  const state = fixture();
  state.entities.push({ id: 'legacy-business', name: 'Legacy business', kind: 'business', ownershipBps: 5000 });
  const sent: Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind: 'account', state, onCommand: async command => { sent.push(command); }, onClose: () => {} })));
  assert.doesNotMatch(container.textContent!, /Belongs to|ownership|Legacy business/i);
  assert.equal(container.querySelector('[name="entityId"]'), null);
  await fill('name', 'Savings');
  await fill('opening', '100');
  await submit();
  assert.ok(sent[0].type === 'add_account');
  assert.equal(sent[0].entityId, 'personal');
});

for (const accountType of ['cash', 'debt', 'payable', 'investment', 'receivable'] as const) {
  test(`${accountType} opening balance ${['cash', 'debt', 'payable'].includes(accountType) ? 'accepts' : 'rejects'} a negative amount`, async () => {
    const sent: Command[] = [];
    await act(async () => root.render(createElement(Forms, { kind: 'account', initialAccountType: accountType, state: fixture(), onCommand: async command => { sent.push(command); }, onClose: () => {} })));
    await fill('name', 'Opening balance test');
    await fill('opening', '-12.34');
    await submit();
    if (['cash', 'debt', 'payable'].includes(accountType)) {
      assert.equal(sent.length, 1);
      assert.ok(sent[0].type === 'add_account');
      assert.equal(sent[0].accountType, accountType);
      assert.equal(sent[0].openingBalanceCents, -1234);
      assert.match(container.textContent!, accountType === 'cash' ? /negative amount for an overdraft/ : /negative amount for a credit balance/);
    } else {
      assert.equal(sent.length, 0);
      assert.match(container.querySelector('[role="alert"]')!.textContent!, /Opening balance cannot be negative/);
    }
  });
}

test('transaction account choices contain personal accounts without owner labels', async () => {
  const state = fixture();
  state.entities.push({ id: 'legacy-business', name: 'Legacy business', kind: 'business', ownershipBps: 5000 });
  state.accounts.push({ ...state.accounts[0], id: 'business-cash', entityId: 'legacy-business', name: 'Business cash' });
  await act(async () => root.render(createElement(Forms, { kind: 'transaction', state, onCommand: async () => {}, onClose: () => {} })));
  const options = [...container.querySelectorAll('select[name="accountId"] option')].map(option => option.textContent);
  assert.deepEqual(options, ['Choose an account', 'Cash']);
});


for (const committed of ['before failure', 'after failure', 'never'] as const) test(`an uncertain legacy restore committed ${committed} cannot replace later records through a retry`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-legacy-restore-retry-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Unavailable test service.' }, { status: 503 }));
  let state = store.command({ type: 'add_account', entityId: 'personal', name: 'Cash', accountType: 'cash', openingBalanceCents: 100000, openingDate: '2026-01-01', requestId: 'restore-cash' });
  const accountId = state.accounts[0].id;
  const backup = store.export();
  const sent: Command[] = [];
  let closed = 0;
  const onCommand = async (command: Command) => {
    state = await executeCommandWithRecovery('live', command, async (_workspace, entry) => {
      sent.push(entry);
      if (committed === 'before failure') store.command(entry);
      throw new Error('The save response timed out after 3 minutes.');
    }, async () => store.state(), recovered => { state = recovered; render(); });
  };
  const render = () => root.render(createElement(Forms, { kind: 'backup', state, onCommand, onClose: () => { closed++; } }));
  await act(async () => render());
  const file = container.querySelector<HTMLInputElement>('input[accept=".json,.gz,application/json,application/gzip"]')!;
  Object.defineProperty(file, 'files', { value: [new File([JSON.stringify(backup)], 'original-backup.json')] });
  await act(async () => { file.dispatchEvent(new Event('change', { bubbles: true })); await new Promise<void>(resolve => setImmediate(resolve)); });
  await act(async () => container.querySelector<HTMLInputElement>('.mazal-backup-preview input[type="checkbox"]')!.click());
  await submit();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].type === 'restore');
  assert.equal(sent[0].expectedRevision, backup.data.revision);
  assert.match(container.textContent!, /could not confirm whether the backup restore completed/);
  assert.equal(file.matches(':disabled'), true);
  await submit();
  assert.equal(sent.length, 1);

  if (committed === 'after failure') store.command(sent[0]);
  state = store.command({ type: 'add_transaction', kind: 'expense', accountId, amountCents: 1234, date: '2026-10-16', description: 'Expense after uncertain restore', category: 'Test', requestId: 'after-uncertain-restore' });
  const saved = structuredClone(state);
  await act(async () => render());
  assert.equal(button('Review updated records').disabled, true);
  await act(async () => button('Review updated records').click());
  await submit();
  assert.equal(sent.length, 1);
  assert.equal(file.matches(':disabled'), true);
  assert.match(container.textContent!, /original-backup\.json/);
  assert.deepEqual(store.state(), saved);

  await act(async () => { button('Close and check records').focus(); button('Close and check records').click(); });
  assert.match(container.textContent!, /Closing this form does not undo it/);
  await act(async () => { button('Keep editing').click(); await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
  assert.equal(closed, 0);
  assert.match(document.activeElement?.textContent ?? '', /could not confirm whether the backup restore completed/);
  await submit();
  assert.equal(sent.length, 1);
  await act(async () => button('Close and check records').click());
  await act(async () => button('Close and check records').click());
  assert.equal(closed, 1);
  assert.deepEqual(store.state(), saved);
});

test('a definitively rejected legacy restore unlocks its backup and requires confirmation before retrying', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Unavailable test service.' }, { status: 503 }));
  const state = fixture();
  const backup = { format: 'mazal-backup', version: 1, workspace: 'live', exportedAt: '2026-10-16T12:00:00.000Z', data: state };
  const sent: Command[] = [];
  let closed = 0;
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state, onCommand: async command => {
    sent.push(command);
    if (sent.length === 1) throw new CommandRejectedError('Choose a valid Mazal backup.', 422);
  }, onClose: () => { closed++; } })));
  const file = container.querySelector<HTMLInputElement>('input[accept=".json,.gz,application/json,application/gzip"]')!;
  Object.defineProperty(file, 'files', { value: [new File([JSON.stringify(backup)], 'backup.json')] });
  await act(async () => { file.dispatchEvent(new Event('change', { bubbles: true })); await new Promise<void>(resolve => setImmediate(resolve)); });
  const confirmation = container.querySelector<HTMLInputElement>('.mazal-backup-preview input[type="checkbox"]')!;
  await act(async () => confirmation.click());
  await submit();
  assert.equal(file.matches(':disabled'), false);
  assert.equal(confirmation.checked, false);
  assert.equal(button('Restore backup').disabled, true);
  assert.match(container.textContent!, /Choose a valid Mazal backup/);
  await submit();
  assert.equal(sent.length, 1);
  await act(async () => confirmation.click());
  await submit();
  assert.equal(sent.length, 2);
  assert.equal(closed, 0);
  assert.match(container.textContent!, /Backup restored/);
  assert.equal(container.querySelector('.mazal-backup-preview'), null);
});

for (const workspace of ['live', 'demo'] as const) {
  test(`Backups and data exposes the ${workspace} original-file archive beside the record backup`, async () => {
    const state = { ...fixture(), workspace };
    const sent: Command[] = [];
    await act(async () => root.render(createElement(Forms, { kind: 'backup', state, onCommand: async command => { sent.push(command); }, onClose: () => {} })));
    const section = button('Download backup').closest('section')!;
    const archive = button('Download original files');
    assert.ok(archive);
    assert.equal(archive.textContent, 'Download original files');
    assert.equal(archive.closest('section'), section);
    assert.match(section.textContent!, /separate archive of original documents, reviewed source files, and their metadata/);
    assert.match(section.textContent!, /Keep both downloads together/);
    assert.doesNotMatch(section.textContent!, /on Documents/);
    assert.equal(archive.closest('fieldset')?.disabled, false);
    assert.equal(sent.length, 0);
  });
}

test('an original-file export error stays in the backup dialog and retry downloads the verified archive', async t => {
  let attempts = 0;
  const downloads: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === '/api/documents/export?workspace=live') {
      attempts++;
      return attempts === 1 ? Response.json({ error: 'The original document no longer matches its saved SHA-256.' }, { status: 500 }) : new Response(new Uint8Array([31, 139, 8]), { headers: { 'Content-Type': 'application/gzip' } });
    }
    return Response.json({ error: 'Unavailable test service.' }, { status: 503 });
  });
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { downloads.push(this.download); });
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state: fixture(), onCommand: async () => { assert.fail('Downloads must not submit financial changes.'); }, onClose: () => {} })));
  await act(async () => button('Download original files').click());
  assert.equal(attempts, 1);
  assert.ok([...container.querySelectorAll('[role="alert"]')].some(alert => /SHA-256/.test(alert.textContent ?? '')));
  assert.deepEqual(downloads, []);
  assert.equal(button('Download original files').disabled, false);
  await act(async () => button('Download original files').click());
  assert.equal(downloads.length, 1);
  assert.match(downloads[0], /^mazal-documents-live-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
  assert.match(container.textContent!, /Original-file download started/);
});

for (const originals of [false, true]) for (const phase of ['fetch', 'body'] as const) test(`the ${originals ? 'original-file' : 'financial'} backup ${phase} timeout unlocks the dialog and ignores a late download`, async t => {
  const url = originals ? '/api/documents/export?workspace=live' : '/api/backup?workspace=live&format=gzip';
  const label = originals ? 'Download original files' : 'Download backup';
  const requests: RequestInit[] = [];
  const downloads: string[] = [];
  let completeLate!: () => void;
  t.mock.method(globalThis, 'fetch', async (path: string, options?: RequestInit) => {
    if (path !== url) return Response.json({ error: 'Unavailable test service.' }, { status: 503 });
    requests.push(options!);
    const blob = new Blob([new Uint8Array([31, 139, 8])], { type: 'application/gzip' });
    const response = new Response(blob);
    if (requests.length > 1) return response;
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    t.mock.method(response, 'blob', () => new Promise(resolve => { completeLate = () => resolve(blob); }));
    return response;
  });
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { downloads.push(this.download); });
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state: fixture(), onCommand: async () => { assert.fail('Downloads must not submit financial changes.'); }, onClose: () => {} })));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await act(async () => button(label).click());
  assert.equal(button('Done').disabled, true);
  await act(async () => t.mock.timers.tick(179_999));
  assert.equal(requests[0].signal!.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(requests[0].signal!.aborted, true);
  const error = [...container.querySelectorAll('[role=alert]')].find(node => /timed out after 3 minutes/.test(node.textContent ?? ''))!;
  assert.ok(error); assert.equal(document.activeElement, error);
  assert.equal(button('Done').disabled, false);
  assert.equal(button(label).disabled, false);
  assert.equal(requests.length, 1); assert.deepEqual(downloads, []);
  await act(async () => completeLate());
  assert.deepEqual(downloads, []);
  await act(async () => button(label).click());
  assert.equal(requests.length, 2); assert.equal(downloads.length, 1);
  assert.match(downloads[0], originals ? /^mazal-documents-live-.*\.tar\.gz$/ : /^mazal-live-.*\.json\.gz$/);
});

test('unmounting a financial backup download aborts it and prevents a late download', async t => {
  let signal!: AbortSignal;
  let completeLate!: () => void;
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (!url.startsWith('/api/backup?')) return Response.json({ error: 'Unavailable test service.' }, { status: 503 });
    signal = options!.signal!;
    return new Promise<Response>(resolve => { completeLate = () => resolve(new Response(new Uint8Array([31, 139, 8]))); });
  });
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', () => { assert.fail('An unmounted form must not trigger a download.'); });
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state: fixture(), onCommand: async () => {}, onClose: () => {} })));
  await act(async () => button('Download backup').click());
  await act(async () => root.render(null));
  assert.equal(signal.aborted, true);
  await act(async () => completeLate());
});

for (const scenario of [
  { operation: 'preview', close: 'Escape' },
  { operation: 'restore', close: 'Escape' },
  { operation: 'preview', close: 'Done' },
  { operation: 'preview', close: 'Close' },
] as const) test(`Keep editing after ${scenario.close} restores ${scenario.close === 'Escape' ? 'the focused' : 'the field before the'} complete-backup ${scenario.operation} timeout alert`, async t => {
  const preview = { token: 'synthetic-preview', exportedAt: '2026-10-16T10:00:00.000Z', encrypted: true, archiveSha256: 'a'.repeat(64), expectedRevision: 1, files: 4, bytes: 100, workspaces: { live: { revision: 1, transactions: 0, documents: 0, unlinkedDocuments: 0 }, demo: { revision: 1, transactions: 0, documents: 0, unlinkedDocuments: 0 } }, calculationFiles: 0 };
  let attempts = 0, closed = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes(`/complete-backup/${scenario.operation}?`)) { attempts++; return new Promise<Response>(() => {}); }
    if (url.includes('/complete-backup/preview?')) return Response.json(preview);
    return Response.json({ error: 'Unavailable test service.' }, { status: 503 });
  });
  await act(async () => root.render(createElement(Forms, { kind: 'backup', state: fixture(), onCommand: async () => {}, onClose: () => { closed++; } })));
  const region = button('Download complete backup').closest('section')!;
  const file = region.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, 'files', { value: [new File(['synthetic archive'], 'backup.mazal')] });
  await act(async () => file.dispatchEvent(new Event('change', { bubbles: true })));
  const password = region.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => password.focus());
  if (scenario.operation === 'restore') {
    await act(async () => button('Verify complete backup').click());
    const confirmation = region.querySelector<HTMLInputElement>('.mazal-backup-preview input[type="checkbox"]')!;
    await act(async () => { confirmation.focus(); confirmation.click(); });
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const action = button(scenario.operation === 'preview' ? 'Verify complete backup' : 'Restore complete backup');
  await act(async () => { action.focus(); action.click(); });
  await act(async () => t.mock.timers.tick(180_000));
  const error = region.querySelector<HTMLElement>('[role="alert"][tabindex]')!;
  assert.match(error.textContent!, /timed out/);
  assert.ok(document.activeElement === error, 'The timeout alert should own focus before closing.');
  if (scenario.operation === 'restore') assert.equal(region.querySelector<HTMLInputElement>('.mazal-backup-preview input[type="checkbox"]')!.disabled, true);
  await act(async () => {
    if (scenario.close === 'Escape') container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    else {
      const close = scenario.close === 'Done' ? button('Done') : container.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!;
      close.focus(); close.click();
    }
  });
  assert.ok(document.activeElement === button('Keep editing'), 'The discard prompt should initially focus Keep editing.');
  await act(async () => { button('Keep editing').click(); await new Promise(resolve => window.requestAnimationFrame(resolve)); });
  assert.ok(document.activeElement === (scenario.close === 'Escape' ? error : password), 'Keep editing should restore the alert for Escape and the previous field for close buttons.');
  assert.equal(attempts, 1); assert.equal(closed, 0);
});


test('a confirmed server rejection keeps the form editable and gives the corrected save a fresh request', async () => {
  const sent: Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind: 'account', state: fixture(), onCommand: async command => { sent.push(command); if (sent.length === 1) throw new CommandRejectedError('Account name already used.', 400); }, onClose: () => {} })));
  await fill('name', 'Existing'); await fill('opening', '100'); await submit();
  assert.match(container.textContent!, /Account name already used/);
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, false);
  await fill('name', 'New account'); await fill('opening', '120'); await submit();
  assert.equal(sent.length, 2); assert.ok(sent[0].type === 'add_account' && sent[1].type === 'add_account');
  assert.notEqual(sent[0].requestId, sent[1].requestId); assert.equal(sent[1].name, 'New account'); assert.equal(sent[1].openingBalanceCents, 12000);
});

test('a closed investment balance editor never substitutes another open account', async () => {
  const state = fixture();
  state.accounts.push({id:'closed',entityId:'personal',name:'Old investment',type:'investment',currency:'CAD',balanceCents:0,reconciledAt:null,closedAt:'2026-01-01'});
  const sent:Command[] = [];
  await act(async () => root.render(createElement(Forms, { kind:'reconcile', accountId:'closed', state, onCommand:async command=>{sent.push(command);}, onClose:()=>{} })));
  assert.equal(container.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!.value,'');
  assert.match(container.textContent!,/The selected account is closed or unavailable/);
  await fill('balance','25');
  await fill('note','Statement balance');
  await submit();
  assert.equal(sent.length,0);
  assert.match(container.textContent!,/Account is required/);
});
