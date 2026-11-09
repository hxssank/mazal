import { spawn } from 'node:child_process';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const valueOptions = new Set([
  '-k', '-m', '-o', '-p', '--override-ini', '--junit-prefix', '--tb', '--capture', '--color',
  '--code-highlight', '--assert', '--import-mode', '--log-level', '--log-format', '--log-date-format',
  '--log-cli-level', '--log-cli-format', '--log-cli-date-format', '--log-file-level',
  '--log-file-format', '--log-file-date-format', '--select', '--extend-select', '--extend-ignore',
  '--per-file-ignores', '--extend-per-file-ignores', '--exclude', '--extend-exclude', '--output-format',
  '--target-version', '--extension',
]);

function backendPath(argument) {
  const [rawPath, ...selection] = argument.split('::');
  const path = rawPath.replaceAll('\\', '/');
  if (!/^(?:\.\/)?(?:backend(?:\/|$)|tests(?:\/|$)|mazal_engine(?:\/|$)|\.\.?\/)/.test(path)) return argument;
  const relativePath = posix.normalize(path.replace(/^(?:\.\/)?backend(?:\/|$)/, '') || '.');
  if (relativePath === '..' || relativePath.startsWith('../')) throw new Error('Choose a path inside backend.');
  return [relativePath, ...selection].join('::');
}

export function engineCheckArguments(mode, additionalArgs = []) {
  if (mode !== 'test' && mode !== 'lint') throw new Error('Choose test or lint.');
  const command = mode === 'test' ? ['pytest'] : ['ruff', 'check'];
  if (!additionalArgs.length) return ['-m', ...command, mode === 'test' ? 'tests' : '.'];
  let value = false;
  let positional = false;
  const args = additionalArgs.map(argument => {
    if (value) { value = false; return argument; }
    if (!positional && argument === '--') { positional = true; return argument; }
    if (!positional && argument.startsWith('-')) {
      value = valueOptions.has(argument) || mode === 'lint' && argument === '--ignore';
      const equals = argument.indexOf('=');
      if (equals > 0 && ['--ignore', '--deselect', '--config', '--confcutdir', '--rootdir'].includes(argument.slice(0, equals))) {
        if (mode === 'lint' && argument.startsWith('--ignore=')) return argument;
        return argument.slice(0, equals + 1) + backendPath(argument.slice(equals + 1));
      }
      return argument;
    }
    return backendPath(argument);
  });
  return ['-m', ...command, ...args];
}

function main() {
  let args;
  try { args = engineCheckArguments(process.argv[2], process.argv.slice(3)); }
  catch (error) { console.error(error.message); process.exitCode = 1; return; }
  const python = join(root, 'backend', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const child = spawn(python, args, { cwd: join(root, 'backend'), stdio: 'inherit' });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', error => {
    console.error(error.code === 'ENOENT' ? 'Set up the local Python environment with npm run engine:setup, then retry.' : error.message);
    process.exitCode = 1;
  });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
