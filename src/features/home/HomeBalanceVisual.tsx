import { useId, useLayoutEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { money } from '../../../shared/analytics.ts';
import './home-balance-visual.css';

interface Props {
  assetsCents: number | null | undefined;
  liabilitiesCents: number | null | undefined;
  motion: boolean;
  onDetails: () => void;
}
type Segment = 'assets' | 'owed';
const recordedAmount = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? value : null;

export default function HomeBalanceVisual({ assetsCents, liabilitiesCents, motion, onDetails }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Segment | null>(null);
  const assets = recordedAmount(assetsCents);
  const owed = recordedAmount(liabilitiesCents);
  const total = assets !== null && owed !== null ? assets + owed : 0;
  const comparable = assets !== null && owed !== null && assets >= 0 && owed >= 0 && Number.isFinite(total) && total > 0;
  const assetShare = comparable ? assets / total * 100 : 0;
  const owedShare = comparable ? owed / total * 100 : 0;
  const value = (segment: Segment) => {
    const cents = segment === 'assets' ? assets : owed;
    return cents === null ? 'Not recorded' : money(cents);
  };

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !motion || !comparable) return;
    let entrance: gsap.core.Tween;
    let sweep: gsap.core.Tween;
    const context = gsap.context(() => {
      entrance = gsap.fromTo('.home-balance-fill', { scaleX: 0, opacity: .35 }, { scaleX: 1, opacity: 1, duration: .8, ease: 'power3.out', stagger: .09, clearProps: 'transform,opacity', paused: document.hidden });
      sweep = gsap.fromTo('.home-balance-sweep', { xPercent: 0 }, { xPercent: 410, duration: 2.6, ease: 'power1.inOut', repeat: -1, repeatDelay: 1.2, paused: document.hidden });
    }, element);
    const visibility = () => {
      if (document.hidden) { entrance.pause(); sweep.pause(); }
      else { entrance.resume(); sweep.resume(); }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); context.revert(); };
  }, [motion, comparable, assetShare, owedShare]);

  return <div ref={root} className="home-balance-visual" data-active={active ?? undefined} data-motion={motion && comparable ? 'on' : 'off'} onMouseLeave={() => {
    const focused = root.current?.querySelector<HTMLButtonElement>('button:focus');
    setActive(focused?.dataset.segment as Segment | undefined ?? null);
  }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setActive(null); }} onKeyDown={event => { if (event.key === 'Escape') setActive(null); }}>
    <div className="home-balance-controls" role="group" aria-label="Assets and amounts owed" aria-describedby={`${id}-description`}>
      {(['assets', 'owed'] as const).map(segment => <button key={segment} type="button" data-segment={segment} aria-label={`${segment === 'assets' ? 'Assets' : 'Owed'} ${value(segment)}`} aria-describedby={active === segment ? `${id}-tooltip` : undefined} onMouseEnter={() => setActive(segment)} onFocus={() => setActive(segment)} onClick={onDetails}>
        <i aria-hidden="true"/>{segment === 'assets' ? 'Assets' : 'Owed'}<span aria-hidden="true">↗</span>
      </button>)}
    </div>
    <div className="home-balance-rail" aria-hidden="true">
      <span className="home-balance-segment assets" style={{ width: `${assetShare}%` }}><span className="home-balance-fill"/></span>
      <span className="home-balance-segment owed" style={{ width: `${owedShare}%` }}><span className="home-balance-fill"/></span>
      {comparable && <span className="home-balance-sweep"/>}
    </div>
    <span id={`${id}-description`} className="sr-only">{comparable ? 'The rail compares recorded assets with amounts owed. Select either amount to open the net worth breakdown.' : 'Select either amount to open the net worth breakdown. A comparison is shown when both recorded amounts are nonnegative and their total is above zero.'}</span>
    {active && <span id={`${id}-tooltip`} role="tooltip" className={`home-balance-tooltip ${active}`}><span>{active === 'assets' ? 'Assets' : 'Owed'}</span><strong>{value(active)}</strong></span>}
  </div>;
}
