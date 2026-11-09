import type { AppState, StatementImport, StatementRow } from './types.ts';

export interface ReviewRow extends StatementRow {
  transactionId: string | null;
}

export interface RepeatedCharge {
  transactionDate: string;
  postingDate: string;
  amountCents: number;
  count: number;
}

export interface ReviewMerchant {
  description: string;
  purchaseCents: number;
  refundCents: number;
  netCents: number;
  purchaseCount: number;
  refundCount: number;
  rows: ReviewRow[];
  repeatedCharges: RepeatedCharge[];
}

export interface PastReview {
  statement: StatementImport;
  accountName: string;
  periodDays: number;
  rowCount: number;
  linkedRowCount: number;
  purchaseCents: number;
  refundCents: number;
  interestCents: number;
  paymentCents: number;
  netNewChargesCents: number;
  balanceReductionCents: number;
  calculatedClosingBalanceCents: number;
  reconciled: boolean;
  merchants: ReviewMerchant[];
}

function sumCents(amounts: number[]): number {
  const sum = amounts.reduce((total, amount) => {
    if (!Number.isSafeInteger(amount)) throw new Error('Statement amounts must use whole cents.');
    return total + BigInt(amount);
  }, 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Statement totals exceed the supported amount in cents.');
  return Number(sum);
}

function periodDays(statement: StatementImport): number {
  const dates = [statement.periodStart, statement.periodEnd].map(value => {
    const date = new Date(`${value}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Statement dates must be valid calendar dates.');
    return date.getTime();
  });
  if (dates[1] < dates[0]) throw new Error('Statement end must be on or after its start.');
  return (dates[1] - dates[0]) / 86_400_000 + 1;
}

export function reviewStatements(state: AppState, scope = 'all'): StatementImport[] {
  const accounts = new Set(state.accounts.filter(account => scope === 'all' || account.entityId === scope).map(account => account.id));
  return (state.statements ?? []).filter(statement => accounts.has(statement.accountId))
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || b.periodStart.localeCompare(a.periodStart) || a.id.localeCompare(b.id));
}

export function buildPastReview(state: AppState, statementId: string): PastReview | null {
  const statement = state.statements?.find(item => item.id === statementId);
  if (!statement) return null;
  const transactions = new Map(state.transactions.filter(transaction => transaction.statementId === statement.id && (transaction.accountId === statement.accountId || transaction.kind === 'debt_payment' && transaction.toAccountId === statement.accountId))
    .map(transaction => [transaction.statementRowId, transaction]));
  const rows: ReviewRow[] = statement.rows.map(row => {
    const transaction = transactions.get(row.id);
    return { ...row, category: transaction?.category ?? row.category, transactionId: transaction?.id ?? null };
  });
  const total = (kind: StatementRow['kind'], sign = 1) => sumCents(rows.filter(row => row.kind === kind).map(row => row.amountCents * sign));
  const purchaseCents = total('purchase');
  const refundCents = total('refund', -1);
  const interestCents = total('interest');
  const paymentCents = total('payment', -1);
  const netNewChargesCents = sumCents([purchaseCents, interestCents, -refundCents]);
  const calculatedClosingBalanceCents = sumCents([statement.openingBalanceCents, netNewChargesCents, -paymentCents]);
  const descriptions = new Map<string, ReviewRow[]>();
  for (const row of rows) {
    if (row.kind !== 'purchase' && row.kind !== 'refund') continue;
    const group = descriptions.get(row.description) ?? [];
    group.push(row);
    descriptions.set(row.description, group);
  }
  const merchants = [...descriptions].map(([description, entries]): ReviewMerchant => {
    const purchases = entries.filter(row => row.kind === 'purchase');
    const refunds = entries.filter(row => row.kind === 'refund');
    const purchaseCents = sumCents(purchases.map(row => row.amountCents));
    const refundCents = sumCents(refunds.map(row => -row.amountCents));
    const matching = new Map<string, RepeatedCharge>();
    for (const row of purchases) {
      const key = JSON.stringify([row.transactionDate, row.postingDate, row.amountCents]);
      const previous = matching.get(key);
      matching.set(key, { transactionDate: row.transactionDate, postingDate: row.postingDate, amountCents: row.amountCents, count: (previous?.count ?? 0) + 1 });
    }
    return {
      description, purchaseCents, refundCents, netCents: sumCents([purchaseCents, -refundCents]), purchaseCount: purchases.length, refundCount: refunds.length,
      rows: [...entries].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.postingDate.localeCompare(b.postingDate) || a.id.localeCompare(b.id)),
      repeatedCharges: [...matching.values()].filter(item => item.count > 1),
    };
  }).sort((a, b) => b.purchaseCents - a.purchaseCents || a.description.localeCompare(b.description));
  return {
    statement, accountName: state.accounts.find(account => account.id === statement.accountId)?.name ?? 'Statement account',
    periodDays: periodDays(statement), rowCount: rows.length, linkedRowCount: rows.filter(row => row.transactionId !== null).length,
    purchaseCents, refundCents, interestCents, paymentCents, netNewChargesCents,
    balanceReductionCents: sumCents([statement.openingBalanceCents, -statement.closingBalanceCents]),
    calculatedClosingBalanceCents, reconciled: calculatedClosingBalanceCents === statement.closingBalanceCents, merchants,
  };
}
