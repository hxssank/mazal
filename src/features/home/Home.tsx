import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { AppState, Command } from '../../../shared/types.ts';
import type { DailyPlan } from '../../../shared/engine.ts';
import { money } from '../../../shared/analytics.ts';
import { displayNetWorth } from '../../../shared/net-worth.ts';
import SpendingCalendar from '../expenses/SpendingCalendar.tsx';
import Icon from '../../components/Icon.tsx';
import { useEngineDate, useEngineProject, useEngineSummary } from '../../services/useEngine.ts';
import EngineStatus from '../../components/EngineStatus.tsx';
import HomeNextUp, { type HomeNavigate } from './HomeNextUp.tsx';
import HomeBackupStatus from './HomeBackupStatus.tsx';
import HomeBalanceVisual from './HomeBalanceVisual.tsx';
import HomeOutlook from './HomeOutlook.tsx';
import AnimatedValue from '../../components/AnimatedValue.tsx';
import { isConfirmedCommandRejection } from '../../services/command-errors.ts';
import './home.css';
import './home-organized.css';
import './home-actions.css';

const TransactionEditor = lazy(() => import('../../components/RecordActions.tsx').then(module => ({ default: module.TransactionEditor })));

interface Props {
  state: AppState;
  scope: string;
  readOnly: boolean;
  motion: boolean;
  onCommand: (command: Command) => Promise<void>;
  onNavigate: HomeNavigate;
  onBackups?: () => void;
  onOpen: (kind: 'transaction' | 'account' | 'obligation' | 'import' | 'reserve' | 'reconcile', accountId?:string) => void;
}

export default function Home({ state, scope, readOnly, motion, onCommand, onNavigate, onOpen, onBackups }: Props) {
  const asOf = useEngineDate();
  const id = useId();
  const engine = useEngineSummary(state, scope, asOf);
  const forecastEngine = useEngineProject<DailyPlan>(state, scope, asOf, { kind: 'daily_plan', draft: { days: 30 } });
  const summary = engine.data?.summary;
  const netWorth = summary ? displayNetWorth(state, summary, scope) : null;
  const excludedAccounts = netWorth?.excludedAccounts ?? [];
  const excludedDebts = excludedAccounts.filter(account => account.type === 'debt' || account.type === 'payable');
  const [savingAccount, setSavingAccount] = useState('');
  const [inclusionError, setInclusionError] = useState('');
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [calendarFocusId, setCalendarFocusId] = useState<string | null>(null);
  const [hour, setHour] = useState(() => new Date().getHours());
  const saving = useRef(false);
  const accountsDetails = useRef<HTMLDetailsElement>(null);
  const worthDetails = useRef<HTMLDetailsElement>(null);
  const calendarDetails = useRef<HTMLDetailsElement>(null);
  const forecastDetails = useRef<HTMLDetailsElement>(null);
  const inclusionRequests = useRef(new Map<string, Command>());
  const accounts = state.accounts.filter(account => scope === 'all' || account.entityId === scope);
  const cashAccounts = accounts.filter(account => account.type === 'cash');
  const selectedTransaction = state.transactions.find(transaction => transaction.id === transactionId);
  const hasRecordedAssets = accounts.length > 0 || (state.assets ?? []).some(asset => (scope === 'all' || asset.entityId === scope) && asset.status !== 'sold' && asset.estimatedValueCents !== null) || (summary?.receivablesCents ?? 0) > 0 || (state.assetPurchases ?? []).some(purchase => (scope === 'all' || purchase.entityId === scope) && purchase.paidCents !== null);
  const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', ...(date.slice(0, 4) !== asOf.slice(0, 4) ? { year: 'numeric' as const } : {}), timeZone: 'UTC' });
  const welcomeDate = new Date(`${asOf}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  useEffect(() => {
    const refresh = () => setHour(new Date().getHours());
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  function revealSection(section: HTMLDetailsElement | null) {
    if (!section) return;
    section.open = true;
    section.querySelector('summary')?.focus({ preventScroll: true });
    section.scrollIntoView({ behavior: motion ? 'smooth' : 'auto', block: 'start' });
  }
  async function includeAccount(accountId: string) {
    if (readOnly || saving.current) return;
    saving.current = true;
    setSavingAccount(accountId);
    setInclusionError('');
    const key = `${state.workspace}:${accountId}`;
    const command: Command = inclusionRequests.current.get(key) ?? { type: 'set_net_worth_inclusion', accountId, included: true, expectedRevision: state.revision, requestId: crypto.randomUUID() };
    inclusionRequests.current.set(key, command);
    try {
      await onCommand(command);
      inclusionRequests.current.delete(key);
    } catch (error) {
      if (isConfirmedCommandRejection(error)) inclusionRequests.current.delete(key);
      setInclusionError(error instanceof Error ? error.message : 'Could not update the net worth view.');
    } finally {
      saving.current = false;
      setSavingAccount('');
    }
  }

  return <div className="mazal-home home-calendar-layout home-organized">
    <header className="home-welcome" data-motion-enter>
      <div><p className="home-welcome-date"><time dateTime={asOf}>{welcomeDate}</time></p><h2>{greeting}<span aria-hidden="true">.</span></h2><span className="home-record-status">Your money at a glance · CAD{readOnly ? ' · Saved records preview' : ''}</span></div>
      <div className="home-welcome-actions">
        <button type="button" className="button secondary" onClick={() => onNavigate('documents')}>Review records<Icon name="arrow" size={16}/></button>
      </div>
    </header>
    <div className="home-position-grid">
      <section className="home-bank-panel" aria-labelledby={`${id}-cash-title`} data-motion-enter>
        <header className="home-bank-heading"><h2 id={`${id}-cash-title`}>Cash in your accounts</h2><Icon name="wallet" size={19}/></header>
        {summary && <div className={`home-bank-total${summary.cashCents < 0 ? ' is-negative' : ''}`}><AnimatedValue value={cashAccounts.length ? summary.cashCents : null}/></div>}
        {!summary && <EngineStatus {...engine}/>}
        {cashAccounts.length > 0 && <p className="home-bank-caption">Saved balances, before upcoming payments.</p>}
        <details ref={accountsDetails} id={`${id}-accounts`} className="home-balance-details">
        <summary>Accounts and balances <span>{cashAccounts.length}</span><Icon name="down" size={15}/></summary>
        {cashAccounts.length ? <ul className="home-bank-list">{cashAccounts.map(account => <li key={account.id}>
          <button type="button" disabled={readOnly} onClick={() => onOpen('reconcile', account.id)} aria-label={account.closedAt ? `Review closed account ${account.name}` : `Check balance for ${account.name}, ${money(account.balanceCents)}`}>
            <span><strong>{account.name}</strong><small>{account.closedAt ? `Closed ${dateLabel(account.closedAt)}` : account.reconciledAt ? `Balance checked ${dateLabel(account.reconciledAt.slice(0, 10))}` : 'Balance needs checking'}</small></span>
            <strong className={account.balanceCents < 0 ? 'is-negative' : undefined}>{money(account.balanceCents)}</strong><Icon name="arrow" size={14}/>
          </button>
        </li>)}</ul> : <p className="home-bank-empty">Add a bank account and its balance to track the money available for payments.</p>}
        <footer className="home-bank-footer">
          {cashAccounts.length > 0 && <p className="home-bank-note">{cashAccounts.some(account => !account.closedAt) ? readOnly ? 'Check saved balances against your bank.' : 'Select an account to check its balance.' : 'No open cash account. Add one or reopen an account in Manage accounts.'}</p>}
          <button type="button" className="text-button" onClick={() => onNavigate('expenses', 'activity')}>Recent transactions <Icon name="arrow" size={15}/></button>
          {!readOnly && <button type="button" className="text-button" onClick={() => onOpen('account')} aria-label="Add cash or bank account"><Icon name="plus" size={15}/>Add account</button>}
        </footer>
        </details>
      </section>
    <HomeOutlook engine={forecastEngine} onDetails={() => revealSection(forecastDetails.current)}/>
    <section className="position-card home-worth-summary" aria-labelledby={`${id}-wealth-title`} data-motion-enter>
      <div className="home-worth-total">
        <header className="position-header"><h2 id={`${id}-wealth-title`}>{excludedAccounts.length ? `Net worth excluding ${excludedAccounts.map(account => account.name).join(', ')}` : 'Recorded net worth'}</h2><Icon name="invest" size={19}/></header>
        <EngineStatus {...engine}/>
        {summary && netWorth && <>
          <div className={`position-value ${netWorth.netWorthCents < 0 ? 'is-negative' : ''}`}><AnimatedValue value={hasRecordedAssets ? netWorth.netWorthCents : null}/></div>
          <p className="position-equation">{hasRecordedAssets ? <>{money(netWorth.assetsCents)} assets <span>−</span> {money(netWorth.liabilitiesCents)} owed</> : 'Add account balances to calculate net worth.'}</p>
          {hasRecordedAssets && <HomeBalanceVisual assetsCents={netWorth.assetsCents} liabilitiesCents={netWorth.liabilitiesCents} motion={motion} onDetails={() => revealSection(worthDetails.current)}/>}
        </>}
        {accounts.some(account=>!account.excludeFromNetWorth&&account.evidence?.status==='credit_report')&&<p className="position-equation">Includes an OSAP credit report balance that still needs lender confirmation.</p>}
      </div>
      {summary && netWorth && <details ref={worthDetails} className="home-balance-details home-worth-detail">
        <summary>Net worth breakdown<Icon name="down" size={15}/></summary>
        {excludedAccounts.length > 0 && <>
          <p className="position-equation">Net worth with all saved accounts is {money(summary.netWorthCents)}.</p>
          {!readOnly && <div className="position-equation">{excludedAccounts.map(account => <button key={account.id} type="button" className="text-button" disabled={!!savingAccount} onClick={() => void includeAccount(account.id)}>{savingAccount === account.id ? 'Saving…' : `Include ${account.name}`}</button>)}</div>}
          {inclusionError && <p className="position-equation" role="alert">{inclusionError}</p>}
        </>}
        <div className="position-breakdown">
          <button type="button" onClick={() => onNavigate('investments')}><span><i className="balance-key investments"/>Investments<Icon name="arrow" size={13}/></span><strong className={accounts.some(account => account.type === 'investment') ? '' : 'balance-unknown'}>{accounts.some(account => account.type === 'investment') ? money(netWorth.investmentsCents) : 'Not recorded'}</strong></button>
          <button type="button" onClick={() => onNavigate('assets')}><span><i className="balance-key"/>Other assets<Icon name="arrow" size={13}/></span><strong>{money(netWorth.trackedAssetsCents)}</strong></button>
          <button type="button" onClick={() => onNavigate('debts')}><span><i className="balance-key debt"/>Total debt<Icon name="arrow" size={13}/></span><strong>{money(summary.liabilitiesCents)}</strong></button>
          <button type="button" onClick={() => onNavigate('assets')}><span>Owed to you<Icon name="arrow" size={13}/></span><strong>{money(summary.receivablesCents)}</strong></button>
        </div>
        {excludedDebts.length > 0 && <p className="position-equation">Total debt includes {excludedDebts.map(account => account.name).join(', ')}, excluded from the net worth above.</p>}
      </details>}
    </section>
    </div>
    <HomeNextUp state={state} scope={scope} asOf={asOf} readOnly={readOnly} engine={forecastEngine} forecastRef={forecastDetails} onNavigate={onNavigate} onOpen={onOpen}>
    <details ref={calendarDetails} id={`${id}-calendar`} className="home-calendar-details" data-motion-enter>
      <summary><Icon name="plan" size={18}/><span><strong>Spending calendar</strong><small>Review transactions by day</small></span><Icon name="down" size={18}/></summary>
      <SpendingCalendar key={`${state.workspace}-${scope}`} state={state} scope={scope} asOf={asOf} onAdd={readOnly ? undefined : () => onOpen('transaction')} onTransaction={readOnly ? undefined : setTransactionId} returnFocusTo={calendarFocusId} onFocusReturned={() => setCalendarFocusId(null)}/>
    </details>
    </HomeNextUp>
    <div className="home-actions" role="group" aria-label="Home quick actions">
      <button type="button" className="home-action" onClick={() => readOnly ? onNavigate('expenses', 'activity') : onOpen('transaction')}>
        <span className="home-action-icon"><Icon name={readOnly ? 'wallet' : 'plus'} size={18}/></span><span><strong>{readOnly ? 'Recent transactions' : 'Record spending'}</strong><small>{readOnly ? 'Review saved activity' : 'Add a transaction'}</small></span><Icon name="arrow" size={15}/>
      </button>
      <button type="button" className="home-action" aria-controls={`${id}-accounts`} onClick={() => revealSection(accountsDetails.current)}>
        <span className="home-action-icon"><Icon name="wallet" size={18}/></span><span><strong>Review balances</strong><small>{cashAccounts.length ? `${cashAccounts.length} cash ${cashAccounts.length === 1 ? 'account' : 'accounts'}` : 'Set up your accounts'}</small></span><Icon name="arrow" size={15}/>
      </button>
      <button type="button" className="home-action" onClick={() => onNavigate('expenses', 'schedule')}>
        <span className="home-action-icon"><Icon name="plan" size={18}/></span><span><strong>Manage payments</strong><small>Bills and pay dates</small></span><Icon name="arrow" size={15}/>
      </button>
      <button type="button" className="home-action" aria-controls={`${id}-calendar`} onClick={() => revealSection(calendarDetails.current)}>
        <span className="home-action-icon"><Icon name="activity" size={18}/></span><span><strong>Explore spending</strong><small>See transactions by day</small></span><Icon name="arrow" size={15}/>
      </button>
    </div>
    {!readOnly && onBackups && <HomeBackupStatus onOpen={onBackups}/>}
    {!readOnly && selectedTransaction && <Suspense fallback={<p role="status">Opening transaction…</p>}><TransactionEditor key={selectedTransaction.id} state={state} transaction={selectedTransaction} onCommand={onCommand} onClose={() => { setCalendarFocusId(selectedTransaction.id); setTransactionId(null); }}/></Suspense>}
  </div>;
}
