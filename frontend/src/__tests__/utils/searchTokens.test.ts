import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import {
  searchTokenHighlighter,
  SEARCH_TOKEN_ROLES,
  parseLineTokens,
  MAX_SEARCH_HIGHLIGHT_CHARS,
  MAX_SEARCH_TOKEN_RANGES,
  buildLineRenderModel,
  type LineRenderPart,
} from '../../utils/searchTokens';
import type { TokenRange } from '../../utils/searchTokens';
import { syntaxPaletteVars } from '../../utils/searchTokens';
import { getSyntaxPalette } from '../../components/Editor/codemirror/palettes';

const tsSupport = javascript({ typescript: true });

describe('searchTokenHighlighter', () => {
  it('maps representative tags to tok-<role> classes', () => {
    expect(searchTokenHighlighter.style([t.keyword])).toBe('tok-keyword');
    expect(searchTokenHighlighter.style([t.string])).toBe('tok-string');
    expect(searchTokenHighlighter.style([t.lineComment])).toBe('tok-comment');
    expect(searchTokenHighlighter.style([t.number])).toBe('tok-number');
    expect(searchTokenHighlighter.style([t.typeName])).toBe('tok-type');
    expect(searchTokenHighlighter.style([t.propertyName])).toBe('tok-property');
    expect(searchTokenHighlighter.style([t.tagName])).toBe('tok-tag');
    expect(searchTokenHighlighter.style([t.attributeName])).toBe('tok-attribute');
    expect(searchTokenHighlighter.style([t.regexp])).toBe('tok-regexp');
    expect(searchTokenHighlighter.style([t.escape])).toBe('tok-escape');
    expect(searchTokenHighlighter.style([t.meta])).toBe('tok-decorator');
    expect(searchTokenHighlighter.style([t.operator])).toBe('tok-operator');
    expect(searchTokenHighlighter.style([t.punctuation])).toBe('tok-punctuation');
  });

  it('prefers the function role over the base variable role', () => {
    expect(searchTokenHighlighter.style([t.function(t.variableName)])).toBe('tok-function');
    expect(searchTokenHighlighter.style([t.variableName])).toBe('tok-variable');
  });

  it('collapses bool/null/atom to the constant role', () => {
    expect(searchTokenHighlighter.style([t.bool])).toBe('tok-constant');
    expect(searchTokenHighlighter.style([t.null])).toBe('tok-constant');
    expect(searchTokenHighlighter.style([t.atom])).toBe('tok-constant');
  });

  it('exposes exactly the 16 emitted roles', () => {
    expect([...SEARCH_TOKEN_ROLES].sort()).toEqual(
      [
        'attribute',
        'comment',
        'constant',
        'decorator',
        'escape',
        'function',
        'keyword',
        'number',
        'operator',
        'property',
        'punctuation',
        'regexp',
        'string',
        'tag',
        'type',
        'variable',
      ].sort()
    );
  });
});

describe('parseLineTokens', () => {
  it('returns ordered role ranges for a TypeScript line', () => {
    const line = 'const answer = 42;';
    const tokens = parseLineTokens(line, tsSupport);
    expect(tokens).not.toBeNull();
    for (let i = 1; i < tokens!.length; i++) {
      expect(tokens![i].from).toBeGreaterThanOrEqual(tokens![i - 1].to);
    }
    const classes = tokens!.map((r) => r.className);
    expect(classes).toContain('tok-keyword'); // const
    expect(classes).toContain('tok-number'); // 42
    expect(tokens!.every((r) => r.className.length > 0)).toBe(true);
  });

  it('maps Markdown heading text to the function role', () => {
    const line = '# Firn search';
    const headingStart = line.indexOf('Firn');
    const tokens = parseLineTokens(line, markdown());
    const heading = tokens?.find((token) => token.from <= headingStart && token.to === line.length);

    expect(heading?.className.split(' ')).toContain('tok-function');
  });

  it('skips parsing lines longer than the character ceiling', () => {
    const line = 'a'.repeat(MAX_SEARCH_HIGHLIGHT_CHARS + 1);
    expect(parseLineTokens(line, tsSupport)).toBeNull();
  });

  it('falls back to null when a line exceeds the token-range ceiling', () => {
    const line = 'a+'.repeat(MAX_SEARCH_TOKEN_RANGES + 10);
    expect(line.length).toBeLessThanOrEqual(MAX_SEARCH_HIGHLIGHT_CHARS);
    expect(parseLineTokens(line, tsSupport)).toBeNull();
  });

  it('returns null when the parser throws', () => {
    const broken = {
      language: {
        parser: {
          parse() {
            throw new Error('boom');
          },
        },
      },
    } as unknown as typeof tsSupport;
    expect(parseLineTokens('anything', broken)).toBeNull();
  });
});

// Convenience: reconstruct the visible text a model would render (excluding the
// render-only indent trim), to prove no characters are lost or reordered.
function renderedText(parts: LineRenderPart[]): string {
  return parts
    .map((p) => (p.kind === 'match' ? p.text : p.pieces.map((pc) => pc.text).join('')))
    .join('');
}

// All classed (colored) pieces across the whole model, in order.
function classedPieces(parts: LineRenderPart[]): { text: string; className: string }[] {
  return parts
    .flatMap((p) => (p.kind === 'context' ? p.pieces : []))
    .filter((pc): pc is { text: string; className: string } => pc.className !== null);
}

describe('buildLineRenderModel', () => {
  it('with no tokens reproduces #207 segments (one lead + trailing context, whole mark)', () => {
    const text = '  const foo = bar;';
    const submatches = [{ start: 8, end: 11 }]; // "foo"
    const parts = buildLineRenderModel(text, submatches, []);
    expect(parts.map((p) => p.kind)).toEqual(['context', 'match', 'context']);
    const lead = parts[0];
    expect(lead.kind === 'context' && lead.isLead).toBe(true);
    expect(lead.kind === 'context' && lead.pieces.map((p) => p.text).join('')).toBe('const ');
    expect(parts[1].kind === 'match' && parts[1].text).toBe('foo');
  });

  it('clips a straddling token to color context on both sides of a match, never the mark', () => {
    const text = 'a foo b'; // a[0] (sp)[1] f[2]o[3]o[4] (sp)[5] b[6]
    const submatches = [{ start: 2, end: 5 }]; // "foo"
    const tokens: TokenRange[] = [{ from: 0, to: 7, className: 'tok-variable' }];
    const parts = buildLineRenderModel(text, submatches, tokens);
    const marks = parts.filter((p) => p.kind === 'match');
    expect(marks).toHaveLength(1);
    expect(marks[0].kind === 'match' && marks[0].text).toBe('foo');
    expect(classedPieces(parts)).toEqual([
      { text: 'a ', className: 'tok-variable' },
      { text: ' b', className: 'tok-variable' },
    ]);
    expect(renderedText(parts)).toBe(text);
  });

  it('preserves per-token coloring across two matches', () => {
    const text = 'k a m b n'; // k[0] a[2] m[4] b[6] n[8]
    const submatches = [
      { start: 2, end: 3 }, // a
      { start: 6, end: 7 }, // b
    ];
    const tokens: TokenRange[] = [
      { from: 0, to: 1, className: 'tok-keyword' },
      { from: 4, to: 5, className: 'tok-type' },
      { from: 8, to: 9, className: 'tok-variable' },
    ];
    const parts = buildLineRenderModel(text, submatches, tokens);
    expect(parts.filter((p) => p.kind === 'match')).toHaveLength(2);
    expect(classedPieces(parts)).toEqual([
      { text: 'k', className: 'tok-keyword' },
      { text: 'm', className: 'tok-type' },
      { text: 'n', className: 'tok-variable' },
    ]);
    expect(renderedText(parts)).toBe(text);
  });

  it('keeps UTF-16 boundaries for CJK, surrogate-pair emoji, and combining marks', () => {
    const text = '🙂漢é const';
    const constIdx = text.indexOf('const');
    const submatches: { start: number; end: number }[] = [];
    const tokens: TokenRange[] = [{ from: constIdx, to: constIdx + 5, className: 'tok-keyword' }];
    const parts = buildLineRenderModel(text, submatches, tokens);
    expect(renderedText(parts)).toBe(text);
    const keywordPiece = classedPieces(parts).find((pc) => pc.className === 'tok-keyword');
    expect(keywordPiece?.text).toBe('const');
  });

  it('aligns UTF-8 byte submatches with UTF-16 Lezer token offsets jointly', () => {
    const text = '🙂 const x';
    const enc = new TextEncoder();
    const matchStart = enc.encode('🙂 const ').length; // byte offset of "x"
    const submatches = [{ start: matchStart, end: matchStart + 1 }];
    const kw = text.indexOf('const');
    const tokens: TokenRange[] = [{ from: kw, to: kw + 5, className: 'tok-keyword' }];
    const parts = buildLineRenderModel(text, submatches, tokens);
    const match = parts.find((p) => p.kind === 'match')!;
    expect(match.kind === 'match' && match.text).toBe('x');
    expect(classedPieces(parts).find((p) => p.className === 'tok-keyword')?.text).toBe('const');
    expect(renderedText(parts)).toBe(text);
  });

  it('drops leading-whitespace pieces from the lead even when prose follows', () => {
    const text = '    return foo;';
    const submatches = [{ start: 11, end: 14 }]; // "foo"
    const tokens: TokenRange[] = [{ from: 4, to: 10, className: 'tok-keyword' }]; // "return"
    const parts = buildLineRenderModel(text, submatches, tokens);
    const lead = parts[0];
    expect(lead.kind).toBe('context');
    const leadText = lead.kind === 'context' ? lead.pieces.map((p) => p.text).join('') : '';
    expect(leadText).toBe('return ');
  });

  it('walks many alternating tokens and matches in a single pass, preserving order', () => {
    const text = 'a b c d e';
    const submatches = [
      { start: 0, end: 1 }, // a
      { start: 4, end: 5 }, // c
    ];
    const tokens: TokenRange[] = [
      { from: 2, to: 3, className: 'tok-variable' },
      { from: 6, to: 7, className: 'tok-variable' },
      { from: 8, to: 9, className: 'tok-variable' },
    ];
    const parts = buildLineRenderModel(text, submatches, tokens);
    expect(renderedText(parts)).toBe(text);
    expect(parts.filter((p) => p.kind === 'match')).toHaveLength(2);
  });

  it('emits no lead part when the leading context is whitespace-only', () => {
    const text = '   foo'; // 3 spaces then the match
    const parts = buildLineRenderModel(text, [{ start: 3, end: 6 }], []);
    // The trimmed-to-empty lead contributes no part: the match is first.
    expect(parts[0].kind).toBe('match');
    expect(parts[0].kind === 'match' && parts[0].text).toBe('foo');
  });
});

describe('syntaxPaletteVars', () => {
  it('emits one --syntax-<role> var per emitted role, and nothing else', () => {
    const vars = syntaxPaletteVars('glacier');
    const keys = Object.keys(vars);
    expect(keys.sort()).toEqual(SEARCH_TOKEN_ROLES.map((r) => `--syntax-${r}`).sort());
    expect(keys).not.toContain('--syntax-background');
    expect(keys).not.toContain('--syntax-param');
  });

  it('reads colors from the requested palette', () => {
    const palette = getSyntaxPalette('reef');
    const vars = syntaxPaletteVars('reef') as Record<string, string>;
    expect(vars['--syntax-keyword']).toBe(palette.keyword);
    expect(vars['--syntax-string']).toBe(palette.string);
  });

  it('falls back to the default palette for an unknown id', () => {
    const fallback = getSyntaxPalette('abyssal');
    const vars = syntaxPaletteVars('nope' as never) as Record<string, string>;
    expect(vars['--syntax-keyword']).toBe(fallback.keyword);
  });
});
