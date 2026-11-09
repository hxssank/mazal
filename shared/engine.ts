import type { Summary } from './analytics.ts';
import type { DebtOverview } from './debt-overview.ts';
import type { PlannerDay, PlannerInput, PlannerMonth, PlannerResult } from './planner.ts';
import type { PlannerDraft } from './planner-draft.ts';
import type { PayoffInput, PayoffResult } from './roadmap.ts';
import type { SimulationPoint } from './simulation.ts';
import type { SpendingMonth, SpendingMonthSummary } from './spending-calendar.ts';
import type { StatementCoverage } from './statement-imports.ts';
import type { Workspace } from './types.ts';

export const ENGINE_MODEL_VERSION = 'mazal-engine-17';

export interface EngineIdentity { workspace: Workspace; scope: string; expectedRevision: number; asOf: string }
export interface EngineEnvelope<T> { workspace: Workspace; scope: string; revision: number; asOf: string; inputHash: string; modelVersion: string; result: T }
export interface EngineSummary {
  summary: Summary;
  trackedAssetsCents: number;
  debtOverview: DebtOverview;
  investmentBreakdown: { solValueCents: number; otherValueCents: number; positions: Record<string, { totalSol: number; stakedPercent: number; valueLessCostCents: number }> };
  debtPaymentSummary: { paidThisMonthCents: number; reversedThisMonthCents: number };
  priorityComparison: { reductionCents: number; priorityAnnualSavedCents: number | null; largestAnnualSavedCents: number | null };
}
export type EnginePlannerDay = PlannerDay & { totalDebtCents: number; debtReducedCents: number };
export type EnginePlannerResult = Omit<PlannerResult, 'opening' | 'days' | 'months'> & { opening: EnginePlannerDay; days: EnginePlannerDay[]; months: (Omit<PlannerMonth, 'end'> & { end: EnginePlannerDay; debtReducedCents: number })[] };
export interface PlannerProjection {
  input: PlannerInput | null; result: EnginePlannerResult | null; baseline: PlannerResult | null; faster: PlannerResult | null;
  fixedDebt: number; accountCredit: number; fixedNames: string[]; error: string; points: SimulationPoint[];
  derived: { normalPaychecks: number; normalRemainder: number | null; interestSaved: number; contributionsDelayed: number; earlierDays: number | null; dayInterest: number;
  startingCash: number; startingInvestments: number; momRemaining: number | null; unallocatedCents: number; totalPayCents: number; selectedDebtEarlyPaymentSavingsCents: number | null; };
}
export interface PayoffProjection { base: PayoffResult; extra: PayoffResult; savedInterest: number | null; savedMonths: number | null }
export interface SpendingCalendarProjection { data: SpendingMonth; summary: SpendingMonthSummary; coverage: StatementCoverage }
export interface DailyPlanEvent {
  id: string; sourceType: 'payday' | 'obligation' | 'debt' | 'expense'; sourceId: string; entityId: string;
  name: string; date: string; effectiveDate: string; direction: 'in' | 'out'; amountCents: number | null;
  status: 'overdue' | 'today' | 'upcoming'; isProjection: boolean; includedInCashflow: boolean;
  accountId: string | null; note: string;
}
export interface DailyPlan {
  asOf: string; endDate: string; horizonDays: number; status: 'ready' | 'partial';
  cashCents: number; protectedCents: number; cashAfterKnownCents: number;
  knownIncomeCents: number; knownOutflowCents: number; livingCostsCents: number;
  lowestCashCents: number; lowestCashDate: string; firstShortfallDate: string | null;
  nextPayday: { date: string; amountCents: number | null } | null;
  todayPayday: { date: string; amountCents: number | null; receiptStatus: 'unconfirmed' | 'recorded'; transactionId?: string } | null;
  beforePayday: { endDate: string; knownIncomeCents: number; knownOutflowCents: number; cashAfterKnownCents: number };
  events: DailyPlanEvent[];
  days: { date: string; incomeCents: number; outflowCents: number; livingCostsCents: number; closingCashCents: number; afterProtectedCents: number; eventIds: string[] }[];
  missingInputs: { field: string; message: string; section: 'pay' | 'expenses' | 'debts' | 'assets' | 'accounts' | 'reserve'; sourceId?: string }[];
  warnings: string[];
}
export type EngineProject = { kind: 'daily_plan'; draft: { days?: number } } | { kind: 'spending_calendar'; draft: { month: string } } | { kind: 'planner'; draft: PlannerDraft } | { kind: 'payoff'; draft: { input: PayoffInput; extraPaymentCents: number } };
export interface AllocationAssumptions {
  months: number; reserveCents: number | null; payCents?: number; frequency?: 12 | 26 | 52; paydayAnchor?: string;
  incomeChanges?: { date: string; monthlyIncomeCents: number }[];
  additionalIncomeObligationIds?: string[]; purchaseFirstPaymentDates?: Record<string, string>;
  monthlySpendingCents?: number | null; annualReturnPercent: number; shockPercent: number; shockMonth: number; seed: number; userInvestmentShare: number;
}
export interface AllocationCheckpoint {
  startDate: string; endDate: string; partial: boolean; month?: string; incomeCents: number; spendingCents: number;
  requiredDebtCents: number; extraDebtCents: number; investmentCents: number; openingCashCents: number; closingCashCents: number; unfundedCents: number; maxUnfundedCents?: number;
}
export interface AllocationScenario { id: string; name: string; netWorthCents: number; lossVsBaseCents: number; shockLossCents: number; investmentGrowthCents: number; differenceVsCashCents: number; maxUnfundedCents: number; paychecksToReplace: number | null }
export interface AllocationPolicy {
  id: string; name: string; investmentShare: number | null; eligible: boolean; netWorthCents: number; totalInvestmentContributionsCents: number;
  totalInterestCents: number; lowestCashCents: number; reserveGapCents: number; maxUnfundedCents: number; debtFreeDate: string | null;
  weekly: AllocationCheckpoint[]; monthly: AllocationCheckpoint[]; scenarios: AllocationScenario[];
}
export interface AllocationComparison {
  status: 'ready' | 'needs_inputs'; missingInputs: { field: string; message: string; section?: string; sourceId?: string }[]; warnings: string[]; assumptions: AllocationAssumptions;
  policies: AllocationPolicy[]; bestPolicyId: string | null; comparisonNote: string;
}
export interface EngineRun<T = AllocationComparison> {
  id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: EngineEnvelope<T> | null; error?: string | null; progress?: string | null;
}

export interface CalculationStorageRun {
  id: string; workspace: Workspace; status: EngineRun['status']; kind: string; revision: number;
  scope: string; asOf: string; createdAt: string; bytes: number; fileCount: number; archivable: boolean;
}
export interface CalculationArchive {
  id: string; workspace: Workspace; createdAt: string; runIds: string[]; runCount: number;
  bytes: number; uncompressedBytes: number; sha256: string; restoredRunCount: number; metadataBytes: number; retainedBytes: number;
}
export interface CalculationStorageUsage {
  workspace: Workspace; runBytes: number; archiveBytes: number; totalBytes: number;
  runs: CalculationStorageRun[]; archives: CalculationArchive[]; unreadableEntryCount: number; unclassifiedBytes: number;
  limits: { runsPerArchive: number; uncompressedBytesPerArchive: number };
}

export interface SpendingModelDiagnostic {
  id: string; library?: string; model?: string; converged: boolean; holdoutMaeCents: number | null;
  limitation?: string; warnings?: string[]; maxRHat?: number | null; minEffectiveSampleSize?: number | null; divergences?: number;
  prior?: { mu: { distribution: string; meanCents: number; sigmaCents: number }; sigma: { distribution: string; sigmaCents: number }; nu: number };
  priorNote?: string; chains?: number; drawsPerChain?: number; tunePerChain?: number;
  holdoutPredictiveIntervalCents?: [number, number];
}
export interface SpendingAnalysisResult {
  status: 'insufficient_history' | 'ready'; completeWeeks: number; minimumWeeks: number; weeklyEstimateCents: number | null;
  selectedModel: string | null; models: SpendingModelDiagnostic[]; limitations: string[];
  weeklyPredictiveIntervalCents?: [number, number]; refitDiagnostics?: Omit<SpendingModelDiagnostic, 'id'> & { id?: string };
  validation?: { method: string; trainingWeeks: number; holdoutWeeks: number; trainingEnd: string; holdoutStart: string; selectionRule: string };
}
