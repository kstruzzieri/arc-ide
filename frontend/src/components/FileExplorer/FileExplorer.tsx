// src/components/FileExplorer/FileExplorer.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Panel, PanelAction } from '../layout';
import { MinusIcon } from '../icons';
import {
  useIDEStore,
  useExpandedPaths,
  useSelectedPath,
  useIsRootExpanded,
  useIsLoadingTree,
  useTreeError,
  useActiveFileId,
  useWorkspace,
} from '../../stores/ideStore';
import { useDirectoryTree as useFetchDirectoryTree } from './useDirectoryTree';
import { useFileTreePresentation } from '../../hooks/useFileTreePresentation';
import { useOpenFolder } from '../../hooks/useOpenFolder';
import { useEnsurePathLoaded } from '../../hooks/useEnsurePathLoaded';
import { TreeRow, ROW_HEIGHT, rowDomId } from './TreeRow';
import { TreeViewToggle } from './TreeViewToggle';
import { WorkspaceTabs } from './WorkspaceTabs';
import { flattenVisibleTree } from '../../utils/flattenTree';
import type { FlatRow } from '../../utils/flattenTree';
import { useTreeKeyboardNav } from './useTreeKeyboardNav';
import { ensureEditorFileOpen } from '../../utils/editorNavigation';
import { relativePathFromRoot } from '../../utils/workspaceRegions';
import { useGitStatusByPath } from '../../stores/gitStore';
import { normalizeFsPath } from '../../utils/paths';
import { accentVar } from '../../utils/accent';
import styles from './FileExplorer.module.css';

export function FileExplorer() {
  const workspace = useWorkspace();
  const expandedPaths = useExpandedPaths();
  const selectedPath = useSelectedPath();
  const isRootExpanded = useIsRootExpanded();
  const isLoadingTree = useIsLoadingTree();
  const treeError = useTreeError();
  const activeFileId = useActiveFileId();

  const presentation = useFileTreePresentation();
  const {
    mode,
    rootLabel,
    rootPath,
    roots,
    scopedError,
    rootUnreadable,
    getRegionAccent,
    getFileAccent,
    getOwnershipAccent,
    treeAccent,
  } = presentation;
  const gitStatusByPath = useGitStatusByPath();

  const ensurePathLoaded = useEnsurePathLoaded();
  const toggleExpanded = useIDEStore((state) => state.toggleExpanded);
  const toggleRootExpanded = useIDEStore((state) => state.toggleRootExpanded);
  const setSelectedPath = useIDEStore((state) => state.setSelectedPath);
  const toggleLeftPanel = useIDEStore((state) => state.toggleLeftPanel);

  // Generation guard: each new activeFileId gets a unique generation number.
  // If the workspace or activeFileId changes mid-flight, the old async chain sees
  // a stale gen and aborts before writing to the store.
  const revealGenRef = useRef(0);

  // Sync active editor file into the tree selection + sequentially load any
  // unloaded ancestor dirs before expanding them (lazy-load reveal).
  useEffect(() => {
    // Always bump generation so any in-flight reveal from a previous activeFileId
    // or workspace sees a stale gen and aborts.
    const gen = ++revealGenRef.current;

    if (!activeFileId) return;

    // Always sync selection immediately so the tree highlights the file even
    // when it's already visible (matching old synchronous behavior).
    if (activeFileId !== useIDEStore.getState().selectedPath) {
      setSelectedPath(activeFileId);
    }

    const ws = workspace;
    const relPath = ws ? relativePathFromRoot(activeFileId, ws.path) : null;
    if (!ws || !relPath) return;

    const rel = relPath.split('/');
    const sep = ws.path.includes('\\') ? '\\' : '/';

    void (async () => {
      let cursor = ws.path;
      const toExpand: string[] = [];
      for (let i = 0; i < rel.length - 1; i++) {
        cursor += sep + rel[i];
        await ensurePathLoaded(cursor);
        const afterLoad = useIDEStore.getState();
        if (revealGenRef.current !== gen || afterLoad.workspace !== ws) return;
        if (afterLoad.dirtyPaths.has(cursor)) return;
        toExpand.push(cursor);
      }
      const cur = useIDEStore.getState();
      const next = new Set(cur.expandedPaths);
      toExpand.forEach((p) => next.add(p));
      useIDEStore.setState({ expandedPaths: next, selectedPath: activeFileId });
    })();
  }, [activeFileId, ensurePathLoaded, setSelectedPath, workspace]);

  // Workspace-View scoped hydration: when findScopedNode returns null (scopedError),
  // load the relDir chain in the background. If the path exists but was unloaded,
  // mergeChildren will update the tree and scopedError will clear on next render.
  // We track scopeHydrating to show a skeleton while the load is in-flight rather
  // than flashing the error briefly before the node appears.
  const [scopeHydrating, setScopeHydrating] = useState(false);
  // Track which relDir we're hydrating so we don't restart on unrelated re-renders.
  const hydratingForRef = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== 'workspace') {
      setScopeHydrating(false);
      hydratingForRef.current = null;
      return;
    }
    if (!scopedError) {
      // Scope found — reset so next error triggers a fresh hydration.
      setScopeHydrating(false);
      hydratingForRef.current = null;
      return;
    }
    const ws = workspace;
    const active = useIDEStore
      .getState()
      .workspaces.find((w) => w.id === useIDEStore.getState().activeWorkspaceId);
    const relDir = active?.relDir ?? '';
    if (!ws || !relDir) {
      setScopeHydrating(false);
      hydratingForRef.current = null;
      return;
    }
    // Already hydrating this exact relDir — don't restart (avoids loops if the path
    // genuinely doesn't exist and each render re-triggers the effect).
    if (hydratingForRef.current === relDir) return;
    hydratingForRef.current = relDir;
    let cancelled = false;
    setScopeHydrating(true);
    const sep = ws.path.includes('\\') ? '\\' : '/';
    void (async () => {
      let cursor = ws.path;
      for (const seg of relDir.split('/')) {
        await ensurePathLoaded(cursor);
        const state = useIDEStore.getState();
        if (cancelled || state.workspace !== ws) return;
        if (state.dirtyPaths.has(cursor)) {
          setScopeHydrating(false);
          return;
        }
        cursor += sep + seg;
      }
      await ensurePathLoaded(cursor);
      if (cancelled || useIDEStore.getState().workspace !== ws) return;
      setScopeHydrating(false);
    })();
    return () => {
      cancelled = true;
      hydratingForRef.current = null;
    };
    // scopedError triggers hydration when scope node is missing; workspace identity
    // invalidates a same-path close/reopen while rootPath handles ordinary switches.
  }, [mode, scopedError, rootPath, ensurePathLoaded, workspace]);

  const { openFolder } = useOpenFolder();
  const { refetch } = useFetchDirectoryTree();

  const rows = useMemo<FlatRow[]>(
    () =>
      flattenVisibleTree({
        roots,
        expandedPaths,
        selectedPath,
        getRegionAccent,
        getFileAccent,
        getOwnershipAccent,
        rootOwnershipAccent: treeAccent,
        isRootExpanded,
        rootLabel,
        rootPath,
      }),
    [
      roots,
      expandedPaths,
      selectedPath,
      getRegionAccent,
      getFileAccent,
      getOwnershipAccent,
      treeAccent,
      isRootExpanded,
      rootLabel,
      rootPath,
    ]
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Primitive handlers — single source of truth; used by both TreeRow and actions.
  const handleToggle = useCallback(
    (kind: 'root' | 'entry', path?: string) => {
      if (kind === 'root') {
        const willExpand = !useIDEStore.getState().isRootExpanded;
        toggleRootExpanded();
        if (willExpand) void ensurePathLoaded(rootPath);
        return;
      }
      if (!path) return;
      const willExpand = !useIDEStore.getState().expandedPaths.has(path);
      toggleExpanded(path);
      if (willExpand) void ensurePathLoaded(path);
    },
    [toggleRootExpanded, toggleExpanded, ensurePathLoaded, rootPath]
  );
  const handleSelect = useCallback((path: string) => setSelectedPath(path), [setSelectedPath]);
  const handleOpen = useCallback((path: string) => void ensureEditorFileOpen(path), []);
  const handleHidePanel = useCallback(() => toggleLeftPanel(), [toggleLeftPanel]);

  // Keyboard-nav action adapters — thin wrappers over the primitive handlers above.
  const actions = useMemo(
    () => ({
      toggle: (row: FlatRow) => handleToggle(row.kind, row.entry?.path),
      select: (row: FlatRow) => {
        if (row.entry) handleSelect(row.entry.path);
      },
      open: (row: FlatRow) => {
        if (row.entry && !row.entry.isDir) handleOpen(row.entry.path);
      },
    }),
    [handleToggle, handleSelect, handleOpen]
  );

  const { activeKey, setActiveKey, activeId, onKeyDown } = useTreeKeyboardNav({
    rows,
    actions,
    virtualizer,
  });

  // Active-file reveal: once ancestors are expanded and rows recomputed, scroll
  // the selected row into view and mark it the keyboard-active descendant.
  // lastRevealed guards against re-running when expandedPaths changes (which
  // rebuilds `rows`) but selectedPath has not changed.
  const lastRevealed = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedPath) return;
    const idx = rows.findIndex((r) => r.kind === 'entry' && r.entry!.path === selectedPath);
    if (idx < 0) {
      // Selected row is not currently visible (an ancestor was collapsed). Clear
      // the guard so the row re-reveals if it reappears, even if selectedPath is
      // unchanged.
      lastRevealed.current = null;
      return;
    }
    if (selectedPath === lastRevealed.current) return;
    lastRevealed.current = selectedPath;
    setActiveKey(rows[idx].key);
    virtualizer.scrollToIndex(idx, { align: 'auto' });
  }, [selectedPath, rows, virtualizer, setActiveKey]);

  const renderContent = () => {
    if (isLoadingTree) return <FileExplorerSkeleton />;
    if (treeError) return <FileExplorerError message={treeError} onRetry={refetch} />;
    if (!workspace) {
      return <FileExplorerEmpty message="Open a folder to get started" onOpenFolder={openFolder} />;
    }
    if (scopeHydrating) return <FileExplorerSkeleton />;
    if (scopedError) {
      return (
        <div className={styles.scopedError} role="status">
          <p>Workspace folder not found</p>
        </div>
      );
    }
    if (roots.length === 0 && !rootUnreadable) {
      return <FileExplorerEmpty message="No files in workspace" onOpenFolder={openFolder} />;
    }

    const virtualItems = virtualizer.getVirtualItems();
    // aria-activedescendant must reference an element that is actually in the DOM.
    // With virtualization the active row only exists while inside the window, so
    // omit the attribute when it is scrolled out rather than dangle a missing id.
    const activeRowRendered =
      activeId !== undefined && virtualItems.some((vi) => rows[vi.index]?.key === activeKey);

    return (
      <div
        ref={scrollRef}
        className={`${styles.scrollArea}${treeAccent ? ` ${styles.workspaceTree}` : ''}`}
        role="tree"
        aria-label="File explorer"
        aria-activedescendant={activeRowRendered ? activeId : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={
          treeAccent
            ? ({ '--tree-accent': accentVar(treeAccent) } as React.CSSProperties)
            : undefined
        }
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          {virtualItems.map((vi) => {
            const row = rows[vi.index];
            const unreadable =
              row.kind === 'root' ? rootUnreadable : Boolean(row.entry?.unreadable);
            return (
              <div
                key={row.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${ROW_HEIGHT}px`,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <TreeRow
                  kind={row.kind}
                  path={row.entry?.path}
                  name={row.name}
                  depth={row.depth}
                  level={row.level}
                  isDir={row.isDir}
                  isExpanded={row.isExpanded}
                  isSelected={row.isSelected}
                  regionAccent={row.regionAccent}
                  fileAccent={row.fileAccent}
                  ownershipAccent={row.ownershipAccent}
                  setSize={row.setSize}
                  posInSet={row.posInSet}
                  rootPath={row.rootPath}
                  rowId={rowDomId(row.key)}
                  isActive={row.key === activeKey}
                  canExpand={row.canExpand || Boolean(row.entry?.isDir && unreadable)}
                  unreadable={unreadable}
                  gitStatus={
                    row.entry ? gitStatusByPath[normalizeFsPath(row.entry.path)] : undefined
                  }
                  onToggle={handleToggle}
                  onSelect={handleSelect}
                  onOpen={handleOpen}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Panel
      title={<TreeViewToggle />}
      actions={
        <PanelAction
          icon={<MinusIcon />}
          title="Hide Panel"
          ariaLabel="Hide Panel"
          onClick={handleHidePanel}
        />
      }
    >
      <div className={styles.explorerBody}>
        {mode === 'workspace' && <WorkspaceTabs />}
        <div className={styles.tree}>{renderContent()}</div>
      </div>
    </Panel>
  );
}

const SKELETON_WIDTHS = [75, 60, 85, 70, 90];

function FileExplorerSkeleton() {
  return (
    <div className={styles.skeleton} role="status" aria-busy="true" aria-label="Loading file tree">
      {SKELETON_WIDTHS.map((width, i) => (
        <div key={i} className={styles.skeletonItem} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

interface FileExplorerEmptyProps {
  message: string;
  onOpenFolder?: () => void;
}

function FileExplorerEmpty({ message, onOpenFolder }: FileExplorerEmptyProps) {
  return (
    <div className={styles.empty}>
      <p>{message}</p>
      <button type="button" className={styles.openButton} onClick={onOpenFolder}>
        Open Folder
      </button>
    </div>
  );
}

interface FileExplorerErrorProps {
  message: string;
  onRetry: () => void;
}

function FileExplorerError({ message, onRetry }: FileExplorerErrorProps) {
  return (
    <div className={styles.error}>
      <p>{message}</p>
      <button type="button" className={styles.retryButton} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
