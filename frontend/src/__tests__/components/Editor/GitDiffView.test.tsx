// @codemirror/* ships untransformed ESM that jest does not transpile (the
// same reason CodeMirrorEditor has no direct render test). Mock the merge
// module and verify the component's construction/teardown contract instead.
const destroyMock = jest.fn();
let fakeSideBDoc = '';
const fakeSideADispatch = jest.fn();
const fakeDispatch = jest.fn(
  (transaction: { changes?: { from: number; to: number; insert: string } }) => {
    if (!transaction.changes) return;
    const { from, to, insert } = transaction.changes;
    fakeSideBDoc = `${fakeSideBDoc.slice(0, from)}${insert}${fakeSideBDoc.slice(to)}`;
  }
);
const fakeSideA = {
  state: {},
  dispatch: fakeSideADispatch,
  requestMeasure: jest.fn(),
};
const fakeSideB = {
  state: { doc: { toString: () => fakeSideBDoc }, selection: { main: { head: 0 } } },
  dispatch: (transaction: unknown) => fakeDispatch(transaction as never),
  focus: jest.fn(),
  requestMeasure: jest.fn(),
};
const mergeViewMock = jest.fn().mockImplementation((config: { b: { doc: string } }) => {
  fakeSideBDoc = config.b.doc;
  return {
    destroy: destroyMock,
    a: fakeSideA,
    b: fakeSideB,
  };
});
const goToNextChunkMock = jest.fn((_arg?: unknown) => true);
const goToPreviousChunkMock = jest.fn((_arg?: unknown) => true);
const getChunksMock = jest.fn((_arg?: unknown) => ({ chunks: [{}, {}], side: null }));

jest.mock('@codemirror/merge', () => ({
  MergeView: mergeViewMock,
  goToNextChunk: (arg: unknown) => goToNextChunkMock(arg),
  goToPreviousChunk: (arg: unknown) => goToPreviousChunkMock(arg),
  getChunks: (arg: unknown) => getChunksMock(arg),
}));
const gutterMock = jest.fn((_config?: unknown) => ({ __gutter: true }));
let mockEditListener: ((update: unknown) => void) | null = null;
const mockUpdateListenerOf = jest.fn((callback: (update: unknown) => void) => {
  mockEditListener = callback;
  return 'EDIT_LISTENER';
});
// Distinct tokens so a pane's extension array reveals its wiring: read-only
// panes carry EDITABLE_FALSE + READONLY, the editable working-tree pane carries
// EDIT_LISTENER instead.
jest.mock('@codemirror/view', () => ({
  EditorView: {
    editable: { of: jest.fn(() => 'EDITABLE_FALSE') },
    updateListener: { of: (callback: (update: unknown) => void) => mockUpdateListenerOf(callback) },
    scrollIntoView: jest.fn(() => 'SCROLL_EFFECT'),
    lineWrapping: {},
  },
  lineNumbers: jest.fn(),
  // Pass bindings through so tests can assert which keymaps a pane carries.
  keymap: { of: (bindings: unknown) => bindings },
  gutter: (config: unknown) => gutterMock(config),
  GutterMarker: class {},
}));
const compartmentReconfigureMocks: jest.Mock[] = [];
jest.mock('@codemirror/state', () => ({
  Annotation: { define: jest.fn(() => ({ of: jest.fn(() => 'EXTERNAL_DOC_UPDATE') })) },
  EditorState: { readOnly: { of: jest.fn(() => 'READONLY') } },
  RangeSet: { of: jest.fn() },
  Transaction: { addToHistory: { of: jest.fn(() => 'NO_HISTORY') } },
  Compartment: class {
    private reconfigureMock = jest.fn((extension: unknown) => ({ __reconfigure: extension }));
    constructor() {
      compartmentReconfigureMocks.push(this.reconfigureMock);
    }
    of(extension: unknown) {
      return extension;
    }
    reconfigure(extension: unknown) {
      return this.reconfigureMock(extension);
    }
  },
}));
jest.mock('@codemirror/commands', () => ({
  history: jest.fn(() => 'HISTORY'),
  historyKeymap: ['HISTORY_KEYS'],
  defaultKeymap: ['DEFAULT_KEYS'],
  indentWithTab: 'INDENT_WITH_TAB',
}));
const mockLoadLanguageSupport = jest.fn<Promise<unknown>, [string]>();
jest.mock('../../../components/Editor/codemirror', () => ({
  buildTheme: jest.fn(() => []),
  loadLanguageSupport: mockLoadLanguageSupport,
  gitGutterExtension: jest.fn(() => 'GIT_GUTTER'),
  setGitBaseline: { of: jest.fn((v: unknown) => ({ __baseline: v })) },
}));
const mockEnsureOpen = jest.fn().mockResolvedValue({ id: '/repo/src/a.ts' });
jest.mock('../../../utils/editorNavigation', () => ({
  ensureEditorFileOpen: (...args: unknown[]) => mockEnsureOpen(...args),
}));
jest.mock('../../../wails/bindings', () => ({
  ...jest.requireActual('../../../wails/bindings'),
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
  GitFileHunks: jest.fn(),
  GitApplyHunk: jest.fn(),
  ReadFile: jest.fn(),
  WriteFile: jest.fn(),
}));

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GitDiffView } from '../../../components/Editor/GitDiffView';
import { useGitStore, type DiffSession } from '../../../stores/gitStore';
import { useIDEStore } from '../../../stores/ideStore';
import { WriteFile } from '../../../wails/bindings';
import { flushWorkingTreeEdit } from '../../../utils/fileWrites';

const mockWriteFile = WriteFile as jest.MockedFunction<typeof WriteFile>;

const base: DiffSession = {
  path: 'src/a.ts',
  absPath: '/repo/src/a.ts',
  context: 'unstaged',
  left: { label: 'Index', content: 'const a = 1;\n' },
  right: { label: 'Working Tree', content: 'const a = 2;\n' },
  binary: false,
  truncated: false,
  hunks: [],
  worktreeEncoding: 'utf-8',
  worktreeLineEndings: 'lf',
};

beforeEach(() => {
  jest.clearAllMocks();
  compartmentReconfigureMocks.length = 0;
  mockLoadLanguageSupport.mockReturnValue(new Promise(() => {}));
  mockEditListener = null;
  mockWriteFile.mockResolvedValue(undefined);
  useIDEStore.setState({ openFiles: [] });
});

describe('GitDiffView', () => {
  it('loads once and reconfigures both panes with separate compartments', async () => {
    const pending = deferred<unknown>();
    const language = { name: 'typescript-support' };
    mockLoadLanguageSupport.mockReturnValueOnce(pending.promise);

    render(<GitDiffView session={base} />);
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalledWith('a.ts'));
    fakeSideADispatch.mockClear();
    fakeDispatch.mockClear();

    await act(async () => pending.resolve(language));

    expect(fakeSideADispatch).toHaveBeenCalledWith({
      effects: { __reconfigure: language },
    });
    expect(fakeDispatch).toHaveBeenCalledWith({ effects: { __reconfigure: language } });
    expect(
      compartmentReconfigureMocks.filter((mock) =>
        mock.mock.calls.some(([extension]) => extension === language)
      )
    ).toHaveLength(2);
  });

  it('keeps both panes plain when no language support is available', async () => {
    mockLoadLanguageSupport.mockResolvedValueOnce(null);

    render(<GitDiffView session={base} />);

    await waitFor(() =>
      expect(fakeSideADispatch).toHaveBeenCalledWith({
        effects: { __reconfigure: [] },
      })
    );
    expect(fakeDispatch).toHaveBeenCalledWith({ effects: { __reconfigure: [] } });
  });

  it('ignores a language resolved for a replaced diff session', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mockLoadLanguageSupport.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<GitDiffView session={base} />);
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalledWith('a.ts'));

    const replacement = {
      ...base,
      path: 'src/b.py',
      absPath: '/repo/src/b.py',
    };
    rerender(<GitDiffView session={replacement} />);
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalledWith('b.py'));
    fakeSideADispatch.mockClear();
    fakeDispatch.mockClear();

    await act(async () => first.resolve({ name: 'stale-typescript' }));
    expect(fakeSideADispatch).not.toHaveBeenCalled();
    expect(fakeDispatch).not.toHaveBeenCalled();

    const python = { name: 'python-support' };
    await act(async () => second.resolve(python));
    expect(fakeSideADispatch).toHaveBeenCalledWith({
      effects: { __reconfigure: python },
    });
    expect(fakeDispatch).toHaveBeenCalledWith({ effects: { __reconfigure: python } });
  });

  it('ignores a language resolved after unmount', async () => {
    const pending = deferred<unknown>();
    mockLoadLanguageSupport.mockReturnValueOnce(pending.promise);
    const { unmount } = render(<GitDiffView session={base} />);
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalled());
    fakeSideADispatch.mockClear();
    fakeDispatch.mockClear();

    unmount();
    await act(async () => pending.resolve({ name: 'late-language' }));

    expect(fakeSideADispatch).not.toHaveBeenCalled();
    expect(fakeDispatch).not.toHaveBeenCalled();
  });

  it('mounts a merge view with both revision docs and labels', () => {
    render(<GitDiffView session={base} />);

    expect(screen.getByText('Index')).toBeInTheDocument();
    expect(screen.getByText('Working Tree')).toBeInTheDocument();
    expect(mergeViewMock).toHaveBeenCalledTimes(1);
    const config = mergeViewMock.mock.calls[0][0];
    expect(config.a.doc).toBe('const a = 1;\n');
    expect(config.b.doc).toBe('const a = 2;\n');
    expect(config.parent).toBe(screen.getByTestId('merge-host'));
  });

  it('delegates Open File to the shared editor navigation utility', async () => {
    useGitStore.setState({ diffFocused: true });
    render(<GitDiffView session={base} />);

    fireEvent.click(screen.getByRole('button', { name: /open file/i }));

    await waitFor(() => expect(mockEnsureOpen).toHaveBeenCalledWith('/repo/src/a.ts'));
  });

  it('destroys the merge view on unmount', () => {
    const { unmount } = render(<GitDiffView session={base} />);

    unmount();

    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('reconciles working-tree content in place so cursor and scroll survive', () => {
    const { rerender } = render(<GitDiffView session={base} />);

    rerender(
      <GitDiffView
        session={{ ...base, right: { label: 'Working Tree', content: 'const a = 3;\n' } }}
      />
    );

    expect(destroyMock).not.toHaveBeenCalled();
    expect(mergeViewMock).toHaveBeenCalledTimes(1);
    expect(fakeSideBDoc).toBe('const a = 3;\n');
    expect(fakeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.anything(),
        annotations: ['NO_HISTORY', 'EXTERNAL_DOC_UPDATE'],
      })
    );
  });

  it('rebuilds when a structural field changes', () => {
    const { rerender } = render(<GitDiffView session={base} />);

    rerender(<GitDiffView session={{ ...base, left: { label: 'Index', content: 'changed\n' } }} />);

    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(mergeViewMock).toHaveBeenCalledTimes(2);
  });

  it('preserves newer in-view text when a stale refresh session arrives', async () => {
    const { rerender } = render(<GitDiffView session={base} />);
    fakeSideBDoc = 'const a = 20;\n';
    mockEditListener?.({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => fakeSideBDoc } },
    });

    rerender(
      <GitDiffView
        session={{ ...base, right: { label: 'Working Tree', content: 'const a = 3;\n' } }}
      />
    );

    expect(mergeViewMock).toHaveBeenCalledTimes(1);
    expect(fakeSideBDoc).toBe('const a = 20;\n');
    await flushWorkingTreeEdit(base.absPath);
  });

  it('a stale refresh arriving after the save completes cannot roll the pane back', async () => {
    // The data-loss chain from GUI testing: edit -> save completes (onSaved
    // fires) -> a refresh that STARTED before the save lands with the older
    // content. If onSaved cleared the local-edit guard, the stale session
    // reconciled the pane backward, silently eating the newest keystrokes and
    // leaving the pane permanently diverged from the buffer/disk. The guard
    // must persist until an arriving session actually matches the pane.
    const { rerender } = render(<GitDiffView session={base} />);
    fakeSideBDoc = 'const a = 20;\n';
    mockEditListener?.({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => fakeSideBDoc } },
    });

    // Complete the debounced save: onSaved fires inside this flush.
    await flushWorkingTreeEdit(base.absPath);

    // Now the stale session (pre-edit content) lands.
    rerender(
      <GitDiffView
        session={{ ...base, right: { label: 'Working Tree', content: 'const a = 3;\n' } }}
      />
    );

    expect(fakeSideBDoc).toBe('const a = 20;\n');

    // The refresh carrying the saved content converges and re-arms reconciles.
    rerender(
      <GitDiffView
        session={{ ...base, right: { label: 'Working Tree', content: 'const a = 20;\n' } }}
      />
    );
    expect(fakeSideBDoc).toBe('const a = 20;\n');
  });

  it('preserves an explicit undo when a stale refresh contains the intermediate edit', async () => {
    const { rerender } = render(<GitDiffView session={base} />);
    fakeSideBDoc = 'const a = 20;\n';
    mockEditListener?.({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => fakeSideBDoc } },
    });
    fakeSideBDoc = base.right.content;
    mockEditListener?.({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => fakeSideBDoc } },
    });

    rerender(
      <GitDiffView
        session={{ ...base, right: { label: 'Working Tree', content: 'const a = 20;\n' } }}
      />
    );

    expect(mergeViewMock).toHaveBeenCalledTimes(1);
    expect(fakeSideBDoc).toBe(base.right.content);
    await flushWorkingTreeEdit(base.absPath);
  });

  it('accepts a newer external session after the local disk write is acknowledged', async () => {
    const { rerender } = render(<GitDiffView session={base} />);
    fakeSideBDoc = 'const a = 20;\n';
    mockEditListener?.({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => fakeSideBDoc } },
    });
    await flushWorkingTreeEdit(base.absPath);

    // The post-save refresh carries a request id past the edit barrier,
    // marking its content as read AFTER the edit — authoritative.
    rerender(
      <GitDiffView
        session={{
          ...base,
          right: { label: 'Working Tree', content: 'external change\n' },
          requestRevision: 99,
        }}
      />
    );

    expect(mergeViewMock).toHaveBeenCalledTimes(1);
    expect(fakeSideBDoc).toBe('external change\n');
  });

  it('accepts a newer external session after routing an edit through an open buffer', () => {
    useIDEStore.setState({
      openFiles: [
        {
          id: base.absPath,
          path: base.absPath,
          name: 'a.ts',
          language: 'TypeScript',
          encoding: 'utf-8',
          lineEndings: 'lf',
          content: base.right.content,
          isModified: false,
        },
      ],
    });
    const { rerender } = render(<GitDiffView session={base} />);
    fakeSideBDoc = 'const a = 20;\n';
    mockEditListener?.({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => fakeSideBDoc } },
    });

    rerender(
      <GitDiffView
        session={{
          ...base,
          right: { label: 'Working Tree', content: 'external change\n' },
          requestRevision: 99,
        }}
      />
    );

    expect(mergeViewMock).toHaveBeenCalledTimes(1);
    expect(fakeSideBDoc).toBe('external change\n');
  });

  it('ignores a slow save acknowledgement from a previously viewed diff', async () => {
    const { rerender } = render(<GitDiffView session={base} />);
    fakeSideBDoc = 'A edit\n';
    mockEditListener?.({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => fakeSideBDoc } },
    });

    const second = {
      ...base,
      path: 'src/b.ts',
      absPath: '/repo/src/b.ts',
      right: { label: 'Working Tree', content: 'B baseline\n' },
    };
    rerender(<GitDiffView session={second} />);
    fakeSideBDoc = 'B edit\n';
    mockEditListener?.({
      docChanged: true,
      transactions: [],
      state: { doc: { toString: () => fakeSideBDoc } },
    });

    await flushWorkingTreeEdit(base.absPath);
    rerender(
      <GitDiffView
        session={{ ...second, right: { label: 'Working Tree', content: 'B stale\n' } }}
      />
    );

    expect(mergeViewMock).toHaveBeenCalledTimes(2);
    expect(fakeSideBDoc).toBe('B edit\n');
    await flushWorkingTreeEdit(second.absPath);
  });

  it('shows the difference count and next/previous navigation', () => {
    render(<GitDiffView session={base} />);

    // base session: one changed line → one hunk.
    expect(screen.getByText('1 difference')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /next difference/i }));
    expect(goToNextChunkMock).toHaveBeenCalled();
    expect(fakeDispatch).toHaveBeenCalledWith({ effects: 'SCROLL_EFFECT' });

    fireEvent.click(screen.getByRole('button', { name: /previous difference/i }));
    expect(goToPreviousChunkMock).toHaveBeenCalled();
  });

  it('renders a draggable column divider that updates the split ratio', () => {
    render(<GitDiffView session={base} />);
    const divider = screen.getByRole('separator', { name: /resize diff columns/i });
    const root = screen.getByTestId('diff-root');
    jest
      .spyOn(root, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 1000, top: 0, height: 500 } as DOMRect);

    fireEvent.mouseDown(divider, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 300 });
    fireEvent.mouseUp(window);

    expect(root.style.getPropertyValue('--diff-left')).toBe('30%');
  });

  it('clamps the divider so neither pane collapses', () => {
    render(<GitDiffView session={base} />);
    const divider = screen.getByRole('separator', { name: /resize diff columns/i });
    const root = screen.getByTestId('diff-root');
    jest
      .spyOn(root, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 1000, top: 0, height: 500 } as DOMRect);

    fireEvent.mouseDown(divider, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 5 });
    fireEvent.mouseUp(window);

    expect(root.style.getPropertyValue('--diff-left')).toBe('15%');
  });

  it('supports keyboard resizing on the divider', () => {
    render(<GitDiffView session={base} />);
    const divider = screen.getByRole('separator', { name: /resize diff columns/i });

    fireEvent.keyDown(divider, { key: 'ArrowLeft' });

    expect(screen.getByTestId('diff-root').style.getPropertyValue('--diff-left')).toBe('48%');
  });

  it('builds a hunk-staging gutter on the right pane when the diff has hunks', () => {
    render(
      <GitDiffView session={{ ...base, hunks: [{ patch: 'P', newStart: 1, newLines: 1 }] }} />
    );

    // The right pane (b) gets the extra gutter; the left pane (a) does not.
    expect(gutterMock).toHaveBeenCalledWith(expect.objectContaining({ class: 'cm-hunkGutter' }));
    const config = mergeViewMock.mock.calls[0][0];
    expect(config.b.extensions).toContainEqual({ __gutter: true });
    expect(config.a.extensions).not.toContainEqual({ __gutter: true });
  });

  it('reconfigures the hunk gutter in place when the hunk set changes', () => {
    const { rerender } = render(<GitDiffView session={base} />);

    rerender(
      <GitDiffView session={{ ...base, hunks: [{ patch: 'P', newStart: 1, newLines: 1 }] }} />
    );

    expect(mergeViewMock).toHaveBeenCalledTimes(1);
    expect(fakeDispatch).toHaveBeenCalledWith({
      effects: { __reconfigure: { __gutter: true } },
    });
  });

  it('makes only the working-tree (right) pane editable in an unstaged diff', () => {
    render(<GitDiffView session={base} />);

    const config = mergeViewMock.mock.calls[0][0];
    // Left pane is the index snapshot: read-only.
    expect(config.a.extensions).toContain('EDITABLE_FALSE');
    expect(config.a.extensions).toContain('READONLY');
    expect(config.a.extensions).not.toContain('EDIT_LISTENER');
    // Right pane is the live working tree: editable, wired to persist edits,
    // with its own undo history (Cmd-Z), like the regular editor. It must also
    // carry the standard editing keymap: without an Enter binding the key
    // falls through to WebKit's contenteditable default, whose block insert
    // reads back as TWO newlines per press.
    expect(config.b.extensions).toContain('EDIT_LISTENER');
    expect(config.b.extensions).toContain('HISTORY');
    expect(config.b.extensions).toContainEqual(['DEFAULT_KEYS', 'INDENT_WITH_TAB']);
    expect(config.a.extensions).not.toContainEqual(['DEFAULT_KEYS', 'INDENT_WITH_TAB']);
    expect(config.b.extensions).not.toContain('EDITABLE_FALSE');
    expect(config.b.extensions).not.toContain('READONLY');
    expect(config.a.extensions).not.toContain('HISTORY');
  });

  it('gives the editable pane the clickable change gutter, seeded with the index baseline', () => {
    render(<GitDiffView session={base} />);

    const config = mergeViewMock.mock.calls[0][0];
    // The file view's git gutter (click -> peek/revert popup) rides along on
    // the working-tree pane; its baseline is the diff's left (index) side, so
    // Revert restores the index content for that hunk.
    expect(config.b.extensions).toContain('GIT_GUTTER');
    expect(config.a.extensions).not.toContain('GIT_GUTTER');
    expect(fakeDispatch).toHaveBeenCalledWith({
      effects: { __baseline: 'const a = 1;\n' },
    });
    // The merge view's own (non-clickable) change bars are hidden on this pane
    // via a root class, so the two gutters don't double up.
    expect(screen.getByTestId('diff-root').className).toContain('editableRight');
  });

  it('keeps the previous hunk gutter through a suppressed-hunks refresh (no column collapse)', () => {
    const withHunks = { ...base, hunks: [{ patch: 'P', newStart: 1, newLines: 1 }] };
    const { rerender } = render(<GitDiffView session={withHunks} />);
    fakeDispatch.mockClear();

    // A refresh that ran while the editor buffer was still dirty ships no
    // hunks; reconfiguring to an empty gutter would unmount the whole column
    // for the sub-second save window, so the old gutter must stay.
    rerender(<GitDiffView session={{ ...withHunks, hunks: [], hunksSuppressed: true }} />);

    expect(fakeDispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        effects: expect.objectContaining({ __reconfigure: expect.anything() }),
      })
    );

    // The follow-up refresh (buffer saved) delivers real hunks again: now the
    // gutter reconfigures with fresh patches.
    rerender(
      <GitDiffView session={{ ...withHunks, hunks: [{ patch: 'P2', newStart: 1, newLines: 1 }] }} />
    );

    expect(fakeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        effects: expect.objectContaining({ __reconfigure: expect.anything() }),
      })
    );
  });

  it('adds no clickable change gutter to a staged (read-only) diff', () => {
    render(
      <GitDiffView
        session={{
          ...base,
          context: 'staged',
          left: { label: 'HEAD', content: 'const a = 1;\n' },
          right: { label: 'Index', content: 'const a = 2;\n' },
        }}
      />
    );

    const config = mergeViewMock.mock.calls[0][0];
    expect(config.b.extensions).not.toContain('GIT_GUTTER');
    expect(screen.getByTestId('diff-root').className).not.toContain('editableRight');
  });

  it('keeps both panes read-only in a staged diff (right side is the index)', () => {
    render(
      <GitDiffView
        session={{
          ...base,
          context: 'staged',
          left: { label: 'HEAD', content: 'const a = 1;\n' },
          right: { label: 'Index', content: 'const a = 2;\n' },
        }}
      />
    );

    const config = mergeViewMock.mock.calls[0][0];
    expect(config.b.extensions).toContain('EDITABLE_FALSE');
    expect(config.b.extensions).toContain('READONLY');
    expect(config.b.extensions).not.toContain('EDIT_LISTENER');
    expect(config.b.extensions).not.toContain('HISTORY');
  });

  it('adds no hunk gutter when there are no hunks', () => {
    render(<GitDiffView session={base} />);

    expect(gutterMock).not.toHaveBeenCalled();
  });

  it('renders a binary state instead of a merge view', () => {
    render(<GitDiffView session={{ ...base, binary: true }} />);

    expect(screen.getByTestId('diff-binary')).toBeInTheDocument();
    expect(mergeViewMock).not.toHaveBeenCalled();
  });

  it('renders a too-large state instead of a merge view', () => {
    render(<GitDiffView session={{ ...base, truncated: true }} />);

    expect(screen.getByTestId('diff-too-large')).toBeInTheDocument();
    expect(mergeViewMock).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
