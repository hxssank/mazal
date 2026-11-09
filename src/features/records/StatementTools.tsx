import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {AppState,Command,StatementBatch,StatementDecision} from '../../../shared/types.ts';
import {money} from '../../../shared/analytics.ts';
import {parseStatementCSV,statementBalanceCheck,statementRowsCSV} from '../../../shared/statement-csv.ts';
import {statementDateBasisLabel,statementDecisionIssue} from '../../../shared/statement-imports.ts';
import {useDraftProtection} from '../../hooks/draft-protection.ts';
import {isConfirmedCommandRejection} from '../../services/command-errors.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
interface Props {batch:StatementBatch;state:AppState;readOnly:boolean;onCommand:(command:Command)=>Promise<void>;onDraftChange?:(dirty:boolean)=>void}
const statementVersion=(batch:StatementBatch)=>JSON.stringify([batch.status,batch.source,batch.decisions]);
export default function StatementTools({batch,state,readOnly,onCommand,onDraftChange}:Props){
  const [mode,setMode]=useState<'none'|'group'|'extract'>('none');
  const [description,setDescription]=useState(''),[kind,setKind]=useState<StatementDecision['kind']>('expense'),[category,setCategory]=useState('');
  const [checked,setChecked]=useState<string[]>([]);
  const [csv,setCSV]=useState(()=>statementRowsCSV(batch.source.rows)),[start,setStart]=useState(batch.source.periodStart),[end,setEnd]=useState(batch.source.periodEnd),[opening,setOpening]=useState((batch.source.openingBalanceCents/100).toFixed(2)),[closing,setClosing]=useState((batch.source.closingBalanceCents/100).toFixed(2)),[reason,setReason]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[discard,setDiscard]=useState(false);
  const [revision,setRevision]=useState(state.revision);
  const reviewedBatch=useRef(batch);
  const form=useRef<HTMLFormElement>(null),openingControl=useRef<HTMLButtonElement|null>(null),restoreControl=useRef(false);
  useEffect(()=>{
    if(mode!=='none'){form.current?.querySelector<HTMLElement>('select,input,textarea')?.focus();return;}
    const target=openingControl.current;openingControl.current=null;const restore=restoreControl.current;restoreControl.current=false;
    if(restore&&target?.isConnected&&!target.disabled&&!target.closest('[hidden]'))target.focus();
  },[mode]);
  const attempt=useRef<Command|null>(null);
  const account=state.accounts.find(item=>item.id===batch.source.accountId);
  const descriptions=[...new Set(batch.source.rows.map(row=>row.description))];
  const matching=batch.source.rows.filter(row=>row.description===description);
  const dirty=mode!=='none';
  const statementChanged=statementVersion(batch)!==statementVersion(reviewedBatch.current);
  const stale=dirty&&revision!==state.revision&&!attempt.current;
  useEffect(()=>{onDraftChange?.(dirty);},[dirty,onDraftChange]);
  useEffect(()=>{if(stale&&!statementChanged&&batch.status==='staged')setRevision(state.revision);},[stale,statementChanged,batch.status,state.revision]);
  const guard=useDraftProtection({dirty,busy,onRequestDiscard:()=>setDiscard(true)});
  async function save(event:FormEvent){
    event.preventDefault();if(readOnly||busy)return;setError('');
    try{
      let command=attempt.current;
      if(!command){
        if(batch.status!=='staged')throw new Error('This statement is no longer pending. Close this draft to review its recorded entries.');
        if(revision!==state.revision)throw new Error('Review the updated statement below before saving. Your draft has been kept.');
        if(mode==='group'){
          if(!checked.length)throw new Error('Select the exact rows to classify.');
          const decisions=batch.source.rows.filter(row=>checked.includes(row.id)).map(row=>({rowId:row.id,kind,category:category.trim()}));
          for(const decision of decisions){const row=batch.source.rows.find(item=>item.id===decision.rowId)!;const issue=account&&statementDecisionIssue(account,row,decision);if(issue)throw new Error(issue);}
          command={type:'review_statement',importId:batch.id,decisions:[...batch.decisions.filter(item=>!checked.includes(item.rowId)),...decisions],expectedRevision:revision,requestId:crypto.randomUUID()};
        }else{
          if(!reason.trim())throw new Error('Explain the extraction correction.');
          const rows=parseStatementCSV(csv,batch.source.sourceKind),balance=statementBalanceCheck(rows,start,end,opening,closing);
          if(balance.differenceCents!==0)throw new Error(`Corrected rows differ from the closing balance by ${money(balance.differenceCents)}.`);
          command={type:'revise_statement',importId:batch.id,reason,statement:{...batch.source,rows,periodStart:start,periodEnd:end,openingBalanceCents:balance.openingBalanceCents,closingBalanceCents:balance.closingBalanceCents},expectedRevision:revision,requestId:crypto.randomUUID()};
        }
        attempt.current=command;
      }
      setBusy(true);await onCommand(command);finishEditing();setChecked([]);
    }catch(failure){if(isConfirmedCommandRejection(failure))attempt.current=null;setError(failure instanceof Error?failure.message:'Could not save the review.');}finally{setBusy(false);}
  }
  function finishEditing(){restoreControl.current=true;setMode('none');attempt.current=null;}
  function open(next:'group'|'extract',trigger:HTMLButtonElement){openingControl.current=trigger;reviewedBatch.current=batch;setRevision(state.revision);setMode(next);setError('');setCSV(statementRowsCSV(batch.source.rows));setStart(batch.source.periodStart);setEnd(batch.source.periodEnd);setOpening((batch.source.openingBalanceCents/100).toFixed(2));setClosing((batch.source.closingBalanceCents/100).toFixed(2));attempt.current=null;}
  function reviewUpdatedStatement(){
    if(busy||attempt.current||batch.status!=='staged')return;
    const previous=reviewedBatch.current.source,current=batch.source;
    if(mode==='extract'){
      if(csv===statementRowsCSV(previous.rows))setCSV(statementRowsCSV(current.rows));
      if(start===previous.periodStart)setStart(current.periodStart);
      if(end===previous.periodEnd)setEnd(current.periodEnd);
      if(opening===(previous.openingBalanceCents/100).toFixed(2))setOpening((current.openingBalanceCents/100).toFixed(2));
      if(closing===(previous.closingBalanceCents/100).toFixed(2))setClosing((current.closingBalanceCents/100).toFixed(2));
    }else setChecked(ids=>ids.filter(id=>matching.some(row=>row.id===id)));
    reviewedBatch.current=batch;setRevision(state.revision);setError('');
  }
  const reviewNotice=stale&&statementChanged&&<div className="mazal-form-notice" role="status">{batch.status!=='staged'?<p>This statement is no longer pending. Your draft is kept here; close it to review the recorded entries.</p>:<><p>The saved statement changed while this draft was open. Review its current extraction and classifications before keeping your edits.</p><p>Current period {batch.source.periodStart} to {batch.source.periodEnd}. Opening {money(batch.source.openingBalanceCents)}, closing {money(batch.source.closingBalanceCents)}.</p><label className="field">Current saved CSV rows<textarea readOnly value={statementRowsCSV(batch.source.rows)} rows={6}/></label><label className="field">Current saved classifications<textarea readOnly rows={4} value={batch.decisions.length ? batch.decisions.map(decision=>`${batch.source.rows.find(row=>row.id===decision.rowId)?.description??decision.rowId}: ${decision.kind}${decision.category?` · ${decision.category}`:''}`).join('\n') : 'None'}/></label><p>{mode==='extract'?'Untouched fields will use the current values. Your edited fields will replace the saved values, and the previous extraction will stay in history. Corrected rows will need classification again.':'Your selected rows will use your classification. Rows outside the current description will be deselected; other saved decisions stay unchanged.'}</p><button type="button" className="button secondary compact" disabled={busy} onClick={reviewUpdatedStatement}>{mode==='extract'?'Keep my edited values':'Keep my classification'}</button></>}</div>;
  if(readOnly)return null;
  return <section className="statement-review-tools"><div className="document-import-heading"><button type="button" className="button secondary compact" disabled={mode!=='none'} onClick={event=>open('group',event.currentTarget)}>Review matching rows together</button><button type="button" className="text-button" disabled={mode!=='none'} onClick={event=>open('extract',event.currentTarget)}>Correct extracted rows</button></div>{mode!=='none'&&<form ref={form} className="import-editor" onSubmit={event=>void save(event)}><fieldset className="statement-review-fields" disabled={busy||!!attempt.current}>{mode==='group'?<><h3>Classify selected rows</h3><label className="field">Exact description<select value={description} onChange={event=>{setDescription(event.target.value);setChecked([]);}}><option value="">Choose description</option>{descriptions.map(value=><option key={value}>{value}</option>)}</select></label>{matching.map(row=><label className="mazal-checkbox" key={row.id}><input type="checkbox" checked={checked.includes(row.id)} onChange={event=>setChecked(current=>event.target.checked?[...current,row.id]:current.filter(id=>id!==row.id))}/><span>{row.transactionDate}{row.dateBasis&&` · ${statementDateBasisLabel(row)}`} · {row.description} · {money(row.amountCents)} · Page {row.sourcePage}</span></label>)}<label className="field">Type<select value={kind} onChange={event=>setKind(event.target.value as StatementDecision['kind'])}>{(['expense','income','refund','interest','movement'] as const).map(value=><option key={value}>{value}</option>)}</select></label><label className="field">Category<input value={category} onChange={event=>setCategory(event.target.value)} maxLength={100}/></label><p>{checked.length} selected rows. Transfers still require individual matching. Other saved classifications stay unchanged.</p></>:<><h3>Correct the extraction</h3><p>The original file and SHA-256 stay unchanged. Mazal keeps the previous extracted rows and their decisions. Corrected rows need classification again.</p><a href={`/api/source?workspace=${state.workspace}&file=${encodeURIComponent(batch.source.sourceFile)}&sha=${batch.source.sha256}`} target="_blank" rel="noreferrer">Open original source</a><div className="form-grid"><label className="field">Period start<input type="date" value={start} onChange={event=>setStart(event.target.value)} required/></label><label className="field">Period end<input type="date" value={end} onChange={event=>setEnd(event.target.value)} required/></label><label className="field">Opening balance<input value={opening} onChange={event=>setOpening(event.target.value)} required/></label><label className="field">Closing balance<input value={closing} onChange={event=>setClosing(event.target.value)} required/></label></div>{batch.source.rows.some(row=>row.dateBasis)&&<p>DateBasis records which date the bank supplied. Leave the other source date blank.</p>}<label className="field">Corrected CSV rows<textarea value={csv} onChange={event=>setCSV(event.target.value)} rows={12} spellCheck={false} required/></label><label className="field">Reason for correction<textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength={1000} required/></label></>}</fieldset>{reviewNotice}{error&&<p role="alert" className="document-message error">{error}</p>}{attempt.current&&!busy&&<p>Retry confirms this same request. Close to inspect the saved review before changing it.</p>}<div><button type="button" className="button secondary compact" disabled={busy} onClick={()=>guard.requestChange(finishEditing)}>Cancel</button><button className="button primary compact" disabled={busy||stale||!attempt.current&&batch.status!=='staged'}>{busy?'Saving…':attempt.current?'Confirm original save':mode==='group'?'Save selected classifications':'Save corrected extraction'}</button></div></form>}{(batch.extractionHistory?.length??0)>0&&<details><summary>{batch.extractionHistory!.length} previous extraction revisions</summary>{batch.extractionHistory!.map((entry,index)=><p key={index}>{entry.revisedAt} · {entry.reason} · {entry.source.rows.length} retained rows</p>)}</details>}{discard&&<DraftDiscardDialog open={discard} onDiscard={()=>{setDiscard(false);setMode('none');attempt.current=null;guard.discard();}} onKeepEditing={()=>{setDiscard(false);guard.keepEditing();}}/>}</section>;
}
