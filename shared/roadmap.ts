import type { DebtRepaymentKind } from './types.ts';
import type { DebtInterestPart } from './debt-model.ts';

export interface PayoffInput {
  balanceCents: number;
  aprPercent: number | null;
  monthlyPaymentCents: number;
  extraPaymentCents?: number;
  maxMonths?: number;
  repaymentKind?: DebtRepaymentKind;
  components?: DebtInterestPart[];
}

export interface PayoffMonth {
  month: number;
  balanceCents: number;
  paymentCents: number;
  interestCents: number;
}

export interface PayoffResult {
  status: 'paid_off' | 'needs_inputs' | 'below_interest' | 'beyond_horizon' | 'interest_only';
  months: number | null;
  totalInterestCents: number | null;
  schedule: PayoffMonth[];
}

export interface TransitionInput {
  cashCents: number;
  protectedReservesCents: number;
  monthlyEssentialsCents: number;
  monthlyDebtMinimumsCents: number;
  currentMonthlyIncomeCents: number | null;
  partTimeMonthlyIncomeCents: number | null;
  monthsUntilChange: number;
  transitionMonths: number;
  monthlyExtraDebtCents: number;
}

export interface TransitionResult {
  status: 'ready' | 'needs_inputs';
  currentMonthlySurplus: number | null;
  monthlyShortfallAfterChange: number | null;
  transitionBufferNeeded: number | null;
  cashAvailableForGoal: number;
  projectedTransitionCash: number | null;
  targetGap: number | null;
}

export const payoffAssumption = 'Estimate uses APR divided by 12, with interest rounded to cents each month. Your lender may use daily interest, fees, or a different payment schedule.';
export const transitionAssumption = 'Income means take-home income. Extra loan payments run only before the change to part-time work. Reserves remain protected. Monthly income and essential costs stay at the amounts entered.';
export const planningPriority = 'Cover essentials and confirmed loan minimums, then fund the transition cushion before adding discretionary loan payments.';

function checkedCents(value: number, name: string, allowNegative = false): number {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new RangeError(`${name} must be ${allowNegative ? '' : 'nonnegative '}whole cents within the supported range.`);
  }
  return value;
}

function checkedMonths(value: number, name: string, minimum = 0): number {
  if (!Number.isInteger(value) || value < minimum || value > 1200) {
    throw new RangeError(`${name} must be a whole number between ${minimum} and 1,200.`);
  }
  return value;
}

export function calculatePayoff(input: PayoffInput): PayoffResult {
  let balance = checkedCents(input.balanceCents, 'Loan balance');
  const monthlyPayment = checkedCents(input.monthlyPaymentCents, 'Monthly payment');
  const extraPayment = checkedCents(input.extraPaymentCents ?? 0, 'Extra monthly payment');
  const maxMonths = checkedMonths(input.maxMonths ?? 600, 'Maximum months', 1);
  if (balance === 0) return { status: 'paid_off', months: 0, totalInterestCents: 0, schedule: [] };
  if (input.aprPercent === null) return { status: 'needs_inputs', months: null, totalInterestCents: null, schedule: [] };
  if (!Number.isFinite(input.aprPercent) || input.aprPercent < 0 || input.aprPercent > 1000) {
    throw new RangeError('APR must be between 0 and 1,000 percent, or unknown.');
  }
  const scheduledPayment = checkedCents(monthlyPayment + extraPayment, 'Combined monthly payment');
  const parts = input.components?.map(part => ({ ...part }));
  if (parts && (parts.some(part => !Number.isSafeInteger(part.balanceCents) || part.balanceCents < 0 || !Number.isFinite(part.aprPercent) || part.aprPercent < 0 || part.aprPercent > 1000) || parts.reduce((sum, part) => sum + part.balanceCents, 0) !== balance)) throw new Error('Loan components must have valid balances and rates and add up to the loan balance.');
  if (input.repaymentKind === 'interest_only' && extraPayment === 0) return { status: 'interest_only', months: null, totalInterestCents: null, schedule: [] };
  let totalInterest = 0;
  const schedule: PayoffMonth[] = [];
  for (let month = 1; month <= maxMonths; month += 1) {
    const rawInterest = parts ? parts.reduce((sum, part) => sum + part.balanceCents * part.aprPercent / 1200, 0) : balance * (input.aprPercent / 1200);
    const interest = checkedCents(Math.round(rawInterest), 'Calculated interest');
    const targetPayment = input.repaymentKind === 'interest_only' ? interest + extraPayment : input.repaymentKind === 'one_off' && month > 1 ? extraPayment : scheduledPayment;
    if (targetPayment <= interest) {
      return { status: 'below_interest', months: null, totalInterestCents: null, schedule };
    }
    const amountDue = checkedCents(balance + interest, 'Balance plus interest');
    const payment = Math.min(targetPayment, amountDue);
    balance = amountDue - payment;
    if (parts) {
      const partsDue = parts.reduce((sum, part) => sum + part.balanceCents * (1 + part.aprPercent / 1200), 0);
      for (const part of parts) part.balanceCents = partsDue > 0 ? part.balanceCents * (1 + part.aprPercent / 1200) / partsDue * balance : 0;
    }
    totalInterest = checkedCents(totalInterest + interest, 'Total interest');
    schedule.push({ month, balanceCents: balance, paymentCents: payment, interestCents: interest });
    if (balance === 0) return { status: 'paid_off', months: month, totalInterestCents: totalInterest, schedule };
  }
  return { status: 'beyond_horizon', months: null, totalInterestCents: null, schedule };
}

export function transitionPlan(input: TransitionInput): TransitionResult {
  checkedCents(input.cashCents, 'Cash balance', true);
  checkedCents(input.protectedReservesCents, 'Protected reserves');
  checkedCents(input.monthlyEssentialsCents, 'Monthly essentials');
  checkedCents(input.monthlyDebtMinimumsCents, 'Monthly debt minimums');
  checkedCents(input.monthlyExtraDebtCents, 'Extra monthly debt payment');
  checkedMonths(input.monthsUntilChange, 'Months until the change');
  checkedMonths(input.transitionMonths, 'Months of transition');
  if (input.currentMonthlyIncomeCents !== null) checkedCents(input.currentMonthlyIncomeCents, 'Current monthly take-home income');
  if (input.partTimeMonthlyIncomeCents !== null) checkedCents(input.partTimeMonthlyIncomeCents, 'Part-time monthly take-home income');
  const essentialsAndMinimums = checkedCents(input.monthlyEssentialsCents + input.monthlyDebtMinimumsCents, 'Essentials and debt minimums');
  const cashAvailableForGoal = checkedCents(input.cashCents - input.protectedReservesCents, 'Cash after reserves', true);
  const currentMonthlySurplus = input.currentMonthlyIncomeCents === null ? null
    : checkedCents(input.currentMonthlyIncomeCents - essentialsAndMinimums - input.monthlyExtraDebtCents, 'Current monthly surplus', true);
  const monthlyShortfallAfterChange = input.partTimeMonthlyIncomeCents === null ? null
    : Math.max(0, essentialsAndMinimums - input.partTimeMonthlyIncomeCents);
  const transitionBufferNeeded = monthlyShortfallAfterChange === null ? null
    : checkedCents(monthlyShortfallAfterChange * input.transitionMonths, 'Transition cushion');
  const projectedTransitionCash = currentMonthlySurplus === null ? null
    : checkedCents(cashAvailableForGoal + currentMonthlySurplus * input.monthsUntilChange, 'Projected unreserved cash', true);
  const targetGap = transitionBufferNeeded === null || projectedTransitionCash === null ? null
    : checkedCents(Math.max(0, transitionBufferNeeded - projectedTransitionCash), 'Transition target gap');
  return {
    status: input.currentMonthlyIncomeCents === null || input.partTimeMonthlyIncomeCents === null ? 'needs_inputs' : 'ready',
    currentMonthlySurplus, monthlyShortfallAfterChange, transitionBufferNeeded,
    cashAvailableForGoal, projectedTransitionCash, targetGap,
  };
}
