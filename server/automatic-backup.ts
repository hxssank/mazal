import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BackupError } from './backup.ts';
import { createCompleteBackupService, decodeCompleteBackup } from './complete-backup.ts';

const intervalMs = 24 * 60 * 60 * 1000;
const retryMs = 15 * 60 * 1000;
const retentionCount = 14;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const archiveName = /^mazal-auto-[0-9TZ-]+-[a-f0-9-]{36}\.encrypted\.mazal$/;
const encryptedMagic = Buffer.from('MAZAL-ENCRYPTED-1\n');
interface DirectoryIdentity { path: string; device: string; inode: string }
interface Receipt { name: string; savedAt: string; verifiedAt: string; sha256: string; bytes: number; credentialId: string }
interface Configuration {
  ownerId: string; credentialId: string; enabled: boolean; destination: DirectoryIdentity; storage: DirectoryIdentity;
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastVerifiedAt: string | null; lastError: string | null;
  receipts: Receipt[];
}
interface SetupJournal { version: 1; ownerId: string; credentialId: string; destination: DirectoryIdentity; storage?: DirectoryIdentity; cleanup?: true }
export interface AutomaticBackupCredentials { get(id: string): Promise<string>; set(id: string, passphrase: string): Promise<void>; delete(id: string): Promise<void> }
export interface AutomaticBackupStatus {
  supported: boolean; unsupportedReason: string | null; configured: boolean; enabled: boolean; destination: string | null;
  intervalHours: number; retentionCount: number; lastAttemptAt: string | null; lastSuccessAt: string | null;
  lastVerifiedAt: string | null; lastBackupPath: string | null; lastBackupSha256: string | null; lastError: string | null;
  nextRunAt: string | null; running: boolean;
}
interface Options {
  dataDirectory: string; credentials?: AutomaticBackupCredentials; configurationPath?: string;
  exportArchive(passphrase: string): Promise<Buffer>;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  verifyArchive?(bytes: Buffer, passphrase: string): Promise<void>;
  now?: () => Date;
}
function fail(message: string, status = 400): never { throw new BackupError(status, message); }
function validPassphrase(value: unknown): value is string { return typeof value === 'string' && value.length >= 12 && value.length <= 1024; }
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function atomicJson(path: string, value: unknown): void {
  if (existsSync(path) && !lstatSync(path).isFile()) fail('Automatic backup settings must be an ordinary file. Keep the existing path for inspection.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, path); syncDirectory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
}
function identity(path: string): DirectoryIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || realpathSync(path) !== path) fail('Choose an ordinary backup folder without symbolic links.');
  return { path, device: stat.dev.toString(), inode: stat.ino.toString() };
}
function sameDirectory(saved: DirectoryIdentity): void {
  const current = identity(saved.path);
  if (current.device !== saved.device || current.inode !== saved.inode) fail('The backup destination changed or its drive was replaced. Choose the destination again before backing up.', 409);
}
function safeError(error: unknown): string {
  if (error instanceof BackupError) return error.message;
  if (error instanceof Error && 'code' in error) {
    if (['ENOENT', 'ENOTDIR'].includes(String(error.code))) return 'The backup destination is unavailable. Reconnect its drive. Mazal will retry while it is running.';
    if (['EACCES', 'EPERM', 'EROFS'].includes(String(error.code))) return 'Mazal cannot write to the backup destination. Check its access permissions.';
    if (String(error.code) === 'ENOSPC') return 'The backup destination is full. Existing backups were kept.';
  }
  return 'The automatic backup failed. Existing backups were kept. Retry after checking the destination and Keychain access.';
}
export function nativeBackupCredentials(helper = process.env.MAZAL_KEYCHAIN_HELPER): AutomaticBackupCredentials | undefined {
  if (process.platform !== 'darwin' || !helper || !isAbsolute(helper)) return;
  function call(operation: 'get' | 'set' | 'delete', id: string, input = ''): Promise<string> {
    if (!uuid.test(id)) return Promise.reject(new BackupError(400, 'The backup credential identifier is invalid.'));
    return new Promise((resolveCall, reject) => {
      const child = spawn(helper!, ['--backup-keychain', operation, id], { stdio: ['pipe', 'pipe', 'ignore'], env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
      const chunks: Buffer[] = []; let bytes = 0; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) { timedOut = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
      child.stdin.on('error', () => undefined);
      child.on('error', () => { clearTimeout(timer); reject(new BackupError(503, 'The Mac backup credential helper is unavailable. Open the installed Mazal app.')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) return reject(new BackupError(503, 'Keychain access timed out. Unlock your Mac and try again.'));
        if (code !== 0) return reject(new BackupError(503, code === 2 ? 'The automatic backup recovery key is missing from Keychain. Set up automatic backups again.' : 'Keychain could not provide automatic backup access. Unlock your Mac and try again.'));
        resolveCall(Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.end(input);
    });
  }
  return { get: id => call('get', id), set: async (id, passphrase) => { await call('set', id, passphrase); }, delete: async id => { await call('delete', id); } };
}
function readConfiguration(path: string): { configuration?: Configuration; lastSetupError: string | null } {
  if (!existsSync(path)) return { lastSetupError: null };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) fail('Automatic backup settings are damaged. Keep the file for inspection.', 409);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; configuration?: Configuration; lastSetupError?: string | null };
  if (saved.version !== 1 || saved.lastSetupError !== undefined && saved.lastSetupError !== null && (typeof saved.lastSetupError !== 'string' || saved.lastSetupError.length > 1000)) fail('Automatic backup settings are damaged. Keep the file for inspection.', 409);
  if (saved.configuration === null && typeof saved.lastSetupError === 'string') return { lastSetupError: saved.lastSetupError };
  const value = saved.configuration;
  const date = (input: unknown) => input === null || typeof input === 'string' && Number.isFinite(Date.parse(input)) && new Date(input).toISOString() === input;
  const directory = (input: DirectoryIdentity | undefined) => input && isAbsolute(input.path) && input.path === resolve(input.path) && /^\d+$/.test(input.device) && /^\d+$/.test(input.inode);
  if (saved.version !== 1 || !value || !uuid.test(value.ownerId) || !uuid.test(value.credentialId) || typeof value.enabled !== 'boolean' || !directory(value.destination) || !directory(value.storage) || dirname(value.storage.path) !== value.destination.path || basename(value.storage.path) !== 'Mazal backups' || !date(value.lastAttemptAt) || !date(value.lastSuccessAt) || !date(value.lastVerifiedAt) || value.lastError !== null && (typeof value.lastError !== 'string' || value.lastError.length > 1000) || !Array.isArray(value.receipts) || value.receipts.length > 10000 || value.receipts.some(receipt => !archiveName.test(receipt.name) || !date(receipt.savedAt) || receipt.savedAt === null || !date(receipt.verifiedAt) || receipt.verifiedAt === null || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0 || !uuid.test(receipt.credentialId)) || new Set(value.receipts.map(receipt => receipt.name)).size !== value.receipts.length) fail('Automatic backup settings are damaged. Keep the file for inspection.', 409);
  return { configuration: value, lastSetupError: saved.lastSetupError ?? null };
}
export function createAutomaticBackupService(options: Options) {
  const directory = realpathSync(options.dataDirectory);
  const configurationPath = options.configurationPath ?? join(dirname(directory), `.${basename(directory)}.automatic-backup.json`);
  const setupPath = `${configurationPath}.setup`;
  const credentials = options.credentials ?? nativeBackupCredentials();
  const now = options.now ?? (() => new Date());
  let configuration: Configuration | undefined;
  let startupError: string | null = null;
  let lastSetupError: string | null = null;
  try { ({ configuration, lastSetupError } = readConfiguration(configurationPath)); } catch { startupError = 'Automatic backup settings could not be read. Existing backups were kept. Keep the settings file for inspection.'; }
  let setupJournal: SetupJournal | undefined;
  if (!startupError && existsSync(setupPath)) {
    try {
      const info = lstatSync(setupPath);
      if (!info.isFile() || info.size > 16384) throw new Error('Invalid setup journal');
      const value = JSON.parse(readFileSync(setupPath, 'utf8')) as SetupJournal;
      const validDirectory = (entry: DirectoryIdentity) => entry && typeof entry.path === 'string' && isAbsolute(entry.path) && entry.path === resolve(entry.path) && /^\d+$/.test(entry.device) && /^\d+$/.test(entry.inode);
      if (value.version !== 1 || !uuid.test(value.ownerId) || !uuid.test(value.credentialId) || !validDirectory(value.destination) || value.storage && (!validDirectory(value.storage) || value.storage.path !== join(value.destination.path, 'Mazal backups')) || value.cleanup !== undefined && (value.cleanup !== true || !value.storage)) throw new Error('Invalid setup journal');
      if (configuration && (configuration.credentialId !== value.credentialId || configuration.ownerId !== value.ownerId)) throw new Error('Setup journal conflicts with saved configuration');
      const matches = (left: DirectoryIdentity, right: DirectoryIdentity | undefined) => right && left.path === right.path && left.device === right.device && left.inode === right.inode;
      if (configuration && matches(configuration.destination, value.destination) && matches(configuration.storage, value.storage)) { rmSync(setupPath); syncDirectory(dirname(setupPath)); }
      else { setupJournal = value; lastSetupError ??= 'Automatic backup setup was interrupted. Choose the same destination to finish using its saved recovery key.'; }
    } catch { startupError = 'The interrupted automatic backup setup needs inspection. Existing keys and backup files were kept.'; }
  }
  let pending: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  function persist(value: Configuration | undefined): void { atomicJson(configurationPath, { version: 1, configuration: value ?? null, lastSetupError }); }
  function checkSetupJournal(): void {
    const info = lstatSync(setupPath, { throwIfNoEntry: false });
    if (setupJournal ? !info?.isFile() || info.size > 16384 || readFileSync(setupPath, 'utf8') !== JSON.stringify(setupJournal) : info !== undefined) fail('The automatic backup setup journal changed. Existing files were kept for inspection.', 409);
  }
  function saveSetupJournal(value: SetupJournal): void {
    checkSetupJournal();
    atomicJson(setupPath, value);
    setupJournal = value;
  }
  function nextRun(value: Configuration): string {
    const success = value.lastSuccessAt ? Date.parse(value.lastSuccessAt) + intervalMs : 0;
    const retry = value.lastError && value.lastAttemptAt ? Date.parse(value.lastAttemptAt) + retryMs : 0;
    return new Date(Math.max(success, retry)).toISOString();
  }
  function status(): AutomaticBackupStatus {
    const latest = configuration?.receipts.at(-1);
    let destinationError: string | null = null;
    if (configuration) { try { checkDestination(configuration); } catch (error) { destinationError = safeError(error); } }
    return { supported: Boolean(credentials), unsupportedReason: credentials ? null : 'Automatic encrypted backups require the installed Mac app and its Keychain helper.', configured: Boolean(configuration), enabled: configuration?.enabled ?? false, destination: configuration?.destination.path ?? null, intervalHours: 24, retentionCount, lastAttemptAt: configuration?.lastAttemptAt ?? null, lastSuccessAt: configuration?.lastSuccessAt ?? null, lastVerifiedAt: configuration?.lastVerifiedAt ?? null, lastBackupPath: latest && configuration ? join(configuration.storage.path, latest.name) : null, lastBackupSha256: latest?.sha256 ?? null, lastError: startupError ?? lastSetupError ?? destinationError ?? configuration?.lastError ?? null, nextRunAt: configuration?.enabled ? nextRun(configuration) : null, running: Boolean(pending) };
  }
  function ready(): AutomaticBackupCredentials {
    if (closed) fail('Automatic backups are shutting down. Reopen Mazal before trying again.', 503);
    if (startupError) fail(startupError, 409);
    if (!credentials) fail(status().unsupportedReason!, 503);
    return credentials;
  }
  function checkDestination(value: Configuration): void {
    sameDirectory(value.destination); sameDirectory(value.storage);
    const marker = join(value.storage.path, '.mazal-owner');
    const info = lstatSync(marker);
    if (!info.isFile() || info.size > 100 || readFileSync(marker, 'utf8') !== value.ownerId) fail('The automatic backup folder no longer belongs to this configuration. Choose the destination again.', 409);
  }
  async function verify(bytes: Buffer, passphrase: string): Promise<void> {
    if (options.verifyArchive) return options.verifyArchive(bytes, passphrase);
    const verifier = createCompleteBackupService(directory, { open: async () => { throw new Error('Verification cannot restore records.'); }, close: async () => { throw new Error('Verification cannot stop the live runtime.'); } });
    try { await verifier.preview(bytes, passphrase); } finally { verifier.close(); }
  }
  async function createCopy(value: Configuration, passphrase: string): Promise<Receipt> {
    checkDestination(value);
    return options.exclusive(async () => {
      const bytes = await options.exportArchive(passphrase);
      if (!bytes.subarray(0, encryptedMagic.length).equals(encryptedMagic)) fail('Automatic backups must be encrypted. No backup was saved.', 500);
      checkDestination(value);
      const savedAt = now().toISOString();
      const name = `mazal-auto-${savedAt.replace(/[:.]/g, '-')}-${randomUUID()}.encrypted.mazal`;
      const path = join(value.storage.path, name), temporary = `${path}.tmp`;
      let installed = false;
      try {
        writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx', flush: true });
        const descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
        let saved: Buffer;
        try { saved = readFileSync(descriptor); } finally { closeSync(descriptor); }
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (saved.length !== bytes.length || createHash('sha256').update(saved).digest('hex') !== digest) fail('The saved backup did not match its bytes. Existing backups were kept.', 500);
        await verify(saved, passphrase);
        checkDestination(value);
        renameSync(temporary, path); installed = true; syncDirectory(value.storage.path);
        return { name, savedAt, verifiedAt: now().toISOString(), sha256: digest, bytes: bytes.length, credentialId: value.credentialId };
      } catch (error) {
        if (installed) rmSync(path, { force: true });
        throw error;
      } finally { rmSync(temporary, { force: true }); }
    });
  }
  function retain(value: Configuration): void {
    const removed: string[] = [];
    try {
      checkDestination(value);
      for (const receipt of value.receipts.slice(0, Math.max(0, value.receipts.length - retentionCount))) {
        const path = join(value.storage.path, receipt.name);
        if (existsSync(path)) {
          const info = lstatSync(path);
          if (!info.isFile() || info.size !== receipt.bytes || createHash('sha256').update(readFileSync(path)).digest('hex') !== receipt.sha256) fail('An older automatic backup changed. Mazal kept it for inspection.', 409);
          rmSync(path); syncDirectory(value.storage.path);
        }
        removed.push(receipt.name);
      }
    } catch { value.lastError = 'The new backup passed verification, but an older backup could not be removed. Existing files were kept for inspection.'; }
    value.receipts = value.receipts.filter(receipt => !removed.includes(receipt.name));
    persist(value);
  }
  function operation<T>(work: () => Promise<T>): Promise<T> {
    ready();
    if (pending) return Promise.reject(new BackupError(409, 'An automatic backup operation is already running. Wait for its result.'));
    const result = Promise.resolve().then(work);
    pending = result;
    return result.finally(() => { pending = undefined; });
  }
  async function configure(input: { destination?: unknown; passphrase?: unknown }): Promise<AutomaticBackupStatus> {
    await operation(async () => {
      try {
      const access = ready();
      if (typeof input?.destination !== 'string' || !isAbsolute(input.destination) || input.destination.length > 4096) fail('Choose an existing absolute backup folder path.');
      if (input.passphrase !== undefined && !validPassphrase(input.passphrase)) fail('Use a backup passphrase from 12 to 1,024 characters.');
      const requested = resolve(input.destination);
      const destination = identity(requested);
      const inside = relative(directory, destination.path);
      if (!inside || inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) fail('Choose a backup destination outside Mazal’s data folder.');
      if (setupJournal) {
        if (destination.path !== setupJournal.destination.path) fail('Finish the interrupted backup setup with its original destination before choosing another folder.', 409);
        sameDirectory(setupJournal.destination);
        if (setupJournal.storage && (!setupJournal.cleanup || lstatSync(setupJournal.storage.path, { throwIfNoEntry: false }))) sameDirectory(setupJournal.storage);
      }
      const ownerId = configuration?.ownerId ?? setupJournal?.ownerId ?? randomUUID();
      const storagePath = join(destination.path, 'Mazal backups');
      let storage: DirectoryIdentity | undefined;
      let needsMarker = false;
      if (existsSync(storagePath)) {
        storage = identity(storagePath);
        const marker = join(storagePath, '.mazal-owner');
        const info = lstatSync(marker, { throwIfNoEntry: false });
        needsMarker = !info && Boolean(setupJournal) && readdirSync(storagePath).length === 0;
        if (!needsMarker && (!info?.isFile() || info.size > 100 || readFileSync(marker, 'utf8') !== ownerId)) fail('The selected folder already contains backups from another configuration. Choose another destination.', 409);
      }
      let existingPassphrase: string | undefined;
      if (configuration) {
        try { existingPassphrase = await access.get(configuration.credentialId); }
        catch {
          if (!validPassphrase(input.passphrase)) fail('The recovery key is missing from Keychain. Enter your saved recovery key to repair access.');
          checkDestination(configuration);
          const receipt = configuration.receipts.at(-1);
          if (!receipt) fail('There is no verified automatic backup to check this recovery key against. Keep your existing files for inspection.', 409);
          const path = join(configuration.storage.path, receipt.name);
          const info = lstatSync(path);
          if (!info.isFile() || info.size !== receipt.bytes) fail('The previous verified backup is unavailable. Reconnect its destination before repairing Keychain access.', 409);
          const bytes = readFileSync(path);
          if (createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) fail('The previous backup changed. Keep it for inspection before repairing Keychain access.', 409);
          await decodeCompleteBackup(bytes, input.passphrase);
          await access.set(configuration.credentialId, input.passphrase);
          existingPassphrase = input.passphrase;
        }
      } else if (setupJournal) {
        try { existingPassphrase = await access.get(setupJournal.credentialId); }
        catch {
          const archives = existsSync(storagePath) ? readdirSync(storagePath).filter(name => archiveName.test(name) || name.endsWith('.encrypted.mazal.tmp')) : [];
          if (archives.length) fail('The interrupted setup already saved backup bytes, but its recovery key is missing from Keychain. Keep the files and restore the original Keychain key before retrying.', 409);
        }
      }
      if (existingPassphrase && input.passphrase !== undefined && input.passphrase !== existingPassphrase) fail('Keep the existing recovery key when changing automatic backup settings. Earlier backups use that key.');
      const passphrase = existingPassphrase ?? input.passphrase ?? randomBytes(32).toString('hex');
      if (!validPassphrase(passphrase)) fail('Keychain returned an invalid backup recovery key. Set up automatic backups again.', 503);
      const credentialId = configuration?.credentialId ?? setupJournal?.credentialId ?? randomUUID();
      const previous = configuration;
      if (!setupJournal && (!previous || !storage)) {
        saveSetupJournal({ version: 1, ownerId, credentialId, destination });
      }
      let value: Configuration | undefined;
      let createdStorage: DirectoryIdentity | undefined;
      let receipt: Receipt | undefined;
      try {
        sameDirectory(destination);
        if (!storage) { mkdirSync(storagePath, { mode: 0o700 }); storage = identity(storagePath); createdStorage = storage; needsMarker = true; }
        else sameDirectory(storage);
        if (setupJournal) { const { cleanup: _cleanup, ...saved } = setupJournal; saveSetupJournal({ ...saved, storage }); }
        if (needsMarker) {
          sameDirectory(destination); sameDirectory(storage);
          if (readdirSync(storagePath).length) fail('The interrupted backup folder is no longer empty. Existing files were kept for inspection.', 409);
          writeFileSync(join(storagePath, '.mazal-owner'), ownerId, { mode: 0o600, flag: 'wx', flush: true });
          syncDirectory(storagePath); syncDirectory(destination.path);
        }
        value = { ownerId, credentialId, enabled: true, destination, storage, lastAttemptAt: now().toISOString(), lastSuccessAt: null, lastVerifiedAt: null, lastError: null, receipts: previous?.storage.path === storage.path ? [...previous.receipts] : [] };
        checkDestination(value);
        if (!previous && !existingPassphrase) await access.set(credentialId, passphrase);
        if (await access.get(credentialId) !== passphrase) fail('Keychain did not retain the backup recovery key. Existing settings were kept.', 503);
        checkSetupJournal();
        receipt = await createCopy(value, passphrase);
        checkSetupJournal();
        value.receipts.push(receipt); value.lastSuccessAt = receipt.savedAt; value.lastVerifiedAt = receipt.verifiedAt;
        lastSetupError = null;
        persist(value); configuration = value;
      } catch (error) {
        if (receipt && value) rmSync(join(value.storage.path, receipt.name), { force: true });
        let removedStorage = false;
        if (createdStorage) {
          try {
            sameDirectory(createdStorage);
            if (readdirSync(storagePath).every(name => name === '.mazal-owner') && readFileSync(join(storagePath, '.mazal-owner'), 'utf8') === ownerId) {
              if (setupJournal) saveSetupJournal({ ...setupJournal, cleanup: true });
              sameDirectory(createdStorage);
              rmSync(join(storagePath, '.mazal-owner')); rmdirSync(storagePath); syncDirectory(destination.path);
              removedStorage = true;
            }
          } catch {}
        }
        if (removedStorage && setupJournal) {
          if (!previous) await access.delete(credentialId).catch(() => undefined);
          checkSetupJournal();
          rmSync(setupPath, { force: true }); syncDirectory(dirname(setupPath)); setupJournal = undefined;
        }
        throw new BackupError(error instanceof BackupError ? error.status : 500, safeError(error));
      }
      if (setupJournal) {
        try { checkSetupJournal(); rmSync(setupPath); syncDirectory(dirname(setupPath)); setupJournal = undefined; }
        catch { value.lastError = 'The backup passed verification, but its setup journal could not be removed. Keep the settings folder for inspection.'; }
      }
      retain(value);
      } catch (error) {
        lastSetupError = safeError(error); persist(configuration);
        throw new BackupError(error instanceof BackupError ? error.status : 500, lastSetupError);
      }
    });
    return status();
  }
  async function run(): Promise<AutomaticBackupStatus> {
    await operation(async () => {
      const access = ready();
      if (!configuration?.enabled) fail('Set up or enable automatic backups before running a backup.');
      const value = configuration;
      lastSetupError = null; value.lastAttemptAt = now().toISOString(); value.lastError = null; persist(value);
      try {
        const passphrase = await access.get(value.credentialId);
        if (!validPassphrase(passphrase)) fail('Keychain returned an invalid backup recovery key. Set up automatic backups again.', 503);
        const receipt = await createCopy(value, passphrase);
        value.receipts.push(receipt); value.lastSuccessAt = receipt.savedAt; value.lastVerifiedAt = receipt.verifiedAt; value.lastError = null;
        persist(value); retain(value);
      } catch (error) { value.lastError = safeError(error); persist(value); throw new BackupError(error instanceof BackupError ? error.status : 500, value.lastError); }
    });
    return status();
  }
  async function disable(): Promise<AutomaticBackupStatus> {
    await operation(async () => { if (configuration) { const next = { ...configuration, enabled: false }; persist(next); configuration = next; } });
    return status();
  }
  async function recoveryKey(): Promise<{ credentialId: string; passphrase: string }> {
    const access = ready();
    if (pending) fail('Wait for the current backup operation before saving its recovery key.', 409);
    if (!configuration) fail('Set up automatic backups before saving a recovery key.');
    const passphrase = await access.get(configuration.credentialId);
    if (!validPassphrase(passphrase)) fail('Keychain returned an invalid backup recovery key. Set up automatic backups again.', 503);
    return { credentialId: configuration.credentialId, passphrase };
  }
  async function tick(): Promise<void> {
    if (closed || pending || !credentials || startupError || !configuration?.enabled || now().getTime() < Date.parse(nextRun(configuration))) return;
    await run().catch(() => undefined);
  }
  function start(): void {
    if (timer || closed) return;
    timer = setInterval(() => { void tick(); }, 60000); timer.unref();
    void tick();
  }
  async function close(): Promise<void> { closed = true; if (timer) clearInterval(timer); await pending?.catch(() => undefined); }
  return { status, configure, run, disable, recoveryKey, tick, start, close };
}
