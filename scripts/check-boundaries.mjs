import { readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const codeFile = /\.[cm]?[jt]sx?$/;
const normalized = path => posix.normalize(path.replaceAll('\\', '/'));
const inside = (path, directory) => path === directory || path.startsWith(`${directory}/`);
const excluded = path => /(?:^|\/)[^/]+\.test\.[^/]+$/.test(path) || path === 'src/engine-test-fixture.ts';

function moduleTarget(file, specifier) {
  const path = specifier.split(/[?#]/)[0].replaceAll('\\', '/');
  if (path.startsWith('.')) return posix.normalize(posix.join(posix.dirname(file), path));
  if (path.startsWith('/')) return posix.normalize(path.slice(1));
  return undefined;
}

function boundaryMessage(file, specifier) {
  const target = moduleTarget(file, specifier);
  const nodeModule = specifier.startsWith('node:') || isBuiltin(specifier);
  if (inside(file, 'src')) {
    if (nodeModule) return 'Browser code cannot import Node.js built-ins.';
    if (target && ['server', 'backend'].some(directory => inside(target, directory))) return 'Browser code must use shared contracts instead of importing server or backend code.';
    if (inside(file, 'src/services') && target && ['features', 'app', 'components', 'hooks'].some(directory => inside(target, `src/${directory}`))) return 'Frontend services cannot import UI features, app composition, components, or hooks.';
    if (['components', 'hooks'].some(directory => inside(file, `src/${directory}`)) && target && inside(target, 'src/app')) return 'Reusable components and hooks cannot import app composition.';
  }
  if (inside(file, 'shared')) {
    if (nodeModule) return 'Shared code cannot import Node.js built-ins.';
    if (target && ['src', 'server', 'backend'].some(directory => inside(target, directory))) return 'Shared code cannot depend on frontend, server, or backend modules.';
  }
  if (inside(file, 'server') && target && ['src', 'backend'].some(directory => inside(target, directory))) return 'Server code cannot import frontend or Python backend modules.';
  return undefined;
}

function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression;
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0];
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  return undefined;
}

export function checkBoundaries(sources) {
  const violations = [];
  for (const { path, source } of sources) {
    const file = normalized(path);
    if (excluded(file) || !codeFile.test(file) || !['src', 'shared', 'server'].some(directory => inside(file, directory))) continue;
    const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      const literal = moduleSpecifier(node);
      if (literal && ts.isStringLiteralLike(literal)) {
        const message = boundaryMessage(file, literal.text);
        if (message) {
          const location = syntax.getLineAndCharacterOfPosition(literal.getStart(syntax));
          violations.push({ file, line: location.line + 1, column: location.character + 1, specifier: literal.text, message });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(syntax);
  }
  return violations;
}

export function readBoundarySources(root) {
  const sources = [];
  function visit(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && codeFile.test(path) && !excluded(path)) sources.push({ path, source: readFileSync(join(root, path), 'utf8') });
    }
  }
  for (const directory of ['src', 'shared', 'server']) visit(directory);
  return sources;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sources = readBoundarySources(root);
  const violations = checkBoundaries(sources);
  for (const violation of violations) console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.message} Import: ${violation.specifier}`);
  if (violations.length) process.exitCode = 1;
  else console.log(`Architecture boundaries passed for ${sources.length} production modules.`);
}
