import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorkspacePersistence } from '../../hooks/useWorkspacePersistence';
import { useIDEStore } from '../../stores/ideStore';
import { LoadWorkspaceState, SaveWorkspaceState } from '../../wails/bindings';

jest.mock('../../wails/bindings', () => ({
  SaveWorkspaceState: jest.fn(() => Promise.resolve()),
  LoadWorkspaceState: jest.fn(),
  DetectWorkspaces: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
  EventsOn: jest.fn(() => jest.fn()),
}));

const mockLoad = LoadWorkspaceState as jest.Mock;
const defs = [
  { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
  { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'frontend', accent: 'frontend' },
];

function savedState(activeWorkspaceId?: string) {
  return {
    workspacePath: '/repo',
    workspaceName: 'repo',
    activeWorkspaceId,
    layout: null,
    editor: { openFiles: [] },
    explorer: { expandedPaths: [] },
  };
}

beforeEach(() => {
  mockLoad.mockReset();
  useIDEStore.setState({ workspace: null, workspaces: [], activeWorkspaceId: 'project' });
});

it('restores a saved id even when detection has not populated workspaces yet (order-independent)', async () => {
  mockLoad.mockResolvedValue(savedState('frontend'));
  renderHook(() => useWorkspacePersistence());
  act(() => {
    useIDEStore.setState({ workspace: { name: 'repo', path: '/repo' } });
  });
  // restore applies the raw id while workspaces is still empty
  await waitFor(() => expect(useIDEStore.getState().activeWorkspaceId).toBe('frontend'));
  // detection completes later and re-validates: id is kept because it exists
  act(() => {
    useIDEStore.getState().setWorkspaces(defs as never);
  });
  expect(useIDEStore.getState().activeWorkspaceId).toBe('frontend');
});

it('an unknown saved id is corrected to project once detection populates the list', async () => {
  mockLoad.mockResolvedValue(savedState('ghost'));
  renderHook(() => useWorkspacePersistence());
  act(() => {
    useIDEStore.setState({ workspace: { name: 'repo', path: '/repo' } });
  });
  await waitFor(() => expect(mockLoad).toHaveBeenCalled());
  act(() => {
    useIDEStore.getState().setWorkspaces(defs as never); // 'ghost' not in list
  });
  expect(useIDEStore.getState().activeWorkspaceId).toBe('project');
});

it('an unknown saved id is corrected when detection already populated the list', async () => {
  let resolveLoad!: (value: unknown) => void;
  mockLoad.mockReturnValue(
    new Promise((resolve) => {
      resolveLoad = resolve;
    })
  );
  useIDEStore.setState({ workspaces: defs as never, activeWorkspaceId: 'project' });

  renderHook(() => useWorkspacePersistence());
  act(() => {
    useIDEStore.setState({ workspace: { name: 'repo', path: '/repo' } });
  });

  await waitFor(() => expect(mockLoad).toHaveBeenCalledWith('/repo'));
  await act(async () => {
    resolveLoad(savedState('ghost'));
  });

  expect(useIDEStore.getState().activeWorkspaceId).toBe('project');
});

it('no saved id leaves the active workspace at project', async () => {
  mockLoad.mockResolvedValue(savedState(undefined));
  renderHook(() => useWorkspacePersistence());
  act(() => {
    useIDEStore.setState({ workspace: { name: 'repo', path: '/repo' } });
  });
  await waitFor(() => expect(mockLoad).toHaveBeenCalled());
  expect(useIDEStore.getState().activeWorkspaceId).toBe('project');
});

it('schedules a save when the active workspace changes', async () => {
  (SaveWorkspaceState as jest.Mock).mockClear();
  mockLoad.mockResolvedValue(null);
  useIDEStore.setState({
    workspaces: defs as never,
    activeWorkspaceId: 'project',
  });
  renderHook(() => useWorkspacePersistence());

  // Set workspace after mount so the hook subscribes first, then restore runs.
  act(() => {
    useIDEStore.setState({ workspace: { name: 'repo', path: '/repo' } });
  });

  // Wait for the restore (mockLoad resolves null) to complete before
  // switching the active workspace, so isRestoringWorkspace is cleared.
  await waitFor(() => expect(mockLoad).toHaveBeenCalled());

  // Clear any saves triggered by the restore/initial sequence.
  (SaveWorkspaceState as jest.Mock).mockClear();

  act(() => {
    useIDEStore.getState().setActiveWorkspace('frontend');
  });

  await waitFor(() => expect(SaveWorkspaceState).toHaveBeenCalled(), {
    timeout: 2000 + 500,
  });
  const saved = (SaveWorkspaceState as jest.Mock).mock.calls.at(-1)![0];
  expect(saved.activeWorkspaceId).toBe('frontend');
});

it('flushes the previous repo with its active workspace id when switching repos', async () => {
  jest.useFakeTimers();

  try {
    let resolveFirstSave!: () => void;
    (SaveWorkspaceState as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstSave = resolve;
          })
      )
      .mockImplementation(() => Promise.resolve());
    mockLoad.mockResolvedValue(null);
    useIDEStore.setState({
      workspaces: defs as never,
      activeWorkspaceId: 'project',
    });

    renderHook(() => useWorkspacePersistence());
    act(() => {
      useIDEStore.setState({ workspace: { name: 'repo-a', path: '/repo-a' } });
    });

    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith('/repo-a'));
    await waitFor(() => expect(useIDEStore.getState().isRestoringWorkspace).toBe(false));

    act(() => {
      useIDEStore.getState().setActiveWorkspace('frontend');
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    await waitFor(() => expect(SaveWorkspaceState).toHaveBeenCalledTimes(1));

    act(() => {
      useIDEStore.setState({ workspace: { name: 'repo-b', path: '/repo-b' } });
    });
    act(() => {
      useIDEStore.getState().setWorkspaces([]);
    });

    await act(async () => {
      resolveFirstSave();
    });

    await waitFor(() => {
      const repoASaves = (SaveWorkspaceState as jest.Mock).mock.calls.filter(
        ([state]) => state.workspacePath === '/repo-a'
      );
      expect(repoASaves).toHaveLength(2);
    });
    const repoASaves = (SaveWorkspaceState as jest.Mock).mock.calls.filter(
      ([state]) => state.workspacePath === '/repo-a'
    );
    const saved = repoASaves.at(-1)![0];
    expect(saved.activeWorkspaceId).toBe('frontend');
  } finally {
    jest.useRealTimers();
  }
});
