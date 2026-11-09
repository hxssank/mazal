import { transactionLabel, transactionSearchText } from '../../../shared/transaction-label.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { updateCategoryReviewSession, useCategoryReviewSession } from './category-review-session.ts';
import { money } from '../../../shared/analytics.ts';
import { activeExpenseTransactions, categoryReviewGroups, categoryReviewOptions, matchesCategoryChange, reverseCategoryChanges, selectedCategoryChanges } from '../../../shared/category-review.ts';
import type { CategoryChange } from '../../../shared/category-review.ts';
import type { AppState, Command, Transaction } from '../../../shared/types.ts';
import CategoryPicker, { categoryPickerLabel } from './CategoryPicker.tsx';
import CategoryRules from './CategoryRules.tsx';
import './category-review.css';

interface Props { state:AppState; rows:Transaction[]; readOnly:boolean; onCommand:(command:Command)=>Promise<void> }

export default function CategoryReview({state,rows,readOnly,onCommand}:Props) {
  const {selections,lastSave,attempt}=useCategoryReviewSession(state.workspace);
  const setSelections=(update:(previous:Record<string,CategoryChange>)=>Record<string,CategoryChange>)=>updateCategoryReviewSession(state.workspace,previous=>({...previous,selections:update(previous.selections)}));
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [query,setQuery]=useState('');
  const [page,setPage]=useState(0);
  const [reviewFilter,setReviewFilter]=useState<'all'|'suggested'|'manual'>('all');
  const [expanded,setExpanded]=useState<Record<string,number>>({});
  const [picker,setPicker]=useState<{rows:Transaction[];title:string;context:string;value:string;options:string[];suggestion?:{category:string;reason:string}|null}|null>(null);
  const checkedAttempts=useRef(new Set<string>());
  const byId=new Map(state.transactions.map(row=>[row.id,row]));
  const attemptMatches=!!attempt?.changes.length&&attempt.changes.every(change=>matchesCategoryChange(byId.get(change.id),change));
  const groups=useMemo(()=>categoryReviewGroups(state,rows),[state,rows]);
  const optionsByOwner=useMemo(()=>new Map([...new Set(groups.map(group=>group.ownerId))].map(ownerId=>[ownerId,categoryReviewOptions(state,ownerId)])),[state,groups]);
  const searched=groups.filter(group=>!query.trim()||`${group.merchant} ${group.rows.map(row=>transactionSearchText(row)).join(' ')}`.toLocaleLowerCase('en-CA').includes(query.trim().toLocaleLowerCase('en-CA')));
  const hasSuggestion=(group:typeof groups[number])=>!!group.suggestion&&(optionsByOwner.get(group.ownerId)??[]).includes(group.suggestion.category);
  const suggestedGroups=searched.filter(hasSuggestion);
  const matching=searched.filter(group=>reviewFilter==='all'||(reviewFilter==='suggested'?hasSuggestion(group):!hasSuggestion(group)));
  const suggestedChanges=matching.filter(hasSuggestion).flatMap(group=>group.rows.filter(row=>!selections[row.id]).map(row=>({id:row.id,expectedCategory:row.category,expectedExpenseCategory:row.expenseCategory??null,category:group.suggestion!.category,expenseCategory:group.suggestion!.category}))).slice(0,5000);
  const pageSize=40;
  const currentPage=Math.min(page,Math.max(0,Math.ceil(matching.length/pageSize)-1));
  const visibleGroups=matching.slice(currentPage*pageSize,(currentPage+1)*pageSize);
  const showOwners=new Set(groups.map(group=>group.ownerId)).size>1;
  const selectedChanges=selectedCategoryChanges(rows,selections,state.transactions);
  const changes=selectedChanges.slice(0,5000);
  const remaining=groups.reduce((sum,group)=>sum+group.rows.length,0);
  const selectedIds=new Set(changes.map(change=>change.id));
  const activeIds=new Set(activeExpenseTransactions(state.transactions).map(row=>row.id));
  const hiddenCount=Object.values(selections).filter(change=>activeIds.has(change.id)&&!selectedIds.has(change.id)&&byId.get(change.id)?.category===change.expectedCategory).length;
  const canUndo=!!lastSave&&lastSave.every(change=>matchesCategoryChange(byId.get(change.id),change));
  function choose(targets:Transaction[],category:string) {
    setSelections(previous=>{
      const next={...previous};
      for(const row of targets) { if(category)next[row.id]={id:row.id,expectedCategory:row.category,expectedExpenseCategory:row.expenseCategory??null,category,expenseCategory:category};else delete next[row.id]; }
      return next;
    });
    setError('');setNotice('');
  }
  async function submit(undo=false,replay?:{changes:CategoryChange[];requestId:string;undo:boolean},ruleChanges?:CategoryChange[],revision=state.revision):Promise<boolean> {
    if(pending||readOnly)return false;
    const batch=replay?.changes??ruleChanges??(undo&&lastSave?reverseCategoryChanges(lastSave):changes);
    if(!batch.length)return false;
    const key=JSON.stringify(batch);
    const requestId=replay?.requestId??(attempt&&attempt.undo===undo&&JSON.stringify(attempt.changes)===key?attempt.requestId:crypto.randomUUID());
    checkedAttempts.current.add(requestId);
    updateCategoryReviewSession(state.workspace,previous=>({...previous,attempt:{changes:batch,requestId,undo}}));
    setPending(true);setError('');
    try {
      await onCommand({type:'categorize_transactions',changes:batch,expectedRevision:revision,requestId});
      updateCategoryReviewSession(state.workspace,previous=>{
        if(previous.attempt?.requestId!==requestId)return previous;
        return {selections:undo?previous.selections:Object.fromEntries(Object.entries(previous.selections).filter(([id,selection])=>!batch.some(change=>change.id===id&&change.category===selection.category))),lastSave:undo?null:batch};
      });
      setNotice(undo?`Restored ${batch.length} ${batch.length===1?'transaction':'transactions'} for review.`:`Saved ${batch.length} ${batch.length===1?'category':'categories'}.`);
      return true;
    } catch(caught){setError(caught instanceof Error?caught.message:'Could not save categories. Your choices are still here.');return false;}
    finally{setPending(false);}
  }
  useEffect(()=>{
    if(!readOnly&&!pending&&attempt&&attemptMatches&&!checkedAttempts.current.has(attempt.requestId))void submit(attempt.undo,attempt);
  },[attempt,attemptMatches,pending,readOnly]);
  return <section className="category-review-workspace" aria-label="Review uncategorized expenses">
    <header className="category-review-heading"><div><h3>Categorize transactions</h3><p>Transactions are grouped by your saved name, or the bank merchant when unnamed. Expand a group to see notes and original entries.</p></div><strong aria-live="polite">{remaining} transactions · {groups.length} merchants</strong></header>
    {pending&&attemptMatches&&<p role="status">Checking the previous save…</p>}
    {error&&<p className="expense-error" role="alert">{error}</p>}
    {attempt&&attemptMatches&&!pending&&<button type="button" className="button secondary compact" disabled={readOnly} onClick={()=>void submit(attempt.undo,attempt)}>Check previous save</button>}
    {(notice||lastSave)&&<div className="category-review-result"><p role="status">{notice}</p>{lastSave&&<button type="button" className="text-button" disabled={pending||readOnly||!canUndo} onClick={()=>void submit(true)}>Undo last save</button>}{lastSave&&!canUndo&&<small>Some saved categories changed again. Undo is unavailable.</small>}</div>}
    {!remaining&&<p className="category-review-complete">All transactions matching these filters have a category.</p>}
    {remaining>0&&<>
      <div className="category-review-tools"><input className="category-review-search" aria-label="Search merchants to categorize" placeholder="Search merchants or statement names" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/><nav className="category-review-filters" aria-label="Category suggestion filters">{([['all','All merchants',searched.length],['suggested','Suggested',suggestedGroups.length],['manual','Needs a choice',searched.length-suggestedGroups.length]] as const).map(([value,label,count])=><button type="button" key={value} aria-pressed={reviewFilter===value} onClick={()=>{setReviewFilter(value);setPage(0);}}>{label}<span>{count}</span></button>)}</nav></div>
      {suggestedChanges.length>0&&<div className="category-review-auto"><div><strong>{suggestedChanges.length} {suggestedChanges.length===1?'transaction has a suggested category':'transactions have suggested categories'}</strong><p>Based on merchant names and your previous choices. Your selected categories stay as they are.</p></div><button type="button" className="button secondary" disabled={pending||readOnly} onClick={()=>void submit(false,undefined,suggestedChanges)}>Apply {suggestedChanges.length} {suggestedChanges.length===1?'suggestion':'suggestions'}</button></div>}
      {!matching.length&&<p className="category-review-empty">No merchants match this view.</p>}
    </>}
    <div className="category-review-groups">{visibleGroups.map(group=>{
      const baseCategories=optionsByOwner.get(group.ownerId)??[];
      const allCategories=group.suggestion&&!baseCategories.includes(group.suggestion.category)?categoryReviewOptions(state,group.ownerId,group.suggestion.category):baseCategories;
      const suggestion=group.suggestion&&allCategories.includes(group.suggestion.category)?group.suggestion:null;
      const selected=group.rows.map(row=>selections[row.id]?.category??'');
      const value=selected.every(category=>category===selected[0])?selected[0]:'__mixed__';
      const owner=state.entities.find(entity=>entity.id===group.ownerId)?.name;
      return <article key={group.key} className={`category-review-group${value&&value!=='__mixed__'?' is-selected':''}`}>
        <div className="category-review-merchant"><div><h4>{group.merchant}</h4><p>{group.rows.length} {group.rows.length===1?'transaction':'transactions'}{showOwners?` · ${owner??'Unknown owner'}`:''} · {group.rows.some(row=>row.amountCents<0)?'Includes refund · ':''}{money(group.amountCents)}</p>{(group.variants??[]).length>1&&<span className="category-review-variants">{group.variants.length} statement names grouped</span>}</div></div>
        <div className="category-review-controls"><div className="category-review-selection"><button type="button" className="expense-category-action" aria-label={`Category for ${group.merchant}${showOwners?` (${owner})`:''}`} disabled={pending||readOnly} onClick={()=>setPicker({rows:group.rows,title:'Choose category',context:`${group.merchant} · ${group.rows.length} ${group.rows.length===1?'transaction':'transactions'} · ${money(group.amountCents)}`,value:value==='__mixed__'?'':value,options:allCategories,suggestion})}>{value==='__mixed__'?'Different categories':value?categoryPickerLabel(value):'Choose category'} <span aria-hidden="true">⌄</span></button>{value&&<button type="button" className="text-button category-review-clear-group" aria-label={`Clear category choices for ${group.merchant}`} disabled={pending||readOnly} onClick={()=>choose(group.rows,'')}>Clear</button>}</div>{suggestion&&<div className="category-review-quick"><button type="button" className="category-review-suggestion" title={suggestion.reason} aria-pressed={value===suggestion.category} disabled={pending||readOnly} onClick={()=>choose(group.rows,suggestion!.category)}>Use {categoryPickerLabel(suggestion.category)}</button></div>}</div>
        <details className="category-review-details" onToggle={event=>{const open=event.currentTarget.open;setExpanded(previous=>({...previous,[group.key]:open?previous[group.key]||50:0}));}}><summary>{group.rows.length===1?'View transaction':`View ${group.rows.length} transactions or choose separately`}</summary><div>{group.rows.slice(0,expanded[group.key]??0).map(row=><div className="category-review-detail" key={row.id}><div><strong>{transactionLabel(row)}</strong>{row.displayName&&<small>Original: {row.description}</small>}{row.note&&<small>{row.note}</small>}<small>{row.date} · {state.accounts.find(account=>account.id===row.accountId)?.name} · {row.amountCents<0?'Refund ':''}{money(row.amountCents)}</small></div><button type="button" className="expense-category-action" aria-label={`Category for ${transactionLabel(row)} on ${row.date} ${row.id.slice(0,6)}`} disabled={pending||readOnly} onClick={()=>setPicker({rows:[row],title:'Choose category',context:`${transactionLabel(row)} · ${row.date} · ${money(row.amountCents)}`,value:selections[row.id]?.category??'',options:allCategories,suggestion})}>{selections[row.id]?.category?categoryPickerLabel(selections[row.id].category):'Choose category'} <span aria-hidden="true">⌄</span></button></div>)}{expanded[group.key]>0&&expanded[group.key]<group.rows.length&&<button type="button" className="text-button" onClick={()=>setExpanded(previous=>({...previous,[group.key]:previous[group.key]+50}))}>Show more transactions</button>}</div></details>
      </article>;
    })}</div>
    {matching.length>pageSize&&<nav className="ledger-pagination" aria-label="Merchant pages"><button type="button" className="button secondary compact" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous merchants</button><span>{currentPage*pageSize+1} to {Math.min((currentPage+1)*pageSize,matching.length)} of {matching.length}</span><button type="button" className="button secondary compact" disabled={(currentPage+1)*pageSize>=matching.length} onClick={()=>setPage(currentPage+1)}>Next merchants</button></nav>}
    {picker&&<CategoryPicker {...picker} onChoose={category=>choose(picker.rows,category)} onClose={()=>setPicker(null)}/>}
    {(remaining>0||hiddenCount>0)&&<div className="category-review-save"><div><strong aria-live="polite">{selectedChanges.length} selected · {remaining-selectedChanges.length} still to choose</strong>{selectedChanges.length>5000&&<small>Save up to 5,000 transactions at a time. The rest of your choices stay selected.</small>}{Object.keys(selections).length>0&&<button type="button" className="category-review-clear" disabled={pending} onClick={()=>setSelections(()=>({}))}>Clear choices</button>}{hiddenCount>0&&<small>{hiddenCount} selections outside these filters will stay unsaved.</small>}</div><button type="button" className="button primary" disabled={pending||readOnly||!changes.length} onClick={()=>void submit()}>{pending?'Saving…':`Save ${changes.length||''} ${changes.length===1?'transaction':'transactions'}`}</button></div>}
    <CategoryRules state={state} readOnly={readOnly} pending={pending} onCommand={onCommand} onApply={(batch,revision)=>submit(false,undefined,batch,revision)}/>
  </section>;
}
