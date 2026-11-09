import { useEffect, useId, useRef, useState } from 'react';
import type { AppState, StatementBatch, StatementImport, StatementSourceRow } from '../../../shared/types.ts';
import { money } from '../../../shared/analytics.ts';
import { statementDateBasisLabel } from '../../../shared/statement-imports.ts';
import { buildPastReview, reviewStatements } from '../../../shared/past-review.ts';
import { useEngineDate } from '../../services/useEngine.ts';
import './review-past.css';

interface Props {
  state: AppState;
  scope?: string;
  onTransactions?: () => void;
  onImport?: () => void;
}

type EntryKind = 'purchase' | 'payment' | 'refund' | 'interest' | 'income' | 'transfer' | 'unclassified' | 'movement';
interface Entry extends StatementSourceRow { kind: EntryKind; category: string; linked: boolean }
interface Review {
  key: string;
  source: StatementImport | StatementBatch['source'];
  accountName: string;
  debt: boolean;
  href: string;
  entries: Entry[];
  reconciled: boolean;
}
interface ArchiveEntry extends Entry { review: Review; key: string }
type Choice = { key: string; source: StatementImport | StatementBatch['source']; statement?: StatementImport; batch?: StatementBatch };
const pageSize = 15;
const kindNames: Record<EntryKind, string> = { purchase: 'Purchase', payment: 'Payment', refund: 'Refund', interest: 'Interest', income: 'Income', transfer: 'Transfer', movement: 'Account movement', unclassified: 'Unclassified' };
const filters: { value: 'all' | EntryKind; label: string }[] = [{ value: 'all', label: 'All' }, { value: 'purchase', label: 'Purchases' }, { value: 'payment', label: 'Payments' }, { value: 'refund', label: 'Refunds' }, { value: 'interest', label: 'Interest' }, { value: 'income', label: 'Income' }, { value: 'transfer', label: 'Transfers' }, { value: 'movement', label: 'Account movements' }, { value: 'unclassified', label: 'Unclassified' }];
const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortDate = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const signedMoney = (amount: number) => `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${money(Math.abs(amount))}`;
const countLabel = (count: number) => `${count} ${count === 1 ? 'transaction' : 'transactions'}`;
const sourceCount = (count: number) => `${count} ${count === 1 ? 'source' : 'sources'}`;
const monthLabel = (value: string) => new Date(`${value}-01T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const observed = (source: Review['source']) => 'sourceKind' in source && source.sourceKind === 'bank_activity' || source.sourceFile.toLowerCase().endsWith('.json');
const categoryMissing = (row: Entry) => ['purchase', 'refund'].includes(row.kind) && (!row.category.trim() || /^(uncategorized|unclassified|unknown)$/i.test(row.category.trim()));
const needsReview = (row: Entry) => !row.linked || row.kind === 'unclassified' || categoryMissing(row);

function sumCents(amounts: number[]): number {
  const sum = amounts.reduce((total, amount) => {
    if (!Number.isSafeInteger(amount)) throw new Error('Statement amounts must use whole cents.');
    return total + BigInt(amount);
  }, 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Statement totals exceed the supported amount in cents.');
  return Number(sum);
}

function buildReview(state: AppState, choice: Choice): Review {
  const account = state.accounts.find(item => item.id === choice.source.accountId)!;
  const transactions = state.transactions.filter(transaction => transaction.accountId === account.id || transaction.kind === 'debt_payment' && transaction.toAccountId === account.id || transaction.kind === 'transfer' && transaction.toAccountId === account.id);
  let entries: Entry[];
  let reconciled: boolean;
  if (choice.statement) {
    const statement = choice.statement;
    const review = buildPastReview(state, statement.id)!;
    const linked = new Map(transactions.filter(transaction => transaction.statementId === statement.id && (transaction.accountId === account.id || transaction.kind === 'debt_payment' && transaction.toAccountId === account.id)).map(transaction => [transaction.statementRowId, transaction]));
    entries = statement.rows.map(row => ({ ...row, category: linked.get(row.id)?.category ?? row.category, linked: linked.has(row.id) }));
    reconciled = review.reconciled;
  } else {
    const batch = choice.batch!;
    const decisions = new Map(batch.decisions.map(decision => [decision.rowId, decision]));
    const linked = new Map(transactions.flatMap(transaction => (transaction.importSources ?? []).filter(ref => ref.importId === batch.id).map(ref => [ref.rowId, transaction] as const)));
    entries = batch.source.rows.map(row => {
      const decision = decisions.get(row.id);
      const transaction = linked.get(row.id);
      const kind: EntryKind = decision?.kind === 'expense' ? 'purchase' : decision?.kind === 'transfer' && transaction?.kind === 'debt_payment' ? 'payment' : decision?.kind ?? 'unclassified';
      return { ...row, kind, category: transaction?.category ?? decision?.category ?? '', linked: !!transaction };
    });
    reconciled = sumCents([batch.source.openingBalanceCents, ...entries.map(row => row.amountCents), -batch.source.closingBalanceCents]) === 0;
  }
  return {
    key: choice.key, source: choice.source, accountName: account.name, debt: ['debt', 'payable'].includes(account.type), entries, reconciled,
    href: `/api/source?file=${encodeURIComponent(choice.source.sourceFile)}&sha=${choice.source.sha256}&workspace=${state.workspace}`,
  };
}

function StatementSummary({ review }: { review: Review }) {
  const { source, entries, debt } = review;
  const added = sumCents(entries.map(row => Math.max(0, row.amountCents)));
  const reduced = sumCents(entries.map(row => Math.max(0, -row.amountCents)));
  const balanceChange = sumCents([source.closingBalanceCents, -source.openingBalanceCents]);
  const missing = entries.filter(row => !row.linked).length;
  return <section className="past-review-statement" aria-label={review.accountName + ' statement details'}>
    <div className="past-review-statement-heading">
      <div><h3 tabIndex={-1}>{review.accountName}</h3><p>{dateLabel(source.periodStart)} to {dateLabel(source.periodEnd)} · CAD</p></div>
      <a className="past-review-pdf" href={review.href} target="_blank" rel="noreferrer">Open original source <span aria-hidden="true">↗</span></a>
    </div>
    {(!review.reconciled || missing > 0) && <div className="past-review-error" role="alert">{!review.reconciled && <p>The entries do not match the statement's closing balance.</p>}{missing > 0 && <p>{missing} {missing === 1 ? 'entry is' : 'entries are'} missing a linked transaction. The amounts below are from the statement.</p>}<a href={review.href} target="_blank" rel="noreferrer">Check the original source</a></div>}
    {observed(source) && <p className="past-review-observation">Saved bank observation. Dates follow account activity; this is not a monthly statement.</p>}
    <details className="past-review-balance-details">
      <summary><span>Statement balances</span><span>{review.reconciled ? 'Balance matches source' : 'Balance needs review'}</span></summary>
      <dl className="past-review-amounts">
        <div><dt>Opening balance</dt><dd>{money(source.openingBalanceCents)}</dd></div>
        <div><dt>{debt ? 'Charges' : 'Money in'}</dt><dd>{money(added)}</dd></div>
        <div><dt>{debt ? 'Payments & credits' : 'Money out'}</dt><dd>{money(reduced)}</dd></div>
        <div className="past-review-closing"><dt>Closing balance</dt><dd>{money(source.closingBalanceCents)}{review.reconciled && <small>{balanceChange === 0 ? 'Unchanged' : money(Math.abs(balanceChange)) + (balanceChange < 0 ? ' lower' : ' higher')}</small>}</dd></div>
      </dl>
      <details className="past-review-provenance"><summary>Source details</summary><p>{source.sourceFile}</p><p className="past-review-hash">SHA-256 {source.sha256}</p><p>Closing balance is dated {dateLabel(source.periodEnd)}. It is not a current account balance.</p></details>
    </details>
  </section>;
}

function StatementArchive({ state, scope = 'all', onTransactions, onImport }: Props) {
  const id = useId();
  const asOf = useEngineDate();
  const archive = useRef<HTMLElement>(null);
  const focusDestination = useRef<'statement' | 'transactions' | null>(null);
  const [accountId, setAccountId] = useState('all');
  const [statementId, setStatementId] = useState('all');
  const [query, setQuery] = useState('');
  const [month, setMonth] = useState('all');
  const [period, setPeriod] = useState<'all' | 'today' | 'week' | 'month'>('all');
  const [kind, setKind] = useState<'all' | EntryKind>('all');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sort, setSort] = useState('newest');
  const [view, setView] = useState<'transactions' | 'merchants'>('transactions');
  const [merchant, setMerchant] = useState('');
  const [page, setPage] = useState(0);
  const accounts = new Set(state.accounts.filter(account => scope === 'all' || account.entityId === scope).map(account => account.id));
  const batches = (state.importBatches ?? []).filter(batch => batch.status === 'committed' && accounts.has(batch.source.accountId));
  const sourceKey = (source: Choice['source']) => JSON.stringify([source.accountId, source.sha256]);
  const unique = new Map<string, Choice>();
  for (const statement of reviewStatements(state, scope)) unique.set(sourceKey(statement), { key: 'statement:' + statement.id, source: statement, statement });
  for (const batch of batches) unique.set(sourceKey(batch.source), { key: 'import:' + batch.id, source: batch.source, batch });
  const reviews = [...unique.values()].sort((a, b) => b.source.periodEnd.localeCompare(a.source.periodEnd) || b.source.periodStart.localeCompare(a.source.periodStart) || a.key.localeCompare(b.key)).map(choice => buildReview(state, choice));
  const accountGroups = [...new Set(reviews.map(review => review.source.accountId))].map(account => ({ id: account, reviews: reviews.filter(review => review.source.accountId === account) }));
  const activeAccount = accountGroups.some(account => account.id === accountId) ? accountId : 'all';
  const accountReviews = reviews.filter(review => activeAccount === 'all' || review.source.accountId === activeAccount);
  const selected = accountReviews.find(review => review.key === statementId) ?? (accountReviews.length === 1 ? accountReviews[0] : undefined);
  const visibleReviews = selected ? [selected] : accountReviews;
  const entries: ArchiveEntry[] = visibleReviews.flatMap(review => review.entries.map(row => ({ ...row, review, key: review.key + ':' + row.id })));
  const months = [...new Set(entries.map(row => row.transactionDate.slice(0, 7)))].sort().reverse();
  const weekStart = new Date(`${asOf}T12:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const periodStart = period === 'today' ? asOf : period === 'week' ? weekStart.toISOString().slice(0, 10) : period === 'month' ? `${asOf.slice(0, 7)}-01` : null;
  const dateEntries = entries.filter(row => (month === 'all' || row.transactionDate.startsWith(month)) && (!periodStart || row.transactionDate >= periodStart && row.transactionDate <= asOf));
  const term = query.trim().toLocaleLowerCase();
  const matching = dateEntries.filter(row => (kind === 'all' || row.kind === kind) && (!reviewOnly || needsReview(row)) && (!merchant || row.description === merchant && (row.kind === 'purchase' || row.kind === 'refund')) && (!term || [row.description, row.category, kindNames[row.kind], row.transactionDate, row.postingDate, row.review.accountName, row.review.source.sourceFile, (Math.abs(row.amountCents) / 100).toFixed(2), money(Math.abs(row.amountCents))].join(' ').toLocaleLowerCase().includes(term)))
    .sort((a, b) => (sort === 'largest' ? Math.abs(b.amountCents) - Math.abs(a.amountCents) : sort === 'oldest' ? a.transactionDate.localeCompare(b.transactionDate) : b.transactionDate.localeCompare(a.transactionDate)) || b.postingDate.localeCompare(a.postingDate) || a.key.localeCompare(b.key));
  const groups = new Map<string, { description: string; purchases: number; refunds: number; count: number }>();
  for (const row of matching) {
    if (row.kind !== 'purchase' && row.kind !== 'refund') continue;
    const group = groups.get(row.description) ?? { description: row.description, purchases: 0, refunds: 0, count: 0 };
    const totalKind = row.kind === 'purchase' ? 'purchases' : 'refunds';
    group[totalKind] = sumCents([group[totalKind], Math.abs(row.amountCents)]);
    group.count++;
    groups.set(row.description, group);
  }
  const merchants = [...groups.values()].sort((a, b) => b.purchases - a.purchases || a.description.localeCompare(b.description));
  const total = view === 'transactions' ? matching.length : merchants.length;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));
  const start = currentPage * pageSize;
  const end = Math.min(start + pageSize, total);
  const reviewCount = dateEntries.filter(needsReview).length;
  const mismatches = accountReviews.filter(review => !review.reconciled);
  const activeFilters = !!query || kind !== 'all' || month !== 'all' || period !== 'all' || reviewOnly || !!merchant;
  const reset = () => { setQuery(''); setKind('all'); setMonth('all'); setPeriod('all'); setReviewOnly(false); setMerchant(''); setPage(0); };
  const chooseSource = (key: string) => { setStatementId(key); reset(); setSort('newest'); setView('transactions'); };
  const openSource = (key: string) => { focusDestination.current = 'statement'; chooseSource(key); };
  const openMerchant = (description: string) => { focusDestination.current = 'transactions'; setMerchant(description); setView('transactions'); setKind('all'); setPage(0); };
  useEffect(() => {
    const destination = focusDestination.current;
    focusDestination.current = null;
    if (!destination) return;
    const heading = archive.current?.querySelector<HTMLElement>(destination === 'statement' ? '.past-review-statement-heading h3' : '.past-review-activity-header h3');
    if (heading?.isConnected && !heading.closest('[hidden]')) heading.focus();
  }, [statementId, merchant, view]);
  const chooseAccount = (value: string) => { setAccountId(value); chooseSource('all'); };
  const changeView = (next: 'transactions' | 'merchants') => { setView(next); setKind('all'); setMerchant(''); setPage(0); };
  const summary = selected ? <span>{selected.debt ? 'Charges' : 'Money in'} {money(sumCents(matching.map(row => Math.max(0, row.amountCents))))} · {selected.debt ? 'Payments & credits' : 'Money out'} {money(sumCents(matching.map(row => Math.max(0, -row.amountCents))))}</span> : <span>Across {sourceCount(new Set(matching.map(row => row.review.key)).size)}</span>;

  if (!reviews.length) return <section className="past-review past-review-empty"><span className="past-review-eyebrow">Statement archive</span><h2>No recorded statements yet</h2><p>Review imported bank or card statements to make their transactions searchable here.</p>{onImport && <button type="button" className="past-review-action" onClick={onImport}>Open import review <span aria-hidden="true">→</span></button>}</section>;

  return <section ref={archive} className="past-review" aria-labelledby={id + '-heading'}>
    <header className="past-review-header"><div><span className="past-review-eyebrow">Statement archive</span><h2 id={id + '-heading'}>Recorded activity</h2><p>{sourceCount(reviews.length)} · {accountGroups.length} {accountGroups.length === 1 ? 'account' : 'accounts'} · Latest record {dateLabel(reviews[0].source.periodEnd)}</p></div>{onImport && <button type="button" className="past-review-action" onClick={onImport}>Review imports <span aria-hidden="true">→</span></button>}</header>
    <div className="past-review-accounts" role="group" aria-label="Statement accounts">
      <button type="button" aria-pressed={activeAccount === 'all'} onClick={() => chooseAccount('all')}><strong>All accounts</strong><span>{sourceCount(reviews.length)}</span></button>
      {accountGroups.map(group => <button type="button" key={group.id} aria-pressed={activeAccount === group.id} onClick={() => chooseAccount(group.id)}><strong>{group.reviews[0].accountName}</strong><span>{sourceCount(group.reviews.length)} · Latest {dateLabel(group.reviews[0].source.periodEnd)}</span></button>)}
    </div>
    <label className="past-review-account-select" htmlFor={id + '-account'}><span>Account</span><select id={id + '-account'} value={activeAccount} onChange={event => chooseAccount(event.target.value)}><option value="all">All accounts · {sourceCount(reviews.length)}</option>{accountGroups.map(group => <option key={group.id} value={group.id}>{group.reviews[0].accountName} · {sourceCount(group.reviews.length)} · Latest {dateLabel(group.reviews[0].source.periodEnd)}</option>)}</select></label>
    <div className="past-review-selection">
      {accountReviews.length > 1 && <label htmlFor={id + '-statement'}><span>Choose statement</span><select id={id + '-statement'} value={selected?.key ?? 'all'} onChange={event => chooseSource(event.target.value)}><option value="all">All recorded sources ({accountReviews.length})</option>{accountReviews.map(review => <option key={review.key} value={review.key}>{review.accountName} · {dateLabel(review.source.periodEnd)}{observed(review.source) ? ' · Bank observation' : ''}</option>)}</select></label>}
    </div>
    {selected ? <StatementSummary review={selected}/> : mismatches.length > 0 && <div className="past-review-error" role="alert"><p>{mismatches.length} {mismatches.length === 1 ? 'source has' : 'sources have'} a closing balance that does not match the entries.</p>{mismatches.map(review => <button className="past-review-link" type="button" key={review.key} onClick={() => openSource(review.key)}>Check {review.accountName} · {dateLabel(review.source.periodEnd)}</button>)}</div>}
    <div className="past-review-activity-header"><h3 tabIndex={-1}>{selected ? 'Statement transactions' : 'All statement transactions'}</h3><div className="past-review-view" role="group" aria-label="Statement view"><button type="button" aria-pressed={view === 'transactions'} onClick={() => changeView('transactions')}>All transactions</button><button type="button" aria-pressed={view === 'merchants'} onClick={() => changeView('merchants')}>By merchant</button></div></div>
    <div className="records-review-period">
      <div role="group" aria-label="Record review period">{([['all', 'All dates'], ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={period === value && month === 'all'} onClick={() => { setPeriod(value); setMonth('all'); setPage(0); }}>{label}</button>)}</div>
      <p>{periodStart ? `${shortDate(periodStart)}${periodStart !== asOf ? ` to ${shortDate(asOf)}` : ''} · Transaction dates` : month !== 'all' ? `${monthLabel(month)} · Transaction dates` : 'Choose a period for your daily, weekly or monthly review.'} <span>Only recorded sources are included.</span></p>
    </div>
    <div className={'past-review-controls' + (months.length > 1 ? ' has-months' : '')}>
      <label className="past-review-search" htmlFor={id + '-search'}><span>Search transactions</span><input id={id + '-search'} type="search" placeholder="Merchant, category, amount or date" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/></label>
      {months.length > 1 && <label htmlFor={id + '-month'}><span>Month</span><select id={id + '-month'} value={month} onChange={event => { setMonth(event.target.value); setPeriod('all'); setPage(0); }}><option value="all">All months</option>{months.map(value => <option value={value} key={value}>{monthLabel(value)}</option>)}</select></label>}
      {view === 'transactions' && <label htmlFor={id + '-sort'}><span>Sort</span><select id={id + '-sort'} value={sort} onChange={event => { setSort(event.target.value); setPage(0); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="largest">Largest amount</option></select></label>}
    </div>
    <div className="past-review-filters" role="group" aria-label="Transaction type">{filters.filter(filter => (view === 'transactions' || ['all', 'purchase', 'refund'].includes(filter.value)) && (filter.value === 'all' || filter.value === kind || dateEntries.some(row => row.kind === filter.value))).map(filter => <button type="button" key={filter.value} aria-pressed={kind === filter.value} onClick={() => { setKind(filter.value); setPage(0); }}>{filter.label}<span>{filter.value === 'all' ? dateEntries.length : dateEntries.filter(row => row.kind === filter.value).length}</span></button>)}{(reviewCount > 0 || reviewOnly) && <button type="button" className="past-review-needs-review" aria-pressed={reviewOnly} onClick={() => { setReviewOnly(value => !value); setKind('all'); setView('transactions'); setPage(0); }}>Needs review<span>{reviewCount}</span></button>}</div>
    {merchant && <div className="past-review-merchant-filter"><span>{merchant}</span><button type="button" onClick={() => { setMerchant(''); setPage(0); }} aria-label="Clear merchant filter">×</button></div>}
    <div className="past-review-results" aria-live="polite"><p>{view === 'transactions' ? <><strong>{countLabel(matching.length)}</strong>{summary}</> : <><strong>{merchants.length} {merchants.length === 1 ? 'merchant' : 'merchants'}</strong><span>{selected ? 'Purchases and refunds by exact source description' : 'Source-entry totals. Overlapping statements can repeat a transaction.'}</span></>}</p>{activeFilters && <button type="button" className="past-review-link" onClick={reset}>Clear filters</button>}</div>
    {reviewOnly && <p className="past-review-review-note">These entries need a transaction link, a classification or a purchase category.{onTransactions && <> <button type="button" className="past-review-link" onClick={onTransactions}>Edit categories in Expenses →</button></>}</p>}
    {total === 0 ? <div className="past-review-no-matches"><p>{entries.length ? 'No transactions match these filters.' : 'This statement has no transactions.'}</p>{activeFilters && <button type="button" className="past-review-link" onClick={reset}>Show all transactions</button>}</div> : view === 'transactions' ? <table className="past-review-table"><caption className="sr-only">{selected?.accountName ?? 'All accounts'} statement transactions</caption><thead><tr><th scope="col">Date</th><th scope="col">Description and source</th><th scope="col">Category / type</th><th scope="col">{selected?.debt ? 'Debt change' : 'Balance change'}</th></tr></thead><tbody>{matching.slice(start, end).map(row => <tr key={row.key}>
      <td className="past-review-date"><time dateTime={row.transactionDate}>{dateLabel(row.transactionDate)}</time><small>{statementDateBasisLabel(row) ?? `${observed(row.review.source) ? 'Bank activity' : 'Posted'} ${shortDate(row.postingDate)}`}</small></td>
      <td className="past-review-description"><strong>{row.description}</strong>{!selected && <span className="past-review-row-account">{row.review.accountName}</span>}<div className="past-review-row-source"><a href={/\.pdf$/i.test(row.review.source.sourceFile) ? row.review.href + '#page=' + row.sourcePage : row.review.href} target="_blank" rel="noreferrer">{/\.pdf$/i.test(row.review.source.sourceFile) ? 'PDF p. ' + row.sourcePage : 'Original source'}</a>{!selected && <button type="button" className="past-review-link" onClick={() => openSource(row.review.key)} aria-label={'View ' + row.review.accountName + ' statement ending ' + dateLabel(row.review.source.periodEnd)}>View statement</button>}</div></td>
      <td className="past-review-category"><span>{row.category || kindNames[row.kind]}</span>{row.category && row.category.toLocaleLowerCase() !== kindNames[row.kind].toLocaleLowerCase() && <small>{kindNames[row.kind]}</small>}{!row.linked ? <small className="past-review-row-issue">Transaction link missing</small> : row.kind === 'unclassified' ? <small className="past-review-row-issue">Classification missing</small> : categoryMissing(row) && <small className="past-review-row-issue">Category missing</small>}</td>
      <td className={'past-review-entry-amount' + ((row.review.debt ? row.amountCents < 0 : row.amountCents > 0) ? ' is-credit' : '')}>{signedMoney(row.amountCents)}{!selected && <small>{row.review.debt ? 'Debt change' : 'Cash change'}</small>}</td>
    </tr>)}</tbody></table> : <table className="past-review-table past-review-merchant-table"><caption className="sr-only">Purchases and refunds by merchant</caption><thead><tr><th scope="col">Description</th><th scope="col">Purchases</th><th scope="col">Refunds</th></tr></thead><tbody>{merchants.slice(start, end).map(group => <tr key={group.description}><td><button type="button" className="past-review-merchant-link" onClick={() => openMerchant(group.description)}><strong>{group.description}</strong><small>{countLabel(group.count)} <span aria-hidden="true">→</span></small></button></td><td>{money(group.purchases)}</td><td className="is-credit">{group.refunds ? money(group.refunds) : 'None'}</td></tr>)}</tbody></table>}
    {total > pageSize && <nav className="past-review-pagination" aria-label="Statement transaction pages"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{start + 1} to {end} of {total}</span><button type="button" disabled={end >= total} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}
    <footer className="past-review-source"><span>{selected ? selected.debt ? '+ increases debt · − reduces debt' : '+ adds money · − removes money' : 'Original source entries. Overlapping statements can include the same transaction.'}</span>{onTransactions && <button type="button" className="past-review-link" onClick={onTransactions}>Edit categories in Expenses <span aria-hidden="true">→</span></button>}</footer>
  </section>;
}

export default function ReviewPast(props: Props) {
  return <StatementArchive key={props.state.workspace + ':' + (props.scope ?? 'all')} {...props}/>;
}
