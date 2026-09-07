import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WORKSPACE_ACCENTS, accentVar } from '../utils/accent';

/**
 * A workspace accent is defined in places no compiler checks against each other:
 * Go emits the string, TypeScript narrows it, CSS resolves it to a colour, and
 * accentVar() looks it up at runtime. Drift is silent — an accent missing from
 * any of them falls back to the neutral "project" accent, so a workspace simply
 * loses its colour with no error anywhere.
 *
 * These tests close that loop.
 */
const repoRoot = resolve(__dirname, '../../..');
const detectGo = readFileSync(resolve(repoRoot, 'internal/workspace/detect.go'), 'utf8');
const tokensCss = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8');
const designSpec = readFileSync(resolve(repoRoot, 'docs/design-specification.md'), 'utf8');

/** The :root block's accent name -> hex, the values the app actually ships. */
function tokenAccentValues(): Record<string, string> {
  const root = tokensCss.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
  if (!root) throw new Error('Missing :root block in tokens.css');
  return Object.fromEntries(
    [...root.matchAll(/^\s*--accent-([a-z]+):\s*(#[0-9a-f]{6})/gm)]
      .filter(([, name]) => !DERIVED_ACCENT_VARS.includes(name))
      .map(([, name, value]) => [name, value.toLowerCase()])
  );
}

/** Accent strings Go can emit: markerRules entries, the frontend special case, and the synthetic project entry. */
function goAccents(): string[] {
  const matches = detectGo.matchAll(
    /(?:accent|Accent):\s*"([a-z]+)"|return\s+Type\w+,\s*"([a-z]+)",\s*true/g
  );
  return [...new Set([...matches].map((m) => m[1] ?? m[2]))].sort();
}

/**
 * Imported, not parsed. The tuple is the single source the type and the runtime
 * lookup are both derived from, so reading it directly is exact — and it cannot
 * silently return [] the way a regex over a refactored file can.
 */
function unionAccents(): string[] {
  return [...WORKSPACE_ACCENTS].sort();
}

/**
 * --accent-dark/dim/glow are per-accent derived values, re-set inside every
 * [data-accent] block rather than being accents themselves. They are excluded by
 * name because that is a structural fact of the token system, not a value list.
 */
const DERIVED_ACCENT_VARS = ['dark', 'dim', 'glow'];

function tokenAccents(): string[] {
  // Scoped to :root so the derived --accent-dark hex inside each [data-accent]
  // block cannot be mistaken for an accent definition.
  const root = tokensCss.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
  if (!root) throw new Error('Missing :root block in tokens.css');
  return [...root.matchAll(/^\s*--accent-([a-z]+):\s*#/gm)]
    .map((m) => m[1])
    .filter((name) => !DERIVED_ACCENT_VARS.includes(name))
    .sort();
}

function dataAccentBlocks(): string[] {
  return [...tokensCss.matchAll(/\[data-accent='([a-z]+)'\]/g)].map((m) => m[1]).sort();
}

/**
 * Every assertion below is a `.filter(...).toEqual([])`, which passes trivially
 * on an empty scan. If detect.go stopped using accent string literals — deriving
 * them from the type, say — the Go scan would silently find nothing and the
 * cross-language guards would all go green while checking nothing at all.
 * These floors make that refactor fail loudly instead.
 */
it('finds the accents it claims to be checking, rather than scanning nothing', () => {
  // Every workspace type a marker rule can currently produce, plus the
  // synthetic project entry. Adding a type should raise this, not bypass it.
  expect(goAccents()).toEqual(
    expect.arrayContaining(['docker', 'frontend', 'go', 'node', 'project', 'python', 'terraform'])
  );
  expect(unionAccents().length).toBeGreaterThanOrEqual(goAccents().length);
  expect(tokenAccents().length).toBeGreaterThanOrEqual(unionAccents().length);
  expect(dataAccentBlocks().length).toBeGreaterThanOrEqual(unionAccents().length);
});

it('resolves every accent through accentVar instead of silently neutralising it', () => {
  // The runtime inventory is the last link in the chain and the easiest to miss:
  // a Set typed as Set<WorkspaceAccent> checks its members, never its
  // completeness, so an accent absent from it type-checks and then quietly
  // renders as "project". Exercising the real function catches that regardless
  // of how the set is built.
  const neutralised = WORKSPACE_ACCENTS.filter(
    (accent) => accent !== 'project' && accentVar(accent) === 'var(--accent-project)'
  );
  expect(neutralised).toEqual([]);

  // And the fallback itself still works for values outside the set.
  expect(accentVar('not-an-accent')).toBe('var(--accent-project)');
  expect(accentVar(undefined)).toBe('var(--accent-project)');
});

it('emits no accent from Go that TypeScript does not accept', () => {
  const union = unionAccents();
  expect(goAccents().filter((accent) => !union.includes(accent))).toEqual([]);
});

it('emits no accent from Go without a --accent-* token', () => {
  const tokens = tokenAccents();
  expect(goAccents().filter((accent) => !tokens.includes(accent))).toEqual([]);
});

it('declares no accent in the union without a token and a [data-accent] block', () => {
  const tokens = tokenAccents();
  const blocks = dataAccentBlocks();
  // 'project' is the neutral fallback and is defined via --accent-project.
  expect(unionAccents().filter((accent) => !tokens.includes(accent))).toEqual([]);
  expect(unionAccents().filter((accent) => !blocks.includes(accent))).toEqual([]);
});

it('leaves no --accent-* token unreachable from the union', () => {
  const union = unionAccents();
  expect(tokenAccents().filter((accent) => !union.includes(accent))).toEqual([]);
});

it('keeps the published design specification in step with the shipped tokens', () => {
  // Doc drift here is not cosmetic: before this guard the specification listed
  // the replaced palette under the current token names, publishing
  // --accent-python: #22C55E — the exact value that collided with --git-added
  // and which this work removed. An implementer following the spec would have
  // reintroduced the bug.
  const specValues = Object.fromEntries(
    [...designSpec.matchAll(/--accent-([a-z]+):\s*(#[0-9a-fA-F]{6})/g)]
      .filter(([, name]) => !DERIVED_ACCENT_VARS.includes(name))
      .map(([, name, value]) => [name, value.toLowerCase()])
  );
  expect(Object.keys(specValues).sort()).toEqual(tokenAccents());
  expect(specValues).toEqual(tokenAccentValues());
});

it('keeps the generic --palette-* ramp out of the workspace accent set', () => {
  // The ramp exists for UI needing distinguishable colours with no workspace
  // meaning. If a palette name leaks into the union, a hue change starts
  // repointing a workspace.
  const ramp = [...tokensCss.matchAll(/^\s*--palette-([a-z]+):/gm)].map((m) => m[1]);
  expect(ramp.length).toBeGreaterThan(0);
  expect(ramp.filter((name) => unionAccents().includes(name))).toEqual([]);
});
