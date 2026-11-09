import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Account, AccountType, AppState, Command, SolPosition } from '../../../shared/types';
import { BillEditor } from '../expenses/ExpenseBills.tsx';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import StatementIntake from '../records/StatementIntake.tsx';
import { parseMoneyCents } from '../../../shared/money-input.ts';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { expensePlanLimits } from '../../../shared/expense-plan.ts';
import { suggestExpenseCategory } from '../../../shared/expense-categories.ts';
import { previewTransaction } from '../../../shared/transaction-preview.ts';
import { readBackupFile } from '../../../shared/backup.ts';
import AccountReconciliation, { type BalanceDraft } from '../accounts/AccountReconciliation.tsx';
import CompleteBackup from '../backups/CompleteBackup.tsx';
import DocumentRecovery from '../records/DocumentRecovery.tsx';
import CalculationStorage from '../planner/CalculationStorage.tsx';
import './forms.css';

type FormKind = 'transaction' | 'account' | 'obligation' | 'reserve' | 'sol' | 'reward' | 'reconcile' | 'import' | 'backup';
interface Props {
  kind: FormKind;
  state: AppState;
  accountId?: string;
  initialAccountType?: AccountType;
  initialTransactionKind?: 'expense' | 'income' | 'transfer' | 'debt_payment';
  initialToAccountId?: string;
  positionId?: string;
  onCommand: (command: Command) => Promise<void>;
  onClose: () => void;
}

const titles: Record<FormKind, string> = {
  transaction: 'Add a transaction', account: 'Add an account',
  obligation: 'Add a bill or expected payment', reserve: 'Set money aside', sol: 'Update SOL holdings',
  reward: 'Add a staking reward', reconcile: 'Update an account balance', import: 'Import a statement', backup: 'Backups and data',
};
const money = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);
const dollars = (cents: number) => (cents / 100).toFixed(2);
const solFieldLabels = { liquidSol:'Unstaked SOL', stakedSol:'Staked SOL', costBasis:'Remaining recorded cost', price:'Price per SOL', priceDate:'Price date', priceSource:'Price source' };
type SolField = keyof typeof solFieldLabels;
function solFields(position:SolPosition|undefined):Record<SolField,string> {
  return { liquidSol:position?.liquidSol ?? '0', stakedSol:position?.stakedSol ?? '0', costBasis:position ? dollars(position.costBasisCents) : '0.00', price:position ? dollars(position.priceCents) : '', priceDate:position?.priceDate ?? today(), priceSource:position?.priceSource ?? '' };
}
function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function cents(value: string, label: string, allowNegative = false): number {
  const parsed = parseMoneyCents(value, { signed:true, leadingDecimal:true, invalidMessage:`${label} needs a number with no more than two decimal places.`, rangeMessage:`${label} is too large.` });
  if (!allowNegative && parsed < 0) throw new Error(`${label} cannot be negative.`);
  return parsed;
}
function positiveCents(value: string, label: string) {
  const amount = cents(value, label);
  if (amount === 0) throw new Error(`${label} must be more than zero.`);
  return amount;
}
function quantity(value: string, label: string, requirePositive = false) {
  const raw = value.trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(raw)) throw new Error(`${label} needs a non-negative number with no more than nine decimal places.`);
  if (requirePositive && Number(raw) === 0) throw new Error(`${label} must be more than zero.`);
  return raw;
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('Choose a valid date.');
  return value;
}
function required(value: string, label: string) {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
async function backupDownload(url: string, controller: AbortController): Promise<Blob> {
  let rejectAborted: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error('The backup download timed out after 3 minutes. Retry the download when the local server is available.')), 180_000);
  const read = async () => {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) { const result = await response.json().catch(() => null); throw new Error(result?.error || 'The backup could not be created. Try again when the local server is available.'); }
    const blob = await response.blob();
    if (controller.signal.aborted) throw controller.signal.reason;
    return blob;
  };
  try { return await Promise.race([read(), aborted]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAborted!); }
}
export default function Forms(props:Props) {
  const [adjustment,setAdjustment] = useState<BalanceDraft|null>(null);
  if (props.kind === 'import') return <StatementIntake key={props.state.workspace} state={props.state} accountId={props.accountId} onCommand={props.onCommand} onClose={props.onClose}/>;
  if(props.kind==='obligation')return <BillEditor state={props.state} scope={props.state.entities.find(item=>item.kind==='personal')?.id??'personal'} onCommand={props.onCommand} onClose={props.onClose}/>;
  const selected = props.state.accounts.find(account=>account.id===props.accountId);
  if(props.kind==='reconcile'&&!adjustment&&(!selected||['cash','debt','payable'].includes(selected.type))) return <AccountReconciliation state={props.state} accountId={props.accountId} onCommand={props.onCommand} onClose={props.onClose} onAdjust={setAdjustment}/>;
  return <FormsDialog {...props} kind={props.kind} accountId={adjustment?.accountId ?? props.accountId} reconcileDraft={adjustment ?? undefined}/>;
}

function FormsDialog({ kind, state, accountId, initialAccountType = 'cash', initialTransactionKind = 'expense', initialToAccountId, positionId, onCommand, onClose, reconcileDraft }: Omit<Props, 'kind'> & { kind: Exclude<FormKind, 'import'>; reconcileDraft?:BalanceDraft }) {
  const entityId = (kind==='reconcile' ? state.accounts.find(account=>account.id===accountId)?.entityId : undefined) ?? state.entities.find(entity => entity.kind === 'personal')?.id ?? '';
  const accounts = state.accounts.filter(account => !account.closedAt && account.entityId === entityId);
  const positions = state.positions.filter(position => accounts.some(account => account.id === position.accountId));
  const dialog = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  const titleId = useId();
  const categoryListId = useId();
  const explicitPosition = positions.find(p => p.id === positionId);
  const solAccountIds = new Set(positions.map(position => position.accountId));
  const eligibleInitialAccounts = accounts.filter(account => {
    if (kind === 'sol') return account.type === 'investment';
    if (kind === 'obligation') return account.type === 'cash';
    if (kind === 'transaction' && initialTransactionKind === 'debt_payment') return account.type === 'cash';
    if (kind === 'transaction' && initialTransactionKind === 'income') return ['cash', 'receivable'].includes(account.type);
    if (kind === 'transaction' && initialTransactionKind === 'transfer') return ['cash', 'investment', 'receivable'].includes(account.type) && !solAccountIds.has(account.id);
    if (kind === 'transaction') return ['cash', 'debt', 'payable'].includes(account.type);
    if (kind === 'reconcile') return !solAccountIds.has(account.id);
    return true;
  });
  const requestedAccount = eligibleInitialAccounts.find(a => a.id === (explicitPosition?.accountId || accountId));
  const initialAccount = kind === 'reconcile' && accountId ? requestedAccount : requestedAccount
    || eligibleInitialAccounts.find(a => (!entityId || a.entityId === entityId) && (kind === 'sol' ? a.type === 'investment' : a.type === 'cash'))
    || eligibleInitialAccounts.find(a => !entityId || a.entityId === entityId);
  const initialPosition = explicitPosition || positions.find(p => p.accountId === initialAccount?.id);
  const [values, setValues] = useState<Record<string, string>>({
    entityId: entityId || initialAccount?.entityId || state.entities[0]?.id || '', accountId: initialAccount?.id || '',
    positionId: initialPosition?.id || positions[0]?.id || '', name: '', description: '', category: '',
    kind: initialTransactionKind, amount: '', toAccountId: initialToAccountId || '', date: reconcileDraft?.date ?? today(), accountType: initialAccountType, opening: '',
    direction: 'out', recurrence: 'monthly', balance: reconcileDraft?.balance ?? (initialAccount ? dollars(initialAccount.balanceCents) : ''), note: '',
    liquidSol: initialPosition?.liquidSol || '0', stakedSol: initialPosition?.stakedSol || '0',
    costBasis: initialPosition ? dollars(initialPosition.costBasisCents) : '0.00',
    price: initialPosition ? dollars(initialPosition.priceCents) : '', priceDate: initialPosition?.priceDate || today(), priceSource:initialPosition?.priceSource ?? '', reward: '',
  });
  const initialValues = useRef(values);
  const solBaseline = useRef(solFields(initialPosition));
  const [solConflicts,setSolConflicts] = useState<{field:SolField;saved:string}[]>([]);
  const {changed:recordsChanged, review:reviewRevision, prepare, resetRequest} = useCommandDraft(state.revision, 'form');
  const [closeIntent, setCloseIntent] = useState<{ href?: string } | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const editingFocus = useRef<HTMLElement | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveAttempt, setSaveAttempt] = useState<Command | null>(null);
  const restoreUnconfirmed = saveAttempt?.type === 'restore';
  const [notice, setNotice] = useState('');
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [completeBusy,setCompleteBusy]=useState(false);
  const [completeDirty,setCompleteDirty]=useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryDirty, setRecoveryDirty] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageDirty, setStorageDirty] = useState(false);
  const [backupMode, setBackupMode] = useState<'restore' | 'import_locked'>('restore');
  const [backup, setBackup] = useState<unknown>(null);
  useEffect(() => { if (kind === 'backup' && backup === null) reviewRevision(true); }, [kind, backup, reviewRevision]);
  const [confirmed, setConfirmed] = useState(false);
  const set = (key: string, value: string) => setValues(previous => ({ ...previous, [key]: value }));
  const chosenAccount = accounts.find(a => a.id === values.accountId);
  const merchantSuggestion = kind === 'transaction' && values.kind === 'expense' ? suggestExpenseCategory(values.description) : null;
  const categorySuggestions = kind === 'transaction' && values.kind === 'expense' && chosenAccount ? expensePlanLimits(state, chosenAccount.entityId) : [];
  const emptyWorkspace = state.entities.length === 1 && state.entities[0].kind === 'personal' && accounts.length === 0 && state.transactions.length === 0 && positions.length === 0 && state.obligations.length === 0 && state.reserves.length === 0;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    const firstField = element?.querySelector<HTMLElement>('[data-initial-focus]')
      ?? element?.querySelector<HTMLElement>('form input:not([type="hidden"]):not(:disabled), form select:not(:disabled), form textarea:not(:disabled)');
    firstField?.focus({ preventScroll: true });
    return () => { if (element?.open) element.close(); };
  }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => () => { downloadRequest.current?.abort(); downloadRequest.current = null; }, []);
  useEffect(() => { if (closeIntent) keepEditingRef.current?.focus(); }, [closeIntent]);

  const isDirty = Object.keys(values).some(key => values[key] !== initialValues.current[key]) || Boolean(fileName || backup || saveAttempt) || recoveryDirty || storageDirty || completeDirty;
  function finishClose(href?: string) {
    onClose();
    if (href) window.location.hash = href;
  }
  const protection=useDraftProtection({dirty:isDirty,busy:saving||reading||recoveryBusy||storageBusy||completeBusy,onRequestDiscard:()=>setCloseIntent({})});
  function requestClose(href?: string) {
    if (saving || reading || recoveryBusy || storageBusy || completeBusy || closeIntent) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement.matches('input, select, textarea, [role="alert"][tabindex]')) editingFocus.current = document.activeElement;
    protection.requestChange(()=>finishClose(href));
  }
  function keepEditing() {
    protection.keepEditing();setCloseIntent(null);
    window.requestAnimationFrame(() => (restoreUnconfirmed ? errorRef.current : editingFocus.current)?.focus());
  }
  function reviewUpdatedRecords() {
    if (restoreUnconfirmed) return;
    if (kind === 'sol' && !saveAttempt) {
      const latest = solFields(positions.find(position => position.accountId === values.accountId));
      const conflicts:{field:SolField;saved:string}[] = [];
      const merged = { ...values };
      for (const field of Object.keys(solFieldLabels) as SolField[]) {
        if (solConflicts.some(conflict => conflict.field === field) && values[field] !== latest[field]) conflicts.push({field,saved:latest[field]});
        else if (values[field] === solBaseline.current[field]) merged[field] = latest[field];
        else if (latest[field] !== solBaseline.current[field] && values[field] !== latest[field]) conflicts.push({field,saved:latest[field]});
      }
      solBaseline.current = latest;
      setValues(merged);
      setSolConflicts(conflicts);
    }
    reviewRevision(true);
    setError('');
    setConfirmed(false);
    setNotice(saveAttempt ? 'The original save is unchanged. Confirm it before starting another edit.' : 'Your entries are still here. Review them against the updated records before saving.');
  }

  const field = (label: string, key: string, options: { type?: string; hint?: string; placeholder?: string; optional?: boolean; min?: string; max?: string; inputMode?: 'decimal' | 'text'; autoFocus?: boolean; list?: string } = {}) => (
    <label className={`field${options.optional ? ' is-optional' : ''}`} key={key}>
      <span>{label}{options.optional && <span className="muted"> · optional</span>}</span>
      <input name={key} type={options.type || 'text'} value={values[key]} onChange={event => set(key, event.target.value)}
        required={!options.optional} placeholder={options.placeholder} min={options.min} max={options.max}
        inputMode={options.inputMode} data-initial-focus={options.autoFocus || undefined} list={options.list} autoComplete="off" />
      {options.hint && <small className="muted">{options.hint}</small>}
    </label>
  );
  const select = (label: string, key: string, options: { value: string; label: string }[], onChange?: (value: string) => void, placeholder = 'Choose an account', balanceAccount?: Account) => (
    <label className="field" key={key}>
      <span className="mazal-field-heading"><span>{label}</span>{balanceAccount && <small>{['debt', 'payable'].includes(balanceAccount.type) ? 'Currently owed' : 'Current balance'} <strong>{money(balanceAccount.balanceCents)}</strong></small>}</span>
      <select name={key} aria-label={label} value={values[key]} required onChange={event => onChange ? onChange(event.target.value) : set(key, event.target.value)}>
        <option value="" disabled>{placeholder}</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
  const accountOptions = (accounts: Account[]) => accounts.map(account => ({ value: account.id, label: account.name }));
  const investmentAccounts = accounts.filter(a => a.type === 'investment');
  const selectableAccounts = accounts.filter(a => (a.type === 'cash' || a.type === 'investment') && !solAccountIds.has(a.id));
  const sourceAccounts = (transactionKind: string) => accounts.filter(account => {
    if (solAccountIds.has(account.id)) return false;
    if (transactionKind === 'income') return account.type === 'cash' || account.type === 'receivable';
    if (transactionKind === 'expense') return ['cash', 'debt', 'payable'].includes(account.type);
    if (transactionKind === 'transfer') return ['cash', 'investment', 'receivable'].includes(account.type);
    return account.type === 'cash';
  });
  const accountSelect = (label = 'Account', choices = accounts) => select(label, 'accountId', accountOptions(choices), value => {
    const account = accounts.find(a => a.id === value);
    setValues(previous => ({ ...previous, accountId: value, balance: dollars(account?.balanceCents || 0) }));
  }, 'Choose an account', kind === 'transaction' ? chosenAccount : undefined);
  const amountField = (label = 'Amount · CAD', key = 'amount', hint?: string) => field(label, key, { inputMode: 'decimal', placeholder: '0.00', hint });
  const dateField = (label = 'Date', key = 'date') => field(label, key, { type: 'date' });

  async function run(command: Command, keepOpen = false) {
    setError('');
    setNotice('');
    setSaving(true);
    try {
      const prepared = saveAttempt && ['save_sol', 'reconcile'].includes(saveAttempt.type) ? saveAttempt : prepare(saveAttempt ?? command);
      if (!keepOpen || prepared.type === 'restore') setSaveAttempt(prepared);
      await onCommand(prepared);
      setSaveAttempt(null);
      if (keepOpen) {
        setNotice(command.type === 'restore' ? 'Backup restored. Your accounts and transactions now match the backup. Continue with step 2 to restore the original files.' : 'Locked balances imported. The full original export is preserved in your backup. Historical transactions were not replayed.');
        setBackup(null);
        setFileName('');
        setConfirmed(false);
      } else onClose();
    } catch (failure) {
      const rejected = isConfirmedCommandRejection(failure);
      if (rejected) { setSaveAttempt(null); resetRequest(); if (command.type === 'restore') setConfirmed(false); }
      setError(command.type === 'restore' && !rejected ? 'Mazal could not confirm whether the backup restore completed. It may still finish. Close this window and inspect your records before reopening Backups and data for a new restore.' : failure instanceof Error ? failure.message : 'The change could not be saved. Your entries are still here.');
    } finally { setSaving(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || reading || recoveryBusy || storageBusy || completeBusy || closeIntent || restoreUnconfirmed) return;
    setError('');
    try {
      if (kind === 'backup' && (recoveryDirty||completeDirty)) throw new Error('Clear the original-file archive before replacing financial records.');
      if (recordsChanged) throw new Error('Records changed while this form was open. Review the updated records before saving.');
      if (saveAttempt) { await run(saveAttempt); return; }
      if (solConflicts.length) throw new Error('Choose which changed SOL values to keep before saving.');
      let command: Command;
      if (kind === 'account') {
        command = { type: 'add_account', entityId: required(values.entityId, 'Owner'), name: required(values.name, 'Account name'), accountType: values.accountType as AccountType, openingBalanceCents: cents(values.opening, 'Opening balance', ['cash', 'debt', 'payable'].includes(values.accountType)), openingDate: validDate(values.date), requestId: '' };
      } else if (kind === 'transaction') {
        const transactionKind = values.kind as 'income' | 'expense' | 'transfer' | 'debt_payment';
        if (['transfer', 'debt_payment'].includes(transactionKind) && values.accountId === values.toAccountId) throw new Error('Choose different source and destination accounts.');
        command = { type: 'add_transaction', kind: transactionKind, accountId: required(values.accountId, 'Account'),
          ...(transactionKind === 'transfer' || transactionKind === 'debt_payment' ? { toAccountId: required(values.toAccountId, 'Destination account') } : {}),
          amountCents: positiveCents(values.amount, 'Amount'), date: validDate(values.date), description: required(values.description, 'Description'), category: values.category.trim(), requestId: '' };
      } else if (kind === 'obligation') {
        command = { type: 'add_obligation', entityId: required(values.entityId, 'Owner'), name: required(values.name, 'Name'), accountId: values.accountId, amountCents: positiveCents(values.amount, 'Amount'), dueDate: validDate(values.date), direction: values.direction as 'in' | 'out', recurrence: values.recurrence as 'once' | 'monthly' | 'biweekly', category: values.category.trim(), requestId: '' };
      } else if (kind === 'reserve') {
        command = { type: 'add_reserve', entityId: required(values.entityId, 'Owner'), name: required(values.name, 'Purpose'), amountCents: positiveCents(values.amount, 'Amount'), requestId: '' };
      } else if (kind === 'sol') {
        command = { type: 'save_sol', accountId: required(values.accountId, 'Investment account'), liquidSol: quantity(values.liquidSol, 'Unstaked SOL'), stakedSol: quantity(values.stakedSol, 'Staked SOL'), costBasisCents: cents(values.costBasis, 'Cost basis'), priceCents: positiveCents(values.price, 'SOL price'), priceDate: validDate(values.priceDate), priceSource:values.priceSource.trim(), requestId: '' };
      } else if (kind === 'reward') {
        command = { type: 'add_sol_reward', positionId: required(values.positionId, 'SOL account'), sol: quantity(values.reward, 'Reward', true), date: validDate(values.date), requestId: '' };
      } else if (kind === 'reconcile') {
        command = { type: 'reconcile', accountId: required(values.accountId, 'Account'), balanceCents: cents(values.balance, 'Actual balance', !!chosenAccount && ['cash', 'debt', 'payable'].includes(chosenAccount.type)), date: validDate(values.date), note: required(values.note, 'Reason for the change'), requestId: '' };
      } else {
        if (!backup) throw new Error('Choose a JSON file first.');
        if (backupMode === 'import_locked' && !emptyWorkspace) throw new Error('Locked import needs an empty workspace. Download your current backup before changing workspaces.');
        if (!confirmed) throw new Error('Review the file and confirm the import below.');
        command = { type: backupMode, backup };
      }
      await run(command, kind === 'backup');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the form and try again.'); }
  }

  async function readBackup(file: File | undefined) {
    if (!file) return;
    setReading(true); setError(''); setBackup(null); setConfirmed(false); setFileName(''); setNotice('');
    try {
      if (backupMode === 'import_locked' && file.size > 20 * 1024 * 1024) throw new Error('Choose a Locked export smaller than 20 MiB.');
      const parsed: unknown = await readBackupFile(file, backupMode === 'import_locked' ? 20 * 1024 * 1024 : undefined);
      const parsedRoot = record(parsed);
      if (!parsedRoot) throw new Error('The backup must contain a JSON object.');
      if (backupMode === 'restore' && (parsedRoot.format !== 'mazal-backup' || parsedRoot.version !== 1 || !record(parsedRoot.data))) throw new Error('Choose a Mazal backup downloaded from Backups and data. To import an older Locked export, choose Import Locked.');
      const legacy = record(parsedRoot.state) || parsedRoot;
      if (backupMode === 'import_locked' && (legacy.version !== 1 || typeof legacy.cash !== 'number' || !Array.isArray(legacy.debts))) throw new Error('Choose a Locked version 1 JSON export with cash and debt balances.');
      setBackup(parsed); setFileName(file.name);
    } catch (failure) { setError(failure instanceof SyntaxError ? 'This file is not valid JSON.' : failure instanceof Error ? failure.message : 'This file could not be read.'); }
    finally { setReading(false); }
  }

  async function downloadBackup(originals = false) {
    if (downloadRequest.current || saving) return;
    const controller = new AbortController(); downloadRequest.current = controller;
    setSaving(true); setError(''); setNotice('');
    try {
      const blob = await backupDownload(originals ? `/api/documents/export?workspace=${state.workspace}` : `/api/backup?workspace=${state.workspace}&format=gzip`, controller);
      if (downloadRequest.current !== controller) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = originals ? `mazal-documents-${state.workspace}-${today()}.tar.gz` : `mazal-${state.workspace}-${today()}.json.gz`;
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(originals ? 'Original-file download started. Keep it with your financial backup outside this laptop.' : 'Backup download started. Keep a copy outside this laptop.');
    } catch (failure) { if (downloadRequest.current === controller) setError(failure instanceof Error ? failure.message : 'The backup could not be downloaded.'); }
    finally { if (downloadRequest.current === controller) { downloadRequest.current = null; setSaving(false); } }
  }

  function chooseSolAccount(value: string) {
    if (value === values.accountId) return;
    protection.requestChange(() => {
      const position = positions.find(p => p.accountId === value);
      const fields = solFields(position);
      const next = { ...values, accountId: value, ...fields };
      solBaseline.current = fields;
      initialValues.current = next;
      setSolConflicts([]);
      setValues(next);
      setError('');
      setNotice('');
      window.requestAnimationFrame(() => dialog.current?.querySelector<HTMLSelectElement>('select[name="accountId"]')?.focus({ preventScroll: true }));
    });
  }

  const transactionEffect = (() => {
    if (kind !== 'transaction' || !chosenAccount || !values.amount.trim() || !sourceAccounts(values.kind).some(account => account.id === chosenAccount.id)) return null;
    const destination = accounts.find(account => account.id === values.toAccountId);
    if (['transfer', 'debt_payment'].includes(values.kind) && (!destination || destination.id === chosenAccount.id)) return null;
    try {
      const amountCents = positiveCents(values.amount, 'Amount');
      const date = validDate(values.date);
      return previewTransaction({ kind: values.kind as Extract<Command, { type: 'add_transaction' }>['kind'], account: chosenAccount, destination, amountCents, date, today: today(), solAccountIds });
    } catch { return null; }
  })();

  let content: ReactNode;
  if (kind === 'account') content = <>
    {field('Account name', 'name', { placeholder: values.accountType === 'debt' ? 'e.g. Visa or car loan' : values.accountType === 'investment' ? 'e.g. TFSA or SOL wallet' : values.accountType === 'receivable' ? 'e.g. Client invoice' : values.accountType === 'payable' ? 'e.g. Contractor invoice' : 'e.g. Main chequing', autoFocus: true })}
    <div className="form-grid">{select('Account type', 'accountType', [
      { value: 'cash', label: 'Cash or bank account' }, { value: 'investment', label: 'Investment account or SOL wallet' },
      { value: 'debt', label: 'Loan or credit card' }, { value: 'receivable', label: 'Money owed to you' }, { value: 'payable', label: 'Unpaid bills' },
    ], value => set('accountType', value), 'Choose a type')}</div>
    <div className="form-grid">{amountField(['debt', 'payable'].includes(values.accountType) ? 'Amount owed · CAD' : 'Opening balance · CAD', 'opening', values.accountType === 'cash' ? 'Enter a negative amount for an overdraft, or 0 if the account is empty.' : ['debt', 'payable'].includes(values.accountType) ? 'Enter a negative amount for a credit balance, or 0 if nothing is owed.' : 'Enter 0 if the account is empty.')}{dateField('Balance as of')}</div>
    {values.accountType === 'investment' && <p className="muted">For SOL, enter 0 here and add the holdings on Investments.</p>}
  </>;
  else if (kind === 'transaction') content = <>
    <div className="mazal-segmented" aria-label="Transaction type">{[
      ['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer'], ['debt_payment', 'Debt payment'],
    ].map(([value, label]) => <button type="button" key={value} aria-pressed={values.kind === value} className={values.kind === value ? 'selected' : ''}
      onClick={() => setValues(previous => ({ ...previous, kind: value, toAccountId: '', accountId: sourceAccounts(value).some(account => account.id === previous.accountId) ? previous.accountId : sourceAccounts(value)[0]?.id || '' }))}>{label}</button>)}</div>
    {field('Description', 'description', { placeholder: values.kind === 'income' ? 'e.g. September salary' : values.kind === 'expense' ? 'e.g. Groceries at Farm Boy' : values.kind === 'debt_payment' ? 'e.g. Credit card payment' : 'e.g. Monthly savings transfer', autoFocus: true })}
    <div className="form-grid">{amountField()}{dateField()}</div>
    {accountSelect(values.kind === 'income' ? 'Receiving account' : ['transfer', 'debt_payment'].includes(values.kind) ? 'From account' : 'Payment account', sourceAccounts(values.kind))}
    {['transfer', 'debt_payment'].includes(values.kind) && select(values.kind === 'debt_payment' ? 'Debt account' : 'To account', 'toAccountId', accountOptions((values.kind === 'debt_payment' ? accounts.filter(a => a.type === 'debt' || a.type === 'payable') : selectableAccounts).filter(a => a.id !== values.accountId)), undefined, 'Choose an account', accounts.find(account => account.id === values.toAccountId))}
    {transactionEffect && <div className={`mazal-transaction-preview${transactionEffect.warning ? ' has-warning' : ''}`} aria-live="polite">
      {transactionEffect.warning ? <p>{transactionEffect.warning}</p> : <><h3>Balance after saving</h3><dl>{transactionEffect.rows.map(row => <div key={row.account.id}><dt><strong>{row.account.name}</strong><span>{['debt', 'payable'].includes(row.account.type) ? 'Amount owed' : row.account.type === 'receivable' ? 'Money owed to you' : 'Account balance'}</span></dt><dd aria-label={`Current ${money(row.account.balanceCents)}, after saving ${money(row.after)}`}><span>{money(row.account.balanceCents)}</span><span aria-hidden="true">→</span><strong>{money(row.after)}</strong></dd></div>)}</dl></>}
    </div>}
    {values.kind === 'expense' && field('Category', 'category', { optional: true, placeholder: 'e.g. Food, Housing, Transport', list: categoryListId })}
    {values.kind === 'income' && <details className="mazal-form-optional"><summary><span>Category</span><small>{values.category || 'Optional'}</small></summary>{field('Category', 'category', { optional: true, placeholder: 'e.g. Salary, Freelance' })}</details>}
    {merchantSuggestion && merchantSuggestion.category !== values.category && <p className="muted">Suggested {merchantSuggestion.category}. {merchantSuggestion.reason} <button type="button" className="text-button" onClick={() => set('category', merchantSuggestion.category)}>Use {merchantSuggestion.category}</button></p>}
    {values.kind === 'expense' && <datalist id={categoryListId}>{categorySuggestions.map(limit => <option key={limit.id} value={limit.name}/>)}</datalist>}
    {values.kind === 'transfer' && <p className="muted">Transfers do not count as income or spending.</p>}
    {values.kind === 'debt_payment' && <p className="muted">Record interest separately as an expense.</p>}
    {values.kind === 'debt_payment' && !accounts.some(account => account.type === 'debt' || account.type === 'payable') && <p className="notice">No debt accounts yet. <a href="#debts" onClick={event => { event.preventDefault(); requestClose('#debts'); }}>Add one on Debts</a>.</p>}
    {!sourceAccounts(values.kind).length && <p className="notice">{values.kind === 'debt_payment' ? 'A debt payment needs a cash account.' : values.kind === 'income' ? 'Income needs a cash account or an account for money owed to you.' : values.kind === 'transfer' ? 'A transfer needs a cash or investment account.' : 'An expense needs a cash account, credit card or loan.'} <a href="#investments/accounts" onClick={event => { event.preventDefault(); requestClose('#investments/accounts'); }}>Add a cash account</a>.</p>}
  </>;
  else if (kind === 'obligation') content = <>
    {field('Payment name', 'name', { placeholder: 'e.g. Rent or client invoice', autoFocus: true })}
    <div className="form-grid">{select('Payment type', 'direction', [{ value: 'out', label: 'Bill to pay' }, { value: 'in', label: 'Money expected' }], value => setValues(previous => ({ ...previous, direction: value, accountId: '' })))}</div>
    <label className="field"><span>{values.direction === 'out' ? 'Pay from' : 'Receive into'} · optional</span><select value={values.accountId} onChange={event => set('accountId', event.target.value)}><option value="">Choose later</option>{accounts.filter(a => a.entityId === values.entityId && (values.direction === 'in' ? a.type === 'cash' : ['cash', 'debt', 'payable'].includes(a.type))).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
    {!values.accountId && <p className="muted">You can save the schedule now. Choose a payment account before recording it.</p>}
    <div className="form-grid">{amountField()}{dateField('Next due date')}</div>
    {select('Repeats', 'recurrence', [{ value: 'once', label: 'Once' }, { value: 'monthly', label: 'Every month' }, { value: 'biweekly', label: 'Every two weeks' }])}
    <details className="mazal-form-optional"><summary><span>Category</span><small>{values.category || 'Optional'}</small></summary>{field('Category', 'category', { optional: true, placeholder: 'e.g. Housing, Subscriptions, Sales' })}</details>
    <p className="muted">Your balance changes when you record the payment.</p>
  </>;
  else if (kind === 'reserve') content = <>
    <p className="muted">This cash stays in your account but is excluded from spending money.</p>
    {field('What is it for?', 'name', { placeholder: 'e.g. Emergency fund', autoFocus: true })}
    <div className="form-grid">{amountField()}</div>
  </>;
  else if (kind === 'sol') content = <>
    <p className="muted">Prices update only when you change them here.</p>
    {select('Investment account', 'accountId', accountOptions(investmentAccounts), chooseSolAccount)}
    {!investmentAccounts.length && <p className="notice"><a href="#investments" onClick={event => { event.preventDefault(); requestClose('#investments'); }}>Add an account on Investments</a> first.</p>}
    <div className="form-grid">{field('Unstaked SOL', 'liquidSol', { inputMode: 'decimal' })}{field('Staked SOL', 'stakedSol', { inputMode: 'decimal', hint: 'Include rewards already in your stake balance.' })}</div>
    {amountField('Remaining recorded cost · CAD', 'costBasis')}
    <div className="form-grid">{amountField('Price per SOL · CAD', 'price')}{dateField('Price as of', 'priceDate')}</div>
    {field('Price source', 'priceSource', { placeholder:'Exchange or statement name' })}
    {solConflicts.length > 0 && <div className="mazal-form-notice" role="alert"><p>These values changed in both places. Choose each value to keep.</p>{solConflicts.map(conflict => <div key={conflict.field}><p>{solFieldLabels[conflict.field]} · Saved {conflict.saved || 'not entered'} · Your entry {values[conflict.field] || 'not entered'}</p><button type="button" className="button secondary compact" onClick={() => { set(conflict.field,conflict.saved); setSolConflicts(current => current.filter(item => item.field !== conflict.field)); }}>Use saved {solFieldLabels[conflict.field].toLowerCase()}</button><button type="button" className="button secondary compact" onClick={() => setSolConflicts(current => current.filter(item => item.field !== conflict.field))}>Keep my {solFieldLabels[conflict.field].toLowerCase()}</button></div>)}</div>}
    {positions.find(p => p.accountId === values.accountId) && <p className="muted">Reward history stays saved.</p>}
  </>;
  else if (kind === 'reward') content = <>
    {select('SOL account', 'positionId', positions.map(position => ({ value: position.id, label: accounts.find(account => account.id === position.accountId)?.name || 'SOL account' })), undefined, 'Choose a SOL account')}
    <div className="form-grid">{field('Reward received · SOL', 'reward', { inputMode: 'decimal', placeholder: '0.000000000', autoFocus: true })}{dateField('Reward date')}</div>
    <p className="notice">Adds to staked SOL. Exclude rewards already in your saved balance.</p>
    {!positions.length && <p className="notice">Add SOL holdings on Investments first.</p>}
  </>;
  else if (kind === 'reconcile') {
    let difference: number | null = null;
    try { if (chosenAccount) difference = cents(values.balance, 'Balance', true) - chosenAccount.balanceCents; } catch { /* Input is incomplete. */ }
    content = <>
      {accountSelect('Account', accounts.filter(account => !solAccountIds.has(account.id)))}
      {accountId && !eligibleInitialAccounts.some(account => account.id === accountId) && <p className="notice">The selected account is closed or unavailable. Reopen it in Manage accounts before updating its balance.</p>}
      <div className="form-grid">{amountField(chosenAccount?.type === 'debt' || chosenAccount?.type === 'payable' ? 'Amount owed on statement · CAD' : 'Statement balance · CAD', 'balance')}{dateField('Statement date')}</div>
      {chosenAccount && <div className="mazal-reconcile-preview"><span>Saved balance <strong>{money(chosenAccount.balanceCents)}</strong></span><span>Adjustment <strong>{difference === null ? 'Enter a balance' : `${difference > 0 ? '+' : ''}${money(difference)}`}</strong></span></div>}
      <p className="muted">The statement date must be on or after this account's latest transaction.</p>
      {field('Reason for the change', 'note', { placeholder: 'e.g. Matched current bank balance' })}
    </>;
  }
  else {
    const root = record(backup);
    const data = record(root?.state) || record(root?.data) || root;
    const count = (key: string) => Array.isArray(data?.[key]) ? (data[key] as unknown[]).filter(value => key !== 'accounts' || ['cash', 'investment', 'debt', 'receivable', 'payable'].includes(String(record(value)?.type))).length : null;
    const legacyCash = typeof data?.cash === 'number' && Number.isSafeInteger(data.cash) ? data.cash : null;
    const legacyInvestments = typeof data?.investments === 'number' && Number.isSafeInteger(data.investments) ? data.investments : 0;
    const recentChanges = [...state.audit].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
    const switchBackupMode = (mode: 'restore' | 'import_locked') => { setBackupMode(mode); setConfirmed(false); setError(''); setBackup(null); setFileName(''); };
    content = <>
      <CompleteBackup workspace={state.workspace} revision={state.revision} disabled={saving||reading||recoveryBusy||storageBusy||Boolean(backup)||recoveryDirty||storageDirty} onBusyChange={setCompleteBusy} onDirtyChange={setCompleteDirty}/>
      <section className="mazal-backup-section"><h3>Download a legacy backup</h3><p className="muted">Download backup saves accounts, transactions, SOL holdings, and history. Download original files saves a separate archive of original documents, reviewed source files, and their metadata. Keep both downloads together.</p>
        <button type="button" className="button secondary" onClick={() => void downloadBackup()} disabled={saving}>Download backup</button>{' '}<button type="button" className="button secondary" onClick={() => void downloadBackup(true)} disabled={saving}>Download original files</button></section>
      <section className="mazal-backup-section"><h3>1. Restore financial records</h3>
        <div className="mazal-segmented"><button type="button" disabled={recoveryDirty||completeDirty} aria-pressed={backupMode === 'restore'} className={backupMode === 'restore' ? 'selected' : ''} onClick={() => switchBackupMode('restore')}>Restore Mazal</button><button type="button" disabled={recoveryDirty||completeDirty} aria-pressed={backupMode === 'import_locked'} className={backupMode === 'import_locked' ? 'selected' : ''} onClick={() => switchBackupMode('import_locked')}>Import Locked</button></div>
        <p className="muted">{backupMode === 'restore' ? 'Restore replaces this workspace. Mazal saves a safety backup before applying the file.' : 'Import current cash, investment, and debt balances from Locked into an empty workspace. Mazal preserves the full original export in its backup. Historical transactions are not replayed.'}</p>
        {backupMode === 'import_locked' && !emptyWorkspace && <p className="notice">Locked import needs an empty workspace.</p>}
        <label className="field mazal-file"><span>{backupMode === 'restore' ? 'Mazal backup (.json or .json.gz)' : 'Locked export JSON'}</span><input key={backupMode} type="file" disabled={recoveryDirty||completeDirty} accept={backupMode === 'restore' ? '.json,.gz,application/json,application/gzip' : '.json,application/json'} onChange={event => void readBackup(event.target.files?.[0])} /></label>
        {reading && <p role="status" className="muted">Reading file…</p>}
        {backup !== null && <div className="mazal-backup-preview"><strong>{fileName}</strong>
          <p className="muted">{backupMode === 'import_locked' && legacyCash !== null ? `${money(legacyCash)} cash · ${money(legacyInvestments)} investments · ${Array.isArray(data?.debts) ? data.debts.length : 0} debt accounts` : ['accounts', 'transactions', 'positions'].map(key => count(key) === null ? null : `${count(key)} ${{accounts:'accounts',transactions:'transactions',positions:'SOL holdings'}[key]}`).filter(Boolean).join(' · ') || 'File loaded. Mazal checks it before changing records.'}</p>
          <label className="mazal-checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>{backupMode === 'restore' ? `Replace the ${state.workspace === 'live' ? 'My finances' : 'Sample'} workspace with this backup.` : 'Import this Locked export into the empty workspace.'}</span></label>
        </div>}
      </section>
      <DocumentRecovery key={state.workspace} workspace={state.workspace} revision={state.revision} accounts={state.accounts} disabled={saving || reading || storageBusy || completeBusy || completeDirty || Boolean(backup)} onBusyChange={setRecoveryBusy} onDirtyChange={setRecoveryDirty} />
      <CalculationStorage key={`storage-${state.workspace}`} workspace={state.workspace} disabled={saving || reading || recoveryBusy || completeBusy || completeDirty} onBusyChange={setStorageBusy} onDirtyChange={setStorageDirty} />
      <details className="mazal-change-history"><summary>Change history</summary>
        {recentChanges.length === 0 ? <p className="muted">No changes recorded.</p> : <ol>{recentChanges.map(event => <li key={event.id}>
          <div><span>{event.action.replaceAll('_', ' ')}</span><time dateTime={event.date}>{new Date(event.date).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}</time></div>
          <p>{event.description}</p>
        </li>)}</ol>}
      </details>
    </>;
  }

  const missingAccount = (kind === 'transaction' && !sourceAccounts(values.kind).length) || (kind === 'sol' && !investmentAccounts.length) || (kind === 'reward' && !positions.length);
  const cannotSave = saving || reading || recoveryBusy || storageBusy || completeBusy || recordsChanged || restoreUnconfirmed || Boolean(closeIntent) || !saveAttempt && (solConflicts.length > 0 || Boolean(transactionEffect?.warning) || missingAccount) || (kind === 'backup' && (recoveryDirty || completeDirty || !backup || !confirmed || (backupMode === 'import_locked' && !emptyWorkspace)));
  const formTitle = kind === 'transaction' ? ({ expense: 'Add an expense', income: 'Add income', transfer: 'Transfer between accounts', debt_payment: 'Record a debt payment' }[values.kind] || titles.transaction) : titles[kind];
  const submitLabel = kind === 'backup' ? backupMode === 'restore' ? 'Restore backup' : 'Import Locked data' : kind === 'reconcile' ? 'Update balance' : kind === 'sol' ? 'Save SOL holdings' : kind === 'transaction' ? ({ expense: 'Add expense', income: 'Add income', transfer: 'Record transfer', debt_payment: 'Record payment' }[values.kind] || 'Save transaction') : kind === 'account' ? 'Add account' : kind === 'obligation' ? values.direction === 'in' ? 'Add expected income' : 'Add bill' : kind === 'reward' ? 'Add reward' : 'Set money aside';
  return <dialog ref={dialog} className="mazal-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (closeIntent) keepEditing(); else requestClose(); }} onClick={event => { if (event.target === event.currentTarget && !saving) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose(); } }}>
    <header className="mazal-dialog-header"><div><span className="eyebrow">{state.workspace === 'demo' ? 'Sample workspace' : 'My finances'}</span><h2 id={titleId}>{formTitle}</h2></div><button className="mazal-dialog-close" type="button" aria-label="Close dialog" onClick={() => requestClose()} disabled={saving || reading || recoveryBusy || storageBusy || completeBusy || Boolean(closeIntent)}>×</button></header>
    <form onSubmit={event => void submit(event)} onFocusCapture={event => { if (event.target instanceof HTMLElement && event.target.matches('input, select, textarea')) editingFocus.current = event.target; }}>
      <fieldset disabled={saving || reading || recoveryBusy || storageBusy || completeBusy || Boolean(closeIntent) || !!saveAttempt} inert={Boolean(closeIntent)} className="mazal-form-body">
        {content}
      </fieldset>
      {saveAttempt && <div className="mazal-form-notice" role="status"><p>{restoreUnconfirmed ? 'The selected backup is locked. This window cannot send another restore because that could replace changes saved after the first restore.' : 'The original save is awaiting confirmation. These details are locked so retrying cannot save a second transaction or a different amount.'}</p>{['save_sol', 'reconcile'].includes(saveAttempt.type) && <p>If records changed before this save reached the server, close this form and reopen the current record. Confirming will not replace a newer saved balance or holding.</p>}</div>}
      {recordsChanged && <div className="mazal-form-notice" role="status"><p>Records changed while this form was open. Your entries have been kept.</p>{kind === 'sol' && (() => { const latest = positions.find(position => position.accountId === values.accountId); return latest ? <p>Saved holding: {latest.liquidSol} unstaked + {latest.stakedSol} staked SOL. Recorded cost {money(latest.costBasisCents)}. Quote {money(latest.priceCents)} on {latest.priceDate}. Reviewing loads saved values for fields you have not edited.</p> : <p>No SOL holding is currently saved for this account.</p>; })()}<button type="button" className="button secondary" disabled={saving || reading || recoveryBusy || storageBusy || completeBusy || Boolean(closeIntent) || restoreUnconfirmed} onClick={reviewUpdatedRecords}>Review updated records</button></div>}
      {error && <div className="mazal-form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
      {notice && <div className="mazal-form-notice" role="status">{notice}</div>}
      <footer className={`mazal-dialog-footer${closeIntent ? ' is-confirming' : ''}`}>
        {closeIntent ? <>
          <div className="mazal-discard-message" role="alert"><strong>{saveAttempt ? 'Close and check records?' : 'Discard unsaved changes?'}</strong><p>{saveAttempt ? 'The original save may already be recorded. Closing this form does not undo it.' : 'These entries will be lost.'}</p></div>
          <div className="mazal-discard-actions"><button ref={keepEditingRef} type="button" className="button primary" onClick={keepEditing}>Keep editing</button><button type="button" className="button secondary" onClick={() => {setCloseIntent(null);protection.discard();}}>{saveAttempt ? 'Close and check records' : 'Discard changes'}</button></div>
        </> : restoreUnconfirmed && !saving ? <button type="button" className="button primary" onClick={() => requestClose()}>Close and check records</button> : <><button type="button" className="button secondary" onClick={() => requestClose()} disabled={saving || reading || recoveryBusy || storageBusy || completeBusy}>{kind === 'backup' ? 'Done' : 'Cancel'}</button><button type="submit" className="button primary" disabled={cannotSave}>{saving ? 'Saving…' : saveAttempt ? 'Confirm original save' : submitLabel}</button></>}
      </footer>
    </form>
  </dialog>;
}
