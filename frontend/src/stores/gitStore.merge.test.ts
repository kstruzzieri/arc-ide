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
  WriteFile: jest.fn(),
  GitConflictStages: jest.fn(),
  GitMergeHeads: jest.fn(),
  GitConflictSnapshot: jest.fn(),
  GitConflictState: jest.fn(),
  GitResolveConflictSide: jest.fn(),
  GitWriteConflictResult: jest.fn(),
  GitStageConflictResult: jest.fn(),
  GitApplyConflictSide: jest.fn(),
}));

import {
  GitStatus,
  GitStage,
  WriteFile,
  GitConflictStages,
  GitMergeHeads,
  GitConflictSnapshot,
  GitConflictState,
  GitResolveConflictSide,
  GitWriteConflictResult,
  GitStageConflictResult,
  GitApplyConflictSide,
} from '../wails/bindings';
import type { git } from '../wails/bindings';
import { CancellablePromise } from '../wails/runtime';
import { useGitStore } from './gitStore';
import { useIDEStore, type EditorFile } from './ideStore';
import { writeFileSerialized } from '../utils/fileWrites';

const mockStages = GitConflictStages as jest.MockedFunction<typeof GitConflictStages>;
const mockGitStage = GitStage as jest.MockedFunction<typeof GitStage>;
const mockResolveSide = GitResolveConflictSide as jest.MockedFunction<
  typeof GitResolveConflictSide
>;
const mockHeads = GitMergeHeads as jest.MockedFunction<typeof GitMergeHeads>;
const mockSnapshot = GitConflictSnapshot as jest.MockedFunction<typeof GitConflictSnapshot>;
const mockState = GitConflictState as jest.MockedFunction<typeof GitConflictState>;
const mockGuardedWrite = GitWriteConflictResult as jest.MockedFunction<
  typeof GitWriteConflictResult
>;
const mockGuardedStage = GitStageConflictResult as jest.MockedFunction<
  typeof GitStageConflictResult
>;
const mockGuardedApply = GitApplyConflictSide as jest.MockedFunction<typeof GitApplyConflictSide>;

const mockWriteFile = WriteFile as jest.MockedFunction<typeof WriteFile>;
const mockGitStatus = GitStatus as jest.MockedFunction<typeof GitStatus>;

const repoStatus = (over: Record<string, unknown> = {}) =>
  ({
    isRepo: true,
    repoRoot: '/repo',
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    files: [{ path: 'file.txt', index: 'U', worktree: 'U', unmerged: true }],
    ...over,
  }) as git.RepoStatus;

const blob = (): git.StageBlob => ({ hash: 'abc123', size: 10 }) as git.StageBlob;

const allStages = (over: Partial<git.ConflictStages> = {}): git.ConflictStages =>
  ({
    path: 'file.txt',
    base: blob(),
    ours: blob(),
    theirs: blob(),
    binary: false,
    ...over,
  }) as git.ConflictStages;

const heads = (): git.MergeHeads =>
  ({
    operation: 'merge',
    ours: { label: 'main', hash: 'abc123', subject: 'ours subject' },
    theirs: { label: 'feature', hash: 'def456', subject: 'theirs subject' },
  }) as git.MergeHeads;

const region = (): git.ConflictRegion =>
  ({
    index: 0,
    startLine: 1,
    endLine: 5,
    ours: ['ours line'],
    base: [],
    theirs: ['theirs line'],
    hasBase: false,
    oursLabel: 'HEAD',
    theirLabel: 'feature',
  }) as git.ConflictRegion;

const snapshot = (over: Partial<git.ConflictSnapshot> = {}): git.ConflictSnapshot =>
  ({
    content: '<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> feature\n',
    encoding: 'utf-8',
    lineEndings: 'lf',
    regions: [region()],
    ...over,
  }) as git.ConflictSnapshot;

const openFile = (over: Partial<EditorFile> = {}): EditorFile => ({
  id: 'f1',
  name: 'file.txt',
  path: '/repo/file.txt',
  language: 'plaintext',
  encoding: 'utf-8',
  lineEndings: 'lf',
  content: 'buffer content',
  isModified: false,
  ...over,
});

/** The version the fake backend currently reports. Tests that simulate an
 * external change move it; everything else never touches it. */
let sourceVersion = 'v1:initial';

const conflictState = (over: Partial<git.ConflictState> = {}): git.ConflictState =>
  ({
    stages: allStages(),
    snapshot: snapshot(),
    heads: heads(),
    sourceVersion,
    ...over,
  }) as git.ConflictState;

/**
 * Derives the one coherent read the store now performs from the same stage /
 * heads / snapshot mocks, applying the SAME kind rules the Go backend applies
 * (`internal/git/conflicts.go`): no stages means nothing conflicted and no
 * heads; a binary conflict or a missing side has no text snapshot. Tests that
 * care about a specific source version, or about a mismatch, override
 * `mockState` directly.
 */
function backendDerivesStateFromMocks() {
  const derive = async (root: string, path: string) => {
    const stages = await mockStages(root, path);
    const conflicted = Boolean(stages.base || stages.ours || stages.theirs);
    const wantsSides = Boolean(stages.binary || !stages.ours || !stages.theirs);
    const state: Record<string, unknown> = { stages, sourceVersion };
    if (conflicted) state.heads = await mockHeads(root);
    if (conflicted && !wantsSides) state.snapshot = await mockSnapshot(root, path);
    return state as unknown as git.ConflictState;
  };
  mockState.mockImplementation((root: string, path: string) =>
    CancellablePromise.resolve(derive(root, path))
  );
}

/** The result a successful guarded write reports. */
const writeApplied = () =>
  ({ applied: true, sourceVersion: 'v1:after-write' }) as git.ConflictGuardResult;

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new CancellablePromise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  useGitStore.getState().resetForWorkspace('/repo');
  useGitStore.setState({ status: repoStatus() });
  useIDEStore.setState({ openFiles: [], toast: null });
  mockGitStatus.mockResolvedValue(repoStatus());
  mockWriteFile.mockResolvedValue(undefined);
  sourceVersion = 'v1:initial';
  backendDerivesStateFromMocks();
  // Default guarded backend: every mutation is accepted and reports a fresh
  // version, which is what a real successful write/stage/apply does.
  mockGuardedWrite.mockImplementation(() =>
    CancellablePromise.resolve({
      applied: true,
      sourceVersion: 'v1:after-write',
    } as git.ConflictGuardResult)
  );
  mockGuardedStage.mockImplementation(() =>
    CancellablePromise.resolve({
      applied: true,
      sourceVersion: 'v1:after-stage',
    } as git.ConflictGuardResult)
  );
  mockGuardedApply.mockImplementation(() =>
    CancellablePromise.resolve({
      applied: true,
      sourceVersion: 'v1:after-apply',
    } as git.ConflictGuardResult)
  );
});

describe('openMergeResolution', () => {
  it('builds a text session from stages, heads, and one snapshot read', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());

    const ok = await useGitStore
      .getState()
      .openMergeResolution('file.txt', ['file.txt', 'other.txt']);

    expect(ok).toBe(true);
    const session = useGitStore.getState().mergeSession;
    expect(session).not.toBeNull();
    if (session?.kind !== 'text') throw new Error('expected text session');
    expect(session.path).toBe('file.txt');
    expect(session.absPath).toBe('/repo/file.txt');
    expect(useGitStore.getState().mergeFocused).toBe(true);
    expect(useGitStore.getState().diffFocused).toBe(false);
    expect(session.repoRoot).toBe('/repo');
    expect(session.labels.ours.label).toBe('main');
    expect(session.labels.theirs.label).toBe('feature');
    expect(session.fileQueue).toEqual(['file.txt', 'other.txt']);
    expect(session.content).toBe(snapshot().content);
    expect(session.encoding).toBe('utf-8');
    expect(session.lineEndings).toBe('lf');
    expect(session.regions).toHaveLength(1);
    expect(session.decisions).toEqual({});
    expect(session.readOnly).toBe(false);
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSnapshot).toHaveBeenCalledWith('/repo', 'file.txt');
  });

  it('builds a sides session for a binary conflict without reading a snapshot', async () => {
    mockStages.mockResolvedValue(allStages({ binary: true }));
    mockHeads.mockResolvedValue(heads());

    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    expect(ok).toBe(true);
    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'sides') throw new Error('expected sides session');
    expect(session.stages.binary).toBe(true);
    expect(session.selectedSide).toBeUndefined();
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('builds a sides session when ours is absent (delete/modify)', async () => {
    mockStages.mockResolvedValue(allStages({ ours: undefined }));
    mockHeads.mockResolvedValue(heads());

    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    expect(ok).toBe(true);
    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'sides') throw new Error('expected sides session');
    expect(session.stages.ours).toBeUndefined();
    expect(session.stages.theirs).toBeDefined();
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('returns false with a toast and no session when the path is not conflicted', async () => {
    mockStages.mockResolvedValue(
      allStages({ base: undefined, ours: undefined, theirs: undefined })
    );

    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    expect(ok).toBe(false);
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toMatch(/not conflicted/i);
    expect(mockHeads).not.toHaveBeenCalled();
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('returns false with a toast when the snapshot read fails', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockRejectedValue(new Error('marker parse failed'));

    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    expect(ok).toBe(false);
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toContain('marker parse failed');
  });

  it('returns false with a toast when the snapshot has no regions', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot({ regions: [] }));

    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    expect(ok).toBe(false);
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toMatch(/no conflict markers/i);
  });

  it('flushes a dirty open buffer to disk before reading the snapshot', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ isModified: true, content: 'unsaved edits' })],
    });
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());

    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    expect(ok).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/repo/file.txt',
      'unsaved edits',
      'utf-8',
      'lf',
      false
    );
    const writeOrder = mockWriteFile.mock.invocationCallOrder[0];
    const snapshotOrder = mockSnapshot.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(snapshotOrder);
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(false);
  });

  it('returns false with a toast when flushing the dirty buffer fails', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ isModified: true, content: 'unsaved edits' })],
    });
    mockWriteFile.mockRejectedValue(new Error('disk full'));

    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    expect(ok).toBe(false);
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toContain('disk full');
    expect(mockStages).not.toHaveBeenCalled();
  });

  it('drops the result when the workspace switches mid-flight', async () => {
    const gate = deferred<git.ConflictStages>();
    mockStages.mockReturnValue(gate.promise);

    const call = useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    useGitStore.getState().resetForWorkspace('/other');
    gate.resolve(allStages());
    const ok = await call;

    expect(ok).toBe(false);
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('refocuses an existing same-path merge session without any save or Wails work', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);
    const live = useGitStore.getState().mergeSession;
    const requestRevision = live?.requestRevision;
    useGitStore.setState({ diffFocused: true, mergeFocused: false });
    mockStages.mockClear();
    mockHeads.mockClear();
    mockSnapshot.mockClear();
    mockWriteFile.mockClear();

    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    expect(ok).toBe(true);
    expect(useGitStore.getState().mergeSession).toBe(live);
    expect(useGitStore.getState().mergeSession?.requestRevision).toBe(requestRevision);
    expect(useGitStore.getState().mergeFocused).toBe(true);
    expect(useGitStore.getState().diffFocused).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockStages).not.toHaveBeenCalled();
    expect(mockHeads).not.toHaveBeenCalled();
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('refuses a different merge-session replacement before any save or Wails work', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);
    const live = useGitStore.getState().mergeSession;
    const requestRevision = live?.requestRevision;
    mockStages.mockClear();
    mockHeads.mockClear();
    mockSnapshot.mockClear();
    mockWriteFile.mockClear();

    const ok = await useGitStore.getState().openMergeResolution('other.txt', ['other.txt']);

    expect(ok).toBe(false);
    expect(useGitStore.getState().mergeSession).toBe(live);
    expect(useGitStore.getState().mergeSession?.requestRevision).toBe(requestRevision);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockStages).not.toHaveBeenCalled();
    expect(mockHeads).not.toHaveBeenCalled();
    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(useIDEStore.getState().toast?.message).toMatch(/close.*first/i);
  });

  it('drops a superseded request in favor of the newer one', async () => {
    const first = deferred<git.ConflictStages>();
    // Key the mock by path — the two opens run concurrently, so call order
    // between them is scheduling-dependent.
    mockStages.mockImplementation((_root, p) =>
      p === 'a.txt'
        ? first.promise
        : CancellablePromise.resolve(allStages({ path: 'b.txt', binary: true }))
    );
    mockHeads.mockResolvedValue(heads());

    const firstCall = useGitStore.getState().openMergeResolution('a.txt', ['a.txt', 'b.txt']);
    const secondOk = await useGitStore.getState().openMergeResolution('b.txt', ['a.txt', 'b.txt']);
    first.resolve(allStages({ path: 'a.txt', binary: true }));
    const firstOk = await firstCall;

    expect(firstOk).toBe(false);
    expect(secondOk).toBe(true);
    const session = useGitStore.getState().mergeSession;
    expect(session?.path).toBe('b.txt');
  });

  it('opens read-only when the snapshot encoding is not writable', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot({ encoding: 'latin-1' }));

    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    expect(ok).toBe(true);
    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'text') throw new Error('expected text session');
    expect(session.readOnly).toBe(true);
  });

  it('refuses a snapshot when the file is written while it is being read', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    const snapshotGate = deferred<git.ConflictSnapshot>();
    mockSnapshot.mockReturnValue(snapshotGate.promise);

    const open = useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    for (let i = 0; i < 10 && mockSnapshot.mock.calls.length === 0; i++) await Promise.resolve();
    await writeFileSerialized('/repo/file.txt', 'external edit', 'utf-8', 'lf', false);
    snapshotGate.resolve(snapshot());

    expect(await open).toBe(false);
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toMatch(/changed|try again/i);
  });
});

describe('merge decision actions', () => {
  async function openTextSession() {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    expect(ok).toBe(true);
  }

  async function openSidesSession() {
    mockStages.mockResolvedValue(allStages({ binary: true }));
    mockHeads.mockResolvedValue(heads());
    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    expect(ok).toBe(true);
  }

  it('recordDecision stores a choice for a region on a text session', async () => {
    await openTextSession();

    useGitStore.getState().recordDecision(0, 'C');

    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'text') throw new Error('expected text session');
    expect(session.decisions).toEqual({ 0: 'C' });
  });

  it('recordDecision replaces an earlier choice for the same region', async () => {
    await openTextSession();

    useGitStore.getState().recordDecision(0, 'C');
    useGitStore.getState().recordDecision(0, 'I');

    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'text') throw new Error('expected text session');
    expect(session.decisions).toEqual({ 0: 'I' });
  });

  it('reopenDecision removes a recorded choice', async () => {
    await openTextSession();
    useGitStore.getState().recordDecision(0, 'B');

    useGitStore.getState().reopenDecision(0);

    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'text') throw new Error('expected text session');
    expect(session.decisions).toEqual({});
  });

  it('recordDecision ignores out-of-range region indices', async () => {
    await openTextSession();

    useGitStore.getState().recordDecision(5, 'C');
    useGitStore.getState().recordDecision(-1, 'C');

    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'text') throw new Error('expected text session');
    expect(session.decisions).toEqual({});
  });

  it('recordDecision is a no-op on a sides session and with no session', async () => {
    useGitStore.getState().recordDecision(0, 'C');
    expect(useGitStore.getState().mergeSession).toBeNull();

    await openSidesSession();
    const before = useGitStore.getState().mergeSession;
    useGitStore.getState().recordDecision(0, 'C');
    expect(useGitStore.getState().mergeSession).toBe(before);
  });

  it('selectMergeSide sets the chosen side on a sides session', async () => {
    await openSidesSession();

    useGitStore.getState().selectMergeSide('theirs');

    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'sides') throw new Error('expected sides session');
    expect(session.selectedSide).toBe('theirs');
  });

  it('selectMergeSide is a no-op on a text session and with no session', async () => {
    useGitStore.getState().selectMergeSide('ours');
    expect(useGitStore.getState().mergeSession).toBeNull();

    await openTextSession();
    const before = useGitStore.getState().mergeSession;
    useGitStore.getState().selectMergeSide('ours');
    expect(useGitStore.getState().mergeSession).toBe(before);
  });

  it('closeMergeResolution discards the session without writing anything', async () => {
    await openTextSession();
    useGitStore.getState().recordDecision(0, 'C');
    mockWriteFile.mockClear();

    useGitStore.getState().closeMergeResolution();

    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useGitStore.getState().mergeFocused).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
  });

  it('resetForWorkspace clears an open merge session', async () => {
    await openTextSession();

    useGitStore.getState().resetForWorkspace('/other');

    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useGitStore.getState().mergeFocused).toBe(false);
  });
});

describe('mergeFinalizeAndStage', () => {
  const RESOLVED = 'resolved line\n';

  async function openTextSession(queue = ['file.txt']) {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    const ok = await useGitStore.getState().openMergeResolution('file.txt', queue);
    expect(ok).toBe(true);
  }

  function resolveTextSessionForFinalize() {
    useGitStore.getState().recordDecision(0, 'C');
  }

  async function openSidesSession(queue = ['file.txt']) {
    mockStages.mockResolvedValue(allStages({ binary: true }));
    mockHeads.mockResolvedValue(heads());
    const ok = await useGitStore.getState().openMergeResolution('file.txt', queue);
    expect(ok).toBe(true);
  }

  beforeEach(() => {
    mockGitStage.mockResolvedValue(undefined);
    mockResolveSide.mockResolvedValue(undefined);
  });

  it('writes the result, stages the file, and closes on an exhausted queue', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(true);
    expect(mockGuardedWrite).toHaveBeenCalledWith(
      '/repo',
      'file.txt',
      'v1:initial',
      RESOLVED,
      'utf-8',
      'lf'
    );
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-write');
    const writeOrder = mockGuardedWrite.mock.invocationCallOrder[0];
    const stageOrder = mockGuardedStage.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(stageOrder);
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useGitStore.getState().mergeFocused).toBe(false);
  });

  it('refuses to finalize unresolved text before writing or staging', async () => {
    await openTextSession();
    mockWriteFile.mockClear();
    mockGitStage.mockClear();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(false);
    expect(useIDEStore.getState().toast?.message).toMatch(/unresolved/i);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).not.toBeNull();
  });

  it('reconciles an open clean buffer with the resolved content', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(true);
    const file = useIDEStore.getState().openFiles[0];
    expect(file.content).toBe(RESOLVED);
    expect(file.isModified).toBe(false);
  });

  it('blocks finalize when the open buffer diverged from the session content', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();
    useIDEStore.setState({
      openFiles: [openFile({ content: 'concurrent edit', isModified: true })],
    });
    mockWriteFile.mockClear();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).not.toBeNull();
    expect(useIDEStore.getState().toast?.message).toBeTruthy();
  });

  it('refuses to finalize a read-only text session', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot({ encoding: 'latin-1' }));
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    mockWriteFile.mockClear();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockGuardedStage).not.toHaveBeenCalled();
  });

  it('finalizes a sides session through the guarded apply and stage', async () => {
    await openSidesSession();
    useGitStore.getState().selectMergeSide('theirs');

    const ok = await useGitStore.getState().mergeFinalizeAndStage();

    expect(ok).toBe(true);
    expect(mockGuardedApply).toHaveBeenCalledWith('/repo', 'file.txt', 'theirs', 'v1:initial');
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-apply');
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).toBeNull();
  });

  it('refuses a sides finalize before a side is selected', async () => {
    await openSidesSession();

    const ok = await useGitStore.getState().mergeFinalizeAndStage();

    expect(ok).toBe(false);
    expect(mockGuardedApply).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).not.toBeNull();
  });

  it('keeps the session open and reports when staging fails', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();
    mockGuardedStage.mockRejectedValue(new Error('index locked'));

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(false);
    expect(useGitStore.getState().mergeSession).not.toBeNull();
    expect(useIDEStore.getState().toast?.message).toContain('index locked');
  });

  it('invalidates the session and reports when the resolved write fails', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();
    mockGuardedWrite.mockRejectedValue(new Error('disk full'));

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(false);
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toContain('disk full');
  });

  it('advances to the next queued conflicted file after a successful finalize', async () => {
    mockStages.mockImplementation((_root, p) =>
      p === 'file.txt'
        ? CancellablePromise.resolve(allStages())
        : CancellablePromise.resolve(allStages({ path: 'other.txt', binary: true }))
    );
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt', 'other.txt']);
    resolveTextSessionForFinalize();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(true);
    const session = useGitStore.getState().mergeSession;
    expect(session?.path).toBe('other.txt');
    expect(session?.kind).toBe('sides');
    expect(session?.fileQueue).toEqual(['other.txt']);
  });

  it('hands off to the next queued file after staging this one', async () => {
    mockStages.mockImplementation((_root, path) =>
      path === 'file.txt'
        ? CancellablePromise.resolve(allStages())
        : CancellablePromise.resolve(allStages({ path: 'other.txt', binary: true }))
    );
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt', 'other.txt']);
    resolveTextSessionForFinalize();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(true);
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-write');
    // The advance is no longer suppressible: the next conflicted file opens.
    expect(useGitStore.getState().mergeSession?.path).toBe('other.txt');
  });

  it('reports queue completion when the last file finalizes', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(true);
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toBe('Conflict queue resolved');
  });

  it('aborts before staging when the workspace switches mid-write', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();
    const gate = deferred<void>();
    mockWriteFile.mockReturnValue(gate.promise as never);

    const call = useGitStore.getState().mergeFinalizeAndStage(RESOLVED);
    // Let the finalize reach the actual disk write before switching away.
    for (let i = 0; i < 10 && mockGuardedWrite.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(mockGuardedWrite).toHaveBeenCalled();
    useGitStore.getState().resetForWorkspace('/other');
    gate.resolve();
    const ok = await call;

    expect(ok).toBe(false);
    expect(mockGuardedStage).not.toHaveBeenCalled();
    // The resolved text WAS written but never staged — the user must be told
    // what manual recovery the stranded file needs.
    expect(useIDEStore.getState().toast?.message).toMatch(/written but not staged/i);
  });

  it('is a no-op without a session or without a result on a text session', async () => {
    expect(await useGitStore.getState().mergeFinalizeAndStage(RESOLVED)).toBe(false);

    await openTextSession();
    mockWriteFile.mockClear();
    expect(await useGitStore.getState().mergeFinalizeAndStage()).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).not.toBeNull();
  });

  it('finalizes a CRLF file whose open buffer is LF-normalized by the editor', async () => {
    // CodeMirror joins lines with \n, so an ever-edited CRLF file holds LF
    // content in the store while the snapshot preserves raw CRLF bytes.
    const crlfContent =
      '<<<<<<< HEAD\r\nours line\r\n=======\r\ntheirs line\r\n>>>>>>> feature\r\n';
    useIDEStore.setState({
      openFiles: [
        openFile({
          content: crlfContent.replace(/\r\n/g, '\n'),
          lineEndings: 'crlf',
          isModified: false,
        }),
      ],
    });
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot({ content: crlfContent, lineEndings: 'crlf' }));
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    resolveTextSessionForFinalize();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(true);
    expect(mockGuardedWrite).toHaveBeenCalledWith(
      '/repo',
      'file.txt',
      'v1:initial',
      RESOLVED,
      'utf-8',
      'crlf'
    );
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-write');
  });

  it('preserves a keystroke that lands in the open buffer during the write', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();
    const gate = deferred<void>();
    mockWriteFile.mockReturnValue(gate.promise);

    const call = useGitStore.getState().mergeFinalizeAndStage(RESOLVED);
    await Promise.resolve();
    useIDEStore.getState().updateFileContent('f1', 'newer keystroke');
    gate.resolve();
    const ok = await call;

    expect(ok).toBe(false);
    expect(mockGuardedStage).not.toHaveBeenCalled();
    const file = useIDEStore.getState().openFiles[0];
    expect(file.content).toBe('newer keystroke');
    expect(file.isModified).toBe(true);
    expect(useIDEStore.getState().toast?.message).toBeTruthy();
  });

  it('allows an immediate retry after a staging failure with the file open', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();
    mockGuardedStage.mockRejectedValueOnce(new Error('index locked'));

    expect(await useGitStore.getState().mergeFinalizeAndStage(RESOLVED)).toBe(false);
    expect(useGitStore.getState().mergeSession).not.toBeNull();

    const retry = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(retry).toBe(true);
    expect(mockGuardedStage).toHaveBeenCalledTimes(2);
    expect(useGitStore.getState().mergeSession).toBeNull();
  });

  it('refuses to finalize while another git operation is in flight', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();
    useGitStore.setState({ opInFlight: 'pull' });
    mockWriteFile.mockClear();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(useIDEStore.getState().toast?.message).toMatch(/operation/i);
    useGitStore.setState({ opInFlight: null });
  });

  it('runs a single write and stage for concurrent finalize calls', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();
    const gate = deferred<void>();
    mockWriteFile.mockReturnValue(gate.promise);

    const first = useGitStore.getState().mergeFinalizeAndStage(RESOLVED);
    const second = useGitStore.getState().mergeFinalizeAndStage('other result\n');
    gate.resolve();
    const [firstOk, secondOk] = await Promise.all([first, second]);

    expect(firstOk).toBe(true);
    expect(secondOk).toBe(false);
    expect(mockGuardedWrite).toHaveBeenCalledTimes(1);
    expect(mockGuardedStage).toHaveBeenCalledTimes(1);
  });

  it('blocks a sides finalize while the open buffer is dirty', async () => {
    useIDEStore.setState({ openFiles: [openFile({ isModified: false })] });
    await openSidesSession();
    useGitStore.getState().selectMergeSide('ours');
    // The edit lands AFTER the session opened (the open itself flushes).
    useIDEStore.getState().updateFileContent('f1', 'edited after open');

    const ok = await useGitStore.getState().mergeFinalizeAndStage();

    expect(ok).toBe(false);
    expect(mockGuardedApply).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).not.toBeNull();
    expect(useIDEStore.getState().toast?.message).toBeTruthy();
  });

  it('closes the open editor tab after a sides finalize applies', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ isModified: false })],
    });
    await openSidesSession();
    useGitStore.getState().selectMergeSide('theirs');

    const ok = await useGitStore.getState().mergeFinalizeAndStage();

    expect(ok).toBe(true);
    expect(useIDEStore.getState().openFiles).toHaveLength(0);
  });

  it('surfaces the unsupported-format reason when finalizing a read-only session', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot({ encoding: 'latin-1' }));
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(false);
    expect(useIDEStore.getState().toast?.message).toMatch(/encoding|format/i);
  });

  it('refuses another open without invalidating the installed session', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();
    mockStages.mockClear();
    mockWriteFile.mockClear();

    const reopened = await useGitStore.getState().openMergeResolution('other.txt', ['other.txt']);

    expect(reopened).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockStages).not.toHaveBeenCalled();
    expect(useIDEStore.getState().toast?.message).toMatch(/close.*first/i);
    expect(await useGitStore.getState().mergeFinalizeAndStage(RESOLVED)).toBe(true);
  });
});

describe('review round 2 hardening', () => {
  const RESOLVED = 'resolved line\n';

  async function openTextSession(queue = ['file.txt']) {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    const ok = await useGitStore.getState().openMergeResolution('file.txt', queue);
    expect(ok).toBe(true);
  }

  function resolveTextSessionForFinalize() {
    useGitStore.getState().recordDecision(0, 'C');
  }

  beforeEach(() => {
    mockGitStage.mockResolvedValue(undefined);
    mockResolveSide.mockResolvedValue(undefined);
  });

  it('keeps the tab and warns when an edit lands during a sides apply', async () => {
    useIDEStore.setState({ openFiles: [openFile({ isModified: false })] });
    mockStages.mockResolvedValue(allStages({ binary: true }));
    mockHeads.mockResolvedValue(heads());
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    useGitStore.getState().selectMergeSide('theirs');
    const gate = deferred<void>();
    mockResolveSide.mockReturnValue(gate.promise);

    const call = useGitStore.getState().mergeFinalizeAndStage();
    await Promise.resolve();
    useIDEStore.getState().updateFileContent('f1', 'edit during apply');
    gate.resolve();
    const ok = await call;

    expect(ok).toBe(true);
    const file = useIDEStore.getState().openFiles[0];
    expect(file).toBeDefined();
    expect(file.content).toBe('edit during apply');
    expect(file.isModified).toBe(true);
    expect(useIDEStore.getState().toast?.message).toMatch(/unsaved|preserved/i);
  });

  it('warns when the tab closes during a sides apply (close-save may recreate)', async () => {
    useIDEStore.setState({ openFiles: [openFile({ isModified: false })] });
    mockStages.mockResolvedValue(allStages({ binary: true }));
    mockHeads.mockResolvedValue(heads());
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    useGitStore.getState().selectMergeSide('theirs');
    const gate = deferred<void>();
    mockResolveSide.mockReturnValue(gate.promise);

    const call = useGitStore.getState().mergeFinalizeAndStage();
    await Promise.resolve();
    // Edit then close mid-apply: the close-save path (useAutosave's
    // subscription) writes the captured content and can recreate a file
    // whose deletion was just staged.
    useIDEStore.getState().updateFileContent('f1', 'edit during apply');
    useIDEStore.getState().closeFile('f1');
    gate.resolve();
    const ok = await call;

    expect(ok).toBe(true);
    expect(useIDEStore.getState().toast?.message).toMatch(/closed|check/i);
  });

  it('blocks staging when the tab closes with edits during the resolved write', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();
    const gate = deferred<git.ConflictGuardResult>();
    mockGuardedWrite.mockReturnValueOnce(gate.promise);

    const call = useGitStore.getState().mergeFinalizeAndStage(RESOLVED);
    for (let i = 0; i < 10 && mockGuardedWrite.mock.calls.length === 0; i++)
      await Promise.resolve();
    // Edit + close mid-write: the close-save queues the marker-bearing edit
    // BEHIND the resolved write in the same per-path queue — disk will not
    // hold the staged resolution.
    useIDEStore.getState().updateFileContent('f1', 'markers still here');
    useIDEStore.getState().closeFile('f1');
    const closeSave = writeFileSerialized(
      '/repo/file.txt',
      'markers still here',
      'utf-8',
      'lf',
      false
    );
    gate.resolve(writeApplied());
    const ok = await call;
    await closeSave;

    expect(ok).toBe(false);
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(useIDEStore.getState().toast?.message).toMatch(/not staged/i);
    // The session closes so a blind retry cannot overwrite the close-saved
    // edit. The user was told to reopen and re-resolve instead.
    expect(useGitStore.getState().mergeSession).toBeNull();
    mockGuardedWrite.mockClear();
    expect(await useGitStore.getState().mergeFinalizeAndStage(RESOLVED)).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
  });

  it('stages when a clean tab closes during the resolved write', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();
    const gate = deferred<git.ConflictGuardResult>();
    mockGuardedWrite.mockReturnValueOnce(gate.promise);

    const call = useGitStore.getState().mergeFinalizeAndStage(RESOLVED);
    for (let i = 0; i < 10 && mockGuardedWrite.mock.calls.length === 0; i++)
      await Promise.resolve();
    useIDEStore.getState().closeFile('f1');
    gate.resolve(writeApplied());

    expect(await call).toBe(true);
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-write');
  });

  it('refuses a dirty baseline buffer before writing the resolution', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();
    useIDEStore.getState().setFileModified('f1', true);
    mockWriteFile.mockClear();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(useIDEStore.getState().toast?.message).toMatch(/unsaved/i);
  });

  it('keeps a later autosave behind the resolved write and stage', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();
    const writeGate = deferred<git.ConflictGuardResult>();
    const stageGate = deferred<git.ConflictGuardResult>();
    let staleWriteStarted = false;
    mockGuardedWrite.mockReturnValueOnce(writeGate.promise);
    // The autosave still writes through WriteFile: only the resolution goes
    // through the guarded op, and it must finish staging first.
    mockWriteFile.mockImplementationOnce(() => {
      staleWriteStarted = true;
      return CancellablePromise.resolve();
    });
    mockGuardedStage.mockReturnValue(stageGate.promise);

    const call = useGitStore.getState().mergeFinalizeAndStage(RESOLVED);
    for (let i = 0; i < 10 && mockGuardedWrite.mock.calls.length === 0; i++)
      await Promise.resolve();
    writeGate.resolve(writeApplied());
    for (let i = 0; i < 10 && mockGuardedStage.mock.calls.length === 0; i++)
      await Promise.resolve();
    const staleWrite = writeFileSerialized(
      '/repo/file.txt',
      snapshot().content,
      'utf-8',
      'lf',
      false
    );
    await Promise.resolve();

    const staleWriteStartedBeforeStageFinished = staleWriteStarted;
    stageGate.resolve({
      applied: true,
      sourceVersion: 'v1:after-stage',
    } as git.ConflictGuardResult);
    expect(await call).toBe(true);
    await staleWrite;
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-write');
    expect(staleWriteStartedBeforeStageFinished).toBe(false);
  });

  it('refuses a close-save that completed before finalize acquired the path', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();
    useIDEStore.getState().updateFileContent('f1', 'closed edit');
    useIDEStore.getState().closeFile('f1');
    await writeFileSerialized('/repo/file.txt', 'closed edit', 'utf-8', 'lf', false);
    mockWriteFile.mockClear();

    const ok = await useGitStore.getState().mergeFinalizeAndStage(RESOLVED);

    expect(ok).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toMatch(/changed|reopen/i);
  });

  it('rechecks cancellation after waiting for the path lock', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();
    const priorWrite = deferred<git.ConflictGuardResult>();
    mockGuardedWrite.mockReturnValueOnce(priorWrite.promise);
    const pending = writeFileSerialized('/repo/file.txt', snapshot().content, 'utf-8', 'lf', false);
    const call = useGitStore.getState().mergeFinalizeAndStage(RESOLVED);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    useGitStore.getState().closeMergeResolution();
    mockWriteFile.mockClear();

    priorWrite.resolve(writeApplied());
    await pending;
    expect(await call).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockGuardedStage).not.toHaveBeenCalled();
  });

  it('invalidates a failed stage when a close-save queued during staging', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();
    let rejectStage!: (error: Error) => void;
    const stage = new CancellablePromise<git.ConflictGuardResult>(
      (_resolve, reject) => (rejectStage = reject)
    );
    void stage.catch(() => undefined);
    mockGuardedStage.mockReturnValueOnce(stage);

    const call = useGitStore.getState().mergeFinalizeAndStage(RESOLVED);
    for (let i = 0; i < 10 && mockGuardedStage.mock.calls.length === 0; i++)
      await Promise.resolve();
    useIDEStore.getState().updateFileContent('f1', 'closed during stage');
    useIDEStore.getState().closeFile('f1');
    const closeSave = writeFileSerialized(
      '/repo/file.txt',
      'closed during stage',
      'utf-8',
      'lf',
      false
    );
    rejectStage(new Error('index locked'));

    expect(await call).toBe(false);
    await closeSave;
    expect(useGitStore.getState().mergeSession).toBeNull();
    mockGuardedWrite.mockClear();
    expect(await useGitStore.getState().mergeFinalizeAndStage(RESOLVED)).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
  });

  it('refuses a side apply after a close-save changed the file', async () => {
    useIDEStore.setState({ openFiles: [openFile({ isModified: false })] });
    mockStages.mockResolvedValue(allStages({ binary: true }));
    mockHeads.mockResolvedValue(heads());
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);
    useGitStore.getState().selectMergeSide('theirs');
    useIDEStore.getState().updateFileContent('f1', 'closed binary edit');
    useIDEStore.getState().closeFile('f1');
    await writeFileSerialized('/repo/file.txt', 'closed binary edit', 'utf-8', 'lf', false);

    expect(await useGitStore.getState().mergeFinalizeAndStage()).toBe(false);
    expect(mockGuardedApply).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useGitStore.getState().mergeFocused).toBe(false);
  });

  it('refuses a same-file re-open while a finalize is mid-write', async () => {
    await openTextSession();
    resolveTextSessionForFinalize();
    const gate = deferred<void>();
    mockWriteFile.mockReturnValue(gate.promise);

    const finalize = useGitStore.getState().mergeFinalizeAndStage(RESOLVED);
    await Promise.resolve();
    mockStages.mockClear();
    const reopened = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    // The refusal must not be a silent dead click.
    expect(useIDEStore.getState().toast?.message).toMatch(/finishing.*previous/i);
    gate.resolve();
    const ok = await finalize;

    expect(reopened).toBe(false);
    expect(mockStages).not.toHaveBeenCalled();
    expect(ok).toBe(true);
    expect(useGitStore.getState().mergeSession).toBeNull();
  });

  it('allows a retry with a corrected result after a staging failure', async () => {
    useIDEStore.setState({
      openFiles: [openFile({ content: snapshot().content, isModified: false })],
    });
    await openTextSession();
    resolveTextSessionForFinalize();
    mockGuardedStage.mockRejectedValueOnce(new Error('index locked'));

    expect(await useGitStore.getState().mergeFinalizeAndStage(RESOLVED)).toBe(false);
    const corrected = 'corrected line\n';
    const retry = await useGitStore.getState().mergeFinalizeAndStage(corrected);

    expect(retry).toBe(true);
    expect(mockGuardedWrite).toHaveBeenLastCalledWith(
      '/repo',
      'file.txt',
      // The retry finalizes against the version the first write produced.
      'v1:after-write',
      corrected,
      'utf-8',
      'lf'
    );
    expect(useGitStore.getState().mergeSession).toBeNull();
  });
});

describe('merge queue advance', () => {
  it('lets a failed next-open toast survive a sides warning', async () => {
    useIDEStore.setState({ openFiles: [openFile({ isModified: false })] });
    mockStages.mockImplementation((_root, p) =>
      p === 'file.txt'
        ? CancellablePromise.resolve(allStages({ binary: true }))
        : CancellablePromise.resolve(
            allStages({ path: 'next.txt', base: undefined, ours: undefined, theirs: undefined })
          )
    );
    mockHeads.mockResolvedValue(heads());
    mockResolveSide.mockReset();
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt', 'next.txt']);
    useGitStore.getState().selectMergeSide('theirs');
    const gate = deferred<void>();
    mockResolveSide.mockReturnValue(gate.promise);

    const call = useGitStore.getState().mergeFinalizeAndStage();
    await Promise.resolve();
    useIDEStore.getState().updateFileContent('f1', 'edit during apply');
    gate.resolve();
    const ok = await call;

    expect(ok).toBe(true);
    // next.txt failed to open ("not conflicted") — that explanation must be
    // the surviving toast, not the sides warning emitted for file.txt.
    expect(useIDEStore.getState().toast?.message).toMatch(/not conflicted/i);
  });
});

describe('installed-session refusal leaves the session finalizable', () => {
  it('a not-conflicted Resolve request on another file does not dead-end the open session', async () => {
    mockStages.mockImplementation((_root, p) =>
      p === 'file.txt'
        ? CancellablePromise.resolve(allStages())
        : CancellablePromise.resolve(
            allStages({ path: 'b.txt', base: undefined, ours: undefined, theirs: undefined })
          )
    );
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    mockGitStage.mockResolvedValue(undefined);
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);

    expect(await useGitStore.getState().openMergeResolution('b.txt', ['b.txt'])).toBe(false);
    useGitStore.getState().recordDecision(0, 'C');

    const ok = await useGitStore.getState().mergeFinalizeAndStage('resolved line\n');
    expect(ok).toBe(true);
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-write');
  });

  it('a rejected Resolve request on another file does not dead-end the open session', async () => {
    mockStages.mockImplementation((_root, p) =>
      p === 'file.txt'
        ? CancellablePromise.resolve(allStages())
        : CancellablePromise.reject(new Error('too large'))
    );
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    mockGitStage.mockResolvedValue(undefined);
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);

    // The installed session refuses a second Resolve before probing b.txt.
    expect(await useGitStore.getState().openMergeResolution('b.txt', ['b.txt'])).toBe(false);
    expect(useGitStore.getState().mergeSession?.path).toBe('file.txt');

    // The surviving session must still finalize — not silently dead-end.
    useGitStore.getState().recordDecision(0, 'C');
    const ok = await useGitStore.getState().mergeFinalizeAndStage('resolved line\n');

    expect(ok).toBe(true);
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-write');
  });
});

describe('same-path installed-session refocus', () => {
  it('keeps the session when a same-path request says it is no longer conflicted', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);
    const live = useGitStore.getState().mergeSession;
    mockStages.mockClear();

    mockStages.mockResolvedValue(
      allStages({ base: undefined, ours: undefined, theirs: undefined })
    );
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);
    expect(useGitStore.getState().mergeSession).toBe(live);
    expect(mockStages).not.toHaveBeenCalled();

    useGitStore.getState().recordDecision(0, 'C');
    expect(await useGitStore.getState().mergeFinalizeAndStage('resolved line\n')).toBe(true);
  });

  it('keeps the session when a same-path request has no conflict markers', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);
    const live = useGitStore.getState().mergeSession;
    mockSnapshot.mockClear();

    mockSnapshot.mockResolvedValue(snapshot({ regions: [] }));
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);
    expect(useGitStore.getState().mergeSession).toBe(live);
    expect(mockSnapshot).not.toHaveBeenCalled();
    useGitStore.getState().recordDecision(0, 'C');
    expect(await useGitStore.getState().mergeFinalizeAndStage('resolved line\n')).toBe(true);
  });

  it('keeps the session when a same-path replacement snapshot would fail', async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);
    const live = useGitStore.getState().mergeSession;
    mockSnapshot.mockClear();

    mockSnapshot.mockRejectedValue(new Error('file changed'));
    expect(await useGitStore.getState().openMergeResolution('file.txt', ['file.txt'])).toBe(true);
    expect(useGitStore.getState().mergeSession).toBe(live);
    expect(mockSnapshot).not.toHaveBeenCalled();
    useGitStore.getState().recordDecision(0, 'C');
    expect(await useGitStore.getState().mergeFinalizeAndStage('resolved line\n')).toBe(true);
  });
});

describe('closeMergeResolution invalidation', () => {
  it('invalidates an in-flight open so a closed surface cannot reappear', async () => {
    const gate = deferred<git.ConflictStages>();
    mockStages.mockReturnValue(gate.promise);
    mockHeads.mockResolvedValue(heads());

    const call = useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    useGitStore.getState().closeMergeResolution();
    gate.resolve(allStages({ binary: true }));
    const ok = await call;

    expect(ok).toBe(false);
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useGitStore.getState().mergeFocused).toBe(false);
  });
});

describe('merge session dirty tracking', () => {
  const openText = async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
  };
  const openSides = async () => {
    mockStages.mockResolvedValue(allStages({ binary: true }));
    mockHeads.mockResolvedValue(heads());
    await useGitStore.getState().openMergeResolution('logo.png', ['logo.png']);
  };

  it('opens clean, carrying the backend source version', async () => {
    mockState.mockResolvedValue(conflictState({ sourceVersion: 'v1:opened' }));
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    const session = useGitStore.getState().mergeSession;
    expect(session?.dirty).toBe(false);
    expect(session?.sourceVersion).toBe('v1:opened');
    expect(session?.reloadPending).toBe(false);
    expect(session?.closeRequested).toBe(false);
    expect(session?.external).toBeUndefined();
    expect(session?.stages.ours).toBeDefined();
  });

  it('markMergeDirty sticks and is idempotent', async () => {
    await openText();
    useGitStore.getState().markMergeDirty();
    const first = useGitStore.getState().mergeSession;
    expect(first?.dirty).toBe(true);

    useGitStore.getState().markMergeDirty();
    // A per-keystroke store write that cloned the session would churn every
    // React consumer, so an already-dirty session must keep its identity.
    expect(useGitStore.getState().mergeSession).toBe(first);
  });

  it('recording and reopening a decision both mark the session touched', async () => {
    await openText();
    useGitStore.getState().recordDecision(0, 'C');
    expect(useGitStore.getState().mergeSession?.dirty).toBe(true);

    // A fresh session, reopened decision only.
    useGitStore.getState().closeMergeResolution();
    await openText();
    expect(useGitStore.getState().mergeSession?.dirty).toBe(false);
    useGitStore.getState().reopenDecision(0);
    expect(useGitStore.getState().mergeSession?.dirty).toBe(true);
  });

  it('selecting a whole-file side marks the session touched', async () => {
    await openSides();
    expect(useGitStore.getState().mergeSession?.dirty).toBe(false);
    useGitStore.getState().selectMergeSide('ours');
    expect(useGitStore.getState().mergeSession?.dirty).toBe(true);
  });

  it('markMergeDirty is a no-op with no session', () => {
    useGitStore.getState().markMergeDirty();
    expect(useGitStore.getState().mergeSession).toBeNull();
  });
});

describe('merge close request', () => {
  const openText = async () => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
  };

  it('closes a pristine session immediately without writing', async () => {
    await openText();

    useGitStore.getState().requestMergeClose();

    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useGitStore.getState().mergeFocused).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockGuardedStage).not.toHaveBeenCalled();
  });

  it('only asks when the session has been touched', async () => {
    await openText();
    useGitStore.getState().recordDecision(0, 'C');

    useGitStore.getState().requestMergeClose();

    const session = useGitStore.getState().mergeSession;
    expect(session).not.toBeNull();
    expect(session?.closeRequested).toBe(true);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
  });

  it('cancelling the request keeps the session and every decision', async () => {
    await openText();
    useGitStore.getState().recordDecision(0, 'C');
    useGitStore.getState().requestMergeClose();

    useGitStore.getState().cancelMergeClose();

    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'text') throw new Error('expected text session');
    expect(session.closeRequested).toBe(false);
    expect(session.decisions).toEqual({ 0: 'C' });
  });

  it('confirming discards the session without writing or staging', async () => {
    await openText();
    useGitStore.getState().recordDecision(0, 'C');
    useGitStore.getState().requestMergeClose();

    useGitStore.getState().confirmMergeClose();

    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(mockGuardedApply).not.toHaveBeenCalled();
  });

  it('a repeated request on a dirty session stays one pending request', async () => {
    await openText();
    useGitStore.getState().markMergeDirty();
    useGitStore.getState().requestMergeClose();
    const first = useGitStore.getState().mergeSession;

    useGitStore.getState().requestMergeClose();

    expect(useGitStore.getState().mergeSession).toBe(first);
  });
});

describe('merge queue order at open', () => {
  const openFrom = async (path: string, queue: string[]) => {
    mockStages.mockResolvedValue(allStages());
    mockHeads.mockResolvedValue(heads());
    mockSnapshot.mockResolvedValue(snapshot());
    await useGitStore.getState().openMergeResolution(path, queue);
  };

  it('rotates the panel queue so the opened path is first', async () => {
    await openFrom('b.txt', ['a.txt', 'b.txt', 'c.txt']);

    // Starting from the middle must walk the rest of the panel order and wrap
    // once, not restart at the top.
    expect(useGitStore.getState().mergeSession?.fileQueue).toEqual(['b.txt', 'c.txt', 'a.txt']);
  });

  it('keeps an already-first queue untouched', async () => {
    await openFrom('a.txt', ['a.txt', 'b.txt']);
    expect(useGitStore.getState().mergeSession?.fileQueue).toEqual(['a.txt', 'b.txt']);
  });

  it('prepends the path when the caller omitted it', async () => {
    await openFrom('z.txt', ['a.txt']);
    expect(useGitStore.getState().mergeSession?.fileQueue).toEqual(['z.txt', 'a.txt']);
  });
});

describe('merge revalidation', () => {
  const textState = (over: Partial<git.ConflictState> = {}) => conflictState(over);

  const openTextSession = async (over: Partial<git.ConflictState> = {}) => {
    mockState.mockResolvedValue(textState(over));
    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    if (!ok) throw new Error('failed to open the text session');
  };
  const openSidesSession = async () => {
    mockState.mockResolvedValue(
      conflictState({ stages: allStages({ binary: true }), snapshot: undefined })
    );
    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    if (!ok) throw new Error('failed to open the sides session');
  };
  const notify = () => useGitStore.getState().notifyMergeFileChanged('/repo/file.txt');
  const session = () => useGitStore.getState().mergeSession;

  it('keeps the exact session object when the source version is unchanged', async () => {
    await openTextSession();
    const before = session();

    await notify();

    expect(session()).toBe(before);
  });

  it('replaces a pristine session atomically when the version moved', async () => {
    await openTextSession();
    const before = session();
    const moved = textState({
      sourceVersion: 'v1:moved',
      snapshot: snapshot({
        content: '<<<<<<< HEAD\nnew ours\n=======\nnew theirs\n>>>>>>> feature\n',
      }),
    });
    mockState.mockResolvedValue(moved);

    await notify();

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next).not.toBe(before);
    expect(next.content).toBe(moved.snapshot?.content);
    expect(next.sourceVersion).toBe('v1:moved');
    expect(next.dirty).toBe(false);
    expect(next.decisions).toEqual({});
    expect(next.external).toBeUndefined();
    expect(next.requestRevision).not.toBe(before?.requestRevision);
    expect(next.fileQueue).toEqual(['file.txt']);
  });

  it('never swaps a session that became dirty while the read was in flight', async () => {
    await openTextSession();
    const gate = deferred<git.ConflictState>();
    mockState.mockReturnValue(gate.promise);

    const pending = notify();
    // The user resolves a region while the revalidation awaits git.
    useGitStore.getState().recordDecision(0, 'C');
    gate.resolve(
      textState({ sourceVersion: 'v1:moved', snapshot: snapshot({ content: 'other\n' }) })
    );
    await pending;

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.decisions).toEqual({ 0: 'C' });
    expect(next.content).toBe(snapshot().content);
    expect(next.external).toEqual({
      kind: 'changed',
      hidden: false,
      scope: 'worktree',
      observedVersion: 'v1:moved',
    });
  });

  it('lets only the newest overlapping read install', async () => {
    await openTextSession();
    const first = deferred<git.ConflictState>();
    const second = deferred<git.ConflictState>();
    mockState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstRun = notify();
    const secondRun = notify();
    // The newer read answers first and installs; the older one is obsolete.
    second.resolve(
      textState({ sourceVersion: 'v1:newest', snapshot: snapshot({ content: 'newest\n' }) })
    );
    await secondRun;
    first.resolve(
      textState({ sourceVersion: 'v1:oldest', snapshot: snapshot({ content: 'oldest\n' }) })
    );
    await firstRun;

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.sourceVersion).toBe('v1:newest');
    expect(next.content).toBe('newest\n');
  });

  it('drops a superseded read even when the newer one installed nothing', async () => {
    await openTextSession();
    const stale = deferred<git.ConflictState>();
    mockState.mockReturnValueOnce(stale.promise);

    const staleRun = notify();
    // The newer read finds the version unchanged, so it installs nothing and
    // never claims a new request revision. Request-revision and epoch checks
    // therefore cannot tell the older read it is obsolete — only the
    // revalidation generation can.
    mockState.mockResolvedValue(textState());
    await notify();

    stale.resolve(
      textState({ sourceVersion: 'v1:stale', snapshot: snapshot({ content: 'stale content\n' }) })
    );
    await staleRun;

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.sourceVersion).toBe('v1:initial');
    expect(next.content).toBe(snapshot().content);
  });

  it('cannot apply a read that belonged to a since-closed session', async () => {
    await openTextSession();
    const gate = deferred<git.ConflictState>();
    mockState.mockReturnValue(gate.promise);

    const pending = notify();
    useGitStore.getState().closeMergeResolution();
    gate.resolve(textState({ sourceVersion: 'v1:moved' }));
    await pending;

    expect(session()).toBeNull();
  });

  it('cannot apply a read for one file to the session that replaced it', async () => {
    await openTextSession();
    const gate = deferred<git.ConflictState>();
    mockState.mockReturnValue(gate.promise);
    const pending = notify();

    // The queue advanced to another file before the read came back.
    useGitStore.getState().closeMergeResolution();
    mockState.mockResolvedValue(conflictState({ sourceVersion: 'v1:next' }));
    await useGitStore.getState().openMergeResolution('other.txt', ['other.txt']);
    gate.resolve(
      textState({ sourceVersion: 'v1:stale', snapshot: snapshot({ content: 'stale\n' }) })
    );
    await pending;

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.path).toBe('other.txt');
    expect(next.sourceVersion).toBe('v1:next');
    expect(next.content).toBe(snapshot().content);
  });

  it('reports resolved-outside when the path is no longer conflicted', async () => {
    await openTextSession();
    mockState.mockResolvedValue(
      conflictState({
        stages: allStages({ base: undefined, ours: undefined, theirs: undefined }),
        snapshot: undefined,
        heads: undefined,
        sourceVersion: 'v1:resolved',
      })
    );

    await notify();

    expect(session()?.external?.kind).toBe('resolved-outside');
  });

  it('reports resolved-outside when a still-conflicted file lost its markers', async () => {
    await openTextSession();
    mockState.mockResolvedValue(
      textState({
        sourceVersion: 'v1:handresolved',
        snapshot: snapshot({ regions: [], content: 'done\n' }),
      })
    );

    await notify();

    expect(session()?.external?.kind).toBe('resolved-outside');
    // The user's work is untouched: this is a notice, not a swap.
    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.content).toBe(snapshot().content);
  });

  it('reports check-failed when the read fails, keeping content and decisions', async () => {
    await openTextSession();
    useGitStore.getState().recordDecision(0, 'C');
    mockState.mockRejectedValue(new Error('git exploded'));

    await notify();

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.external?.kind).toBe('check-failed');
    expect(next.decisions).toEqual({ 0: 'C' });
    expect(next.content).toBe(snapshot().content);
  });

  it('a later failed read cannot downgrade resolved-outside', async () => {
    await openTextSession();
    mockState.mockResolvedValue(
      conflictState({
        stages: allStages({ base: undefined, ours: undefined, theirs: undefined }),
        snapshot: undefined,
        heads: undefined,
        sourceVersion: 'v1:resolved',
      })
    );
    await notify();
    expect(session()?.external?.kind).toBe('resolved-outside');

    mockState.mockRejectedValue(new Error('git exploded'));
    await notify();

    expect(session()?.external?.kind).toBe('resolved-outside');
  });

  it('clears a stale notice when the version matches again', async () => {
    await openTextSession();
    mockState.mockRejectedValue(new Error('transient'));
    await notify();
    expect(session()?.external?.kind).toBe('check-failed');

    mockState.mockResolvedValue(textState());
    await notify();

    expect(session()?.external).toBeUndefined();
  });

  it('classifies an index-stage change as conflict-scoped, not worktree', async () => {
    await openTextSession();
    useGitStore.getState().markMergeDirty();
    mockState.mockResolvedValue(
      textState({
        sourceVersion: 'v1:restaged',
        stages: allStages({ theirs: { hash: 'other', mode: '100644', size: 12 } as git.StageBlob }),
      })
    );

    await notify();

    // Current/Incoming no longer mean what the user reviewed, so this may not
    // be acknowledged away.
    expect(session()?.external).toMatchObject({ kind: 'changed', scope: 'conflict' });
    useGitStore.getState().acknowledgeMergeExternal();
    expect(session()?.external).toMatchObject({ scope: 'conflict', hidden: false });
  });

  it('classifies an operation-head change as conflict-scoped', async () => {
    await openTextSession();
    useGitStore.getState().markMergeDirty();
    mockState.mockResolvedValue(
      textState({
        sourceVersion: 'v1:rebased',
        heads: {
          operation: 'merge',
          ours: { label: 'main', hash: 'abc123', subject: 'ours subject' },
          theirs: { label: 'feature', hash: 'moved99', subject: 'other subject' },
        } as git.MergeHeads,
      })
    );

    await notify();

    expect(session()?.external).toMatchObject({ kind: 'changed', scope: 'conflict' });
  });

  it('lets Keep working hide a worktree-scoped notice without changing the version', async () => {
    await openTextSession();
    useGitStore.getState().markMergeDirty();
    mockState.mockResolvedValue(
      textState({ sourceVersion: 'v1:moved', snapshot: snapshot({ content: 'outside\n' }) })
    );
    await notify();

    useGitStore.getState().acknowledgeMergeExternal();

    const acknowledged = session();
    expect(acknowledged?.external).toMatchObject({
      kind: 'changed',
      hidden: true,
      scope: 'worktree',
    });
    // Acknowledgement is not overwrite consent: the mismatched version stays.
    expect(acknowledged?.sourceVersion).toBe('v1:initial');

    // A later signal that finds the SAME outside change must not re-raise the
    // notice the user already dismissed.
    await notify();
    expect(session()?.external).toMatchObject({ hidden: true });

    // A NEW outside change does raise it again.
    mockState.mockResolvedValue(
      textState({
        sourceVersion: 'v1:moved-again',
        snapshot: snapshot({ content: 'outside twice\n' }),
      })
    );
    await notify();
    expect(session()?.external).toMatchObject({ hidden: false, observedVersion: 'v1:moved-again' });
  });

  it('treats a session whose version already matches Firn own write as a no-op', async () => {
    await openTextSession();
    useGitStore.getState().recordDecision(0, 'C');
    // Stand in for Task 8's post-write baseline update: the session now holds
    // the version Firn's own write produced, so the watcher event it triggers
    // must not look like an outside change.
    const live = session();
    if (!live) throw new Error('expected a session');
    useGitStore.setState({ mergeSession: { ...live, sourceVersion: 'v1:afterwrite' } });
    mockState.mockResolvedValue(
      textState({
        sourceVersion: 'v1:afterwrite',
        snapshot: snapshot({ regions: [], content: 'resolved\n' }),
      })
    );

    await notify();

    // Marker-free and still conflicted, but this is Firn's own resolved write
    // awaiting a stage retry — not a resolution done outside Firn.
    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.external).toBeUndefined();
    expect(next.decisions).toEqual({ 0: 'C' });
  });

  it('skips revalidation while a finalize is in flight', async () => {
    await openTextSession();
    const stageAfterNotify = async () => {
      // Mid-finalize: the backend guard is the authority here, and the
      // worktree is half-written.
      await notify();
      expect(mockState).toHaveBeenCalledTimes(1); // only the open read
      return { applied: true, sourceVersion: 'v1:after-stage' } as git.ConflictGuardResult;
    };
    mockGuardedStage.mockImplementation(() => CancellablePromise.resolve(stageAfterNotify()));
    useGitStore.getState().recordDecision(0, 'C');
    await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    expect(mockGuardedStage).toHaveBeenCalled();
  });

  it('a background signal cannot supersede a Reload in flight', async () => {
    await openTextSession();
    useGitStore.getState().markMergeDirty();
    mockState.mockResolvedValue(textState({ sourceVersion: 'v1:moved' }));
    await notify();
    expect(session()?.external?.kind).toBe('changed');

    const gate = deferred<git.ConflictState>();
    mockState.mockReturnValue(gate.promise);
    const reload = useGitStore.getState().applyMergeReload();
    expect(session()?.reloadPending).toBe(true);
    const callsBefore = mockState.mock.calls.length;

    await notify();
    expect(mockState.mock.calls.length).toBe(callsBefore);

    gate.resolve(
      textState({ sourceVersion: 'v1:reloaded', snapshot: snapshot({ content: 'reloaded\n' }) })
    );
    await reload;

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.content).toBe('reloaded\n');
    expect(next.dirty).toBe(false);
    expect(next.reloadPending).toBe(false);
    expect(next.external).toBeUndefined();
  });

  it('Reload reads at click time and observes a change that landed during it', async () => {
    await openTextSession();
    useGitStore.getState().markMergeDirty();
    mockState.mockResolvedValue(textState({ sourceVersion: 'v1:first-change' }));
    await notify();

    // Two reads: the forced one installs, then one ordinary follow-up catches
    // anything that changed while the forced read was in flight.
    mockState
      .mockResolvedValueOnce(
        textState({
          sourceVersion: 'v1:second-change',
          snapshot: snapshot({ content: 'second\n' }),
        })
      )
      .mockResolvedValueOnce(
        textState({ sourceVersion: 'v1:third-change', snapshot: snapshot({ content: 'third\n' }) })
      );

    await useGitStore.getState().applyMergeReload();

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    // The follow-up ran against the freshly installed pristine session, so it
    // swapped again rather than raising a notice.
    expect(next.content).toBe('third\n');
    expect(next.sourceVersion).toBe('v1:third-change');
  });

  it('Reload reports a failed read and leaves the session usable', async () => {
    await openTextSession();
    useGitStore.getState().markMergeDirty();
    mockState.mockResolvedValue(textState({ sourceVersion: 'v1:moved' }));
    await notify();
    mockState.mockRejectedValue(new Error('read failed'));

    await useGitStore.getState().applyMergeReload();

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.reloadPending).toBe(false);
    expect(next.external?.kind).toBe('check-failed');
    expect(useIDEStore.getState().toast?.type).toBe('error');
  });

  it('a same-version Retry clears check-failed without rebuilding the session', async () => {
    await openTextSession();
    useGitStore.getState().recordDecision(0, 'C');
    mockState.mockRejectedValue(new Error('transient'));
    await notify();
    expect(session()?.external?.kind).toBe('check-failed');
    const beforeRetry = session();

    mockState.mockResolvedValue(textState());
    await useGitStore.getState().applyMergeReload();

    const next = session();
    if (next?.kind !== 'text') throw new Error('expected text session');
    expect(next.external).toBeUndefined();
    expect(next.decisions).toEqual({ 0: 'C' });
    expect(next.requestRevision).toBe(beforeRetry?.requestRevision);
  });

  it('swaps a sides session when its stage identity changed', async () => {
    await openSidesSession();
    mockState.mockResolvedValue(
      conflictState({
        stages: allStages({
          binary: true,
          theirs: { hash: 'other', mode: '100644', size: 9 } as git.StageBlob,
        }),
        snapshot: undefined,
        sourceVersion: 'v1:newblob',
      })
    );

    await notify();

    const next = session();
    if (next?.kind !== 'sides') throw new Error('expected sides session');
    expect(next.stages.theirs?.hash).toBe('other');
    expect(next.selectedSide).toBeUndefined();
    expect(next.sourceVersion).toBe('v1:newblob');
  });

  it('ignores signals for other paths and with no session', async () => {
    await openTextSession();
    const before = session();
    const callsBefore = mockState.mock.calls.length;

    await useGitStore.getState().notifyMergeFileChanged('/repo/other.txt');
    expect(mockState.mock.calls.length).toBe(callsBefore);
    expect(session()).toBe(before);

    useGitStore.getState().closeMergeResolution();
    await useGitStore.getState().notifyMergeFileChanged('/repo/file.txt');
    expect(mockState.mock.calls.length).toBe(callsBefore);
  });
});

describe('status-derived merge revalidation', () => {
  const openTextSession = async () => {
    mockState.mockResolvedValue(conflictState());
    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    if (!ok) throw new Error('failed to open the text session');
  };
  const resolvedState = () =>
    conflictState({
      stages: allStages({ base: undefined, ours: undefined, theirs: undefined }),
      snapshot: undefined,
      heads: undefined,
      sourceVersion: 'v1:resolved',
    });
  const statusWithoutConflict = () =>
    repoStatus({ files: [{ path: 'file.txt', index: 'M', worktree: ' ', unmerged: false }] });

  it('revalidates when an accepted status no longer lists the path as unmerged', async () => {
    await openTextSession();
    // `git add` in a terminal changes no watched file, so the watcher never
    // fires: the status snapshot is the only signal.
    mockGitStatus.mockResolvedValue(statusWithoutConflict());
    mockState.mockResolvedValue(resolvedState());

    await useGitStore.getState().refresh();

    expect(useGitStore.getState().mergeSession?.external?.kind).toBe('resolved-outside');
  });

  it('leaves the session untouched while the path is still unmerged', async () => {
    await openTextSession();
    const before = useGitStore.getState().mergeSession;
    const callsBefore = mockState.mock.calls.length;

    await useGitStore.getState().refresh();

    expect(mockState.mock.calls.length).toBe(callsBefore);
    expect(useGitStore.getState().mergeSession).toBe(before);
  });

  it('promotes an existing changed notice to resolved-outside', async () => {
    await openTextSession();
    useGitStore.getState().markMergeDirty();
    mockState.mockResolvedValue(conflictState({ sourceVersion: 'v1:moved' }));
    await useGitStore.getState().notifyMergeFileChanged('/repo/file.txt');
    expect(useGitStore.getState().mergeSession?.external?.kind).toBe('changed');

    mockGitStatus.mockResolvedValue(statusWithoutConflict());
    mockState.mockResolvedValue(resolvedState());
    await useGitStore.getState().refresh();

    // A stale notice must not stop the stronger signal from landing.
    expect(useGitStore.getState().mergeSession?.external?.kind).toBe('resolved-outside');
  });

  it('promotes an existing check-failed notice to resolved-outside', async () => {
    await openTextSession();
    mockState.mockRejectedValue(new Error('transient'));
    await useGitStore.getState().notifyMergeFileChanged('/repo/file.txt');
    expect(useGitStore.getState().mergeSession?.external?.kind).toBe('check-failed');

    mockGitStatus.mockResolvedValue(statusWithoutConflict());
    mockState.mockResolvedValue(resolvedState());
    await useGitStore.getState().refresh();

    expect(useGitStore.getState().mergeSession?.external?.kind).toBe('resolved-outside');
  });

  it('ignores a status snapshot for another repository root', async () => {
    await openTextSession();
    const before = useGitStore.getState().mergeSession;
    const callsBefore = mockState.mock.calls.length;
    mockGitStatus.mockResolvedValue(repoStatus({ repoRoot: '/elsewhere', files: [] }));

    await useGitStore.getState().refresh();

    expect(mockState.mock.calls.length).toBe(callsBefore);
    expect(useGitStore.getState().mergeSession).toBe(before);
  });

  it('cannot act on a refresh that predates the current session', async () => {
    await openTextSession();
    const gate = deferred<git.RepoStatus>();
    mockGitStatus.mockReturnValue(gate.promise);
    const pending = useGitStore.getState().refresh();

    // The session the refresh started for is gone by the time it resolves.
    useGitStore.getState().closeMergeResolution();
    mockState.mockResolvedValue(conflictState({ sourceVersion: 'v1:next' }));
    await useGitStore.getState().openMergeResolution('other.txt', ['other.txt']);
    const replacement = useGitStore.getState().mergeSession;
    gate.resolve(statusWithoutConflict());
    await pending;

    expect(useGitStore.getState().mergeSession).toBe(replacement);
    expect(useGitStore.getState().mergeSession?.external).toBeUndefined();
  });
});

describe('guarded finalize', () => {
  const openText = async () => {
    mockState.mockResolvedValue(conflictState());
    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    if (!ok) throw new Error('failed to open the text session');
    useGitStore.getState().recordDecision(0, 'C');
  };
  const openSides = async () => {
    mockState.mockResolvedValue(
      conflictState({ stages: allStages({ binary: true }), snapshot: undefined })
    );
    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    if (!ok) throw new Error('failed to open the sides session');
  };
  const session = () => useGitStore.getState().mergeSession;

  it('writes and stages against the version the session was built from', async () => {
    await openText();

    const ok = await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    expect(ok).toBe(true);
    expect(mockGuardedWrite).toHaveBeenCalledWith(
      '/repo',
      'file.txt',
      'v1:initial',
      'resolved\n',
      'utf-8',
      'lf'
    );
    // The stage presents the version the write produced, not the opening one.
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-write');
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockGitStage).not.toHaveBeenCalled();
  });

  it('keeps a refused text write retryable without mutating', async () => {
    await openText();
    mockGuardedWrite.mockResolvedValue({
      applied: false,
      sourceVersion: 'v1:elsewhere',
    } as git.ConflictGuardResult);
    mockState.mockResolvedValue(conflictState({ sourceVersion: 'v1:elsewhere' }));

    const ok = await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    expect(ok).toBe(false);
    expect(mockGuardedStage).not.toHaveBeenCalled();
    const live = session();
    if (live?.kind !== 'text') throw new Error('expected the session to survive');
    // Decisions survive, and the surface now explains what moved.
    expect(live.decisions).toEqual({ 0: 'C' });
    expect(live.external).toMatchObject({ kind: 'changed', scope: 'worktree' });

    mockGuardedWrite.mockResolvedValue(writeApplied());
    const retry = await useGitStore.getState().mergeOverwriteAndStage('resolved\n');

    expect(retry).toBe(true);
    expect(mockGuardedWrite).toHaveBeenCalledTimes(2);
    expect(mockGuardedStage).toHaveBeenCalledTimes(1);
  });

  it('updates the session baseline from the write so a failed stage can retry', async () => {
    await openText();
    mockGuardedStage.mockRejectedValue(new Error('index.lock held'));

    const ok = await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    expect(ok).toBe(false);
    const live = session();
    if (live?.kind !== 'text') throw new Error('expected the session to survive');
    expect(live.content).toBe('resolved\n');
    expect(live.sourceVersion).toBe('v1:after-write');
    expect(live.external).toBeUndefined();

    // The retry needs no new read: the baseline already matches the worktree.
    mockGuardedStage.mockResolvedValue({
      applied: true,
      sourceVersion: 'v1:after-stage',
    } as git.ConflictGuardResult);
    const retry = await useGitStore.getState().mergeFinalizeAndStage('resolved\n');
    expect(retry).toBe(true);
    expect(mockGuardedWrite).toHaveBeenCalledTimes(2);
    expect(mockGuardedStage).toHaveBeenLastCalledWith('/repo', 'file.txt', 'v1:after-write');
  });

  it('a watcher event between write and failed stage leaves the session retryable', async () => {
    await openText();
    mockGuardedStage.mockRejectedValue(new Error('index.lock held'));
    await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    // The write's own watcher event arrives: the version matches the rebased
    // baseline, so it is a no-op — not "resolved outside Firn".
    mockState.mockResolvedValue(
      conflictState({
        sourceVersion: 'v1:after-write',
        snapshot: snapshot({ regions: [], content: 'resolved\n' }),
      })
    );
    await useGitStore.getState().notifyMergeFileChanged('/repo/file.txt');

    expect(session()?.external).toBeUndefined();
  });

  it('applies a side to the worktree and stages it as two guarded steps', async () => {
    await openSides();
    useGitStore.getState().selectMergeSide('theirs');

    const ok = await useGitStore.getState().mergeFinalizeAndStage();

    expect(ok).toBe(true);
    expect(mockGuardedApply).toHaveBeenCalledWith('/repo', 'file.txt', 'theirs', 'v1:initial');
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-apply');
    expect(mockResolveSide).not.toHaveBeenCalled();
  });

  it('retries only the stage after an applied side failed to stage', async () => {
    await openSides();
    useGitStore.getState().selectMergeSide('ours');
    mockGuardedStage.mockRejectedValue(new Error('index.lock held'));
    await useGitStore.getState().mergeFinalizeAndStage();

    const live = session();
    if (live?.kind !== 'sides') throw new Error('expected the session to survive');
    expect(live.appliedSide).toEqual({ side: 'ours', sourceVersion: 'v1:after-apply' });

    mockGuardedStage.mockResolvedValue({
      applied: true,
      sourceVersion: 'v1:after-stage',
    } as git.ConflictGuardResult);
    const retry = await useGitStore.getState().mergeFinalizeAndStage();

    expect(retry).toBe(true);
    // Re-applying would overwrite whatever the user changed in between.
    expect(mockGuardedApply).toHaveBeenCalledTimes(1);
    expect(mockGuardedStage).toHaveBeenLastCalledWith('/repo', 'file.txt', 'v1:after-apply');
  });

  it('re-applies when the side changed after an apply', async () => {
    await openSides();
    useGitStore.getState().selectMergeSide('ours');
    mockGuardedStage.mockRejectedValue(new Error('index.lock held'));
    await useGitStore.getState().mergeFinalizeAndStage();

    useGitStore.getState().selectMergeSide('theirs');
    const afterSideChange = session();
    if (afterSideChange?.kind !== 'sides') throw new Error('expected sides session');
    expect(afterSideChange.appliedSide).toBeUndefined();
    mockGuardedStage.mockResolvedValue({
      applied: true,
      sourceVersion: 'v1:after-stage',
    } as git.ConflictGuardResult);
    await useGitStore.getState().mergeFinalizeAndStage();

    expect(mockGuardedApply).toHaveBeenCalledTimes(2);
    expect(mockGuardedApply).toHaveBeenLastCalledWith(
      '/repo',
      'file.txt',
      'theirs',
      'v1:after-apply'
    );
  });

  it('keeps a refused side apply retryable without touching the worktree', async () => {
    await openSides();
    useGitStore.getState().selectMergeSide('ours');
    mockGuardedApply.mockResolvedValue({
      applied: false,
      sourceVersion: 'v1:elsewhere',
    } as git.ConflictGuardResult);
    mockState.mockResolvedValue(
      conflictState({
        stages: allStages({ binary: true }),
        snapshot: undefined,
        sourceVersion: 'v1:elsewhere',
      })
    );

    const ok = await useGitStore.getState().mergeFinalizeAndStage();

    expect(ok).toBe(false);
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(session()?.external?.kind).toBe('changed');

    mockGuardedApply.mockResolvedValue({
      applied: true,
      sourceVersion: 'v1:after-apply',
    } as git.ConflictGuardResult);
    const retry = await useGitStore.getState().mergeOverwriteAndStage();

    expect(retry).toBe(true);
    expect(mockGuardedApply).toHaveBeenCalledTimes(2);
    expect(mockGuardedStage).toHaveBeenCalledTimes(1);
  });

  it('does not stage the old repository after a workspace switch during side apply', async () => {
    await openSides();
    useGitStore.getState().selectMergeSide('ours');
    const gate = deferred<git.ConflictGuardResult>();
    mockGuardedApply.mockReturnValue(gate.promise);

    const call = useGitStore.getState().mergeFinalizeAndStage();
    for (let i = 0; i < 10 && mockGuardedApply.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(mockGuardedApply).toHaveBeenCalled();
    useGitStore.getState().resetForWorkspace('/other');
    gate.resolve({
      applied: true,
      sourceVersion: 'v1:after-apply',
    } as git.ConflictGuardResult);

    expect(await call).toBe(false);
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(useIDEStore.getState().toast?.message).toMatch(/applied but not staged/i);
  });

  it('refuses to finalize while any external state is unresolved', async () => {
    await openText();
    mockState.mockResolvedValue(conflictState({ sourceVersion: 'v1:moved' }));
    await useGitStore.getState().notifyMergeFileChanged('/repo/file.txt');
    expect(session()?.external?.kind).toBe('changed');

    const ok = await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    expect(ok).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
  });
});

describe('explicit overwrite consent', () => {
  const openDirtyWithWorktreeChange = async () => {
    mockState.mockResolvedValue(conflictState());
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    useGitStore.getState().recordDecision(0, 'C');
    mockState.mockResolvedValue(
      conflictState({ sourceVersion: 'v1:outside', snapshot: snapshot({ content: 'outside\n' }) })
    );
    await useGitStore.getState().notifyMergeFileChanged('/repo/file.txt');
    if (useGitStore.getState().mergeSession?.external?.kind !== 'changed') {
      throw new Error('expected a changed notice');
    }
  };

  it('reads at confirmation time and writes against that version', async () => {
    await openDirtyWithWorktreeChange();
    mockState.mockResolvedValue(
      conflictState({
        sourceVersion: 'v1:confirm-time',
        snapshot: snapshot({ content: 'newer\n' }),
      })
    );

    const ok = await useGitStore.getState().mergeOverwriteAndStage('resolved\n');

    expect(ok).toBe(true);
    // Not the version the notice was raised with: the file may have moved again
    // while the dialog was on screen.
    expect(mockGuardedWrite).toHaveBeenCalledWith(
      '/repo',
      'file.txt',
      'v1:confirm-time',
      'resolved\n',
      'utf-8',
      'lf'
    );
  });

  it('is still refused when the file moves between the read and the write', async () => {
    await openDirtyWithWorktreeChange();
    mockState.mockResolvedValue(conflictState({ sourceVersion: 'v1:confirm-time' }));
    mockGuardedWrite.mockResolvedValue({
      applied: false,
      sourceVersion: 'v1:moved-again',
    } as git.ConflictGuardResult);

    const ok = await useGitStore.getState().mergeOverwriteAndStage('resolved\n');

    expect(ok).toBe(false);
    expect(mockGuardedStage).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession).not.toBeNull();
  });

  it('refuses when the conflict identity changed instead of just the worktree', async () => {
    await openDirtyWithWorktreeChange();
    mockState.mockResolvedValue(
      conflictState({
        sourceVersion: 'v1:restaged',
        stages: allStages({ theirs: { hash: 'other', mode: '100644', size: 3 } as git.StageBlob }),
      })
    );

    const ok = await useGitStore.getState().mergeOverwriteAndStage('resolved\n');

    expect(ok).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession?.external).toMatchObject({ scope: 'conflict' });
  });

  it('refuses marker-free text as resolved outside Firn rather than overwriting', async () => {
    await openDirtyWithWorktreeChange();
    mockState.mockResolvedValue(
      conflictState({
        sourceVersion: 'v1:handresolved',
        snapshot: snapshot({ regions: [], content: 'done\n' }),
      })
    );

    const ok = await useGitStore.getState().mergeOverwriteAndStage('resolved\n');

    expect(ok).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeSession?.external?.kind).toBe('resolved-outside');
  });

  it('does not install the fresh candidate or drop decisions', async () => {
    await openDirtyWithWorktreeChange();
    mockState.mockResolvedValue(
      conflictState({
        sourceVersion: 'v1:confirm-time',
        snapshot: snapshot({ content: 'newer\n' }),
      })
    );
    mockGuardedWrite.mockResolvedValue({
      applied: false,
      sourceVersion: 'v1:confirm-time',
    } as git.ConflictGuardResult);

    await useGitStore.getState().mergeOverwriteAndStage('resolved\n');

    const live = useGitStore.getState().mergeSession;
    if (live?.kind !== 'text') throw new Error('expected the session to survive');
    expect(live.content).toBe(snapshot().content);
    expect(live.decisions).toEqual({ 0: 'C' });
  });

  it('is refused for a conflict-scoped notice', async () => {
    mockState.mockResolvedValue(conflictState());
    await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    useGitStore.getState().recordDecision(0, 'C');
    mockState.mockResolvedValue(
      conflictState({
        sourceVersion: 'v1:restaged',
        stages: allStages({ ours: { hash: 'moved', mode: '100644', size: 4 } as git.StageBlob }),
      })
    );
    await useGitStore.getState().notifyMergeFileChanged('/repo/file.txt');

    const ok = await useGitStore.getState().mergeOverwriteAndStage('resolved\n');

    expect(ok).toBe(false);
    expect(mockGuardedWrite).not.toHaveBeenCalled();
  });
});

describe('queue advance', () => {
  const openQueue = async (path: string, queue: string[]) => {
    mockState.mockResolvedValue(conflictState());
    const ok = await useGitStore.getState().openMergeResolution(path, queue);
    if (!ok) throw new Error('failed to open');
    useGitStore.getState().recordDecision(0, 'C');
  };

  it('advances to the next queued file after a successful finalize', async () => {
    await openQueue('file.txt', ['file.txt', 'other.txt']);

    const ok = await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    expect(ok).toBe(true);
    const next = useGitStore.getState().mergeSession;
    expect(next?.path).toBe('other.txt');
    expect(next?.fileQueue).toEqual(['other.txt']);
    expect(useGitStore.getState().mergeAdvancePending).toBe(false);
  });

  it('reports completion and closes when the queue is exhausted', async () => {
    await openQueue('file.txt', ['file.txt']);

    await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toBe('Conflict queue resolved');
    expect(useGitStore.getState().mergeAdvancePending).toBe(false);
  });

  it('does not cascade past a queued path that is no longer conflicted', async () => {
    await openQueue('file.txt', ['file.txt', 'stale.txt', 'valid.txt']);
    mockState.mockResolvedValue(
      conflictState({
        stages: allStages({ base: undefined, ours: undefined, theirs: undefined }),
        snapshot: undefined,
        heads: undefined,
      })
    );

    await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    // The stale entry closes the surface with its own explanation; the user
    // picks the next file from the refreshed panel.
    expect(useGitStore.getState().mergeSession).toBeNull();
    expect(useIDEStore.getState().toast?.message).toContain('stale.txt is not conflicted');
    expect(useGitStore.getState().mergeAdvancePending).toBe(false);
  });

  it('announces each hand-off with the remaining count', async () => {
    await openQueue('file.txt', ['file.txt', 'other.txt', 'third.txt']);

    await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    expect(useGitStore.getState().mergeQueueAnnouncement).toBe(
      'Now resolving other.txt. 2 conflicted files remaining.'
    );
  });

  it('uses the singular when one file is left', async () => {
    await openQueue('file.txt', ['file.txt', 'other.txt']);

    await useGitStore.getState().mergeFinalizeAndStage('resolved\n');

    expect(useGitStore.getState().mergeQueueAnnouncement).toBe(
      'Now resolving other.txt. 1 conflicted file remaining.'
    );
  });

  it('clears the announcement when the surface closes', async () => {
    await openQueue('file.txt', ['file.txt', 'other.txt']);
    await useGitStore.getState().mergeFinalizeAndStage('resolved\n');
    expect(useGitStore.getState().mergeQueueAnnouncement).not.toBe('');

    useGitStore.getState().closeMergeResolution();

    expect(useGitStore.getState().mergeQueueAnnouncement).toBe('');
  });

  it('marks the advance pending across the gap between sessions', async () => {
    await openQueue('file.txt', ['file.txt', 'other.txt']);
    const gate = deferred<git.ConflictState>();
    let pendingDuringGap: boolean | undefined;
    mockState.mockImplementation(() => {
      pendingDuringGap = useGitStore.getState().mergeAdvancePending;
      return gate.promise;
    });

    const finalize = useGitStore.getState().mergeFinalizeAndStage('resolved\n');
    gate.resolve(conflictState());
    await finalize;

    // The gap is explicit so the editor shell does not treat it as a close.
    expect(pendingDuringGap).toBe(true);
    expect(useGitStore.getState().mergeAdvancePending).toBe(false);
  });

  it('clears the advance flag when the workspace resets mid-advance', async () => {
    await openQueue('file.txt', ['file.txt', 'other.txt']);
    const gate = deferred<git.ConflictState>();
    mockState.mockReturnValue(gate.promise);

    const finalize = useGitStore.getState().mergeFinalizeAndStage('resolved\n');
    useGitStore.getState().resetForWorkspace('/elsewhere');
    gate.resolve(conflictState());
    await finalize;

    expect(useGitStore.getState().mergeAdvancePending).toBe(false);
    expect(useGitStore.getState().mergeSession).toBeNull();
  });
});

describe('delete/modify symmetry at the session boundary', () => {
  const openSides = async (over: Partial<git.ConflictStages>) => {
    mockState.mockResolvedValue(conflictState({ stages: allStages(over), snapshot: undefined }));
    const ok = await useGitStore.getState().openMergeResolution('file.txt', ['file.txt']);
    if (!ok) throw new Error('failed to open');
  };

  it('opens a sides session when ours is absent and stages the surviving side', async () => {
    await openSides({ ours: undefined });
    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'sides') throw new Error('expected sides session');
    expect(session.stages.ours).toBeUndefined();
    expect(session.stages.theirs).toBeDefined();

    useGitStore.getState().selectMergeSide('theirs');
    await useGitStore.getState().mergeFinalizeAndStage();

    expect(mockGuardedApply).toHaveBeenCalledWith('/repo', 'file.txt', 'theirs', 'v1:initial');
  });

  it('opens a sides session when theirs is absent and can resolve to that deletion', async () => {
    await openSides({ theirs: undefined });
    const session = useGitStore.getState().mergeSession;
    if (session?.kind !== 'sides') throw new Error('expected sides session');
    expect(session.stages.theirs).toBeUndefined();
    expect(session.stages.ours).toBeDefined();

    // Choosing the absent side IS choosing the deletion; the backend turns that
    // into a worktree removal plus a staged deletion.
    useGitStore.getState().selectMergeSide('theirs');
    await useGitStore.getState().mergeFinalizeAndStage();

    expect(mockGuardedApply).toHaveBeenCalledWith('/repo', 'file.txt', 'theirs', 'v1:initial');
    expect(mockGuardedStage).toHaveBeenCalledWith('/repo', 'file.txt', 'v1:after-apply');
  });
});
