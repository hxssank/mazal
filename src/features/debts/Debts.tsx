import { transactionLabel } from '../../../shared/transaction-label.ts';
import { useEffect, useRef, useState } from 'react';
import type { Account, AppState, Command } from '../../../shared/types.ts';
import { money, today } from '../../../shared/analytics.ts';
import { debtRepaymentKind } from '../../../shared/debt-model.ts';
import type { EngineSummary } from '../../../shared/engine.ts';
import type { DebtOverviewRow } from '../../../shared/debt-overview.ts';
import { useEngineDate, useEngineSummary } from '../../services/useEngine.ts';
import EngineStatus from '../../components/EngineStatus.tsx';
import { loanGuideFor } from '../../../shared/loan-guidance.ts';
import { isStatementCardPayment } from '../../../shared/ledger.ts';
import Icon from '../../components/Icon.tsx';
import AnimatedValue from '../../components/AnimatedValue.tsx';
import DebtResearch from './DebtResearch.tsx';
import DebtScenario from './DebtScenario.tsx';
import { requestDraftNavigation } from '../../hooks/draft-protection.ts';
import { AccountEditor } from '../../components/RecordActions.tsx';
import './debts-refresh.css';
import './debt-layout.css';
import './debt-review.css';
import '../../styles/organized-accounts.css';

interface Props {
  state: AppState;
  scope: string;
  readOnly: boolean;
  onCommand: (command: Command) => Promise<void>;
  onOpen: (kind: 'transaction'|'account'|'reconcile', accountId?: string) => void;
}

type DebtFilter = 'all' | 'due' | 'attention' | 'deferred' | 'settled';
type DebtSort = 'priority' | 'balance' | 'date';
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function reviewReason(row: DebtOverviewRow, asOf: string): string | null {
  if (row.balanceCents <= 0 || row.paymentStatus === 'in_study') return null;
  if (row.paymentStatus === 'needs_confirmation') return 'Confirm when payments resume';
  if (row.dueDate && row.dueDate < asOf) return 'Past date. Check the latest statement';
  if (row.requiredPaymentCents === null) return 'Confirm the payment amount';
  if (!row.dueDate) return 'Add the next payment date';
  if (row.confirmedApr === null) return 'Confirm the interest rate';
  if (row.monthlyInterestCents !== null && row.requiredPaymentCents > 0 && row.requiredPaymentCents < row.monthlyInterestCents && debtRepaymentKind(row.account) !== 'one_off') return 'Saved payment is below estimated interest';
  return null;
}

export default function Debts(props: Props) {
  const asOf = useEngineDate();
  const engine = useEngineSummary(props.state, props.scope, asOf);
  const retained = useRef<{ key: string; data: EngineSummary } | null>(null);
  const key = `${props.state.workspace}-${props.scope}`;
  if (engine.data) retained.current = { key, data: engine.data };
  const data = engine.data ?? (retained.current?.key === key ? retained.current.data : null);
  const debts = props.state.accounts.filter(account => (props.scope === 'all' || account.entityId === props.scope) && ['debt', 'payable'].includes(account.type));
  const recordedAccounts = <div className="debt-refresh debt-layout"><section className="night-glass debt-overview" aria-label="Debt overview"><EngineStatus {...engine}/></section><section className="night-glass debt-account-map"><h2>Recorded debts</h2>{debts.filter(account => !account.closedAt).map(account => <div className="debt-payment-row" key={account.id}><strong>{account.name}</strong><span>{money(account.balanceCents)}</span>{!props.readOnly && <button type="button" className="text-button" onClick={() => props.onOpen('reconcile', account.id)}>Update balance</button>}</div>)}{!props.readOnly && <button type="button" className="text-button" onClick={() => props.onOpen('account')}>Add debt</button>}</section><ClosedDebtHistory {...props} accounts={debts.filter(account => account.closedAt)}/></div>;
  return <>{!engine.data && recordedAccounts}{data && <div hidden={!engine.data} style={{ display: engine.data ? undefined : 'none' }}><DebtContent key={key} {...props} engine={data}/></div>}</>;
}

function DebtContent({state,scope,readOnly,onCommand,onOpen,engine}:Props & { engine: EngineSummary }) {
  const asOf=today();
  const recordedDebt=state.accounts.filter(account=>(scope==='all'||account.entityId===scope)&&['debt','payable'].includes(account.type));
  const debt=recordedDebt.filter(account=>!account.closedAt);
  const closedDebt=recordedDebt.filter(account=>account.closedAt);
  const overview=engine.debtOverview;
  const activeIds=new Set(debt.map(account=>account.id));
  const rows=overview.rows.filter(row=>activeIds.has(row.accountId));
  const deferred=rows.filter(row=>row.paymentStatus==='in_study');
  const [requestedId]=useState(()=>new URLSearchParams(window.location.hash.split('?')[1]).get('record'));
  const [showDeferred,setShowDeferred]=useState(()=>deferred.some(row=>row.accountId===requestedId));
  const visibleRows=rows.filter(row=>showDeferred||row.paymentStatus!=='in_study');
  const [filter,setFilter]=useState<DebtFilter>('all');
  const [search,setSearch]=useState('');
  const [sort,setSort]=useState<DebtSort>('priority');
  const [selectedId,setSelectedId]=useState(()=>rows.some(row=>row.accountId===requestedId)?requestedId!:overview.highestRateAccountId??visibleRows[0]?.accountId??'');
  const [reviewRequest,setReviewRequest]=useState(0);
  const [showAllPayments,setShowAllPayments]=useState(false);
  const [manageAccountId,setManageAccountId]=useState<string|null>(null);
  const focusFrame=useRef(0);
  const accountList=useRef<HTMLElement>(null);
  const searchInput=useRef<HTMLInputElement>(null);
  const managedAccount=state.accounts.find(account=>account.id===manageAccountId);
  const selected=visibleRows.find(row=>row.accountId===selectedId)?.account??visibleRows[0]?.account;
  const weekEnd=new Date(`${asOf}T12:00:00Z`);weekEnd.setUTCDate(weekEnd.getUTCDate()+6);
  const nextWeek=weekEnd.toISOString().slice(0,10);
  const dueSoon=(row:DebtOverviewRow)=>row.balanceCents>0&&row.paymentStatus!=='in_study'&&!!row.dueDate&&row.dueDate>=asOf&&row.dueDate<=nextWeek;
  const dueThisWeek=rows.filter(dueSoon);
  const knownWeeklyPayments=dueThisWeek.filter(row=>row.requiredPaymentCents!==null);
  const weeklyPaymentTotal=knownWeeklyPayments.reduce((sum,row)=>sum+row.requiredPaymentCents!,0);
  const attentionRows=rows.filter(row=>reviewReason(row,asOf));
  const filters:{id:DebtFilter;label:string;count:number}[]=[
    {id:'all',label:'Open accounts',count:visibleRows.length},
    {id:'due',label:'Next 7 days',count:rows.filter(dueSoon).length},
    {id:'attention',label:'Check details',count:attentionRows.length},
    {id:'deferred',label:'Deferred',count:deferred.length},
    {id:'settled',label:'Paid off',count:rows.filter(row=>row.balanceCents===0).length},
  ];
  const filteredRows=rows.filter(row=>{
    if(filter==='all'&&!showDeferred&&row.paymentStatus==='in_study')return false;
    if(filter==='due'&&!dueSoon(row))return false;
    if(filter==='attention'&&!reviewReason(row,asOf))return false;
    if(filter==='deferred'&&row.paymentStatus!=='in_study')return false;
    if(filter==='settled'&&row.balanceCents!==0)return false;
    return row.account.name.toLocaleLowerCase('en-CA').includes(search.trim().toLocaleLowerCase('en-CA'));
  }).sort((a,b)=>sort==='balance'?b.balanceCents-a.balanceCents||a.account.name.localeCompare(b.account.name):sort==='date'?(a.dueDate??'9999-12-31').localeCompare(b.dueDate??'9999-12-31')||a.account.name.localeCompare(b.account.name):(b.confirmedApr??-1)-(a.confirmedApr??-1)||b.balanceCents-a.balanceCents||a.account.name.localeCompare(b.account.name));
  const nextDates=rows.filter(row=>row.balanceCents>0&&row.paymentStatus!=='in_study'&&row.dueDate&&row.dueDate>=asOf).sort((a,b)=>a.dueDate!.localeCompare(b.dueDate!)).slice(0,3);
  const pastDates=rows.filter(row=>row.balanceCents>0&&row.paymentStatus!=='in_study'&&row.dueDate&&row.dueDate<asOf);
  const nextReview=pastDates[0]??nextDates[0]??attentionRows[0];
  const maxBalance=Math.max(1,...rows.map(row=>row.balanceCents));
  const maxInterest=Math.max(1,...rows.map(row=>row.monthlyInterestCents??0));
  const priority=rows.find(row=>row.accountId===overview.highestRateAccountId);
  const activeBalances=rows.filter(row=>row.balanceCents>0&&row.paymentStatus!=='in_study');
  const rateToConfirm=activeBalances.find(row=>row.confirmedApr===null);
  const deferredOnly=overview.debtCents>0&&activeBalances.length===0;
  const largest=rows.find(row=>row.accountId===overview.largestBalanceAccountId);
  const comparisonReduction=engine.priorityComparison.reductionCents;
  const debtIds=new Set(debt.map(account=>account.id));
  const cardMovements=state.transactions.filter(transaction=>isStatementCardPayment(transaction)&&debtIds.has(transaction.accountId)&&transaction.date<=today());
  const movementEffect=(transaction:typeof state.transactions[number])=>transaction.balanceChanges?.[transaction.accountId]??(transaction.statementId?-Math.abs(transaction.amountCents):0);
  const reversals=cardMovements.filter(transaction=>movementEffect(transaction)>0);
  const payments=[...state.transactions.filter(transaction=>transaction.kind==='debt_payment'&&transaction.toAccountId&&debtIds.has(transaction.toAccountId)&&transaction.date<=today()),...cardMovements.filter(transaction=>movementEffect(transaction)<0)].sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt));
  const currentMonth=today().slice(0,7);
  const paidThisMonth=engine.debtPaymentSummary.paidThisMonthCents;
  const reversedThisMonth=engine.debtPaymentSummary.reversedThisMonthCents;
  const reversedIds=new Set([...reversals, ...payments.filter(payment=>payment.reversalOf)].map(payment=>payment.id));
  const selectedPayments=[...payments,...reversals].filter(payment=>(payment.toAccountId??payment.accountId)===selected?.id).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt));
  useEffect(()=>{if(requestedId&&rows.some(row=>row.accountId===requestedId))applySelection(requestedId,false);return()=>window.cancelAnimationFrame(focusFrame.current);},[requestedId]);

  function selectDebt(id:string,reviewTerms=false) {
    if(id!==selected?.id){requestDraftNavigation(()=>applySelection(id,reviewTerms));return;}
    applySelection(id,reviewTerms);
  }
  function applySelection(id:string,reviewTerms:boolean) {
    setSelectedId(id);setShowAllPayments(false);
    if(deferred.some(row=>row.accountId===id))setShowDeferred(true);
    setReviewRequest(value=>reviewTerms?value+1:0);
    window.cancelAnimationFrame(focusFrame.current);
    focusFrame.current=window.requestAnimationFrame(()=>{
      const panel=document.getElementById('debt-payoff');
      const shell=panel?.closest<HTMLElement>('.app-shell');
      const toolbar=shell?.querySelector<HTMLElement>('.glass-toolbar');
      const heading=panel?.closest<HTMLElement>('.debt-review-detail')?.querySelector<HTMLElement>('.debt-scenario-heading')??panel;
      if(heading&&toolbar)heading.style.scrollMarginTop=`${Math.max(0,toolbar.getBoundingClientRect().bottom)+12}px`;
      panel?.focus({preventScroll:true});
      heading?.scrollIntoView({block:'nearest',behavior:shell?.dataset.motion==='off'||window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    });
  }

  function showFilter(value:DebtFilter) {
    setFilter(value);setSearch('');
    accountList.current?.scrollIntoView({block:'nearest',behavior:'instant'});
  }

  function showSelectedAccount() {
    setFilter('all');setSearch('');
    if(deferred.some(row=>row.accountId===selected?.id))setShowDeferred(true);
    window.requestAnimationFrame(()=>accountList.current?.querySelector<HTMLButtonElement>('.debt-account-choice.is-selected')?.focus());
  }

  return <div className="debt-refresh debt-layout debt-review">
    {debt.length>0?<>
      <section className="night-glass debt-overview" aria-label="Debt overview" data-motion-enter>
        <div className="debt-total"><span className="debt-kicker">Total owed</span><strong><AnimatedValue value={overview.debtCents}/></strong><p>{debt.length} {debt.length===1?'account':'accounts'}{overview.creditCents>0?` · ${money(overview.creditCents)} in account credits`:''}</p>
          {overview.debtCents>0&&<><div className="debt-balance-split" aria-hidden="true"><span style={{width:`${(overview.debtCents-overview.deferredCents)/overview.debtCents*100}%`}}/><span className="is-deferred" style={{width:`${overview.deferredCents/overview.debtCents*100}%`}}/></div><div className="debt-balance-key"><span><i/>{money(overview.debtCents-overview.deferredCents)} not deferred</span>{overview.deferredCents>0&&<span><i className="is-deferred"/>{money(overview.deferredCents)} deferred</span>}</div></>}
        </div>
        <div className="debt-summary-metric debt-interest-total"><span>Estimated interest / month</span><strong>{overview.unknownInterestCount>0&&overview.monthlyInterestCents===0?'Not confirmed':<AnimatedValue value={overview.monthlyInterestCents}/>}</strong><p>At current balances and confirmed rates.{overview.unknownInterestCount>0?` ${overview.unknownInterestCount} ${overview.unknownInterestCount===1?'account excluded until its interest is':'accounts excluded until their interest is'} confirmed.`:''}</p></div>
        <div className="debt-summary-metric"><span>Paid this month</span><strong className="debt-teal"><AnimatedValue value={paidThisMonth}/></strong><p>{new Date(`${currentMonth}-01T12:00:00`).toLocaleDateString('en-CA',{month:'long',year:'numeric'})}{reversedThisMonth>0?` · ${money(reversedThisMonth)} in payment reversals shown separately.`:''}</p></div>
      </section>
      <section className="debt-payment-brief" aria-label="Payment outlook" data-motion-enter>
        <div className="debt-weekly-total"><span>Saved payments in the next 7 days</span><strong>{dueThisWeek.length ? knownWeeklyPayments.length ? <AnimatedValue value={weeklyPaymentTotal}/> : 'Amount needed' : 'No saved dates'}</strong><p>{dueThisWeek.length ? `${knownWeeklyPayments.length} of ${dueThisWeek.length} payment amounts recorded${knownWeeklyPayments.length < dueThisWeek.length ? '. Missing amounts are excluded.' : '.'}` : 'Add payment dates from your latest statements.'}</p></div>
        {nextReview ? <button type="button" className={`debt-next-payment${pastDates.length ? ' needs-review' : ''}`} onClick={()=>selectDebt(nextReview.accountId,!!reviewReason(nextReview,asOf))}><span className="debt-next-payment-icon"><Icon name={pastDates.length?'info':'plan'} size={20}/></span><span><small>{pastDates.length ? 'Check a past payment date' : nextReview.dueDate && nextReview.dueDate>=asOf ? `Next saved date · ${shortDate(nextReview.dueDate)}` : 'Complete account details'}</small><strong>{nextReview.account.name}</strong><span>{pastDates.length ? 'Confirm the payment or update the saved date.' : nextReview.requiredPaymentCents===null ? 'Confirm the amount with your lender.' : nextReview.dueDate && nextReview.dueDate>=asOf ? `${money(nextReview.requiredPaymentCents)} saved payment · review account` : reviewReason(nextReview,asOf)}</span></span><Icon name="arrow" size={17}/></button> : <div className="debt-payment-brief-note"><Icon name="check" size={20}/><p>{deferredOnly ? 'Payments are deferred. These balances remain in total debt.' : overview.debtCents===0 ? 'No balance owed on your open accounts.' : 'Review saved terms when your next statement arrives.'}</p></div>}
      </section>
      <section className="debt-review-checkpoints" aria-label="Debt review shortcuts" data-motion-enter>
        <div className="debt-review-period"><span className="debt-kicker">Weekly check</span><strong>{shortDate(asOf)} to {shortDate(nextWeek)}</strong></div>
        <button type="button" className={filter==='due'?'is-active':''} onClick={()=>showFilter('due')}><span className="debt-review-check-icon"><Icon name="plan" size={18}/></span><span><strong>{rows.filter(dueSoon).length} payment {rows.filter(dueSoon).length===1?'date':'dates'}</strong><small>Saved for the next 7 days</small></span><Icon name="arrow" size={15}/></button>
        <button type="button" className={`debt-review-check-details${filter==='attention'?' is-active':''}`} onClick={()=>showFilter('attention')}><span className="debt-review-check-icon"><Icon name="info" size={18}/></span><span><strong>{attentionRows.length} {attentionRows.length===1?'account':'accounts'} to check</strong><small>Dates, rates or payment amounts</small></span><Icon name="arrow" size={15}/></button>
        <button type="button" className={filter==='deferred'?'is-active':''} onClick={()=>showFilter('deferred')}><span className="debt-review-check-icon"><Icon name="clock" size={18}/></span><span><strong>{deferred.length} deferred</strong><small>{money(overview.deferredCents)} remains owed</small></span><Icon name="arrow" size={15}/></button>
      </section>
      <div className="debt-review-workspace">
      <section ref={accountList} className="night-glass debt-account-map" aria-label="Choose a debt account"><div className="debt-section-heading"><div><span className="debt-kicker">Accounts</span><h2>Choose a debt</h2></div><div className="debt-account-heading-actions"><span>{rows.length}</span>{!readOnly&&<button type="button" className="text-button" onClick={()=>onOpen('account')}>Add debt<Icon name="plus" size={14}/></button>}</div></div>
        <div className="debt-review-search"><Icon name="search" size={16}/><input ref={searchInput} type="search" aria-label="Search debt accounts" placeholder="Search accounts" value={search} onChange={event=>setSearch(event.target.value)}/>{search&&<button type="button" aria-label="Clear debt search" onClick={()=>{setSearch('');searchInput.current?.focus();}}><Icon name="close" size={14}/></button>}</div>
        <div className="debt-review-filters" role="group" aria-label="Filter debt accounts">{filters.filter(item=>item.count>0||item.id==='all'||item.id===filter).map(item=><button type="button" key={item.id} aria-pressed={filter===item.id} onClick={()=>setFilter(item.id)}>{item.label}<span>{item.count}</span></button>)}</div>
        <div className="debt-review-list-heading"><span aria-live="polite">{filteredRows.length} {filteredRows.length===1?'account':'accounts'}</span><label>Sort<select aria-label="Sort debt accounts" value={sort} onChange={event=>setSort(event.target.value as DebtSort)}><option value="priority">Highest APR</option><option value="balance">Largest balance</option><option value="date">Payment date</option></select></label></div>
        <div className="debt-account-choices">{filteredRows.map(row=>{
          const account=row.account;
          const paymentBelowInterest=row.monthlyInterestCents!==null&&row.requiredPaymentCents!==null&&row.requiredPaymentCents>0&&row.requiredPaymentCents<row.monthlyInterestCents&&row.paymentStatus==='repaying'&&debtRepaymentKind(account)!=='one_off';
          return <button type="button" key={account.id} className={`debt-account-choice${account.id===selected?.id?' is-selected':''}`} aria-pressed={account.id===selected?.id} aria-label={`${account.name}. ${account.balanceCents<0?`${money(-account.balanceCents)} credit`:`${money(row.balanceCents)} owed`}. ${row.confirmedApr===null?'Interest rate not confirmed':`${Number(row.confirmedApr.toFixed(2))}% APR`}. ${row.monthlyInterestCents===null?'Monthly interest not confirmed':`${money(row.monthlyInterestCents)} estimated monthly interest`}${paymentBelowInterest?'. Saved payment is below estimated interest':''}`} onClick={()=>selectDebt(account.id)}>
            <span className="debt-map-name"><strong>{account.name}</strong><small>{account.balanceCents<0?'Credit balance':account.balanceCents===0?'Paid off':row.confirmedApr===null?'Interest not confirmed':`${Number(row.confirmedApr.toFixed(2))}% APR confirmed`}{row.paymentStatus==='in_study'?' · Payments deferred':''}</small>{paymentBelowInterest&&<span className="debt-map-warning">Saved payment is below estimated interest</span>}</span>
            <span className="debt-map-value debt-map-balance"><small>Balance owed</small><strong>{account.balanceCents<0?`${money(-account.balanceCents)} credit`:money(row.balanceCents)}</strong><span className="debt-map-track" aria-hidden="true"><i style={{width:`${row.balanceCents/maxBalance*100}%`}}/></span></span>
            <span className={`debt-map-value debt-map-interest${row.monthlyInterestCents===null?' is-unknown':''}`}><small>Est. monthly interest</small><strong>{row.monthlyInterestCents===null?'Not confirmed':money(row.monthlyInterestCents)}</strong><span className="debt-map-track" aria-hidden="true">{row.monthlyInterestCents!==null&&<i style={{width:`${row.monthlyInterestCents/maxInterest*100}%`}}/>}</span></span>
            <span className={`debt-review-account-status${reviewReason(row,asOf)?' needs-review':''}`}><Icon name={row.balanceCents===0?'check':row.paymentStatus==='in_study'?'clock':reviewReason(row,asOf)?'info':'plan'} size={13}/><span>{row.balanceCents===0?account.balanceCents<0?'Credit stays on this account':'No balance owed':row.paymentStatus==='in_study'?'Payments deferred':reviewReason(row,asOf)??(row.requiredPaymentCents===0?'No minimum due':`${money(row.requiredPaymentCents!)} saved payment`)}</span>{row.dueDate&&row.dueDate>=asOf&&row.paymentStatus!=='in_study'&&row.balanceCents>0&&<time dateTime={row.dueDate}>{shortDate(row.dueDate)}</time>}</span>
          </button>;
        })}</div>
        {!filteredRows.length&&<div className="debt-review-no-matches"><Icon name="search" size={24}/><strong>{search.trim()?'No accounts match your search':'No accounts in this view'}</strong><p>{search.trim()?`No debt account contains "${search.trim()}".`:filter==='due'?'No saved payment dates fall in the next 7 days.':filter==='attention'?'The open accounts have saved dates, rates and payment amounts.':'Choose another view to review your accounts.'}</p><button type="button" className="text-button" onClick={()=>{setFilter('all');setSearch('');searchInput.current?.focus();}}>Show open accounts</button></div>}
        {deferred.length>0&&<div className="debt-deferred-summary" aria-label="Deferred loans"><p>{deferred.map(row=>row.account.name).join(', ')}: no payment due now. {money(overview.deferredCents)} remains in total debt.</p><button type="button" className="text-button" aria-expanded={showDeferred} onClick={()=>{const toggle=()=>setShowDeferred(value=>!value);if(showDeferred&&deferred.some(row=>row.accountId===selected?.id))requestDraftNavigation(toggle);else toggle();}}>{showDeferred?'Hide deferred loans':deferred.length===1?'Show deferred loan':'Show deferred loans'}</button></div>}
      </section>
      <div className="debt-review-detail">
      {selected&&<>
        <div className="debt-scenario-heading"><div><span className="debt-kicker">Selected account</span><h2>{selected.name}</h2></div>{!readOnly&&<div><button type="button" className="button secondary" onClick={()=>setManageAccountId(selected.id)}>Manage account</button>{selected.balanceCents>0&&<button className="button primary" onClick={()=>onOpen('transaction',selected.id)}>Record payment <Icon name="plus" size={15}/></button>}</div>}</div>
        {!filteredRows.some(row=>row.accountId===selected.id)&&<div className="debt-review-selection-note"><span>This account is outside the current list. Your review stays open.</span><button type="button" className="text-button" onClick={showSelectedAccount}>Show account</button></div>}
        {reviewReason(rows.find(row=>row.accountId===selected.id)!,asOf)&&<div className="debt-review-account-check"><Icon name="info" size={17}/><div><strong>{reviewReason(rows.find(row=>row.accountId===selected.id)!,asOf)}</strong><p>Review the saved terms against the latest lender record.</p></div><button type="button" className="text-button" onClick={()=>selectDebt(selected.id,true)}>Review details<Icon name="arrow" size={14}/></button></div>}
        {selected.balanceCents<0?<section className="night-glass debt-payoff-lab" id="debt-payoff" tabIndex={-1}><h2>{selected.name}</h2><div className="debt-selected-balance"><div><span>Credit balance</span><strong>{money(-selected.balanceCents)}</strong></div>{!readOnly&&<button className="button secondary compact" onClick={()=>onOpen('reconcile',selected.id)}>Update balance</button>}</div><p>No debt payment is needed for this recorded balance. The credit stays on this account until the lender applies or refunds it.</p></section>:<DebtScenario key={selected.id} loan={selected} state={state} readOnly={readOnly} onCommand={onCommand} onOpen={onOpen} reviewRequest={reviewRequest}/>}
        {loanGuideFor(selected)&&<details className="debt-source-details"><summary>Fees, repayment rules and sources</summary><DebtResearch account={selected}/></details>}
      {selectedPayments.length>0&&<section className="night-glass debt-payment-history"><div className="debt-section-heading"><h2>Payments</h2>{!readOnly&&selected.balanceCents>0&&<button className="text-button" onClick={()=>onOpen('transaction',selected.id)}>Record payment<Icon name="plus" size={15}/></button>}</div><p className="debt-section-note">{selected.name} · {selectedPayments.length} {selectedPayments.length===1?'entry':'entries'}</p><div>{(showAllPayments?selectedPayments:selectedPayments.slice(0,4)).map(payment=><div className="debt-payment-row" key={payment.id}><span className="debt-payment-check"><Icon name={reversedIds.has(payment.id)?'info':'check'} size={16}/></span><div><strong>{transactionLabel(payment)||'Debt payment'}</strong><small>{reversedIds.has(payment.id)?'Payment reversal. Debt increased.':isStatementCardPayment(payment)?'Statement payment. Funding account not matched.':`Paid from ${state.accounts.find(account=>account.id===payment.accountId)?.name??'Unknown account'}`}</small></div><time dateTime={payment.date}>{new Date(`${payment.date}T12:00:00`).toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric'})}</time><strong>{reversedIds.has(payment.id)?'+':''}{money(Math.abs(payment.amountCents))}</strong></div>)}{selectedPayments.length>4&&<button className="text-button debt-history-toggle" onClick={()=>setShowAllPayments(!showAllPayments)}>{showAllPayments?'Show recent':`Show all ${selectedPayments.length} entries`}</button>}</div></section>}
      </>}
      {!selected&&<section className="debt-review-no-selection"><Icon name="clock" size={28}/><h2>Payments are deferred</h2><p>Deferred balances stay in total debt. Choose a loan to review its terms or try a voluntary payment.</p><button type="button" className="button secondary" onClick={()=>{setShowDeferred(true);setFilter('deferred');}}>Review deferred loans</button></section>}
      </div>
      </div>
      <details className="account-disclosure debt-planning-disclosure">
        <summary><span><strong>Payment schedule and extra payments</strong><small>{nextDates.length ? `Next saved date ${shortDate(nextDates[0].dueDate!)}` : 'No upcoming payment dates recorded'} · Compare confirmed interest rates</small></span><Icon name="down" size={18}/></summary>
        <div className="account-disclosure-content">
      <div className="debt-next-actions">
        <section className="night-glass debt-dates" aria-labelledby="debt-dates-title"><div className="debt-section-heading"><h2 id="debt-dates-title">Upcoming payment dates</h2></div>
          {nextDates.length>0?<ol>{nextDates.map(row=><li key={row.accountId}><button type="button" onClick={()=>selectDebt(row.accountId)}><time dateTime={row.dueDate!}><span>{new Date(`${row.dueDate}T12:00:00`).toLocaleDateString('en-CA',{month:'short'})}</span><strong>{Number(row.dueDate!.slice(8))}</strong></time><span className="debt-date-name"><strong>{row.account.name}</strong><small>{row.requiredPaymentCents===null?'Payment amount needs confirmation':row.requiredPaymentCents===0?'No minimum due':'Saved payment amount'}</small></span><span className="debt-date-amount">{row.requiredPaymentCents===null?'Not set':money(row.requiredPaymentCents)}<Icon name="arrow" size={14}/></span></button></li>)}</ol>:<p className="debt-dates-empty">No upcoming payment dates recorded.</p>}
          <p className="debt-section-note">Check the latest statement and any payments since it.{pastDates.length>0&&<> <button className="text-button" onClick={()=>selectDebt(pastDates[0].accountId,true)}>Review {pastDates.length} past {pastDates.length===1?'date':'dates'}</button></>}</p>
        </section>
        {priority?<section className="night-glass debt-rate-impact" aria-label="Extra payment priority"><span className="debt-kicker">Highest confirmed rate</span><h2>{priority.account.name}</h2><div className="debt-rate-number"><strong>{Number(priority.confirmedApr!.toFixed(2))}%</strong><span>APR</span></div>
          <p>A {money(comparisonReduction)} balance reduction cuts simple annual interest by <strong>{money(engine.priorityComparison.priorityAnnualSavedCents!)}</strong>.{largest&&largest.accountId!==priority.accountId&&largest.confirmedApr!==null&&<> The same reduction on {largest.account.name} cuts <strong>{money(engine.priorityComparison.largestAnnualSavedCents!)}</strong>.</>}</p>
          <button type="button" className="text-button" onClick={()=>selectDebt(priority.accountId)}>Try an extra payment <Icon name="arrow" size={14}/></button><small>Cover required payments and agreed dates first. Rates held constant for this comparison.</small>
        </section>:<section className="night-glass debt-rate-impact" aria-label="Extra payment priority"><h2>{overview.debtCents===0?'No balance to repay':deferredOnly?'Payments are deferred':rateToConfirm?'Confirm the cost of borrowing':'Active debts are interest-free'}</h2><p>{overview.debtCents===0?'Paid-off accounts and card credits stay in your records.':deferredOnly?'Required payments are deferred. These balances remain in total debt; interest may still accrue.':rateToConfirm?'Add or confirm interest rates to compare the effect of an extra payment.':'Confirmed rates on debts with active payments are 0%. An extra payment reduces principal without saving interest on those debts.'}</p>{rateToConfirm&&<button className="text-button" onClick={()=>selectDebt(rateToConfirm.accountId,true)}>Review account details <Icon name="arrow" size={14}/></button>}</section>}
      </div>
        </div>
      </details>
    </>:<section className="night-glass debt-empty-state"><h2>{closedDebt.length?'No open debts':'No debts recorded'}</h2><p>{closedDebt.length?'Settled accounts and their history are saved below.':'Add a loan or credit card balance.'}</p>{!readOnly?<button className="button primary" onClick={()=>onOpen('account')}><Icon name="plus" size={16}/>Add debt</button>:<small>Read-only view</small>}</section>}
    <ClosedDebtHistory state={state} accounts={closedDebt} readOnly={readOnly} onCommand={onCommand}/>
    {!readOnly&&managedAccount&&<AccountEditor account={managedAccount} state={state} onCommand={onCommand} onClose={()=>setManageAccountId(null)}/>}
  </div>;
}

function ClosedDebtHistory({ state, accounts, readOnly, onCommand }: Pick<Props, 'state' | 'readOnly' | 'onCommand'> & { accounts: Account[] }) {
  const [requestedId] = useState(() => new URLSearchParams(window.location.hash.split('?')[1]).get('record'));
  const [open, setOpen] = useState(() => accounts.some(account => account.id === requestedId));
  const [manageId, setManageId] = useState<string | null>(null);
  const managed = accounts.find(account => account.id === manageId);
  const dateLabel = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  if (!accounts.length) return null;
  return <details className="debt-source-details debt-closed-history" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Closed debts <span>{accounts.length}</span></summary>
    <div className="night-glass debt-payment-history">{accounts.map(account => {
      const activity = state.transactions.filter(transaction => transaction.date <= today() && (transaction.accountId === account.id || transaction.toAccountId === account.id || Object.hasOwn(transaction.balanceChanges ?? {}, account.id)))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
      return <section className="debt-closed-account" key={account.id} aria-label={`${account.name} closed debt history`}>
        <div className="debt-section-heading"><h2>{account.name}</h2>{!readOnly && <button type="button" className="text-button" onClick={() => setManageId(account.id)}>Manage account</button>}</div>
        <p className="debt-section-note">Closed {dateLabel(account.closedAt!)} · {money(account.balanceCents)} balance</p>
        {activity.length ? activity.map(transaction => <div className="debt-payment-row" key={transaction.id}>
          <div><strong>{transactionLabel(transaction) || 'Recorded transaction'}</strong><small>{transaction.reversalOf ? 'Reversal' : transaction.kind === 'debt_payment' || isStatementCardPayment(transaction) ? 'Debt payment' : transaction.kind === 'adjustment' ? 'Balance adjustment' : transaction.kind === 'opening' ? 'Opening balance' : 'Recorded transaction'}{transaction.correctionReason ? ` · ${transaction.correctionReason}` : ''}</small></div>
          <time dateTime={transaction.date}>{dateLabel(transaction.date)}</time><strong>{money(transaction.amountCents)}</strong>
        </div>) : <p className="debt-section-note">No transactions recorded for this account.</p>}
      </section>;
    })}</div>
    {!readOnly && managed && <AccountEditor account={managed} state={state} onCommand={onCommand} onClose={() => setManageId(null)}/>}
  </details>;
}
