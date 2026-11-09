import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLocalAgent } from './local-agent.mjs';

const commands = new Set(['add_transaction', 'extend_bank_activity', 'set_debt_terms', 'categorize_transaction', 'categorize_transactions']);
const shaPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Use snapshot --output file; preview --plan file; rehearse --plan file --backup file --source-directory directory --run-directory new-directory; apply --plan file --rehearsal receipt.json --run-directory directory [--resume].
Plans use format "mazal-bank-update", version 1, id, baseline {stateFile, revision, stateSha256}, sources [{file, sourceFile, sha256}], steps [{id, command, capture?}], and expect {accountBalancesCents, transactionDelta}.
Commands omit requestId and expectedRevision. A capture on add_transaction names its new transaction; later commands reference it with {"$transaction":"name"}. Apply requires a successful rehearsal of the same plan. Resume explicitly retries only an exact journaled request with no intervening revision.`;

function check(condition, message) { if (!condition) throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function objectHash(value) { return digest(JSON.stringify(canonical(value))); }
export function bankStateHash(state) { const { lastBackupAt: _lastBackupAt, ...records } = state; return objectHash(records); }
function stateRecords(state) { const { revision: _revision, audit: _audit, lastBackupAt: _lastBackupAt, ...records } = state; return records; }
function validState(state) { check(state?.workspace === 'live' && Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.accounts) && Array.isArray(state.transactions), 'Expected a saved live workspace state.'); return state; }
function filename(name) { check(typeof name === 'string' && name.length > 0 && name === basename(name) && !name.includes('\\') && !/[\u0000-\u001f]/u.test(name) && name !== '.' && name !== '..', 'Source filenames must name one file without path separators.'); return name; }
function fileBytes(path) { check(lstatSync(path).isFile(), `Expected a regular file: ${path}`); return readFileSync(path); }
function readJson(path) { return JSON.parse(fileBytes(path).toString('utf8')); }
function saveNew(path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    linkSync(temporary, path);
    if (process.platform !== 'win32') { const descriptor = openSync(dirname(path), 'r'); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function directory(path, create = false) {
  if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
  check(lstatSync(path).isDirectory(), `Expected a regular directory: ${path}`);
}

export function bankImplementationHash(root = sourceRoot) {
  const paths = ['package-lock.json', 'scripts/bank-update.mjs', 'scripts/local-agent.mjs'];
  const visit = relative => {
    directory(join(root, relative));
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = `${relative}/${name}`;
      const info = lstatSync(join(root, path));
      if (info.isDirectory()) visit(path);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) { check(info.isFile(), `Implementation files must be regular files: ${path}`); paths.push(path); }
    }
  };
  visit('server');
  visit('shared');
  return objectHash(paths.sort().map(path => ({ path, sha256: digest(fileBytes(join(root, path))) })));
}

function references(value, known, resolveReference = false) {
  if (Array.isArray(value)) return value.map(item => references(item, known, resolveReference));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$transaction')) {
      check(Object.keys(value).length === 1 && typeof value.$transaction === 'string' && known.has(value.$transaction), 'Transaction references must name a capture from an earlier step.');
      return resolveReference ? known.get(value.$transaction) : value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, references(item, known, resolveReference)]));
  }
  return value;
}

export function validateBankUpdatePlan(plan) {
  check(plan?.format === 'mazal-bank-update' && plan.version === 1 && typeof plan.id === 'string' && idPattern.test(plan.id), 'Choose a version 1 Mazal bank update plan with a stable ID.');
  check(typeof plan.baseline?.stateFile === 'string' && Number.isSafeInteger(plan.baseline.revision) && plan.baseline.revision >= 0 && shaPattern.test(plan.baseline.stateSha256), 'The plan needs a saved baseline, revision and state SHA-256.');
  check(Array.isArray(plan.sources) && Array.isArray(plan.steps) && plan.steps.length > 0 && plan.steps.length <= 100, 'The plan needs sources and between 1 and 100 reviewed steps.');
  const sources = new Map();
  for (const source of plan.sources) {
    filename(source.sourceFile);
    check(typeof source.file === 'string' && shaPattern.test(source.sha256) && !sources.has(source.sourceFile), 'Each source needs a local file, SHA-256 and unique destination filename.');
    sources.set(source.sourceFile, source.sha256);
  }
  const ids = new Set(), captures = new Map(), usedSources = new Set();
  for (const step of plan.steps) {
    check(typeof step.id === 'string' && idPattern.test(step.id) && !ids.has(step.id), 'Step IDs must be unique stable names.');
    ids.add(step.id);
    check(commands.has(step.command?.type) && !Object.hasOwn(step.command, 'requestId') && !Object.hasOwn(step.command, 'expectedRevision'), 'Use a supported bank command without requestId or expectedRevision.');
    references(step.command, captures);
    if (step.command.type === 'extend_bank_activity') {
      const source = step.command.replacementSource;
      check(source && sources.get(source.sourceFile) === source.sha256, 'Every replacement source must match a hashed source in the plan.');
      check(source.sourceFile !== step.command.expectedSource?.sourceFile, 'A bank extension must use a new source filename.');
      usedSources.add(source.sourceFile);
    }
    if (step.capture !== undefined) {
      check(step.command.type === 'add_transaction' && typeof step.capture === 'string' && idPattern.test(step.capture) && !captures.has(step.capture), 'Capture names must be unique and belong to add_transaction steps.');
      captures.set(step.capture, step.capture);
    }
  }
  check(usedSources.size === sources.size, 'Every new source must be used by a bank extension.');
  check(plan.expect && Number.isSafeInteger(plan.expect.transactionDelta) && plan.expect.accountBalancesCents && typeof plan.expect.accountBalancesCents === 'object' && !Array.isArray(plan.expect.accountBalancesCents) && Object.keys(plan.expect.accountBalancesCents).length > 0 && Object.values(plan.expect.accountBalancesCents).every(Number.isSafeInteger), 'Specify the reviewed transaction count change and expected account balances in cents.');
  return plan;
}

export function loadBankUpdatePlan(planPath) {
  const plan = validateBankUpdatePlan(readJson(planPath));
  const baseDirectory = dirname(resolve(planPath));
  const baseline = validState(readJson(resolve(baseDirectory, plan.baseline.stateFile)));
  check(baseline.revision === plan.baseline.revision && bankStateHash(baseline) === plan.baseline.stateSha256, 'The saved baseline differs from the reviewed plan.');
  const sources = plan.sources.map(source => {
    const bytes = fileBytes(resolve(baseDirectory, source.file));
    check(digest(bytes) === source.sha256, `Source hash changed: ${source.sourceFile}`);
    return { ...source, bytes };
  });
  return { plan, baseline, sources, planSha256: objectHash(plan) };
}

function originalsIn(directoryPath) {
  directory(directoryPath);
  return readdirSync(directoryPath).map(sourceFile => {
    const path = join(directoryPath, sourceFile);
    check(lstatSync(path).isFile(), `The source directory contains a non-regular file: ${sourceFile}`);
    return { sourceFile, sha256: digest(fileBytes(path)) };
  });
}
function verifyOriginals(directoryPath, originals) {
  for (const source of originals) check(digest(fileBytes(join(directoryPath, filename(source.sourceFile)))) === source.sha256, `An original source changed: ${source.sourceFile}`);
}
function documentOriginals(sourceDirectory) {
  const path = join(dirname(sourceDirectory), 'documents', 'live');
  if (!existsSync(path)) return { directory: path, originals: [] };
  directory(path);
  const originals = readdirSync(path).filter(name => /^[a-f0-9]{64}\.original$/.test(name)).map(sourceFile => {
    const sha256 = digest(fileBytes(join(path, sourceFile)));
    check(sourceFile === `${sha256}.original`, `A document original no longer matches its content hash: ${sourceFile}`);
    return { sourceFile, sha256 };
  });
  return { directory: path, originals };
}
function verifyReferencedSources(plan, originals) {
  const hashes = new Map(originals.map(source => [source.sourceFile, source.sha256]));
  for (const step of plan.steps.filter(item => item.command.type === 'extend_bank_activity')) {
    const source = step.command.expectedSource;
    check(source && hashes.get(source.sourceFile) === source.sha256, `The saved source is missing or changed: ${source?.sourceFile}`);
  }
}
function unavailableHistoricalSources(state, originals, documents) {
  const hashes = new Map(originals.map(source => [source.sourceFile, source.sha256]));
  const documentHashes = new Set(documents.map(source => source.sha256));
  const sources = [...state.statements ?? [], ...(state.importBatches ?? []).map(batch => batch.source)];
  return [...new Map(sources.filter(source => hashes.get(source.sourceFile) !== source.sha256 && !documentHashes.has(source.sha256)).map(source => [source.sourceFile, { sourceFile: source.sourceFile, sha256: source.sha256, status: hashes.has(source.sourceFile) ? 'hash_mismatch' : 'missing' }])).values()];
}
function captureTransaction(step, before, after, captures) {
  if (!step.capture) return;
  const oldIds = new Set(before.transactions.map(item => item.id));
  const additions = after.transactions.filter(item => !oldIds.has(item.id));
  check(additions.length === 1 && typeof additions[0].id === 'string', `Step ${step.id} did not create exactly one transaction.`);
  captures.set(step.capture, additions[0].id);
}
function verifyExpected(plan, baseline, state) {
  check(state.transactions.length - baseline.transactions.length === plan.expect.transactionDelta, 'The transaction count does not match the reviewed plan.');
  for (const [id, cents] of Object.entries(plan.expect.accountBalancesCents)) check(state.accounts.find(account => account.id === id)?.balanceCents === cents, `The final balance does not match the reviewed plan for account ${id}.`);
}

export async function executeBankUpdate(loaded, { adapter, sourceDirectory, runDirectory, resume = false }) {
  const { plan, baseline, sources, planSha256 } = loaded;
  const existed = existsSync(runDirectory);
  check(!existed || resume, 'The run directory already exists. Use --resume to inspect and continue its saved requests.');
  directory(runDirectory, true);
  const manifestPath = join(runDirectory, 'run.json');
  let manifest;
  if (existsSync(manifestPath)) {
    manifest = readJson(manifestPath);
    check(manifest.planSha256 === planSha256 && manifest.baselineStateSha256 === bankStateHash(baseline) && manifest.sourceDirectory === resolve(sourceDirectory), 'The saved run belongs to a different plan, baseline or source directory.');
    check(Array.isArray(manifest.documentOriginals), 'This run predates document-original verification. Review a new run.');
  } else {
    check(!existed, 'The existing run has no complete manifest. Choose a new run directory.');
    const current = validState(await adapter.state());
    check(bankStateHash(current) === bankStateHash(baseline), 'The live baseline changed. Review and rehearse a new plan.');
    const originals = originalsIn(sourceDirectory);
    const documents = documentOriginals(sourceDirectory);
    verifyReferencedSources(plan, originals);
    check(sources.every(source => !originals.some(original => original.sourceFile === source.sourceFile)), 'A new source filename already exists. Original files are never replaced.');
    manifest = { format: 'mazal-bank-update-run', version: 1, planSha256, baselineStateSha256: bankStateHash(baseline), sourceDirectory: resolve(sourceDirectory), originals, documentOriginals: documents.originals };
    saveNew(manifestPath, manifest);
    saveNew(join(runDirectory, 'before-state.json'), baseline);
  }
  verifyOriginals(sourceDirectory, manifest.originals);
  const documentDirectory = join(dirname(sourceDirectory), 'documents', 'live');
  verifyOriginals(documentDirectory, manifest.documentOriginals);
  for (const source of sources) {
    check(digest(source.bytes) === source.sha256, `Source hash changed: ${source.sourceFile}`);
    const target = join(sourceDirectory, source.sourceFile);
    if (existsSync(target)) check(digest(fileBytes(target)) === source.sha256, `The new source destination changed: ${source.sourceFile}`);
    else saveNew(target, source.bytes);
  }
  let state = baseline;
  const captures = new Map();
  let incomplete = false;
  for (const [index, step] of plan.steps.entries()) {
    const stem = `${String(index + 1).padStart(3, '0')}-${step.id}`;
    const commandPath = join(runDirectory, `${stem}-command.json`), responsePath = join(runDirectory, `${stem}-response.json`);
    const command = { ...references(step.command, captures, true), expectedRevision: state.revision, requestId: `bank-update:${plan.id}:${step.id}` };
    const savedCommand = existsSync(commandPath);
    const savedResponse = existsSync(responsePath);
    check(!savedResponse || savedCommand, `Step ${step.id} has a response without its command.`);
    if (savedCommand) assert.deepEqual(readJson(commandPath), command, `The saved command for ${step.id} differs from the reviewed plan.`);
    let next;
    if (savedResponse) {
      check(!incomplete, 'The journal has a response after an unfinished step.');
      next = validState(readJson(responsePath));
    } else {
      incomplete = true;
      const current = validState(await adapter.state());
      if (savedCommand) {
        check(resume && [state.revision, state.revision + 1].includes(current.revision), 'An interrupted request has intervening changes. Review the current records before continuing.');
        if (current.revision === state.revision) check(bankStateHash(current) === bankStateHash(state), 'The saved baseline changed without a revision.');
      } else {
        check(bankStateHash(current) === bankStateHash(state), 'The workspace changed between steps. Review a new plan.');
        saveNew(commandPath, command);
      }
      next = validState(await adapter.command(command, commandPath));
      check(next.revision === state.revision + 1, 'The command response includes an unexpected revision. Stop and review the current records.');
      saveNew(responsePath, next);
    }
    check(next.revision === state.revision + 1, `Step ${step.id} has an invalid response revision.`);
    captureTransaction(step, state, next, captures);
    state = next;
  }
  check(bankStateHash(validState(await adapter.state())) === bankStateHash(state), 'The final read-back differs from the saved response.');
  verifyOriginals(sourceDirectory, manifest.originals);
  verifyOriginals(documentDirectory, manifest.documentOriginals);
  for (const source of sources) check(digest(fileBytes(join(sourceDirectory, source.sourceFile))) === source.sha256, `The new source changed: ${source.sourceFile}`);
  verifyExpected(plan, baseline, state);
  const result = { format: 'mazal-bank-update-result', version: 1, planSha256, baselineRevision: baseline.revision, revision: state.revision, steps: plan.steps.length, transactionDelta: state.transactions.length - baseline.transactions.length, originalFilesPreserved: manifest.originals.length, documentOriginalFilesPreserved: manifest.documentOriginals.length, updateSourceHashesVerified: true, unavailableHistoricalSources: unavailableHistoricalSources(baseline, manifest.originals, manifest.documentOriginals), stateSha256: bankStateHash(state), complete: true };
  const resultPath = join(runDirectory, 'result.json');
  if (existsSync(resultPath)) assert.deepEqual(readJson(resultPath), result);
  else saveNew(resultPath, result);
  return result;
}

export async function rehearseBankUpdate(loaded, { backupPath, sourceDirectory, runDirectory }) {
  check(!existsSync(runDirectory), 'Rehearsal needs a new directory. Existing records are never restored over.');
  const implementationSha256 = bankImplementationHash();
  const backup = readJson(backupPath);
  check(backup.format === 'mazal-backup' && backup.workspace === 'live' && backup.data?.revision === loaded.baseline.revision, 'The backup revision does not match the reviewed baseline.');
  const originals = originalsIn(sourceDirectory);
  const documents = documentOriginals(sourceDirectory);
  verifyReferencedSources(loaded.plan, originals);
  mkdirSync(runDirectory, { mode: 0o700 });
  const isolatedSources = join(runDirectory, 'source-documents');
  mkdirSync(isolatedSources, { mode: 0o700 });
  for (const original of originals) {
    const replacement = loaded.sources.find(source => source.sourceFile === original.sourceFile);
    if (replacement) check(replacement.sha256 === original.sha256, `The rehearsal archive has different bytes for the new source: ${original.sourceFile}`);
    else saveNew(join(isolatedSources, original.sourceFile), fileBytes(join(sourceDirectory, original.sourceFile)));
  }
  if (documents.originals.length) {
    const copiedDocuments = join(runDirectory, 'documents', 'live');
    mkdirSync(copiedDocuments, { recursive: true, mode: 0o700 });
    for (const original of documents.originals) saveNew(join(copiedDocuments, original.sourceFile), fileBytes(join(documents.directory, original.sourceFile)));
  }
  const { createStore } = await import('../server/store.ts');
  const databasePath = join(runDirectory, 'live.sqlite');
  let store = createStore(databasePath, 'live');
  try {
    const baseline = store.restore(backup);
    check(objectHash(stateRecords(baseline)) === objectHash(stateRecords(loaded.baseline)), 'The backup contents do not match the reviewed baseline.');
    const result = await executeBankUpdate({ ...loaded, baseline }, { adapter: { state: async () => store.state(), command: async command => store.command(command) }, sourceDirectory: isolatedSources, runDirectory: join(runDirectory, 'commands') });
    const final = store.state();
    store.close();
    store = createStore(databasePath, 'live');
    check(bankStateHash(store.state()) === bankStateHash(final), 'Rehearsal records changed after reopening the database.');
    verifyOriginals(sourceDirectory, originals);
    verifyOriginals(documents.directory, documents.originals);
    check(bankImplementationHash() === implementationSha256, 'The command implementation changed during rehearsal. Rehearse again before applying.');
    const receipt = { format: 'mazal-bank-update-rehearsal', version: 1, planSha256: loaded.planSha256, baselineStateSha256: bankStateHash(loaded.baseline), implementationSha256, complete: true, persistedReadBack: true, result };
    saveNew(join(runDirectory, 'receipt.json'), receipt);
    return { ...receipt, receiptPath: join(runDirectory, 'receipt.json') };
  } finally { store.close(); }
}

export function parseBankUpdateArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  const [mode, ...flags] = args;
  check(['snapshot', 'preview', 'rehearse', 'apply'].includes(mode), usage);
  const options = { mode };
  const allowed = { snapshot: ['--output'], preview: ['--plan'], rehearse: ['--plan', '--backup', '--source-directory', '--run-directory'], apply: ['--plan', '--rehearsal', '--run-directory', '--resume'] }[mode];
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    check(allowed.includes(flag) && !Object.hasOwn(options, flag.slice(2)), usage);
    if (flag === '--resume') options.resume = true;
    else { const value = flags[++index]; check(value && !value.startsWith('--'), usage); options[flag.slice(2)] = value; }
  }
  for (const flag of allowed.filter(flag => flag !== '--resume')) check(options[flag.slice(2)], usage);
  return options;
}

export async function runBankUpdate(args) {
  const options = parseBankUpdateArguments(args);
  if (options.mode === 'help') return { help: usage };
  const adapter = {
    state: async () => JSON.parse((await runLocalAgent(['GET', '/api/state?workspace=live'])).body),
    command: async (_command, commandPath) => JSON.parse((await runLocalAgent(['POST', '/api/command?workspace=live', '--body-file', commandPath])).body),
  };
  if (options.mode === 'snapshot') {
    const state = validState(await adapter.state());
    saveNew(resolve(options.output), state);
    return { output: resolve(options.output), revision: state.revision, stateSha256: bankStateHash(state) };
  }
  const loaded = loadBankUpdatePlan(resolve(options.plan));
  if (options.mode === 'preview') return { planSha256: loaded.planSha256, baselineRevision: loaded.baseline.revision, newSources: loaded.sources.map(source => ({ sourceFile: source.sourceFile, sha256: source.sha256 })), steps: loaded.plan.steps, expect: loaded.plan.expect, writes: false };
  if (options.mode === 'rehearse') return rehearseBankUpdate(loaded, { backupPath: resolve(options.backup), sourceDirectory: resolve(options['source-directory']), runDirectory: resolve(options['run-directory']) });
  const receipt = readJson(resolve(options.rehearsal));
  check(receipt.format === 'mazal-bank-update-rehearsal' && receipt.version === 1 && receipt.complete === true && receipt.persistedReadBack === true && receipt.planSha256 === loaded.planSha256 && receipt.baselineStateSha256 === bankStateHash(loaded.baseline), 'Apply needs a successful rehearsal receipt for this exact plan and baseline.');
  check(process.platform === 'darwin', 'Apply currently supports the installed Mazal Mac app. Rehearsal and preview are portable.');
  check(receipt.implementationSha256 === bankImplementationHash(), 'The command implementation changed since rehearsal. Rehearse the plan again.');
  let installedHash;
  try { installedHash = bankImplementationHash(join(homedir(), 'Applications', 'Mazal.app', 'Contents', 'Resources', 'app')); }
  catch { throw new Error('The installed command implementation could not be read. Install and restart the matching Mazal app before applying.'); }
  check(receipt.implementationSha256 === installedHash, 'The installed app differs from the rehearsed command implementation. Install and restart the matching app before applying.');
  return executeBankUpdate(loaded, { adapter, sourceDirectory: join(homedir(), 'Library', 'Application Support', 'Mazal', 'data', 'source-documents'), runDirectory: resolve(options['run-directory']), resume: options.resume === true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await runBankUpdate(process.argv.slice(2)); console.log(result.help ?? JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
