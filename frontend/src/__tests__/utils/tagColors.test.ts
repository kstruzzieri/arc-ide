import { getTagColor } from '../../utils/tagColors';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WORKSPACE_ACCENTS } from '../../utils/accent';

type RGB = [number, number, number];

const tokenCss = readFileSync(resolve(__dirname, '../../styles/tokens.css'), 'utf8');
const cardCss = readFileSync(
  resolve(__dirname, '../../components/RunProfiles/RunProfileCard.module.css'),
  'utf8'
);

const TAG_COLORS = [
  ['dev', { background: 'rgba(56,189,248,0.08)', text: 'rgba(56,189,248,1)' }],
  ['test', { background: 'rgba(168,85,247,0.08)', text: 'rgba(192,132,252,1)' }],
  ['build', { background: 'rgba(245,158,11,0.08)', text: 'rgba(245,158,11,1)' }],
  ['lint', { background: 'rgba(6,182,212,0.08)', text: 'rgba(6,182,212,1)' }],
  ['deploy', { background: 'rgba(239,68,68,0.08)', text: 'rgba(248,113,113,1)' }],
  ['custom', { background: 'rgba(255,255,255,0.04)', text: '#94a3b8' }],
] as const;

function parseColor(value: string): { rgb: RGB; alpha: number } {
  if (value.startsWith('#')) {
    return {
      rgb: [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as RGB,
      alpha: 1,
    };
  }
  const channels = value.match(/[\d.]+/g)?.map(Number);
  if (!channels || channels.length !== 4) throw new Error(`Unsupported color ${value}`);
  return { rgb: channels.slice(0, 3) as RGB, alpha: channels[3] };
}

function composite(foreground: { rgb: RGB; alpha: number }, background: RGB): RGB {
  return foreground.rgb.map(
    (channel, index) => channel * foreground.alpha + background[index] * (1 - foreground.alpha)
  ) as RGB;
}

function luminance(rgb: RGB): number {
  const linear = rgb
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: RGB, b: RGB): number {
  const aLuminance = luminance(a);
  const bLuminance = luminance(b);
  return (Math.max(aLuminance, bLuminance) + 0.05) / (Math.min(aLuminance, bLuminance) + 0.05);
}

function token(name: string): RGB {
  const value = tokenCss.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, 'i'))?.[1];
  if (!value) throw new Error(`Missing hex token --${name}`);
  return parseColor(value).rgb;
}

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = cardCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1];
  if (!body) throw new Error(`Missing CSS rule ${selector}`);
  return body;
}

function backgroundMix(selector: string): number {
  const percentage = rule(selector).match(
    /background:\s*color-mix\(in srgb,\s*var\(--[\w-]+\)\s*([\d.]+)%,\s*var\(--surface-base\)\)/
  )?.[1];
  if (!percentage) throw new Error(`Missing surface-base background mix for ${selector}`);
  return Number(percentage) / 100;
}

function mix(foreground: RGB, background: RGB, alpha: number): RGB {
  return composite({ rgb: foreground, alpha }, background);
}

function cardBackgrounds(): [string, RGB][] {
  const base = token('surface-base');
  const backgrounds: [string, RGB][] = [['base', base]];

  for (const accent of WORKSPACE_ACCENTS) {
    backgrounds.push([
      `${accent} hover`,
      mix(token(`accent-${accent}`), base, backgroundMix('.card:hover')),
    ]);
  }

  backgrounds.push(
    ['running', mix(token('status-success'), base, backgroundMix('.running'))],
    ['failed', mix(token('status-error'), base, backgroundMix('.failed'))]
  );

  for (const accent of WORKSPACE_ACCENTS) {
    backgrounds.push([
      `${accent} selected target`,
      mix(token(`accent-${accent}`), base, backgroundMix('.selectedTarget')),
    ]);
  }

  return backgrounds;
}

const TAG_CONTRAST_CASES = TAG_COLORS.flatMap(([tag]) =>
  cardBackgrounds().map(([state, background]) => [tag, state, background] as const)
);

describe('getTagColor', () => {
  it.each(TAG_COLORS)('returns the exact accessible pair for %s', (tag, expected) => {
    expect(getTagColor(tag)).toEqual(expected);
  });

  it.each(TAG_CONTRAST_CASES)(
    'keeps %s text at 4.5:1 or better on the %s card',
    (tag, _state, card) => {
      const color = getTagColor(tag);
      const background = composite(parseColor(color.background), card);
      const foreground = composite(parseColor(color.text), background);
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  );
});
