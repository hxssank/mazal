import type { AccountType } from '../../shared/types.ts';

export type FormKind = 'transaction' | 'account' | 'obligation' | 'reserve' | 'sol' | 'reward' | 'reconcile' | 'import' | 'backup';
export interface FormSelection {
  kind: FormKind;
  accountId?: string;
  positionId?: string;
  initialAccountType?: AccountType;
  initialTransactionKind?: 'expense' | 'income' | 'transfer' | 'debt_payment';
  initialToAccountId?: string;
}
