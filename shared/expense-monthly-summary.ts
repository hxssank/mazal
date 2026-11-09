import { addCents } from './analytics.ts';
import { buildExpenseSchedule, debtScheduleDetails } from './expense-schedule.ts';
import type { AppState, Obligation, Transaction } from './types.ts';

export interface ExpenseMonthlyBill {
  id: string;
  sourceType: 'obligation' | 'debt' | 'recorded';
  sourceId: string;
  entityId: string;
  name: string;
  amountCents: number | null;
  dueDate: string | null;
  recurrence: 'monthly' | 'biweekly' | null;
  status: 'scheduled' | 'overdue' | 'needs_schedule' | 'needs_date';
  category: string;
  subscription: boolean;
  ownershipBps: number;
  recordedMonthCents: number;
  transactionIds: string[];
  lastPayment: { transactionId: string; date: string; amountCents: number } | null;
}

export interface ExpenseMonthlySummary {
  month: string;
  asOf: string;
  recordedBillsCents: number;
  currentBills: ExpenseMonthlyBill[];
  scheduledMonthlyCents: number;
  unscheduledCount: number;
}

const recordedMerchants = [
  { id: 'goodlife', name: 'GoodLife', pattern: /\bGOODLIFE\b/i, category: 'Personal' },
  { id: 'chatgpt', name: 'ChatGPT', pattern: /\bCHATGPT\b/i, category: 'Subscriptions' },
];
const merchantFor = (name: string) => recordedMerchants.find(merchant => merchant.pattern.test(name));
const billId = (sourceType: ExpenseMonthlyBill['sourceType'], sourceId: string) => `${sourceType}:${sourceId}`;
const recurringExpense = (bill: Obligation) => bill.direction === 'out' && bill.recurrence !== 'once' && !bill.assetPurchaseId;

function weightedCents(amount: number, ownershipBps: number): number {
  const value = BigInt(amount) * BigInt(ownershipBps);
  return Number((value + (value < 0n ? -5000n : 5000n)) / 10000n);
}

export function buildExpenseMonthlySummary(state: AppState, ownerId: string, month: string, asOf: string): ExpenseMonthlySummary {
  const asOfDate = new Date(`${asOf}T12:00:00Z`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Choose a calendar month as YYYY-MM.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(asOfDate.getTime()) || asOfDate.toISOString().slice(0, 10) !== asOf) throw new Error('Choose a valid summary date.');
  const included = (entityId: string) => ownerId === 'all' || entityId === ownerId;
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const ownership = new Map(state.entities.map(entity => [entity.id, ownerId === 'all' ? entity.ownershipBps : 10000]));
  const obligations = new Map(state.obligations.filter(bill => included(bill.entityId) && recurringExpense(bill)).map(bill => [bill.id, bill]));
  const rows = new Map<string, ExpenseMonthlyBill>();
  const merchantBills = new Map<string, Obligation[]>();
  const suppressedObservations = new Set<string>();
  const result: ExpenseMonthlySummary = { month, asOf, recordedBillsCents: 0, currentBills: [], scheduledMonthlyCents: 0, unscheduledCount: 0 };
  let annualCents = 0;

  for (const bill of obligations.values()) {
    const merchant = merchantFor(bill.name);
    if (merchant) {
      const key = `${bill.entityId}:${merchant.id}`;
      merchantBills.set(key, [...merchantBills.get(key) ?? [], bill]);
    }
    const ownershipBps = ownership.get(bill.entityId) ?? 0;
    const amountCents = weightedCents(bill.amountCents, ownershipBps);
    const id = billId('obligation', bill.id);
    const dueDate = bill.status === 'paid'
      ? buildExpenseSchedule({ ...state, accounts: [], obligations: [bill], roadmap: undefined }, ownerId, bill.dueDate > asOf ? bill.dueDate : asOf, 32).upcoming.find(event => event.sourceType === 'obligation' && event.sourceId === bill.id)?.date ?? null
      : bill.dueDate;
    rows.set(id, {
      id, sourceType: 'obligation', sourceId: bill.id, entityId: bill.entityId, name: bill.name,
      amountCents, dueDate, recurrence: bill.recurrence === 'biweekly' ? 'biweekly' : 'monthly',
      status: !dueDate ? 'needs_date' : dueDate < asOf ? 'overdue' : 'scheduled', category: bill.category,
      subscription: !!bill.subscription, ownershipBps, recordedMonthCents: 0, transactionIds: [], lastPayment: null,
    });
    if (bill.status !== 'cancelled') annualCents = addCents(annualCents, amountCents * (bill.recurrence === 'biweekly' ? 26 : 12));
  }

  const recorded = state.transactions.filter(transaction => transaction.kind === 'expense' && transaction.date <= asOf && included(accounts.get(transaction.accountId)?.entityId ?? ''));
  const byTransaction = new Map(recorded.map(transaction => [transaction.id, transaction]));
  const reversedIds = new Set(state.transactions.filter(transaction => transaction.date <= asOf && transaction.reversalOf).map(transaction => transaction.reversalOf));
  const groupByTransaction = new Map<string, string | null>();
  function group(transaction: Transaction, visited = new Set<string>()): string | null {
    if (groupByTransaction.has(transaction.id)) return groupByTransaction.get(transaction.id)!;
    if (visited.has(transaction.id)) return null;
    visited.add(transaction.id);
    const account = accounts.get(transaction.accountId);
    if (!account) return null;
    const obligationId = transaction.plannedPayment?.obligationId ?? (transaction.source.startsWith('Planned payment ') ? transaction.source.slice('Planned payment '.length) : null);
    const obligation = obligationId ? obligations.get(obligationId) : null;
    let id: string | null = obligation?.entityId === account.entityId ? billId('obligation', obligation.id) : null;
    const original = transaction.refundOf ?? transaction.reversalOf;
    if (!id && original) {
      const originalTransaction = byTransaction.get(original);
      if (originalTransaction && accounts.get(originalTransaction.accountId)?.entityId === account.entityId) id = group(originalTransaction, visited);
    }
    const merchant = merchantFor(transaction.description);
    if (!id && merchant) {
      const key = `${account.entityId}:${merchant.id}`;
      const saved = merchantBills.get(key);
      const active = saved?.filter(bill => bill.status !== 'cancelled') ?? [];
      if (active.length === 1) id = billId('obligation', active[0].id);
      else if (saved?.length === 1) id = billId('obligation', saved[0].id);
      else {
        id = billId('recorded', key);
        if (saved?.length) suppressedObservations.add(id);
        if (!rows.has(id)) rows.set(id, {
          id, sourceType: 'recorded', sourceId: merchant.id, entityId: account.entityId, name: merchant.name,
          amountCents: null, dueDate: null, recurrence: null, status: 'needs_schedule', category: merchant.category,
          subscription: true, ownershipBps: ownership.get(account.entityId) ?? 0,
          recordedMonthCents: 0, transactionIds: [], lastPayment: null,
        });
      }
    }
    groupByTransaction.set(transaction.id, id);
    return id;
  }

  for (const transaction of recorded) {
    const id = group(transaction);
    const row = id ? rows.get(id) : null;
    if (!row) continue;
    const amountCents = weightedCents(transaction.amountCents, row.ownershipBps);
    if (transaction.date.slice(0, 7) === month) {
      row.recordedMonthCents = addCents(row.recordedMonthCents, amountCents);
      row.transactionIds.push(transaction.id);
      result.recordedBillsCents = addCents(result.recordedBillsCents, amountCents);
    }
    if (transaction.amountCents > 0 && !transaction.reversalOf && !reversedIds.has(transaction.id)
      && (!row.lastPayment || transaction.date > row.lastPayment.date || transaction.date === row.lastPayment.date && transaction.id > row.lastPayment.transactionId)) {
      row.lastPayment = { transactionId: transaction.id, date: transaction.date, amountCents };
      if (row.sourceType === 'recorded') row.amountCents = amountCents;
    }
  }

  const schedule = buildExpenseSchedule(state, ownerId, asOf, 90);
  const debtPayments = new Map([...schedule.past, ...schedule.upcoming].filter(event => event.sourceType === 'debt' && !event.isProjection).map(event => [event.sourceId, event]));
  for (const account of state.accounts) {
    if (!included(account.entityId) || account.closedAt || !['fixed', 'interest_only'].includes(account.debtTerms?.repaymentKind ?? '')) continue;
    const payment = debtScheduleDetails(account, schedule.through);
    if (!payment) continue;
    const ownershipBps = ownership.get(account.entityId) ?? 0;
    const scheduled = debtPayments.get(account.id);
    const remaining = scheduled ? scheduled.amountCents : payment.minimumCents === null ? null : account.debtTerms?.repaymentKind === 'interest_only' ? payment.minimumCents : Math.min(account.balanceCents, payment.minimumCents);
    if (remaining === 0) continue;
    const dueDate = payment.needsDateConfirmation ? null : payment.dueDate;
    const id = billId('debt', account.id);
    rows.set(id, {
      id, sourceType: 'debt', sourceId: account.id, entityId: account.entityId, name: account.name,
      amountCents: remaining === null ? null : weightedCents(remaining, ownershipBps), dueDate, recurrence: null,
      status: !dueDate ? 'needs_date' : dueDate < asOf ? 'overdue' : 'scheduled', category: 'Debt payment',
      subscription: false, ownershipBps, recordedMonthCents: 0, transactionIds: [], lastPayment: null,
    });
  }

  const oldestObservation = new Date(asOfDate.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  result.currentBills = [...rows.values()].filter(row => row.sourceType === 'obligation' ? obligations.get(row.sourceId)?.status !== 'cancelled' : row.sourceType !== 'recorded' || !!row.lastPayment && row.lastPayment.date >= oldestObservation && !suppressedObservations.has(row.id))
    .sort((a, b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  result.scheduledMonthlyCents = Math.round(annualCents / 12);
  result.unscheduledCount = result.currentBills.filter(row => row.status === 'needs_schedule' || row.status === 'needs_date').length;
  return result;
}
