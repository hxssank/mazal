import type { AllocationAssumptions, AllocationComparison, EngineEnvelope, EngineIdentity, EngineProject, EngineRun, EngineSummary } from '../../shared/engine.ts';
import { ENGINE_MODEL_VERSION } from '../../shared/engine.ts';

const unavailable = 'The Python engine is unavailable. Check that Mazal’s local services are running, then retry.';
const requestTimeoutMs = 125_000;
export class EngineRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = 'EngineRequestError'; this.status = status; }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
async function request(path: string, signal?: AbortSignal, body?: unknown, method = body === undefined ? 'GET' : 'POST', onLateResponse?: (value: unknown) => void): Promise<unknown> {
  if (signal?.aborted) throw signal.reason;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  let rejectAborted: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error('The engine request timed out after 125 seconds. Retry the calculation.')), requestTimeoutMs);
  async function read(): Promise<unknown> {
    let response: Response;
    try { response = await fetch(path, { method, signal: controller.signal, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); }
    catch { if (controller.signal.aborted) throw controller.signal.reason; throw new Error(unavailable); }
    let value: unknown;
    try { value = await response.json(); }
    catch { if (controller.signal.aborted) throw controller.signal.reason; throw new Error('The engine returned an unreadable result. Retry the calculation.'); }
    if (controller.signal.aborted) {
      if (response.ok) onLateResponse?.(value);
      throw controller.signal.reason;
    }
    if (!response.ok) throw new EngineRequestError(record(value) && typeof value.error === 'string' ? value.error : unavailable, response.status);
    return value;
  }
  try { return await Promise.race([read(), aborted]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAborted!);
  }
}
export type EngineResultKind = 'summary' | EngineProject['kind'] | 'comparison' | 'spending';
type Check = (value: unknown) => boolean;
const text: Check = value => typeof value === 'string';
const number: Check = value => typeof value === 'number' && Number.isFinite(value);
const cents: Check = value => Number.isSafeInteger(value);
const boolean: Check = value => typeof value === 'boolean';
const nullable = (check: Check): Check => value => value === null || check(value);
const optional = (check: Check): Check => value => value === undefined || check(value);
const list = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const oneOf = (...values: unknown[]): Check => value => values.includes(value);
const object = (fields: Record<string, Check>): Check => value => record(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
const numbers = (keys: string): Record<string, Check> => Object.fromEntries(keys.split(' ').map(key => [key, cents]));
const allFinite: Check = value => typeof value === 'number' ? Number.isFinite(value) : Array.isArray(value) ? value.every(allFinite) : record(value) ? Object.values(value).every(allFinite) : true;
const strings = list(text);
const debtTerms = object({ aprPercent: nullable(number), minimumPaymentCents: nullable(cents), rateConfirmed: boolean, notes: text, ...Object.fromEntries('paymentDueDate statementDate repaymentStatusAsOf schoolReturnMonth studyEndDate repaymentStartDate'.split(' ').map(key => [key, optional(nullable(text))])), repaymentKind: optional(text), interestStatus: optional(text), repaymentStatus: optional(text), repaymentStatusSource: optional(text), components: optional(list(object({ id: text, balanceCents: nullable(cents), aprPercent: nullable(number), rateConfirmed: boolean, interestStatus: text }))) });
const account = object({ id: text, entityId: text, name: text, type: text, balanceCents: cents, debtTerms: optional(debtTerms), evidence: optional(object({ sourceFile: text, asOf: nullable(text), capturedOn: text, status: text, notes: text })) });
const summary = object({
  summary: object(numbers('assetsCents liabilitiesCents netWorthCents cashCents investmentsCents receivablesCents physicalAssetsCents purchaseEquityCents availableCents reservedCents committedCents incomeCents expensesCents personalAvailableCents')),
  trackedAssetsCents: cents,
  debtOverview: object({
    ...numbers('debtCents creditCents monthlyInterestCents unknownInterestCount deferredCents repayingCents'), highestRateAccountId: nullable(text), largestBalanceAccountId: nullable(text),
    rows: list(object({ account, accountId: text, balanceCents: cents, confirmedApr: nullable(number), monthlyInterestCents: nullable(cents), paymentStatus: text, requiredPaymentCents: nullable(cents), dueDate: nullable(text) })),
  }),
  investmentBreakdown: object({ solValueCents: cents, otherValueCents: cents, positions: value => record(value) && Object.values(value).every(object({ totalSol: number, stakedPercent: number, valueLessCostCents: cents })) }),
  debtPaymentSummary: object(numbers('paidThisMonthCents reversedThisMonthCents')),
  priorityComparison: object({ reductionCents: cents, priorityAnnualSavedCents: nullable(cents), largestAnnualSavedCents: nullable(cents) }),
});
const spendingDay = object({ date: text, totalCents: cents, isFuture: boolean, entries: list(object({ transaction: object({ id: text, description: text, category: text }), ...numbers('amountCents recordedAmountCents ownershipBps'), accountName: text, ownerName: text })) });
const spendingCalendar = object({
  data: object({ month: text, ...numbers('totalCents transactionCount largestDayCents'), firstWeekday: value => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6, days: value => Array.isArray(value) && value.length > 0 && value.every(spendingDay), hasWeightedExpenses: boolean }),
  summary: object({ categories: list(object({ key: text, label: text, totalCents: cents })), daysWithExpenses: cents, highestDay: nullable(spendingDay) }),
  coverage: object({ status: oneOf('none', 'partial', 'complete'), ...numbers('accountCount coveredAccountCount completeAccountCount coveredAccountDays totalAccountDays'), accounts: list(object({ accountId: text, coveredDays: cents, totalDays: cents })) }),
});
const calendarDate: Check = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dailyPlanEvent = object({ id: text, sourceType: oneOf('payday', 'obligation', 'debt', 'expense'), sourceId: text, entityId: text, name: text, date: calendarDate, effectiveDate: calendarDate, direction: oneOf('in', 'out'), amountCents: nullable(cents), status: oneOf('overdue', 'today', 'upcoming'), isProjection: boolean, includedInCashflow: boolean, accountId: nullable(text), note: text });
const dailyPlan: Check = value => {
  if (!object({
    asOf: calendarDate, endDate: calendarDate, horizonDays: value => Number.isInteger(value) && Number(value) >= 7 && Number(value) <= 90, status: oneOf('ready', 'partial'),
    ...numbers('cashCents protectedCents cashAfterKnownCents knownIncomeCents knownOutflowCents livingCostsCents lowestCashCents'), lowestCashDate: calendarDate, firstShortfallDate: nullable(calendarDate),
    nextPayday: nullable(object({ date: calendarDate, amountCents: nullable(cents) })),
    todayPayday: nullable(object({ date: calendarDate, amountCents: nullable(value => cents(value) && Number(value) >= 0), receiptStatus: oneOf('unconfirmed', 'recorded'), transactionId: optional(value => text(value) && String(value).trim().length > 0) })),
    beforePayday: object({ endDate: calendarDate, ...numbers('knownIncomeCents knownOutflowCents cashAfterKnownCents') }),
    events: list(dailyPlanEvent), days: list(object({ date: calendarDate, ...numbers('incomeCents outflowCents livingCostsCents closingCashCents afterProtectedCents'), eventIds: strings })),
    missingInputs: list(object({ field: text, message: text, section: oneOf('pay', 'expenses', 'debts', 'assets', 'accounts', 'reserve'), sourceId: optional(text) })), warnings: strings,
  })(value) || !record(value)) return false;
  const days = value.days as Record<string, unknown>[];
  const events = value.events as Record<string, unknown>[];
  const todayPayday = value.todayPayday as Record<string, unknown> | null;
  if (todayPayday && (todayPayday.date !== value.asOf || (todayPayday.receiptStatus === 'recorded') !== (todayPayday.transactionId !== undefined))) return false;
  const eventIds = new Set(events.map(event => event.id));
  if (eventIds.size !== events.length || days.length !== value.horizonDays || days[0]?.date !== value.asOf || days.at(-1)?.date !== value.endDate) return false;
  if ((value.status === 'ready') !== ((value.missingInputs as unknown[]).length === 0)) return false;
  return days.every((day, index) => (!index || Date.parse(String(day.date)) - Date.parse(String(days[index - 1].date)) === 86400000)
    && (day.eventIds as string[]).every(id => eventIds.has(id)))
    && events.every(event => Number(event.amountCents ?? 0) >= 0 && (!event.includedInCashflow || event.amountCents !== null)
      && String(event.effectiveDate) >= String(value.asOf) && String(event.effectiveDate) <= String(value.endDate));
};
const payoffResult = object({ status: oneOf('paid_off', 'needs_inputs', 'below_interest', 'beyond_horizon', 'interest_only'), months: nullable(cents), totalInterestCents: nullable(cents), schedule: list(object(numbers('month balanceCents paymentCents interestCents'))) });
const payoff = object({ base: payoffResult, extra: payoffResult, savedInterest: nullable(cents), savedMonths: nullable(cents) });
const targets = object(numbers('spendingCents momCents debtCents'));
const paycheck = object({ date: text, month: text, ...numbers('dayIndex number payCents spendingCents momCents debtCents investCents cashCents extraDebtCents shortfallCents'), targets, debtPayments: list(object({ debtId: text, amountCents: cents })) });
const plannerDayFields = { date: text, ...numbers('dayIndex paycheckNumber momPaidCents debtCents investmentsCents cashCents cashContributionsCents interestCents investmentContributionsCents investmentGrowthCents progressCents'), momRemainingCents: nullable(cents), payday: optional(paycheck), debts: list(object({ id: text, name: text, ...numbers('balanceCents interestCents paymentCents') })) };
const plannerResult = (enriched: boolean): Check => {
  const day = object({ ...plannerDayFields, ...(enriched ? numbers('totalDebtCents debtReducedCents') : {}) });
  return object({
    surplusDestination: oneOf('cash', 'investments'), opening: day, days: value => Array.isArray(value) && value.length > 0 && value.every(day), paychecks: list(paycheck),
    months: list(object({ month: text, ...numbers('paydayCount incomeCents spendingCents momCents debtCents investCents cashCents interestCents shortfallCents minimumShortfallCents unknownMinimumCount'), ...(enriched ? { debtReducedCents: cents } : {}), paycheckNumbers: list(cents), targets, end: day })),
    milestones: list(object({ date: text, name: text, type: oneOf('mom_paid', 'debt_paid'), debtId: optional(text) })), debtFreeDate: nullable(text), ...numbers('totalInterestCents totalShortfallCents totalMinimumShortfallCents monthsWithUnknownMinimums'), warnings: strings,
  });
};
const planner: Check = value => {
  if (!object({ fixedDebt: cents, accountCredit: cents, fixedNames: strings, error: text, derived: record, points: list(object(numbers('month cashCents investmentsCents debtCents selectedDebtCents businessCents netWorthCents interestCents investmentChangeCents debtPaymentCents redirectedDebtCents'))) })(value) || !record(value)) return false;
  if (value.result === null) return value.input === null && value.baseline === null && value.faster === null && typeof value.error === 'string' && value.error.length > 0;
  return object({
    result: plannerResult(true), baseline: plannerResult(false), faster: plannerResult(false),
    input: object({ payByDateCents: optional(value => record(value) && Object.entries(value).every(([date, amount]) => calendarDate(date) && cents(amount) && Number(amount) >= 0)), startMonth: text, paydayAnchor: text, ...numbers('months payCents frequency monthlyMomCents monthlyDebtCents monthlySpendingCents startingCashCents startingInvestmentsCents extraDebtCents'), annualReturnPercent: number, momRemainingCents: nullable(cents), surplusDestination: oneOf('cash', 'investments'), strategy: text, selectedDebtId: nullable(text), debts: list(object({ id: text, name: text, balanceCents: cents, aprPercent: number, minimumCents: nullable(cents) })) }),
    derived: object({ ...numbers('normalPaychecks interestSaved contributionsDelayed dayInterest startingCash startingInvestments unallocatedCents totalPayCents'), normalRemainder: nullable(cents), earlierDays: nullable(cents), momRemaining: nullable(cents), selectedDebtEarlyPaymentSavingsCents: nullable(cents) }),
  })(value);
};
const checkpoint = object({ startDate: text, endDate: text, partial: boolean, ...numbers('incomeCents spendingCents requiredDebtCents extraDebtCents investmentCents openingCashCents closingCashCents unfundedCents') });
const comparison = object({
  status: oneOf('ready', 'needs_inputs'), missingInputs: list(object({ field: text, message: text })), warnings: strings, assumptions: record, bestPolicyId: nullable(text), comparisonNote: text,
  policies: list(object({ id: text, name: text, investmentShare: nullable(number), eligible: boolean, ...numbers('netWorthCents totalInvestmentContributionsCents totalInterestCents lowestCashCents reserveGapCents maxUnfundedCents'), debtFreeDate: nullable(text), weekly: list(checkpoint), monthly: list(checkpoint), scenarios: list(object({ id: text, name: text, ...numbers('netWorthCents lossVsBaseCents shockLossCents investmentGrowthCents differenceVsCashCents maxUnfundedCents'), paychecksToReplace: nullable(number) })) })),
});
const interval: Check = value => Array.isArray(value) && value.length === 2 && value.every(cents) && value[0] <= value[1];
const diagnosticFields: Record<string, Check> = {
  id: text, converged: boolean, priorNote: optional(text), chains: optional(cents), drawsPerChain: optional(cents), tunePerChain: optional(cents), holdoutMaeCents: optional(nullable(cents)), warnings: optional(strings), limitation: optional(text),
  maxRHat: optional(nullable(number)), minEffectiveSampleSize: optional(nullable(number)), divergences: optional(cents), holdoutPredictiveIntervalCents: optional(interval),
  prior: optional(object({ mu: object({ meanCents: number, sigmaCents: number }), sigma: object({ sigmaCents: number }), nu: number })),
};
const diagnostic = object(diagnosticFields);
const spending = object({ status: oneOf('ready', 'insufficient_history'), completeWeeks: cents, minimumWeeks: cents, weeklyEstimateCents: nullable(cents), selectedModel: nullable(text), models: list(diagnostic), limitations: strings, weeklyPredictiveIntervalCents: optional(interval), refitDiagnostics: optional(object({ ...diagnosticFields, id: optional(text) })), validation: optional(object({ method: text, trainingWeeks: cents, holdoutWeeks: cents, trainingEnd: text, holdoutStart: text, selectionRule: text })) });
const resultChecks: Record<EngineResultKind, Check> = { summary, spending_calendar: spendingCalendar, daily_plan: dailyPlan, payoff, planner, comparison, spending };

export function validateEngineEnvelope<T>(value: unknown, identity: EngineIdentity, kind?: EngineResultKind): EngineEnvelope<T> {
  if (!record(value) || value.workspace !== identity.workspace || value.scope !== identity.scope || value.revision !== identity.expectedRevision || value.asOf !== identity.asOf
    || typeof value.inputHash !== 'string' || !value.inputHash || typeof value.modelVersion !== 'string' || !value.modelVersion || !record(value.result)) {
    throw new Error('The calculation does not match the current records. Refresh your records and retry.');
  }
  if (value.modelVersion !== ENGINE_MODEL_VERSION) throw new Error('The calculation uses a different financial engine version. Reopen Mazal to load the current engine, then retry.');
  if (!allFinite(value.result) || kind && !resultChecks[kind](value.result) || kind === 'daily_plan' && value.result.asOf !== identity.asOf) throw new Error('The engine returned an incomplete calculation. Retry the calculation.');
  return value as unknown as EngineEnvelope<T>;
}
export async function getEngineSummary(identity: EngineIdentity, signal?: AbortSignal): Promise<EngineEnvelope<EngineSummary>> {
  const query = new URLSearchParams({ workspace: identity.workspace, scope: identity.scope, asOf: identity.asOf, expectedRevision: String(identity.expectedRevision) });
  return validateEngineEnvelope(await request(`/api/engine/summary?${query}`, signal), identity, 'summary');
}
export async function projectEngine<T>(identity: EngineIdentity, project: EngineProject, signal?: AbortSignal): Promise<EngineEnvelope<T>> {
  return validateEngineEnvelope(await request(`/api/engine/project?workspace=${identity.workspace}`, signal, { ...identity, ...project }), identity, project.kind);
}
function readRun<T>(value: unknown): EngineRun<T> {
  if (!record(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(value.status))
    || !optional(nullable(text))(value.error) || !optional(nullable(text))(value.progress)
    || value.status === 'failed' && (typeof value.error !== 'string' || !value.error.trim())) throw new Error('The engine returned an unreadable run status.');
  return value as unknown as EngineRun<T>;
}
export async function startEngineRun<T = AllocationComparison>(identity: EngineIdentity, assumptions: AllocationAssumptions | { seed: number }, signal?: AbortSignal, kind: 'comparison' | 'spending' = 'comparison'): Promise<EngineRun<T>> {
  return readRun<T>(await request(`/api/engine/runs?workspace=${identity.workspace}`, signal, { ...identity, kind, assumptions }, 'POST', value => {
    if (!record(value) || value.workspace !== identity.workspace) return;
    try {
      const run = readRun<T>(value);
      if (run.status === 'queued' || run.status === 'running') void cancelEngineRun(run.id, identity.workspace).catch(() => {});
    } catch {}
  }));
}
export async function getEngineRun<T = AllocationComparison>(id: string, workspace: EngineIdentity['workspace'], signal?: AbortSignal): Promise<EngineRun<T>> {
  return readRun<T>(await request(`/api/engine/runs/${encodeURIComponent(id)}?workspace=${workspace}`, signal));
}
export async function cancelEngineRun<T = AllocationComparison>(id: string, workspace: EngineIdentity['workspace'], signal?: AbortSignal): Promise<EngineRun<T>> {
  return readRun<T>(await request(`/api/engine/runs/${encodeURIComponent(id)}?workspace=${workspace}`, signal, undefined, 'DELETE'));
}
