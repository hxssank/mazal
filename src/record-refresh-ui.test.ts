import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import { engineFixtureFetch } from './engine-test-fixture.ts';
import type { AppState, Command } from '../shared/types.ts';
import { today } from '../shared/analytics.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'HTMLCanvasElement', 'Event', 'MouseEvent', 'localStorage'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
const media = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, matchMedia: media, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
window.matchMedia = media as unknown as typeof window.matchMedia;
window.scrollTo = () => {};
HTMLElement.prototype.scrollIntoView = () => {};
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
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
const { createElement: reactCreateElement, act } = await import('react');
let engineState: AppState | undefined;
const createElement = ((type: unknown, props?: { state?: AppState }, ...children: unknown[]) => {
  if (props?.state) engineState = props.state;
  return reactCreateElement(type as never, props as never, ...children as never[]);
}) as typeof reactCreateElement;
const { createRoot } = await import('react-dom/client');
const { default: App } = await import('./app/App.tsx');
const { default: ErrorBoundary } = await import('./components/ErrorBoundary.tsx');
const { default: DraftDiscardDialog } = await import('./components/DraftDiscardDialog.tsx');
const { default: Debts } = await import('./features/debts/Debts.tsx');
const { default: Expenses } = await import('./features/expenses/Expenses.tsx');
const { ExpensePay } = await import('./features/expenses/ExpenseOverview.tsx');
const { requestDraftNavigation } = await import('./hooks/draft-protection.ts');
await import('./features/investments/Investments.tsx');
await import('./features/entries/Forms.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  engineState = undefined; globalThis.fetch = engineFixtureFetch(() => engineState);
  await act(async () => root.unmount());
  root = createRoot(container);
  window.history.replaceState(null, '', '/');
});
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });

function recordsFetch(fallback: typeof fetch): typeof fetch {
  return engineFixtureFetch(() => engineState, async (url, init) => {
    if (String(url) === '/api/automatic-backup') return Response.json({ supported: false, unsupportedReason: 'Synthetic runtime', configured: false, enabled: false, destination: null, intervalHours: 24, retentionCount: 14, lastAttemptAt: null, lastSuccessAt: null, lastVerifiedAt: null, lastBackupPath: null, lastBackupSha256: null, lastError: null, nextRunAt: null, running: false });
    const response = await fallback(url, init);
    if (response.status === 304) return response;
    const value = await response.clone().json();
    if (value.workspace && Array.isArray(value.accounts)) engineState = value;
    return response;
  });
}
function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }], accounts: [{ id: 'cash', entityId: 'personal', name: 'Cash', type: 'cash', currency: 'CAD', balanceCents: 100000, reconciledAt: null }], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}
function button(label: string): HTMLButtonElement {
  const item = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === label);
  assert.ok(item, `Button ${label} exists`);
  return item;
}
async function fill(input: HTMLInputElement, value: string) {
  assert.ok(input);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

test('returning to Mazal reads external changes and preserves an open transaction draft', async () => {
  let state = fixture();
  let reads = 0;
  globalThis.fetch = recordsFetch(async () => { reads++; return Response.json(state); });
  await act(async () => root.render(createElement(App)));
  assert.match(container.querySelector('.position-value')!.textContent!, /1,000/);
  await act(async () => button('Add transaction').click());
  await fill(container.querySelector<HTMLInputElement>('input[name="description"]')!, 'Reviewed groceries');
  await fill(container.querySelector<HTMLInputElement>('input[name="amount"]')!, '12.34');
  state = { ...state, revision: 2, accounts: [{ ...state.accounts[0], balanceCents: 90000 }] };
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.equal(reads, 2);
  assert.match(container.querySelector('.position-value')!.textContent!, /900/);
  assert.equal(container.querySelector<HTMLInputElement>('input[name="description"]')!.value, 'Reviewed groceries');
  assert.match(container.textContent!, /Records changed while this form was open/);
  assert.equal(container.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.disabled, true);
  assert.equal(container.querySelector('.toast'), null);
  await act(async () => button('Review updated records').click());
  assert.equal(container.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.disabled, false);
  assert.match(container.textContent!, /887\.66/);
});

test('unchanged refreshes preserve the draft and same-revision backup updates replace the conditional token', async () => {
  let state = fixture();
  let etag = '"before-backup"';
  const tokens: (string | null)[] = [];
  globalThis.fetch = recordsFetch(async (_url, init) => {
    const token = new Headers(init?.headers).get('If-None-Match');
    tokens.push(token);
    return token === etag ? new Response(null, { status: 304, headers: { ETag: etag } }) : Response.json(state, { headers: { ETag: etag } });
  });
  await act(async () => root.render(createElement(App)));
  await act(async () => button('Add transaction').click());
  await fill(container.querySelector<HTMLInputElement>('input[name="description"]')!, 'Unsaved groceries');
  await fill(container.querySelector<HTMLInputElement>('input[name="amount"]')!, '12.34');
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.equal(container.querySelector('.error-banner'), null);
  assert.equal(container.querySelector<HTMLInputElement>('input[name="description"]')!.value, 'Unsaved groceries');
  assert.equal(container.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.disabled, false);
  state = { ...state, lastBackupAt: '2026-10-19T12:00:00.000Z' };
  etag = '"after-backup"';
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.deepEqual(tokens, [null, '"before-backup"', '"before-backup"', '"after-backup"']);
  assert.equal(container.querySelector('.error-banner'), null);
  assert.equal(container.querySelector<HTMLInputElement>('input[name="description"]')!.value, 'Unsaved groceries');
  assert.equal(container.querySelector<HTMLInputElement>('input[name="amount"]')!.value, '12.34');
  assert.equal(container.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.disabled, false);
});

test('identical records from a new snapshot source require a full read and switch the app to read-only', async () => {
  const state = fixture();
  const etag = '"same-records"';
  let source = 'personal';
  const tokens: (string | null)[] = [];
  globalThis.fetch = recordsFetch(async (_url, init) => {
    const token = new Headers(init?.headers).get('If-None-Match');
    tokens.push(token);
    const headers = { ETag: etag, 'X-Mazal-Data-Source': source };
    return token === etag ? new Response(null, { status: 304, headers }) : Response.json(state, { headers });
  });
  await act(async () => root.render(createElement(App)));
  assert.equal(button('Add transaction').disabled, false);
  source = 'snapshot';
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.deepEqual(tokens, [null, etag, null]);
  assert.equal(container.querySelector('.error-banner'), null);
  assert.equal(button('Add transaction').disabled, true);
  assert.match(container.querySelector('.sample-preview-notice')!.textContent!, /Read-only preview/);
});

test('a failed background refresh keeps the last saved records and a visible retry recovers', async () => {
  let unavailable = false;
  globalThis.fetch = recordsFetch(async () => { if (unavailable) throw new Error('Offline'); return Response.json(fixture()); });
  await act(async () => root.render(createElement(App)));
  unavailable = true;
  await act(async () => window.dispatchEvent(new Event('online')));
  assert.match(container.querySelector('.error-banner')!.textContent!, /could not read your records/);
  assert.match(container.querySelector('.position-value')!.textContent!, /1,000/);
  unavailable = false;
  await act(async () => button('Retry').click());
  assert.equal(container.querySelector('.error-banner'), null);
  await act(async () => container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!.click());
  assert.match(container.querySelector('.record-sync')!.textContent!, /Records checked/);
});

test('unlock before a delayed locked records response refreshes again and preserves the open draft', async () => {
  let reads = 0;
  let resolveLocked!: (response: Response) => void;
  globalThis.fetch = recordsFetch(async () => ++reads === 2 ? new Promise(resolve => { resolveLocked = resolve; }) : Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  await act(async () => button('Add transaction').click());
  await fill(container.querySelector<HTMLInputElement>('input[name="description"]')!, 'Unsaved groceries');
  await fill(container.querySelector<HTMLInputElement>('input[name="amount"]')!, '12.34');
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(reads, 2, 'foreground events do not duplicate an in-flight read');
  await act(async () => resolveLocked(Response.json({ error: 'Mazal is locked.' }, { status: 401 })));
  assert.equal(reads, 3, 'a read interrupted by the prior lock retries after unlock');
  assert.equal(container.querySelector('.error-banner'), null);
  assert.equal(container.querySelector<HTMLInputElement>('input[name="description"]')!.value, 'Unsaved groceries');
  assert.equal(container.querySelector<HTMLInputElement>('input[name="amount"]')!.value, '12.34');
  assert.equal(container.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.disabled, false);
});

test('a delayed locked records response retries only once without another foreground event', async () => {
  let reads = 0;
  let resolveLocked!: (response: Response) => void;
  globalThis.fetch = recordsFetch(async () => {
    reads++;
    if (reads === 1) return Response.json(fixture());
    if (reads === 2) return new Promise(resolve => { resolveLocked = resolve; });
    return Response.json({ error: 'Mazal is locked.' }, { status: 401 });
  });
  await act(async () => root.render(createElement(App)));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => resolveLocked(Response.json({ error: 'Mazal is locked.' }, { status: 401 })));
  assert.equal(reads, 3);
  assert.match(container.querySelector('.error-banner')!.textContent!, /Mazal is locked/);
});

test('foreground changes do not automatically retry a delayed non-authentication records error', async () => {
  let reads = 0;
  let resolveFailure!: (response: Response) => void;
  globalThis.fetch = recordsFetch(async () => ++reads === 2 ? new Promise(resolve => { resolveFailure = resolve; }) : Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => resolveFailure(Response.json({ error: 'Records unavailable.' }, { status: 500 })));
  assert.equal(reads, 2);
  assert.match(container.querySelector('.error-banner')!.textContent!, /Records unavailable/);
});

test('an initial load failure stays actionable until records can be opened', async () => {
  let unavailable = true;
  globalThis.fetch = recordsFetch(async () => { if (unavailable) throw new Error('Offline'); return Response.json(fixture()); });
  await act(async () => root.render(createElement(App)));
  assert.match(container.querySelector('.loading-panel')!.textContent!, /Unable to open records/);
  assert.equal(container.querySelector('.navigation-more-panel'), null);
  assert.ok(container.querySelector('.error-banner [class="button secondary"]'));
  await act(async () => container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!.click());
  assert.match(container.querySelector('.record-sync')!.textContent!, /Records unavailable/);
  assert.equal(container.querySelector('[aria-label="Dismiss error"]'), null);
  unavailable = false;
  await act(async () => button('Retry').click());
  assert.equal(container.querySelector('.error-banner'), null);
  assert.match(container.querySelector('.position-value')!.textContent!, /1,000/);
});

test('an older initial response cannot replace records already read on focus', async () => {
  let resolveInitial!: (response: Response) => void;
  let reads = 0;
  const newer = fixture();
  newer.revision = 2;
  newer.accounts[0].balanceCents = 75000;
  globalThis.fetch = recordsFetch(async () => ++reads === 1 ? new Promise<Response>(resolve => { resolveInitial = resolve; }) : Response.json(newer));
  await act(async () => root.render(createElement(App)));
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.match(container.querySelector('.position-value')!.textContent!, /750/);
  await act(async () => resolveInitial(Response.json(fixture())));
  assert.match(container.querySelector('.position-value')!.textContent!, /750/);
});

test('a superseded initial read failure does not obscure a successful refresh', async () => {
  let rejectInitial!: (error: Error) => void;
  let reads = 0;
  globalThis.fetch = recordsFetch(async () => ++reads === 1 ? new Promise<Response>((_resolve, reject) => { rejectInitial = reject; }) : Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => rejectInitial(new Error('Older request disconnected')));
  assert.equal(container.querySelector('.error-banner'), null);
  assert.match(container.querySelector('.position-value')!.textContent!, /1,000/);
});

function debtFixture(): AppState {
  const state = fixture();
  state.accounts.push({ id: 'loan', entityId: 'personal', name: 'Loan', type: 'debt', currency: 'CAD', balanceCents: 100000, reconciledAt: null, debtTerms: { aprPercent: 10, minimumPaymentCents: 5000, rateConfirmed: true, notes: '' } });
  return state;
}

test('native draft checks block inline saves through success and failed-save recovery', async () => {
  let state = debtFixture();
  state.accounts[1].excludeFromNetWorth = true;
  let resolveSave!: (response: Response) => void;
  let resolveRecovery!: (response: Response) => void;
  let recovering = false;
  const immediateChecks: boolean[] = [];
  globalThis.fetch = recordsFetch(async (_url, init) => {
    if (init?.method === 'POST') {
      immediateChecks.push(nativeStatus().busy);
      assert.equal(requestDraftNavigation(() => { throw new Error('Navigation escaped the save guard.'); }), false);
      assert.equal(window.dispatchEvent(new Event('beforeunload', { cancelable: true })), false);
      return new Promise(resolve => { resolveSave = resolve; });
    }
    if (recovering) return new Promise(resolve => { resolveRecovery = resolve; });
    return Response.json(state);
  });
  const nativeStatus = () => {
    const detail = { ready: false, dirty: false, busy: false };
    window.dispatchEvent(new dom.window.CustomEvent('mazal:check-drafts', { detail }));
    return detail;
  };
  await act(async () => root.render(createElement(App)));
  assert.equal(nativeStatus().busy, false);
  await act(async () => button('Include Loan').click());
  assert.equal(nativeStatus().busy, true);
  state = { ...state, revision: 2, accounts: state.accounts.map(account => ({ ...account, excludeFromNetWorth: false })) };
  await act(async () => resolveSave(Response.json(state)));
  assert.equal(nativeStatus().busy, false);
  state = { ...state, revision: 3, accounts: state.accounts.map(account => ({ ...account, excludeFromNetWorth: account.id === 'loan' })) };
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => button('Include Loan').click());
  recovering = true;
  await act(async () => resolveSave(Response.json({ error: 'Save interrupted.' }, { status: 500 })));
  assert.equal(nativeStatus().busy, true, 'recovery still owns the save until records are checked');
  await act(async () => resolveRecovery(Response.json(state)));
  assert.equal(nativeStatus().busy, false);
  assert.match(container.textContent!, /Save interrupted/);
  assert.deepEqual(immediateChecks, [true, true], 'both commands are protected at the API call, before React commits');
});
const rateInput = () => container.querySelector<HTMLInputElement>('input[aria-label="Debt scenario APR"]')!;

test('debt edits survive a bank review refresh and need explicit review before overwriting terms', async () => {
  let state = debtFixture();
  const commands: Command[] = [];
  const render = () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand: async command => { commands.push(command); } }));
  await act(async () => render());
  await fill(rateInput(), '12');
  state = { ...state, revision: 2, accounts: state.accounts.map(account => account.id === 'loan' ? { ...account, debtTerms: { ...account.debtTerms!, aprPercent: 8, minimumPaymentCents: 6000 } } : account) };
  await act(async () => render());
  assert.equal(rateInput().value, '12');
  assert.equal(button('Save details').disabled, true);
  assert.match(container.textContent!, /Saved APR: 8%/);
  await act(async () => button('Keep my entries').click());
  await act(async () => button('Save details').click());
  assert.equal(commands.length, 1);
  assert.equal(commands[0].expectedRevision, 2);
  assert.ok(commands[0].type === 'set_debt_terms');
  assert.equal(commands[0].terms.aprPercent, 12);
});

test('an untouched debt form adopts reviewed terms and a local draft can load saved details', async () => {
  let state = debtFixture();
  const render = () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand: async () => {} }));
  await act(async () => render());
  state = { ...state, revision: 2, accounts: state.accounts.map(account => account.id === 'loan' ? { ...account, debtTerms: { ...account.debtTerms!, aprPercent: 8 } } : account) };
  await act(async () => render());
  assert.equal(rateInput().value, '8');
  assert.equal(button('Save details').disabled, true);
  await fill(rateInput(), '12');
  state = { ...state, revision: 3 };
  await act(async () => render());
  await act(async () => button('Load saved details').click());
  assert.equal(rateInput().value, '12');
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.draft-discard-dialog button')].find(button=>button.textContent==='Discard changes')!.click());
  assert.equal(rateInput().value, '8');
  assert.equal(button('Save details').disabled, true);
});

test('saving debt details accepts the resulting revision and clears the unsaved state', async () => {
  let state = debtFixture();
  const onCommand = async (command: Command) => {
    assert.ok(command.type === 'set_debt_terms');
    state = { ...state, revision: state.revision + 1, accounts: state.accounts.map(account => account.id === command.accountId ? { ...account, debtTerms: command.terms } : account) };
    render();
  };
  const render = () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand }));
  await act(async () => render());
  await fill(rateInput(), '12');
  await act(async () => button('Save details').click());
  assert.equal(button('Save details').disabled, true);
  assert.equal(container.querySelector('.debt-unsaved'), null);
  assert.doesNotMatch(container.textContent!, /Records changed/);
});

test('debt history counts the debt-side payment once and displays its reversal separately', async () => {
  const state = debtFixture();
  state.transactions = [
    { id: 'bank-side', description: 'Bank card payment', accountId: 'cash', effect: -50000 },
    { id: 'card-side', description: 'Card received payment', accountId: 'loan', effect: -50000 },
    { id: 'reversal', description: 'Payment returned', accountId: 'loan', effect: 50000 },
  ].map(row => ({ id: row.id, description: row.description, accountId: row.accountId, toAccountId: null, kind: 'adjustment', amountCents: 50000, date: today(), createdAt: `${today()}T12:00:00Z`, category: 'Card payment', source: 'Reviewed statement', importSources: [{ importId: 'review', rowId: row.id }], balanceChanges: { [row.accountId]: row.effect } }));
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand: async () => {} })));
  const paid = [...container.querySelectorAll('.debt-summary-metric')].find(item => item.textContent?.includes('Paid this month'))!;
  assert.equal(paid.querySelector('strong')!.textContent, '$500');
  assert.match(paid.textContent!, /\$500 in payment reversals shown separately/);
  const history = container.querySelector('.debt-payment-history')!;
  assert.doesNotMatch(history.textContent!, /Bank card payment/);
  assert.match(history.textContent!, /Card received payment/);
  assert.match(history.textContent!, /Payment reversal\. Debt increased/);
  assert.equal(history.querySelectorAll('.debt-payment-row').length, 2);
});

test('a reversed manual debt payment is shown as increasing debt while the monthly total stays net of the correction', async () => {
  const state = debtFixture();
  const payment: AppState['transactions'][number] = { id: 'manual-payment', description: 'Manual loan payment', accountId: 'cash', toAccountId: 'loan', kind: 'debt_payment', amountCents: 10000, date: today(), createdAt: `${today()}T12:00:00Z`, category: 'Debt', source: 'Manual entry' };
  state.transactions = [payment, { ...payment, id: 'manual-reversal', description: 'Reversal: Manual loan payment', amountCents: -10000, createdAt: `${today()}T12:01:00Z`, source: 'Manual reversal', reversalOf: payment.id, correctionReason: 'Entered twice' }];
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand: async () => {} })));
  const paid = [...container.querySelectorAll('.debt-summary-metric')].find(item => item.textContent?.includes('Paid this month'))!;
  assert.equal(paid.querySelector('strong')!.textContent, '$0');
  const reversal = [...container.querySelectorAll('.debt-payment-row')].find(item => item.textContent?.includes('Reversal: Manual loan payment'))!;
  assert.match(reversal.textContent ?? '', /Payment reversal\. Debt increased/);
  assert.equal(reversal.querySelector(':scope > strong')?.textContent, '+$100');
  assert.doesNotMatch(reversal.textContent ?? '', /Paid from|\-\$100/);
  assert.equal(container.querySelectorAll('.debt-payment-history .debt-payment-row').length, 2);
});

test('transaction ledger shows signed source movements and does not total unpaired payment sides', async () => {
  const state = fixture();
  state.transactions = [{ id: 'movement', description: 'Reviewed outgoing payment', accountId: 'cash', toAccountId: null, kind: 'adjustment', amountCents: 50000, date: today(), createdAt: `${today()}T12:00:00Z`, category: 'Card payment', source: 'Bank source', importSources: [{ importId: 'review', rowId: 'movement' }], balanceChanges: { cash: -50000 } }];
  await act(async () => root.render(createElement(Expenses, { state, scope: 'personal', initialSection: 'activity', readOnly: false, onOpen: () => {}, onCommand: async () => {} })));
  assert.match(container.querySelector('.ledger-totals')!.textContent!, /Statement account movements1.*Amounts are not combined/);
  assert.match(container.querySelector('.ledger-entry-amount')!.textContent!, /−\$500/);
  await act(async () => button('Bills').click());
  assert.equal(button('Bills').getAttribute('aria-pressed'), 'true');
});


test('pay schedule drafts survive record changes and save only after the new revision is reviewed', async () => {
  let state = { ...fixture(), roadmap: { payAmountCents: 200000, payEveryDays: 14, paydayAnchor: today() } } as AppState;
  const commands: Command[] = [];
  const render = () => root.render(createElement(ExpensePay, { state, readOnly: false, onCommand: async command => { commands.push(command); } }));
  await act(async () => render());
  await act(async () => button('Edit').click());
  await fill(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!, '2345.67');
  state = { ...state, revision: 2, roadmap: { ...state.roadmap!, payAmountCents: 180000 } };
  await act(async () => render());
  assert.equal(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.value, '2345.67');
  assert.equal(button('Save schedule').disabled, true);
  assert.match(container.textContent!, /Saved schedule: \$1,800 every 14 days/);
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(commands.length, 0);
  await act(async () => button('Keep my entries').click());
  await act(async () => button('Save schedule').click());
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], { type: 'update_pay_schedule', expectedRevision: 2, payAmountCents: 234567, payEveryDays: 14, paydayAnchor: today() });
});

test('a changed pay schedule can load the saved values without closing the editor', async () => {
  let state = { ...fixture(), roadmap: { payAmountCents: 200000, payEveryDays: 14, paydayAnchor: today() } } as AppState;
  const render = () => root.render(createElement(ExpensePay, { state, readOnly: false, onCommand: async () => {} }));
  await act(async () => render());
  await act(async () => button('Edit').click());
  await fill(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!, '2345.67');
  state = { ...state, revision: 2, roadmap: { ...state.roadmap!, payAmountCents: 180000, payEveryDays: 7 } };
  await act(async () => render());
  await act(async () => button('Load saved schedule').click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.draft-discard-dialog button')].find(button=>button.textContent==='Discard changes')!.click());
  assert.equal(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.value, '1800');
  assert.equal(container.querySelector<HTMLInputElement>('input[type="number"]')!.value, '7');
  assert.equal(button('Save schedule').disabled, false);
  assert.doesNotMatch(container.textContent!, /Records changed/);
});

test('the debt engine outage keeps the existing account balance action', async () => {
  const opened: unknown[] = [];
  globalThis.fetch = async () => Response.json({ error: 'Engine offline' }, { status: 503 });
  await act(async () => root.render(createElement(Debts, { state: debtFixture(), scope: 'personal', readOnly: false, onCommand: async () => {}, onOpen: (kind: string, accountId?: string) => { opened.push([kind, accountId]); } })));
  await act(async () => button('Update balance').click());
  assert.deepEqual(opened, [['reconcile', 'loan']]);
  assert.match(container.textContent!, /Engine offline/);
});

test('an empty transaction form leads to cash account setup', async () => {
  const state = { ...fixture(), accounts: [] };
  globalThis.fetch = recordsFetch(async () => Response.json(state));
  await act(async () => root.render(createElement(App)));
  await act(async () => button('Add transaction').click());
  const link = container.querySelector<HTMLAnchorElement>('dialog a[href="#investments/accounts"]')!;
  assert.ok(link);
  await act(async () => { link.click(); await new Promise(resolve => window.setTimeout(resolve, 0)); });
  assert.equal(window.location.hash, '#investments/accounts');
  assert.equal(container.querySelector('dialog'), null);
  assert.match(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent!, /Accounts/);
  await act(async () => button('Add account').click());
  assert.equal(container.querySelector<HTMLSelectElement>('dialog select[name="accountType"]')!.value, 'cash');
});

test('account and transaction sections survive deep links and browser history', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  window.history.replaceState(null, '', '#expenses/activity');
  await act(async () => root.render(createElement(App)));
  assert.equal(button('Transactions').getAttribute('aria-pressed'), 'true');
  await act(async () => container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!.click());
  await act(async () => button('Investments').click());
  assert.equal(window.location.hash, '#investments');
  await act(async () => {
    const changed = new Promise<void>(resolve => window.addEventListener('hashchange', () => resolve(), { once: true }));
    window.history.back();
    await changed;
  });
  assert.equal(window.location.hash, '#expenses/activity');
  assert.equal(button('Transactions').getAttribute('aria-pressed'), 'true');
});

async function nextFrame() { await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); }); }

test('page navigation moves keyboard focus to the page title without stealing focus on refresh', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  await act(async () => { button('Expenses').focus(); button('Expenses').click(); });
  await nextFrame();
  assert.ok(document.activeElement === container.querySelector('.page-heading h1'), `Page title should receive focus, found ${document.activeElement?.tagName}: ${document.activeElement?.textContent?.slice(0, 100)}`);
  assert.equal(document.activeElement?.textContent, 'Expenses');
  const month = container.querySelector<HTMLInputElement>('.expense-dashboard-month input')!;
  month.focus();
  await act(async () => window.dispatchEvent(new Event('focus')));
  await nextFrame();
  assert.ok(document.activeElement === month, `Month input should retain focus, found ${document.activeElement?.tagName}: ${document.activeElement?.getAttribute('aria-label')}`);
});

test('quick add closes when keyboard focus leaves its options', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  const menu = container.querySelector<HTMLDetailsElement>('.quick-add')!;
  await act(async () => { menu.open = true; button('Expense').focus(); });
  assert.equal(menu.open, true);
  await act(async () => container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!.focus());
  assert.equal(menu.open, false);
});

for (const focusOpener of [true, false]) test(`closing account management returns focus to its visible menu trigger after ${focusOpener ? 'keyboard' : 'unfocused pointer'} activation`, async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  const trigger = container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!;
  await act(async () => trigger.click());
  await act(async () => { if (focusOpener) button('Manage accounts').focus(); button('Manage accounts').click(); });
  assert.ok(container.querySelector<HTMLDialogElement>('dialog')!.open);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await act(async () => button('Done').click());
  await nextFrame();
  assert.equal(container.querySelector('dialog'), null);
  assert.ok(document.activeElement === trigger, 'Account management restores its visible menu trigger');
});

test('closing a Home balance form returns focus to its clicked opener even when the click did not focus it', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  const details = container.querySelector<HTMLDetailsElement>('.home-bank-panel details')!;
  const trigger = details.querySelector<HTMLButtonElement>('[aria-label^="Check balance for"]')!;
  await act(async () => { details.open = true; details.querySelector('summary')!.focus(); trigger.click(); });
  assert.ok(container.querySelector<HTMLDialogElement>('dialog')!.open);
  await act(async () => container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })));
  await nextFrame();
  assert.equal(container.querySelector('dialog'), null);
  assert.ok(document.activeElement === trigger, 'The balance opener receives focus after closing');
});

test('saving the first cash account returns focus to the page when its empty-state trigger disappears', async () => {
  let state: AppState = { ...fixture(), accounts: [] };
  globalThis.fetch = recordsFetch(async (_url, init) => {
    if (init?.method === 'POST') state = { ...fixture(), revision: 2 };
    return Response.json(state);
  });
  window.history.replaceState(null, '', '#investments/accounts');
  await act(async () => root.render(createElement(App)));
  const trigger = button('Add cash account');
  await act(async () => { trigger.focus(); trigger.click(); });
  await fill(container.querySelector<HTMLInputElement>('input[name="name"]')!, 'Cash');
  await fill(container.querySelector<HTMLInputElement>('input[name="opening"]')!, '1000');
  await act(async () => container.querySelector('dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await nextFrame();
  assert.equal(Boolean(container.querySelector('dialog')), false);
  assert.equal(trigger.isConnected, false);
  assert.equal(document.activeElement?.tagName, 'H1');
  assert.equal(document.activeElement?.textContent, 'Investments');
});

test('a form opened after discarding another draft returns focus to its original trigger', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  window.history.replaceState(null, '', '#expenses/plan');
  await act(async () => root.render(createElement(App)));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Set Food & groceries monthly amount"]')!.click());
  await fill(container.querySelector<HTMLInputElement>('.expense-plan-detail-panel:not([hidden]) .expense-plan-editor input')!, '200');
  const trigger = button('Add transaction');
  await act(async () => { trigger.focus(); trigger.click(); });
  const discard = button('Discard changes');
  await act(async () => { discard.focus(); discard.click(); });
  assert.ok(container.querySelector('dialog.mazal-dialog'));
  await act(async () => container.querySelector<HTMLButtonElement>('dialog [aria-label="Close dialog"]')!.click());
  await nextFrame();
  assert.equal(container.querySelector('dialog'), null);
  assert.equal(document.activeElement, trigger);
});

for (const action of ['Keep editing', 'Escape'] as const) test(`${action} returns focus from discard confirmation to its trigger`, async () => {
  let open = false;
  const render = () => root.render(createElement('div', null, createElement('button', { id: 'draft-trigger' }, 'Leave draft'), createElement(DraftDiscardDialog, { open, onDiscard: () => {}, onKeepEditing: () => { open = false; render(); } })));
  await act(async () => render());
  const trigger = container.querySelector<HTMLButtonElement>('#draft-trigger')!;
  trigger.focus();
  open = true;
  await act(async () => render());
  assert.equal(document.activeElement?.textContent, 'Keep editing');
  await act(async () => {
    const dialog = document.querySelector('dialog')!;
    if (action === 'Escape') dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    else [...dialog.querySelectorAll('button')].find(item => item.textContent === 'Keep editing')!.click();
  });
  await nextFrame();
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(document.activeElement, trigger);
});

test('retrying a failed view preserves content outside its error boundary', async t => {
  t.mock.method(console, 'error', () => {});
  let fail = true;
  function View() { if (fail) throw new Error('Temporary rendering failure'); return createElement('p', null, 'View recovered'); }
  await act(async () => root.render(createElement('div', null, createElement('input', { 'aria-label': 'Other draft', defaultValue: '' }), createElement(ErrorBoundary, null, createElement(View)))));
  await fill(container.querySelector<HTMLInputElement>('input')!, 'Keep this draft');
  assert.match(container.textContent!, /This page could not be displayed/);
  fail = false;
  await act(async () => button('Try again').click());
  assert.match(container.textContent!, /View recovered/);
  assert.equal(container.querySelector<HTMLInputElement>('input')!.value, 'Keep this draft');
});

test('a failed form exposes a focused close action without reloading the app', async t => {
  t.mock.method(console, 'error', () => {});
  let closed = false;
  function View(): never { throw new Error('Form rendering failure'); }
  await act(async () => root.render(createElement(ErrorBoundary, { onClose: () => { closed = true; }, children: createElement(View) })));
  assert.match(container.textContent!, /This form could not be displayed/);
  assert.equal(document.activeElement, button('Try again'));
  await act(async () => button('Close form').click());
  assert.equal(closed, true);
});

test('bill deep links open one visible editor and closing it leaves no modal behind', async () => {
  const state = fixture();
  state.obligations = [{ id: 'rent', entityId: 'personal', name: 'Rent', amountCents: 50000, dueDate: today(), direction: 'out', recurrence: 'monthly', status: 'planned', accountId: 'cash', category: 'Bills' }];
  globalThis.fetch = recordsFetch(async () => Response.json(state));
  window.history.replaceState(null, '', '#expenses/schedule?record=rent');
  await act(async () => root.render(createElement(App)));
  const dialogs = [...container.querySelectorAll<HTMLDialogElement>('dialog[open]')];
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].closest('[hidden]'), null);
  await act(async () => dialogs[0].querySelector<HTMLButtonElement>('[aria-label="Close payment editor"]')!.click());
  assert.equal(container.querySelector('dialog[open]'), null);
  await act(async () => button('Home').click());
  assert.equal(window.location.hash, '#home');
});

test('expense subsection links preserve filters, browser history, and the selected view on reload', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  window.history.replaceState(null, '', '#expenses');
  await act(async () => root.render(createElement(App)));
  await act(async () => button('Transactions').click());
  assert.equal(window.location.hash, '#expenses/activity');
  await fill(container.querySelector<HTMLInputElement>('[aria-label="Search transactions"]')!, 'Groceries');
  await act(async () => { button('Bills').focus(); button('Bills').click(); });
  await nextFrame();
  assert.equal(window.location.hash, '#expenses/schedule');
  assert.equal(document.activeElement, button('Bills'));
  await act(async () => {
    const changed = new Promise<void>(resolve => window.addEventListener('hashchange', () => resolve(), { once: true }));
    window.history.back(); await changed;
  });
  assert.equal(window.location.hash, '#expenses/activity');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Search transactions"]')!.value, 'Groceries');
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(App)));
  assert.equal(button('Transactions').getAttribute('aria-pressed'), 'true');
});

test('a planned expense deep link keeps its category and month when opening transactions', async () => {
  const state = fixture();
  const date = '2025-08-15';
  state.expensePlanItems = [{ id: 'groceries-plan', entityId: 'personal', categoryId: 'personal:food', name: 'Weekly groceries', amountCents: 5000, date: today(), notes: '' }];
  state.transactions = ['Food', 'Transport'].map(category => ({ id: category, accountId: 'cash', toAccountId: null, kind: 'expense', amountCents: 5000, category, description: category, date, source: 'Manual', createdAt: date }));
  globalThis.fetch = recordsFetch(async () => Response.json(state));
  window.history.replaceState(null, '', '#expenses/plan?record=groceries-plan');
  await act(async () => root.render(createElement(App)));
  await fill(container.querySelector<HTMLInputElement>('.expense-month-nav input')!, date.slice(0, 7));
  const details = container.querySelector<HTMLElement>('.expense-plan-detail-panel:not([hidden])')!;
  assert.equal(details.getAttribute('aria-label'), 'Food & groceries details');
  await act(async () => [...details.querySelectorAll('button')].find(item => item.textContent === 'View transactions')!.click());
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Expense category"]')!.value, 'food');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Transaction month"]')!.value, date.slice(0, 7));
  await act(async () => {
    const changed = new Promise<void>(resolve => window.addEventListener('hashchange', () => resolve(), { once: true }));
    window.history.back(); await changed;
  });
  assert.equal(window.location.hash, '#expenses/plan?record=groceries-plan');
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.expense-plan-category-select')].find(item => item.querySelector('strong')?.textContent === 'Transport')!.click());
  const transport = container.querySelector<HTMLElement>('.expense-plan-detail-panel:not([hidden])')!;
  await act(async () => [...transport.querySelectorAll('button')].find(item => item.textContent === 'View transactions')!.click());
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Expense category"]')!.value, 'transport');
  await act(async () => button('Overview').click());
  assert.equal(window.location.hash, '#expenses');
  assert.equal(button('Overview').getAttribute('aria-pressed'), 'true');
});

for (const item of [
  { route: '#investments', selector: '.investment-section-tabs button', label: 'Accounts', next: '#investments/accounts', selected: '[role="tab"][aria-selected="true"]' },
  { route: '#documents', selector: '.document-navigation button', label: 'Source files', next: '#documents/files', selected: '.document-navigation [aria-pressed="true"]' },
  { route: '#simulations', selector: '.workspace-tabs button', label: 'Plan setup', next: '#simulations/setup', selected: '.workspace-tabs [aria-pressed="true"]' },
]) test(`${item.label} navigation creates a reloadable subsection route`, async () => {
  globalThis.fetch = recordsFetch(async url => String(url).startsWith('/api/documents?') ? Response.json({documents:[]}) : String(url).startsWith('/api/master-workbook/status?') ? Response.json({available:false}) : Response.json(fixture()));
  window.history.replaceState(null, '', item.route);
  await act(async () => root.render(createElement(App)));
  const target = [...container.querySelectorAll<HTMLButtonElement>(item.selector)].find(node => node.textContent?.startsWith(item.label))!;
  assert.ok(target);
  await act(async () => target.click());
  assert.equal(window.location.hash, item.next);
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(createElement(App)));
  assert.ok(container.querySelector(item.selected)?.textContent?.startsWith(item.label));
});

test('record utilities have a labeled menu separate from creation actions', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  const add = container.querySelector('.toolbar-add .quick-add')!;
  const trigger = container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!;
  assert.equal(trigger.getAttribute('aria-label'), 'Settings and data');
  await act(async () => trigger.click());
  const utilities = container.querySelector('.workspace-utilities')!;
  assert.doesNotMatch(add.textContent!, /Backups and data|Manage accounts|Refresh records/);
  for (const label of ['Backups and data', 'Manage accounts', 'Refresh records']) assert.ok(utilities.textContent!.includes(label));
});


test('navigation gives every page one destination and separates settings', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  const navigation = container.querySelector('[aria-label="Main navigation"]')!;
  assert.deepEqual([...navigation.querySelectorAll('button')].map(node => node.textContent), ['Home', 'Expenses', 'Planner', 'Debts', 'Investments', 'Assets', 'Statements', 'Work & pay']);
  const more = container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!;
  await act(async () => more.click());
  assert.deepEqual([...container.querySelectorAll('.navigation-more-panel button')].map(node => node.textContent), ['Manage accounts', 'Backups and data', 'Refresh records', 'Motion off']);
  await act(async () => button('Investments').click());
  assert.equal(window.location.hash, '#investments');
  assert.equal(navigation.querySelector('[aria-current="page"]')?.textContent, 'Investments');
  assert.equal(more.getAttribute('aria-current'), null);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
});

test('More closes on Escape and on focus leaving its options', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  const more = container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!;
  await act(async () => more.click());
  await act(async () => button('Manage accounts').focus());
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, more);
  await act(async () => more.click());
  await act(async () => button('Manage accounts').focus());
  await act(async () => button('Add transaction').focus());
  assert.equal(more.getAttribute('aria-expanded'), 'false');
});

for (const route of ['#pay', '#pay/statements', '#pay/hours', '#pay/review']) test(`${route} keeps its URL and selects Work & pay`, async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  window.history.replaceState(null, '', route);
  await act(async () => root.render(createElement(App)));
  const current = container.querySelector('[aria-label="Main navigation"] [aria-current="page"]');
  assert.equal(current?.textContent, 'Work & pay');
  assert.equal(container.querySelector('.page-heading h1')?.textContent, 'Work & pay');
  assert.equal(container.querySelector('[aria-label="Record types"]'), null);
  assert.equal(window.location.hash, route);
});


test('Home starts with its daily content and keeps refresh and motion controls in More', async () => {
  globalThis.fetch = recordsFetch(async () => Response.json(fixture()));
  await act(async () => root.render(createElement(App)));
  assert.equal(container.querySelector('.workspace-meta, .page-heading'), null);
  assert.equal(container.querySelector('h1')?.textContent, 'Home');
  assert.equal(container.querySelector('h1')?.className, 'sr-only');
  assert.equal(container.querySelector('.record-sync, .motion-toggle'), null);
  await act(async () => container.querySelector<HTMLButtonElement>('.navigation-more-toggle')!.click());
  const menu = container.querySelector('.navigation-more-panel')!;
  assert.ok(menu.querySelector('.record-sync'));
  assert.ok(menu.querySelector('[aria-label="Refresh saved records"]'));
  assert.ok(menu.querySelector('.motion-toggle'));
});
