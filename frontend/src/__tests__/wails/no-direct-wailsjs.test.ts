import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import ts from 'typescript';

const SRC = resolve(__dirname, '../..');
const FRONTEND = resolve(SRC, '..');
const ADAPTER_DIR = resolve(SRC, 'wails');
const BINDINGS_DIR = resolve(FRONTEND, 'bindings');

// `wails3 generate bindings` emits one directory per module root under
// frontend/bindings (currently firn/, encoding/json/ and
// github.com/wailsapp/wails/v3/) -- derived here instead of hard-coded so a
// future root wails3 adds is caught automatically rather than silently
// slipping past the generated-path check below.
const BINDING_ROOTS = readdirSync(BINDINGS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const BINDING_ROOTS_PATTERN = BINDING_ROOTS.map((name) =>
  name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
).join('|');
const GENERATED_BINDINGS_RE = new RegExp(
  `(^|[^A-Za-z0-9_])bindings\\/(${BINDING_ROOTS_PATTERN})([\\\\/]|$)`
);
const ALLOWED_GENERATED_IMPORTERS = new Set([
  resolve(ADAPTER_DIR, 'bindings.ts'),
  resolve(ADAPTER_DIR, 'runtime.ts'),
]);
const JEST_MODULE_LOADERS = new Set([
  'createMockFromModule',
  'deepUnmock',
  'doMock',
  'dontMock',
  'mock',
  'requireActual',
  'requireMock',
  'setMock',
  'unmock',
  'unstable_mockModule',
  'unstable_unmockModule',
]);
const RAW_WAILS_GLOBALS = new Set(['go', 'runtime']);
const RAW_GLOBAL_OWNERS = new Set(['window', 'globalThis', 'self', 'top', 'parent']);
const SKIP_DIRS = new Set(['coverage', 'dist', 'node_modules', 'bindings']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

const files = walk(FRONTEND);

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!node.argumentExpression) return null;
  const name = unwrap(node.argumentExpression);
  return ts.isStringLiteralLike(name) ? name.text : null;
}

// isGeneratedPath recognises every specifier that only the two adapters may
// import: the v2 `wailsjs` tree (deleted, but a re-introduction must still be
// caught), the v3 `@wailsio/runtime` package, and the generated output under
// frontend/bindings. `@wailsio/runtime/plugins/*` is build tooling, not app
// runtime, so vite.config.ts may import it freely.
function isGeneratedPath(expression: ts.Expression | undefined): boolean {
  if (!expression) return false;
  const path = unwrap(expression);
  if (!ts.isStringLiteralLike(path)) return false;
  const text = path.text;
  // A wailsjs path segment counts whether it starts the specifier or follows any
  // non-word character (path separator, alias sigil like @ or ~, etc.), so aliased
  // imports such as '@wailsjs/go/main/App' or '~wailsjs/...' are still caught.
  if (/(^|[^A-Za-z0-9_])wailsjs([\\/]|$)/.test(text)) return true;
  // The generated roots (BINDING_ROOTS, read from frontend/bindings above)
  // are matched by name rather than as a bare `bindings` segment, which
  // would also flag the adapter path '../wails/bindings'.
  if (GENERATED_BINDINGS_RE.test(text)) return true;
  if (text === '@wailsio/runtime') return true;
  return text.startsWith('@wailsio/runtime/') && !text.startsWith('@wailsio/runtime/plugins/');
}

function isModuleLoaderCall(node: ts.CallExpression): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  const target = unwrap(node.expression);
  if (ts.isIdentifier(target) && target.text === 'require') return true;
  if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
  const owner = unwrap(target.expression);
  const method = memberName(target);
  return (
    ts.isIdentifier(owner) &&
    ((owner.text === 'module' && method === 'require') ||
      (owner.text === 'jest' && JEST_MODULE_LOADERS.has(method ?? '')))
  );
}

// firstOffenseLine returns the 1-based line number of the first direct generated
// import — wailsjs, @wailsio/runtime, or bindings/ — or raw Wails global access,
// or null when the file uses only the adapters.
// A string-concatenated or template-interpolated dynamic import specifier (e.g.
// `import('../../' + 'wailsjs/go/main/App')`) is outside a static scanner's reach
// by design — this walks a syntax tree, not a value evaluator.
function firstOffenseLine(content: string, filePath = 'probe.ts'): number | null {
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false);
  const mayImportGenerated = ALLOWED_GENERATED_IMPORTERS.has(resolve(filePath));
  let firstPosition = Number.POSITIVE_INFINITY;

  const record = (node: ts.Node) => {
    firstPosition = Math.min(firstPosition, node.getStart(source));
  };
  const visit = (node: ts.Node) => {
    if (!mayImportGenerated) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        isGeneratedPath(node.moduleSpecifier)
      ) {
        record(node);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        isGeneratedPath(node.moduleReference.expression)
      ) {
        record(node);
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        isGeneratedPath(node.argument.literal)
      ) {
        record(node);
      } else if (
        ts.isCallExpression(node) &&
        isModuleLoaderCall(node) &&
        isGeneratedPath(node.arguments[0])
      ) {
        record(node);
      }
    }

    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      RAW_WAILS_GLOBALS.has(memberName(node) ?? '')
    ) {
      const owner = unwrap(node.expression);
      if (ts.isIdentifier(owner) && RAW_GLOBAL_OWNERS.has(owner.text)) record(node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const owner = unwrap(node.initializer);
      if (ts.isIdentifier(owner) && RAW_GLOBAL_OWNERS.has(owner.text)) {
        for (const element of node.name.elements) {
          const boundName = element.propertyName ?? element.name;
          const propName = ts.isIdentifier(boundName) ? boundName.text : null;
          if (propName && RAW_WAILS_GLOBALS.has(propName)) {
            record(element);
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  if (!Number.isFinite(firstPosition)) return null;
  return source.getLineAndCharacterOfPosition(firstPosition).line + 1;
}

const PROBE_FILE = resolve(SRC, 'probe.ts');

const directReferenceCases: Array<[string, string, number, string]> = [
  ['static import', "import { ReadFile } from '../../wailsjs/go/main/App';", 1, PROBE_FILE],
  ['static export', "export * from '../../wailsjs/go/models';", 1, PROBE_FILE],
  ['import type query', 'type Module = typeof import("../../wailsjs/go/main/App");', 1, PROBE_FILE],
  [
    'import type reference',
    'type App = import("../../wailsjs/go/models").main.App;',
    1,
    PROBE_FILE,
  ],
  ['dynamic import', "void import('../../wailsjs/runtime/runtime');", 1, PROBE_FILE],
  [
    'cast dynamic import path',
    "void import('../../wailsjs/runtime/runtime' as string);",
    1,
    PROBE_FILE,
  ],
  ['require', "require('../../wailsjs/runtime');", 1, PROBE_FILE],
  ['cast require path', "require('../../wailsjs/runtime' as string);", 1, PROBE_FILE],
  ['cast require', "(require as any)('../../wailsjs/runtime');", 1, PROBE_FILE],
  ['module require', "module.require('../../wailsjs/runtime');", 1, PROBE_FILE],
  ['computed module require', "module['require']('../../wailsjs/runtime');", 1, PROBE_FILE],
  ['cast module require', "(module as any)['require']('../../wailsjs/runtime');", 1, PROBE_FILE],
  ['Jest mock', "jest.mock('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  ['parenthesized Jest mock path', "jest.mock(('../../wailsjs/go/main/App'));", 1, PROBE_FILE],
  ['Jest element mock', "jest['mock']('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  ['cast Jest mock', "(jest as any).mock('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  ['Jest requireActual', "jest.requireActual('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  ['Jest requireMock', "jest.requireMock('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  ['Jest doMock', "jest.doMock('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  ['Jest dontMock', "jest.dontMock('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  ['Jest setMock', "jest.setMock('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  ['Jest unmock', "jest.unmock('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  ['Jest deepUnmock', "jest.deepUnmock('../../wailsjs/go/main/App');", 1, PROBE_FILE],
  [
    'Jest createMockFromModule',
    "jest.createMockFromModule('../../wailsjs/go/main/App');",
    1,
    PROBE_FILE,
  ],
  [
    'Jest unstable_mockModule',
    "jest.unstable_mockModule('../../wailsjs/go/main/App');",
    1,
    PROBE_FILE,
  ],
  [
    'Jest unstable_unmockModule',
    "jest.unstable_unmockModule('../../wailsjs/go/main/App');",
    1,
    PROBE_FILE,
  ],
  ['dot-form global', 'window.runtime.EventsEmit()', 1, PROBE_FILE],
  ['cast element access', "const go = (window as any)['go'];", 1, PROBE_FILE],
  ['parenthesized element access', "const runtime = (window)['runtime'];", 1, PROBE_FILE],
  ['optional property access', 'const go = window?.go;', 1, PROBE_FILE],
  ['cast element name', "const runtime = window['runtime' as any];", 1, PROBE_FILE],
  ['optional element access', "const go = window?.['go'];", 1, PROBE_FILE],
  [
    'unapproved adapter-directory file',
    "export * from '../../wailsjs/go/models';",
    1,
    resolve(ADAPTER_DIR, 'extra.ts'),
  ],
  ['globalThis property access', 'globalThis.go.CreateTerminal();', 1, PROBE_FILE],
  ['self property access', 'self.runtime.EventsEmit();', 1, PROBE_FILE],
  ['destructured from window', 'const { go } = window;', 1, PROBE_FILE],
  ['destructured from globalThis', 'const { runtime } = globalThis;', 1, PROBE_FILE],
  ['destructured multiple from globalThis', 'const { runtime, go } = globalThis;', 1, PROBE_FILE],
  ['let destructured from window', 'let { go } = window;', 1, PROBE_FILE],
  ['var destructured from window', 'var { runtime } = window;', 1, PROBE_FILE],
  ['aliased path import', "import x from '@wailsjs/go/main/App';", 1, PROBE_FILE],
  ['v3 runtime import', "import { Events } from '@wailsio/runtime';", 1, PROBE_FILE],
  ['v3 runtime subpath import', "import '@wailsio/runtime/foo';", 1, PROBE_FILE],
  ['v3 runtime Jest mock', "jest.mock('@wailsio/runtime');", 1, PROBE_FILE],
  [
    'generated bindings import',
    "import { ReadFile } from '../../bindings/firn/app';",
    1,
    PROBE_FILE,
  ],
  [
    'generated encoding/json bindings import',
    "import { Marshal } from '../../bindings/encoding/json/models';",
    1,
    PROBE_FILE,
  ],
  [
    'generated wails internal bindings import',
    "import { create } from '../../bindings/github.com/wailsapp/wails/v3/internal/eventcreate';",
    1,
    PROBE_FILE,
  ],
];

it.each(directReferenceCases)('detects %s', (_name, content, line, filePath) => {
  expect(firstOffenseLine(content, filePath)).toBe(line);
});

const allowedReferenceCases: Array<[string, string, string]> = [
  ['adapter import', "import { ReadFile } from '../wails/bindings';", PROBE_FILE],
  ['comment', "// import { ReadFile } from '../../wailsjs/go/main/App';", PROBE_FILE],
  ['string', "const note = 'window.go and wailsjs are migration terms';", PROBE_FILE],
  ['unrelated properties', 'config.go; config.runtime; window.runtimeConfig;', PROBE_FILE],
  ['unrelated local identifier named go', 'const go = 1; go + 1;', PROBE_FILE],
  [
    'bindings adapter',
    "export * from '../../wailsjs/go/main/App';",
    resolve(ADAPTER_DIR, 'bindings.ts'),
  ],
  [
    'runtime adapter',
    "export { EventsOn } from '../../wailsjs/runtime/runtime';",
    resolve(ADAPTER_DIR, 'runtime.ts'),
  ],
  [
    'runtime adapter v3 import',
    "import { Events } from '@wailsio/runtime';",
    resolve(ADAPTER_DIR, 'runtime.ts'),
  ],
  [
    'bindings adapter v3 export',
    "export * from '../../bindings/firn/app';",
    resolve(ADAPTER_DIR, 'bindings.ts'),
  ],
  [
    'vite plugin import',
    "import wails from '@wailsio/runtime/plugins/vite';",
    resolve(FRONTEND, 'vite.config.ts'),
  ],
];

it.each(allowedReferenceCases)('allows %s', (_name, content, filePath) => {
  expect(firstOffenseLine(content, filePath)).toBeNull();
});

it('scans a non-trivial number of files (anti-vacuity floor)', () => {
  expect(files.length).toBeGreaterThan(200);
});

it('derives a non-empty set of generated binding roots including firn (anti-vacuity floor)', () => {
  expect(BINDING_ROOTS.length).toBeGreaterThan(0);
  expect(BINDING_ROOTS).toContain('firn');
});

it('scans handwritten frontend files outside src but skips generated output', () => {
  expect(files).toContain(resolve(SRC, '../vite.config.ts'));
  expect(files).not.toContain(resolve(SRC, '../bindings/firn/app.ts'));
});

it('only the two adapters import generated code and no handwritten file reaches the raw v2 globals', () => {
  const offenders: string[] = [];
  for (const f of files) {
    const line = firstOffenseLine(readFileSync(f, 'utf-8'), f);
    if (line !== null) offenders.push(`${f}:${line}`);
  }
  expect(offenders).toEqual([]);
});
