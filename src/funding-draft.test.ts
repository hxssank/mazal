import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppState, RoadmapSettings } from '../shared/types.ts';
import { fundingDefaults, restoreFundingDraft } from './features/planner/funding-draft.ts';

const base: AppState = { workspace: 'demo', revision: 0, entities: [{ id: 'personal', name: 'Personal', kind: 'personal', ownershipBps: 10000 }, { id: 'business', name: 'Business', kind: 'business', ownershipBps: 10000 }], accounts: [], transactions: [], obligations: [], reserves: [], positions: [], audit: [], lastBackupAt: null };
const roadmap: RoadmapSettings = { currentMonthlyIncomeCents: null, partTimeMonthlyIncomeCents: null, monthlyEssentialsCents: null, monthlyDebtMinimumsCents: null, transitionDate: '2027-01-01', transitionMonths: 1, monthlyExtraDebtCents: 0, loanAccountId: '', loanAprPercent: null, loanMonthlyPaymentCents: null };

test('a dated work schedule replaces the open-ended income assumption in saved comparison drafts', () => {
  const old = fundingDefaults({ ...base, roadmap: { ...roadmap, partTimeMonthlyIncomeCents: 100000 } });
  const saved = JSON.stringify({ version: 1, draft: { ...old, transitionIncome: '1234' } });
  const updated = fundingDefaults({ ...base, roadmap: { ...roadmap, temporaryWorkSchedule: {
    weeklyHours: 20, fullTimeWeeklyHours: 37.5, returnDate: '2027-05-01', payPeriodEndLagDays: 5,
  } } });
  const draft = restoreFundingDraft(saved, updated);
  assert.equal(draft.transitionIncome, '');
  assert.equal(draft.transitionDate, '');
});

test('funding comparisons start from the saved personal reserve floor, including explicit zero', () => {
  assert.equal(fundingDefaults(base).reserve, '');
  assert.equal(fundingDefaults(base).reserveConfirmed, false);
  const zero = fundingDefaults({ ...base, roadmap: { ...roadmap, planningCashReserveCents: 0 } });
  assert.equal(zero.reserve, '0.00');
  assert.equal(zero.reserveConfirmed, true);
  const state = { ...base, roadmap: { ...roadmap, planningCashReserveCents: 50000 }, reserves: [{ id: 'rent', entityId: 'personal', name: 'Rent', amountCents: 100000 }, { id: 'tax', entityId: 'business', name: 'Tax', amountCents: 500000 }] };
  assert.equal(fundingDefaults(state).reserve, '1000.00');
  assert.equal(fundingDefaults(state).reserveConfirmed, true);
  assert.equal(fundingDefaults({ ...state, roadmap: { ...roadmap, planningCashReserveCents: null } }).reserveConfirmed, false);
});
