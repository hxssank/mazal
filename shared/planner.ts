import type { DebtRepaymentKind } from './types.ts';
import type { DebtInterestPart } from './debt-model.ts';

export interface PlannerDebt {
  id: string;
  name: string;
  balanceCents: number;
  aprPercent: number;
  minimumCents: number | null;
  minimumDueDate?: string | null;
  repaymentKind?: DebtRepaymentKind;
  components?: DebtInterestPart[];
  repaymentStartDate?: string | null;
  studyEndDate?: string | null;
  paymentsDeferred?: boolean;
}

export interface PlannerInput {
  startMonth: string;
  months: number;
  payCents: number;
  payByDateCents?: Record<string, number>;
  frequency: 12 | 26 | 52;
  paydayAnchor: string;
  monthlyMomCents: number;
  momRemainingCents: number | null;
  monthlyDebtCents: number;
  monthlySpendingCents: number;
  debts: PlannerDebt[];
  startingCashCents: number;
  startingInvestmentsCents: number;
  surplusDestination: 'cash' | 'investments';
  annualReturnPercent: number;
  extraDebtCents: number;
  strategy: 'selected' | 'avalanche';
  selectedDebtId: string | null;
}

export interface PlannerTargets {
  spendingCents: number;
  momCents: number;
  debtCents: number;
}

export interface PlannerDebtBalance {
  id: string;
  name: string;
  balanceCents: number;
  interestCents: number;
  paymentCents: number;
}

export interface PlannerPaycheck {
  date: string;
  dayIndex: number;
  number: number;
  month: string;
  payCents: number;
  spendingCents: number;
  momCents: number;
  debtCents: number;
  investCents: number;
  cashCents: number;
  extraDebtCents: number;
  shortfallCents: number;
  targets: PlannerTargets;
  debtPayments: { debtId: string; amountCents: number }[];
}

export interface PlannerDay {
  date: string;
  dayIndex: number;
  paycheckNumber: number;
  payday?: PlannerPaycheck;
  momPaidCents: number;
  momRemainingCents: number | null;
  debtCents: number;
  debts: PlannerDebtBalance[];
  investmentsCents: number;
  cashCents: number;
  cashContributionsCents: number;
  interestCents: number;
  investmentContributionsCents: number;
  investmentGrowthCents: number;
  progressCents: number;
}

export interface PlannerMonth {
  month: string;
  paydayCount: number;
  paycheckNumbers: number[];
  incomeCents: number;
  spendingCents: number;
  momCents: number;
  debtCents: number;
  investCents: number;
  cashCents: number;
  interestCents: number;
  shortfallCents: number;
  minimumShortfallCents: number;
  unknownMinimumCount: number;
  targets: PlannerTargets;
  end: PlannerDay;
}

export interface PlannerMilestone {
  type: 'debt_paid' | 'mom_paid';
  date: string;
  debtId?: string;
  name: string;
}

export interface PlannerResult {
  surplusDestination: 'cash' | 'investments';
  opening: PlannerDay;
  days: PlannerDay[];
  paychecks: PlannerPaycheck[];
  months: PlannerMonth[];
  milestones: PlannerMilestone[];
  debtFreeDate: string | null;
  totalInterestCents: number;
  totalShortfallCents: number;
  totalMinimumShortfallCents: number;
  monthsWithUnknownMinimums: number;
  warnings: string[];
}

const DAY_MS = 86_400_000;
const MAX_INPUT_CENTS = 1_000_000_000_000;

function cents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INPUT_CENTS) throw new Error(`${label} must be nonnegative whole cents, at most ${MAX_INPUT_CENTS}.`);
  return value;
}

function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dateValue(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be a real date in YYYY-MM-DD format.`);
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  const year = Number(value.slice(0, 4));
  if (!Number.isFinite(timestamp) || isoDate(timestamp) !== value || year < 1900 || year > 2200) throw new Error(`${label} must be a real date between 1900 and 2200.`);
  return timestamp;
}

function monthValue(value: string): number {
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error('Start month must use YYYY-MM format.');
  return dateValue(`${value}-01`, 'Start month');
}

function nextMonth(timestamp: number, offset = 1): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1);
}

function splitCents(amount: number, count: number, index: number): number {
  return Math.floor(amount / count) + (index < amount % count ? 1 : 0);
}

function cumulativeSplit(amount: number, count: number, index: number): number {
  return Math.floor(amount / count) * (index + 1) + Math.min(index + 1, amount % count);
}

function payDates(input: PlannerInput, start: number, end: number, anchor: number): Set<string> {
  const result = new Set<string>();
  if (input.frequency === 12) {
    const anchorDate = new Date(anchor);
    const anchorMonth = Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), 1);
    for (let month = Math.max(start, anchorMonth); month < end; month = nextMonth(month)) {
      const date = new Date(month);
      const lastDay = new Date(nextMonth(month) - DAY_MS).getUTCDate();
      const timestamp = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), Math.min(lastDay, anchorDate.getUTCDate()));
      if (timestamp >= anchor && timestamp >= start) result.add(isoDate(timestamp));
    }
  } else {
    const interval = (input.frequency === 26 ? 14 : 7) * DAY_MS;
    const first = anchor + Math.max(0, Math.ceil((start - anchor) / interval)) * interval;
    for (let timestamp = first; timestamp < end; timestamp += interval) result.add(isoDate(timestamp));
  }
  return result;
}

interface DebtState {
  source: PlannerDebt;
  balance: number;
  interest: number;
  paid: number;
  components?: DebtInterestPart[];
}

function paymentDueDate(debt: PlannerDebt): string | null {
  const due = debt.minimumDueDate ?? null;
  return due && debt.paymentsDeferred && debt.repaymentStartDate && due < debt.repaymentStartDate ? null : due;
}

export function simulatePlanner(input: PlannerInput): PlannerResult {
  const start = monthValue(input.startMonth);
  const anchor = dateValue(input.paydayAnchor, 'First payday');
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > 24) throw new Error('Choose 1 to 24 whole months.');
  if (![12, 26, 52].includes(input.frequency)) throw new Error('Choose 12 monthly, 26 biweekly, or 52 weekly paychecks.');
  if (!['selected', 'avalanche'].includes(input.strategy)) throw new Error('Choose selected or avalanche debt repayment.');
  if (!['cash', 'investments'].includes(input.surplusDestination)) throw new Error('Choose cash or investments for remaining income.');
  cents(input.payCents, 'Pay');
  cents(input.monthlyMomCents, 'Monthly Mom payment');
  if (input.momRemainingCents !== null) cents(input.momRemainingCents, 'Mom remaining');
  cents(input.monthlyDebtCents, 'Monthly debt payment');
  cents(input.monthlySpendingCents, 'Monthly spending');
  cents(input.startingInvestmentsCents, 'Starting investments');
  if (!Number.isSafeInteger(input.startingCashCents) || Math.abs(input.startingCashCents) > MAX_INPUT_CENTS) throw new Error('Starting cash must be whole cents within the supported range.');
  cents(input.extraDebtCents, 'Extra debt payment');
  if (!Number.isFinite(input.annualReturnPercent) || input.annualReturnPercent < -100 || input.annualReturnPercent > 100) throw new Error('Annual investment return must be between -100% and 100%.');
  if (!Array.isArray(input.debts) || input.debts.length > 50) throw new Error('Use at most 50 debts.');
  const ids = new Set<string>();
  const debts: DebtState[] = input.debts.map((debt) => {
    if (!debt.id || ids.has(debt.id)) throw new Error('Every debt needs a unique nonempty ID.');
    ids.add(debt.id);
    cents(debt.balanceCents, 'Debt balance');
    if (debt.minimumCents !== null) cents(debt.minimumCents, 'Monthly minimum');
    if (!Number.isFinite(debt.aprPercent) || debt.aprPercent < 0 || debt.aprPercent > 100) throw new Error('Debt APR must be between 0% and 100%.');
    for (const field of ['minimumDueDate', 'repaymentStartDate', 'studyEndDate'] as const) if (debt[field]) dateValue(debt[field], field);
    if (debt.repaymentKind && !['fixed', 'revolving', 'interest_only', 'one_off'].includes(debt.repaymentKind)) throw new Error('Choose a valid debt repayment kind.');
    if (debt.components) {
      for (const component of debt.components) {
        cents(component.balanceCents, 'Component balance');
        if (!Number.isFinite(component.aprPercent) || component.aprPercent < 0 || component.aprPercent > 100) throw new Error('Component APR must be between 0% and 100%.');
      }
      if (debt.components.reduce((sum, component) => sum + component.balanceCents, 0) !== debt.balanceCents) throw new Error('Loan components must add up to its balance.');
    }
    return { source: debt, balance: debt.balanceCents, interest: 0, paid: 0, ...(debt.components ? { components: debt.components.map(component => ({ ...component })) } : {}) };
  });
  if (input.selectedDebtId !== null && !ids.has(input.selectedDebtId)) throw new Error('The selected debt must be in the plan.');
  const openingDebt = cents(debts.reduce((total, debt) => total + debt.balance, 0), 'Combined debt');
  const priority = [...debts].sort((a, b) => {
    if (input.strategy === 'selected') {
      if (a.source.id === input.selectedDebtId) return -1;
      if (b.source.id === input.selectedDebtId) return 1;
    }
    return b.source.aprPercent - a.source.aprPercent || a.source.id.localeCompare(b.source.id);
  });
  const end = nextMonth(start, input.months);
  const scheduledDates = payDates(input, start, end, anchor);
  const warnings = debts.filter((debt) => debt.balance > 0 && debt.source.minimumCents === null).map((debt) => `Minimum payment for ${debt.source.name} is unknown. Add it before using this plan for payments.`);
  for (const debt of debts) {
    if (!debt.balance) continue;
    const dueDate = paymentDueDate(debt.source);
    if (debt.source.minimumDueDate && !dueDate) warnings.push(`${debt.source.name}: the recorded due date ${debt.source.minimumDueDate} is before repayment resumes ${debt.source.repaymentStartDate}. Confirm the first payment deadline after deferral.`);
    if (!dueDate && debt.source.minimumCents && (!debt.source.paymentsDeferred || debt.source.repaymentStartDate)) warnings.push(`${debt.source.name}: payment due date is unknown. Monthly funding does not confirm on-time payment.`);
    if (dueDate && debt.source.repaymentKind !== 'one_off' && debt.source.repaymentKind !== 'fixed') warnings.push(`${debt.source.name}: only the recorded due date is confirmed. Later months use estimated minimums; confirm each statement.`);
    if (debt.source.repaymentKind === 'interest_only') warnings.push(`${debt.source.name}: after the recorded payment, monthly interest-only targets use the remaining balance and APR. Fees, rate changes and lender billing periods are not modeled.`);
    if (debt.source.components) warnings.push(`${debt.source.name}: this scenario allocates payments proportionally between loan components. Confirm the lender's allocation before paying.`);
    if (debt.source.paymentsDeferred) warnings.push(`${debt.source.name}: ${debt.source.repaymentStartDate ? `required payments resume ${debt.source.repaymentStartDate}` : debt.source.studyEndDate ? `study status needs review after ${debt.source.studyEndDate}; later minimums are unknown` : 'the deferral has no recorded end date; future required payments are unknown'}.`);
  }
  let investments = input.startingInvestmentsCents;
  let contributions = 0;
  let cash = input.startingCashCents;
  let cashContributions = 0;
  let momRemaining = input.momRemainingCents;
  let momPaid = 0;
  const paychecks: PlannerPaycheck[] = [];
  const milestones: PlannerMilestone[] = [];
  const days: PlannerDay[] = [];
  const months: PlannerMonth[] = [];
  const dailyReturn = Math.pow(1 + input.annualReturnPercent / 100, 1 / 365) - 1;
  const snapshot = (timestamp: number, dayIndex: number, payday?: PlannerPaycheck): PlannerDay => {
    const balances = debts.map((debt) => ({ id: debt.source.id, name: debt.source.name, balanceCents: Math.round(debt.balance), interestCents: Math.round(debt.interest), paymentCents: debt.paid }));
    const debtCents = balances.reduce((total, debt) => total + debt.balanceCents, 0);
    const investmentsCents = Math.round(investments);
    return {
      date: isoDate(timestamp), dayIndex, paycheckNumber: paychecks.length, ...(payday ? { payday } : {}),
      momPaidCents: momPaid, momRemainingCents: momRemaining, debtCents, debts: balances,
      investmentsCents, interestCents: balances.reduce((total, debt) => total + debt.interestCents, 0),
      cashCents: cash, cashContributionsCents: cashContributions,
      investmentContributionsCents: contributions, investmentGrowthCents: investmentsCents - input.startingInvestmentsCents - contributions,
      progressCents: openingDebt - debtCents + momPaid + cashContributions + investmentsCents - input.startingInvestmentsCents,
    };
  };
  const opening = snapshot(start - DAY_MS, -1);
  let debtFreeDate: string | null = openingDebt === 0 ? opening.date : null;
  let dayIndex = 0;
  for (let monthStart = start; monthStart < end; monthStart = nextMonth(monthStart)) {
    const monthEnd = nextMonth(monthStart);
    const month = isoDate(monthStart).slice(0, 7);
    const dates = [...scheduledDates].filter((date) => date.startsWith(month));
    const paydayCount = dates.length;
    const monthOpening = days.at(-1) ?? opening;
    const monthPayments = new Map(debts.map((debt) => [debt.source.id, 0]));
    const requirements = new Map(debts.map(debt => {
      const source = debt.source;
      const knownDue = paymentDueDate(source);
      let dueDate: string | null = null;
      if (knownDue && (knownDue.startsWith(month) || monthStart === start && knownDue < isoDate(start))) dueDate = knownDue;
      else if (knownDue && source.repaymentKind === 'fixed' && knownDue < isoDate(monthEnd)) {
        const day = Math.min(Number(knownDue.slice(8)), new Date(monthEnd - DAY_MS).getUTCDate());
        dueDate = `${month}-${String(day).padStart(2, '0')}`;
      }
      let amount = source.repaymentKind === 'one_off' ? dueDate ? source.minimumCents : 0 : source.minimumCents;
      if (source.repaymentKind === 'interest_only' && (!knownDue || dueDate !== knownDue)) amount = Math.round((debt.components ?? [{ balanceCents: debt.balance, aprPercent: source.aprPercent }]).reduce((sum, part) => sum + part.balanceCents * part.aprPercent / 1200, 0));
      if (knownDue && knownDue >= isoDate(monthEnd)) amount = 0;
      if (source.paymentsDeferred) {
        if (!source.repaymentStartDate) { amount = source.studyEndDate && source.studyEndDate < isoDate(monthEnd - DAY_MS) ? null : 0; dueDate = null; }
        else if (source.repaymentStartDate >= isoDate(monthEnd)) { amount = 0; dueDate = null; }
      }
      return [source.id, { amount: amount === null ? null : Math.min(amount, Math.round(debt.balance)), dueDate, shortfall: 0, checked: false }];
    }));
    const unknownMinimumCount = debts.filter(debt => debt.balance > 0 && requirements.get(debt.source.id)!.amount === null).length;
    const monthPaychecks: PlannerPaycheck[] = [];
    let baseDebtPaid = 0;
    const targets = { spendingCents: input.monthlySpendingCents, momCents: input.monthlyMomCents, debtCents: input.monthlyDebtCents };
    for (let timestamp = monthStart; timestamp < monthEnd; timestamp += DAY_MS, dayIndex += 1) {
      const date = isoDate(timestamp);
      for (const debt of debts) {
        const interest = debt.components ? debt.components.reduce((sum, part) => { const value = part.balanceCents * part.aprPercent / 36500; part.balanceCents += value; return sum + value; }, 0) : debt.balance * debt.source.aprPercent / 100 / 365;
        debt.balance += interest;
        debt.interest += interest;
      }
      investments += investments * dailyReturn;
      let payday: PlannerPaycheck | undefined;
      if (scheduledDates.has(date)) {
        const index = monthPaychecks.length;
        const installment = {
          spendingCents: splitCents(targets.spendingCents, paydayCount, index),
          momCents: splitCents(targets.momCents, paydayCount, index),
          debtCents: splitCents(targets.debtCents, paydayCount, index),
        };
        const payCents = cents(input.payByDateCents?.[date] ?? input.payCents, 'Pay');
        let available = payCents;
        const spendingCents = Math.min(available, installment.spendingCents);
        available -= spendingCents;
        const momNeeded = Math.min(installment.momCents, momRemaining ?? installment.momCents);
        const momCents = Math.min(available, momNeeded);
        available -= momCents;
        momPaid += momCents;
        if (momRemaining !== null) {
          const wasOwed = momRemaining > 0;
          momRemaining -= momCents;
          if (wasOwed && momRemaining === 0) milestones.push({ type: 'mom_paid', date, name: 'Mom paid off' });
        }
        const nextPayday = dates[index + 1] ?? isoDate(monthEnd);
        const urgentMinimum = debts.reduce((sum, debt) => { const requirement = requirements.get(debt.source.id)!; return sum + (requirement.dueDate && requirement.dueDate < nextPayday ? Math.max(0, (requirement.amount ?? 0) - (monthPayments.get(debt.source.id) ?? 0)) : 0); }, 0);
        const debtNeeded = Math.min(Math.max(installment.debtCents, urgentMinimum), Math.max(0, targets.debtCents - baseDebtPaid), debts.reduce((total, debt) => total + Math.round(debt.balance), 0));
        const baseDebtBudget = Math.min(available, debtNeeded);
        const extraBudget = Math.min(available - baseDebtBudget, splitCents(input.extraDebtCents, paydayCount, index));
        let debtBudget = baseDebtBudget + extraBudget;
        const debtPayments = new Map<string, number>();
        const payDebt = (debt: DebtState, requested: number): void => {
          const owed = Math.round(debt.balance);
          const amount = Math.min(debtBudget, requested, owed);
          if (amount <= 0) return;
          if (debt.components) for (const part of debt.components) part.balanceCents = amount === owed ? 0 : part.balanceCents * (debt.balance - amount) / debt.balance;
          if (amount === owed) {
            debt.interest += owed - debt.balance;
            debt.balance = 0;
            milestones.push({ type: 'debt_paid', date, debtId: debt.source.id, name: debt.source.name });
          } else debt.balance -= amount;
          debt.paid += amount;
          debtBudget -= amount;
          debtPayments.set(debt.source.id, (debtPayments.get(debt.source.id) ?? 0) + amount);
          monthPayments.set(debt.source.id, (monthPayments.get(debt.source.id) ?? 0) + amount);
        };
        const minimumPriority = [...priority].sort((a, b) => (requirements.get(a.source.id)!.dueDate ?? '9999').localeCompare(requirements.get(b.source.id)!.dueDate ?? '9999'));
        for (const debt of minimumPriority) {
          const requirement = requirements.get(debt.source.id)!;
          if (requirement.amount === null) continue;
          const timelyPaydays = requirement.dueDate ? dates.filter(payDate => payDate <= requirement.dueDate!).length : paydayCount;
          const due = requirement.dueDate && (timelyPaydays === 0 || date >= requirement.dueDate) ? requirement.amount : cumulativeSplit(requirement.amount, timelyPaydays || paydayCount, index);
          payDebt(debt, Math.max(0, due - (monthPayments.get(debt.source.id) ?? 0)));
        }
        for (const debt of priority) payDebt(debt, debtBudget);
        const debtCents = baseDebtBudget + extraBudget - debtBudget;
        baseDebtPaid += Math.min(baseDebtBudget, debtCents);
        available -= debtCents;
        const investCents = input.surplusDestination === 'investments' ? available : 0;
        const cashCents = input.surplusDestination === 'cash' ? available : 0;
        contributions += investCents;
        investments += investCents;
        cashContributions += cashCents;
        cash += cashCents;
        const shortfallCents = installment.spendingCents - spendingCents + momNeeded - momCents + debtNeeded - Math.min(debtNeeded, debtCents);
        payday = {
          date, dayIndex, number: paychecks.length + 1, month, payCents,
          spendingCents, momCents, debtCents, investCents, cashCents,
          extraDebtCents: Math.max(0, debtCents - baseDebtBudget), shortfallCents, targets: installment,
          debtPayments: [...debtPayments].map(([debtId, amountCents]) => ({ debtId, amountCents })),
        };
        paychecks.push(payday);
        monthPaychecks.push(payday);
      }
      for (const debt of debts) {
        const requirement = requirements.get(debt.source.id)!;
        if (!requirement.checked && requirement.dueDate && requirement.dueDate <= date) {
          requirement.checked = true;
          const paidOnTime = requirement.dueDate < isoDate(start) ? 0 : monthPayments.get(debt.source.id) ?? 0;
          requirement.shortfall = Math.max(0, (requirement.amount ?? 0) - paidOnTime);
          if (requirement.shortfall > 0) warnings.push(`${debt.source.name}: ${(requirement.shortfall / 100).toFixed(2)} of the payment due ${requirement.dueDate} is not funded by that date. Later payments do not remove this missed deadline.`);
        }
      }
      const point = snapshot(timestamp, dayIndex, payday);
      if (debtFreeDate === null && point.debtCents === 0 && debts.every((debt) => debt.balance === 0)) debtFreeDate = date;
      days.push(point);
    }
    const monthLast = days[days.length - 1];
    const sum = (field: 'payCents' | 'spendingCents' | 'momCents' | 'debtCents' | 'investCents' | 'cashCents' | 'shortfallCents'): number => monthPaychecks.reduce((total, paycheck) => total + paycheck[field], 0);
    const minimumShortfallCents = debts.reduce((total, debt, index) => {
      const requirement = requirements.get(debt.source.id)!;
      if (requirement.amount === null) return total;
      if (requirement.checked) return total + requirement.shortfall;
      const startingBalance = monthOpening.debts[index].balanceCents;
      const monthInterest = monthLast.debts[index].interestCents - monthOpening.debts[index].interestCents;
      const required = Math.min(requirement.amount, startingBalance + monthInterest);
      return total + Math.max(0, required - (monthPayments.get(debt.source.id) ?? 0));
    }, 0);
    const shortfallCents = Math.max(0, targets.spendingCents - sum('spendingCents'))
      + Math.max(0, Math.min(targets.momCents, monthOpening.momRemainingCents ?? targets.momCents) - sum('momCents'))
      + Math.max(0, Math.min(targets.debtCents, monthOpening.debtCents + monthLast.interestCents - monthOpening.interestCents) - sum('debtCents'));
    months.push({
      month, paydayCount, paycheckNumbers: monthPaychecks.map((paycheck) => paycheck.number), incomeCents: sum('payCents'),
      spendingCents: sum('spendingCents'), momCents: sum('momCents'), debtCents: sum('debtCents'), investCents: sum('investCents'), cashCents: sum('cashCents'),
      interestCents: monthLast.interestCents - monthOpening.interestCents,
      shortfallCents, minimumShortfallCents, unknownMinimumCount, targets, end: monthLast,
    });
  }
  const totalMinimumShortfallCents = months.reduce((total, month) => total + month.minimumShortfallCents, 0);
  if (totalMinimumShortfallCents > 0) warnings.push('Some known minimum payments are not covered. Increase the debt budget or reduce other allocations.');
  if (months.some((month) => month.paydayCount === 0)) warnings.push('At least one month has no scheduled paycheck. Its targets remain unfunded.');
  return {
    surplusDestination: input.surplusDestination,
    opening, days, paychecks, months, milestones, debtFreeDate, warnings,
    totalInterestCents: days[days.length - 1].interestCents,
    totalShortfallCents: months.reduce((total, month) => total + month.shortfallCents, 0), totalMinimumShortfallCents, monthsWithUnknownMinimums: months.filter(month => month.unknownMinimumCount > 0).length,
  };
}
