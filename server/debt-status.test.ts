import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import type { DebtTerms } from '../shared/types.ts';

test('in-study status preserves unknown terms and account money through restart and backup restore', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-debt-status-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  store.command({ type: 'add_account', entityId: 'personal', name: 'Student loan', accountType: 'debt', openingBalanceCents: 1192000, openingDate: '2026-01-01' });
  const accountId = store.state().accounts[0].id;
  const transactions = store.state().transactions;
  const terms: DebtTerms = { aprPercent: null, rateConfirmed: false, minimumPaymentCents: null, notes: 'Reported by owner. Current lender status needs confirmation.', repaymentStatus: 'in_study', repaymentStatusSource: 'owner', repaymentStatusAsOf: '2026-09-24', schoolReturnMonth: '2027-01' };
  store.command({ type: 'set_debt_terms', accountId, terms });
  assert.deepEqual(store.state().accounts[0].debtTerms, terms);
  assert.equal(store.state().accounts[0].balanceCents, 1192000);
  assert.deepEqual(store.state().transactions, transactions);
  for (const patch of [{ repaymentStatus: 'graduated' }, { repaymentStatusSource: 'guessed' }, { repaymentStatusSource: undefined }, { repaymentStatusAsOf: '2099-01-01' }, { schoolReturnMonth: '2027-13' }, { schoolReturnMonth: '2027-01-01' }]) {
    assert.throws(() => store.command({ type: 'set_debt_terms', accountId, terms: { ...terms, ...patch } as DebtTerms }));
    assert.deepEqual(store.state().accounts[0].debtTerms, terms);
  }
  const backup = store.export();
  store.command({ type: 'set_debt_terms', accountId, terms: { ...terms, repaymentStatus: 'repaying', repaymentStatusSource: 'lender', minimumPaymentCents: 10000 } });
  store.restore(backup);
  assert.deepEqual(store.state().accounts[0].debtTerms, terms);
  store.close();
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state().accounts[0].debtTerms, terms); assert.equal(reopened.state().accounts[0].balanceCents, 1192000); } finally { reopened.close(); }
});
