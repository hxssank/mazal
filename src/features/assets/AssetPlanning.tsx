import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AppState, Command, MoneyOwed, OwedPayment, WishItem } from '../../../shared/types';
import { owedPaid, owedRemaining, parseAssetMoney } from '../../../shared/asset-planning';
import { money as cash, today } from '../../../shared/analytics';
import Icon from '../../components/Icon';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import AssetEditor from './AssetEditor.tsx';
import './asset-planning.css';

interface Props {
  state: AppState;
  readOnly: boolean;
  onCommand: (command: Command) => Promise<void>;
  section?: 'all' | 'priorities' | 'owed';
}
type Editor = { kind: 'wish'; item: WishItem | null } | { kind: 'tab'; tab: MoneyOwed | null } | { kind: 'payment'; tab: MoneyOwed } | { kind: 'undo'; tab: MoneyOwed; payment: OwedPayment };
const amountText = (cents: number | null) => cents === null ? '' : (cents / 100).toFixed(2);
const dateText = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });

export default function AssetPlanning({ state, readOnly, onCommand, section = 'all' }: Props) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [purchasedWish, setPurchasedWish] = useState<WishItem | null>(null);
  const entityId = state.entities.find(entity => entity.kind === 'personal')?.id;
  const wishes = (state.wishItems ?? []).filter(item => item.entityId === entityId);
  const tabs = (state.moneyOwed ?? []).filter(tab => tab.entityId === entityId);
  const wishTotal = wishes.reduce((sum, item) => sum + (item.costCents ?? 0), 0);
  const pricedWishes = wishes.filter(item => item.costCents !== null);
  const totalOwed = tabs.reduce((sum, tab) => sum + tab.amountCents, 0);
  const paid = tabs.reduce((sum, tab) => sum + owedPaid(tab), 0);
  const remaining = totalOwed - paid;
  useEffect(() => { if (readOnly) setEditor(null); }, [readOnly]);

  return <div className="asset-planning">
    {section !== 'owed' && <section className={`panel wish-basket purchase-priorities${wishes.length ? '' : ' is-empty'}`} aria-label="Wish basket">
      <header className="asset-planning-heading"><div><h2>Purchase priorities</h2><p>{wishes.length ? 'Essentials first. Optional purchases follow.' : 'No purchases planned.'}</p></div>{!readOnly && <button className="button primary compact" type="button" onClick={() => setEditor({ kind: 'wish', item: null })}><Icon name="plus" size={16}/>Add wish</button>}</header>
      {wishes.length > 0 && <div className="asset-planning-total"><strong>{pricedWishes.length ? cash(wishTotal) : 'Price needed'}</strong><span>{pricedWishes.length ? `Known prices · ${pricedWishes.length} of ${wishes.length} ${wishes.length === 1 ? 'item' : 'items'}` : `${wishes.length} ${wishes.length === 1 ? 'item needs' : 'items need'} a price`}</span></div>}
      {wishes.length > 0 && <div className="wish-priority-groups">{(['essential', 'optional', 'unassigned'] as const).map(priority => {
        const group = wishes.filter(item => (item.priority ?? 'unassigned') === priority);
        if (priority === 'unassigned' && !group.length) return null;
        const label = priority === 'essential' ? 'Essential' : priority === 'optional' ? 'Optional' : 'Unassigned';
        return <section className={`wish-priority-group priority-${priority}`} aria-label={`${label} purchases`} key={priority}>
          <div className="wish-group-heading"><h3>{label}</h3><span>{group.length}</span></div>
          {group.length ? <ul className="wish-list">{group.map(item => <li key={item.id}>
            <span className="wish-item-symbol" aria-hidden="true">{/glasses|eyewear/i.test(item.name) ? <svg viewBox="0 0 32 22" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 8 5 2M30 8 27 2M12 10c2-3 6-3 8 0M2 8h10v7a5 5 0 0 1-10 0V8Zm18 0h10v7a5 5 0 0 1-10 0V8Z"/></svg> : <Icon name={priority === 'essential' ? 'check' : 'plus'} size={18}/>}</span>
            <div className="wish-item-copy"><h4>{item.name}</h4>{item.comment && <p>{item.comment}</p>}</div><div className="wish-item-end"><strong className={item.costCents === null ? 'price-needed' : ''}>{item.costCents === null ? 'Price needed' : cash(item.costCents)}</strong>{!readOnly && <><button type="button" className="text-button" aria-label={`Edit wish ${item.name}`} onClick={() => setEditor({ kind: 'wish', item })}>{item.costCents === null ? 'Add price' : 'Edit'}</button><button type="button" className="text-button" aria-label={`Add ${item.name} to owned items`} onClick={() => setPurchasedWish(item)}>Add to owned items</button></>}</div>
          </li>)}</ul> : <p className="wish-group-empty">{priority === 'essential' ? 'No essentials added.' : 'No optional purchases planned.'}</p>}
        </section>;
      })}</div>}
      {wishes.length > 0 && <p className="asset-planning-footnote">Planned purchases. No money set aside or spent.</p>}
    </section>}

    {section !== 'priorities' && <section className="panel money-owed" aria-label="Owed to me">
      <header className="asset-planning-heading"><div className="owed-heading"><h2>Owed to me</h2>{tabs.length > 1 && <span><strong>{cash(remaining)}</strong> remaining</span>}</div>{!readOnly && <button className="button secondary compact" type="button" onClick={() => setEditor({ kind: 'tab', tab: null })}><Icon name="plus" size={16}/>Add person</button>}</header>
      {tabs.length ? <div className="owed-tabs">{tabs.map(tab => {
        const balance = owedRemaining(tab);
        return <article className="owed-tab" key={tab.id}>
          <div className="owed-person"><span className="owed-avatar"><Icon name={balance ? 'person' : 'check'} size={19}/></span><div><h3>{tab.name}</h3><span>{balance ? `${cash(owedPaid(tab))} repaid of ${cash(tab.amountCents)}` : 'Paid in full'}</span></div><strong>{cash(balance)}</strong></div>
          {tab.comment && <details className="owed-notes"><summary aria-label={`Notes for ${tab.name}`}>Notes</summary><p className="owed-comment">{tab.comment}</p></details>}
          {!readOnly && <div className="owed-actions">{balance > 0 && <button className="button primary compact" type="button" aria-label={`Record payment from ${tab.name}`} onClick={() => setEditor({ kind: 'payment', tab })}><Icon name="plus" size={15}/>Record payment</button>}<button type="button" className="text-button" aria-label={`Edit tab for ${tab.name}`} onClick={() => setEditor({ kind: 'tab', tab })}>Edit tab</button></div>}
          {tab.payments.length > 0 && <details className="owed-history"><summary>Payment history · {tab.payments.length}</summary><ul>{[...tab.payments].reverse().map(payment => <li key={payment.id}><div><span>{dateText(payment.date)}{payment.cashAccountId?` · ${state.accounts.find(account=>account.id===payment.cashAccountId)?.name??'Cash account'}`:''}</span>{payment.comment && <p>{payment.comment}</p>}</div><strong>{cash(payment.amountCents)}</strong>{!readOnly && <button type="button" className="text-button" aria-label={`Undo ${cash(payment.amountCents)} payment from ${tab.name} on ${dateText(payment.date)}`} onClick={() => setEditor({ kind: 'undo', tab, payment })}>Undo</button>}</li>)}</ul></details>}
        </article>;
      })}</div> : <p className="wish-group-empty">No amounts owed to you recorded.</p>}
      <p className="asset-planning-footnote">Outstanding amounts count toward Home net worth. Repayments move that amount into the cash account you choose.</p>
    </section>}
    {!readOnly && editor && <PlanningEditor key={`${editor.kind}-${editor.kind === 'wish' ? editor.item?.id ?? 'new' : editor.tab?.id ?? 'new'}`} editor={editor} state={state} onCommand={onCommand} onClose={() => setEditor(null)}/>}
    {!readOnly && purchasedWish && <AssetEditor key={`wish-${purchasedWish.id}`} asset={null} fromWish={purchasedWish} recordSale={false} state={state} onCommand={onCommand} onClose={() => setPurchasedWish(null)}/>}
  </div>;
}

function planningDraft(editor:Editor) {
  const original = editor.kind === 'wish' ? editor.item : editor.kind === 'tab' ? editor.tab : null;
  return { name:original?.name ?? '', amount:original ? amountText('costCents' in original ? original.costCents : original.amountCents) : '', priority:editor.kind === 'wish' ? editor.item?.priority ?? '' : '', comment:original?.comment ?? '', date:today(), cashAccountId:'', afterBalanceConfirmation:false };
}

function PlanningEditor({ editor:initialEditor, state, onCommand, onClose }: { editor: Editor; state: AppState; onCommand: Props['onCommand']; onClose: () => void }) {
  const [editor,setEditor] = useState(initialEditor);
  const dialog = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const {changed:stale, review:reviewRevision, prepare} = useCommandDraft(state.revision);
  const itemId = useRef(crypto.randomUUID());
  const original = editor.kind === 'wish' ? editor.item : editor.kind === 'tab' ? editor.tab : null;
  const [draft, setDraft] = useState(() => planningDraft(editor));
  const initialDraft = useRef(draft);
  const [intent, setIntent] = useState<'discard' | 'delete' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initialDraft.current);
  const editingFocus = useRef<HTMLElement | null>(null);
  const protection = useDraftProtection({ dirty: isDirty, busy: saving || intent === 'delete', onRequestDiscard: () => setIntent('discard') });
  const set = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => setDraft(previous => ({ ...previous, [key]: value, ...((key==='date'||key==='cashAccountId')?{afterBalanceConfirmation:false}:{}) }));
  const title = editor.kind === 'wish' ? original ? 'Edit wish' : 'Add to wish basket' : editor.kind === 'tab' ? original ? 'Edit tab' : 'Add someone who owes you' : editor.kind === 'payment' ? 'Record a repayment' : 'Undo this payment?';
  const entityId = (editor.kind === 'payment' || editor.kind === 'undo' ? editor.tab.entityId : original?.entityId) ?? state.entities.find(entity => entity.kind === 'personal')?.id ?? '';
  const cashAccounts = state.accounts.filter(account=>!account.closedAt&&account.entityId===entityId&&account.type==='cash');
  const receivingAccount = cashAccounts.find(account=>account.id===draft.cashAccountId);
  const sameDayBalance = editor.kind==='payment'&&!!receivingAccount?.reconciledAt&&draft.date===receivingAccount.reconciledAt;
  const receivedDateError = editor.kind==='payment'&&receivingAccount?.reconciledAt&&draft.date<receivingAccount.reconciledAt ? `Choose a date on or after ${dateText(receivingAccount.reconciledAt)}. That bank balance already includes earlier receipts; this payment cannot be posted twice.` : sameDayBalance&&!draft.afterBalanceConfirmation ? 'Confirm that this money arrived after the bank balance check before recording it.' : '';
  useEffect(() => { const element = dialog.current; element?.showModal(); element?.querySelector<HTMLInputElement>('input')?.focus(); return () => { if (element?.open) element.close(); }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (intent) keepEditingRef.current?.focus(); }, [intent]);
  const latestEditor:Editor|null = (() => {
    if (editor.kind === 'wish') return editor.item ? (state.wishItems ?? []).find(item => item.id === editor.item!.id) ? { kind:'wish',item:(state.wishItems ?? []).find(item => item.id === editor.item!.id)! } : null : editor;
    if (editor.kind === 'tab' && !editor.tab) return editor;
    const tab = (state.moneyOwed ?? []).find(item => item.id === editor.tab!.id);
    if (!tab) return null;
    if (editor.kind === 'undo') { const payment = tab.payments.find(item => item.id === editor.payment.id); return payment ? {kind:'undo',tab,payment} : null; }
    return {kind:editor.kind,tab};
  })();
  const recordChanged = JSON.stringify(latestEditor) !== JSON.stringify(editor);
  function reviewUpdated() {
    if (!latestEditor) return;
    if (recordChanged) { const next = planningDraft(latestEditor); setEditor(latestEditor); setDraft(next); initialDraft.current = next; }
    else setDraft(current => ({...current,afterBalanceConfirmation:false}));
    reviewRevision(); setError(''); setIntent(null);
  }
  function close() { if (saving || intent) return; protection.requestChange(onClose); }
  function keepEditing() {
    const removing = intent === 'delete';
    protection.keepEditing(); setIntent(null);
    window.requestAnimationFrame(() => {
      const previous = removing ? removeRef.current : editingFocus.current;
      const target = previous?.isConnected && !previous.matches(':disabled') ? previous : dialog.current?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)');
      target?.focus({ preventScroll: true });
    });
  }
  async function run(command: Command) {
    if (stale) { setError('Review the updated records before saving.'); return; }
    setSaving(true);
    try { await onCommand(prepare(command)); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save. Your entries are still here.'); }
    finally { setSaving(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || intent) return;
    setError('');
    try {
      if (editor.kind === 'undo') {
        await run({ type: 'remove_owed_payment', id: editor.tab.id, expected: editor.tab, paymentId: editor.payment.id, requestId: '' });
        return;
      }
      if (editor.kind !== 'payment' && !draft.name.trim()) throw new Error(editor.kind === 'wish' ? 'Enter an item name.' : 'Enter a name for this tab.');
      if (editor.kind === 'wish') {
        const costCents = draft.amount.trim() ? parseAssetMoney(draft.amount, 'Cost') : null;
        const priority = draft.priority === 'essential' || draft.priority === 'optional' ? draft.priority : undefined;
        await run({ type: 'save_wish_item', item: { id: original?.id ?? itemId.current, entityId, name: draft.name.trim(), costCents, comment: draft.comment.trim(), ...(priority ? {priority} : {}) }, expected: editor.item, requestId: '' });
      } else {
        const amountCents = parseAssetMoney(draft.amount, 'Amount');
        if (editor.kind === 'tab') {
          if (amountCents <= 0) throw new Error('Enter an amount greater than zero.');
          if (editor.tab && amountCents < owedPaid(editor.tab)) throw new Error('The original amount cannot be less than the repayments already recorded.');
          await run({ type: 'save_money_owed', tab: { id: original?.id ?? itemId.current, entityId, name: draft.name.trim(), amountCents, comment: draft.comment.trim(), payments: editor.tab?.payments ?? [] }, expected: editor.tab, requestId: '' });
        } else {
          if (!receivingAccount) throw new Error('Choose the cash account that received this payment.');
          if (receivedDateError) throw new Error(receivedDateError);
          if (amountCents <= 0) throw new Error('Enter a payment greater than zero.');
          if (amountCents > owedRemaining(editor.tab)) throw new Error('This payment is more than the remaining tab.');
          if (!draft.date || draft.date > today()) throw new Error('Choose today or a past payment date.');
          await run({ type: 'record_owed_payment', id: editor.tab.id, expected: editor.tab, cashAccountId: draft.cashAccountId, afterBalanceConfirmation: sameDayBalance&&draft.afterBalanceConfirmation, payment: { id: itemId.current, amountCents, date: draft.date, comment: draft.comment.trim() }, requestId: '' });
        }
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check your entries.'); }
  }
  function remove() {
    if (saving) return;
    setError('');
    if (editor.kind === 'wish' && editor.item) void run({ type: 'delete_wish_item', id: editor.item.id, expected: editor.item, requestId: '' });
    if (editor.kind === 'tab' && editor.tab) void run({ type: 'delete_money_owed', id: editor.tab.id, expected: editor.tab, requestId: '' });
  }
  let paymentPreview: number | null = null;
  if (editor.kind === 'payment') {
    try { const amount = parseAssetMoney(draft.amount, 'Payment'); if (amount > 0 && amount <= owedRemaining(editor.tab)) paymentPreview = owedRemaining(editor.tab) - amount; } catch { /* The form reports an invalid amount on submit. */ }
  }
  return <dialog ref={dialog} className="portfolio-dialog planning-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (saving) return; if (intent) keepEditing(); else close(); }} onClick={event => { if (event.target !== event.currentTarget) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); }}>
    <header className="portfolio-dialog-header"><div><span className="asset-planning-kicker">{editor.kind === 'wish' ? 'Wish basket' : 'Owed to me'}</span><h2 id={titleId}>{title}</h2></div><button type="button" className="icon-button" aria-label="Close dialog" disabled={saving || !!intent} onClick={close}><Icon name="close"/></button></header>
    <form onSubmit={event => void save(event)}>
      <fieldset className="portfolio-dialog-body" disabled={saving || !!intent} onFocusCapture={event => { if (event.target instanceof HTMLElement && event.target.matches('input,select,textarea')) editingFocus.current = event.target; }}>
        {editor.kind === 'undo' ? <div className="owed-undo-preview"><p>Remove the {cash(editor.payment.amountCents)} repayment from {editor.tab.name} on {dateText(editor.payment.date)}.</p>{editor.payment.cashAccountId&&<p>This also removes {cash(editor.payment.amountCents)} from {state.accounts.find(account=>account.id===editor.payment.cashAccountId)?.name??'the receiving account'}.</p>}<div><span>Remaining after undo</span><strong>{cash(owedRemaining(editor.tab) + editor.payment.amountCents)}</strong></div></div> : <>
          {editor.kind === 'payment' ? <div className="owed-payment-context"><span>{editor.tab.name}</span><strong>{cash(owedRemaining(editor.tab))} remaining</strong></div> : <label className="field"><span>{editor.kind === 'wish' ? 'Item name' : 'Person or tab name'}</span><input autoFocus value={draft.name} required maxLength={160} placeholder={editor.kind === 'wish' ? 'e.g. Cordless drill' : 'e.g. Alex'} onChange={event => set('name', event.target.value)}/></label>}
          {editor.kind === 'wish' && <label className="field"><span>Priority</span><select aria-label="Purchase priority" value={draft.priority} onChange={event => set('priority', event.target.value)}><option value="">Unassigned</option><option value="essential">Essential</option><option value="optional">Optional</option></select></label>}
          <label className="field planning-amount"><span>{editor.kind === 'wish' ? 'Cost · optional' : editor.kind === 'tab' ? 'Original amount owed' : 'Payment received'} · CAD</span><input autoFocus={editor.kind === 'payment'} inputMode="decimal" required={editor.kind !== 'wish'} autoComplete="off" placeholder={editor.kind === 'wish' ? 'Price not known yet' : '0.00'} value={draft.amount} onChange={event => set('amount', event.target.value)}/></label>
          {editor.kind === 'payment' && <><button type="button" className="text-button owed-fill-payment" onClick={() => set('amount', amountText(owedRemaining(editor.tab)))}>Use full remaining amount</button><label className="field"><span>Payment date</span><input type="date" required min="1900-01-01" max={today()} value={draft.date} onChange={event => set('date', event.target.value)}/></label></>}
          {editor.kind==='payment'&&<><label className="field"><span>Received into</span><select aria-label="Repayment cash account" required value={draft.cashAccountId} onChange={event=>set('cashAccountId',event.target.value)}><option value="">Choose cash account</option>{cashAccounts.map(account=><option key={account.id} value={account.id}>{account.name} · {cash(account.balanceCents)}</option>)}</select></label>{!cashAccounts.length&&<p className="portfolio-dialog-note">Add a cash account before recording a repayment.</p>}{sameDayBalance&&<label className="cash-posting-confirmation"><input type="checkbox" required checked={draft.afterBalanceConfirmation} onChange={event=>set('afterBalanceConfirmation',event.target.checked)}/><span>This money arrived after the balance check on {dateText(receivingAccount!.reconciledAt!)}.</span></label>}{receivedDateError&&<p className="portfolio-form-error" role="alert">{receivedDateError}</p>}</>}
          <label className="field"><span>Comment · optional</span><textarea value={draft.comment} maxLength={1000} rows={3} placeholder={editor.kind === 'wish' ? 'Why you want it, a link, or what to check before buying' : editor.kind === 'payment' ? 'e.g. E-transfer received' : 'What the money was for'} onChange={event => set('comment', event.target.value)}/></label>
          {editor.kind === 'payment' && <div className="owed-payment-preview" aria-live="polite"><span>Remaining after payment</span><strong>{paymentPreview === null ? 'Enter an amount' : cash(paymentPreview)}</strong></div>}
          {editor.kind==='tab'&&editor.tab?.payments.some(payment=>payment.cashAccountId)&&<p className="portfolio-dialog-note">Undo linked repayments before removing this tab.</p>}
          {editor.kind === 'tab' && editor.tab && owedPaid(editor.tab) > 0 && <p className="portfolio-dialog-note">{cash(owedPaid(editor.tab))} already repaid. Payment history stays with this tab.</p>}
          <p className="portfolio-dialog-note">{editor.kind === 'wish' ? 'Save the idea now. This does not record an expense.' : editor.kind==='payment'?'This reduces the amount owed and adds the same amount to the selected cash account in one step.':'This updates the amount owed. Repayments update cash when you record them.'}</p>
        </>}
      </fieldset>
      {stale && <div className="mazal-form-notice" role="status"><p>Records changed. {recordChanged ? latestEditor ? latestEditor.kind === 'wish' ? `Saved wish: ${latestEditor.item?.name}, ${latestEditor.item?.costCents == null ? 'price needed' : cash(latestEditor.item.costCents)}. Loading it replaces this draft.` : `Saved tab: ${latestEditor.tab?.name}, ${cash(latestEditor.tab ? owedRemaining(latestEditor.tab) : 0)} remaining. Loading it replaces this draft.` : 'This record was removed. Close this editor to continue.' : 'This record is unchanged. Your draft can be kept.'}</p>{latestEditor && <button type="button" className="button secondary" disabled={saving} onClick={reviewUpdated}>{recordChanged ? 'Load saved record' : 'Review updated records'}</button>}</div>}
      {error && <div className="portfolio-form-error" tabIndex={-1} role="alert" ref={errorRef}>{error}</div>}
      <footer className={`portfolio-dialog-footer${intent ? ' is-confirming' : ''}`}>
        {intent ? <><div className="portfolio-discard-message" role="alert"><strong>{intent === 'discard' ? 'Discard unsaved changes?' : editor.kind === 'wish' ? 'Remove this wish?' : 'Remove this tab and its payment history?'}</strong></div><div className="portfolio-discard-actions"><button ref={keepEditingRef} type="button" className="button secondary" disabled={saving} onClick={keepEditing}>Keep editing</button><button type="button" className="button primary" disabled={saving} onClick={intent === 'discard' ? () => { setIntent(null); protection.discard(); } : remove}>{saving ? 'Removing...' : intent === 'discard' ? 'Discard changes' : 'Remove'}</button></div></> : <>{original&&!(editor.kind==='tab'&&editor.tab?.payments.some(payment=>payment.cashAccountId)) && <button ref={removeRef} type="button" className="text-button planning-remove" disabled={saving} onClick={() => setIntent('delete')}>Remove {editor.kind === 'wish' ? 'wish' : 'tab'}</button>}<button type="button" className="button secondary" disabled={saving} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={saving||stale}>{saving ? 'Saving...' : editor.kind === 'wish' ? 'Save wish' : editor.kind === 'tab' ? 'Save tab' : editor.kind === 'payment' ? 'Save payment' : 'Undo payment'}</button></>}
      </footer>
    </form>
  </dialog>;
}
