import type { SolActivityKind, SolHistoryEntry, SolPosition, SolSnapshot } from './types.ts';

const SCALE = 1_000_000_000n;
const MAX_CENTS = 100_000_000_000_000;

export function solLamports(value:string):bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(value)) throw new Error('SOL must be nonnegative with at most 9 decimals.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * SCALE + BigInt(fraction.padEnd(9, '0'));
  if (amount > 1_000_000_000n * SCALE) throw new Error('SOL exceeds the supported quantity.');
  return amount;
}

export function solQuantity(value:bigint):string {
  if (value < 0n) throw new Error('SOL cannot be negative.');
  const fraction = (value % SCALE).toString().padStart(9, '0').replace(/0+$/, '');
  return `${value / SCALE}${fraction ? `.${fraction}` : ''}`;
}

function cents(value:number):number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) throw new Error('SOL amounts must be whole cents within the supported balance.');
  return value;
}

export function solMarketValue(position:Pick<SolSnapshot,'liquidSol'|'stakedSol'|'priceCents'>):number {
  const value = (solLamports(position.liquidSol) + solLamports(position.stakedSol)) * BigInt(cents(position.priceCents));
  return cents(Number((value + SCALE / 2n) / SCALE));
}

export function solSnapshot(position:SolSnapshot):SolSnapshot {
  return { liquidSol:position.liquidSol, stakedSol:position.stakedSol, rewardsSol:position.rewardsSol, costBasisCents:position.costBasisCents, priceCents:position.priceCents, priceDate:position.priceDate };
}

export function calculateSolActivity(position:SolSnapshot, activity:{kind:SolActivityKind; quantitySol:string; feeCents:number}):{snapshot:SolSnapshot; amountCents:number; feeCents:number; cashDeltaCents:number} {
  const quantity = solLamports(activity.quantitySol);
  const liquid = solLamports(position.liquidSol);
  const staked = solLamports(position.stakedSol);
  const total = liquid + staked;
  const feeCents = cents(activity.feeCents);
  const snapshot = solSnapshot(position);
  let amountCents = cents(Number((quantity * BigInt(cents(position.priceCents)) + SCALE / 2n) / SCALE));
  let cashDeltaCents = 0;
  if (activity.kind === 'fee') {
    if (quantity !== 0n || !feeCents) throw new Error('A CAD fee needs an amount greater than zero and no SOL quantity.');
    amountCents = 0;
    cashDeltaCents = -feeCents;
  } else {
    if (!quantity) throw new Error('Enter a SOL quantity greater than zero.');
    if (activity.kind === 'buy') {
      if (!amountCents) throw new Error('Purchase value must be at least one cent.');
      snapshot.liquidSol = solQuantity(liquid + quantity);
      snapshot.costBasisCents = cents(position.costBasisCents + amountCents + feeCents);
      cashDeltaCents = -(amountCents + feeCents);
    } else if (activity.kind === 'sell') {
      if (quantity > liquid) throw new Error('This sale exceeds unstaked SOL. Update the staked and unstaked quantities first.');
      if (!amountCents || feeCents > amountCents) throw new Error('Sale value must be positive and cover the fee.');
      snapshot.liquidSol = solQuantity(liquid - quantity);
      const removedCost = quantity === total ? position.costBasisCents : Number((BigInt(position.costBasisCents) * quantity + total / 2n) / total);
      snapshot.costBasisCents = position.costBasisCents - removedCost;
      cashDeltaCents = amountCents - feeCents;
    } else {
      if (feeCents) throw new Error('Record a reward fee as a separate fee.');
      snapshot.stakedSol = solQuantity(staked + quantity);
      snapshot.rewardsSol = solQuantity(solLamports(position.rewardsSol) + quantity);
      amountCents = solMarketValue(snapshot) - solMarketValue(position);
    }
  }
  solLamports(snapshot.liquidSol);
  solLamports(snapshot.stakedSol);
  solLamports(snapshot.rewardsSol);
  solMarketValue(snapshot);
  cents(Math.abs(cashDeltaCents));
  return { snapshot, amountCents, feeCents, cashDeltaCents };
}

export function summarizeSolHistory(position:SolPosition) {
  const history = position.history ?? [];
  let purchasesCents = 0, salesCents = 0, rewardsCents = 0, feesCents = 0, correctionsCents = 0, marketChangeCents = 0;
  for (let index = 1; index < history.length; index++) {
    const entry = history[index];
    const change = solMarketValue(entry) - solMarketValue(history[index - 1]);
    feesCents += entry.feeCents;
    if (entry.kind === 'buy') { purchasesCents += entry.amountCents; marketChangeCents += change - entry.amountCents; }
    else if (entry.kind === 'sell') { salesCents += entry.amountCents; marketChangeCents += change + entry.amountCents; }
    else if (entry.kind === 'reward') { rewardsCents += entry.amountCents; marketChangeCents += change - entry.amountCents; }
    else if (entry.kind === 'correction') correctionsCents += change;
    else marketChangeCents += change;
  }
  return { startDate:history[0]?.date ?? null, openingValueCents:history[0] ? solMarketValue(history[0]) : null, purchasesCents, salesCents, rewardsCents, feesCents, correctionsCents, marketChangeCents, resultCents:rewardsCents + marketChangeCents - feesCents };
}

export function validateSolHistory(position:SolPosition):void {
  if (!position.history) return;
  const history = position.history;
  if (!history.length || history[0].kind !== 'snapshot') throw new Error('SOL history needs an opening snapshot.');
  for (let index = 0; index < history.length; index++) {
    const entry = history[index];
    if (entry.priceDate > entry.date) throw new Error('A SOL history price cannot be dated after its entry.');
    if (index === 0) {
      if (entry.quantitySol !== '0' || entry.amountCents || entry.feeCents || entry.cashAccountId || entry.transactionIds.length) throw new Error('A SOL opening snapshot cannot contain a trade or cash posting.');
      continue;
    }
    const previous = history[index - 1];
    if (entry.date < previous.date || entry.kind === 'snapshot') throw new Error('SOL history must stay in date order with one opening snapshot.');
    if (entry.kind === 'price' || entry.kind === 'correction') {
      if (entry.quantitySol !== '0' || entry.amountCents || entry.feeCents || entry.cashAccountId) throw new Error('A SOL correction or quote cannot contain a trade.');
      if (entry.kind === 'price' && (entry.liquidSol !== previous.liquidSol || entry.stakedSol !== previous.stakedSol || entry.rewardsSol !== previous.rewardsSol || entry.costBasisCents !== previous.costBasisCents)) throw new Error('A SOL price update cannot change holdings.');
      if (entry.kind === 'correction' && entry.rewardsSol !== previous.rewardsSol) throw new Error('A SOL correction cannot change recorded rewards.');
    } else {
      if (entry.priceCents !== previous.priceCents || entry.priceDate !== previous.priceDate || entry.priceSource !== previous.priceSource) throw new Error('Record a SOL quote before activity at a new price.');
      if (entry.kind === 'reward' && entry.cashAccountId) throw new Error('A SOL reward cannot post cash.');
      const calculated = calculateSolActivity(previous, { kind:entry.kind as SolActivityKind, quantitySol:entry.quantitySol, feeCents:entry.feeCents });
      if (JSON.stringify(calculated.snapshot) !== JSON.stringify(solSnapshot(entry)) || calculated.amountCents !== entry.amountCents) throw new Error('SOL history does not match its quantities, cost or transaction value.');
    }
  }
  if (JSON.stringify(solSnapshot(history.at(-1)!)) !== JSON.stringify(solSnapshot(position)) || history.at(-1)!.priceSource !== position.priceSource) throw new Error('SOL history does not match the current position.');
}

export const solHistoryLabels:Record<SolHistoryEntry['kind'],string> = { snapshot:'Opening snapshot', correction:'Balance correction', price:'Price update', buy:'Buy', sell:'Sell', reward:'Staking reward', fee:'CAD fee' };
