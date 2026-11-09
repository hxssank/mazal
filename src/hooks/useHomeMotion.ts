import { useLayoutEffect, type RefObject } from 'react';
import { gsap } from 'gsap';

export default function useHomeMotion(root: RefObject<HTMLElement | null>, motion: boolean, ready: boolean) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !motion || !ready) return;
    const seen = new WeakSet<Element>();
    const context = gsap.context(() => {}, element);
    let today: HTMLElement | null = null;
    let todayPulse: gsap.core.Tween | null = null;
    let detailKey = '';
    const previousValues = new Map<string, string>();
    const reveal = () => context.add(() => {
      const body = element.querySelector('.mazal-home');
      if (!body) return;
      const candidates = [...body.querySelectorAll<HTMLElement>('[data-motion-enter], .spend-calendar')];
      const entering = candidates.filter(target => !seen.has(target) && target.getClientRects().length && !target.closest('[hidden], details:not([open])'));
      entering.forEach(target => seen.add(target));
      if (entering.length) gsap.fromTo(entering, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .42, stagger: .045, ease: 'power2.out', clearProps: 'opacity,transform', overwrite: 'auto' });
      for (const selector of ['.position-value', '.home-bank-total']) {
        const value = body.querySelector<HTMLElement>(selector);
        const text = value?.textContent ?? '';
        const previous = previousValues.get(selector);
        if (value && text) {
          if (previous && previous !== text) gsap.fromTo(value, { textShadow: '0 0 24px rgba(180,224,255,.9)' }, { textShadow: '0 0 0px rgba(180,224,255,0)', duration: 1.1, clearProps: 'textShadow', overwrite: 'auto' });
          previousValues.set(selector, text);
        }
      }
      const nextToday = body.querySelector<HTMLElement>('.spend-calendar-day.is-today .spend-calendar-number');
      if (today !== nextToday) {
        todayPulse?.revert();
        today = nextToday;
        todayPulse = today ? gsap.fromTo(today, { boxShadow: '0 0 0 0px rgba(200,162,255,.05)' }, { boxShadow: '0 0 0 7px rgba(200,162,255,.22)', duration: 1.8, repeat: -1, yoyo: true, ease: 'sine.inOut', paused: document.hidden }) : null;
      }
      const details = body.querySelector<HTMLElement>('.spend-calendar-details:not([hidden])');
      const nextDetail = details?.querySelector('h3')?.textContent ?? '';
      if (details && detailKey && nextDetail !== detailKey) {
        gsap.fromTo(details, { opacity: .45, x: 10 }, { opacity: 1, x: 0, duration: .32, ease: 'power2.out', clearProps: 'opacity,transform', overwrite: 'auto' });
        const bars = details.querySelectorAll('.spend-calendar-category-bar > span');
        if (bars.length) gsap.fromTo(bars, { scaleX: 0, transformOrigin: 'left' }, { scaleX: 1, duration: .5, stagger: .04, ease: 'power2.out', clearProps: 'transform,transformOrigin' });
      }
      if (nextDetail) detailKey = nextDetail;
    });
    const disclosure = (event: Event) => {
      const target = event.target;
      if (!(target instanceof window.HTMLDetailsElement) || !target.open || !target.closest('.mazal-home')) return;
      context.add(() => gsap.fromTo([...target.children].filter(child => child.tagName !== 'SUMMARY'), { opacity: .4, y: 5 }, { opacity: 1, y: 0, duration: .25, ease: 'power2.out', clearProps: 'opacity,transform', overwrite: 'auto' }));
    };
    const hover = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || document.hidden) return;
      const target = event.target instanceof window.Element ? event.target.closest<HTMLElement>('.mazal-home .home-position-grid > section, .mazal-home .spend-calendar-day') : null;
      if (!target || event.relatedTarget instanceof window.Node && target.contains(event.relatedTarget)) return;
      const entered = event.type === 'pointerover';
      context.add(() => gsap.to(target, { y: entered ? target.classList.contains('spend-calendar-day') ? -3 : -4 : 0, duration: .22, ease: 'power2.out', overwrite: 'auto', ...(!entered ? { clearProps: 'transform' } : {}) }));
    };
    const observer = new window.MutationObserver(reveal);
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    element.addEventListener('toggle', disclosure, true);
    element.addEventListener('pointerover', hover);
    element.addEventListener('pointerout', hover);
    const visibility = () => {
      if (document.hidden) {
        todayPulse?.pause();
        context.getTweens().filter((tween: gsap.core.Tween) => tween !== todayPulse).forEach((tween: gsap.core.Tween) => tween.progress(1).pause());
      } else todayPulse?.resume();
    };
    document.addEventListener('visibilitychange', visibility);
    reveal();
    return () => {
      observer.disconnect();
      element.removeEventListener('toggle', disclosure, true);
      element.removeEventListener('pointerover', hover);
      element.removeEventListener('pointerout', hover);
      document.removeEventListener('visibilitychange', visibility);
      context.revert();
    };
  }, [root, motion, ready]);
}
