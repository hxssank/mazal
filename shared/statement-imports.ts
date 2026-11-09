import type { Account, AppState, StatementBatch, StatementDecision, StatementSource, StatementSourceRow, Transaction } from './types.ts';

export interface StatementPreview { ready:boolean; rowCount:number; unreviewedCount:number; transferCount:number; issues:string[]; differences:{importId:string; differenceCents:number}[] }
type ImportState = Pick<AppState, 'accounts' | 'transactions' | 'importBatches'> & Partial<Pick<AppState, 'statements'>>;

export interface StatementCoverage {
  status: 'none' | 'partial' | 'complete';
  accountCount: number;
  coveredAccountCount: number;
  completeAccountCount: number;
  coveredAccountDays: number;
  totalAccountDays: number;
  accounts: { accountId: string; coveredDays: number; totalDays: number }[];
}

export function statementCoverage(state: Pick<AppState, 'accounts' | 'statements' | 'importBatches'>, scope: string, month: string, accountId = 'all'): StatementCoverage {
  const first = new Date(`${month}-01T12:00:00Z`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isFinite(first.getTime())) throw new Error('Choose a calendar month as YYYY-MM.');
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const dates = Array.from({ length: last.getUTCDate() }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
  const accounts = state.accounts.filter(account => ['cash', 'debt', 'payable'].includes(account.type) && (scope === 'all' || account.entityId === scope) && (accountId === 'all' || account.id === accountId) && (!account.closedAt || account.closedAt >= dates[0]));
  const periods = [...(state.statements ?? []), ...(state.importBatches ?? []).filter(batch => batch.status === 'committed').map(batch => batch.source)];
  const coverage = accounts.map(account => {
    const matching = periods.filter(period => period.accountId === account.id);
    const activeDates = dates.filter(date => !account.closedAt || date <= account.closedAt);
    const coveredDays = activeDates.filter(date => matching.some(period => period.periodStart <= date && date <= period.periodEnd)).length;
    return { accountId: account.id, coveredDays, totalDays: activeDates.length };
  });
  const coveredAccountDays = coverage.reduce((sum, account) => sum + account.coveredDays, 0);
  const totalAccountDays = coverage.reduce((sum, account) => sum + account.totalDays, 0);
  return {
    status: coveredAccountDays === 0 ? 'none' : coveredAccountDays === totalAccountDays ? 'complete' : 'partial',
    accountCount: coverage.length,
    coveredAccountCount: coverage.filter(account => account.coveredDays > 0).length,
    completeAccountCount: coverage.filter(account => account.coveredDays === account.totalDays).length,
    coveredAccountDays, totalAccountDays, accounts: coverage,
  };
}

export function statementRowKey(importId:string, rowId:string):string { return JSON.stringify([importId, rowId]); }
export function statementDateBasisLabel(row:Pick<StatementSourceRow, 'dateBasis'>):string|null {
  return row.dateBasis === 'posting_only' ? 'Posting date only; transaction date not supplied' : row.dateBasis === 'transaction_only' ? 'Transaction date only; posting date not supplied' : null;
}
export function statementBalanceDate(source:Pick<StatementSource, 'sourceKind'|'observedOn'>, row:Pick<StatementSourceRow, 'postingDate'>):string {
  return source.sourceKind === 'bank_activity' && source.observedOn && row.postingDate > source.observedOn ? source.observedOn : row.postingDate;
}
export function statementDebit(account:Pick<Account, 'type'>, amountCents:number):number { return ['debt', 'payable'].includes(account.type) ? -amountCents : amountCents; }
export function transactionAccountDelta(transaction:Transaction, account:Pick<Account, 'id' | 'type'>):number|null {
  if (transaction.kind !== 'transfer' && transaction.kind !== 'debt_payment') return null;
  const debit = transaction.accountId === account.id ? -transaction.amountCents : transaction.toAccountId === account.id ? transaction.amountCents : null;
  return debit === null ? null : statementDebit(account, debit);
}
export function statementDecisionIssue(account:Pick<Account, 'type'>, row:StatementSourceRow, decision:StatementDecision):string|null {
  const debt = ['debt', 'payable'].includes(account.type);
  if (decision.kind === 'transfer') return null;
  if (decision.match && (!['expense', 'income', 'interest', 'refund'].includes(decision.kind) || !('transactionId' in decision.match))) return 'Match this classification to an existing expense, income, or refund transaction.';
  if (decision.kind === 'movement') return null;
  if (decision.kind === 'income' && (debt || row.amountCents <= 0)) return 'Income must increase a cash account.';
  if (['expense', 'interest'].includes(decision.kind) && (debt ? row.amountCents <= 0 : row.amountCents >= 0)) return 'Expenses must reduce cash or increase debt.';
  if (decision.kind === 'refund' && (debt ? row.amountCents >= 0 : row.amountCents <= 0)) return 'Refunds must increase cash or reduce debt.';
  return null;
}
function nearDates(first:string, second:string):boolean { return Math.abs(Date.parse(first) - Date.parse(second)) <= 7 * 86400000; }
export function legacyPaymentMatch(transaction:Transaction, batch:StatementBatch, row:StatementSourceRow, accounts:Account[]):boolean {
  const account = accounts.find(item => item.id === batch.source.accountId);
  const target = accounts.find(item => item.id === transaction.accountId);
  return account?.type === 'cash' && row.amountCents < 0 && transaction.kind === 'adjustment' && !!transaction.statementId && !!target && ['debt', 'payable'].includes(target.type) && transaction.amountCents === -row.amountCents && nearDates(transaction.postingDate ?? transaction.date, row.postingDate);
}
export function manualStatementMatch(transaction:Transaction, batch:StatementBatch, row:StatementSourceRow, kind:StatementDecision['kind'], accounts:Account[]):boolean {
  const account = accounts.find(item => item.id === batch.source.accountId);
  const expectedKind = kind === 'income' ? 'income' : 'expense';
  const amount = kind === 'refund' ? -Math.abs(row.amountCents) : Math.abs(row.amountCents);
  return !!account && ['expense', 'income', 'interest', 'refund'].includes(kind)
    && (['Manual entry', 'Corrected manual entry', 'Manual refund'].includes(transaction.source) || transaction.source.startsWith('Planned payment ') && (!transaction.plannedPayment || transaction.source === `Planned payment ${transaction.plannedPayment.obligationId}`))
    && !transaction.statementId && !transaction.reversalOf && transaction.accountId === account.id && transaction.toAccountId === null
    && transaction.kind === expectedKind && transaction.amountCents === amount
    && nearDates(transaction.date, row.transactionDate) && nearDates(transaction.date, row.postingDate)
    && !statementDecisionIssue(account, row, { rowId:row.id, kind, category:transaction.category });
}
export function neutralStatementTransactions(transactions:Transaction[]):Set<string> {
  const originals = new Map(transactions.map(transaction => [transaction.id, transaction]));
  const neutral = new Set<string>();
  for (const reversal of transactions) {
    const original = reversal.reversalOf ? originals.get(reversal.reversalOf) : undefined;
    if (!original || !['Manual entry', 'Corrected manual entry'].includes(original.source) || original.statementId || original.importSources?.length || original.plannedPayment || original.reversalOf || original.refundOf
      || reversal.source !== 'Manual reversal' || reversal.statementId || reversal.importSources?.length || reversal.plannedPayment || reversal.refundOf
      || reversal.kind !== original.kind || reversal.accountId !== original.accountId || reversal.toAccountId !== original.toAccountId || reversal.date !== original.date || reversal.amountCents !== -original.amountCents) continue;
    neutral.add(original.id); neutral.add(reversal.id);
  }
  return neutral;
}
export function statementTransactionMatcher(state:ImportState):(batch:StatementBatch,row:StatementSourceRow,kind:StatementDecision['kind'],transaction:Transaction)=>boolean {
  const accounts = new Map(state.accounts.map(account => [account.id,account]));
  const batches = new Map((state.importBatches ?? []).map(batch => [batch.id,batch]));
  const reversed = new Set(state.transactions.flatMap(tx => tx.reversalOf ? [tx.reversalOf] : []));
  return (batch,row,kind,transaction) => {
    const account = accounts.get(batch.source.accountId);
    if (!account || transaction.reversalOf || reversed.has(transaction.id)
      || transaction.importSources?.some(ref => batches.get(ref.importId)?.source.accountId === account.id)) return false;
    return kind === 'transfer'
      ? transactionAccountDelta(transaction, account) === row.amountCents && nearDates(transaction.postingDate ?? transaction.date, row.postingDate) || legacyPaymentMatch(transaction, batch, row, state.accounts)
      : !transaction.importSources?.length && manualStatementMatch(transaction, batch, row, kind, [account]);
  };
}
export function canMatchStatementTransaction(state:ImportState, batch:StatementBatch, row:StatementSourceRow, kind:StatementDecision['kind'], transaction:Transaction):boolean {
  return statementTransactionMatcher(state)(batch,row,kind,transaction);
}
export function statementPeriodIssues(statements:AppState['statements'], batches:StatementBatch[]):string[] {
  const issues:string[] = [];
  const sources = [...statements ?? [], ...batches.filter(batch => batch.status === 'committed').map(batch => batch.source)].sort((a,b) => a.accountId.localeCompare(b.accountId) || a.periodStart.localeCompare(b.periodStart));
  for (let index = 1; index < sources.length; index++) {
    const previous = sources[index - 1], current = sources[index];
    if (previous.accountId !== current.accountId) continue;
    if (previous.periodEnd >= current.periodStart) issues.push('Statement periods for the same account cannot overlap.');
    const next = new Date(`${previous.periodEnd}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.toISOString().slice(0,10) === current.periodStart && previous.closingBalanceCents !== current.openingBalanceCents) issues.push('Adjacent statements must carry the previous closing balance into the next opening balance.');
  }
  const observedRows = new Set<string>();
  for (const source of sources) {
    for (const row of source.rows) if (observedRows.has(JSON.stringify([source.accountId, row.transactionDate, row.postingDate, row.amountCents]))) issues.push('Previously observed bank activity appears in another source. Review the extraction so the same activity is not imported twice.');
    if ('sourceKind' in source && source.sourceKind === 'bank_activity') for (const row of source.rows) if (row.postingDate > source.periodEnd) observedRows.add(JSON.stringify([source.accountId, row.transactionDate, row.postingDate, row.amountCents]));
  }
  return [...new Set(issues)];
}
function statementCommitIssues(state:ImportState, batches:StatementBatch[]):string[] {
  const selected = new Set(batches.map(batch => batch.id));
  const issues = statementPeriodIssues(state.statements, (state.importBatches ?? []).map(batch => selected.has(batch.id) ? {...batch,status:'committed'} : batch));
  const dates = new Map(state.transactions.map(tx => [tx.id, {...tx.balanceDates}]));
  const sources = [...state.statements ?? [], ...(state.importBatches ?? []).filter(batch => batch.status === 'committed').map(batch => batch.source)];
  const sourceRows = new Map(sources.flatMap(source => source.rows.map(row => [statementRowKey(source.id,row.id), {accountId:source.accountId,date:statementBalanceDate(source as StatementSource,row)}] as const)));
  for (const tx of state.transactions) for (const ref of [...tx.importSources ?? [], ...(tx.statementId && tx.statementRowId ? [{importId:tx.statementId,rowId:tx.statementRowId}] : [])]) {
    const source = sourceRows.get(statementRowKey(ref.importId,ref.rowId));
    if (source) dates.get(tx.id)![source.accountId] = source.date;
  }
  const selectedRows = new Map(batches.flatMap(batch => batch.source.rows.map(row => [statementRowKey(batch.id,row.id),row] as const)));
  for (const batch of batches) for (const decision of batch.decisions) if (decision.match && 'transactionId' in decision.match) {
    const row = selectedRows.get(statementRowKey(batch.id,decision.rowId));
    const target = dates.get(decision.match.transactionId);
    if (row && target) target[batch.source.accountId] = statementBalanceDate(batch.source,row);
  }
  const neutral = neutralStatementTransactions(state.transactions);
  const transactions = new Map(state.transactions.map(tx => [tx.id,tx]));
  const decisions = new Map(batches.flatMap(batch => batch.decisions.map(decision => [statementRowKey(batch.id,decision.rowId),decision] as const)));
  for (const account of state.accounts) {
    const group = batches.filter(batch => batch.source.accountId === account.id).sort((a,b) => a.source.periodStart.localeCompare(b.source.periodStart));
    if (!group.length) continue;
    if (account.closedAt) issues.push(`${account.name}: reopen the account before recording statements.`);
    const first = group[0].source, last = group[group.length - 1].source;
    const matched = new Set(group.flatMap(batch => batch.decisions.flatMap(decision => decision.match && 'transactionId' in decision.match ? [decision.match.transactionId] : [])));
    const effectiveDate = (tx:Transaction) => dates.get(tx.id)?.[account.id] ?? tx.postingDate ?? tx.date;
    const completed = account.reconciliation;
    if (completed) {
      const moved = completed.transactionIds.map(id => transactions.get(id)).find(tx => tx && matched.has(tx.id) && effectiveDate(tx) > completed.date);
      if (moved) issues.push(`${account.name}: matching ${moved.description} moves its bank balance date to ${effectiveDate(moved)}, after the completed reconciliation on ${completed.date}. Reopen the saved transaction checks before recording this statement.`);
    }
    const relevant = state.transactions.filter(tx => (tx.accountId === account.id || tx.toAccountId === account.id) && !neutral.has(tx.id));
    const ambiguous = relevant.find(tx => group.some(batch => effectiveDate(tx) >= batch.source.periodStart && effectiveDate(tx) <= batch.source.periodEnd)
      && tx.kind !== 'opening' && !(tx.kind === 'adjustment' && ['Statement reconciliation','Historical statement reconciliation','Statement history correction'].includes(tx.source)) && !matched.has(tx.id));
    if (ambiguous) issues.push(`${account.name}: this account already has activity in the statement period without a source link. Match existing entries before importing so activity is not recorded twice. Unmatched: ${ambiguous.description}.`);
    if (account.reconciledAt !== null && account.reconciledAt >= last.periodEnd) {
      const latest = [...sources,...group.map(batch => batch.source)].filter(source => source.accountId === account.id).sort((a,b) => b.periodEnd.localeCompare(a.periodEnd))[0];
      if (latest.periodEnd === account.reconciledAt && latest.closingBalanceCents !== account.balanceCents) issues.push('The confirmed balance and statement closing balance disagree on the same date. Review the bank balance before importing.');
    } else {
      const alreadyPosted = group.reduce((total,batch) => total + batch.source.rows.reduce((sum,row) => {
        const match = decisions.get(statementRowKey(batch.id,row.id))?.match;
        const tx = match && 'transactionId' in match ? transactions.get(match.transactionId) : undefined;
        return sum + (tx && (transactionAccountDelta(tx,account) !== null || tx.accountId === account.id) ? BigInt(row.amountCents) : 0n);
      },0n),0n);
      if (BigInt(account.balanceCents) !== BigInt(first.openingBalanceCents) + alreadyPosted) issues.push('The recorded balance does not match this statement opening balance. Confirm a current balance dated on or after the statement end before importing historical activity.');
      if (group.reduce((sum,batch) => sum + BigInt(batch.source.closingBalanceCents) - BigInt(batch.source.openingBalanceCents),BigInt(first.openingBalanceCents)) !== BigInt(last.closingBalanceCents)) issues.push('Import consecutive statements or confirm a later balance before importing a period with gaps.');
      if (relevant.some(tx => effectiveDate(tx) > last.periodEnd)) issues.push('This account has later transactions. Confirm its current balance before importing historical activity.');
    }
  }
  return [...new Set(issues)];
}
export function previewStatementBatches(state:ImportState, importIds:string[]):StatementPreview {
  const issues:string[] = [];
  const differences:StatementPreview['differences'] = [];
  const selected = new Set(importIds);
  const batches = new Map((state.importBatches ?? []).map(batch => [batch.id, batch]));
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const sourceRows = new Map((state.importBatches ?? []).flatMap(batch => batch.source.rows.map(row => [statementRowKey(batch.id, row.id), row] as const)));
  const reviews = new Map((state.importBatches ?? []).flatMap(batch => batch.decisions.map(decision => [statementRowKey(batch.id, decision.rowId), decision] as const)));
  const transactions = new Map(state.transactions.map(transaction => [transaction.id, transaction]));
  const usedMatches = new Map<string,string>();
  const matchesTransaction = statementTransactionMatcher(state);
  let rowCount = 0, unreviewedCount = 0, transferCount = 0;
  if (!importIds.length || selected.size !== importIds.length) issues.push('Choose one or more different staged statements.');
  for (const id of importIds) {
    const batch = batches.get(id);
    if (!batch || batch.status !== 'staged') { issues.push('A selected statement is missing or already committed.'); continue; }
    const account = accounts.get(batch.source.accountId);
    if (!account) { issues.push(`${batch.source.sourceFile}: its account is missing.`); continue; }
    const difference = BigInt(batch.source.openingBalanceCents) + batch.source.rows.reduce((sum, row) => sum + BigInt(row.amountCents), 0n) - BigInt(batch.source.closingBalanceCents);
    const differenceCents = Number(difference);
    differences.push({ importId:id, differenceCents });
    if (difference !== 0n) issues.push(`${batch.source.sourceFile}: opening balance plus rows differs from closing balance by ${differenceCents} cents.`);
    const decisions = new Map(batch.decisions.map(decision => [decision.rowId, decision]));
    for (const row of batch.source.rows) {
      rowCount++;
      const prefix = `${batch.source.sourceFile}, page ${row.sourcePage}, row ${row.id}`;
      const decision = decisions.get(row.id);
      if (!decision) { unreviewedCount++; continue; }
      const invalid = statementDecisionIssue(account, row, decision);
      if (invalid) issues.push(`${prefix}: ${invalid}`);
      if (decision.kind !== 'transfer' && !decision.match) continue;
      if (decision.kind === 'transfer') transferCount++;
      const match = decision.match;
      if (!match) { issues.push(`${prefix}: match this transfer to its other statement row or an existing transfer.`); continue; }
      if ('transactionId' in match) {
        const tx = transactions.get(match.transactionId);
        if (!tx || !matchesTransaction(batch, row, decision.kind, tx)) issues.push(`${prefix}: the matched transaction has different accounts, amount, date, or kind, is reversed, or already has a source.`);
        if (tx && decision.kind !== 'transfer' && tx.category !== decision.category) issues.push(`${prefix}: keep the matched transaction category or change it in recorded activity first.`);
        if (tx?.importSources?.some(ref => batches.get(ref.importId)?.source.accountId === account.id)) issues.push(`${prefix}: this transaction already has a source row for this account.`);
        const key = JSON.stringify([match.transactionId, account.id]);
        if (usedMatches.has(key)) issues.push(`${prefix}: two rows cannot match the same account side of a transaction.`);
        usedMatches.set(key, prefix);
      } else {
        const otherBatch = batches.get(match.importId);
        const other = sourceRows.get(statementRowKey(match.importId, match.rowId));
        const otherAccount = otherBatch ? accounts.get(otherBatch.source.accountId) : undefined;
        const otherDecision = reviews.get(statementRowKey(match.importId, match.rowId));
        const back = otherDecision?.match;
        if (!otherBatch || !other || !otherAccount || !selected.has(otherBatch.id) || otherBatch.status !== 'staged') { issues.push(`${prefix}: commit both sides of this transfer together.`); continue; }
        if (account.id === otherAccount.id || statementDebit(account, row.amountCents) + statementDebit(otherAccount, other.amountCents) !== 0 || !nearDates(row.postingDate, other.postingDate)) issues.push(`${prefix}: transfer sides need different accounts, equal opposite movements, and dates within seven days.`);
        const from = statementDebit(account, row.amountCents) < 0 ? account : otherAccount;
        const to = from === account ? otherAccount : account;
        if (from.type !== 'cash' || !['cash', 'debt', 'payable'].includes(to.type)) issues.push(`${prefix}: transfers must move cash to cash or debt.`);
        if (otherDecision?.kind !== 'transfer' || !back || !('importId' in back) || back.importId !== batch.id || back.rowId !== row.id) issues.push(`${prefix}: both rows must point to each other.`);
      }
    }
  }
  if (unreviewedCount) issues.push(`${unreviewedCount} statement rows still need a classification.`);
  if (!issues.length) issues.push(...statementCommitIssues(state, [...batches.values()].filter(batch => selected.has(batch.id))));
  return { ready:issues.length === 0, rowCount, unreviewedCount, transferCount, issues, differences };
}
