import { useCallback, useEffect, useState, type RefObject } from 'react';

const panels = '.expense-dashboard-spending, .expense-recurring, .planner-horizon, .pay-review-latest, .holdings-review-panel, .position-card, .home-bank-panel, .home-next-up, .spend-calendar, .expense-month-story, .expense-pay-card, .expense-plan, .expense-ledger, .expense-coming-up, .expense-recurring-preview, .subscription-row, .bill-list, .debt-overview, .debt-account-choice, .debt-payoff-lab, .debt-payment-history, .portfolio-total-bar, .portfolio-business-card, .portfolio-sol-card, .portfolio-asset-card, .portfolio-account-list, .assets-value-hero, .assets-summary-card, .assets-account-group, .planner-setup, .planner-card, .planner-results, .planner-schedule, .planner-overview, .planner-agenda, .planner-timeline, .planner-setup-card, .work-pay-overview, .work-pay-trend, .work-pay-detail, .work-pay-timecard-group, .work-pay-issue, .statement-files, .document-workbook';
const motionKey = 'mazal.glass.motion';

function preference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export default function useGlassAppearance(root: RefObject<HTMLDivElement | null>) {
  const [motionPreference, setMotionPreference] = useState(() => preference(motionKey) !== 'off');
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const motion = motionPreference && !reducedMotion;
  const toggleMotion = useCallback(() => {
    if (!reducedMotion) setMotionPreference(value => !value);
  }, [reducedMotion]);

  useEffect(() => {
    try { localStorage.setItem(motionKey, motionPreference ? 'on' : 'off'); } catch { /* Keep the choice for this session when browser storage is unavailable. */ }
  }, [motionPreference]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === motionKey || event.key === null) setMotionPreference(event.newValue !== 'off');
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);

  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element || !motion) return;
    let active: HTMLElement | null = null;
    let frame = 0;
    const clear = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      active?.removeAttribute('data-glass-lit');
      active?.style.removeProperty('--glass-x');
      active?.style.removeProperty('--glass-y');
      active = null;
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || document.hidden) return;
      const next = event.target instanceof window.Element ? event.target.closest<HTMLElement>(panels) : null;
      if (next !== active) {
        clear();
        active = next;
      }
      cancelAnimationFrame(frame);
      if (!next) return;
      const { clientX, clientY } = event;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!next.isConnected || document.hidden) return;
        const box = next.getBoundingClientRect();
        next.style.setProperty('--glass-x', `${clientX - box.left}px`);
        next.style.setProperty('--glass-y', `${clientY - box.top}px`);
        next.setAttribute('data-glass-lit', '');
      });
    };
    element.addEventListener('pointermove', move, { passive: true });
    element.addEventListener('pointerleave', clear);
    document.addEventListener('visibilitychange', clear);
    window.addEventListener('scroll', clear, { passive: true });
    return () => {
      clear();
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', clear);
      document.removeEventListener('visibilitychange', clear);
      window.removeEventListener('scroll', clear);
    };
  }, [motion, root]);

  return { motion, reducedMotion, toggleMotion };
}
