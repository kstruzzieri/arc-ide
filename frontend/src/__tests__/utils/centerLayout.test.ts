import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CENTER_LIMITS,
  DEFAULT_CENTER_LAYOUT,
  DEFAULT_GOLEM_WIDTH,
  HORIZONTAL_CHROME,
  LAYOUT_TOKENS,
  VERTICAL_CHROME,
  computeBottomLayout,
  computeCenterLayout,
  computeEffectiveCenter,
  computeSideMax,
  computeSideWidths,
  initialCenterReveal,
  normalizeCenterLayout,
  viewportSize,
  type CenterBudgetInput,
  type CenterLayoutState,
} from '../../utils/centerLayout';

describe('normalizeCenterLayout', () => {
  it('returns the defaults for an empty legacy record', () => {
    expect(normalizeCenterLayout({})).toEqual(DEFAULT_CENTER_LAYOUT);
  });

  it('keeps a valid golem-first order and rejects an unknown one', () => {
    expect(normalizeCenterLayout({ centerOrder: 'golem-first' }).centerOrder).toBe('golem-first');
    expect(normalizeCenterLayout({ centerOrder: 'sideways' }).centerOrder).toBe('files-first');
  });

  // A width outside the seam's own limits can only come from a hand-edited or
  // corrupt file; clamping it here stops the preference from persisting garbage
  // until the next seam drag happens to commit an effective value over it.
  it('clamps a persisted width to the seam limits', () => {
    expect(normalizeCenterLayout({ golemWidth: 1e9 }).golemWidth).toBe(CENTER_LIMITS.maxGolemPx);
    expect(normalizeCenterLayout({ golemWidth: 12 }).golemWidth).toBe(CENTER_LIMITS.minGolem);
  });

  it('rounds a finite positive width and falls back for zero, negative, NaN, or non-numbers', () => {
    expect(normalizeCenterLayout({ golemWidth: 501.6 }).golemWidth).toBe(502);
    expect(normalizeCenterLayout({ golemWidth: Number.POSITIVE_INFINITY }).golemWidth).toBe(
      DEFAULT_GOLEM_WIDTH
    );
    expect(normalizeCenterLayout({ golemWidth: 0 }).golemWidth).toBe(DEFAULT_GOLEM_WIDTH);
    expect(normalizeCenterLayout({ golemWidth: -20 }).golemWidth).toBe(DEFAULT_GOLEM_WIDTH);
    expect(normalizeCenterLayout({ golemWidth: Number.NaN }).golemWidth).toBe(DEFAULT_GOLEM_WIDTH);
    expect(normalizeCenterLayout({ golemWidth: '420' }).golemWidth).toBe(DEFAULT_GOLEM_WIDTH);
  });

  it('preserves an explicitly saved open Golem panel (false wins over the collapsed default)', () => {
    expect(normalizeCenterLayout({ golemCollapsed: false }).isGolemPanelCollapsed).toBe(false);
    expect(normalizeCenterLayout({ golemCollapsed: null }).isGolemPanelCollapsed).toBe(true);
    expect(normalizeCenterLayout({ golemCollapsed: undefined }).isGolemPanelCollapsed).toBe(true);
  });

  it('never yields both panels collapsed: the malformed pair becomes Files open / Golem collapsed', () => {
    const prefs = normalizeCenterLayout({ golemCollapsed: true, filesCollapsed: true });
    expect(prefs).toMatchObject({ isGolemPanelCollapsed: true, isFilesPanelCollapsed: false });
  });
});

describe('initialCenterReveal', () => {
  it('is Golem only when Golem is the sole open panel', () => {
    expect(
      initialCenterReveal({
        ...DEFAULT_CENTER_LAYOUT,
        isFilesPanelCollapsed: true,
        isGolemPanelCollapsed: false,
      })
    ).toBe('golem');
  });

  it('is Files when both are open or when Files is the sole open panel', () => {
    expect(initialCenterReveal({ ...DEFAULT_CENTER_LAYOUT, isGolemPanelCollapsed: false })).toBe(
      'files'
    );
    expect(initialCenterReveal(DEFAULT_CENTER_LAYOUT)).toBe('files');
  });
});

const LIMITS = { minGolem: 320, maxGolemPx: 900, minFiles: 360, maxFraction: 0.5 };
const budget = (over: Partial<CenterBudgetInput> = {}): CenterBudgetInput => ({
  viewportWidth: 1440,
  chrome: 86,
  sideWidths: { left: 260, right: 280 },
  prefs: { ...DEFAULT_CENTER_LAYOUT, isGolemPanelCollapsed: false },
  reveal: 'files',
  limits: LIMITS,
  ...over,
});

describe('layout token mirrors', () => {
  // The 86px chrome is arithmetic over real CSS tokens: sidebar + both content
  // paddings + the three horizontal seams (tree, center pair, dock). If a seam
  // or a token moves this fails rather than silently mis-budgeting the center.
  const tokens = readFileSync(join(__dirname, '../../styles/tokens.css'), 'utf8');
  const tokenValue = (name: string): string =>
    tokens.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim() ?? '';

  it('mirrors the CSS layout tokens the budget assumes', () => {
    expect(tokenValue('--sidebar-width')).toBe(`${LAYOUT_TOKENS.sidebarWidth}px`);
    expect(tokenValue('--content-padding')).toBe(`${LAYOUT_TOKENS.contentPadding}px`);
    expect(tokenValue('--panel-gap')).toBe(`${LAYOUT_TOKENS.panelGap}px`);
    expect(tokenValue('--panel-golem-width')).toBe(`${DEFAULT_GOLEM_WIDTH}px`);
    expect(tokenValue('--panel-rail-width')).toBe(`${LAYOUT_TOKENS.railWidth}px`);
    expect(tokenValue('--header-height')).toBe(`${LAYOUT_TOKENS.headerHeight}px`);
    expect(tokenValue('--statusbar-height')).toBe(`${LAYOUT_TOKENS.statusBarHeight}px`);
  });

  it('derives the horizontal chrome from those tokens and three seams', () => {
    expect(HORIZONTAL_CHROME).toBe(
      LAYOUT_TOKENS.sidebarWidth + LAYOUT_TOKENS.contentPadding * 2 + LAYOUT_TOKENS.panelGap * 3
    );
    expect(HORIZONTAL_CHROME).toBe(86);
  });

  it('derives the vertical chrome from those tokens and the one vertical seam', () => {
    expect(VERTICAL_CHROME).toBe(
      LAYOUT_TOKENS.headerHeight +
        LAYOUT_TOKENS.statusBarHeight +
        LAYOUT_TOKENS.contentPadding * 2 +
        LAYOUT_TOKENS.panelGap
    );
    expect(VERTICAL_CHROME).toBe(88);
  });

  it('publishes the spec constants as the shell limits', () => {
    expect(CENTER_LIMITS).toEqual(LIMITS);
  });
});

describe('computeCenterLayout', () => {
  it('keeps both panels open with the preferred width when it fits', () => {
    // 1440 - 86 - 540 = 814 available >= 320 + 360
    const out = computeCenterLayout(budget());
    expect(out).toMatchObject({
      filesCollapsed: false,
      golemCollapsed: false,
      golemWidth: 420,
      seamEnabled: true,
      degraded: false,
    });
    // ceiling = min(900, 720, 814 - 360 = 454)
    expect(out.maxGolemWidth).toBe(454);
  });

  it('clamps an oversized preference to the ceiling without touching the preference', () => {
    const prefs = { ...DEFAULT_CENTER_LAYOUT, isGolemPanelCollapsed: false, golemWidth: 800 };
    const out = computeCenterLayout(budget({ prefs }));
    expect(out.golemWidth).toBe(454);
    expect(prefs.golemWidth).toBe(800);
  });

  it('honours a preferred collapse without degrading', () => {
    const out = computeCenterLayout(budget({ prefs: { ...DEFAULT_CENTER_LAYOUT } }));
    expect(out).toMatchObject({
      golemCollapsed: true,
      filesCollapsed: false,
      seamEnabled: false,
      degraded: false,
    });
  });

  it('rails the non-requested panel when the pair cannot fit at 1024 with both sides open', () => {
    // 1024 - 86 - 360 = 578 < 680
    const narrow = budget({ viewportWidth: 1024, sideWidths: { left: 180, right: 180 } });
    expect(computeCenterLayout(narrow)).toMatchObject({
      golemCollapsed: true,
      filesCollapsed: false,
      degraded: true,
      seamEnabled: false,
    });
    expect(computeCenterLayout({ ...narrow, reveal: 'golem' })).toMatchObject({
      golemCollapsed: false,
      filesCollapsed: true,
      degraded: true,
    });
  });

  it('recovers the preferred split when the window widens again', () => {
    const narrow = budget({ viewportWidth: 1024, sideWidths: { left: 180, right: 180 } });
    expect(computeCenterLayout(narrow).degraded).toBe(true);
    expect(computeCenterLayout({ ...narrow, viewportWidth: 1440 })).toMatchObject({
      degraded: false,
      golemCollapsed: false,
      filesCollapsed: false,
    });
    // The preference record is read-only input: the budget never writes back.
    expect(narrow.prefs).toEqual({ ...DEFAULT_CENTER_LAYOUT, isGolemPanelCollapsed: false });
  });

  it('jointly clamps oversize sides and preserves the active preview', () => {
    const input = {
      viewportWidth: 1024,
      chrome: 86,
      preferred: { left: 600, right: 600 },
      collapsed: { left: false, right: false },
    };
    expect(computeSideWidths(input)).toEqual({ left: 358, right: 180 });
    expect(computeSideWidths({ ...input, active: 'right' })).toEqual({ left: 180, right: 358 });
    expect(input.preferred).toEqual({ left: 600, right: 600 });
  });

  it.each([false, true])(
    'fits 1024 with left collapsed=%s across right choices/orders/reveals',
    (left) => {
      for (const right of [false, true]) {
        const preferred = { left: 600, right: 600 };
        const sideWidths = computeSideWidths({
          viewportWidth: 1024,
          chrome: 86,
          preferred,
          collapsed: { left, right },
        });
        // A user-collapsed side is the only zero; a visible one is clamped to the
        // 40% cap (409) and, with both visible, jointly shrunk to 358/180.
        expect(sideWidths).toEqual({
          left: left ? 0 : right ? 409 : 358,
          right: right ? 0 : left ? 409 : 180,
        });
        expect(preferred).toEqual({ left: 600, right: 600 });

        for (const centerOrder of ['files-first', 'golem-first'] as const) {
          for (const reveal of ['files', 'golem'] as const) {
            const prefs = { ...DEFAULT_CENTER_LAYOUT, centerOrder, isGolemPanelCollapsed: false };
            const input = budget({ viewportWidth: 1024, sideWidths, reveal, prefs });
            const result = computeCenterLayout(input);
            const available = 1024 - 86 - sideWidths.left - sideWidths.right;
            expect(result.filesCollapsed && result.golemCollapsed).toBe(false);
            if (result.seamEnabled) {
              expect(result.golemWidth).toBeGreaterThanOrEqual(320);
              expect(available - result.golemWidth).toBeGreaterThanOrEqual(360);
            } else {
              expect(available - 40).toBeGreaterThanOrEqual(result.filesCollapsed ? 320 : 360);
            }
            // The rendered budget never exceeds the window: chrome + the widths
            // the allocator returned + what the center actually paints.
            const renderedCenter = result.seamEnabled
              ? result.golemWidth + 360
              : 40 + (result.filesCollapsed ? 320 : 360);
            expect(86 + sideWidths.left + sideWidths.right + renderedCenter).toBeLessThanOrEqual(
              1024
            );
            // A state-only order change cannot move a size.
            expect(prefs).toEqual({
              ...DEFAULT_CENTER_LAYOUT,
              centerOrder,
              isGolemPanelCollapsed: false,
            });
          }
        }
      }
    }
  );

  it('rejects malformed and very large persisted preferences before any geometry', () => {
    const sideWidths = computeSideWidths({
      viewportWidth: 1024,
      chrome: 86,
      preferred: { left: 1, right: Number.NaN },
      collapsed: { left: false, right: false },
    });
    expect(sideWidths).toEqual({ left: 180, right: 180 });

    expect(
      computeSideWidths({
        viewportWidth: 1024,
        chrome: 86,
        preferred: { left: 1e9, right: 1e9 },
        collapsed: { left: false, right: false },
      })
    ).toEqual({ left: 358, right: 180 });

    const out = computeCenterLayout(
      budget({
        viewportWidth: 1024,
        sideWidths,
        prefs: { ...DEFAULT_CENTER_LAYOUT, isGolemPanelCollapsed: false, golemWidth: 1e9 },
      })
    );
    for (const value of [out.golemWidth, out.maxGolemWidth]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('caps a side gesture against the live peer and the center reserve', () => {
    // 1024 - 86 - 400 - 180 = 358 beats both the 600px and the 40% ceilings.
    expect(computeSideMax(1024, 86, 180)).toBe(358);
    // Wide enough that the absolute cap wins.
    expect(computeSideMax(2560, 86, 280)).toBe(600);
    // Never below the 180px minimum, however cramped the window.
    expect(computeSideMax(700, 86, 180)).toBe(180);
  });
});

describe('computeBottomLayout', () => {
  it('clamps an oversized saved height into the editor reserve without rewriting it', () => {
    const preferred = 900;
    // 600 - 88 vertical chrome - 200 editor reserve = 312
    expect(computeBottomLayout(600, preferred)).toEqual({ height: 312, max: 312 });
    expect(preferred).toBe(900);
  });

  it('keeps the 100px floor on a very short window and honours a fitting preference', () => {
    expect(computeBottomLayout(200, 900)).toEqual({ height: 100, max: 100 });
    expect(computeBottomLayout(900, 240)).toEqual({ height: 240, max: 600 });
  });
});

describe('computeEffectiveCenter', () => {
  // The shell renders from this and `toggle-golem-panel` decides from it, so
  // the composition — chrome, side allocation, then the center pair — lives in
  // exactly one place and neither caller can answer from a different budget.
  const state = (over: Partial<CenterLayoutState> = {}): CenterLayoutState => ({
    centerOrder: 'files-first',
    centerReveal: 'files',
    isGolemPanelCollapsed: false,
    isFilesPanelCollapsed: false,
    isLeftPanelCollapsed: false,
    isRightPanelCollapsed: false,
    panelSizes: { left: 260, right: 280, golem: 420 },
    ...over,
  });

  it('allocates the sides first and hands the remainder to the center pair', () => {
    // 1440 - 86 - 540 = 814; ceiling = min(900, 720, 814 - 360) = 454.
    expect(computeEffectiveCenter(state(), 1440)).toEqual({
      sideWidths: { left: 260, right: 280 },
      center: {
        filesCollapsed: false,
        golemCollapsed: false,
        seamEnabled: true,
        degraded: false,
        golemWidth: 420,
        maxGolemWidth: 454,
      },
    });
  });

  it('rails the panel that was not requested once the sides have taken their share', () => {
    // 1024 - 86 - 400 reserve = 538 for both sides, so Runs gives up 2px;
    // 400 left for the center cannot hold the 320 + 360 split.
    expect(computeEffectiveCenter(state(), 1024)).toMatchObject({
      sideWidths: { left: 260, right: 278 },
      center: { filesCollapsed: false, golemCollapsed: true, degraded: true, seamEnabled: false },
    });
    expect(computeEffectiveCenter(state({ centerReveal: 'golem' }), 1024).center).toMatchObject({
      filesCollapsed: true,
      golemCollapsed: false,
    });
  });

  it('shrinks the peer rather than the side currently being dragged', () => {
    expect(computeEffectiveCenter(state(), 1024, 'right').sideWidths).toEqual({
      left: 258,
      right: 280,
    });
  });
});

describe('viewportSize', () => {
  it('measures the real window rather than the import-time fallback', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    expect(viewportSize()).toEqual({ width: 1600, height: 900 });
  });
});
