import type { AppState } from '../shared/types.ts';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_MODEL_VERSION } from '../shared/engine.ts';

const backend = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const python = join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const calculate = `import json,sys
from mazal_engine.summary import summary
from mazal_engine.calendar import spending_calendar
from mazal_engine.daily_plan import daily_plan
from mazal_engine.debt import compare_payoff
from mazal_engine.planner import project
p=json.load(sys.stdin)
snapshot,scope,as_of,draft=p["state"],p["scope"],p["asOf"],p["draft"]
calculations={
    "summary":lambda: summary(snapshot,scope,as_of),
    "spending_calendar":lambda: spending_calendar(snapshot,scope,as_of,draft["month"]),
    "daily_plan":lambda: daily_plan(snapshot,scope,as_of,draft),
    "payoff":lambda: compare_payoff(draft["input"],draft.get("extraPaymentCents",0)),
    "planner":lambda: project(snapshot,scope,as_of,draft),
}
print(json.dumps(calculations[p["kind"]](),allow_nan=False))`;
const results = new Map<string, string>();

export function engineFixtureResult(state: AppState, scope: string, asOf: string, kind: string, draft: Record<string, unknown> = {}): unknown {
  const input = JSON.stringify({ state, scope, asOf, kind, draft });
  let result = results.get(input);
  if (result === undefined) {
    result = execFileSync(python, ['-c', calculate], { cwd: backend, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (results.size >= 100) results.delete(results.keys().next().value!);
    results.set(input, result);
  }
  return JSON.parse(result);
}
export function engineFixtureFetch(getState: () => AppState | undefined, fallback?: typeof fetch): typeof fetch {
  return async (url, init) => {
    const path = new URL(String(url), 'http://localhost');
    if (!path.pathname.startsWith('/api/engine/')) {
      if (fallback) return fallback(url, init);
      throw new Error(`Unexpected request in test: ${url}`);
    }
    const state = getState();
    if (!state) throw new Error('No fixture records supplied to engine test');
    const request = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(path.searchParams);
    const scope = request.scope ?? 'personal';
    const asOf = request.asOf;
    return Response.json({ workspace: state.workspace, revision: state.revision, scope, asOf, inputHash: 'test-fixture', modelVersion: ENGINE_MODEL_VERSION, result: engineFixtureResult(state, scope, asOf, path.pathname.endsWith('/summary') ? 'summary' : request.kind, request.draft) });
  };
}
