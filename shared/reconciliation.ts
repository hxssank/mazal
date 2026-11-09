import type { Account, AppState, Transaction } from './types.ts';
import { statementBalanceDate } from './statement-imports.ts';

export function transactionPostingDates(data: Pick<AppState, 'transactions'|'statements'|'importBatches'>): Map<string,Record<string,string>> {
  const rows = new Map<string,{accountId:string;date:string}>();
  for (const batch of data.importBatches ?? []) if(batch.status === 'committed') for(const row of batch.source.rows) rows.set(JSON.stringify([batch.id,row.id]),{accountId:batch.source.accountId,date:row.postingDate});
  const legacy = new Map<string,{accountId:string;date:string}>();
  for(const statement of data.statements ?? []) for(const row of statement.rows) legacy.set(JSON.stringify([statement.id,row.id]),{accountId:statement.accountId,date:row.postingDate});
  return new Map(data.transactions.map(transaction=>{
    const dates:Record<string,string> = Object.create(null);
    const sources = (transaction.importSources ?? []).map(ref=>rows.get(JSON.stringify([ref.importId,ref.rowId])));
    if(transaction.statementId&&transaction.statementRowId)sources.push(legacy.get(JSON.stringify([transaction.statementId,transaction.statementRowId])));
    for(const source of sources)if(source)dates[source.accountId]=dates[source.accountId]&&dates[source.accountId]>source.date?dates[source.accountId]:source.date;
    return [transaction.id,dates];
  }));
}

export function transactionBalanceDates(data: Pick<AppState, 'transactions'|'statements'|'importBatches'>): Map<string,Record<string,string>> {
  const dates = transactionPostingDates(data);
  const rows = new Map((data.importBatches ?? []).filter(batch => batch.status === 'committed').flatMap(batch => batch.source.rows.map(row => [JSON.stringify([batch.id,row.id]), { accountId:batch.source.accountId, date:statementBalanceDate(batch.source,row) }] as const)));
  for (const transaction of data.transactions) for (const ref of transaction.importSources ?? []) {
    const row = rows.get(JSON.stringify([ref.importId,ref.rowId]));
    if (row) dates.get(transaction.id)![row.accountId] = row.date;
  }
  return dates;
}

export function reconciliationDate(transaction:Transaction,accountId:string):string {
  return transaction.balanceDates?.[accountId] ?? transaction.postingDates?.[accountId] ?? transaction.postingDate ?? transaction.date;
}

export function reconciliationStart(transactions: Iterable<Transaction>, accountId: string): string | null {
  let earliest: string | null = null;
  for (const transaction of transactions) {
    if (transaction.kind !== 'opening' || transaction.accountId !== accountId) continue;
    const date = reconciliationDate(transaction, accountId);
    if (earliest === null || date < earliest) earliest = date;
  }
  return earliest;
}

export function transactionBalanceChanges(accounts: { id:string; type:string }[], transactions: Transaction[], entries: { transactionId:string; accountId:string; debitCents:number }[]): Map<string, Record<string, number>> {
  const visible = new Map(accounts.filter(account => ['cash', 'investment', 'debt', 'receivable', 'payable'].includes(account.type)).map(account => [account.id, account]));
  const changes = new Map<string, Record<string, number>>();
  for (const transaction of transactions) {
    const amounts: Record<string, number> = Object.create(null);
    for (const id of [transaction.accountId, transaction.toAccountId]) if (id && visible.has(id)) amounts[id] = 0;
    changes.set(transaction.id, amounts);
  }
  for (const entry of entries) {
    const account = visible.get(entry.accountId);
    const amounts = changes.get(entry.transactionId);
    if (account && amounts) amounts[account.id] = (amounts[account.id] ?? 0) + entry.debitCents * (['debt', 'payable'].includes(account.type) ? -1 : 1);
  }
  return changes;
}

export function reconciliationRows(state: AppState, accountId: string, date: string): Transaction[] {
  return state.transactions.filter(transaction => reconciliationDate(transaction,accountId) <= date && (transaction.accountId === accountId || transaction.toAccountId === accountId || Object.hasOwn(transaction.balanceChanges ?? {}, accountId)))
    .sort((a, b) => reconciliationDate(a,accountId).localeCompare(reconciliationDate(b,accountId)) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function clearedBalance(rows: Transaction[], account: Pick<Account, 'id'>, selected: ReadonlySet<string>): number | null {
  let total = 0n;
  for (const row of rows) {
    if (!selected.has(row.id)) continue;
    const amount = row.balanceChanges?.[account.id];
    if (!Number.isSafeInteger(amount)) return null;
    total += BigInt(amount!);
  }
  return total > 100_000_000_000_000n || total < -100_000_000_000_000n ? null : Number(total);
}
