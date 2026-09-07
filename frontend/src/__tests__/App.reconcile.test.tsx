/**
 * Task 10 — surgical watcher reconcile
 *
 * On a file-change event App.tsx should:
 *  - re-read only the changed file's PARENT dir if it is loaded AND visible
 *  - mark dirty (not re-read) if loaded but hidden (collapsed)
 *  - ignore completely if the dir has never been loaded (children === undefined)
 *
 * We fire events by grabbing the watcher callback captured by mockUseFileWatcher,
 * identical to the pattern in App.test.tsx.
 */

import { act, render } from '@testing-library/react';
import App from '../App';
import { useIDEStore } from '../stores/ideStore';
import type { FileEntry } from '../stores/ideStore';
import { useSearchStore } from '../stores/searchStore';
import { useGitStore, GIT_REFRESH_DEBOUNCE_MS } from '../stores/gitStore';
import { GitStatus } from '../wails/bindings';
import { resetLSPDocumentSyncState } from '../utils/lspDocumentSync';
import { ReadDirectoryShallow } from '../wails/bindings';
import { __resetEnsurePathLoaded } from '../hooks/useEnsurePathLoaded';
import type { FileEvent } from '../types/watcher';

// ── helpers ───────────────────────────────────────────────────────────────────
// Plain-object helpers avoid FileEntry.convertValues edge cases in tests.
// A loaded dir has children defined (even if empty []).
const loadedDir = (path: string): FileEntry =>
  ({
    name: path.split('/').pop()!,
    path,
    isDir: true,
    size: 0,
    modTime: '',
    children: [],
  }) as unknown as FileEntry;
// An unloaded dir has children undefined.
const unloadedDir = (path: string): FileEntry =>
  ({
    name: path.split('/').pop()!,
    path,
    isDir: true,
    size: 0,
    modTime: '',
    children: undefined,
  }) as unknown as FileEntry;

// ── mocks ─────────────────────────────────────────────────────────────────────
const mockUseFileWatcher = jest.fn();

jest.mock('../wails/bindings', () => {
  const actual = jest.requireActual('../wails/bindings');
  return {
    ...actual,
    ReadDirectory: jest.fn(),
    ReadDirectoryShallow: jest.fn(),
    ReadFile: jest.fn(),
    WriteFile: jest.fn(),
    OpenFolderDialog: jest.fn(),
    GetWatchedPath: jest.fn(),
    SetWatchedPath: jest.fn(),
    CreateTerminal: jest.fn(() => Promise.resolve('term-1')),
    WriteTerminal: jest.fn(),
    CloseTerminal: jest.fn(),
    ResizeTerminal: jest.fn(),
    ConfirmBeforeCloseReady: jest.fn(() => Promise.resolve()),
    CancelBeforeClose: jest.fn(() => Promise.resolve()),
    SaveWorkspaceState: jest.fn(() => Promise.resolve()),
    LoadWorkspaceState: jest.fn(() => Promise.resolve(null)),
    ListRecentWorkspaces: jest.fn(() => Promise.resolve([])),
    LoadRunProfiles: jest.fn(() => Promise.resolve()),
    GetRunProfilesSnapshot: jest.fn(() => Promise.resolve({ profiles: [], profileState: {} })),
    SetActiveVariant: jest.fn(() => Promise.resolve()),
    LSPDidOpen: jest.fn().mockResolvedValue(undefined),
    LSPDidChange: jest.fn().mockResolvedValue(undefined),
    LSPDidSave: jest.fn().mockResolvedValue(undefined),
    LSPDidClose: jest.fn().mockResolvedValue(undefined),
    SearchWorkspace: jest.fn().mockResolvedValue({}),
    CancelSearch: jest.fn().mockResolvedValue(undefined),
    DetectWorkspaces: jest.fn(() => Promise.resolve([])),
    GitStatus: jest.fn(() =>
      Promise.resolve({
        isRepo: false,
        repoRoot: '',
        branch: '',
        upstream: '',
        ahead: 0,
        behind: 0,
        files: [],
      })
    ),
    GitBranches: jest.fn(() => Promise.resolve([])),
    GitCommitMessageAvailable: jest.fn(() => Promise.resolve(false)),
    GitStage: jest.fn(),
    GitUnstage: jest.fn(),
    GitCommit: jest.fn(),
    GitPull: jest.fn(),
    GitPush: jest.fn(),
    GitCheckout: jest.fn(),
    GitGenerateCommitMessage: jest.fn(),
    GitConflictState: jest.fn(),
    // App now mounts useGolemBridge; an unbound repository is the quiet default.
    GetWorkspaceInfo: jest.fn((path: string) =>
      Promise.resolve({ name: '', path, repoKey: '', repoEpoch: 0 })
    ),
    GetGolemStatus: jest.fn(() =>
      Promise.resolve({
        available: false,
        workspaceLabel: '',
        identity: { repoEpoch: 0, workspaceId: '', conversationId: '' },
        needsConsent: false,
        activeRuns: [],
      })
    ),
    RunGolemTurn: jest.fn(() => Promise.resolve(null)),
    CancelGolemRun: jest.fn(() => Promise.resolve(false)),
  };
});

jest.mock('../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
  EventsOn: jest.fn(() => jest.fn()),
}));

jest.mock('../hooks/useFileWatcher', () => ({
  useFileWatcher: (...args: unknown[]) => mockUseFileWatcher(...args),
}));

jest.mock('../components/Editor', () => ({
  Editor: () => null,
}));

jest.mock('../components/FileExplorer/useDirectoryTree', () => ({
  useDirectoryTree: () => ({ refetch: jest.fn() }),
}));

// ── test suite ────────────────────────────────────────────────────────────────
describe('App — surgical watcher reconcile', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    __resetEnsurePathLoaded();
    resetLSPDocumentSyncState();

    // Default: ReadDirectoryShallow succeeds with empty result
    (ReadDirectoryShallow as jest.Mock).mockResolvedValue([]);

    useIDEStore.setState({
      workspace: { name: 'r', path: '/r' },
      openFiles: [],
      activeFileId: null,
      directoryTree: [],
      treeError: null,
      activeSidebarView: 'explorer',
      isLeftPanelCollapsed: false,
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      dirtyPaths: new Set<string>(),
      isRootExpanded: true,
    });

    useSearchStore.setState({
      query: '',
      options: { regex: false, caseSensitive: false, wholeWord: false },
      uiState: { kind: 'no-workspace' },
      expandedFiles: new Set<string>(),
      activeRequestId: null,
      focusInputRevision: 0,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function getWatcherCallback(): (event: FileEvent) => void {
    const cb = mockUseFileWatcher.mock.calls[0]?.[1] as ((event: FileEvent) => void) | undefined;
    expect(cb).toBeDefined();
    return cb!;
  }

  it('schedules a debounced git status refresh on any file event', async () => {
    await act(async () => {
      render(<App />);
    });
    act(() => {
      useGitStore.getState().resetForWorkspace('/r');
    });
    (GitStatus as jest.Mock).mockClear();

    const fire = getWatcherCallback();
    act(() => {
      fire({
        type: 'modified',
        path: '/r/some/file.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      fire({
        type: 'modified',
        path: '/r/other/file.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      jest.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10);
    });
    await act(async () => {});

    // Burst of events → exactly one debounced status call.
    expect(GitStatus).toHaveBeenCalledTimes(1);
    expect(GitStatus).toHaveBeenCalledWith('/r');
  });

  // ── (a) visible loaded dir → ReadDirectoryShallow called ──────────────────
  it('(a) change under a visible loaded dir triggers ReadDirectoryShallow for that dir', async () => {
    await act(async () => {
      render(<App />);
    });

    // Set state AFTER render: useWorkspacePersistence resets expandedPaths on mount.
    act(() => {
      useIDEStore.setState({
        directoryTree: [loadedDir('/r/a')],
        expandedPaths: new Set(['/r/a']),
        isRootExpanded: true,
      });
    });

    const fire = getWatcherCallback();

    act(() => {
      fire({
        type: 'created',
        path: '/r/a/newfile.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      jest.advanceTimersByTime(100);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(ReadDirectoryShallow).toHaveBeenCalledTimes(1);
    expect(ReadDirectoryShallow).toHaveBeenCalledWith('/r/a', '/r');
  });

  // ── (b) loaded but collapsed dir → markDirty, no fetch ────────────────────
  it('(b) change under a loaded-but-collapsed dir marks it dirty, no ReadDirectoryShallow', async () => {
    await act(async () => {
      render(<App />);
    });

    // Seed: /r/a is loaded (children=[]) but NOT in expandedPaths (collapsed).
    // Set state AFTER render to avoid useWorkspacePersistence resetting it.
    act(() => {
      useIDEStore.setState({
        directoryTree: [loadedDir('/r/a')],
        expandedPaths: new Set<string>(), // /r/a NOT expanded
        isRootExpanded: true,
      });
    });

    const fire = getWatcherCallback();

    act(() => {
      fire({
        type: 'deleted',
        path: '/r/a/oldfile.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      jest.advanceTimersByTime(100);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(ReadDirectoryShallow).not.toHaveBeenCalled();
    expect(useIDEStore.getState().dirtyPaths.has('/r/a')).toBe(true);
  });

  // ── (c) unloaded dir → ignored entirely ────────────────────────────────────
  it('(c) change under an unloaded dir is ignored — no fetch, not dirty', async () => {
    await act(async () => {
      render(<App />);
    });

    // Seed: /r/b has children === undefined (never loaded).
    // Set state AFTER render to avoid useWorkspacePersistence resetting it.
    act(() => {
      useIDEStore.setState({
        directoryTree: [unloadedDir('/r/b')],
        expandedPaths: new Set<string>(),
        isRootExpanded: true,
      });
    });

    const fire = getWatcherCallback();

    act(() => {
      fire({
        type: 'renamed',
        path: '/r/b/something.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      jest.advanceTimersByTime(100);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(ReadDirectoryShallow).not.toHaveBeenCalled();
    expect(useIDEStore.getState().dirtyPaths.has('/r/b')).toBe(false);
  });

  // ── (d) two visible dirs → two independent ReadDirectoryShallow calls ──────
  it('(d) changes under two different visible dirs each trigger their own ReadDirectoryShallow', async () => {
    await act(async () => {
      render(<App />);
    });

    // Seed: /r/a and /r/c are both loaded and expanded.
    // Set state AFTER render to avoid useWorkspacePersistence resetting it.
    act(() => {
      useIDEStore.setState({
        directoryTree: [loadedDir('/r/a'), loadedDir('/r/c')],
        expandedPaths: new Set(['/r/a', '/r/c']),
        isRootExpanded: true,
      });
    });

    const fire = getWatcherCallback();

    act(() => {
      fire({
        type: 'created',
        path: '/r/a/file1.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      fire({
        type: 'created',
        path: '/r/c/file2.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      jest.advanceTimersByTime(100);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(ReadDirectoryShallow).toHaveBeenCalledTimes(2);
    expect(ReadDirectoryShallow).toHaveBeenCalledWith('/r/a', '/r');
    expect(ReadDirectoryShallow).toHaveBeenCalledWith('/r/c', '/r');
  });

  // ── (e) reconcile preserves loaded children of surviving subdirs ───────────
  it('(e) reconcile at root preserves loaded children of a surviving subdir', async () => {
    // /r/a is already loaded+expanded with children; a root-level event arrives.
    // ReadDirectoryShallow('/r') returns a fresh shallow level where /r/a is
    // unloaded. preserveLoadedChildren must restore /r/a's children so the tree
    // does not visually collapse to empty.
    const existingChild = {
      name: 'x.ts',
      path: '/r/a/x.ts',
      isDir: false,
      size: 0,
      modTime: '',
    } as FileEntry;

    // Mock ReadDirectoryShallow('/r') to return [unloaded /r/a, new file /r/new.ts]
    (ReadDirectoryShallow as jest.Mock).mockImplementation((path: string) => {
      if (path === '/r') {
        return Promise.resolve([
          { name: 'a', path: '/r/a', isDir: true, size: 0, modTime: '', children: undefined },
          { name: 'new.ts', path: '/r/new.ts', isDir: false, size: 0, modTime: '' },
        ]);
      }
      return Promise.resolve([]);
    });

    await act(async () => {
      render(<App />);
    });

    // Seed: root expanded, /r/a loaded+expanded with a child file.
    act(() => {
      useIDEStore.setState({
        directoryTree: [
          {
            name: 'a',
            path: '/r/a',
            isDir: true,
            size: 0,
            modTime: '',
            children: [existingChild],
            unreadable: true,
          } as FileEntry,
        ],
        expandedPaths: new Set(['/r/a']),
        isRootExpanded: true,
      });
    });

    const fire = getWatcherCallback();

    // Fire a root-level created event (new file at /r).
    act(() => {
      fire({
        type: 'created',
        path: '/r/new.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      jest.advanceTimersByTime(100);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const state = useIDEStore.getState();
    const aNode = state.directoryTree.find((e) => e.path === '/r/a');
    const newNode = state.directoryTree.find((e) => e.path === '/r/new.ts');

    // /r/new.ts must appear after reconcile
    expect(newNode).toBeTruthy();
    // /r/a must retain its previously-loaded children (not revert to undefined)
    expect(aNode?.children).toEqual([existingChild]);
    // Reading only /r does not prove that /r/a's contents became readable.
    expect(aNode?.unreadable).toBe(true);
  });

  it('a successful watcher retry of the unreadable dir clears its marker', async () => {
    const realChild = {
      name: 'new.ts',
      path: '/r/a/new.ts',
      isDir: false,
      size: 0,
      modTime: '',
    } as FileEntry;
    (ReadDirectoryShallow as jest.Mock).mockResolvedValue([realChild]);

    await act(async () => {
      render(<App />);
    });
    act(() => {
      useIDEStore.setState({
        directoryTree: [{ ...loadedDir('/r/a'), unreadable: true } as FileEntry],
        expandedPaths: new Set(['/r/a']),
        isRootExpanded: true,
      });
    });

    const fire = getWatcherCallback();
    act(() => {
      fire({
        type: 'created',
        path: '/r/a/new.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      jest.advanceTimersByTime(100);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(ReadDirectoryShallow).toHaveBeenCalledWith('/r/a', '/r');
    const aNode = useIDEStore.getState().directoryTree[0];
    expect(aNode.children).toEqual([realChild]);
    expect(aNode.unreadable).toBe(false);
  });
});

describe('App — merge session revalidation signals', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    __resetEnsurePathLoaded();
    resetLSPDocumentSyncState();
    (ReadDirectoryShallow as jest.Mock).mockResolvedValue([]);
    useIDEStore.setState({
      workspace: { name: 'r', path: '/r' },
      openFiles: [],
      activeFileId: null,
      directoryTree: [],
      treeError: null,
      activeSidebarView: 'explorer',
      isLeftPanelCollapsed: false,
      expandedPaths: new Set<string>(),
      loadingPaths: new Set<string>(),
      dirtyPaths: new Set<string>(),
      isRootExpanded: true,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function watcherCallback(): (event: FileEvent) => void {
    const cb = mockUseFileWatcher.mock.calls[0]?.[1] as ((event: FileEvent) => void) | undefined;
    expect(cb).toBeDefined();
    return cb!;
  }

  /**
   * Renders inside act and settles the mount: the always-mounted Golem bridge
   * resolves GetWorkspaceInfo a microtask after render, which would otherwise
   * land after the test body returns and count as an update outside act (#226).
   */
  async function renderApp() {
    await act(async () => {
      render(<App />);
    });
  }

  /** Replaces the store action so the test observes the signal, not the policy
   * (which gitStore.merge.test.ts owns). */
  function captureMergeSignal() {
    const notifyMergeFileChanged = jest.fn(() => Promise.resolve());
    useGitStore.setState({ notifyMergeFileChanged });
    return notifyMergeFileChanged;
  }

  it('hands a changed path to the merge session revalidator', async () => {
    const notify = captureMergeSignal();
    await renderApp();

    act(() => {
      watcherCallback()({
        type: 'modified',
        path: '/r/conflict.ts',
        isDir: false,
        time: '',
      });
    });

    // A merge session is not an open editor buffer, so the reload path in
    // handleFileChange never sees it — the store has to be told directly.
    expect(notify).toHaveBeenCalledWith('/r/conflict.ts');
  });

  it('hands both sides of a rename to the revalidator', async () => {
    const notify = captureMergeSignal();
    await renderApp();

    act(() => {
      watcherCallback()({
        type: 'renamed',
        path: '/r/renamed.ts',
        oldPath: '/r/conflict.ts',
        isDir: false,
        time: '',
      });
    });

    // The session's file may be either end of the rename.
    expect(notify).toHaveBeenCalledWith('/r/renamed.ts');
    expect(notify).toHaveBeenCalledWith('/r/conflict.ts');
  });

  it('signals a deletion of the session file too', async () => {
    const notify = captureMergeSignal();
    await renderApp();

    act(() => {
      watcherCallback()({
        type: 'deleted',
        path: '/r/conflict.ts',
        isDir: false,
        time: '',
      });
    });

    expect(notify).toHaveBeenCalledWith('/r/conflict.ts');
  });

  it('does not signal for directory events', async () => {
    const notify = captureMergeSignal();
    await renderApp();

    act(() => {
      watcherCallback()({ type: 'created', path: '/r/sub', isDir: true, time: '' });
    });

    expect(notify).not.toHaveBeenCalled();
  });
});
