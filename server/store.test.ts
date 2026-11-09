import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { today } from '../shared/analytics.ts';
import type { Command } from '../shared/types.ts';

function setup(t: { after: (fn: () => void) => void }, workspace: 'live' | 'demo' = 'live') {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-test-'));
  const path = join(directory, `${workspace}.sqlite`);
  const store = createStore(path, workspace);
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { store, directory, path };
}
const day = today();
function account(store: ReturnType<typeof createStore>, name: string, type: 'cash' | 'investment' | 'debt' | 'payable' | 'receivable', amount: number, entityId = 'personal') {
  const state = store.command({ type: 'add_account', entityId, name, accountType: type, openingBalanceCents: amount, openingDate: '2026-01-01' });
  return state.accounts.find(item => item.name === name)!.id;
}
function tx(store: ReturnType<typeof createStore>, kind: 'expense' | 'income' | 'transfer' | 'debt_payment', accountId: string, amountCents: number, requestId: string, toAccountId?: string) {
  return store.command({ type: 'add_transaction', kind, accountId, amountCents, requestId, toAccountId, date: day, description: 'Test entry', category: 'Test' });
}
function amount(store: ReturnType<typeof createStore>, id: string) { return store.state().accounts.find(item => item.id === id)!.balanceCents; }
function netWorth(store: ReturnType<typeof createStore>) { return store.state().accounts.reduce((sum, item) => sum + item.balanceCents * (['debt', 'payable'].includes(item.type) ? -1 : 1), 0); }

test('live starts empty and sample balances are separate, synthetic, and consistent', t => {
  const live = setup(t).store;
  assert.equal(live.state().accounts.length, 0);
  assert.equal(live.state().entities.length, 1);
  const demo = setup(t, 'demo').store;
  const personal = demo.state().accounts.filter(item => item.entityId === 'personal');
  assert.equal(personal.filter(item => item.type === 'cash').reduce((sum, item) => sum + item.balanceCents, 0), 845000);
  assert.equal(personal.filter(item => item.type === 'investment').reduce((sum, item) => sum + item.balanceCents, 0), 1820000);
  assert.equal(netWorth(demo), 2680000);
  assert.equal(live.state().transactions.length, 0);
});

test('credit card purchases and card payments count the expense once', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  const card = account(store, 'Card', 'debt', 10000);
  tx(store, 'expense', card, 2500, 'purchase');
  assert.equal(amount(store, card), 12500);
  assert.equal(netWorth(store), 7500);
  tx(store, 'debt_payment', cash, 2500, 'payment', card);
  assert.equal(amount(store, cash), 17500);
  assert.equal(amount(store, card), 10000);
  assert.equal(netWorth(store), 7500);
  assert.equal(store.state().transactions.filter(item => item.kind === 'expense').reduce((sum, item) => sum + item.amountCents, 0), 2500);
});

test('cross-owner transfers move existing assets and balance each owner journal', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  store.command({ type: 'add_entity', name: 'Shop', ownershipBps: 10000 });
  const shop = store.state().entities.find(item => item.name === 'Shop')!;
  const business = account(store, 'Operating', 'cash', 0, shop.id);
  tx(store, 'transfer', cash, 5000, 'transfer', business);
  assert.equal(amount(store, cash), 15000);
  assert.equal(amount(store, business), 5000);
  assert.equal(netWorth(store), 20000);
  const backup = store.export();
  const last = backup.data.transactions.at(-1)!;
  const entries = backup.data.entries.filter(entry => entry.transactionId === last.id);
  assert.equal(entries.length, 4);
  for (const entity of backup.data.entities) assert.equal(entries.filter(entry => backup.data.accounts.find(a => a.id === entry.accountId)?.entityId === entity.id).reduce((sum, entry) => sum + entry.debitCents, 0), 0);
});

test('request IDs prevent duplicates across restart and reject different payload reuse', t => {
  const { store, path } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  tx(store, 'expense', cash, 2500, 'same-request');
  const revision = store.state().revision;
  tx(store, 'expense', cash, 2500, 'same-request');
  assert.equal(store.state().revision, revision);
  assert.equal(amount(store, cash), 17500);
  assert.throws(() => tx(store, 'expense', cash, 3500, 'same-request'), /different operation/);
  store.close();
  const reopened = createStore(path, 'live');
  try { tx(reopened, 'expense', cash, 2500, 'same-request'); assert.equal(amount(reopened, cash), 17500); assert.equal(reopened.state().revision, revision); }
  finally { reopened.close(); }
});

test('invalid cents, dates, references, overspending, overpayment and future entries leave state intact', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  const card = account(store, 'Card', 'debt', 10000);
  const baseline = store.state();
  for (const cents of [0, -1, 0.25, Number.MAX_SAFE_INTEGER + 1, NaN]) assert.throws(() => tx(store, 'expense', cash, cents, `bad-${cents}`));
  assert.throws(() => tx(store, 'expense', cash, 20001, 'overspend'), /enough/);
  assert.throws(() => tx(store, 'debt_payment', cash, 10001, 'overpayment', card), /exceeds/);
  assert.throws(() => tx(store, 'income', 'missing', 1, 'bad-account'), /existing/);
  assert.throws(() => store.command({ type: 'add_transaction', kind: 'expense', accountId: cash, amountCents: 100, requestId: 'bad-date', date: '2026-02-30', description: 'Bad', category: '' }), /valid/);
  assert.throws(() => store.command({ type: 'add_transaction', kind: 'income', accountId: cash, amountCents: 100, requestId: 'future', date: '2199-01-01', description: 'Future', category: '' }), /future|happen/);
  assert.deepEqual(store.state(), baseline);
});

test('balance checks reject an older date than an account expense and preserve the ledger', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 10000);
  store.command({ type: 'add_transaction', kind: 'expense', accountId: cash, amountCents: 2000, date: '2026-01-05', description: 'Later purchase', category: '', requestId: 'later-purchase' });
  store.command({ type: 'add_transaction', kind: 'expense', accountId: cash, amountCents: 1000, date: '2026-01-03', description: 'Earlier purchase', category: '', requestId: 'earlier-purchase' });
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'reconcile', accountId: cash, balanceCents: 9000, date: '2026-01-04', note: 'Older statement', requestId: 'older-check' }), /2026-01-05.*Choose that date or later/);
  assert.deepEqual(store.state(), baseline);
  assert.equal(amount(store, cash), 7000);
});

test('balance checks reject dates before incoming transfers and debt payments', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 30000);
  const savings = account(store, 'Savings', 'cash', 10000);
  const debt = account(store, 'Debt', 'debt', 20000);
  store.command({ type: 'add_transaction', kind: 'transfer', accountId: cash, toAccountId: savings, amountCents: 5000, date: '2026-01-03', description: 'Move to savings', category: '', requestId: 'incoming-transfer' });
  store.command({ type: 'add_transaction', kind: 'debt_payment', accountId: cash, toAccountId: debt, amountCents: 4000, date: '2026-01-04', description: 'Pay debt', category: '', requestId: 'incoming-debt-payment' });
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'reconcile', accountId: savings, balanceCents: 10000, date: '2026-01-02', note: 'Before transfer', requestId: 'check-transfer-target' }), /2026-01-03.*Choose that date or later/);
  assert.throws(() => store.command({ type: 'reconcile', accountId: debt, balanceCents: 20000, date: '2026-01-03', note: 'Before payment', requestId: 'check-payment-target' }), /2026-01-04.*Choose that date or later/);
  assert.deepEqual(store.state(), baseline);
});

test('balance checks allow the latest account date, ignore unrelated later entries, and reject future dates', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 10000);
  const savings = account(store, 'Savings', 'cash', 3000);
  store.command({ type: 'add_transaction', kind: 'transfer', accountId: cash, toAccountId: savings, amountCents: 5000, date: '2026-01-03', description: 'Move to savings', category: '', requestId: 'latest-transfer' });
  store.command({ type: 'add_transaction', kind: 'expense', accountId: cash, amountCents: 1000, date: '2026-01-04', description: 'Unrelated purchase', category: '', requestId: 'unrelated-purchase' });
  store.command({ type: 'reconcile', accountId: savings, balanceCents: 9000, date: '2026-01-03', note: 'Statement after transfer', requestId: 'latest-check' });
  assert.equal(amount(store, savings), 9000);
  assert.equal(amount(store, cash), 4000);
  assert.equal(store.state().accounts.find(item => item.id === savings)!.reconciledAt, '2026-01-03');
  const adjustment = store.state().transactions.find(item => item.accountId === savings && item.kind === 'adjustment');
  assert.equal(adjustment?.amountCents, 1000);
  store.command({ type: 'reconcile', accountId: savings, balanceCents: 10000, date: '2026-01-05', note: 'Later statement', requestId: 'later-check' });
  assert.equal(amount(store, savings), 10000);
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'reconcile', accountId: savings, balanceCents: 11000, date: '2199-01-01', note: 'Future statement', requestId: 'future-check' }), /future/);
  assert.deepEqual(store.state(), baseline);
});

test('manual history cannot change a later confirmed balance on either side of a transfer', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 30000);
  const savings = account(store, 'Savings', 'cash', 10000);
  const card = account(store, 'Card', 'debt', 20000);
  for (const [accountId, balanceCents] of [[savings, 10000], [card, 20000]] as const) {
    store.command({ type: 'reconcile', accountId, balanceCents, date: '2026-01-10', note: 'Bank snapshot', requestId: `check-${accountId}` });
  }
  const baseline = store.state();
  const commands: Extract<Command, { type: 'add_transaction' }>[] = [
    { type: 'add_transaction', kind: 'income', accountId: savings, amountCents: 1000, date: '2026-01-09', description: 'Earlier income', category: '', requestId: 'old-income' },
    { type: 'add_transaction', kind: 'expense', accountId: card, amountCents: 1000, date: '2026-01-09', description: 'Earlier purchase', category: '', requestId: 'old-expense' },
    { type: 'add_transaction', kind: 'transfer', accountId: savings, toAccountId: cash, amountCents: 1000, date: '2026-01-09', description: 'Earlier withdrawal', category: '', requestId: 'old-source' },
    { type: 'add_transaction', kind: 'transfer', accountId: cash, toAccountId: savings, amountCents: 1000, date: '2026-01-09', description: 'Earlier deposit', category: '', requestId: 'old-destination' },
    { type: 'add_transaction', kind: 'debt_payment', accountId: cash, toAccountId: card, amountCents: 1000, date: '2026-01-09', description: 'Earlier payment', category: '', requestId: 'old-payment' },
  ];
  for (const command of commands) {
    assert.throws(() => store.command(command), /confirmed balance on 2026-01-10/);
    assert.deepEqual(store.state(), baseline);
  }
  store.command({ ...commands[3], date: '2026-01-10', requestId: 'same-day-transfer' });
  store.command({ ...commands[4], date: '2026-01-11', requestId: 'later-payment' });
  assert.equal(amount(store, cash), 28000);
  assert.equal(amount(store, savings), 11000);
  assert.equal(amount(store, card), 19000);
});

test('CSV import keeps identical purchases in one file, skips repeated files, and rolls back invalid batches', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  const rows = [{ date: day, description: 'Coffee', amountCents: -500 }, { date: day, description: 'Coffee', amountCents: -500 }];
  store.command({ type: 'import_rows', accountId: cash, rows, requestId: 'csv-1' });
  assert.equal(amount(store, cash), 19000);
  store.command({ type: 'import_rows', accountId: cash, rows, requestId: 'csv-2' });
  assert.equal(amount(store, cash), 19000);
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'import_rows', accountId: cash, rows: [{ date: day, description: 'Lunch', amountCents: -1000 }, { date: day, description: 'Too much', amountCents: -90000 }], requestId: 'bad-csv' }), /enough/);
  assert.deepEqual(store.state(), baseline);
});

test('SOL rewards use lamport precision, increase stake once, and do not add reward totals twice', t => {
  const { store } = setup(t);
  const investment = account(store, 'SOL', 'investment', 0);
  store.command({ type: 'save_sol', accountId: investment, liquidSol: '0.5', stakedSol: '10', costBasisCents: 150000, priceCents: 20000, priceDate: day, requestId: 'sol-1' });
  assert.equal(amount(store, investment), 210000);
  const position = store.state().positions[0];
  const reward: Command = { type: 'add_sol_reward', positionId: position.id, sol: '0.000000001', date: day, requestId: 'reward-tiny' };
  store.command(reward);
  store.command(reward);
  assert.equal(store.state().positions[0].stakedSol, '10.000000001');
  store.command({ type: 'add_sol_reward', positionId: position.id, sol: '0.25', date: day, requestId: 'reward-large' });
  assert.equal(store.state().positions[0].stakedSol, '10.250000001');
  assert.equal(store.state().positions[0].rewardsSol, '0.250000001');
  assert.equal(amount(store, investment), 215000);
  assert.equal(store.state().transactions.filter(item => item.category === 'Staking rewards').reduce((sum, item) => sum + item.amountCents, 0), 5000);
  assert.throws(() => store.command({ type: 'add_sol_reward', positionId: position.id, sol: '0.0000000001', date: day, requestId: 'precision' }), /9 decimals/);
  assert.throws(() => store.command({ type: 'add_sol_reward', positionId: position.id, sol: '-1', date: day, requestId: 'negative' }));
  assert.throws(() => tx(store, 'income', investment, 1, 'not-cash'), /SOL/);
});

test('backups retain journals, request IDs and SOL, restore transactionally, and save pre-restore copies', t => {
  const { store, directory } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  tx(store, 'expense', cash, 2500, 'before-backup');
  const backup = store.export();
  tx(store, 'expense', cash, 1000, 'after-backup');
  assert.equal(amount(store, cash), 16500);
  store.restore(backup);
  assert.equal(amount(store, cash), 17500);
  tx(store, 'expense', cash, 2500, 'before-backup');
  assert.equal(amount(store, cash), 17500);
  const files = readdirSync(join(directory, 'backups', 'live'));
  assert.ok(files.some(file => file.includes('daily')));
  assert.ok(files.some(file => file.includes('before-restore')));
  const baseline = store.state();
  const broken = structuredClone(backup);
  broken.data.entries[0].debitCents++;
  assert.throws(() => store.restore(broken), /balance/);
  assert.deepEqual(store.state(), baseline);
  const orphan = structuredClone(backup);
  orphan.data.transactions[0].accountId = 'missing';
  assert.throws(() => store.restore(orphan), /missing/);
  assert.deepEqual(store.state(), baseline);
});

test('Locked import preserves the original source and brings current balances without replaying history', t => {
  const { store } = setup(t);
  const old = { version: 1, cash: 123456, investments: 22222, debts: [{ name: 'Loan', balance: 55555 }], transactions: [{ kind: 'expense', amount: 10000 }], habits: [{ name: 'Old habit' }] };
  store.command({ type: 'import_locked', backup: old });
  assert.equal(netWorth(store), 90123);
  assert.ok(store.state().transactions.every(item => item.kind === 'opening'));
  assert.deepEqual(store.export().data.originalImports[0].source, old);
  assert.throws(() => store.command({ type: 'import_locked', backup: old }), /empty workspace/);
});

test('planned payments do not move cash before confirmation and repeated request IDs do not pay twice', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Phone', amountCents: 5000, dueDate: '2026-10-31', direction: 'out', recurrence: 'monthly', category: 'Bills' });
  assert.equal(amount(store, cash), 20000);
  const payment = { type: 'pay_obligation', id: store.state().obligations[0].id, expectedDueDate: '2026-10-31', requestId: 'paid' } as const;
  store.command(payment);
  store.command(payment);
  assert.equal(amount(store, cash), 15000);
  assert.equal(store.state().obligations[0].dueDate, '2026-11-30');
  assert.equal(store.state().obligations[0].status, 'planned');
});

test('a second window cannot record the same recurring payment with a different request ID', t => {
  const { store, path } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Phone', amountCents: 5000, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Bills' });
  const obligation = store.state().obligations[0];
  const payment = { type: 'pay_obligation', id: obligation.id, expectedDueDate: obligation.dueDate, requestId: 'first-window' } as const;
  const second = createStore(path, 'live');
  t.after(() => second.close());
  store.command(payment);
  const baseline = store.state();
  assert.throws(() => second.command({ ...payment, requestId: 'second-window' }), /date changed.*Refresh/);
  assert.deepEqual(second.state(), baseline);
  assert.equal(amount(second, cash), 15000);
  assert.equal(second.state().obligations[0].dueDate, '2026-02-28');
  second.command(payment);
  assert.deepEqual(second.state(), baseline);
  second.command({ ...payment, expectedDueDate: '2026-02-28', requestId: 'next-payment' });
  assert.equal(amount(store, cash), 10000);
  assert.equal(store.state().obligations[0].dueDate, '2026-03-31');
});

test('payment confirmation requires the displayed due date and rejects a schedule edited in another window', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Phone', amountCents: 5000, dueDate: '2026-01-31', direction: 'out', recurrence: 'once', category: 'Bills' });
  const obligation = store.state().obligations[0];
  store.command({ type: 'update_obligation', id: obligation.id, expectedDueDate: obligation.dueDate, expectedStatus: obligation.status as 'planned', name: obligation.name, amountCents: obligation.amountCents, dueDate: '2026-02-02', recurrence: obligation.recurrence, accountId: cash, category: obligation.category, requestId: 'reschedule' });
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'pay_obligation', id: obligation.id, expectedDueDate: obligation.dueDate, requestId: 'stale-schedule' }), /date changed.*Refresh/);
  assert.throws(() => store.command({ type: 'pay_obligation', id: obligation.id, requestId: 'missing-date' } as Command), /Payment due date/);
  assert.throws(() => store.command({ type: 'pay_obligation', id: obligation.id, expectedDueDate: '2026-02-30', requestId: 'invalid-date' }), /valid YYYY-MM-DD/);
  assert.deepEqual(store.state(), baseline);
});

test('backup restore rejects balanced journals whose displayed transactions were changed', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  tx(store, 'expense', cash, 2500, 'expense');
  const backup = store.export();
  const baseline = store.state();
  backup.data.transactions.at(-1)!.amountCents = 25;
  assert.throws(() => store.restore(backup), /does not match/);
  assert.deepEqual(store.state(), baseline);
});

test('monthly payment recurrence preserves the 31st across short months', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 50000);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Monthly', amountCents: 1000, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Bills' });
  const id = store.state().obligations[0].id;
  store.command({ type: 'pay_obligation', id, expectedDueDate: '2026-01-31', requestId: 'january' });
  assert.equal(store.state().obligations[0].dueDate, '2026-02-28');
  store.command({ type: 'pay_obligation', id, expectedDueDate: '2026-02-28', requestId: 'february' });
  assert.equal(store.state().obligations[0].dueDate, '2026-03-31');
  assert.equal(store.state().obligations[0].recurrenceDay, 31);
});

test('subscriptions preserve payment history through price edits, cancellation, restart and restore', t => {
  const { store, path } = setup(t);
  const cash = account(store, 'Cash', 'cash', 50000);
  const add = { type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Video plan', amountCents: 1299, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Digital', subscription: true, requestId: 'subscription-add' } as const;
  store.command(add);
  store.command(add);
  assert.equal(store.state().obligations.length, 1);
  const id = store.state().obligations[0].id;
  store.command({ type: 'pay_obligation', id, expectedDueDate: '2026-01-31', requestId: 'subscription-payment' });
  const history = store.state().transactions;
  const update = { type: 'update_obligation', id, expectedStatus: 'planned', expectedDueDate: '2026-02-28', name: 'Video plan', amountCents: 1999, dueDate: '2026-02-28', recurrence: 'monthly', accountId: cash, category: 'Digital', subscription: true, requestId: 'subscription-price' } as const;
  store.command(update);
  store.command(update);
  assert.equal(store.state().obligations[0].amountCents, 1999);
  assert.equal(store.state().obligations[0].recurrenceDay, 31);
  assert.deepEqual(store.state().transactions, history);
  assert.equal(amount(store, cash), 48701);
  store.command({ type: 'set_obligation_status', id, status: 'cancelled', requestId: 'subscription-cancel' });
  assert.equal(store.state().obligations[0].status, 'cancelled');
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'pay_obligation', id, expectedDueDate: '2026-02-28', requestId: 'cancelled-payment' }), /cancelled/);
  assert.deepEqual(store.state(), baseline);
  const backup = store.export();
  const expected = store.state().obligations;
  store.close();
  const reopened = createStore(path, 'live');
  t.after(() => reopened.close());
  assert.deepEqual(reopened.state().obligations, expected);
  reopened.restore(backup);
  assert.deepEqual(reopened.state().obligations, expected);
  assert.deepEqual(reopened.state().transactions, history);
});

test('subscription reactivation requires a due date and changing recurrence preserves identity', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 10000);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Gym', amountCents: 1000, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Gym', subscription: true, requestId: 'gym-add' });
  const id = store.state().obligations[0].id;
  store.command({ type: 'set_obligation_status', id, status: 'cancelled', requestId: 'gym-cancel' });
  assert.throws(() => store.command({ type: 'set_obligation_status', id, status: 'planned', requestId: 'gym-no-date' }), /Next due date/);
  store.command({ type: 'set_obligation_status', id, status: 'planned', dueDate: '2026-02-15', requestId: 'gym-reactivate' });
  assert.equal(store.state().obligations[0].recurrenceDay, 15);
  store.command({ type: 'update_obligation', id, expectedStatus: 'planned', expectedDueDate: '2026-02-15', name: 'Gym', amountCents: 1250, dueDate: '2026-02-16', recurrence: 'biweekly', accountId: cash, category: 'Gym', subscription: true, requestId: 'gym-biweekly' });
  assert.equal(store.state().obligations[0].recurrenceDay, undefined);
  store.command({ type: 'pay_obligation', id, expectedDueDate: '2026-02-16', requestId: 'gym-payment' });
  assert.equal(store.state().obligations[0].id, id);
  assert.equal(store.state().obligations[0].dueDate, '2026-03-02');
  assert.equal(store.state().obligations.length, 1);
  assert.equal(amount(store, cash), 8750);
});

for (const route of ['edit', 'edit-reactivation', 'reactivation'] as const) {
  test(`${route} cannot reuse a recorded bill occurrence`, t => {
    const { store } = setup(t);
    const cash = account(store, 'Cash', 'cash', 600000);
    store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Rent', amountCents: 150000, dueDate: '2026-10-20', direction: 'out', recurrence: 'monthly', category: 'Housing' });
    const id = store.state().obligations[0].id;
    store.command({ type: 'pay_obligation', id, expectedDueDate: '2026-10-20', date: '2026-10-15', requestId: 'rent-paid-early' });
    assert.equal(store.state().obligations[0].dueDate, '2026-11-20');
    if (route !== 'edit') store.command({ type: 'set_obligation_status', id, status: 'cancelled', requestId: 'rent-cancel' });
    const before = store.state();
    const command: Command = route === 'reactivation'
      ? { type: 'set_obligation_status', id, status: 'planned', dueDate: '2026-10-20', requestId: 'reuse-paid-date' }
      : { type: 'update_obligation', id, expectedStatus: route === 'edit' ? 'planned' : 'cancelled', expectedDueDate: '2026-11-20', name: 'Rent', amountCents: 160000, dueDate: '2026-10-20', recurrence: 'monthly', status: 'planned', accountId: cash, category: 'Housing', requestId: 'reuse-paid-date' };
    assert.throws(() => store.command(command), /already recorded.*2026-10-20/);
    assert.deepEqual(store.state(), before);
    assert.equal(amount(store, cash), 450000);
  });
}

test('bill edits preserve paid history while accepting new dates and cancelled details', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Phone', amountCents: 1000, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Bills' });
  const id = store.state().obligations[0].id;
  store.command({ type: 'pay_obligation', id, expectedDueDate: '2026-01-31', requestId: 'phone-paid' });
  const history = store.state().transactions;
  const edit = { type: 'update_obligation', id, expectedStatus: 'planned', expectedDueDate: '2026-02-28', name: 'Phone', amountCents: 1200, dueDate: '2026-02-28', recurrence: 'monthly', accountId: cash, category: 'Bills', requestId: 'phone-price' } as const;
  store.command(edit);
  store.command({ ...edit, dueDate: '2026-03-05', requestId: 'phone-move' });
  assert.equal(store.state().obligations[0].recurrenceDay, 5);
  store.command({ ...edit, expectedDueDate: '2026-03-05', dueDate: '2026-01-31', status: 'cancelled', requestId: 'phone-cancel-edit' });
  store.command({ ...edit, expectedStatus: 'cancelled', expectedDueDate: '2026-01-31', dueDate: '2026-01-31', name: 'Old phone plan', requestId: 'phone-cancelled-name' });
  const cancelled = store.state();
  assert.throws(() => store.command({ type: 'set_obligation_status', id, status: 'planned', dueDate: '2026-01-31', requestId: 'phone-paid-reactivation' }), /already recorded.*2026-01-31/);
  assert.deepEqual(store.state(), cancelled);
  store.command({ type: 'set_obligation_status', id, status: 'planned', dueDate: '2026-03-06', requestId: 'phone-new-reactivation' });
  assert.equal(store.state().obligations[0].dueDate, '2026-03-06');
  assert.equal(store.state().obligations[0].recurrenceDay, 6);
  assert.deepEqual(store.state().transactions, history);
  assert.equal(amount(store, cash), 19000);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Other bill', amountCents: 500, dueDate: '2026-01-30', direction: 'out', recurrence: 'once', category: 'Bills' });
  const other = store.state().obligations[1];
  store.command({ ...edit, id: other.id, expectedDueDate: other.dueDate, name: other.name, amountCents: other.amountCents, dueDate: '2026-01-31', recurrence: 'once', requestId: 'other-bill-date' });
  store.command({ type: 'pay_obligation', id: other.id, expectedDueDate: '2026-01-31', requestId: 'other-bill-paid' });
  const paid = store.state();
  assert.throws(() => store.command({ ...edit, id: other.id, expectedDueDate: '2026-01-31', dueDate: '2026-02-01', requestId: 'completed-edit' }), /completed payment cannot be edited/);
  assert.throws(() => store.command({ type: 'set_obligation_status', id: other.id, status: 'planned', dueDate: '2026-02-01', requestId: 'completed-reactivation' }), /completed payment cannot be reactivated/);
  assert.deepEqual(store.state(), paid);
});

test('stale subscription edits cannot reverse a payment advancement or cross owners', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 10000);
  store.command({ type: 'add_entity', name: 'Business', ownershipBps: 10000 });
  const owner = store.state().entities.find(item => item.name === 'Business')!.id;
  const foreign = account(store, 'Business bank', 'cash', 10000, owner);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Phone', amountCents: 1000, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Bills', subscription: true, requestId: 'phone-add' });
  const id = store.state().obligations[0].id;
  store.command({ type: 'pay_obligation', id, expectedDueDate: '2026-01-31', requestId: 'phone-payment' });
  const baseline = store.state();
  const edit = { type: 'update_obligation', id, expectedStatus: 'planned', expectedDueDate: '2026-01-31', name: 'Phone', amountCents: 2000, dueDate: '2026-01-31', recurrence: 'monthly', accountId: cash, category: 'Bills', subscription: true, requestId: 'phone-stale' } as const;
  assert.throws(() => store.command(edit), /date changed/);
  assert.throws(() => store.command({ ...edit, expectedDueDate: '2026-02-28', accountId: foreign, requestId: 'phone-wrong-owner' }), /belonging to this owner/);
  assert.deepEqual(store.state(), baseline);
});

test('subscription flags require recurring outgoing payments and survive existing bill classification', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 10000);
  const add = { type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Phone', amountCents: 1000, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Bills' } as const;
  store.command(add);
  assert.equal(store.state().obligations[0].subscription, undefined);
  const id = store.state().obligations[0].id;
  store.command({ type: 'update_obligation', id, expectedStatus: 'planned', expectedDueDate: add.dueDate, name: add.name, amountCents: add.amountCents, dueDate: add.dueDate, recurrence: add.recurrence, accountId: cash, category: add.category, subscription: true, requestId: 'classify' });
  assert.equal(store.state().obligations.length, 1);
  assert.equal(store.state().obligations[0].subscription, true);
  const baseline = store.state();
  assert.throws(() => store.command({ ...add, subscription: true }), /request ID/);
  assert.throws(() => store.command({ ...add, subscription: true, recurrence: 'once', requestId: 'one-time' }), /recurring outgoing/);
  assert.throws(() => store.command({ ...add, subscription: true, direction: 'in', requestId: 'income' }), /recurring outgoing/);
  assert.deepEqual(store.state(), baseline);
  const backup = store.export();
  (backup.data.obligations[0] as unknown as Record<string, unknown>).subscription = 'yes';
  assert.throws(() => store.restore(backup), /true or false/);
});

test('subscriptions can be tracked without accounts, restored, and linked before payment', t => {
  const { store, path } = setup(t);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: '', name: 'Phone', amountCents: 5500, dueDate: '2026-09-23', direction: 'out', recurrence: 'monthly', category: 'Bills', subscription: true, requestId: 'unlinked-add' });
  const id = store.state().obligations[0].id;
  assert.equal(store.state().accounts.length, 0);
  assert.equal(store.state().transactions.length, 0);
  assert.equal(store.state().obligations[0].accountId, '');
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'pay_obligation', id, expectedDueDate: '2026-09-23', requestId: 'unlinked-paid' }), /Choose a payment account/);
  assert.deepEqual(store.state(), baseline);
  const backup = store.export();
  store.close();
  const reopened = createStore(path, 'live');
  t.after(() => reopened.close());
  assert.equal(reopened.state().obligations[0].accountId, '');
  reopened.restore(backup);
  assert.equal(reopened.state().accounts.length, 0);
  const cash = account(reopened, 'Bank', 'cash', 20000);
  reopened.command({ type: 'update_obligation', id, expectedStatus: 'planned', expectedDueDate: '2026-09-23', name: 'Phone', amountCents: 5500, dueDate: '2026-09-23', recurrence: 'monthly', accountId: cash, category: 'Bills', subscription: true, requestId: 'link-phone' });
  reopened.command({ type: 'pay_obligation', id, expectedDueDate: '2026-09-23', requestId: 'linked-phone-paid' });
  assert.equal(amount(reopened, cash), 14500);
  assert.equal(reopened.state().obligations[0].dueDate, '2026-10-23');
  assert.equal(reopened.state().obligations.length, 1);
  const invalid = reopened.export();
  invalid.data.obligations[0].accountId = 'missing-account';
  invalid.data.obligations[0].subscription = false;
  assert.throws(() => reopened.restore(invalid), /existing payment account/);
});

test('card subscriptions and payable bills record purchases once and survive restore', t => {
  const { store, path } = setup(t);
  const card = account(store, 'Credit card', 'debt', 10000);
  const payable = account(store, 'Store credit', 'payable', 2000);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: card, name: 'Video subscription', amountCents: 1299, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Digital', subscription: true, requestId: 'card-subscription-add' });
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: '', name: 'Appliance purchase', amountCents: 4500, dueDate: '2026-01-15', direction: 'out', recurrence: 'once', category: 'Home' });
  const [subscription, bill] = store.state().obligations;
  store.command({ type: 'update_obligation', id: bill.id, expectedStatus: 'planned', expectedDueDate: bill.dueDate, name: bill.name, amountCents: bill.amountCents, dueDate: bill.dueDate, recurrence: bill.recurrence, accountId: payable, category: bill.category, requestId: 'link-payable-bill' });
  assert.equal(amount(store, card), 10000);
  assert.equal(amount(store, payable), 2000);
  const subscriptionPayment = { type: 'pay_obligation', id: subscription.id, expectedDueDate: subscription.dueDate, requestId: 'card-subscription-payment' } as const;
  const billPayment = { type: 'pay_obligation', id: bill.id, expectedDueDate: bill.dueDate, requestId: 'payable-bill-payment' } as const;
  for (const payment of [subscriptionPayment, billPayment]) {
    store.command(payment);
    store.command(payment);
  }
  assert.equal(amount(store, card), 11299);
  assert.equal(amount(store, payable), 6500);
  assert.equal(store.state().obligations[0].dueDate, '2026-02-28');
  assert.equal(store.state().obligations[1].status, 'paid');
  assert.equal(store.state().accounts.some(item => item.type === 'cash'), false);
  assert.equal(store.state().transactions.filter(item => item.kind === 'expense').length, 2);
  assert.equal(store.state().transactions.filter(item => item.kind === 'debt_payment').length, 0);
  const backup = store.export();
  store.close();
  const reopened = createStore(path, 'live');
  t.after(() => reopened.close());
  assert.equal(amount(reopened, card), 11299);
  reopened.restore(backup);
  reopened.command(subscriptionPayment);
  reopened.command(billPayment);
  assert.equal(amount(reopened, card), 11299);
  assert.equal(amount(reopened, payable), 6500);
  assert.equal(reopened.state().transactions.filter(item => item.kind === 'expense').length, 2);
  assert.equal(reopened.state().obligations[0].subscription, true);
});

test('planned payment accounts reject wrong owners and income on liabilities atomically', t => {
  const { store } = setup(t);
  const card = account(store, 'Credit card', 'debt', 10000);
  const payable = account(store, 'Store credit', 'payable', 0);
  const investment = account(store, 'Investment', 'investment', 10000);
  store.command({ type: 'add_entity', name: 'Business', ownershipBps: 10000 });
  const owner = store.state().entities.find(item => item.name === 'Business')!.id;
  const foreign = account(store, 'Business card', 'debt', 0, owner);
  const add = { type: 'add_obligation', entityId: 'personal', accountId: '', name: 'Planned entry', amountCents: 1000, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Bills' } as const;
  store.command(add);
  store.command({ ...add, name: 'Incoming pay', direction: 'in' });
  const [bill, income] = store.state().obligations;
  const validBackup = store.export();
  const baseline = store.state();
  const edit = { type: 'update_obligation', id: bill.id, expectedStatus: 'planned', expectedDueDate: bill.dueDate, name: bill.name, amountCents: bill.amountCents, dueDate: bill.dueDate, recurrence: bill.recurrence, accountId: foreign, category: bill.category, requestId: 'wrong-owner-bill-edit' } as const;
  assert.throws(() => store.command({ ...add, accountId: foreign }), /belonging to this owner/);
  assert.throws(() => store.command(edit), /belonging to this owner/);
  assert.throws(() => store.command({ ...add, accountId: investment }), /cash, debt, or payable/);
  for (const accountId of [card, payable, investment]) {
    assert.throws(() => store.command({ ...add, accountId, direction: 'in' }), /income needs a cash account/);
    assert.throws(() => store.command({ ...edit, id: income.id, accountId, requestId: `income-${accountId}` }), /income needs a cash account/);
    const invalidIncome = structuredClone(validBackup);
    invalidIncome.data.obligations[1].accountId = accountId;
    assert.throws(() => store.restore(invalidIncome), /income needs a cash account/);
  }
  const invalidOwner = structuredClone(validBackup);
  invalidOwner.data.obligations[0].accountId = foreign;
  assert.throws(() => store.restore(invalidOwner), /belonging to this owner/);
  assert.deepEqual(store.state(), baseline);
});

test('an old editor cannot reactivate a subscription cancelled in another session', t => {
  const { store } = setup(t);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: '', name: 'Gym', amountCents: 3000, dueDate: '2026-10-01', direction: 'out', recurrence: 'biweekly', category: 'Gym', subscription: true, requestId: 'status-add' });
  const id = store.state().obligations[0].id;
  store.command({ type: 'set_obligation_status', id, status: 'cancelled', requestId: 'status-cancel' });
  const baseline = store.state();
  const edit = { type: 'update_obligation', id, expectedStatus: 'planned', expectedDueDate: '2026-10-01', name: 'Gym', amountCents: 3500, dueDate: '2026-10-01', recurrence: 'biweekly', accountId: '', category: 'Gym', subscription: true, status: 'planned', requestId: 'stale-active' } as const;
  assert.throws(() => store.command(edit), /status changed/);
  assert.deepEqual(store.state(), baseline);
  store.command({ ...edit, expectedStatus: 'cancelled', dueDate: '2026-10-15', requestId: 'explicit-reactivation' });
  assert.equal(store.state().obligations[0].status, 'planned');
  assert.equal(store.state().obligations[0].dueDate, '2026-10-15');
  assert.equal(store.state().transactions.length, 0);
});

test('restore rejects completed recurring subscriptions without changing legacy paid recurrence', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  store.command({ type: 'add_obligation', entityId: 'personal', accountId: cash, name: 'Phone', amountCents: 1000, dueDate: '2026-01-31', direction: 'out', recurrence: 'monthly', category: 'Bills' });
  const backup = store.export();
  backup.data.obligations[0].status = 'paid';
  store.restore(backup);
  assert.equal(store.state().obligations[0].status, 'paid');
  backup.data.obligations[0].subscription = true;
  const baseline = store.state();
  assert.throws(() => store.restore(backup), /active or cancelled/);
  assert.deepEqual(store.state(), baseline);
});

test('roadmap preserves unknown amounts and real pay cadence through restart and backup restore', t => {
  const { store, path } = setup(t);
  const settings = { currentMonthlyIncomeCents: 325000, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: '2027-01-01', transitionMonths: 8, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, payAmountCents: 150000, payEveryDays: 14, paydayAnchor: '2026-09-24' };
  store.command({ type: 'save_roadmap', settings });
  assert.deepEqual(store.state().roadmap, settings);
  assert.equal(store.state().accounts.length, 0);
  assert.equal(store.state().transactions.length, 0);
  const backup = store.export();
  store.command({ type: 'save_roadmap', settings: { ...settings, monthlyExtraDebtCents: 12345 } });
  store.restore(backup);
  assert.deepEqual(store.state().roadmap, settings);
  assert.throws(() => store.command({ type: 'save_roadmap', settings: { ...settings, loanAccountId: 'nonexistent' } }), /existing/);
  assert.throws(() => store.command({ type: 'save_roadmap', settings: { ...settings, payEveryDays: 0 } }), /between/);
  store.close();
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state().roadmap, settings); } finally { reopened.close(); }
});

test('temporary hours survive restore and track changes to the full-time planning amount', t => {
  const { store } = setup(t);
  store.command({ type: 'update_pay_schedule', payAmountCents: 150000, payEveryDays: 14, paydayAnchor: '2026-10-29' });
  const schedule = { weeklyHours: 20, fullTimeWeeklyHours: 37.5, returnDate: '2027-05-01', payPeriodEndLagDays: 12 };
  const settings = { ...store.state().roadmap!, incomeTransitionPlanned: true, transitionDate: '2027-01-01', temporaryWorkSchedule: schedule };
  store.command({ type: 'save_roadmap', settings });
  assert.equal(store.state().roadmap!.partTimeMonthlyIncomeCents, 173333);
  const backup = store.export();
  const changePay = { type: 'update_pay_schedule', payAmountCents: 180000, payEveryDays: 14, paydayAnchor: '2027-01-21' } as const;
  assert.throws(() => store.command({ ...changePay, resolveIncomeTransition: true }), /full-time pay/);
  store.command(changePay);
  assert.equal(store.state().roadmap!.partTimeMonthlyIncomeCents, 208000);
  store.restore(backup);
  assert.deepEqual(store.state().roadmap!.temporaryWorkSchedule, schedule);
  for (const invalid of [{ returnDate: '2027-01-01' }, { weeklyHours: 38 }, { weeklyHours: 10.234 }, { fullTimeWeeklyHours: 0 }, { payPeriodEndLagDays: -1 }]) {
    assert.throws(() => store.command({ type: 'save_roadmap', settings: { ...settings, temporaryWorkSchedule: { ...schedule, ...invalid } } }), /hours|days|resume/i);
  }
  assert.equal(store.state().transactions.length, 0);
});

test('debt terms preserve unconfirmed rates and unknown minimums through restart and restore', t => {
  const { store, path } = setup(t);
  const loan = account(store, 'Student loan', 'debt', 1540000);
  const cash = account(store, 'Cash', 'cash', 10000);
  const terms = { aprPercent: 7.5, rateConfirmed: false, minimumPaymentCents: null, notes: 'Estimated rate; statement needed.' };
  store.command({ type: 'set_debt_terms', accountId: loan, terms });
  assert.deepEqual(store.state().accounts.find(item => item.id === loan)!.debtTerms, terms);
  assert.equal(amount(store, loan), 1540000);
  assert.throws(() => store.command({ type: 'set_debt_terms', accountId: cash, terms }), /debt or payable/);
  assert.throws(() => store.command({ type: 'set_debt_terms', accountId: loan, terms: { ...terms, aprPercent: null, rateConfirmed: true } }), /confirmed interest rate/);
  assert.throws(() => store.command({ type: 'set_debt_terms', accountId: loan, terms: { ...terms, minimumPaymentCents: 1.2 } }), /whole number/);
  const backup = store.export();
  store.command({ type: 'set_debt_terms', accountId: loan, terms: { ...terms, aprPercent: 8, rateConfirmed: true, minimumPaymentCents: 15000 } });
  store.restore(backup);
  assert.deepEqual(store.state().accounts.find(item => item.id === loan)!.debtTerms, terms);
  store.close();
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state().accounts.find(item => item.id === loan)!.debtTerms, terms); } finally { reopened.close(); }
});

test('family payment is a saved planning commitment without a fabricated loan or vehicle asset', t => {
  const { store } = setup(t);
  const settings = { currentMonthlyIncomeCents: 300000, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: '2027-01-01', transitionMonths: 8, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null, monthlyFamilyPaymentCents: 100000, familyPaymentNote: 'Mom / BMW payment. Remaining balance and due date not confirmed.' };
  store.command({ type: 'save_roadmap', settings });
  assert.deepEqual(store.state().roadmap, settings);
  assert.equal(store.state().accounts.length, 0);
  assert.equal(store.state().transactions.length, 0);
  const backup = store.export();
  store.restore(backup);
  assert.deepEqual(store.state().roadmap, settings);
});

test('future SOL rewards and malformed legacy balances fail without partial changes', t => {
  const { store } = setup(t);
  const investment = account(store, 'SOL', 'investment', 0);
  store.command({ type: 'save_sol', accountId: investment, liquidSol: '1', stakedSol: '2', costBasisCents: 30000, priceCents: 20000, priceDate: day, requestId: 'setup-sol' });
  const baseline = store.state();
  assert.throws(() => store.command({ type: 'add_sol_reward', positionId: baseline.positions[0].id, sol: '0.1', date: '2199-01-01', requestId: 'future-reward' }), /future/);
  assert.deepEqual(store.state(), baseline);
  const empty = setup(t).store;
  const initial = empty.state();
  assert.throws(() => empty.command({ type: 'import_locked', backup: { version: 1, cash: 10000, debts: [{ name: 'Valid', balance: 1000 }, { name: 'Malformed', balance: '2000' }] } }), /whole number/);
  assert.deepEqual(empty.state(), initial);
});

test('category limits and resale assets survive restart and restore while recorded sales credit cash', t => {
  const { store, path } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  const originalTransactions = store.state().transactions;
  const limit = { id: 'personal:food', entityId: 'personal', name: 'Food', color: '#DBAA88', aliases: ['Groceries', 'Coffee'], dailyCents: 2500, weeklyCents: null, monthlyCents: 60000 };
  const asset = { id: 'laptop', entityId: 'personal', name: 'Laptop', category: 'Electronics', purchaseDate: '2026-01-01', costCents: 150000, estimatedValueCents: 90000, status: 'owned' as const, soldDate: null, saleCents: null, feesCents: 0, notes: 'Original receipt saved locally.' };
  store.command({ type: 'save_spending_limit', limit });
  store.command({ type: 'save_asset', asset });
  assert.deepEqual(store.state().spendingLimits, [limit]);
  assert.deepEqual(store.state().assets, [asset]);
  assert.deepEqual(store.state().transactions, originalTransactions);
  assert.equal(amount(store, cash), 20000);
  assert.equal(netWorth(store), 20000);
  const backup = store.export();
  store.command({ type: 'save_spending_limit', limit: { ...limit, dailyCents: 0 } });
  store.command({ type: 'record_asset_sale', asset: { ...asset, status: 'sold', soldDate: day, saleCents: 85000, feesCents: 5000 }, expected: asset, cashAccountId: cash, requestId: 'asset-sale' });
  assert.equal(store.state().assets?.length, 1);
  assert.equal(store.state().assets?.[0].status, 'sold');
  assert.equal(store.state().transactions.length, originalTransactions.length + 1);
  assert.equal(netWorth(store), 100000);
  store.restore(backup);
  store.close();
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state().spendingLimits, [limit]); assert.deepEqual(reopened.state().assets, [asset]); assert.equal(netWorth(reopened), 20000); }
  finally { reopened.close(); }
});

test('spending limits reject invalid money, missing owners, and overlapping category aliases atomically', t => {
  const { store } = setup(t);
  const limit = { id: 'personal:food', entityId: 'personal', name: 'Food', color: '#DBAA88', aliases: ['Groceries', 'Coffee'], dailyCents: 2500, weeklyCents: null, monthlyCents: 60000 };
  store.command({ type: 'save_spending_limit', limit });
  const baseline = store.state();
  for (const patch of [{ dailyCents: -1 }, { monthlyCents: 1.5 }, { color: 'red' }, { entityId: 'missing' }, { aliases: ['Coffee', ' coffee '] }]) assert.throws(() => store.command({ type: 'save_spending_limit', limit: { ...limit, ...patch } }));
  assert.throws(() => store.command({ type: 'save_spending_limit', limit: { ...limit, id: 'personal:other', name: 'Other', aliases: ['  GROCERIES  '] } }), /another spending limit/);
  assert.deepEqual(store.state(), baseline);
  store.command({ type: 'add_entity', name: 'Business', ownershipBps: 10000 });
  const businessId = store.state().entities.find(entity => entity.kind === 'business')!.id;
  store.command({ type: 'save_spending_limit', limit: { ...limit, id: 'business:food', entityId: businessId } });
  assert.equal(store.state().spendingLimits?.length, 2);
});

test('asset register rejects invalid sale dates, future purchases, partial sales and unsafe cents', t => {
  const { store } = setup(t);
  const asset = { id: 'camera', entityId: 'personal', name: 'Camera', category: 'Electronics', purchaseDate: '2026-01-01', costCents: 10000, estimatedValueCents: 8000, status: 'owned' as const, soldDate: null, saleCents: null, feesCents: 0, notes: '' };
  const baseline = store.state();
  for (const patch of [{ purchaseDate: '2026-02-30' }, { purchaseDate: '2199-01-01' }, { costCents: -1 }, { estimatedValueCents: 1.1 }, { feesCents: Number.MAX_SAFE_INTEGER + 1 }, { entityId: 'missing' }, { soldDate: day, saleCents: 8000 }]) assert.throws(() => store.command({ type: 'save_asset', asset: { ...asset, ...patch } }));
  assert.throws(() => store.command({ type: 'save_asset', asset: { ...asset, status: 'sold', soldDate: null, saleCents: 8000 } }), /sale date/);
  assert.throws(() => store.command({ type: 'save_asset', asset: { ...asset, status: 'sold', soldDate: '2025-12-31', saleCents: 8000 } }), /on or after/);
  assert.throws(() => store.command({ type: 'save_asset', asset: { ...asset, status: 'sold', soldDate: '2199-01-01', saleCents: 8000 } }), /future/);
  assert.deepEqual(store.state(), baseline);
});

test('old backups without inventory or limits still restore and malformed new arrays reject', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 20000);
  const backup = store.export();
  delete backup.data.spendingLimits;
  delete backup.data.assets;
  store.restore(backup);
  assert.deepEqual(store.state().spendingLimits, []);
  assert.deepEqual(store.state().assets, []);
  assert.equal(amount(store, cash), 20000);
  const malformed = store.export();
  malformed.data.assets = [{ id: 'broken' }] as never;
  const baseline = store.state();
  assert.throws(() => store.restore(malformed));
  assert.deepEqual(store.state(), baseline);
});

test('category batches save once, preserve balances and postings, and undo through guarded changes', t => {
  const { store } = setup(t);
  const card = account(store, 'Card', 'debt', 10000);
  tx(store, 'expense', card, 2500, 'first');
  tx(store, 'expense', card, 1000, 'second');
  const before = store.state();
  const postings = store.export().data.entries;
  const changes = before.transactions.filter(row => row.kind === 'expense').map(row => ({ id: row.id, expectedCategory: row.category, category: 'Food' }));
  const command: Command = { type: 'categorize_transactions', changes, requestId: 'batch', expectedRevision: before.revision };
  const saved = store.command(command);
  assert.equal(saved.revision, before.revision + 1);
  assert.equal(saved.audit.length, before.audit.length + 1);
  assert.ok(saved.transactions.filter(row => row.kind === 'expense').every(row => row.category === 'Food'));
  assert.deepEqual(saved.accounts, before.accounts);
  assert.deepEqual(store.export().data.entries, postings);
  assert.deepEqual(store.command(command).transactions, saved.transactions);
  assert.equal(store.state().revision, saved.revision);
  const undone = store.command({ type: 'categorize_transactions', changes: changes.map(change => ({ id: change.id, expectedCategory: change.category, category: change.expectedCategory })), requestId: 'undo-batch', expectedRevision: saved.revision });
  assert.deepEqual(undone.transactions, before.transactions);
  assert.deepEqual(undone.accounts, before.accounts);
});

test('category batches reject conflicts, duplicate rows, nonexpenses and missing guards without partial saves', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 10000);
  tx(store, 'expense', cash, 2500, 'first');
  tx(store, 'expense', cash, 1000, 'second');
  const before = store.state();
  const rows = before.transactions.filter(row => row.kind === 'expense');
  const change = { id: rows[0].id, expectedCategory: rows[0].category, category: 'Food' };
  const batch: Extract<Command, { type: 'categorize_transactions' }> = { type: 'categorize_transactions', changes: [change], requestId: 'invalid-batch', expectedRevision: before.revision };
  for (const command of [
    { ...batch, changes: [change, { id: rows[1].id, expectedCategory: 'Wrong', category: 'Food' }] },
    { ...batch, changes: [change, change] },
    { ...batch, changes: [change, { id: 'missing', expectedCategory: '', category: 'Food' }] },
    { ...batch, changes: [change, { id: before.transactions.find(row => row.kind === 'opening')!.id, expectedCategory: '', category: 'Food' }] },
    { ...batch, changes: [] },
    { ...batch, expectedRevision: before.revision - 1 },
    { ...batch, expectedRevision: undefined },
    { ...batch, requestId: undefined },
  ]) {
    assert.throws(() => store.command(command as Command));
    assert.deepEqual(store.state(), before);
  }
});

test('category batches update statement purchases and refunds and reject stale undo atomically', t => {
  const { store } = setup(t);
  const card = account(store, 'Card', 'debt', 10000);
  store.command({ type: 'import_statement', requestId: 'statement', statement: {
    id: 'statement', accountId: card, sourceFile: 'statement.pdf', sha256: 'a'.repeat(64), periodStart: '2026-01-01', periodEnd: '2026-01-31', openingBalanceCents: 10000, closingBalanceCents: 10900,
    rows: [{id:'purchase',transactionDate:'2026-01-02',postingDate:'2026-01-03',description:'Shop',amountCents:1000,kind:'purchase',category:'Uncategorized',sourcePage:1},{id:'refund',transactionDate:'2026-01-04',postingDate:'2026-01-05',description:'Shop',amountCents:-100,kind:'refund',category:'Uncategorized',sourcePage:1}],
  } });
  const before = store.state();
  const changes = before.transactions.filter(row => row.kind === 'expense').map(row => ({ id: row.id, expectedCategory: row.category, category: 'Personal' }));
  const saved = store.command({type:'categorize_transactions',changes,requestId:'statement-batch',expectedRevision:before.revision});
  assert.ok(saved.statements![0].rows.every(row => row.category === 'Personal'));
  assert.deepEqual(saved.accounts, before.accounts);
  store.command({type:'categorize_transaction',id:changes[1].id,expectedCategory:'Personal',category:'Other',requestId:'later-edit'});
  const later = store.state();
  assert.throws(() => store.command({type:'categorize_transactions',changes:changes.map(change=>({id:change.id,expectedCategory:'Personal',category:change.expectedCategory})),requestId:'stale-undo',expectedRevision:later.revision}), /category changed/);
  assert.deepEqual(store.state(),later);
});

test('category batches propagate to staged statement decisions without rewriting raw evidence', t => {
  const { store } = setup(t);
  const cash = account(store, 'Cash', 'cash', 10000);
  const source = {id:'bank',accountId:cash,sourceFile:'bank.pdf',sha256:'b'.repeat(64),periodStart:'2026-01-01',periodEnd:'2026-01-31',openingBalanceCents:10000,closingBalanceCents:9100,rows:[{id:'buy',transactionDate:'2026-01-02',postingDate:'2026-01-03',description:'Shop',amountCents:-1000,sourcePage:1},{id:'refund',transactionDate:'2026-01-04',postingDate:'2026-01-05',description:'Shop refund',amountCents:100,sourcePage:1}]};
  store.command({type:'stage_statement',statement:source,requestId:'stage'});
  store.command({type:'review_statement',importId:source.id,decisions:[{rowId:'buy',kind:'expense',category:'Uncategorized'},{rowId:'refund',kind:'refund',category:'Uncategorized'}],requestId:'review',expectedRevision:store.state().revision});
  store.command({type:'commit_statements',importIds:[source.id],requestId:'commit',expectedRevision:store.state().revision});
  const before = store.state();
  const saved = store.command({type:'categorize_transactions',changes:before.transactions.filter(row=>row.kind==='expense').map(row=>({id:row.id,expectedCategory:row.category,category:'Food'})),requestId:'batch',expectedRevision:before.revision});
  assert.deepEqual(saved.importBatches![0].source,source);
  assert.ok(saved.importBatches![0].decisions.every(row=>row.category==='Food'));
  assert.deepEqual(saved.accounts,before.accounts);
  store.restore(store.export());
});
