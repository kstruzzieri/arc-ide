jest.mock('../wails/bindings', () => ({
  GitStatus: jest.fn(),
  GitStage: jest.fn(),
  GitUnstage: jest.fn(),
  GitIntentToAdd: jest.fn(),
  GitCommit: jest.fn(),
  GitPull: jest.fn(),
  GitPush: jest.fn(),
  GitBranches: jest.fn(),
  GitCheckout: jest.fn(),
  GitCommitMessageAvailable: jest.fn(),
  GitGenerateCommitMessage: jest.fn(),
  GitFileAtRev: jest.fn(),
  GitFileHunks: jest.fn(),
  GitApplyHunk: jest.fn(),
  ReadFile: jest.fn(),
}));

import {
  GitStatus,
  GitStage,
  GitIntentToAdd,
  GitCommit,
  GitPull,
  GitBranches,
  GitCheckout,
  GitCommitMessageAvailable,
  GitGenerateCommitMessage,
  GitFileAtRev,
  GitFileHunks,
  GitApplyHunk,
  ReadFile,
} from '../wails/bindings';
import { CancellablePromise } from '../wails/runtime';
import { useGitStore, GIT_REFRESH_DEBOUNCE_MS } from './gitStore';
import { useIDEStore } from './ideStore';

const mockGitStatus = GitStatus as jest.MockedFunction<typeof GitStatus>;
const mockGitStage = GitStage as jest.MockedFunction<typeof GitStage>;
const mockGitIntentToAdd = GitIntentToAdd as jest.MockedFunction<typeof GitIntentToAdd>;
const mockGitCommit = GitCommit as jest.MockedFunction<typeof GitCommit>;
const mockGitPull = GitPull as jest.MockedFunction<typeof GitPull>;
const mockGitBranches = GitBranches as jest.MockedFunction<typeof GitBranches>;
const mockGitCheckout = GitCheckout as jest.MockedFunction<typeof GitCheckout>;
const mockAvailable = GitCommitMessageAvailable as jest.MockedFunction<
  typeof GitCommitMessageAvailable
>;
const mockGenerate = GitGenerateCommitMessage as jest.MockedFunction<
  typeof GitGenerateCommitMessage
>;

const repoStatus = (over: Record<string, unknown> = {}) =>
  ({
    isRepo: true,
    repoRoot: '/repo',
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 2,
    files: [
      { path: 'a.ts', index: 'M', worktree: '.' },
      { path: 'b.ts', index: '.', worktree: 'M' },
    ],
    ...over,
  }) as Awaited<ReturnType<typeof GitStatus>>;

function resetStores() {
  useGitStore.getState().resetForWorkspace('/repo');
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStores();
});

describe('gitStore refresh', () => {
  it('populates status and the absolute statusByPath map', async () => {
    mockGitStatus.mockResolvedValue(repoStatus());

    await useGitStore.getState().refresh();

    const s = useGitStore.getState();
    expect(s.status?.branch).toBe('main');
    expect(s.statusByPath['/repo/a.ts']).toBe('modified');
    expect(s.isRefreshing).toBe(false);
  });

  it('clears state for a non-repo workspace', async () => {
    mockGitStatus.mockResolvedValue(repoStatus({ isRepo: false, branch: '', files: [] }));

    await useGitStore.getState().refresh();

    const s = useGitStore.getState();
    expect(s.status?.isRepo).toBe(false);
    expect(s.statusByPath).toEqual({});
  });

  it('drops a stale refresh that resolves after a workspace switch', async () => {
    let resolveA!: (v: Awaited<ReturnType<typeof GitStatus>>) => void;
    mockGitStatus.mockReturnValueOnce(
      new CancellablePromise((res) => {
        resolveA = res;
      })
    );
    const inFlight = useGitStore.getState().refresh();

    useGitStore.getState().resetForWorkspace('/other');
    resolveA(repoStatus({ branch: 'stale-branch' }));
    await inFlight;

    expect(useGitStore.getState().status?.branch).not.toBe('stale-branch');
  });

  it('surfaces refresh failure as a toast and stops the spinner', async () => {
    mockGitStatus.mockRejectedValue(new Error('boom'));

    await useGitStore.getState().refresh();

    expect(useGitStore.getState().isRefreshing).toBe(false);
    expect(useIDEStore.getState().toast?.type).toBe('error');
  });

  it('debounces scheduleRefresh into a single call', async () => {
    jest.useFakeTimers();
    mockGitStatus.mockResolvedValue(repoStatus());

    const s = useGitStore.getState();
    s.scheduleRefresh();
    s.scheduleRefresh();
    s.scheduleRefresh();
    jest.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10);
    await Promise.resolve();

    expect(mockGitStatus).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});

describe('gitStore operations', () => {
  beforeEach(() => {
    useIDEStore.setState({ openFiles: [], toast: null });
    mockGitStatus.mockResolvedValue(repoStatus());
  });

  it('stage calls the binding with the workspace root and refreshes', async () => {
    mockGitStage.mockResolvedValue(undefined);

    await useGitStore.getState().stage(['a.ts']);

    expect(mockGitStage).toHaveBeenCalledWith('/repo', ['a.ts']);
    expect(mockGitStatus).toHaveBeenCalled();
  });

  it('intentToAdd calls the binding with the workspace root and refreshes', async () => {
    mockGitIntentToAdd.mockResolvedValue(undefined);

    await useGitStore.getState().intentToAdd(['new.md']);

    expect(mockGitIntentToAdd).toHaveBeenCalledWith('/repo', ['new.md']);
    expect(mockGitStatus).toHaveBeenCalled();
  });

  it('intentToAdd failure lands in lastError and toasts', async () => {
    mockGitIntentToAdd.mockRejectedValue(new Error('pathspec did not match'));

    await useGitStore.getState().intentToAdd(['gone.md']);

    expect(useGitStore.getState().lastError).toContain('pathspec');
    expect(useIDEStore.getState().toast?.type).toBe('error');
  });

  it('commit clears the message on success', async () => {
    mockGitCommit.mockResolvedValue('[main abc] subject');
    useGitStore.getState().setCommitMessage('feat: thing');

    await useGitStore.getState().commit(false);

    expect(mockGitCommit).toHaveBeenCalledWith('/repo', 'feat: thing', false);
    expect(useGitStore.getState().commitMessage).toBe('');
  });

  it('commit success records a receipt with hash, subject, and staged files', async () => {
    mockGitStatus.mockResolvedValue(
      repoStatus({
        files: [
          { path: 'a.ts', index: 'M', worktree: '.' },
          { path: 'b.ts', index: '.', worktree: 'M' },
        ],
      })
    );
    await useGitStore.getState().refresh();
    mockGitCommit.mockResolvedValue(
      '[main 1a2b3c4] feat: add thing\n 1 file changed, 2 insertions(+)'
    );
    useGitStore.getState().setCommitMessage('feat: add thing');

    await useGitStore.getState().commit(false);

    const receipt = useGitStore.getState().lastCommitReceipt;
    expect(receipt?.hash).toBe('1a2b3c4');
    expect(receipt?.branch).toBe('main');
    expect(receipt?.subject).toBe('feat: add thing');
    expect(receipt?.files).toEqual(['a.ts']); // only staged files, not b.ts
    expect(receipt?.output).toContain('1 file changed');
  });

  it('commit failure leaves no receipt', async () => {
    mockGitCommit.mockRejectedValue(new Error('hook rejected'));
    useGitStore.getState().setCommitMessage('x');

    await useGitStore.getState().commit(false);

    expect(useGitStore.getState().lastCommitReceipt).toBeNull();
  });

  it('commit failure keeps the message and toasts the git error', async () => {
    mockGitCommit.mockRejectedValue(new Error('git commit: nothing staged'));
    useGitStore.getState().setCommitMessage('feat: thing');

    await useGitStore.getState().commit(false);

    expect(useGitStore.getState().commitMessage).toBe('feat: thing');
    expect(useGitStore.getState().lastError).toContain('nothing staged');
  });

  it('pull records op-in-flight state and output', async () => {
    let resolvePull!: (v: string) => void;
    mockGitPull.mockReturnValue(
      new CancellablePromise((res) => {
        resolvePull = res;
      })
    );

    const p = useGitStore.getState().pull();
    expect(useGitStore.getState().opInFlight).toBe('pull');

    resolvePull('Already up to date.');
    await p;
    expect(useGitStore.getState().opInFlight).toBeNull();
    expect(useGitStore.getState().lastOpOutput).toContain('up to date');
  });

  it('drops a mutating op result that resolves after a workspace switch', async () => {
    let resolvePull!: (v: string) => void;
    mockGitPull.mockReturnValue(
      new CancellablePromise((res) => {
        resolvePull = res;
      })
    );

    const p = useGitStore.getState().pull();
    expect(useGitStore.getState().opInFlight).toBe('pull');

    useGitStore.getState().resetForWorkspace('/other');
    mockGitStatus.mockClear();
    resolvePull('Already up to date.');
    await p;

    expect(useGitStore.getState().lastOpOutput).toBeNull();
    expect(useGitStore.getState().lastError).toBeNull();
    expect(mockGitStatus).not.toHaveBeenCalled();
  });

  it('pull conflict error lands in lastError for the panel', async () => {
    mockGitPull.mockRejectedValue(new Error('git pull: CONFLICT (content): a.ts'));

    await useGitStore.getState().pull();

    expect(useGitStore.getState().lastError).toContain('CONFLICT');
    expect(useGitStore.getState().opInFlight).toBeNull();
  });

  it('checkout refreshes branches and status', async () => {
    mockGitCheckout.mockResolvedValue(undefined);
    mockGitBranches.mockResolvedValue(['main', 'feature/x']);

    await useGitStore.getState().checkout('feature/x', false);

    expect(mockGitCheckout).toHaveBeenCalledWith('/repo', 'feature/x', false);
    expect(useGitStore.getState().branches).toEqual(['main', 'feature/x']);
  });

  it('generateMessage fills commitMessage when golem responds', async () => {
    mockGenerate.mockResolvedValue('feat: generated subject');

    await useGitStore.getState().generateMessage();

    expect(useGitStore.getState().commitMessage).toBe('feat: generated subject');
  });

  it('probeAiAvailable stores availability', async () => {
    mockAvailable.mockResolvedValue(true);

    await useGitStore.getState().probeAiAvailable();

    expect(useGitStore.getState().aiAvailable).toBe(true);
  });
});

describe('gitStore diff sessions', () => {
  const mockFileAtRev = GitFileAtRev as jest.MockedFunction<typeof GitFileAtRev>;
  const mockReadFile = ReadFile as jest.MockedFunction<typeof ReadFile>;
  const mockFileHunks = GitFileHunks as jest.MockedFunction<typeof GitFileHunks>;
  const mockApplyHunk = GitApplyHunk as jest.MockedFunction<typeof GitApplyHunk>;
  const rev = (content: string, flags: Partial<{ binary: boolean; truncated: boolean }> = {}) =>
    ({ content, binary: false, truncated: false, ...flags }) as Awaited<
      ReturnType<typeof GitFileAtRev>
    >;
  const hunks = (...list: { patch: string; newStart: number; newLines: number }[]) =>
    ({ path: 'src/a.ts', hunks: list }) as Awaited<ReturnType<typeof GitFileHunks>>;

  beforeEach(() => {
    mockGitStatus.mockResolvedValue(repoStatus());
    mockFileAtRev.mockResolvedValue(rev(''));
    mockFileHunks.mockResolvedValue(hunks());
    mockApplyHunk.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue({
      content: 'worktree text',
      encoding: 'utf-8',
      lineEndings: 'lf',
      isBinary: false,
    } as Awaited<ReturnType<typeof ReadFile>>);
  });

  it('fetches per-hunk staging data for a tracked unstaged diff', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));
    mockFileHunks.mockResolvedValueOnce(hunks({ patch: 'PATCH', newStart: 2, newLines: 1 }));

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');

    // staged=false for the working-tree-vs-index (stageable) hunks.
    expect(mockFileHunks).toHaveBeenCalledWith('/repo', 'src/a.ts', false);
    expect(useGitStore.getState().diffSession?.hunks).toEqual([
      { patch: 'PATCH', newStart: 2, newLines: 1 },
    ]);
  });

  it('fetches staged hunks (staged=true) for a staged diff', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('head')).mockResolvedValueOnce(rev('index'));

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: 'M', worktree: '.' }, 'staged');

    expect(mockFileHunks).toHaveBeenCalledWith('/repo', 'src/a.ts', true);
  });

  it('suppresses hunks while the working-tree side is an unsaved editor buffer', async () => {
    // git diffs disk, but the pane shows the dirty buffer — disk hunks would
    // neither line up with nor stage what's on screen, so no per-hunk buttons.
    useIDEStore.setState({
      openFiles: [
        {
          id: 'f',
          path: '/repo/src/a.ts',
          name: 'a.ts',
          content: 'unsaved\n',
          encoding: 'utf-8',
          lineEndings: 'lf',
          isModified: true,
        },
      ] as unknown as ReturnType<typeof useIDEStore.getState>['openFiles'],
    });
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');

    expect(mockFileHunks).not.toHaveBeenCalled();
    expect(useGitStore.getState().diffSession?.hunks).toEqual([]);
    // Flagged so the diff view keeps its previous hunk gutter through the
    // save window instead of collapsing the column on this refresh.
    expect(useGitStore.getState().diffSession?.hunksSuppressed).toBe(true);
    useIDEStore.setState({ openFiles: [] });
  });

  it('does not flag genuinely hunk-less diffs as suppressed', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));
    mockFileHunks.mockResolvedValueOnce(hunks());

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');

    expect(useGitStore.getState().diffSession?.hunksSuppressed).toBe(false);
  });

  it('still fetches hunks when the open file is saved (buffer matches disk)', async () => {
    useIDEStore.setState({
      openFiles: [
        {
          id: 'f',
          path: '/repo/src/a.ts',
          name: 'a.ts',
          content: 'saved\n',
          encoding: 'utf-8',
          lineEndings: 'lf',
          isModified: false,
        },
      ] as unknown as ReturnType<typeof useIDEStore.getState>['openFiles'],
    });
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');

    expect(mockFileHunks).toHaveBeenCalledWith('/repo', 'src/a.ts', false);
    useIDEStore.setState({ openFiles: [] });
  });

  it('skips hunk fetching for untracked files (no per-hunk staging)', async () => {
    await useGitStore
      .getState()
      .openDiff({ path: 'new.ts', index: '?', worktree: '?' }, 'unstaged');

    expect(mockFileHunks).not.toHaveBeenCalled();
    expect(useGitStore.getState().diffSession?.hunks).toEqual([]);
  });

  it('applyHunk stages a hunk (reverse=false) and refreshes', async () => {
    await useGitStore.getState().applyHunk('PATCH', false);

    expect(mockApplyHunk).toHaveBeenCalledWith('/repo', 'PATCH', false);
    // runOp refreshes afterward so the diff view reflects the new index.
    expect(mockGitStatus).toHaveBeenCalled();
  });

  it('applyHunk unstages a hunk (reverse=true)', async () => {
    await useGitStore.getState().applyHunk('PATCH', true);

    expect(mockApplyHunk).toHaveBeenCalledWith('/repo', 'PATCH', true);
  });

  it('staged context diffs HEAD against the index', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('head text')).mockResolvedValueOnce(rev('index text'));

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: 'M', worktree: '.' }, 'staged');

    expect(mockFileAtRev).toHaveBeenNthCalledWith(1, '/repo', 'HEAD', 'src/a.ts');
    expect(mockFileAtRev).toHaveBeenNthCalledWith(2, '/repo', ':0', 'src/a.ts');
    const session = useGitStore.getState().diffSession;
    expect(session?.left).toEqual({ label: 'HEAD', content: 'head text' });
    expect(session?.right).toEqual({ label: 'Index', content: 'index text' });
    expect(session?.path).toBe('src/a.ts');
    expect(useGitStore.getState().diffFocused).toBe(true);
  });

  it('staged rename diffs HEAD from the original path against the new index path', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('old text')).mockResolvedValueOnce(rev('new text'));

    await useGitStore
      .getState()
      .openDiff(
        { path: 'src/new.ts', origPath: 'src/old.ts', index: 'R', worktree: '.' },
        'staged'
      );

    expect(mockFileAtRev).toHaveBeenNthCalledWith(1, '/repo', 'HEAD', 'src/old.ts');
    expect(mockFileAtRev).toHaveBeenNthCalledWith(2, '/repo', ':0', 'src/new.ts');
    expect(useGitStore.getState().diffSession?.left).toEqual({
      label: 'HEAD',
      content: 'old text',
    });
    expect(mockFileHunks).not.toHaveBeenCalled();
    expect(useGitStore.getState().diffSession?.hunks).toEqual([]);
  });

  it('fetches hunks for unstaged edits on a staged rename', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));
    mockFileHunks.mockResolvedValueOnce(hunks({ patch: 'PATCH', newStart: 1, newLines: 1 }));

    await useGitStore
      .getState()
      .openDiff(
        { path: 'src/new.ts', origPath: 'src/old.ts', index: 'R', worktree: 'M' },
        'unstaged'
      );

    expect(mockFileHunks).toHaveBeenCalledWith('/repo', 'src/new.ts', false);
    expect(useGitStore.getState().diffSession?.hunks).toEqual([
      { patch: 'PATCH', newStart: 1, newLines: 1 },
    ]);
  });

  it('unstaged context diffs the index against the working tree', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');

    expect(mockFileAtRev).toHaveBeenCalledWith('/repo', ':0', 'src/a.ts');
    expect(mockReadFile).toHaveBeenCalledWith('/repo/src/a.ts');
    const session = useGitStore.getState().diffSession;
    expect(session?.right).toEqual({ label: 'Working Tree', content: 'worktree text' });
  });

  it('captures the working-tree encoding and line endings for a disk-read unstaged diff', async () => {
    // These let an edit written straight to disk (file not open in the editor)
    // round-trip the original encoding/line endings instead of forcing UTF-8/LF.
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));
    mockReadFile.mockResolvedValueOnce({
      content: 'worktree text',
      encoding: 'utf-16le',
      lineEndings: 'crlf',
    } as Awaited<ReturnType<typeof ReadFile>>);

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');

    const session = useGitStore.getState().diffSession;
    expect(session?.worktreeEncoding).toBe('utf-16le');
    expect(session?.worktreeLineEndings).toBe('crlf');
  });

  it('does not reuse a session when only persistence metadata changed', async () => {
    mockFileAtRev.mockResolvedValue(rev('index text'));
    mockReadFile.mockResolvedValueOnce({
      content: 'same text',
      encoding: 'utf-8',
      lineEndings: 'lf',
      isBinary: false,
    } as Awaited<ReturnType<typeof ReadFile>>);
    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');
    const first = useGitStore.getState().diffSession;

    mockReadFile.mockResolvedValueOnce({
      content: 'same text',
      encoding: 'utf-16le',
      lineEndings: 'crlf',
      isBinary: false,
    } as Awaited<ReturnType<typeof ReadFile>>);
    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');

    expect(useGitStore.getState().diffSession).not.toBe(first);
    expect(useGitStore.getState().diffSession?.worktreeEncoding).toBe('utf-16le');
  });

  it('leaves working-tree encoding unset for a staged diff (its right side is read-only)', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('head')).mockResolvedValueOnce(rev('index'));

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: 'M', worktree: '.' }, 'staged');

    const session = useGitStore.getState().diffSession;
    expect(session?.worktreeEncoding).toBeUndefined();
    expect(session?.worktreeLineEndings).toBeUndefined();
  });

  it('uses the live editor buffer for the working-tree side when the file is open', async () => {
    // An open, possibly-unsaved file: the diff reflects the editor content,
    // not stale disk content, and doesn't read disk.
    useIDEStore.setState({
      openFiles: [
        {
          id: 'f',
          path: '/repo/src/a.ts',
          name: 'a.ts',
          content: 'live editor edits\n',
          encoding: 'utf-16le',
          lineEndings: 'crlf',
          isModified: true,
        },
      ] as unknown as ReturnType<typeof useIDEStore.getState>['openFiles'],
    });
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));

    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');

    expect(useGitStore.getState().diffSession?.right.content).toBe('live editor edits\n');
    expect(useGitStore.getState().diffSession?.worktreeEncoding).toBe('utf-16le');
    expect(useGitStore.getState().diffSession?.worktreeLineEndings).toBe('crlf');
    expect(mockReadFile).not.toHaveBeenCalled();
    useIDEStore.setState({ openFiles: [] });
  });

  it('a background refresh cannot cancel a user-initiated diff open', async () => {
    // The user clicks file B while a watcher refresh is mid-flight. The
    // refresh's refreshOpenDiff must yield to the pending user request, not
    // bump the request revision and get B's completion discarded.
    mockFileAtRev.mockResolvedValue(rev('index a'));
    useGitStore.setState({
      status: repoStatus({ files: [{ path: 'src/a.ts', index: '.', worktree: 'M' }] }),
    });
    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');

    // User clicks B; hold its worktree read open.
    let releaseB!: (v: Awaited<ReturnType<typeof ReadFile>>) => void;
    mockReadFile.mockReturnValueOnce(
      new CancellablePromise((res) => {
        releaseB = res;
      })
    );
    const userOpen = useGitStore
      .getState()
      .openDiff({ path: 'src/b.ts', index: '.', worktree: 'M' }, 'unstaged');

    // Watcher refresh lands while B is still loading.
    await useGitStore.getState().refreshOpenDiff();

    releaseB({ content: 'b worktree' } as Awaited<ReturnType<typeof ReadFile>>);
    await userOpen;

    expect(useGitStore.getState().diffSession?.path).toBe('src/b.ts');
  });

  it('follows a whole-file stage: the unstaged diff retargets to the staged context', async () => {
    // Open the unstaged diff, then stage the whole file via the panel checkbox:
    // the unstaged side goes empty and the change now lives in the staged
    // context, so the open diff must switch with it instead of going stale.
    mockFileAtRev.mockResolvedValue(rev('index text'));
    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');
    expect(useGitStore.getState().diffSession?.context).toBe('unstaged');

    useGitStore.setState({
      status: repoStatus({ files: [{ path: 'src/a.ts', index: 'M', worktree: '.' }] }),
    });
    await useGitStore.getState().refreshOpenDiff();

    expect(useGitStore.getState().diffSession?.context).toBe('staged');
  });

  it('follows a whole-file unstage back to the (editable) unstaged context', async () => {
    mockFileAtRev.mockResolvedValue(rev('head text'));
    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: 'M', worktree: '.' }, 'staged');

    useGitStore.setState({
      status: repoStatus({ files: [{ path: 'src/a.ts', index: '.', worktree: 'M' }] }),
    });
    await useGitStore.getState().refreshOpenDiff();

    expect(useGitStore.getState().diffSession?.context).toBe('unstaged');
  });

  it('keeps the current context for a partially staged file', async () => {
    // Both contexts still have content: no reason to yank the user elsewhere.
    mockFileAtRev.mockResolvedValue(rev('index text'));
    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: 'M', worktree: 'M' }, 'unstaged');

    useGitStore.setState({
      status: repoStatus({ files: [{ path: 'src/a.ts', index: 'M', worktree: 'M' }] }),
    });
    await useGitStore.getState().refreshOpenDiff();

    expect(useGitStore.getState().diffSession?.context).toBe('unstaged');
  });

  it('re-fetches the open diff on refresh even when git status no longer lists the file', async () => {
    // Unsaved edit: disk is unchanged so the file drops out of git status, but
    // the open diff must still update from the live buffer.
    const change = { path: 'src/a.ts', index: '.', worktree: 'M' };
    const openFile = (content: string) =>
      useIDEStore.setState({
        openFiles: [
          {
            id: 'f',
            path: '/repo/src/a.ts',
            name: 'a.ts',
            content,
            encoding: 'utf-8',
            lineEndings: 'lf',
            isModified: true,
          },
        ] as unknown as ReturnType<typeof useIDEStore.getState>['openFiles'],
      });
    mockFileAtRev.mockResolvedValue(rev('index text'));

    openFile('v1\n');
    await useGitStore.getState().openDiff(change, 'unstaged');
    expect(useGitStore.getState().diffSession?.right.content).toBe('v1\n');

    openFile('v2 edited\n');
    mockGitStatus.mockResolvedValue(repoStatus({ files: [] }));
    await useGitStore.getState().refresh();

    expect(useGitStore.getState().diffSession?.right.content).toBe('v2 edited\n');
    useIDEStore.setState({ openFiles: [] });
  });

  // A file added then edited before commit is A/M: the staged row diffs it as
  // a brand-new file (HEAD is empty), while a separate unstaged row shows only
  // the edits made after staging (index -> working tree).
  it('shows an added-then-modified file as new when staged, incremental when unstaged', async () => {
    const added = { path: 'fresh.ts', index: 'A', worktree: 'M' };

    // Staged view: HEAD has no such file (empty) vs the content at add time.
    mockFileAtRev.mockResolvedValueOnce(rev('')).mockResolvedValueOnce(rev('added content\n'));
    await useGitStore.getState().openDiff(added, 'staged');
    let session = useGitStore.getState().diffSession;
    expect(mockFileAtRev).toHaveBeenNthCalledWith(1, '/repo', 'HEAD', 'fresh.ts');
    expect(session?.left).toEqual({ label: 'HEAD', content: '' });
    expect(session?.right).toEqual({ label: 'Index', content: 'added content\n' });

    // Unstaged view: content at add time vs current working tree (the new edits).
    mockFileAtRev.mockReset();
    mockFileAtRev.mockResolvedValueOnce(rev('added content\n'));
    mockReadFile.mockResolvedValueOnce({
      content: 'added content\nplus later edits\n',
    } as Awaited<ReturnType<typeof ReadFile>>);
    await useGitStore.getState().openDiff(added, 'unstaged');
    session = useGitStore.getState().diffSession;
    expect(mockFileAtRev).toHaveBeenCalledWith('/repo', ':0', 'fresh.ts');
    expect(session?.left).toEqual({ label: 'Index', content: 'added content\n' });
    expect(session?.right).toEqual({
      label: 'Working Tree',
      content: 'added content\nplus later edits\n',
    });
  });

  it('re-fetches an open diff when git status refreshes (live edits)', async () => {
    const added = { path: 'fresh.ts', index: 'A', worktree: 'M' };
    mockFileAtRev.mockResolvedValue(rev('staged content\n'));
    mockReadFile.mockResolvedValueOnce({
      content: 'staged content\n',
    } as Awaited<ReturnType<typeof ReadFile>>);

    await useGitStore.getState().openDiff(added, 'unstaged');
    expect(useGitStore.getState().diffSession?.right.content).toBe('staged content\n');

    // The user keeps editing: the worktree grows, and a status refresh fires.
    mockGitStatus.mockResolvedValue(repoStatus({ files: [added] }));
    mockReadFile.mockResolvedValueOnce({
      content: 'staged content\nplus a later edit\n',
    } as Awaited<ReturnType<typeof ReadFile>>);
    await useGitStore.getState().refresh();

    expect(useGitStore.getState().diffSession?.right.content).toBe(
      'staged content\nplus a later edit\n'
    );
  });

  it('keeps the same diff session object when a refresh finds no change (no rebuild)', async () => {
    const added = { path: 'fresh.ts', index: 'A', worktree: 'M' };
    mockFileAtRev.mockResolvedValue(rev('x'));
    mockReadFile.mockResolvedValue({ content: 'x' } as Awaited<ReturnType<typeof ReadFile>>);
    await useGitStore.getState().openDiff(added, 'unstaged');
    const first = useGitStore.getState().diffSession;

    mockGitStatus.mockResolvedValue(repoStatus({ files: [added] }));
    await useGitStore.getState().refresh();

    // Same content → same object reference, so the merge view is not rebuilt.
    expect(useGitStore.getState().diffSession).toBe(first);
  });

  it('rebuilds an open untracked diff after intent-to-add enables hunks', async () => {
    const untracked = { path: 'fresh.ts', index: '?', worktree: '?' };
    const intentToAdd = { path: 'fresh.ts', index: '.', worktree: 'A' };
    mockReadFile.mockResolvedValue({ content: 'x' } as Awaited<ReturnType<typeof ReadFile>>);
    await useGitStore.getState().openDiff(untracked, 'unstaged');
    const first = useGitStore.getState().diffSession;

    mockGitStatus.mockResolvedValue(repoStatus({ files: [intentToAdd] }));
    mockFileAtRev.mockResolvedValueOnce(rev(''));
    mockFileHunks.mockResolvedValueOnce(hunks({ patch: 'PATCH', newStart: 1, newLines: 1 }));
    await useGitStore.getState().refresh();

    const session = useGitStore.getState().diffSession;
    expect(session).not.toBe(first);
    expect(session?.hunks).toEqual([{ patch: 'PATCH', newStart: 1, newLines: 1 }]);
  });

  it('keeps the diff unfocused across a refresh when the user is on a file tab', async () => {
    const added = { path: 'fresh.ts', index: 'A', worktree: 'M' };
    mockFileAtRev.mockResolvedValue(rev('x'));
    mockReadFile.mockResolvedValue({ content: 'x' } as Awaited<ReturnType<typeof ReadFile>>);
    await useGitStore.getState().openDiff(added, 'unstaged');
    useGitStore.getState().setDiffFocused(false);

    mockGitStatus.mockResolvedValue(repoStatus({ files: [added] }));
    await useGitStore.getState().refresh();

    expect(useGitStore.getState().diffFocused).toBe(false);
    expect(useGitStore.getState().diffSession).not.toBeNull();
  });

  it('untracked files diff against empty content without a rev fetch', async () => {
    await useGitStore
      .getState()
      .openDiff({ path: 'new.md', index: '?', worktree: '?' }, 'unstaged');

    expect(mockFileAtRev).not.toHaveBeenCalled();
    const session = useGitStore.getState().diffSession;
    expect(session?.left).toEqual({ label: 'Index', content: '' });
  });

  it('flags binary sessions instead of shipping content', async () => {
    mockFileAtRev.mockResolvedValue(rev('', { binary: true }));

    await useGitStore.getState().openDiff({ path: 'img.png', index: 'M', worktree: '.' }, 'staged');

    expect(useGitStore.getState().diffSession?.binary).toBe(true);
  });

  it('a deleted worktree file stays an empty read-only snapshot', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));

    await useGitStore
      .getState()
      .openDiff({ path: 'gone.ts', index: '.', worktree: 'D' }, 'unstaged');

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(useGitStore.getState().diffSession?.right).toEqual({
      label: 'Working Tree',
      content: '',
    });
    expect(useGitStore.getState().diffSession?.worktreeEncoding).toBeUndefined();
    expect(useGitStore.getState().diffSession?.worktreeLineEndings).toBeUndefined();
  });

  it('does not expose an editable empty pane when a non-deleted file cannot be read', async () => {
    mockFileAtRev.mockResolvedValueOnce(rev('index text'));
    mockReadFile.mockRejectedValue(new Error('permission denied'));

    await useGitStore
      .getState()
      .openDiff({ path: 'private.ts', index: '.', worktree: 'M' }, 'unstaged');

    expect(useGitStore.getState().diffSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toContain('permission denied');
  });

  it('drops an older diff request that resolves after a newer one', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof GitFileAtRev>>) => void;
    mockFileAtRev
      .mockReturnValueOnce(
        new CancellablePromise((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce(rev('new index'));

    const oldRequest = useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');
    const newRequest = useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: '.', worktree: 'M' }, 'unstaged');
    await newRequest;

    resolveOld(rev('old index'));
    await oldRequest;

    expect(useGitStore.getState().diffSession?.left.content).toBe('new index');
  });

  it('closeDiff clears the session and focus', async () => {
    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: 'M', worktree: '.' }, 'staged');

    useGitStore.getState().closeDiff();

    expect(useGitStore.getState().diffSession).toBeNull();
    expect(useGitStore.getState().diffFocused).toBe(false);
  });

  it('resetForWorkspace drops any open diff session', async () => {
    await useGitStore
      .getState()
      .openDiff({ path: 'src/a.ts', index: 'M', worktree: '.' }, 'staged');

    useGitStore.getState().resetForWorkspace('/other');

    expect(useGitStore.getState().diffSession).toBeNull();
  });
});
