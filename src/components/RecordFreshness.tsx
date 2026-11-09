import type { DataSource } from '../services/api.ts';
import Icon from './Icon.tsx';

interface Props {
  source: DataSource;
  checked: Date | null;
  refreshing: boolean;
  error: boolean;
  onRefresh: () => void;
}

export default function RecordFreshness({ source, checked, refreshing, error, onRefresh }: Props) {
  const snapshot = source === 'snapshot';
  const status = error ? 'error' : refreshing ? 'checking' : 'ready';
  return <div className="record-freshness" data-status={status} aria-label="Record updates">
    <div className="record-freshness-source"><i aria-hidden="true"/><strong>{snapshot ? 'Saved copy' : source === 'sample' ? 'Sample records' : 'Saved records'}</strong><span>{snapshot ? 'Reopen the preview for newer records' : 'Balances update when you add or import records'}</span></div>
    {!snapshot && <div className="record-freshness-check"><span>{error ? 'Refresh failed. Showing last loaded records.' : refreshing ? 'Checking for changes…' : checked ? <time dateTime={checked.toISOString()}>Checked {checked.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}</time> : 'Waiting for records'}</span><button type="button" disabled={refreshing} onClick={onRefresh} aria-label="Check for record updates" title="Refresh saved records. Bank balances change when you record or import data."><Icon name="repeat" size={14}/></button></div>}
  </div>;
}
