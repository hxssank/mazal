import { useEffect, useId, useRef, useState } from 'react';
import { request, validStatus, type BackupStatus } from '../../services/automatic-backup-api.ts';

interface Props { disabled: boolean; onBusyChange: (busy: boolean) => void; onDirtyChange: (dirty: boolean) => void }
interface FolderPicker { postMessage: (body: { action: 'chooseBackupFolder' }) => Promise<string | null> }
function folderPicker(): FolderPicker | undefined {
  return (window as Window & { webkit?: { messageHandlers?: { mazalBackupFolder?: FolderPicker } } }).webkit?.messageHandlers?.mazalBackupFolder;
}

const dateLabel = (value: string) => new Date(value).toLocaleString();

export default function AutomaticBackup({ disabled, onBusyChange, onDirtyChange }: Props) {
  const heading = useId();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [destination, setDestination] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange(destination.trim() !== (status?.destination ?? '') || Boolean(recoveryKey)); }, [destination, status?.destination, recoveryKey, onDirtyChange]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; active.current?.abort(); active.current = null; };
  }, []);
  function accept(value: BackupStatus) {
    if (!validStatus(value)) throw new Error('Mazal returned an invalid backup status. Check backup status again.');
    setStatus(value);
    setDestination(current => current.trim() === (status?.destination ?? '') ? value.destination ?? '' : current);
    setNeedsRefresh(false);
  }
  async function refresh() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setLoading(true); setError('');
    try {
      const value = await request<BackupStatus>('', 'GET', controller);
      if (mounted.current && active.current === controller) accept(value);
    } catch (failure) {
      if (mounted.current && active.current === controller) { setNeedsRefresh(true); setError(failure instanceof Error ? failure.message : 'Backup status could not be checked.'); }
    } finally {
      if (mounted.current && active.current === controller) { active.current = null; setLoading(false); }
    }
  }
  const blocked = disabled || busy || loading || !status?.supported || status.running || needsRefresh;
  async function change(action: 'configure' | 'run' | 'disable') {
    if (blocked || active.current) return;
    if (action === 'configure' && !destination.trim()) { setError('Choose a folder for automatic backups.'); return; }
    if (action === 'configure' && recoveryKey && recoveryKey.length < 12) { setError('Enter the complete saved recovery key, at least 12 characters.'); return; }
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setNotice('');
    setOperation(action === 'configure' ? 'Saving the folder and verifying the first encrypted backup…' : action === 'run' ? 'Creating and verifying an encrypted backup…' : 'Pausing automatic backups…');
    try {
      const value = await request<BackupStatus>(`/${action}`, 'POST', controller, action === 'configure' ? { destination: destination.trim(), ...(recoveryKey ? { passphrase: recoveryKey } : {}) } : undefined);
      if (!mounted.current || active.current !== controller) return;
      accept(value); setDestination(value.destination ?? ''); if (action === 'configure') setRecoveryKey('');
      setNotice(action === 'configure' ? 'Daily backups are set up. Save the recovery key so you can restore them on another Mac.' : action === 'disable' ? 'Automatic backups paused. Existing copies and the recovery key remain available.' : 'The complete backup was saved and verified.');
    } catch (failure) {
      if (mounted.current && active.current === controller) { setNeedsRefresh(true); setError(`${failure instanceof Error ? failure.message : 'The backup change could not be confirmed.'} Check backup status before trying another change.`); }
    } finally {
      if (mounted.current && active.current === controller) { active.current = null; setBusy(false); setOperation(''); }
    }
  }
  async function chooseFolder() {
    const picker = folderPicker();
    if (blocked || !picker) return;
    setBusy(true); setError('');
    try {
      const selected = await picker.postMessage({ action: 'chooseBackupFolder' });
      if (mounted.current && typeof selected === 'string' && selected) setDestination(selected);
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'The backup folder could not be selected.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function saveKey() {
    if (blocked || !status?.configured || active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setNotice(''); setOperation('Preparing the recovery key…');
    try {
      const key = await request<{ credentialId: string; passphrase: string }>('/recovery-key', 'POST', controller);
      if (!mounted.current || active.current !== controller) return;
      if (!key || typeof key.credentialId !== 'string' || !/^[a-f\d-]{36}$/i.test(key.credentialId) || typeof key.passphrase !== 'string' || key.passphrase.length < 12 || key.passphrase.length > 1024) throw new Error('The recovery key response was invalid. Try saving the key again.');
      const text = `Mazal automatic backup recovery key\n\nKey ID: ${key.credentialId}\nPassphrase: ${key.passphrase}\n\nUse this passphrase to verify or restore an encrypted .mazal backup. Keep this file separately from your backups and outside this Mac.\n`;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `mazal-recovery-key-${key.credentialId}.txt`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice('Recovery key download started. Keep the saved key separately from your backups and outside this Mac.');
    } catch (failure) { if (mounted.current && active.current === controller) setError(failure instanceof Error ? failure.message : 'The recovery key could not be saved.'); }
    finally { if (mounted.current && active.current === controller) { active.current = null; setBusy(false); setOperation(''); } }
  }
  return <section className="mazal-automatic-backup" aria-labelledby={heading}>
    <h4 id={heading}>Automatic complete backups</h4>
    <p>Save an encrypted copy every 24 hours while Mazal's local service is running. Mazal checks overdue backups when it starts and keeps the latest 14 automatic copies.</p>
    {status && !status.supported && <p className="muted">{status.unsupportedReason || 'Automatic backups require the installed macOS app and its Keychain helper.'}</p>}
    {status?.supported && <>
      <p role="status"><strong>{status.running ? 'Backup in progress' : status.enabled ? 'Daily backups enabled' : status.configured ? 'Automatic backups paused' : 'Automatic backups are not set up'}</strong></p>
      <label className="field"><span>Automatic backup folder</span><input type="text" value={destination} disabled={blocked} spellCheck={false} autoComplete="off" placeholder="Choose a folder outside Mazal's data folder" onChange={event => setDestination(event.target.value)}/></label>
      {status.configured && <details><summary>Restore a saved recovery key</summary><p className="muted">If Keychain lost access, enter the key saved with these backups. Mazal verifies it against a previous backup before restoring access.</p><label className="field"><span>Saved automatic backup recovery key</span><input type="password" value={recoveryKey} disabled={blocked} autoComplete="off" maxLength={1024} onChange={event => setRecoveryKey(event.target.value)}/></label></details>}
      <div className="mazal-backup-actions">{folderPicker() && <button type="button" className="button secondary" disabled={blocked} onClick={() => void chooseFolder()}>Choose backup folder</button>}<button type="button" className="button secondary" disabled={blocked || !destination.trim()} onClick={() => void change('configure')}>{!status.configured ? 'Set up daily backups' : !status.enabled ? 'Resume daily backups' : 'Save backup folder'}</button></div>
      <p className="muted">Mazal stores the encryption key in macOS Keychain. Save a recovery key separately so another Mac can open these backups. A folder on this Mac protects against damaged records, but losing this Mac also loses that local copy. Choose an external drive or a synced folder for a second copy.</p>
      {status.configured && <>
        <dl className="mazal-backup-status"><div><dt>Last verified backup</dt><dd>{status.lastVerifiedAt ? dateLabel(status.lastVerifiedAt) : 'No verified automatic backup'}</dd></div>{status.nextRunAt && status.enabled && <div><dt>Next backup due</dt><dd>{dateLabel(status.nextRunAt)}</dd></div>}{status.lastBackupPath && <div><dt>Saved file</dt><dd>{status.lastBackupPath}</dd></div>}</dl>
        <div className="mazal-backup-actions"><button type="button" className="button secondary" disabled={blocked || !status.enabled} onClick={() => void change('run')}>Back up now</button><button type="button" className="button secondary" disabled={blocked} onClick={() => void saveKey()}>Save recovery key</button>{status.enabled && <button type="button" className="text-button" disabled={blocked} onClick={() => void change('disable')}>Pause automatic backups</button>}</div>
      </>}
      {status.lastError && <p className="form-error" role="alert">Last backup error: {status.lastError}</p>}
    </>}
    {operation && <p role="status">{operation}</p>}{loading && <p role="status">Checking automatic backup status…</p>}{notice && <p role="status">{notice}</p>}{error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="text-button" disabled={busy || loading} onClick={() => void refresh()}>Check backup status</button>
  </section>;
}
