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
  const centerOrder: CenterOrder = raw.centerOrder === 'golem-first' ? 'golem-first' : 'files-first';
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
