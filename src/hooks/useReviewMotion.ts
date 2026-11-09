import { useLayoutEffect, type RefObject } from 'react';
import { gsap } from 'gsap';

const pointerProperties = ['--pointer-x', '--pointer-y', '--review-hover'] as const;
type SavedProperty = { value: string; priority: string };

export default function useReviewMotion(root: RefObject<HTMLElement | null>, motion: boolean, periodKey: string) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !motion) return;
    const values = new Map<HTMLElement, string>();
    const highlights = new Map<HTMLElement, gsap.core.Tween>();
    const hovers = new Map<HTMLElement, gsap.core.Tween>();
    const pointerStyles = new Map<HTMLElement, SavedProperty[]>();
    let pointerFrame = 0;
    let pointer: { panel: HTMLElement; x: number; y: number } | null = null;
    const visible = (target: HTMLElement) => !target.closest('[hidden], [inert], details:not([open])');
    const context = gsap.context(() => {
      if (document.hidden) return;
      const reveal = (selector: string, from: gsap.TweenVars, to: gsap.TweenVars) => {
        const targets = [...element.querySelectorAll<HTMLElement>(selector)].filter(visible);
        if (!targets.length) return;
        const tween = gsap.fromTo(targets, from, { ...to, onComplete: () => tween.revert() });
      };
      reveal('[data-review-panel]', { opacity: .6, y: 12 }, { opacity: 1, y: 0, duration: .5, stagger: .045, ease: 'power3.out' });
      reveal('[data-review-bar]', { scaleY: .08, transformOrigin: '50% 100%' }, { scaleY: 1, duration: .7, stagger: { amount: .18 }, ease: 'power3.out' });
      reveal('[data-review-meter]', { scaleX: .08, transformOrigin: '0% 50%' }, { scaleX: 1, duration: .65, stagger: .06, ease: 'power3.out' });
    }, element);

    const rememberPointerStyles = (panel: HTMLElement) => {
      if (!pointerStyles.has(panel)) pointerStyles.set(panel, pointerProperties.map(property => ({ value: panel.style.getPropertyValue(property), priority: panel.style.getPropertyPriority(property) })));
    };
    const restorePointerStyles = (panel: HTMLElement) => {
      pointerStyles.get(panel)?.forEach(({ value, priority }, index) => {
        if (value) panel.style.setProperty(pointerProperties[index], value, priority);
        else panel.style.removeProperty(pointerProperties[index]);
      });
      pointerStyles.delete(panel);
    };
    const cancelPointer = () => {
      if (pointerFrame) window.cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      pointer = null;
    };
    const panelFor = (target: EventTarget | null) => {
      const panel = target instanceof window.Element ? target.closest<HTMLElement>('[data-review-panel]') : null;
      return panel && element.contains(panel) && visible(panel) ? panel : null;
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || document.hidden) return;
      const panel = panelFor(event.target);
      if (!panel) return;
      pointer = { panel, x: event.clientX, y: event.clientY };
      if (pointerFrame) return;
      pointerFrame = window.requestAnimationFrame(() => {
        pointerFrame = 0;
        if (!pointer || document.hidden || !element.contains(pointer.panel)) return;
        const { panel: target, x, y } = pointer;
        const box = target.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return;
        rememberPointerStyles(target);
        target.style.setProperty('--pointer-x', `${Math.max(0, Math.min(100, (x - box.left) / box.width * 100))}%`);
        target.style.setProperty('--pointer-y', `${Math.max(0, Math.min(100, (y - box.top) / box.height * 100))}%`);
      });
    };
    const hover = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || document.hidden) return;
      const panel = panelFor(event.target);
      if (!panel || event.relatedTarget instanceof window.Node && panel.contains(event.relatedTarget)) return;
      const entered = event.type === 'pointerover';
      if (entered) move(event);
      else if (pointer?.panel === panel) cancelPointer();
      rememberPointerStyles(panel);
      hovers.get(panel)?.kill();
      if (!panel.style.getPropertyValue('--review-hover')) panel.style.setProperty('--review-hover', '0');
      const tween = gsap.to(panel, {
        '--review-hover': entered ? 1 : 0, duration: .24, ease: 'power2.out',
        onComplete: () => {
          if (hovers.get(panel) !== tween) return;
          hovers.delete(panel);
          if (!entered) restorePointerStyles(panel);
        },
      });
      hovers.set(panel, tween);
    };
    const updateValues = () => {
      for (const target of element.querySelectorAll<HTMLElement>('[data-review-value]')) {
        const text = target.textContent ?? '';
        const previous = values.get(target);
        values.set(target, text);
        if (previous === undefined || previous === text || document.hidden || !visible(target)) continue;
        highlights.get(target)?.revert();
        const tween = gsap.fromTo(target, { textShadow: '0 0 20px rgba(164,226,255,.9)' }, {
          textShadow: '0 0 0px rgba(164,226,255,0)', duration: .9, ease: 'power2.out',
          onComplete: () => {
            tween.revert();
            if (highlights.get(target) === tween) highlights.delete(target);
          },
        });
        highlights.set(target, tween);
      }
      for (const target of values.keys()) {
        if (element.contains(target)) continue;
        highlights.get(target)?.revert();
        highlights.delete(target);
        values.delete(target);
      }
    };
    const observer = new window.MutationObserver(records => {
      const touchesValue = records.some(record => {
        const target = record.target instanceof window.Element ? record.target : record.target.parentElement;
        return target?.closest('[data-review-value]') || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof window.Element && (node.matches('[data-review-value]') || node.querySelector('[data-review-value]')));
      });
      if (touchesValue) updateValues();
      for (const panel of pointerStyles.keys()) {
        if (element.contains(panel)) continue;
        hovers.get(panel)?.kill();
        hovers.delete(panel);
        restorePointerStyles(panel);
        if (pointer?.panel === panel) cancelPointer();
      }
    });
    const clearTransient = () => {
      cancelPointer();
      context.revert();
      highlights.forEach(tween => tween.revert());
      highlights.clear();
      hovers.forEach(tween => tween.kill());
      hovers.clear();
      [...pointerStyles.keys()].forEach(restorePointerStyles);
    };
    const visibility = () => { if (document.hidden) clearTransient(); };
    const cancel = () => {
      cancelPointer();
      hovers.forEach(tween => tween.kill());
      hovers.clear();
      [...pointerStyles.keys()].forEach(restorePointerStyles);
    };
    updateValues();
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    element.addEventListener('pointermove', move, { passive: true });
    element.addEventListener('pointerover', hover);
    element.addEventListener('pointerout', hover);
    element.addEventListener('pointercancel', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerover', hover);
      element.removeEventListener('pointerout', hover);
      element.removeEventListener('pointercancel', cancel);
      document.removeEventListener('visibilitychange', visibility);
      clearTransient();
    };
  }, [root, motion, periodKey]);
}
