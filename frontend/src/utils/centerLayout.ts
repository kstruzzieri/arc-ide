/**
 * Center-pair layout preferences (#271 spec §2–3).
 *
 * Pure: no React, no store. `normalizeCenterLayout` is the single place a
 * persisted (possibly legacy, possibly malformed) record becomes a valid
 * preference set, so restore and the store setters cannot drift.
 */

export type CenterOrder = 'files-first' | 'golem-first';
export type CenterPanel = 'files' | 'golem';

export const DEFAULT_GOLEM_WIDTH = 420;

export interface CenterLayoutPrefs {
  centerOrder: CenterOrder;
  /** Preferred Golem island width in px when both panels are open. */
  golemWidth: number;
  /** D2: Golem is opt-in, so the default is collapsed. */
  isGolemPanelCollapsed: boolean;
  /** D3: full-width conversation mode. */
  isFilesPanelCollapsed: boolean;
}

export const DEFAULT_CENTER_LAYOUT: Readonly<CenterLayoutPrefs> = Object.freeze({
  centerOrder: 'files-first',
  golemWidth: DEFAULT_GOLEM_WIDTH,
  isGolemPanelCollapsed: true,
  isFilesPanelCollapsed: false,
});

/** The persisted shape before validation; every field may be absent or wrong. */
export interface RawCenterLayout {
  centerOrder?: unknown;
  golemWidth?: unknown;
  golemCollapsed?: unknown;
  filesCollapsed?: unknown;
}

export function normalizeCenterLayout(raw: RawCenterLayout): CenterLayoutPrefs {
  const centerOrder: CenterOrder =
    raw.centerOrder === 'golem-first' ? 'golem-first' : 'files-first';
  const golemWidth =
    typeof raw.golemWidth === 'number' && Number.isFinite(raw.golemWidth) && raw.golemWidth > 0
      ? Math.max(1, Math.round(raw.golemWidth))
      : DEFAULT_GOLEM_WIDTH;
  // A saved `false` must survive: the default is collapsed, and only a real
  // boolean may override it (null / undefined are "absent").
  const isGolemPanelCollapsed =
    typeof raw.golemCollapsed === 'boolean'
      ? raw.golemCollapsed
      : DEFAULT_CENTER_LAYOUT.isGolemPanelCollapsed;
  let isFilesPanelCollapsed = raw.filesCollapsed === true;
  // Invariant: never both collapsed. The malformed pair resolves to the
  // default shape rather than to whichever flag happened to be read last.
  if (isGolemPanelCollapsed && isFilesPanelCollapsed) isFilesPanelCollapsed = false;
  return { centerOrder, golemWidth, isGolemPanelCollapsed, isFilesPanelCollapsed };
}

/**
 * Which center panel a restore should treat as explicitly requested (spec
 * §2.3): the sole preferred-open panel, else Files.
 */
export function initialCenterReveal(prefs: CenterLayoutPrefs): CenterPanel {
  if (prefs.isFilesPanelCollapsed && !prefs.isGolemPanelCollapsed) return 'golem';
  return 'files';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Effective layout budget (#271 spec §2.3)
 *
 * Preferences are what the user asked for; the effective layout is what fits.
 * Nothing below writes back: the shell renders these results and persists only
 * the preferences, so widening the window restores the split on its own.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Mirrors of the CSS layout tokens the arithmetic below assumes. A test asserts
 * they still match `styles/tokens.css`, because the budget is only correct while
 * the DOM really renders this chrome.
 */
export const LAYOUT_TOKENS = {
  sidebarWidth: 56,
  contentPadding: 6,
  panelGap: 6,
  railWidth: 40,
  headerHeight: 44,
  statusBarHeight: 26,
} as const;

/** Sidebar + both content paddings + three horizontal seams (tree, pair, dock). */
export const HORIZONTAL_CHROME =
  LAYOUT_TOKENS.sidebarWidth + LAYOUT_TOKENS.contentPadding * 2 + LAYOUT_TOKENS.panelGap * 3;

/** Header + status bar + both content paddings + the one vertical seam. */
export const VERTICAL_CHROME =
  LAYOUT_TOKENS.headerHeight +
  LAYOUT_TOKENS.statusBarHeight +
  LAYOUT_TOKENS.contentPadding * 2 +
  LAYOUT_TOKENS.panelGap;

/** Minimum width of a side island (tree, Runs dock). */
export const MIN_SIDE_WIDTH = 180;
/** Absolute ceiling for a side island, however wide the window. */
export const MAX_PANEL_PX = 600;
/** Fraction of the viewport a single side island may occupy. */
export const MAX_SIDE_FRACTION = 0.4;
/** A usable Files column (`CENTER_LIMITS.minFiles` 360) plus the other panel's 40px rail. */
export const CENTER_RESERVE = 400;
/** Minimum bottom-panel height, and the editor height it may never eat into. */
export const MIN_BOTTOM_HEIGHT = 100;
export const MIN_EDITOR_HEIGHT = 200;

export const CENTER_LIMITS: CenterLayoutLimits = {
  minGolem: 320,
  maxGolemPx: 900,
  minFiles: 360,
  maxFraction: 0.5,
};

export interface CenterLayoutLimits {
  minGolem: number;
  maxGolemPx: number;
  minFiles: number;
  maxFraction: number;
}

export interface CenterBudgetInput {
  viewportWidth: number;
  chrome: number;
  sideWidths: { left: number; right: number };
  prefs: CenterLayoutPrefs;
  reveal: CenterPanel;
  limits: CenterLayoutLimits;
}

export interface EffectiveCenterLayout {
  filesCollapsed: boolean;
  golemCollapsed: boolean;
  /** Usable split width while the seam is live; the retained preference otherwise. */
  golemWidth: number;
  maxGolemWidth: number;
  seamEnabled: boolean;
  /** True only when window pressure — not a preference — railed a panel. */
  degraded: boolean;
}

export interface SideBudgetInput {
  viewportWidth: number;
  chrome: number;
  preferred: { left: number; right: number };
  collapsed: { left: boolean; right: boolean };
  active?: 'left' | 'right';
}

/**
 * Both side islands allocated jointly (spec §2.3). Calculating each against the
 * opposite *saved* width lets two oversize preferences both pass and squeeze the
 * center out, so the pair is clamped together against one shared remainder.
 */
export function computeSideWidths(input: SideBudgetInput): { left: number; right: number } {
  const minimum = MIN_SIDE_WIDTH;
  const cap = Math.min(MAX_PANEL_PX, Math.floor(input.viewportWidth * MAX_SIDE_FRACTION));
  const clamp = (value: number) =>
    Math.min(cap, Math.max(minimum, Number.isFinite(value) ? Math.round(value) : minimum));
  const widths = {
    left: input.collapsed.left ? 0 : clamp(input.preferred.left),
    right: input.collapsed.right ? 0 : clamp(input.preferred.right),
  };
  let excess = Math.max(
    0,
    widths.left + widths.right - (input.viewportWidth - input.chrome - CENTER_RESERVE)
  );
  // Preserve a live preview; otherwise shrink Runs first for deterministic restore.
  const shrinkOrder: ('left' | 'right')[] =
    input.active === 'right' ? ['left', 'right'] : ['right', 'left'];
  for (const side of shrinkOrder) {
    const reduction = Math.min(excess, Math.max(0, widths[side] - minimum));
    widths[side] -= reduction;
    excess -= reduction;
  }
  return widths;
}

/**
 * The ceiling for one side island during its own gesture: the peer is read at
 * gesture start so a shrinking peer cannot feed back into a growing maximum.
 */
export function computeSideMax(viewportWidth: number, chrome: number, peerWidth: number): number {
  return Math.max(
    MIN_SIDE_WIDTH,
    Math.min(
      MAX_PANEL_PX,
      Math.floor(viewportWidth * MAX_SIDE_FRACTION),
      viewportWidth - chrome - CENTER_RESERVE - peerWidth
    )
  );
}

/** The bottom panel's effective height and its gesture ceiling. */
export function computeBottomLayout(
  viewportHeight: number,
  preferred: number
): { height: number; max: number } {
  const max = Math.max(
    MIN_BOTTOM_HEIGHT,
    Math.min(MAX_PANEL_PX, viewportHeight - VERTICAL_CHROME - MIN_EDITOR_HEIGHT)
  );
  const requested = Number.isFinite(preferred) ? preferred : MIN_BOTTOM_HEIGHT;
  return { height: Math.min(max, Math.max(MIN_BOTTOM_HEIGHT, Math.round(requested))), max };
}

/**
 * The center pair's effective layout. A preferred collapse always wins; only
 * when both panels are preferred open and the split genuinely cannot fit does
 * the pair degrade, and then it keeps the requested panel and rails the other.
 */
export function computeCenterLayout({
  viewportWidth,
  chrome,
  sideWidths,
  prefs,
  reveal,
  limits,
}: CenterBudgetInput): EffectiveCenterLayout {
  const available = viewportWidth - chrome - sideWidths.left - sideWidths.right;
  // Not floored at minGolem: `max(min, available)` would conceal a split that
  // does not fit and render a Files column below its own minimum.
  const ceiling = Math.min(
    limits.maxGolemPx,
    Math.floor(viewportWidth * limits.maxFraction),
    available - limits.minFiles
  );
  const preferredRail = prefs.isFilesPanelCollapsed || prefs.isGolemPanelCollapsed;
  const degraded = !preferredRail && ceiling < limits.minGolem;
  const filesCollapsed = preferredRail
    ? prefs.isFilesPanelCollapsed
    : degraded && reveal === 'golem';
  const golemCollapsed = preferredRail
    ? prefs.isGolemPanelCollapsed
    : degraded && reveal === 'files';
  const seamEnabled = !filesCollapsed && !golemCollapsed;
  return {
    filesCollapsed,
    golemCollapsed,
    seamEnabled,
    degraded,
    golemWidth: seamEnabled
      ? Math.min(ceiling, Math.max(limits.minGolem, prefs.golemWidth))
      : prefs.golemWidth,
    maxGolemWidth: seamEnabled ? ceiling : 0,
  };
}

/** The store fields the whole center budget is composed from. */
export interface CenterLayoutState {
  centerOrder: CenterOrder;
  centerReveal: CenterPanel;
  isGolemPanelCollapsed: boolean;
  isFilesPanelCollapsed: boolean;
  isLeftPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  panelSizes: { left: number; right: number; golem: number };
}

/**
 * The one composition of side widths and center layout (spec §2.3). The shell
 * renders from it and the Golem toggle command decides from it, so neither can
 * answer from a budget the other does not share. `activeSide` is the side
 * island currently under a gesture, whose live preview must survive the shrink.
 */
export function computeEffectiveCenter(
  state: CenterLayoutState,
  viewportWidth: number,
  activeSide?: 'left' | 'right'
): { sideWidths: { left: number; right: number }; center: EffectiveCenterLayout } {
  const sideWidths = computeSideWidths({
    viewportWidth,
    chrome: HORIZONTAL_CHROME,
    preferred: { left: state.panelSizes.left, right: state.panelSizes.right },
    collapsed: { left: state.isLeftPanelCollapsed, right: state.isRightPanelCollapsed },
    active: activeSide,
  });
  return {
    sideWidths,
    center: computeCenterLayout({
      viewportWidth,
      chrome: HORIZONTAL_CHROME,
      sideWidths,
      prefs: {
        centerOrder: state.centerOrder,
        golemWidth: state.panelSizes.golem,
        isGolemPanelCollapsed: state.isGolemPanelCollapsed,
        isFilesPanelCollapsed: state.isFilesPanelCollapsed,
      },
      reveal: state.centerReveal,
      limits: CENTER_LIMITS,
    }),
  };
}

/**
 * The viewport the budget is measured against. The `window`-less branch is a
 * dead one in the webview and in jsdom alike — it exists so importing this
 * module cannot throw — and it lives here rather than at each call site so
 * every consumer measures against the same fallback.
 */
export function viewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}
