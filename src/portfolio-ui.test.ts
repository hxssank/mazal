import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import ts from 'typescript';
import { engineFixtureFetch } from './engine-test-fixture.ts';
import type { AccountType, AppState, Command } from '../shared/types.ts';
import { today } from '../shared/analytics.ts';
import { plannerDefaults, plannerSourceKey } from '../shared/planner-draft.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'Event', 'MouseEvent'] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.scrollIntoView = () => {};
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true });
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
const { default: Investments } = await import('./features/investments/Investments.tsx');
const { default: Assets } = await import('./features/assets/Assets.tsx');
const { default: Debts } = await import('./features/debts/Debts.tsx');
const { default: AccountStrategy } = await import('./features/planner/AccountStrategy.tsx');
const { default: Simulations } = await import('./features/planner/Simulations.tsx');
const container = document.getElementById('root')!;
let root = createRoot(container);
const originalFetch = globalThis.fetch;
beforeEach(async () => { engineState = undefined; globalThis.fetch = engineFixtureFetch(() => engineState); await act(async () => root.unmount()); root = createRoot(container); localStorage.clear(); window.history.replaceState(null, '', '/'); });
after(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; hooks.deregister(); dom.window.close(); });

function fixture(): AppState {
  return { workspace: 'live', revision: 1, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'legacy-business', name: 'Legacy business', kind: 'business', ownershipBps: 5000 }], accounts: [
    { id: 'brokerage', entityId: 'personal', name: 'Brokerage', type: 'investment', currency: 'CAD', balanceCents: 12345, reconciledAt: null },
    { id: 'bank', entityId: 'personal', name: 'Bank', type: 'cash', currency: 'CAD', balanceCents: 50000, reconciledAt: null },
    { id: 'business-investment', entityId: 'legacy-business', name: 'Company holdings', type: 'investment', currency: 'CAD', balanceCents: 90000000, reconciledAt: null },
    { id: 'business-cash', entityId: 'legacy-business', name: 'Company bank', type: 'cash', currency: 'CAD', balanceCents: 90000000, reconciledAt: null },
  ], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
}

function priorityLoan(id: string, terms: AppState['accounts'][number]['debtTerms'], balanceCents = 100000): AppState['accounts'][number] {
  return { id, entityId: 'personal', name: id, type: 'debt', currency: 'CAD', balanceCents, reconciledAt: null, debtTerms: terms };
}

async function renderPriority(accounts: AppState['accounts']) {
  const state = fixture();
  state.accounts = accounts;
  await act(async () => root.render(createElement(Debts, { key: accounts.map(account => account.id).join(','), state, scope: 'personal', readOnly: false, onCommand: async () => {}, onOpen: () => {} })));
  return container.querySelector<HTMLElement>('[aria-label="Extra payment priority"]')!;
}

test('confirmed zero rates need no rate confirmation even when another loan is deferred', async () => {
  const free = priorityLoan('Interest-free loan', { aprPercent: 0, rateConfirmed: true, minimumPaymentCents: 10000, notes: '' });
  for (const accounts of [[free], [free, priorityLoan('Deferred loan', { aprPercent: null, rateConfirmed: false, minimumPaymentCents: null, repaymentStatus: 'in_study', notes: '' })]]) {
    const panel = await renderPriority(accounts);
    assert.equal(panel.querySelector('h2')?.textContent, 'Active debts are interest-free');
    assert.doesNotMatch(panel.textContent!, /Add or confirm|Confirm the cost/);
    assert.equal(panel.querySelector('button'), null);
  }
});

test('a deferred-only portfolio does not request rates or imply interest is waived', async () => {
  for (const aprPercent of [12, null]) {
    const panel = await renderPriority([priorityLoan(`Deferred ${aprPercent}`, { aprPercent, rateConfirmed: aprPercent !== null, minimumPaymentCents: 10000, repaymentStatus: 'in_study', interestStatus: aprPercent === null ? 'unknown' : 'accruing', notes: '' })]);
    assert.equal(panel.querySelector('h2')?.textContent, 'Payments are deferred');
    assert.match(panel.textContent!, /interest may still accrue/);
    assert.doesNotMatch(panel.textContent!, /Add or confirm|interest-free/);
    assert.equal(panel.querySelector('button'), null);
  }
});

test('unknown or unconfirmed active rates offer review, while paid accounts and credits do not', async () => {
  for (const aprPercent of [null, 0, 24]) {
    const panel = await renderPriority([priorityLoan(`Unconfirmed ${aprPercent}`, { aprPercent, rateConfirmed: false, minimumPaymentCents: 10000, notes: '' })]);
    assert.equal(panel.querySelector('h2')?.textContent, 'Confirm the cost of borrowing');
    assert.match(panel.querySelector('button')?.textContent ?? '', /Review account details/);
  }
  const panel = await renderPriority([priorityLoan('Paid', undefined, 0), priorityLoan('Credit', undefined, -10000)]);
  assert.equal(panel.querySelector('h2')?.textContent, 'No balance to repay');
  assert.equal(panel.querySelector('button'), null);
});

test('portfolio displays personal balances and chooses account types without an ownership parameter', async () => {
  const accountTypes: (AccountType | undefined)[] = [];
  await act(async () => root.render(createElement(Investments, { state: fixture(), readOnly: false, onCommand: async () => {}, onOpen: () => {}, onAddAccount: type => { accountTypes.push(type); } })));
  assert.doesNotMatch(container.textContent!, /Company|Legacy business|Business ownership|Your ownership share|Full account values|Personal/);
  assert.match(container.querySelector('[aria-label="Investment totals"]')!.textContent!, /Total investments\$123\.45/);
  assert.match(container.textContent!, /Brokerage/);
  const investmentAdd = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add account')!;
  await act(async () => investmentAdd.click());
  const accountsTab = container.querySelector<HTMLButtonElement>('[role="tab"][id$="-accounts-tab"]')!;
  await act(async () => accountsTab.click());
  assert.match(container.querySelector('[id$="-accounts-panel"]')!.textContent!, /Bank/);
  const cashAdd = container.querySelector<HTMLButtonElement>('.investment-section-navigation > button')!;
  await act(async () => cashAdd.click());
  assert.deepEqual(accountTypes, ['investment', 'cash']);
});

test('SOL activity form previews linked cash, records source dates and permits two intentional identical purchases', async () => {
  const state = fixture();
  state.accounts[0].balanceCents = 20000;
  state.positions = [{ id:'position', accountId:'brokerage', liquidSol:'1', stakedSol:'1', rewardsSol:'0', costBasisCents:18000, priceCents:10000, priceDate:today(), priceSource:'Wallet statement' }];
  const commands:Command[] = [];
  await act(async () => root.render(createElement(Investments, { state, readOnly:false, onOpen:()=>{}, onAddAccount:()=>{}, onCommand:async command => { commands.push(command); } })));
  assert.match(container.textContent!, /Wallet statement.*Quote dated/);
  assert.match(container.textContent!, /History starts with your next recorded activity/);
  const open = async () => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Record activity')!.click());
  const input = async (suffix:string, value:string) => act(async () => {
    const field = container.querySelector<HTMLInputElement>(`input[id$="-${suffix}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles:true }));
  });
  const select = async (suffix:string, value:string) => act(async () => {
    const field = container.querySelector<HTMLSelectElement>(`select[id$="-${suffix}"]`)!;
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles:true }));
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await open();
    await input('quantity', '0.5');
    await input('price', '120');
    await input('fee', '2');
    await input('source', 'Exchange fill');
    await select('cash', 'bank');
    assert.doesNotMatch(container.querySelector('select[id$="-cash"]')!.textContent!, /Company bank/);
    assert.match(container.querySelector('.investment-history-preview')!.textContent!, /Bank -\$62.*After \$438/);
    await act(async () => container.querySelector('form.investment-history-form')!.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true })));
  }
  assert.equal(commands.length, 2);
  const [first, second] = commands as Extract<Command,{type:'record_sol_activity'}>[];
  assert.equal(first.kind, 'buy');
  assert.equal(first.quantitySol, '0.5');
  assert.equal(first.priceCents, 12000);
  assert.equal(first.feeCents, 200);
  assert.equal(first.cashAccountId, 'bank');
  assert.equal(first.priceSource, 'Exchange fill');
  assert.equal(first.expectedRevision, 1);
  assert.notEqual(first.requestId, second.requestId);
});

test('SOL form blocks stale edits until the current records are reviewed', async () => {
  const state = fixture();
  state.positions = [{ id:'position', accountId:'brokerage', liquidSol:'1', stakedSol:'1', rewardsSol:'0', costBasisCents:18000, priceCents:10000, priceDate:today() }];
  const props = { state, readOnly:false, onOpen:()=>{}, onAddAccount:()=>{}, onCommand:async ()=>{} };
  await act(async () => root.render(createElement(Investments, props)));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Record activity')!.click());
  await act(async () => root.render(createElement(Investments, { ...props, state:{ ...state, revision:2 } })));
  assert.match(container.textContent!, /Records changed/);
  assert.equal(container.querySelector<HTMLButtonElement>('.investment-history-form button[type="submit"]')!.disabled, true);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use updated records')!.click());
  assert.equal(container.querySelector<HTMLButtonElement>('.investment-history-form button[type="submit"]')!.disabled, false);
});

test('closed investment accounts retain their records without offering blocked updates', async () => {
  const state = fixture();
  state.accounts[0] = { ...state.accounts[0], balanceCents:0, closedAt:'2026-01-01' };
  state.accounts.push({ ...state.accounts[0], id:'wallet', name:'Wallet' });
  state.positions = [{ id:'position', accountId:'wallet', liquidSol:'0', stakedSol:'0', rewardsSol:'0', costBasisCents:0, priceCents:10000, priceDate:today() }];
  await act(async () => root.render(createElement(Investments, { state, readOnly:false, onCommand:async()=>{}, onOpen:()=>{}, onAddAccount:()=>{} })));
  assert.match(container.querySelector('.portfolio-sol-card h3')!.textContent!, /Wallet · Closed/);
  assert.match(container.querySelector('.portfolio-account-row h3')!.textContent!, /Brokerage · Closed/);
  const actions = [...container.querySelectorAll('button')].map(button => button.textContent?.trim());
  assert.equal(actions.some(label => ['Update SOL', 'Add SOL', 'Add reward', 'Record activity', 'Update value'].includes(label ?? '')), false);
  assert.ok(actions.includes('Add account'));
});

test('assets and wish totals use only the personal records', async () => {
  const state = fixture();
  const item = { id: 'tool', entityId: 'personal', name: 'Drill', category: 'Tools', purchaseDate: '2026-01-01', costCents: 10000, estimatedValueCents: 8000, status: 'owned' as const, soldDate: null, saleCents: null, feesCents: 0, notes: '' };
  state.assets = [item, { ...item, id: 'company-tool', entityId: 'legacy-business', name: 'Company equipment', estimatedValueCents: 90000000 }];
  state.wishItems = [{ id: 'wish', entityId: 'personal', name: 'Saw', costCents: 12000, comment: '' }, { id: 'company-wish', entityId: 'legacy-business', name: 'Company wish', costCents: 90000000, comment: '' }];
  await act(async () => root.render(createElement(Assets, { state, readOnly: true, onOpen: () => {}, onCommand: async () => {} })));
  assert.doesNotMatch(container.textContent!, /Company|Legacy business|business-owned|Personal/);
  assert.match(container.textContent!, /Drill/);
  assert.equal(container.querySelector('[aria-label="Wish basket"] .asset-planning-total strong')!.textContent, '$120');
  assert.equal(container.querySelector('.assets-primary-value')!.textContent, '$80');
});

test('asset planning stays collapsed while unknown amounts remain visible in its summaries', async () => {
  const state = fixture();
  state.wishItems = [{ id:'wish', entityId:'personal', name:'New tool', costCents:null, comment:'' }];
  state.assetPurchases = [{ id:'car', entityId:'personal', name:'Car', payee:'Seller', targetCents:100000, monthlyCents:10000, paidCents:null, paidAsOf:'2026-01-01', notes:'' }];
  const before = structuredClone(state);
  await act(async () => root.render(createElement(Assets, { state, readOnly:true, onOpen:()=>{}, onCommand:async()=>{} })));
  const disclosures = [...container.querySelectorAll<HTMLDetailsElement>('.asset-planning-disclosures > details')];
  assert.equal(disclosures.length, 3);
  assert.ok(disclosures.every(element => !element.open));
  assert.match(disclosures[1].querySelector('summary')!.textContent!, /1 price needed/);
  assert.match(disclosures[2].querySelector('summary')!.textContent!, /Confirm amount paid for 1/);
  await act(async () => disclosures[1].querySelector('summary')!.click());
  assert.equal(disclosures[1].open, true);
  assert.deepEqual(state, before);
});

test('an Assets record link focuses its purchase once and preserves focus through refresh', async () => {
  const state = fixture();
  state.assets = [{ id:'tool', entityId:'personal', name:'Drill', category:'Tools', purchaseDate:'2026-01-01', costCents:10000, estimatedValueCents:8000, status:'owned', soldDate:null, saleCents:null, feesCents:0, notes:'' }];
  state.assetPurchases = [{ id:'car', entityId:'personal', name:'Car', payee:'Seller', targetCents:100000, monthlyCents:10000, paidCents:10000, paidAsOf:'2026-01-01', notes:'' }];
  window.history.replaceState(null, '', '/#assets?record=car');
  const props = { state, readOnly:true, onOpen:()=>{}, onCommand:async()=>{} };
  await act(async () => root.render(createElement(Assets, props)));
  await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())));
  assert.equal(document.activeElement, container.querySelector('[data-purchase-id="car"]'));
  assert.equal(container.querySelector('[data-purchase-id="car"]')!.closest('details')!.open, true);
  const search = container.querySelector<HTMLInputElement>('[aria-label="Search physical assets"]')!;
  search.focus();
  await act(async () => root.render(createElement(Assets, { ...props, state:{ ...state, revision:2 } })));
  await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())));
  assert.equal(document.activeElement, search);
});

function deferredLoanFixture(): AppState {
  const state = fixture();
  state.accounts = [state.accounts[1],
    { id: 'osap', entityId: 'personal', name: 'OSAP', type: 'debt', currency: 'CAD', balanceCents: 1200000, reconciledAt: null, debtTerms: { aprPercent: null, minimumPaymentCents: null, rateConfirmed: false, notes: '', repaymentStatus: 'in_study', repaymentStatusSource: 'owner' } },
    { id: 'card', entityId: 'personal', name: 'Credit card', type: 'debt', currency: 'CAD', balanceCents: 100000, reconciledAt: null, debtTerms: { aprPercent: 12, minimumPaymentCents: 10000, rateConfirmed: true, notes: '' } },
  ];
  state.roadmap = { currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: 50000, monthlyDebtMinimumsCents: 10000, transitionDate: '', transitionMonths: 0, monthlyExtraDebtCents: 0, loanAccountId: 'osap', loanAprPercent: null, loanMonthlyPaymentCents: null, payAmountCents: 200000, payEveryDays: 14, paydayAnchor: today(), monthlyFamilyPaymentCents: 0 };
  return state;
}

test('account strategy leaves deferred OSAP out of repayment nags', async () => {
  await act(async () => root.render(createElement(AccountStrategy, { state: deferredLoanFixture() })));
  assert.doesNotMatch(container.textContent!, /OSAP|Rates still need confirmation/);
  assert.match(container.textContent!, /Credit card/);
});

test('account strategy replaces historical commitments and payday text with the saved schedule', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T16:00:00Z') });
  const state = deferredLoanFixture();
  state.roadmap = { ...state.roadmap!, paydayAnchor: '2026-10-01', payAmountCents: 150000 };
  state.sourceFacts = [
    { id: 'september-commitments', label: 'Planned for September 30', value: '$1,400 outstanding', asOf: '2026-09-24', sourceFile: 'Owner confirmation', note: 'Neither payment is recorded as paid.' },
    { id: 'payday-confirmation', label: 'Expected next payday', value: 'October 1 · $1,500', asOf: '2026-09-24', sourceFile: 'Owner confirmation', note: 'Owner thinks October 1 is the first pay date.' },
  ];
  state.obligations = [
    { id: 'paid', entityId: 'personal', name: 'September and October car payment', amountCents: 150000, dueDate: '2026-10-15', direction: 'out', recurrence: 'once', status: 'paid', accountId: 'bank', category: 'Car' },
    { id: 'car', entityId: 'personal', name: 'November car payment', amountCents: 130000, dueDate: '2026-11-01', direction: 'out', recurrence: 'once', status: 'planned', accountId: 'bank', category: 'Car' },
    { id: 'company', entityId: 'legacy-business', name: 'Company bill', amountCents: 900000, dueDate: '2026-10-20', direction: 'out', recurrence: 'once', status: 'planned', accountId: 'business-cash', category: 'Bills' },
  ];
  const before = structuredClone(state);
  await act(async () => root.render(createElement(AccountStrategy, { state })));
  const panel = container.querySelector('.account-strategy-first')!;
  assert.match(panel.textContent!, /Next scheduled payment\$1,300 · Nov 1, 2026/);
  assert.match(panel.textContent!, /November car payment/);
  assert.match(panel.textContent!, /Next scheduled paydayOct 29, 2026 · \$1,500 estimated/);
  assert.doesNotMatch(panel.textContent!, /September|October 1|\$1,400|Neither payment|Company bill/);
  assert.deepEqual(state, before);
});

test('account strategy keeps unpaid overdue payments visible and uses unknown pay after a transition', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T16:00:00Z') });
  const state = deferredLoanFixture();
  state.roadmap = { ...state.roadmap!, paydayAnchor: '2026-10-15', transitionDate: '2026-10-25' };
  state.obligations = [
    { id: 'late', entityId: 'personal', name: 'Unconfirmed October bill', amountCents: 7500, dueDate: '2026-10-17', direction: 'out', recurrence: 'once', status: 'planned', accountId: 'bank', category: 'Bills' },
    { id: 'cancelled', entityId: 'personal', name: 'Cancelled bill', amountCents: 1000, dueDate: '2026-10-16', direction: 'out', recurrence: 'once', status: 'cancelled', accountId: 'bank', category: 'Bills' },
  ];
  await act(async () => root.render(createElement(AccountStrategy, { state })));
  const panel = container.querySelector('.account-strategy-first')!;
  assert.match(panel.textContent!, /Past-due payment to review\$75 · Oct 17, 2026/);
  assert.match(panel.textContent!, /Unconfirmed October bill\. Confirm whether this payment has been made\./);
  assert.match(panel.textContent!, /Next scheduled paydayOct 29, 2026 · Amount unknown/);
  assert.doesNotMatch(panel.textContent!, /Cancelled bill|\$2,000 estimated/);
});

test('account strategy does not recover missing current plans from historical source facts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T16:00:00Z') });
  const state = fixture();
  state.sourceFacts = [{ id: 'payday-confirmation', label: 'Expected next payday', value: 'October 1 · $1,500', asOf: '2026-09-24', sourceFile: 'Owner confirmation', note: 'Unconfirmed past plan.' }];
  await act(async () => root.render(createElement(AccountStrategy, { state })));
  const panel = container.querySelector('.account-strategy-first')!;
  assert.match(panel.textContent!, /Recorded personal cash\$500/);
  assert.doesNotMatch(panel.textContent!, /payday|scheduled payment|Unconfirmed past plan/);
});

test('Debts keeps OSAP in totals and opens active debt planning first', async () => {
  const state = deferredLoanFixture();
  state.accounts.find(account => account.id === 'osap')!.debtTerms!.aprPercent = 18;
  state.accounts.find(account => account.id === 'osap')!.debtTerms!.interestStatus = 'accruing';
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand: async () => {} })));
  assert.equal(container.querySelector('.debt-total > strong')!.textContent, '$13,000');
  assert.match(container.querySelector('[aria-label="Deferred loans"]')!.textContent!, /OSAP: no payment due now/);
  assert.ok(container.querySelector('[aria-label="Credit card payoff calculator"]'));
  assert.equal(container.querySelector('[aria-label="OSAP payoff calculator"]'), null);
  assert.equal(container.querySelector('.debt-attention'), null);
  assert.doesNotMatch(container.querySelector('[aria-label="Extra payment priority"]')!.textContent!, /OSAP/);
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show deferred loan')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.debt-account-choice')].find(button => button.textContent!.includes('OSAP'))!.click());
  assert.ok(container.querySelector('[aria-label="OSAP payoff calculator"]'));
});

function closedDebtFixture(): AppState {
  const state = deferredLoanFixture();
  state.accounts.push(
    { id: 'fatima', entityId: 'personal', name: 'Fatima', type: 'payable', currency: 'CAD', balanceCents: 0, reconciledAt: null, closedAt: today() },
    { id: 'other-debt', entityId: 'personal', name: 'Other personal debt', type: 'payable', currency: 'CAD', balanceCents: 0, reconciledAt: null, closedAt: today() },
  );
  state.transactions.push(
    { id: 'fatima-payment', accountId: 'bank', toAccountId: 'fatima', kind: 'debt_payment', amountCents: 30000, date: today(), description: 'Paid sister', category: 'Debt payment', source: 'Manual', createdAt: today() },
    { id: 'fatima-settlement', accountId: 'fatima', toAccountId: null, kind: 'adjustment', amountCents: -10000, date: today(), description: 'Remaining balance settled', category: 'Balance adjustment', source: 'Manual', createdAt: today() },
    { id: 'other-payment', accountId: 'bank', toAccountId: 'other-debt', kind: 'debt_payment', amountCents: 25000, date: today(), description: 'Paid other personal debt', category: 'Debt payment', source: 'Manual', createdAt: today() },
  );
  return state;
}

test('closed debts leave the daily account list while payments and settlement stay in collapsed history', async () => {
  const state = closedDebtFixture();
  const original = structuredClone(state);
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: true, onOpen: () => {}, onCommand: async () => {} })));
  assert.equal(container.querySelector('.debt-total > p')?.textContent, '2 accounts');
  assert.equal(container.querySelector('.debt-total > strong')?.textContent, '$13,000');
  assert.doesNotMatch(container.querySelector('.debt-account-map')!.textContent!, /Fatima|Other personal debt/);
  const history = container.querySelector<HTMLDetailsElement>('.debt-closed-history')!;
  assert.equal(history.open, false);
  assert.match(history.querySelector('summary')!.textContent!, /Closed debts 2/);
  assert.equal(history.querySelectorAll('.debt-closed-account').length, 2);
  assert.equal(container.querySelector('[aria-label="Fatima payoff calculator"]'), null);
  await act(async () => history.querySelector('summary')!.click());
  assert.equal(history.open, true);
  const fatima = history.querySelector('[aria-label="Fatima closed debt history"]')!;
  assert.match(fatima.textContent!, /Closed .*\$0 balance/);
  assert.match(fatima.textContent!, /Paid sister.*Debt payment.*\$300/);
  assert.match(fatima.textContent!, /Remaining balance settled.*Balance adjustment.*-\$100/);
  assert.match(history.querySelector('[aria-label="Other personal debt closed debt history"]')!.textContent!, /Paid other personal debt.*\$250/);
  assert.equal(history.querySelector('button'), null);
  assert.deepEqual(state, original);
});

test('closed debt history remains available when the calculation service is unavailable', async () => {
  globalThis.fetch = async () => { throw new Error('Engine offline'); };
  const state = closedDebtFixture();
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: true, onOpen: () => {}, onCommand: async () => {} })));
  assert.doesNotMatch(container.querySelector('.debt-account-map')!.textContent!, /Fatima|Other personal debt/);
  assert.match(container.querySelector('.debt-account-map')!.textContent!, /Credit card/);
  const history = container.querySelector<HTMLDetailsElement>('.debt-closed-history')!;
  assert.equal(history.open, false);
  await act(async () => history.querySelector('summary')!.click());
  assert.match(history.textContent!, /Fatima.*Paid sister.*Remaining balance settled.*Other personal debt.*Paid other personal debt/);
});

test('a closed debt record link opens its history even when no debts remain open', async () => {
  const state = closedDebtFixture();
  state.accounts = state.accounts.filter(account => account.type === 'cash' || account.closedAt);
  window.history.replaceState(null, '', '/#debts?record=fatima');
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: true, onOpen: () => {}, onCommand: async () => {} })));
  assert.equal(container.querySelector('.debt-empty-state h2')?.textContent, 'No open debts');
  assert.equal(container.querySelector('.debt-account-choices'), null);
  assert.equal(container.querySelector('.debt-payoff-lab'), null);
  const history = container.querySelector<HTMLDetailsElement>('.debt-closed-history')!;
  assert.equal(history.open, true);
  assert.match(history.textContent!, /Fatima.*Paid sister/);
});

test('a deferred debt record link reveals and focuses the requested loan', async () => {
  window.history.replaceState(null, '', '/#debts?record=osap');
  await act(async () => root.render(createElement(Debts, { state:deferredLoanFixture(), scope:'personal', readOnly:false, onOpen:()=>{}, onCommand:async()=>{} })));
  await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())));
  assert.ok(container.querySelector('[aria-label="OSAP payoff calculator"]'));
  assert.equal(container.querySelector('[aria-label="Credit card payoff calculator"]'), null);
  assert.equal(document.activeElement, container.querySelector('#debt-payoff'));
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="Deferred loans"] button')?.getAttribute('aria-expanded'), 'true');
});

test('a known zero minimum is labelled as no payment due on the upcoming date', async () => {
  const state = deferredLoanFixture();
  state.accounts.find(account => account.id === 'card')!.debtTerms = { aprPercent:12, rateConfirmed:true, minimumPaymentCents:0, paymentDueDate:today(), notes:'' };
  await act(async () => root.render(createElement(Debts, { state, scope:'personal', readOnly:false, onOpen:()=>{}, onCommand:async()=>{} })));
  const dates = container.querySelector('.debt-dates')!;
  assert.match(dates.textContent!, /Credit cardNo minimum due\$0/);
  assert.doesNotMatch(dates.textContent!, /Saved payment amount/);
  assert.equal(dates.querySelector('time')?.dateTime, today());
});

test('Debts keeps card credits separate from amount owed and does not offer another payment', async () => {
  const state = deferredLoanFixture();
  state.accounts = state.accounts.filter(account => account.id !== 'osap');
  state.accounts.find(account => account.id === 'card')!.balanceCents = -2500;
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand: async () => {} })));
  assert.equal(container.querySelector('.debt-total > strong')!.textContent, '$0');
  assert.match(container.querySelector('.debt-total')!.textContent!, /\$25 in account credits/);
  assert.match(container.querySelector('#debt-payoff')!.textContent!, /Credit balance\$25/);
  assert.match(container.textContent!, /No debt payment is needed/);
  assert.equal(container.querySelector('[aria-label="Credit card payoff calculator"]'), null);
  assert.equal([...container.querySelectorAll('button')].some(button => button.textContent === 'Record payment'), false);
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent === 'Update balance'));
});

test('Planner accepts overdraft cash and holds a card credit outside repayment targets', async () => {
  const state = deferredLoanFixture();
  state.accounts = state.accounts.filter(account => account.id !== 'osap');
  state.accounts.find(account => account.id === 'bank')!.balanceCents = -1000;
  state.accounts.find(account => account.id === 'card')!.balanceCents = -2500;
  await act(async () => root.render(createElement(Simulations, { state, scope: 'personal', motion: false })));
  assert.ok(container.querySelector('[aria-label="Daily plan progress"]'));
  assert.equal(container.querySelector('.monthly-error'), null);
  assert.match(container.querySelector('[aria-label="Recorded account credits"]')!.textContent!, /Credit card: \$25 credit/);
  assert.match(container.querySelector('[aria-label="Recorded account credits"]')!.textContent!, /do not fund cash payments/);
  assert.equal(container.querySelector('[aria-label="Credit card balance"]'), null);
  assert.match(container.querySelector('.monthly-calendar-selection')!.textContent!, /Debt \$0Cash -\$10/);
});

test('Planner runs with deferred OSAP held fixed and its optional inputs hidden', async () => {
  const state = deferredLoanFixture();
  const before = structuredClone(state);
  await act(async () => root.render(createElement(Simulations, { state, scope: 'personal', motion: false })));
  assert.ok(container.querySelector('[aria-label="Daily plan progress"]'));
  assert.equal(container.querySelector('.monthly-error'), null);
  assert.equal(container.querySelector('[aria-label="OSAP APR"]'), null);
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Debt to prioritize"]')!.value, 'card');
  assert.match(container.querySelector('[aria-label="Daily timeline"]')!.getAttribute('aria-valuetext')!, /debt \$13,000/);
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show deferred loan')!.click());
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="OSAP APR"]')!.value, '');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Include OSAP in repayment scenario"]')!.checked, false);
  assert.deepEqual(state, before);
});

test('older Planner drafts stop requiring OSAP terms while keeping other scenario entries', async () => {
  const state = deferredLoanFixture();
  const draft = plannerDefaults(state, 'personal', today());
  draft.pay = '2250';
  draft.debts.osap.included = true;
  draft.selectedDebtId = 'osap';
  localStorage.setItem('mazal.planner.monthly.v4.live.personal', JSON.stringify({ version: 4, sourceKey: plannerSourceKey(state, 'personal', today()), draft }));
  await act(async () => root.render(createElement(Simulations, { state, scope: 'personal', motion: false })));
  assert.ok(container.querySelector('[aria-label="Daily plan progress"]'));
  assert.equal(container.querySelector('.monthly-error'), null);
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Pay per paycheck"]')!.value, '2250');
  const saved = JSON.parse(localStorage.getItem('mazal.planner.monthly.v4.live.personal')!);
  assert.equal(saved.draft.debts.osap.included, false);
  assert.equal(saved.draft.selectedDebtId, 'card');
  assert.equal(saved.deferredPlanningVersion, 1);
});

function tdFixture(): AppState {
  const state = deferredLoanFixture();
  const card = state.accounts.find(account => account.id === 'card')!;
  card.name = 'TD Low Rate Visa sample';
  card.balanceCents = 600000;
  card.debtTerms = { aprPercent: 12.9, rateConfirmed: true, minimumPaymentCents: null, statementDate: '2026-08-10', notes: '' };
  state.sourceFacts = [{ id: 'td-august-terms', label: 'August statement minimum', value: '$80.00 due September 4', asOf: '2026-08-10', sourceFile: 'example-card-statement.pdf', note: 'Historical payment information. Current payment status is unknown.' }];
  return state;
}

async function inputValue(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

test('account strategy shows a usable TD estimate and the distinct historical statement amount', async () => {
  const state = tdFixture();
  const before = structuredClone(state);
  await act(async () => root.render(createElement(AccountStrategy, { state })));
  const estimate = container.querySelector('[aria-label="TD minimum estimate"]')!;
  assert.match(estimate.textContent!, /Estimated regular minimum: \$74\.50/);
  assert.match(estimate.textContent!, /\$80\.00 due September 4.*Aug 10, 2026/);
  assert.match(estimate.textContent!, /Excludes fees, overdue amounts, over-limit requirements and instalments/);
  assert.ok(estimate.querySelector('a[href*="12128-599186-cha-25-a1-en.pdf"]'));
  assert.doesNotMatch(container.textContent!, /Still needed:.*Current TD minimum/);
  assert.deepEqual(state, before);
});

test('Debts uses the estimate for payoff while saving only the user-entered confirmed fields', async () => {
  const state = tdFixture();
  const before = structuredClone(state);
  const commands: Command[] = [];
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand: async command => { commands.push(command); } })));
  assert.equal(container.querySelector('.debt-attention'), null);
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Debt scenario monthly payment"]')!.value, '');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Use estimated regular minimum for payoff"]')!.checked, true);
  assert.match(container.querySelector('.debt-comparison')!.textContent!, /\$74\.50 per month/);
  assert.match(container.querySelector('[aria-label="TD minimum estimate"]')!.textContent!, /\$80\.00 due September 4/);
  await inputValue('Debt scenario APR', '13');
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent!.includes('Save details'))!.click());
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'set_debt_terms');
  if (commands[0].type === 'set_debt_terms') {
    assert.equal(commands[0].terms.aprPercent, 13);
    assert.equal(commands[0].terms.minimumPaymentCents, null);
    assert.equal(commands[0].terms.paymentDueDate, null);
  }
  assert.deepEqual(state, before);
});

test('Planner migrates a blank TD minimum, recomputes estimates, and preserves manual scenario targets', async () => {
  const state = tdFixture();
  const before = structuredClone(state);
  const draft = plannerDefaults(state, 'personal', today());
  draft.pay = '2250';
  draft.debts.card.minimum = '';
  delete draft.debts.card.minimumMode;
  localStorage.setItem('mazal.planner.monthly.v4.live.personal', JSON.stringify({ version: 4, deferredPlanningVersion: 1, sourceKey: plannerSourceKey(state, 'personal', today()), draft }));
  await act(async () => root.render(createElement(Simulations, { state, scope: 'personal', motion: false })));
  assert.ok(container.querySelector('[aria-label="Daily plan progress"]'));
  assert.equal(container.querySelector('.monthly-error'), null);
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="Pay per paycheck"]')!.value, '2250');
  const label = 'TD Low Rate Visa sample';
  assert.equal(container.querySelector<HTMLInputElement>(`[aria-label="${label} estimated regular minimum"]`)!.value, '74.5');
  assert.match(container.querySelector('[aria-label="Estimated minimum assumptions"]')!.textContent!, /\$74\.50 estimated regular minimum/);
  await inputValue(`${label} APR`, '24');
  assert.equal(container.querySelector<HTMLInputElement>(`[aria-label="${label} estimated regular minimum"]`)!.value, '130');
  await inputValue(`${label} estimated regular minimum`, '150');
  assert.equal(container.querySelector<HTMLInputElement>(`[aria-label="Use estimated regular minimum for ${label}"]`)!.checked, false);
  await inputValue(`${label} balance`, '1000');
  assert.equal(container.querySelector<HTMLInputElement>(`[aria-label="${label} monthly minimum"]`)!.value, '150');
  await act(async () => container.querySelector<HTMLInputElement>(`[aria-label="Use estimated regular minimum for ${label}"]`)!.click());
  assert.equal(container.querySelector<HTMLInputElement>(`[aria-label="${label} estimated regular minimum"]`)!.value, '30');
  assert.ok(container.querySelector('[aria-label="Daily plan progress"]'));
  assert.equal(JSON.parse(localStorage.getItem('mazal.planner.monthly.v4.live.personal')!).draft.debts.card.minimumMode, 'td_estimate');
  assert.deepEqual(state, before);
});

test('debt overview separates balance size, confirmed interest cost, and saved payment amounts', async () => {
  const state = fixture();
  const due = new Date(`${today()}T12:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 5);
  const dueDate = due.toISOString().slice(0, 10);
  const base = { entityId: 'personal', type: 'debt' as const, currency: 'CAD' as const, reconciledAt: null };
  state.accounts.push(
    { ...base, id: 'large', name: 'Large loan', balanceCents: 2000000, debtTerms: { aprPercent: 6, rateConfirmed: true, minimumPaymentCents: 8000, paymentDueDate: dueDate, notes: '' } },
    { ...base, id: 'costly', name: 'Higher-rate card', balanceCents: 500000, debtTerms: { aprPercent: 12, rateConfirmed: true, minimumPaymentCents: 15000, paymentDueDate: dueDate, notes: '' } },
    { ...base, id: 'unknown', name: 'Unknown loan', balanceCents: 150000, debtTerms: { aprPercent: 0, rateConfirmed: false, minimumPaymentCents: null, paymentDueDate: dueDate, repaymentKind: 'one_off', notes: '' } },
  );
  const before = structuredClone(state);
  const commands: Command[] = [];
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand: async command => { commands.push(command); } })));
  assert.match(container.querySelector('.debt-interest-total')!.textContent!, /\$150.*1 account excluded/);
  assert.equal(container.querySelector('.debt-account-choice.is-selected .debt-map-name strong')!.textContent, 'Higher-rate card');
  assert.match(container.querySelector('[aria-label="Extra payment priority"]')!.textContent!, /\$1,000.*\$120.*Large loan.*\$60/);
  const large = [...container.querySelectorAll('.debt-account-choice')].find(row => row.textContent!.includes('Large loan'))!;
  assert.match(large.textContent!, /Saved payment is below estimated interest/);
  assert.match(large.getAttribute('aria-label')!, /\$20,000 owed.*\$100 estimated monthly interest/);
  const unknownDate = [...container.querySelectorAll('.debt-dates li')].find(row => row.textContent!.includes('Unknown loan'))!;
  assert.match(unknownDate.textContent!, /Payment amount needs confirmation.*Not set/);
  assert.doesNotMatch(unknownDate.textContent!, /\$1,500/);
  assert.deepEqual(state, before);
  assert.equal(commands.length, 0);
});

test('accounts without confirmed interest do not appear as zero-cost borrowing', async () => {
  const state = fixture();
  state.accounts.push({ id: 'unknown', entityId: 'personal', name: 'Unchecked loan', type: 'debt', currency: 'CAD', balanceCents: 250000, reconciledAt: null });
  await act(async () => root.render(createElement(Debts, { state, scope: 'personal', readOnly: false, onOpen: () => {}, onCommand: async () => {} })));
  assert.equal(container.querySelector('.debt-interest-total > strong')!.textContent, 'Not confirmed');
  assert.equal(container.querySelector('.debt-map-interest > strong')!.textContent, 'Not confirmed');
  assert.match(container.querySelector('[aria-label="Extra payment priority"]')!.textContent!, /Confirm the cost of borrowing/);
});
