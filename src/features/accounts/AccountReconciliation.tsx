import { transactionLabel, transactionSearchText } from '../../../shared/transaction-label.ts';
import { useEffect, useId, useRef, useState } from 'react';
import type { AppState, Command } from '../../../shared/types.ts';
import { money, today } from '../../../shared/analytics.ts';
import { parseMoneyCents } from '../../../shared/money-input.ts';
import { clearedBalance, reconciliationDate, reconciliationRows, reconciliationStart } from '../../../shared/reconciliation.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
import './reconciliation.css';

export interface BalanceDraft { accountId:string; balance:string; date:string }
interface Props { state:AppState; accountId?:string; onCommand:(command:Command)=>Promise<void>; onClose:()=>void; onAdjust:(draft:BalanceDraft)=>void }
function parseBalance(value:string):number|null {
  try { return parseMoneyCents(value,{signed:true,leadingDecimal:true,maxCents:100_000_000_000_000,invalidMessage:'Enter a statement balance.',rangeMessage:'The statement balance is too large.'}); }
  catch { return null; }
}
const sorted = (ids:Iterable<string>) => JSON.stringify([...ids].sort());

export default function AccountReconciliation({ state, accountId, onCommand, onClose, onAdjust }:Props) {
  const accounts = state.accounts.filter(account => ['cash','debt','payable'].includes(account.type));
  const initial = accountId ? accounts.find(account => account.id === accountId) : accounts[0];
  const [chosenId,setChosenId] = useState(initial?.id ?? '');
  const account = accounts.find(account => account.id === chosenId);
  const [date,setDate] = useState(today());
  const [balance,setBalance] = useState(initial ? (initial.balanceCents/100).toFixed(2) : '');
  const [initialValues,setInitialValues] = useState({date:today(),balance:initial ? (initial.balanceCents/100).toFixed(2) : ''});
  const [selected,setSelected] = useState(new Set(initial?.clearedTransactionIds ?? []));
  const reviewedChecks = useRef(new Set(initial?.clearedTransactionIds ?? []));
  const [query,setQuery] = useState('');
  const [showReconciled,setShowReconciled] = useState(false);
  const [page,setPage] = useState(0);
  const [revision,setRevision] = useState(state.revision);
  const [pending,setPending] = useState(false);
  const [error,setError] = useState('');
  const [discard,setDiscard] = useState(false);
  const [reopen,setReopen] = useState(false);
  const requests = useRef(new Map<string,string>());
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const openingDate = reconciliationStart(state.transactions,chosenId);
  const minimumDate = [openingDate,account?.reconciliation?.date,'1900-01-01'].filter((value):value is string=>!!value).sort().at(-1)!;
  const beforeOpening = !!date && !!openingDate && date < openingDate;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= minimumDate && date <= today();
  const rows = reconciliationRows(state,chosenId,date);
  const locked = new Set(account?.reconciliation?.transactionIds ?? []);
  const checked = account ? clearedBalance(rows,account,selected) : null;
  const target = parseBalance(balance);
  const difference = checked === null || target === null ? null : target - checked;
  const stale = revision !== state.revision;
  const matching = rows.filter(row => (showReconciled || !locked.has(row.id)) && (!query.trim() || `${transactionSearchText(row)} ${row.category}`.toLocaleLowerCase('en-CA').includes(query.trim().toLocaleLowerCase('en-CA'))));
  const currentPage = Math.min(page,Math.max(0,Math.ceil(matching.length/40)-1));
  const visible = matching.slice(currentPage*40,(currentPage+1)*40);
  const checksChanged = sorted(selected) !== sorted(account?.clearedTransactionIds ?? []);
  const dirty = checksChanged || date !== initialValues.date || balance !== initialValues.balance;
  const guard = useDraftProtection({dirty,busy:pending,onRequestDiscard:()=>setDiscard(true)});
  useEffect(() => { dialog.current?.showModal(); },[]);
  function close() { guard.requestChange(onClose); }
  function changeAccount(value:string) {
    const next = accounts.find(account => account.id === value);
    const nextBalance=next ? (next.balanceCents/100).toFixed(2) : '';
    reviewedChecks.current = new Set(next?.clearedTransactionIds ?? []);
    setChosenId(value);setSelected(new Set(next?.clearedTransactionIds ?? []));setBalance(nextBalance);setDate(today());setInitialValues({date:today(),balance:nextBalance});setPage(0);setRevision(state.revision);setError('');setReopen(false);
  }
  function reviewUpdated() {
    const available = new Set(state.transactions.map(row=>row.id));
    const latest = new Set(account?.clearedTransactionIds ?? []);
    const merged = new Set(latest);
    for (const key of reviewedChecks.current) if (!selected.has(key)) merged.delete(key);
    for (const key of selected) if (!reviewedChecks.current.has(key)) merged.add(key);
    for (const key of account?.reconciliation?.transactionIds ?? []) merged.add(key);
    setSelected(new Set([...merged].filter(key=>available.has(key))));
    reviewedChecks.current = latest;
    setRevision(state.revision);setError('');
  }
  async function save(finish:boolean) {
    if(pending||stale||!validDate||!account||target===null)return;
    const payload={type:'save_reconciliation' as const,accountId:chosenId,date,balanceCents:target,clearedTransactionIds:[...selected].sort(),finish};
    const key=JSON.stringify(payload);
    if(!requests.current.has(key))requests.current.set(key,crypto.randomUUID());
    setPending(true);setError('');
    try { await onCommand({...payload,expectedRevision:revision,requestId:requests.current.get(key)!});onClose(); }
    catch(caught){setError(caught instanceof Error?caught.message:'Could not save transaction checks.');}
    finally{setPending(false);}
  }
  async function reopenChecks() {
    if(pending||stale)return;
    const key=`reopen:${chosenId}:${JSON.stringify(account?.reconciliation)}`;
    if(!requests.current.has(key))requests.current.set(key,crypto.randomUUID());
    setPending(true);setError('');
    try{await onCommand({type:'reopen_reconciliation',accountId:chosenId,expectedRevision:revision,requestId:requests.current.get(key)!});onClose();}
    catch(caught){setError(caught instanceof Error?caught.message:'Could not reopen transaction checks.');}
    finally{setPending(false);}
  }
  return <><dialog ref={dialog} className="mazal-dialog reconciliation-dialog" aria-labelledby={`${id}-title`} onCancel={event=>{event.preventDefault();close();}}>
    <header className="mazal-dialog-header"><h2 id={`${id}-title`}>Reconcile account</h2><button type="button" className="mazal-dialog-close" aria-label="Close dialog" disabled={pending} onClick={close}>×</button></header>
    <form onSubmit={event=>{event.preventDefault();void save(true);}}>
      <fieldset className="mazal-form-body" disabled={pending||discard||reopen}>
        <label className="field"><span>Account</span><select value={account?chosenId:''} disabled={dirty&&!!account} onChange={event=>{const nextId=event.target.value;guard.requestChange(()=>changeAccount(nextId));}}><option value="" disabled>Choose an account</option>{accounts.map(item=><option key={item.id} value={item.id}>{item.name}{state.entities.length>1?` · ${state.entities.find(owner=>owner.id===item.entityId)?.name}`:''}</option>)}</select></label>
        {!account&&<p role="status">{accountId||chosenId?'The selected account is unavailable. Choose an account to reconcile.':'No cash or debt accounts are available to reconcile.'}</p>}
        <div className="form-grid"><label className="field"><span>Statement date</span><input type="date" value={date} min={minimumDate} max={today()} required onChange={event=>{setDate(event.target.value);setPage(0);}}/></label><label className="field"><span>{['debt','payable'].includes(account?.type ?? '')?'Amount owed · CAD':'Statement balance · CAD'}</span><input name="statementBalance" value={balance} inputMode="decimal" required onChange={event=>setBalance(event.target.value)}/></label></div>
        {beforeOpening&&<p role="alert">Opening balance is dated {openingDate}. Review earlier statements in Statements.</p>}
        {!validDate&&!beforeOpening&&<p role="alert">Choose a statement date from {minimumDate} through {today()}.</p>}
        <dl className="reconciliation-totals"><div><dt>Checked balance</dt><dd>{checked===null?'Unavailable':money(checked)}</dd></div><div><dt>Difference</dt><dd>{difference===null?'Enter a balance':money(difference)}</dd></div></dl>
        <p className="muted">Check each entry that appears on your statement. Include the opening balance.</p>
        {account?.reconciliation&&<div className="reconciliation-previous"><span>Reconciled through {account.reconciliation.date}</span><button type="button" className="text-button" disabled={stale||dirty} onClick={()=>setReopen(true)}>Reopen</button></div>}
        <div className="reconciliation-filter"><label className="field"><span>Search transactions</span><input type="search" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label>{locked.size>0&&<label><input type="checkbox" checked={showReconciled} onChange={event=>{setShowReconciled(event.target.checked);setPage(0);}}/> Show reconciled</label>}</div>
        <div className="reconciliation-list-heading"><span>{matching.length} {matching.length===1?'entry':'entries'}</span>{visible.some(row=>!selected.has(row.id))&&<button type="button" className="text-button" onClick={()=>setSelected(previous=>new Set([...previous,...visible.filter(row=>Number.isSafeInteger(row.balanceChanges?.[chosenId])).map(row=>row.id)]))}>Check shown</button>}</div>
        <ul className="reconciliation-list">{visible.map(row=>{const delta=row.balanceChanges?.[chosenId];return <li key={row.id}><label><input type="checkbox" aria-label={`Check ${transactionLabel(row)}`} checked={selected.has(row.id)} disabled={locked.has(row.id)||!Number.isSafeInteger(delta)} onChange={event=>setSelected(previous=>{const next=new Set(previous);if(event.target.checked)next.add(row.id);else next.delete(row.id);return next;})}/><span><strong>{transactionLabel(row)}</strong>{row.displayName&&<small>{row.description}</small>}<small>{reconciliationDate(row,chosenId)} · {locked.has(row.id)?'Reconciled':row.category||row.source}</small></span><b>{delta===undefined?'Unavailable':`${delta>0?'+':''}${money(delta)}`}</b></label></li>;})}</ul>
        {!matching.length&&<p className="muted">{query?'No entries match.':locked.size?'No unchecked entries through this date.':'No entries through this date.'}</p>}
        {matching.length>40&&<nav className="reconciliation-pagination" aria-label="Reconciliation pages"><button type="button" className="button secondary" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><span>{currentPage*40+1} to {Math.min((currentPage+1)*40,matching.length)}</span><button type="button" className="button secondary" disabled={(currentPage+1)*40>=matching.length} onClick={()=>setPage(currentPage+1)}>Next</button></nav>}
        {rows.some(row=>row.balanceChanges?.[chosenId]===undefined)&&<p role="alert">Reload Mazal to read the balance changes for these entries.</p>}
        <details className="reconciliation-adjust"><summary>Correct a missing balance</summary><p>Creates a balance correction. Use it only after checking for missing or duplicate entries.</p><button type="button" className="button secondary" disabled={!account||checksChanged||stale||!validDate||!!account.closedAt} onClick={()=>onAdjust({accountId:chosenId,date,balance})}>Adjust balance</button>{account?.closedAt&&<p>Reopen this account in Manage accounts before adjusting its balance.</p>}{checksChanged&&<p>Save your checks before adjusting the balance.</p>}</details>
      </fieldset>
      {stale&&<div className="mazal-form-notice" role="status"><p>Records changed. Review them before saving.</p><button type="button" className="button secondary" disabled={pending} onClick={reviewUpdated}>Review updated records</button></div>}
      {error&&<p className="mazal-form-error" role="alert">{error}</p>}
      <footer className="mazal-dialog-footer">
        {reopen?<><span>Reopen the saved checks for this account?</span><button type="button" className="button secondary" disabled={pending} onClick={()=>setReopen(false)}>Cancel</button><button type="button" className="button primary" disabled={pending||stale} onClick={()=>void reopenChecks()}>Reopen checks</button></>:<><button type="button" className="button secondary" disabled={pending} onClick={close}>Cancel</button><button type="button" className="button secondary" disabled={pending||stale||!validDate||target===null||!checksChanged} onClick={()=>void save(false)}>Save checks</button><button type="submit" className="button primary" disabled={pending||stale||!validDate||difference!==0||!account}>{pending?'Saving…':'Finish reconciliation'}</button></>}
      </footer>
    </form>
  </dialog><DraftDiscardDialog open={discard} onDiscard={()=>{setDiscard(false);guard.discard();}} onKeepEditing={()=>{setDiscard(false);guard.keepEditing();}}/></>;
}
