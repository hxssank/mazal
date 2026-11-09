import type { AppState, StatementSource, StatementSourceRow, Transaction } from './types.ts';
import { statementBalanceDate } from './statement-imports.ts';

export interface BankReviewRow {
  id: string; date: string; description: string; category: string; amountCents: number;
  kind: 'income' | 'spending' | 'movement'; spendingCents: number; sourceFile: string; sha256: string; sourcePage: number; postingDate: string; observedOn?: string; dateBasis?: StatementSourceRow['dateBasis'];
}
export interface BankReview {
  rows: BankReviewRow[]; months: string[]; start: string; end: string;
  addedCents: number; removedCents: number; incomeCents: number; spendingCents: number;
  openingCents: number | null; closingCents: number | null; coveredDays: number; below50Days: number; negativeDays: number;
  daily: { date: string; balanceCents: number }[]; gaps: boolean;
}
function sum(amounts: number[]): number {
  const total = amounts.reduce((result, value) => {
    if (!Number.isSafeInteger(value)) throw new Error('Bank review amounts must use whole cents.');
    return result + BigInt(value);
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Bank review total exceeds the supported amount.');
  return Number(total);
}
function dateValue(value: string): number {
  const timestamp = Date.parse(`${value}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error('Bank review dates must be real calendar dates from 1900 through 2200.');
  return timestamp;
}
const nextDay = (date: string) => new Date(dateValue(date) + 86_400_000).toISOString().slice(0, 10);
const rowKey = (statementId: string, rowId: string) => JSON.stringify([statementId, rowId]);

export function bankReview(state: AppState, accountId: string, month = 'all'): BankReview {
  if (month !== 'all' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Choose a calendar month.');
  const links = new Map<string, Transaction>();
  for (const transaction of state.transactions) {
    if (transaction.statementId && transaction.statementRowId) links.set(rowKey(transaction.statementId, transaction.statementRowId), transaction);
    for (const ref of transaction.importSources ?? []) links.set(rowKey(ref.importId, ref.rowId), transaction);
  }
  const sources: StatementSource[] = [];
  const seen = new Set<string>();
  for (const source of [...(state.statements ?? []), ...(state.importBatches ?? []).filter(batch => batch.status === 'committed').map(batch => batch.source)]) {
    if (source.accountId !== accountId || seen.has(source.sha256)) continue;
    seen.add(source.sha256); sources.push(source);
  }
  sources.sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const allRows = sources.flatMap(source => source.rows.map(row => {
    const transaction = links.get(rowKey(source.id, row.id));
    return { id: rowKey(source.id, row.id), date: statementBalanceDate(source, row), postingDate: row.postingDate, observedOn: source.observedOn, dateBasis: row.dateBasis, description: row.description,
      amountCents: row.amountCents, category: transaction?.expenseCategory ?? transaction?.category ?? 'Unclassified',
      kind: transaction?.kind === 'expense' ? 'spending' as const : transaction?.kind === 'income' ? 'income' as const : 'movement' as const,
      spendingCents: transaction?.kind === 'expense' ? transaction.amountCents : 0,
      sourceFile: source.sourceFile, sha256: source.sha256, sourcePage: row.sourcePage };
  }));
  const months = new Set<string>();
  const daily: BankReview['daily'] = [];
  let openingCents: number | null = null;
  let previousEnd = '';
  let previousClosing: number | null = null;
  let gaps = false;
  for (const source of sources) {
    dateValue(source.periodStart); dateValue(source.periodEnd);
    if (source.periodEnd < source.periodStart) throw new Error('A source has invalid coverage dates.');
    if (previousEnd && source.periodStart <= previousEnd) throw new Error('Bank review sources overlap. Review their coverage before using totals.');
    if (previousEnd && source.periodStart === nextDay(previousEnd) && source.openingBalanceCents !== previousClosing) throw new Error('Consecutive bank sources disagree on the carried-forward balance. Review their opening and closing balances.');
    previousEnd = source.periodEnd;
    previousClosing = source.closingBalanceCents;
    if (sum([source.openingBalanceCents, ...source.rows.map(row => row.amountCents)]) !== source.closingBalanceCents) throw new Error('A source does not reconcile to its closing balance.');
    const byDate = new Map<string, number[]>();
    for (const row of source.rows) {
      dateValue(row.postingDate);
      const balanceDate = statementBalanceDate(source, row);
      if (balanceDate < source.periodStart || balanceDate > source.periodEnd) throw new Error('A source entry is posted outside its coverage dates.');
      const amounts = byDate.get(balanceDate) ?? [];
      amounts.push(row.amountCents); byDate.set(balanceDate, amounts);
    }
    let balance = source.openingBalanceCents;
    for (let date = source.periodStart; date <= source.periodEnd; date = nextDay(date)) {
      months.add(date.slice(0, 7));
      const selected = month === 'all' || date.startsWith(month);
      if (selected && openingCents === null) openingCents = balance;
      balance = sum([balance, ...(byDate.get(date) ?? [])]);
      if (selected) {
        if (daily.length && nextDay(daily.at(-1)!.date) !== date) gaps = true;
        daily.push({ date, balanceCents: balance });
      }
    }
  }
  const rows = allRows.filter(row => month === 'all' || row.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return { rows, months: [...months].sort().reverse(), start: daily[0]?.date ?? '', end: daily.at(-1)?.date ?? '',
    addedCents: sum(rows.map(row => Math.max(0, row.amountCents))), removedCents: sum(rows.map(row => Math.max(0, -row.amountCents))),
    incomeCents: sum(rows.filter(row => row.kind === 'income').map(row => Math.abs(row.amountCents))), spendingCents: sum(rows.map(row => row.spendingCents)),
    openingCents: gaps ? null : openingCents, closingCents: daily.at(-1)?.balanceCents ?? null,
    coveredDays: daily.length, below50Days: daily.filter(day => day.balanceCents < 5000).length,
    negativeDays: daily.filter(day => day.balanceCents < 0).length, daily, gaps };
}
