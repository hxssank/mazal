import { useEffect, useId, useRef, useState } from 'react';
import type { AppState, Command, TrackedAsset } from '../../../shared/types';
import { money } from '../../../shared/analytics';
import { owedRemaining } from '../../../shared/asset-planning.ts';
import Icon from '../../components/Icon';
import AssetPurchases from './AssetPurchases';
import AssetPlanning from './AssetPlanning';
import AssetEditor from './AssetEditor';
import AnimatedValue from '../../components/AnimatedValue.tsx';
import '../../styles/portfolio.css';
import './assets-refresh.css';
import '../../styles/holdings-review.css';
import '../../styles/organized-accounts.css';

interface Props {
  state: AppState;
  readOnly: boolean;
  onCommand: (command: Command) => Promise<void>;
  onOpen: (kind: 'account' | 'reconcile', accountId?: string) => void;
}
type AssetFilter = 'all' | TrackedAsset['status'];
type AssetSort = 'recent' | 'value' | 'name';
type RecordFilter = 'all' | 'estimate' | 'cost';
const shortDate = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
const profit = (asset: TrackedAsset) => asset.costCents === null ? null : (asset.saleCents ?? 0) - asset.costCents - asset.feesCents;
const statusLabels = { all: 'All items', owned: 'Owned', listed: 'For sale', sold: 'Sold' } as const;

export default function Assets({ state, readOnly, onCommand, onOpen }: Props) {
  const id = useId();
  const [requestedId] = useState(() => new URLSearchParams(window.location.hash.split('?')[1]).get('record'));
  const [filter, setFilter] = useState<AssetFilter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<AssetSort>('recent');
  const [recordFilter, setRecordFilter] = useState<RecordFilter>('all');
  const [category, setCategory] = useState('');
  const allItems = useRef<HTMLButtonElement>(null);
  const [editor, setEditor] = useState<{ asset: TrackedAsset | null; sale?: boolean } | null>(null);
  useEffect(() => { if (readOnly) setEditor(null); }, [readOnly]);
  const entityId = state.entities.find(entity => entity.kind === 'personal')?.id;
  const purchases = (state.assetPurchases ?? []).filter(purchase => purchase.entityId === entityId);
  const items = (state.assets ?? []).filter(asset => asset.entityId === entityId);
  const wishes = (state.wishItems ?? []).filter(item => item.entityId === entityId);
  const owed = (state.moneyOwed ?? []).filter(item => item.entityId === entityId);
  const totalOwed = owed.reduce((sum, item) => sum + owedRemaining(item), 0);
  const plannedCost = wishes.reduce((sum, item) => sum + (item.costCents ?? 0), 0);
  const unknownPrices = wishes.filter(item => item.costCents === null).length;
  const unknownPayments = purchases.filter(item => item.paidCents === null).length;
  const [owedOpen, setOwedOpen] = useState(() => owed.some(item => item.id === requestedId));
  const [prioritiesOpen, setPrioritiesOpen] = useState(() => wishes.some(item => item.id === requestedId));
  const [purchasesOpen, setPurchasesOpen] = useState(() => purchases.some(item => item.id === requestedId));
  const owned = items.filter(asset => asset.status === 'owned');
  const listed = items.filter(asset => asset.status === 'listed');
  const held = items.filter(asset => asset.status !== 'sold');
  const sold = items.filter(asset => asset.status === 'sold');
  const valued = held.filter(asset => asset.estimatedValueCents !== null);
  const estimatedValue = valued.reduce((sum, asset) => sum + (asset.estimatedValueCents ?? 0), 0);
  const costed = held.filter(asset => asset.costCents !== null);
  const heldCost = costed.reduce((sum, asset) => sum + (asset.costCents ?? 0), 0);
  const knownSales = sold.filter(asset => asset.costCents !== null);
  const realizedProfit = knownSales.reduce((sum, asset) => sum + (profit(asset) ?? 0), 0);
  const saleProceeds = sold.reduce((sum, asset) => sum + (asset.saleCents ?? 0), 0);
  const missingEstimates = held.filter(asset => asset.estimatedValueCents === null);
  const missingCosts = items.filter(asset => asset.costCents === null);
  const categories = [...new Set(items.map(asset => asset.category))].sort((a, b) => a.localeCompare(b));
  const selectedCategory = categories.includes(category) ? category : '';
  const query = search.trim().toLowerCase();
  const visible = items.filter(asset => (filter === 'all' || asset.status === filter) && (!selectedCategory || asset.category === selectedCategory) && (recordFilter === 'all' || recordFilter === 'estimate' && asset.status !== 'sold' && asset.estimatedValueCents === null || recordFilter === 'cost' && asset.costCents === null) && `${asset.name} ${asset.category} ${asset.notes}`.toLowerCase().includes(query))
    .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'value' ? (b.status === 'sold' ? b.saleCents ?? -1 : b.estimatedValueCents ?? -1) - (a.status === 'sold' ? a.saleCents ?? -1 : a.estimatedValueCents ?? -1) : (b.soldDate ?? b.purchaseDate ?? '').localeCompare(a.soldDate ?? a.purchaseDate ?? '') || a.name.localeCompare(b.name));
  const counts = { all: items.length, owned: owned.length, listed: listed.length, sold: sold.length };
  function chooseRecordFilter(next: RecordFilter) { setRecordFilter(recordFilter === next ? 'all' : next); setFilter('all'); setSearch(''); setCategory(''); }
  function clearFilters() { setFilter('all'); setSearch(''); setRecordFilter('all'); setCategory(''); allItems.current?.focus(); }
  function revealPlanning(section: 'owed' | 'priorities') {
    if (section === 'owed') setOwedOpen(true); else setPrioritiesOpen(true);
    window.requestAnimationFrame(() => {
      const summary = document.getElementById(`${id}-${section}`)?.querySelector('summary');
      summary?.focus({ preventScroll: true });
      summary?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
  }
  return <div className="portfolio-page assets-page">
    <section className="assets-at-a-glance" aria-label="Assets at a glance" data-motion-enter>
      <div className="assets-glance-value"><span><Icon name="devices" size={17}/>Recorded resale value</span><strong>{valued.length ? <AnimatedValue value={estimatedValue}/> : 'Not recorded'}</strong><p>{held.length ? `${valued.length} of ${held.length} held items valued. Estimates before selling fees.` : 'Add the items you own and their resale estimates.'}</p></div>
      <button type="button" className="assets-glance-action" onClick={() => revealPlanning('owed')} aria-controls={`${id}-owed`}><span><Icon name="coins" size={17}/>Money owed to you<Icon name="arrow" size={15}/></span><strong><AnimatedValue value={totalOwed}/></strong><small>{owed.length ? 'Recorded repayments reduce this balance.' : 'Track money lent and repayments received.'}</small></button>
      <button type="button" className="assets-glance-action" onClick={() => revealPlanning('priorities')} aria-controls={`${id}-priorities`}><span><Icon name="plan" size={17}/>Purchase priorities<Icon name="arrow" size={15}/></span><strong>{wishes.length && unknownPrices === wishes.length ? 'Prices needed' : <AnimatedValue value={plannedCost}/>}</strong><small>{wishes.length ? `${wishes.length} planned ${wishes.length === 1 ? 'purchase' : 'purchases'}${unknownPrices ? ` · ${unknownPrices} ${unknownPrices === 1 ? 'price' : 'prices'} missing` : ' · saved prices'}` : 'Rank purchases before committing cash.'}</small></button>
    </section>
    <section className="portfolio-section assets-inventory" aria-label="Physical items" data-motion-enter>
      <div className="assets-items-heading"><div><h2>My items</h2><p>{held.length} {held.length === 1 ? 'item' : 'items'} owned{listed.length ? ` · ${listed.length} for sale` : ''}{sold.length ? ` · ${sold.length} sold` : ''}</p></div>{!readOnly && <button type="button" className="button secondary" onClick={() => setEditor({ asset: null })}><Icon name="plus" size={16}/>Add item</button>}</div>
      {items.length > 0 && <section className="holdings-item-review" aria-label="Review item records">
        <div className="holdings-coverage"><span>Resale estimates recorded</span><strong>{valued.length}<small> / {held.length} held {held.length === 1 ? 'item' : 'items'}</small></strong><div className="holdings-coverage-rail" aria-hidden="true"><span style={{ width: `${held.length ? valued.length / held.length * 100 : 0}%` }}/></div><p>{held.length ? 'Unvalued items do not contribute to net worth.' : 'Sold items remain in your sale history.'}</p></div>
        {(missingEstimates.length > 0 || recordFilter === 'estimate') && <button type="button" className="holdings-review-action" aria-pressed={recordFilter === 'estimate'} onClick={() => chooseRecordFilter('estimate')}><span>Missing estimates<Icon name="arrow" size={16}/></span><strong>{missingEstimates.length}</strong><small>{missingEstimates.length ? 'Review resale values' : 'All held items have an estimate'}</small></button>}
        {(missingCosts.length > 0 || recordFilter === 'cost') && <button type="button" className="holdings-review-action" aria-pressed={recordFilter === 'cost'} onClick={() => chooseRecordFilter('cost')}><span>Missing purchase costs<Icon name="arrow" size={16}/></span><strong>{missingCosts.length}</strong><small>{missingCosts.length ? 'Needed to calculate gain or loss' : 'All purchase costs recorded'}</small></button>}
      </section>}
      {(valued.length > 0 || held.length > 1 || sold.length > 0) && <div className="assets-inventory-totals" aria-label="Physical asset totals">
        {held.length > 0 && <><div><span>Purchase cost</span><strong>{costed.length ? money(heldCost) : 'Not confirmed'}</strong>{costed.length < held.length && <small>{costed.length} of {held.length} costs recorded</small>}</div><div><span>Resale estimates</span><strong className="assets-primary-value">{valued.length ? money(estimatedValue) : 'Not confirmed'}</strong><small>{valued.length} of {held.length} {held.length === 1 ? 'item valued' : 'items valued'} · before fees</small></div></>}
        {sold.length > 0 && <div><span>{sold.length} completed {sold.length === 1 ? 'sale' : 'sales'}</span><strong className={realizedProfit < 0 ? 'negative' : ''}>{realizedProfit > 0 ? '+' : ''}{knownSales.length ? money(realizedProfit) : 'Not confirmed'}</strong><small>Gain or loss after fees · proceeds {money(saleProceeds)}{knownSales.length < sold.length ? ` · ${knownSales.length} of ${sold.length} costs recorded` : ''}</small></div>}
      </div>}
      {items.length > 0 && <div className="assets-inventory-controls">
        <div className="portfolio-status-filters" aria-label="Filter physical assets">{(['all', 'owned', 'listed', 'sold'] as AssetFilter[]).map(status => <button type="button" key={status} ref={status === 'all' ? allItems : undefined} aria-pressed={filter === status} className={filter === status ? 'active' : ''} onClick={() => { setFilter(status); setRecordFilter('all'); }}>{statusLabels[status]}<span>{counts[status]}</span></button>)}</div>
        <div className="assets-find-controls"><label className="portfolio-search"><Icon name="search" size={16}/><input aria-label="Search physical assets" placeholder="Search items" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button type="button" aria-label="Clear item search" onClick={() => setSearch('')}><Icon name="close" size={14}/></button>}</label><label className="assets-sort"><select aria-label="Sort items" value={sort} onChange={event => setSort(event.target.value as AssetSort)}><option value="recent">Most recent</option><option value="value">Highest value</option><option value="name">Name A to Z</option></select></label></div>
      </div>}
      {categories.length > 1 && <div className="holdings-category-filter"><label>Category<select aria-label="Filter item category" value={selectedCategory} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{categories.map(name => <option key={name} value={name}>{name}</option>)}</select></label><span>{categories.length} categories in your inventory</span></div>}
      {items.length > 0 && (query || filter !== 'all' || selectedCategory || recordFilter !== 'all') && <p className="assets-results" aria-live="polite">{visible.length} {visible.length === 1 ? 'item' : 'items'}{recordFilter === 'estimate' ? ' missing a resale estimate' : recordFilter === 'cost' ? ' missing a purchase cost' : ''}{selectedCategory ? ` in ${selectedCategory}` : ''}{query ? ` matching "${search.trim()}"` : ''}<button type="button" className="text-button" onClick={clearFilters}>Show all items</button></p>}
      {visible.length === 0 ? <p className="assets-empty-line">{items.length ? 'No matching items.' : 'No owned items recorded.'}</p> : <div className="portfolio-assets-grid">{visible.map(asset => {
        const realized = asset.status === 'sold';
        const difference = realized ? profit(asset) : asset.estimatedValueCents === null || asset.costCents === null ? null : asset.estimatedValueCents - asset.costCents - asset.feesCents;
        return <article className={`panel portfolio-asset-card assets-item-${asset.status}`} key={asset.id} data-motion-enter>
          <div className="assets-item-visual"><span className="portfolio-device"><AssetGlyph category={`${asset.category} ${asset.name}`}/></span><span className={`portfolio-status ${asset.status}`}>{statusLabels[asset.status]}</span><span className="assets-item-category">{asset.category}</span></div>
          <div className="assets-item-content"><div className="portfolio-asset-title"><h3>{asset.name}</h3><small>{realized && asset.soldDate ? `Sold ${shortDate(asset.soldDate)}` : asset.purchaseDate ? `Bought ${shortDate(asset.purchaseDate)}` : 'Purchase date not entered'}</small></div>
          <div className="portfolio-asset-value"><span>{realized ? 'Sale price' : 'Purchase cost'}</span><strong>{realized ? money(asset.saleCents ?? 0) : asset.costCents === null ? 'Not confirmed' : money(asset.costCents)}</strong></div>
          <dl className="portfolio-asset-numbers">{realized ? <div><dt>Purchase cost</dt><dd>{asset.costCents === null ? 'Not confirmed' : money(asset.costCents)}</dd></div> : <div><dt>Resale estimate</dt><dd className={asset.estimatedValueCents === null ? 'assets-value-unknown' : ''}>{asset.estimatedValueCents === null ? 'Not confirmed' : money(asset.estimatedValueCents)}</dd></div>}{asset.feesCents > 0 && <div><dt>Recorded fees</dt><dd>{money(asset.feesCents)}</dd></div>}{difference !== null && <div className="assets-item-result"><dt>{realized ? 'Gain or loss after fees' : 'Estimated gain or loss'}</dt><dd className={difference < 0 ? 'negative' : difference > 0 ? 'positive' : ''}>{difference > 0 ? '+' : ''}{money(difference)}</dd></div>}</dl>
          {!realized && asset.estimatedValueCents === null && <p className="assets-value-note">Add a resale estimate to include this item in net worth.</p>}
          {(asset.notes || realized) && <details className="portfolio-asset-details"><summary>{realized ? 'Sale details' : 'Notes'}</summary>{realized && <dl><div><dt>Bought</dt><dd>{asset.purchaseDate ? shortDate(asset.purchaseDate) : 'Date not entered'}</dd></div>{asset.soldDate && <div><dt>Sold</dt><dd>{shortDate(asset.soldDate)}</dd></div>}</dl>}{asset.notes && <p>{asset.notes}</p>}</details>}
          {!readOnly && <div className="portfolio-asset-actions"><button type="button" className="button secondary compact" onClick={() => setEditor({ asset })}>Edit item</button>{!realized && <button type="button" className="text-button" onClick={() => setEditor({ asset, sale: true })}>Record sale <Icon name="arrow" size={14}/></button>}</div>}</div>
        </article>;
      })}</div>}
      
    </section>
    <div className="asset-planning-disclosures" aria-label="Asset planning">
      <details id={`${id}-owed`} className="account-disclosure" open={owedOpen} onToggle={event => setOwedOpen(event.currentTarget.open)} data-motion-enter>
        <summary><span><strong>Money owed to me</strong><small>{owed.length ? `${money(totalOwed)} remaining across ${owed.length} ${owed.length === 1 ? 'person' : 'people'}` : 'Track repayments from people who owe you'}</small></span><Icon name="down" size={18}/></summary>
        <div className="account-disclosure-content"><AssetPlanning state={state} readOnly={readOnly} onCommand={onCommand} section="owed"/></div>
      </details>
      <details id={`${id}-priorities`} className="account-disclosure" open={prioritiesOpen} onToggle={event => setPrioritiesOpen(event.currentTarget.open)} data-motion-enter>
        <summary><span><strong>Purchase priorities</strong><small>{wishes.length ? `${wishes.length} planned ${wishes.length === 1 ? 'purchase' : 'purchases'}` : 'Save and rank things you want to buy'}{unknownPrices > 0 && <span className="account-disclosure-warning"> · {unknownPrices} {unknownPrices === 1 ? 'price' : 'prices'} needed</span>}</small></span><Icon name="down" size={18}/></summary>
        <div className="account-disclosure-content"><AssetPlanning state={state} readOnly={readOnly} onCommand={onCommand} section="priorities"/></div>
      </details>
      <details className="account-disclosure" open={purchasesOpen} onToggle={event => setPurchasesOpen(event.currentTarget.open)} data-motion-enter>
        <summary><span><strong>Purchases in progress</strong><small>{purchases.length ? `${purchases.length} ${purchases.length === 1 ? 'purchase' : 'purchases'} with recorded payment terms` : 'Track payments toward a purchase'}{unknownPayments > 0 && <span className="account-disclosure-warning"> · Confirm amount paid for {unknownPayments}</span>}</small></span><Icon name="down" size={18}/></summary>
        <div className="account-disclosure-content"><AssetPurchases state={state} purchases={purchases} readOnly={readOnly} onCommand={onCommand} onAddAccount={() => onOpen('account')}/></div>
      </details>
    </div>
    {!readOnly && editor && <AssetEditor key={`${editor.asset?.id ?? 'new'}-${editor.sale ? 'sale' : 'edit'}`} asset={editor.asset} recordSale={editor.sale ?? false} state={state} onCommand={onCommand} onClose={() => setEditor(null)}/>}
  </div>;
}

function AssetGlyph({ category }: { category: string }) {
  const key = category.toLowerCase();
  const path = /printer|bambu|p2s/.test(key) ? 'M9 7h30v35H9V7Zm0 8h30M14 20h20v17H14V20Zm0 12h20M21 15v7h6v-7M24 22v4M28 7V3h9v4M33 11h2'
    : /phone|iphone|pixel|mobile/.test(key) ? 'M15 5h18v38H15V5Zm5 4h8m-6 29h4'
    : /computer|laptop|macbook|monitor/.test(key) ? 'M8 9h32v24H8V9ZM4 38h40l-4-5H8l-4 5Zm15 0h10'
      : /audio|headphone|speaker|airpod/.test(key) ? 'M10 28v-6a14 14 0 0 1 28 0v6M10 24H6v14h8V24h-4Zm28 0h4v14h-8V24h4Z'
        : /camera|lens/.test(key) ? 'M7 14h10l3-5h8l3 5h10v25H7V14Zm17 5a8 8 0 1 0 0 16 8 8 0 0 0 0-16m10-1h3'
          : /gaming|console|playstation|xbox/.test(key) ? 'M13 15h22l7 19-5 5-9-8h-8l-9 8-5-5 7-19Zm1 6v9m-4-5h8m13-4h1m4 5h1'
            : /vehicle|car|bmw/.test(key) ? 'M8 22l5-10h22l5 10M5 22h38v16H5V22Zm4 16v5m30-5v5M11 28h5m16 0h5'
              : 'M8 14l16-8 16 8v22l-16 8-16-8V14Zm0 0 16 8 16-8M24 22v22';
  return <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>;
}
