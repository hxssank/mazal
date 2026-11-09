import type { Account, AppState } from './types.ts';
import { addCents, type Summary } from './analytics.ts';

export interface NetWorthDisplay {
  assetsCents: number;
  liabilitiesCents: number;
  netWorthCents: number;
  investmentsCents: number;
  trackedAssetsCents: number;
  excludedAccounts: Account[];
}

export function displayNetWorth(state: AppState, summary: Summary, scope = 'all'): NetWorthDisplay {
  const owners = new Map(state.entities.map(entity => [entity.id, entity.ownershipBps]));
  const excludedAccounts = state.accounts.filter(account => account.excludeFromNetWorth && (scope === 'all' || account.entityId === scope));
  const result: NetWorthDisplay = {
    assetsCents: summary.assetsCents,
    liabilitiesCents: summary.liabilitiesCents,
    netWorthCents: summary.netWorthCents,
    investmentsCents: summary.investmentsCents,
    trackedAssetsCents: addCents(addCents(summary.receivablesCents, summary.physicalAssetsCents), summary.purchaseEquityCents),
    excludedAccounts,
  };
  for (const account of excludedAccounts) {
    const balance = scope === 'all'
      ? Number((BigInt(Math.abs(account.balanceCents)) * BigInt(owners.get(account.entityId) ?? 0) + 5000n) / 10000n) * Math.sign(account.balanceCents)
      : account.balanceCents;
    if (account.type === 'debt' || account.type === 'payable') result.liabilitiesCents = addCents(result.liabilitiesCents, -balance);
    else result.assetsCents = addCents(result.assetsCents, -balance);
    if (account.type === 'investment') result.investmentsCents = addCents(result.investmentsCents, -balance);
    if (account.type === 'receivable') result.trackedAssetsCents = addCents(result.trackedAssetsCents, -balance);
  }
  result.netWorthCents = addCents(result.assetsCents, -result.liabilitiesCents);
  return result;
}
