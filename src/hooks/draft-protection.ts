import { useEffect, useRef } from 'react';

type NavigationGuard = (proceed: () => void) => boolean;
const guards = new Set<NavigationGuard>();
const operations = new Set<symbol>();
type DesktopDraftStatus = { ready: boolean; dirty: boolean; busy: boolean };
if (typeof window !== 'undefined') {
  window.addEventListener('mazal:check-drafts', event => {
    const status = (event as CustomEvent<DesktopDraftStatus>).detail;
    if (status) { status.ready = true; status.busy ||= operations.size > 0; }
  });
  window.addEventListener('beforeunload', event => {
    if (!operations.size) return;
    event.preventDefault(); event.returnValue = '';
  });
}

export function beginDraftOperation(): () => void {
  const operation = Symbol();
  operations.add(operation);
  return () => { operations.delete(operation); };
}

export function requestDraftNavigation(proceed: () => void): boolean {
  const pending = [...guards].reverse();
  let completed = false;
  const next = (index: number): void => {
    if (operations.size) return;
    if (index === pending.length) { completed = true; proceed(); return; }
    if (!guards.has(pending[index])) { next(index + 1); return; }
    pending[index](() => { next(index + 1); });
  };
  next(0);
  return completed;
}

export function useDraftProtection({ dirty, busy = false, onRequestDiscard }: { dirty: boolean; busy?: boolean; onRequestDiscard: () => void }) {
  const latest = useRef({ dirty, busy, onRequestDiscard });
  latest.current = { dirty, busy, onRequestDiscard };
  const continuation = useRef<(() => void) | null>(null);
  const guard = useRef<NavigationGuard>((proceed) => {
    if (operations.size || latest.current.busy) return false;
    if (!latest.current.dirty) { proceed(); return true; }
    continuation.current = () => { if (!operations.size && !latest.current.busy) proceed(); };
    latest.current.onRequestDiscard();
    return false;
  });
  useEffect(() => {
    const protect = guard.current;
    guards.add(protect);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!latest.current.dirty && !latest.current.busy) return;
      event.preventDefault(); event.returnValue = '';
    };
    const desktopCheck = (event: Event) => {
      const status = (event as CustomEvent<DesktopDraftStatus>).detail;
      if (!status) return;
      status.dirty ||= latest.current.dirty;
      status.busy ||= latest.current.busy;
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('mazal:check-drafts', desktopCheck);
    return () => { guards.delete(protect); continuation.current = null; window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('mazal:check-drafts', desktopCheck); };
  }, []);
  return {
    requestChange: guard.current,
    discard: () => { const proceed = continuation.current; continuation.current = null; proceed?.(); },
    keepEditing: () => { continuation.current = null; },
  };
}
