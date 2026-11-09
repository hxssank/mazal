import { parseMoneyCents } from './money-input.ts';
import type { PayrollImport, PayrollPaystub, PayrollSource, PayrollTimecard } from './payroll.ts';

export interface PayrollLineDraft { label: string; amount: string; ytdAmount: string; hours: string; rate: string; ytdHours: string }
export interface PaystubDraft {
  id: string; sourcePage: string; employer: string; payDate: string; periodStart: string; periodEnd: string;
  sequence: string; payFrequency: string; payRate: string; paymentMethod: string;
  gross: string; net: string; tax: string; deduction: string; hours: string;
  ytdGross: string; ytdNet: string; ytdTax: string; ytdDeduction: string; ytdHours: string;
  earnings: PayrollLineDraft[]; taxes: PayrollLineDraft[]; deductions: PayrollLineDraft[]; lineDetailsReviewed: boolean;
}
export interface TimecardDraft { id: string; sourceRow: string; sourcePage: string; periodStart: string; periodEnd: string; hours: string; status: string; submissionDate: string; transferredTo: string; system: PayrollTimecard['system'] }
export const emptyPayrollLine = (): PayrollLineDraft => ({ label: '', amount: '', ytdAmount: '', hours: '', rate: '', ytdHours: '' });
export const emptyPaystub = (id: string, page = 1): PaystubDraft => ({ id, sourcePage: String(page), employer: '', payDate: '', periodStart: '', periodEnd: '', sequence: '', payFrequency: '', payRate: '', paymentMethod: '', gross: '', net: '', tax: '', deduction: '', hours: '', ytdGross: '', ytdNet: '', ytdTax: '', ytdDeduction: '', ytdHours: '', earnings: [], taxes: [], deductions: [], lineDetailsReviewed: false });
export const emptyTimecard = (id: string, row = 1): TimecardDraft => ({ id, sourceRow: String(row), sourcePage: '1', periodStart: '', periodEnd: '', hours: '', status: '', submissionDate: '', transferredTo: '', system: 'projects' });

function money(value: string, label: string): number {
  return parseMoneyCents(value, { signed: true, maxCents: 100_000_000_000_000, invalidMessage: `${label} needs the source amount in dollars and cents. Enter 0 only when the source reports zero.`, rangeMessage: `${label} exceeds the supported amount.` });
}
function hours(value: string, label: string): number {
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(value.trim()) || Math.abs(Number(value)) > 1_000_000) throw new Error(`${label} needs the signed source hours, up to six decimal places.`);
  return Number(value);
}
function date(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`${label} needs a valid date.`);
  return value;
}
function period(start: string, end: string) {
  const periodStart = date(start, 'Period start'), periodEnd = date(end, 'Period end');
  if (periodEnd < periodStart) throw new Error('The pay or timecard period cannot end before it starts.');
  return { periodStart, periodEnd };
}
function required(value: string, label: string): string { if (!value.trim()) throw new Error(`Enter ${label} from the source.`); return value.trim(); }
function positive(value: string, label: string, maximum: number): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${label} must be between 1 and ${maximum}.`);
  return Number(value);
}
function rate(value: string): string | null {
  if (!value.trim()) return null;
  if (!/^\d{1,10}(?:\.\d{1,10})?$/.test(value.trim())) throw new Error('Keep the hourly rate exactly as printed, without a currency sign.');
  return value.trim();
}
const optionalMoney = (value: string, label: string) => value.trim() ? money(value, label) : null;
const optionalHours = (value: string, label: string) => value.trim() ? hours(value, label) : null;

export function reviewedPayrollImport(input: { id: string; importedAt: string; source: PayrollSource; paystubs: PaystubDraft[]; timecards: TimecardDraft[] }): PayrollImport {
  const { source } = input;
  if (!Number.isInteger(source.pageCount) || source.pageCount < 1 || source.pageCount > 10000) throw new Error('Enter the number of pages in the original file.');
  const line = (row: PayrollLineDraft) => ({ label: required(row.label, 'the line label'), amountCents: optionalMoney(row.amount, 'Line amount'), ytdAmountCents: optionalMoney(row.ytdAmount, 'Year-to-date line amount') });
  const paystubs: PayrollPaystub[] = source.kind === 'paystub' ? input.paystubs.map(draft => ({
    id: draft.id, sourceId: source.id, sourcePage: positive(draft.sourcePage, 'Source page', source.pageCount), employer: required(draft.employer, 'the employer'), payDate: date(draft.payDate, 'Pay date'), ...period(draft.periodStart, draft.periodEnd),
    sequence: draft.sequence.trim(), payFrequency: draft.payFrequency.trim(), payRate: rate(draft.payRate), paymentMethod: draft.paymentMethod.trim(),
    grossCents: money(draft.gross, 'Gross pay'), netCents: money(draft.net, 'Net pay'), taxCents: money(draft.tax, 'Taxes'), deductionCents: money(draft.deduction, 'Deductions'), hours: hours(draft.hours, 'Payroll hours'),
    ytd: { grossCents: optionalMoney(draft.ytdGross, 'Year-to-date gross pay'), netCents: optionalMoney(draft.ytdNet, 'Year-to-date net pay'), taxCents: optionalMoney(draft.ytdTax, 'Year-to-date taxes'), deductionCents: optionalMoney(draft.ytdDeduction, 'Year-to-date deductions'), hours: optionalHours(draft.ytdHours, 'Year-to-date hours') },
    earnings: draft.earnings.map(row => ({ ...line(row), hours: optionalHours(row.hours, 'Earning hours'), rate: rate(row.rate), ytdHours: optionalHours(row.ytdHours, 'Year-to-date earning hours') })), taxes: draft.taxes.map(line), deductions: draft.deductions.map(line), lineDetailsReviewed: draft.lineDetailsReviewed,
    vacationBalanceCents: null, vacationAccruedCents: null,
  })) : [];
  if (new Set(paystubs.map(stub => stub.sourcePage)).size !== paystubs.length) throw new Error('Each paystub needs a different source page.');
  const timecards: PayrollTimecard[] = source.kind === 'timecards' ? input.timecards.map(draft => ({ id: draft.id, sourceId: source.id, sourceRow: positive(draft.sourceRow, 'Source row', 100000), sourcePage: positive(draft.sourcePage, 'Source page', source.pageCount), ...period(draft.periodStart, draft.periodEnd), hours: hours(draft.hours, 'Timecard hours'), status: required(draft.status, 'the timecard status'), submissionDate: draft.submissionDate ? date(draft.submissionDate, 'Submission date') : null, transferredTo: draft.transferredTo.trim() || null, system: draft.system })) : [];
  if (new Set(timecards.map(card => `${card.sourcePage}:${card.sourceRow}`)).size !== timecards.length) throw new Error('Each timecard needs a different source page and row.');
  if (!paystubs.length && !timecards.length) throw new Error('Enter at least one record from the original.');
  return { id: input.id, importedAt: input.importedAt, schemaVersion: 1, currency: 'CAD', archive: { filename: source.filename, sha256: source.sha256 }, sources: [source], paystubs, timecards, issues: [] };
}
