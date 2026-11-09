import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { money, today } from '../../../shared/analytics';
import { purchaseAccountId, purchaseRemaining } from '../../../shared/asset-purchases';
import type { AppState, AssetPurchase, Command } from '../../../shared/types';
import Icon from '../../components/Icon';
import { parseMoneyCents } from '../../../shared/money-input.ts';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import './asset-purchases.css';

type Props = { state: AppState; purchases: AssetPurchase[]; readOnly: boolean; onCommand: (command: Command) => Promise<void>; onAddAccount: () => void };
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });

export default function AssetPurchases({ state, purchases, readOnly, onCommand, onAddAccount }: Props) {
  const cards=useRef<HTMLElement>(null);
  const [requestedId]=useState(()=>new URLSearchParams(window.location.hash.split('?')[1]).get('record'));
  const requestedPurchase=purchases.some(purchase=>purchase.id===requestedId);
  const [editor, setEditor] = useState<{ purchase: AssetPurchase | null; payment: boolean } | null>(null);
  useEffect(() => { if (readOnly) setEditor(null); }, [readOnly]);
  useEffect(()=>{
    if(!requestedId||!requestedPurchase)return;
    const frame=window.requestAnimationFrame(()=>{
      const card=[...(cards.current?.querySelectorAll<HTMLElement>('[data-purchase-id]')??[])].find(element=>element.dataset.purchaseId===requestedId);
      if(!card)return;
      const toolbar=card.closest('.app-shell')?.querySelector('.glass-toolbar');
      card.style.scrollMarginTop=`${Math.max(0,toolbar?.getBoundingClientRect().bottom??0)+12}px`;
      card.focus({preventScroll:true});card.scrollIntoView({block:'start'});
    });
    return()=>window.cancelAnimationFrame(frame);
  },[requestedId,requestedPurchase]);
  return <section ref={cards} className="asset-purchases" aria-label="Purchases in progress">
    <div className="assets-items-heading"><div><h2>Purchases in progress</h2>{!purchases.length&&<p>Add a purchase you are paying toward.</p>}</div>{!readOnly&&<button className="button secondary" type="button" onClick={()=>setEditor({purchase:null,payment:false})}><Icon name="plus" size={16}/>Add purchase</button>}</div>
    {purchases.map(purchase => {
      const remaining = purchaseRemaining(purchase);
      const complete = remaining === 0;
      const percent = purchase.paidCents === null ? null : purchase.paidCents / purchase.targetCents * 100;
      const cash = state.accounts.filter(account => !account.closedAt && account.entityId === purchase.entityId && account.type === 'cash');
      const payments = state.transactions.filter(transaction => transaction.toAccountId === purchaseAccountId(purchase.id)).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
      const installments = state.obligations.filter(item => item.assetPurchaseId === purchase.id && item.status === 'planned').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      return <article className="panel asset-purchase-card" key={purchase.id} data-purchase-id={purchase.id} tabIndex={-1} aria-label={`${purchase.name} purchase`}>
        <div className="asset-purchase-heading"><div><span className="eyebrow">{complete ? 'Purchase complete' : 'Buying from ' + purchase.payee}</span><h2>{purchase.name}</h2></div><span className="asset-purchase-badge">{complete ? 'Paid in full' : 'Asset purchase'}</span></div>
        <div className="asset-purchase-amount"><strong>{purchase.paidCents === null ? 'Amount paid unknown' : money(purchase.paidCents)}</strong><span>of {money(purchase.targetCents)} to own it</span></div>
        {percent !== null && <div className="asset-purchase-track" role="progressbar" aria-label={`${purchase.name} purchase progress`} aria-valuemin={0} aria-valuemax={purchase.targetCents} aria-valuenow={purchase.paidCents!} aria-valuetext={`${money(purchase.paidCents!)} of ${money(purchase.targetCents)} paid`}><span style={{ width: `${percent}%` }}/></div>}
        <div className="asset-purchase-facts"><span>{money(purchase.monthlyCents)} / month to {purchase.payee}</span>{remaining !== null && <span>{money(remaining)} left{remaining > 0 && purchase.monthlyCents > 0 ? ` · ${Math.ceil(remaining / purchase.monthlyCents)} monthly payments` : ''}</span>}</div>
        <p className="asset-purchase-accounting">{purchase.paidCents === null ? 'Confirm what you have paid to start tracking progress.' : `Confirmed ${dateLabel(purchase.paidAsOf)}. ${money(purchase.paidCents)} counts toward your assets.`} Payments and repairs count toward ownership. Gas stays in expenses.</p>
        {installments.length > 0 ? <details className="asset-purchase-notes"><summary>Scheduled installments · {installments.length}</summary><ul>{installments.map(item => <li key={item.id}><span>{item.name} · {dateLabel(item.dueDate)} · {item.recurrence === 'once' ? 'Once' : item.recurrence === 'monthly' ? 'Monthly' : 'Every two weeks'}</span><strong>{money(item.amountCents)}</strong></li>)}</ul><p>These bills count toward this purchase in the plan. Mark an installment paid from Expenses to record its contribution once.</p></details> : !complete && <p className="asset-purchase-accounting">No installment is scheduled. Add a bill in Expenses and link it to this purchase to include its payments in your cash plan.</p>}
        {purchase.notes && <details className="asset-purchase-notes"><summary>Purchase notes</summary><p>{purchase.notes}</p></details>}
        {!!payments.length && <details className="asset-purchase-notes"><summary>Recent contributions</summary><ul>{payments.map(payment => <li key={payment.id}><span>{dateLabel(payment.date)} · {payment.source === 'Car repair contribution' ? 'Repair' : 'Payment'} · {state.accounts.find(account => account.id === payment.accountId)?.name}</span><strong>{money(payment.amountCents)}</strong></li>)}</ul></details>}
        {!readOnly && <div className="asset-purchase-actions"><button type="button" className="button secondary compact" onClick={() => setEditor({ purchase, payment: false })}>{purchase.paidCents === null ? 'Confirm amount paid' : 'Edit purchase'}</button>{!complete && purchase.paidCents !== null && (cash.length ? <button type="button" className="button primary compact" onClick={() => setEditor({ purchase, payment: true })}><Icon name="plus" size={15}/>Record contribution</button> : <button type="button" className="text-button" onClick={onAddAccount}>Add a cash account to record contributions <Icon name="arrow" size={14}/></button>)}</div>}
      </article>;
    })}
    {editor && !readOnly && <PurchaseEditor key={`${editor.purchase?.id??'new'}-${editor.payment}`} state={state} purchase={editor.purchase} payment={editor.payment} onCommand={onCommand} onClose={() => setEditor(null)}/>}
  </section>;
}

function parseCents(value: string, label: string): number {
  return parseMoneyCents(value, { maxCents:100_000_000_000_000, invalidMessage:`Enter ${label.toLowerCase()} with up to two decimal places.`, rangeMessage:`${label} exceeds the supported amount.` });
}
const amount = (cents: number) => (cents / 100).toFixed(2);

function purchaseDraft(purchase:AssetPurchase|null,payment:boolean,cashAccountId:string) {
  return { name: purchase?.name??'', payee: purchase?.payee??'', paid: purchase?.paidCents == null ? '' : amount(purchase.paidCents), date: payment ? today() : purchase?.paidAsOf || today(), target: purchase ? amount(purchase.targetCents):'', monthly: purchase?amount(purchase.monthlyCents):'', amount: purchase?amount(Math.min(purchase.monthlyCents, purchaseRemaining(purchase) ?? purchase.monthlyCents)):'', accountId: cashAccountId, notes: payment ? '' : purchase?.notes??'', contributionKind: 'payment' };
}

function PurchaseEditor({ state, purchase:initialPurchase, payment, onCommand, onClose }: { state: AppState; purchase: AssetPurchase | null; payment: boolean; onCommand: Props['onCommand']; onClose: () => void }) {
  const [purchase,setPurchase] = useState(initialPurchase);
  const dialog = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const editingFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const {changed:stale, review:reviewRevision, prepare, resetRequest} = useCommandDraft(state.revision);
  const entityId = purchase?.entityId ?? state.entities.find(entity=>entity.kind==='personal')?.id ?? '';
  const purchaseId = useRef(purchase?.id ?? crypto.randomUUID());
  const cash = state.accounts.filter(account => !account.closedAt && account.entityId === entityId && account.type === 'cash');
  const [draft, setDraft] = useState(() => purchaseDraft(purchase,payment,cash[0]?.id ?? ''));
  const initial = useRef(JSON.stringify(draft));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saveAttempt, setSaveAttempt] = useState<Command | null>(null);
  const [discard, setDiscard] = useState(false);
  const protection = useDraftProtection({ dirty: JSON.stringify(draft) !== initial.current || !!saveAttempt, busy: saving, onRequestDiscard: () => { editingFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDiscard(true); } });
  const set = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { if (element?.open) element.close(); }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (discard) keepEditingRef.current?.focus(); }, [discard]);
  const latestPurchase = purchase ? (state.assetPurchases ?? []).find(item => item.id === purchase.id) ?? null : null;
  const recordChanged = JSON.stringify(latestPurchase) !== JSON.stringify(purchase);
  function reviewUpdated() {
    if (recordChanged) {
      if (!latestPurchase) return;
      const next = purchaseDraft(latestPurchase,payment,cash[0]?.id ?? '');
      setPurchase(latestPurchase); setDraft(next); initial.current = JSON.stringify(next);
    }
    reviewRevision(); setError(''); setDiscard(false);
  }
  function close() {
    if (saving || discard) return;
    protection.requestChange(onClose);
  }
  function keepEditing() { protection.keepEditing(); setDiscard(false); window.requestAnimationFrame(() => editingFocus.current?.focus()); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || discard) return;
    setError('');
    try {
      if (saveAttempt) { setSaving(true); await onCommand(saveAttempt); onClose(); return; }
      if (stale) throw new Error('Review the updated records before saving this purchase.');
      if (!payment && (!draft.name.trim() || !draft.payee.trim())) throw new Error('Enter the purchase name and who you are paying.');
      if (payment && !cash.some(account => account.id === draft.accountId)) throw new Error('Choose an open cash account for this contribution.');
      const base = payment && purchase ? {
        type: 'record_asset_purchase_payment' as const, contributionKind: draft.contributionKind as 'payment' | 'repair', id: purchase.id, expected: purchase, accountId: draft.accountId, amountCents: parseCents(draft.amount, 'Payment amount'), date: draft.date, notes: draft.notes.trim(),
      } : {
        type: 'save_asset_purchase' as const, expected: purchase, purchase: { ...purchase, id: purchaseId.current, entityId, name: draft.name.trim(), payee: draft.payee.trim(), targetCents: parseCents(draft.target, 'Purchase target'), monthlyCents: parseCents(draft.monthly, 'Monthly payment'), paidCents: draft.paid.trim() ? parseCents(draft.paid, 'Amount paid') : null, paidAsOf: draft.paid.trim() ? draft.date : '', notes: draft.notes.trim() },
      };
      const command = prepare({...base, requestId:''});
      setSaveAttempt(command);
      setSaving(true);
      await onCommand(command);
      onClose();
    } catch (failure) { if (isConfirmedCommandRejection(failure)) { setSaveAttempt(null); resetRequest(); } setError(failure instanceof Error ? failure.message : 'Could not save the purchase. Your entries are still here.'); }
    finally { setSaving(false); }
  }
  const amountField = (label: string, key: 'paid' | 'target' | 'monthly' | 'amount', required = true) => <label className="field"><span>{label} · CAD</span><input value={draft[key]} onChange={event => set(key, event.target.value)} inputMode="decimal" required={required} autoComplete="off" placeholder={required ? '0.00' : 'Unknown'}/></label>;
  return <dialog ref={dialog} className="portfolio-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (discard) keepEditing(); else close(); }}>
    <header className="portfolio-dialog-header"><h2 id={titleId}>{payment ? 'Record contribution' : purchase ? 'Edit ' + purchase.name : 'Add purchase'}</h2><button type="button" className="icon-button" aria-label="Close purchase dialog" disabled={saving || discard} onClick={close}><Icon name="close"/></button></header>
    <form onSubmit={event => void save(event)}><fieldset className="portfolio-dialog-body" disabled={saving || discard || !!saveAttempt}>
      {payment ? <><label className="field"><span>Contribution type</span><select value={draft.contributionKind} onChange={event => set('contributionKind', event.target.value)} autoFocus><option value="payment">Payment to {purchase?.payee}</option><option value="repair">Car repair</option></select></label><label className="field"><span>Paid from</span><select value={draft.accountId} onChange={event => set('accountId', event.target.value)} required>{cash.map(account => <option key={account.id} value={account.id}>{account.name} · {money(account.balanceCents)}</option>)}</select></label>{amountField('Payment amount', 'amount')}<p className="portfolio-dialog-note">This reduces cash and adds the same amount toward ownership. Repairs count toward the target. Gas does not.</p></> : <><div className="form-grid"><label className="field"><span>Purchase name</span><input value={draft.name} required maxLength={100} onChange={event=>set('name',event.target.value)}/></label><label className="field"><span>Paying whom</span><input value={draft.payee} required maxLength={100} onChange={event=>set('payee',event.target.value)}/></label></div><div className="form-grid">{amountField('Purchase target', 'target')}{amountField('Monthly payment', 'monthly')}</div>{amountField('Total already paid', 'paid', false)}<p className="portfolio-dialog-note">Confirm the total credited toward this purchase, including payments to {draft.payee||'the seller'} and repair contributions already recorded here. This updates asset value without changing cash.</p></>}
      <label className="field"><span>{payment ? 'Payment date' : 'Paid total confirmed on'}</span><input type="date" value={draft.date} max={today()} min={payment ? purchase?.paidAsOf : undefined} onChange={event => set('date', event.target.value)} required={payment || !!draft.paid.trim()}/></label>
      <label className="field"><span>{payment && draft.contributionKind === 'repair' ? 'Repair or vendor notes · optional' : 'Notes · optional'}</span><textarea value={draft.notes} onChange={event => set('notes', event.target.value)} rows={3} maxLength={payment ? 250 : 2000}/></label>
    </fieldset>{saveAttempt && !saving && <p className="portfolio-dialog-note" role="status">The original save needs confirmation. Retrying checks the same request without posting another contribution. Close and check your records before starting a new edit.</p>}{stale && !saveAttempt && <div className="mazal-form-notice" role="status"><p>Records changed. {recordChanged ? latestPurchase ? `Saved purchase: ${latestPurchase.name}, ${latestPurchase.paidCents === null ? 'paid total unknown' : `${money(latestPurchase.paidCents)} paid`}. Loading it replaces this draft.` : 'This purchase was removed. Close this editor to continue.' : 'This purchase is unchanged. Your draft can be kept.'}</p>{(!recordChanged || latestPurchase) && <button type="button" className="button secondary" disabled={saving} onClick={reviewUpdated}>{recordChanged ? 'Load saved purchase' : 'Review updated records'}</button>}</div>}{error && <div className="portfolio-form-error" ref={errorRef} role="alert" tabIndex={-1}>{error}</div>}<footer className="portfolio-dialog-footer">{discard ? <><span role="alert">{saveAttempt ? 'Close and check records? The original save may already be recorded.' : 'Discard unsaved changes?'}</span><button type="button" className="button primary" ref={keepEditingRef} onClick={keepEditing}>Keep editing</button><button type="button" className="button secondary" onClick={() => { setDiscard(false); protection.discard(); }}>{saveAttempt ? 'Close and check records' : 'Discard'}</button></> : <><button type="button" className="button secondary" disabled={saving} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={saving||stale&&!saveAttempt}>{saving ? 'Saving...' : saveAttempt ? 'Confirm original save' : payment ? 'Record contribution' : 'Save purchase'}</button></>}</footer></form>
  </dialog>;
}
