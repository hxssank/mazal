import type { AssetPurchase } from './types.ts';

export const purchaseAccountId = (purchaseId: string): string => `asset-purchase:${purchaseId}`;
export const purchaseRemaining = (purchase: AssetPurchase): number | null => purchase.paidCents === null ? null : Math.max(0, purchase.targetCents - purchase.paidCents);
