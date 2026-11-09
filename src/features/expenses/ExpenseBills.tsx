import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AppState, Command, Obligation } from '../../../shared/types.ts';
import { money, today } from '../../../shared/analytics.ts';
import {isConfirmedCommandRejection} from '../../services/command-errors.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import Icon from '../../components/Icon.tsx';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import './expense-bills.css';

export interface ExpenseBillDraft { name: string; amountCents: number; category: string; requireRecurrence?: boolean; subscription?: boolean }
interface Props {
  state: AppState;
  scope: string;
  readOnly: boolean;
  onCommand: (command: Command) => Promise<void>;
  onPay: (id: string) => Promise<void>;
  pending: string;
  initialDraft?: ExpenseBillDraft;
  onDraftConsumed?: () => void;
  embedded?: boolean;
}
interface Editor { obligation?: Obligation; draft?: ExpenseBillDraft; reactivate?: boolean; focusAccount?: boolean }
const familyName = (name: string) => /\b(?:mom|bmw)\b/i.test(name);
const dateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
const recurrenceLabel = (value: Obligation['recurrence']) => value === 'monthly' ? 'Every month' : value === 'biweekly' ? 'Every two weeks' : 'One time';
const amountText = (value: number) => `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, '0')}`;

function parseAmount(value: string): number {
  const raw = value.trim();
  if (!/^(?:\d+|\d*\.\d{1,2})$/.test(raw)) throw new Error('Enter an amount with up to two decimal places.');
  const [whole, decimal = ''] = raw.split('.');
  const cents = BigInt(whole || '0') * 100n + BigInt(decimal.padEnd(2, '0'));
  if (cents <= 0n || cents > 100_000_000_000_000n) throw new Error('Enter an amount greater than zero within the supported range.');
  return Number(cents);
}

export default function ExpenseBills({ state, scope, readOnly, onCommand, onPay, pending, initialDraft, onDraftConsumed, embedded = false }: Props) {
  const [view, setView] = useState<'planned' | 'cancelled'>('planned');
  const [direction, setDirection] = useState<'all' | 'out' | 'in'>('all');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requests = useRef(new Map<string, string>());
  const consumedDraft = useRef<ExpenseBillDraft | undefined>(undefined);
  const currentDay = today();
  const soon = new Date(`${currentDay}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 7);
  const soonDate = soon.toISOString().slice(0, 10);
  const personal = state.entities.find(entity => entity.kind === 'personal');
  const bills = state.obligations.filter(item => (scope === 'all' || item.entityId === scope) && (!embedded || item.direction === 'out' && !item.subscription));
  const active = bills.filter(item => item.status === 'planned');
  const cancelled = bills.filter(item => item.status === 'cancelled');
  const visible = bills.filter(item => item.status === view && (direction === 'all' || item.direction === direction)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
  const familyBills = state.obligations.filter(item => item.entityId === personal?.id && item.direction === 'out' && familyName(item.name));
  const cancelledFamily = familyBills.find(item => item.status === 'cancelled');
  const familyAmount = state.roadmap?.monthlyFamilyPaymentCents ?? 0;
  const showFamily = !embedded && !(state.assetPurchases ?? []).some(purchase => purchase.entityId === personal?.id && familyName(purchase.name)) && (scope === 'all' || scope === personal?.id) && familyAmount > 0 && !familyBills.some(item => item.status === 'planned');
  const busy = !!pending || !!saving;
  const groups = view === 'cancelled' ? [{ name: 'Cancelled', items: visible, tone: '' }] : [
    { name: 'Overdue', items: visible.filter(item => item.dueDate < currentDay), tone: 'overdue' },
    { name: 'Today and next 7 days', items: visible.filter(item => item.dueDate >= currentDay && item.dueDate <= soonDate), tone: 'soon' },
    { name: 'Later', items: visible.filter(item => item.dueDate > soonDate), tone: '' },
  ];

  useEffect(() => {
    if (!initialDraft || initialDraft === consumedDraft.current || readOnly || editor) return;
    consumedDraft.current = initialDraft;
    const existing = familyName(initialDraft.name) ? state.obligations.find(item => item.entityId === personal?.id && item.direction === 'out' && item.status === 'cancelled' && familyName(item.name)) : undefined;
    setEditor(existing ? { obligation: existing, reactivate: true } : { draft: initialDraft });
    onDraftConsumed?.();
  }, [initialDraft, onDraftConsumed, readOnly, editor, state.obligations, personal?.id]);

  async function cancel(item: Obligation) {
    if (readOnly || busy) return;
    setSaving(item.id); setError(''); setNotice('');
    const key = `${item.id}-${item.dueDate}-cancel`;
    const requestId = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      await onCommand({ type: 'set_obligation_status', id: item.id, status: 'cancelled', requestId });
      requests.current.delete(key);
      setNotice(`${item.name} cancelled in Mazal. Recorded transactions are unchanged.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not cancel this entry.'); }
    finally { setSaving(''); }
  }

  async function pay(item: Obligation) {
    if (readOnly || busy) return;
    setSaving(item.id); setError(''); setNotice('');
    try { await onPay(item.id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not record this payment.'); }
    finally { setSaving(''); }
  }

  return <section className={`expense-bills-page${embedded ? ' is-embedded' : ''}`} aria-label={embedded ? 'Bills' : 'Bills and income'}>
    <header className="expense-bills-heading"><div><h2>{embedded ? 'Bills' : 'Bills & income'}</h2><p>Each row shows the next payment.</p></div>{!readOnly && <button type="button" className="bill-button bill-primary" disabled={busy} onClick={() => setEditor({})}><Icon name="plus" size={16}/>{embedded ? 'Add bill' : 'Add bill or income'}</button>}</header>
    <div className="expense-bills-filters"><div className="bill-view-toggle" role="group" aria-label="Scheduled payment status">{(['planned', 'cancelled'] as const).map(value => <button type="button" key={value} aria-pressed={view === value} onClick={() => setView(value)}>{value === 'planned' ? 'Upcoming' : 'Cancelled'}<span>{value === 'planned' ? active.length : cancelled.length}</span></button>)}</div>{!embedded && <label className="bill-direction"><span className="bill-sr-only">Payment direction</span><select aria-label="Payment direction" value={direction} onChange={event => setDirection(event.target.value as typeof direction)}><option value="all">Bills & income</option><option value="out">Bills to pay</option><option value="in">Expected income</option></select></label>}</div>
    {error && <p className="bill-error" role="alert">{error}</p>}{notice && <p className="bill-notice" role="status">{notice}</p>}
    {groups.filter(group => group.items.length > 0).map(group => <section className={`bill-group ${group.tone}`} key={group.name} aria-label={group.name}>
      <h3>{group.name}<span>{group.items.length}</span></h3>
      <div className="bill-list">{group.items.map(item => <article className={`bill-row${item.direction === 'in' ? ' is-income' : ''}${item.status === 'cancelled' ? ' is-cancelled' : ''}`} key={item.id}>
        <div className="bill-date"><span>{new Date(`${item.dueDate}T12:00:00`).toLocaleDateString('en-CA', { month: 'short' })}</span><strong>{Number(item.dueDate.slice(8))}</strong></div>
        <div className="bill-copy"><h4>{item.name}{item.subscription && <span className="bill-tag">Subscription</span>}</h4><p>{recurrenceLabel(item.recurrence)} · {item.direction === 'in' ? 'Expected income' : item.category || 'Bill'}</p><small>{item.status === 'cancelled' ? 'Last scheduled: ' : item.dueDate < currentDay ? 'Past due: ' : 'Next payment: '}{dateLabel(item.dueDate)} · {state.accounts.find(account => account.id === item.accountId)?.name ?? 'Payment account not set'}</small></div>
        <strong className="bill-amount">{item.direction === 'in' ? '+' : ''}{money(item.amountCents)}</strong>
        {!readOnly && <div className="bill-row-actions"><button type="button" className="bill-button bill-secondary" disabled={busy} onClick={() => setEditor({ obligation: item })} aria-label={`Edit ${item.name}`}>Edit</button>{item.status === 'planned' ? <><button type="button" className="bill-button bill-primary" disabled={busy} onClick={() => void pay(item)} aria-label={!item.accountId ? `Choose payment account for ${item.name}` : `${item.direction === 'in' ? 'Record received' : 'Record paid'}: ${item.name}`}>{pending === item.id || saving === item.id ? 'Saving…' : !item.accountId ? 'Choose account' : item.direction === 'in' ? 'Record received' : 'Record paid'}</button><button type="button" className="bill-text-button" disabled={busy} onClick={() => void cancel(item)} aria-label={`Cancel ${item.name} in Mazal`}>Cancel</button></> : <button type="button" className="bill-button bill-primary" disabled={busy} onClick={() => setEditor({ obligation: item, reactivate: true })} aria-label={`Reactivate ${item.name}`}>Reactivate</button>}</div>}
      </article>)}</div>
    </section>)}
    {view === 'planned' && direction !== 'in' && showFamily && <section className="bill-group" aria-label="Not scheduled"><h3>Not scheduled</h3><article className="bill-family-row"><span className="bill-family-icon"><Icon name="plan" size={21}/></span><div className="bill-copy"><h4>BMW payment to Mom</h4><p>{money(familyAmount)} every month · From your monthly plan</p><small>Choose the next payment date to add it to the schedule.</small></div>{!readOnly && <button type="button" className="bill-button bill-secondary" disabled={busy} onClick={() => setEditor(cancelledFamily ? { obligation: cancelledFamily, reactivate: true } : { draft: { name: 'BMW payment to Mom', amountCents: familyAmount, category: 'Transport' } })}>Schedule payment</button>}</article></section>}
    {visible.length === 0 && !(view === 'planned' && direction !== 'in' && showFamily) && <div className="bill-empty"><Icon name="plan" size={24}/><h3>{view === 'cancelled' ? 'No cancelled entries' : direction === 'all' ? 'No bill or income entries' : direction === 'in' ? 'No expected income scheduled' : 'No bills scheduled'}</h3>{view === 'planned' && <p>Add the next date and amount. Choose a payment account now or later.</p>}</div>}
    <p className="bill-footnote">Record a payment after the money moves. Enter its actual details or match a transaction already recorded. Recurring entries advance to the next date. Cancelling changes Mazal only; it does not cancel a service or bank payment.</p>
    {!readOnly && editor && <BillEditor key={`${editor.obligation?.id ?? 'new'}-${editor.reactivate ? 'reactivate' : 'edit'}`} state={state} scope={scope} embedded={embedded} {...editor} onCommand={onCommand} onClose={() => setEditor(current => current === editor ? null : current)}/>}
  </section>;
}

export function BillEditor({ state, scope, obligation, draft: preset, reactivate = false, focusAccount = false, embedded = false, recurring = false, onCommand, onClose }: Editor & { embedded?: boolean; recurring?: boolean; state: AppState; scope: string; onCommand: Props['onCommand']; onClose: () => void }) {
  const initialOwner = obligation?.entityId ?? (scope !== 'all' ? scope : state.entities.find(entity => entity.kind === 'personal')?.id ?? state.entities[0]?.id ?? '');
  const [draft, setDraft] = useState({ entityId: initialOwner, name: obligation?.name ?? preset?.name ?? '', amount: obligation ? amountText(obligation.amountCents) : preset ? amountText(preset.amountCents) : '', dueDate: reactivate ? '' : obligation?.dueDate ?? '', direction: obligation?.direction ?? 'out', recurrence: obligation?.recurrence ?? (preset?.requireRecurrence ? '' as const : preset || recurring ? 'monthly' as const : 'once' as const), accountId: obligation?.accountId ?? '', category: obligation?.category ?? preset?.category ?? '', additionalToPay: obligation?.additionalToPay ?? null, assetPurchaseId:obligation?.assetPurchaseId??'' });
  const initial = useRef(draft);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const accountRef = useRef<HTMLSelectElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const editingFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [closeIntent, setCloseIntent] = useState(false);
  const [createAttempt, setCreateAttempt] = useState<Extract<Command, { type: 'add_obligation' }> | null>(null);
  const { changed: revisionChanged, review, prepare, resetRequest } = useCommandDraft(state.revision, 'form');
  const recordsChanged = !obligation && revisionChanged;
  const lastRequest = useRef<{ payload: string; id: string } | null>(null);
  const accounts = state.accounts.filter(account => !account.closedAt && account.entityId === draft.entityId && (draft.direction === 'in' ? account.type === 'cash' : ['cash', 'debt', 'payable'].includes(account.type)));
  const current = obligation ? state.obligations.find(item => item.id === obligation.id) : undefined;
  const stale = !!obligation && (!current || (Object.keys({ ...obligation, ...current }) as (keyof Obligation)[]).some(key => current[key] !== obligation[key]));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.current);
  const set = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const title = reactivate ? 'Reactivate payment' : focusAccount ? 'Choose payment account' : obligation ? 'Edit payment' : embedded ? 'Add bill' : 'Add bill or income';
  useEffect(() => { const element = dialog.current; element?.showModal(); (focusAccount ? accountRef.current : nameRef.current)?.focus({ preventScroll: true }); return () => element?.close(); }, [focusAccount]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (closeIntent) keepEditingRef.current?.focus(); }, [closeIntent]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  const protection=useDraftProtection({dirty:dirty||!!createAttempt,busy:saving,onRequestDiscard:()=>setCloseIntent(true)});
  function requestClose() { protection.requestChange(onClose); }
  function keepEditing() {
    protection.keepEditing(); setCloseIntent(false);
    window.requestAnimationFrame(() => {
      const field = editingFocus.current;
      const target = field?.isConnected && !field.matches(':disabled') ? field : dialog.current?.querySelector<HTMLElement>('button[type="submit"]:not(:disabled)') ?? dialog.current?.querySelector<HTMLElement>('.bill-close:not(:disabled)');
      target?.focus({ preventScroll: true });
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || closeIntent) return;
    setSaving(true); setError('');
    try {
      if (recordsChanged) throw new Error('Review the updated records before confirming this save.');
      if (stale) throw new Error('This payment changed. Close this editor and reopen the current entry.');
      if (!obligation && createAttempt) {
        await onCommand(prepare(createAttempt));
        onClose();
        return;
      }
      if (!state.entities.some(entity => entity.id === draft.entityId)) throw new Error('Your personal profile is missing. Reload your records.');
      if (!draft.name.trim()) throw new Error('Enter a payment name.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate) || draft.dueDate < '1900-01-01' || draft.dueDate > '2200-12-31' || !Number.isFinite(Date.parse(draft.dueDate)) || new Date(draft.dueDate).toISOString().slice(0, 10) !== draft.dueDate) throw new Error('Choose a valid next payment date.');
      if (draft.accountId && !accounts.some(account => account.id === draft.accountId)) throw new Error('Choose a payment account, or choose later.');
      if (!draft.recurrence) throw new Error('Choose how often this bill repeats.');
      const terms = { name: draft.name.trim(), amountCents: parseAmount(draft.amount), dueDate: draft.dueDate, recurrence: draft.recurrence, accountId: draft.accountId, category: draft.category.trim(), assetPurchaseId:draft.direction==='out'?draft.assetPurchaseId:'', ...(draft.direction === 'in' && draft.additionalToPay !== null ? { additionalToPay: draft.additionalToPay } : {}) };
      const payload = obligation ? { type: 'update_obligation' as const, id: obligation.id, expectedDueDate: obligation.dueDate, expectedStatus: obligation.status === 'cancelled' ? 'cancelled' as const : 'planned' as const, ...terms, status: reactivate ? 'planned' as const : obligation.status === 'cancelled' ? 'cancelled' as const : 'planned' as const } : { type: 'add_obligation' as const, entityId: draft.entityId, direction: draft.direction, ...(preset?.subscription ? {subscription:true} : {}), ...terms };
      const signature = JSON.stringify(payload);
      if (lastRequest.current?.payload !== signature) lastRequest.current = { payload: signature, id: crypto.randomUUID() };
      const command = obligation ? { ...payload, requestId: lastRequest.current.id } : prepare({ ...payload, requestId: lastRequest.current.id });
      if (command.type === 'add_obligation') setCreateAttempt(command);
      await onCommand(command);
      onClose();
    } catch (failure) { if(isConfirmedCommandRejection(failure)){setCreateAttempt(null);resetRequest();lastRequest.current=null;} setError(failure instanceof Error ? failure.message : 'Could not save this payment.'); }
    finally { setSaving(false); }
  }

  return <dialog ref={dialog} className="bill-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (closeIntent) keepEditing(); else requestClose(); }}>
    <header className="bill-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="bill-close" aria-label="Close payment editor" disabled={saving} onClick={requestClose}><Icon name="close" size={20}/></button></header>
    <form onSubmit={event => void save(event)}>
      <fieldset className="bill-fields" disabled={saving || closeIntent || !!createAttempt} onFocusCapture={event => { if (event.target instanceof HTMLElement && event.target.matches('input,select,textarea')) editingFocus.current = event.target; }}>
        <label className="bill-field"><span>Name</span><input ref={nameRef} value={draft.name} onChange={event => set('name', event.target.value)} maxLength={100} required/></label>
        <div className="bill-form-grid"><label className="bill-field"><span>Payment type</span><select value={draft.direction} disabled={!!obligation} onChange={event => setDraft(current => ({ ...current, direction: event.target.value as 'in' | 'out', accountId: '', assetPurchaseId:'' }))}><option value="out">Bill to pay</option>{!embedded && <option value="in">Expected income</option>}</select></label><label className="bill-field"><span>Category · optional</span><input value={draft.category} onChange={event => set('category', event.target.value)} maxLength={100} placeholder={draft.direction === 'in' ? 'Salary, Freelance' : 'Housing, Transport'}/></label></div>
        <div className="bill-form-grid"><label className="bill-field"><span>Amount per payment · CAD</span><input value={draft.amount} onChange={event => set('amount', event.target.value)} inputMode="decimal" placeholder="0.00" required/></label><label className="bill-field"><span>Next payment date</span><input type="date" value={draft.dueDate} onChange={event => set('dueDate', event.target.value)} min="1900-01-01" max="2200-12-31" required/></label></div>
        <div className="bill-form-grid"><label className="bill-field"><span>Repeats</span><select value={draft.recurrence} onChange={event => set('recurrence', event.target.value as Obligation['recurrence'])}>{!draft.recurrence && <option value="" disabled>Choose frequency</option>}{!obligation?.subscription && !recurring && <option value="once">One time</option>}<option value="monthly">Every month</option><option value="biweekly">Every two weeks</option></select></label><label className="bill-field"><span>{draft.direction === 'in' ? 'Receive into' : 'Pay from'} · optional</span><select ref={accountRef} value={draft.accountId} onChange={event => set('accountId', event.target.value)}><option value="">Choose later</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label></div>
        {!obligation && scope === 'all' && state.entities.length > 1 && <label className="bill-field"><span>Category · optional</span><input value={draft.category} onChange={event => set('category', event.target.value)} maxLength={100} placeholder={draft.direction === 'in' ? 'Salary, Freelance' : 'Housing, Transport'}/></label>}
        {draft.direction === 'in' && <label className="bill-field"><span>Income source</span><select aria-label="Income source" value={draft.additionalToPay === null ? '' : draft.additionalToPay ? 'extra' : 'regular'} onChange={event => set('additionalToPay', event.target.value === 'extra')}><option value="" disabled>Choose how to count this income</option><option value="regular">Already included in regular pay</option><option value="extra">Extra income on top of regular pay</option></select><small>Confirm this so the forecast counts each paycheck once. You can save the schedule and choose later.</small></label>}
        {draft.direction==='out'&&<label className="bill-field"><span>Linked asset purchase · optional</span><select value={draft.assetPurchaseId} onChange={event=>{set('assetPurchaseId',event.target.value);set('accountId','');}}><option value="">Separate bill</option>{(state.assetPurchases??[]).filter(item=>item.entityId===draft.entityId).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><small>A linked bill supplies the purchase payment dates. The forecast counts that commitment once.</small></label>}
        {draft.direction === 'out' && <p>{draft.assetPurchaseId?'Payments move cash to the linked purchase.':'Bill payments record expenses. Record loan repayments on Debts.'}</p>}
        {!draft.accountId && <p>Choose an account before recording the payment. You can save the schedule now.</p>}
        <p>{obligation ? 'Edits change future payments. Recorded transactions keep their original amounts.' : 'Scheduling does not change your balance. Record the payment after the money moves.'}</p>
      </fieldset>
      {createAttempt && !saving && <p className="bill-form-error" role="status">Confirm the original save for {createAttempt.name}, {money(createAttempt.amountCents)} due {dateLabel(createAttempt.dueDate)}, before changing its details. Retrying checks the same save and does not add a second copy.</p>}
      {recordsChanged && <div className="bill-form-error" role="status"><p>Records changed while this editor was open. Review the saved schedule before continuing.</p><button type="button" className="bill-button bill-secondary" disabled={saving} onClick={() => { review(true); setError(''); }}>Review updated records</button></div>}
      {stale && <p className="bill-error bill-form-error" role="alert">This payment changed. Close this editor and reopen the current entry.</p>}
      {error && <p ref={errorRef} className="bill-error bill-form-error" role="alert" tabIndex={-1}>{error}</p>}
      <footer className="bill-dialog-footer">{closeIntent ? <><span>{createAttempt ? 'Close and check whether this entry was saved?' : 'Discard your changes?'}</span><button type="button" className="bill-button bill-secondary" onClick={()=>{setCloseIntent(false);protection.discard();}}>{createAttempt ? 'Close editor' : 'Discard'}</button><button type="button" className="bill-button bill-primary" ref={keepEditingRef} onClick={keepEditing}>{createAttempt ? 'Keep checking' : 'Keep editing'}</button></> : <><button type="button" className="bill-button bill-secondary" disabled={saving} onClick={requestClose}>Cancel</button><button type="submit" className="bill-button bill-primary" disabled={saving || stale || recordsChanged}>{saving ? 'Saving…' : createAttempt ? 'Confirm original save' : reactivate ? 'Reactivate' : obligation ? 'Save changes' : 'Add to schedule'}</button></>}</footer>
    </form>
  </dialog>;
}
