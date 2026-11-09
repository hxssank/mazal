import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface BuildIdentity {
  readonly version: string;
  readonly sourceSha256: string;
  readonly assetsSha256: string;
  readonly nodeVersion: string;
  readonly pythonVersion: string;
}

export interface RuntimeBuildStatus {
  readonly format: 'mazal-runtime-build';
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly processId: number;
  readonly identityStatus: 'available' | 'missing' | 'invalid';
  readonly build: Readonly<BuildIdentity> | null;
}

export function captureBuildStatus(root: string): Readonly<RuntimeBuildStatus> {
  const runtime = { format: 'mazal-runtime-build' as const, schemaVersion: 1 as const, startedAt: new Date().toISOString(), processId: process.pid };
  try {
    const directory = join(root, 'dist');
    const path = join(directory, 'BUILD.json');
    if (!lstatSync(directory).isDirectory() || !lstatSync(path).isFile()) throw new Error('Build metadata must be a regular file.');
    const identity: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!identity || typeof identity !== 'object') throw new Error('Invalid build metadata.');
    const value = identity as Record<string, unknown>;
    if (value.format !== 'mazal-web-build' || value.schemaVersion !== 1
      || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version)
      || !['sourceSha256', 'assetsSha256'].every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]))
      || !['nodeVersion', 'pythonVersion'].every(key => typeof value[key] === 'string' && /^\d+\.\d+\.\d+$/.test(value[key]))) throw new Error('Invalid build metadata.');
    const build = Object.freeze({ version: value.version, sourceSha256: value.sourceSha256 as string, assetsSha256: value.assetsSha256 as string, nodeVersion: value.nodeVersion as string, pythonVersion: value.pythonVersion as string });
    return Object.freeze({ ...runtime, identityStatus: 'available' as const, build });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return Object.freeze({ ...runtime, identityStatus: missing ? 'missing' as const : 'invalid' as const, build: null });
  }
}
