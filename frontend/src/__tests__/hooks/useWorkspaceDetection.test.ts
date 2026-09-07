import { renderHook, waitFor, act } from '@testing-library/react';
import { useWorkspaceDetection } from '../../hooks/useWorkspaceDetection';
import { useIDEStore } from '../../stores/ideStore';
import { DetectWorkspaces } from '../../wails/bindings';

jest.mock('../../wails/bindings', () => ({
  DetectWorkspaces: jest.fn(),
}));

const mockDetect = DetectWorkspaces as jest.Mock;

beforeEach(() => {
  mockDetect.mockReset();
  useIDEStore.setState({ workspace: null, workspaces: [], activeWorkspaceId: 'project' });
});

it('detects workspaces when a repo is open', async () => {
  mockDetect.mockResolvedValue([
    { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
    { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'frontend', accent: 'frontend' },
  ]);

  renderHook(() => useWorkspaceDetection());
  act(() => {
    useIDEStore.setState({ workspace: { name: 'repo', path: '/repo' } });
  });

  await waitFor(() => expect(mockDetect).toHaveBeenCalledWith('/repo'));
  await waitFor(() => expect(useIDEStore.getState().workspaces).toHaveLength(2));
});

it('clears workspaces when no repo is open', async () => {
  useIDEStore.setState({
    workspaces: [
      { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
    ] as never,
  });
  renderHook(() => useWorkspaceDetection());
  act(() => {
    useIDEStore.setState({ workspace: null });
  });
  await waitFor(() => expect(useIDEStore.getState().workspaces).toHaveLength(0));
  expect(mockDetect).not.toHaveBeenCalled();
});

it('clears stale workspaces immediately on repo switch (no cross-repo leak)', async () => {
  mockDetect.mockResolvedValueOnce([
    { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
    { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'frontend', accent: 'frontend' },
  ]);
  renderHook(() => useWorkspaceDetection());

  act(() => {
    useIDEStore.setState({ workspace: { name: 'a', path: '/a' } });
  });
  await waitFor(() => expect(useIDEStore.getState().workspaces).toHaveLength(2));
  act(() => {
    useIDEStore.getState().setActiveWorkspace('frontend');
  });
  expect(useIDEStore.getState().activeWorkspaceId).toBe('frontend');

  // Switch to repo B with a slow (still-pending) detection.
  let resolveB!: (v: unknown) => void;
  mockDetect.mockReturnValueOnce(
    new Promise((r) => {
      resolveB = r;
    })
  );
  act(() => {
    useIDEStore.setState({ workspace: { name: 'b', path: '/b' } });
  });

  // Immediately: stale list cleared and active id reset, before B resolves.
  expect(useIDEStore.getState().workspaces).toHaveLength(0);
  expect(useIDEStore.getState().activeWorkspaceId).toBe('project');

  await act(async () => {
    resolveB([{ id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' }]);
  });
  expect(useIDEStore.getState().workspaces).toHaveLength(1);
});
