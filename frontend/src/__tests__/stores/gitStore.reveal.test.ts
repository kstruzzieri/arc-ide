import { useGitStore } from '../../stores/gitStore';
import { useIDEStore } from '../../stores/ideStore';
import type { GitFileChange } from '../../types/git';
import { GitConflictState, GitFileAtRev, GitFileHunks, ReadFile } from '../../wails/bindings';

jest.mock('../../wails/bindings', () => ({
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
  GitConflictState: jest.fn(),
  GitWriteConflictResult: jest.fn(),
  GitStageConflictResult: jest.fn(),
  GitApplyConflictSide: jest.fn(),
  ReadFile: jest.fn(),
  WriteFile: jest.fn(),
}));

const mockFileAtRev = GitFileAtRev as jest.MockedFunction<typeof GitFileAtRev>;
const mockFileHunks = GitFileHunks as jest.MockedFunction<typeof GitFileHunks>;
const mockConflictState = GitConflictState as jest.MockedFunction<typeof GitConflictState>;
const mockReadFile = ReadFile as jest.MockedFunction<typeof ReadFile>;

const change: GitFileChange = { path: 'src/a.ts', index: ' ', worktree: 'M' };

const heads = {
  operation: 'merge',
  ours: { label: 'current', hash: 'abc', subject: '' },
  theirs: { label: 'incoming', hash: 'def', subject: '' },
};

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState(useIDEStore.getInitialState());
  useGitStore.setState({
    ...useGitStore.getInitialState(),
    root: '/repo',
    status: { isRepo: true, repoRoot: '/repo', files: [] } as never,
  });
  mockFileAtRev.mockResolvedValue({ content: 'old', binary: false, truncated: false } as never);
  mockFileHunks.mockResolvedValue({ hunks: [] } as never);
  mockReadFile.mockResolvedValue({
    content: 'new',
    encoding: 'utf-8',
    lineEndings: 'LF',
    isBinary: false,
  } as never);
});

/** Files railed by preference: what a reveal has to undo. */
const railFiles = () => useIDEStore.getState().setFilesPanelCollapsed(true);
const filesCollapsed = () => useIDEStore.getState().isFilesPanelCollapsed;

describe('openDiff reveal (#271 §6.3)', () => {
  it('reveals Files on a focused open, and again for the same path', async () => {
    await useGitStore.getState().openDiff(change, 'unstaged');
    expect(useGitStore.getState().diffFocused).toBe(true);

    railFiles();
    await useGitStore.getState().openDiff(change, 'unstaged');
    expect(filesCollapsed()).toBe(false);
    expect(useIDEStore.getState().centerReveal).toBe('files');
  });

  it('leaves a railed Files column alone for a background refresh', async () => {
    railFiles();
    await useGitStore.getState().openDiff(change, 'unstaged', { focus: false });
    expect(useGitStore.getState().diffSession).not.toBeNull();
    expect(filesCollapsed()).toBe(true);
  });

  it('does not reveal when the read fails', async () => {
    railFiles();
    mockFileAtRev.mockRejectedValue(new Error('boom'));
    await useGitStore.getState().openDiff(change, 'unstaged');
    expect(useGitStore.getState().diffSession).toBeNull();
    expect(filesCollapsed()).toBe(true);
  });

  it('does not reveal when the workspace changed under the request', async () => {
    railFiles();
    mockFileAtRev.mockImplementation((async () => {
      useGitStore.setState({ epoch: useGitStore.getState().epoch + 1 });
      return { content: 'old', binary: false, truncated: false };
    }) as never);

    await useGitStore.getState().openDiff(change, 'unstaged');

    expect(useGitStore.getState().diffSession).toBeNull();
    expect(filesCollapsed()).toBe(true);
  });
});

describe('openMergeResolution reveal (#271 §6.3)', () => {
  const sidesState = { stages: { ours: 'a', theirs: 'b' }, heads, sourceVersion: 'v1' };
  const textState = {
    ...sidesState,
    snapshot: {
      content: '<<<<<<< current\nleft\n=======\nright\n>>>>>>> incoming\n',
      encoding: 'utf-8',
      lineEndings: 'lf',
      regions: [{ index: 0, startLine: 1, endLine: 5, ours: ['left'], theirs: ['right'] }],
    },
  };

  it('reveals Files for a sides session', async () => {
    railFiles();
    mockConflictState.mockResolvedValue(sidesState as never);

    expect(await useGitStore.getState().openMergeResolution('clash.go', ['clash.go'])).toBe(true);
    expect(useGitStore.getState().mergeSession?.kind).toBe('sides');
    expect(filesCollapsed()).toBe(false);
  });

  it('reveals Files for a text session, and again when the same file is refocused', async () => {
    mockConflictState.mockResolvedValue(textState as never);
    expect(await useGitStore.getState().openMergeResolution('clash.go', ['clash.go'])).toBe(true);
    expect(useGitStore.getState().mergeSession?.kind).toBe('text');

    railFiles();
    expect(await useGitStore.getState().openMergeResolution('clash.go', ['clash.go'])).toBe(true);
    expect(filesCollapsed()).toBe(false);
    expect(useIDEStore.getState().centerReveal).toBe('files');
  });

  it('does not reveal when the file is not conflicted or the read fails', async () => {
    railFiles();
    mockConflictState.mockResolvedValue({ stages: {}, heads, sourceVersion: 'v1' } as never);
    expect(await useGitStore.getState().openMergeResolution('clean.go', ['clean.go'])).toBe(false);
    expect(filesCollapsed()).toBe(true);

    mockConflictState.mockRejectedValue(new Error('boom'));
    expect(await useGitStore.getState().openMergeResolution('clash.go', ['clash.go'])).toBe(false);
    expect(filesCollapsed()).toBe(true);
  });
});
