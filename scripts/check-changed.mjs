import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { run } from './process.mjs';

const execute = promisify(execFile);
const sourceExtensions = ['.ts', '.tsx', '.mjs', '.js', '.cjs', '.jsx', '.css', '.json'];
const ignoredDirectories = new Set(['node_modules', '.venv', '__pycache__', '.pytest_cache', '.ruff_cache', '.cache', '.python', '.git']);
const nodeTest = file => /\.test\.(?:[cm]?js|tsx?)$/.test(file);
const browserTest = file => /^tests\/.*\.spec\.[jt]s$/.test(file);
const slash = path => path.replaceAll('\\', '/');

export function projectPath(root, path) {
  const normalized = slash(relative(root, resolve(root, path)));
  if (!normalized || normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized)) throw new Error(`Changed path must be inside the project: ${path}`);
  return normalized;
}

async function readProjectFiles(root) {
  const files = new Map();
  async function visit(directory) {
    let entries;
    try { entries = await readdir(join(root, directory), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = slash(join(directory, entry.name));
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await visit(file);
      else if (entry.isFile()) files.set(file, await readFile(join(root, file)));
    }
  }
  for (const directory of ['src', 'server', 'shared', 'scripts', 'tests', 'backend', 'macos', '.github']) await visit(directory);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile()) files.set(entry.name, await readFile(join(root, entry.name)));
  }
  for (const path of ['backend/pyproject.toml', 'backend/uv.lock', 'backend/.python-version']) {
    try { files.set(path, await readFile(join(root, path))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}

function resolveDependency(root, importer, specifier, files) {
  if (!specifier.startsWith('.')) return [];
  const base = projectPath(root, resolve(root, dirname(importer), specifier));
  if (extname(base)) return [base];
  const candidates = [base, ...sourceExtensions.map(extension => `${base}${extension}`), ...sourceExtensions.map(extension => `${base}/index${extension}`)];
  const existing = candidates.find(candidate => files.has(candidate));
  return existing ? [existing] : candidates;
}

export async function buildDependencyGraph(root) {
  root = resolve(root);
  const files = await readProjectFiles(root);
  const dependencies = new Map();
  const dependents = new Map();
  const dynamic = new Set();
  for (const [file, contents] of files) {
    const source = contents.toString('utf8');
    const imports = new Set();
    const add = specifier => {
      try { for (const dependency of resolveDependency(root, file, specifier, files)) imports.add(dependency); }
      catch { dynamic.add(file); }
    };
    if (file.endsWith('.css')) {
      for (const match of source.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g)) add(match[1].startsWith('.') ? match[1] : `./${match[1]}`);
    } else if (/\.[cm]?[jt]sx?$/.test(file)) {
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isStringLiteralLike(node)) {
          const path = node.text;
          if (/^(?:src|server|shared|scripts|tests|backend|macos)\/.+\.(?:[cm]?[jt]sx?|css|json|py|swift|plist)$/.test(path)) imports.add(projectPath(root, path));
          else if (/^\.{1,2}\/.+\.(?:[cm]?[jt]sx?|css|json|py|swift|plist)$/.test(path)) add(path);
        }
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) add(node.moduleSpecifier.text);
        if (ts.isCallExpression(node)) {
          const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === 'require') {
            if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text);
            else dynamic.add(file);
          }
          if (/^(?:readFile|readFileSync|readdir|readdirSync|exec|execFile|spawn|fork|copyFile|copyFileSync|stat|statSync|existsSync|glob)$/.test(name)) dynamic.add(file);
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
          if (node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0])) add(node.arguments[0].text);
          else dynamic.add(file);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
    dependencies.set(file, imports);
    for (const dependency of imports) {
      if (!dependents.has(dependency)) dependents.set(dependency, new Set());
      dependents.get(dependency).add(file);
    }
  }
  return { root, files, dependencies, dependents, dynamic };
}

function closure(starts, edges) {
  const visited = new Set(starts);
  for (const file of visited) for (const next of edges.get(file) ?? []) visited.add(next);
  return visited;
}

export function planChangedChecks(graph, paths) {
  const changed = [...new Set(paths.map(path => projectPath(graph.root, path)))].sort();
  const allNodeTests = [...graph.files.keys()].filter(nodeTest).sort();
  const allBrowserTests = [...graph.files.keys()].filter(browserTest).sort();
  const impacted = closure(changed, graph.dependents);
  const reasons = [];
  const python = changed.some(file => file.startsWith('backend/') || file === 'scripts/check-engine.mjs');
  for (const file of changed) {
    if (file.startsWith('backend/')) continue;
    if (/^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.|playwright\.config\.|\.node-version|\.github\/|index\.html|macos\/)/.test(file)
      || /^scripts\/(?:build|release|setup|clean-install|macos-install|dev|start|browser-test-server|process)(?:[.-]|$)/.test(file)) reasons.push(`${file} changes build, runtime, or test configuration.`);
    else if (!graph.files.has(file) && !graph.dependents.has(file)) reasons.push(`${file} has no known dependency path.`);
    else if (!/^(?:src|server|shared|scripts|tests)\//.test(file)) reasons.push(`${file} is outside the application dependency graph.`);
    else if (!/\.(?:[cm]?js|[jt]sx?|css|json)$/.test(file)) reasons.push(`${file} needs checks outside the import graph.`);
  }
  const full = reasons.length > 0;
  const nodeTests = full ? allNodeTests : allNodeTests.filter(file => impacted.has(file));
  const applicationChanged = changed.some(file => /^(?:src|server|shared|backend)\//.test(file) && !nodeTest(file) && !file.startsWith('backend/tests/'));
  const browserTests = full || applicationChanged ? allBrowserTests : allBrowserTests.filter(file => impacted.has(file));
  const covered = closure(nodeTests, graph.dependencies);
  const untested = changed.filter(file => /^(?:src|server|shared)\/.*\.[jt]sx?$/.test(file) && !covered.has(file));
  return { changed, nodeTests, browserTests, full, reasons, python, untested };
}

export function testFingerprint(graph, file, nodeVersion = process.versions.node, global = false) {
  let dependencies = closure([file], graph.dependencies);
  if (global || [...dependencies].some(path => graph.dynamic.has(path) || !graph.files.has(path))) dependencies = new Set(graph.files.keys());
  for (const path of ['package.json', 'package-lock.json', '.node-version', 'tsconfig.json', 'scripts/check-changed.mjs']) dependencies.add(path);
  for (const path of graph.files.keys()) if (!path.includes('/') && /config.*\.(?:json|[cm]?js|ts)$/.test(path)) dependencies.add(path);
  const hash = createHash('sha256').update(`mazal-changed-tests-v1\0${nodeVersion}\0`);
  for (const path of [...dependencies].sort()) hash.update(path).update('\0').update(graph.files.get(path) ?? '<missing>').update('\0');
  return hash.digest('hex');
}

export async function changedFiles(root) {
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  const [tracked, untracked] = await Promise.all([
    execute('git', ['-c', 'core.fsmonitor=false', 'diff', '--name-only', '--no-renames', '-z', 'HEAD'], options),
    execute('git', ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'], options),
  ]);
  return [...new Set(`${tracked.stdout}${untracked.stdout}`.split('\0').filter(Boolean))];
}

async function readCache(path) {
  try {
    const cache = JSON.parse(await readFile(path, 'utf8'));
    return cache.version === 1 && cache.passed && typeof cache.passed === 'object' ? cache : { passed: {} };
  } catch { return { passed: {} }; }
}

async function writeCache(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, ...value }, null, 2) + '\n');
  await rename(temporary, path);
}

export function engineFingerprint(graph, identity) {
  const hash = createHash('sha256').update(`mazal-engine-checks-v1\0${identity}\0`);
  const files = [...graph.files.keys()].filter(file => file.startsWith('backend/') || ['scripts/check-engine.mjs', 'scripts/check-changed.mjs', 'scripts/process.mjs', 'package.json', 'package-lock.json', '.node-version'].includes(file)).sort();
  for (const file of files) hash.update(file).update('\0').update(graph.files.get(file)).update('\0');
  return hash.digest('hex');
}

async function readPythonIdentity(root) {
  const python = join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  try {
    const { stdout } = await execute(python, ['-c', 'import sys, importlib.metadata as m; print(sys.version); print(sorted((d.metadata["Name"], d.version) for d in m.distributions()))'], { cwd: root });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Set up the local Python environment with npm run engine:setup, then retry.');
    throw error;
  }
}

function checkedIdentity(graph) {
  const hash = createHash('sha256').update(process.versions.node);
  for (const file of [...graph.files.keys()].filter(file => ['scripts/check-changed.mjs', 'package.json', 'package-lock.json', '.node-version'].includes(file) || !file.includes('/') && /config.*\.(?:json|[cm]?js|ts)$/.test(file)).sort()) hash.update(file).update('\0').update(graph.files.get(file)).update('\0');
  return hash.digest('hex');
}

async function sourceFingerprints(root, paths) {
  return Object.fromEntries(await Promise.all(paths.map(async file => {
    let content;
    try { content = await readFile(join(root, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; content = '<missing>'; }
    return [file, createHash('sha256').update(content).digest('hex')];
  })));
}

function plannedFingerprint(graph, file, plan, sources) {
  const signature = testFingerprint(graph, file, process.versions.node, plan.full);
  if (!plan.full) return signature;
  return createHash('sha256').update(signature).update(JSON.stringify(sources)).digest('hex');
}

export async function checkChanged({ root, paths, list = false, noCache = false, engine = false, runner = run, pythonIdentity = readPythonIdentity, discoverChanges = changedFiles, log = console.log }) {
  root = resolve(root);
  const graph = await buildDependencyGraph(root);
  const cachePath = join(root, 'outputs', 'changed-checks-cache.json');
  const cacheRecord = await readCache(cachePath);
  const cache = cacheRecord.passed;
  const requested = [...new Set((paths ?? await discoverChanges(root)).map(file => projectPath(root, file)))].sort();
  const requestedSources = await sourceFingerprints(root, requested);
  const identity = checkedIdentity(graph);
  const checkedSources = cacheRecord.checkedIdentity === identity && cacheRecord.checkedSources && typeof cacheRecord.checkedSources === 'object' ? cacheRecord.checkedSources : {};
  let backendVerified = false;
  const backendPath = file => file.startsWith('backend/') || file === 'scripts/check-engine.mjs';
  if (!paths && !noCache && engine && !list && requested.some(backendPath) && cacheRecord.engine) {
    backendVerified = engineFingerprint(graph, await pythonIdentity(root)) === cacheRecord.engine;
  }
  const pending = paths || noCache ? requested : requested.filter(file => checkedSources[file] !== requestedSources[file] || backendPath(file) && !backendVerified);
  const plan = planChangedChecks(graph, pending);
  const sources = Object.fromEntries(plan.changed.map(file => [file, requestedSources[file]]));
  const fingerprints = Object.fromEntries(plan.nodeTests.map(file => [file, plannedFingerprint(graph, file, plan, sources)]));
  const cached = plan.nodeTests.filter(file => !noCache && cache[file] === fingerprints[file]);
  const tests = plan.nodeTests.filter(file => !cached.includes(file));
  const previouslyChecked = requested.length - plan.changed.length;
  log(`${plan.changed.length} changed files; ${plan.nodeTests.length} affected Node test files; ${cached.length} unchanged passing files cached; ${tests.length} to run.`);
  if (previouslyChecked) log(`${previouslyChecked} unchanged dirty files already passed checks and were excluded from selection.`);
  for (const reason of plan.reasons) log(`Full Node test selection: ${reason}`);
  for (const file of tests) log(`  ${file}`);
  if (plan.untested.length) log(`No imported Node test covers: ${plan.untested.join(', ')}. Typecheck and browser verification still apply.`);
  if (plan.browserTests.length) {
    log(`${plan.browserTests.length} browser specs may be affected. Browser checks require a current build and run separately:`);
    log(plan.browserTests.length > 12 ? '  npm run test:browser' : `  npm run test:browser -- ${plan.browserTests.join(' ')}`);
  }
  if (plan.python) log(engine ? 'Python changed. Engine lint and tests are included unless their inputs match a passing cached run.' : 'Python changed. Run npm run engine:check and npm run engine:test separately. Node checks do not validate the engine.');
  if (!plan.changed.length) log('No unchecked file changes found. Browser checks run separately.');
  let cacheChanged = false;
  let engineStatus = plan.python ? engine ? 'planned' : 'required' : 'unchanged';
  if (!list && tests.length) {
    try { await runner(process.execPath, ['--test', ...tests], { cwd: root }); }
    catch (error) {
      for (const file of tests) delete cache[file];
      await writeCache(cachePath, { passed: cache, ...(cacheRecord.engine ? { engine: cacheRecord.engine } : {}) });
      throw error;
    }
    const after = await buildDependencyGraph(root);
    const afterSources = await sourceFingerprints(root, plan.changed);
    for (const file of tests) if (plannedFingerprint(after, file, plan, afterSources) === fingerprints[file]) cache[file] = fingerprints[file];
    cacheChanged = true;
  }
  if (!list && plan.python && engine) {
    const signature = engineFingerprint(await buildDependencyGraph(root), await pythonIdentity(root));
    if (!noCache && cacheRecord.engine === signature) {
      engineStatus = 'cached';
      backendVerified = true;
      log('Python lint and tests match the passing cache.');
    } else {
      try {
        await runner(process.execPath, ['scripts/check-engine.mjs', 'lint'], { cwd: root });
        await runner(process.execPath, ['scripts/check-engine.mjs', 'test'], { cwd: root });
      } catch (error) {
        for (const file of Object.keys(checkedSources)) if (backendPath(file)) delete checkedSources[file];
        await writeCache(cachePath, { passed: cache, checkedIdentity: identity, checkedSources });
        throw error;
      }
      const after = engineFingerprint(await buildDependencyGraph(root), await pythonIdentity(root));
      if (after === signature) { cacheRecord.engine = signature; cacheChanged = true; backendVerified = true; }
      engineStatus = 'passed';
    }
  }
  if (!list && plan.changed.length) {
    const afterSources = await sourceFingerprints(root, plan.changed);
    const afterGraph = await buildDependencyGraph(root);
    const nodeVerified = plan.nodeTests.length > 0 && plan.nodeTests.every(file => cache[file] === fingerprints[file] && plannedFingerprint(afterGraph, file, plan, afterSources) === fingerprints[file]);
    const covered = closure(plan.nodeTests, graph.dependencies);
    for (const file of plan.changed) {
      const verified = backendPath(file) ? backendVerified : nodeVerified && !plan.untested.includes(file) && (covered.has(file) || plan.full && plan.nodeTests.length > 0);
      if (verified && afterSources[file] === sources[file]) { checkedSources[file] = sources[file]; cacheChanged = true; }
    }
  }
  if (!list && cacheChanged) {
    await writeCache(cachePath, { passed: cache, checkedIdentity: identity, checkedSources, ...(cacheRecord.engine ? { engine: cacheRecord.engine } : {}) });
  }
  return { ...plan, tests, cached, engineStatus, previouslyChecked };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.find(argument => argument.startsWith('--') && !['--list', '--no-cache', '--engine'].includes(argument));
  if (unknown) throw new Error(`Unknown option: ${unknown}`);
  const paths = args.filter(argument => !argument.startsWith('--'));
  await checkChanged({ root: fileURLToPath(new URL('..', import.meta.url)), paths: paths.length ? paths : undefined, list: args.includes('--list'), noCache: args.includes('--no-cache'), engine: args.includes('--engine') });
}
