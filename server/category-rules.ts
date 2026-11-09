import { validateCategoryRule, validateCategoryRules } from '../shared/category-rules.ts';
import type { CategoryRule, CategoryRuleContext } from '../shared/category-rules.ts';

export function applyCategoryRuleCommand(data:CategoryRuleContext & {categoryRules?:CategoryRule[]},command:Record<string,unknown>):string|null {
  if (command.type!=='save_category_rule' && command.type!=='delete_category_rule') return null;
  const rules=data.categoryRules??[];
  if (command.type==='save_category_rule') {
    const rule=validateCategoryRule(command.rule,data);
    const index=rules.findIndex(item=>item.id===rule.id);
    if (command.expected===null) {
      if (index>=0) throw new Error('This rule already exists. Reopen it before saving.');
    } else {
      const expected=validateCategoryRule(command.expected,data);
      if (index<0 || expected.id!==rule.id || JSON.stringify(expected)!==JSON.stringify(rules[index])) throw new Error('This rule changed or was removed. Reopen it before saving.');
      if (rules[index].entityId!==rule.entityId) throw new Error('A rule cannot move to another owner. Create a separate rule.');
    }
    const next=[...rules];
    if (index<0) next.push(rule); else next[index]=rule;
    data.categoryRules=validateCategoryRules(next,data);
    return `Saved merchant rule for ${rule.merchant}.`;
  }
  const expected=validateCategoryRule(command.expected,data);
  const index=rules.findIndex(rule=>rule.id===command.id);
  if (index<0 || expected.id!==command.id || JSON.stringify(expected)!==JSON.stringify(rules[index])) throw new Error('This rule changed or was removed. Reopen it before removing.');
  data.categoryRules=rules.filter(rule=>rule.id!==command.id);
  return `Removed merchant rule for ${expected.merchant}.`;
}
