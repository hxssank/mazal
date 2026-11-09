import { useEffect, useId, useState } from 'react';
import type { AccountType, AppState, Command } from '../../../shared/types';
import { money } from '../../../shared/analytics';
import Icon from '../../components/Icon';
import { useEngineDate, useEngineSummary } from '../../services/useEngine';
import EngineStatus from '../../components/EngineStatus';
import InvestmentAccounts from './InvestmentAccounts';
import InvestmentHistory from './InvestmentHistory';
import AnimatedValue from '../../components/AnimatedValue.tsx';
import '../../styles/portfolio.css';
import './investment-accounts.css';
import '../../styles/holdings-review.css';
import './organized-investments.css';

interface Props {
  state: AppState;
  readOnly: boolean;
  initialSection?: 'accounts';
  onSectionChange?: (section?: 'accounts') => void;
  onCommand: (command:Command) => Promise<void>;
  onAddAccount: (accountType?: AccountType) => void;
  onOpen: (kind: 'account' | 'sol' | 'reward' | 'reconcile', accountId?: string, positionId?: string) => void;
}
const solAmount = (value: string | number) => Number(value).toLocaleString('en-CA', { maximumFractionDigits: 9 });
const recordedDate = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });

export default function Investments({ state, readOnly, initialSection, onSectionChange, onOpen, onAddAccount, onCommand }: Props) {
  const [section, setSection] = useState<'investments' | 'accounts'>(initialSection ?? 'investments');
  const [allocation, setAllocation] = useState<'sol' | 'other'>('sol');
  const id = useId();
  useEffect(() => { setSection(initialSection ?? 'investments'); }, [initialSection]);
  function chooseSection(value: 'investments' | 'accounts') { if(onSectionChange)onSectionChange(value==='accounts'?'accounts':undefined);else setSection(value); }
  const entityId = state.entities.find(entity => entity.kind === 'personal')?.id;
  const accounts = state.accounts.filter(account => account.type === 'investment' && account.entityId === entityId);
  const cashAccounts = state.accounts.filter(account => ['cash', 'receivable'].includes(account.type) && account.entityId === entityId);
  const positions = state.positions.filter(position => accounts.some(account => account.id === position.accountId));
  const solAccounts = accounts.filter(account => positions.some(position => position.accountId === account.id));
  const otherAccounts = accounts.filter(account => !positions.some(position => position.accountId === account.id));
  const asOf = useEngineDate();
  const engine = useEngineSummary(state, entityId ?? '', asOf);
  const summary = engine.data?.summary;
  const breakdown = engine.data?.investmentBreakdown;
  const calculationLabel = engine.loading ? 'Calculating…' : 'Unavailable';
  const activePositions = positions.filter(position => !accounts.find(account => account.id === position.accountId)?.closedAt);
  const activeOtherAccounts = otherAccounts.filter(account => !account.closedAt);
  const uncheckedAccounts = activeOtherAccounts.filter(account => !account.reconciledAt);
  const priceDates = activePositions.map(position => position.priceDate).sort();
  const earliestPrice = priceDates[0];
  const savedPriceAge = earliestPrice ? Math.round((Date.parse(`${asOf}T12:00:00Z`) - Date.parse(`${earliestPrice.slice(0,10)}T12:00:00Z`)) / 86_400_000) : null;
  const selectedAllocation = positions.length && (!otherAccounts.length || allocation === 'sol') ? 'sol' : 'other';
  const allocationTotal = breakdown ? breakdown.solValueCents + breakdown.otherValueCents : 0;
  const comparable = !!breakdown && breakdown.solValueCents >= 0 && breakdown.otherValueCents >= 0 && allocationTotal > 0;
  const solShare = comparable ? breakdown!.solValueCents / allocationTotal * 100 : 0;
  const otherShare = comparable ? breakdown!.otherValueCents / allocationTotal * 100 : 0;
  function reviewHoldings(kind: 'sol' | 'other' = selectedAllocation) {
    const target = document.getElementById(`${id}-${kind}-holdings`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  return <div className="portfolio-page investments-page">
    <div className="investment-section-navigation">
      <div className="period-control investment-section-tabs" role="tablist" aria-label="Investments section">
        {(['investments', 'accounts'] as const).map(value => <button type="button" key={value} role="tab" id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} aria-selected={section === value} tabIndex={section === value ? 0 : -1} onClick={() => chooseSection(value)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'investments' : event.key === 'End' ? 'accounts' : value === 'investments' ? 'accounts' : 'investments';
          chooseSection(next);
          document.getElementById(`${id}-${next}-tab`)?.focus();
        }}>{value === 'investments' ? 'Investments' : 'Accounts'}<span>{value === 'investments' ? accounts.length : cashAccounts.length}</span></button>)}
      </div>
      {section === 'accounts' && !readOnly && <button type="button" className="button primary" onClick={() => onAddAccount('cash')}><Icon name="plus" size={16}/>Add account</button>}
    </div>
    <div id={`${id}-investments-panel`} hidden={section !== 'investments'} role="tabpanel" aria-labelledby={`${id}-investments-tab`} tabIndex={0} className="investment-tab-panel">
    {accounts.length > 0 && <section className="portfolio-total-bar panel holdings-review-panel investment-allocation-review" aria-label="Investment totals" data-motion-enter>
      <EngineStatus {...engine}/>
      <div className="holdings-review-heading"><div className="holdings-review-total"><span>Total investments</span><strong>{summary ? <AnimatedValue value={summary.investmentsCents}/> : calculationLabel}</strong></div><div className="holdings-review-source"><span className="holdings-review-kicker">Recorded values</span><p>Manually entered balances and prices.</p></div></div>
      {comparable && <div className="investment-allocation-glance" aria-label="Recorded investment mix">
        <div className="holdings-allocation-rail" role="img" aria-label={`SOL ${solShare.toLocaleString('en-CA',{maximumFractionDigits:1})}%, other investments ${otherShare.toLocaleString('en-CA',{maximumFractionDigits:1})}%`}><span className="is-sol is-selected" style={{ width: `${solShare}%` }}/><span className="is-other is-selected" style={{ width: `${otherShare}%` }}/></div>
        <div className="investment-allocation-caption"><span><i/>SOL<strong>{solShare.toLocaleString('en-CA',{maximumFractionDigits:1})}%</strong></span><span><i/>Other investments<strong>{otherShare.toLocaleString('en-CA',{maximumFractionDigits:1})}%</strong></span></div>
      </div>}
      {earliestPrice && <div className="investment-price-context"><span className="investment-price-icon"><Icon name="clock" size={18}/></span><div><strong>Oldest saved SOL price · {recordedDate(earliestPrice)}</strong><p>{savedPriceAge===0 ? 'Price dated today. Values change when you save a new price.' : savedPriceAge!==null&&savedPriceAge>0 ? `${savedPriceAge} ${savedPriceAge===1?'day':'days'} old. Each holding uses its saved price. Review prices before using the total.` : 'Price is dated ahead of today. Check the saved date.'}</p></div><button type="button" className="text-button" onClick={()=>reviewHoldings('sol')}>Review prices<Icon name="arrow" size={15}/></button></div>}
      {uncheckedAccounts.length > 0 && <div className="holdings-balance-check"><Icon name="info" size={16}/><span>{uncheckedAccounts.length} {uncheckedAccounts.length === 1 ? 'balance has' : 'balances have'} no recorded check</span><button type="button" className="text-button" onClick={() => reviewHoldings('other')}>Check balances<Icon name="arrow" size={15}/></button></div>}
      <details className="holdings-allocation-disclosure"><summary><span>Allocation breakdown</span><Icon name="down" size={16}/></summary>
      <div className="holdings-allocation-options" role="group" aria-label="Investment allocation">
        {(['sol', 'other'] as const).map(kind => <button type="button" key={kind} className={`holdings-allocation-option is-${kind}`} aria-pressed={selectedAllocation === kind} disabled={kind === 'sol' ? !positions.length : !otherAccounts.length} onClick={() => setAllocation(kind)}><span><i/>{kind === 'sol' ? 'SOL accounts' : 'Other investments'}{comparable && <small>{(kind === 'sol' ? solShare : otherShare).toLocaleString('en-CA', { maximumFractionDigits: 1 })}%</small>}</span><strong>{!(kind === 'sol' ? solAccounts.length : otherAccounts.length) ? 'Not recorded' : breakdown ? money(kind === 'sol' ? breakdown.solValueCents : breakdown.otherValueCents) : calculationLabel}</strong><small>{kind === 'sol' ? solAccounts.length : otherAccounts.length} recorded {(kind === 'sol' ? solAccounts.length : otherAccounts.length) === 1 ? 'account' : 'accounts'}</small></button>)}
      </div>
      <div className="holdings-review-next" aria-live="polite"><div><strong>{selectedAllocation === 'sol' ? earliestPrice ? `Earliest saved price: ${recordedDate(earliestPrice)}` : 'No active SOL positions' : activeOtherAccounts.length ? 'Recorded account balances' : 'No active accounts in this group'}</strong><p>{selectedAllocation === 'sol' ? 'Use each wallet or exchange record to check quantities and the saved CAD price.' : 'Compare the recorded amounts with your account statements.'}</p></div><button type="button" className="text-button" onClick={() => reviewHoldings()}>{selectedAllocation === 'sol' ? 'Review SOL records' : 'Review account balances'}<Icon name="arrow" size={16}/></button></div>
      </details>
    </section>}

    {accounts.length === 0 ? <section className="portfolio-empty panel portfolio-investment-empty"><h2>No investment accounts</h2><p>Add a brokerage or wallet account with its current balance.</p>{!readOnly && <button type="button" className="button primary" onClick={() => onAddAccount('investment')}><Icon name="plus" size={16}/>Add account</button>}</section> : <div className={`portfolio-holdings-grid${positions.length ? '' : ' single-holding-group'}`}>
    {positions.length > 0 && <section className="portfolio-section holdings-detail-section" id={`${id}-sol-holdings`} tabIndex={-1} aria-labelledby="sol-heading" data-motion-enter>
      <div className="portfolio-section-heading"><div><h2 id="sol-heading">Solana</h2></div>{!readOnly && accounts.some(account => !account.closedAt) && <button type="button" className="button primary" onClick={() => onOpen('sol')}><Icon name="plus" size={16}/>{positions.length ? 'Update SOL' : 'Add SOL'}</button>}</div>
      <div className="portfolio-sol-grid">{positions.map(position => {
        const account = accounts.find(item => item.id === position.accountId)!;
        const totals = breakdown?.positions[position.id];
        const totalSol = totals?.totalSol;
        const stakedFraction = totals?.stakedPercent;
        const difference = totals?.valueLessCostCents;
        return <article className="panel portfolio-sol-card" key={position.id}>
          <div className="portfolio-card-heading"><span className="portfolio-token"><SolMark/></span><div><h3>{account.name}{account.closedAt ? ' · Closed' : ''}</h3></div>{!readOnly && !account.closedAt && <button type="button" className="button secondary compact" onClick={() => onOpen('sol', account.id, position.id)}>Update SOL</button>}</div>
          <div className="portfolio-sol-balance"><strong><AnimatedValue value={account.balanceCents}/></strong><span>{totalSol === undefined ? calculationLabel : solAmount(totalSol)} SOL at {money(position.priceCents)} per SOL</span><small>Price as of {recordedDate(position.priceDate)}</small></div>
          {stakedFraction !== undefined && <div className="portfolio-stake-bar" role="img" aria-label={`${solAmount(position.stakedSol)} SOL staked, ${solAmount(position.liquidSol)} SOL unstaked`}><span style={{ width: `${stakedFraction}%` }}/></div>}
          <div className="portfolio-stake-labels"><span><i/>Staked <strong>{solAmount(position.stakedSol)} SOL</strong></span><span><i/>Unstaked <strong>{solAmount(position.liquidSol)} SOL</strong></span></div>
          <dl className="portfolio-position-details"><div><dt>Remaining recorded cost</dt><dd>{money(position.costBasisCents)}</dd></div><div><dt>Value less recorded cost</dt><dd className={difference !== undefined && difference < 0 ? 'negative' : difference !== undefined && difference > 0 ? 'positive' : ''}>{difference !== undefined && difference > 0 ? '+' : ''}{difference === undefined ? calculationLabel : money(difference)}</dd></div><div><dt>Rewards recorded</dt><dd>{solAmount(position.rewardsSol)} SOL</dd></div></dl>
          <div className="portfolio-position-footer"><span>Rewards are added to staked SOL.</span>{!readOnly && !account.closedAt && <button type="button" className="text-button" onClick={() => onOpen('reward', account.id, position.id)}>Add reward <Icon name="plus" size={14}/></button>}</div>
          <InvestmentHistory state={state} position={position} readOnly={readOnly || !!account.closedAt} onCommand={onCommand}/>
        </article>;
      })}</div>
    </section>}

    <section className="portfolio-section holdings-detail-section" id={`${id}-other-holdings`} tabIndex={-1} aria-labelledby="other-investments-heading" data-motion-enter>
      <div className="portfolio-section-heading"><div><h2 id="other-investments-heading">{positions.length ? 'Other investments' : 'Investment accounts'}</h2></div>{!readOnly && <button type="button" className="button secondary" onClick={() => onAddAccount('investment')}><Icon name="plus" size={16}/>Add account</button>}</div>
      <div className="panel portfolio-account-list">{otherAccounts.length === 0 ? <p className="portfolio-empty-line">No other investment accounts.</p> : otherAccounts.map(account => <div className="portfolio-account-row" key={account.id}><span className="portfolio-row-icon"><Icon name="invest"/></span><div><h3>{account.name}{account.closedAt ? ' · Closed' : ''}</h3><small>{account.reconciledAt ? `Checked ${recordedDate(account.reconciledAt)}` : 'Balance not checked'}</small></div><strong>{money(account.balanceCents)}</strong>{!readOnly && !account.closedAt && <button type="button" className="button secondary compact" onClick={() => onOpen('reconcile', account.id)}>Update value</button>}</div>)}</div>
    </section>
    </div>}
    {accounts.some(account => !account.closedAt) && positions.length === 0 && !readOnly && <details className="holdings-add-sol"><summary><span>Add a Solana holding</span><Icon name="down" size={16}/></summary><div><p>Record SOL quantities and a CAD price in an investment account.</p><button type="button" className="button secondary" onClick={() => onOpen('sol')}><Icon name="plus" size={16}/>Add SOL</button></div></details>}

    </div>
    <section id={`${id}-accounts-panel`} hidden={section !== 'accounts'} role="tabpanel" aria-labelledby={`${id}-accounts-tab`} tabIndex={0} className="investment-tab-panel">
      <InvestmentAccounts onCommand={onCommand} state={state} readOnly={readOnly} onAddAccount={onAddAccount} onOpen={onOpen}/>
    </section>
  </div>;
}

function SolMark() {
  return <svg width="28" height="26" viewBox="0 0 28 26" fill="none" aria-hidden="true"><path d="M6 4h20l-4 4H2l4-4Z" fill="currentColor" opacity=".95"/><path d="M2 11h20l4 4H6l-4-4Z" fill="currentColor" opacity=".72"/><path d="M6 18h20l-4 4H2l4-4Z" fill="currentColor" opacity=".5"/></svg>;
}
