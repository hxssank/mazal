import { useLayoutEffect, type RefObject } from 'react';

export default function useLiveMotion(root: RefObject<HTMLElement | null>, motion: boolean, page: string) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const visibility = () => { element.dataset.windowHidden = String(document.hidden); };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); delete element.dataset.windowHidden; };
  }, [root]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !motion) return;
    const seen = new WeakSet<HTMLElement>();
    const values = new WeakMap<HTMLElement, string>();
    const active = new Map<HTMLElement, Animation>();
    let frame = 0;
    const visible = (target: HTMLElement) => {
      if (!target.getClientRects().length || target.closest('[hidden], [inert]')) return false;
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches('details:not([open])') && !parent.querySelector(':scope > summary')?.contains(target)) return false;
      }
      return true;
    };
    const animate = (target: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      if (typeof target.animate !== 'function' || document.hidden) return;
      active.get(target)?.cancel();
      const animation = target.animate(keyframes, options);
      active.set(target, animation);
      const done = () => { if (active.get(target) === animation) active.delete(target); };
      animation.onfinish = done;
      animation.oncancel = done;
    };
    const scan = () => {
      frame = 0;
      const panels = [...element.querySelectorAll<HTMLElement>('.page-body [data-motion-enter]')]
        .filter(target => !target.closest('.mazal-home') && !seen.has(target) && visible(target));
      panels.forEach(target => seen.add(target));
      if (!document.hidden) panels.filter(target => !panels.some(parent => parent !== target && parent.contains(target))).forEach((target, index) => {
        animate(target, [{ opacity: .45, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 420, delay: Math.min(index, 5) * 45, easing: 'cubic-bezier(.22,1,.36,1)' });
      });
      for (const target of element.querySelectorAll<HTMLElement>('[data-live-value]')) {
        const text = target.textContent ?? '';
        const previous = values.get(target);
        values.set(target, text);
        if (previous !== undefined && previous !== text && visible(target)) {
          animate(target, [{ color: '#c5edff', textShadow: '0 0 18px #8cd5ffb3' }, { color: getComputedStyle(target).color, textShadow: '0 0 0px #8cd5ff00' }], { duration: 900, easing: 'ease-out' });
        }
      }
      for (const [target, animation] of active) if (!element.contains(target) || !visible(target)) { animation.cancel(); active.delete(target); }
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(scan); };
    const observer = new window.MutationObserver(schedule);
    observer.observe(element, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'data-live-value'] });
    const stop = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      active.forEach(animation => animation.cancel());
      active.clear();
    };
    const visibility = () => { if (document.hidden) stop(); else schedule(); };
    element.addEventListener('toggle', schedule, true);
    document.addEventListener('visibilitychange', visibility);
    scan();
    return () => {
      observer.disconnect();
      element.removeEventListener('toggle', schedule, true);
      document.removeEventListener('visibilitychange', visibility);
      stop();
    };
  }, [root, motion, page]);
}
