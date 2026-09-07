import { tags as t, tagHighlighter, highlightTree, type Highlighter } from '@lezer/highlight';
import type { LanguageSupport } from '@codemirror/language';
import type { CSSProperties } from 'react';
import type { MatchRange } from '../types/search';
import { splitLineByByteRanges } from './searchRanges';
import { getSyntaxPalette, type SyntaxThemeId } from '../components/Editor/codemirror/palettes';

/**
 * Curated syntax roles the search panel colors. These are exactly the
 * `SyntaxPalette` keys the one-line preview cares about — `background` and
 * `param` are intentionally excluded (`background` is the canvas; `param` is a
 * Python syntax-tree overlay role, not a Lezer tag). Kept in sync by hand with
 * the palette-backed portions of `theme.ts:buildHighlightSpec`; drift is
 * cosmetic in a single-line preview (see the #215 design doc).
 */
export const SEARCH_TOKEN_ROLES = [
  'keyword',
  'string',
  'number',
  'comment',
  'function',
  'type',
  'variable',
  'property',
  'operator',
  'punctuation',
  'constant',
  'tag',
  'attribute',
  'regexp',
  'escape',
  'decorator',
] as const;

export type SearchTokenRole = (typeof SEARCH_TOKEN_ROLES)[number];

// tagHighlighter precedence: more specific tags win, so `function(variableName)`
// overrides the base `variableName` rule and definitions inherit their base role.
export const searchTokenHighlighter: Highlighter = tagHighlighter([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'tok-comment' },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue], class: 'tok-string' },
  { tag: t.escape, class: 'tok-escape' },
  { tag: [t.number, t.integer, t.float], class: 'tok-number' },
  {
    tag: [
      t.keyword,
      t.modifier,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.self,
    ],
    class: 'tok-keyword',
  },
  {
    tag: [
      t.operator,
      t.compareOperator,
      t.arithmeticOperator,
      t.logicOperator,
      t.bitwiseOperator,
      t.updateOperator,
      t.definitionOperator,
    ],
    class: 'tok-operator',
  },
  {
    tag: [
      t.punctuation,
      t.paren,
      t.brace,
      t.bracket,
      t.squareBracket,
      t.separator,
      t.derefOperator,
      t.angleBracket,
    ],
    class: 'tok-punctuation',
  },
  { tag: t.meta, class: 'tok-decorator' },
  { tag: [t.variableName, t.definition(t.variableName)], class: 'tok-variable' },
  { tag: [t.propertyName, t.definition(t.propertyName)], class: 'tok-property' },
  {
    tag: [
      t.function(t.variableName),
      t.definition(t.function(t.variableName)),
      t.function(t.propertyName),
      t.heading,
      t.heading1,
      t.heading2,
      t.heading3,
    ],
    class: 'tok-function',
  },
  { tag: [t.typeName, t.className, t.namespace, t.annotation], class: 'tok-type' },
  {
    tag: [t.constant(t.variableName), t.bool, t.null, t.atom, t.unit],
    class: 'tok-constant',
  },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: t.attributeName, class: 'tok-attribute' },
  { tag: t.regexp, class: 'tok-regexp' },
]);

/** A colored token range in UTF-16 char offsets, in document order. */
export interface TokenRange {
  from: number;
  to: number;
  className: string;
}

/**
 * Cosmetic-work ceilings. Highlighting a one-line preview is never worth
 * blocking the UI: lines longer than this many chars skip parsing entirely, and
 * lines producing more than this many styled ranges fall back to plain context
 * rather than a partially colored row. Both are generous versus the ~100-char
 * visible preview.
 *
 * ponytail: full-line parse with a plain fallback; ranged parsing around visible
 * matches is the upgrade path if pathological lines ever need coloring.
 */
export const MAX_SEARCH_HIGHLIGHT_CHARS = 4_096;
export const MAX_SEARCH_TOKEN_RANGES = 512;

// Panel-level parsing budget: with the per-row range ceiling above, this caps
// aggregate syntax work at 50 × 512 styled ranges. Search still renders every
// result and match mark; rows after this ceiling use the monochrome fallback.
// ponytail: viewport-aware parsing is the upgrade path if this budget proves
// too coarse for larger result sets.
export const MAX_SEARCH_HIGHLIGHTED_ROWS = 50;

/**
 * Parse a single line with the given already-loaded language support and return
 * its colored token ranges, or null when highlighting is skipped (over a
 * ceiling, or the parser/highlighter throws). Lezer offsets and JS string
 * slicing are both UTF-16, so no byte conversion happens here.
 */
export function parseLineTokens(text: string, support: LanguageSupport): TokenRange[] | null {
  if (text.length > MAX_SEARCH_HIGHLIGHT_CHARS) return null;
  try {
    const tree = support.language.parser.parse(text);
    const ranges: TokenRange[] = [];
    let overflowed = false;
    highlightTree(tree, searchTokenHighlighter, (from, to, classes) => {
      if (overflowed) return;
      if (ranges.length >= MAX_SEARCH_TOKEN_RANGES) {
        overflowed = true;
        return;
      }
      ranges.push({ from, to, className: classes });
    });
    return overflowed ? null : ranges;
  } catch (error) {
    console.error('Search token highlight failed:', error);
    return null;
  }
}

/** One inner run of a context segment: raw text plus an optional tok-<role> class. */
export interface RenderPiece {
  text: string;
  className: string | null;
}

export type LineRenderPart =
  | { kind: 'match'; text: string }
  | { kind: 'context'; isLead: boolean; pieces: RenderPiece[] };

const LEADING_INDENT = /^[\t ]+/;

/**
 * Merge #207's outer match/context segments with lezer token ranges in one
 * linear pass. Match segments stay a single unchanged run so their <mark> is
 * untouched; context segments are subdivided at token boundaries. Token ranges
 * that cross into a match color the context on either side but never the match.
 *
 * `tokens` must be ordered and non-overlapping (as produced by parseLineTokens);
 * pass [] to get the pre-#215 monochrome structure. All offsets are UTF-16.
 */
export function buildLineRenderModel(
  text: string,
  submatches: readonly MatchRange[],
  tokens: readonly TokenRange[]
): LineRenderPart[] {
  const segments = splitLineByByteRanges(text, submatches);
  const parts: LineRenderPart[] = [];
  let cursor = 0; // absolute UTF-16 offset at the start of the current segment
  let tokenIndex = 0; // monotonic index into `tokens`

  segments.forEach((segment, segmentIndex) => {
    const segStart = cursor;
    const segEnd = cursor + segment.text.length;
    cursor = segEnd;

    if (segment.isMatch) {
      parts.push({ kind: 'match', text: segment.text });
      // Do not advance tokenIndex here: a token straddling the match must still
      // be available to color the context that follows it.
      return;
    }

    const isLead = segmentIndex === 0;
    // Render-only indent trim (identical to #207 MatchLine): advance the render
    // start past leading whitespace so token offsets stay aligned to `text`.
    let renderStart = segStart;
    if (isLead) {
      const indent = LEADING_INDENT.exec(segment.text)?.[0]?.length ?? 0;
      renderStart = segStart + indent;
    }

    const pieces: RenderPiece[] = [];
    let pos = renderStart;

    while (pos < segEnd) {
      // Skip tokens that end at or before the cursor.
      while (tokenIndex < tokens.length && tokens[tokenIndex].to <= pos) tokenIndex++;
      const token = tokenIndex < tokens.length ? tokens[tokenIndex] : null;
      if (!token || token.from >= segEnd) {
        // No token overlaps the rest of this segment: emit a plain tail.
        pieces.push({ text: text.slice(pos, segEnd), className: null });
        pos = segEnd;
        break;
      }
      if (token.from > pos) {
        pieces.push({ text: text.slice(pos, token.from), className: null });
        pos = token.from;
      }
      const end = Math.min(token.to, segEnd);
      pieces.push({ text: text.slice(pos, end), className: token.className });
      pos = end;
      // Consume the token only if it ends within this segment; a token that
      // straddles into the next segment (or past a match) stays at tokenIndex so
      // it can still color the following context. Match segments never advance
      // tokenIndex, which is what lets a straddling token color both sides.
      if (token.to <= segEnd) tokenIndex++;
    }

    // A lead that trimmed to nothing (whitespace-only) contributes no part, so
    // MatchLine renders the match as the first child (matches #207 behavior).
    if (pieces.length === 0) return;
    parts.push({ kind: 'context', isLead, pieces });
  });

  return parts;
}

/**
 * Inline custom-property style for the search container. React's CSSProperties
 * has no arbitrary custom-property index signature, so the return type is an
 * explicit intersection over the emitted roles only.
 */
export type SearchSyntaxStyle = CSSProperties & Record<`--syntax-${SearchTokenRole}`, string>;

export function syntaxPaletteVars(id: SyntaxThemeId): SearchSyntaxStyle {
  const palette = getSyntaxPalette(id);
  const style = {} as SearchSyntaxStyle;
  for (const role of SEARCH_TOKEN_ROLES) {
    style[`--syntax-${role}`] = palette[role];
  }
  return style;
}
