import { addCents, today } from './analytics.ts';
import { buildExpensePlan } from './expense-plan.ts';
import { periodBounds } from './spending.ts';
import { statementCoverage } from './statement-imports.ts';
import type { AppState } from './types.ts';

export interface ExpenseCategoryComparison {
  spentCents: number;
  transactionCount: number;
  differenceCents: number | null;
  direction: 'higher' | 'lower' | 'same' | 'unavailable';
}

export interface ExpenseComparison {
  previousMonth: string;
  start: string;
  end: string;
  partialPeriod: boolean;
  hasHistory: boolean;
  coverageComplete: boolean;
  byCategoryId: Map<string, ExpenseCategoryComparison>;
}

export function buildExpenseComparison(state: AppState, ownerId: string, month: string, asOf = today()): ExpenseComparison {
  const current = buildExpensePlan(state, ownerId, month, asOf);
  const previousDate = new Date(`${current.start}T12:00:00.000Z`);
  previousDate.setUTCMonth(previousDate.getUTCMonth() - 1);
  const previousMonth = previousDate.toISOString().slice(0, 7);
  const previousBounds = periodBounds('monthly', `${previousMonth}-01`);
  const partialPeriod = month === asOf.slice(0, 7);
  const available = month <= asOf.slice(0, 7);
  const end = partialPeriod
    ? `${previousMonth}-${String(Math.min(Number(asOf.slice(8)), Number(previousBounds.end.slice(8)))).padStart(2, '0')}`
    : previousBounds.end;
  const previous = buildExpensePlan(state, ownerId, previousMonth, end < asOf ? end : asOf);
  const coverageComplete = statementCoverage(state, ownerId, month).status === 'complete' && statementCoverage(state, ownerId, previousMonth).status === 'complete';
  const previousById = new Map(previous.rows.map(row => [row.limit.id, row]));
  const byCategoryId = new Map<string, ExpenseCategoryComparison>();
  for (const row of current.rows) {
    const previousRow = previousById.get(row.limit.id);
    const spentCents = previousRow?.spentCents ?? 0;
    const transactionCount = previousRow?.transactionCount ?? 0;
    const differenceCents = available && transactionCount > 0 ? addCents(row.spentCents, -spentCents) : null;
    const direction = differenceCents === null ? 'unavailable' : differenceCents > 0 ? 'higher' : differenceCents < 0 ? 'lower' : 'same';
    byCategoryId.set(row.limit.id, { spentCents, transactionCount, differenceCents, direction });
  }
  return { previousMonth, start: previousBounds.start, end, partialPeriod, hasHistory: available && previous.transactionCount > 0, coverageComplete, byCategoryId };
}
