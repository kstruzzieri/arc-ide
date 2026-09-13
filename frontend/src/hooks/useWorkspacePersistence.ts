import { useEffect, useRef, useCallback } from 'react';
import { useIDEStore } from '../stores/ideStore';
import {
  CancelBeforeClose,
  ConfirmBeforeCloseReady,
  SaveWorkspaceState,
  LoadWorkspaceState,
  ReadFile,
} from '../wails/bindings';
import { EventsOn } from '../wails/runtime';
import type { workspace, filesystem } from '../wails/bindings';
import { createEditorFile } from '../utils/editorFile';
import { pathsReferToSameFile } from '../utils/lspUri';
import { relativePathFromRoot } from '../utils/workspaceRegions';
import { normalizeCenterLayout } from '../utils/centerLayout';
import { getCachedWorkspaceTree, setCachedWorkspaceTree } from '../utils/workspaceTreeCache';
import { ensurePathLoaded } from './useEnsurePathLoaded';
import { drainRunHistoryForClose } from './useRunOutput';

const SAVE_DEBOUNCE_MS = 2000;

interface WorkspaceIdentity {
  path: string;
  name: string;
}

interface CollectWorkspaceOptions {
  includeTreeSnapshot?: boolean;
}

interface ReportedSaveFailure {
  message: string;
  // Set by a successful restore: the next refusal is reported even if its
  // message is the one already shown.
  rearmed: boolean;
}

/**
 * True when every top-level entry of `snapshot` is an immediate child of `workspacePath`.
 * A snapshot whose entries point elsewhere is cross-workspace pollution
 * (a wrong-project tree saved under this path by a buggy prior switch) and
 * must not be applied. Empty snapshots are never "belonging" — there is
 * nothing to paint and applying `[]` would clobber a correct fresh fetch.
 */
function treeSnapshotBelongsTo(snapshot: filesystem.FileEntry[], workspacePath: string): boolean {
  if (!snapshot.length) return false;
  return snapshot.every((entry) => {
    const rel = relativePathFromRoot(entry.path, workspacePath);
    return rel !== null && rel !== '' && !rel.includes('/');
  });
}

/**
 * Resolves which directory tree to serialize as the explorer snapshot.
 *
 * With an identity override we're flushing a *different* workspace than the
 * live one (a switch flush). At that moment `state.directoryTree` has already
 * been swapped to the NEW workspace by openWorkspaceByPath, so serializing it
 * would persist the wrong project's tree under the old path. Pull the old
 * workspace's tree from the in-memory cache instead, and return undefined on a
 * cache miss rather than the wrong live tree.
 */
function resolveTreeSnapshot(
  directoryTree: filesystem.FileEntry[],
  overrideIdentity?: WorkspaceIdentity
): filesystem.FileEntry[] | undefined {
  if (overrideIdentity) {
    return getCachedWorkspaceTree(overrideIdentity.path);
  }
  return directoryTree;
}

/**
 * Collects the current workspace state from the Zustand store
 * and maps it to the Go backend's WorkspaceState shape.
 *
 * Accepts an optional identity override so callers can serialize
 * the current editor/explorer state under a *different* workspace
 * path (e.g., when flushing the old workspace before a switch).
 */
function collectWorkspaceState(
  overrideIdentity?: WorkspaceIdentity,
  options?: CollectWorkspaceOptions
): workspace.State | null {
  const state = useIDEStore.getState();
  const includeTreeSnapshot = options?.includeTreeSnapshot ?? false;

  const wsPath = overrideIdentity?.path ?? state.workspace?.path;
  const wsName = overrideIdentity?.name ?? state.workspace?.name;
  if (!wsPath) return null;

  return {
    workspacePath: wsPath,
    workspaceName: wsName ?? '',
    lastOpened: '', // set by backend
    layout: {
      panelSizes: { ...state.panelSizes },
      leftCollapsed: state.isLeftPanelCollapsed,
      rightCollapsed: state.isRightPanelCollapsed,
      bottomCollapsed: state.isBottomPanelCollapsed,
      // #271: preferences only. The transient centerReveal and any effective
      // (window-pressure) collapse are deliberately not written.
      centerOrder: state.centerOrder,
      golemCollapsed: state.isGolemPanelCollapsed,
      filesCollapsed: state.isFilesPanelCollapsed,
    },
    editor: {
      activeFilePath: state.activeFileId ?? '',
      openFiles: state.openFiles.map((f) => ({
        path: f.path,
        cursorLine: state.cursorPositions[f.id]?.line ?? 1,
        cursorColumn: state.cursorPositions[f.id]?.column ?? 1,
        scrollTop: state.scrollPositions[f.id] ?? 0,
      })),
    },
    explorer: {
      expandedPaths: Array.from(state.expandedPaths),
      rootExpanded: state.isRootExpanded,
      treeSnapshot: includeTreeSnapshot
        ? resolveTreeSnapshot(state.directoryTree, overrideIdentity)
        : undefined,
    },
    activeSidebar: state.activeSidebarView,
    hiddenProfileIds: state.hiddenProfileIds,
    activeWorkspaceId: state.activeWorkspaceId,
  } as workspace.State;
}

/**
 * Restores workspace state from the backend after a folder is opened.
 * Accepts an AbortSignal so the caller can cancel a stale restore when
 * the user switches workspaces before the previous restore completes.
 * A load that resolves re-arms the workspace's refused-save report, so the
 * next refusal is news again. The toast stays: the backend latch holds for
 * the session, so the warning is still true until a save succeeds.
 */
async function restoreWorkspaceState(
  workspacePath: string,
  signal: AbortSignal,
  reportedSaveFailures: Map<string, ReportedSaveFailure>
): Promise<void> {
  const store = useIDEStore.getState();
  store.setRestoringWorkspace(true);

  try {
    const cachedTree = getCachedWorkspaceTree(workspacePath);

    // Reset workspace-scoped state before applying saved values.
    store.resetWorkspaceSession();

    if (cachedTree !== undefined) {
      store.setDirectoryTree(cachedTree);
    }

    const state = await LoadWorkspaceState(workspacePath);
    if (signal.aborted) return;
    const reported = reportedSaveFailures.get(workspacePath);
    if (reported !== undefined) reported.rearmed = true;
    if (!state) return; // first time opening, use defaults

    // Restore layout
    if (state.layout) {
      // Validate before the setters. A wrongly *typed* size never reaches here:
      // Go's decode rejects the whole file on a type mismatch, so a hand-edited
      // `"260"` fails the load outright. What does reach here is an absent or
      // null field and any finite number the file cares to name — zero, a
      // negative, an absurd one — so the guard is about range, not type.
      const sizes = state.layout.panelSizes;
      for (const panel of ['left', 'right', 'bottom'] as const) {
        const size: unknown = sizes?.[panel];
        if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
          store.setPanelSize(panel, Math.max(1, Math.round(size)));
        }
      }

      // #271: one normalized, atomic apply. Direct setters alone would not make
      // a malformed both-collapsed pair order-independent, so the normalizer
      // decides the whole pair first.
      store.applyCenterLayout(
        normalizeCenterLayout({
          centerOrder: state.layout.centerOrder,
          golemWidth: state.layout.panelSizes?.golem,
          golemCollapsed: state.layout.golemCollapsed,
          filesCollapsed: state.layout.filesCollapsed,
        })
      );

      // Restore collapsed states — only toggle if a real boolean differs, so an
      // absent legacy field cannot toggle a default panel closed.
      const current = useIDEStore.getState();
      if (
        typeof state.layout.leftCollapsed === 'boolean' &&
        state.layout.leftCollapsed !== current.isLeftPanelCollapsed
      ) {
        store.toggleLeftPanel();
      }
      if (
        typeof state.layout.rightCollapsed === 'boolean' &&
        state.layout.rightCollapsed !== current.isRightPanelCollapsed
      ) {
        store.toggleRightPanel();
      }
      if (
        typeof state.layout.bottomCollapsed === 'boolean' &&
        state.layout.bottomCollapsed !== current.isBottomPanelCollapsed
      ) {
        store.toggleBottomPanel();
      }
    }

    // Restore sidebar view
    if (state.activeSidebar) {
      store.setSidebarView(state.activeSidebar as 'explorer' | 'search' | 'git' | 'run');
    }

    // Restore hidden profile IDs
    if (state.hiddenProfileIds) {
      useIDEStore.setState({ hiddenProfileIds: state.hiddenProfileIds });
    }

    // Restore active workspace selection
    if (state.activeWorkspaceId) {
      restoreActiveWorkspaceId(state.activeWorkspaceId);
    }

    // Restore explorer expanded paths
    if (state.explorer) {
      if (state.explorer.expandedPaths) {
        useIDEStore.setState({
          expandedPaths: new Set(state.explorer.expandedPaths),
        });
      }
      if (state.explorer.rootExpanded !== undefined) {
        useIDEStore.setState({ isRootExpanded: state.explorer.rootExpanded });
      }
      // Only apply a snapshot that actually belongs to this workspace. A
      // foreign snapshot is disk pollution from a prior buggy switch; ignoring
      // it here self-heals that state — fetchTree then repopulates correctly.
      if (
        state.explorer.treeSnapshot &&
        treeSnapshotBelongsTo(state.explorer.treeSnapshot, workspacePath)
      ) {
        setCachedWorkspaceTree(workspacePath, state.explorer.treeSnapshot);
        store.setDirectoryTree(state.explorer.treeSnapshot);
      }

      // Hydrate each persisted expanded path so restored subtrees are fresh,
      // not reliant on the (optional) treeSnapshot for correctness.
      // ponytail: ancestor-first ensures parent nodes exist before children are merged.
      const expanded = state.explorer.expandedPaths ?? [];
      const underRoot = expanded
        .map((path) => ({ path, rel: relativePathFromRoot(path, workspacePath) }))
        .filter((item): item is { path: string; rel: string } => item.rel !== null)
        .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length);
      for (const { path } of underRoot) {
        if (signal.aborted) return;
        await ensurePathLoaded(path);
      }
    }

    if (signal.aborted) return;

    // Restore open files
    if (state.editor?.openFiles?.length) {
      const scrollPositions: Record<string, number> = {};
      const cursorPositions: Record<string, { line: number; column: number }> = {};

      for (const fileState of state.editor.openFiles) {
        if (signal.aborted) return;
        try {
          const fileContent = await ReadFile(fileState.path);
          if (signal.aborted) return;
          // Matches the other ReadFile call sites (gitStore, editorNavigation):
          // a null answer is a backend contract violation, not a fact about
          // the file, so it goes through the catch below rather than being
          // indistinguishable from a deliberate skip.
          if (fileContent === null) {
            throw new Error(`ReadFile returned no content for ${fileState.path}`);
          }
          if (fileContent.isBinary) continue;

          const editorFile = createEditorFile(fileState.path, fileContent);
          store.openFile(editorFile);

          // Use the normalized file ID for view-state keys so they match
          // the ID that openFile stored (important on Windows where
          // createEditorFile normalizes c:/... -> C:\...).
          const fileId = editorFile.id;
          if (fileState.scrollTop > 0) {
            scrollPositions[fileId] = fileState.scrollTop;
          }
          if (fileState.cursorLine > 0) {
            cursorPositions[fileId] = {
              line: fileState.cursorLine,
              column: fileState.cursorColumn || 1,
            };
          }
        } catch (err) {
          // The file is gone, unreadable, or came back empty-handed — drop it
          // from the restore and keep going, so one missing file cannot cost
          // the user every other tab in the session. Still logged, so a
          // silently dropped tab has a trail to follow.
          console.warn(`Failed to restore file ${fileState.path}:`, err);
          continue;
        }
      }

      if (signal.aborted) return;

      // Apply saved view state in bulk
      useIDEStore.setState((prev) => ({
        scrollPositions: { ...prev.scrollPositions, ...scrollPositions },
        cursorPositions: { ...prev.cursorPositions, ...cursorPositions },
      }));

      // Set active file (only if it was successfully opened).
      // Compare with pathsReferToSameFile since the saved activeFilePath may
      // differ in case/slash form from the normalized EditorFile.id.
      if (state.editor.activeFilePath) {
        const openFiles = useIDEStore.getState().openFiles;
        const match = openFiles.find((f) =>
          pathsReferToSameFile(f.id, state.editor.activeFilePath)
        );
        if (match) {
          store.setActiveFile(match.id);
        }
      }
    }
  } catch (err) {
    // Surface it: a silently failed restore is indistinguishable from a first
    // open, and the user's tabs/layout appear to have vanished.
    console.warn('Failed to restore workspace state:', err);
    if (!signal.aborted) {
      useIDEStore
        .getState()
        .showToast(
          `Failed to restore workspace session: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        );
    }
  } finally {
    if (!signal.aborted) {
      useIDEStore.getState().setRestoringWorkspace(false);
    }
  }
}

function restoreActiveWorkspaceId(activeWorkspaceId: string): void {
  const state = useIDEStore.getState();
  if (state.workspaces.length > 0) {
    state.setActiveWorkspace(activeWorkspaceId);
    return;
  }

  // Detection may not have populated the list yet; setWorkspaces will validate
  // this raw id when the detected definitions arrive.
  useIDEStore.setState({ activeWorkspaceId });
}

/**
 * Main persistence hook. Handles:
 * - Debounced save on any relevant state change
 * - Restore on workspace switch (with correct flush of old workspace)
 * - Immediate flush on visibility change, blur, and app close
 */
export function useWorkspacePersistence(
  beforeClose?: () => Promise<void>,
  drainHistory: () => Promise<void> = drainRunHistoryForClose,
  closeGuard?: () => Promise<boolean>
) {
  const workspace = useIDEStore((state) => state.workspace);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveOptionsRef = useRef<CollectWorkspaceOptions>({});
  const prevWorkspaceRef = useRef<WorkspaceIdentity | null>(null);
  // Workspace path -> the refused-save toast shown for it. A successful save
  // retires the toast and the entry. A successful restore keeps the entry
  // (a later success must still retire the toast) but re-arms the report,
  // so the next refusal is shown again.
  const reportedSaveFailuresRef = useRef(new Map<string, ReportedSaveFailure>());

  /**
   * Flush save — optionally for a specific workspace identity.
   * When switching workspaces, the caller passes the OLD identity
   * so the current editor state is saved under the correct path.
   *
   * If a save is already in flight, waits for it to finish and then
   * saves a fresh snapshot so recent changes are never dropped.
   */
  const flushSave = useCallback(
    async (identityOverride?: WorkspaceIdentity, options?: CollectWorkspaceOptions) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      const saveOptions = {
        includeTreeSnapshot: Boolean(
          pendingSaveOptionsRef.current.includeTreeSnapshot || options?.includeTreeSnapshot
        ),
      };
      pendingSaveOptionsRef.current = {};

      // For workspace switches, capture the old session before restore/detection
      // clears workspace-scoped state, then wait for any in-flight save.
      const previousWorkspaceState = identityOverride
        ? collectWorkspaceState(identityOverride, saveOptions)
        : null;

      // Wait for any in-flight save to complete before collecting a fresh snapshot.
      await savePromiseRef.current;

      const state = previousWorkspaceState ?? collectWorkspaceState(identityOverride, saveOptions);
      if (!state) return;

      const promise = SaveWorkspaceState(state)
        .then(() => {
          // Saving works again: retire the report and its toast, shown or held.
          const shown = reportedSaveFailuresRef.current.get(state.workspacePath);
          if (shown === undefined) return;
          reportedSaveFailuresRef.current.delete(state.workspacePath);
          useIDEStore.getState().retireToast(shown.message);
        })
        .catch((err) => {
          console.error('Failed to save workspace state:', err);
          // Show a refused save once per workspace and reason, in the
          // backend's own words (#290's latch names the consequence, the
          // file, the reason and the remedy). Sticky, because the user has
          // to act on it. The workspace path makes the message this
          // workspace's own, so retiring it can never take another
          // workspace's toast down. A different reason replaces the earlier
          // report: the latest refusal is the one to act on.
          const message = `Workspace session not saved (${state.workspacePath}): ${err instanceof Error ? err.message : String(err)}`;
          const previous = reportedSaveFailuresRef.current.get(state.workspacePath);
          if (previous !== undefined && previous.message === message && !previous.rearmed) return;
          const ide = useIDEStore.getState();
          if (previous !== undefined && previous.message !== message) {
            ide.retireToast(previous.message);
          }
          reportedSaveFailuresRef.current.set(state.workspacePath, { message, rearmed: false });
          ide.showToast(message, 'error', true);
        })
        .finally(() => {
          if (savePromiseRef.current === promise) {
            savePromiseRef.current = Promise.resolve();
          }
        });

      savePromiseRef.current = promise;
      await promise;
    },
    []
  );

  const scheduleSave = useCallback(
    (options?: CollectWorkspaceOptions) => {
      if (useIDEStore.getState().isRestoringWorkspace) return;

      pendingSaveOptionsRef.current = {
        includeTreeSnapshot: Boolean(
          pendingSaveOptionsRef.current.includeTreeSnapshot || options?.includeTreeSnapshot
        ),
      };

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flushSave(), SAVE_DEBOUNCE_MS);
    },
    [flushSave]
  );

  // Subscribe to relevant state changes
  useEffect(() => {
    if (!workspace) return;

    const unsubscribe = useIDEStore.subscribe((state, prevState) => {
      if (state.isRestoringWorkspace) return;
      if (state.workspace?.path !== prevState.workspace?.path) return;

      if (state.workspace?.path && state.directoryTree !== prevState.directoryTree) {
        setCachedWorkspaceTree(state.workspace.path, state.directoryTree);
      }

      const treeChanged = state.directoryTree !== prevState.directoryTree;
      const shouldSaveTree = treeChanged;

      if (
        state.openFiles !== prevState.openFiles ||
        state.activeFileId !== prevState.activeFileId ||
        shouldSaveTree ||
        state.panelSizes !== prevState.panelSizes ||
        state.isLeftPanelCollapsed !== prevState.isLeftPanelCollapsed ||
        state.isRightPanelCollapsed !== prevState.isRightPanelCollapsed ||
        state.isBottomPanelCollapsed !== prevState.isBottomPanelCollapsed ||
        state.centerOrder !== prevState.centerOrder ||
        state.isGolemPanelCollapsed !== prevState.isGolemPanelCollapsed ||
        state.isFilesPanelCollapsed !== prevState.isFilesPanelCollapsed ||
        state.activeSidebarView !== prevState.activeSidebarView ||
        state.expandedPaths !== prevState.expandedPaths ||
        state.isRootExpanded !== prevState.isRootExpanded ||
        state.scrollPositions !== prevState.scrollPositions ||
        state.cursorPositions !== prevState.cursorPositions ||
        state.hiddenProfileIds !== prevState.hiddenProfileIds ||
        state.activeWorkspaceId !== prevState.activeWorkspaceId
      ) {
        scheduleSave(shouldSaveTree ? { includeTreeSnapshot: true } : undefined);
      }
    });

    return () => {
      unsubscribe();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [workspace, scheduleSave]);

  // Restore state when workspace changes.
  // An AbortController cancels any in-flight restore when the workspace
  // changes again, preventing stale state from leaking into the new session.
  useEffect(() => {
    if (!workspace?.path) return;

    // A same-path rerun (rename: the name dep changed) whose cleanup just
    // aborted an in-flight restore must act as that restore's successor and
    // run it again — the aborted run deliberately leaves isRestoringWorkspace
    // set for its successor, and skipping here would wedge it (and disable
    // every debounced save) for the rest of the session.
    const interruptedRestore = useIDEStore.getState().isRestoringWorkspace;

    // Don't restore on first mount if workspace was already set.
    if (prevWorkspaceRef.current?.path === workspace.path && !interruptedRestore) {
      // Keep the recorded name fresh so a later switch-flush serializes the
      // outgoing state under the current identity, not the pre-rename one.
      prevWorkspaceRef.current = { path: workspace.path, name: workspace.name };
      return;
    }

    // Flush save for previous workspace BEFORE updating the ref.
    // Pass the old identity so collectWorkspaceState serializes
    // the current editor state under the OLD workspace path. Never flush
    // mid-restore: an aborted restore's partial state must not overwrite the
    // last good snapshot (the restart below re-reads it instead).
    if (prevWorkspaceRef.current && !interruptedRestore) {
      void flushSave(prevWorkspaceRef.current, { includeTreeSnapshot: true });
    }

    prevWorkspaceRef.current = { path: workspace.path, name: workspace.name };

    const controller = new AbortController();
    restoreWorkspaceState(workspace.path, controller.signal, reportedSaveFailuresRef.current);

    return () => {
      controller.abort();
    };
  }, [workspace?.path, workspace?.name, flushSave]);

  // Flush on visibility change and window blur
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        void flushSave(undefined, { includeTreeSnapshot: true });
      }
    };
    const handleBlur = () => {
      void flushSave(undefined, { includeTreeSnapshot: true });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleBlur);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleBlur);
    };
  }, [flushSave]);

  // Listen for app:beforeclose event from Go backend. The backend is now
  // waiting in `awaiting_frontend` and has torn down nothing, so this handler
  // owns the decision: confirm and let the app quit, or cancel and leave it
  // exactly as it was.
  useEffect(() => {
    // abandonClose returns the backend to idle. A transport failure is
    // reported, never thrown: the backend backstop is the remaining net.
    const abandonClose = async () => {
      try {
        await CancelBeforeClose();
      } catch (err) {
        console.error('Failed to cancel app close:', err);
      }
    };

    const handleBeforeClose = async () => {
      try {
        // The guard settles anything that must not be interrupted — an
        // in-flight settings write, an unsaved draft, staged secrets — and
        // answers whether the close may proceed at all.
        if (closeGuard && !(await closeGuard())) {
          await abandonClose();
          return;
        }
        await Promise.all([
          flushSave(undefined, { includeTreeSnapshot: true }),
          beforeClose?.() ?? Promise.resolve(),
          Promise.resolve()
            .then(() => drainHistory())
            .catch((err) => {
              console.error('Failed to drain run history before close:', err);
            }),
        ]);
      } catch (err) {
        // Never approve data loss — and never leave the window wedged behind
        // an unanswered handshake either.
        console.error('Failed to prepare for app close:', err);
        await abandonClose();
        return;
      }
      try {
        await ConfirmBeforeCloseReady();
      } catch (err) {
        console.error('Failed to acknowledge app close:', err);
      }
    };

    const cancel = EventsOn('app:beforeclose', () => {
      void handleBeforeClose();
    });
    return cancel;
  }, [beforeClose, closeGuard, drainHistory, flushSave]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);
}
