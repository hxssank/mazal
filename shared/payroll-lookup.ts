import { payrollIssues } from './payroll.ts';
import type { PayrollImport, PayrollPaystub, PayrollTimecard } from './payroll.ts';

const overlap = (a: string, b: string, start: string, end: string) => a <= end && b >= start;

export function findPayrollRecords(imports: readonly PayrollImport[], start: string, end: string) {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDate(start) || !validDate(end) || start > end) return null;
  const cards: { batch: PayrollImport; card: PayrollTimecard }[] = [];
  const pays: { batch: PayrollImport; pay: PayrollPaystub }[] = [];
  for (const batch of imports) {
    cards.push(...batch.timecards.filter(card => overlap(card.periodStart, card.periodEnd, start, end)).map(card => ({ batch, card })));
    pays.push(...batch.paystubs.filter(pay => overlap(pay.periodStart, pay.periodEnd, start, end)).map(pay => ({ batch, pay })));
  }
  const cardIds = new Set(cards.map(item => item.card.id));
  const payIds = new Set(pays.map(item => item.pay.id));
  const issues = imports.flatMap(batch => payrollIssues(batch).filter(issue => issue.timecardIds.some(id => cardIds.has(id)) || issue.paystubIds.some(id => payIds.has(id))).map(issue => ({ batch, issue })));
  return { cards: cards.sort((a, b) => a.card.periodStart.localeCompare(b.card.periodStart)), pays: pays.sort((a, b) => a.pay.payDate.localeCompare(b.pay.payDate)), issues };
}

