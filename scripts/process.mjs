import { spawn } from 'node:child_process';

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', error => reject(new Error(`Could not start ${command}: ${error.message}`)));
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${signal ?? code}.`)));
  });
}

export function runNpm(args, options = {}) {
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args], options);
  if (process.platform !== 'win32') return run('npm', args, options);
  if (args.some(argument => !/^[A-Za-z0-9_:@./=-]+$/.test(argument))) throw new Error('Unsupported npm argument.');
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], options);
}
