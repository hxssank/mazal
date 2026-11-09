import type { AppState, Workspace } from './types.ts';

export interface StateChanges {
  format: 'mazal-state-changes';
  workspace: Workspace;
  baseRevision: number;
  revision: number;
  changes: Partial<Omit<AppState, 'workspace' | 'revision'>>;
}
