/**
 * Syntax palettes for the Firn editor theme system.
 *
 * Pure data + id helpers — no React, no CodeMirror imports — so both the editor
 * theme builders and the Zustand store can import from here without cycles.
 *
 * A palette defines ONLY syntax token colors plus the editor canvas `background`.
 * All other editor chrome (borders, tooltip surface, selection, gutters, text)
 * is shared and lives in theme.ts (`colors`).
 */

export interface SyntaxPalette {
  /** Editor canvas + gutter background. */
  background: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  constant: string;
  operator: string;
  punctuation: string;
  /** Plain identifier color. */
  variable: string;
  property: string;
  regexp: string;
  tag: string;
  attribute: string;
  /** String-escape sequences. */
  escape: string;
  /** Decorator marker + name (`@property`). */
  decorator: string;
  /** Keyword-argument / call parameter names (`Foo(id=…)`). */
  param: string;
}

export type SyntaxThemeId =
  | 'glacier'
  | 'solar'
  | 'reef'
  | 'nebula'
  | 'bifrost'
  | 'aurora'
  | 'abyssal';

export interface SyntaxThemeDefinition {
  id: SyntaxThemeId;
  /** Human label shown in the picker. */
  label: string;
  palette: SyntaxPalette;
}

/** Ordered for picker display. Order is product behavior — keep it stable. */
export const SYNTAX_THEMES: readonly SyntaxThemeDefinition[] = [
  {
    id: 'glacier',
    label: 'Firn Glacier',
    palette: {
      background: '#0F172A',
      comment: '#758AA4',
      keyword: '#C4B5FD',
      string: '#86EFAC',
      number: '#FCD34D',
      function: '#7DD3FC',
      type: '#FDA4AF',
      constant: '#F0ABFC',
      operator: '#22D3EE',
      punctuation: '#CBD5E1',
      variable: '#F1F5F9',
      property: '#FDE68A',
      regexp: '#86EFAC',
      tag: '#FDA4AF',
      attribute: '#FCD34D',
      escape: '#22D3EE',
      decorator: '#FBBF24',
      param: '#C084FC',
    },
  },
  {
    id: 'solar',
    label: 'Solar Flare',
    palette: {
      background: '#0F172A',
      comment: '#8E8879',
      keyword: '#FB7185',
      string: '#A3E635',
      number: '#FBBF24',
      function: '#FACC15',
      type: '#2DD4BF',
      constant: '#FB923C',
      operator: '#F472B6',
      punctuation: '#D6D3D1',
      variable: '#FDE68A',
      property: '#FDBA74',
      regexp: '#FCA5A5',
      tag: '#FB7185',
      attribute: '#FBBF24',
      escape: '#F472B6',
      decorator: '#C084FC',
      param: '#67E8F9',
    },
  },
  {
    id: 'reef',
    label: 'Tropic Coral Reef',
    palette: {
      background: '#0F172A',
      comment: '#708D95',
      keyword: '#FF6B9D',
      string: '#5EE6A8',
      number: '#FF9E64',
      function: '#FFC857',
      type: '#22D3EE',
      constant: '#C77DFF',
      operator: '#7DD3FC',
      punctuation: '#8DA9BC',
      variable: '#EAF2F8',
      property: '#FCA5A5',
      regexp: '#5EE6A8',
      tag: '#FF6B9D',
      attribute: '#FFC857',
      escape: '#7DD3FC',
      decorator: '#A78BFA',
      param: '#38BDF8',
    },
  },
  {
    id: 'nebula',
    label: 'Nebula Jewel',
    palette: {
      background: '#0F172A',
      comment: '#7E8999',
      keyword: '#C084FC',
      string: '#FBBF24',
      number: '#FB7185',
      function: '#38BDF8',
      type: '#34D399',
      constant: '#E879F9',
      operator: '#2DD4BF',
      punctuation: '#94A3B8',
      variable: '#E5E7EB',
      property: '#A3E635',
      regexp: '#FBBF24',
      tag: '#C084FC',
      attribute: '#A3E635',
      escape: '#2DD4BF',
      decorator: '#FBBF24',
      param: '#F0ABFC',
    },
  },
  {
    id: 'bifrost',
    label: 'Ember Bifrost',
    palette: {
      background: '#0F172A',
      comment: '#788AA2',
      keyword: '#F97316',
      string: '#7DD3FC',
      number: '#A5B4FC',
      function: '#FBBF24',
      type: '#5EEAD4',
      constant: '#C4B5FD',
      operator: '#FB7185',
      punctuation: '#94A3B8',
      variable: '#E2E8F0',
      property: '#93C5FD',
      regexp: '#67E8F9',
      tag: '#F97316',
      attribute: '#FBBF24',
      escape: '#FB7185',
      decorator: '#F472B6',
      param: '#A78BFA',
    },
  },
  // Aurora Bloom = Ember Bifrost's warm/cool structure rendered in Tropic Reef hues,
  // so it intentionally shares several role colors with `reef`.
  {
    id: 'aurora',
    label: 'Aurora Bloom',
    palette: {
      background: '#0F172A',
      comment: '#708D95',
      keyword: '#FF6B9D',
      string: '#5EE6A8',
      number: '#A5B4FC',
      function: '#FFC857',
      type: '#22D3EE',
      constant: '#C77DFF',
      operator: '#FB7185',
      punctuation: '#8DA9BC',
      variable: '#EAF2F8',
      property: '#7DD3FC',
      regexp: '#67E8F9',
      tag: '#FF6B9D',
      attribute: '#FFC857',
      escape: '#FB7185',
      decorator: '#A78BFA',
      param: '#FBBF24',
    },
  },
  {
    id: 'abyssal',
    label: 'Abyssal Current',
    palette: {
      background: '#08111C',
      comment: '#6A879B',
      keyword: '#F472B6',
      string: '#4ADE80',
      number: '#FBBF24',
      function: '#38BDF8',
      type: '#2DD4BF',
      constant: '#A78BFA',
      operator: '#67E8F9',
      punctuation: '#7A93AB',
      variable: '#CBD7E6',
      property: '#7DD3FC',
      regexp: '#5EEAD4',
      tag: '#F472B6',
      attribute: '#FBBF24',
      escape: '#67E8F9',
      decorator: '#FBBF24',
      param: '#A78BFA',
    },
  },
];

export const SYNTAX_THEME_BY_ID: ReadonlyMap<SyntaxThemeId, SyntaxThemeDefinition> = new Map(
  SYNTAX_THEMES.map((theme) => [theme.id, theme])
);

export const DEFAULT_SYNTAX_THEME_ID: SyntaxThemeId = 'abyssal';

export function isSyntaxThemeId(value: unknown): value is SyntaxThemeId {
  return typeof value === 'string' && SYNTAX_THEME_BY_ID.has(value as SyntaxThemeId);
}

export function getSyntaxPalette(id: SyntaxThemeId): SyntaxPalette {
  return (
    SYNTAX_THEME_BY_ID.get(id) ??
    SYNTAX_THEME_BY_ID.get(DEFAULT_SYNTAX_THEME_ID) ??
    SYNTAX_THEMES[0]
  ).palette;
}
