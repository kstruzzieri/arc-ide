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
  GitFileAtRev: jest.fn(),
  ReadFile: jest.fn(),
}));

import { act, renderHook, waitFor } from '@testing-library/react';
import { GitFileAtRev } from '../wails/bindings';
import { useGitBaseline } from './useGitBaseline';
import { useGitStore } from '../stores/gitStore';
import type { git } from '../wails/bindings';

const mockFileAtRev = GitFileAtRev as jest.MockedFunction<typeof GitFileAtRev>;

function seedStatus(
  files: Array<{ path: string; index: string; worktree: string; origPath?: string }>
) {
  useGitStore.getState().resetForWorkspace('/repo');
  useGitStore.setState({
    status: {
      isRepo: true,
      repoRoot: '/repo',
      branch: 'main',
      upstream: '',
      ahead: 0,
      behind: 0,
      files,
    } as unknown as git.RepoStatus,
    statusByPath: Object.fromEntries(
      files.map((f) => [`/repo/${f.path}`, f.index === '?' ? 'untracked' : 'modified'])
    ),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFileAtRev.mockResolvedValue({
    content: 'head content',
    binary: false,
    truncated: false,
  } as Awaited<ReturnType<typeof GitFileAtRev>>);
});

describe('useGitBaseline', () => {
  it('fetches HEAD content for a modified file', async () => {
    seedStatus([{ path: 'src/a.ts', index: '.', worktree: 'M' }]);

    const { result } = renderHook(() => useGitBaseline('/repo/src/a.ts'));

    await waitFor(() => expect(result.current).toBe('head content'));
    expect(mockFileAtRev).toHaveBeenCalledWith('/repo', 'HEAD', 'src/a.ts');
  });

  it('refetches when git status refreshes even if row status stays modified', async () => {
    mockFileAtRev
      .mockResolvedValueOnce({
        content: 'old head',
        binary: false,
        truncated: false,
      } as Awaited<ReturnType<typeof GitFileAtRev>>)
      .mockResolvedValueOnce({
        content: 'new head',
        binary: false,
        truncated: false,
      } as Awaited<ReturnType<typeof GitFileAtRev>>);
    seedStatus([{ path: 'src/a.ts', index: '.', worktree: 'M' }]);

    const { result } = renderHook(() => useGitBaseline('/repo/src/a.ts'));
    await waitFor(() => expect(result.current).toBe('old head'));

    act(() => {
      useGitStore.setState((state) => ({ statusRevision: state.statusRevision + 1 }));
    });

    await waitFor(() => expect(result.current).toBe('new head'));
    expect(mockFileAtRev).toHaveBeenCalledTimes(2);
  });

  it('uses the original HEAD path for a renamed file', async () => {
    seedStatus([{ path: 'src/new.ts', origPath: 'src/old.ts', index: 'R', worktree: '.' }]);

    const { result } = renderHook(() => useGitBaseline('/repo/src/new.ts'));

    await waitFor(() => expect(result.current).toBe('head content'));
    expect(mockFileAtRev).toHaveBeenCalledWith('/repo', 'HEAD', 'src/old.ts');
  });

  it('returns an empty baseline for an untracked file without fetching', async () => {
    seedStatus([{ path: 'new.ts', index: '?', worktree: '?' }]);

    const { result } = renderHook(() => useGitBaseline('/repo/new.ts'));

    await waitFor(() => expect(result.current).toBe(''));
    expect(mockFileAtRev).not.toHaveBeenCalled();
  });

  it('returns null for a clean file', async () => {
    seedStatus([]);

    const { result } = renderHook(() => useGitBaseline('/repo/clean.ts'));

    await waitFor(() => expect(result.current).toBeNull());
    expect(mockFileAtRev).not.toHaveBeenCalled();
  });

  it('returns null when HEAD content is binary', async () => {
    mockFileAtRev.mockResolvedValue({
      content: '',
      binary: true,
      truncated: false,
    } as Awaited<ReturnType<typeof GitFileAtRev>>);
    seedStatus([{ path: 'img.png', index: '.', worktree: 'M' }]);

    const { result, rerender } = renderHook(() => useGitBaseline('/repo/img.png'));
    rerender();

    await waitFor(() => expect(mockFileAtRev).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('returns null for no path', () => {
    const { result } = renderHook(() => useGitBaseline(undefined));

    expect(result.current).toBeNull();
  });
});
