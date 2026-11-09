import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBoundaries, readBoundarySources } from './check-boundaries.mjs';

test('browser imports and type-only contracts cannot reach Node or backend modules', () => {
  const violations = checkBoundaries([{ path: 'src/features/home/Home.tsx', source: [
    "import { load } from '../../../server/store.ts';",
    "import type { Document } from '../../../server/documents.ts';",
    "import '../../../backend/mazal_engine/app.py';",
    "import { readFile } from 'fs/promises';",
    "import type { Worker } from 'node:worker_threads';",
  ].join('\n') }]);
  assert.equal(violations.length, 5);
  assert.deepEqual(violations.map(violation => violation.line), [1, 2, 3, 4, 5]);
  assert.ok(violations.every(violation => violation.file === 'src/features/home/Home.tsx' && violation.column > 1));
});

test('re-exports, dynamic imports, import-type queries and import equals follow the same boundaries', () => {
  const violations = checkBoundaries([{ path: 'src/services/records.ts', source: [
    "export { App } from '../app/App.tsx';",
    "export type { Props } from '../components/Button.tsx';",
    "const load = () => import('../features/home/Home.tsx');",
    'const hook = () => import(`../hooks/useDraft.ts`);',
    "type View = import('../app/navigation.ts').View;",
    "import fs = require('node:fs');",
  ].join('\n') }]);
  assert.equal(violations.length, 6);
  assert.deepEqual(violations.map(violation => violation.line), [1, 2, 3, 4, 5, 6]);
});

test('shared models stay independent and server modules cannot import UI or Python code', () => {
  const violations = checkBoundaries([
    { path: 'shared/models.ts', source: "import '../src/services/api.ts';\nimport '../server/store.ts';\nimport '../backend/models.py';\nimport 'node:crypto';" },
    { path: 'server/routes/records.ts', source: "import '../../src/services/api.ts';\nimport '../../backend/app.py';\nimport 'node:crypto';" },
  ]);
  assert.equal(violations.length, 6);
  assert.equal(violations.filter(violation => violation.file === 'shared/models.ts').length, 4);
  assert.equal(violations.filter(violation => violation.file === 'server/routes/records.ts').length, 2);
});

test('reusable components and hooks cannot depend on app composition', () => {
  const violations = checkBoundaries([
    { path: 'src/components/Button.tsx', source: "import '../app/App.tsx';" },
    { path: 'src/hooks/useRoute.ts', source: "import '../app/navigation.ts';" },
  ]);
  assert.equal(violations.length, 2);
  assert.ok(violations.every(violation => /app composition/.test(violation.message)));
});

test('valid contracts, service dependencies, feature styles and third-party packages remain allowed', () => {
  assert.deepEqual(checkBoundaries([
    { path: 'src/app/App.tsx', source: "import '../features/home/Home.tsx';\nimport '../services/api.ts';\nimport '../components/Icon.tsx';" },
    { path: 'src/services/api.ts', source: "import '../../shared/types.ts';\nimport './engine-api.ts';\nimport { useState } from 'react';" },
    { path: 'src/components/RecordActions.tsx', source: "import '../features/expenses/expense-bills.css';\nimport '../services/api.ts';" },
    { path: 'src/hooks/useMotion.ts', source: "import { gsap } from 'gsap';\nimport '../components/Icon.tsx';" },
    { path: 'shared/models.ts', source: "export type { AppState } from './types.ts';" },
    { path: 'server/routes/records.ts', source: "import '../../shared/types.ts';\nimport '../store.ts';\nimport 'node:fs';" },
  ]), []);
});

test('AST scanning ignores import text in comments, strings and unrelated calls', () => {
  assert.deepEqual(checkBoundaries([{ path: 'src/components/Code.tsx', source: [
    "// import fs from 'node:fs';",
    'const example = "import fs from \'node:fs\'";',
    "const value = api.import('node:fs');",
    "const jsx = <pre>import from node:fs</pre>;",
  ].join('\n') }]), []);
});

test('path normalization catches parent traversal, root imports and Windows file paths', () => {
  const violations = checkBoundaries([
    { path: 'src/services/api.ts', source: "import '../features/../app/App.tsx';\nimport '/server/store.ts?raw';" },
    { path: 'src\\components\\Button.tsx', source: "import '../app/App.tsx';" },
  ]);
  assert.equal(violations.length, 3);
  assert.equal(violations[2].file, 'src/components/Button.tsx');
});

test('test modules and the Python test bridge are excluded without excluding neighboring production files', () => {
  const sources = ['src/api.test.ts', 'server/store.test.ts', 'shared/model.test.tsx', 'src/engine-test-fixture.ts', 'src/engine-test-fixture-extra.ts'].map(path => ({ path, source: "import 'node:fs';" }));
  const violations = checkBoundaries(sources);
  assert.deepEqual(violations.map(violation => violation.file), ['src/engine-test-fixture-extra.ts']);
});

test('CLI exits with a location for violations and succeeds after the import is fixed', t => {
  const root = mkdtempSync(join(tmpdir(), 'mazal-boundaries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['src', 'shared', 'server']) mkdirSync(join(root, directory));
  writeFileSync(join(root, 'src', 'App.tsx'), "import '../server/store.ts';\n");
  writeFileSync(join(root, 'src', 'App.test.ts'), "import 'node:fs';\n");
  writeFileSync(join(root, 'src', 'engine-test-fixture.ts'), "import 'node:child_process';\n");
  assert.deepEqual(readBoundarySources(root).map(source => source.path), ['src/App.tsx']);
  const script = fileURLToPath(new URL('./check-boundaries.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /src\/App.tsx:1:8 .*server or backend/);
  writeFileSync(join(root, 'src', 'App.tsx'), "import type { AppState } from '../shared/types.ts';\n");
  const valid = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /passed for 1 production modules/);
});
