import type { AppState } from '../../../shared/types.ts';
import type { EngineIdentity, SpendingAnalysisResult } from '../../../shared/engine.ts';
import { money } from '../../../shared/analytics.ts';
import { useEngineRun } from '../../services/useEngineRun.ts';
import { useEngineDate } from '../../services/useEngine.ts';

const modelName = (id: string) => ({ median: 'Historical median', local_level: 'statsmodels local level', bayesian: 'PyMC spending uncertainty' })[id] ?? id;
export default function SpendingAnalysis({ state, scope }: { state: AppState; scope: string }) {
  const asOf = useEngineDate();
  const identity: EngineIdentity = { workspace: state.workspace, scope, expectedRevision: state.revision, asOf };
  const key = JSON.stringify(identity);
  const run = useEngineRun<SpendingAnalysisResult>(identity, key, 'spending');
  const result = run.envelope?.result;
  return <details className="monthly-method funding-spending-analysis">
    <summary>Estimate spending from recorded history</summary>
    <p>Compare a historical median with statsmodels and PyMC estimates. The analysis uses complete weeks covered by your committed statements. It keeps its estimate separate from your living-cost assumption.</p>
    <div className="funding-actions"><button type="button" className="button secondary" disabled={run.running} onClick={() => run.start({ seed: 42 })}>Analyze recorded spending</button>{run.running && <><span role="status">{run.run?.progress ?? 'Fitting spending models…'}</span><button type="button" className="text-button" disabled={run.cancelling || !run.run} onClick={run.cancel}>{run.cancelling ? 'Cancelling…' : 'Cancel spending analysis'}</button></>}</div>
    {run.error && <p className="monthly-error" role="alert">{run.error}</p>}
    {run.run?.status === 'cancelled' && <p role="status">Spending analysis cancelled.</p>}
    {run.stale && <p role="status">Records changed. Run spending analysis again.</p>}
    {result && <div aria-label="Spending analysis results">
      <p>{result.completeWeeks} complete weeks available. {result.minimumWeeks} consecutive weeks are required.</p>
      {result.status === 'ready' && result.weeklyEstimateCents !== null ? <p><strong>{money(result.weeklyEstimateCents)} estimated per week</strong>{result.selectedModel && <> using {modelName(result.selectedModel)}.</>}{result.weeklyPredictiveIntervalCents && <> The modeled 5th to 95th percentile range is {money(result.weeklyPredictiveIntervalCents[0])} to {money(result.weeklyPredictiveIntervalCents[1])} per week.</>}</p> : <p>There is not enough covered history to fit the spending models. Keep living costs as an explicit assumption.</p>}
      {result.validation && <p>The model trained on {result.validation.trainingWeeks} weeks through {result.validation.trainingEnd} and was checked against the next {result.validation.holdoutWeeks} weeks. {result.validation.selectionRule}</p>}
      {result.models.length > 0 && <div className="funding-table-scroll"><table className="funding-table"><caption>Spending model checks</caption><thead><tr><th scope="col">Model</th><th scope="col">Average forecast error</th><th scope="col">Fit checks</th></tr></thead><tbody>{result.models.map(model => <tr key={model.id}><th scope="row">{modelName(model.id)}{model.id === result.selectedModel && <small>Selected estimate</small>}</th><td>{model.holdoutMaeCents == null ? 'Unavailable' : money(model.holdoutMaeCents)}</td><td>{model.converged ? 'Passed' : 'Failed'}{model.limitation && <small>{model.limitation}</small>}{model.maxRHat !== undefined && <small>R-hat {model.maxRHat ?? 'unavailable'}; effective samples {model.minEffectiveSampleSize ?? 'unavailable'}; divergences {model.divergences ?? 'unavailable'}.</small>}{model.warnings?.map(warning => <small key={warning}>{warning}</small>)}</td></tr>)}</tbody></table></div>}
      {result.models.filter(model => model.prior).map(model => <details key={model.id}><summary>PyMC prior and sampling checks</summary><p>{model.priorNote}</p><p>Prior weekly center {money(model.prior!.mu.meanCents)} with spread {money(model.prior!.mu.sigmaCents)}. Prior scale {money(model.prior!.sigma.sigmaCents)}. Student-t degrees of freedom {model.prior!.nu}.</p><p>{model.chains} chains, {model.drawsPerChain} draws and {model.tunePerChain} tuning steps per chain.</p></details>)}
      {result.refitDiagnostics && <p>The selected model’s fit on all covered weeks {result.refitDiagnostics.converged ? 'passed' : 'failed'} its checks.{result.refitDiagnostics.limitation && <> {result.refitDiagnostics.limitation}</>}</p>}
      <ul>{result.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>
      <p>No spending amount was changed. Review the estimate before editing living costs in the base plan.</p>
      <small>Records revision {run.envelope!.revision} · Model {run.envelope!.modelVersion}</small>
    </div>}
  </details>;
}
