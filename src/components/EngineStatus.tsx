export default function EngineStatus({ loading, error, retry }: { loading: boolean; error: string; retry: () => void }) {
  if (error) return <p className="monthly-error" role="alert">{error} <button type="button" className="text-button" onClick={retry}>Retry calculation</button></p>;
  return loading ? <p className="position-equation" role="status">Calculating from current records…</p> : null;
}
