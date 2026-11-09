import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createStore } from '../server/store.ts';
import { createDocumentStore } from '../server/documents.ts';
import { csvHeaders, defaultStatementMapping, mapStatementCSV } from '../shared/statement-mapping.ts';
import type { AppState, Command } from '../shared/types.ts';
import { CommandRejectedError } from './services/command-errors.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLDialogElement', 'Event'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) for (const extension of ['.ts', '.tsx']) {
      const url = new URL(`${specifier}${extension}`, context.parentURL);
      if (existsSync(url)) return nextResolve(url.href, context);
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
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'cash', entityId: 'personal', name: 'Cash', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
const csv = '\uFEFFTransactionDate,PostingDate,Description,Amount\r\n2026-01-02,2026-01-03," Shop, café ",-10.25\r\n2026-01-02,2026-01-03," Shop, café ",-10.25\r\n2026-01-04,2026-01-05,Refund,5.50\r\n2026-01-08,2026-01-09,Card payment,-100.00\r\n';
const csvHash = createHash('sha256').update(csv).digest('hex');
function button(label: string) {
  const result = [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
  assert.ok(result, `Missing button ${label}`);
  return result;
}
async function fill(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  assert.ok(input, `Missing input ${name}`);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function chooseFile(contents = csv, name = 'Statement.csv') {
  const input = container.querySelector<HTMLInputElement>('input[name="statementFile"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([contents], name, { type: 'text/csv' })] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let index = 0; index < 30 && (index === 0 || container.textContent?.includes('Reading statement…')); index++) await new Promise(resolve => setTimeout(resolve, 5));
  });
}
async function details(closing = '885.00') {
  await fill('periodStart', '2026-01-01'); await fill('periodEnd', '2026-01-31'); await fill('opening', '1000.00'); await fill('closing', closing);
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
function uploadResult() { return new Response(JSON.stringify({ document: { sha256: csvHash, bytes: Buffer.byteLength(csv), mimeType: 'text/csv; charset=utf-8', originalName: 'Statement.csv' } }), { status: 201, headers: { 'Content-Type': 'application/json' } }); }
beforeEach(async () => { await act(async () => root.unmount()); root = createRoot(container); globalThis.fetch = originalFetch; window.location.hash = ''; localStorage.clear(); });
after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); globalThis.fetch = originalFetch; });

test('Import statement uploads exact CSV bytes and stages the whole source without recording transactions or classifications', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-intake-ui-'));
  const store = createStore(join(directory, 'finance.sqlite'), 'live');
  let state = store.state();
  state = store.command({ type: 'add_account', entityId: state.entities[0].id, name: 'Bank', accountType: 'cash', openingBalanceCents: 100000, openingDate: '2026-01-01', expectedRevision: state.revision, requestId: 'bank' });
  const documents = createDocumentStore(join(directory, 'documents'), accountId => store.state().accounts.some(account => account.id === accountId));
  t.after(() => { documents.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = structuredClone(state);
  const sent: Command[] = [];
  let uploadCount = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/documents?workspace=live'); assert.equal(init?.method, 'POST'); uploadCount++;
    const bytes = Buffer.from(init?.body as ArrayBuffer);
    assert.deepEqual(bytes, Buffer.from(csv));
    const metadata = JSON.parse(decodeURIComponent(new Headers(init?.headers).get('X-Mazal-Document')!));
    assert.equal(metadata.periodStart, '2026-01-01'); assert.equal(metadata.periodEnd, '2026-01-31');
    return new Response(JSON.stringify(documents.upload(bytes, metadata)), { status: 201 });
  };
  let closed = 0;
  await act(async () => root.render(createElement(Forms, { kind: 'import', state, onCommand: async command => { sent.push(command); state = store.command(command); }, onClose: () => { closed++; } })));
  assert.equal(container.textContent!.includes('Uncheck transfers'), false);
  await chooseFile(); await details();
  assert.equal(button('Stage for review').disabled, false);
  assert.equal(uploadCount, 0);
  button('Stage for review').focus();
  await submit();
  assert.equal(uploadCount, 1); assert.equal(sent.length, 1); assert.equal(sent[0].type, 'stage_statement');
  const batch = state.importBatches![0];
  assert.equal(batch.status, 'staged'); assert.equal(batch.source.sha256, csvHash); assert.equal(batch.source.rows.length, 4);
  assert.deepEqual(batch.decisions, []);
  assert.equal(batch.source.rows[0].description, ' Shop, café '); assert.equal(batch.source.rows[0].transactionDate, '2026-01-02'); assert.equal(batch.source.rows[0].postingDate, '2026-01-03');
  assert.equal(batch.source.rows[2].amountCents, 550); assert.equal(batch.source.rows[3].amountCents, -10000);
  assert.deepEqual(state.accounts, before.accounts); assert.deepEqual(state.transactions, before.transactions);
  assert.deepEqual(documents.content(csvHash).bytes, Buffer.from(csv));
  assert.match(container.textContent!, /Balances and spending have not changed/);
  assert.equal(document.activeElement, button('Review statement'));
  await act(async () => button('Review statement').click());
  assert.equal(closed, 1); assert.equal(window.location.hash, '#documents/imports');
});

test('missing balances, missing posting dates and reconciliation differences never upload or stage', async () => {
  const sent: Command[] = []; let uploads = 0;
  globalThis.fetch = async () => { uploads++; return uploadResult(); };
  await act(async () => root.render(createElement(Forms, { kind: 'import', state: fixture(), onCommand: async command => { sent.push(command); }, onClose: () => {} })));
  await chooseFile('Date,Description,Amount\n2026-01-01,Shop,-5');
  assert.match(container.textContent!, /Map bank columns.*required/s);
  assert.equal(button('Stage for review').disabled,true);
  await submit();assert.match(container.querySelector('[role="alert"]')!.textContent!,/Apply the column mapping/);
  assert.equal(uploads,0);
  await chooseFile();
  assert.match(container.textContent!,/Discard this import draft/);
  await act(async()=>{button('Discard changes').click();for(let index=0;index<30;index++){await new Promise(resolve=>setTimeout(resolve,5));if(!container.textContent?.includes('Reading statement…'))break;}});
  await submit(); assert.equal(uploads, 0); assert.equal(sent.length, 0);
  await details('884.99');
  assert.equal(button('Stage for review').disabled, true);
  await submit(); assert.match(container.querySelector('[role="alert"]')!.textContent!, /differs by \$0.01/);
  assert.equal(uploads, 0); assert.equal(sent.length, 0);
  await fill('closing', '885.00'); await fill('periodStart', '2026-01-04');
  await submit(); assert.match(container.querySelector('[role="alert"]')!.textContent!, /Every posting date/);
  assert.equal(uploads, 0);
});

test('upload failure keeps the complete draft and a verified retry stages once', async () => {
  const sent: Command[] = []; let uploads = 0;
  globalThis.fetch = async () => { uploads++; return uploads === 1 ? new Response(JSON.stringify({ error: 'Original storage unavailable' }), { status: 503 }) : uploadResult(); };
  await act(async () => root.render(createElement(Forms, { kind: 'import', state: fixture(), onCommand: async command => { sent.push(command); }, onClose: () => {} })));
  await chooseFile(); await details(); await submit();
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Original storage unavailable/);
  assert.equal(sent.length, 0); assert.equal(container.querySelector<HTMLInputElement>('[name="closing"]')!.value, '885.00');
  await submit(); assert.equal(uploads, 2); assert.equal(sent.length, 1);
});

for (const scenario of [
  { phase: 'fetch', persisted: false },
  { phase: 'fetch', persisted: true },
  { phase: 'body', persisted: true },
] as const) test(`a stalled upload ${scenario.phase} ${scenario.persisted ? 'after' : 'before'} saving keeps the draft and a manual retry preserves one original`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-intake-timeout-'));
  const documents = createDocumentStore(directory, accountId => accountId === 'cash');
  t.after(() => { documents.close(); rmSync(directory, { recursive: true, force: true }); });
  const metadata = { originalName: 'Statement.csv', kind: 'statement', accountId: 'cash', periodStart: '2026-01-01', periodEnd: '2026-01-31' };
  if (scenario.phase === 'body') documents.upload(Buffer.from(csv), { ...metadata, originalName: 'Archived statement.csv' });
  const sent: Command[] = [];
  const requests: RequestInit[] = [];
  let completeLate!: () => void;
  globalThis.fetch = async (_url, init) => {
    requests.push(init!);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(Buffer.from(init?.body as ArrayBuffer), Buffer.from(csv));
    const submitted = JSON.parse(decodeURIComponent(new Headers(init?.headers).get('X-Mazal-Document')!));
    assert.deepEqual(submitted, metadata);
    const result = requests.length > 1 || scenario.persisted ? documents.upload(Buffer.from(init?.body as ArrayBuffer), submitted) : null;
    const response = result ? Response.json(result, { status: result.duplicate ? 200 : 201 }) : uploadResult();
    if (requests.length > 1) return response;
    if (scenario.phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    t.mock.method(response, 'json', () => new Promise(resolve => { completeLate = () => resolve(result); }));
    return response;
  };
  await act(async () => root.render(createElement(Forms, { kind: 'import', state: fixture(), onCommand: async command => { sent.push(command); }, onClose: () => {} })));
  await chooseFile(); await details();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await submit();
  assert.equal(button('Cancel').disabled, true);
  await act(async () => t.mock.timers.tick(59_999));
  assert.equal(requests[0].signal!.aborted, false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(requests[0].signal!.aborted, true);
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /timed out after 60 seconds.*original may already be saved.*No statement was staged/s);
  assert.equal(button('Cancel').disabled, false);
  assert.equal(button('Stage for review').disabled, false);
  assert.equal(container.querySelector<HTMLInputElement>('[name="opening"]')!.value, '1000.00');
  assert.equal(container.querySelector<HTMLInputElement>('[name="closing"]')!.value, '885.00');
  assert.equal(container.querySelectorAll('.statement-intake-preview tbody tr').length, 4);
  const status = { ready: false, dirty: false, busy: false };
  window.dispatchEvent(new dom.window.CustomEvent('mazal:check-drafts', { detail: status }));
  assert.equal(status.dirty, true); assert.equal(status.busy, false);
  assert.equal(requests.length, 1); assert.equal(sent.length, 0);
  const savedOriginal = documents.list().documents[0];
  assert.equal(documents.list().documents.length, scenario.persisted ? 1 : 0);
  await act(async () => { completeLate(); });
  assert.equal(requests.length, 1); assert.equal(sent.length, 0);
  assert.equal(button('Stage for review').disabled, false);
  await submit();
  assert.equal(requests.length, 2); assert.equal(sent.length, 1);
  assert.equal(new Headers(requests[1].headers).get('X-Mazal-Document'), new Headers(requests[0].headers).get('X-Mazal-Document'));
  assert.deepEqual(Buffer.from(requests[1].body as ArrayBuffer), Buffer.from(requests[0].body as ArrayBuffer));
  assert.equal(documents.list().documents.length, 1);
  if (savedOriginal) assert.deepEqual(documents.list().documents[0], savedOriginal);
  assert.deepEqual(documents.content(csvHash).bytes, Buffer.from(csv));
  assert.equal(sent[0].type, 'stage_statement');
  if (sent[0].type !== 'stage_statement') throw new Error('Expected a statement import');
  assert.equal(sent[0].statement.sha256, csvHash);
  assert.equal(sent[0].statement.sourceFile, scenario.phase === 'body' ? 'Archived statement.csv' : 'Statement.csv');
  assert.equal(sent[0].statement.accountId, 'cash');
  assert.equal(sent[0].statement.periodStart, '2026-01-01');
  assert.equal(sent[0].statement.periodEnd, '2026-01-31');
  assert.equal(sent[0].statement.openingBalanceCents, 100000);
  assert.equal(sent[0].statement.closingBalanceCents, 88500);
  assert.equal(sent[0].statement.rows.length, 4);
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(requests[1].signal!.aborted, false);
  assert.equal(sent.length, 1);
});

for (const phase of ['fetch', 'body'] as const) test(`closing the intake during a pending upload ${phase} aborts it and cannot stage a late original`, async t => {
  const sent: Command[] = [];
  let signal: AbortSignal | undefined;
  let completeLate!: () => void;
  let uploads = 0;
  globalThis.fetch = async (_url, init) => {
    uploads++; signal = init?.signal!;
    const response = uploadResult();
    if (phase === 'fetch') return new Promise<Response>(resolve => { completeLate = () => resolve(response); });
    const result = await response.json();
    t.mock.method(response, 'json', () => new Promise(resolve => { completeLate = () => resolve(result); }));
    return response;
  };
  await act(async () => root.render(createElement(Forms, { kind: 'import', state: fixture(), onCommand: async command => { sent.push(command); }, onClose: () => {} })));
  await chooseFile(); await details();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await submit();
  assert.equal(signal!.aborted, false);
  await act(async () => root.render(null));
  assert.equal(signal!.aborted, true);
  const reason = signal!.reason;
  await act(async () => { completeLate(); });
  await act(async () => t.mock.timers.tick(60_000));
  assert.equal(signal!.reason, reason);
  assert.equal(uploads, 1); assert.equal(sent.length, 0);
});

test('unverified original response cannot stage a source', async () => {
  const sent: Command[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ document: { sha256: '0'.repeat(64), bytes: Buffer.byteLength(csv), mimeType: 'text/csv; charset=utf-8', originalName: 'Statement.csv' } }), { status: 201 });
  await act(async () => root.render(createElement(Forms, { kind: 'import', state: fixture(), onCommand: async command => { sent.push(command); }, onClose: () => {} })));
  await chooseFile(); await details(); await submit();
  assert.equal(sent.length, 0); assert.match(container.querySelector('[role="alert"]')!.textContent!, /saved original could not be verified/);
});

test('stale intake retains fields and a lost staging response retries the same source and request ID', async () => {
  let state = fixture(); let uploads = 0; const sent: Command[] = [];
  globalThis.fetch = async () => { uploads++; return uploadResult(); };
  const render = () => root.render(createElement(Forms, { kind: 'import', state, onCommand: async command => {
    sent.push(command);
    if (sent.length === 1) { state = { ...state, revision: state.revision + 1 }; render(); throw new Error('Could not confirm the save.'); }
  }, onClose: () => {} }));
  await act(async () => render()); await chooseFile(); await details();
  state = { ...state, revision: 2 }; await act(async () => render());
  assert.equal(button('Stage for review').disabled, true); await submit(); assert.equal(uploads, 0);
  await act(async () => button('Review updated records').click()); await submit();
  assert.equal(sent.length, 1); assert.equal(uploads, 1); assert.match(container.querySelector('[role="alert"]')!.textContent!, /confirm the save/);
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true);
  assert.equal(container.querySelector<HTMLInputElement>('[name="opening"]')!.value, '1000.00');
  await act(async () => button('Review updated records').click()); await submit();
  assert.equal(uploads, 1); assert.equal(sent.length, 2);
  assert.equal(sent[0].type, 'stage_statement'); assert.equal(sent[1].type, 'stage_statement');
  if (sent[0].type !== 'stage_statement' || sent[1].type !== 'stage_statement') throw new Error('Expected staging');
  assert.equal(sent[0].requestId, sent[1].requestId); assert.deepEqual(sent[0].statement, sent[1].statement); assert.equal(sent[1].expectedRevision, 3);
});

test('a rejected statement import keeps the saved original and releases entries for correction', async () => {
  globalThis.fetch = async () => uploadResult();
  await act(async () => root.render(createElement(Forms, { kind: 'import', state: fixture(), onCommand: async () => { throw new CommandRejectedError('The statement was rejected.', 400); }, onClose: () => {} })));
  await chooseFile(); await details(); await submit();
  assert.match(container.querySelector('[role=alert]')!.textContent!, /was rejected/);
  assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, false);
  await fill('opening', '2000.00');
  assert.equal(container.querySelector<HTMLInputElement>('[name="opening"]')!.value, '2000.00');
  assert.match(container.textContent!, /Original CSV saved/);
});

test('cancel protects an entered import draft until discard is explicit', async () => {
  let closed = 0; let commands = 0;
  await act(async () => root.render(createElement(Forms, { kind: 'import', state: fixture(), onCommand: async () => { commands++; }, onClose: () => { closed++; } })));
  const opening = container.querySelector<HTMLInputElement>('[name="opening"]')!;
  opening.focus(); await fill('opening', '10.00');
  await act(async () => { button('Cancel').focus(); button('Cancel').click(); });
  assert.equal(closed, 0); assert.match(container.textContent!, /Discard this import draft/);
  assert.equal(document.activeElement, button('Keep editing'));
  await act(async () => button('Keep editing').click());
  await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
  assert.equal(document.activeElement, opening);
  assert.equal(opening.value, '10.00');
  await act(async () => { button('Cancel').focus(); button('Cancel').click(); });
  assert.equal(document.activeElement, button('Keep editing'));
  await act(async () => container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })));
  await act(async () => { await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
  assert.equal(document.activeElement, opening);
  assert.equal(opening.value, '10.00');
  assert.equal(closed, 0); assert.equal(commands, 0);
  await act(async () => button('Cancel').click()); await act(async () => button('Discard changes').click()); assert.equal(closed, 1);
});

test('changing a CSV mapping hides the previous preview until reapplied and confirms saved presets', async () => {
  let writes = 0;
  globalThis.fetch = async () => { writes++; return uploadResult(); };
  await act(async () => root.render(createElement(Forms, { kind: 'import', state: fixture(), onCommand: async () => { writes++; }, onClose: () => {} })));
  await chooseFile(); await details();
  assert.equal(container.querySelectorAll('.statement-intake-preview tbody tr').length, 4);
  assert.equal(button('Stage for review').disabled, false);
  const direction = [...container.querySelectorAll('label')].find(node => node.textContent?.startsWith('Amount direction'))!.querySelector('select')!;
  await act(async () => { direction.value = 'invert'; direction.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(container.querySelector('.statement-intake-preview'), null);
  assert.match(container.querySelector('.mazal-import-summary')!.textContent!, /Apply mapping to preview entries/);
  assert.equal(button('Stage for review').disabled, true);
  await act(async () => button('Apply mapping and preview').click());
  assert.equal(container.querySelectorAll('.statement-intake-preview tbody tr').length, 4);
  assert.match(container.querySelector('.statement-intake-balance')!.textContent!, /difference from closing balance/);
  const presetName = container.querySelector<HTMLInputElement>('input[placeholder="Bank export name"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(presetName, 'Bank format'); presetName.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Save reusable mapping').click());
  assert.match(container.textContent!, /Saved mapping "Bank format" in this browser/);
  assert.equal(JSON.parse(localStorage.getItem('mazal:csv-presets:v1')!)[0].mapping.sign, 'invert');
  assert.equal(writes, 0);
});

for (const preset of [false, true]) test(`mapped CSV intake submits the applied ${preset ? 'saved preset' : 'column choices'} with unchanged original bytes`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-mapped-intake-ui-'));
  const documents = createDocumentStore(directory);
  t.after(() => { documents.close(); rmSync(directory, { recursive: true, force: true }); });
  const text = 'Date,Details,Withdrawals,Deposits\r\n01/02/2026,"Groceries, local",10.00,\r\n';
  const mapping = { ...defaultStatementMapping(csvHeaders(text)), mode: 'split' as const, dateFormat: 'mdy' as const, sameDate: true };
  const sent: Command[] = [];
  if (preset) localStorage.setItem('mazal:csv-presets:v1', JSON.stringify([{ name: 'Bank', headers: csvHeaders(text), mapping }]));
  globalThis.fetch = async (_url, init) => {
    const bytes = Buffer.from(init?.body as ArrayBuffer);
    assert.deepEqual(bytes, Buffer.from(text));
    const metadata = JSON.parse(decodeURIComponent(new Headers(init?.headers).get('X-Mazal-Document')!));
    return new Response(JSON.stringify(documents.upload(bytes, metadata)), { status: 201 });
  };
  await act(async () => root.render(createElement(Forms, { kind: 'import', state: fixture(), onCommand: async command => { sent.push(command); }, onClose: () => {} })));
  await chooseFile(text, 'Bank.csv');
  if (!preset) {
    const select = async (label: string, value: string) => {
      const input = [...container.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))?.querySelector('select');
      assert.ok(input, `Missing ${label}`);
      await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); });
    };
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await select('Date format', 'mdy');
    await select('Amount columns', 'split');
    await act(async () => button('Apply mapping and preview').click());
  }
  await details('990.00');
  assert.equal(button('Stage for review').disabled, false);
  await submit();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'stage_statement');
  if (sent[0].type !== 'stage_statement') throw new Error('Expected a statement import');
  assert.deepEqual(sent[0].statement.csvMapping, mapping);
  assert.deepEqual(sent[0].statement.rows, mapStatementCSV(text, mapping));
  assert.deepEqual(documents.content(sent[0].statement.sha256).bytes, Buffer.from(text));
});

test('statement review links an existing manual expense and enables commit without posting it twice', async t => {
  const { default: ImportQueue } = await import('./features/records/ImportQueue.tsx');
  const directory = mkdtempSync(join(tmpdir(), 'mazal-match-ui-'));
  const store = createStore(join(directory, 'live.sqlite'), 'live');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (input: Command) => store.command({ ...input, expectedRevision: store.state().revision });
  command({ type: 'add_account', entityId: 'personal', name: 'Bank', accountType: 'cash', openingBalanceCents: 10000, openingDate: '2026-01-01' });
  const accountId = store.state().accounts[0].id;
  command({ type: 'add_transaction', kind: 'expense', accountId, amountCents: 1000, date: '2026-01-10', description: 'Manual groceries', category: 'Groceries', requestId: 'manual' });
  const manual = store.state().transactions.find(tx => tx.kind === 'expense')!;
  command({ type: 'stage_statement', requestId: 'stage', statement: { id: 'january', accountId, sourceFile: 'January.pdf', sha256: 'a'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 9000, rows: [{ id: 'row1', transactionDate: '2026-01-10', postingDate: '2026-01-12', description: 'BANK GROCERIES', amountCents: -1000, sourcePage: 1 }] } });
  command({ type: 'review_statement', importId: 'january', requestId: 'initial-review', decisions: [{ rowId: 'row1', kind: 'expense', category: 'Food' }] });
  let state = store.state();
  const render = () => root.render(createElement(ImportQueue, { state, scope: 'personal', onCommand: async input => { state = store.command(input); render(); } }));
  await act(async () => render());
  assert.equal(button('Record 1 statement').disabled, true);
  assert.match(container.textContent!, /Unmatched: Manual groceries/);
  await act(async () => button('Review entries').click());
  await act(async () => button('expense · Food').click());
  const select = [...container.querySelectorAll('label')].find(label => label.textContent?.startsWith('Existing recorded entry'))!.querySelector('select')!;
  assert.match(select.textContent!, /Manual groceries/);
  await act(async () => { select.value = JSON.stringify({ transactionId: manual.id }); select.dispatchEvent(new Event('change', { bubbles: true })); });
  const category = container.querySelector<HTMLInputElement>('.import-editor input[list]')!;
  assert.equal(category.value, 'Groceries'); assert.equal(category.disabled, true);
  assert.match(container.textContent!, /No second transaction is recorded/);
  await act(async () => button('Save classification').click());
  assert.equal(button('Record 1 statement').disabled, false);
  await act(async () => button('Record 1 statement').click());
  assert.equal(state.accounts[0].balanceCents, 9000);
  assert.equal(state.transactions.filter(tx => tx.kind === 'expense').length, 1);
  assert.deepEqual(state.transactions.find(tx => tx.id === manual.id)?.importSources, [{ importId: 'january', rowId: 'row1' }]);
});
