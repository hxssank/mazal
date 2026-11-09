import { transactionLabel } from '../../../shared/transaction-label.ts';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppState, Command, SpendingLimit, Transaction } from '../../../shared/types.ts';
import { money } from '../../../shared/analytics.ts';
import { buildExpensePlan, createExpensePlanCategory, parseExpensePlanAmount } from '../../../shared/expense-plan.ts';
import type { ExpensePlanRow } from '../../../shared/expense-plan.ts';
import { buildExpenseComparison } from '../../../shared/expense-comparison.ts';
import { isUncategorized } from '../../../shared/expense-categories.ts';
import { activeExpenseTransactions } from '../../../shared/category-review.ts';
import ExpensePlanDetails from './ExpensePlanDetails.tsx';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
import './expense-plan.css';

interface Props {
  state: AppState;
  scope: string;
  month: string;
  readOnly: boolean;
  onCommand: (command: Command) => Promise<void>;
  onCategory: (name: string, ownerId?: string) => void;
  onEditCategory?: (transaction: Transaction) => void;
  overview?: ReactNode;
  renderCategoryContent?: (row: ExpensePlanRow) => ReactNode;
  initialRecordId?: string;
}

const categoryGroups = [
  { key: 'essentials', title: 'Everyday essentials', description: 'Home, food, transport and personal care', categories: ['housing', 'bills', 'food', 'transport', 'gym', 'personal'] },
  { key: 'lifestyle', title: 'Lifestyle', description: 'Subscriptions, going out and regular extras', categories: ['subscriptions', 'social', 'cannabis'] },
  { key: 'occasional', title: 'Occasional spending', description: 'Plan trips, purchases and projects by date', categories: ['trips', 'career', 'digital', 'sidequests'] },
  { key: 'other', title: 'Fees & other spending', description: 'Interest, account charges and other expenses', categories: ['fees', 'other'] },
  { key: 'custom', title: 'Your categories', description: '', categories: [] as string[] },
];
const occasionalCategory = (row: ExpensePlanRow) => categoryGroups[2].categories.includes(row.key);

export default function ExpensePlan(props: Props) {
  const owner = props.state.entities.find(entity => entity.kind === 'personal');
  if (!owner) return null;
  return <ExpensePlanEditor key={`${props.state.workspace}:${owner.id}:${props.month}`} {...props} ownerId={owner.id} ownerName={owner.name}/>;
}

function ExpensePlanEditor({ state, month, readOnly, onCommand, onCategory, onEditCategory, overview, renderCategoryContent, ownerId, ownerName, initialRecordId }: Props & { ownerId: string; ownerName: string }) {
  const id = useId();
  const plan = buildExpensePlan(state, ownerId, month);
  const activeExpenseIds = new Set(activeExpenseTransactions(state.transactions).map(transaction => transaction.id));
  const correctedIds = new Set(state.transactions.map(transaction => transaction.replacesId).filter(Boolean));
  const comparison = buildExpenseComparison(state, ownerId, month, plan.asOf);
  const previousLabel = new Date(`${comparison.previousMonth}-01T12:00:00`).toLocaleDateString('en-CA', { month: 'short', year: 'numeric' });
  const comparisonLabel = comparison.partialPeriod ? `${previousLabel}, days 1–${Number(comparison.end.slice(8))}` : previousLabel;
  const groupedRows = categoryGroups.map(group => ({ ...group, rows: plan.rows.filter(row => group.key === 'custom' ? !categoryGroups.some(candidate => candidate.categories.includes(row.key)) : group.categories.includes(row.key)).sort((a, b) => group.categories.indexOf(a.key) - group.categories.indexOf(b.key)) })).filter(group => group.rows.length);
  const [editing, setEditing] = useState('');
  const [budgetContext, setBudgetContext] = useState<{ revision: number; limit: SpendingLimit } | null>(null);
  const requestedRecordId = initialRecordId ?? new URLSearchParams(window.location.hash.split('?')[1]).get('record');
  const requestedItem = state.expensePlanItems?.find(item => item.id === requestedRecordId && item.entityId === ownerId);
  const [selectedCategory, setSelectedCategory] = useState(requestedItem?.categoryId ?? '');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [newCategory, setNewCategory] = useState<{ id: string; name: string; monthlyAmount: string; categories: string; revision: number } | null>(null);
  const [discard, setDiscard] = useState(false);
  const originalAmount = budgetContext?.limit.monthlyCents == null ? '' : (budgetContext.limit.monthlyCents / 100).toFixed(2);
  const protection = useDraftProtection({ dirty: !!editing && draft !== originalAmount || !!newCategory && !!(newCategory.name || newCategory.monthlyAmount || newCategory.categories), busy: pending, onRequestDiscard: () => setDiscard(true) });
  const panelsRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const categoryTrigger = useRef<HTMLElement | null>(null);
  const restoreCategoryFocus = useRef(false);
  const monthLabel = new Date(`${month}-01T12:00:00`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  const requestedCategoryId = requestedItem?.categoryId;
  useEffect(() => { if (requestedCategoryId) revealCategory(requestedCategoryId); }, [requestedRecordId, requestedCategoryId]);
  useEffect(() => {
    if (selectedCategory || !restoreCategoryFocus.current) return;
    restoreCategoryFocus.current = false;
    const trigger = categoryTrigger.current;
    (trigger?.isConnected && !trigger.closest('[hidden]') && !trigger.matches(':disabled') ? trigger : headingRef.current)?.focus();
  }, [selectedCategory]);

  function revealCategory(categoryId: string, focusAmount = false, trigger?: HTMLElement) {
    if (trigger?.closest('.expense-plan-category-card')) categoryTrigger.current = trigger;
    else if (categoryId !== selectedCategory) categoryTrigger.current = null;
    setSelectedCategory(categoryId);
    window.requestAnimationFrame(() => {
      const panel = [...(panelsRef.current?.querySelectorAll<HTMLElement>('.expense-plan-detail-panel') ?? [])].find(element => element.dataset.categoryId === categoryId);
      if (!panel || panel.hidden) return;
      const shell = panel.closest<HTMLElement>('.app-shell');
      const toolbar = shell?.querySelector<HTMLElement>('.glass-toolbar');
      if (toolbar) panel.style.setProperty('--expense-detail-scroll-top', `${Math.max(0, toolbar.getBoundingClientRect().bottom) + 12}px`);
      const target = focusAmount ? panel.querySelector<HTMLInputElement>('.expense-plan-editor:not(.expense-plan-item-editor) input') ?? panel : panel;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start', behavior: shell?.dataset.motion === 'off' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
  }
  function closeCategory() { restoreCategoryFocus.current = true; setSelectedCategory(''); }

  function edit(row: ExpensePlanRow, trigger?: HTMLElement) {
    if (pending || readOnly) return;
    protection.requestChange(() => {
    setEditing(editing === row.limit.id && selectedCategory === row.limit.id ? '' : row.limit.id);
    if (editing !== row.limit.id) {
      setDraft(row.limit.monthlyCents === null ? '' : (row.limit.monthlyCents / 100).toFixed(2));
      setBudgetContext({ revision: state.revision, limit: structuredClone(row.limit) });
    }
    setError('');
    setSaved('');
    setNewCategory(null);
    revealCategory(row.limit.id, editing !== row.limit.id || selectedCategory !== row.limit.id, trigger);
    });
  }

  async function save(row: ExpensePlanRow, clear = false) {
    if (pending || readOnly) return;
    if (!budgetContext || budgetContext.limit.id !== row.limit.id || budgetContext.revision !== state.revision) {
      setError('Review the updated records before saving this monthly amount.');
      return;
    }
    setError('');
    let monthlyCents: number | null;
    try { monthlyCents = clear ? null : parseExpensePlanAmount(draft); }
    catch (error) { setError(error instanceof Error ? error.message : 'Enter a monthly amount.'); return; }
    setPending(true);
    try {
      await onCommand({ type: 'save_spending_limit', limit: { ...budgetContext.limit, monthlyCents }, budgetMonth: month, expectedRevision: budgetContext.revision });
      setEditing('');
      setBudgetContext(null);
      setSaved(monthlyCents === null ? `Cleared ${row.label} for ${monthLabel}.` : `Saved ${money(monthlyCents)} for ${row.label} in ${monthLabel}.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save this monthly amount.'); }
    finally { setPending(false); }
  }

  function addCategory() {
    protection.requestChange(() => {
    setNewCategory({ id: crypto.randomUUID(), name: '', monthlyAmount: '', categories: '', revision: state.revision });
    setEditing('');
    setError('');
    setSaved('');
    });
  }

  async function saveCategory() {
    if (!newCategory || pending || readOnly) return;
    if (newCategory.revision !== state.revision) {
      setError('Review the updated records before adding this category.');
      return;
    }
    setError('');
    let limit;
    try { limit = createExpensePlanCategory({ ...newCategory, ownerId }, plan.rows.flatMap(row => [row.limit.name, row.label])); }
    catch (error) { setError(error instanceof Error ? error.message : 'Check this category.'); return; }
    setPending(true);
    try {
      await onCommand({ type: 'save_spending_limit', limit, budgetMonth: month, expectedRevision: newCategory.revision });
      setNewCategory(null);
      setSaved(`${limit.name} added${limit.monthlyCents === null ? ' without an amount' : ` with ${money(limit.monthlyCents)}`} for ${monthLabel}.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not add this category.'); }
    finally { setPending(false); }
  }

  return <section className="expense-plan expense-plan-compact" aria-labelledby={`${id}-title`}>
    <DraftDiscardDialog open={discard} onKeepEditing={() => { protection.keepEditing(); setDiscard(false); }} onDiscard={() => { setEditing(''); setDraft(originalAmount); setNewCategory(null); setError(''); setDiscard(false); protection.discard(); }}/>
    <div className="expense-plan-heading">
      <div><h2 ref={headingRef} id={`${id}-title`} tabIndex={-1}>Spending plan</h2><p>For {monthLabel}</p></div>
    </div>
    {overview && <div className="expense-plan-overview">{overview}</div>}
    <div className="expense-plan-summary">
      <span>{plan.plannedCategoryCount > 0 ? <><strong>{money(plan.plannedCents)}</strong> planned for {monthLabel} · {plan.plannedCategoryCount} {plan.plannedCategoryCount === 1 ? 'category' : 'categories'}</> : 'Monthly targets are optional. Add dated plans for occasional costs.'}</span>
    </div>
    <div className="expense-plan-comparison-key" id={`${id}-comparison`}>
      <span>Recorded spending vs {comparisonLabel}</span>
      {comparison.coverageComplete ? <span className="expense-plan-legend"><span className="is-lower">↓ Lower</span><span className="is-higher">↑ Higher</span><span>— Same / no history</span></span> : <span>Statement coverage is incomplete. Differences compare recorded amounts only.</span>}
    </div>
    <div className="expense-plan-groups">
      {groupedRows.map(group => <section className={`expense-plan-group expense-plan-group-${group.key}`} key={group.key} aria-labelledby={`${id}-group-${group.key}`}>
        <div className="expense-plan-group-heading"><div><h3 id={`${id}-group-${group.key}`}>{group.title}</h3>{group.description && <p>{group.description}</p>}</div><span>{money(group.rows.reduce((total, row) => total + row.spentCents, 0))}</span></div>
        <div className="expense-plan-category-grid" aria-label={group.title}>
          {group.rows.map(row => {
            const index = plan.rows.indexOf(row);
            const amount = row.limit.monthlyCents;
            const over = row.remainingCents !== null && row.remainingCents < 0;
            const expanded = selectedCategory === row.limit.id;
            const editingAmount = editing === row.limit.id;
            const detailsId = `${id}-details-${index}`;
            const previous = comparison.byCategoryId.get(row.limit.id);
            const direction = previous?.direction ?? 'unavailable';
            const changeLabel = direction === 'unavailable' ? 'No prior records' : !comparison.coverageComplete ? direction === 'same' ? 'Same recorded amount' : `${money(Math.abs(previous!.differenceCents!))} ${direction === 'lower' ? 'less' : 'more'} recorded` : direction === 'same' ? 'Same as prior month' : `${direction === 'lower' ? '↓' : '↑'} ${money(Math.abs(previous!.differenceCents!))} ${direction}`;
            const occasional = occasionalCategory(row);
            const itemCount = (state.expensePlanItems ?? []).filter(item => item.entityId === ownerId && item.categoryId === row.limit.id).length;
            return <div key={row.limit.id} className={`expense-plan-category-card${expanded ? ' is-selected' : ''}${over ? ' is-over' : ''}`}>
              <button className="expense-plan-category-select" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={event => revealCategory(row.limit.id, false, event.currentTarget)}><strong>{row.label}</strong><span className="expense-plan-examples">{row.examples}</span></button>
              <button className={`expense-plan-spent is-${comparison.coverageComplete ? direction : 'unavailable'}`} type="button" aria-describedby={`${id}-comparison`} onClick={event => revealCategory(row.limit.id, false, event.currentTarget)} aria-label={`Show ${row.transactionCount} ${row.label} expenses for ${ownerName} in ${monthLabel}, ${money(row.spentCents)}. ${changeLabel}${direction === 'unavailable' ? '' : ` compared with ${comparisonLabel}, ${money(previous!.spentCents)}`}`}><small>Spent</small><strong>{money(row.spentCents)}</strong><span className="expense-plan-change">{changeLabel}</span></button>
              <div className="expense-plan-card-footer">
                {(!occasional || amount !== null) && (readOnly ? <span className="expense-plan-budget is-readonly"><small>Monthly target</small><span>{amount === null ? 'Not set' : money(amount)}</span></span> : <button className={`expense-plan-budget${amount === null ? ' is-empty' : ''}`} type="button" aria-expanded={editingAmount && expanded} aria-controls={`${id}-edit-${index}`} aria-label={`${amount === null ? 'Set' : 'Edit'} ${row.label} monthly amount${amount === null ? '' : `, currently ${money(amount)}`}`} disabled={pending} onClick={event => edit(row, event.currentTarget)}><small>Monthly target</small><span>{amount === null ? 'Set amount' : money(amount)} <span aria-hidden="true">{editingAmount && expanded ? '−' : '+'}</span></span></button>)}
                {(occasional || itemCount > 0) && <button className="expense-plan-items-link" type="button" aria-label={`View ${row.label} plans and dates`} aria-controls={detailsId} aria-expanded={expanded} onClick={event => revealCategory(row.limit.id, false, event.currentTarget)}>{itemCount > 0 ? `${itemCount} planned ${itemCount === 1 ? 'item' : 'items'}` : 'Plans & dates'} <span aria-hidden="true">↗</span></button>}
                {over && <span className="expense-plan-card-over">{money(Math.abs(row.remainingCents!))} over target</span>}
              </div>
            </div>;
          })}
        </div>
      </section>)}
    </div>
    <div ref={panelsRef} className="expense-plan-category-panels">
      {plan.rows.map((row, index) => {
        const amount = row.limit.monthlyCents;
        const over = row.remainingCents !== null && row.remainingCents < 0;
        const editorId = `${id}-edit-${index}`;
        const progress = amount !== null && amount > 0 ? Math.min(100, row.spentCents / amount * 100) : over ? 100 : 0;
        return <section key={row.limit.id} id={`${id}-details-${index}`} data-category-id={row.limit.id} className={`expense-plan-detail-panel${over ? ' is-over' : ''}`} aria-label={`${row.label} details`} tabIndex={-1} hidden={selectedCategory !== row.limit.id}>
          <div className="expense-plan-detail-heading"><h3>{row.label}</h3><button type="button" className="text-button" aria-label={`Close ${row.label} details`} onClick={closeCategory}>Close</button></div>
          {occasionalCategory(row) && <ExpensePlanDetails state={state} row={row} readOnly={readOnly} onCommand={onCommand}/>}
          {occasionalCategory(row) && amount === null && !readOnly && editing !== row.limit.id && <button type="button" className="text-button expense-plan-optional-target" onClick={() => edit(row)}>Set a target for {monthLabel}</button>}
          {amount !== null && <div className="expense-plan-progress-line"><div className="expense-plan-track" role={amount > 0 ? 'progressbar' : undefined} aria-label={`${row.label} spending`} aria-valuemin={amount > 0 ? 0 : undefined} aria-valuemax={amount > 0 ? amount : undefined} aria-valuenow={amount > 0 ? Math.min(amount, Math.max(0, row.spentCents)) : undefined} aria-valuetext={amount > 0 ? `${money(row.spentCents)} spent of ${money(amount)} monthly amount` : undefined}><span style={{ width: `${Math.max(0, progress)}%` }}/></div><span className="expense-plan-remaining">{money(Math.abs(row.remainingCents!))} {over ? 'over plan' : 'remaining'}</span></div>}
          {selectedCategory === row.limit.id && <div className="expense-plan-recorded">
            <div className="expense-plan-details-heading"><h4>{monthLabel} spending</h4>{row.transactions.length > 0 && <button className="text-button" type="button" onClick={() => onCategory(row.limit.name, ownerId)}>View transactions</button>}</div>
            {row.transactions.length ? <ul className="expense-plan-entries">{row.transactions.slice(0, 50).map(transaction => <li key={transaction.id}><div><strong>{transactionLabel(transaction)}</strong><small>{new Date(`${transaction.date}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} · {state.accounts.find(account => account.id === transaction.accountId)?.name ?? 'Account'}</small>{transaction.reversalOf ? <small>Reversal</small> : !activeExpenseIds.has(transaction.id) && <small>{correctedIds.has(transaction.id) ? 'Corrected · Previous entry canceled' : 'Reversed · Entry canceled'}</small>}</div><div className="expense-plan-entry-actions"><span>{money(transaction.amountCents)}</span>{!readOnly && activeExpenseIds.has(transaction.id) && onEditCategory && <button type="button" className="expense-category-action" aria-label={`Edit category for ${transactionLabel(transaction)} on ${transaction.date}`} onClick={() => onEditCategory(transaction)}>{isUncategorized(transaction.category) ? 'Categorize' : 'Edit category'}</button>}</div></li>)}</ul> : <p className="expense-plan-no-entries">No recorded expenses in this category for {monthLabel}.</p>}
            {row.transactions.length > 50 && <p className="expense-plan-no-entries">Showing 50 of {row.transactions.length} expenses. Use View transactions to see all entries.</p>}
          </div>}
          {editing === row.limit.id && <form id={editorId} className="expense-plan-editor" onSubmit={event => { event.preventDefault(); void save(row); }}>
            <label htmlFor={`${editorId}-amount`}>Monthly amount for {row.label}<span className="expense-plan-input"><span aria-hidden="true">$</span><input id={`${editorId}-amount`} value={draft} onChange={event => { setDraft(event.target.value); setError(''); }} type="text" inputMode="decimal" placeholder="Not set" aria-describedby={`${editorId}-hint${error ? ` ${editorId}-error` : ''}`} aria-invalid={!!error} disabled={pending}/><span>CAD</span></span></label>
            <p id={`${editorId}-hint`}>For {monthLabel}. Blank means no plan. $0 means no spending planned.</p>
            {budgetContext?.revision !== state.revision && <div className="expense-plan-error" role="alert"><p>Records changed. The saved monthly amount for {row.label} is {amount === null ? 'not set' : money(amount)}. Your draft is still here.</p><button type="button" className="text-button" disabled={pending} onClick={() => { setBudgetContext({ revision: state.revision, limit: structuredClone(row.limit) }); setError(''); }}>Review updated records</button></div>}
            {error && <p id={`${editorId}-error`} className="expense-plan-error" role="alert">{error}</p>}
            <div className="expense-plan-editor-actions"><button className="expense-plan-save" type="submit" disabled={pending || budgetContext?.revision !== state.revision}>{pending ? 'Saving…' : 'Save amount'}</button>{amount !== null && <button className="expense-plan-clear" type="button" disabled={pending || budgetContext?.revision !== state.revision} onClick={() => void save(row, true)}>Clear amount</button>}<button className="expense-plan-cancel" type="button" disabled={pending} onClick={() => protection.requestChange(() => { setEditing(''); setBudgetContext(null); setError(''); })}>Cancel</button></div>
          </form>}
          {renderCategoryContent?.(row)}
          {!occasionalCategory(row) && <ExpensePlanDetails state={state} row={row} readOnly={readOnly} onCommand={onCommand}/>}
        </section>;
      })}
    </div>
    {!readOnly && <div className="expense-plan-custom">
      {!newCategory ? <button className="expense-plan-add" type="button" disabled={pending} onClick={addCategory}><span aria-hidden="true">+</span> Add category</button> : <form className="expense-plan-editor expense-plan-newcategory" aria-label="Add expense category" onSubmit={event => { event.preventDefault(); void saveCategory(); }}>
        <label htmlFor={`${id}-new-name`}>Category name<input className="expense-plan-text-input" id={`${id}-new-name`} value={newCategory.name} onChange={event => { setNewCategory({ ...newCategory, name: event.target.value }); setError(''); }} maxLength={100} placeholder="e.g. Pets" autoFocus required disabled={pending}/></label>
        <label htmlFor={`${id}-new-amount`}>Monthly amount <small>Optional</small><span className="expense-plan-input"><span aria-hidden="true">$</span><input id={`${id}-new-amount`} value={newCategory.monthlyAmount} onChange={event => { setNewCategory({ ...newCategory, monthlyAmount: event.target.value }); setError(''); }} type="text" inputMode="decimal" placeholder="Not set" aria-describedby={`${id}-new-amount-hint`} disabled={pending}/><span>CAD</span></span></label>
        <p id={`${id}-new-amount-hint`}>For {monthLabel}. Blank means no plan. $0 means no spending planned.</p>
        <label htmlFor={`${id}-new-categories`}>Transaction categories <small>Optional, comma separated</small><input className="expense-plan-text-input" id={`${id}-new-categories`} value={newCategory.categories} onChange={event => { setNewCategory({ ...newCategory, categories: event.target.value }); setError(''); }} placeholder="e.g. Vet, pet food" aria-describedby={`${id}-new-categories-hint`} disabled={pending}/></label>
        <p id={`${id}-new-categories-hint`}>Expenses matching the name or these categories count here.</p>
        {newCategory.revision !== state.revision && <div className="expense-plan-error" role="alert"><p>Records changed. Review the current category list above before saving. Your name and amount are still here.</p><button type="button" className="text-button" disabled={pending} onClick={() => { setNewCategory({ ...newCategory, revision: state.revision }); setError(''); }}>Review updated records</button></div>}
        {error && <p className="expense-plan-error" role="alert">{error}</p>}
        <div className="expense-plan-editor-actions"><button className="expense-plan-save" type="submit" disabled={pending || newCategory.revision !== state.revision}>{pending ? 'Saving…' : 'Add category'}</button><button className="expense-plan-cancel" type="button" disabled={pending} onClick={() => protection.requestChange(() => { setNewCategory(null); setError(''); })}>Cancel</button></div>
      </form>}
    </div>}
    <p className="expense-plan-status" role="status">{saved}</p>
  </section>;
}
