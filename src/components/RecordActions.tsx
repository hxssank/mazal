import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Account, AppState, Command, Obligation, Reserve, Transaction } from '../../shared/types.ts';
import { transactionLabel } from '../../shared/transaction-label.ts';
import { transactionDisplayLabel } from '../../shared/ledger.ts';
import { money, today } from '../../shared/analytics.ts';
import { parseMoneyCents } from '../../shared/money-input.ts';
import { purchaseAccountId } from '../../shared/asset-purchases.ts';
import {isConfirmedCommandRejection} from '../services/command-errors.ts';
import { useDraftProtection } from '../hooks/draft-protection.ts';
import '../features/expenses/expense-bills.css';

interface Props { state:AppState; onCommand:(command:Command)=>Promise<void>; onClose:()=>void; returnFocusTo?:HTMLElement|null }
const dollars=(value:number)=>(value/100).toFixed(2);
function amount(value:string) { const cents=parseMoneyCents(value,{leadingDecimal:true,invalidMessage:'Enter a dollar amount with up to two decimal places.',rangeMessage:'Amount is too large.'}); if(cents<=0)throw new Error('Enter an amount greater than zero.'); return cents; }
function RecordDialog({state,onCommand,onClose,title,dirty,build,children,submit='Save',canSubmit=true,onReview,returnFocusTo}:{title:string;dirty:boolean;build:()=>Command;children:ReactNode;submit?:string;canSubmit?:boolean;onReview?:()=>void}&Props) {
  const dialog=useRef<HTMLDialogElement>(null), keepRef=useRef<HTMLButtonElement>(null), editingFocus=useRef<HTMLElement|null>(null), id=useId();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[discard,setDiscard]=useState(false);
  const [attempt,setAttempt]=useState<Command|null>(null);
  const [revision,setRevision]=useState(state.revision);
  const guard=useDraftProtection({dirty:dirty||!!attempt,busy,onRequestDiscard:()=>setDiscard(true)});
  useEffect(()=>{
    const element=dialog.current,trigger=returnFocusTo===undefined?document.activeElement:returnFocusTo;
    element?.showModal();element?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')?.focus();
    return()=>{
      element?.close();if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus();
      window.requestAnimationFrame(()=>{
        if(document.querySelector('dialog[open]'))return;
        const active=document.activeElement;
        if(returnFocusTo===undefined&&active&&active!==document.body&&active.isConnected)return;
        const target=trigger instanceof HTMLElement&&trigger!==document.body&&trigger!==document.documentElement&&trigger.isConnected&&!trigger.matches(':disabled')?trigger:document.querySelector<HTMLElement>('main h1[tabindex="-1"]')??document.querySelector<HTMLElement>('main[tabindex="-1"]');
        target?.focus({preventScroll:true});
      });
    };
  },[]);
  useEffect(()=>{if(discard)keepRef.current?.focus();},[discard]);
  function restoreEditingFocus() {
    window.requestAnimationFrame(()=>{
      const element=dialog.current;if(!element?.isConnected)return;
      const previous=editingFocus.current;
      const target=previous?.isConnected&&element.contains(previous)&&!previous.matches(':disabled')?previous:element.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button[type="submit"]:not(:disabled)')??element.querySelector<HTMLElement>('.bill-close:not(:disabled)');
      target?.focus({preventScroll:true});
    });
  }
  function keepEditing() { setDiscard(false);guard.keepEditing();restoreEditingFocus(); }
  async function save(event:FormEvent) {
    event.preventDefault();if(busy||discard)return;setError('');
    try {
      if(!attempt&&!canSubmit)throw new Error('This record is no longer available for this change. Reopen it from your current records.');
      if(!attempt&&revision!==state.revision)throw new Error('Review the updated records before saving.');
      const command=attempt??{...build(),requestId:crypto.randomUUID(),expectedRevision:revision};
      setAttempt(command);setBusy(true);await onCommand(command);onClose();
    } catch(failure){if(isConfirmedCommandRejection(failure))setAttempt(null);setError(failure instanceof Error?failure.message:'Could not save this record.');}finally{setBusy(false);}
  }
  return <dialog ref={dialog} className="bill-dialog record-dialog" aria-labelledby={id} onCancel={event=>{event.preventDefault();if(discard)keepEditing();else guard.requestChange(onClose);}}><header className="bill-dialog-heading"><h2 id={id}>{title}</h2><button className="bill-close" aria-label="Close record" disabled={busy} onClick={()=>guard.requestChange(onClose)}>×</button></header><form onSubmit={event=>void save(event)}><fieldset className="bill-fields" disabled={busy||!!attempt||discard} onFocusCapture={event=>{if(event.target instanceof HTMLElement&&event.target.matches('input,select,textarea'))editingFocus.current=event.target;}}>{children}</fieldset>{revision!==state.revision&&!attempt&&<div className="bill-form-error" role="status">Records changed while this form was open. Review the current values.<button type="button" className="text-button" onClick={()=>{onReview?.();setRevision(state.revision);setError('');restoreEditingFocus();}}>Use updated records</button></div>}{error&&<p className="bill-error bill-form-error" role="alert">{error}</p>}{attempt&&!busy&&<p className="bill-form-error">The result needs confirmation. Retry checks this same request without posting a second copy. Close to review the saved records before changing the details.</p>}<footer className="bill-dialog-footer">{discard?<><span>{attempt?'Close and check the saved records?':'Discard these changes?'}</span><button type="button" className="bill-button bill-secondary" onClick={()=>{setDiscard(false);guard.discard();}}>Discard</button><button ref={keepRef} type="button" className="bill-button bill-primary" onClick={keepEditing}>Keep editing</button></>:<><button type="button" className="bill-button bill-secondary" disabled={busy} onClick={()=>guard.requestChange(onClose)}>Cancel</button><button type="submit" className="bill-button bill-primary" disabled={busy||!attempt&&(!canSubmit||revision!==state.revision)}>{busy?'Saving…':attempt?'Confirm original save':submit}</button></>}</footer></form></dialog>;
}
export function PaymentRecorder({obligation:initialObligation,...props}:{obligation:Obligation}&Props) {
  const {state}=props;
  const [obligation]=useState(initialObligation);
  const [mode,setMode]=useState('new'),[value,setValue]=useState(dollars(obligation.amountCents)),[date,setDate]=useState(today()),[account,setAccount]=useState(obligation.accountId),[match,setMatch]=useState('');
  const accounts=state.accounts.filter(item=>!item.closedAt&&item.entityId===obligation.entityId&&(obligation.direction==='in'||obligation.assetPurchaseId?item.type==='cash':['cash','debt','payable'].includes(item.type)));
  const matches=state.transactions.filter(tx=>tx.amountCents>0&&!tx.plannedPayment&&!tx.reversalOf&&!state.transactions.some(other=>other.reversalOf===tx.id)&&accounts.some(item=>item.id===tx.accountId)&&tx.kind===(obligation.assetPurchaseId?'transfer':obligation.direction==='in'?'income':'expense')&&(!obligation.assetPurchaseId||tx.toAccountId===purchaseAccountId(obligation.assetPurchaseId)));
  const selected=matches.find(tx=>tx.id===match);
  const current=state.obligations.find(item=>item.id===obligation.id);
  const available=current?.status==='planned'&&(Object.keys({...obligation,...current}) as (keyof Obligation)[]).every(key=>current[key]===obligation[key]);
  return <RecordDialog {...props} title={obligation.direction==='in'?'Record received income':'Record a payment'} dirty={mode!=='new'||value!==dollars(obligation.amountCents)||date!==today()||account!==obligation.accountId} canSubmit={available} submit={mode==='match'?'Link recorded payment':'Record payment'} build={()=>({type:'pay_obligation',id:obligation.id,expectedDueDate:obligation.dueDate,requestId:'',...(mode==='match'?{transactionId:match||(()=>{throw new Error('Choose a recorded payment.');})()}:{amountCents:amount(value),date,accountId:account})})}>
    <p><strong>{obligation.name}</strong> · Due {obligation.dueDate} · Scheduled {money(obligation.amountCents)}</p>{!available&&<p role="alert">This scheduled payment changed or was already recorded. Close this form and review the current schedule before recording another payment.</p>}<label className="bill-field">Payment record<select value={mode} onChange={event=>setMode(event.target.value)}><option value="new">Add the payment that happened</option><option value="match">Match an existing transaction</option></select></label>
    {mode==='new'?<><div className="bill-form-grid"><label className="bill-field">Actual amount · CAD<input inputMode="decimal" value={value} onChange={event=>setValue(event.target.value)} required/></label><label className="bill-field">Actual payment date<input type="date" value={date} max={today()} onChange={event=>setDate(event.target.value)} required/></label></div><label className="bill-field">{obligation.direction==='in'?'Received into':'Paid from'}<select value={account} onChange={event=>setAccount(event.target.value)} required><option value="">Choose account</option>{accounts.map(item=><option key={item.id} value={item.id}>{item.name} · {money(item.balanceCents)}</option>)}</select></label><p>{obligation.assetPurchaseId?'This payment moves cash to the linked purchase.':'Record only money that has moved.'} Recording completes this occurrence even when the actual amount differs. Recurring payments advance to the next due date.</p></>:<><label className="bill-field">Recorded transaction<select value={match} onChange={event=>setMatch(event.target.value)} required><option value="">Choose transaction</option>{matches.map(tx=><option key={tx.id} value={tx.id}>{tx.date} · {transactionLabel(tx)} · {money(tx.amountCents)}</option>)}</select></label>{selected&&<p>{selected.source} · {state.accounts.find(item=>item.id===selected.accountId)?.name}</p>}<p>Linking completes this occurrence without changing the transaction or posting money again.</p></>}
  </RecordDialog>;
}
export function ReserveEditor({reserve:initialReserve,...props}:{reserve:Reserve}&Props) {
  const [reserve,setReserve]=useState(initialReserve),[name,setName]=useState(initialReserve.name),[value,setValue]=useState(dollars(initialReserve.amountCents)),[release,setRelease]=useState(false);
  const latest=props.state.reserves.find(item=>item.id===reserve.id);
  const changed=!!latest&&(latest.name!==reserve.name||latest.amountCents!==reserve.amountCents||latest.entityId!==reserve.entityId);
  function review() {
    if(!latest)return;
    if(name===reserve.name)setName(latest.name);
    if(value===dollars(reserve.amountCents))setValue(dollars(latest.amountCents));
    if(changed)setRelease(false);
    setReserve(latest);
  }
  return <RecordDialog {...props} title="Edit money set aside" dirty={name!==reserve.name||value!==dollars(reserve.amountCents)||release} canSubmit={!!latest&&!changed} onReview={review} submit={release?'Release reserve':'Save reserve'} build={()=>release?{type:'remove_reserve',id:reserve.id}:{type:'update_reserve',id:reserve.id,expected:reserve,name,amountCents:amount(value),requestId:''}}>{!latest&&<p role="status">This reserve is no longer available. Close this editor and choose a current reserve.</p>}{changed&&<p role="status">Saved reserve: {latest!.name} · {money(latest!.amountCents)}. Use updated records to review these changes. Your edited entries will be kept. Choose release again if you still want to release it.</p>}<label className="bill-field">Reserve name<input value={name} onChange={event=>setName(event.target.value)} maxLength={100} required/></label><label className="bill-field">Amount · CAD<input inputMode="decimal" value={value} onChange={event=>setValue(event.target.value)} disabled={release} required/></label><label><input type="checkbox" checked={release} onChange={event=>setRelease(event.target.checked)}/> Release this reserve</label><p>Changes the amount protected in the plan. It does not move cash or delete transactions.</p></RecordDialog>;
}
export function AccountEditor({account:initialAccount,...props}:{account:Account}&Props) {
  const [account,setAccount]=useState(initialAccount),[name,setName]=useState(initialAccount.name),[action,setAction]=useState('rename');
  const latest=props.state.accounts.find(item=>item.id===account.id);
  const changed=latest&&(latest.name!==account.name||latest.balanceCents!==account.balanceCents||latest.closedAt!==account.closedAt);
  function review() {
    if(!latest)return;
    if(name===account.name)setName(latest.name);
    if(Boolean(latest.closedAt)!==Boolean(account.closedAt))setAction('rename');
    setAccount(latest);
  }
  return <RecordDialog {...props} title={`Manage ${account.name}`} dirty={name!==account.name||action!=='rename'} canSubmit={!!latest} onReview={review} build={()=>action==='rename'?{type:'rename_account',accountId:account.id,name,expectedName:account.name,requestId:''}:{type:'set_account_closed',accountId:account.id,closed:!account.closedAt,requestId:''}}><p>{money(account.balanceCents)} · {account.closedAt?`Closed ${account.closedAt}`:'Open account'}</p>{!latest&&<p role="status">This account is no longer available. Close this editor and choose a current account.</p>}{changed&&<p role="status">Saved account: {latest.name} · {money(latest.balanceCents)} · {latest.closedAt?'Closed':'Open'}. Use updated records to review these changes. Your edited name will be kept; if the account status changed, choose the change again.</p>}<label className="bill-field">Change<select value={action} onChange={event=>setAction(event.target.value)}><option value="rename">Rename account</option><option value="status">{account.closedAt?'Reopen account':'Close account'}</option></select></label>{action==='rename'?<label className="bill-field">Account name<input value={name} onChange={event=>setName(event.target.value)} maxLength={100} required/></label>:<p>{account.closedAt?'Reopening makes this account available for new transactions again.':'Closing preserves the history and removes the account from new transaction choices. The recorded balance must be zero and planned payments must be moved first.'}</p>}</RecordDialog>;
}
export function TransactionEditor({transaction:tx,...props}:{transaction:Transaction}&Props) {
  const {state}=props;
  const [action,setAction]=useState('annotate'),[value,setValue]=useState(dollars(Math.abs(tx.amountCents))),[date,setDate]=useState(tx.date),[description,setDescription]=useState(tx.description),[reason,setReason]=useState(''),[account,setAccount]=useState(tx.accountId),[to,setTo]=useState(tx.toAccountId??''),[category,setCategory]=useState(tx.category);
  const [reviewedCategory,setReviewedCategory]=useState(tx.category);
  const [displayName,setDisplayName]=useState(tx.displayName??''),[note,setNote]=useState(tx.note??'');
  const [reviewedName,setReviewedName]=useState(tx.displayName??''),[reviewedNote,setReviewedNote]=useState(tx.note??'');
  const annotationDirty=displayName.trim()!==reviewedName||note.trim()!==reviewedNote;
  const current=state.transactions.find(item=>item.id===tx.id);
  function review() {
    if(!current)return;
    if(category===reviewedCategory)setCategory(current.category);
    setReviewedCategory(current.category);
    if(displayName===reviewedName)setDisplayName(current.displayName??'');
    if(note===reviewedNote)setNote(current.note??'');
    setReviewedName(current.displayName??'');setReviewedNote(current.note??'');
  }
  const reversed=state.transactions.find(item=>item.reversalOf===tx.id);
  const affected=state.accounts.filter(item=>[tx.accountId,tx.toAccountId].includes(item.id));
  const canCorrect=!!current&&['Manual entry','Corrected manual entry'].includes(current.source)&&!current.statementId&&!current.importSources?.length&&!current.plannedPayment&&!reversed&&!current.refundOf&&!current.reversalOf&&!state.transactions.some(item=>item.refundOf===tx.id)&&!affected.some(item=>item.closedAt||!!item.reconciledAt&&tx.date<=item.reconciledAt||item.clearedTransactionIds?.includes(tx.id));
  const canRefund=!!current&&current.kind==='expense'&&current.amountCents>0&&!reversed;
  const actionAvailable=action==='details'||(action==='annotate'?!!current:action==='refund'?canRefund:canCorrect);
  const owner=state.accounts.find(item=>item.id===tx.accountId)?.entityId;
  const accounts=state.accounts.filter(item=>!item.closedAt&&item.entityId===owner);
  const solAccountIds=new Set(state.positions.map(position=>position.accountId));
  const sourceAccounts=accounts.filter(item=>!solAccountIds.has(item.id)&&(action==='refund'||tx.kind==='expense'?['cash','debt','payable'].includes(item.type):tx.kind==='income'?['cash','receivable'].includes(item.type):tx.kind==='transfer'?['cash','investment','receivable'].includes(item.type):item.type==='cash'));
  const destinationAccounts=state.accounts.filter(item=>!item.closedAt&&!solAccountIds.has(item.id)&&item.id!==account&&(tx.kind==='debt_payment'?['debt','payable'].includes(item.type):['cash','investment'].includes(item.type)));
  const linked=state.transactions.filter(item=>item.reversalOf===tx.id||item.replacesId===tx.id||item.refundOf===tx.id||item.id===tx.reversalOf||item.id===tx.replacesId||item.id===tx.refundOf);
  const sources=[...(tx.statementId?[{name:state.statements?.find(item=>item.id===tx.statementId)?.sourceFile??tx.source,id:tx.statementId,sha:state.statements?.find(item=>item.id===tx.statementId)?.sha256??''}]:[]),...(tx.importSources??[]).map(ref=>({name:state.importBatches?.find(item=>item.id===ref.importId)?.source.sourceFile??tx.source,id:ref.importId,sha:state.importBatches?.find(item=>item.id===ref.importId)?.source.sha256??''}))];
  return <RecordDialog {...props} title="Transaction details" dirty={annotationDirty||action!=='details'&&action!=='annotate'} canSubmit={action!=='details'&&actionAvailable&&(action!=='annotate'||annotationDirty)} onReview={review} submit={action==='annotate'?'Save name and note':action==='refund'?'Record refund':action==='reverse'?'Reverse entry':'Save correction'} build={()=>{
    if(action==='annotate')return {type:'annotate_transaction',id:tx.id,expectedDisplayName:reviewedName||null,expectedNote:reviewedNote||null,displayName:displayName.trim()||null,note:note.trim()||null,requestId:''};
    if(!reason.trim())throw new Error('Enter the reason for this change.');
    if(action!=='reverse'&&!sourceAccounts.some(item=>item.id===account))throw new Error('Choose an available account for this transaction.');
    if(action==='correct'&&tx.toAccountId&&!destinationAccounts.some(item=>item.id===to))throw new Error('Choose a different available destination account.');
    if(action==='refund')return {type:'record_refund',id:tx.id,accountId:account,amountCents:amount(value),date,reason,requestId:''};
    return {type:'correct_transaction',id:tx.id,reason,requestId:'',...(action==='correct'?{replacement:{kind:tx.kind as 'income'|'expense'|'transfer'|'debt_payment',accountId:account,toAccountId:to||undefined,amountCents:amount(value),date,description,category}}:{})};
  }}><p><strong>{transactionLabel(current??tx)}</strong><br/>{tx.date} · {money(tx.amountCents)} · {state.accounts.find(item=>item.id===tx.accountId)?.name}<br/>{transactionDisplayLabel(tx)}{tx.kind==='expense'?` · ${current?.expenseCategory??current?.category??tx.category}`:''}<br/>{tx.source}</p><p className="record-original-description">Original description: {tx.description}</p>{sources.map(source=><a key={source.id} href={`/api/source?workspace=${state.workspace}&file=${encodeURIComponent(source.name)}&sha=${source.sha}`} target="_blank" rel="noreferrer">{source.name}</a>)}{tx.correctionReason&&<p>Reason: {tx.correctionReason}</p>}{linked.map(item=><p key={item.id}>{item.source} · {item.date} · {money(item.amountCents)} · {item.correctionReason}</p>)}<label className="bill-field">Action<select value={action} disabled={annotationDirty} onChange={event=>{if(annotationDirty)return;setAction(event.target.value);if(event.target.value==='refund')setDate(today());}}><option value="annotate">Name and note</option><option value="details">Review record</option>{!actionAvailable&&<option value={action} disabled>This action is no longer available</option>}{canCorrect&&<><option value="correct">Correct this manual entry</option><option value="reverse">Reverse this manual entry</option></>}{canRefund&&<option value="refund">Record a refund</option>}</select></label>{(!current||!actionAvailable)&&<p role="alert">This transaction changed or was removed. Choose an available action or close this record.</p>}{action==='annotate'&&<>{annotationDirty&&<p>Save your name and note before choosing another action. <button type="button" className="text-button" onClick={()=>{setDisplayName(reviewedName);setNote(reviewedNote);}}>Reset name and note edits</button></p>}<label className="bill-field">Transaction name<input value={displayName} onChange={event=>setDisplayName(event.target.value)} maxLength={200} placeholder={tx.description}/></label><label className="bill-field">Note<textarea value={note} onChange={event=>setNote(event.target.value)} maxLength={1000} placeholder="What was this for? Add context for category review."/></label><p>Clear the name to use the original description. Names and notes appear in search and category review. They do not change the amount, category, or payment type.</p></>}{action==='details'&&current?.note&&<p>{current.note}</p>}{!canCorrect&&action!=='annotate'&&<p>Imported, linked, and reconciled entries retain their source details. Correct statement extractions in Statements before recording them.</p>}{action!=='details'&&action!=='annotate'&&<>{action!=='reverse'&&<><label className="bill-field">Amount · CAD<input inputMode="decimal" value={value} onChange={event=>setValue(event.target.value)} required/></label><label className="bill-field">Date<input type="date" value={date} max={today()} onChange={event=>setDate(event.target.value)} required/></label><label className="bill-field">Account<select value={sourceAccounts.some(item=>item.id===account)?account:''} onChange={event=>{setAccount(event.target.value);if(event.target.value===to)setTo('');}} required><option value="" disabled>Choose an account</option>{sourceAccounts.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{action==='correct'&&<><label className="bill-field">Description<input value={description} onChange={event=>setDescription(event.target.value)} required/></label><label className="bill-field">Category<input value={category} onChange={event=>setCategory(event.target.value)}/></label>{tx.toAccountId&&<label className="bill-field">Destination<select value={destinationAccounts.some(item=>item.id===to)?to:''} onChange={event=>setTo(event.target.value)} required><option value="" disabled>Choose a destination</option>{destinationAccounts.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}</>}</>}<label className="bill-field">Reason<textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength={500} required/></label><p>The original entry stays in your history. A correction adds its reversal and replacement. A refund adds a linked credit.</p></>}</RecordDialog>;
}
export function PaydayReceipt({paydayDate,...props}:{paydayDate:string}&Props) {
  const {state}=props;const [id,setId]=useState('');
  const income=state.transactions.filter(tx=>tx.kind==='income'&&tx.amountCents>0&&!tx.paydayDate&&!state.transactions.some(other=>other.reversalOf===tx.id)&&state.accounts.some(account=>account.id===tx.accountId&&account.type==='cash'));
  return <RecordDialog {...props} title="Confirm payday deposit" dirty={!!id} canSubmit={!!id} submit="Link deposit" build={()=>({type:'confirm_payday',transactionId:id,paydayDate,requestId:''})}><p>Scheduled payday: {paydayDate}. Choose the income entry confirmed in your bank records. A schedule alone does not confirm a deposit.</p><label className="bill-field">Recorded income<select value={id} onChange={event=>setId(event.target.value)} required><option value="">Choose deposit</option>{income.map(tx=><option key={tx.id} value={tx.id}>{tx.date} · {transactionLabel(tx)} · {money(tx.amountCents)}</option>)}</select></label>{!income.length&&<p>Record or import the deposit first, then return to link it.</p>}</RecordDialog>;
}
