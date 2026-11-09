import { isUncategorized, normalizedCategory, suggestExpenseCategory } from './expense-categories.ts';
import type { CategoryChange } from './category-review.ts';
import { activeExpenseTransactions } from './category-review.ts';
import type { Transaction } from './types.ts';

export interface CategoryRule { id:string; entityId:string; accountId:string|null; match:'exact'|'contains'; merchant:string; category:string; enabled:boolean }
export interface CategoryRuleContext { entities:{id:string}[]; accounts:{id:string;entityId:string;type:string}[] }
type RuleAccount = { id:string; entityId:string };
export interface CategoryRuleResolution { kind:'none'|'match'|'conflict'; rules:CategoryRule[]; category:string|null }
export interface CategoryRulePreview { transaction:Transaction; change:CategoryChange; conflictCategories:string[] }

function ruleRecord(value:unknown):Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Category rule must be an object.');
  return value as Record<string,unknown>;
}

function ruleText(value:unknown,label:string,max=200):string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error(`${label} must contain a value of at most ${max} characters.`);
  return value.trim();
}

export function validateCategoryRule(raw:unknown,context:CategoryRuleContext):CategoryRule {
  const input=ruleRecord(raw);
  const entityId=ruleText(input.entityId,'Rule owner');
  if (!context.entities.some(entity=>entity.id===entityId)) throw new Error('Choose an existing rule owner.');
  const accountId=input.accountId===null?null:ruleText(input.accountId,'Rule account');
  if (accountId!==null) {
    const account=context.accounts.find(item=>item.id===accountId);
    if (!account || account.entityId!==entityId || !['cash','debt','payable'].includes(account.type)) throw new Error('Choose a cash, debt, or payable account belonging to the rule owner.');
  }
  if (input.match!=='exact' && input.match!=='contains') throw new Error('Choose exact or contains for the merchant match.');
  if (typeof input.enabled!=='boolean') throw new Error('Rule enabled must be true or false.');
  const category=ruleText(input.category,'Rule category',100);
  if (isUncategorized(category)) throw new Error('Choose a category other than Uncategorized.');
  return {id:ruleText(input.id,'Rule ID'),entityId,accountId,match:input.match,merchant:ruleText(input.merchant,'Merchant text',500),category,enabled:input.enabled};
}

export function validateCategoryRules(raw:unknown,context:CategoryRuleContext):CategoryRule[] {
  if (!Array.isArray(raw) || raw.length>1000) throw new Error('Category rules must be a list with at most 1,000 entries.');
  const rules=raw.map(rule=>validateCategoryRule(rule,context));
  if (new Set(rules.map(rule=>rule.id)).size!==rules.length) throw new Error('Duplicate category rule IDs.');
  return rules;
}

export function categoryRuleMatches(rule:CategoryRule,transaction:Transaction,accounts:RuleAccount[]):boolean {
  if (transaction.kind!=='expense') return false;
  const account=accounts.find(item=>item.id===transaction.accountId);
  if (!account || account.entityId!==rule.entityId || rule.accountId!==null && rule.accountId!==account.id) return false;
  const merchant=normalizedCategory(rule.merchant);
  if (!merchant) return false;
  const description=normalizedCategory(transaction.description);
  return rule.match==='exact'?description===merchant:description.includes(merchant);
}

export function resolveCategoryRules(rules:CategoryRule[],transaction:Transaction,accounts:RuleAccount[]):CategoryRuleResolution {
  const matching=rules.filter(rule=>rule.enabled && categoryRuleMatches(rule,transaction,accounts));
  if (!matching.length) return {kind:'none',rules:[],category:null};
  const categories=new Set(matching.map(rule=>normalizedCategory(rule.category)));
  return {kind:categories.size===1?'match':'conflict',rules:matching,category:categories.size===1?matching[0].category:null};
}

export function autoCategorizeTransaction(rules:CategoryRule[],transaction:Transaction,accounts:RuleAccount[]):Transaction {
  if (transaction.kind!=='expense' || !isUncategorized(transaction.category) || transaction.expenseCategory!==undefined && !isUncategorized(transaction.expenseCategory)) return transaction;
  const result=resolveCategoryRules(rules,transaction,accounts);
  if (result.kind==='conflict') return transaction;
  const category=result.kind==='match'?result.category:suggestExpenseCategory(transaction.description)?.category;
  return category?{...transaction,category,expenseCategory:category}:transaction;
}

export function previewCategoryRule(rule:CategoryRule,transactions:Transaction[],accounts:RuleAccount[],savedRules:CategoryRule[]=[]):CategoryRulePreview[] {
  const rules=[...savedRules.filter(saved=>saved.id!==rule.id),{...rule,enabled:true}];
  return activeExpenseTransactions(transactions).filter(transaction=>categoryRuleMatches(rule,transaction,accounts)).map(transaction=>{
    const result=resolveCategoryRules(rules,transaction,accounts);
    return {
      transaction:{...transaction},
      change:{id:transaction.id,expectedCategory:transaction.category,expectedExpenseCategory:transaction.expenseCategory??null,category:rule.category,expenseCategory:rule.category},
      conflictCategories:result.kind==='conflict'?[...new Set(result.rules.map(item=>item.category))]:[],
    };
  }).filter(row=>row.transaction.category!==rule.category || row.transaction.expenseCategory!==undefined && row.transaction.expenseCategory!==rule.category);
}
