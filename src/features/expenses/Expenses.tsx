import { transactionLabel } from '../../../shared/transaction-label.ts';
import { useEffect, useRef, useState } from 'react';
import type { AppState, Command, Transaction, TransactionKind } from '../../../shared/types.ts';
import { money, today } from '../../../shared/analytics.ts';
import { expensePlanLimits, expensePlanTransactionCategory } from '../../../shared/expense-plan.ts';
import { isUncategorized } from '../../../shared/expense-categories.ts';
import { activeExpenseTransactions, categoryReviewOptions, matchesCategoryChange, reverseCategoryChanges } from '../../../shared/category-review.ts';
import { updateCategoryReviewSession, useCategoryReviewSession } from './category-review-session.ts';
import { purchaseAccountId } from '../../../shared/asset-purchases.ts';
import { filterLedger, ledgerCSV, ledgerDirection, ledgerTotals, isStatementMovement, transactionDisplayLabel, transactionLabels } from '../../../shared/ledger.ts';
import Icon from '../../components/Icon.tsx';
import Subscriptions from './Subscriptions.tsx';
import ExpenseOverview from './ExpenseOverview.tsx';
import ExpenseDashboard from './ExpenseDashboard.tsx';
import CategoryReview from './CategoryReview.tsx';
import CategoryPicker from './CategoryPicker.tsx';
import ExpensePlan from './ExpensePlan.tsx';
import { PaymentRecorder, TransactionEditor } from '../../components/RecordActions.tsx';
import { requestDraftNavigation } from '../../hooks/draft-protection.ts';
import ExpenseBills, { BillEditor, type ExpenseBillDraft } from './ExpenseBills.tsx';
import ExpenseSchedule from './ExpenseSchedule.tsx';
import './expenses.css';
import './expenses-refresh.css';
import './ledger.css';
import './expense-workspace.css';
import './expense-redesign.css';
import '../../styles/organized-workspaces.css';

interface Props {
  state: AppState;
  scope: string;
  readOnly: boolean;
  initialSection?: 'schedule'|'activity'|'plan';
  onSectionChange?: (section?: 'schedule'|'activity'|'plan') => void;
  onCommand: (command: Command) => Promise<void>;
  onOpen: (kind: 'transaction'|'account'|'obligation'|'import'|'reconcile'|'reserve', accountId?: string) => void;
}
const normalized=(value:string)=>value.normalize('NFKC').trim().toLocaleLowerCase('en-CA').replace(/\s+/g,' ');
type Tab='spending'|'schedule'|'transactions'|'plan';
const uncategorizedFilter='__uncategorized__';

export default function Expenses({state,scope,readOnly,initialSection,onSectionChange,onCommand,onOpen}:Props) {
  const requestedRecord=new URLSearchParams(window.location.hash.split('?')[1]).get('record');
  const requestedPlan=!!state.expensePlanItems?.some(item=>item.id===requestedRecord);
  const selectedTab:Tab=initialSection==='activity'?'transactions':initialSection==='schedule'?'schedule':initialSection==='plan'||requestedPlan?'plan':'spending';
  const [tab,setTab]=useState<Tab>(selectedTab);
  useEffect(()=>{setTab(selectedTab);},[selectedTab]);
  const [billDraft,setBillDraft]=useState<ExpenseBillDraft|null>(null);
  const [addingBill,setAddingBill]=useState(false);
  const [requestedBill,setRequestedBill]=useState(()=>{const id=new URLSearchParams(window.location.hash.split('?')[1]).get('record');return state.obligations.find(item=>item.id===id)??null;});
  const [transactionView,setTransactionView]=useState<'all'|'categories'>(()=>new URLSearchParams(window.location.hash.split('?')[1]).get('record')==='categories'?'categories':'all');
  const [month,setMonth]=useState(today().slice(0,7));
  const [query,setQuery]=useState('');
  const [dateFilter,setDateFilter]=useState<'month'|'all'>('all');
  const [kindFilter,setKindFilter]=useState<TransactionKind|'all'>('all');
  const [accountFilter,setAccountFilter]=useState('all');
  const [categoryFilter,setCategoryFilter]=useState('all');
  const [pending,setPending]=useState('');
  const [error,setError]=useState('');
  const [categoryEdit,setCategoryEdit]=useState<{id:string;description:string;expected:string;expectedExpenseCategory:string|null;value:string}|null>(null);
  const activeExpenseIds=new Set(activeExpenseTransactions(state.transactions).map(row=>row.id));
  const correctedIds=new Set(state.transactions.map(row=>row.replacesId).filter(Boolean));
  const reviewSession=useCategoryReviewSession(state.workspace);
  const editedTransaction=state.transactions.find(row=>row.id===categoryEdit?.id);
  const categoryEditCanceled=!!editedTransaction&&!activeExpenseIds.has(editedTransaction.id);
  const categoryEditConflict=!!categoryEdit&&(!editedTransaction||categoryEditCanceled||editedTransaction.category!==categoryEdit.expected||(editedTransaction.expenseCategory??null)!==categoryEdit.expectedExpenseCategory);
  const editOwner=state.accounts.find(account=>account.id===editedTransaction?.accountId)?.entityId;
  const editCategories=editOwner?categoryReviewOptions(state,editOwner):[];
  const [pageSelection,setPageSelection]=useState({filters:'',page:0});
  const [payment,setPayment]=useState<string|null>(null);
  const [detail,setDetail]=useState<string|null>(()=>{const id=new URLSearchParams(window.location.hash.split('?')[1]).get('record');return state.transactions.some(tx=>tx.id===id)?id:null;});
  const detailTrigger=useRef<HTMLElement|null>(null);
  const ledgerRef=useRef<HTMLElement>(null);
  const searchRef=useRef<HTMLInputElement>(null);
  const filterDetails=useRef<HTMLDetailsElement>(null);
  const categoryReviewButtonRef=useRef<HTMLButtonElement>(null);
  const currentDay=today();
  const currentMonth=currentDay.slice(0,7);
  const personalId=state.entities.find(entity=>entity.kind==='personal')?.id??state.entities[0]?.id??'';
  const planOwner=scope==='all'?personalId:scope;
  const ledgerScope=planOwner;
  const owners=state.entities.filter(e=>e.id===planOwner);
  const accounts=state.accounts.filter(a=>ledgerScope==='all'||a.entityId===ledgerScope);
  const selectedAccount=accounts.some(account=>account.id===accountFilter)?accountFilter:'all';
  const ids=new Set(accounts.map(a=>a.id));
  const accountNames=new Map([...state.accounts.map(account=>[account.id,account.name] as const),...(state.assetPurchases??[]).map(purchase=>[purchaseAccountId(purchase.id),purchase.name] as const)]);
  const transactionCount=state.transactions.filter(transaction=>ids.has(transaction.accountId)||!!transaction.toAccountId&&ids.has(transaction.toAccountId)).length;
  const monthLabel=new Date(`${month}-01T12:00:00`).toLocaleDateString('en-CA',{month:'long',year:'numeric'});
  const ownerLimits=new Map(owners.filter(owner=>ledgerScope==='all'||owner.id===ledgerScope).map(owner=>[owner.id,expensePlanLimits(state,owner.id)]));
  function transactionCategory(transaction:Transaction) {
    const ownerId=state.accounts.find(account=>account.id===transaction.accountId)?.entityId??'';
    return normalized(expensePlanTransactionCategory(state,ownerId,transaction));
  }
  const planCategories=[...new Map([...ownerLimits.values()].flat().map(limit=>[normalized(limit.name),limit.name])).entries()];
  const rawCategories=[...new Set(state.transactions.filter(t=>t.kind==='expense'&&ids.has(t.accountId)).map(t=>t.category))].filter(name=>!isUncategorized(name)&&!planCategories.some(([key])=>key===normalized(name))).map(name=>[`raw:${normalized(name)}`,name] as [string,string]);
  const ledgerCategories=[...planCategories,...rawCategories].sort((a,b)=>a[1].localeCompare(b[1]));
  const selectedCategory=categoryFilter===uncategorizedFilter||ledgerCategories.some(([key])=>key===categoryFilter)?categoryFilter:'all';
  const reviewingCategories=selectedCategory===uncategorizedFilter;
  const ledgerFilters={scope:ledgerScope,month:dateFilter==='month'?month:null,accountId:selectedAccount,kind:kindFilter,query};
  const reviewCount=activeExpenseTransactions(state.transactions,filterLedger(state,{...ledgerFilters,kind:'expense'})).filter(t=>isUncategorized(t.category)).length;
  const planReviewTransactions=activeExpenseTransactions(state.transactions,filterLedger(state,{scope:planOwner,month:null,accountId:'all',kind:'expense',query:''})).filter(t=>isUncategorized(t.category));
  const planReviewCount=planReviewTransactions.length;
  const rows=filterLedger(state,ledgerFilters).filter(t=>selectedCategory==='all'||t.kind==='expense'&&(reviewingCategories?isUncategorized(t.category):selectedCategory.startsWith('raw:')?normalized(t.category)===selectedCategory.slice(4):transactionCategory(t)===selectedCategory));
  const sourceMovements=rows.filter(isStatementMovement);
  const totals=ledgerTotals(rows.filter(t=>!isStatementMovement(t)));
  const ledgerDateLabel=(value:string)=>new Date(`${value}T12:00:00`).toLocaleDateString('en-CA',{month:'short',day:'numeric',...(dateFilter==='all'?{year:'numeric'}:{})});
  const activeFilters=[
    ...(query.trim()?[{key:'search',label:'Search',value:query.trim(),control:'Search transactions',clear:()=>setQuery('')}]:[]),
    ...(dateFilter==='month'?[{key:'date',label:'Month',value:monthLabel,control:'Transaction date range',clear:()=>setDateFilter('all')}]:[]),
    ...(selectedAccount!=='all'?[{key:'account',label:'Account',value:accountNames.get(selectedAccount)??selectedAccount,control:'Transaction account',clear:()=>setAccountFilter('all')}]:[]),
    ...(kindFilter!=='all'?[{key:'type',label:'Type',value:kindFilter==='adjustment'?'Other account entries':transactionLabels[kindFilter],control:'Transaction type',clear:()=>setKindFilter('all')}]:[]),
    ...(selectedCategory!=='all'?[{key:'category',label:'Category',value:reviewingCategories?'Uncategorized':ledgerCategories.find(([key])=>key===selectedCategory)![1],control:'Expense category',clear:()=>setCategoryFilter('all')}]:[]),
  ];
  const activeFilterCount=activeFilters.length;
  const filtered=activeFilterCount>0;
  const pageSize=50;
  const pageFilters=JSON.stringify([state.workspace,ledgerScope,month,dateFilter,selectedAccount,kindFilter,query,selectedCategory]);
  const lastPage=Math.max(0,Math.ceil(rows.length/pageSize)-1);
  const page=pageSelection.filters===pageFilters?Math.min(pageSelection.page,lastPage):0;
  const visibleRows=rows.slice(page*pageSize,(page+1)*pageSize);
  const ledgerDays=[...new Set(visibleRows.map(row=>row.date))].map(date=>({date,rows:visibleRows.filter(row=>row.date===date)}));

  function chooseMonth(value:string) {
    const next=value||currentMonth;
    if(next===month)return;
    requestDraftNavigation(()=>{setMonth(next);if(!reviewingCategories)setCategoryFilter('all');});
  }
  function chooseCategory(name:string) {
    setCategoryFilter(normalized(name));setKindFilter('expense');setDateFilter('month');setQuery('');setAccountFilter('all');setTransactionView('all');changeTab('transactions');
    window.requestAnimationFrame(()=>{ledgerRef.current?.focus({preventScroll:true});ledgerRef.current?.scrollIntoView({block:'start'});});
  }
  function clearFilters() { setQuery('');setCategoryFilter('all');setAccountFilter('all');setKindFilter('all');setDateFilter('all'); }
  function showTransactions() { clearFilters();setDateFilter('month');setKindFilter('expense');setTransactionView('all');changeTab('transactions'); }
  function showTransaction(id:string,trigger:HTMLButtonElement) {
    if(!readOnly){detailTrigger.current=trigger;setDetail(id);return;}
    const transaction=state.transactions.find(row=>row.id===id);
    clearFilters();setQuery(transaction?transactionLabel(transaction):'');setDateFilter('month');setKindFilter('expense');setTransactionView('all');changeTab('transactions');
  }
  function reviewPlanCategories() { setTransactionView('categories');changeTab('transactions');setError('');window.requestAnimationFrame(()=>categoryReviewButtonRef.current?.focus({preventScroll:true})); }
  function editCategory(transaction:Transaction) { if(readOnly||!activeExpenseIds.has(transaction.id))return;setCategoryEdit({id:transaction.id,description:transactionLabel(transaction),expected:transaction.category,expectedExpenseCategory:transaction.expenseCategory??null,value:isUncategorized(transaction.category)?'':transaction.category}); }
  async function saveCategory(category:string) {
    if(!categoryEdit||readOnly)return;
    if(categoryEditConflict)throw new Error('This transaction changed. Reload its category before saving.');
    const change={id:categoryEdit.id,expectedCategory:categoryEdit.expected,expectedExpenseCategory:categoryEdit.expectedExpenseCategory,category,expenseCategory:category};
    const previous=reviewSession.attempt;
    const requestId=previous&&!previous.undo&&JSON.stringify(previous.changes)===JSON.stringify([change])?previous.requestId:crypto.randomUUID();
    updateCategoryReviewSession(state.workspace,session=>({...session,attempt:{changes:[change],requestId,undo:false}}));
    await onCommand({type:'categorize_transactions',changes:[change],requestId,expectedRevision:state.revision});
    updateCategoryReviewSession(state.workspace,session=>session.attempt?.requestId!==requestId?session:({...session,selections:Object.fromEntries(Object.entries(session.selections).filter(([id])=>id!==change.id)),lastSave:[change],attempt:undefined}));
  }
  async function undoCategory() {
    if(!reviewSession.lastSave||pending||readOnly)return;
    const changes=reverseCategoryChanges(reviewSession.lastSave);
    const requestId=reviewSession.attempt?.undo&&JSON.stringify(reviewSession.attempt.changes)===JSON.stringify(changes)?reviewSession.attempt.requestId:crypto.randomUUID();
    updateCategoryReviewSession(state.workspace,session=>({...session,attempt:{changes,requestId,undo:true}}));
    setPending('category-undo');setError('');
    try {
      await onCommand({type:'categorize_transactions',changes,requestId,expectedRevision:state.revision});
      updateCategoryReviewSession(state.workspace,session=>session.attempt?.requestId!==requestId?session:({...session,lastSave:null,attempt:undefined}));
    } catch(caught){setError(caught instanceof Error?caught.message:'Could not undo the category change.');}
    finally{setPending('');}
  }
  function chooseTab(value:Tab) { setTab(value);setError(''); }
  function changeTab(value:Tab) { if(onSectionChange)onSectionChange(value==='transactions'?'activity':value==='schedule'?'schedule':value==='plan'?'plan':undefined);else requestDraftNavigation(()=>chooseTab(value)); }
  function exportEntries() {
    const url=URL.createObjectURL(new Blob([ledgerCSV(state,rows,selectedAccount,ledgerScope)],{type:'text/csv;charset=utf-8;'}));
    const link=document.createElement('a');link.href=url;link.download=`mazal-${state.workspace}-entries-${dateFilter==='all'?'all-dates':month}.csv`;
    document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function confirm(id:string) {
    if(readOnly||pending)return;
    const payment=state.obligations.find(o=>o.id===id);
    if(!payment){setError('This payment is no longer available. Refresh the schedule.');return;}
    setPayment(id);setError('');
  }
  return <div className="expense-page expense-refresh expense-workspace expense-redesign">
    <div className="expense-workspace-toolbar expense-plan-toolbar"><nav className="expense-workspace-nav" aria-label="Expense views"><button type="button" aria-pressed={tab==='spending'} onClick={()=>changeTab('spending')}>Overview</button><button type="button" aria-pressed={tab==='schedule'} onClick={()=>changeTab('schedule')}>Bills</button><button type="button" aria-pressed={tab==='plan'} onClick={()=>changeTab('plan')}>Budget</button><button type="button" aria-pressed={tab==='transactions'} onClick={()=>changeTab('transactions')}>Transactions</button></nav>{!readOnly&&tab==='plan'&&planReviewCount>0&&<div className="expense-workspace-actions"><button type="button" className="text-button expense-review-shortcut" onClick={reviewPlanCategories}>Categorize <span>{planReviewCount}</span></button></div>}</div>
    {tab==='transactions'&&<nav className="expense-transaction-nav" aria-label="Transaction views"><button type="button" aria-pressed={transactionView==='all'} onClick={()=>{if(transactionView!=='all')requestDraftNavigation(()=>{setTransactionView('all');setError('');});}}>All transactions</button><button type="button" ref={categoryReviewButtonRef} aria-label="Categorize transactions" aria-pressed={transactionView==='categories'} onClick={reviewPlanCategories}>Categorize {planReviewCount>0&&<span>{planReviewCount}</span>}</button></nav>}
    {(tab!=='transactions'||transactionView!=='categories')&&reviewSession.lastSave&&<div className="category-review-result"><p role="status">Category changes saved.</p><button type="button" className="text-button" disabled={!!pending||readOnly||!reviewSession.lastSave.every(change=>matchesCategoryChange(state.transactions.find(row=>row.id===change.id),change))} onClick={()=>void undoCategory()}>Undo last save</button></div>}
    {error&&<p className="expense-error" role="alert">{error}</p>}
    {tab==='spending'&&<ExpenseDashboard state={state} ownerId={planOwner} month={month} onMonth={chooseMonth} onTransactions={showTransactions} onCategory={chooseCategory} onTransaction={showTransaction} onSchedule={()=>changeTab('schedule')} onBudget={()=>changeTab('plan')} readOnly={readOnly} onAddBill={()=>{setBillDraft(null);setAddingBill(true);}} onBill={bill=>{
      if(readOnly){changeTab('schedule');return;}
      if(bill.sourceType==='obligation')setRequestedBill(state.obligations.find(item=>item.id===bill.sourceId)??null);
      else if(bill.sourceType==='recorded'&&bill.amountCents!==null){setBillDraft({name:bill.name,amountCents:bill.amountCents,category:bill.category,requireRecurrence:true,subscription:bill.subscription});setAddingBill(true);}
    }}/>}
    <div hidden={tab!=='plan'} className="expense-month-workspace">
      <ExpensePlan state={state} scope={planOwner} month={month} readOnly={readOnly} onCommand={onCommand} onCategory={chooseCategory} onEditCategory={editCategory}
        overview={<ExpenseOverview state={state} ownerId={planOwner} month={month} onMonth={chooseMonth} onTransactions={showTransactions}/>}
        renderCategoryContent={row=>row.key==='bills'?<ExpenseBills state={state} scope={planOwner} readOnly={readOnly} onCommand={onCommand} onPay={confirm} pending={pending} embedded/>:row.key==='subscriptions'?<Subscriptions state={state} scope={planOwner} readOnly={readOnly} pending={pending} onCommand={onCommand} onPay={confirm} embedded/>:row.key==='transport'?<p className="expense-car-note">Car payments and repairs build your car equity. Gas stays here as an expense. <a href="#assets">Record car payment or repair <Icon name="arrow" size={14}/></a></p>:null}/>
    </div>
    {tab==='transactions'&&transactionView==='all'&&<section id="expense-transactions-panel" ref={ledgerRef} className="night-glass expense-ledger" aria-label="Transactions" tabIndex={-1}>
        <div className="expense-card-heading"><div><h2>Transactions</h2><p aria-live="polite">{filtered?`${rows.length} of ${transactionCount}`:transactionCount} {transactionCount===1?'transaction':'transactions'} · {dateFilter==='all'?'All dates':monthLabel}</p></div><div className="ledger-heading-actions">{filtered&&<button className="text-button" onClick={clearFilters}>Reset {activeFilterCount} {activeFilterCount===1?'filter':'filters'}</button>}</div></div>
        <div className="ledger-search-tools">
          <div className="search-box"><Icon name="search" size={17}/><input ref={searchRef} aria-label="Search transactions" placeholder="Search transactions" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button type="button" className="ledger-search-clear" aria-label="Clear transaction search" title="Clear search" onClick={()=>{setQuery('');searchRef.current?.focus();}}><Icon name="close" size={14}/></button>}</div>
          <details ref={filterDetails} className="ledger-filter-details"><summary>Filters{activeFilters.some(filter=>filter.key!=='search')&&<span>{activeFilters.filter(filter=>filter.key!=='search').length}</span>}<Icon name="down" size={14}/></summary><div className="expense-ledger-tools ledger-filters">
          <label className="ledger-filter"><span>Dates</span><select aria-label="Transaction date range" value={dateFilter} onChange={e=>setDateFilter(e.target.value as 'month'|'all')}><option value="month">Selected month</option><option value="all">All dates</option></select></label>
          {dateFilter==='month'&&<label className="ledger-filter"><span>Month</span><input type="month" aria-label="Transaction month" value={month} onChange={e=>chooseMonth(e.target.value)}/></label>}
          <label className="ledger-filter"><span>Account</span><select aria-label="Transaction account" value={selectedAccount} onChange={e=>setAccountFilter(e.target.value)}><option value="all">All accounts</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label className="ledger-filter"><span>Type</span><select aria-label="Transaction type" value={kindFilter} onChange={e=>{setKindFilter(e.target.value as TransactionKind|'all');setCategoryFilter('all');}}><option value="all">All transactions</option>{(Object.entries(transactionLabels) as [TransactionKind,string][]).map(([kind,label])=><option key={kind} value={kind}>{kind==='adjustment'?'Other account entries':label}</option>)}</select></label>
          {(kindFilter==='all'||kindFilter==='expense')&&<label className="ledger-filter"><span>Expense category</span><select aria-label="Expense category" value={selectedCategory} onChange={e=>{setCategoryFilter(e.target.value);if(e.target.value!=='all')setKindFilter('expense');}}><option value="all">All categories</option><option value={uncategorizedFilter}>Uncategorized</option>{ledgerCategories.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>}
          </div></details>
        </div>
        {filtered&&<div className="ledger-active-filters" role="group" aria-label="Active transaction filters">{activeFilters.map(filter=><button type="button" key={filter.key} className="ledger-filter-chip" aria-label={`Remove ${filter.label.toLowerCase()} filter: ${filter.value}`} title={`Remove ${filter.label.toLowerCase()} filter: ${filter.value}`} onClick={()=>{filter.clear();if(filter.key!=='search'&&filterDetails.current)filterDetails.current.open=true;ledgerRef.current?.querySelector<HTMLElement>(`[aria-label="${filter.control}"]`)?.focus();}}><span>{filter.label}</span><strong>{filter.value}</strong><Icon name="close" size={12}/></button>)}</div>}
        {reviewCount>0&&<div className="expense-category-review ledger-category-review"><p>{reviewCount} uncategorized {reviewCount===1?'transaction':'transactions'} in this view.</p><button type="button" className="button secondary compact" onClick={reviewPlanCategories}>Categorize transactions</button></div>}
        <details className="ledger-totals-details"><summary>Totals and export<Icon name="down" size={14}/></summary><dl className="ledger-totals" aria-label="Totals for filtered transactions">{(['expense','income','transfer','debt_payment'] as const).filter(kind=>totals[kind].count>0).map(kind=><div key={kind}><dt>{kind==='expense'?'Expenses':kind==='income'?'Income':kind==='transfer'?'Transfers':'Debt payments'}</dt><dd>{money(totals[kind].amountCents)}</dd><small>{totals[kind].count} {totals[kind].count===1?'entry':'entries'}</small></div>)}{totals.opening.count>0&&<div><dt>Opening balances</dt><dd>{money(totals.opening.amountCents)}</dd><small>{totals.opening.count} {totals.opening.count===1?'entry':'entries'}</small></div>}{sourceMovements.length>0&&<div><dt>Statement account movements</dt><dd>{sourceMovements.length}</dd><small>Source entries may include both sides. Amounts are not combined.</small></div>}{totals.adjustment.count>0&&<div><dt>Other account entries</dt><dd>{totals.adjustment.count}</dd></div>}</dl><button type="button" className="text-button ledger-export" disabled={!rows.length} onClick={exportEntries} aria-label={`Export ${rows.length} filtered transactions to CSV`}>Export CSV<Icon name="arrow" size={14}/></button></details>
        {(rows.length?<div className="expense-rows">{ledgerDays.map(day=><section className="ledger-day" key={day.date} aria-label={`Transactions for ${day.date}`}><header className="ledger-day-heading"><h3><time dateTime={day.date}>{day.date===currentDay?'Today':ledgerDateLabel(day.date)}</time></h3><span>{day.rows.length} {day.rows.length===1?'entry':'entries'} on this page</span></header>{day.rows.map(t=>{
          const direction=ledgerDirection(t,selectedAccount,ids);
          return <div className="expense-entry" key={t.id} data-record-id={t.id}><span className={`expense-entry-icon ${t.kind}`}><Icon name={t.kind==='income'?'down':t.kind==='expense'?'wallet':'arrow'} size={18}/></span><span className="expense-entry-copy"><strong>{transactionLabel(t)}</strong>{t.displayName&&<small className="expense-entry-original">{t.description}</small>}{t.note&&<small className="expense-entry-note">{t.note}</small>}{!readOnly&&<button type="button" className="text-button" onClick={event=>showTransaction(t.id,event.currentTarget)} aria-label={`View record for ${transactionLabel(t)}`}>Details</button>}<small>{state.accounts.find(a=>a.id===t.accountId)?.name}{t.toAccountId?` → ${accountNames.get(t.toAccountId)??'Asset purchase'}`:''}<span className="expense-mobile-date"> · {ledgerDateLabel(t.date)}</span>{t.date>currentDay?' · Future-dated':''}</small>{(t.statementId||!!t.importSources?.length)&&<details className="ledger-entry-source-details"><summary>Source</summary><small className="expense-entry-source">{t.source}{t.postingDate?` · Posted ${ledgerDateLabel(t.postingDate)}`:''}</small></details>}{t.kind==='expense'&&!t.reversalOf&&!activeExpenseIds.has(t.id)&&<small>{correctedIds.has(t.id)?'Corrected · Previous entry canceled':'Reversed · Entry canceled'}</small>}{activeExpenseIds.has(t.id)&&!readOnly&&<button className="expense-category-action" aria-label={`Edit category for ${transactionLabel(t)} on ${t.date}`} onClick={()=>editCategory(t)}>{isUncategorized(t.category)?'Categorize':`${t.category} · Edit`}</button>}</span><span className="expense-entry-category">{t.kind==='expense'?readOnly?t.category||'Uncategorized':'':transactionDisplayLabel(t)}</span><span className="expense-entry-date">{ledgerDateLabel(t.date)}</span><span className={`ledger-entry-amount ${direction==='In'?'positive':''}`}><strong>{direction==='Out'||direction==='Decrease'?'−':direction==='In'||direction==='Increase'?'+':direction==='Transfer'?'↔ ':''}{money(Math.abs(t.amountCents))}</strong>{t.kind==='adjustment'&&<small>{transactionDisplayLabel(t)}</small>}{t.kind==='expense'&&t.amountCents<0&&<small>{t.reversalOf?'Reversal':'Refund'}</small>}{t.kind==='debt_payment'&&<small>{transactionDisplayLabel(t)}</small>}</span></div>;
        })}</section>)}</div>:<div className="expense-friendly-empty"><h3>{reviewingCategories?'No uncategorized transactions in this view':transactionCount===0?'No transactions recorded':'No matching transactions'}</h3>{transactionCount>0?<><p>{query.trim()?'Clear the search or remove a filter to see more transactions.':'Remove a filter to see more transactions.'}</p><button className="text-button" onClick={clearFilters}>Show all transactions</button></>:<>{!readOnly&&<button className="text-button" onClick={()=>onOpen('transaction')}>Add transaction <Icon name="plus" size={14}/></button>}</>}</div>)}
        {rows.length>pageSize&&<nav className="ledger-pagination" aria-label="Transaction pages"><button type="button" className="button secondary compact" disabled={page===0} onClick={()=>setPageSelection({filters:pageFilters,page:page-1})}>Previous</button><span aria-live="polite">{page*pageSize+1} to {Math.min((page+1)*pageSize,rows.length)} of {rows.length}</span><button type="button" className="button secondary compact" disabled={page===lastPage} onClick={()=>setPageSelection({filters:pageFilters,page:page+1})}>Next</button></nav>}
    </section>}
    {tab==='transactions'&&transactionView==='categories'&&<div className="night-glass expense-category-panel"><CategoryReview state={state} rows={planReviewTransactions} readOnly={readOnly} onCommand={onCommand}/></div>}
    {addingBill&&!readOnly&&<BillEditor state={state} scope={planOwner} embedded recurring draft={billDraft??undefined} onCommand={onCommand} onClose={()=>setAddingBill(false)}/>}
    {requestedBill&&!readOnly&&<BillEditor state={state} scope={planOwner} obligation={requestedBill} onCommand={onCommand} onClose={()=>setRequestedBill(null)}/>}
    {payment&&!readOnly&&state.obligations.some(item=>item.id===payment)&&<PaymentRecorder state={state} obligation={state.obligations.find(item=>item.id===payment)!} onCommand={onCommand} onClose={()=>setPayment(null)}/>}
    {detail&&!readOnly&&state.transactions.some(item=>item.id===detail)&&<TransactionEditor state={state} transaction={state.transactions.find(item=>item.id===detail)!} returnFocusTo={detailTrigger.current} onCommand={onCommand} onClose={()=>setDetail(null)}/>}
    {categoryEdit&&!readOnly&&<CategoryPicker title="Choose category" context={`${categoryEdit.description}${editedTransaction?` · ${ledgerDateLabel(editedTransaction.date)} · ${money(editedTransaction.amountCents)}`:''}`} value={categoryEdit.value} options={editCategories} onChoose={saveCategory} onClose={()=>setCategoryEdit(null)} conflict={categoryEditConflict?categoryEditCanceled?<p>This entry was canceled. Review its linked records in transaction details.</p>:<><p>Current category: {editedTransaction?.category||'Transaction unavailable'}.</p>{editedTransaction&&<button type="button" className="text-button" onClick={()=>editCategory(editedTransaction)}>Reload category</button>}</>:undefined}/>}
    {tab==='schedule'&&<ExpenseSchedule state={state} scope={planOwner} readOnly={readOnly} onCommand={onCommand} onPay={confirm} pending={pending}/>}
  </div>;
}
