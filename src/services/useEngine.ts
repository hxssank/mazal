import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/types.ts';
import type { EngineEnvelope, EngineIdentity, EngineProject, EngineSummary } from '../../shared/engine.ts';
import { today } from '../../shared/analytics.ts';
import { EngineRequestError, getEngineSummary, projectEngine } from './engine-api.ts';

interface Result<T> { data: T | null; envelope: EngineEnvelope<T> | null; loading: boolean; error: string; retry: () => void }
function useRequest<T>(identity: EngineIdentity, project?: EngineProject | null): Result<T> {
  const key = JSON.stringify([identity.workspace, identity.scope, identity.expectedRevision, identity.asOf, project]);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; attempt: number; envelope: EngineEnvelope<T> | null; error: string } | null>(null);
  useEffect(() => {
    if (project === null) return;
    const controller = new AbortController();
    let locked = false;
    let foreground = 0;
    function load() {
      const started = foreground;
      locked = false;
      setResponse(null);
      const task = project ? projectEngine<T>(identity, project, controller.signal) : getEngineSummary(identity, controller.signal) as Promise<EngineEnvelope<T>>;
      task.then(envelope => { if (!controller.signal.aborted) setResponse({ key, attempt, envelope, error: '' }); }, error => {
        if (controller.signal.aborted) return;
        locked = error instanceof EngineRequestError && error.status === 401;
        if (locked && foreground > started && !document.hidden) { load(); return; }
        setResponse({ key, attempt, envelope: null, error: error instanceof Error ? error.message : 'Calculation failed.' });
      });
    }
    const resume = () => {
      if (document.hidden) return;
      foreground++;
      if (locked) load();
    };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    load();
    return () => { controller.abort(); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, [key, attempt]);
  const current = response?.key === key && response.attempt === attempt ? response : null;
  return { data: current?.envelope?.result ?? null, envelope: current?.envelope ?? null, loading: project !== null && !current, error: current?.error ?? '', retry: () => setAttempt(value => value + 1) };
}
export function useEngineSummary(state: AppState, scope: string, asOf: string): Result<EngineSummary> {
  return useRequest({ workspace: state.workspace, scope, expectedRevision: state.revision, asOf });
}
export function useEngineProject<T>(state: AppState, scope: string, asOf: string, project: EngineProject | null): Result<T> {
  return useRequest({ workspace: state.workspace, scope, expectedRevision: state.revision, asOf }, project);
}

export function useEngineDate(): string {
  const [asOf, setAsOf] = useState(today);
  useEffect(() => {
    let timer = 0;
    const refresh = () => {
      setAsOf(today());
      window.clearTimeout(timer);
      const next = new Date(); next.setHours(24, 0, 0, 0);
      timer = window.setTimeout(refresh, next.getTime() - Date.now() + 50);
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return asOf;
}
