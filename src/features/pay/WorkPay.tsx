import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AppState, Command } from '../../../shared/types.ts';
import { payrollBankMatch, payrollIssueReview, payrollIssues, payrollReconciliation, payrollTimecardOverlaps, payrollTotals } from '../../../shared/payroll.ts';
import type { PayrollBankMatch, PayrollDeduction, PayrollImport, PayrollPaystub, PayrollSource, PayrollTimecard } from '../../../shared/payroll.ts';
import PayrollIntake from './PayrollIntake.tsx';
import PayrollReview from './PayrollReview.tsx';
import PayrollLookup from './PayrollLookup.tsx';
import { requestDraftNavigation } from '../../hooks/draft-protection.ts';
import { useEngineDate } from '../../services/useEngine.ts';
import Icon from '../../components/Icon.tsx';
import AnimatedValue from '../../components/AnimatedValue.tsx';
import './work-pay.css';
import './work-pay-review.css';
import './organized-pay.css';

interface Props { state: AppState; initialSection?: Section; onSectionChange?: (section: Section) => void; onCommand?: (command: Command) => Promise<void> }
type PayRecord = PayrollPaystub & { importId: string };
type HourRecord = PayrollTimecard & { importId: string };
type Section = 'pay' | 'hours' | 'review';
const currency = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 });
const amount = (cents: number | null) => cents === null ? 'Not listed' : currency.format(cents / 100);
const hours = (value: number | null) => value === null ? 'Not listed' : new Intl.NumberFormat('en-CA', { maximumFractionDigits: 2 }).format(value);
const dateLabel = (value: string, year = true) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const dateRange = (start: string, end: string) => start === end ? dateLabel(start) : `${dateLabel(start, start.slice(0, 4) !== end.slice(0, 4))} to ${dateLabel(end)}`;
const sourceHref = (source: PayrollSource, workspace: AppState['workspace'], page?: number) => `/api/documents/${encodeURIComponent(source.sha256)}/content?workspace=${workspace}${page ? `#page=${page}` : ''}`;
const systemLabel = (system: PayrollTimecard['system']) => system === 'legacy' ? 'Legacy timecards' : 'Projects timecards';
const payKey = (pay: PayRecord) => `${pay.importId}:${pay.id}`;
const bankMatchLabel = (status: PayrollBankMatch['status']) => status === 'confirmed' ? 'Deposit confirmed' : status === 'matched' ? 'Amount/date match' : status === 'ambiguous' ? 'Possible deposit matches' : 'No deposit in records';
function reconciliationDifferences(pay: PayrollPaystub): string[] {
  const check = payrollReconciliation(pay);
  const amounts: [string, number | null][] = [['Current earnings', check.grossDifferenceCents], ['Current taxes', check.taxDifferenceCents], ['Current deductions', check.deductionDifferenceCents], ['Gross less taxes and deductions', check.netDifferenceCents], ['Year-to-date earnings', check.ytdGrossDifferenceCents], ['Year-to-date taxes', check.ytdTaxDifferenceCents], ['Year-to-date deductions', check.ytdDeductionDifferenceCents], ['Year-to-date net pay', check.ytdNetDifferenceCents]];
  const differences = amounts.filter(([, difference]) => difference !== null && difference !== 0).map(([label, difference]) => `${label} differs from the reported total by ${amount(difference)}.`);
  if (check.hoursDifference !== null && check.hoursDifference !== 0) differences.push(`Current earnings hours differ from the reported total by ${hours(check.hoursDifference)}.`);
  if ('ytdHoursDifference' in check && typeof check.ytdHoursDifference === 'number' && check.ytdHoursDifference !== 0) differences.push(`Year-to-date earnings hours differ from the reported total by ${hours(check.ytdHoursDifference)}.`);
  return differences;
}

export default function WorkPay({ state, initialSection, onSectionChange, onCommand }: Props) {
  const id = useId();
  const asOf = useEngineDate();
  const page = useRef<HTMLDivElement>(null);
  const focusDestination = useRef<'pay' | 'review' | null>(null);
  const sectionFocus = useRef<Section | null>(null);
  const imports = state.payrollImports ?? [];
  const paystubs = useMemo(() => imports.flatMap(batch => batch.paystubs.map(pay => ({ ...pay, importId: batch.id }))).sort((a, b) => a.payDate.localeCompare(b.payDate) || a.sequence.localeCompare(b.sequence)), [imports]);
  const timecards = useMemo(() => imports.flatMap(batch => batch.timecards.map(card => ({ ...card, importId: batch.id }))).sort((a, b) => b.periodStart.localeCompare(a.periodStart)), [imports]);
  const defaultSection = useRef<Section>(paystubs.length === 0 && timecards.length > 0 ? 'hours' : 'pay');
  const [section, setSection] = useState<Section>(initialSection ?? defaultSection.current);
  const [sectionRequest, setSectionRequest] = useState<Section | null>(null);
  const routed = !!onSectionChange;
  useEffect(() => {
    if (!routed || sectionRequest !== null) return;
    const next = initialSection ?? defaultSection.current;
    if (next !== section) { sectionFocus.current = next; setSection(next); }
  }, [initialSection, routed, sectionRequest]);
  useEffect(() => {
    if (sectionFocus.current !== section) return;
    sectionFocus.current = null;
    page.current?.querySelector<HTMLElement>('.work-pay-nav button[aria-pressed="true"]')?.focus();
  }, [section]);
  useEffect(() => {
    if (sectionRequest === null) return;
    setSectionRequest(null);
    onSectionChange?.(sectionRequest);
  }, [sectionRequest, onSectionChange]);
  function selectSection(value: Section) {
    setSection(value);
    if (routed && value !== section) setSectionRequest(value);
  }
  function chooseSection(value: Section) { if (value !== section) requestDraftNavigation(() => selectSection(value)); }
  const [year, setYear] = useState('all');
  const [period, setPeriod] = useState<'all' | 'month' | 'year'>('all');
  const [reviewMonth, setReviewMonth] = useState(asOf.slice(0, 7));
  const [reviewFilter, setReviewFilter] = useState<'open' | 'all'>('open');
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('newest');
  const [intake, setIntake] = useState<PayrollSource['kind'] | null>(null);
  const years = [...new Set(paystubs.map(pay => pay.payDate.slice(0, 4)))].sort().reverse();
  const activeYear = years.includes(year) ? year : 'all';
  const selectedPays = paystubs.filter(pay => (activeYear === 'all' || pay.payDate.startsWith(activeYear)) && (period === 'all' || pay.payDate.startsWith(period === 'month' ? reviewMonth : asOf.slice(0, 4))));
  const visiblePays = selectedPays.filter(pay => `${pay.payDate} ${dateLabel(pay.payDate)} ${pay.sequence} ${pay.employer} ${pay.paymentMethod} ${pay.periodStart} ${pay.periodEnd}`.toLowerCase().includes(query.toLowerCase().trim())).sort((a, b) => sort === 'oldest' ? a.payDate.localeCompare(b.payDate) : sort === 'highest' ? b.netCents - a.netCents : b.payDate.localeCompare(a.payDate));
  const selected = visiblePays.find(pay => payKey(pay) === selectedId) ?? visiblePays[0];
  useEffect(() => { if (selected && payKey(selected) !== selectedId) setSelectedId(payKey(selected)); }, [selected, selectedId]);
  const totals = payrollTotals(selectedPays);
  const statementMatches = selectedPays.map(pay => ({ pay, match: payrollBankMatch(state, pay) }));
  const confirmedStatements = statementMatches.filter(item => item.match.status === 'confirmed').length;
  const possibleStatements = statementMatches.filter(item => item.match.status === 'matched' || item.match.status === 'ambiguous').length;
  const nextReceiptReview = statementMatches.findLast(item => item.match.status !== 'confirmed')?.pay;
  const issues = imports.flatMap(batch => payrollIssues(batch).map(issue => ({ ...issue, importId: batch.id })));
  const reviewCount = issues.filter(issue => issue.severity === 'review' && payrollIssueReview(imports.find(batch => batch.id === issue.importId)!, issue.id)?.status !== 'resolved').length;
  const latestPay = paystubs.at(-1);
  const latestBank = latestPay ? payrollBankMatch(state, latestPay) : null;
  const latestTimecard = timecards.reduce<HourRecord | undefined>((latest, card) => !latest || card.periodEnd > latest.periodEnd ? card : latest, undefined);
  const selectedRange = selectedPays.length ? dateRange(selectedPays[0].payDate, selectedPays[selectedPays.length - 1].payDate) : 'No pay dates in this range';
  function pickPay(pay: PayRecord, clearSearch = true) { requestDraftNavigation(() => { if (section === 'pay' && selectedId === payKey(pay) && (!clearSearch || !query)) page.current?.querySelector<HTMLElement>('.work-pay-detail')?.focus(); else focusDestination.current = 'pay'; setSelectedId(payKey(pay)); if (clearSearch) setQuery(''); selectSection('pay'); }); }
  function openIntake(kind: PayrollSource['kind']) { requestDraftNavigation(() => setIntake(kind)); }
  function pickIssuePay(importId: string, paystubId: string) {
    const pay = paystubs.find(item => item.importId === importId && item.id === paystubId);
    if (pay) requestDraftNavigation(() => { if (section === 'pay' && selectedId === payKey(pay) && period === 'all' && activeYear === 'all' && !query) page.current?.querySelector<HTMLElement>('.work-pay-detail')?.focus(); else focusDestination.current = 'pay'; setYear('all'); setPeriod('all'); setSelectedId(payKey(pay)); setQuery(''); selectSection('pay'); });
  }
  function showImported(batch: PayrollImport) {
    setYear('all'); setPeriod('all'); setQuery('');
    setSelectedId(batch.paystubs.length ? `${batch.id}:${batch.paystubs[0].id}` : '');
    selectSection(batch.paystubs.length ? 'pay' : 'hours');
  }

  useEffect(() => {
    if (!focusDestination.current) return;
    const selector = focusDestination.current === 'pay' ? '.work-pay-detail' : '.work-pay-review-heading h2';
    page.current?.querySelector<HTMLElement>(selector)?.focus();
    focusDestination.current = null;
  }, [section, selectedId, query, period, reviewMonth, year]);

  return <div ref={page} className="work-pay pay-review-workspace">
    {intake && onCommand && <PayrollIntake state={state} initialKind={intake} onSaved={showImported} onCommand={onCommand} onClose={() => setIntake(null)}/>}
    {!imports.length ? <section className="work-pay-empty"><span className="work-pay-kicker">Your employment records</span><h2>Keep work hours and pay in one place</h2><p>Saved pay statements and timecards will appear here with their original files, pay breakdowns and items to review.</p><p>Pay statements describe payroll amounts. Bank transactions remain the record of money received.</p>{onCommand && <button className="button" onClick={() => openIntake('paystub')}>Add payroll records</button>}</section> : <>
    <div className="pay-review-start" role="group" aria-label="Latest payroll records">
      <section className="pay-review-latest" aria-labelledby={`${id}-latest-title`} data-motion-enter>
        <header><span className="pay-review-icon"><Icon name="coins" size={19}/></span><h2 id={`${id}-latest-title`}>Latest pay statement</h2>{latestPay && <time dateTime={latestPay.payDate}>{dateLabel(latestPay.payDate)}</time>}</header>
        <strong className="pay-review-latest-amount"><AnimatedValue value={latestPay?.netCents ?? null} format={amount}/></strong>
        <span className="pay-review-latest-caption">{latestPay ? `${latestPay.employer} · Net pay on statement` : 'Add a pay statement to see its amount and bank evidence.'}</span>
        {latestBank && <div className={`pay-review-receipt ${latestBank.status}`}><span><i aria-hidden="true"/>{bankMatchLabel(latestBank.status)}</span><p>{latestBank.status === 'confirmed' ? 'Confirmed against a saved bank transaction.' : latestBank.status === 'matched' ? 'A recorded deposit matches the amount and date. Check its bank source.' : latestBank.status === 'ambiguous' ? 'Possible bank matches need review before confirming receipt.' : 'The statement records payroll. Receipt in your bank is not confirmed here.'}</p></div>}
        {latestPay && <button type="button" className="text-button" onClick={() => pickIssuePay(latestPay.importId, latestPay.id)}>Inspect latest statement<Icon name="arrow" size={15}/></button>}
      </section>
      <button type="button" className={`pay-review-shortcut${reviewCount ? ' needs-review' : ''}`} onClick={() => chooseSection('review')} aria-label={`Open payroll review, ${reviewCount} open ${reviewCount === 1 ? 'item' : 'items'}`} data-motion-enter>
        <span className="pay-review-shortcut-label"><Icon name="activity" size={18}/>Source checks<Icon name="arrow" size={15}/></span>
        <strong><AnimatedValue value={reviewCount} format={String}/><small>open {reviewCount === 1 ? 'item' : 'items'}</small></strong>
        <p>{reviewCount ? 'Check the flagged amounts, dates and overlapping timecards.' : 'Original files and your review decisions remain available.'}</p>
        <span className="pay-review-shortcut-action">Review payroll sources<Icon name="arrow" size={14}/></span>
      </button>
      <button type="button" className="pay-review-shortcut pay-review-hours-shortcut" onClick={() => chooseSection('hours')} aria-label={`Browse ${timecards.length} saved timecards`} data-motion-enter>
        <span className="pay-review-shortcut-label"><Icon name="clock" size={18}/>Work periods<Icon name="arrow" size={15}/></span>
        <strong><AnimatedValue value={timecards.length} format={String}/><small>{timecards.length === 1 ? 'timecard' : 'timecards'}</small></strong>
        <p>{latestTimecard ? <>Latest period ends <time dateTime={latestTimecard.periodEnd}>{dateLabel(latestTimecard.periodEnd)}</time>.<br/>Systems remain separate when dates overlap.</> : 'Add timecards to compare each work period with its source.'}</p>
        <span className="pay-review-shortcut-action">Review work hours<Icon name="arrow" size={14}/></span>
      </button>
    </div>
    <PayrollLookup state={state}/>
    <div className="work-pay-toolbar"><nav className="work-pay-nav" aria-label="Work and pay sections">
      {([['pay', 'Pay statements'], ['hours', 'Work hours'], ['review', 'Review & sources']] as [Section, string][]).map(([key, label]) => <button key={key} type="button" id={`${id}-${key}-button`} aria-pressed={section === key} aria-controls={`${id}-${key}`} onClick={() => chooseSection(key)}>{label}{key === 'review' && reviewCount > 0 && <span>{reviewCount}</span>}</button>)}
    </nav>{onCommand && <button className="button secondary" onClick={() => openIntake('paystub')}>Add payroll records</button>}</div>
    {section === 'pay' && (paystubs.length === 0 ? <section className="work-pay-empty" id={`${id}-pay`} aria-labelledby={`${id}-pay-button`}><h2>No pay statements saved yet</h2><p>Your timecards are saved in Work hours. Add a pay statement to review gross pay, deductions and its bank deposit.</p>{onCommand && <button type="button" className="button" onClick={() => openIntake('paystub')}>Add pay statement</button>}</section> : <section id={`${id}-pay`} aria-labelledby={`${id}-pay-button`} className="work-pay-section">
      <div className="pay-review-period-controls"><div role="group" aria-label="Payroll review period">{([['all', 'All imported pay'], ['month', 'Monthly review'], ['year', 'This year']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={period === value && activeYear === 'all'} onClick={() => { if (period !== value || activeYear !== 'all') requestDraftNavigation(() => { setPeriod(value); setYear('all'); setSelectedId(''); setQuery(''); }); }}>{label}</button>)}</div>{period === 'month' && <label>Pay month<input type="month" min="1900-01" max="2200-12" value={reviewMonth} aria-label="Payroll review month" onChange={event => { const value = event.target.value; if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= '1900-01' && value <= '2200-12') requestDraftNavigation(() => { setReviewMonth(value); setSelectedId(''); setQuery(''); }); }}/></label>}<span>Statement totals by pay date</span></div>
      <div className="work-pay-period"><div><span className="work-pay-kicker">{period === 'month' ? new Date(`${reviewMonth}-01T12:00:00Z`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : period === 'year' ? asOf.slice(0, 4) : 'By pay date'}</span><p>{selectedRange} <span>· {selectedPays.length} {selectedPays.length === 1 ? 'statement' : 'statements'}</span></p></div><label>Year<select value={activeYear} onChange={event => { const value = event.target.value; requestDraftNavigation(() => { setYear(value); setPeriod('all'); setSelectedId(''); setQuery(''); }); }} aria-label="Pay statement year"><option value="all">All imported pay</option>{years.map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>
      <section className="work-pay-overview" aria-label="Pay totals for selected period" data-motion-enter>
        <div className="work-pay-net"><span className="work-pay-kicker">Net pay on statements</span><strong><AnimatedValue value={totals.netCents} format={amount}/></strong><p>{totals.grossCents > 0 ? `${(totals.netCents / totals.grossCents * 100).toFixed(1)}% of gross pay after taxes and deductions` : 'No pay statements in this period'}</p><div className="work-pay-composition" aria-hidden="true"><span style={{ flex: Math.max(0, totals.netCents) }}/><span style={{ flex: Math.max(0, totals.taxCents) }}/><span style={{ flex: Math.max(0, totals.deductionCents) }}/></div></div>
        <div className="work-pay-total"><span>Gross pay</span><strong><AnimatedValue value={totals.grossCents} format={amount}/></strong><small>Before taxes and deductions</small></div>
        <div className="work-pay-total"><span><i className="work-pay-dot tax"/>Taxes</span><strong><AnimatedValue value={totals.taxCents} format={amount}/></strong><small>Tax lines reported by payroll</small></div>
        <div className="work-pay-total"><span><i className="work-pay-dot deduction"/>Deductions</span><strong><AnimatedValue value={totals.deductionCents} format={amount}/></strong><small>Separate from reported taxes</small></div>
      </section>
      {selectedPays.length > 0 && <section className="pay-bank-coverage" aria-label="Bank evidence for selected pay period" data-motion-enter><div className="pay-bank-coverage-copy"><span><Icon name="wallet" size={16}/>Bank confirmation</span><h3>{confirmedStatements} of {selectedPays.length} statements confirmed</h3><p>{nextReceiptReview ? `${possibleStatements ? `${possibleStatements} ${possibleStatements === 1 ? 'statement has a possible deposit match' : 'statements have possible deposit matches'}. ` : ''}Confirm receipt against bank records.` : 'Each statement in this period has a confirmed bank match.'}</p></div><div className="pay-bank-coverage-meter" role="meter" aria-label="Statements with confirmed bank deposits" aria-valuemin={0} aria-valuemax={selectedPays.length} aria-valuenow={confirmedStatements} aria-valuetext={`${confirmedStatements} of ${selectedPays.length} statements`}><span style={{ width: `${confirmedStatements / selectedPays.length * 100}%` }}/></div>{nextReceiptReview && <button type="button" className="text-button" onClick={() => pickPay(nextReceiptReview)}>Review bank evidence<Icon name="arrow" size={14}/></button>}</section>}
      {selectedPays.length > 0 && <details className="work-pay-trend"><summary><span>Pay over time</span><small>{selectedPays.length} {selectedPays.length === 1 ? 'statement' : 'statements'} · View chart</small></summary><div className="work-pay-trend-content"><header><p>Select a pay date to inspect its statement.</p><div className="work-pay-legend"><span><i className="work-pay-dot net"/>Net</span><span><i className="work-pay-dot tax"/>Taxes</span><span><i className="work-pay-dot deduction"/>Deductions</span></div></header><div className="work-pay-chart" style={{ '--pay-count': selectedPays.length } as CSSProperties}>{selectedPays.map(pay => { const maximum = Math.max(...selectedPays.map(item => item.grossCents), 1); return <button type="button" key={payKey(pay)} className={`work-pay-bar ${selected && payKey(selected) === payKey(pay) ? 'selected' : ''}`} aria-label={`View pay statement for ${dateLabel(pay.payDate)}, net ${amount(pay.netCents)}`} aria-pressed={!!selected && payKey(selected) === payKey(pay)} onClick={() => pickPay(pay)}><span className="work-pay-bar-value">{amount(pay.netCents)}</span><span className="work-pay-bar-track" aria-hidden="true"><span className="work-pay-bar-stack" style={{ height: `${Math.max(1, pay.grossCents / maximum * 100)}%` }}><span className="deduction" style={{ flex: Math.max(0, pay.deductionCents) }}/><span className="tax" style={{ flex: Math.max(0, pay.taxCents) }}/><span className="net" style={{ flex: Math.max(0, pay.netCents) }}/></span></span><span className="work-pay-bar-date">{dateLabel(pay.payDate, false)}</span></button>; })}</div></div></details>}
      <div className="work-pay-records">
        <section className="work-pay-history" aria-labelledby={`${id}-history-title`}><header><h2 id={`${id}-history-title`}>Pay history</h2><span>{visiblePays.length} of {selectedPays.length}</span></header><div className="work-pay-filters"><label className="work-pay-search"><span className="sr-only">Search pay statements</span><input type="search" value={query} placeholder="Search date, employer or reference" onChange={event => { const value = event.target.value; requestDraftNavigation(() => setQuery(value)); }}/></label><label><span className="sr-only">Sort pay statements</span><select aria-label="Sort pay statements" value={sort} onChange={event => { const value = event.target.value; requestDraftNavigation(() => setSort(value)); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="highest">Highest net pay</option></select></label></div><div className="work-pay-history-list">{visiblePays.map(pay => { const match = payrollBankMatch(state, pay); return <button type="button" key={payKey(pay)} className={`work-pay-history-row ${selected && payKey(selected) === payKey(pay) ? 'selected' : ''}`} aria-label={`Inspect ${dateLabel(pay.payDate)} pay statement, reference ${pay.sequence}, ${pay.employer}, net ${amount(pay.netCents)}, ${bankMatchLabel(match.status)}, ${hours(pay.hours)} payroll hours`} aria-pressed={!!selected && payKey(selected) === payKey(pay)} onClick={() => pickPay(pay, false)}><span><strong>{dateLabel(pay.payDate)}</strong><small>{dateRange(pay.periodStart, pay.periodEnd)}</small><span className={`work-pay-bank-status ${match.status}`}><i aria-hidden="true"/>{bankMatchLabel(match.status)}</span></span><span><strong>{amount(pay.netCents)}</strong><small>{hours(pay.hours)} payroll hours</small></span></button>; })}{visiblePays.length === 0 && <div className="work-pay-no-results"><h3>No matching statements</h3><p>Try a date, employer or pay reference.</p>{query && <button className="text-button" onClick={() => requestDraftNavigation(() => setQuery(''))}>Clear search</button>}</div>}</div><p className="work-pay-history-note">Deposit matches use existing bank records. Missing bank evidence does not mean pay is unpaid.</p></section>
        {selected && <PayDetails key={payKey(selected)} pay={selected} batch={imports.find(batch => batch.id === selected.importId)!} state={state} onCommand={onCommand} onReview={() => requestDraftNavigation(() => { focusDestination.current = 'review'; selectSection('review'); })}/>}
      </div>
    </section>)}
    {section === 'hours' && <section id={`${id}-hours`} aria-labelledby={`${id}-hours-button`}><WorkHours timecards={timecards} imports={imports} state={state} onAdd={onCommand ? () => openIntake('timecards') : undefined}/></section>}
    {section === 'review' && <section id={`${id}-review`} aria-labelledby={`${id}-review-button`} className="work-pay-review">
      <header className="work-pay-review-heading"><div><span className="work-pay-kicker">Source review</span><h2 tabIndex={-1}>{reviewCount === 0 ? 'No open review items' : `${reviewCount} ${reviewCount === 1 ? 'item' : 'items'} to check`}</h2><p>{reviewCount === 0 ? 'Original files and source details are kept below.' : 'Check the amounts and dates against the linked originals. Record your decision and a note for each item.'}</p></div></header>
      <div className="pay-review-queue-filter" role="group" aria-label="Payroll review items"><button type="button" aria-pressed={reviewFilter === 'open'} onClick={() => { if (reviewFilter !== 'open') requestDraftNavigation(() => setReviewFilter('open')); }}>Open items <span>{reviewCount}</span></button><button type="button" aria-pressed={reviewFilter === 'all'} onClick={() => { if (reviewFilter !== 'all') requestDraftNavigation(() => setReviewFilter('all')); }}>All source notes <span>{issues.length}</span></button></div>
      {reviewFilter === 'open' && reviewCount === 0 && <div className="pay-review-clear"><Icon name="check" size={20}/><p>No unresolved source checks. You can still read the original files and past decisions.</p><button type="button" className="text-button" onClick={() => requestDraftNavigation(() => setReviewFilter('all'))}>Show all source notes<Icon name="arrow" size={14}/></button></div>}
      <div className="work-pay-issues">{issues.map(issue => { const batch = imports.find(item => item.id === issue.importId)!; const resolved = payrollIssueReview(batch, issue.id)?.status === 'resolved'; return <article key={`${issue.importId}:${issue.id}`} hidden={reviewFilter === 'open' && (issue.severity !== 'review' || resolved)} className={`work-pay-issue ${issue.severity}${resolved ? ' resolved' : ''}`}><span className="work-pay-issue-kind">{resolved ? 'Resolved' : issue.severity === 'review' ? 'Needs review' : 'Source note'}</span><h3>{issue.title}</h3><p>{issue.detail}</p><div className="work-pay-issue-links">{issue.paystubIds.map(payId => { const pay = batch.paystubs.find(item => item.id === payId); return pay ? <button type="button" key={payId} className="text-button" onClick={() => pickIssuePay(batch.id, payId)}>{dateLabel(pay.payDate, false)} pay</button> : null; })}{issue.sourceIds.map(sourceId => { const source = batch.sources.find(item => item.id === sourceId); return source ? <a key={sourceId} href={sourceHref(source, state.workspace)} target="_blank" rel="noreferrer">{source.filename}</a> : null; })}</div><PayrollReview state={state} batch={batch} issueId={issue.id} onCommand={onCommand}/></article>; })}</div>
      <section className="work-pay-sources"><header><h2>Original files</h2><p>Saved with their file fingerprints so every figure can be traced to its source.</p></header>{imports.map(batch => <div key={batch.id} className="work-pay-source-batch"><div className="work-pay-import"><strong>{batch.archive.filename}</strong><span>Imported {new Date(batch.importedAt).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' })}</span><details><summary>Archive fingerprint</summary><code>{batch.archive.sha256}</code></details></div><ul>{batch.sources.map(source => <li key={source.id}><div><strong>{source.filename}</strong><span>{source.kind === 'paystub' ? 'Pay statement' : 'Timecard original'} · {source.pageCount} {source.pageCount === 1 ? 'page' : 'pages'}</span></div><a className="button secondary compact" href={sourceHref(source, state.workspace)} target="_blank" rel="noreferrer">Open original<span className="sr-only"> {source.filename}</span></a></li>)}</ul></div>)}</section>
    </section>}
    </>}
  </div>;
}

function PayDetails({ pay, batch, state, onReview, onCommand }: { pay: PayRecord; batch: PayrollImport; state: AppState; onReview: () => void; onCommand?: (command: Command) => Promise<void> }) {
  const source = batch.sources.find(item => item.id === pay.sourceId);
  const match = payrollBankMatch(state, pay);
  const relatedIssues = payrollIssues(batch).filter(issue => issue.severity === 'review' && issue.paystubIds.includes(pay.id) && payrollIssueReview(batch, issue.id)?.status !== 'resolved');
  const currentEarnings = pay.earnings.filter(earning => earning.hours !== null || earning.rate !== null || earning.amountCents !== null);
  const ytdOnlyCount = pay.earnings.length - currentEarnings.length;
  const hasSignedHours = currentEarnings.some(earning => (earning.hours ?? 0) < 0 || (earning.amountCents ?? 0) < 0 || /advance/i.test(earning.label) && (earning.hours !== null || earning.amountCents !== null));
  const differences = reconciliationDifferences(pay);
  return <article className="work-pay-detail" tabIndex={-1} aria-label={`Pay statement details for ${dateLabel(pay.payDate)}`}><header><div><span className="work-pay-kicker">Pay statement</span><h2>{dateLabel(pay.payDate)}</h2><p>{pay.employer}</p></div>{source && <a className="button secondary compact" href={sourceHref(source, state.workspace, pay.sourcePage)} target="_blank" rel="noreferrer">Open original</a>}</header><div className="work-pay-detail-net"><span>Net pay</span><strong>{amount(pay.netCents)}</strong><span className={`work-pay-bank-status ${match.status}`}><i aria-hidden="true"/>{bankMatchLabel(match.status)}</span></div><p className="work-pay-match-note">{match.reason}</p>{match.transactions.length > 0 && <ul className="work-pay-matches">{match.transactions.map(transaction => <li key={transaction.id}><span>{dateLabel(transaction.date)} · {state.accounts.find(account => account.id === transaction.accountId)?.name ?? 'Recorded account'}</span><strong>{amount(transaction.amountCents)}</strong></li>)}</ul>}<dl className="work-pay-metadata"><div><dt>Pay period</dt><dd>{dateRange(pay.periodStart, pay.periodEnd)}</dd></div><div><dt>Pay rate</dt><dd>{pay.payRate === null ? 'Not listed' : `$${pay.payRate} / hour`}</dd></div><div><dt>Payment method</dt><dd>{pay.paymentMethod || 'Not listed'}</dd></div><div><dt>Pay reference</dt><dd>{pay.sequence || 'Not listed'}</dd></div></dl>{relatedIssues.length > 0 && <button className="work-pay-related" type="button" onClick={onReview}>{relatedIssues.length} {relatedIssues.length === 1 ? 'review item' : 'review items'} linked to this statement <span aria-hidden="true">↗</span></button>}
    <PayrollReview state={state} batch={batch} paystub={pay} onCommand={onCommand}/>
    {pay.lineDetailsReviewed === false && <p role="note">Only statement totals have been reviewed. Line details are incomplete.</p>}
    {differences.length > 0 && <div className="work-pay-arithmetic-warning" role="note"><strong>Source totals need review</strong><p>{differences.join(' ')}</p></div>}
    <div className="work-pay-lines"><div className="work-pay-lines-heading"><h3>Earnings</h3><span>This pay period</span></div><div className="work-pay-table-scroll" tabIndex={0} role="region" aria-label={`Current earnings for ${dateLabel(pay.payDate)}`}><table><caption className="sr-only">Current period earnings for {dateLabel(pay.payDate)}</caption><thead><tr><th scope="col">Earning</th><th scope="col">Hours</th><th scope="col">Rate</th><th scope="col">Amount</th></tr></thead><tbody>{currentEarnings.map((earning, index) => <tr key={`${earning.label}-${index}`} className={(earning.amountCents ?? 0) < 0 ? 'work-pay-negative' : ''}><th scope="row">{earning.label}</th><td>{hours(earning.hours)}</td><td>{earning.rate === null ? 'Not listed' : `$${earning.rate}`}</td><td>{amount(earning.amountCents)}</td></tr>)}</tbody><tfoot><tr><th scope="row">Gross pay</th><td>{hours(pay.hours)}</td><td/><td>{amount(pay.grossCents)}</td></tr></tfoot></table></div>{ytdOnlyCount > 0 && <p className="work-pay-ytd-only">{ytdOnlyCount} earning {ytdOnlyCount === 1 ? 'type appears' : 'types appear'} only in the year-to-date detail below.</p>}{hasSignedHours && <p className="work-pay-adjustment-note">Signed hours include payroll corrections. They are not a total of hours worked during this period.</p>}</div>
    <DeductionLines title="Taxes" lines={pay.taxes} total={pay.taxCents}/><DeductionLines title="Deductions" lines={pay.deductions} total={pay.deductionCents}/>
    <details className="work-pay-ytd"><summary>Year to date on this statement<span>As of {dateLabel(pay.payDate)}</span></summary><p>These are the employer's running totals printed on this statement. They do not change with the period filter.</p><dl className="work-pay-ytd-totals"><div><dt>Gross pay</dt><dd>{amount(pay.ytd.grossCents)}</dd></div><div><dt>Net pay</dt><dd>{amount(pay.ytd.netCents)}</dd></div><div><dt>Taxes</dt><dd>{amount(pay.ytd.taxCents)}</dd></div><div><dt>Deductions</dt><dd>{amount(pay.ytd.deductionCents)}</dd></div><div><dt>Payroll hours</dt><dd>{hours(pay.ytd.hours)}</dd></div></dl><div className="work-pay-table-scroll" tabIndex={0} role="region" aria-label={`Year-to-date earnings for ${dateLabel(pay.payDate)}`}><table><caption>Year-to-date earnings</caption><thead><tr><th scope="col">Earning</th><th scope="col">Hours</th><th scope="col">Amount</th></tr></thead><tbody>{pay.earnings.map((earning, index) => <tr key={`${earning.label}-${index}`}><th scope="row">{earning.label}</th><td>{hours(earning.ytdHours)}</td><td>{amount(earning.ytdAmountCents)}</td></tr>)}</tbody></table></div><DeductionLines title="Year-to-date taxes" lines={pay.taxes} total={pay.ytd.taxCents} ytd/><DeductionLines title="Year-to-date deductions" lines={pay.deductions} total={pay.ytd.deductionCents} ytd/></details>
    <details className="work-pay-vacation"><summary>Vacation reported on this statement</summary><dl className="work-pay-ytd-totals"><div><dt>Balance</dt><dd>{amount(pay.vacationBalanceCents)}</dd></div><div><dt>Accrued</dt><dd>{amount(pay.vacationAccruedCents)}</dd></div></dl><p>Balance and accrual are separate source fields. An unlisted value is unknown.</p></details>
    <footer>{source?.filename ?? 'Source file'} · page {pay.sourcePage} · {pay.payFrequency}</footer>
  </article>;
}

function DeductionLines({ title, lines, total, ytd = false }: { title: string; lines: PayrollDeduction[]; total: number | null; ytd?: boolean }) {
  return <section className="work-pay-deductions"><div className="work-pay-lines-heading"><h3>{title}</h3><strong>{amount(total)}</strong></div>{lines.length > 0 ? <dl>{lines.map((line, index) => <div key={`${line.label}-${index}`}><dt>{line.label}</dt><dd>{amount(ytd ? line.ytdAmountCents : line.amountCents)}</dd></div>)}</dl> : <p>No {title.toLowerCase()} lines on this statement.</p>}</section>;
}

function WorkHours({ timecards, imports, state, onAdd }: { timecards: HourRecord[]; imports: PayrollImport[]; state: AppState; onAdd?: () => void }) {
  const [system, setSystem] = useState<'all' | PayrollTimecard['system']>('all');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const statuses = [...new Set(timecards.map(card => card.status))].sort();
  if (timecards.length === 0) return <section className="work-pay-empty"><h2>No timecards saved yet</h2><p>Add the original timecard file and its work periods to compare hours with your pay statements.</p>{onAdd && <button type="button" className="button" onClick={onAdd}>Add timecards</button>}</section>;
  const visibleCards = timecards.filter(card => (system === 'all' || card.system === system) && (status === 'all' || card.status === status) && `${card.periodStart} ${card.periodEnd} ${dateLabel(card.periodStart)} ${dateLabel(card.periodEnd)} ${card.status}`.toLowerCase().includes(query.toLowerCase().trim()));
  const overlappingPeriods = payrollTimecardOverlaps(timecards);
  const overlapIssue = imports.flatMap(batch => batch.issues).find(issue => issue.id === 'overlapping-timecards');
  return <div className="work-pay-hours"><header><div><h2>Hours recorded on timecards</h2><p>Review each submitted period against its original file.</p></div><span>{visibleCards.length} of {timecards.length} records</span></header><div className="work-pay-hours-note"><strong>Keep the two timecard systems separate</strong><p>{overlapIssue ? overlapIssue.detail : overlappingPeriods.length > 0 ? `${overlappingPeriods.length} overlapping period ${overlappingPeriods.length === 1 ? 'group appears' : 'groups appear'} in these records. Each row keeps its source hours; no combined worked-hours total is inferred.` : 'Each row keeps its source hours. Payroll hours can include corrections, so compare individual source periods before drawing conclusions.'}</p></div><div className="work-pay-hour-filters"><label>Timecard system<select value={system} onChange={event => setSystem(event.target.value as typeof system)}><option value="all">Both systems, grouped</option><option value="legacy">Legacy timecards</option><option value="projects">Projects timecards</option></select></label><label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{statuses.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="work-pay-search">Search periods<input type="search" value={query} placeholder="Search dates" onChange={event => setQuery(event.target.value)}/></label></div>
    {visibleCards.length === 0 && <div className="work-pay-no-results" role="status"><h3>No timecards match these filters.</h3><p>Clear the system, status and date filters to see all saved timecards.</p><button type="button" className="text-button" onClick={() => { setSystem('all'); setStatus('all'); setQuery(''); }}>Clear timecard filters</button></div>}
    {(['projects', 'legacy'] as const).filter(value => (system === 'all' || system === value) && visibleCards.some(card => card.system === value)).map(value => { const cards = visibleCards.filter(card => card.system === value); return <section key={value} className="work-pay-timecard-group"><header><h3>{systemLabel(value)}</h3><span>{cards.length} {cards.length === 1 ? 'row' : 'rows'}</span></header>{cards.length ? <div className="work-pay-table-scroll" tabIndex={0} role="region" aria-label={systemLabel(value)}><table><caption className="sr-only">{systemLabel(value)} from original files</caption><thead><tr><th scope="col">Work period</th><th scope="col">Hours</th><th scope="col">Status</th><th scope="col">Submitted</th><th scope="col">Source</th></tr></thead><tbody>{cards.map(card => { const batch = imports.find(item => item.id === card.importId)!; const source = batch.sources.find(item => item.id === card.sourceId); const flagged = batch.issues.some(issue => issue.severity === 'review' && issue.timecardIds.includes(card.id) && payrollIssueReview(batch, issue.id)?.status !== 'resolved'); return <tr key={`${card.importId}:${card.id}`}><th scope="row">{dateRange(card.periodStart, card.periodEnd)}{flagged && <span className="work-pay-timecard-flag">Source review noted</span>}</th><td className="work-pay-hours-value">{hours(card.hours)}</td><td><span className="work-pay-timecard-status">{card.status}</span>{card.transferredTo && <small>To {card.transferredTo}</small>}</td><td>{card.submissionDate ? dateLabel(card.submissionDate) : 'Not listed'}</td><td>{source && <a href={sourceHref(source, state.workspace, card.sourcePage)} target="_blank" rel="noreferrer">{source.filename}<span>{card.sourcePage ? `Page ${card.sourcePage} · ` : ''}Row {card.sourceRow}</span></a>}</td></tr>; })}</tbody></table></div> : <p className="work-pay-no-results">No timecards match these filters.</p>}</section>; })}
  </div>;
}
