import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import type { AppState, Command, Obligation } from '../../../shared/types.ts';
import { money, today } from '../../../shared/analytics.ts';
import { subscriptionAmount, subscriptionAmountText, subscriptionPresets, subscriptionTotals } from '../../../shared/subscriptions.ts';
import Icon from '../../components/Icon.tsx';
import './subscriptions.css';

interface Props {
  state: AppState;
  scope: string;
  readOnly: boolean;
  pending: string;
  onCommand: (command: Command) => Promise<void>;
  onPay: (id: string) => Promise<void>;
  initialPreset?: string;
  embedded?: boolean;
}
type Preset = { name: string; category: string };
type Editor = { obligation?: Obligation; preset?: Preset; reactivate?: boolean };
const shortDate = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });

export default function Subscriptions({ state, scope, readOnly, pending, onCommand, onPay, initialPreset, embedded = false }: Props) {
  const [filter, setFilter] = useState<'planned' | 'cancelled' | 'all'>('planned');
  const [editor, setEditor] = useState<Editor | null>(() => initialPreset && subscriptionPresets.some(preset => preset.name === initialPreset) ? { preset: subscriptionPresets.find(preset => preset.name === initialPreset)! } : null);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requests = useRef(new Map<string, string>());
  const inScope = (item: Obligation) => scope === 'all' || item.entityId === scope;
  const subscriptions = state.obligations.filter(item => item.subscription && inScope(item));
  const active = subscriptions.filter(item => item.status === 'planned').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const cancelled = subscriptions.filter(item => item.status === 'cancelled');
  const visible = subscriptions.filter(item => filter === 'all' || item.status === filter).sort((a, b) => Number(a.status === 'cancelled') - Number(b.status === 'cancelled') || a.dueDate.localeCompare(b.dueDate));
  const existingBills = state.obligations.filter(item => !item.subscription && item.status === 'planned' && item.direction === 'out' && item.recurrence !== 'once' && inScope(item));
  const totals = subscriptionTotals(subscriptions);
  const busy = !!pending || !!saving;

  async function cancel(item: Obligation) {
    if (readOnly || busy) return;
    setSaving(item.id);setError('');setNotice('');
    const key = `${item.id}-${item.dueDate}-cancel`;
    const requestId = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      await onCommand({ type: 'set_obligation_status', id: item.id, status: 'cancelled', requestId });
      requests.current.delete(key);
      setNotice(`${item.name} marked cancelled. Recorded payments remain in Transactions.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not update this subscription.'); }
    finally { setSaving(''); }
  }

  async function pay(item: Obligation) {
    if (readOnly || busy) return;
    if (!item.accountId) { setEditor({ obligation: item }); return; }
    setSaving(item.id);setError('');
    try { await onPay(item.id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not record this payment.'); }
    finally { setSaving(''); }
  }

  return <section className={`subscriptions-page${embedded ? ' is-embedded' : ''}`} aria-label="Subscriptions">
    <div className="subscription-heading"><div><h2>Subscriptions</h2><p>{active.length} active · {cancelled.length} cancelled</p></div>{!readOnly && <button type="button" className="button primary" disabled={busy} onClick={() => setEditor({})}><Icon name="plus" size={16}/>Add subscription</button>}</div>
    {subscriptions.length > 0 && <div className="subscription-summary">
      <div><span>Monthly equivalent</span><strong>{money(totals.monthlyCents)}</strong><small>Active subscriptions</small></div>
      <div><span>Annual equivalent</span><strong>{money(totals.annualCents)}</strong><small>At the current prices</small></div>
      <div><span>Next payment</span><strong>{active[0] ? shortDate(active[0].dueDate) : 'None scheduled'}</strong><small>{active[0] ? `${active[0].name} · ${money(active[0].amountCents)}` : 'No active subscriptions'}</small></div>
    </div>}
    {!readOnly && <div className="subscription-add-options">
      <span>Add your plan</span><div className="subscription-presets">{subscriptionPresets.map(preset => <button type="button" key={preset.name} disabled={busy} onClick={() => setEditor({ preset })}><Icon name="plus" size={14}/>{preset.name}</button>)}<button type="button" disabled={busy} onClick={() => setEditor({})}><Icon name="plus" size={14}/>Custom</button></div><small>Enter your price and next payment date.</small>
      {existingBills.length > 0 && <label className="subscription-existing"><span>Already listed in bills?</span><select aria-label="Track an existing bill as a subscription" disabled={busy} value="" onChange={event => { const obligation = existingBills.find(item => item.id === event.target.value); if (obligation) setEditor({ obligation }); }}><option value="">Choose an existing recurring bill</option>{existingBills.map(item => <option value={item.id} key={item.id}>{item.name} · {money(item.amountCents)}</option>)}</select></label>}
    </div>}
    {error && <p role="alert" className="expense-error">{error}</p>}{notice && <p role="status" className="subscription-notice">{notice}</p>}
    {subscriptions.length > 0 && <div className="period-control subscription-status-filter" role="group" aria-label="Subscription status">{(['planned', 'cancelled', 'all'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'planned' ? 'Active' : value === 'cancelled' ? 'Cancelled' : 'All'}</button>)}</div>}
    <div className="subscription-list">{visible.map(item => {
      const isActive = item.status === 'planned';
      const payments = state.transactions.filter(entry => entry.kind === 'expense' && (entry.plannedPayment?.obligationId === item.id || !entry.plannedPayment && entry.source === `Planned payment ${item.id}`));
      return <article className={`subscription-row${isActive ? '' : ' is-cancelled'}`} key={item.id}>
        <div className="subscription-name"><span className="subscription-symbol"><Icon name={item.category === 'Gym' ? 'activity' : 'clock'} size={21}/></span><div><h3>{item.name}</h3><small>{item.category}</small></div><span className={`subscription-status ${isActive ? 'active' : ''}`}>{isActive ? 'Active' : 'Cancelled'}</span></div>
        <div className="subscription-price"><strong>{money(item.amountCents)}</strong><span>{item.recurrence === 'monthly' ? 'every month' : 'every two weeks'}</span></div>
        <div className="subscription-due"><span>{isActive ? item.dueDate < today() ? 'Past due' : 'Next payment' : 'Last scheduled date'}</span><strong className={isActive && item.dueDate < today() ? 'negative' : ''}>{shortDate(item.dueDate)}</strong><small>{state.accounts.find(account => account.id === item.accountId)?.name ?? 'Payment account not set'}</small></div>
        <div className="subscription-history"><span>Recorded payments</span><strong>{payments.length ? money(payments.reduce((sum, entry) => sum + entry.amountCents, 0)) : 'None yet'}</strong><small>{payments.length > 0 ? `${payments.length} ${payments.length === 1 ? 'payment' : 'payments'}` : 'Added to Transactions when paid'}</small></div>
        {!readOnly && <div className="subscription-actions"><button type="button" className="button secondary compact" disabled={busy} onClick={() => setEditor({ obligation: item })} aria-label={`Edit ${item.name}`}>Edit</button>{isActive ? <><button type="button" className="button secondary compact" disabled={busy} onClick={() => void pay(item)} aria-label={item.accountId ? `Mark ${item.name} paid` : `Choose payment account for ${item.name}`}>{pending === item.id ? 'Saving…' : item.accountId ? 'Mark paid' : 'Choose payment account'}</button><button type="button" className="text-button" disabled={busy} onClick={() => void cancel(item)} aria-label={`Mark ${item.name} cancelled`}>{saving === item.id ? 'Saving…' : 'Mark cancelled'}</button></> : <button type="button" className="button secondary compact" disabled={busy} onClick={() => setEditor({ obligation: item, reactivate: true })} aria-label={`Reactivate ${item.name}`}>Reactivate</button>}</div>}
      </article>;
    })}</div>
    {visible.length === 0 && <div className="subscription-empty"><h3>{subscriptions.length ? filter === 'cancelled' ? 'No cancelled subscriptions' : 'No active subscriptions' : 'No subscriptions added'}</h3>{!subscriptions.length && <p>Track recurring charges, change prices and keep cancelled plans out of upcoming payments.</p>}</div>}
    <p className="subscription-footnote">Monthly equivalent uses 26 biweekly charges per year. Mark paid after the charge clears; it records one expense and advances the due date. Status changes update Mazal only. Cancel the service with the provider.</p>
    {!readOnly && editor && <SubscriptionEditor key={`${editor.obligation?.id ?? editor.preset?.name ?? 'new'}-${editor.reactivate ? 'reactivate' : 'edit'}`} state={state} scope={scope} {...editor} onCommand={onCommand} onClose={() => setEditor(null)} onSaved={() => { if (editor.reactivate) setFilter('planned'); setEditor(null); }}/>}
  </section>;
}

function SubscriptionEditor({ state, scope, obligation, preset, reactivate = false, onCommand, onClose, onSaved }: Editor & { state: AppState; scope: string; onCommand: Props['onCommand']; onClose: () => void; onSaved: () => void }) {
  const initialOwner = obligation?.entityId ?? (scope !== 'all' ? scope : state.entities.find(entity => entity.kind === 'personal')?.id ?? state.entities[0]?.id ?? '');
  const [draft, setDraft] = useState({ entityId: initialOwner, name: obligation?.name ?? preset?.name ?? '', amount: obligation ? subscriptionAmountText(obligation.amountCents) : '', dueDate: reactivate ? '' : obligation?.dueDate ?? '', recurrence: obligation?.recurrence === 'biweekly' ? 'biweekly' : 'monthly', accountId: obligation?.accountId ?? state.accounts.find(account => !account.closedAt && account.type === 'cash' && account.entityId === initialOwner)?.id ?? '', category: obligation?.category ?? preset?.category ?? 'Subscriptions' });
  const accounts = state.accounts.filter(account => !account.closedAt && ['cash', 'debt', 'payable'].includes(account.type) && account.entityId === draft.entityId);
  const initial = useRef(draft);
  const dialog = useRef<HTMLDialogElement>(null);
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
  const current = obligation ? state.obligations.find(item => item.id === obligation.id) : undefined;
  const stale = !!obligation && (!current || (Object.keys({ ...obligation, ...current }) as (keyof Obligation)[]).some(key => current[key] !== obligation[key]));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.current);
  const protection = useDraftProtection({ dirty: dirty || !!createAttempt, busy: saving, onRequestDiscard: () => { editingFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setCloseIntent(true); } });
  const set = (key: keyof typeof draft, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const title = reactivate ? 'Reactivate subscription' : obligation ? obligation.subscription ? 'Edit subscription' : 'Track existing bill' : 'Add subscription';
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (closeIntent) keepEditingRef.current?.focus(); }, [closeIntent]);
  function keepEditing() { protection.keepEditing(); setCloseIntent(false); window.requestAnimationFrame(() => editingFocus.current?.focus()); }
  function requestClose() { protection.requestChange(onClose); }
  async function save(event: FormEvent) {
    event.preventDefault();if (saving || closeIntent) return;
    setError('');setSaving(true);
    try {
      if (recordsChanged) throw new Error('Review the updated records before confirming this save.');
      if (stale) throw new Error('This subscription changed. Close this editor and reopen the current entry.');
      if (!obligation && createAttempt) { await onCommand(prepare(createAttempt)); onSaved(); return; }
      const account = accounts.find(item => item.id === draft.accountId);
      if (draft.accountId && !account) throw new Error('Choose a bank or credit account, or choose later.');
      if (!state.entities.some(entity => entity.id === draft.entityId)) throw new Error('Your personal profile is missing. Reload your records.');
      if (!draft.name.trim()) throw new Error('Enter a subscription name.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate) || !Number.isFinite(Date.parse(draft.dueDate)) || new Date(draft.dueDate).toISOString().slice(0, 10) !== draft.dueDate) throw new Error('Choose the next payment date.');
      const terms = { name: draft.name.trim(), amountCents: subscriptionAmount(draft.amount), dueDate: draft.dueDate, recurrence: draft.recurrence as 'monthly' | 'biweekly', accountId: account?.id ?? '', category: draft.category.trim(), subscription: true };
      const payload = obligation ? { type: 'update_obligation' as const, id: obligation.id, expectedDueDate: obligation.dueDate, expectedStatus: obligation.status === 'cancelled' ? 'cancelled' as const : 'planned' as const, ...terms, status: reactivate ? 'planned' as const : obligation.status === 'cancelled' ? 'cancelled' as const : 'planned' as const } : { type: 'add_obligation' as const, entityId: draft.entityId, direction: 'out' as const, ...terms };
      const signature = JSON.stringify(payload);
      if (lastRequest.current?.payload !== signature) lastRequest.current = { payload: signature, id: crypto.randomUUID() };
      const command = obligation ? { ...payload, requestId: lastRequest.current.id } : prepare({ ...payload, requestId: lastRequest.current.id });
      if (command.type === 'add_obligation') setCreateAttempt(command);
      await onCommand(command);
      onSaved();
    } catch (error) { if (isConfirmedCommandRejection(error)) { setCreateAttempt(null); resetRequest(); } setError(error instanceof Error ? error.message : 'Could not save this subscription.'); }
    finally { setSaving(false); }
  }

  return <dialog ref={dialog} className="subscription-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (closeIntent) keepEditing(); else requestClose(); }}>
    <div className="subscription-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close subscription editor" onClick={requestClose} disabled={saving}><Icon name="close" size={20}/></button></div>
    <form onSubmit={event => void save(event)}><fieldset disabled={saving || closeIntent || !!createAttempt} className="subscription-fields">
      <label className="field"><span>Name</span><input value={draft.name} onChange={event => set('name', event.target.value)} maxLength={100} required autoFocus/></label>
      <div className="form-grid"><label className="field"><span>Amount per charge · CAD</span><input value={draft.amount} onChange={event => set('amount', event.target.value)} inputMode="decimal" placeholder="0.00" required/></label><label className="field"><span>Repeats</span><select value={draft.recurrence} onChange={event => set('recurrence', event.target.value)}><option value="monthly">Every month</option><option value="biweekly">Every two weeks</option></select></label></div>
      <div className="form-grid"><label className="field"><span>Next payment date</span><input type="date" min="1900-01-01" max="2200-12-31" value={draft.dueDate} onChange={event => set('dueDate', event.target.value)} required/></label><label className="field"><span>Category</span><input value={draft.category} onChange={event => set('category', event.target.value)} maxLength={100} list={`${titleId}-categories`}/><datalist id={`${titleId}-categories`}><option value="Digital"/><option value="Gym"/><option value="Bills"/><option value="Subscriptions"/></datalist></label></div>
      <label className="field"><span>Pay from · optional</span><select value={draft.accountId} onChange={event => set('accountId', event.target.value)}><option value="">Choose later</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      {!draft.accountId && <p>Track the charge now. Choose a payment account before marking it paid.</p>}
      <p>{obligation ? 'Changes apply to future payments. Recorded expenses keep their original amounts.' : 'This adds a scheduled charge. Your balance changes when you mark it paid.'}</p>
    </fieldset>{stale && <p className="expense-error subscription-form-error" role="alert">This subscription changed. Close this editor and reopen the current entry.</p>}
    {createAttempt && <p className="subscription-form-error" role="status">The original save is awaiting confirmation. Confirm it before changing these details. Retrying uses the same save and cannot add this subscription twice.</p>}
    {recordsChanged && <div className="subscription-form-error" role="alert"><p>Your records changed while this form was open. Review the subscription list before continuing.</p><button className="button secondary" type="button" disabled={saving || closeIntent} onClick={() => { review(true); setError(''); }}>I reviewed the updated records</button></div>}
    {error && <p className="expense-error subscription-form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
    <footer className="subscription-dialog-footer">{closeIntent ? <><span>{createAttempt ? 'Close and check the subscription list? The original save may already be recorded.' : 'Discard your changes?'}</span><button type="button" className="button secondary" onClick={() => { setCloseIntent(false); protection.discard(); }}>{createAttempt ? 'Close and check records' : 'Discard'}</button><button type="button" className="button primary" ref={keepEditingRef} onClick={keepEditing}>Keep editing</button></> : <><button type="button" className="button secondary" disabled={saving} onClick={requestClose}>Cancel</button><button type="submit" className="button primary" disabled={saving || stale || recordsChanged}>{saving ? 'Saving…' : createAttempt ? 'Confirm original save' : reactivate ? 'Reactivate' : obligation ? 'Save changes' : 'Add subscription'}</button></>}</footer></form>
  </dialog>;
}
