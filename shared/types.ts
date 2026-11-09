import type { CategoryRule } from './category-rules.ts';
import type { PayrollImport } from './payroll.ts';
import type { StatementMapping } from './statement-mapping.ts';
export type { CategoryRule } from './category-rules.ts';
export type { PayrollImport } from './payroll.ts';
export type Workspace = 'demo' | 'live';
export type AccountType = 'cash' | 'investment' | 'debt' | 'receivable' | 'payable';
export interface Entity { id: string; name: string; kind: 'personal' | 'business'; ownershipBps: number }
export type DebtRepaymentKind = 'fixed' | 'revolving' | 'interest_only' | 'one_off';
export type DebtInterestStatus = 'accruing' | 'interest_free' | 'unknown';
export interface DebtComponent { id:'federal'|'ontario'; balanceCents:number|null; aprPercent:number|null; rateConfirmed:boolean; interestStatus:DebtInterestStatus }
export interface DebtTerms { aprPercent:number|null; rateConfirmed:boolean; minimumPaymentCents:number|null; notes:string; paymentDueDate?:string|null; statementDate?:string|null; repaymentStatus?:'repaying'|'in_study'; repaymentStatusSource?:'owner'|'lender'; repaymentStatusAsOf?:string|null; schoolReturnMonth?:string|null; repaymentKind?:DebtRepaymentKind; interestStatus?:DebtInterestStatus; studyEndDate?:string|null; repaymentStartDate?:string|null; components?:DebtComponent[] }
export interface BalanceEvidence { balanceCents?:number; sourceFile:string; asOf:string|null; capturedOn:string; status:'bank'|'credit_report'; notes:string; creditLimitCents?:number; availableCreditCents?:number; payoffCents?:number }
export interface Reconciliation { date:string; balanceCents:number; transactionIds:string[] }
export interface Account { id: string; entityId: string; name: string; type: AccountType; currency: 'CAD'; balanceCents: number; reconciledAt: string | null; debtTerms?:DebtTerms; evidence?:BalanceEvidence; clearedTransactionIds?:string[]; reconciliation?:Reconciliation; closedAt?:string|null; excludeFromNetWorth?:boolean }
export type TransactionKind = 'income' | 'expense' | 'transfer' | 'debt_payment' | 'opening' | 'adjustment';
export interface Transaction { id: string; date: string; description: string; displayName?:string; note?:string; kind: TransactionKind; amountCents: number; accountId: string; toAccountId: string | null; category: string; source: string; createdAt: string; expenseCategory?:string; plannedPayment?:{obligationId:string;dueDate:string}; statementId?:string; statementRowId?:string; postingDate?:string; importSources?:StatementSourceRef[]; balanceChanges?:Record<string,number>; postingDates?:Record<string,string>; balanceDates?:Record<string,string>; reversalOf?:string; replacesId?:string; refundOf?:string; correctionReason?:string; paydayDate?:string }
export interface StatementRow { id:string; transactionDate:string; postingDate:string; description:string; amountCents:number; kind:'purchase'|'interest'|'payment'|'refund'; category:string; sourcePage:number }
export interface StatementImport { id:string; accountId:string; sourceFile:string; sha256:string; periodStart:string; periodEnd:string; openingBalanceCents:number; closingBalanceCents:number; rows:StatementRow[] }
export interface StatementSourceRow { id:string; transactionDate:string; postingDate:string; description:string; amountCents:number; sourcePage:number; dateBasis?:'posting_only'|'transaction_only' }
export interface StatementSource { id:string; accountId:string; sourceFile:string; sha256:string; periodStart:string; periodEnd:string; openingBalanceCents:number; closingBalanceCents:number; rows:StatementSourceRow[]; sourceKind?:'bank_activity'; observedOn?:string; csvMapping?:StatementMapping }
export interface StatementSourceRef { importId:string; rowId:string }
export type StatementMatch = StatementSourceRef | { transactionId:string };
export interface StatementDecision { rowId:string; kind:'expense'|'income'|'refund'|'interest'|'transfer'|'movement'; category:string; match?:StatementMatch }
export interface StatementExtractionRevision { source:StatementSource; decisions:StatementDecision[]; revisedAt:string; reason:string }
export interface StatementBatch { id:string; source:StatementSource; decisions:StatementDecision[]; status:'staged'|'committed'; createdAt:string; committedAt:string|null; extractionHistory?:StatementExtractionRevision[] }
export interface SourceFact { id:string; label:string; value:string; asOf:string|null; sourceFile:string; note:string }
export interface Obligation { id: string; entityId: string; name: string; amountCents: number; dueDate: string; direction: 'in' | 'out'; recurrence: 'once' | 'monthly' | 'biweekly'; status: 'planned' | 'paid' | 'cancelled'; accountId: string; category: string; recurrenceDay?:number; subscription?:boolean; additionalToPay?:boolean; assetPurchaseId?:string }
export interface Reserve { id: string; entityId: string; name: string; amountCents: number }
export interface ExpenseFund { id:string; entityId:string; name:string; targetCents:number; savedCents:number; targetDate:string }
export interface ExpensePlanItem { id:string; entityId:string; categoryId:string; name:string; amountCents:number|null; date:string; notes:string; obligationId?:string; transactionId?:string; separatePaymentConfirmed?:boolean }
export interface AssetPurchase { id:string; entityId:string; name:string; payee:string; targetCents:number; monthlyCents:number; paidCents:number|null; paidAsOf:string; notes:string }
export interface AuditEvent { id: string; date: string; action: string; description: string }
export interface SolSnapshot { liquidSol:string; stakedSol:string; rewardsSol:string; costBasisCents:number; priceCents:number; priceDate:string }
export type SolActivityKind = 'buy' | 'sell' | 'reward' | 'fee';
export interface SolHistoryEntry extends SolSnapshot { id:string; date:string; kind:SolActivityKind|'snapshot'|'correction'|'price'; quantitySol:string; amountCents:number; feeCents:number; priceSource:string; cashAccountId?:string; transactionIds:string[] }
export interface SolPosition extends SolSnapshot { id: string; accountId: string; priceSource?:string; history?:SolHistoryEntry[] }
export interface TemporaryWorkSchedule { weeklyHours:number; fullTimeWeeklyHours:number; returnDate:string; payPeriodEndLagDays:number }
export interface RoadmapSettings { temporaryWorkSchedule?:TemporaryWorkSchedule; growthTarget?:'lifetime_compounding'|null; planningCashReserveCents?:number|null; incomeTransitionPlanned?:boolean; currentMonthlyIncomeCents:number|null; partTimeMonthlyIncomeCents:number|null; monthlyEssentialsCents:number|null; monthlyDebtMinimumsCents:number|null; transitionDate:string; transitionMonths:number; monthlyExtraDebtCents:number; loanAccountId:string; loanAprPercent:number|null; loanMonthlyPaymentCents:number|null; payAmountCents?:number; payEveryDays?:number; paydayAnchor?:string; monthlyFamilyPaymentCents?:number; familyPaymentNote?:string }
export interface SpendingLimit { id:string; entityId:string; name:string; color:string; aliases:string[]; dailyCents:number|null; weeklyCents:number|null; monthlyCents:number|null; monthlyAmounts?:Record<string,number|null> }
export interface TrackedAsset { id:string; entityId:string; name:string; category:string; purchaseDate:string|null; costCents:number|null; estimatedValueCents:number|null; status:'owned'|'listed'|'sold'; soldDate:string|null; saleCents:number|null; feesCents:number; notes:string; salePosting?:{cashAccountId:string;transactionId:string} }
export interface WishItem { id:string; entityId:string; name:string; costCents:number|null; comment:string; priority?:'essential'|'optional' }
export interface OwedPayment { id:string; amountCents:number; date:string; comment:string; cashAccountId?:string; transactionId?:string }
export interface MoneyOwed { id:string; entityId:string; name:string; amountCents:number; comment:string; payments:OwedPayment[] }
export interface AppState { workspace: Workspace; revision: number; entities: Entity[]; accounts: Account[]; transactions: Transaction[]; obligations: Obligation[]; reserves: Reserve[]; positions: SolPosition[]; audit: AuditEvent[]; lastBackupAt: string | null; roadmap?:RoadmapSettings; spendingLimits?:SpendingLimit[]; assets?:TrackedAsset[]; expenseFunds?:ExpenseFund[]; expensePlanItems?:ExpensePlanItem[]; assetPurchases?:AssetPurchase[]; wishItems?:WishItem[]; moneyOwed?:MoneyOwed[]; statements?:StatementImport[]; importBatches?:StatementBatch[]; sourceFacts?:SourceFact[]; categoryRules?:CategoryRule[]; payrollImports?:PayrollImport[] }
export interface ImportRow { date: string; description: string; amountCents: number; category?: string }
export type Command = ({ expectedRevision?:number }) & (
  | { type:'import_payroll'; import:PayrollImport; requestId:string }
  | { type:'link_payroll_deposit'; importId:string; paystubId:string; transactionId:string; note:string; requestId:string }
  | { type:'unlink_payroll_deposit'; importId:string; paystubId:string; note:string; requestId:string }
  | { type:'review_payroll_issue'; importId:string; issueId:string; status:'resolved'|'open'; note:string; requestId:string }
  | { type:'save_category_rule'; rule:CategoryRule; expected:CategoryRule|null; requestId:string }
  | { type:'delete_category_rule'; id:string; expected:CategoryRule; requestId:string }
  | { type:'save_reconciliation'; accountId:string; date:string; balanceCents:number; clearedTransactionIds:string[]; finish:boolean; requestId:string }
  | { type:'reopen_reconciliation'; accountId:string; requestId:string }
  | { type:'categorize_transaction'; id:string; expectedCategory:string; category:string; expectedExpenseCategory?:string|null; expenseCategory?:string|null; requestId:string }
  | { type:'annotate_transaction'; id:string; expectedDisplayName:string|null; expectedNote:string|null; displayName:string|null; note:string|null; requestId:string }
  | { type:'categorize_transactions'; changes:{id:string; expectedCategory:string; category:string; expectedExpenseCategory?:string|null; expenseCategory?:string|null}[]; requestId:string }
  | { type:'stage_statement'; statement:StatementSource; requestId:string }
  | { type:'revise_statement'; importId:string; statement:StatementSource; reason:string; requestId:string }
  | { type:'review_statement'; importId:string; decisions:StatementDecision[]; requestId:string }
  | { type:'commit_statements'; importIds:string[]; requestId:string }
  | { type:'import_statement'; statement:StatementImport; requestId:string }
  | { type: 'add_entity'; name: string; ownershipBps: number }
  | { type: 'add_account'; entityId: string; name: string; accountType: AccountType; openingBalanceCents: number; openingDate: string; requestId?: string }
  | { type:'rename_account'; accountId:string; name:string; expectedName:string; requestId:string }
  | { type: 'add_transaction'; kind: 'income' | 'expense' | 'transfer' | 'debt_payment'; accountId: string; toAccountId?: string; amountCents: number; date: string; description: string; category: string; paydayDate?:string; requestId: string }
  | { type:'correct_transaction'; id:string; reason:string; replacement?:{kind:'income'|'expense'|'transfer'|'debt_payment';accountId:string;toAccountId?:string;amountCents:number;date:string;description:string;category:string}; requestId:string }
  | { type:'correct_bank_matched_amount'; transactionId:string; source:StatementSource; rowId:string; expectedSourceSha256:string; expectedTransaction:Transaction; expectedObligation:Obligation; expectedPurchase:AssetPurchase|null; description:string; reason:string; requestId:string }
  | { type:'extend_bank_activity'; sourceId:string; expectedSource:StatementSource; replacementSource:StatementSource; decisions:StatementDecision[]; dateCorrectionRowIds?:string[]; reason:string; requestId:string }
  | { type:'record_refund'; id:string; accountId:string; amountCents:number; date:string; reason:string; requestId:string }
  | { type:'confirm_payday'; transactionId:string; paydayDate:string; requestId:string }
  | { type:'set_account_closed'; accountId:string; closed:boolean; requestId:string }
  | { type:'set_net_worth_inclusion'; accountId:string; included:boolean; requestId:string }
  | { type:'update_reserve'; id:string; expected:Reserve; name:string; amountCents:number; requestId:string }
  | { type: 'add_obligation'; entityId: string; name: string; amountCents: number; dueDate: string; direction: 'in' | 'out'; recurrence: Obligation['recurrence']; accountId: string; category: string; subscription?:boolean; additionalToPay?:boolean; assetPurchaseId?:string; requestId?:string }
  | { type: 'update_obligation'; id:string; expectedDueDate:string; expectedStatus:'planned'|'cancelled'; name:string; amountCents:number; dueDate:string; recurrence:Obligation['recurrence']; accountId:string; category:string; subscription?:boolean; additionalToPay?:boolean; assetPurchaseId?:string; status?:'planned'|'cancelled'; requestId:string }
  | { type: 'set_obligation_status'; id:string; status:'planned'|'cancelled'; dueDate?:string; requestId:string }
  | { type: 'pay_obligation'; id: string; expectedDueDate: string; amountCents?:number; date?:string; accountId?:string; transactionId?:string; requestId: string }
  | { type: 'add_reserve'; entityId: string; name: string; amountCents: number; requestId?: string }
  | { type: 'remove_reserve'; id: string }
  | { type:'save_expense_plan_item'; item:ExpensePlanItem; expected:ExpensePlanItem|null; requestId:string }
  | { type:'delete_expense_plan_item'; id:string; expected:ExpensePlanItem; requestId:string }
  | { type:'save_asset_purchase'; purchase:AssetPurchase; expected:AssetPurchase|null; requestId:string }
  | { type:'record_asset_purchase_payment'; contributionKind?:'payment'|'repair'; id:string; expected:AssetPurchase; accountId:string; amountCents:number; date:string; notes:string; requestId:string }
  | { type:'save_expense_fund'; fund:ExpenseFund; expected:ExpenseFund|null; requestId:string }
  | { type:'delete_expense_fund'; id:string; expected:ExpenseFund; requestId:string }
  | { type: 'reconcile'; accountId: string; balanceCents: number; date: string; note: string; requestId: string }
  | { type: 'import_rows'; accountId: string; rows: ImportRow[]; requestId: string }
  | { type: 'save_sol'; accountId: string; liquidSol: string; stakedSol: string; costBasisCents: number; priceCents: number; priceDate: string; priceSource?:string; requestId: string }
  | { type: 'add_sol_reward'; positionId: string; sol: string; date: string; requestId: string }
  | { type:'record_sol_activity'; positionId:string; kind:SolActivityKind; quantitySol:string; priceCents:number; feeCents:number; priceSource:string; date:string; cashAccountId?:string; afterBalanceConfirmation?:boolean; requestId:string }
  | { type: 'save_roadmap'; settings: RoadmapSettings }
  | { type:'update_pay_schedule'; payAmountCents:number; payEveryDays:number; paydayAnchor:string; resolveIncomeTransition?:boolean }
  | { type:'update_living_costs'; monthlyEssentialsCents:number|null }
  | { type:'update_planning_reserve'; amountCents:number|null }
  | { type:'update_growth_target'; target:'lifetime_compounding'|null; requestId:string }
  | { type: 'set_debt_terms'; accountId:string; terms:DebtTerms }
  | { type: 'save_spending_limit'; limit:SpendingLimit; budgetMonth?:string }
  | { type: 'save_asset'; asset:TrackedAsset }
  | { type:'record_asset_sale'; asset:TrackedAsset; expected:TrackedAsset|null; cashAccountId:string; afterBalanceConfirmation?:boolean; requestId:string }
  | { type:'undo_asset_sale'; id:string; expected:TrackedAsset; requestId:string }
  | { type:'convert_wish_to_asset'; id:string; expected:WishItem; asset:TrackedAsset; requestId:string }
  | { type:'save_wish_item'; item:WishItem; expected:WishItem|null; requestId:string }
  | { type:'delete_wish_item'; id:string; expected:WishItem; requestId:string }
  | { type:'save_money_owed'; tab:MoneyOwed; expected:MoneyOwed|null; requestId:string }
  | { type:'delete_money_owed'; id:string; expected:MoneyOwed; requestId:string }
  | { type:'record_owed_payment'; id:string; expected:MoneyOwed; payment:OwedPayment; cashAccountId:string; afterBalanceConfirmation?:boolean; requestId:string }
  | { type:'remove_owed_payment'; id:string; expected:MoneyOwed; paymentId:string; requestId:string }
  | { type: 'restore'; backup: unknown }
  | { type: 'import_locked'; backup: unknown });
