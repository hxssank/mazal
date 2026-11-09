import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AppState, Command, StatementSourceRow } from '../../../shared/types.ts';
import { today } from '../../../shared/analytics.ts';
import { parseStatementCSV, statementBalanceCheck, statementCSVHeader } from '../../../shared/statement-csv.ts';
import {csvHeaders,defaultStatementMapping,mapStatementCSV,type StatementMapping} from '../../../shared/statement-mapping.ts';
import {useDraftProtection} from '../../hooks/draft-protection.ts';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import './statement-intake.css';

interface Props { state: AppState; accountId?: string; onCommand: (command: Command) => Promise<void>; onClose: () => void }
interface IntakeFile { file: File; bytes: ArrayBuffer; sha256: string; rows: StatementSourceRow[]; id: string; text:string; headers:string[]; csvMapping?:StatementMapping }
const money = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);

export default function StatementIntake({ state, accountId, onCommand, onClose }: Props) {
  const accounts = state.accounts.filter(account => ['cash', 'debt', 'payable'].includes(account.type));
  const [values, setValues] = useState({ accountId: accounts.find(account => account.id === accountId)?.id ?? accounts[0]?.id ?? '', periodStart: '', periodEnd: '', opening: '', closing: '' });
  const initialValues = useRef(values);
  const [source, setSource] = useState<IntakeFile | null>(null);
  const [mapping,setMapping]=useState<StatementMapping|null>(null);
  const [mapped,setMapped]=useState(false);
  const [presetName,setPresetName]=useState('');
  const [mappingNotice,setMappingNotice]=useState('');
  const [presets,setPresets]=useState<{name:string;headers:string[];mapping:StatementMapping}[]>(()=>{try{const saved=JSON.parse(localStorage.getItem('mazal:csv-presets:v1')??'[]');return Array.isArray(saved)?saved.filter(item=>typeof item.name==='string'&&Array.isArray(item.headers)&&item.mapping):[];}catch{return [];}});
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState<Extract<Command, { type: 'stage_statement' }> | null>(null);
  const [uploaded, setUploaded] = useState<{ sha256: string; originalName: string } | null>(null);
  const uploadedRef = useRef<typeof uploaded>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const editingFocus = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const uploadRequest = useRef<AbortController | null>(null);
  const id = useId();
  const { changed, review, prepare, resetRequest } = useCommandDraft(state.revision);
  const account = accounts.find(item => item.id === values.accountId);
  const dirty = !saved && (!!source || Object.keys(values).some(key => values[key as keyof typeof values] !== initialValues.current[key as keyof typeof values]));
  const busy = reading || saving;
  const set = (key: keyof typeof values, value: string) => setValues(previous => ({ ...previous, [key]: value }));
  let balance: ReturnType<typeof statementBalanceCheck> | null = null;
  let validation = '';
  if (source && mapped) {
    try {
      balance = statementBalanceCheck(source.rows, values.periodStart, values.periodEnd, values.opening, values.closing);
      if (values.periodEnd > today()) validation = 'The statement period cannot end in the future.';
    } catch (failure) { validation = failure instanceof Error ? failure.message : 'Check the statement details.'; }
  }
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLSelectElement>('select')?.focus();
    return () => { uploadRequest.current?.abort(new Error('The statement import was closed.')); if (dialog.current?.open) dialog.current.close(); };
  }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (discard) keepRef.current?.focus(); }, [discard]);
  useEffect(() => { if (saved) reviewRef.current?.focus(); }, [saved]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  const protection=useDraftProtection({dirty,busy,onRequestDiscard:()=>setDiscard(true)});
  function close() { if (!busyRef.current) protection.requestChange(onClose); }
  function keepEditing() {
    protection.keepEditing(); setDiscard(false);
    window.requestAnimationFrame(() => {
      const target = editingFocus.current;
      if (target?.isConnected && !target.matches(':disabled')) target.focus();
      else dialog.current?.querySelector<HTMLButtonElement>('button[type="submit"]:not(:disabled)')?.focus();
    });
  }
  async function read(file: File | undefined) {
    if (!file || busyRef.current || attempt) return;
    busyRef.current = true; setReading(true); setError(''); setMappingNotice(''); setSource(null); setUploaded(null); uploadedRef.current = null;
    try {
      if (!/\.csv$/i.test(file.name)) throw new Error('Choose a CSV file with transaction and posting dates.');
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose a CSV file smaller than 5 MB.');
      const bytes = await file.arrayBuffer();
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('Save the CSV as UTF-8 so its original text can be preserved.'); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('The CSV contains unsupported control characters. Choose a UTF-8 statement export.');
      const headers=csvHeaders(text);
      const preset=presets.find(item=>JSON.stringify(item.headers)===JSON.stringify(headers));
      const nextMapping=preset?.mapping??defaultStatementMapping(headers);
      let rows:StatementSourceRow[]=[];
      try{rows=preset?mapStatementCSV(text,nextMapping):parseStatementCSV(text);}catch{ /* Column review is required before staging. */ }
      setMapping(nextMapping);setMapped(rows.length>0);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      setSource({ file, bytes, sha256, rows, text, headers, id: `statement-${crypto.randomUUID()}`, ...(preset&&rows.length?{csvMapping:{...nextMapping}}:{}) });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'This CSV could not be read.'); }
    finally { busyRef.current = false; setReading(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || saved || discard) return;
    setError('');
    if (changed) { setError('Review the updated records before staging this statement. Your entries have been kept.'); return; }
    if (!mapped) {setError('Apply the column mapping and review the extracted entries first.');return;}
    if (!source || !account) { setError('Choose an account and its complete statement CSV.'); return; }
    if (validation || !balance) { setError(validation || 'Enter the statement period and both balances.'); return; }
    if (balance.differenceCents !== 0) { setError(`The closing balance differs by ${money(Math.abs(balance.differenceCents))}. Check both balances, amount signs, and missing or repeated entries.`); return; }
    busyRef.current = true; setSaving(true);
    try {
      let original = uploadedRef.current;
      if (!original || original.sha256 !== source.sha256) {
        const request = new AbortController();
        uploadRequest.current = request;
        let rejectAborted: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectAborted = () => reject(request.signal.reason);
          request.signal.addEventListener('abort', rejectAborted, { once: true });
        });
        const timer = setTimeout(() => request.abort(new Error('Saving the original CSV timed out after 60 seconds. The original may already be saved. No statement was staged. Your entries are still here. Try again to confirm the original and stage the statement.')), 60_000);
        const upload = async () => {
          const response = await fetch(`/api/documents?workspace=${state.workspace}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Mazal-Document': encodeURIComponent(JSON.stringify({ originalName: source.file.name, kind: 'statement', accountId: account.id, periodStart: values.periodStart, periodEnd: values.periodEnd })) }, body: source.bytes, signal: request.signal });
          if (request.signal.aborted) throw request.signal.reason;
          const result = await response.json().catch(() => null);
          if (request.signal.aborted) throw request.signal.reason;
          if (!response.ok) throw new Error(result?.error || 'The original CSV could not be saved. Try again.');
          if (result?.document?.sha256 !== source.sha256 || result?.document?.bytes !== source.bytes.byteLength || typeof result?.document?.originalName !== 'string' || result?.document?.mimeType !== 'text/csv; charset=utf-8') throw new Error('The saved original could not be verified. No statement was staged. Try again.');
          return { sha256: source.sha256, originalName: result.document.originalName as string };
        };
        try {
          original = await Promise.race([upload(), aborted]);
          if (request.signal.aborted) throw request.signal.reason;
        }
        finally {
          clearTimeout(timer);
          request.signal.removeEventListener('abort', rejectAborted!);
          if (uploadRequest.current === request) uploadRequest.current = null;
        }
        uploadedRef.current = original; setUploaded(original);
      }
      const prepared = prepare(attempt ?? { type: 'stage_statement', requestId: '', statement: { id: source.id, accountId: account.id, sourceFile: original.originalName, sha256: original.sha256, periodStart: values.periodStart, periodEnd: values.periodEnd, openingBalanceCents: balance.openingBalanceCents, closingBalanceCents: balance.closingBalanceCents, rows: source.rows, ...(source.csvMapping?{csvMapping:source.csvMapping}:{}) } });
      setAttempt(prepared);
      await onCommand(prepared);
      setAttempt(null); setSaved(true);
    } catch (failure) { if (isConfirmedCommandRejection(failure)) { setAttempt(null); resetRequest(); } setError(failure instanceof Error ? failure.message : 'The statement could not be staged. Your entries have been kept.'); }
    finally { busyRef.current = false; setSaving(false); }
  }
  function openReview() {
    onClose();
    window.location.hash = '#documents/imports';
    window.dispatchEvent(new Event('mazal:open-import-review'));
  }
  function changeMapping<K extends keyof StatementMapping>(key:K,value:StatementMapping[K]) {setMapping(current=>current?{...current,[key]:value}:null);setMapped(false);setError('');setMappingNotice('');}
  function applyMapping() {if(!source||!mapping)return;try{const rows=mapStatementCSV(source.text,mapping);setSource({...source,rows,csvMapping:{...mapping}});setMapped(true);setError('');}catch(failure){setMapped(false);setError(failure instanceof Error?failure.message:'Review the column mapping.');}}
  function savePreset(){if(!source||!mapping||!presetName.trim())return;const next=[...presets.filter(item=>item.name!==presetName.trim()),{name:presetName.trim(),headers:source.headers,mapping}].slice(-30);try{localStorage.setItem('mazal:csv-presets:v1',JSON.stringify(next));setPresets(next);setMappingNotice(`Saved mapping "${presetName.trim()}" in this browser.`);setPresetName('');}catch{setError('This browser could not save the mapping preset. The import can continue.');}}
  const column=(label:string,key:'transactionDate'|'postingDate'|'description'|'amount'|'debit'|'credit')=><label className="field"><span>{label}</span><select value={mapping?.[key]??-1} onChange={event=>changeMapping(key,Number(event.target.value))}><option value={-1}>Choose column</option>{source?.headers.map((header,index)=><option key={index} value={index}>{header}</option>)}</select></label>;
  const input = (label: string, key: keyof typeof values, type = 'text') => <label className="field"><span>{label}</span><input name={key} type={type} value={values[key]} onChange={event => set(key, event.target.value)} required inputMode={type === 'text' ? 'decimal' : undefined} max={type === 'date' ? today() : undefined}/></label>;
  return <dialog ref={dialog} className="mazal-dialog statement-intake" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (discard) keepEditing(); else close(); }}>
    <header className="mazal-dialog-header"><h2 id={`${id}-title`}>Import a statement</h2><button type="button" className="mazal-dialog-close" aria-label="Close dialog" disabled={busy || discard} onClick={close}>×</button></header>
    {saved ? <><div className="mazal-form-body" role="status"><h3>Statement ready for review</h3><p>{source?.rows.length} entries saved with the original CSV. Balances and spending have not changed.</p><p>Review every entry’s classification and match transfers before recording the statement.</p></div><footer className="mazal-dialog-footer"><button ref={reviewRef} type="button" className="button primary" onClick={openReview}>Review statement</button></footer></> : <form onSubmit={event => void submit(event)} onFocusCapture={event => { if (event.target instanceof HTMLElement && event.target.matches('input, select, textarea')) editingFocus.current = event.target; }}>
      <fieldset className="mazal-form-body" disabled={busy || discard || !!attempt} inert={discard}>
        <p className="muted">Upload the complete CSV, then enter the period and balances printed on the statement. You will review categories and transfers next.</p>
        <label className="field"><span>Account</span><select name="accountId" value={values.accountId} onChange={event => set('accountId', event.target.value)} required><option value="">Choose an account</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.name}{state.entities.length > 1 ? ` · ${state.entities.find(entity => entity.id === item.entityId)?.name ?? ''}` : ''}</option>)}</select></label>
        {!accounts.length && <p className="notice">Add a cash account or debt account before importing its statement.</p>}
        <details className="statement-intake-format" open={!source}><summary>CSV columns and amount signs</summary><p>Default CSV header:</p><code>{statementCSVHeader}</code><p>Both dates use YYYY-MM-DD. Enter dollars with up to two decimal places. Preserve every entry, including payments, refunds and repeated transactions.</p><p>{account?.type === 'cash' ? 'Bank account: deposits are positive; withdrawals and card payments are negative.' : account ? 'Debt account: purchases and interest are positive; payments and refunds are negative. Balances are the amount owed.' : 'Amounts are changes to the account balance. Bank withdrawals are negative. Debt purchases are positive.'}</p><p>Bank exports with other column names can be mapped below. The original file stays unchanged. Confirm explicitly if the bank provides only one date. Categories are chosen during review.</p></details>
        <label className="field mazal-file"><span>Complete statement CSV</span><input name="statementFile" type="file" accept=".csv,text/csv" onChange={event => {const file=event.target.files?.[0];if(source&&file)protection.requestChange(()=>void read(file));else void read(file);}}/><small>UTF-8 CSV, up to 5 MB and 5,000 entries. The exact uploaded bytes are kept as the source.</small></label>
        {source&&mapping&&<details className="statement-intake-format" open={!mapped}><summary>Map bank columns {mapped?'· applied':'· required'}</summary><p>Use the bank's columns directly. Review dates and amount signs against the original before staging.</p>{presets.filter(item=>JSON.stringify(item.headers)===JSON.stringify(source.headers)).length>0&&<label className="field">Saved mapping<select value="" onChange={event=>{const preset=presets.find(item=>item.name===event.target.value);if(preset){setMapping(preset.mapping);setMapped(false);setMappingNotice('');setError('');}}}><option value="">Choose preset</option>{presets.filter(item=>JSON.stringify(item.headers)===JSON.stringify(source.headers)).map(item=><option key={item.name}>{item.name}</option>)}</select></label>}<div className="form-grid">{column('Transaction date column','transactionDate')}{column('Description column','description')}</div><label className="mazal-checkbox"><input type="checkbox" checked={mapping.sameDate} onChange={event=>changeMapping('sameDate',event.target.checked)}/><span>The bank provides one date. Use it as both transaction and posting date.</span></label>{!mapping.sameDate&&column('Posting date column','postingDate')}<label className="field">Date format<select value={mapping.dateFormat} onChange={event=>changeMapping('dateFormat',event.target.value as StatementMapping['dateFormat'])}><option value="ymd">YYYY-MM-DD</option><option value="mdy">MM/DD/YYYY</option><option value="dmy">DD/MM/YYYY</option></select></label><label className="field">Amount columns<select value={mapping.mode} onChange={event=>changeMapping('mode',event.target.value as StatementMapping['mode'])}><option value="signed">One signed amount</option><option value="split">Separate debit and credit</option></select></label>{mapping.mode==='signed'?column('Amount column','amount'):<div className="form-grid">{column('Debit / withdrawal column','debit')}{column('Credit / deposit column','credit')}</div>}<label className="field">Amount direction<select value={mapping.sign} onChange={event=>changeMapping('sign',event.target.value as StatementMapping['sign'])}><option value="as-is">{mapping.mode === 'signed' ? 'Keep amounts as written' : 'Deposits positive, withdrawals negative'}</option><option value="invert">{mapping.mode === 'signed' ? 'Reverse every amount sign' : 'Withdrawals positive, deposits negative'}</option></select></label><p>{account?.type==='cash'?'For cash, money received increases the balance.':'For debts, purchases increase the amount owed and payments reduce it.'} Check the preview and closing balance.</p><button type="button" className="button secondary" onClick={applyMapping}>Apply mapping and preview</button><label className="field">Save mapping as<input value={presetName} maxLength={80} onChange={event=>setPresetName(event.target.value)} placeholder="Bank export name"/></label><button type="button" className="text-button" disabled={!mapped||!presetName.trim()} onClick={savePreset}>Save reusable mapping</button>{mappingNotice&&<p role="status">{mappingNotice}</p>}</details>}
        <div className="form-grid">{input('Period start', 'periodStart', 'date')}{input('Period end', 'periodEnd', 'date')}</div>
        <div className="form-grid">{input('Opening balance · CAD', 'opening')}{input('Closing balance · CAD', 'closing')}</div>
        <p className="muted">Use the statement’s balances, including zero. Do not use today’s balance for an older statement.</p>
        {reading && <p role="status">Reading statement…</p>}
        {source && <><div className="mazal-import-summary"><span><strong>{mapped ? `${source.rows.length} entries` : 'Apply mapping to preview entries'}</strong><small>{source.file.name}</small></span></div>{balance && !validation ? <div className={`statement-intake-balance${balance.differenceCents ? ' has-difference' : ''}`} role="status"><p>{money(balance.openingBalanceCents)} opening + {money(balance.rowTotalCents)} entries = {money(balance.openingBalanceCents + balance.rowTotalCents)}</p><strong>{balance.differenceCents === 0 ? 'Matches the closing balance' : `${money(Math.abs(balance.differenceCents))} difference from closing balance`}</strong>{balance.differenceCents !== 0 && <p>Check both balances, amount signs, and missing or repeated entries.</p>}</div> : validation && <p className="muted" role="status">{validation}</p>}{mapped && <details className="statement-intake-preview"><summary>Preview all {source.rows.length} entries</summary><div className="mazal-import-table" tabIndex={0} aria-label="Complete statement entries"><table><thead><tr><th scope="col">Entry and dates</th><th scope="col">CAD</th></tr></thead><tbody>{source.rows.map(row => <tr key={row.id}><td><span>{row.description}</span><small>Transaction {row.transactionDate}<br/>Posted {row.postingDate}</small></td><td>{money(row.amountCents)}</td></tr>)}</tbody></table></div></details>}</>}
      </fieldset>
      {changed && <div className="mazal-form-notice" role="status"><p>Records changed while this form was open. Your entries have been kept.</p><button type="button" className="button secondary" disabled={busy || discard} onClick={() => { review(true); setError(''); }}>Review updated records</button></div>}
      {uploaded && !saved && <div className="mazal-form-notice">Original CSV saved. {attempt ? 'Staging is not confirmed. Retry to confirm the same account, balances and entries.' : error ? 'The statement was not staged. Review the error and try again.' : 'Staging its entries for review.'}</div>}
      {error && <div className="mazal-form-error" ref={errorRef} tabIndex={-1} role="alert">{error}</div>}
      <footer className={`mazal-dialog-footer${discard ? ' is-confirming' : ''}`}>{discard ? <><div className="mazal-discard-message" role="alert"><strong>Discard this import draft?</strong><p>{uploaded ? 'The original CSV stays in Source files. Check Import review for any entries already saved.' : 'Your file selection and entered balances will be discarded.'}</p></div><div className="mazal-discard-actions"><button ref={keepRef} type="button" className="button primary" onClick={keepEditing}>Keep editing</button><button type="button" className="button secondary" onClick={()=>{setDiscard(false);protection.discard();}}>Discard changes</button></div></> : <><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={busy || changed || !mapped || !source || !account || !balance || !!validation || balance.differenceCents !== 0}>{saving ? 'Saving…' : attempt ? 'Confirm original staging' : 'Stage for review'}</button></>}</footer>
    </form>}
  </dialog>;
}
