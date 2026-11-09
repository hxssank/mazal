import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AppState, Command, TrackedAsset, WishItem } from '../../../shared/types';
import { money, today } from '../../../shared/analytics';
import Icon from '../../components/Icon';
import { parseMoneyCents } from '../../../shared/money-input.ts';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import './asset-editor.css';

interface Props {
  asset: TrackedAsset | null;
  recordSale: boolean;
  state: AppState;
  onCommand: (command: Command) => Promise<void>;
  onClose: () => void;
  fromWish?: WishItem;
}

const categories = ['Essentials', 'Tools', 'Toys', 'Computers', 'Phones', 'Audio', 'Cameras', 'Gaming', 'Equipment', 'Vehicles', 'Electronics', 'Home', 'Other'];
const amountText = (value: number | null) => value === null ? '' : (value / 100).toFixed(2);

function integerCents(value: string, label: string) {
  return parseMoneyCents(value, { leadingDecimal:true, maxCents:100_000_000_000_000, invalidMessage:`${label} must be zero or more, with up to two decimal places.`, rangeMessage:`${label} exceeds the supported amount.` });
}

function validateDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error(`Choose a valid ${label.toLowerCase()}.`);
  if (value > today()) throw new Error(`${label} cannot be in the future.`);
  return value;
}

function assetDraft(asset:TrackedAsset|null, recordSale:boolean) {
  return {
    name: asset?.name || '',
    category: asset?.category || 'Essentials',
    purchaseDate: asset?.purchaseDate ?? '',
    cost: asset ? amountText(asset.costCents) : '',
    fees: amountText(asset?.feesCents ?? 0),
    estimated: asset ? amountText(asset.estimatedValueCents) : '',
    status: recordSale ? 'sold' as const : asset?.status || 'owned',
    soldDate: asset?.soldDate || today(),
    sale: asset?.saleCents !== null && asset?.saleCents !== undefined ? amountText(asset.saleCents) : '',
    notes: asset?.notes || '',
    cashAccountId: asset?.salePosting?.cashAccountId ?? '',
    afterBalanceConfirmation: false,
  };
}

export default function AssetEditor({ asset:initialAsset, recordSale, state, onCommand, onClose, fromWish }: Props) {
  const [asset,setAsset] = useState(initialAsset);
  const dialog = useRef<HTMLDialogElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const {changed:stale, review:reviewRevision, prepare, resetRequest} = useCommandDraft(state.revision);
  const itemId = useRef(asset?.id || crypto.randomUUID());
  const linkedSale = !!asset?.salePosting;
  const entityId = asset?.entityId || fromWish?.entityId || state.entities.find(entity => entity.kind === 'personal')?.id || '';
  const [draft, setDraft] = useState(() => ({ ...assetDraft(asset,recordSale), ...(fromWish ? { name: fromWish.name, cost: amountText(fromWish.costCents), notes: fromWish.comment } : {}) }));
  const initialDraft = useRef(draft);
  const [closeIntent, setCloseIntent] = useState(false);
  const [undoIntent, setUndoIntent] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const editingFocus = useRef<HTMLElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conversionAttempt, setConversionAttempt] = useState<Extract<Command, { type: 'convert_wish_to_asset' }> | null>(null);
  const set = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => setDraft(previous => ({ ...previous, [key]: value, ...((key==='soldDate'||key==='cashAccountId')?{afterBalanceConfirmation:false}:{}) }));
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) { element.showModal(); initialFocusRef.current?.focus(); }
    return () => { if (element?.open) element.close(); };
  }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (closeIntent||undoIntent) keepEditingRef.current?.focus(); }, [closeIntent,undoIntent]);
  const cashAccounts = state.accounts.filter(account=>!account.closedAt&&account.entityId===entityId&&account.type==='cash');
  const receivingAccount = (linkedSale ? state.accounts : cashAccounts).find(account=>account.id===draft.cashAccountId);
  const saleNeedsCash = draft.status==='sold'&&asset?.status!=='sold';
  const sameDayBalance = saleNeedsCash&&!!receivingAccount?.reconciledAt&&draft.soldDate===receivingAccount.reconciledAt;
  const saleDateError = saleNeedsCash&&receivingAccount?.reconciledAt&&draft.soldDate<receivingAccount.reconciledAt ? `Choose a sale date on or after ${receivingAccount.reconciledAt}. That bank balance already includes earlier receipts; this sale cannot be posted twice.` : sameDayBalance&&!draft.afterBalanceConfirmation ? 'Confirm that this money arrived after the bank balance check before recording the sale.' : '';
  const latestAsset = asset ? state.assets?.find(item => item.id === asset.id) ?? null : null;
  const assetChanged = JSON.stringify(latestAsset) !== JSON.stringify(asset);
  const isDirty = (Object.keys(draft) as (keyof typeof draft)[]).some(key => draft[key] !== initialDraft.current[key]);
  const protection = useDraftProtection({ dirty: isDirty || !!conversionAttempt, busy: saving || undoIntent, onRequestDiscard: () => { setCloseIntent(true); } });

  function reviewUpdated() {
    if (assetChanged) {
      if (!latestAsset) return;
      const next = assetDraft(latestAsset,recordSale && latestAsset.status !== 'sold');
      setAsset(latestAsset); setDraft(next); initialDraft.current = next;
    } else setDraft(current => ({...current,afterBalanceConfirmation:false}));
    reviewRevision(!!conversionAttempt); setError(''); setUndoIntent(false);
  }

  function requestClose() {
    if (saving || closeIntent || undoIntent) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement.matches('input, select, textarea')) editingFocus.current = document.activeElement;
    protection.requestChange(onClose);
  }

  function keepEditing() {
    protection.keepEditing();
    setCloseIntent(false);
    window.requestAnimationFrame(() => editingFocus.current?.focus());
  }

  let cashReceived: number | null = null;
  try { if(draft.status==='sold') cashReceived = integerCents(draft.sale,'Sale amount')-integerCents(draft.fees,'Selling fees'); } catch { /* Wait for complete amounts. */ }
  let previewProfit: number | null = null;
  try { if (draft.status === 'sold') previewProfit = integerCents(draft.sale, 'Sale amount') - integerCents(draft.cost, 'Purchase cost') - integerCents(draft.fees, 'Selling fees'); } catch { /* Wait for complete amounts. */ }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || closeIntent || undoIntent) return;
    setError('');
    try {
      if (stale) throw new Error('Review the updated records before saving this item.');
      if (conversionAttempt) { setSaving(true); await onCommand(prepare(conversionAttempt)); onClose(); return; }
      if (!draft.name.trim()) throw new Error('Enter an item name.');
      if (!draft.category.trim()) throw new Error('Choose a category.');
      if (!state.entities.some(entity => entity.id === entityId && entity.kind === 'personal')) throw new Error('Your workspace could not be loaded. Reload before saving this item.');
      const purchaseDate = draft.purchaseDate ? validateDate(draft.purchaseDate, 'Purchase date') : null;
      const soldDate = draft.status === 'sold' ? validateDate(draft.soldDate, 'Sale date') : null;
      if (soldDate && purchaseDate && soldDate < purchaseDate) throw new Error('The sale date cannot be before the purchase date.');
      if(saleNeedsCash&&!receivingAccount)throw new Error('Choose the cash account that received the sale proceeds.');
      if(saleDateError)throw new Error(saleDateError);
      if(saleNeedsCash&&cashReceived!==null&&cashReceived<0)throw new Error('Selling fees cannot exceed the sale amount.');
      const savedAsset:TrackedAsset = {
        id: itemId.current, entityId, name: draft.name.trim(), category: draft.category.trim(), purchaseDate,
        costCents: draft.cost.trim() ? integerCents(draft.cost, 'Purchase cost') : null,
        estimatedValueCents: draft.status === 'sold' ? asset?.estimatedValueCents ?? null : draft.estimated.trim() ? integerCents(draft.estimated, 'Resale estimate') : null,
        status: draft.status, soldDate, saleCents: draft.status === 'sold' ? integerCents(draft.sale, 'Sale amount') : null,
        feesCents: integerCents(draft.fees, 'Selling fees'), notes: draft.notes.trim(),
        ...(asset?.salePosting?{salePosting:asset.salePosting}:{}),
      };
      const base = fromWish ? {type:'convert_wish_to_asset' as const,id:fromWish.id,expected:fromWish,asset:savedAsset,requestId:''} : saleNeedsCash ? {type:'record_asset_sale' as const,asset:savedAsset,expected:asset,cashAccountId:draft.cashAccountId,afterBalanceConfirmation:sameDayBalance&&draft.afterBalanceConfirmation} : {type:'save_asset' as const,asset:savedAsset};
      const command = prepare(base.type==='record_asset_sale'?{...base,requestId:''}:base);
      if (command.type === 'convert_wish_to_asset') setConversionAttempt(command);
      setSaving(true);
      await onCommand(command);
      onClose();
    } catch (failure) { if (isConfirmedCommandRejection(failure)) { setConversionAttempt(null); resetRequest(); } setError(failure instanceof Error ? failure.message : 'Could not save this item. Your entries are still here.'); }
    finally { setSaving(false); }
  }


  async function undoSale(){
    if(!asset?.salePosting||saving||stale)return;
    const base={type:'undo_asset_sale' as const,id:asset.id,expected:asset};
    setSaving(true);setError('');
    try{await onCommand(prepare({...base,requestId:''}));onClose();}
    catch(failure){setError(failure instanceof Error?failure.message:'Could not undo this sale.');}
    finally{setSaving(false);}
  }

  function amountField(label: string, key: 'cost' | 'estimated' | 'sale' | 'fees') {
    const optional = key === 'cost' || key === 'estimated';
    return <label className="field asset-editor-amount"><span>{label}{optional && <small> · optional</small>}</span><span className="asset-editor-money-input"><span aria-hidden="true">$</span><input ref={recordSale && key === 'sale' ? initialFocusRef : undefined} aria-label={`${label} in CAD`} disabled={linkedSale&&(key==='sale'||key==='fees')} inputMode="decimal" value={draft[key]} onChange={event => set(key, event.target.value)} required={!optional} placeholder={optional ? 'Not confirmed' : '0.00'} autoComplete="off"/><span aria-hidden="true">CAD</span></span></label>;
  }

  return <dialog ref={dialog} className="portfolio-dialog asset-editor-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (undoIntent) setUndoIntent(false); else if (closeIntent) keepEditing(); else requestClose(); }} onClick={event => {
    if (event.target !== event.currentTarget || saving) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestClose();
  }}>
    <header className="portfolio-dialog-header asset-editor-header"><div><span className="asset-editor-kicker">Your items</span><h2 id={titleId}>{recordSale ? 'Record sale' : asset ? 'Edit item' : 'Add item'}</h2></div><button className="icon-button" type="button" aria-label="Close item dialog" disabled={saving || closeIntent || undoIntent} onClick={requestClose}><Icon name="close"/></button></header>
    <form onSubmit={event => void save(event)} onFocusCapture={event => { if (event.target instanceof HTMLElement && event.target.matches('input, select, textarea')) editingFocus.current = event.target; }}>
      <fieldset disabled={saving || closeIntent || undoIntent || !!conversionAttempt} className="portfolio-dialog-body asset-editor-body">
        <label className="field asset-editor-name"><span>Item name</span><input ref={!recordSale ? initialFocusRef : undefined} value={draft.name} onChange={event => set('name', event.target.value)} required maxLength={160} placeholder="e.g. Cordless drill"/></label>
        <div className="asset-editor-amounts">{amountField('Purchase cost', 'cost')}{draft.status === 'sold' ? amountField('Sale amount', 'sale') : amountField('Resale estimate', 'estimated')}</div>
        <div className="asset-editor-category-row"><label className="field"><span>Category</span><select value={draft.category} onChange={event => set('category', event.target.value)} required>{!categories.includes(draft.category) && <option value={draft.category}>{draft.category}</option>}{categories.map(category => <option value={category} key={category}>{category}</option>)}</select></label><div className="asset-editor-quick-categories" role="group" aria-label="Quick categories">{['Tools', 'Toys', 'Essentials'].map(category => <button type="button" key={category} aria-pressed={draft.category === category} onClick={() => set('category', category)}>{category}{draft.category === category && <Icon name="check" size={13}/>}</button>)}</div></div>
        {!fromWish && <div className="asset-editor-status"><span id={`${titleId}-status`}>Status</span><div role="group" aria-labelledby={`${titleId}-status`}>{([{ value: 'owned', label: 'Owned' }, { value: 'listed', label: 'For sale' }, { value: 'sold', label: 'Sold' }] as const).map(status => <button type="button" key={status.value} aria-pressed={draft.status === status.value} disabled={linkedSale} onClick={() => set('status', status.value)}>{status.label}</button>)}</div></div>}
        <div className="asset-editor-dates"><label className="field"><span>Purchase date <small>· optional</small></span><input type="date" aria-label="Purchase date" max={today()} value={draft.purchaseDate} onChange={event => set('purchaseDate', event.target.value)}/></label>{draft.status === 'sold' && <label className="field"><span>Sale date</span><input type="date" disabled={linkedSale} min={draft.purchaseDate || undefined} max={today()} value={draft.soldDate} onChange={event => set('soldDate', event.target.value)} required/></label>}</div>
        {amountField(draft.status === 'sold' ? 'Selling fees' : 'Expected selling fees', 'fees')}
        {draft.status === 'sold' && <div className="portfolio-sale-preview"><span>Gain or loss after fees</span><strong className={previewProfit !== null && previewProfit < 0 ? 'negative' : ''}>{previewProfit === null ? 'Enter the amounts' : money(previewProfit)}</strong></div>}
        {saleNeedsCash&&<><label className="field"><span>Received into</span><select aria-label="Sale proceeds cash account" required value={draft.cashAccountId} onChange={event=>set('cashAccountId',event.target.value)}><option value="">Choose cash account</option>{cashAccounts.map(account=><option key={account.id} value={account.id}>{account.name} · {money(account.balanceCents)}</option>)}</select></label>{!cashAccounts.length&&<p className="portfolio-dialog-note">Add a cash account before recording this sale.</p>}{sameDayBalance&&<label className="cash-posting-confirmation"><input type="checkbox" required checked={draft.afterBalanceConfirmation} onChange={event=>set('afterBalanceConfirmation',event.target.checked)}/><span>This money arrived after the balance check on {receivingAccount!.reconciledAt}.</span></label>}{saleDateError&&<p className="portfolio-form-error" role="alert">{saleDateError}</p>}<div className="portfolio-sale-preview"><span>Cash received after fees</span><strong>{cashReceived===null?'Enter the amounts':money(cashReceived)}</strong></div></>}
        {linkedSale&&<p className="portfolio-dialog-note">Sale proceeds were posted to {receivingAccount?.name??'the saved cash account'}. Undo the sale before changing its date, amount, fees, or status.</p>}
        <label className="field"><span>Comment <small>optional</small></span><textarea value={draft.notes} onChange={event => set('notes', event.target.value)} maxLength={1000} rows={2} placeholder="Condition, accessories, or anything to remember"/></label>
        <p className="portfolio-dialog-note">{fromWish ? 'Saving moves this wish into your owned items. Add the actual purchase cost when known. This does not change cash or add an expense; keep the existing purchase record or record it separately.' : saleNeedsCash?'Saving records the sale and adds its proceeds after fees to the cash account in one step.':linkedSale?'Item notes and purchase details can be edited without reposting the sale.':'Recording an item does not change cash. Record its purchase separately if it is not already in your bank balance.'}</p>
      </fieldset>
      {conversionAttempt && <p className="portfolio-dialog-note" role="status">Confirm the original save before editing. The wish may already have moved into owned items. Retrying this save cannot add it twice.</p>}
      {stale && <div className="mazal-form-notice" role="status"><p>Records changed. {assetChanged ? latestAsset ? `Saved item: ${latestAsset.name}, ${latestAsset.status}, ${latestAsset.estimatedValueCents === null ? 'resale value not confirmed' : `estimate ${money(latestAsset.estimatedValueCents)}`}. Loading it replaces this draft.` : 'This item was removed. Close this editor to continue.' : 'This item is unchanged. Your draft can be kept.'}</p>{(!assetChanged || latestAsset) && <button type="button" className="button secondary" disabled={saving} onClick={reviewUpdated}>{assetChanged ? 'Load saved item' : 'Review updated records'}</button>}</div>}
      {error && <div className="portfolio-form-error" tabIndex={-1} role="alert" ref={errorRef}>{error}</div>}
      <footer className={`portfolio-dialog-footer asset-editor-footer${closeIntent||undoIntent ? ' is-confirming' : ''}`}>
        {undoIntent?<><div className="portfolio-discard-message" role="alert"><strong>Undo this sale?</strong><p>This removes {money((asset?.saleCents??0)-(asset?.feesCents??0))} from {receivingAccount?.name??'the receiving account'} and returns the item to Owned.</p></div><div className="portfolio-discard-actions"><button ref={keepEditingRef} type="button" className="button secondary" disabled={saving} onClick={()=>setUndoIntent(false)}>Keep sale</button><button type="button" className="button primary" disabled={saving} onClick={()=>void undoSale()}>{saving?'Undoing...':'Undo sale'}</button></div></>:closeIntent ? <><div className="portfolio-discard-message" role="alert"><strong>{conversionAttempt ? 'Close and check owned items? The original save may already be recorded.' : 'Discard unsaved changes?'}</strong></div><div className="portfolio-discard-actions"><button ref={keepEditingRef} className="button primary" type="button" onClick={keepEditing}>Keep editing</button><button className="button secondary" type="button" onClick={() => { setCloseIntent(false); protection.discard(); }}>Discard changes</button></div></> : <>{linkedSale&&<button className="text-button" type="button" disabled={saving||isDirty||stale} onClick={()=>setUndoIntent(true)}>Undo sale</button>}<button className="button secondary" type="button" disabled={saving} onClick={requestClose}>Cancel</button><button className="button primary" type="submit" disabled={saving||stale}>{saving ? 'Saving...' : conversionAttempt ? 'Confirm original save' : saleNeedsCash ? 'Record sale' : asset ? 'Save changes' : 'Add item'}<Icon name="check" size={15}/></button></>}
      </footer>
    </form>
  </dialog>;
}
