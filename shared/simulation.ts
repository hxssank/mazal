export interface SimulationInput {
  cashCents: number;
  investmentsCents: number;
  selectedDebtCents: number;
  otherDebtCents: number;
  otherAssetsCents: number;
  monthlyBudgetCents: number | null;
  monthlyDebtCents: number;
  monthlyInvestmentsCents: number;
  monthlyBusinessCents: number;
  debtAprPercent: number | null;
  investmentAnnualReturnPercent: number;
  businessMonthlyNetCents: number;
  months: number;
  periodsPerYear?: 12 | 26 | 52;
}

export interface SimulationPoint {
  month: number;
  cashCents: number;
  investmentsCents: number;
  debtCents: number;
  selectedDebtCents: number;
  businessCents: number;
  netWorthCents: number;
  interestCents: number;
  investmentChangeCents: number;
  debtPaymentCents: number;
  redirectedDebtCents: number;
}

export interface SimulationResult {
  status: 'ready' | 'needs_inputs' | 'over_budget';
  missing: ('budget' | 'apr')[];
  monthlyCashCents: number | null;
  overBudgetCents: number;
  totalInterestCents: number | null;
  firstCashGapMonth: number | null;
  points: SimulationPoint[];
}

function cents(value: number, label: string, signed = false): number {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) throw new Error(`${label} must be ${signed ? '' : 'nonnegative '}whole cents within the supported range.`);
  return value;
}

export function simulateMoney(input: SimulationInput): SimulationResult {
  const periodsPerYear = input.periodsPerYear === undefined ? 12 : input.periodsPerYear;
  if (![12, 26, 52].includes(periodsPerYear)) throw new Error('Choose 12 monthly, 26 biweekly, or 52 weekly periods per year.');
  const maximumPeriods = periodsPerYear * 5;
  const periodLabel = periodsPerYear === 12 ? 'months' : periodsPerYear === 26 ? 'biweekly periods' : 'weeks';
  let cash = cents(input.cashCents, 'Cash', true);
  let investments = cents(input.investmentsCents, 'Investments');
  let debt = cents(input.selectedDebtCents, 'Selected debt');
  const otherDebt = cents(input.otherDebtCents, 'Other debt');
  const otherAssets = cents(input.otherAssetsCents, 'Other assets', true);
  const debtAllocation = cents(input.monthlyDebtCents, 'Debt allocation');
  const investmentAllocation = cents(input.monthlyInvestmentsCents, 'Investment allocation');
  const businessAllocation = cents(input.monthlyBusinessCents, 'Business allocation');
  const businessNet = cents(input.businessMonthlyNetCents, periodsPerYear === 12 ? 'Business monthly net income' : 'Business net income per period', true);
  if (!Number.isInteger(input.months) || input.months < 1 || input.months > maximumPeriods) throw new Error(`Choose a projection from 1 to ${maximumPeriods} whole ${periodLabel}.`);
  if (!Number.isFinite(input.investmentAnnualReturnPercent) || input.investmentAnnualReturnPercent < -100 || input.investmentAnnualReturnPercent > 1000) throw new Error('Annual investment return must be between -100% and 1,000%.');
  if (input.debtAprPercent !== null && (!Number.isFinite(input.debtAprPercent) || input.debtAprPercent < 0 || input.debtAprPercent > 1000)) throw new Error('Debt APR must be between 0% and 1,000%, or unknown.');
  const totalAllocation = cents(debtAllocation + investmentAllocation + businessAllocation, 'Combined allocations');
  if (input.monthlyBudgetCents !== null) cents(input.monthlyBudgetCents, periodsPerYear === 12 ? 'Monthly budget' : 'Budget per period');
  const missing: SimulationResult['missing'] = [];
  if (input.monthlyBudgetCents === null) missing.push('budget');
  if (debt > 0 && input.debtAprPercent === null) missing.push('apr');
  const result: SimulationResult = { status: 'ready', missing, monthlyCashCents: input.monthlyBudgetCents === null ? null : input.monthlyBudgetCents - totalAllocation, overBudgetCents: input.monthlyBudgetCents === null ? 0 : Math.max(0, totalAllocation - input.monthlyBudgetCents), totalInterestCents: null, firstCashGapMonth: null, points: [] };
  if (result.overBudgetCents > 0) return { ...result, status: 'over_budget' };
  if (missing.length) return { ...result, status: 'needs_inputs' };
  const budget = input.monthlyBudgetCents!;
  const periodReturn = Math.pow(1 + input.investmentAnnualReturnPercent / 100, 1 / periodsPerYear) - 1;
  let business = 0;
  let totalInterest = 0;
  const point = (month: number, interestCents: number, investmentChangeCents: number, debtPaymentCents: number, redirectedDebtCents: number): SimulationPoint => ({
    month, cashCents: cash, investmentsCents: investments, debtCents: cents(debt + otherDebt, 'Total debt'), selectedDebtCents: debt,
    businessCents: business, netWorthCents: cents(cash + investments + business + otherAssets - debt - otherDebt, 'Net worth', true),
    interestCents, investmentChangeCents, debtPaymentCents, redirectedDebtCents,
  });
  result.points.push(point(0, 0, 0, 0, 0));
  if (cash < 0) result.firstCashGapMonth = 0;
  for (let month = 1; month <= input.months; month += 1) {
    const interest = cents(Math.round(debt * ((input.debtAprPercent ?? 0) / (100 * periodsPerYear))), periodsPerYear === 12 ? 'Monthly interest' : 'Interest per period');
    const amountOwed = cents(debt + interest, 'Debt plus interest');
    const payment = Math.min(debtAllocation, amountOwed);
    debt = amountOwed - payment;
    const redirected = debtAllocation - payment;
    const investmentChange = cents(Math.round(investments * periodReturn), 'Investment change', true);
    investments = cents(investments + investmentChange + investmentAllocation, 'Projected investments');
    cash = cents(cash + budget - payment - investmentAllocation - businessAllocation, 'Projected cash', true);
    business = cents(business + businessAllocation + businessNet, 'Projected business capital', true);
    if (business < 0) { cash = cents(cash + business, 'Cash after business loss', true); business = 0; }
    if (cash < 0 && result.firstCashGapMonth === null) result.firstCashGapMonth = month;
    totalInterest = cents(totalInterest + interest, 'Total interest');
    result.points.push(point(month, interest, investmentChange, payment, redirected));
  }
  return { ...result, totalInterestCents: totalInterest };
}
