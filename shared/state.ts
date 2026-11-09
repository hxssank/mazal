import type { AppState } from './types.ts';

export function newestState(current: AppState | null, incoming: AppState): AppState {
  if (current?.workspace === incoming.workspace && current.revision > incoming.revision) return current;
  return incoming;
}
