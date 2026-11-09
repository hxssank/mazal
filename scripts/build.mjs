import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
import { collectRelease } from './release.mjs';
import { verifyNodeDependencies, writeBuildIdentity } from './build-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { manifest } = await collectRelease(root);
if (process.versions.node !== manifest.nodeVersion) throw new Error(`Build with Node.js ${manifest.nodeVersion}; found ${process.versions.node}.`);
await verifyNodeDependencies(root);
await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: root });
await run(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root });
const identity = await writeBuildIdentity(root, manifest);
console.log(`Verified web build ${identity.version}, source ${identity.sourceSha256}.`);
