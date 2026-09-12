import { readFileSync, readdirSync } from 'fs';
import { relative, resolve } from 'path';
import { cssRule } from '../helpers/cssRule';
import { DEFAULT_SYNTAX_THEME_ID } from '../../components/Editor/codemirror/palettes';
import { syntaxPaletteVars } from '../../utils/searchTokens';

// jsdom resolves no CSS from a module, so this reads the sources directly.
//
// A `var(--x)` whose `--x` is declared nowhere makes the whole declaration
// invalid at computed-value time: `border: 1px solid var(--x)` resets to
// `none`, `background: var(--x)` to transparent, with no console warning. This
// guards every stylesheet under src against that. `var(--x, fallback)` is
// checked too: a valid fallback keeps the declaration alive, but an undeclared
// name there means the fallback is what renders. A literal fallback has no tie
// to tokens.css and drifts; a nested var() fallback still resolves through its
// token, and the absent outer name is then dead indirection.
//
// A reference is declared when the name is
//   - a `:root` token in styles/tokens.css (the `[data-accent]` blocks only
//     override tokens that `:root` already declares, so `:root` is the whole
//     vocabulary), or
//   - declared anywhere in the same stylesheet (a local such as `--rail-key`), or
//   - set from TS/TSX as a quoted literal: `style={{ '--x': ... }}`,
//     `setProperty('--x', ...)`, or
//   - produced by a generator that builds names from a template, such as
//     `--syntax-${role}`: those are only known by running it, so each
//     generator is called below and its actual keys are the declared set. A
//     prefix or literal-suffix heuristic would let `--syntax-error` through
//     on the strength of unrelated `'error'` strings.
//
// Ceiling: this checks that every name is known somewhere, not that it
// resolves where it is used. A script-set property is accepted in any
// stylesheet, so a rule that must use only `:root` tokens keeps its own
// guard (MergeResolutionView's `.dialog`). The script scan is a quoted-token
// scan over the raw source, comments included, not a type check: a name
// built as `'--' + x`, or by a generator not listed in GENERATED, is
// invisible to it; a stylesheet referencing one fails here, on purpose, and
// the fix is to list the generator. The CSS scan is likewise a token scan,
// not a parser: it reads `var(` inside strings, url() and @supports probes,
// misses escaped names, and comment stripping can fuse neighbouring tokens.
// None occur in this tree.

const SRC = resolve(__dirname, '../..');

function sources(extension: RegExp, exclude?: RegExp): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => extension.test(file) && !exclude?.test(file))
    .map((file) => resolve(SRC, file))
    .sort();
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function declarations(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
}

const rootTokens = declarations(
  cssRule(readFileSync(resolve(SRC, 'styles/tokens.css'), 'utf8'), ':root')
);

// readdirSync joins with the platform separator, so the exclusion accepts
// either. The suffixes mirror jest.config.cjs testMatch.
const TESTS = /(^|[\\/])__tests__[\\/]|\.(test|spec)\.tsx?$/;
const scripts = sources(/\.tsx?$/, TESTS)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const scriptNames = new Set([...scripts.matchAll(/['"`](--[\w-]+)['"`]/g)].map((m) => m[1]));

// Every generator that emits custom-property names from a template. The theme
// only picks values; the key set is the same for each.
const GENERATED = new Set(Object.keys(syntaxPaletteVars(DEFAULT_SYNTAX_THEME_ID)));

it('every stylesheet references only custom properties declared in :root, itself, or a script', () => {
  const stylesheets = sources(/\.css$/, TESTS);
  // A wrong SRC would scan nothing and pass; the floor makes that loud.
  expect(stylesheets.length).toBeGreaterThan(0);

  const undeclared = stylesheets.flatMap((file) => {
    const css = stripComments(readFileSync(file, 'utf8'));
    const local = declarations(css);
    // CSS function names are case-insensitive; custom-property names are not.
    return [...css.matchAll(/var\(\s*(--[\w-]+)\s*[,)]/gi)]
      .map((match) => match[1])
      .filter(
        (name) =>
          !rootTokens.has(name) &&
          !local.has(name) &&
          !scriptNames.has(name) &&
          !GENERATED.has(name)
      )
      .map((name) => `${relative(SRC, file)}: var(${name})`);
  });

  expect([...new Set(undeclared)]).toEqual([]);
});
