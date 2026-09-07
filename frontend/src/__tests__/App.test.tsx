/**
 * Test: React Testing Library Works
 *
 * Tests that React components can be rendered and tested.
 * TDD: Written first to define expected behavior.
 */

import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../App';
import { useIDEStore } from '../stores/ideStore';
import { useSearchStore } from '../stores/searchStore';
import { resetLSPDocumentSyncState } from '../utils/lspDocumentSync';
import { __resetEnsurePathLoaded } from '../hooks/useEnsurePathLoaded';
import type { FileEvent } from '../types/watcher';

const mockReadDirectory = jest.fn();
const mockReadDirectoryShallow = jest.fn();
const mockReadFile = jest.fn();
const mockUseFileWatcher = jest.fn();
const mockDidOpen = jest.fn().mockResolvedValue(undefined);
const mockDidChange = jest.fn().mockResolvedValue(undefined);
const mockDidSave = jest.fn().mockResolvedValue(undefined);
const mockDidClose = jest.fn().mockResolvedValue(undefined);
const mockSearchWorkspace = jest.fn().mockResolvedValue({});
const mockCancelSearch = jest.fn().mockResolvedValue(undefined);
type RunEventCallback = (...args: unknown[]) => void;

const mockRunEventCallbacks = new Map<string, Map<symbol, RunEventCallback>>();
const mockEventsOn = jest.fn((event: string, callback: RunEventCallback) => {
  const callbacks = mockRunEventCallbacks.get(event) ?? new Map<symbol, RunEventCallback>();
  const registration = Symbol();
  callbacks.set(registration, callback);
  mockRunEventCallbacks.set(event, callbacks);
  return () => {
    callbacks.delete(registration);
    if (callbacks.size === 0) {
      mockRunEventCallbacks.delete(event);
    }
  };
});
const emitRunEvent = (event: string, payload: unknown) => {
  for (const callback of mockRunEventCallbacks.get(event)?.values() ?? []) callback(payload);
};
const mockAppendRunHistoryRecord = jest.fn((record: Record<string, unknown>) =>
  Promise.resolve({
    historyId: `${record.kind}:${record.profileId}`,
    kind: record.kind,
    profileId: record.profileId,
    profileName: record.profileName,
    state: record.state,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    outputAvailable: record.kind === 'ordinary',
  })
);

// Mock Wails bindings
jest.mock('../wails/bindings', () => {
  const actual = jest.requireActual('../wails/bindings');
  return {
    ...actual,
    ReadDirectory: (...args: unknown[]) => mockReadDirectory(...args),
    ReadDirectoryShallow: (...args: unknown[]) => mockReadDirectoryShallow(...args),
    ReadFile: (...args: unknown[]) => mockReadFile(...args),
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
    LSPDidOpen: (...args: unknown[]) => mockDidOpen(...args),
    LSPDidChange: (...args: unknown[]) => mockDidChange(...args),
    LSPDidSave: (...args: unknown[]) => mockDidSave(...args),
    LSPDidClose: (...args: unknown[]) => mockDidClose(...args),
    SearchWorkspace: (...args: unknown[]) => mockSearchWorkspace(...args),
    CancelSearch: (...args: unknown[]) => mockCancelSearch(...args),
    DetectWorkspaces: jest.fn(() => Promise.resolve([])),
    AppendRunHistoryRecord: (record: Record<string, unknown>) => mockAppendRunHistoryRecord(record),
    ClearAllRunHistory: jest.fn(() => Promise.resolve()),
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
  EventsOn: (event: string, callback: (...args: unknown[]) => void) =>
    mockEventsOn(event, callback),
}));

jest.mock('../hooks/useFileWatcher', () => ({
  useFileWatcher: (...args: unknown[]) => mockUseFileWatcher(...args),
}));

jest.mock('../components/Editor', () => ({
  Editor: () => null,
}));

// Mock useDirectoryTree to prevent automatic fetching
jest.mock('../components/FileExplorer/useDirectoryTree', () => ({
  useDirectoryTree: () => ({ refetch: jest.fn() }),
}));

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: jest.fn(),
  });
});

describe('App Component', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReadDirectory.mockReset();
    mockReadDirectoryShallow.mockReset();
    mockReadDirectoryShallow.mockResolvedValue([]);
    mockReadFile.mockReset();
    mockUseFileWatcher.mockReset();
    __resetEnsurePathLoaded();
    mockDidOpen.mockClear();
    mockDidChange.mockClear();
    mockDidSave.mockClear();
    mockDidClose.mockClear();
    mockSearchWorkspace.mockClear();
    mockCancelSearch.mockClear();
    mockEventsOn.mockClear();
    mockRunEventCallbacks.clear();
    mockAppendRunHistoryRecord.mockClear();
    resetLSPDocumentSyncState();
    useIDEStore.setState({
      workspace: null,
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

  it('should render without crashing', async () => {
    await act(async () => {
      render(<App />);
    });
    // The app should render the IDE shell
    expect(document.body).toBeInTheDocument();
  });

  it('should render the Firn IDE header', async () => {
    await act(async () => {
      render(<App />);
    });
    // Look for the app name in the header
    expect(screen.getByText('Firn')).toBeInTheDocument();
  });

  it('shows the FileExplorer in the left panel when sidebar view is explorer', async () => {
    useIDEStore.setState({ activeSidebarView: 'explorer' });
    await act(async () => {
      render(<App />);
    });
    // SearchPanel exposes a textbox labelled "Search query"; the explorer does not.
    expect(screen.queryByLabelText('Search query')).not.toBeInTheDocument();
  });

  it('routes the left panel to the SearchPanel when sidebar view is search', async () => {
    useIDEStore.setState({ activeSidebarView: 'search' });
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByLabelText('Search query')).toBeInTheDocument();
  });

  it('opens the command palette from Search Everywhere without switching sidebar views', async () => {
    useIDEStore.setState({
      workspace: { name: 'workspace', path: '/test/workspace' },
      activeSidebarView: 'explorer',
      isLeftPanelCollapsed: true,
    });
    await act(async () => {
      render(<App />);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Search everywhere' }));

    expect(screen.getByRole('dialog', { name: 'Command palette' })).toHaveAttribute('open');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Command palette' })).toHaveFocus()
    );
    expect(useIDEStore.getState().activeSidebarView).toBe('explorer');
    expect(screen.queryByRole('textbox', { name: 'Search query' })).not.toBeInTheDocument();
  });

  it.each(['created', 'deleted', 'renamed'] as const)(
    'should surgically reconcile the parent dir on %s file watcher events',
    async (type) => {
      // Seed workspace with root loaded (directoryTree = []) and expanded
      useIDEStore.setState({
        workspace: { name: 'workspace', path: '/test/workspace' },
        directoryTree: [],
        isRootExpanded: true,
      });

      // ReadDirectoryShallow returns the new on-disk state for the root dir
      mockReadDirectoryShallow.mockResolvedValueOnce([
        { name: 'new.ts', path: '/test/workspace/new.ts', isDir: false },
      ]);

      await act(async () => {
        render(<App />);
      });

      const watcherCallback = mockUseFileWatcher.mock.calls[0]?.[1] as
        | ((event: FileEvent) => void)
        | undefined;
      expect(watcherCallback).toBeDefined();

      act(() => {
        watcherCallback!({
          type,
          path: '/test/workspace/new.ts',
          isDir: false,
          time: new Date().toISOString(),
        });
        jest.advanceTimersByTime(100);
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Surgical reconcile: calls ReadDirectoryShallow on the parent dir, NOT ReadDirectory
      expect(mockReadDirectory).not.toHaveBeenCalled();
      expect(mockReadDirectoryShallow).toHaveBeenCalledWith('/test/workspace', '/test/workspace');
      expect(useIDEStore.getState().directoryTree).toEqual([
        { name: 'new.ts', path: '/test/workspace/new.ts', isDir: false },
      ]);
    }
  );

  it('should sync LSP content when an unmodified open file is externally reloaded', async () => {
    useIDEStore.setState({
      workspace: { name: 'workspace', path: '/test/workspace' },
    });

    mockReadFile.mockResolvedValueOnce({
      content: 'const x = 2;',
      encoding: 'utf-8',
      lineEndings: 'LF',
    });

    await act(async () => {
      render(<App />);
    });

    act(() => {
      useIDEStore.getState().openFile({
        id: '/test/workspace/main.ts',
        name: 'main.ts',
        path: '/test/workspace/main.ts',
        language: 'typescript',
        encoding: 'utf-8',
        lineEndings: 'LF',
        content: 'const x = 1;',
        isModified: false,
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    const watcherCallback = mockUseFileWatcher.mock.calls[0]?.[1] as
      | ((event: FileEvent) => void)
      | undefined;
    expect(watcherCallback).toBeDefined();

    await act(async () => {
      watcherCallback!({
        type: 'modified',
        path: '/test/workspace/main.ts',
        isDir: false,
        time: new Date().toISOString(),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useIDEStore.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        content: 'const x = 2;',
        isModified: false,
      })
    );
    expect(mockDidChange).toHaveBeenCalledWith(
      '/test/workspace/main.ts',
      2,
      expect.arrayContaining([expect.objectContaining({ text: 'const x = 2;' })])
    );
    expect(mockDidSave).toHaveBeenCalledWith('/test/workspace/main.ts');
    expect(mockDidChange.mock.invocationCallOrder[0]).toBeLessThan(
      mockDidSave.mock.invocationCallOrder[0]
    );
  });

  it('keeps run capture alive while the bottom panel is collapsed', async () => {
    useIDEStore.setState({
      ...useIDEStore.getInitialState(),
      activeTerminalTab: 'output',
      isBottomPanelCollapsed: false,
      runProfiles: [
        {
          id: 'build',
          name: 'Build',
          type: 'single',
          source: 'user',
          command: 'go build ./...',
        },
        {
          id: 'ci',
          name: 'CI',
          type: 'compound',
          source: 'user',
          steps: ['build'],
        },
      ],
      workspaceEpoch: 7,
    });

    await act(async () => {
      render(
        <StrictMode>
          <App />
        </StrictMode>
      );
    });
    expect(screen.getByRole('tablist', { name: 'Terminal panels' })).toBeInTheDocument();

    act(() => {
      useIDEStore.getState().toggleBottomPanel();
    });
    expect(screen.queryByRole('tablist', { name: 'Terminal panels' })).not.toBeInTheDocument();

    act(() => {
      emitRunEvent('run:status', {
        runInstanceId: 'ordinary-run',
        profileId: 'build',
        stepIdx: 0,
        launchSeq: 1,
        workspaceEpoch: 7,
        state: 'running',
        exitCode: 0,
        timestamp: 100,
      });
      emitRunEvent('run:output', {
        runInstanceId: 'ordinary-run',
        profileId: 'build',
        stepIdx: 0,
        launchSeq: 1,
        workspaceEpoch: 7,
        stream: 'stdout',
        data: 'captured while hidden\n',
        timestamp: 110,
      });
      emitRunEvent('run:status', {
        runInstanceId: 'ordinary-run',
        profileId: 'build',
        stepIdx: 0,
        launchSeq: 1,
        workspaceEpoch: 7,
        state: 'success',
        exitCode: 0,
        timestamp: 120,
      });
      emitRunEvent('run:status', {
        runInstanceId: 'compound-run',
        profileId: 'ci',
        stepIdx: 0,
        launchSeq: 2,
        workspaceEpoch: 7,
        state: 'running',
        exitCode: 0,
        timestamp: 200,
      });
      emitRunEvent('run:compound', {
        runInstanceId: 'compound-run',
        compoundId: 'ci',
        launchSeq: 2,
        workspaceEpoch: 7,
        name: 'CI',
        state: 'running',
        currentStep: 0,
        steps: [
          {
            idx: 0,
            runInstanceId: 'compound-step',
            profileId: 'build',
            name: 'Build',
            state: 'running',
            exitCode: 0,
            workingDir: '/repo',
            durationMs: 0,
            startedAt: 210,
          },
        ],
      });
      emitRunEvent('run:output', {
        runInstanceId: 'compound-step',
        parentRunInstanceId: 'compound-run',
        profileId: 'build',
        stepIdx: 0,
        launchSeq: 0,
        workspaceEpoch: 7,
        stream: 'stdout',
        data: 'compound output while hidden\n',
        timestamp: 220,
      });
      emitRunEvent('run:compound', {
        runInstanceId: 'compound-run',
        compoundId: 'ci',
        launchSeq: 2,
        workspaceEpoch: 7,
        name: 'CI',
        state: 'success',
        currentStep: 1,
        steps: [
          {
            idx: 0,
            runInstanceId: 'compound-step',
            profileId: 'build',
            name: 'Build',
            state: 'success',
            exitCode: 0,
            workingDir: '/repo',
            durationMs: 40,
            startedAt: 210,
            endedAt: 250,
          },
        ],
      });
      emitRunEvent('run:status', {
        runInstanceId: 'compound-run',
        profileId: 'ci',
        stepIdx: 0,
        launchSeq: 2,
        workspaceEpoch: 7,
        state: 'success',
        exitCode: 0,
        timestamp: 260,
      });
    });

    const hiddenState = useIDEStore.getState();
    expect(hiddenState.runOutputs['ordinary-run']?.entries).toEqual([
      { stream: 'stdout', text: 'captured while hidden', timestamp: 110 },
    ]);
    expect(hiddenState.runCompounds.ci).toMatchObject({
      runInstanceId: 'compound-run',
      state: 'success',
      stepOutputs: {
        0: [{ stream: 'stdout', text: 'compound output while hidden', timestamp: 220 }],
      },
    });
    expect(hiddenState.runHistory.build).toHaveLength(2);
    expect(hiddenState.runHistory.ci).toHaveLength(1);

    await waitFor(() => {
      expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(3);
      expect(Object.keys(useIDEStore.getState().runHistorySummaries)).toHaveLength(3);
    });
    expect(mockAppendRunHistoryRecord.mock.calls.map(([record]) => record.kind).sort()).toEqual([
      'compound-aggregate',
      'compound-step',
      'ordinary',
    ]);

    act(() => {
      useIDEStore.setState({ activeRunOutputId: 'ordinary-run' });
      useIDEStore.getState().toggleBottomPanel();
    });

    expect(screen.getByText('captured while hidden')).toBeInTheDocument();
    for (const event of ['run:output', 'run:status', 'run:compound']) {
      expect(mockRunEventCallbacks.get(event)?.size).toBe(1);
    }
  });
});
