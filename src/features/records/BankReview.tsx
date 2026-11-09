import { useMemo, useState } from 'react';
import type { AppState } from '../../../shared/types.ts';
import { bankReview } from '../../../shared/bank-review.ts';
import { statementDateBasisLabel } from '../../../shared/statement-imports.ts';
import { money } from '../../../shared/analytics.ts';
import './bank-review.css';

export default function BankReview({ state, scope }: { state: AppState; scope: string }) {
  const sourceAccounts = new Set([...(state.statements ?? []).map(source => source.accountId), ...(state.importBatches ?? []).filter(batch => batch.status === 'committed').map(batch => batch.source.accountId)]);
  const accounts = state.accounts.filter(account => sourceAccounts.has(account.id) && (scope === 'all' || account.entityId === scope));
  const [accountChoice, setAccount] = useState('');
  const [monthChoice, setMonth] = useState('latest');
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const account = accounts.find(item => item.id === accountChoice) ?? accounts.find(item => item.type === 'cash') ?? accounts[0];
  const result = useMemo(() => {
    try {
      const all = bankReview(state, account?.id ?? '');
      const month = monthChoice === 'latest' ? all.months[0] ?? 'all' : monthChoice;
      return { all, month, review: month === 'all' ? all : bankReview(state, account?.id ?? '', month) };
    } catch (error) { return { error: error instanceof Error ? error.message : 'Could not calculate the bank review.' }; }
  }, [state, account?.id, monthChoice]);
  if ('error' in result) return <section className="bank-review"><h2>Bank review</h2><p role="alert">{result.error} Use the transaction archive to inspect each source separately.</p></section>;
  const { all, month, review } = result;
  if (!account || !all.months.length) return null;
  const cash = account.type === 'cash';
  const observed = review.rows.some(row => !row.observedOn && row.sourceFile.toLowerCase().endsWith('.json'));
  const observedBeforePosting = review.rows.some(row => row.date !== row.postingDate);
  const rows = review.rows.filter(row => (kind === 'all' || row.kind === kind) && `${row.description} ${row.category}`.toLowerCase().includes(query.trim().toLowerCase()));
  const lastPage = Math.max(0, Math.ceil(rows.length / 25) - 1);
  const currentPage = Math.min(page, lastPage);
  const categories = new Map<string, { added: number; removed: number; count: number }>();
  for (const row of review.rows) {
    const previous = categories.get(row.category) ?? { added: 0, removed: 0, count: 0 };
    categories.set(row.category, { added: previous.added + Math.max(0, row.amountCents), removed: previous.removed + Math.max(0, -row.amountCents), count: previous.count + 1 });
  }
  const date = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const monthName = (value: string) => new Date(`${value}-01T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return <section className="bank-review" aria-labelledby="bank-review-heading">
    <header><div><h2 id="bank-review-heading">Bank review</h2><p>Bank source activity. {review.start ? `${date(review.start)} to ${date(review.end)}.` : 'No source coverage in this month.'}</p></div>
      <div className="bank-review-controls"><label>Review account<select value={account.id} onChange={event => { setAccount(event.target.value); setMonth('latest'); setPage(0); }}>{accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Review month<select value={month} onChange={event => { setMonth(event.target.value); setPage(0); }}><option value="all">All covered dates</option>{all.months.map(value => <option key={value} value={value}>{monthName(value)}</option>)}</select></label></div>
    </header>
    {observed && <p>Saved bank observations use the date shown in account activity. A separate posting date was not supplied. PDF and CSV entries use their posting dates.</p>}
    {observedBeforePosting && <p>The observed bank balance already includes entries with later posting dates. Balances include those entries on the observation date; each entry retains the bank posting date.</p>}
    <dl className="bank-review-totals">
      <div><dt>{cash ? 'Deposits' : 'Debt added'}</dt><dd>{money(review.addedCents)}</dd></div>
      <div><dt>{cash ? 'Withdrawals' : 'Debt reduced'}</dt><dd>{money(review.removedCents)}</dd></div>
      <div><dt>Net change</dt><dd>{money(review.addedCents - review.removedCents)}</dd></div>
      <div><dt>Closing source balance</dt><dd>{review.closingCents === null ? 'No coverage' : money(review.closingCents)}</dd><small>{review.end && date(review.end)}</small></div>
    </dl>
    <p>{cash ? `Classified income ${money(review.incomeCents)}. Deposits also include transfers, borrowing, reversals and receipts whose purpose is unconfirmed.` : 'Payments, cash advances and payment reversals change debt without becoming spending.'} Classified spending after refunds: {money(review.spendingCents)}.</p>
    <p>{review.coveredDays} covered days{cash && ` · ${review.below50Days} closed below $50 · ${review.negativeDays} closed negative`}. {review.gaps ? 'There are gaps between sources; no balances are inferred in those gaps.' : 'Balances carry forward only inside source coverage.'} {month !== 'all' && review.coveredDays < new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate() && 'This is a partial month.'}</p>
    <details><summary>Amounts by classification</summary><div className="bank-review-scroll"><table><caption className="sr-only">Posted amounts by classification</caption><thead><tr><th>Classification</th><th>Entries</th><th>{cash ? 'Deposits' : 'Debt added'}</th><th>{cash ? 'Withdrawals' : 'Debt reduced'}</th></tr></thead><tbody>{[...categories].sort((a, b) => b[1].added + b[1].removed - a[1].added - a[1].removed).map(([category, value]) => <tr key={category}><td>{category}</td><td>{value.count}</td><td>{money(value.added)}</td><td>{money(value.removed)}</td></tr>)}</tbody></table></div></details>
    <details><summary>Search {review.rows.length} source entries</summary>
      <div className="bank-review-controls"><label>Search bank entries<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Description or classification"/></label><label>Bank entry type<select value={kind} onChange={event => { setKind(event.target.value); setPage(0); }}><option value="all">All entries</option><option value="income">Classified income</option><option value="spending">Spending and refunds</option><option value="movement">Other account movements</option></select></label></div>
      <p role="status">{rows.length} matching entries</p><div className="bank-review-scroll"><table><caption className="sr-only">Bank source entries</caption><thead><tr><th>Bank date</th><th>Description</th><th>Classification</th><th>Balance change</th><th>Source</th></tr></thead><tbody>{rows.slice(currentPage * 25, (currentPage + 1) * 25).map(row => <tr key={row.id}><td>{date(row.date)}{row.dateBasis ? <small> · {statementDateBasisLabel(row)}</small> : row.date !== row.postingDate ? <small> · Bank posting date {date(row.postingDate)}</small> : !row.observedOn && row.sourceFile.toLowerCase().endsWith('.json') && <small> · Date shown in bank activity</small>}</td><td>{row.description}</td><td>{row.category}</td><td>{money(row.amountCents)}</td><td><a target="_blank" rel="noreferrer" href={`/api/source?workspace=${state.workspace}&file=${encodeURIComponent(row.sourceFile)}&sha=${row.sha256}`}>Original{row.sourceFile.toLowerCase().endsWith('.pdf') ? ` · p${row.sourcePage}` : ''}</a></td></tr>)}</tbody></table></div>
      {rows.length > 25 && <nav aria-label="Bank review pages"><button className="button secondary compact" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage + 1} / {lastPage + 1}</span><button className="button secondary compact" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}
    </details>
  </section>;
}
