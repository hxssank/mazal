import { useCallback, useSyncExternalStore } from 'react';
import type { CategoryChange } from '../../../shared/category-review.ts';
import type { Workspace } from '../../../shared/types.ts';

export interface CategoryReviewSession { selections:Record<string,CategoryChange>; lastSave:CategoryChange[]|null; attempt?:{changes:CategoryChange[];requestId:string;undo:boolean} }
const sessions = new Map<Workspace,CategoryReviewSession>();
const listeners = new Map<Workspace,Set<()=>void>>();
const storageKey = (workspace:Workspace) => `mazal:category-review:v1:${workspace}`;
const isChange = (value:unknown):value is CategoryChange => {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const change=value as Record<string,unknown>;
  return ['id','expectedCategory','category'].every(key=>typeof change[key]==='string')&&['expectedExpenseCategory','expenseCategory'].every(key=>change[key]===undefined||change[key]===null||typeof change[key]==='string');
};

export function readCategoryReviewSession(workspace:Workspace):CategoryReviewSession {
  const cached=sessions.get(workspace);
  if(cached)return cached;
  let session:CategoryReviewSession={selections:{},lastSave:null};
  try {
    const saved=JSON.parse(sessionStorage.getItem(storageKey(workspace))??'null');
    if(saved&&typeof saved.selections==='object'&&saved.selections!==null&&!Array.isArray(saved.selections)&&Object.entries(saved.selections).every(([id,value])=>isChange(value)&&value.id===id)&&(saved.lastSave===null||Array.isArray(saved.lastSave)&&saved.lastSave.every(isChange))&&(saved.attempt===undefined||saved.attempt&&Array.isArray(saved.attempt.changes)&&saved.attempt.changes.every(isChange)&&typeof saved.attempt.requestId==='string'&&typeof saved.attempt.undo==='boolean'))session=saved;
  } catch {}
  sessions.set(workspace,session);
  return session;
}

export function updateCategoryReviewSession(workspace:Workspace,update:(previous:CategoryReviewSession)=>CategoryReviewSession):void {
  const next=update(readCategoryReviewSession(workspace));
  sessions.set(workspace,next);
  try { sessionStorage.setItem(storageKey(workspace),JSON.stringify(next)); } catch {}
  listeners.get(workspace)?.forEach(listener=>listener());
}

export function useCategoryReviewSession(workspace:Workspace):CategoryReviewSession {
  const subscribe=useCallback((listener:()=>void)=>{
    const subscribers=listeners.get(workspace)??new Set<()=>void>();
    subscribers.add(listener);listeners.set(workspace,subscribers);
    return()=>{subscribers.delete(listener);};
  },[workspace]);
  const snapshot=useCallback(()=>readCategoryReviewSession(workspace),[workspace]);
  return useSyncExternalStore(subscribe,snapshot,snapshot);
}
