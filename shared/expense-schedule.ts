import { addCents, recordedObligationDates, today } from './analytics.ts';
import { debtPaymentStatus, requiredDebtPaymentCents } from './debt-status.ts';
import { debtRepaymentKind } from './debt-model.ts';
import { expensePayDates, projectedPayCents } from './expense-pay.ts';
import { purchaseRemaining } from './asset-purchases.ts';
import { isStatementCardPayment } from './ledger.ts';
import type { Account, AppState, Obligation } from './types.ts';

export interface ExpenseScheduleEvent {
  key: string;
  sourceType: 'obligation' | 'payday' | 'debt';
  sourceId: string;
  entityId: string;
  name: string;
  date: string;
  direction: 'in' | 'out';
  amountCents: number | null;
  accountId?: string;
  isProjection: boolean;
  recurrence?: Obligation['recurrence'];
  subscription?: boolean;
  category?: string;
  needsStatementConfirmation?: boolean;
  incomeTreatment?: 'scheduled' | 'additional' | 'in_regular_pay' | 'needs_confirmation' | 'after_transition';
}

export interface ExpenseSchedule {
  asOf: string;
  through: string;
  horizonDays: number;
  hasRegularPaySchedule: boolean;
  upcoming: ExpenseScheduleEvent[];
  past: ExpenseScheduleEvent[];
  totals: {
    paydayIncomeCents: number;
    obligationIncomeCents: number;
    outgoingCents: number;
    unknownOutgoingCount: number;
    unknownPaydayIncomeCount: number;
    unconfirmedObligationIncomeCount: number;
    alreadyIncludedIncomeCount: number;
  };
}

const DAY_MS = 86_400_000;
function calendarDate(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}
function dateText(date: Date): string | null {
  return date.getUTCFullYear() > 9999 ? null : date.toISOString().slice(0, 10);
}
function monthAfter(anchor: Date, offset: number, recurrenceDay?: number): string | null {
  const next = new Date(anchor);
  next.setUTCDate(1);
  next.setUTCMonth(anchor.getUTCMonth() + offset);
  const lastDay = new Date(next);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  next.setUTCDate(Math.min(recurrenceDay ?? anchor.getUTCDate(), lastDay.getUTCDate()));
  return dateText(next);
}
function key(sourceType: ExpenseScheduleEvent['sourceType'], sourceId: string, date: string): string {
  return `${sourceType}:${encodeURIComponent(sourceId)}:${date}`;
}

export function debtScheduleDetails(account: Account, through: string): { dueDate: string | null; minimumCents: number | null; needsDateConfirmation: boolean; repaymentStartDate: string | null } | null {
  if (!['debt', 'payable'].includes(account.type) || account.balanceCents <= 0 || debtPaymentStatus(account, through) === 'in_study') return null;
  const terms = account.debtTerms;
  const dueDate = terms?.paymentDueDate && calendarDate(terms.paymentDueDate) ? terms.paymentDueDate : null;
  const repaymentStartDate = terms?.repaymentStatus === 'in_study' ? terms.repaymentStartDate ?? null : null;
  return {
    dueDate, repaymentStartDate,
    minimumCents: requiredDebtPaymentCents(account, through),
    needsDateConfirmation: !dueDate || !!repaymentStartDate && dueDate < repaymentStartDate,
  };
}

export function buildExpenseSchedule(state: AppState, ownerId: string, asOf = today(), days = 30): ExpenseSchedule {
  const start = calendarDate(asOf);
  if (!start) throw new Error('Choose a valid schedule start date.');
  if (!Number.isSafeInteger(days) || days < 0) throw new Error('Choose a schedule period in nonnegative whole days.');
  const horizonDays = Math.min(days, 90);
  const end = new Date(start.getTime() + horizonDays * DAY_MS);
  if (end.getUTCFullYear() > 9999) throw new Error('The schedule ends outside the supported date range.');
  const through = end.toISOString().slice(0, 10);
  const included = (entityId: string) => ownerId === 'all' || entityId === ownerId;
  const personal = state.entities.find(entity => entity.kind === 'personal');
  const interval = state.roadmap?.payEveryDays;
  const anchor = state.roadmap?.paydayAnchor;
  const hasRegularPaySchedule = !!personal && included(personal.id) && !!anchor && !!calendarDate(anchor) && Number.isInteger(interval) && Number(interval) >= 1 && Number(interval) <= 366;
  const result: ExpenseSchedule = { asOf, through, horizonDays, hasRegularPaySchedule, upcoming: [], past: [], totals: { paydayIncomeCents: 0, obligationIncomeCents: 0, outgoingCents: 0, unknownOutgoingCount: 0, unknownPaydayIncomeCount: 0, unconfirmedObligationIncomeCount: 0, alreadyIncludedIncomeCount: 0 } };
  function add(row: ExpenseScheduleEvent) {
    if (row.date > through) return;
    if (row.date >= asOf) result.upcoming.push(row);
    else if (!row.isProjection) result.past.push(row);
  }

  const recorded = recordedObligationDates(state.transactions);
  for (const obligation of state.obligations) {
    if (!included(obligation.entityId) || obligation.status === 'cancelled' || obligation.dueDate > through) continue;
    const anchor = calendarDate(obligation.dueDate);
    if (!anchor) continue;
    const occurrence = (date: string, isProjection: boolean): ExpenseScheduleEvent => ({
      key: key('obligation', obligation.id, date), sourceType: 'obligation', sourceId: obligation.id,
      entityId: obligation.entityId, name: obligation.name, date, direction: obligation.direction,
      amountCents: obligation.amountCents, ...(obligation.accountId ? { accountId: obligation.accountId } : {}),
      isProjection, recurrence: obligation.recurrence, category: obligation.category,
      ...(obligation.subscription === undefined ? {} : { subscription: obligation.subscription }),
      ...(obligation.direction !== 'in' ? {} : { incomeTreatment: hasRegularPaySchedule && obligation.entityId === personal?.id ? obligation.additionalToPay === true ? 'additional' : obligation.additionalToPay === false ? 'in_regular_pay' : 'needs_confirmation' : 'scheduled' }),
    });
    const paid = recorded.get(obligation.id);
    if (obligation.status === 'planned' && !paid?.has(obligation.dueDate)) add(occurrence(obligation.dueDate, false));
    if (obligation.recurrence === 'once') continue;
    let offset = obligation.recurrence === 'monthly'
      ? Math.max(1, (start.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + start.getUTCMonth() - anchor.getUTCMonth())
      : Math.max(1, Math.floor((start.getTime() - anchor.getTime()) / (14 * DAY_MS)));
    for (;;) {
      const date = obligation.recurrence === 'monthly'
        ? monthAfter(anchor, offset, obligation.recurrenceDay)
        : dateText(new Date(anchor.getTime() + offset * 14 * DAY_MS));
      if (date === null || date > through) break;
      if (date >= asOf && !paid?.has(date)) add(occurrence(date, true));
      offset += 1;
    }
  }

  if (personal && included(personal.id)) {
    const count = interval && Number.isInteger(interval) && interval > 0 ? Math.floor(horizonDays / interval) + 1 : 1;
    const cashAccounts = new Set(state.accounts.filter(account => account.entityId === personal.id && account.type === 'cash').map(account => account.id));
    const reversed = new Set(state.transactions.filter(transaction => transaction.date <= asOf && transaction.reversalOf).map(transaction => transaction.reversalOf));
    const receivedPaydays = new Set(state.transactions.filter(transaction => transaction.kind === 'income' && transaction.amountCents > 0
      && cashAccounts.has(transaction.accountId) && transaction.date <= asOf && transaction.paydayDate
      && !transaction.reversalOf && !reversed.has(transaction.id)).map(transaction => transaction.paydayDate));
    for (const date of expensePayDates(state.roadmap, asOf, count)) {
      if (receivedPaydays.has(date)) continue;
      const amountCents = projectedPayCents(state.roadmap, date);
      add({
        key: key('payday', personal.id, date), sourceType: 'payday', sourceId: personal.id,
        entityId: personal.id, name: 'Payday', date, direction: 'in',
        amountCents, incomeTreatment: amountCents === null && state.roadmap?.payAmountCents != null ? 'after_transition' : 'scheduled', isProjection: true,
      });
    }
  }

  for (const account of state.accounts) {
    if (!included(account.entityId)) continue;
    const payment = debtScheduleDetails(account, through);
    if (!payment?.dueDate || payment.needsDateConfirmation) continue;
    const date = payment.dueDate;
    const minimum = payment.minimumCents;
    let paid = 0;
    const statement = account.debtTerms?.statementDate;
    for (const transaction of state.transactions) {
      const posted = transaction.postingDates?.[account.id] ?? transaction.postingDate ?? transaction.date;
      if (posted > asOf || statement && posted <= statement) continue;
      if (transaction.kind === 'debt_payment' && transaction.toAccountId === account.id) paid = addCents(paid, transaction.amountCents);
      else if (transaction.accountId === account.id && isStatementCardPayment(transaction)) {
        const movement = transaction.balanceChanges?.[account.id] ?? (transaction.statementId ? -Math.abs(transaction.amountCents) : 0);
        paid = addCents(paid, -movement);
      }
    }
    const remaining = minimum === null ? null : Math.max(0, minimum - (statement ? Math.max(0, paid) : 0));
    const repaymentKind = debtRepaymentKind(account);
    const needsStatementConfirmation = !statement && minimum !== null && minimum > 0 && paid !== 0 && debtPaymentStatus(account, date) === 'repaying';
    const occurrence = (date: string, isProjection: boolean): ExpenseScheduleEvent => {
      const amount = isProjection ? minimum === 0 ? null : minimum : remaining;
      return { key: key('debt', account.id, date), sourceType: 'debt', sourceId: account.id,
        entityId: account.entityId, name: account.name, date, direction: 'out',
        amountCents: amount === null || repaymentKind === 'interest_only' ? amount : Math.min(account.balanceCents, amount),
        accountId: account.id, isProjection,
        ...(!isProjection && needsStatementConfirmation ? { needsStatementConfirmation: true } : {}) };
    };
    add(occurrence(date, false));
    if (repaymentKind === 'one_off') continue;
    const anchor = calendarDate(date)!;
    let offset = Math.max(1, (start.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + start.getUTCMonth() - anchor.getUTCMonth());
    for (;;) {
      const next = monthAfter(anchor, offset);
      if (next === null || next > through) break;
      if (next >= asOf && debtPaymentStatus(account, next) === 'repaying') add(occurrence(next, true));
      offset += 1;
    }
  }

  const order = (a: ExpenseScheduleEvent, b: ExpenseScheduleEvent) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  result.upcoming.sort(order);
  result.past.sort(order);
  const purchases = new Map((state.assetPurchases ?? []).map(purchase => [purchase.id, { owner: purchase.entityId, remaining: purchaseRemaining(purchase) }]));
  const bills = new Map(state.obligations.map(obligation => [obligation.id, obligation]));
  for (const row of [...result.past, ...result.upcoming]) {
    if (row.sourceType !== 'obligation' || row.direction !== 'out') continue;
    const purchaseId = bills.get(row.sourceId)?.assetPurchaseId;
    const purchase = purchaseId ? purchases.get(purchaseId) : undefined;
    if (!purchase || purchase.owner !== row.entityId) continue;
    row.amountCents = purchase.remaining === null ? null : Math.min(row.amountCents ?? 0, purchase.remaining);
    if (purchase.remaining !== null) purchase.remaining -= row.amountCents ?? 0;
  }
  for (const row of result.upcoming) {
    if (row.direction === 'out') {
      if (row.amountCents === null) result.totals.unknownOutgoingCount += 1;
      else result.totals.outgoingCents = addCents(result.totals.outgoingCents, row.amountCents);
    } else if (row.sourceType === 'payday') {
      if (row.amountCents === null) result.totals.unknownPaydayIncomeCount += 1;
      else result.totals.paydayIncomeCents = addCents(result.totals.paydayIncomeCents, row.amountCents);
    } else if (row.incomeTreatment === 'needs_confirmation') result.totals.unconfirmedObligationIncomeCount += 1;
    else if (row.incomeTreatment === 'in_regular_pay') result.totals.alreadyIncludedIncomeCount += 1;
    else if (row.amountCents !== null) result.totals.obligationIncomeCents = addCents(result.totals.obligationIncomeCents, row.amountCents);
  }
  return result;
}
