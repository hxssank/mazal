import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { expenseCategoryTemplates, normalizedCategory } from '../../../shared/expense-categories.ts';
import './category-picker.css';

interface Props {
  title: string;
  context: string;
  value: string;
  options: string[];
  suggestion?: { category: string; reason: string } | null;
  conflict?: ReactNode;
  onChoose: (category: string) => void | Promise<void>;
  onClose: () => void;
}

const categoryGroups = [
  { key: 'essentials', title: 'Everyday essentials', categories: ['housing', 'bills', 'food', 'transport', 'personal'] },
  { key: 'lifestyle', title: 'Lifestyle', categories: ['subscriptions', 'social', 'cannabis'] },
  { key: 'occasional', title: 'Occasional spending', categories: ['trips', 'career', 'digital', 'sidequests'] },
  { key: 'other', title: 'Fees & other spending', categories: ['fees', 'other'] },
  { key: 'custom', title: 'Your categories', categories: [] as string[] },
];
const templateFor=(name:string)=>expenseCategoryTemplates.find(item=>[item.name,item.label].some(label=>normalizedCategory(label)===normalizedCategory(name)));
export const categoryPickerLabel=(name:string)=>expenseCategoryTemplates.find(item=>normalizedCategory(item.name)===normalizedCategory(name))?.label??name;

export default function CategoryPicker({title,context,value,options,suggestion,conflict,onChoose,onClose}:Props) {
  const id=useId();
  const dialog=useRef<HTMLDialogElement>(null);
  const applying=useRef(false);
  const optionFor=(name:string)=>options.includes(name)?name:expenseCategoryTemplates.find(template=>[template.name,template.label,...template.aliases].some(alias=>normalizedCategory(alias)===normalizedCategory(name))&&options.includes(template.name))?.name??name;
  const current=optionFor(value);
  const [query,setQuery]=useState('');
  const [pendingCategory,setPendingCategory]=useState<string|null>(null);
  const selected=pendingCategory??current;
  const pending=pendingCategory!==null;
  const [error,setError]=useState('');
  const choices=[...new Set([...options,...(current&&!options.includes(current)?[current]:[])])].map(name=>({name,label:categoryPickerLabel(name),template:templateFor(name)}));
  const terms=normalizedCategory(query).split(' ').filter(Boolean);
  const visible=choices.filter(choice=>terms.every(term=>normalizedCategory([choice.name,choice.label,choice.template?.examples,...(choice.template?.aliases??[])].join(' ')).includes(term)));
  const groups=categoryGroups.map(group=>({...group,choices:visible.filter(choice=>group.key==='custom'?!choice.template:group.categories.includes(choice.template?.key??'')).sort((a,b)=>group.categories.indexOf(a.template?.key??'')-group.categories.indexOf(b.template?.key??'')||a.name.localeCompare(b.name))})).filter(group=>group.choices.length);
  const suggested=suggestion&&choices.find(choice=>choice.name===optionFor(suggestion.category));
  useEffect(()=>{
    const previous=document.activeElement;
    const element=dialog.current;
    element?.showModal();
    element?.querySelector('input')?.focus();
    return()=>{element?.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  },[]);
  useEffect(()=>{setError('');},[current]);
  async function choose(category:string) {
    if(!category||applying.current||conflict)return;
    applying.current=true;
    setPendingCategory(category);setError('');
    try {await onChoose(category);onClose();}
    catch(caught){setError(caught instanceof Error?caught.message:'Could not save the category. Try again.');}
    finally{applying.current=false;setPendingCategory(null);}
  }
  return <dialog ref={dialog} className="category-picker" aria-labelledby={`${id}-title`} aria-describedby={`${id}-context`} onCancel={event=>{event.preventDefault();if(!pending)onClose();}} onClick={event=>{if(event.target===event.currentTarget&&!pending){const box=event.currentTarget.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)onClose();}}}>
    <div className="category-picker-body">
      <header><div><h2 id={`${id}-title`}>{title}</h2><p id={`${id}-context`}>{context}</p></div><button type="button" className="category-picker-close" aria-label="Close category picker" disabled={pending} onClick={onClose}>×</button></header>
      <div className="category-picker-search-row"><input className="category-picker-search" aria-label="Search categories" placeholder="Search categories or expenses" value={query} disabled={pending} onChange={event=>setQuery(event.target.value)}/>{query&&<button type="button" className="category-picker-search-clear" aria-label="Clear category search" disabled={pending} onClick={()=>{setQuery('');dialog.current?.querySelector('input')?.focus();}}>×</button>}</div>
      <div className="category-picker-options" role="group" aria-label="Categories">
        {suggested&&!terms.length&&<div className="category-picker-recommendation"><span>Suggested for this merchant</span><button type="button" data-category={suggested.name} aria-pressed={selected===suggested.name} disabled={pending||!!conflict} onClick={()=>void choose(suggested.name)}><i style={{background:suggested.template?.color??'#a4b8d9'}} aria-hidden="true"/><span className="category-picker-option-copy"><strong>{suggested.label}</strong><small>{suggestion!.reason}</small></span><span className="category-picker-check" aria-hidden="true">{selected===suggested.name?'✓':''}</span></button></div>}
        {groups.map(group=><section className="category-picker-group" key={group.key} aria-labelledby={`${id}-${group.key}`}><h3 id={`${id}-${group.key}`}>{group.title}</h3><div>{group.choices.map(choice=><button type="button" key={choice.name} data-category={choice.name} aria-pressed={selected===choice.name} disabled={pending||!!conflict} onClick={()=>void choose(choice.name)}><i style={{background:choice.template?.color??'#a4b8d9'}} aria-hidden="true"/><span className="category-picker-option-copy"><strong>{choice.label}</strong>{choice.template&&<small>{choice.template.examples}</small>}</span><span className="category-picker-check" aria-hidden="true">{selected===choice.name?'✓':''}</span></button>)}</div></section>)}
      </div>
      {!visible.length&&<p className="category-picker-empty">No matching categories. Add a category in the monthly plan to use it here.</p>}
      {conflict&&<div className="category-picker-error" role="alert">{conflict}</div>}
      {error&&<p className="category-picker-error" role="alert">{error}</p>}
      {pending&&<p className="category-picker-pending" role="status">Applying category…</p>}
    </div>
  </dialog>;
}
