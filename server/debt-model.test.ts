import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import type { DebtTerms } from '../shared/types.ts';

test('structured loan terms survive restart and restore; invalid updates leave the account unchanged', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mazal-debt-model-'));
  const path = join(directory, 'live.sqlite');
  const store = createStore(path, 'live');
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  store.command({ type: 'add_account', entityId: 'personal', name: 'OSAP', accountType: 'debt', openingBalanceCents: 1000000, openingDate: '2026-01-01' });
  const accountId = store.state().accounts[0].id;
  const terms: DebtTerms = { aprPercent: null, rateConfirmed: false, minimumPaymentCents: null, notes: '', repaymentKind: 'revolving', interestStatus: 'unknown', repaymentStatus: 'in_study', repaymentStatusSource: 'owner', studyEndDate: null, repaymentStartDate: null,
    components: [{ id: 'federal', balanceCents: null, aprPercent: null, rateConfirmed: false, interestStatus: 'unknown' }, { id: 'ontario', balanceCents: null, aprPercent: null, rateConfirmed: false, interestStatus: 'unknown' }] };
  store.command({ type: 'set_debt_terms', accountId, terms });
  assert.deepEqual(store.state().accounts[0].debtTerms, terms);
  for (const patch of [{ repaymentKind: 'unknown_kind' }, { interestStatus: 'guess' }, { studyEndDate: '2026-02-30' }, { components: [terms.components![0], terms.components![0]] }, { components: [{ ...terms.components![0], balanceCents: 0.5 }] }, { components: [{ ...terms.components![0], rateConfirmed: true }] }]) {
    assert.throws(() => store.command({ type: 'set_debt_terms', accountId, terms: { ...terms, ...patch } as DebtTerms }));
    assert.deepEqual(store.state().accounts[0].debtTerms, terms);
  }
  const backup = store.export();
  store.command({ type: 'set_debt_terms', accountId, terms: { ...terms, components: [], repaymentKind: 'interest_only', interestStatus: 'accruing', aprPercent: 5.45, rateConfirmed: true } });
  store.restore(backup);
  assert.deepEqual(store.state().accounts[0].debtTerms, terms);
  store.close();
  const reopened = createStore(path, 'live');
  try { assert.deepEqual(reopened.state().accounts[0].debtTerms, terms); assert.equal(reopened.state().accounts[0].balanceCents, 1000000); } finally { reopened.close(); }
});
