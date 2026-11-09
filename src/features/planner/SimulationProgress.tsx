import { useId, useMemo, type CSSProperties } from 'react';
import type { SimulationPoint } from '../../../shared/simulation.ts';
import { money } from '../../../shared/analytics.ts';
import './simulation-progress.css';

export type SimulationArea = 'cash' | 'debt' | 'investments' | 'business';

interface Props {
  points: SimulationPoint[];
  month: number;
  focus: SimulationArea;
  onFocus: (area: SimulationArea) => void;
  unknownCash?: boolean;
  visibleAreas?: SimulationArea[];
  labels?: Partial<Record<SimulationArea, string>>;
  motion?: boolean;
}

const areas: { id: SimulationArea; label: string; field: 'cashCents' | 'debtCents' | 'investmentsCents' | 'businessCents'; color: string; pale: string; edge: string }[] = [
  { id: 'cash', label: 'Cash', field: 'cashCents', color: '#baa5dc', pale: '#eee8fa', edge: '#8d6ebc' },
  { id: 'debt', label: 'Debt', field: 'debtCents', color: '#e49984', pale: '#fbe3d7', edge: '#b96955' },
  { id: 'investments', label: 'Investments', field: 'investmentsCents', color: '#9870e4', pale: '#e5d3fc', edge: '#7546bd' },
  { id: 'business', label: 'Business', field: 'businessCents', color: '#caa3ac', pale: '#fae3d7', edge: '#ae7d8d' },
];

function scaleLimit(value: number): number {
  if (value <= 0) return 0;
  const order = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / order) * order;
}

function plane(y: number): string {
  return `M39 ${y} 75 ${y - 18} 111 ${y} 75 ${y + 18}Z`;
}

function changeLabel(area: SimulationArea, difference: number): string {
  if (difference === 0) return 'Unchanged';
  if (area === 'debt') return `${money(Math.abs(difference))} ${difference < 0 ? 'less owed' : 'more owed'}`;
  return `${difference < 0 ? '−' : '+'}${money(Math.abs(difference))} from start`;
}

export default function SimulationProgress({ points, month, focus, onFocus, unknownCash = false, visibleAreas, labels, motion = true }: Props) {
  const id = useId().replace(/:/g, '');
  const shownAreas = useMemo(() => visibleAreas ? areas.filter(area => visibleAreas.includes(area.id)) : areas, [visibleAreas]);
  const scale = useMemo(() => {
    let maximum = 0;
    let minimum = 0;
    for (const point of points) {
      for (const area of shownAreas) {
        if (unknownCash && area.id === 'cash') continue;
        maximum = Math.max(maximum, point[area.field]);
        minimum = Math.min(minimum, point[area.field]);
      }
    }
    const upper = scaleLimit(maximum);
    const lower = scaleLimit(-minimum);
    const pixelsPerCent = 178 / (upper + lower || 1);
    return { upper, lower, pixelsPerCent, zeroY: upper + lower === 0 ? 221 : 43 + upper * pixelsPerCent };
  }, [points, unknownCash, shownAreas]);
  const selected = points.find(point => point.month === month) ?? points.at(-1);
  const opening = points[0];
  if (!selected || !opening || shownAreas.length === 0) return null;
  const hasBalances = scale.upper + scale.lower > 0;
  const hasProjection = points.length > 1;
  const low = scale.lower ? `−${money(scale.lower)}` : money(0);
  const scaleLabel = hasBalances ? `${low} to ${money(scale.upper)}` : 'No nonzero balances';

  return <div className="planner-balance" data-motion={motion ? 'on' : 'off'} aria-label="Interactive balance columns">
    <div className="planner-balance-scale"><span>{shownAreas.length === 2 ? 'Same scale for both balances' : 'Same scale for all balances'}</span><span>{scaleLabel}</span></div>
    <div className="planner-balance-stage" role="group" aria-label="Select a balance to inspect" style={{ '--planner-column-count': shownAreas.length, '--planner-mobile-column-count': Math.min(2, shownAreas.length) } as CSSProperties}>
      {shownAreas.map((area, index) => {
        const unknown = unknownCash && area.id === 'cash';
        const value = unknown ? null : selected[area.field];
        const startValue = unknown ? null : opening[area.field];
        const difference = value === null || startValue === null ? null : value - startValue;
        const y = value === null ? scale.zeroY : scale.zeroY - value * scale.pixelsPerCent;
        const startY = startValue === null ? scale.zeroY : scale.zeroY - startValue * scale.pixelsPerCent;
        const negative = value !== null && value < 0;
        const active = focus === area.id;
        const label = labels?.[area.id] ?? (negative && area.id === 'cash' ? 'Cash deficit' : area.label);
        const delta = difference === null ? '' : changeLabel(area.id, difference);
        const favourable = difference !== null && (area.id === 'debt' ? difference < 0 : difference > 0);
        const unfavourable = difference !== null && (area.id === 'debt' ? difference > 0 : difference < 0);
        const color = negative ? '#c27364' : area.color;
        const edge = negative ? '#ae4e3a' : area.edge;
        return <button type="button" key={area.id} className={`planner-balance-cell${active ? ' is-focused' : ''}${negative ? ' is-deficit' : ''}${unknown ? ' is-unknown' : ''}`} style={{ '--planner-column-color': edge } as CSSProperties} aria-pressed={active} aria-label={`${label}: ${value === null ? 'unknown' : money(value)}${hasProjection && difference !== null ? `. ${delta}` : ''}. Inspect ${label.toLowerCase()}.`} onClick={() => onFocus(area.id)}>
          <svg className="planner-balance-column" viewBox="0 0 150 270" aria-hidden="true">
            <defs>
              <linearGradient id={`${id}-${area.id}-front`} x1="0" y1="0" x2="1" y2=".8"><stop stopColor={area.pale} stopOpacity=".9"/><stop offset=".46" stopColor={color} stopOpacity=".52"/><stop offset="1" stopColor={color} stopOpacity=".9"/></linearGradient>
              <linearGradient id={`${id}-${area.id}-side`} x1="0" y1="0" x2="1" y2="1"><stop stopColor={color} stopOpacity=".36"/><stop offset="1" stopColor={edge} stopOpacity=".78"/></linearGradient>
              <linearGradient id={`${id}-${area.id}-cap`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#ffefde"/><stop offset=".48" stopColor={area.pale}/><stop offset="1" stopColor={color}/></linearGradient>
            </defs>
            <g className="planner-balance-grid" fill="none">
              {[0, .25, .5, .75, 1].map(fraction => <line key={fraction} x1="0" x2="150" y1={43 + fraction * 178} y2={43 + fraction * 178}/>)}
              <path d={`M0 ${scale.zeroY + 18} 75 ${scale.zeroY - 19} 150 ${scale.zeroY + 18}M0 ${scale.zeroY + 37} 75 ${scale.zeroY} 150 ${scale.zeroY + 37}M0 ${scale.zeroY} 75 ${scale.zeroY + 37} 150 ${scale.zeroY}M0 ${scale.zeroY + 19} 75 ${scale.zeroY + 56} 150 ${scale.zeroY + 19}`}/>
            </g>
            <line className="planner-balance-zero" x1="0" x2="150" y1={scale.zeroY} y2={scale.zeroY}/>
            {index === 0 && <text className="planner-balance-zero-label" x="3" y={scale.zeroY - 7}>$0</text>}
            <path d={plane(scale.zeroY)} className="planner-balance-base"/>
            {value !== null && value !== 0 && <g className="planner-balance-prism" style={{ '--planner-column-color': edge } as CSSProperties}>
              <path d={`M39 ${y} 75 ${y + 18}V${scale.zeroY + 18}L39 ${scale.zeroY}Z`} fill={`url(#${id}-${area.id}-front)`}/>
              <path d={`M75 ${y + 18} 111 ${y}V${scale.zeroY}L75 ${scale.zeroY + 18}Z`} fill={`url(#${id}-${area.id}-side)`}/>
              <path d={plane(y)} fill={`url(#${id}-${area.id}-cap)`}/>
              <path d={`M41 ${y + 2} 75 ${y + 19} 109 ${y + 2}M75 ${y + 20}V${scale.zeroY + 16}`} className="planner-balance-shine" fill="none"/>
              <path d={`M46 ${y + 5}V${scale.zeroY + 3}`} className="planner-balance-edge-light" fill="none"/>
            </g>}
            {hasProjection && startValue !== null && <g className="planner-balance-opening" fill="none"><path d={plane(startY)}/><path d={`M39 ${startY}V${scale.zeroY}M111 ${startY}V${scale.zeroY}`}/></g>}
            {negative && <text className="planner-balance-deficit" x="75" y={Math.min(260, y + 35)} textAnchor="middle">DEFICIT</text>}
            {unknown && <text className="planner-balance-unknown" x="75" y={scale.zeroY - 15} textAnchor="middle">Not entered</text>}
          </svg>
          <span className="planner-balance-name"><i/>{label}</span>
          <strong className="planner-balance-value">{value === null ? 'Unknown' : money(value)}</strong>
          <span className={`planner-balance-change${favourable ? ' is-favourable' : ''}${unfavourable ? ' is-unfavourable' : ''}`}>{unknown ? 'Enter starting cash' : hasProjection ? delta : 'Starting balance'}</span>
        </button>;
      })}
    </div>
    <div className="planner-balance-key"><span>{hasProjection ? <><i/>Dashed outline = starting balance</> : 'Select a balance to inspect'}</span><span>{hasProjection ? 'Scale stays fixed as you move through the plan' : 'Column height uses the recorded amount'}</span></div>

  </div>;
}
