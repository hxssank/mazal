import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import { useEffect, useId, useRef, useState } from 'react';
import type { AppState, Command, SolActivityKind, SolPosition } from '../../../shared/types';
import { money, today } from '../../../shared/analytics';
import { parseMoneyCents } from '../../../shared/money-input.ts';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
import { calculateSolActivity, solHistoryLabels, solMarketValue, summarizeSolHistory } from '../../../shared/sol-history';
import './investment-history.css';

interface Props { state:AppState; position:SolPosition; readOnly:boolean; onCommand:(command:Command)=>Promise<void> }
const formatSol = (value:string) => Number(value).toLocaleString('en-CA', { maximumFractionDigits:9 });
const signed = (value:number) => `${value > 0 ? '+' : ''}${money(value)}`;

function parseCents(value:string, label:string):number {
  return parseMoneyCents(value, { trim:false, invalidMessage:`${label} needs a CAD amount with at most two decimals.`, rangeMessage:`${label} is too large.` });
}

export default function InvestmentHistory({ state, position, readOnly, onCommand }:Props) {
  const id = useId();
  const recordButton = useRef<HTMLButtonElement>(null);
  const activityField = useRef<HTMLSelectElement>(null);
  const focusDestination = useRef<'form' | 'record' | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const target = focusDestination.current === 'form' && editing ? activityField.current : focusDestination.current === 'record' && !editing ? recordButton.current : null;
    focusDestination.current = null;
    if (target && !target.closest('[hidden]') && !document.querySelector('dialog[open]')) target.focus();
  }, [editing]);
  const [kind, setKind] = useState<SolActivityKind|'price'>('buy');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState((position.priceCents / 100).toFixed(2));
  const [fee, setFee] = useState('0');
  const [date, setDate] = useState(today());
  const [source, setSource] = useState('Manual entry');
  const [cashAccountId, setCashAccountId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const {changed, review:reviewRevision, prepare, resetRequest} = useCommandDraft(state.revision);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [attempt, setAttempt] = useState<Command | null>(null);
  const [discard, setDiscard] = useState(false);
  const fields = JSON.stringify({ kind, quantity, price, fee, date, source, cashAccountId, confirmed });
  const initialFields = useRef(fields);
  const protection = useDraftProtection({ dirty: editing && fields !== initialFields.current || !!attempt, busy: pending, onRequestDiscard: () => setDiscard(true) });
  const owner = state.accounts.find(account => account.id === position.accountId)?.entityId;
  const cashAccounts = state.accounts.filter(account => !account.closedAt && account.type === 'cash' && account.entityId === owner);
  const cash = cashAccounts.find(account => account.id === cashAccountId);
  const hasCash = kind === 'buy' || kind === 'sell' || kind === 'fee';
  const missingCash = hasCash && !!cashAccountId && !cash;
  const needsConfirmation = hasCash && cash?.reconciledAt === date;
  const history = position.history ?? [];
  const summary = summarizeSolHistory(position);
  let cashChange:number|null = null;
  let previewError = '';
  let tradeValue:number|null = null;
  try {
    if (kind !== 'price') {
      const result = calculateSolActivity({ ...position, priceCents:kind === 'fee' ? position.priceCents : parseCents(price, 'Price') }, { kind, quantitySol:kind === 'fee' ? '0' : quantity, feeCents:kind === 'reward' ? 0 : parseCents(fee, 'Fee') });
      cashChange = result.cashDeltaCents;
      tradeValue = result.amountCents;
    }
  } catch (failure) { previewError = failure instanceof Error ? failure.message : 'Check the activity.'; }

  function openForm() {
    focusDestination.current = 'form';
    initialFields.current = JSON.stringify({ kind, quantity: '', price: (position.priceCents / 100).toFixed(2), fee: '0', date: today(), source, cashAccountId, confirmed: false });
    setQuantity('');
    setFee('0');
    setPrice((position.priceCents / 100).toFixed(2));
    setDate(today());
    setConfirmed(false);
    reviewRevision(true);
    setError('');
    setEditing(true);
  }
  function closeForm() { focusDestination.current = 'record'; setEditing(false); setAttempt(null); resetRequest(); }

  async function submit(event:React.FormEvent) {
    event.preventDefault();
    if (pending || readOnly) return;
    setError('');
    try {
      if (changed) throw new Error('Records changed while this form was open. Review the updated records first.');
      if (attempt) { setPending(true); await onCommand(attempt); closeForm(); setQuantity(''); setFee('0'); setConfirmed(false); return; }
      if (missingCash) throw new Error('The selected cash account is closed or unavailable. Choose another account or choose Cash not linked.');
      if (previewError && kind !== 'price') throw new Error(previewError);
      const priceCents = kind === 'fee' ? position.priceCents : parseCents(price, 'Price');
      if (kind !== 'fee' && !priceCents) throw new Error('Price must be greater than zero.');
      if (kind !== 'fee' && !source.trim()) throw new Error('Enter the price source.');
      if (needsConfirmation && !confirmed) throw new Error('Confirm that this happened after the cash balance check.');
      const payload = kind === 'price' ? { type:'save_sol' as const, accountId:position.accountId, liquidSol:position.liquidSol, stakedSol:position.stakedSol, costBasisCents:position.costBasisCents, priceCents, priceDate:date, priceSource:source.trim() } : { type:'record_sol_activity' as const, positionId:position.id, kind, quantitySol:kind === 'fee' ? '0' : quantity, priceCents, feeCents:kind === 'reward' ? 0 : parseCents(fee, 'Fee'), date, priceSource:kind === 'fee' ? position.priceSource ?? 'Previously saved manual price' : source.trim(), ...(hasCash && cashAccountId ? { cashAccountId, afterBalanceConfirmation:confirmed } : {}) };
      setPending(true);
      const command = prepare({ ...payload, requestId:'' });
      setAttempt(command);
      await onCommand(command);
      closeForm();
      setQuantity('');
      setFee('0');
      setConfirmed(false);
    } catch (failure) { if (isConfirmedCommandRejection(failure)) { setAttempt(null); resetRequest(); } setError(failure instanceof Error ? failure.message : 'Could not save the activity.'); }
    finally { setPending(false); }
  }

  return <div className="investment-history">
    <DraftDiscardDialog open={discard} uncertain={!!attempt} onKeepEditing={() => { protection.keepEditing(); setDiscard(false); }} onDiscard={() => { closeForm(); setDiscard(false); protection.discard(); }}/>
    <div className="investment-history-heading"><h4>Activity & prices</h4>{!readOnly && !editing && <button ref={recordButton} type="button" className="button secondary compact" onClick={openForm}>Record activity</button>}</div>
    <p className="investment-history-note">{position.priceSource ?? 'Manual price'} · Quote dated {position.priceDate}.{position.priceDate < today() ? ' This is not a live price.' : ''}</p>
    {!history.length && <p className="investment-history-note">Your current holding is a balance snapshot. History starts with your next recorded activity.</p>}
    {editing && <form onSubmit={submit} className="investment-history-form">
      <fieldset className="investment-history-entry" disabled={pending || !!attempt}>
      <div className="investment-history-fields">
        <label htmlFor={`${id}-kind`}>Activity<select ref={activityField} id={`${id}-kind`} value={kind} disabled={pending} onChange={event => { setKind(event.target.value as typeof kind); setConfirmed(false); }}><option value="buy">Buy SOL</option><option value="sell">Sell unstaked SOL</option><option value="reward">Staking reward</option><option value="fee">CAD fee</option><option value="price">Update price only</option></select></label>
        <label htmlFor={`${id}-date`}>{kind === 'price' ? 'Price date' : 'Activity date'}<input id={`${id}-date`} type="date" value={date} max={today()} min={history.at(-1)?.date ?? position.priceDate} required disabled={pending} onChange={event => { setDate(event.target.value); setConfirmed(false); }}/></label>
        {kind !== 'fee' && kind !== 'price' && <label htmlFor={`${id}-quantity`}>SOL quantity<input id={`${id}-quantity`} inputMode="decimal" value={quantity} placeholder="0.00" required disabled={pending} onChange={event => setQuantity(event.target.value)}/></label>}
        {kind !== 'fee' && <label htmlFor={`${id}-price`}>{kind === 'price' ? 'CAD per SOL' : 'CAD per SOL on this date'}<input id={`${id}-price`} inputMode="decimal" value={price} required disabled={pending} onChange={event => setPrice(event.target.value)}/></label>}
        {hasCash && <label htmlFor={`${id}-fee`}>{kind === 'fee' ? 'Fee paid in CAD' : 'Fee in CAD'}<input id={`${id}-fee`} inputMode="decimal" value={fee} required disabled={pending} onChange={event => setFee(event.target.value)}/></label>}
        {kind !== 'fee' && <label htmlFor={`${id}-source`}>Price source<input id={`${id}-source`} value={source} maxLength={200} required disabled={pending} placeholder="Exchange, statement or manual entry" onChange={event => setSource(event.target.value)}/></label>}
        {hasCash && <label className="investment-history-wide" htmlFor={`${id}-cash`}>{kind === 'sell' ? 'Cash received into' : 'Paid from'}<select id={`${id}-cash`} value={cashAccountId} disabled={pending} onChange={event => { setCashAccountId(event.target.value); setConfirmed(false); }}>{missingCash&&<option value={cashAccountId} disabled>{state.accounts.find(account=>account.id===cashAccountId)?.name??'Selected account'} · unavailable</option>}<option value="">Cash not linked</option>{cashAccounts.map(account => <option key={account.id} value={account.id}>{account.name} · {money(account.balanceCents)}</option>)}</select></label>}
      </div>
      {kind === 'price' ? <p className="investment-history-note">Updates the CAD valuation. Quantities and cash stay the same.</p> : <div className="investment-history-preview">
        {tradeValue !== null && kind !== 'fee' && <p>{kind === 'reward' ? 'Reward value' : 'Trade value'} <strong>{money(tradeValue)}</strong></p>}
        {hasCash && (missingCash ? <p role="alert">The selected cash account is closed or unavailable. Choose another account or choose Cash not linked.</p> : cash ? <p>{cash.name} {cashChange === null ? '' : signed(cashChange)}{cashChange !== null && <> · After <strong>{money(cash.balanceCents + cashChange)}</strong></>}</p> : <p>Cash is not linked. {kind === 'fee' ? 'This fee reduces the recorded result only.' : 'This trade changes your SOL holding only.'} No bank balance changes.</p>)}
        {kind === 'reward' && <p>Added to staked SOL. No cash deposit or purchase is recorded.</p>}
        {kind === 'sell' && <p>Remaining recorded cost uses the average cost per SOL. Staked SOL must be unstaked before selling.</p>}
        {previewError && quantity && <p className="negative">{previewError}</p>}
      </div>}
      {needsConfirmation && <label className="investment-history-confirm"><input type="checkbox" checked={confirmed} disabled={pending} onChange={event => setConfirmed(event.target.checked)}/>This happened after the cash balance check on {date}.</label>}
      </fieldset>
      {attempt && <p className="investment-history-note" role="status">Confirm the original save before changing its details. Retrying this request cannot record another trade, reward or fee. If it was not saved before another change, close this form and reopen the latest holding.</p>}
      {changed && <p role="alert">Records changed. Review the current holding and cash balance. <button type="button" className="text-button" disabled={pending} onClick={() => { reviewRevision(true); if (!attempt) setConfirmed(false); setError(''); }}>Use updated records</button></p>}
      {error && <p className="negative" role="alert">{error}</p>}
      <div className="investment-history-actions"><button type="button" className="button secondary compact" disabled={pending} onClick={() => protection.requestChange(closeForm)}>Cancel</button><button type="submit" className="button primary compact" disabled={pending || changed || !attempt && missingCash}>{pending ? 'Saving…' : attempt ? 'Confirm original save' : kind === 'price' ? 'Save price' : 'Save activity'}</button></div>
    </form>}
    {history.length > 0 && <details className="investment-history-records">
      <summary>{history.length} {history.length === 1 ? 'record' : 'records'} since {summary.startDate}</summary>
      <p className="investment-history-note">Opening value {money(summary.openingValueCents ?? 0)}. Earlier returns are unknown. Corrections do not count as earnings.</p>
      {history.length > 1 && <dl className="investment-history-summary">
        <div><dt>Purchases</dt><dd>{money(summary.purchasesCents)}</dd></div><div><dt>Sales before fees</dt><dd>{money(summary.salesCents)}</dd></div>
        <div><dt>Rewards at entry price</dt><dd>{money(summary.rewardsCents)}</dd></div><div><dt>Fees</dt><dd>{money(summary.feesCents)}</dd></div>
        <div><dt>Market change</dt><dd>{signed(summary.marketChangeCents)}</dd></div><div><dt>Balance corrections</dt><dd>{signed(summary.correctionsCents)}</dd></div>
        <div className="investment-history-result"><dt>Rewards + market change − fees</dt><dd>{signed(summary.resultCents)}</dd></div>
      </dl>}
      <ol className="investment-history-list">{[...history].reverse().slice(0, showAll ? undefined : 12).map(entry => <li key={entry.id}><details><summary><span>{solHistoryLabels[entry.kind]}<small>{entry.date}</small></span><strong>{entry.kind === 'fee' ? money(entry.feeCents) : ['buy','sell','reward'].includes(entry.kind) ? `${formatSol(entry.quantitySol)} SOL` : money(solMarketValue(entry))}</strong></summary><dl><div><dt>Holding after entry</dt><dd>{formatSol(entry.liquidSol)} liquid + {formatSol(entry.stakedSol)} staked SOL</dd></div><div><dt>Recorded cost after entry</dt><dd>{money(entry.costBasisCents)}</dd></div><div><dt>Quote</dt><dd>{money(entry.priceCents)} / SOL · {entry.priceDate} · {entry.priceSource}</dd></div>{entry.amountCents > 0 && <div><dt>Activity value</dt><dd>{money(entry.amountCents)}</dd></div>}{entry.feeCents > 0 && <div><dt>Fee</dt><dd>{money(entry.feeCents)}</dd></div>}{['buy','sell','fee'].includes(entry.kind) && <div><dt>Cash account</dt><dd>{entry.cashAccountId ? state.accounts.find(account => account.id === entry.cashAccountId)?.name ?? 'Account unavailable' : 'Not linked'}</dd></div>}</dl></details></li>)}</ol>
      {history.length > 12 && <button type="button" className="text-button" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show latest 12' : `Show all ${history.length} records`}</button>}
    </details>}
  </div>;
}
