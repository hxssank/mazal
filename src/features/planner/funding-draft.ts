import type { AppState } from '../../../shared/types.ts';
import { addCents } from '../../../shared/analytics.ts';
import { temporaryWorkSchedule } from '../../../shared/expense-pay.ts';

export interface FundingDraft {
  reserve: string; reserveConfirmed: boolean; annualReturn: string; shock: string; months: string; investmentShare: string;
  additionalIncomeIds: string[]; incomeConfirmedFor: string; purchaseDates: Record<string, string>;
  transitionDate: string; transitionIncome: string; transitionSourceKey: string;
}

export function fundingDefaults(state: AppState): FundingDraft {
  const work = temporaryWorkSchedule(state.roadmap);
  const legacyTransition = !work && state.roadmap?.incomeTransitionPlanned !== false;
  const transitionDate = legacyTransition ? state.roadmap?.transitionDate ?? '' : '';
  const income = legacyTransition ? state.roadmap?.partTimeMonthlyIncomeCents : null;
  const personal = new Set(state.entities.filter(entity => entity.kind === 'personal').map(entity => entity.id));
  const recordedReserves = state.reserves.filter(reserve => personal.has(reserve.entityId)).reduce((sum, reserve) => addCents(sum, reserve.amountCents), 0);
  const savedFloor = state.roadmap?.planningCashReserveCents;
  const protectedCents = Math.max(recordedReserves, savedFloor ?? 0);
  return { reserve: savedFloor != null || recordedReserves > 0 ? (protectedCents / 100).toFixed(2) : '', reserveConfirmed: savedFloor != null, annualReturn: '0', shock: '-30', months: '60', investmentShare: '50',
    additionalIncomeIds: [], incomeConfirmedFor: '', purchaseDates: {}, transitionDate,
    transitionIncome: income == null ? '' : (income / 100).toFixed(2), transitionSourceKey: JSON.stringify(work ? [state.roadmap?.transitionDate, work] : [transitionDate, income ?? null]) };
}

export function restoreFundingDraft(serialized: string | null, defaults: FundingDraft): FundingDraft {
  try {
    const saved = JSON.parse(serialized ?? 'null');
    if (saved?.version !== 1 || !saved.draft || typeof saved.draft !== 'object') return defaults;
    const raw = saved.draft;
    const draft = { ...defaults };
    for (const field of ['reserve', 'annualReturn', 'shock', 'investmentShare', 'incomeConfirmedFor'] as const) {
      if (typeof raw[field] === 'string') draft[field] = raw[field];
    }
    if (['12', '24', '60'].includes(raw.months)) draft.months = raw.months;
    if (typeof raw.reserveConfirmed === 'boolean') draft.reserveConfirmed = raw.reserveConfirmed;
    if (Array.isArray(raw.additionalIncomeIds) && raw.additionalIncomeIds.every((value: unknown) => typeof value === 'string')) draft.additionalIncomeIds = [...new Set<string>(raw.additionalIncomeIds)];
    if (raw.purchaseDates && typeof raw.purchaseDates === 'object' && !Array.isArray(raw.purchaseDates)) {
      draft.purchaseDates = Object.fromEntries(Object.entries(raw.purchaseDates).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    }
    if (raw.transitionSourceKey === defaults.transitionSourceKey) {
      if (typeof raw.transitionDate === 'string') draft.transitionDate = raw.transitionDate;
      if (typeof raw.transitionIncome === 'string') draft.transitionIncome = raw.transitionIncome;
    }
    return draft;
  } catch { return defaults; }
}
