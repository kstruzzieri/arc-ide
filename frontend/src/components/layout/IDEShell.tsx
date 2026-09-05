import {
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { ToggleMaximize } from '../../wails/bindings';
import {
  useIDEStore,
  useIsLeftPanelCollapsed,
  useIsRightPanelCollapsed,
  useIsBottomPanelCollapsed,
  useCenterOrder,
  useCenterReveal,
  useIsFilesPanelCollapsed,
  useIsGolemPanelCollapsed,
} from '../../stores/ideStore';
import type { WorkspaceAccent } from '../../stores/ideStore';
import { CommandPalette } from '../CommandPalette';
import { FilesCommandBar } from './FilesCommandBar';
import { PanelRail } from './PanelRail';
import { ResizeHandle } from './ResizeHandle';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useLayoutCssSync } from '../../hooks/useLayoutCssSync';
import { useOpenFolder } from '../../hooks/useOpenFolder';
import { createCommands } from '../../utils/commands';
import {
  CENTER_LIMITS,
  HORIZONTAL_CHROME,
  MIN_BOTTOM_HEIGHT,
  MIN_SIDE_WIDTH,
  computeBottomLayout,
  computeCenterLayout,
  computeSideMax,
  computeSideWidths,
  type CenterOrder,
  type CenterPanel,
} from '../../utils/centerLayout';
import { CENTER_DRAG_MIME, reorderTargetForDrop } from '../../utils/centerReorder';
import { useGolemStore } from '../../stores/golemStore';
import styles from './IDEShell.module.css';

/** Panels whose size is a draggable CSS variable. */
type ResizePanel = 'left' | 'right' | 'bottom' | 'golem';

const CSS_VAR: Record<ResizePanel, string> = {
  left: '--panel-left-width',
  right: '--panel-right-width',
  bottom: '--panel-bottom-height',
  golem: '--panel-golem-width',
};

const CENTER_PANELS: readonly CenterPanel[] = ['files', 'golem'];

const CENTER_LABEL: Record<CenterPanel, string> = { files: 'Files', golem: 'Golem' };

/** A collapsed center panel keeps its tree mounted and merely leaves layout. */
const HIDDEN = { display: 'none' } as const;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface IDEShellProps {
  header: (openCommandPalette: () => void) => ReactNode;
  sidebar: ReactNode;
  leftPanel: ReactNode;
  centerPanel: ReactNode;
  /**
   * The Golem island's host. A render callback rather than a node because the
   * host needs the *effective* visibility — a saved-open island is still a rail
   * under window pressure — and that derived truth must not enter the store.
   */
  golemPanel: (visible: boolean) => ReactNode;
  rightPanel: ReactNode;
  bottomPanel: ReactNode;
  statusBar: ReactNode;
  accent?: WorkspaceAccent;
}

export function IDEShell({
  header,
  sidebar,
  leftPanel,
  centerPanel,
  golemPanel,
  rightPanel,
  bottomPanel,
  statusBar,
  accent = 'project',
}: IDEShellProps) {
  const isLeftPanelCollapsed = useIsLeftPanelCollapsed();
  const isRightPanelCollapsed = useIsRightPanelCollapsed();
  const isBottomPanelCollapsed = useIsBottomPanelCollapsed();
  const toggleLeftPanel = useIDEStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = useIDEStore((s) => s.toggleRightPanel);
  const toggleBottomPanel = useIDEStore((s) => s.toggleBottomPanel);
  const setPanelSize = useIDEStore((s) => s.setPanelSize);
  const leftPanelSize = useIDEStore((s) => s.panelSizes.left);
  const rightPanelSize = useIDEStore((s) => s.panelSizes.right);
  const bottomPanelSize = useIDEStore((s) => s.panelSizes.bottom);
  const golemPanelSize = useIDEStore((s) => s.panelSizes.golem);
  const centerOrder = useCenterOrder();
  const centerReveal = useCenterReveal();
  const isGolemPanelCollapsed = useIsGolemPanelCollapsed();
  const isFilesPanelCollapsed = useIsFilesPanelCollapsed();
  const workspacePath = useIDEStore((s) => s.workspace?.path ?? null);
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const { openFolder } = useOpenFolder();
  const commands = useMemo(() => createCommands(openFolder), [openFolder]);

  // Global keyboard shortcuts (Cmd+O, etc.) — registered once here
  useKeyboardShortcuts(openFolder, openCommandPalette, isCommandPaletteOpen);

  // Track viewport dimensions for dynamic max constraints
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));

  useEffect(() => {
    let rafId: number;
    const handleResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setViewport({ width: window.innerWidth, height: window.innerHeight });
      });
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(rafId);
    };
  }, []);

  const handleHeaderDoubleClick = useCallback(() => {
    ToggleMaximize();
  }, []);

  /**
   * The one in-flight gesture (#271). `size` is its live preview, which feeds
   * the budget so peers give way before paint; `peer` is the other side's
   * effective width read at gesture start, so a peer shrinking to make room
   * cannot feed back into this gesture's own maximum. Only a side gesture has
   * such a peer — it is null for the bottom and the center seam.
   */
  const [active, setActive] = useState<{
    panel: ResizePanel;
    size: number;
    peer: number | null;
  } | null>(null);
  /** Bumped on a cancelled gesture: the CSS var is ahead of the store. */
  const [invalidationRevision, setInvalidationRevision] = useState(0);

  const previewOf = (panel: ResizePanel, saved: number) =>
    active?.panel === panel ? active.size : saved;

  const sideWidths = computeSideWidths({
    viewportWidth: viewport.width,
    chrome: HORIZONTAL_CHROME,
    preferred: {
      left: previewOf('left', leftPanelSize),
      right: previewOf('right', rightPanelSize),
    },
    collapsed: { left: isLeftPanelCollapsed, right: isRightPanelCollapsed },
    active: active?.panel === 'left' || active?.panel === 'right' ? active.panel : undefined,
  });

  const center = computeCenterLayout({
    viewportWidth: viewport.width,
    chrome: HORIZONTAL_CHROME,
    sideWidths,
    prefs: {
      centerOrder,
      golemWidth: previewOf('golem', golemPanelSize),
      isGolemPanelCollapsed,
      isFilesPanelCollapsed,
    },
    reveal: centerReveal,
    limits: CENTER_LIMITS,
  });

  const bottom = computeBottomLayout(viewport.height, previewOf('bottom', bottomPanelSize));

  /** The peer width this side's gesture froze at its start, else the live one. */
  const peerOf = (panel: 'left' | 'right', live: number) =>
    active?.panel === panel && active.peer !== null ? active.peer : live;
  const maxLeft = computeSideMax(
    viewport.width,
    HORIZONTAL_CHROME,
    peerOf('left', sideWidths.right)
  );
  const maxRight = computeSideMax(
    viewport.width,
    HORIZONTAL_CHROME,
    peerOf('right', sideWidths.left)
  );

  // Effective sizes reach the CSS variables here, never through the store: a
  // restore, a clamp, or a peer giving way must land without a drag. The one
  // variable a live gesture owns is left to `useResize`.
  useLayoutCssSync(
    {
      left: sideWidths.left,
      right: sideWidths.right,
      bottom: bottom.height,
      golem: center.golemWidth,
    },
    active ? CSS_VAR[active.panel] : null,
    invalidationRevision
  );

  const effectiveLeft = sideWidths.left;
  const effectiveRight = sideWidths.right;

  const resize = useMemo(() => {
    const make = (panel: ResizePanel) => ({
      // Only a side gesture has a peer whose width bounds it; the bottom and
      // the center seam are bounded by the viewport alone.
      onResizeStart: (size: number) =>
        setActive({
          panel,
          size,
          peer: panel === 'left' ? effectiveRight : panel === 'right' ? effectiveLeft : null,
        }),
      onResizePreview: (size: number) =>
        setActive((previous) =>
          previous && previous.panel === panel ? { ...previous, size } : previous
        ),
      onResizeEnd: (size: number) => {
        setActive(null);
        setPanelSize(panel, size);
      },
      onResizeCancel: () => {
        setActive(null);
        // The inline CSS variable is whatever the abandoned drag last wrote, so
        // the sync hook has to rewrite it even though its desired value never
        // moved.
        setInvalidationRevision((revision) => revision + 1);
      },
    });
    return {
      left: make('left'),
      right: make('right'),
      bottom: make('bottom'),
      golem: make('golem'),
    };
  }, [effectiveLeft, effectiveRight, setPanelSize]);

  // Everything that redefines the layout underneath an in-flight gesture, and
  // nothing this gesture itself produces.
  const invalidationKey = [
    viewport.width,
    viewport.height,
    centerOrder,
    centerReveal,
    isLeftPanelCollapsed,
    isRightPanelCollapsed,
    isBottomPanelCollapsed,
    isGolemPanelCollapsed,
    isFilesPanelCollapsed,
    workspacePath ?? '',
  ].join('|');

  // ── Center-pair focus ownership (spec §2.4) ────────────────────────────────
  const pairRef = useRef<HTMLDivElement>(null);
  const filesRootRef = useRef<HTMLDivElement>(null);
  const golemRootRef = useRef<HTMLElement>(null);
  const lastFocused = useRef<Record<CenterPanel, HTMLElement | null>>({ files: null, golem: null });
  const lastFocusedPanel = useRef<CenterPanel | null>(null);
  const lastFocusedInPair = useRef<HTMLElement | null>(null);
  const rootOf = useCallback(
    (panel: CenterPanel): HTMLElement | null =>
      panel === 'files' ? filesRootRef.current : golemRootRef.current,
    []
  );

  useEffect(() => {
    const node = pairRef.current;
    if (!node) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      lastFocusedInPair.current = target;
      const panel = CENTER_PANELS.find((candidate) => rootOf(candidate)?.contains(target));
      lastFocusedPanel.current = panel ?? null;
      if (panel) lastFocused.current[panel] = target;
    };
    node.addEventListener('focusin', onFocusIn);
    return () => node.removeEventListener('focusin', onFocusIn);
  }, [rootOf]);

  const previousLayout = useRef({
    files: center.filesCollapsed,
    golem: center.golemCollapsed,
    preferredFiles: isFilesPanelCollapsed,
    preferredGolem: isGolemPanelCollapsed,
    reveal: centerReveal,
    order: centerOrder,
  });

  useLayoutEffect(() => {
    const previous = previousLayout.current;
    previousLayout.current = {
      files: center.filesCollapsed,
      golem: center.golemCollapsed,
      preferredFiles: isFilesPanelCollapsed,
      preferredGolem: isGolemPanelCollapsed,
      reveal: centerReveal,
      order: centerOrder,
    };

    // Moving a DOM node drops the focus it held, so a reorder restores the
    // control the user was on by identity once the move has committed. Only
    // the pair's own focus is the pair's to restore: `focusin` never fires when
    // focus *leaves*, so the recorded element outlives its turn, and a reorder
    // must not yank focus back out of the dock the user has moved on to.
    if (previous.order !== centerOrder) {
      const held = lastFocusedInPair.current;
      const activeElement = document.activeElement;
      const ours =
        activeElement === null ||
        activeElement === document.body ||
        (activeElement instanceof HTMLElement && pairRef.current?.contains(activeElement) === true);
      if (ours && held?.isConnected && activeElement !== held) held.focus();
    }

    for (const panel of CENTER_PANELS) {
      const collapsed = panel === 'files' ? center.filesCollapsed : center.golemCollapsed;
      if (collapsed === previous[panel]) continue;
      const root = rootOf(panel);
      const preferredCollapsed = panel === 'files' ? isFilesPanelCollapsed : isGolemPanelCollapsed;
      const wasPreferredCollapsed =
        panel === 'files' ? previous.preferredFiles : previous.preferredGolem;

      if (collapsed) {
        // An explicit collapse always hands focus to the rail that replaced the
        // panel. Automatic degradation only does so when the focus it just hid
        // would otherwise be lost to the document body.
        const explicit = preferredCollapsed && !wasPreferredCollapsed;
        if (explicit || focusWasIn(root, panel, lastFocusedPanel.current)) {
          pairRef.current?.querySelector<HTMLElement>(`button[data-panel="${panel}"]`)?.focus();
        }
        continue;
      }

      // Automatic widening never steals focus; only a preference change or an
      // explicit reveal of this panel does.
      const explicitExpand =
        (wasPreferredCollapsed && !preferredCollapsed) ||
        (centerReveal === panel && previous.reveal !== panel);
      if (!explicitExpand || !root) continue;
      if (root.contains(document.activeElement)) continue;
      const remembered = lastFocused.current[panel];
      if (remembered?.isConnected && root.contains(remembered) && !isDisabled(remembered)) {
        remembered.focus();
        if (document.activeElement === remembered) continue;
      }
      (root.querySelector<HTMLElement>(FOCUSABLE) ?? root).focus();
    }
  }, [
    center.filesCollapsed,
    center.golemCollapsed,
    centerOrder,
    centerReveal,
    isFilesPanelCollapsed,
    isGolemPanelCollapsed,
    rootOf,
  ]);

  // ── Center-pair reorder by drag (spec §4.1) ────────────────────────────────
  // The source, the order it started from and the repository it belongs to,
  // captured once at dragstart: the destination is then a stable assignment
  // rather than a toggle, so a repeated delivery lands on the same order.
  const sessionKey = workspacePath ?? '';
  const dragRecord = useRef<{
    source: CenterPanel;
    order: CenterOrder;
    session: string;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    panel: CenterPanel;
    edge: 'left' | 'right';
    session: string;
  } | null>(null);
  // A repository switch redefines the layout the drag was aimed at, so the
  // indicator is scoped to the session that raised it rather than swept up by
  // an effect. `dropPlacement` refuses the stale record for the same reason.
  const dropIndicator = dropTarget?.session === sessionKey ? dropTarget : null;

  const endDrag = useCallback(() => {
    dragRecord.current = null;
    setDropTarget(null);
    useIDEStore.getState().setCenterDrag(null);
  }, []);

  const onPairDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      // Only this shell's own bars carry the type; anything else is a foreign
      // drag passing through and never becomes a reorder.
      if (!e.dataTransfer.types.includes(CENTER_DRAG_MIME)) return;
      const node = e.target;
      const source =
        node instanceof Node
          ? CENTER_PANELS.find((panel) => rootOf(panel)?.contains(node))
          : undefined;
      if (!source) return;
      dragRecord.current = { source, order: centerOrder, session: sessionKey };
    },
    [centerOrder, rootOf, sessionKey]
  );

  /**
   * Where this drag would land on `panel`, or null while the drop is a no-op.
   * The payload is deliberately not read here: browsers put the drag data store
   * in protected mode during dragover, so `getData` is empty until drop and the
   * captured record plus the advertised type are all there is to go on.
   */
  const dropPlacement = useCallback(
    (panel: CenterPanel, e: DragEvent<HTMLElement>) => {
      const record = dragRecord.current;
      if (!record || record.session !== sessionKey) return null;
      if (!e.dataTransfer.types.includes(CENTER_DRAG_MIME)) return null;
      const rect = e.currentTarget.getBoundingClientRect();
      const order = reorderTargetForDrop(
        record.source,
        record.order,
        panel,
        (rect.left + rect.right) / 2,
        e.clientX
      );
      // The drop-line marks the target's far edge — the side the source lands on.
      const edge = (panel === 'files') === (record.order === 'files-first') ? 'left' : 'right';
      return order ? ({ order, edge } as const) : null;
    },
    [sessionKey]
  );

  const dropHandlers = useMemo(() => {
    const make = (panel: CenterPanel) => ({
      onDragEnter: (e: DragEvent<HTMLElement>) => {
        const placement = dropPlacement(panel, e);
        setDropTarget(placement && { panel, edge: placement.edge, session: sessionKey });
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        const placement = dropPlacement(panel, e);
        setDropTarget(placement && { panel, edge: placement.edge, session: sessionKey });
        if (!placement) return;
        // Accepting the drag is what lets `drop` fire on this island at all.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        // Crossing into a child is not leaving the island.
        const related = e.relatedTarget;
        if (related instanceof Node && e.currentTarget.contains(related)) return;
        setDropTarget(null);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        const record = dragRecord.current;
        const placement = dropPlacement(panel, e);
        endDrag();
        if (!record || !placement) return;
        e.preventDefault();
        // Only at drop is the payload readable; it has to be the drag we saw start.
        if (e.dataTransfer.getData(CENTER_DRAG_MIME) !== record.source) return;
        useIDEStore.getState().setCenterOrder(placement.order);
      },
    });
    return { files: make('files'), golem: make('golem') };
  }, [dropPlacement, endDrag, sessionKey]);

  const dropAttributes = (panel: CenterPanel) =>
    dropIndicator?.panel === panel
      ? { 'data-drop-over': 'true', 'data-drop-edge': dropIndicator.edge }
      : undefined;

  // ── Layout announcements (spec §7) ─────────────────────────────────────────
  // One region, one effect: simultaneous changes — a collapse and the expand it
  // caused — become one message instead of three racing writes. The region is
  // written directly rather than through state: it is an assistive-technology
  // output, not something any render depends on.
  const announcerRef = useRef<HTMLDivElement>(null);
  const announced = useRef({
    order: centerOrder,
    files: center.filesCollapsed,
    golem: center.golemCollapsed,
    session: sessionKey,
  });

  useEffect(() => {
    const previous = announced.current;
    const next = {
      order: centerOrder,
      files: center.filesCollapsed,
      golem: center.golemCollapsed,
      session: sessionKey,
    };
    announced.current = next;
    // A restore is not a change the user just made. The initial mount — and
    // StrictMode's replay of it — compares equal to itself and says nothing.
    if (previous.session !== next.session) return;
    const parts: string[] = [];
    if (previous.order !== next.order) {
      parts.push(`Golem panel moved ${next.order === 'golem-first' ? 'left' : 'right'}.`);
    }
    for (const panel of CENTER_PANELS) {
      if (previous[panel] === next[panel]) continue;
      parts.push(`${CENTER_LABEL[panel]} panel ${next[panel] ? 'collapsed' : 'expanded'}.`);
    }
    if (parts.length && announcerRef.current) {
      announcerRef.current.textContent = parts.join(' ');
    }
  }, [centerOrder, center.filesCollapsed, center.golemCollapsed, sessionKey]);

  const expandCenter = useCallback((panel: CenterPanel) => {
    useIDEStore.getState().revealCenterPanel(panel);
    // Revealing the chat is a request to type in it; the hidden mount consumes
    // the request only once it is actually visible.
    if (panel === 'golem') useGolemStore.getState().requestComposerFocus();
  }, []);
  const expandFiles = useCallback(() => expandCenter('files'), [expandCenter]);
  const expandGolem = useCallback(() => expandCenter('golem'), [expandCenter]);

  const filesSlot = (
    <div key="files" className={styles.centerSlot}>
      <div
        ref={filesRootRef}
        className={styles.centerArea}
        data-center-panel="files"
        role="region"
        aria-label="Files"
        tabIndex={-1}
        style={center.filesCollapsed ? HIDDEN : undefined}
        {...dropAttributes('files')}
        {...dropHandlers.files}
      >
        <section className={styles.centerPanel}>
          <FilesCommandBar />
          {centerPanel}
        </section>
        <ResizeHandle
          direction="vertical"
          cssVar="--panel-bottom-height"
          min={MIN_BOTTOM_HEIGHT}
          max={bottom.max}
          inverted
          isCollapsed={isBottomPanelCollapsed}
          onToggleCollapse={toggleBottomPanel}
          collapseDirection="down"
          panelSize={bottom.height}
          invalidationKey={invalidationKey}
          {...resize.bottom}
        />
        {!isBottomPanelCollapsed && <section className={styles.bottomPanel}>{bottomPanel}</section>}
      </div>
      {center.filesCollapsed && <PanelRail panel="files" onExpand={expandFiles} />}
    </div>
  );

  const golemSlot = (
    <div key="golem" className={styles.centerSlot}>
      <section
        ref={golemRootRef}
        className={styles.golemPanel}
        data-center-panel="golem"
        data-fill={center.filesCollapsed ? 'true' : undefined}
        aria-label="Golem"
        tabIndex={-1}
        style={center.golemCollapsed ? HIDDEN : undefined}
        {...dropAttributes('golem')}
        {...dropHandlers.golem}
      >
        {golemPanel(!center.golemCollapsed)}
      </section>
      {center.golemCollapsed && <PanelRail panel="golem" onExpand={expandGolem} />}
    </div>
  );

  // A dead seam is a plain spacer, not a ResizeHandle wearing a collapse
  // chevron: the rail beside it already owns the one expand action.
  const seam = center.seamEnabled ? (
    <ResizeHandle
      key="center-seam"
      direction="horizontal"
      cssVar="--panel-golem-width"
      min={CENTER_LIMITS.minGolem}
      max={center.maxGolemWidth}
      inverted={centerOrder === 'files-first'}
      panelSize={center.golemWidth}
      invalidationKey={invalidationKey}
      {...resize.golem}
    />
  ) : (
    <div key="center-seam" className={styles.centerSpacer} aria-hidden="true" />
  );

  const slots = { files: filesSlot, golem: golemSlot };
  const order: CenterPanel[] =
    centerOrder === 'files-first' ? ['files', 'golem'] : ['golem', 'files'];

  return (
    <div
      className={styles.ide}
      data-accent={accent}
      data-left-collapsed={isLeftPanelCollapsed || undefined}
      data-right-collapsed={isRightPanelCollapsed || undefined}
      data-bottom-collapsed={isBottomPanelCollapsed || undefined}
      data-files-collapsed={center.filesCollapsed || undefined}
      data-golem-collapsed={center.golemCollapsed || undefined}
    >
      <a className={styles.skipLink} href="#main-content">
        Skip to main content
      </a>
      <header className={styles.header} onDoubleClick={handleHeaderDoubleClick}>
        {header(openCommandPalette)}
      </header>
      <aside className={styles.sidebar}>{sidebar}</aside>
      <main id="main-content" className={styles.content} tabIndex={-1}>
        {!isLeftPanelCollapsed && <section className={styles.leftPanel}>{leftPanel}</section>}
        <ResizeHandle
          direction="horizontal"
          cssVar="--panel-left-width"
          min={MIN_SIDE_WIDTH}
          max={maxLeft}
          isCollapsed={isLeftPanelCollapsed}
          onToggleCollapse={toggleLeftPanel}
          collapseDirection="left"
          panelSize={sideWidths.left}
          invalidationKey={invalidationKey}
          {...resize.left}
        />
        <div
          className={styles.centerPair}
          ref={pairRef}
          onDragStart={onPairDragStart}
          onDragEnd={endDrag}
        >
          {[slots[order[0]], seam, slots[order[1]]]}
        </div>
        <ResizeHandle
          direction="horizontal"
          cssVar="--panel-right-width"
          min={MIN_SIDE_WIDTH}
          max={maxRight}
          inverted
          isCollapsed={isRightPanelCollapsed}
          onToggleCollapse={toggleRightPanel}
          collapseDirection="right"
          panelSize={sideWidths.right}
          invalidationKey={invalidationKey}
          {...resize.right}
        />
        {!isRightPanelCollapsed && <section className={styles.rightPanel}>{rightPanel}</section>}
      </main>
      <footer className={styles.statusBar}>{statusBar}</footer>
      <div
        ref={announcerRef}
        className={styles.srOnly}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Layout changes"
      />
      <CommandPalette
        open={isCommandPaletteOpen}
        commands={commands}
        onClose={() => setCommandPaletteOpen(false)}
      />
    </div>
  );
}

const isDisabled = (element: HTMLElement): boolean =>
  element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';

/**
 * Whether focus lived in a panel that has just been hidden. A browser blurs the
 * element the moment it stops rendering, so the recorded owner plus a focus that
 * has fallen back to the document is as much evidence as remains.
 */
const focusWasIn = (
  root: HTMLElement | null,
  panel: CenterPanel,
  owner: CenterPanel | null
): boolean => {
  const activeElement = document.activeElement;
  if (root && activeElement instanceof HTMLElement && root.contains(activeElement)) return true;
  return owner === panel && (activeElement === null || activeElement === document.body);
};
