import { ensureEditorFileOpen, navigateToEditorLocation } from '../../utils/editorNavigation';
import { useIDEStore } from '../../stores/ideStore';
import { useGitStore } from '../../stores/gitStore';
import { toNativeLocalPath } from '../../utils/lspUri';
import { ReadFile, WriteFile } from '../../wails/bindings';
import { CancellablePromise } from '../../wails/runtime';
import { queueWorkingTreeEdit } from '../../utils/fileWrites';

jest.mock('../../wails/bindings', () => ({
  ReadFile: jest.fn(),
  WriteFile: jest.fn(),
}));

const mockReadFile = ReadFile as jest.MockedFunction<typeof ReadFile>;
const mockWriteFile = WriteFile as jest.MockedFunction<typeof WriteFile>;

function createReadFileResult(content: string) {
  return {
    content,
    encoding: 'utf-8',
    lineEndings: 'LF',
    size: content.length,
    isBinary: false,
  };
}

beforeEach(() => {
  useIDEStore.setState(useIDEStore.getInitialState());
  useGitStore.setState({ mergeSession: null, mergeFocused: false, diffFocused: false });
  jest.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
});

describe('ensureEditorFileOpen', () => {
  it('returns existing file and activates it when already open', async () => {
    useIDEStore.getState().openFile({
      id: '/test/file.ts',
      name: 'file.ts',
      path: '/test/file.ts',
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });

    const file = await ensureEditorFileOpen('/test/file.ts');
    expect(file).not.toBeNull();
    expect(file!.id).toBe('/test/file.ts');
    expect(useIDEStore.getState().activeFileId).toBe('/test/file.ts');
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('yields an active merge to an already-open file without reading it again', async () => {
    useIDEStore.getState().openFile({
      id: '/test/file.ts',
      name: 'file.ts',
      path: '/test/file.ts',
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });
    useGitStore.setState({ mergeSession: { path: 'clash.go' } as never, mergeFocused: true });

    await ensureEditorFileOpen('/test/file.ts');

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(useGitStore.getState().mergeFocused).toBe(false);
  });

  it('reads and opens a new file', async () => {
    mockReadFile.mockResolvedValue(createReadFileResult('hello world') as never);

    const file = await ensureEditorFileOpen('/test/new.ts');
    expect(file).not.toBeNull();
    expect(file!.name).toBe('new.ts');
    expect(file!.language).toBe('TypeScript');
    expect(useIDEStore.getState().openFiles).toHaveLength(1);
  });

  it('yields an active merge after opening a new file', async () => {
    mockReadFile.mockResolvedValue(createReadFileResult('hello world') as never);
    useGitStore.setState({ mergeSession: { path: 'clash.go' } as never, mergeFocused: true });

    await ensureEditorFileOpen('/test/new.ts');

    expect(useGitStore.getState().mergeFocused).toBe(false);
  });

  it('flushes a pending diff edit before reading the file into an editor buffer', async () => {
    queueWorkingTreeEdit({
      absPath: '/test/pending.ts',
      displayPath: 'pending.ts',
      content: 'latest diff text',
      encoding: 'utf-8',
      lineEndings: 'lf',
    });
    mockReadFile.mockResolvedValue(createReadFileResult('latest diff text') as never);

    await ensureEditorFileOpen('/test/pending.ts');

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/test/pending.ts',
      'latest diff text',
      'utf-8',
      'lf',
      false
    );
    expect(mockWriteFile.mock.invocationCallOrder[0]).toBeLessThan(
      mockReadFile.mock.invocationCallOrder[0]
    );
  });

  it('reuses an already-open file when the requested path is slash-normalized', async () => {
    // Open a file under its backslash form
    const storedId = 'C:\\Users\\dev\\project\\file.ts';
    useIDEStore.getState().openFile({
      id: storedId,
      name: 'file.ts',
      path: storedId,
      language: 'TypeScript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: true,
    });

    // Request with forward-slash lowercase form — should find the existing file
    const file = await ensureEditorFileOpen('c:/Users/dev/project/file.ts');

    expect(file).not.toBeNull();
    expect(file!.id).toBe(storedId);
    expect(useIDEStore.getState().activeFileId).toBe(storedId);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('stores new files using the native path form', async () => {
    mockReadFile.mockResolvedValue(createReadFileResult('const x = 1;') as never);

    const inputPath = 'c:/Users/dev/project/file.ts';
    const file = await ensureEditorFileOpen(inputPath);

    // toNativeLocalPath determines the expected form for this platform
    const expectedPath = toNativeLocalPath(inputPath);
    expect(mockReadFile).toHaveBeenCalledWith(expectedPath);
    expect(file).not.toBeNull();
    expect(file!.id).toBe(expectedPath);
    expect(file!.name).toBe('file.ts');
    expect(file!.language).toBe('TypeScript');
  });

  it('shows toast and returns null for binary files', async () => {
    mockReadFile.mockResolvedValue({
      content: '',
      encoding: '',
      lineEndings: '',
      isBinary: true,
    } as never);
    useGitStore.setState({ mergeSession: { path: 'clash.go' } as never, mergeFocused: true });

    const file = await ensureEditorFileOpen('/test/image.png');
    expect(file).toBeNull();
    expect(useIDEStore.getState().toast?.type).toBe('error');
    expect(useGitStore.getState().mergeFocused).toBe(true);
  });

  it('shows toast and returns null when read fails', async () => {
    mockReadFile.mockRejectedValue(new Error('File not found'));
    useGitStore.setState({ mergeSession: { path: 'clash.go' } as never, mergeFocused: true });

    const file = await ensureEditorFileOpen('/test/missing.ts');
    expect(file).toBeNull();
    expect(useIDEStore.getState().toast?.message).toContain('File not found');
    expect(useGitStore.getState().mergeFocused).toBe(true);
  });

  it('does not yield merge focus when navigation becomes stale while reading', async () => {
    let resolveRead!: (value: ReturnType<typeof createReadFileResult>) => void;
    mockReadFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }) as never
    );
    useGitStore.setState({ mergeSession: { path: 'clash.go' } as never, mergeFocused: true });
    let applies = true;

    const navigation = ensureEditorFileOpen('/test/stale.ts', { shouldApply: () => applies });
    await Promise.resolve();
    applies = false;
    resolveRead(createReadFileResult('stale'));

    expect(await navigation).toBeNull();
    expect(useGitStore.getState().mergeFocused).toBe(true);
  });
});

describe('navigateToEditorLocation', () => {
  it('opens file and requests navigation', async () => {
    mockReadFile.mockResolvedValue(createReadFileResult('line1\nline2\nline3') as never);

    await navigateToEditorLocation('/test/file.ts', 2, 5);

    expect(useIDEStore.getState().openFiles).toHaveLength(1);
    const nav = useIDEStore.getState().pendingEditorNavigation;
    expect(nav).not.toBeNull();
    expect(nav!.fileId).toBe('/test/file.ts');
    expect(nav!.line).toBe(2);
    expect(nav!.column).toBe(5);
  });

  it('does not request navigation when file open fails', async () => {
    mockReadFile.mockRejectedValue(new Error('Not found'));

    await navigateToEditorLocation('/test/missing.ts', 1, 1);

    expect(useIDEStore.getState().pendingEditorNavigation).toBeNull();
  });

  it('does not open or navigate when shouldApply turns false while reading', async () => {
    useIDEStore.setState({ workspace: { name: 'Workspace A', path: '/workspace-a' } });
    let resolveRead!: (value: ReturnType<typeof createReadFileResult>) => void;
    mockReadFile.mockImplementation(
      () =>
        new CancellablePromise((resolve) => {
          resolveRead = resolve;
        })
    );

    const navigation = navigateToEditorLocation('/workspace-a/file.ts', 2, 5, {
      shouldApply: () => useIDEStore.getState().workspace?.path === '/workspace-a',
    });
    await Promise.resolve(); // allow the shared pre-open flush to settle

    useIDEStore.setState({ workspace: { name: 'Workspace B', path: '/workspace-b' } });
    resolveRead(createReadFileResult('line1\nline2'));
    await navigation;

    expect(useIDEStore.getState().openFiles).toHaveLength(0);
    expect(useIDEStore.getState().pendingEditorNavigation).toBeNull();
  });

  it('increments revision for repeated navigation to same location', async () => {
    useIDEStore.getState().openFile({
      id: '/test/file.ts',
      name: 'file.ts',
      path: '/test/file.ts',
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });

    await navigateToEditorLocation('/test/file.ts', 1, 1);
    const rev1 = useIDEStore.getState().pendingEditorNavigation!.revision;

    await navigateToEditorLocation('/test/file.ts', 1, 1);
    const rev2 = useIDEStore.getState().pendingEditorNavigation!.revision;

    expect(rev2).toBeGreaterThan(rev1);
  });

  // The navigation is registered up front (before the tab is activated) so the
  // editor can suppress the cached-scroll restore. If the activation then does
  // not happen, that pre-registration must be retracted — otherwise it lingers
  // and hijacks the viewport the next time the tab is activated for an unrelated
  // reason, and in the workspace-switch case it points into the old workspace.
  it('retracts the pre-registered navigation when the workspace changes mid-flight', async () => {
    useIDEStore.setState({ workspace: { name: 'Workspace A', path: '/workspace-a' } });
    useIDEStore.getState().openFile({
      id: '/workspace-a/file.ts',
      name: 'file.ts',
      path: '/workspace-a/file.ts',
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });

    const navigation = navigateToEditorLocation('/workspace-a/file.ts', 5, 3, {
      shouldApply: () => useIDEStore.getState().workspace?.path === '/workspace-a',
    });

    // Registered synchronously, before the activation is awaited.
    expect(useIDEStore.getState().pendingEditorNavigation?.fileId).toBe('/workspace-a/file.ts');

    // The user switches workspaces while the pre-open flush is in flight.
    useIDEStore.setState({ workspace: { name: 'Workspace B', path: '/workspace-b' } });
    await navigation;

    expect(useIDEStore.getState().pendingEditorNavigation).toBeNull();
  });

  it('preserves a newer same-file navigation when retracting a stale pre-registration', async () => {
    useIDEStore.setState({ workspace: { name: 'Workspace A', path: '/workspace-a' } });
    useIDEStore.getState().openFile({
      id: '/workspace-a/file.ts',
      name: 'file.ts',
      path: '/workspace-a/file.ts',
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });

    const staleNavigation = navigateToEditorLocation('/workspace-a/file.ts', 5, 3, {
      shouldApply: () => useIDEStore.getState().workspace?.path === '/workspace-a',
    });
    const preRegistered = useIDEStore.getState().pendingEditorNavigation!;

    // Model CodeMirror consuming the first request, then a newer navigation
    // arriving before the stale operation finishes its awaited activation.
    useIDEStore
      .getState()
      .clearPendingEditorNavigation(preRegistered.fileId, preRegistered.revision);
    useIDEStore.getState().requestEditorNavigation('/workspace-a/file.ts', 9, 7);
    const newerNavigation = useIDEStore.getState().pendingEditorNavigation!;

    // Clearing the request resets the store's local revision sequence, so the
    // new object can reuse the exact same file/revision identity.
    expect(newerNavigation).not.toBe(preRegistered);
    expect(newerNavigation.revision).toBe(preRegistered.revision);

    useIDEStore.setState({ workspace: { name: 'Workspace B', path: '/workspace-b' } });
    await staleNavigation;

    expect(useIDEStore.getState().pendingEditorNavigation).toBe(newerNavigation);
  });

  it('registers the navigation before activating an already-open tab (background-tab scroll fix)', async () => {
    useIDEStore.getState().openFile({
      id: '/test/file.ts',
      name: 'file.ts',
      path: '/test/file.ts',
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });

    // The editor's file-switch effect restores a background tab's cached scroll
    // on activation and only skips it when a navigation is already pending. So
    // the navigation MUST be registered before the tab is activated — capture
    // what was pending at the moment setActiveFile ran.
    let pendingFileAtActivation: string | null | undefined = 'not-called';
    const original = useIDEStore.getState().setActiveFile;
    const spy = jest
      .spyOn(useIDEStore.getState(), 'setActiveFile')
      .mockImplementation((id: string | null) => {
        pendingFileAtActivation = useIDEStore.getState().pendingEditorNavigation?.fileId ?? null;
        return original(id);
      });

    await navigateToEditorLocation('/test/file.ts', 5, 3);

    expect(pendingFileAtActivation).toBe('/test/file.ts');
    expect(useIDEStore.getState().pendingEditorNavigation).toMatchObject({
      fileId: '/test/file.ts',
      line: 5,
      column: 3,
    });

    spy.mockRestore();
  });
});

describe('center reveal on navigation (#271 §6.3)', () => {
  const openTestFile = (path: string) =>
    useIDEStore.getState().openFile({
      id: path,
      name: path.split('/').pop()!,
      path,
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });

  it('reveals Files when the SAME already-open file is selected again', async () => {
    openTestFile('/test/file.ts');
    await ensureEditorFileOpen('/test/file.ts');
    useIDEStore.getState().setFilesPanelCollapsed(true);

    // Same id, same active file: nothing about the editor state changes, so
    // only the intent itself can carry the reveal.
    await ensureEditorFileOpen('/test/file.ts');

    expect(useIDEStore.getState()).toMatchObject({
      isFilesPanelCollapsed: false,
      centerReveal: 'files',
    });
  });

  it('retargets a transient Golem reveal when navigating inside the same file', async () => {
    openTestFile('/test/file.ts');
    useIDEStore.getState().revealCenterPanel('golem');

    await navigateToEditorLocation('/test/file.ts', 12, 1);

    expect(useIDEStore.getState()).toMatchObject({
      centerReveal: 'files',
      // No persisted toggle: both saved preferences stay open.
      isGolemPanelCollapsed: false,
      isFilesPanelCollapsed: false,
    });
  });

  it('reveals Files for a newly opened file', async () => {
    mockReadFile.mockResolvedValue(createReadFileResult('hello') as never);
    useIDEStore.getState().setFilesPanelCollapsed(true);

    await ensureEditorFileOpen('/test/new.ts');

    expect(useIDEStore.getState().isFilesPanelCollapsed).toBe(false);
  });

  it('does not reveal for a stale navigation or a failed read', async () => {
    openTestFile('/test/file.ts');
    useIDEStore.getState().setFilesPanelCollapsed(true);

    await ensureEditorFileOpen('/test/file.ts', { shouldApply: () => false });
    expect(useIDEStore.getState().isFilesPanelCollapsed).toBe(true);

    mockReadFile.mockRejectedValue(new Error('gone'));
    await ensureEditorFileOpen('/test/missing.ts');
    expect(useIDEStore.getState().isFilesPanelCollapsed).toBe(true);
  });

  it('preserves a saved Files collapse while a workspace restore reopens files', async () => {
    mockReadFile.mockResolvedValue(createReadFileResult('hello') as never);
    useIDEStore.getState().setFilesPanelCollapsed(true);
    useIDEStore.getState().setRestoringWorkspace(true);

    await ensureEditorFileOpen('/test/restored.ts');
    expect(useIDEStore.getState().isFilesPanelCollapsed).toBe(true);

    // Explicit navigation to that same restored file, once restore is done.
    useIDEStore.getState().setRestoringWorkspace(false);
    await navigateToEditorLocation('/test/restored.ts', 3, 1);
    expect(useIDEStore.getState().isFilesPanelCollapsed).toBe(false);
  });
});
