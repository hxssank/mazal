import { useEffect, useRef, useState } from 'react';
import type { AllocationAssumptions, EngineEnvelope, EngineIdentity, EngineRun } from '../../shared/engine.ts';
import { cancelEngineRun, EngineRequestError, getEngineRun, startEngineRun, validateEngineEnvelope } from './engine-api.ts';

const pending = (run: EngineRun<unknown> | null) => !run || run.status === 'queued' || run.status === 'running';

export function useEngineRun<T>(identity: EngineIdentity, key: string, kind: 'comparison' | 'spending') {
  const [request, setRequest] = useState<{ key: string; identity: EngineIdentity; assumptions: AllocationAssumptions | { seed: number }; sequence: number } | null>(null);
  const [output, setOutput] = useState<{ key: string; sequence: number; run: EngineRun<T> | null; envelope: EngineEnvelope<T> | null; error: string; locked: boolean } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const active = useRef<{ cancel: () => Promise<void> } | null>(null);
  const current = output?.key === key && output.sequence === request?.sequence ? output : null;

  useEffect(() => {
    if (!request || request.key !== key) return;
    let stopped = false;
    let job: EngineRun<T> | null = null;
    let timer = 0;
    let pollEpoch = 0;
    let foreground = 0;
    let locked = false;
    let resumeEpoch: number | null = null;
    let cancelRequested = false;
    const controller = new AbortController();
    const write = (run: EngineRun<T> | null, envelope: EngineEnvelope<T> | null, error: string) => {
      if (!stopped) setOutput({ key, sequence: request.sequence, run, envelope, error, locked });
    };
    const fail = (error: unknown, started = foreground) => {
      if (stopped) return;
      window.clearTimeout(timer);
      if (error instanceof EngineRequestError && error.status === 401 && job && pending(job)) {
        locked = true;
        write(job, null, 'Mazal is locked. Unlock it to resume this calculation.');
        if (foreground > started && !document.hidden && resumeEpoch === null) resume();
        return;
      }
      locked = false;
      write(job, null, error instanceof Error ? error.message : 'The calculation failed. Retry it.');
      if (job && pending(job)) void cancelEngineRun(job.id, request.identity.workspace).catch(() => {});
    };
    const accept = (next: EngineRun<T>) => {
      job = next;
      if (stopped) {
        if (pending(next)) void cancelEngineRun(next.id, request.identity.workspace).catch(() => {});
        return;
      }
      locked = false;
      const envelope = next.status === 'completed' ? validateEngineEnvelope<T>(next.result, request.identity, kind) : null;
      write(next, envelope, next.status === 'failed' ? next.error ?? 'The calculation failed. Review the inputs and retry.' : '');
      if (pending(next)) {
        const epoch = pollEpoch;
        timer = window.setTimeout(() => {
          const started = foreground;
          void getEngineRun<T>(next.id, request.identity.workspace, controller.signal).then(value => {
            if (!stopped && epoch === pollEpoch) accept(value);
          }).catch(error => { if (epoch === pollEpoch) fail(error, started); });
        }, 750);
      }
    };
    const session = {
      async cancel() {
        if (!job || !pending(job)) return;
        cancelRequested = true;
        const epoch = ++pollEpoch;
        resumeEpoch = null;
        locked = false;
        window.clearTimeout(timer);
        setCancelling(true);
        const started = foreground;
        try { const next = await cancelEngineRun<T>(job.id, request.identity.workspace); if (epoch === pollEpoch) accept(next); }
        catch (error) { if (epoch === pollEpoch) fail(error, started); }
        finally { if (!stopped) setCancelling(false); }
      },
    };
    const resume = () => {
      if (!locked || stopped || resumeEpoch !== null || !job || !pending(job) || document.hidden) return;
      const epoch = ++pollEpoch;
      resumeEpoch = epoch;
      const started = foreground;
      const task = cancelRequested ? cancelEngineRun<T>(job.id, request.identity.workspace) : getEngineRun<T>(job.id, request.identity.workspace, controller.signal);
      void task.then(value => { if (!stopped && epoch === pollEpoch) accept(value); })
        .catch(error => { if (epoch === pollEpoch) fail(error, started); })
        .finally(() => {
          if (resumeEpoch !== epoch) return;
          resumeEpoch = null;
          if (!stopped && epoch === pollEpoch && locked && foreground > started && !document.hidden) resume();
        });
    };
    const onForeground = () => {
      if (document.hidden) return;
      foreground++;
      resume();
    };
    window.addEventListener('focus', onForeground);
    document.addEventListener('visibilitychange', onForeground);
    active.current = session;
    write(null, null, '');
    setCancelling(false);
    // Retain the create response so leaving the page can cancel its worker.
    void startEngineRun<T>(request.identity, request.assumptions, undefined, kind).then(accept).catch(fail);
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener('focus', onForeground);
      document.removeEventListener('visibilitychange', onForeground);
      if (job && pending(job)) void cancelEngineRun(job.id, request.identity.workspace).catch(() => {});
      if (active.current === session) active.current = null;
    };
  }, [request, key, kind]);

  return {
    run: current?.run ?? null,
    envelope: current?.envelope ?? null,
    error: current?.error ?? '',
    running: request?.key === key && (!current?.error || current.locked) && pending(current?.run ?? null),
    cancelling,
    stale: output !== null && output.key !== key,
    start: (assumptions: AllocationAssumptions | { seed: number }) => setRequest(previous => ({ key, identity, assumptions, sequence: (previous?.sequence ?? 0) + 1 })),
    cancel: () => active.current?.cancel(),
  };
}
