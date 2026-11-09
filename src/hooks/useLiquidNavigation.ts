import { useLayoutEffect, useRef, type RefObject } from 'react';

const properties = ['--nav-x', '--nav-y', '--nav-width', '--nav-height'];

export default function useLiquidNavigation(navRef: RefObject<HTMLElement | null>, activeView: string, motion: boolean) {
  const update = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    let frame = 0;
    let disposed = false;
    const observed = new Set<Element>();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);

    function measure() {
      if (disposed) return;
      if (observer) {
        const buttons = new Set(nav!.querySelectorAll('button'));
        for (const button of observed) {
          if (!buttons.has(button as HTMLButtonElement)) { observer.unobserve(button); observed.delete(button); }
        }
        for (const button of buttons) {
          if (!observed.has(button)) { observer.observe(button); observed.add(button); }
        }
      }
      const selected = nav!.querySelector<HTMLElement>('button[aria-current="page"]');
      const box = selected?.getBoundingClientRect();
      if (!box || box.width <= 0 || box.height <= 0) { nav!.removeAttribute('data-glass-ready'); return; }
      const origin = nav!.getBoundingClientRect();
      nav!.style.setProperty('--nav-x', `${box.left - origin.left + nav!.scrollLeft - nav!.clientLeft}px`);
      nav!.style.setProperty('--nav-y', `${box.top - origin.top + nav!.scrollTop - nav!.clientTop}px`);
      nav!.style.setProperty('--nav-width', `${box.width}px`);
      nav!.style.setProperty('--nav-height', `${box.height}px`);
      nav!.setAttribute('data-glass-ready', '');
    }
    function schedule() {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    }

    update.current = measure;
    observer?.observe(nav);
    nav.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    void document.fonts?.ready.then(schedule);
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      nav.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.fonts?.removeEventListener('loadingdone', schedule);
      if (update.current === measure) update.current = null;
      properties.forEach(property => nav.style.removeProperty(property));
      nav.removeAttribute('data-glass-ready');
      nav.removeAttribute('data-glass-motion');
    };
  }, [navRef]);

  useLayoutEffect(() => { update.current?.(); }, [activeView, navRef]);
  useLayoutEffect(() => { navRef.current?.setAttribute('data-glass-motion', motion ? 'on' : 'off'); }, [motion, navRef]);
}
