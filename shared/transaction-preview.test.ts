import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewTransaction } from './transaction-preview.ts';
import type { Account } from './types.ts';

const dates = { date: '2026-09-23', today: '2026-09-23' };
function account(id: string, type: Account['type'], balanceCents: number): Account {
  return { id, name: id, type, balanceCents, entityId: 'personal', currency: 'CAD', reconciledAt: null };
}

test('cash expenses reduce cash while credit purchases increase debt or unpaid bills', () => {
  const cash = previewTransaction({ ...dates, kind: 'expense', account: account('Bank', 'cash', 10_000), amountCents: 1_250 });
  assert.equal(cash.warning, '');
  assert.equal(cash.rows[0].after, 8_750);
  for (const type of ['debt', 'payable'] as const) {
    const credit = previewTransaction({ ...dates, kind: 'expense', account: account('Card', type, 10_000), amountCents: 1_250 });
    assert.equal(credit.warning, '');
    assert.equal(credit.rows[0].after, 11_250);
  }
});

test('income increases cash or money owed to the owner', () => {
  for (const type of ['cash', 'receivable'] as const) {
    const result = previewTransaction({ ...dates, kind: 'income', account: account('Income account', type, 5_000), amountCents: 2_501 });
    assert.equal(result.warning, '');
    assert.equal(result.rows[0].after, 7_501);
  }
});

test('cash deficits accept income and incoming transfers while keeping new outgoing payments blocked', () => {
  const bank = account('Bank', 'cash', -1250);
  const income = previewTransaction({ ...dates, kind: 'income', account: bank, amountCents: 2000 });
  assert.equal(income.warning, '');
  assert.equal(income.rows[0].after, 750);
  const transfer = previewTransaction({ ...dates, kind: 'transfer', account: account('Savings', 'cash', 2000), destination: bank, amountCents: 1500 });
  assert.equal(transfer.warning, '');
  assert.deepEqual(transfer.rows.map(row => row.after), [500, 250]);
  for (const kind of ['expense', 'transfer', 'debt_payment'] as const) {
    const result = previewTransaction({ ...dates, kind, account: bank, destination: account('Destination', kind === 'debt_payment' ? 'debt' : 'cash', 1000), amountCents: 1 });
    assert.match(result.warning, /recorded/);
    assert.deepEqual(result.rows, []);
  }
});

test('transfers preserve total account value across owners and do not mutate inputs', () => {
  const source = Object.freeze(account('Personal', 'cash', 10_000));
  const destination = Object.freeze({ ...account('Business', 'investment', 2_000), entityId: 'business' });
  const result = previewTransaction({ ...dates, kind: 'transfer', account: source, destination, amountCents: 3_333 });
  assert.equal(result.warning, '');
  assert.deepEqual(result.rows.map(row => row.after), [6_667, 5_333]);
  assert.equal(result.rows.reduce((sum, row) => sum + row.after, 0), source.balanceCents + destination.balanceCents);
  assert.equal(source.balanceCents, 10_000);
  assert.equal(destination.balanceCents, 2_000);
});

test('debt payments reduce cash and debt by the same amount, including full payoff', () => {
  const result = previewTransaction({ ...dates, kind: 'debt_payment', account: account('Bank', 'cash', 10_000), destination: account('Card', 'debt', 4_000), amountCents: 4_000 });
  assert.equal(result.warning, '');
  assert.deepEqual(result.rows.map(row => row.after), [6_000, 0]);
  assert.equal(result.rows[0].after - result.rows[1].after, 10_000 - 4_000);
});

test('overspending and debt overpayments return no projected balances', () => {
  const source = account('Bank', 'cash', 10_000);
  const destination = account('Card', 'debt', 4_000);
  for (const kind of ['expense', 'transfer', 'debt_payment'] as const) {
    const result = previewTransaction({ ...dates, kind, account: source, destination: kind === 'transfer' ? account('Savings', 'cash', 0) : destination, amountCents: 10_001 });
    assert.match(result.warning, /recorded/);
    assert.deepEqual(result.rows, []);
  }
  const overpayment = previewTransaction({ ...dates, kind: 'debt_payment', account: source, destination, amountCents: 4_001 });
  assert.match(overpayment.warning, /more than/);
  assert.deepEqual(overpayment.rows, []);
});

test('card credits absorb new purchases and never accept an extra debt payment', () => {
  const card = account('Card', 'debt', -2500);
  const purchase = previewTransaction({ ...dates, kind: 'expense', account: card, amountCents: 1000 });
  assert.equal(purchase.warning, '');
  assert.equal(purchase.rows[0].after, -1500);
  const payment = previewTransaction({ ...dates, kind: 'debt_payment', account: account('Bank', 'cash', 10000), destination: card, amountCents: 1 });
  assert.match(payment.warning, /more than/);
  assert.deepEqual(payment.rows, []);
});

test('future or invalid dates cannot produce a transaction preview', () => {
  const input = { ...dates, kind: 'income' as const, account: account('Bank', 'cash', 0), amountCents: 100 };
  assert.match(previewTransaction({ ...input, date: '2026-09-24' }).warning, /future date/);
  for (const date of ['2026-02-30', '1899-12-31', '2201-01-01', '']) {
    const result = previewTransaction({ ...input, date });
    assert.match(result.warning, /valid transaction date/);
    assert.deepEqual(result.rows, []);
  }
});

test('activity before a confirmed balance is blocked for both source and destination accounts', () => {
  const bank = Object.freeze({ ...account('Bank', 'cash', 10_000), reconciledAt: '2026-09-23' });
  for (const kind of ['income', 'expense', 'transfer', 'debt_payment'] as const) {
    const destination = kind === 'debt_payment' ? account('Card', 'debt', 4000) : account('Savings', 'cash', 0);
    const result = previewTransaction({ ...dates, kind, date: '2026-09-22', account: bank, destination, amountCents: 100 });
    assert.match(result.warning, /Bank has a confirmed balance on 2026-09-23/);
    assert.deepEqual(result.rows, []);
    assert.equal(previewTransaction({ ...dates, kind, account: bank, destination, amountCents: 100 }).warning, '');
  }
  for (const kind of ['transfer', 'debt_payment'] as const) {
    const source = { ...bank, reconciledAt: '2026-09-20' };
    const destination = Object.freeze({ ...account('Destination', kind === 'debt_payment' ? 'debt' : 'cash', 4000), reconciledAt: '2026-09-23' });
    const result = previewTransaction({ ...dates, kind, date: '2026-09-22', account: source, destination, amountCents: 100 });
    assert.match(result.warning, /Destination has a confirmed balance on 2026-09-23/);
    assert.deepEqual(result.rows, []);
    assert.equal(previewTransaction({ ...dates, kind, account: source, destination, amountCents: 100 }).warning, '');
  }
  assert.equal(previewTransaction({ ...dates, date: '2026-09-22', kind: 'expense', account: account('Unchecked', 'cash', 1000), amountCents: 100 }).warning, '');
});

test('backend cent limits and unsafe integers are rejected before showing balances', () => {
  const max = 100_000_000_000_000;
  const input = { ...dates, kind: 'income' as const, account: account('Bank', 'cash', 0), amountCents: 1 };
  for (const amountCents of [0, -1, 0.5, max + 1, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    const result = previewTransaction({ ...input, amountCents });
    assert.notEqual(result.warning, '');
    assert.deepEqual(result.rows, []);
  }
  assert.equal(previewTransaction({ ...input, amountCents: max }).rows[0].after, max);
  for (const balanceCents of [max, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const result = previewTransaction({ ...input, account: account('Bank', 'cash', balanceCents) });
    assert.match(result.warning, /supported range/);
    assert.deepEqual(result.rows, []);
  }
  const destinationOverflow = previewTransaction({ ...dates, kind: 'transfer', account: account('Bank', 'cash', 100), destination: account('Savings', 'cash', max), amountCents: 1 });
  assert.match(destinationOverflow.warning, /supported range/);
});

test('account roles, distinct destinations and SOL restrictions match transaction rules', () => {
  const bank = account('Bank', 'cash', 1_000);
  const investment = account('Investment', 'investment', 1_000);
  const debt = account('Debt', 'debt', 1_000);
  const input = { ...dates, amountCents: 1 };
  const results = [
    previewTransaction({ ...input, kind: 'income', account: debt }),
    previewTransaction({ ...input, kind: 'expense', account: investment }),
    previewTransaction({ ...input, kind: 'transfer', account: bank, destination: bank }),
    previewTransaction({ ...input, kind: 'transfer', account: bank, destination: debt }),
    previewTransaction({ ...input, kind: 'debt_payment', account: investment, destination: debt }),
    previewTransaction({ ...input, kind: 'debt_payment', account: bank, destination: investment }),
    previewTransaction({ ...input, kind: 'transfer', account: investment, destination: bank, solAccountIds: new Set([investment.id]) }),
    previewTransaction({ ...input, kind: 'transfer', account: bank, destination: investment, solAccountIds: new Set([investment.id]) }),
  ];
  for (const result of results) {
    assert.notEqual(result.warning, '');
    assert.deepEqual(result.rows, []);
  }
});
