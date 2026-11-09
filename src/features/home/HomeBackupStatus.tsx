import { useEffect, useRef, useState } from 'react';
import { request, validStatus, type BackupStatus } from '../../services/automatic-backup-api.ts';
import Icon from '../../components/Icon.tsx';

interface Props { onOpen: () => void }
const dateLabel = (value: string) => new Date(value).toLocaleString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function HomeBackupStatus({ onOpen }: Props) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState(Date.now);
  const [attempt, setAttempt] = useState(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    let mounted = true;
    async function refresh() {
      if (document.hidden || active.current) return;
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      try {
        const value = await request<BackupStatus>('', 'GET', controller);
        if (!validStatus(value)) throw new Error('Mazal returned an invalid backup status.');
        if (mounted) { setStatus(value); setError(''); setCheckedAt(Date.now()); }
      } catch (failure) {
        if (mounted) setError(failure instanceof Error ? failure.message : 'Backup status could not be checked.');
      } finally {
        if (active.current === controller) active.current = null;
        if (mounted) setLoading(false);
      }
    }
    const resume = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(resume, 60_000);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
      active.current?.abort();
      active.current = null;
    };
  }, [attempt]);

  if (!error && (!status || !status.supported)) return null;
  const overdue = !!status?.enabled && !!status.lastVerifiedAt
    && checkedAt - Date.parse(status.lastVerifiedAt) > status.intervalHours * 3_600_000;
  const attention = !!error || !!status?.lastError || !status?.configured || !status.enabled || !status.lastVerifiedAt || overdue;
  const title = error ? 'Backup status unavailable'
    : status!.running ? 'Automatic backup in progress'
    : status!.lastError ? 'Automatic backups need attention'
    : !status!.configured ? 'Automatic backups are not set up'
    : !status!.enabled ? 'Automatic backups paused'
    : !status!.lastVerifiedAt ? 'No verified automatic backup'
    : overdue ? 'Automatic backup overdue' : 'Automatic backup verified';
  return <aside className={`home-backup-status${attention ? ' needs-attention' : ''}`} aria-label="Automatic backup health">
    <Icon name={attention ? 'info' : 'check'} size={18}/>
    <div className="home-backup-message" role="status">
      <strong>{title}</strong>
      {error ? <p>{error}</p> : <>
        {status!.lastError && <p>{status!.lastError}</p>}
        {status!.lastVerifiedAt ? <p>Last verified {dateLabel(status!.lastVerifiedAt)}.</p>
          : !status!.running && <p>Keep an encrypted copy of your records and original files.</p>}
      </>}
    </div>
    <div className="home-backup-actions">
      {error && <button type="button" className="text-button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>{loading ? 'Checking…' : 'Retry backup status'}</button>}
      <button type="button" className="text-button" onClick={onOpen}>{status && !status.configured && !error ? 'Set up backups' : 'Review backups'}<Icon name="arrow" size={14}/></button>
    </div>
  </aside>;
}
