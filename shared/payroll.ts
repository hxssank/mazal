import type { AppState, Transaction } from './types.ts';

export interface PayrollSource { id: string; filename: string; sha256: string; mimeType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/heic'; kind: 'paystub' | 'timecards'; pageCount: number }
export interface PayrollEarning { label: string; hours: number | null; rate: string | null; amountCents: number | null; ytdHours: number | null; ytdAmountCents: number | null }
export interface PayrollDeduction { label: string; amountCents: number | null; ytdAmountCents: number | null }
export interface PayrollAmounts { grossCents: number; netCents: number; taxCents: number; deductionCents: number; hours: number }
export type PayrollYtdAmounts = { [Field in keyof PayrollAmounts]: PayrollAmounts[Field] | null };
export interface PayrollPaystub extends PayrollAmounts {
  id: string; sourceId: string; sourcePage: number; payDate: string; periodStart: string; periodEnd: string;
  sequence: string; employer: string; payFrequency: string; payRate: string | null; earnings: PayrollEarning[];
  taxes: PayrollDeduction[]; deductions: PayrollDeduction[]; ytd: PayrollYtdAmounts; paymentMethod: string;
  lineDetailsReviewed?: boolean;
  vacationBalanceCents: number | null; vacationAccruedCents: number | null;
}
export interface PayrollTimecard { id: string; sourceId: string; sourceRow: number; sourcePage?: number; periodStart: string; periodEnd: string; hours: number; status: string; submissionDate: string | null; transferredTo: string | null; system: 'legacy' | 'projects' }
export interface PayrollIssue { id: string; severity: 'review' | 'info'; title: string; detail: string; sourceIds: string[]; paystubIds: string[]; timecardIds: string[] }
export interface PayrollBankLink { id: string; paystubId: string; transactionId: string | null; reviewedAt: string; note: string }
export interface PayrollIssueReview { id: string; issueId: string; status: 'resolved' | 'open'; reviewedAt: string; note: string }
export interface PayrollImport {
  id: string; importedAt: string; schemaVersion: 1; currency: 'CAD'; archive: { filename: string; sha256: string };
  sources: PayrollSource[]; paystubs: PayrollPaystub[]; timecards: PayrollTimecard[]; issues: PayrollIssue[];
  bankLinks?: PayrollBankLink[]; issueReviews?: PayrollIssueReview[];
}
export type Paystub = PayrollPaystub;
export type Timecard = PayrollTimecard;

export function payrollSumCents(values: readonly number[]): number {
  const total = values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value)) throw new Error('Payroll amounts must use whole cents.');
    return sum + BigInt(value);
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('The payroll total exceeds the supported amount.');
  return Number(total);
}

function sumHours(values: readonly number[]): number {
  if (values.some(value => !Number.isFinite(value))) throw new Error('Payroll hours must be finite numbers.');
  const value = values.reduce((sum, hours) => sum + hours, 0);
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) throw new Error('The payroll hours total exceeds the supported amount.');
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function payrollTotals(paystubs: readonly PayrollPaystub[]): PayrollAmounts & { paystubCount: number } {
  return {
    paystubCount: paystubs.length,
    grossCents: payrollSumCents(paystubs.map(stub => stub.grossCents)), netCents: payrollSumCents(paystubs.map(stub => stub.netCents)),
    taxCents: payrollSumCents(paystubs.map(stub => stub.taxCents)), deductionCents: payrollSumCents(paystubs.map(stub => stub.deductionCents)),
    hours: sumHours(paystubs.map(stub => stub.hours)),
  };
}

export function payrollReconciliation(stub: PayrollPaystub) {
  const difference = (total: number, values: readonly (number | null)[]) => payrollSumCents([total, ...values.map(value => -(value ?? 0))]);
  const details = stub.lineDetailsReviewed !== false;
  const ytdDifference = (total: number | null, values: readonly (number | null)[]) => !details || total === null || values.some(value => value === null) ? null : difference(total, values);
  const grossDifferenceCents = details ? difference(stub.grossCents, stub.earnings.map(row => row.amountCents)) : null;
  const taxDifferenceCents = details ? difference(stub.taxCents, stub.taxes.map(row => row.amountCents)) : null;
  const deductionDifferenceCents = details ? difference(stub.deductionCents, stub.deductions.map(row => row.amountCents)) : null;
  const netDifferenceCents = payrollSumCents([stub.grossCents, -stub.taxCents, -stub.deductionCents, -stub.netCents]);
  const hoursDifference = details ? sumHours([stub.hours, ...stub.earnings.map(row => -(row.hours ?? 0))]) : null;
  const ytdGrossDifferenceCents = ytdDifference(stub.ytd.grossCents, stub.earnings.map(row => row.ytdAmountCents));
  const ytdTaxDifferenceCents = ytdDifference(stub.ytd.taxCents, stub.taxes.map(row => row.ytdAmountCents));
  const ytdDeductionDifferenceCents = ytdDifference(stub.ytd.deductionCents, stub.deductions.map(row => row.ytdAmountCents));
  const ytdNetDifferenceCents = [stub.ytd.grossCents, stub.ytd.taxCents, stub.ytd.deductionCents, stub.ytd.netCents].some(value => value === null) ? null : payrollSumCents([stub.ytd.grossCents!, -stub.ytd.taxCents!, -stub.ytd.deductionCents!, -stub.ytd.netCents!]);
  const ytdHoursDifference = !details || stub.ytd.hours === null || stub.earnings.some(row => row.ytdHours === null) ? null : sumHours([stub.ytd.hours, ...stub.earnings.map(row => -row.ytdHours!)]);
  return {
    grossDifferenceCents, taxDifferenceCents, deductionDifferenceCents, netDifferenceCents, hoursDifference,
    ytdGrossDifferenceCents, ytdTaxDifferenceCents, ytdDeductionDifferenceCents, ytdNetDifferenceCents, ytdHoursDifference,
    isBalanced: [grossDifferenceCents, taxDifferenceCents, deductionDifferenceCents, netDifferenceCents, hoursDifference, ytdGrossDifferenceCents, ytdTaxDifferenceCents, ytdDeductionDifferenceCents, ytdNetDifferenceCents, ytdHoursDifference].every(value => value === 0),
  };
}

export function payrollCurrentLinks(imports: readonly PayrollImport[]): PayrollBankLink[] {
  return imports.flatMap(batch => [...new Map((batch.bankLinks ?? []).map(link => [link.paystubId, link])).values()].filter(link => link.transactionId !== null));
}

export function payrollIssueReview(batch: PayrollImport, issueId: string): PayrollIssueReview | undefined {
  return batch.issueReviews?.findLast(review => review.issueId === issueId);
}

export function payrollIssues(batch: PayrollImport): PayrollIssue[] {
  const calculated = batch.paystubs.flatMap(stub => {
    const check = payrollReconciliation(stub);
    const differs = Object.entries(check).some(([key, value]) => key !== 'isBalanced' && typeof value === 'number' && value !== 0);
    if (!differs && stub.lineDetailsReviewed !== false) return [];
    const payDate = new Date(`${stub.payDate}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return [{ id: `reconciliation-${stub.id}`, severity: 'review' as const, title: `${payDate} totals need review`, detail: differs ? 'Some source totals differ from the entered earning, tax or deduction lines. Open this statement to inspect the differences.' : 'Only statement totals were entered. Review the earning, tax and deduction lines against the original before treating the breakdown as complete.', sourceIds: [stub.sourceId], paystubIds: [stub.id], timecardIds: [] }];
  });
  return [...calculated, ...batch.issues];
}

export interface PayrollBankMatch { status: 'confirmed' | 'matched' | 'ambiguous' | 'unmatched'; transactions: Transaction[]; reason: string }
export function payrollBankMatch(state: Pick<AppState, 'accounts' | 'entities' | 'transactions' | 'payrollImports'>, stub: PayrollPaystub): PayrollBankMatch {
  const personalOwners = new Set(state.entities.filter(entity => entity.kind === 'personal').map(entity => entity.id));
  const accounts = new Set(state.accounts.filter(account => account.type === 'cash' && personalOwners.has(account.entityId)).map(account => account.id));
  const reversed = new Set(state.transactions.flatMap(transaction => transaction.reversalOf ? [transaction.reversalOf] : []));
  const links = payrollCurrentLinks(state.payrollImports ?? []);
  const linked = links.find(link => link.paystubId === stub.id);
  if (linked) {
    const transaction = state.transactions.find(item => item.id === linked.transactionId && !reversed.has(item.id));
    if (transaction) return { status: 'confirmed', transactions: [transaction], reason: `Deposit confirmed on ${linked.reviewedAt.slice(0, 10)}. ${linked.note}` };
  }
  const used = new Set(links.filter(link => link.paystubId !== stub.id).map(link => link.transactionId));
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  function candidate(transaction: Transaction, paystub: PayrollPaystub): boolean {
    if (transaction.kind !== 'income' || reversed.has(transaction.id) || transaction.reversalOf || used.has(transaction.id) || paystub.netCents <= 0 || transaction.amountCents !== paystub.netCents || !accounts.has(transaction.accountId)) return false;
    if (![transaction.date, transaction.postingDate, transaction.postingDates?.[transaction.accountId]].includes(paystub.payDate)) return false;
    const employer = normalize(paystub.employer);
    const description = normalize(transaction.description);
    const employerNamed = employer.length >= 4 && ` ${description} `.includes(` ${employer} `)
      && /\b(payroll|salary|pay|payment|deposit|wages)\b/u.test(description) && !/\b(refund|reimbursement)\b/u.test(description);
    const genericPayroll = /\b(payroll|salary)\b/u.test(`${description} ${normalize(transaction.category)}`)
      && description.split(' ').every(word => /^(payroll|salary|deposit|pay|direct|electronic|credit|\d+)$/u.test(word));
    return employerNamed || genericPayroll;
  }
  const transactions = state.transactions.filter(transaction => candidate(transaction, stub));
  const competingStubs = (state.payrollImports ?? []).flatMap(item => item.paystubs).filter(other => other.id !== stub.id && !links.some(link => link.paystubId === other.id) && transactions.some(transaction => candidate(transaction, other)));
  if (transactions.length && competingStubs.length) return { status: 'ambiguous', transactions, reason: 'The same bank deposit also matches another imported paystub. Review both paystubs before treating the deposit as either payment.' };
  if (transactions.length === 1) return { status: 'matched', transactions, reason: 'One recorded payroll deposit has the same amount and pay date. Verify the employer against the bank source.' };
  if (transactions.length > 1) return { status: 'ambiguous', transactions, reason: 'More than one recorded deposit matches the net pay and pay date. Review the bank entries before choosing a match.' };
  return { status: 'unmatched', transactions, reason: 'No recorded payroll deposit matches both net pay and pay date. Missing bank coverage or a different deposit date may explain this.' };
}

export interface PayrollTimecardOverlap { periodStart: string; periodEnd: string; timecardIds: string[]; systems: PayrollTimecard['system'][] }
export function payrollTimecardOverlaps(timecards: readonly PayrollTimecard[]): PayrollTimecardOverlap[] {
  const groups: PayrollTimecardOverlap[] = [];
  for (const card of [...timecards].sort((left, right) => left.periodStart.localeCompare(right.periodStart) || left.periodEnd.localeCompare(right.periodEnd) || left.id.localeCompare(right.id))) {
    const group = groups.at(-1);
    if (group && card.periodStart <= group.periodEnd) {
      group.periodEnd = card.periodEnd > group.periodEnd ? card.periodEnd : group.periodEnd;
      group.timecardIds.push(card.id);
      if (!group.systems.includes(card.system)) group.systems.push(card.system);
    } else groups.push({ periodStart: card.periodStart, periodEnd: card.periodEnd, timecardIds: [card.id], systems: [card.system] });
  }
  return groups.filter(group => group.timecardIds.length > 1);
}
