import type { Account, AppState } from './types.ts';
import type { PlannerDebt } from './planner.ts';
import { parseAssetMoney } from './asset-planning.ts';
import { requiredDebtPaymentCents } from './debt-status.ts';
import { debtInterestParts, debtRepaymentKind, effectiveDebtApr, paymentDeferral } from './debt-model.ts';
import { tdPlanningMinimumEstimate, tdRegularMinimumEstimate } from './td-minimum.ts';
import { addCents } from './analytics.ts';

export interface PlannerDebtDraft { balance: string; apr: string; minimum: string; included: boolean; minimumMode?: 'manual' | 'td_estimate' }
export interface PlannerDraft {
  pay: string; mom: string; debt: string; living: string;
  firstPayday: string; startMonth: string; months: string; frequency: string;
  investmentReturn: string; extraDebt: string; selectedDebtId: string;
  surplusDestination: 'cash' | 'investments';
  debts: Record<string, PlannerDebtDraft>;
}

const fields = ['pay', 'mom', 'debt', 'living', 'firstPayday', 'startMonth', 'months', 'frequency', 'investmentReturn', 'extraDebt', 'selectedDebtId'] as const;
const moneyText = (value: number | null | undefined) => value == null ? '' : String(value / 100);

export function plannerTdMinimumEstimate(account: Account, draft: PlannerDebtDraft) {
  if (!draft.apr.trim() || !/^\d*\.?\d+$/.test(draft.apr.trim())) return null;
  try {
    return tdRegularMinimumEstimate({ ...account, balanceCents: parseAssetMoney(draft.balance, 'Balance'), debtTerms: { ...account.debtTerms, aprPercent: Number(draft.apr), interestStatus: Number(draft.apr) === 0 ? 'interest_free' : 'accruing', minimumPaymentCents: null, rateConfirmed: false, notes: account.debtTerms?.notes ?? '' } });
  } catch { return null; }
}

export function plannerDebtProjection(accounts: Account[], values: Record<string, PlannerDebtDraft>): { debts: PlannerDebt[]; fixedDebtCents: number; fixedNames: string[]; creditBalanceCents: number } {
  const debts: PlannerDebt[] = [];
  let fixedDebtCents = 0;
  let creditBalanceCents = 0;
  const fixedNames: string[] = [];
  for (const account of accounts) {
    if (account.balanceCents <= 0) {
      creditBalanceCents = addCents(creditBalanceCents, -account.balanceCents);
      continue;
    }
    const draft = values[account.id];
    const balanceCents = parseAssetMoney(draft.balance, `${account.name} balance`);
    if (!balanceCents) continue;
    if (!draft.included) { fixedDebtCents = addCents(fixedDebtCents, balanceCents); fixedNames.push(account.name); continue; }
    const components = account.debtTerms?.components?.length ? debtInterestParts({ ...account, balanceCents }) : undefined;
    if (components === null) throw new Error(`Confirm both component balances and interest terms for ${account.name}. They must add up to the loan balance.`);
    if (!draft.apr.trim() && !components) throw new Error(`Enter the APR for ${account.name}. Use 0 only for interest-free debt.`);
    const kind = debtRepaymentKind(account);
    const terms = account.debtTerms;
    const estimatedMinimum = draft.minimumMode === 'td_estimate' ? plannerTdMinimumEstimate(account, draft) : null;
    if (draft.minimumMode === 'td_estimate' && !estimatedMinimum) throw new Error(`Enter a valid balance and APR for the ${account.name} minimum estimate.`);
    const hasDeferredMinimum = terms?.repaymentStatus === 'in_study' && !!terms.repaymentStartDate;
    if (!estimatedMinimum && !draft.minimum.trim() && kind !== 'interest_only' && !hasDeferredMinimum) throw new Error(`Enter the ${kind === 'one_off' ? 'lump-sum payment' : 'monthly minimum'} for ${account.name}. A blank amount is unknown, not zero.`);
    debts.push({ id: account.id, name: account.name, balanceCents, aprPercent: components ? effectiveDebtApr({ ...account, balanceCents })! : Number(draft.apr), minimumCents: estimatedMinimum?.amountCents ?? (draft.minimum.trim() ? parseAssetMoney(draft.minimum, 'Minimum payment') : null),
      ...(!estimatedMinimum && terms?.paymentDueDate ? { minimumDueDate: terms.paymentDueDate } : {}), repaymentKind: kind, ...(components ? { components } : {}),
      ...(terms?.repaymentStatus === 'in_study' ? { paymentsDeferred: true, repaymentStartDate: terms.repaymentStartDate ?? null, studyEndDate: terms.studyEndDate ?? null } : {}),
    });
  }
  return { debts, fixedDebtCents, fixedNames, creditBalanceCents };
}

export function plannerDefaults(state: AppState, ownerId: string, date: string): PlannerDraft {
  const accounts = state.accounts.filter(account => account.entityId === ownerId && ['debt', 'payable'].includes(account.type));
  const priorityAccounts = accounts.filter(account => paymentDeferral(account, date) !== 'deferred');
  const roadmap = state.entities.find(entity => entity.id === ownerId)?.kind === 'personal' ? state.roadmap : undefined;
  const purchase = state.assetPurchases?.find(item => item.entityId === ownerId && /mom/i.test(item.payee));
  const nextFullMonth = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
  if (date.slice(8) !== '01') nextFullMonth.setUTCMonth(nextFullMonth.getUTCMonth() + 1);
  return {
    pay: moneyText(roadmap?.payAmountCents), mom: moneyText(purchase?.monthlyCents ?? roadmap?.monthlyFamilyPaymentCents),
    debt: moneyText(roadmap?.monthlyDebtMinimumsCents), living: moneyText(roadmap?.monthlyEssentialsCents),
    firstPayday: roadmap?.paydayAnchor ?? '', startMonth: nextFullMonth.toISOString().slice(0, 7), months: '12',
    frequency: roadmap?.payEveryDays === 14 ? '26' : roadmap?.payEveryDays === 7 ? '52' : '',
    investmentReturn: '0', extraDebt: '0', surplusDestination: 'cash', selectedDebtId: priorityAccounts.find(account => account.id === roadmap?.loanAccountId && account.balanceCents > 0)?.id ?? priorityAccounts.find(account => account.balanceCents > 0)?.id ?? '',
    debts: Object.fromEntries(accounts.map(account => {
      if (account.balanceCents <= 0) return [account.id, { balance: '0', apr: '', minimum: '0', included: false }];
      const rate = effectiveDebtApr(account);
      const status = paymentDeferral(account, date);
      const terms = account.debtTerms;
      const expiredMinimum = status === 'repaying' && debtRepaymentKind(account) !== 'one_off' && terms?.paymentDueDate && terms.paymentDueDate < date;
      const estimatedMinimum = status === 'repaying' ? tdPlanningMinimumEstimate(account, date) : null;
      const minimum = estimatedMinimum ? moneyText(estimatedMinimum.amountCents) : expiredMinimum ? '' : terms?.repaymentStatus === 'in_study' && terms.repaymentStartDate ? moneyText(terms.minimumPaymentCents) : status === 'deferred' ? '0' : status === 'review' ? '' : moneyText(requiredDebtPaymentCents(account, date));
      return [account.id, { balance: moneyText(account.balanceCents), apr: rate == null ? '' : String(rate), minimum, included: status === 'repaying' && account.balanceCents > 0 && rate != null, ...(estimatedMinimum ? { minimumMode: 'td_estimate' } : tdRegularMinimumEstimate(account) ? { minimumMode: 'manual' } : {}) }];
    })),
  };
}

export function plannerSourceKey(state: AppState, ownerId: string, date: string): string {
  return JSON.stringify({
    accounts: state.accounts.filter(account => account.entityId === ownerId && ['debt', 'payable', 'investment', 'cash'].includes(account.type)),
    expiredMinimums: state.accounts.filter(account => account.entityId === ownerId && account.debtTerms?.paymentDueDate && account.debtTerms.paymentDueDate < date).map(account => account.id),
    deferralStatuses: state.accounts.filter(account => account.entityId === ownerId && ['debt', 'payable'].includes(account.type)).map(account => [account.id, paymentDeferral(account, date)]),
    roadmap: state.entities.find(entity => entity.id === ownerId)?.kind === 'personal' ? state.roadmap : undefined,
    purchases: state.assetPurchases?.filter(purchase => purchase.entityId === ownerId),
  });
}

export function restorePlannerDraft(serialized: string | null, defaults: PlannerDraft, sourceKey: string): PlannerDraft {
  try {
    const stored = JSON.parse(serialized ?? 'null');
    if (!stored || stored.version !== 4 || stored.sourceKey !== sourceKey || !stored.draft) return defaults;
    const value = stored.draft;
    const restored = { ...defaults, debts: { ...defaults.debts } };
    if (value.surplusDestination === 'cash' || value.surplusDestination === 'investments') restored.surplusDestination = value.surplusDestination;
    for (const field of fields) if (typeof value[field] === 'string' && value[field].length <= 100) restored[field] = value[field];
    for (const id of Object.keys(defaults.debts)) {
      const debt = value.debts?.[id];
      if (debt && typeof debt.included === 'boolean' && ['balance', 'apr', 'minimum'].every(field => typeof debt[field] === 'string' && debt[field].length <= 100)) {
        const useEstimate = defaults.debts[id].minimumMode !== undefined && (debt.minimumMode === 'td_estimate' || defaults.debts[id].minimumMode === 'td_estimate' && debt.minimumMode === undefined && !debt.minimum.trim());
        restored.debts[id] = { balance: debt.balance, apr: debt.apr, minimum: useEstimate ? defaults.debts[id].minimum : debt.minimum, included: debt.included, ...(useEstimate ? { minimumMode: 'td_estimate' } : debt.minimumMode === 'manual' ? { minimumMode: 'manual' } : {}) };
      }
    }
    return restored;
  } catch { return defaults; }
}
