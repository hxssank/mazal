import { transactionLabel } from '../../../shared/transaction-label.ts';
import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import { useMemo, useRef, useState } from 'react';
import { money } from '../../../shared/analytics.ts';
import { categoryReviewOptions } from '../../../shared/category-review.ts';
import type { CategoryChange } from '../../../shared/category-review.ts';
import { previewCategoryRule, resolveCategoryRules, validateCategoryRule } from '../../../shared/category-rules.ts';
import type { CategoryRule, CategoryRulePreview } from '../../../shared/category-rules.ts';
import { isUncategorized } from '../../../shared/expense-categories.ts';
import type { AppState, Command } from '../../../shared/types.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
import './category-rules.css';

interface Props { state:AppState; readOnly:boolean; pending:boolean; onCommand:(command:Command)=>Promise<void>; onApply:(changes:CategoryChange[],revision:number)=>Promise<boolean> }
interface Preview { rows:CategoryRulePreview[]; revision:number; selected:Set<string>; visible:number }

export default function CategoryRules({state,readOnly,pending,onCommand,onApply}:Props) {
  const [open,setOpen]=useState(false);
  const [draft,setDraft]=useState<CategoryRule|null>(null);
  const [expected,setExpected]=useState<CategoryRule|null>(null);
  const [preview,setPreview]=useState<Preview|null>(null);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [attempt,setAttempt]=useState<Extract<Command,{type:'save_category_rule'|'delete_category_rule'}>|null>(null);
  const [discard,setDiscard]=useState(false);
  const initial=useRef('');
  const busy=readOnly||pending||saving;
  const disabled=busy||!!attempt;
  const protection=useDraftProtection({dirty:!!draft&&JSON.stringify(draft)!==initial.current||!!attempt,busy:pending||saving,onRequestDiscard:()=>setDiscard(true)});
  const rules=state.categoryRules??[];
  const conflicts=useMemo(()=>open?state.transactions.filter(row=>row.kind==='expense'&&isUncategorized(row.category)).flatMap(row=>{
    const result=resolveCategoryRules(state.categoryRules??[],row,state.accounts);
    return result.kind==='conflict'?[{row,categories:[...new Set(result.rules.map(rule=>rule.category))]}]:[];
  }):[],[open,state.categoryRules,state.transactions,state.accounts]);
  const accounts=state.accounts.filter(account=>account.entityId===draft?.entityId&&['cash','debt','payable'].includes(account.type));
  const categories=draft?categoryReviewOptions(state,draft.entityId,draft.category):[];
  const changedSincePreview=!!preview&&preview.revision!==state.revision;
  function edit(rule?:CategoryRule) {
    protection.requestChange(()=>{
      const next:CategoryRule=rule?{...rule}:{id:crypto.randomUUID(),entityId:state.entities[0]?.id??'',accountId:null,match:'exact',merchant:'',category:'',enabled:true};
      initial.current=JSON.stringify(next);setDraft(next);
      setExpected(rule?{...rule}:null);setPreview(null);setError('');setNotice('');setAttempt(null);
    });
  }
  function closeEditor() {setDraft(null);setExpected(null);setPreview(null);setAttempt(null);setError('');}
  function change(values:Partial<CategoryRule>) {
    if(attempt)return;
    setDraft(previous=>previous?{...previous,...values}:null);setPreview(null);setError('');setNotice('');
  }
  function makePreview() {
    if(!draft)return;
    try {
      const rule=validateCategoryRule(draft,state);
      const rows=previewCategoryRule(rule,state.transactions,state.accounts,rules);
      setPreview({rows,revision:state.revision,visible:100,selected:new Set(rows.slice(0,100).filter(row=>isUncategorized(row.transaction.category)&&!row.conflictCategories.length).map(row=>row.transaction.id))});setError('');
    } catch(caught){setError(caught instanceof Error?caught.message:'Check the rule fields.');}
  }
  async function save(remove=false) {
    if(!draft||busy)return;
    setSaving(true);setError('');setNotice('');
    try {
      const rule=attempt?.type==='save_category_rule'?attempt.rule:validateCategoryRule(draft,state);
      const body=attempt??(remove?{type:'delete_category_rule' as const,id:rule.id,expected:expected!,requestId:crypto.randomUUID(),expectedRevision:state.revision}:{type:'save_category_rule' as const,rule,expected,requestId:crypto.randomUUID(),expectedRevision:state.revision});
      setAttempt(body);
      await onCommand(body);
      setAttempt(null);setPreview(null);
      if(body.type==='delete_category_rule'){setDraft(null);setExpected(null);setNotice('Rule removed.');}
      else{initial.current=JSON.stringify(rule);setDraft(rule);setExpected(rule);setNotice(rule.enabled?'Rule saved. It will categorize new uncategorized expenses.':'Rule saved and turned off.');}
    } catch(caught){if(isConfirmedCommandRejection(caught))setAttempt(null);setError(caught instanceof Error?caught.message:'Could not save the rule.');}
    finally{setSaving(false);}
  }
  async function apply() {
    if(!preview||disabled||changedSincePreview)return;
    const changes=preview.rows.filter(row=>preview.selected.has(row.transaction.id)&&!row.conflictCategories.length).map(row=>row.change);
    if(await onApply(changes,preview.revision)){setPreview(null);setNotice('Categories saved. Use Undo last save above to restore them.');}
  }
  const selectedCount=preview?.selected.size??0;
  return <details className="category-rules" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <DraftDiscardDialog open={discard} uncertain={!!attempt} onDiscard={()=>{closeEditor();setDiscard(false);protection.discard();}} onKeepEditing={()=>{setDiscard(false);protection.keepEditing();}}/>
    <summary>Merchant rules <span>{rules.length}</span></summary>
    {open&&<div className="category-rules-body">
      <p>Match merchant text within one owner. New uncategorized expenses use enabled rules. Preview existing records before changing them.</p>
      {conflicts.length>0&&<div className="category-rules-conflicts" role="status"><strong>{conflicts.length} {conflicts.length===1?'expense has':'expenses have'} conflicting rules.</strong><p>These stay uncategorized until the rules agree.</p><ul>{conflicts.slice(0,10).map(({row,categories})=><li key={row.id}>{transactionLabel(row)} · {row.date} · {categories.join(' / ')}</li>)}</ul>{conflicts.length>10&&<small>Showing 10 of {conflicts.length} conflicts.</small>}</div>}
      <div className="category-rules-list">{rules.map(rule=><button type="button" className="category-rules-item" key={rule.id} disabled={disabled} onClick={()=>edit(rule)}><span><strong>{rule.merchant}</strong><small>{rule.match==='exact'?'Exact match':'Contains'} · {state.entities.find(entity=>entity.id===rule.entityId)?.name} · {rule.accountId?state.accounts.find(account=>account.id===rule.accountId)?.name:'All owner accounts'}</small></span><span>{rule.category}<small>{rule.enabled?'On':'Off'} · Edit</small></span></button>)}</div>
      <button type="button" className="button secondary compact" disabled={disabled||!state.entities.length} onClick={()=>edit()}>Add merchant rule</button>
      {error&&<p className="expense-error" role="alert">{error}</p>}
      {notice&&<p role="status">{notice}</p>}
      {draft&&<div className="category-rule-editor">
        {attempt&&<p className="mazal-form-notice" role="status">Confirm the original save before editing. Retrying sends the same rule once. If records changed before it saved, close this editor and reopen the saved rule.</p>}
        <div className="category-rule-fields">
          <label>Owner<select value={draft.entityId} disabled={disabled||expected!==null} onChange={event=>change({entityId:event.target.value,accountId:null,category:''})}>{state.entities.map(entity=><option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label>
          <label>Account<select value={draft.accountId??''} disabled={disabled} onChange={event=>change({accountId:event.target.value||null})}><option value="">All accounts for this owner</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>Match<select value={draft.match} disabled={disabled} onChange={event=>change({match:event.target.value as CategoryRule['match']})}><option value="exact">Exact merchant text</option><option value="contains">Contains merchant text</option></select></label>
          <label>Merchant text<input maxLength={500} value={draft.merchant} disabled={disabled} onChange={event=>change({merchant:event.target.value})}/></label>
          <label>Category<input list="merchant-rule-categories" maxLength={100} value={draft.category} disabled={disabled} onChange={event=>change({category:event.target.value})}/><datalist id="merchant-rule-categories">{categories.map(category=><option key={category} value={category}/>)}</datalist></label>
          <label className="category-rule-checkbox"><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={event=>change({enabled:event.target.checked})}/>Use next time</label>
        </div>
        <small>Matches ignore case and repeated spaces. Original descriptions and source links stay as recorded.</small>
        <div className="category-rule-actions"><button type="button" className="button secondary compact" disabled={disabled} onClick={makePreview}>Preview existing expenses</button><button type="button" className="button primary compact" disabled={busy} onClick={()=>void save()}>{saving?'Saving…':attempt?'Confirm original save':'Save rule'}</button>{expected&&<button type="button" className="text-button" disabled={disabled} onClick={()=>void save(true)}>Delete rule</button>}<button type="button" className="text-button" disabled={busy} onClick={()=>protection.requestChange(closeEditor)}>Close editor</button></div>
        {preview&&<div className="category-rule-preview">
          <strong>{preview.rows.length} matching {preview.rows.length===1?'expense would':'expenses would'} change</strong>
          <p>Uncategorized expenses in the first 100 matches are selected. Existing categories change only when you select them.</p>
          {changedSincePreview&&<p className="expense-error" role="alert">Records changed. Preview again before applying.</p>}
          {preview.rows.some(row=>row.conflictCategories.length>0)&&<p className="expense-error">Conflicting rules block those rows. Edit or turn off the conflicting rule first.</p>}
          {preview.rows.length>100&&<p>Showing {Math.min(preview.visible,preview.rows.length)} of {preview.rows.length} matches. Apply at most 5,000 changes at a time.</p>}
          <div className="category-rule-preview-rows">{preview.rows.slice(0,preview.visible).map(({transaction,change:categoryChange,conflictCategories})=><label className="category-rule-preview-row" key={transaction.id}><input type="checkbox" aria-label={`Change category for ${transactionLabel(transaction)} on ${transaction.date}`} disabled={disabled||changedSincePreview||!!conflictCategories.length||!preview.selected.has(transaction.id)&&selectedCount>=5000} checked={preview.selected.has(transaction.id)} onChange={event=>{const checked=event.target.checked;setPreview(previous=>{if(!previous)return null;const selected=new Set(previous.selected);if(checked)selected.add(transaction.id);else selected.delete(transaction.id);return {...previous,selected};});}}/><span><strong>{transactionLabel(transaction)}</strong><small>{transaction.date} · {state.accounts.find(account=>account.id===transaction.accountId)?.name} · {money(transaction.amountCents)}</small><span>{transaction.category||'Uncategorized'} → {categoryChange.category}{transaction.expenseCategory!==undefined&&transaction.expenseCategory!==transaction.category&&<small>Reporting category: {transaction.expenseCategory||'Uncategorized'} → {categoryChange.category}</small>}</span>{conflictCategories.length>0&&<small>Conflict: {conflictCategories.join(' / ')}</small>}</span></label>)}</div>
          {preview.visible<preview.rows.length&&<button type="button" className="text-button" onClick={()=>setPreview(previous=>previous?{...previous,visible:previous.visible+100}:null)}>Show 100 more matches</button>}
          <div className="category-rule-actions"><button type="button" className="text-button" disabled={disabled||changedSincePreview} onClick={()=>setPreview(previous=>previous?{...previous,selected:new Set()}:null)}>Clear selection</button><button type="button" className="button primary compact" disabled={disabled||changedSincePreview||!selectedCount} onClick={()=>void apply()}>Apply {selectedCount} {selectedCount===1?'change':'changes'}</button></div>
        </div>}
      </div>}
    </div>}
  </details>;
}
