import { categoryLimits, categoryMatcher, isUncategorized, normalizedCategory, suggestExpenseCategory } from './expense-categories.ts';
import { addCents } from './analytics.ts';
import { reviewMerchant } from './merchant-names.ts';
import type { AppState, Transaction } from './types.ts';
export { reviewMerchant } from './merchant-names.ts';

const reviewName = (row: Transaction): string => row.displayName?.trim() || reviewMerchant(row.description);

export interface CategoryChange { id: string; expectedCategory: string; category: string; expectedExpenseCategory?: string | null; expenseCategory?: string | null }
export interface CategoryReviewGroup { key: string; merchant: string; variants: string[]; ownerId: string; rows: Transaction[]; amountCents: number; suggestion: { category: string; reason: string } | null }

export function activeExpenseTransactions(transactions: Transaction[], rows = transactions): Transaction[] {
  const canceled = new Set(transactions.flatMap(row => [row.reversalOf, row.replacesId].filter((id): id is string => !!id)));
  return rows.filter(row => row.kind === 'expense' && !row.reversalOf && !canceled.has(row.id));
}

export function matchesCategoryChange(transaction: Transaction | undefined, change: Pick<CategoryChange, 'category' | 'expenseCategory'>): boolean {
  return transaction?.category === change.category && (change.expenseCategory === undefined || (transaction.expenseCategory ?? null) === change.expenseCategory);
}

export function categoryReviewGroups(state: AppState, rows: Transaction[]): CategoryReviewGroup[] {
  const owners = new Map(state.accounts.map(account => [account.id, account.entityId]));
  const groups = new Map<string, CategoryReviewGroup>();
  for (const row of activeExpenseTransactions(state.transactions, rows)) {
    if (!isUncategorized(row.category)) continue;
    const ownerId = owners.get(row.accountId) ?? row.accountId;
    const merchant = reviewName(row);
    const key = JSON.stringify([ownerId, normalizedCategory(merchant)]);
    const group = groups.get(key) ?? { key, merchant, variants: [], ownerId, rows: [], amountCents: 0, suggestion: null };
    group.rows.push(row);
    group.amountCents = addCents(group.amountCents, row.amountCents);
    groups.set(key, group);
  }
  const history = new Map<string, Set<string>>();
  const canonicalByOwner = new Map<string, (category: string) => string>();
  const canonical = (ownerId: string, category: string) => {
    let match = canonicalByOwner.get(ownerId);
    if (!match) {
      const limits = categoryLimits(state, ownerId);
      const allowed = new Set(limits.flatMap(limit => [limit.name, ...limit.aliases]).map(normalizedCategory));
      const matchCategory = categoryMatcher(limits, new Set((state.spendingLimits ?? []).map(limit => limit.id)));
      match = value => allowed.has(normalizedCategory(value)) ? matchCategory(value).name : value;
      canonicalByOwner.set(ownerId, match);
    }
    return match(category);
  };
  for (const row of activeExpenseTransactions(state.transactions)) {
    const category = row.category;
    if (isUncategorized(category)) continue;
    const ownerId = owners.get(row.accountId) ?? row.accountId;
    const key = JSON.stringify([ownerId, normalizedCategory(reviewName(row))]);
    if (!groups.has(key)) continue;
    const categories = history.get(key) ?? new Set<string>();
    categories.add(canonical(ownerId, row.expenseCategory ?? category));
    history.set(key, categories);
  }
  for (const group of groups.values()) {
    group.rows.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    group.merchant = reviewName(group.rows[0]);
    group.variants = [...new Set(group.rows.map(row => row.description))].sort((a, b) => a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0));
    const categories = [...(history.get(group.key) ?? [])];
    const suggestions = new Map<string, { category: string; reason: string }>();
    if (!categories.length) for (const description of new Set(group.rows.map(row => row.displayName?.trim() || row.description))) {
      const suggestion = suggestExpenseCategory(description);
      if (suggestion) {
        const category = canonical(group.ownerId, suggestion.category);
        suggestions.set(category, { ...suggestion, category });
      }
    }
    group.suggestion = categories.length === 1 ? { category: categories[0], reason: 'Used on your other entries from this merchant. Check that these purchases belong together.' } : !categories.length && suggestions.size === 1 ? [...suggestions.values()][0] : null;
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || b.rows[0].date.localeCompare(a.rows[0].date) || a.merchant.localeCompare(b.merchant) || a.key.localeCompare(b.key));
}

export function selectedCategoryChanges(rows: Transaction[], selections: Record<string, CategoryChange>, transactions = rows): CategoryChange[] {
  return activeExpenseTransactions(transactions, rows).flatMap(row => {
    const selected = selections[row.id];
    return row.kind === 'expense' && isUncategorized(row.category) && selected && selected.category.trim() && selected.category !== row.category ? [{ ...selected, expectedExpenseCategory: selected.expectedExpenseCategory === undefined ? row.expenseCategory ?? null : selected.expectedExpenseCategory, expenseCategory: selected.category }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function reverseCategoryChanges(changes: CategoryChange[]): CategoryChange[] {
  return changes.map(change => ({ id: change.id, expectedCategory: change.category, category: change.expectedCategory || 'Uncategorized', ...(change.expenseCategory === undefined ? {} : { expectedExpenseCategory: change.expenseCategory }), expenseCategory: change.expectedExpenseCategory ?? null }));
}

export function categoryReviewOptions(state:AppState,ownerId:string,_suggestedCategory?:string):string[] {
  const limits=categoryLimits(state,ownerId);
  return [...new Map(limits.map(limit=>[normalizedCategory(limit.name),limit.name])).values()].sort((a,b)=>a.localeCompare(b));
}
