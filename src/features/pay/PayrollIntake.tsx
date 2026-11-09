import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AppState, Command } from '../../../shared/types.ts';
import type { PayrollImport, PayrollSource } from '../../../shared/payroll.ts';
import { payrollReconciliation, payrollTotals } from '../../../shared/payroll.ts';
import { emptyPaystub, emptyPayrollLine, emptyTimecard, reviewedPayrollImport, type PaystubDraft, type PayrollLineDraft, type TimecardDraft } from '../../../shared/payroll-intake.ts';
import { useCommandDraft } from '../../hooks/useCommandDraft.ts';
import { useDraftProtection } from '../../hooks/draft-protection.ts';
import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import DraftDiscardDialog from '../../components/DraftDiscardDialog.tsx';
import './payroll-intake.css';

interface Props { state: AppState; onCommand: (command: Command) => Promise<void>; onClose: () => void; initialKind?: PayrollSource['kind']; onSaved?: (batch: PayrollImport) => void }
interface Original { file: File; bytes: ArrayBuffer; sha256: string; url: string; mimeType: PayrollSource['mimeType'] }
interface ExtractedText { pages: { page: number; text: string; method: 'pdf-text' | 'ocr' }[]; warnings: string[] }
const money = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);

async function payrollRequest<T>(url: string, options: RequestInit, controller: AbortController, timeoutMs: number, timeoutMessage: string, readBody: (response: Response) => Promise<T>): Promise<T> {
  if (controller.signal.aborted) throw controller.signal.reason;
  let rejectAborted: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
  const read = async () => {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (controller.signal.aborted) throw controller.signal.reason;
    const result = await readBody(response);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  };
  try { return await Promise.race([read(), aborted]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAborted!); }
}

export default function PayrollIntake({ state, onCommand, onClose, initialKind = 'paystub', onSaved }: Props) {
  const [kind, setKind] = useState<PayrollSource['kind']>(initialKind);
  const [original, setOriginal] = useState<Original | null>(null);
  const [pageCount, setPageCount] = useState('1');
  const [paystubs, setPaystubs] = useState(() => [emptyPaystub(crypto.randomUUID())]);
  const [timecards, setTimecards] = useState(() => [emptyTimecard(crypto.randomUUID())]);
  const [reviewed, setReviewed] = useState(false);
  const [preview, setPreview] = useState<PayrollImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const [saved, setSaved] = useState(false);
  const [extracted, setExtracted] = useState<ExtractedText | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const attempt = useRef<Extract<Command, { type: 'import_payroll' }> | null>(null);
  const identity = useRef({ id: crypto.randomUUID(), sourceId: crypto.randomUUID(), importedAt: new Date().toISOString() });
  const uploaded = useRef<{ sha256: string; filename: string } | null>(null);
  const lock = useRef(false);
  const request = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const errorNode = useRef<HTMLParagraphElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const { changed, review, prepare, resetRequest } = useCommandDraft(state.revision);
  const initialDraft = useRef(JSON.stringify({ kind, pageCount, paystubs, timecards }));
  const dirty = !saved && (!!original || JSON.stringify({ kind, pageCount, paystubs, timecards }) !== initialDraft.current);
  const protection = useDraftProtection({ dirty: dirty || attempted, busy, onRequestDiscard: () => setDiscard(true) });
  useEffect(() => { dialog.current?.showModal(); dialog.current?.querySelector<HTMLSelectElement>('select')?.focus(); return () => { if (dialog.current?.open) dialog.current.close(); }; }, []);
  useEffect(() => () => { if (original) URL.revokeObjectURL(original.url); }, [original]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  useEffect(() => { if (error) errorNode.current?.focus(); }, [error]);
  useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);
  function close() { if (!lock.current) protection.requestChange(onClose); }
  function edit() { setPreview(null); setReviewed(false); setError(''); }
  async function read(file: File | undefined) {
    if (!file || lock.current || attempted) return;
    lock.current = true; setBusy(true); edit();
    try {
      if (file.size > 25 * 1024 * 1024 || !file.size) throw new Error('Choose an original PDF or image between 1 byte and 25 MB.');
      const extension = file.name.split('.').at(-1)?.toLowerCase();
      const types: Record<string, PayrollSource['mimeType']> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', heic: 'image/heic' };
      const mimeType = extension && types[extension];
      if (!mimeType) throw new Error('Choose the original PDF, PNG, JPG or HEIC file.');
      const bytes = await file.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if ((state.payrollImports ?? []).some(batch => batch.sources.some(source => source.sha256 === sha256))) throw new Error('This original is already in Work & pay. Open its saved records instead of importing it again.');
      setOriginal({ file, bytes, sha256, mimeType, url: URL.createObjectURL(new Blob([bytes], { type: mimeType })) }); uploaded.current = null; setExtracted(null);
      if (mimeType !== 'application/pdf') setPageCount('1');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The original could not be read.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function extractText() {
    if (!original || lock.current) return;
    if (original.bytes.byteLength > 10 * 1024 * 1024) { setError('Text extraction accepts originals up to 10 MB. You can still enter and preserve this file manually.'); return; }
    lock.current = true; setBusy(true); setExtracting(true); setError('');
    const controller = new AbortController(); request.current = controller;
    try {
      const result = await payrollRequest(`/api/document-extract?workspace=${state.workspace}`, { method: 'POST', headers: { 'Content-Type': original.mimeType }, body: original.bytes }, controller, 120_000, 'Text extraction timed out after 2 minutes. Your entries have been kept. Retry extraction or enter the values manually.', async response => {
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error || 'Local text extraction is unavailable. You can enter the source values manually.');
        if (!Array.isArray(result?.pages) || result.pages.length > 20 || result.pages.some((page: ExtractedText['pages'][number]) => !Number.isInteger(page.page) || page.page < 1 || typeof page.text !== 'string' || page.text.length > 200000 || !['pdf-text', 'ocr'].includes(page.method)) || !Array.isArray(result.warnings) || result.warnings.some((warning: unknown) => typeof warning !== 'string')) throw new Error('The extracted text could not be read. Your source values have been kept.');
        return result as ExtractedText;
      });
      if (request.current !== controller) return;
      setExtracted(result);
    } catch (failure) { if (request.current === controller) setError(failure instanceof Error ? failure.message : 'Local text extraction failed. Your entries have been kept.'); }
    finally { if (request.current === controller) { request.current = null; lock.current = false; setBusy(false); setExtracting(false); } }
  }
  function build(): PayrollImport {
    if (!original) throw new Error('Choose the original payroll file.');
    if (!Number.isInteger(Number(pageCount)) || Number(pageCount) < 1 || Number(pageCount) > 1000) throw new Error('Enter between 1 and 1,000 pages for this original.');
    return reviewedPayrollImport({ ...identity.current, source: { id: identity.current.sourceId, filename: uploaded.current?.filename ?? original.file.name, sha256: original.sha256, mimeType: original.mimeType, kind, pageCount: Number(pageCount) }, paystubs, timecards });
  }
  function showPreview() { try { setPreview(build()); setError(''); setReviewed(false); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the source values.'); } }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !preview || !original || saved) return;
    if (changed) { setError('Review the updated records before importing. Your source and entries have been kept.'); return; }
    if (!reviewed) { setError('Check the displayed records against the original and confirm the review.'); return; }
    lock.current = true; setBusy(true); setError('');
    const controller = new AbortController(); request.current = controller;
    try {
      if (uploaded.current?.sha256 !== original.sha256) {
        const result = await payrollRequest(`/api/documents?workspace=${state.workspace}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Mazal-Document': encodeURIComponent(JSON.stringify({ originalName: original.file.name, kind: 'other', notes: 'Payroll original' })) }, body: original.bytes }, controller, 60_000, 'The original upload timed out after 60 seconds. The original may already be saved. No payroll records were added. Your reviewed values have been kept; retry to confirm the original and import them.', async response => {
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new Error(result?.error || 'The payroll original could not be saved.');
          if (result?.document?.sha256 !== original.sha256 || result?.document?.bytes !== original.bytes.byteLength || result?.document?.mimeType !== original.mimeType || typeof result?.document?.originalName !== 'string') throw new Error('The saved original could not be verified. No payroll records were added.');
          return result;
        });
        if (request.current !== controller) return;
        uploaded.current = { sha256: original.sha256, filename: result.document.originalName };
      }
      const batch = attempt.current?.import ?? build();
      const prepared = prepare(attempt.current ?? { type: 'import_payroll', import: batch, requestId: '' });
      attempt.current = prepared;
      setAttempted(true);
      await onCommand(prepared);
      if (request.current !== controller) return;
      attempt.current = null; setSaved(true); setAttempted(false); onSaved?.(batch); onClose();
    } catch (failure) { if (request.current === controller) { if (isConfirmedCommandRejection(failure)) { attempt.current = null; setAttempted(false); resetRequest(); } setError(failure instanceof Error ? failure.message : 'The import could not be confirmed. Your reviewed values have been kept.'); } }
    finally { if (request.current === controller) { request.current = null; lock.current = false; setBusy(false); } }
  }
  const totals = preview ? payrollTotals(preview.paystubs) : null;
  return <><DraftDiscardDialog open={discard} uncertain={attempted} onDiscard={() => { setDiscard(false); attempt.current = null; setAttempted(false); setSaved(true); protection.discard(); }} onKeepEditing={() => { setDiscard(false); protection.keepEditing(); }}/><dialog ref={dialog} className="payroll-intake" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }}>
    <header><div><h2 id={`${id}-title`}>Add payroll records</h2><p>Keep the original file and enter the values you reviewed. Payroll records do not post money to a bank account.</p></div><button type="button" onClick={close} disabled={busy} aria-label="Close payroll intake">Close</button></header>
    <form onSubmit={save}>
      <fieldset disabled={busy || !!preview}><legend>Original file</legend><label>Record type<select value={kind} onChange={event => { setKind(event.target.value as typeof kind); edit(); }}><option value="paystub">Pay statements</option><option value="timecards">Timecards</option></select></label><label>Original PDF or image<input type="file" accept=".pdf,.png,.jpg,.jpeg,.heic" onChange={event => void read(event.target.files?.[0])}/></label>{original && <p><a href={original.url} target="_blank" rel="noreferrer">Open {original.file.name}</a> · {(original.bytes.byteLength / 1024).toFixed(1)} KB</p>}<label>Pages in original<input type="number" min="1" max="1000" value={pageCount} onChange={event => { setPageCount(event.target.value); edit(); }} readOnly={!!original && original.mimeType !== 'application/pdf'}/></label><p>Add every paystub page or timecard row you want to retain before saving this file.</p></fieldset>
      {original && <section className="payroll-extracted-text"><button type="button" onClick={() => void extractText()} disabled={busy}>{extracting ? 'Reading text on this Mac…' : 'Extract text on this Mac'}</button><p>Text stays on this computer. Check it against the original before entering amounts; extraction does not fill or save financial records.</p>{extracted && <>{extracted.warnings.map((warning, index) => <p key={index} role="note">{warning}</p>)}{extracted.pages.map(page => <details key={page.page} open={extracted.pages.length === 1}><summary>Page {page.page} · {page.method === 'ocr' ? 'Text read from image' : 'PDF text'}</summary><pre>{page.text || 'No text was found on this page.'}</pre></details>)}</>}</section>}
      {!preview && <fieldset disabled={busy}><legend>{kind === 'paystub' ? 'Values from each statement' : 'Timecard rows'}</legend><p>Keep negative corrections. Leave optional fields blank when the source does not list them. Current totals require source values, including an explicit zero when shown.</p>
        {kind === 'paystub' ? paystubs.map((draft, index) => <PaystubFields key={draft.id} draft={draft} number={index + 1} set={value => { setPaystubs(rows => rows.map((row, position) => position === index ? value : row)); edit(); }} remove={paystubs.length > 1 ? () => setPaystubs(rows => rows.filter(row => row.id !== draft.id)) : undefined}/>) : timecards.map((draft, index) => <TimecardFields key={draft.id} draft={draft} number={index + 1} set={value => { setTimecards(rows => rows.map((row, position) => position === index ? value : row)); edit(); }} remove={timecards.length > 1 ? () => setTimecards(rows => rows.filter(row => row.id !== draft.id)) : undefined}/>)}
        <button type="button" onClick={() => kind === 'paystub' ? setPaystubs(rows => [...rows, emptyPaystub(crypto.randomUUID(), rows.length + 1)]) : setTimecards(rows => [...rows, emptyTimecard(crypto.randomUUID(), rows.length + 1)])}>Add another {kind === 'paystub' ? 'paystub' : 'row'}</button>
      </fieldset>}
      {preview && <section className="payroll-intake-preview" aria-label="Reviewed payroll values"><h3 ref={previewHeading} tabIndex={-1}>Review before saving</h3><p>{preview.sources[0].filename} · {preview.paystubs.length} pay statements · {preview.timecards.length} timecard rows{totals && preview.paystubs.length > 0 && ` · ${money(totals.netCents)} net pay`}</p><ul>{preview.paystubs.map(stub => <li key={stub.id}><strong>Page {stub.sourcePage} · {stub.employer} · {stub.payDate} · Net {money(stub.netCents)}</strong><p>Period {stub.periodStart} to {stub.periodEnd}. Gross {money(stub.grossCents)}, taxes {money(stub.taxCents)}, deductions {money(stub.deductionCents)}, {stub.hours} payroll hours.</p>{!payrollReconciliation(stub).isBalanced && <p>Some line details or year-to-date values are missing or differ from the totals. The source values will be saved for review.</p>}</li>)}{preview.timecards.map(card => <li key={card.id}>Page {card.sourcePage} · row {card.sourceRow} · {card.periodStart} to {card.periodEnd} · {card.hours} hours · {card.status} · {card.system}</li>)}</ul><label className="payroll-checkbox"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={busy}/>I checked these records against the original file.</label><button type="button" onClick={() => { setPreview(null); setReviewed(false); }} disabled={busy || attempted}>Edit values</button></section>}
      {attempted && !busy && <p role="status">The import may already be saved. Retry to confirm these same reviewed records.</p>}
      {changed && <p role="status">Records changed while this form was open. <button type="button" onClick={() => { review(true); setError(''); }} disabled={busy}>I reviewed the updated records</button></p>}
      {error && <p ref={errorNode} role="alert" tabIndex={-1}>{error}</p>}
      <footer>{preview ? <button className="button" type="submit" disabled={busy || changed || !reviewed}>{busy ? 'Saving original and records…' : 'Save reviewed payroll'}</button> : <button className="button" type="button" onClick={showPreview} disabled={busy || !original}>{busy ? 'Reading original…' : 'Review entered records'}</button>}<button type="button" onClick={close} disabled={busy}>Cancel</button></footer>
    </form>
  </dialog></>;
}

function PaystubFields({ draft, number, set, remove }: { draft: PaystubDraft; number: number; set: (draft: PaystubDraft) => void; remove?: () => void }) {
  const fields: [keyof PaystubDraft, string, string][] = [['sourcePage', 'Source page', 'number'], ['employer', 'Employer', 'text'], ['payDate', 'Pay date', 'date'], ['periodStart', 'Period start', 'date'], ['periodEnd', 'Period end', 'date'], ['gross', 'Gross pay', 'text'], ['net', 'Net pay', 'text'], ['tax', 'Taxes', 'text'], ['deduction', 'Deductions', 'text'], ['hours', 'Payroll hours', 'text']];
  const optional: [keyof PaystubDraft, string][] = [['sequence', 'Pay reference'], ['payFrequency', 'Pay frequency'], ['payRate', 'Hourly rate'], ['paymentMethod', 'Payment method'], ['ytdGross', 'Year-to-date gross'], ['ytdNet', 'Year-to-date net'], ['ytdTax', 'Year-to-date taxes'], ['ytdDeduction', 'Year-to-date deductions'], ['ytdHours', 'Year-to-date hours']];
  return <section className="payroll-intake-record"><h3>Paystub {number}</h3><div className="payroll-fields">{fields.map(([key, label, type]) => <label key={key}>{label}<input type={type} value={String(draft[key])} onChange={event => set({ ...draft, [key]: event.target.value })} required/></label>)}</div><details><summary>Optional source details and year-to-date totals</summary><div className="payroll-fields">{optional.map(([key, label]) => <label key={key}>{label}<input value={String(draft[key])} onChange={event => set({ ...draft, [key]: event.target.value })}/></label>)}</div></details><details><summary>Earning, tax and deduction lines</summary>{(['earnings', 'taxes', 'deductions'] as const).map(kind => <LineFields key={kind} kind={kind} rows={draft[kind]} set={rows => set({ ...draft, [kind]: rows })}/>)}<label className="payroll-checkbox"><input type="checkbox" checked={draft.lineDetailsReviewed} onChange={event => set({ ...draft, lineDetailsReviewed: event.target.checked })}/>I entered every earning, tax and deduction line shown on this statement.</label></details>{remove && <button type="button" onClick={remove}>Remove paystub {number}</button>}</section>;
}
function LineFields({ kind, rows, set }: { kind: 'earnings' | 'taxes' | 'deductions'; rows: PayrollLineDraft[]; set: (rows: PayrollLineDraft[]) => void }) {
  const fields: [keyof PayrollLineDraft, string][] = [['label', 'Line label'], ['amount', 'Current amount'], ...(kind === 'earnings' ? [['hours', 'Current hours'], ['rate', 'Rate']] as [keyof PayrollLineDraft, string][] : []), ['ytdAmount', 'Year-to-date amount'], ...(kind === 'earnings' ? [['ytdHours', 'Year-to-date hours']] as [keyof PayrollLineDraft, string][] : [])];
  return <section><h4>{kind[0].toUpperCase() + kind.slice(1)}</h4>{rows.map((row, index) => <div className="payroll-fields" key={index}>{fields.map(([key, label]) => <label key={key}>{label}<input value={row[key]} onChange={event => set(rows.map((item, position) => index === position ? { ...item, [key]: event.target.value } : item))}/></label>)}<button type="button" onClick={() => set(rows.filter((_, position) => position !== index))}>Remove line {index + 1}</button></div>)}<button type="button" onClick={() => set([...rows, emptyPayrollLine()])}>Add {kind === 'earnings' ? 'earning' : kind === 'taxes' ? 'tax' : 'deduction'} line</button></section>;
}
function TimecardFields({ draft, number, set, remove }: { draft: TimecardDraft; number: number; set: (draft: TimecardDraft) => void; remove?: () => void }) {
  const fields: [keyof TimecardDraft, string, string][] = [['sourcePage', 'Source page', 'number'], ['sourceRow', 'Source row', 'number'], ['periodStart', 'Period start', 'date'], ['periodEnd', 'Period end', 'date'], ['hours', 'Hours', 'text'], ['status', 'Source status', 'text'], ['submissionDate', 'Submission date, if listed', 'date'], ['transferredTo', 'Transfer destination, if listed', 'text']];
  return <section className="payroll-intake-record"><h3>Timecard {number}</h3><div className="payroll-fields">{fields.map(([key, label, type]) => <label key={key}>{label}<input type={type} value={draft[key]} onChange={event => set({ ...draft, [key]: event.target.value })}/></label>)}<label>Timecard system<select value={draft.system} onChange={event => set({ ...draft, system: event.target.value as TimecardDraft['system'] })}><option value="projects">Projects</option><option value="legacy">Legacy</option></select></label></div>{remove && <button type="button" onClick={remove}>Remove timecard {number}</button>}</section>;
}
