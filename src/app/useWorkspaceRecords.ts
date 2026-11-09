import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppState, Command, Workspace } from '../../shared/types.ts';
import { newestState } from '../../shared/state.ts';
import { loadState, sendCommand, StateRequestError, type DataSource } from '../services/api.ts';
import { executeCommandWithRecovery } from '../services/command-recovery.ts';
import { beginDraftOperation } from '../hooks/draft-protection.ts';

interface Options {
  onResetForms: () => void;
}

export function useWorkspaceRecords(workspace: Workspace, { onResetForms }: Options) {
  const [state, setState] = useState<AppState | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>('personal');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const stateRef = useRef(state);
  const resetFormsRef = useRef(onResetForms);
  const requestVersion = useRef(0);
  const readSequence = useRef(0);
  const foregroundSequence = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const readOnly = dataSource === 'snapshot';

  useLayoutEffect(() => { stateRef.current = state; resetFormsRef.current = onResetForms; });

  useEffect(() => {
    const version = ++requestVersion.current;
    const read = ++readSequence.current;
    const controller = new AbortController();
    setState(null); setError(''); resetFormsRef.current(); setNotice(''); setRefreshing(false);
    loadState(workspace, controller.signal, source => {
      if (version === requestVersion.current && read === readSequence.current) setDataSource(source);
    }).then(next => {
      if (version === requestVersion.current && read === readSequence.current) {
        setState(current => newestState(current, next));
        setLastChecked(new Date());
      }
    }).catch(error => {
      if (version === requestVersion.current && read === readSequence.current && !controller.signal.aborted) {
        setError(error instanceof Error ? error.message : 'Could not load your records.');
      }
    });
    return () => { requestVersion.current++; controller.abort(); refreshController.current?.abort(); };
  }, [workspace]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const refresh = useCallback(async (announce = true) => {
    if (!announce && refreshController.current) return;
    refreshController.current?.abort();
    const controller = new AbortController();
    readSequence.current++;
    refreshController.current = controller;
    const version = requestVersion.current;
    setRefreshing(true);
    let source = dataSource;
    try {
      let next: AppState;
      let baseline: AppState | undefined;
      while (true) {
        const started = foregroundSequence.current;
        baseline = stateRef.current ?? undefined;
        try {
          next = await loadState(workspace, controller.signal, value => { source = value; }, baseline);
          break;
        } catch (error) {
          if (!(error instanceof StateRequestError && error.status === 401 && foregroundSequence.current > started && !document.hidden && version === requestVersion.current && !controller.signal.aborted)) throw error;
        }
      }
      if (version === requestVersion.current && !controller.signal.aborted) {
        setDataSource(source);
        setState(current => source !== dataSource ? next : next === baseline && current?.revision === next.revision ? current : newestState(current, next));
        if (source !== dataSource) resetFormsRef.current();
        setLastChecked(new Date());
        setError('');
        if (announce) setNotice('Records refreshed.');
      }
    } catch (error) {
      if (version === requestVersion.current && !controller.signal.aborted) {
        setError(error instanceof Error ? error.message : 'Could not load your records.');
      }
    } finally {
      if (version === requestVersion.current && refreshController.current === controller) {
        refreshController.current = null;
        setRefreshing(false);
      }
    }
  }, [workspace, dataSource]);

  useEffect(() => {
    if (dataSource === 'snapshot') return;
    const check = () => { if (!document.hidden && stateRef.current) void refresh(false); };
    const resume = () => {
      if (!document.hidden) { foregroundSequence.current++; void refresh(false); }
    };
    const interval = window.setInterval(check, 15_000);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [refresh, dataSource]);

  async function command(cmd: Command) {
    if (readOnly) throw new Error('This preview is read-only. Open Mazal.app to change your records.');
    const version = requestVersion.current;
    const finish = beginDraftOperation();
    try {
      const result = await executeCommandWithRecovery(
        workspace,
        { ...cmd, expectedRevision: cmd.expectedRevision ?? state?.revision },
        (target, change) => sendCommand(target, change, state ?? undefined),
        loadState,
        next => { if (version === requestVersion.current) setState(current => newestState(current, next)); },
      );
      if (version !== requestVersion.current) return;
      setState(current => newestState(current, result));
      setNotice('Saved.');
    } finally { finish(); }
  }

  return { state, dataSource, readOnly, error, notice, refreshing, lastChecked, refresh, command, setError, setNotice };
}
