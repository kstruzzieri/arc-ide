// @codemirror/* ships untransformed ESM jest cannot parse; the extension only
// needs `EditorView.updateListener.of` to exist at import time (the listener is
// driven by a live view, never here). The stores are mocked so the persist
// routing is asserted directly, without a CodeMirror view or real git bindings.
jest.mock('@codemirror/view', () => ({
  EditorView: { updateListener: { of: (cb: unknown) => ({ __listener: cb }) } },
}));
const mockExternalDocUpdate = { of: jest.fn(() => 'EXTERNAL_DOC_UPDATE') };
jest.mock('@codemirror/state', () => ({
  Annotation: { define: () => mockExternalDocUpdate },
  Transaction: { addToHistory: { of: jest.fn(() => 'NO_HISTORY') } },
}));
jest.mock('../../../wails/bindings', () => ({ WriteFile: jest.fn() }));

import {
  isWorkingTreeEditable,
  persistWorkingTreeEdit,
  workingTreeEditListener,
} from './editableWorkingTree';
import { flushWorkingTreeEdit, writeFileSerialized } from '../../../utils/fileWrites';
import type { DiffSession } from '../../../stores/gitStore';
import { useIDEStore, type EditorFile } from '../../../stores/ideStore';
import { WriteFile } from '../../../wails/bindings';
import { CancellablePromise } from '../../../wails/runtime';

const mockWriteFile = WriteFile as jest.MockedFunction<typeof WriteFile>;

const openFile = (over: Partial<EditorFile> = {}): EditorFile => ({
  id: '/repo/src/a.ts',
  name: 'a.ts',
  path: '/repo/src/a.ts',
  language: 'typescript',
  encoding: 'utf-8',
  lineEndings: 'lf',
  content: 'old\n',
  isModified: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({ openFiles: [] });
});

const session = (over: Partial<DiffSession> = {}): DiffSession => ({
  path: 'src/a.ts',
  absPath: '/repo/src/a.ts',
  context: 'unstaged',
  left: { label: 'Index', content: 'a\n' },
  right: { label: 'Working Tree', content: 'b\n' },
  binary: false,
  truncated: false,
  hunks: [],
  worktreeEncoding: 'utf-8',
  worktreeLineEndings: 'lf',
  ...over,
});

describe('isWorkingTreeEditable', () => {
  it('an unstaged, textual, in-size diff is editable', () => {
    expect(isWorkingTreeEditable(session())).toBe(true);
  });

  it('a staged diff is read-only (its right side is the index snapshot)', () => {
    expect(isWorkingTreeEditable(session({ context: 'staged' }))).toBe(false);
  });

  it('a binary diff is read-only', () => {
    expect(isWorkingTreeEditable(session({ binary: true }))).toBe(false);
  });

  it('a too-large diff is read-only', () => {
    expect(isWorkingTreeEditable(session({ truncated: true }))).toBe(false);
  });

  it('stays read-only when persistence metadata is unavailable', () => {
    expect(
      isWorkingTreeEditable(
        session({ worktreeEncoding: undefined, worktreeLineEndings: undefined })
      )
    ).toBe(false);
  });

  it('stays read-only for formats the writer cannot round-trip', () => {
    expect(isWorkingTreeEditable(session({ worktreeEncoding: 'latin-1' }))).toBe(false);
    expect(isWorkingTreeEditable(session({ worktreeLineEndings: 'mixed' }))).toBe(false);
  });
});

describe('persistWorkingTreeEdit — open buffer', () => {
  it('routes the edit through the open editor buffer, not to disk', () => {
    useIDEStore.setState({ openFiles: [openFile()] });

    persistWorkingTreeEdit(session(), 'edited\n');

    const f = useIDEStore.getState().openFiles[0];
    expect(f.content).toBe('edited\n');
    expect(f.isModified).toBe(true);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('ignores a no-op edit matching the buffer so a saved file is not marked dirty', () => {
    useIDEStore.setState({ openFiles: [openFile({ content: 'same\n', isModified: false })] });

    persistWorkingTreeEdit(session(), 'same\n');

    expect(useIDEStore.getState().openFiles[0].isModified).toBe(false);
  });
});

// Awaiting a v3 binding promise costs extra microtask ticks because
// CancellablePromise is a Promise subclass, so drain the queue instead of
// counting individual ticks.
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('persistWorkingTreeEdit — disk write (file not open)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('writes to disk after a debounce, preserving the captured encoding and line endings', () => {
    mockWriteFile.mockResolvedValue(undefined);

    persistWorkingTreeEdit(
      session({ worktreeEncoding: 'utf-16le', worktreeLineEndings: 'crlf' }),
      'edited\n'
    );
    expect(mockWriteFile).not.toHaveBeenCalled(); // debounced, not per-keystroke

    jest.runOnlyPendingTimers();

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/repo/src/a.ts',
      'edited\n',
      'utf-16le',
      'crlf',
      false
    );
  });

  it('collapses rapid edits into a single trailing write', () => {
    mockWriteFile.mockResolvedValue(undefined);
    const s = session();

    persistWorkingTreeEdit(s, 'a');
    persistWorkingTreeEdit(s, 'ab');
    persistWorkingTreeEdit(s, 'abc');
    jest.runOnlyPendingTimers();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledWith('/repo/src/a.ts', 'abc', 'utf-8', 'lf', false);
  });

  it('debounces per file so switching diffs before a write fires never drops an edit', () => {
    mockWriteFile.mockResolvedValue(undefined);

    // Edit file A, then edit a different file B before A's write fires.
    persistWorkingTreeEdit(session({ path: 'a.ts', absPath: '/repo/a.ts' }), 'A edit');
    persistWorkingTreeEdit(session({ path: 'b.ts', absPath: '/repo/b.ts' }), 'B edit');
    jest.runOnlyPendingTimers();

    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile).toHaveBeenCalledWith('/repo/a.ts', 'A edit', 'utf-8', 'lf', false);
    expect(mockWriteFile).toHaveBeenCalledWith('/repo/b.ts', 'B edit', 'utf-8', 'lf', false);
  });

  it('flushes immediately before the full editor reads the file', async () => {
    mockWriteFile.mockResolvedValue(undefined);

    persistWorkingTreeEdit(session(), 'latest');
    await flushWorkingTreeEdit('/repo/src/a.ts');

    expect(mockWriteFile).toHaveBeenCalledWith('/repo/src/a.ts', 'latest', 'utf-8', 'lf', false);
  });

  it('serializes writes so an older slow write cannot finish after a newer edit', async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    mockWriteFile
      .mockImplementationOnce(
        () =>
          new CancellablePromise<void>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new CancellablePromise<void>((resolve) => {
            resolveSecond = resolve;
          })
      );

    persistWorkingTreeEdit(session(), 'first');
    jest.runOnlyPendingTimers();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    persistWorkingTreeEdit(session(), 'second');
    jest.runOnlyPendingTimers();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    resolveFirst();
    await flushMicrotasks();
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile.mock.calls[1][1]).toBe('second');

    resolveSecond();
    await flushMicrotasks();
  });

  it('serializes a full-editor save behind an in-flight diff write', async () => {
    let resolveDiff!: () => void;
    let resolveEditor!: () => void;
    mockWriteFile
      .mockImplementationOnce(
        () =>
          new CancellablePromise<void>((resolve) => {
            resolveDiff = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new CancellablePromise<void>((resolve) => {
            resolveEditor = resolve;
          })
      );

    const windowsSession = session({
      absPath: 'C:/repo/src/a.ts',
      path: 'src/a.ts',
    });
    persistWorkingTreeEdit(windowsSession, 'diff content');
    jest.runOnlyPendingTimers();
    const diffWrite = flushWorkingTreeEdit('C:\\repo\\src\\a.ts');
    const editorWrite = writeFileSerialized(
      'C:\\repo\\src\\a.ts',
      'newer editor content',
      'utf-8',
      'lf',
      false
    );
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    resolveDiff();
    await flushMicrotasks();
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile.mock.calls[1][1]).toBe('newer editor content');

    resolveEditor();
    await Promise.all([diffWrite, editorWrite]);
  });

  it('reroutes a pending disk edit into a buffer opened during the debounce', async () => {
    persistWorkingTreeEdit(session(), 'diff edit');
    useIDEStore.setState({ openFiles: [openFile({ content: 'stale disk content' })] });

    jest.runOnlyPendingTimers();
    await flushMicrotasks();

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(useIDEStore.getState().openFiles[0].content).toBe('diff edit');
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(true);
  });

  it('surfaces a toast and retains the latest edit for retry when a write fails', async () => {
    const showToast = jest.fn();
    const original = useIDEStore.getState().showToast;
    useIDEStore.setState({ showToast });
    mockWriteFile.mockRejectedValue(new Error('disk full'));

    try {
      persistWorkingTreeEdit(session(), 'x');
      jest.runOnlyPendingTimers();
      await flushMicrotasks();

      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('disk full'), 'error');

      mockWriteFile.mockResolvedValue(undefined);
      persistWorkingTreeEdit(session(), 'retry');
      jest.runOnlyPendingTimers();
      await flushMicrotasks();
      expect(mockWriteFile).toHaveBeenLastCalledWith(
        '/repo/src/a.ts',
        'retry',
        'utf-8',
        'lf',
        false
      );
    } finally {
      useIDEStore.setState({ showToast: original });
    }
  });
});

describe('workingTreeEditListener', () => {
  // The @codemirror/view mock returns the callback it was handed, so the test
  // can drive it with a fake ViewUpdate — no live CodeMirror view.
  const listenerCb = (session_: DiffSession) =>
    (workingTreeEditListener(session_) as unknown as { __listener: (u: unknown) => void })
      .__listener;

  it('persists the new doc text on a doc-changing update', () => {
    useIDEStore.setState({ openFiles: [openFile()] });

    listenerCb(session())({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => 'typed\n' } },
    });

    expect(useIDEStore.getState().openFiles[0].content).toBe('typed\n');
  });

  it('acknowledges an edit routed into an open buffer', () => {
    const onSaved = jest.fn();
    useIDEStore.setState({ openFiles: [openFile()] });
    const callback = (
      workingTreeEditListener(session(), undefined, onSaved) as unknown as {
        __listener: (u: unknown) => void;
      }
    ).__listener;

    callback({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => 'typed\n' } },
    });

    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('ignores updates that did not change the doc (scroll, selection, folding)', () => {
    useIDEStore.setState({ openFiles: [openFile()] });

    listenerCb(session())({
      docChanged: false,
      transactions: [],
      state: { doc: { toString: () => 'should not persist\n' } },
    });

    expect(useIDEStore.getState().openFiles[0].content).toBe('old\n');
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(false);
  });

  it('ignores authoritative external reconciliation updates', () => {
    useIDEStore.setState({ openFiles: [openFile()] });
    const onEdit = jest.fn();
    const callback = (
      workingTreeEditListener(session(), onEdit) as unknown as {
        __listener: (u: unknown) => void;
      }
    ).__listener;

    callback({
      docChanged: true,
      transactions: [
        {
          annotation: (annotation: unknown) =>
            annotation === mockExternalDocUpdate ? true : undefined,
        },
      ],
      state: { doc: { toString: () => 'externally refreshed\n' } },
    });

    expect(onEdit).not.toHaveBeenCalled();
    expect(useIDEStore.getState().openFiles[0].content).toBe('old\n');
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(false);
  });
});
