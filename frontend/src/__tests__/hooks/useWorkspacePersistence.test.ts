import { act, renderHook, waitFor } from '@testing-library/react';
import { useIDEStore } from '../../stores/ideStore';
import {
  clearWorkspaceTreeCache,
  getCachedWorkspaceTree,
  setCachedWorkspaceTree,
} from '../../utils/workspaceTreeCache';

const mockConfirmBeforeCloseReady = jest.fn(() => Promise.resolve());
const mockCancelBeforeClose = jest.fn(() => Promise.resolve());
let lastSavedWorkspaceState: unknown = null;
const mockSaveWorkspaceState = jest.fn((state: unknown) => {
  lastSavedWorkspaceState = state;
  return Promise.resolve();
});
const mockLoadWorkspaceState = jest.fn<Promise<unknown>, []>(() => Promise.resolve(null));
const mockReadFile = jest.fn();

let beforeCloseHandler: (() => void) | null = null;

jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    ConfirmBeforeCloseReady: mockConfirmBeforeCloseReady,
    CancelBeforeClose: mockCancelBeforeClose,
    SaveWorkspaceState: mockSaveWorkspaceState,
    LoadWorkspaceState: mockLoadWorkspaceState,
    ReadFile: mockReadFile,
  };
});

jest.mock('../../wails/runtime', () => ({
  EventsOn: jest.fn((event: string, callback: () => void) => {
    if (event === 'app:beforeclose') {
      beforeCloseHandler = callback;
    }
    return jest.fn();
  }),
  WindowSetTitle: jest.fn(),
}));

const mockEnsurePathLoaded = jest.fn<Promise<void>, [string]>(() => Promise.resolve());

jest.mock('../../hooks/useEnsurePathLoaded', () => ({
  ensurePathLoaded: (...args: [string]) => mockEnsurePathLoaded(...args),
  __resetEnsurePathLoaded: jest.fn(),
  useEnsurePathLoaded: jest.fn(() => mockEnsurePathLoaded),
}));

import { filesystem } from '../../wails/bindings';
import { useWorkspacePersistence } from '../../hooks/useWorkspacePersistence';
import { trackRunHistoryClear } from '../../hooks/useRunOutput';
import { openWorkspaceByPath } from '../../utils/workspace';

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsurePathLoaded.mockResolvedValue(undefined);
  beforeCloseHandler = null;
  lastSavedWorkspaceState = null;
  clearWorkspaceTreeCache();

  useIDEStore.getState().resetWorkspaceSession();
  useIDEStore.setState({
    workspace: null,
    directoryTree: [],
    isLoadingTree: false,
    treeError: null,
    toast: null,
    isRestoringWorkspace: false,
  });
});

describe('useWorkspacePersistence', () => {
  it('recovers when a rename re-runs the restore effect mid-restore (no permanent save freeze)', async () => {
    // The restore effect depends on workspace name; a name-only change aborts
    // the in-flight restore, whose finally deliberately leaves the restoring
    // flag set for a successor. The same-path rerun must BE that successor
    // (restart the restore) - otherwise the flag wedges true forever and
    // every debounced save stays disabled for the session.
    let releaseRestore!: (v: unknown) => void;
    mockLoadWorkspaceState.mockReturnValueOnce(
      new Promise((res) => {
        releaseRestore = res;
      })
    );
    useIDEStore.setState({ workspace: { name: 'A', path: '/workspace/w' } });

    const { rerender } = renderHook(() => useWorkspacePersistence());
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(true));

    // Rename the workspace (same path) while the restore hangs.
    act(() => {
      useIDEStore.setState({ workspace: { name: 'B', path: '/workspace/w' } });
    });
    rerender();
    releaseRestore(null);

    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));
  });

  it('resets workspace-scoped UI state to defaults when no saved session exists', async () => {
    useIDEStore.setState({
      workspace: { name: 'new-workspace', path: '/workspace/new-workspace' },
      activeSidebarView: 'git',
      isLeftPanelCollapsed: true,
      isRightPanelCollapsed: true,
      isBottomPanelCollapsed: true,
      panelSizes: { left: 320, right: 360, bottom: 140, golem: 500 },
      expandedPaths: new Set(['/workspace/new-workspace/src']),
      selectedPath: '/workspace/new-workspace/src',
      isRootExpanded: false,
      openFiles: [
        {
          id: '/workspace/new-workspace/main.ts',
          name: 'main.ts',
          path: '/workspace/new-workspace/main.ts',
          language: 'typescript',
          encoding: 'utf-8',
          lineEndings: 'LF',
          content: 'console.log("stale");',
          isModified: false,
        },
      ],
      activeFileId: '/workspace/new-workspace/main.ts',
      cursorPosition: { line: 9, column: 4 },
      scrollPositions: { '/workspace/new-workspace/main.ts': 48 },
      cursorPositions: { '/workspace/new-workspace/main.ts': { line: 9, column: 4 } },
    });

    renderHook(() => useWorkspacePersistence());

    await waitFor(() =>
      expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/workspace/new-workspace')
    );
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    const state = useIDEStore.getState();
    expect(state.activeSidebarView).toBe('explorer');
    expect(state.isLeftPanelCollapsed).toBe(false);
    expect(state.isRightPanelCollapsed).toBe(false);
    expect(state.isBottomPanelCollapsed).toBe(false);
    expect(state.panelSizes).toEqual({ left: 260, right: 280, bottom: 200, golem: 420 });
    expect(state.expandedPaths.size).toBe(0);
    expect(state.selectedPath).toBeNull();
    expect(state.isRootExpanded).toBe(true);
    expect(state.openFiles).toEqual([]);
    expect(state.activeFileId).toBeNull();
    expect(state.cursorPosition).toEqual({ line: 1, column: 1 });
    expect(state.scrollPositions).toEqual({});
    expect(state.cursorPositions).toEqual({});
  });

  it('acknowledges app close even when there is no workspace state to save', async () => {
    renderHook(() => useWorkspacePersistence());

    await waitFor(() => expect(beforeCloseHandler).not.toBeNull());

    act(() => {
      beforeCloseHandler?.();
    });

    await waitFor(() => expect(mockConfirmBeforeCloseReady).toHaveBeenCalledTimes(1));
    expect(mockSaveWorkspaceState).not.toHaveBeenCalled();
  });

  it('flushes pending editor work before acknowledging app close', async () => {
    let resolveFlush!: () => void;
    const flushPendingEdits = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        })
    );
    renderHook(() => useWorkspacePersistence(flushPendingEdits));
    await waitFor(() => expect(beforeCloseHandler).not.toBeNull());

    act(() => {
      beforeCloseHandler?.();
    });
    await waitFor(() => expect(flushPendingEdits).toHaveBeenCalledTimes(1));
    expect(mockConfirmBeforeCloseReady).not.toHaveBeenCalled();

    act(() => resolveFlush());
    await waitFor(() => expect(mockConfirmBeforeCloseReady).toHaveBeenCalledTimes(1));
  });

  // A flush that fails must not approve data loss — and must not leave the app
  // wedged behind an unanswered handshake either: it cancels the close.
  it('cancels the close when pending editor work fails to flush', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const flushPendingEdits = jest.fn(() => Promise.reject(new Error('disk full')));
    try {
      renderHook(() => useWorkspacePersistence(flushPendingEdits));
      await waitFor(() => expect(beforeCloseHandler).not.toBeNull());

      act(() => {
        beforeCloseHandler?.();
      });

      await waitFor(() => expect(flushPendingEdits).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mockCancelBeforeClose).toHaveBeenCalledTimes(1));
      expect(mockConfirmBeforeCloseReady).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  // The close guard is the §5.5 preparation step: settle any settings write,
  // resolve unsaved work, clear secrets. It runs BEFORE the flush, and its
  // answer decides whether the app tears down at all.
  it('flushes and confirms once the close guard approves', async () => {
    const closeGuard = jest.fn(() => Promise.resolve(true));
    const flushPendingEdits = jest.fn(() => Promise.resolve());
    renderHook(() => useWorkspacePersistence(flushPendingEdits, undefined, closeGuard));
    await waitFor(() => expect(beforeCloseHandler).not.toBeNull());

    act(() => {
      beforeCloseHandler?.();
    });

    await waitFor(() => expect(mockConfirmBeforeCloseReady).toHaveBeenCalledTimes(1));
    expect(closeGuard).toHaveBeenCalledTimes(1);
    expect(flushPendingEdits).toHaveBeenCalledTimes(1);
    expect(mockCancelBeforeClose).not.toHaveBeenCalled();
  });

  it.each([
    ['declines', () => Promise.resolve(false)],
    ['fails', () => Promise.reject(new Error('draft prompt exploded'))],
  ])('cancels the close and leaves the app usable when the guard %s', async (_name, guard) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const closeGuard = jest.fn(guard as () => Promise<boolean>);
    const flushPendingEdits = jest.fn(() => Promise.resolve());
    try {
      renderHook(() => useWorkspacePersistence(flushPendingEdits, undefined, closeGuard));
      await waitFor(() => expect(beforeCloseHandler).not.toBeNull());

      act(() => {
        beforeCloseHandler?.();
      });

      await waitFor(() => expect(mockCancelBeforeClose).toHaveBeenCalledTimes(1));
      expect(mockConfirmBeforeCloseReady).not.toHaveBeenCalled();
      // A close the user declined must not flush half-finished work either.
      expect(flushPendingEdits).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  // A cancel that cannot reach the backend is reported, never thrown; the
  // backend backstop is the remaining safety net.
  it('survives a failing CancelBeforeClose', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockCancelBeforeClose.mockRejectedValueOnce(new Error('transport gone'));
    const closeGuard = jest.fn(() => Promise.resolve(false));
    try {
      renderHook(() => useWorkspacePersistence(undefined, undefined, closeGuard));
      await waitFor(() => expect(beforeCloseHandler).not.toBeNull());

      act(() => {
        beforeCloseHandler?.();
      });

      await waitFor(() => expect(mockCancelBeforeClose).toHaveBeenCalledTimes(1));
      expect(mockConfirmBeforeCloseReady).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('acknowledges close when the best-effort history drain rejects', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const drainRunHistoryQueue = jest.fn(() => Promise.reject(new Error('history disk full')));
    const phase2CHook = useWorkspacePersistence as unknown as (
      flushPendingEdits?: () => Promise<void>,
      drainHistory?: () => Promise<void>
    ) => void;
    try {
      renderHook(() => phase2CHook(undefined, drainRunHistoryQueue));
      await waitFor(() => expect(beforeCloseHandler).not.toBeNull());

      act(() => {
        beforeCloseHandler?.();
      });

      await waitFor(() => expect(drainRunHistoryQueue).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mockConfirmBeforeCloseReady).toHaveBeenCalledTimes(1));
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each(['resolve', 'reject'] as const)(
    'waits for a tracked record clear to %s before acknowledging close',
    async (outcome) => {
      let resolveClear!: () => void;
      let rejectClear!: (reason: Error) => void;
      const clear = new Promise<void>((resolve, reject) => {
        resolveClear = resolve;
        rejectClear = reject;
      });
      trackRunHistoryClear(clear);
      renderHook(() => useWorkspacePersistence());
      await waitFor(() => expect(beforeCloseHandler).not.toBeNull());

      act(() => {
        beforeCloseHandler?.();
      });
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(mockConfirmBeforeCloseReady).not.toHaveBeenCalled();

      act(() => {
        if (outcome === 'resolve') {
          resolveClear();
        } else {
          rejectClear(new Error('redaction failed'));
        }
      });
      await waitFor(() => expect(mockConfirmBeforeCloseReady).toHaveBeenCalledTimes(1));
    }
  );

  it('restores a cached explorer tree immediately from saved workspace state', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce({
      workspacePath: '/workspace/cached',
      workspaceName: 'cached',
      layout: null,
      editor: { activeFilePath: '', openFiles: [] },
      explorer: {
        expandedPaths: ['/workspace/cached/src'],
        rootExpanded: true,
        treeSnapshot: [
          filesystem.FileEntry.createFrom({
            name: 'src',
            path: '/workspace/cached/src',
            isDir: true,
            size: 0,
            modTime: new Date().toISOString(),
            children: [
              {
                name: 'App.tsx',
                path: '/workspace/cached/src/App.tsx',
                isDir: false,
                size: 123,
                modTime: new Date().toISOString(),
              },
            ],
          }),
        ],
      },
      activeSidebar: 'explorer',
      hiddenProfileIds: [],
    });

    useIDEStore.setState({
      workspace: { name: 'cached', path: '/workspace/cached' },
      directoryTree: [],
      isLoadingTree: true,
    });

    renderHook(() => useWorkspacePersistence());

    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/workspace/cached'));
    await waitFor(() =>
      expect(useIDEStore.getState().directoryTree[0]?.path).toBe('/workspace/cached/src')
    );

    expect(useIDEStore.getState().isLoadingTree).toBe(false);
  });

  it('hydrates expanded paths in ancestor-first order on restore', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce({
      workspacePath: '/r',
      workspaceName: 'r',
      layout: null,
      editor: { activeFilePath: '', openFiles: [] },
      explorer: {
        // deliberately deep-first to verify sorting
        expandedPaths: ['/r/a/b', '/r/a'],
        rootExpanded: true,
      },
      activeSidebar: 'explorer',
      hiddenProfileIds: [],
    });

    useIDEStore.setState({
      workspace: { name: 'r', path: '/r' },
      directoryTree: [],
      isLoadingTree: false,
    });

    renderHook(() => useWorkspacePersistence());

    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/r'));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    const calls = mockEnsurePathLoaded.mock.calls.map((c) => c[0]);
    expect(calls).toContain('/r/a');
    expect(calls).toContain('/r/a/b');
    // /r/a (depth 2) must be called before /r/a/b (depth 3)
    expect(calls.indexOf('/r/a')).toBeLessThan(calls.indexOf('/r/a/b'));
  });

  it('does not hydrate expanded paths outside the current workspace root', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce({
      workspacePath: '/r',
      workspaceName: 'r',
      layout: null,
      editor: { activeFilePath: '', openFiles: [] },
      explorer: {
        expandedPaths: ['/r/a', '/other/x'],
        rootExpanded: true,
      },
      activeSidebar: 'explorer',
      hiddenProfileIds: [],
    });

    useIDEStore.setState({
      workspace: { name: 'r', path: '/r' },
      directoryTree: [],
      isLoadingTree: false,
    });

    renderHook(() => useWorkspacePersistence());

    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/r'));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    const calls = mockEnsurePathLoaded.mock.calls.map((c) => c[0]);
    expect(calls).toContain('/r/a');
    expect(calls).not.toContain('/other/x');
  });

  it('hydrates Windows expanded paths under the current workspace root', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce({
      workspacePath: 'C:\\repo',
      workspaceName: 'repo',
      layout: null,
      editor: { activeFilePath: '', openFiles: [] },
      explorer: {
        expandedPaths: ['C:\\repo\\a\\b', 'C:\\repo\\a', 'D:\\other\\x'],
        rootExpanded: true,
      },
      activeSidebar: 'explorer',
      hiddenProfileIds: [],
    });

    useIDEStore.setState({
      workspace: { name: 'repo', path: 'C:\\repo' },
      directoryTree: [],
      isLoadingTree: false,
    });

    renderHook(() => useWorkspacePersistence());

    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('C:\\repo'));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    const calls = mockEnsurePathLoaded.mock.calls.map((c) => c[0]);
    expect(calls).toContain('C:\\repo\\a');
    expect(calls).toContain('C:\\repo\\a\\b');
    expect(calls).not.toContain('D:\\other\\x');
    expect(calls.indexOf('C:\\repo\\a')).toBeLessThan(calls.indexOf('C:\\repo\\a\\b'));
  });

  it('persists tree snapshots when the directory tree changes', async () => {
    jest.useFakeTimers();

    try {
      useIDEStore.setState({
        workspace: { name: 'tree-save', path: '/workspace/tree-save' },
        directoryTree: [],
        isLoadingTree: false,
      });

      renderHook(() => useWorkspacePersistence());

      await waitFor(() =>
        expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/workspace/tree-save')
      );
      await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

      const treeEntry = filesystem.FileEntry.createFrom({
        name: 'src',
        path: '/workspace/tree-save/src',
        isDir: true,
        size: 0,
        modTime: new Date().toISOString(),
      });

      act(() => {
        useIDEStore.getState().setDirectoryTree([treeEntry]);
      });

      act(() => {
        jest.advanceTimersByTime(2000);
      });

      await waitFor(() => expect(mockSaveWorkspaceState).toHaveBeenCalled());

      const savedState = lastSavedWorkspaceState as {
        explorer: { treeSnapshot: filesystem.FileEntry[] };
      };
      expect(savedState.explorer.treeSnapshot).toEqual([treeEntry]);
      expect(getCachedWorkspaceTree('/workspace/tree-save')).toEqual([treeEntry]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('saves the previous workspace tree, not the live one, when switching workspaces', async () => {
    const treeA = filesystem.FileEntry.createFrom({
      name: 'main.go',
      path: '/workspace/A/main.go',
      isDir: false,
      size: 1,
      modTime: new Date().toISOString(),
    });
    const treeB = filesystem.FileEntry.createFrom({
      name: '_deployment',
      path: '/workspace/B/_deployment',
      isDir: true,
      size: 0,
      modTime: new Date().toISOString(),
    });

    // Workspace A is open with its tree cached (as the save subscription would
    // have done while A was active).
    setCachedWorkspaceTree('/workspace/A', [treeA]);
    useIDEStore.setState({
      workspace: { name: 'A', path: '/workspace/A' },
      directoryTree: [treeA],
      isLoadingTree: false,
    });

    renderHook(() => useWorkspacePersistence());
    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/workspace/A'));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    mockSaveWorkspaceState.mockClear();

    // Simulate openWorkspaceByPath: swap workspace AND live directoryTree to B
    // in a single store update. This is the moment the switch-flush of A runs.
    act(() => {
      useIDEStore.setState({
        workspace: { name: 'B', path: '/workspace/B' },
        directoryTree: [treeB],
        isLoadingTree: false,
      });
    });

    await waitFor(() =>
      expect(
        mockSaveWorkspaceState.mock.calls.some(
          (c) => (c[0] as { workspacePath: string }).workspacePath === '/workspace/A'
        )
      ).toBe(true)
    );

    const savedForA = mockSaveWorkspaceState.mock.calls
      .map(
        (c) =>
          c[0] as {
            workspacePath: string;
            explorer: { treeSnapshot?: filesystem.FileEntry[] };
          }
      )
      .find((s) => s.workspacePath === '/workspace/A');

    // A's persisted snapshot must be A's tree, never B's live tree.
    expect(savedForA?.explorer.treeSnapshot).toEqual([treeA]);
  });

  it('saves the outgoing hidden profiles when openWorkspaceByPath resets run state', async () => {
    useIDEStore.setState({ workspace: { name: 'A', path: '/workspace/A' } });

    renderHook(() => useWorkspacePersistence());
    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/workspace/A'));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    // Hide two profiles while A is the active workspace.
    act(() => {
      useIDEStore.getState().hideProfile('lint');
      useIDEStore.getState().hideProfile('e2e');
    });
    mockSaveWorkspaceState.mockClear();

    // openWorkspaceByPath clears transient run state before publishing the new
    // workspace identity. The switch-flush of A runs afterwards, so it must
    // still see A's hidden profiles rather than an already-emptied list.
    act(() => {
      openWorkspaceByPath('/workspace/B');
    });

    await waitFor(() =>
      expect(
        mockSaveWorkspaceState.mock.calls.some(
          (c) => (c[0] as { workspacePath: string }).workspacePath === '/workspace/A'
        )
      ).toBe(true)
    );

    const savedForA = mockSaveWorkspaceState.mock.calls
      .map((c) => c[0] as { workspacePath: string; hiddenProfileIds?: string[] })
      .find((s) => s.workspacePath === '/workspace/A');
    expect(savedForA?.hiddenProfileIds).toEqual(['lint', 'e2e']);

    // B starts with no inherited hidden profiles once its restore has run.
    await waitFor(() => expect(useIDEStore.getState().hiddenProfileIds).toEqual([]));
  });

  it('ignores a treeSnapshot whose entries are not under the workspace root', async () => {
    // Simulates disk state already polluted by a prior cross-workspace switch:
    // firn's saved snapshot actually holds quantum-trader's tree.
    mockLoadWorkspaceState.mockResolvedValueOnce({
      workspacePath: '/workspace/firn',
      workspaceName: 'firn',
      layout: null,
      editor: { activeFilePath: '', openFiles: [] },
      explorer: {
        expandedPaths: [],
        rootExpanded: true,
        treeSnapshot: [
          filesystem.FileEntry.createFrom({
            name: '_deployment',
            path: '/workspace/quantum/_deployment',
            isDir: true,
            size: 0,
            modTime: new Date().toISOString(),
          }),
        ],
      },
      activeSidebar: 'explorer',
      hiddenProfileIds: [],
    });

    useIDEStore.setState({
      workspace: { name: 'firn', path: '/workspace/firn' },
      directoryTree: [],
      isLoadingTree: false,
    });

    renderHook(() => useWorkspacePersistence());

    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/workspace/firn'));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    // The foreign (quantum) snapshot must be ignored, not painted under firn,
    // and must not poison the in-memory cache for firn.
    expect(useIDEStore.getState().directoryTree).toEqual([]);
    expect(getCachedWorkspaceTree('/workspace/firn')).toBeUndefined();
  });

  it('ignores a treeSnapshot whose top-level entries are nested descendants', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce({
      workspacePath: '/repo',
      workspaceName: 'repo',
      layout: null,
      editor: { activeFilePath: '', openFiles: [] },
      explorer: {
        expandedPaths: [],
        rootExpanded: true,
        treeSnapshot: [
          filesystem.FileEntry.createFrom({
            name: 'src',
            path: '/repo/frontend/src',
            isDir: true,
            size: 0,
            modTime: new Date().toISOString(),
          }),
        ],
      },
      activeSidebar: 'explorer',
      hiddenProfileIds: [],
    });

    useIDEStore.setState({
      workspace: { name: 'repo', path: '/repo' },
      directoryTree: [],
      isLoadingTree: false,
    });

    renderHook(() => useWorkspacePersistence());

    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/repo'));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    expect(useIDEStore.getState().directoryTree).toEqual([]);
    expect(getCachedWorkspaceTree('/repo')).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // #271 center-pair preferences round-trip
  // ---------------------------------------------------------------------

  /** Minimal saved payload; only `layout` varies between the cases below. */
  const savedStateWithLayout = (layout: unknown, workspacePath = '/workspace/center') => ({
    workspacePath,
    workspaceName: 'center',
    layout,
    editor: { activeFilePath: '', openFiles: [] },
    explorer: { expandedPaths: [], rootExpanded: true },
    activeSidebar: 'explorer',
    hiddenProfileIds: [],
  });

  /** Mount the hook against a repository and wait until its restore has settled. */
  const renderRestored = async (path = '/workspace/center') => {
    useIDEStore.setState({
      workspace: { name: 'center', path },
      directoryTree: [],
      isLoadingTree: false,
    });
    const rendered = renderHook(() => useWorkspacePersistence());
    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith(path));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));
    return rendered;
  };

  const savedLayout = () => (lastSavedWorkspaceState as { layout: Record<string, unknown> }).layout;

  it('serializes center preferences with lowercase keys and an explicit golemCollapsed:false', async () => {
    jest.useFakeTimers();
    try {
      await renderRestored();

      act(() => {
        const store = useIDEStore.getState();
        store.setCenterOrder('golem-first');
        store.setPanelSize('golem', 512);
        // Collapsing Files is what opens Golem — the pair invariant lives in the store.
        store.setFilesPanelCollapsed(true);
      });

      act(() => {
        jest.advanceTimersByTime(2000);
      });
      await waitFor(() => expect(mockSaveWorkspaceState).toHaveBeenCalled());

      expect(savedLayout()).toMatchObject({
        centerOrder: 'golem-first',
        golemCollapsed: false,
        filesCollapsed: true,
        panelSizes: expect.objectContaining({ golem: 512 }),
      });
      // Transient reveal and any effective (window-pressure) collapse are preferences' opposite.
      expect(savedLayout()).not.toHaveProperty('centerReveal');
    } finally {
      jest.useRealTimers();
    }
  });

  it('restores an actually-saved open Golem and reveals Files', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce(
      savedStateWithLayout({
        panelSizes: { left: 260, right: 280, bottom: 200, golem: 512 },
        leftCollapsed: false,
        rightCollapsed: false,
        bottomCollapsed: false,
        centerOrder: 'golem-first',
        golemCollapsed: false,
        filesCollapsed: false,
      })
    );

    await renderRestored();

    const state = useIDEStore.getState();
    expect(state.centerOrder).toBe('golem-first');
    expect(state.isGolemPanelCollapsed).toBe(false);
    expect(state.isFilesPanelCollapsed).toBe(false);
    expect(state.panelSizes.golem).toBe(512);
    expect(state.centerReveal).toBe('files');
  });

  it('normalizes a both-collapsed pair and a zero Golem width in one atomic apply', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce(
      savedStateWithLayout({
        panelSizes: { left: 260, right: 280, bottom: 200, golem: 0 },
        leftCollapsed: false,
        rightCollapsed: false,
        bottomCollapsed: false,
        centerOrder: 'files-first',
        golemCollapsed: true,
        filesCollapsed: true,
      })
    );

    await renderRestored();

    const state = useIDEStore.getState();
    expect(state.isGolemPanelCollapsed).toBe(true);
    expect(state.isFilesPanelCollapsed).toBe(false);
    expect(state.panelSizes.golem).toBe(420);
    expect(state.centerReveal).toBe('files');
  });

  it('treats missing center keys and a null golemCollapsed as absent', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce(
      savedStateWithLayout({
        panelSizes: { left: 260, right: 280, bottom: 200 },
        leftCollapsed: false,
        rightCollapsed: false,
        bottomCollapsed: false,
        golemCollapsed: null,
      })
    );

    await renderRestored();

    const state = useIDEStore.getState();
    expect(state.centerOrder).toBe('files-first');
    expect(state.isGolemPanelCollapsed).toBe(true);
    expect(state.isFilesPanelCollapsed).toBe(false);
    expect(state.panelSizes.golem).toBe(420);
  });

  it('rejects an invalid persisted center order', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce(
      savedStateWithLayout({
        panelSizes: { left: 260, right: 280, bottom: 200, golem: 400 },
        centerOrder: 'sideways',
        golemCollapsed: false,
        filesCollapsed: false,
      })
    );

    await renderRestored();

    expect(useIDEStore.getState().centerOrder).toBe('files-first');
    expect(useIDEStore.getState().panelSizes.golem).toBe(400);
  });

  it.each([
    ['a fractional width rounds to a positive integer', 511.6, 512],
    ['a sub-pixel width clamps up to the seam minimum, never 0', 0.4, 320],
    ['an absurd width clamps down to the seam maximum', 1e9, 900],
    ['a negative width falls back to the default', -5, 420],
    ['a non-finite width falls back to the default', Number.POSITIVE_INFINITY, 420],
  ])('normalizes the persisted Golem width: %s', async (_name, saved, expected) => {
    mockLoadWorkspaceState.mockResolvedValueOnce(
      savedStateWithLayout({
        panelSizes: { left: 260, right: 280, bottom: 200, golem: saved },
        golemCollapsed: false,
        filesCollapsed: false,
      })
    );

    await renderRestored();

    expect(useIDEStore.getState().panelSizes.golem).toBe(expected);
  });

  it('ignores missing or wrong-typed legacy panel fields instead of coercing them', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce(
      savedStateWithLayout({
        // A numeric string must never reach setPanelSize; nor may NaN/0.
        panelSizes: { left: '999', right: 0, bottom: Number.NaN, golem: 420 },
        // leftCollapsed absent entirely; the others are wrong-typed.
        rightCollapsed: 'true',
        bottomCollapsed: null,
      })
    );

    await renderRestored();

    const state = useIDEStore.getState();
    expect(state.panelSizes).toEqual({ left: 260, right: 280, bottom: 200, golem: 420 });
    expect(state.isLeftPanelCollapsed).toBe(false);
    expect(state.isRightPanelCollapsed).toBe(false);
    expect(state.isBottomPanelCollapsed).toBe(false);
  });

  it('leaves center defaults in place when there is no saved session', async () => {
    await renderRestored();

    const state = useIDEStore.getState();
    expect(state.centerOrder).toBe('files-first');
    expect(state.isGolemPanelCollapsed).toBe(true);
    expect(state.isFilesPanelCollapsed).toBe(false);
    expect(state.panelSizes.golem).toBe(420);
    expect(state.centerReveal).toBe('files');
  });

  it('saves the outgoing center preferences under A before B resets them', async () => {
    mockLoadWorkspaceState.mockResolvedValueOnce(null);
    mockLoadWorkspaceState.mockResolvedValueOnce(null);
    useIDEStore.setState({ workspace: { name: 'A', path: '/workspace/A' } });

    renderHook(() => useWorkspacePersistence());
    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/workspace/A'));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    act(() => {
      const store = useIDEStore.getState();
      store.setCenterOrder('golem-first');
      store.setGolemPanelCollapsed(false);
      store.setPanelSize('golem', 640);
    });
    mockSaveWorkspaceState.mockClear();

    act(() => {
      useIDEStore.setState({ workspace: { name: 'B', path: '/workspace/B' } });
    });

    await waitFor(() =>
      expect(
        mockSaveWorkspaceState.mock.calls.some(
          (c) => (c[0] as { workspacePath: string }).workspacePath === '/workspace/A'
        )
      ).toBe(true)
    );

    const savedForA = mockSaveWorkspaceState.mock.calls
      .map((c) => c[0] as { workspacePath: string; layout: Record<string, unknown> })
      .find((s) => s.workspacePath === '/workspace/A');
    expect(savedForA?.layout).toMatchObject({
      centerOrder: 'golem-first',
      golemCollapsed: false,
      panelSizes: expect.objectContaining({ golem: 640 }),
    });

    // B starts from the defaults, not A's leftovers.
    await waitFor(() => expect(useIDEStore.getState().centerOrder).toBe('files-first'));
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(true);
    expect(useIDEStore.getState().panelSizes.golem).toBe(420);
  });

  it('cannot apply an aborted older restore to the repository that replaced it', async () => {
    let releaseA!: (value: unknown) => void;
    mockLoadWorkspaceState.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseA = resolve;
      })
    );
    mockLoadWorkspaceState.mockResolvedValueOnce(
      savedStateWithLayout(
        {
          panelSizes: { left: 260, right: 280, bottom: 200, golem: 340 },
          centerOrder: 'files-first',
          golemCollapsed: true,
          filesCollapsed: false,
        },
        '/workspace/B'
      )
    );

    useIDEStore.setState({ workspace: { name: 'A', path: '/workspace/A' } });
    renderHook(() => useWorkspacePersistence());
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(true));

    act(() => {
      useIDEStore.setState({ workspace: { name: 'B', path: '/workspace/B' } });
    });
    await waitFor(() => expect(mockLoadWorkspaceState).toHaveBeenCalledWith('/workspace/B'));

    // A's load finally answers — too late. Its center layout must not land on B.
    await act(async () => {
      releaseA(
        savedStateWithLayout(
          {
            panelSizes: { left: 260, right: 280, bottom: 200, golem: 900 },
            centerOrder: 'golem-first',
            golemCollapsed: false,
            filesCollapsed: true,
          },
          '/workspace/A'
        )
      );
    });
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    const state = useIDEStore.getState();
    expect(state.centerOrder).toBe('files-first');
    expect(state.panelSizes.golem).toBe(340);
    expect(state.isGolemPanelCollapsed).toBe(true);
    expect(state.isFilesPanelCollapsed).toBe(false);
  });

  it('keeps this repository center layout when the focused workspace id changes', async () => {
    jest.useFakeTimers();
    try {
      await renderRestored();

      act(() => {
        const store = useIDEStore.getState();
        store.setCenterOrder('golem-first');
        store.setGolemPanelCollapsed(false);
        store.setPanelSize('golem', 480);
      });
      mockSaveWorkspaceState.mockClear();

      act(() => {
        useIDEStore.setState({ activeWorkspaceId: 'frontend' });
      });
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      await waitFor(() => expect(mockSaveWorkspaceState).toHaveBeenCalled());

      const state = useIDEStore.getState();
      expect(state.centerOrder).toBe('golem-first');
      expect(state.isGolemPanelCollapsed).toBe(false);
      expect(state.panelSizes.golem).toBe(480);
      expect(savedLayout()).toMatchObject({
        centerOrder: 'golem-first',
        golemCollapsed: false,
        panelSizes: expect.objectContaining({ golem: 480 }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not schedule a save when only the transient center reveal changes', async () => {
    jest.useFakeTimers();
    try {
      await renderRestored();
      mockSaveWorkspaceState.mockClear();

      act(() => {
        useIDEStore.setState({ centerReveal: 'golem' });
      });
      act(() => {
        jest.advanceTimersByTime(5000);
      });

      expect(mockSaveWorkspaceState).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('schedules a save when a center collapse or order preference changes', async () => {
    jest.useFakeTimers();
    try {
      await renderRestored();
      mockSaveWorkspaceState.mockClear();

      act(() => {
        useIDEStore.getState().setGolemPanelCollapsed(false);
      });
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      await waitFor(() => expect(mockSaveWorkspaceState).toHaveBeenCalledTimes(1));
      expect(savedLayout()).toMatchObject({ golemCollapsed: false });

      act(() => {
        useIDEStore.getState().swapCenterOrder();
      });
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      await waitFor(() => expect(mockSaveWorkspaceState).toHaveBeenCalledTimes(2));
      expect(savedLayout()).toMatchObject({ centerOrder: 'golem-first' });
    } finally {
      jest.useRealTimers();
    }
  });
});
