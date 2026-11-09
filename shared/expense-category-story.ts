import { addCents } from './analytics.ts';
import { categoryLimits, categoryTemplateFor, normalizedCategory, transactionCategoryMatcher } from './expense-categories.ts';
import type { SpendingMonth } from './spending-calendar.ts';
import type { AppState, Transaction } from './types.ts';

interface ExpenseStoryTotals {
  totalCents: number;
  chargedCents: number;
  refundCents: number;
  correctionCents: number;
  entryCount: number;
  chargeCount: number;
  refundCount: number;
  correctionCount: number;
}

export interface ExpenseCategoryMerchant extends ExpenseStoryTotals {
  key: string;
  name: string;
}

export interface ExpenseCategoryStory extends ExpenseStoryTotals {
  categoryKey: string | null;
  categoryLabel: string | null;
  merchantCount: number;
  merchants: ExpenseCategoryMerchant[];
}

const emptyTotals = (): ExpenseStoryTotals => ({ totalCents: 0, chargedCents: 0, refundCents: 0, correctionCents: 0, entryCount: 0, chargeCount: 0, refundCount: 0, correctionCount: 0 });
const descriptionName = (transaction: Transaction) => transaction.description.trim().replace(/\s+/g, ' ') || 'No description';

export function buildExpenseCategoryStory(state: AppState, ownerId: string, data: SpendingMonth, selectedCategoryKey?: string | null): ExpenseCategoryStory {
  const result: ExpenseCategoryStory = { ...emptyTotals(), categoryKey: selectedCategoryKey ?? null, categoryLabel: null, merchantCount: 0, merchants: [] };
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const entries = data.days.flatMap(day => day.entries).filter(entry => {
    const account = accounts.get(entry.transaction.accountId);
    return !!account && entry.transaction.kind === 'expense' && (ownerId === 'all' || account.entityId === ownerId);
  });
  const transactions = new Map(state.transactions.map(transaction => [transaction.id, transaction]));
  for (const entry of entries) transactions.set(entry.transaction.id, entry.transaction);
  const sameOwnerOriginal = (transaction: Transaction, id: string) => {
    const original = transactions.get(id);
    return original?.kind === 'expense' && accounts.get(original.accountId)?.entityId === accounts.get(transaction.accountId)?.entityId ? original : undefined;
  };
  const reversedIds = new Set(entries.flatMap(({ transaction }) => transaction.reversalOf && sameOwnerOriginal(transaction, transaction.reversalOf) ? [transaction.reversalOf] : []));
  const merchantNames = new Map<string, string>();
  function merchantName(transaction: Transaction, visited = new Set<string>()): string {
    const cached = merchantNames.get(transaction.id);
    if (cached) return cached;
    if (visited.has(transaction.id)) return descriptionName(transaction);
    visited.add(transaction.id);
    const originalId = transaction.refundOf ?? transaction.reversalOf;
    const original = originalId ? sameOwnerOriginal(transaction, originalId) : undefined;
    const name = original ? merchantName(original, visited) : descriptionName(transaction);
    merchantNames.set(transaction.id, name);
    return name;
  }
  const savedIds = new Set((state.spendingLimits ?? []).map(limit => limit.id));
  const matchers = new Map<string, ReturnType<typeof transactionCategoryMatcher>>();
  const merchants = new Map<string, ExpenseCategoryMerchant>();
  for (const entry of entries) {
    const transaction = entry.transaction;
    const entityId = accounts.get(transaction.accountId)!.entityId;
    let match = matchers.get(entityId);
    if (!match) {
      match = transactionCategoryMatcher(state, entityId, categoryLimits(state, entityId));
      matchers.set(entityId, match);
    }
    const limit = match(transaction);
    const template = categoryTemplateFor(limit);
    const savedName = savedIds.has(limit.id) && template && ![template.name, template.label].some(name => normalizedCategory(name) === normalizedCategory(limit.name));
    const label = savedName ? limit.name : template?.label ?? limit.name;
    const categoryKey = template?.key ?? `custom:${normalizedCategory(label)}`;
    if (selectedCategoryKey && categoryKey !== selectedCategoryKey) continue;
    if (selectedCategoryKey && result.categoryLabel === null) result.categoryLabel = label;
    const name = merchantName(transaction);
    const key = normalizedCategory(name);
    const merchant = merchants.get(key) ?? { ...emptyTotals(), key, name };
    const correction = !!transaction.reversalOf || reversedIds.has(transaction.id);
    for (const totals of [result, merchant]) {
      totals.totalCents = addCents(totals.totalCents, entry.amountCents);
      totals.entryCount++;
      if (correction) {
        totals.correctionCents = addCents(totals.correctionCents, entry.amountCents);
        totals.correctionCount++;
      } else if (entry.amountCents > 0) {
        totals.chargedCents = addCents(totals.chargedCents, entry.amountCents);
        totals.chargeCount++;
      } else if (entry.amountCents < 0) {
        totals.refundCents = addCents(totals.refundCents, entry.amountCents);
        totals.refundCount++;
      }
    }
    merchants.set(key, merchant);
  }
  result.merchants = [...merchants.values()].sort((a, b) => Math.abs(b.totalCents) - Math.abs(a.totalCents) || b.chargedCents - a.chargedCents || a.name.localeCompare(b.name));
  result.merchantCount = result.merchants.length;
  return result;
}
