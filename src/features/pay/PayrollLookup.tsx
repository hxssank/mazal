import { useId, useState } from 'react';
import type { AppState } from '../../../shared/types.ts';
import { payrollBankMatch, payrollIssueReview } from '../../../shared/payroll.ts';
import { findPayrollRecords } from '../../../shared/payroll-lookup.ts';
import type { PayrollImport } from '../../../shared/payroll.ts';
import './payroll-lookup.css';

const money = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);

export default function PayrollLookup({ state }: { state: AppState }) {
  const id = useId();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const result = findPayrollRecords(state.payrollImports ?? [], start, end);
  function source(batch: PayrollImport, sourceId: string, page?: number) {
    const item = batch.sources.find(entry => entry.id === sourceId);
    return item ? <a href={`/api/documents/${encodeURIComponent(item.sha256)}/content?workspace=${state.workspace}${page ? `#page=${page}` : ''}`} target="_blank" rel="noreferrer">Open {item.filename}</a> : null;
  }
  return <details className="payroll-lookup">
    <summary>Find pay for a work period</summary>
    <p>Enter the dates you worked to see saved timecards, statements and related review notes together.</p>
    <div className="payroll-lookup-dates"><label htmlFor={`${id}-start`}>From<input id={`${id}-start`} type="date" value={start} onChange={event => setStart(event.target.value)}/></label><label htmlFor={`${id}-end`}>To<input id={`${id}-end`} type="date" value={end} onChange={event => setEnd(event.target.value)}/></label></div>
    {start && end && !result && <p role="alert">Enter valid dates with the start on or before the end.</p>}
    {result && <div aria-live="polite">
      <p>Statement periods show payroll's stated dates. Adjustments can refer to other weeks, so a matching period does not prove these hours were paid. Missing records do not prove wages are unpaid.</p>
      <h3>Timecards ({result.cards.length})</h3>
      {result.cards.length ? <ul>{result.cards.map(({ batch, card }) => <li key={`${batch.id}:${card.id}`}><strong>{card.periodStart} to {card.periodEnd}</strong> · {card.hours} hours · {card.status} · {card.system === 'legacy' ? 'Legacy' : 'Projects'} · {source(batch, card.sourceId, card.sourcePage)}</li>)}</ul> : <p>No saved timecard overlaps these dates.</p>}
      <p>Timecards can overlap across systems. Do not add their hours without checking the originals.</p>
      <h3>Statements with overlapping periods ({result.pays.length})</h3>
      {result.pays.length ? <ul>{result.pays.map(({ batch, pay }) => { const match = payrollBankMatch(state, pay); return <li key={`${batch.id}:${pay.id}`}><strong>Pay date {pay.payDate}</strong> · period {pay.periodStart} to {pay.periodEnd} · {pay.hours} payroll units · {money(pay.netCents)} net<br/>{match.reason} {source(batch, pay.sourceId, pay.sourcePage)}</li>; })}</ul> : <p>No saved statement has a period overlapping these dates. A later statement may include adjustments.</p>}
      <h3>Related review notes ({result.issues.length})</h3>
      {result.issues.length ? <ul>{result.issues.map(({ batch, issue }) => { const review = payrollIssueReview(batch, issue.id); return <li key={`${batch.id}:${issue.id}`}><strong>{issue.title}</strong> · {review?.status === 'resolved' ? 'Resolved' : issue.severity === 'review' ? 'Open' : 'Source note'}<p>{issue.detail}</p>{review && <p>Latest review: {review.note}</p>}</li>; })}</ul> : <p>No saved review notes link to the matching records.</p>}
      <p>Latest saved statement: {(state.payrollImports ?? []).flatMap(batch => batch.paystubs).map(pay => pay.payDate).sort().at(-1) ?? 'none'}. A deposit match confirms an amount, not the work weeks it covers.</p>
    </div>}
  </details>;
}
