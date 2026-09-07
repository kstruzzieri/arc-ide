import {
  SYNTAX_THEMES,
  SYNTAX_THEME_BY_ID,
  DEFAULT_SYNTAX_THEME_ID,
  getSyntaxPalette,
  isSyntaxThemeId,
  type SyntaxPalette,
  type SyntaxThemeId,
} from '../../../../components/Editor/codemirror/palettes';
import { readFileSync } from 'fs';
import { resolve } from 'path';

type RGB = [number, number, number];

const themeSource = readFileSync(
  resolve(__dirname, '../../../../components/Editor/codemirror/theme.ts'),
  'utf8'
);
const searchPanelSource = readFileSync(
  resolve(__dirname, '../../../../components/Search/SearchPanel.module.css'),
  'utf8'
);

// Derive role keys from a live palette so a new SyntaxPalette field is auto-covered.
const ROLES = Object.keys(SYNTAX_THEMES[0].palette) as (keyof SyntaxPalette)[];

// Relative luminance + contrast ratio (WCAG) for the comment-contrast guard.
function parseHex(hex: string): RGB {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as RGB;
}

function activeLineBackground(background: string): RGB {
  const channels = themeSource
    .match(/activeLine:\s*'rgba\(([^)]+)\)'/)?.[1]
    .split(',')
    .map(Number);
  if (!channels || channels.length !== 4) throw new Error('Missing CodeMirror active-line color');
  const canvas = parseHex(background);
  return channels
    .slice(0, 3)
    .map((channel, index) => channel * channels[3] + canvas[index] * (1 - channels[3])) as RGB;
}

function luminance(rgb: RGB): number {
  const lin = rgb
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: RGB, b: RGB): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function searchTokenWeight(selector: string): number | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = searchPanelSource.matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm'));
  for (const block of blocks) {
    const percent = block[1].match(/--search-token-weight:\s*([\d.]+)%/)?.[1];
    if (percent !== undefined) return Number(percent) / 100;
  }
  return null;
}

describe('syntax palette registry', () => {
  it('exposes 7 themes in a stable order', () => {
    expect(SYNTAX_THEMES.map((t) => t.id)).toEqual([
      'glacier',
      'solar',
      'reef',
      'nebula',
      'bifrost',
      'aurora',
      'abyssal',
    ]);
  });

  it('default theme id exists in the registry', () => {
    expect(SYNTAX_THEME_BY_ID.has(DEFAULT_SYNTAX_THEME_ID)).toBe(true);
    expect(DEFAULT_SYNTAX_THEME_ID).toBe('abyssal');
  });

  it('every theme defines every palette role as a non-empty string', () => {
    for (const theme of SYNTAX_THEMES) {
      expect(theme.label.length).toBeGreaterThan(0);
      for (const role of ROLES) {
        expect(typeof theme.palette[role]).toBe('string');
        expect(theme.palette[role]).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('has unique ids and a lookup map covering all themes', () => {
    const ids = SYNTAX_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(SYNTAX_THEME_BY_ID.get(id as SyntaxThemeId)?.id).toBe(id);
    }
  });

  it('never makes number and constant byte-identical within a theme', () => {
    for (const theme of SYNTAX_THEMES) {
      expect(theme.palette.number.toLowerCase()).not.toBe(theme.palette.constant.toLowerCase());
    }
  });

  it('keeps comment contrast at or above 4.5:1 on each active-line background', () => {
    for (const theme of SYNTAX_THEMES) {
      const ratio = contrast(
        parseHex(theme.palette.comment),
        activeLineBackground(theme.palette.background)
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('isSyntaxThemeId guards unknown values', () => {
    for (const theme of SYNTAX_THEMES) {
      expect(isSyntaxThemeId(theme.id)).toBe(true);
    }
    expect(isSyntaxThemeId('nope')).toBe(false);
    expect(isSyntaxThemeId(null)).toBe(false);
    expect(isSyntaxThemeId(42)).toBe(false);
  });

  it('getSyntaxPalette returns the matching palette and falls back to the default for unknown ids', () => {
    expect(getSyntaxPalette('reef')).toBe(SYNTAX_THEME_BY_ID.get('reef')!.palette);
    // Unknown id falls back to the default (abyssal) palette.
    expect(getSyntaxPalette('does-not-exist' as SyntaxThemeId)).toBe(
      SYNTAX_THEME_BY_ID.get(DEFAULT_SYNTAX_THEME_ID)!.palette
    );
  });
});

describe('search result token contrast', () => {
  // Emitted search roles (mirror SEARCH_TOKEN_ROLES in utils/searchTokens.ts).
  const SEARCH_ROLES: (keyof SyntaxPalette)[] = [
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
  ];
  // From styles/tokens.css (single dark chrome theme).
  const SECONDARY = parseHex('#94a3b8');
  const SURFACES = { panel: parseHex('#0f172a'), hover: parseHex('#1e293b') };

  // color-mix(in srgb, token W, --text-secondary) — gamma-encoded channel lerp.
  function mix(token: RGB, weight: number): RGB {
    return token.map((c, i) => c * weight + SECONDARY[i] * (1 - weight)) as RGB;
  }

  it('keeps every emitted role at or above 4.5:1 for all themes, weights, and surfaces', () => {
    const normalWeight = searchTokenWeight('.resultRow');
    const focusWeight = searchTokenWeight('.resultRow.focused');
    expect({ normal: normalWeight, focus: focusWeight }).toEqual({ normal: 0.4, focus: 0.55 });
    if (normalWeight === null || focusWeight === null) {
      throw new Error('Missing search token weight declaration');
    }
    const weights = { normal: normalWeight, focus: focusWeight };
    const failures: string[] = [];
    for (const theme of SYNTAX_THEMES) {
      for (const role of SEARCH_ROLES) {
        const token = parseHex(theme.palette[role]);
        for (const [wName, w] of Object.entries(weights)) {
          const color = mix(token, w);
          for (const [sName, surface] of Object.entries(SURFACES)) {
            const ratio = contrast(color, surface);
            if (ratio < 4.5) {
              failures.push(`${theme.id}/${role}/${wName}/${sName}=${ratio.toFixed(2)}`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
