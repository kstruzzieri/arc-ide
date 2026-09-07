jest.mock('../wails/bindings', () => ({
  GitStatus: jest.fn(),
  GitStage: jest.fn(),
  GitUnstage: jest.fn(),
  GitCommit: jest.fn(),
  GitPull: jest.fn(),
  GitPush: jest.fn(),
  GitBranches: jest.fn(),
  GitCheckout: jest.fn(),
  GitCommitMessageAvailable: jest.fn(),
  GitGenerateCommitMessage: jest.fn(),
}));

import { renderHook, act } from '@testing-library/react';
import { GitStatus, GitBranches, GitCommitMessageAvailable } from '../wails/bindings';
import { useGitSync } from './useGitSync';
import { useGitStore, GIT_REFRESH_DEBOUNCE_MS } from '../stores/gitStore';
import { useIDEStore } from '../stores/ideStore';

const mockGitStatus = GitStatus as jest.MockedFunction<typeof GitStatus>;
const mockGitBranches = GitBranches as jest.MockedFunction<typeof GitBranches>;
const mockAvailable = GitCommitMessageAvailable as jest.MockedFunction<
  typeof GitCommitMessageAvailable
>;

const repoStatus = {
  isRepo: true,
  repoRoot: '/ws',
  branch: 'main',
  upstream: '',
  ahead: 0,
  behind: 0,
  files: [],
} as unknown as Awaited<ReturnType<typeof GitStatus>>;

beforeEach(() => {
  jest.clearAllMocks();
  mockGitStatus.mockResolvedValue(repoStatus);
  mockGitBranches.mockResolvedValue(['main']);
  mockAvailable.mockResolvedValue(false);
  useGitStore.getState().resetForWorkspace(null);
});

describe('useGitSync', () => {
  it('resets and refreshes git state when a workspace is active', async () => {
    act(() => {
      useIDEStore.setState({ workspace: { name: 'ws', path: '/ws' } });
    });

    renderHook(() => useGitSync());
    await act(async () => {});

    expect(useGitStore.getState().root).toBe('/ws');
    expect(mockGitStatus).toHaveBeenCalledWith('/ws');
    expect(mockGitBranches).toHaveBeenCalledWith('/ws');
    expect(mockAvailable).toHaveBeenCalled();
  });

  it('does not load branches when the active workspace is not a git repo', async () => {
    mockGitStatus.mockResolvedValue({
      ...repoStatus,
      isRepo: false,
      repoRoot: '',
      branch: '',
      files: [],
    } as unknown as Awaited<ReturnType<typeof GitStatus>>);
    act(() => {
      useIDEStore.setState({ workspace: { name: 'plain', path: '/plain' } });
    });

    renderHook(() => useGitSync());
    await act(async () => {});

    expect(mockGitStatus).toHaveBeenCalledWith('/plain');
    expect(mockGitBranches).not.toHaveBeenCalled();
  });

  it('clears git state when there is no workspace', async () => {
    act(() => {
      useIDEStore.setState({ workspace: null });
    });

    renderHook(() => useGitSync());
    await act(async () => {});

    expect(useGitStore.getState().root).toBeNull();
    expect(mockGitStatus).not.toHaveBeenCalled();
  });

  it('schedules a refresh when the window regains focus', async () => {
    jest.useFakeTimers();
    act(() => {
      useIDEStore.setState({ workspace: { name: 'ws', path: '/ws' } });
    });
    renderHook(() => useGitSync());
    await act(async () => {});
    mockGitStatus.mockClear();

    act(() => {
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10);
    });
    await act(async () => {});

    expect(mockGitStatus).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('removes the focus listener on unmount', async () => {
    jest.useFakeTimers();
    act(() => {
      useIDEStore.setState({ workspace: { name: 'ws', path: '/ws' } });
    });
    const { unmount } = renderHook(() => useGitSync());
    await act(async () => {});
    mockGitStatus.mockClear();

    unmount();
    act(() => {
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10);
    });
    await act(async () => {});

    expect(mockGitStatus).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
