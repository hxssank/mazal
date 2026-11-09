import { useEffect, type RefObject } from 'react';

const controls = '.top-nav-item, .button, .toolbar-record, .toolbar-add-toggle, .motion-toggle, .expense-workspace-nav > button, .expense-transaction-nav > button, .expense-page-nav > button, .investment-section-tabs > button, .assets-section-tabs > button, .portfolio-status-filters > button, .workspace-tabs > button, .mazal-segmented > button, .document-navigation > button, .work-pay-nav > button';
const waveLimit = 6;
type Wave = { element: HTMLElement; animation: Animation };

export default function useGlassClicks(root: RefObject<HTMLDivElement | null>, motion: boolean) {
  useEffect(() => {
    const element = root.current;
    if (!element || !motion) return;
    const waves = new Map<HTMLElement, Wave>();
    const clear = (control: HTMLElement) => {
      const wave = waves.get(control);
      if (!wave) return;
      waves.delete(control);
      wave.animation.cancel();
      wave.element.remove();
    };
    const clearAll = () => { [...waves.keys()].forEach(clear); };
    const clearDetached = () => {
      for (const control of waves.keys()) {
        if (!control.isConnected || !element.contains(control)) clear(control);
      }
    };
    const click = (event: MouseEvent) => {
      if (document.hidden) return;
      const target = event.target instanceof window.Element ? event.target : null;
      const control = target?.closest<HTMLElement>(controls);
      if (!control || !element.contains(control) || !control.isConnected
        || control.matches(':disabled, [aria-disabled="true"]')
        || control.closest('[inert]') || typeof control.animate !== 'function') return;
      const box = control.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const x = event.detail > 0 ? Math.max(0, Math.min(box.width, event.clientX - box.left)) : box.width / 2;
      const y = event.detail > 0 ? Math.max(0, Math.min(box.height, event.clientY - box.top)) : box.height / 2;
      const diameter = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y)) * 2;
      clear(control);
      if (waves.size >= waveLimit) clear(waves.keys().next().value!);
      const wave = document.createElement('i');
      wave.className = 'glass-click-wave';
      wave.setAttribute('aria-hidden', 'true');
      Object.assign(wave.style, { left: `${x}px`, top: `${y}px`, width: `${diameter}px`, height: `${diameter}px`, pointerEvents: 'none' });
      control.append(wave);
      let animation: Animation;
      try {
        animation = wave.animate([
          { transform: 'translate(-50%, -50%) scale(.08)', opacity: .44 },
          { transform: 'translate(-50%, -50%) scale(.65)', opacity: .2, offset: .55 },
          { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 },
        ], { duration: 560, easing: 'cubic-bezier(.16, 1, .3, 1)' });
      } catch {
        wave.remove();
        return;
      }
      const active = { element: wave, animation };
      waves.set(control, active);
      const finish = () => {
        if (waves.get(control) === active) waves.delete(control);
        wave.remove();
      };
      void animation.finished.then(finish, finish);
    };
    const visibility = () => { if (document.hidden) clearAll(); };
    const observer = new window.MutationObserver(clearDetached);
    observer.observe(element, { childList: true, subtree: true });
    element.addEventListener('click', click);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      element.removeEventListener('click', click);
      document.removeEventListener('visibilitychange', visibility);
      clearAll();
    };
  }, [motion, root]);
}
