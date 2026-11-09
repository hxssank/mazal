import type { DailyPlan, DailyPlanEvent } from './engine.ts';

export function incomeBeforePayday(plan: DailyPlan): DailyPlanEvent | undefined {
  return plan.events.filter(event => event.direction === 'in' && event.includedInCashflow && event.amountCents !== null
    && event.date > plan.asOf && (!plan.nextPayday || event.date < plan.nextPayday.date))
    .sort((left, right) => left.date.localeCompare(right.date) || left.name.localeCompare(right.name))[0];
}
