import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, AppState, Command } from '../../../shared/types.ts';
import { money, today } from '../../../shared/analytics.ts';
import type { PayoffResult } from '../../../shared/roadmap.ts';
import type { PayoffProjection } from '../../../shared/engine.ts';
import { useEngineProject } from '../../services/useEngine.ts';
import EngineStatus from '../../components/EngineStatus.tsx';
import { debtPaymentStatus } from '../../../shared/debt-status.ts';
import { debtInterestParts, debtRepaymentKind, effectiveDebtApr } from '../../../shared/debt-model.ts';
import { tdPlanningMinimumEstimate, tdRegularMinimumEstimate } from '../../../shared/td-minimum.ts';
import DebtModelFields, { debtModelDraft, parseDebtModelDraft } from './DebtModelFields.tsx';
import TdMinimumEstimate from './TdMinimumEstimate.tsx';
import Icon from '../../components/Icon.tsx';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
import './debt-scenario.css';

interface Props {
  onCommand: (command: Command) => Promise<void>;
  onOpen: (kind: 'transaction'|'account'|'reconcile', accountId?: string) => void;
}
const termsFor=(account:Account)=>account.debtTerms;
const dateLabel=(date:string)=>new Date(`${date}T12:00:00`).toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric'});

function numericCents(value:string):number|null {
  if(!/^(?:\d+|\d*\.\d{1,2})$/.test(value.trim()))return null;
  const [whole,fraction='']=value.trim().split('.');const number=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return Number.isSafeInteger(number)?number:null;
}
function payoffLabel(result:PayoffResult|null):string {
  if(!result||result.status==='needs_inputs')return 'Missing details';
  if(result.status==='below_interest')return 'Payment too low';
  if(result.status==='interest_only')return 'Interest only';
  if(result.status==='beyond_horizon')return 'Over 50 years';
  if(result.months===0)return 'Paid off';
  const end=new Date();end.setDate(1);end.setMonth(end.getMonth()+result.months!);
  return end.toLocaleDateString('en-CA',{month:'short',year:'numeric'});
}
function duration(months:number):string {
  if(months<12)return `${months} ${months===1?'month':'months'}`;
  const years=Math.floor(months/12);const remainder=months%12;
  return `${years} ${years===1?'year':'years'}${remainder?` ${remainder} mo`:''}`;
}
export default function DebtScenario({loan,state,readOnly,onCommand,onOpen,reviewRequest=0}:{loan:Account;state:AppState;readOnly:boolean;onCommand:Props['onCommand'];onOpen:Props['onOpen'];reviewRequest?:number}) {
  const terms=termsFor(loan);
  const [apr,setApr]=useState(terms?.aprPercent!=null?String(terms.aprPercent):'');
  const [payment,setPayment]=useState(terms?.minimumPaymentCents!=null?String(terms.minimumPaymentCents/100):'');
  const [confirmed,setConfirmed]=useState(!!terms?.rateConfirmed);
  const [statementDate,setStatementDate]=useState(terms?.statementDate??'');
  const [paymentDueDate,setPaymentDueDate]=useState(terms?.paymentDueDate??'');
  const [repaymentStatus,setRepaymentStatus]=useState(terms?.repaymentStatus??'repaying');
  const [statusSource,setStatusSource]=useState(terms?.repaymentStatusSource??'owner');
  const [statusDate,setStatusDate]=useState(terms?.repaymentStatusAsOf??'');
  const [schoolReturnMonth,setSchoolReturnMonth]=useState(terms?.schoolReturnMonth??'');
  const [voluntaryPayment,setVoluntaryPayment]=useState('');
  const [useEstimatedMinimum,setUseEstimatedMinimum]=useState(()=>tdPlanningMinimumEstimate(loan,today())!==null);
  const [model,setModel]=useState(()=>debtModelDraft(terms));
  const savedModel=JSON.stringify(debtModelDraft(terms));
  const savedDetails=JSON.stringify([savedModel,terms?.aprPercent!=null?String(terms.aprPercent):'',terms?.minimumPaymentCents!=null?String(terms.minimumPaymentCents/100):'',!!terms?.rateConfirmed,terms?.statementDate??'',terms?.paymentDueDate??'',terms?.repaymentStatus??'repaying',terms?.repaymentStatusSource??'owner',terms?.repaymentStatusAsOf??'',terms?.schoolReturnMonth??'']);
  const draftDetails=JSON.stringify([JSON.stringify(model),apr,payment,confirmed,statementDate,paymentDueDate,repaymentStatus,statusSource,statusDate,schoolReturnMonth]);
  const [baselineDetails,setBaselineDetails]=useState(savedDetails);
  const reportedInStudy=repaymentStatus==='in_study';
  const currentPaymentStatus=debtPaymentStatus({...loan,debtTerms:{...terms,aprPercent:terms?.aprPercent??null,rateConfirmed:terms?.rateConfirmed??false,minimumPaymentCents:terms?.minimumPaymentCents??null,notes:terms?.notes??'',repaymentStatus,studyEndDate:model.studyEndDate||null,repaymentStartDate:model.repaymentStartDate||null}});
  const inStudy=currentPaymentStatus==='in_study';
  const supportsInStudy=/\b(?:OSAP|NSLSC)\b|\b(?:Canada|Ontario)\b.*\bstudent loan\b/i.test(loan.name)||loan.debtTerms?.repaymentStatus==='in_study'||!!terms?.components?.length;
  const [extra,setExtra]=useState(0);
  const [saving,setSaving]=useState(false);const [message,setMessage]=useState('');
  const [discard,setDiscard]=useState(false);
  const guard=useDraftProtection({dirty:!readOnly&&draftDetails!==baselineDetails,busy:saving,onRequestDiscard:()=>setDiscard(true)});
  const [editRevision,setEditRevision]=useState(state.revision);
  const stale=state.revision!==editRevision;
  const detailsRef=useRef<HTMLDetailsElement>(null);
  function openDetails(){if(detailsRef.current){detailsRef.current.open=true;detailsRef.current.scrollIntoView({block:'nearest'});}}
  useEffect(()=>{if(reviewRequest>0)openDetails();},[reviewRequest]);
  function loadSavedDetails(){
    setModel(debtModelDraft(terms));
    setApr(terms?.aprPercent!=null?String(terms.aprPercent):'');
    setPayment(terms?.minimumPaymentCents!=null?String(terms.minimumPaymentCents/100):'');
    setConfirmed(!!terms?.rateConfirmed);
    setStatementDate(terms?.statementDate??'');setPaymentDueDate(terms?.paymentDueDate??'');
    setRepaymentStatus(terms?.repaymentStatus??'repaying');setStatusSource(terms?.repaymentStatusSource??'owner');setStatusDate(terms?.repaymentStatusAsOf??'');setSchoolReturnMonth(terms?.schoolReturnMonth??'');
    setBaselineDetails(savedDetails);setEditRevision(state.revision);setMessage('');
  }
  useEffect(()=>{
    if(draftDetails===savedDetails){setBaselineDetails(savedDetails);setEditRevision(state.revision);}
    else if(draftDetails===baselineDetails)loadSavedDetails();
  },[state.revision,savedDetails,draftDetails,baselineDetails]);
  const rate=/^(?:\d+|\d*\.\d+)$/.test(apr.trim())&&Number.isFinite(Number(apr))&&Number(apr)>=0&&Number(apr)<=1000?Number(apr):null;
  const recordedPayment=numericCents(payment);
  const previewTerms=useMemo(()=>{try {const parsed=parseDebtModelDraft(model);return {...terms,...parsed,repaymentKind:parsed.repaymentKind,interestStatus:parsed.interestStatus??(inStudy&&rate!==null?'accruing':undefined),aprPercent:rate,rateConfirmed:confirmed,minimumPaymentCents:recordedPayment,notes:terms?.notes??'',repaymentStatus,statementDate:statementDate||null,paymentDueDate:paymentDueDate||null};}catch{return null;}},[model,terms,rate,confirmed,recordedPayment,repaymentStatus,statementDate,paymentDueDate,inStudy]);
  const previewAccount=previewTerms?{...loan,debtTerms:previewTerms}:null;
  const parts=previewAccount?debtInterestParts(previewAccount):null;
  const previewRate=previewAccount?effectiveDebtApr(previewAccount):null;
  const modelKind=previewAccount?debtRepaymentKind(previewAccount):undefined;
  const minimumEstimate=previewAccount?tdRegularMinimumEstimate(previewAccount):null;
  const usingEstimate=!inStudy&&useEstimatedMinimum&&minimumEstimate!==null;
  const amount=inStudy?numericCents(voluntaryPayment):usingEstimate?minimumEstimate.amountCents:recordedPayment;
  const oneTimeDue=modelKind==='one_off'?paymentDueDate:null;
  const studyStatus=previewAccount?debtPaymentStatus(previewAccount):null;
  const payoffInput = {balanceCents:loan.balanceCents,aprPercent:previewRate,monthlyPaymentCents:amount??0,repaymentKind:inStudy?'fixed' as const:modelKind,...(model.split&&parts?{components:parts}:{})};
  const engine = useEngineProject<PayoffProjection>(state, loan.entityId, today(), amount===null&&loan.balanceCents!==0&&modelKind!=='interest_only' ? null : {kind:'payoff',draft:{input:payoffInput,extraPaymentCents:extra}});
  const result = engine.data;
  const canPreview = previewRate !== null && (amount !== null || modelKind === 'interest_only' || loan.balanceCents === 0);
  const savedInterest=result?.savedInterest??null;
  const savedMonths=result?.savedMonths??null;
  const changed=draftDetails!==savedDetails;
  const baselineLabel=inStudy?'Voluntary payment':usingEstimate?'Estimated minimum':modelKind==='interest_only'?'Interest-only payment':changed?'Entered payment':'Saved payment';
  async function save(){
    if(readOnly||saving||stale)return;
    if((apr.trim()&&rate===null)||(payment.trim()&&recordedPayment===null)){setMessage('Enter an APR from 0 to 1,000% and a payment with up to two decimal places. Leave unknown values blank.');return;}
    if(statusDate&&statusDate>today()){setMessage('Status date cannot be in the future.');return;}
    if(statementDate&&statementDate>today()){setMessage('Statement date cannot be in the future.');return;}
    if(statementDate&&paymentDueDate&&paymentDueDate<statementDate){setMessage('Payment due date cannot be before the statement date.');return;}
    setSaving(true);setMessage('');
    try{const parsed=parseDebtModelDraft(model);await onCommand({type:'set_debt_terms',expectedRevision:editRevision,accountId:loan.id,terms:{...terms,...parsed,repaymentKind:parsed.repaymentKind,interestStatus:parsed.interestStatus,aprPercent:rate,minimumPaymentCents:recordedPayment,repaymentStatus,repaymentStatusSource:statusSource,repaymentStatusAsOf:statusDate||null,schoolReturnMonth:schoolReturnMonth||null,rateConfirmed:rate!==null&&confirmed,statementDate:statementDate||null,paymentDueDate:paymentDueDate||null,notes:terms?.notes??''}});setApr(rate===null?'':String(rate));setPayment(recordedPayment===null?'':String(recordedPayment/100));setMessage('Debt details saved. Blank amounts remain unknown.');}
    catch(error){setMessage(error instanceof Error?error.message:'Could not save debt details.');}
    finally{setSaving(false);}
  }

  return <><section id="debt-payoff" className="night-glass debt-payoff-lab debt-scenario" aria-label={`${loan.name} payoff calculator`} tabIndex={-1}>
    <header className="debt-scenario-heading"><div><span>Payoff estimate</span><h2>{loan.name}</h2></div><div className="debt-scenario-balance"><span>Balance used</span><strong>{money(loan.balanceCents)}</strong></div></header>
    {studyStatus==='needs_confirmation'&&<p className="debt-base-warning" role="alert">The recorded study period has ended. Confirm the current required payment and repayment start. Mazal now treats the payment amount as unknown.</p>}
    {reportedInStudy&&studyStatus==='repaying'&&<p className="debt-base-warning" role="alert">The recorded repayment start has arrived. Your saved minimum is included again. Update the study status and current statement.</p>}
    {inStudy&&<p className="debt-scenario-status">Payments deferred. Any payment below is voluntary.</p>}
    <div className={`debt-scenario-workspace${canPreview ? '' : ' needs-setup'}`}>
      {!canPreview&&minimumEstimate&&!inStudy&&<label className="debt-scenario-estimate"><input type="checkbox" aria-label="Use estimated regular minimum for payoff" checked={useEstimatedMinimum} onChange={event=>setUseEstimatedMinimum(event.target.checked)}/><span>Use {money(minimumEstimate.amountCents)} estimated regular minimum<small>For this scenario. Your saved minimum stays unchanged.</small></span></label>}
      {canPreview && <div className="debt-scenario-controls">
    <div className="debt-extra-control"><label htmlFor="debt-extra"><span>Extra monthly payment</span><strong>{money(extra)}<small> / month</small></strong></label><input id="debt-extra" aria-label="Extra monthly payment" type="range" min="0" max="100000" step="2500" value={extra} disabled={previewRate===null||(amount===null&&modelKind!=='interest_only')||loan.balanceCents===0} onChange={e=>setExtra(Number(e.target.value))} aria-valuetext={`${money(extra)} extra per month`}/><div className="debt-extra-presets" aria-label="Extra payment amounts">{[0,10000,25000,50000,100000].map(value=><button key={value} aria-pressed={extra===value} disabled={previewRate===null||(amount===null&&modelKind!=='interest_only')||loan.balanceCents===0} onClick={()=>setExtra(value)}>{value===0?'No extra':`+${money(value)}`}</button>)}</div></div>
        <div className="debt-scenario-basis"><p>{previewRate!==null?`${Number(previewRate.toFixed(2))}% APR`:'APR not entered'}{!confirmed&&rate!==null?' · rate not checked':''}{amount!==null?` · ${money(amount)} ${inStudy?'voluntary':usingEstimate?'estimated minimum':'recorded payment'}`:modelKind==='interest_only'?' · interest-only payments':' · payment not entered'}</p><button type="button" className="text-button" onClick={openDetails}>Edit assumptions<Icon name="arrow" size={14}/></button></div>
        {minimumEstimate&&!inStudy&&<label className="debt-scenario-estimate"><input type="checkbox" aria-label="Use estimated regular minimum for payoff" checked={useEstimatedMinimum} onChange={event=>setUseEstimatedMinimum(event.target.checked)}/><span>Use {money(minimumEstimate.amountCents)} estimated regular minimum<small>For this scenario. Your saved minimum stays unchanged.</small></span></label>}
        {changed&&<p className="debt-unsaved">Using unsaved details</p>}
        <p className="debt-scenario-preview-note">Preview only. No payment or balance changes are saved.</p>
      </div>}
    <div className="debt-comparison" aria-live="polite">{engine.loading||engine.error?<EngineStatus {...engine}/>:result&&result.base.status!=='needs_inputs'&&result.extra.status!=='needs_inputs'?<><div className={`debt-comparison-dates${extra===0?' is-minimum-only':''}`}><div><span>{extra===0?inStudy?'Voluntary amount':'Estimated payoff':inStudy?'Voluntary amount':usingEstimate?'Estimated regular minimum':modelKind==='interest_only'?'Interest only':'Without extra'}</span><strong>{payoffLabel(result?.base??null)}</strong><small>{modelKind==='interest_only'&&!inStudy?'Monthly interest, recalculated':amount!==null?oneTimeDue?`${money(amount)} due ${dateLabel(oneTimeDue)}`:modelKind==='one_off'?`${money(amount)} once · due date not entered`:`${money(amount)} per month`:'Monthly payment needed'}</small></div>{extra>0&&<><Icon name="arrow" size={20}/><div><span>With {money(extra)} extra</span><strong>{payoffLabel(result?.extra??null)}</strong><small>{modelKind==='interest_only'&&!inStudy?`${money(extra)} principal plus monthly interest`:amount!==null?modelKind==='one_off'?`${money(amount)} once${extra>0?` + ${money(extra)} per month`:''}`:`${money(amount+extra)} per month`:'Monthly payment needed'}</small></div></>}</div>
      {result&&result.extra.status==='paid_off'&&loan.balanceCents>0?<DebtCurve base={result.base} extra={result.extra} balance={loan.balanceCents} compare={extra>0} baselineLabel={baselineLabel}/>:<div className="debt-payoff-message"><Icon name={loan.balanceCents===0?'check':'info'} size={21}/><p>{loan.balanceCents===0?'This debt is paid off.':result?.extra.status==='interest_only'?'Interest-only payments cover interest and leave principal outstanding. Add an extra principal payment to estimate a payoff date.':result?.extra.status==='below_interest'?'Payment does not exceed monthly interest. Increase it to reduce the balance.':result?.extra.status==='beyond_horizon'?'This payment does not clear the balance within 50 years.':'Enter the interest rate and monthly payment to estimate a payoff date.'}</p></div>}
      {result?.base.status==='below_interest'&&result.extra.status==='paid_off'&&<p className="debt-base-warning">The entered payment does not reduce the balance, so savings cannot be calculated.</p>}
      <div className={`debt-comparison-savings${extra===0?' is-minimum-only':''}`}>{extra>0?<><div><span>Time saved</span><strong>{savedMonths!==null?duration(savedMonths):'Not calculated'}</strong></div><div><span>Interest saved</span><strong>{savedInterest!==null?money(savedInterest):'Not calculated'}</strong></div></>:<div><span>Time to pay off</span><strong>{result.base.months!==null?duration(result.base.months):'Not calculated'}</strong></div>}<div><span>{extra>0?'Interest with extra payments':'Estimated interest'}</span><strong>{result?.extra.totalInterestCents!=null?money(result.extra.totalInterestCents):'Not calculated'}</strong></div></div>
    </>:<div className="debt-scenario-missing"><p className="debt-inputs-needed">{inStudy?'No required-payment payoff date is projected while in study. Enter a known APR and voluntary monthly amount to preview early repayment.':'Add the APR and monthly minimum. Use 0% only when the loan is confirmed interest-free.'}</p><button type="button" className="button secondary compact" onClick={openDetails}>Add missing details<Icon name="arrow" size={14}/></button></div>}</div>
    </div>
    <details id="debt-account-details" className="debt-scenario-details" ref={detailsRef}>
      <summary><span>Account details &amp; assumptions</span><small>{stale?'Saved records changed':changed?'Unsaved details':'APR, payment, dates and source'}</small></summary>
      <div className="debt-scenario-details-body">
    <div className="debt-selected-balance"><div><span>{loan.name}</span><strong>{money(loan.balanceCents)}</strong></div>{!readOnly&&<button className="text-button" onClick={()=>onOpen('reconcile',loan.id)}>Update balance<Icon name="arrow" size={14}/></button>}</div>
    {loan.evidence&&<p className="debt-local-note">{loan.evidence.asOf?`Balance reported ${dateLabel(loan.evidence.asOf)}.`:'Balance date not confirmed.'} {loan.evidence.status==='credit_report'?'Credit report balance. Check against the lender statement.':''} {loan.evidence.notes}</p>}
    {inStudy&&<div className="debt-study-note"><strong>No payment due now</strong><p>{loan.name} stays in your total debt. Required payments are excluded while the saved deferral applies.{statusDate?` Status recorded ${dateLabel(statusDate)}.`:''}</p><p>{model.repaymentStartDate?`Repayment starts ${dateLabel(model.repaymentStartDate)}. `:''}The controls below are optional for updating details or estimating voluntary payments. Interest is not assumed to be zero.</p></div>}
    {!readOnly&&supportsInStudy&&<div className="debt-lab-inputs debt-status-inputs"><label>Repayment status<select aria-label="Debt repayment status" disabled={saving} value={repaymentStatus} onChange={event=>{setRepaymentStatus(event.target.value as 'repaying'|'in_study');setMessage('');}}><option value="repaying">Repaying</option><option value="in_study">In study, payments deferred</option></select></label>{reportedInStudy&&<><label>Status source<select aria-label="Debt repayment status source" disabled={saving} value={statusSource} onChange={event=>{setStatusSource(event.target.value as 'owner'|'lender');setMessage('');}}><option value="owner">Reported by me</option><option value="lender">Confirmed by lender</option></select></label><label>Status date <span>optional</span><input type="date" aria-label="Debt repayment status date" disabled={saving} max={today()} value={statusDate} onChange={event=>{setStatusDate(event.target.value);setMessage('');}}/></label><label>School return <span>month, optional</span><input type="month" aria-label="School return month" disabled={saving} value={schoolReturnMonth} onChange={event=>{setSchoolReturnMonth(event.target.value);setMessage('');}}/></label></>}</div>}
    {!inStudy&&(terms?.statementDate||terms?.paymentDueDate)&&<p className="debt-local-note">{terms.statementDate?`Terms from the ${dateLabel(terms.statementDate)} statement.`:''}{terms.paymentDueDate?` Minimum due ${dateLabel(terms.paymentDueDate)}.`:''}{terms.paymentDueDate&&terms.paymentDueDate<today()?' That due date has passed. Check the latest statement before paying.':''}</p>}
    <div className="debt-lab-inputs"><label>{inStudy?'APR for voluntary estimate':'Interest rate'} <span>% APR</span><input type="number" aria-label="Debt scenario APR" disabled={saving} min="0" max="1000" step="0.01" value={apr} onChange={e=>{setApr(e.target.value);setConfirmed(false);setMessage('');}} placeholder="Not entered"/></label><label>{inStudy?'Voluntary monthly payment':oneTimeDue?'Recorded payment':'Recorded monthly minimum'} <span>CAD</span><input type="number" aria-label="Debt scenario monthly payment" disabled={saving} min="0" step="0.01" value={inStudy?voluntaryPayment:payment} onChange={e=>{if(inStudy)setVoluntaryPayment(e.target.value);else{setPayment(e.target.value);setUseEstimatedMinimum(false);}setMessage('');}} placeholder="Not entered"/></label></div><p className="debt-local-note">{inStudy?'Voluntary payments are a preview and are not saved as a required minimum. Leave the APR blank until the rate for this loan is known.':'Leave an unknown APR or payment blank. A zero means confirmed interest-free debt or no required payment.'}</p>
        {minimumEstimate&&<TdMinimumEstimate account={loan} estimate={minimumEstimate} historical={state.sourceFacts?.find(fact=>fact.id==='td-august-terms')}/>}
    {!readOnly&&!inStudy&&<div className="debt-lab-inputs"><label>Statement date <span>optional</span><input type="date" aria-label="Debt statement date" disabled={saving} max={today()} value={statementDate} onChange={event=>{setStatementDate(event.target.value);setMessage('');}}/></label><label>Payment due <span>optional</span><input type="date" aria-label="Debt payment due date" disabled={saving} min={statementDate||undefined} value={paymentDueDate} onChange={event=>{setPaymentDueDate(event.target.value);setMessage('');}}/></label></div>}
    <DebtModelFields value={model} onChange={setModel} supportsStudy={supportsInStudy} disabled={saving||readOnly}/>
    {model.split&&parts===null&&<p className="debt-base-warning">Complete both loan portions and reconcile their balances before projecting interest or payoff.</p>}
    {!readOnly&&stale&&<div className="mazal-form-notice" role="status"><p>Records changed. Your entries have been kept. Saved APR: {terms?.aprPercent??'unknown'}{terms?.aprPercent!=null?'%':''}. Saved minimum: {terms?.minimumPaymentCents!=null?money(terms.minimumPaymentCents):'unknown'}.</p><button type="button" className="button secondary compact" disabled={saving} onClick={()=>guard.requestChange(loadSavedDetails)}>Load saved details</button><button type="button" className="button secondary compact" disabled={saving} onClick={()=>{setBaselineDetails(savedDetails);setEditRevision(state.revision);setMessage('');}}>Keep my entries</button></div>}
    {!readOnly?<div className="debt-save-terms"><label><input type="checkbox" checked={confirmed} disabled={saving||rate===null} onChange={event=>{setConfirmed(event.target.checked);setMessage('');}}/>Rate matches my statement</label><button className="button secondary compact" disabled={saving||stale||!changed} onClick={save}>{saving?'Saving…':'Save details'}<Icon name="check" size={14}/></button></div>:<p className="debt-local-note">Read-only view. Changes are not saved.</p>}
    {message&&<p role="status" className="debt-save-message">{message}</p>}
<div className="debt-scenario-assumptions"><h3>Calculation assumptions</h3>{oneTimeDue&&<p>The recorded payment is due {dateLabel(oneTimeDue)}. This calculator applies the recorded amount once. Extra payments, if entered, repeat monthly.</p>}<p>Fixed APR, no new borrowing or fees. Monthly interest uses APR divided by 12. {modelKind==='interest_only'?'The interest-only scenario recalculates interest each month and adds the chosen extra principal payment.':modelKind==='one_off'?'The recorded obligation happens once.':'The monthly amount stays fixed; future statement minimums can change.'} Your lender may calculate it differently.</p>{model.split&&<p>Payments are allocated proportionally between components for this scenario. Confirm the lender's allocation before paying.</p>}</div>
      </div>
    </details>
  </section><DraftDiscardDialog open={discard} onDiscard={()=>{setDiscard(false);guard.discard();}} onKeepEditing={()=>{setDiscard(false);guard.keepEditing();}}/></>;
}
function DebtCurve({base,extra,balance,compare,baselineLabel}:{base:PayoffResult;extra:PayoffResult;balance:number;compare:boolean;baselineLabel:string}) {
  const months=Math.max(base.months??0,extra.months??0,1);
  const balanceLabel=money(balance);
  const left=8;
  const width=492-left;
  const path=(result:PayoffResult)=>[{month:0,balanceCents:balance},...result.schedule].map((point,index)=>`${index?'L':'M'}${left+point.month/months*width},${14+(1-point.balanceCents/balance)*110}`).join(' ');
  return <div className="debt-payoff-curve"><div className="debt-curve-plot"><div className="debt-curve-axis" aria-hidden="true"><span className="debt-curve-value">{balanceLabel}</span><span className="debt-curve-value">$0</span></div><svg viewBox="0 0 500 138" preserveAspectRatio="none" role="img" aria-label={`Balance starts at ${balanceLabel} and ends at $0. Debt clears in ${extra.months} months${compare?(base.months!==null?`, compared with ${base.months} months using the ${baselineLabel.toLowerCase()}`:`. The ${baselineLabel.toLowerCase()} has no payoff estimate`):''}.`}><line x1={left} x2="492" y1="14" y2="14"/><line x1={left} x2="492" y1="69" y2="69"/><line x1={left} x2="492" y1="124" y2="124"/>{compare&&base.status==='paid_off'&&<path className="debt-line-base" d={path(base)}/>}<path className="debt-line-extra" d={path(extra)}/><circle cx={left+extra.months!/months*width} cy="124" r="4"/></svg><div className="debt-curve-time" aria-hidden="true"><span>Today</span><span>{duration(months)}</span></div></div><div className="debt-curve-legend"><span><i/>{compare?'With extra payments':'Balance remaining'}</span>{compare&&base.status==='paid_off'&&<span><i/>{baselineLabel}</span>}</div></div>;
}
