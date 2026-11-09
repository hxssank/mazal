import { randomUUID } from 'node:crypto';
import { payrollCurrentLinks, payrollIssues, payrollReconciliation, payrollTotals } from '../shared/payroll.ts';
import type { PayrollAmounts, PayrollBankLink, PayrollDeduction, PayrollEarning, PayrollImport, PayrollIssue, PayrollIssueReview, PayrollPaystub, PayrollSource, PayrollTimecard, PayrollYtdAmounts } from '../shared/payroll.ts';
import type { AppState } from '../shared/types.ts';

const MAX_CENTS = 100_000_000_000_000;
function fail(message: string): never { throw new Error(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail(`${label} must be an object.`);
}
function text(value: unknown, label: string, max = 200, empty = false): string {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label} must contain ${empty ? 'text' : 'a value'} of at most ${max} characters.`);
  return value.trim();
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : fail(`${label} is not supported.`);
}
function list(value: unknown, label: string, max = 5000): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : fail(`${label} must be a list with at most ${max} entries.`);
}
function integer(value: unknown, label: string, min = -MAX_CENTS, max = MAX_CENTS): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(`${label} must be a whole number between ${min} and ${max}.`);
}
function hours(value: unknown, label: string): number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : fail(`${label} must be a finite number from -1000000 through 1000000.`);
}
function rate(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (!/^\d{1,10}(?:\.\d{1,10})?$/.test(result)) fail(`${label} must retain its decimal digits without a currency symbol.`);
  return result;
}
function date(value: unknown, label: string): string {
  const result = text(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || result < '1900-01-01' || result > '2200-12-31' || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) fail(`${label} must be a valid YYYY-MM-DD date.`);
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 'Payroll review date', 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) fail('The payroll review date must be an ISO timestamp.');
  return result;
}
function sha256(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail('A payroll source needs its original SHA-256.');
}
function filename(value: unknown): string {
  const name = text(value, 'Payroll source filename', 240);
  if (/[\\/<>:"|?*]/u.test(name) || /^[. ]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) fail('A payroll source filename must be a safe filename without folders.');
  return name;
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`Duplicate ${label} records are not allowed.`);
}
function period(raw: Record<string, unknown>): { periodStart: string; periodEnd: string } {
  const periodStart = date(raw.periodStart, 'Payroll period start');
  const periodEnd = date(raw.periodEnd, 'Payroll period end');
  if (periodEnd < periodStart) fail('A payroll period must end on or after it starts.');
  return { periodStart, periodEnd };
}
function amounts(value: unknown): PayrollAmounts {
  const raw = object(value, 'Payroll totals');
  return { grossCents: integer(raw.grossCents, 'Gross pay'), netCents: integer(raw.netCents, 'Net pay'), taxCents: integer(raw.taxCents, 'Payroll taxes'), deductionCents: integer(raw.deductionCents, 'Payroll deductions'), hours: hours(raw.hours, 'Payroll hours') };
}
function ytdAmounts(value: unknown): PayrollYtdAmounts {
  const raw = object(value, 'Year-to-date payroll totals');
  return { grossCents: raw.grossCents === null ? null : integer(raw.grossCents, 'Year-to-date gross pay'), netCents: raw.netCents === null ? null : integer(raw.netCents, 'Year-to-date net pay'), taxCents: raw.taxCents === null ? null : integer(raw.taxCents, 'Year-to-date taxes'), deductionCents: raw.deductionCents === null ? null : integer(raw.deductionCents, 'Year-to-date deductions'), hours: raw.hours === null ? null : hours(raw.hours, 'Year-to-date hours') };
}
function deduction(value: unknown): PayrollDeduction {
  const raw = object(value, 'Payroll line');
  return { label: text(raw.label, 'Payroll line label'), amountCents: raw.amountCents === null ? null : integer(raw.amountCents, 'Payroll line amount'), ytdAmountCents: raw.ytdAmountCents === null ? null : integer(raw.ytdAmountCents, 'Year-to-date payroll line amount') };
}
function earning(value: unknown): PayrollEarning {
  const raw = object(value, 'Payroll earning');
  return { ...deduction(raw), hours: raw.hours === null ? null : hours(raw.hours, 'Earning hours'), rate: raw.rate === null ? null : rate(raw.rate, 'Earning rate'), ytdHours: raw.ytdHours === null ? null : hours(raw.ytdHours, 'Year-to-date earning hours') };
}
function paystub(value: unknown, sources: Map<string, PayrollSource>): PayrollPaystub {
  const raw = object(value, 'Paystub');
  const sourceId = text(raw.sourceId, 'Paystub source ID');
  const source = sources.get(sourceId);
  if (!source || source.kind !== 'paystub') fail('A paystub must reference a saved paystub source.');
  const result: PayrollPaystub = {
    id: text(raw.id, 'Paystub ID'), sourceId, sourcePage: integer(raw.sourcePage, 'Paystub source page', 1, source.pageCount),
    payDate: date(raw.payDate, 'Pay date'), ...period(raw), sequence: text(raw.sequence, 'Payroll sequence', 200, true), employer: text(raw.employer, 'Employer'),
    payFrequency: text(raw.payFrequency, 'Pay frequency', 200, true), payRate: raw.payRate === null ? null : rate(raw.payRate, 'Pay rate'), ...amounts(raw),
    earnings: list(raw.earnings, 'Earnings', 200).map(earning), taxes: list(raw.taxes, 'Payroll taxes', 200).map(deduction), deductions: list(raw.deductions, 'Payroll deductions', 200).map(deduction),
    ytd: ytdAmounts(raw.ytd), paymentMethod: text(raw.paymentMethod, 'Payment method', 200, true),
    vacationBalanceCents: raw.vacationBalanceCents === null ? null : integer(raw.vacationBalanceCents, 'Vacation balance'),
    vacationAccruedCents: raw.vacationAccruedCents === null ? null : integer(raw.vacationAccruedCents, 'Vacation accrual'),
  };
  if (raw.lineDetailsReviewed !== undefined) {
    if (typeof raw.lineDetailsReviewed !== 'boolean') fail('Payroll line review must be true or false.');
    result.lineDetailsReviewed = raw.lineDetailsReviewed;
  }
  payrollReconciliation(result);
  return result;
}
function paystubIdentity(stub: PayrollPaystub): string {
  return JSON.stringify([stub.employer.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(), stub.payDate, stub.periodStart, stub.periodEnd]);
}

export function validatePayrollImport(value: unknown): PayrollImport {
  const raw = object(value, 'Payroll import');
  if (raw.schemaVersion !== 1 || raw.currency !== 'CAD') fail('Payroll imports must use version 1 and CAD.');
  const importedAt = text(raw.importedAt, 'Payroll import date', 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(importedAt) || !Number.isFinite(Date.parse(importedAt)) || new Date(importedAt).toISOString() !== importedAt) fail('The payroll import date must be an ISO timestamp.');
  const archive = object(raw.archive, 'Payroll archive');
  const sources = list(raw.sources, 'Payroll sources', 1000).map(value => {
    const source = object(value, 'Payroll source');
    const result: PayrollSource = { id: text(source.id, 'Payroll source ID'), filename: filename(source.filename), sha256: sha256(source.sha256), mimeType: choice(source.mimeType, ['application/pdf', 'image/png', 'image/jpeg', 'image/heic'] as const, 'Payroll source type'), kind: choice(source.kind, ['paystub', 'timecards'] as const, 'Payroll source kind'), pageCount: integer(source.pageCount, 'Payroll source page count', 1, 10000) };
    const extension = result.filename.split('.').at(-1)?.toLowerCase();
    const extensions = { 'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/heic': ['heic'] };
    if (!extension || !extensions[result.mimeType].includes(extension)) fail('A payroll source filename must match its file type.');
    return result;
  });
  if (!sources.length) fail('A payroll import needs at least one original source.');
  unique(sources.map(source => source.id), 'payroll source ID');
  unique(sources.map(source => source.sha256), 'payroll source SHA-256');
  unique(sources.map(source => source.filename.normalize('NFC').toLowerCase()), 'payroll source filename');
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  const paystubs = list(raw.paystubs, 'Paystubs').map(value => paystub(value, sourceMap));
  unique(paystubs.map(stub => stub.id), 'paystub ID');
  unique(paystubs.map(paystubIdentity), 'employer and pay period');
  unique(paystubs.map(stub => JSON.stringify([stub.sourceId, stub.sourcePage])), 'paystub source page');
  const timecards = list(raw.timecards, 'Timecards').map(value => {
    const card = object(value, 'Timecard');
    const sourceId = text(card.sourceId, 'Timecard source ID');
    if (sourceMap.get(sourceId)?.kind !== 'timecards') fail('A timecard must reference a saved timecard source.');
    return { id: text(card.id, 'Timecard ID'), sourceId, sourceRow: integer(card.sourceRow, 'Timecard source row', 1, 100000), ...(card.sourcePage === undefined ? {} : { sourcePage: integer(card.sourcePage, 'Timecard source page', 1, sourceMap.get(sourceId)!.pageCount) }), ...period(card), hours: hours(card.hours, 'Timecard hours'), status: text(card.status, 'Timecard status'), submissionDate: card.submissionDate === null ? null : date(card.submissionDate, 'Timecard submission date'), transferredTo: card.transferredTo === null ? null : text(card.transferredTo, 'Timecard transfer destination'), system: choice(card.system, ['legacy', 'projects'] as const, 'Timecard system') } satisfies PayrollTimecard;
  });
  if (!paystubs.length && !timecards.length) fail('A payroll import needs paystubs or timecards.');
  unique(timecards.map(card => card.id), 'timecard ID');
  unique(timecards.map(card => JSON.stringify([card.sourceId, card.sourcePage ?? 1, card.sourceRow])), 'timecard source row');
  const paystubIds = new Set(paystubs.map(stub => stub.id));
  const timecardIds = new Set(timecards.map(card => card.id));
  function references(value: unknown, allowed: { has: (id: string) => boolean }, label: string): string[] {
    const ids = list(value, label).map(id => text(id, label));
    unique(ids, label);
    if (ids.some(id => !allowed.has(id))) fail(`A payroll issue refers to a missing ${label}.`);
    return ids;
  }
  const issues = list(raw.issues, 'Payroll review notes', 1000).map(value => {
    const issue = object(value, 'Payroll review note');
    return { id: text(issue.id, 'Payroll review note ID'), severity: choice(issue.severity, ['review', 'info'] as const, 'Payroll review severity'), title: text(issue.title, 'Payroll review title', 300), detail: text(issue.detail, 'Payroll review detail', 10000), sourceIds: references(issue.sourceIds, sourceMap, 'source ID'), paystubIds: references(issue.paystubIds, paystubIds, 'paystub ID'), timecardIds: references(issue.timecardIds, timecardIds, 'timecard ID') } satisfies PayrollIssue;
  });
  unique(issues.map(issue => issue.id), 'payroll review note ID');
  if (issues.some(issue => issue.id.startsWith('reconciliation-'))) fail('Payroll source issue IDs cannot use the reconciliation prefix.');
  payrollTotals(paystubs);
  const result: PayrollImport = { id: text(raw.id, 'Payroll import ID'), importedAt, schemaVersion: 1, currency: 'CAD', archive: { filename: filename(archive.filename), sha256: sha256(archive.sha256) }, sources, paystubs, timecards, issues };
  if (raw.bankLinks !== undefined) result.bankLinks = list(raw.bankLinks, 'Payroll deposit reviews', 10000).map(value => {
    const item = object(value, 'Payroll deposit review');
    const paystubId = text(item.paystubId, 'Reviewed paystub');
    if (!paystubIds.has(paystubId)) fail('A payroll deposit review refers to a missing paystub.');
    return { id: text(item.id, 'Payroll deposit review ID'), paystubId, transactionId: item.transactionId === null ? null : text(item.transactionId, 'Deposit transaction'), reviewedAt: timestamp(item.reviewedAt), note: text(item.note, 'Payroll review note', 2000) } satisfies PayrollBankLink;
  });
  const issueIds = new Set(payrollIssues(result).map(issue => issue.id));
  if (raw.issueReviews !== undefined) result.issueReviews = list(raw.issueReviews, 'Payroll issue reviews', 10000).map(value => {
    const item = object(value, 'Payroll issue review');
    const issueId = text(item.issueId, 'Reviewed issue');
    if (!issueIds.has(issueId)) fail('A payroll review refers to a missing issue.');
    return { id: text(item.id, 'Payroll issue review ID'), issueId, status: choice(item.status, ['resolved', 'open'] as const, 'Payroll review status'), reviewedAt: timestamp(item.reviewedAt), note: text(item.note, 'Payroll review note', 2000) } satisfies PayrollIssueReview;
  });
  for (const history of [result.bankLinks ?? [], result.issueReviews ?? []]) {
    unique(history.map(item => item.id), 'payroll review ID');
    if (history.some((item, index) => index > 0 && item.reviewedAt < history[index - 1].reviewedAt)) fail('Payroll review history must remain in date order.');
  }
  return result;
}

export function validatePayrollImports(value: unknown): PayrollImport[] {
  const imports = list(value, 'Payroll imports', 100).map(validatePayrollImport);
  unique(imports.map(item => item.id), 'payroll import ID');
  unique(imports.map(item => item.archive.sha256), 'payroll archive SHA-256');
  unique(imports.flatMap(item => item.sources.map(source => source.sha256)), 'payroll source SHA-256');
  unique(imports.flatMap(item => item.sources.map(source => source.id)), 'payroll source ID');
  unique(imports.flatMap(item => item.paystubs.map(stub => stub.id)), 'paystub ID');
  unique(imports.flatMap(item => item.paystubs.map(paystubIdentity)), 'employer and pay period');
  unique(imports.flatMap(item => item.timecards.map(card => card.id)), 'timecard ID');
  payrollTotals(imports.flatMap(item => item.paystubs));
  return imports;
}

type PayrollRecords = Pick<AppState, 'payrollImports' | 'transactions' | 'entities'> & { accounts: { id: string; entityId: string; type: string }[] };

export function validatePayrollLinks(imports: readonly PayrollImport[], data: Omit<PayrollRecords, 'payrollImports'>): void {
  const owners = new Set(data.entities.filter(entity => entity.kind === 'personal').map(entity => entity.id));
  const cash = new Set(data.accounts.filter(account => account.type === 'cash' && owners.has(account.entityId)).map(account => account.id));
  const transactions = new Map(data.transactions.map(transaction => [transaction.id, transaction]));
  const reversed = new Set(data.transactions.flatMap(transaction => transaction.reversalOf ? [transaction.reversalOf] : []));
  const stubs = new Map(imports.flatMap(batch => batch.paystubs.map(stub => [stub.id, stub] as const)));
  const active = payrollCurrentLinks(imports);
  unique(active.map(link => link.transactionId!), 'confirmed payroll deposit');
  for (const batch of imports) for (const link of batch.bankLinks ?? []) {
    if (link.transactionId !== null && !transactions.has(link.transactionId)) fail('A payroll deposit review refers to a missing bank transaction.');
  }
  for (const link of active) {
    const transaction = transactions.get(link.transactionId!);
    if (!transaction || transaction.kind !== 'income' || transaction.amountCents <= 0 || transaction.amountCents !== stubs.get(link.paystubId)?.netCents || !cash.has(transaction.accountId)) fail('Confirm a personal cash income entry with exactly the paystub net amount.');
    if (transaction.reversalOf || reversed.has(transaction.id)) fail('Unlink the payroll deposit before reversing its bank entry.');
  }
}

export function applyPayrollCommand(data: PayrollRecords, command: Record<string, unknown>): string | null {
  if (!['import_payroll', 'link_payroll_deposit', 'unlink_payroll_deposit', 'review_payroll_issue'].includes(String(command.type))) return null;
  if (!Number.isSafeInteger(command.expectedRevision) || Number(command.expectedRevision) < 0) fail('Importing payroll needs the current workspace revision.');
  text(command.requestId, 'Payroll request ID');
  if (command.type === 'import_payroll') {
    const imported = validatePayrollImport(command.import);
    if (imported.bankLinks?.length || imported.issueReviews?.length) fail('Import source records first, then save deposit links and review decisions.');
    data.payrollImports = validatePayrollImports([...(data.payrollImports ?? []), imported]);
    return `Imported ${imported.paystubs.length} paystubs and ${imported.timecards.length} timecards from ${imported.archive.filename}. Bank balances and transactions were unchanged.`;
  }
  const imports = structuredClone(data.payrollImports ?? []);
  const batch = imports.find(item => item.id === command.importId);
  if (!batch) fail('The payroll import was not found. Refresh your records.');
  const review = { id: randomUUID(), reviewedAt: new Date().toISOString(), note: text(command.note, 'Payroll review note', 2000) };
  if (command.type === 'review_payroll_issue') {
    const issueId = text(command.issueId, 'Reviewed issue');
    if (!payrollIssues(batch).some(issue => issue.id === issueId)) fail('The payroll issue was not found.');
    const status = choice(command.status, ['resolved', 'open'] as const, 'Payroll review status');
    if (batch.issueReviews?.findLast(item => item.issueId === issueId)?.status === status) fail('This payroll issue already has that review status.');
    batch.issueReviews = [...(batch.issueReviews ?? []), { ...review, issueId, status }];
  } else {
    const paystubId = text(command.paystubId, 'Reviewed paystub');
    if (!batch.paystubs.some(stub => stub.id === paystubId)) fail('The paystub was not found.');
    const existing = payrollCurrentLinks(imports).find(link => link.paystubId === paystubId);
    const transactionId = command.type === 'unlink_payroll_deposit' ? null : text(command.transactionId, 'Deposit transaction');
    if (transactionId === null && !existing) fail('This paystub has no confirmed deposit to unlink.');
    if (transactionId !== null && existing) fail('Unlink the existing payroll deposit before choosing another.');
    batch.bankLinks = [...(batch.bankLinks ?? []), { ...review, paystubId, transactionId }];
  }
  const validated = validatePayrollImports(imports);
  validatePayrollLinks(validated, data);
  data.payrollImports = validated;
  return command.type === 'review_payroll_issue' ? 'Payroll review saved with its note and date.' : command.type === 'unlink_payroll_deposit' ? 'Deposit link removed. Bank records are unchanged.' : 'Payroll deposit link confirmed. Bank records are unchanged.';
}
