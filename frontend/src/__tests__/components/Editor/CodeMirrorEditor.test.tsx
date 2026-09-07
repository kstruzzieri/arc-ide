import { act, render, screen, waitFor } from '@testing-library/react';

type DispatchSpec = {
  selection?: { anchor: number };
  changes?: { from: number; to: number; insert: string };
  effects?: unknown | unknown[];
  scrollIntoView?: boolean;
};

class FakeDoc {
  constructor(private text: string) {}

  get lines() {
    return this.text.split('\n').length;
  }

  line(lineNumber: number) {
    const lines = this.text.split('\n');
    let from = 1;
    for (let i = 0; i < lineNumber - 1; i += 1) {
      from += (lines[i] ?? '').length + 1;
    }
    return {
      from,
      length: (lines[lineNumber - 1] ?? '').length,
    };
  }

  toString() {
    return this.text;
  }

  replace(text: string) {
    this.text = text;
  }
}

let lastEditorView: {
  dispatch: jest.Mock<void, [DispatchSpec]>;
  scrollDOM: { scrollTop: number; addEventListener: jest.Mock; removeEventListener: jest.Mock };
} | null = null;

const mockCreateEditorExtensions = jest.fn(() => []);
const mockUpdateEditorDiagnostics = jest.fn();
const mockReconfigureCompletion = jest.fn((filePath: string, triggerCharacters: string[]) => ({
  kind: 'completion-source',
  filePath,
  triggerCharacters,
}));
const mockReconfigureHover = jest.fn((filePath: string) => ({
  kind: 'hover-source',
  filePath,
}));
const mockResetCompletion = jest.fn(() => ({
  kind: 'completion-default',
}));
const mockCompletionCompartmentReconfigure = jest.fn((value: unknown) => ({
  kind: 'completion-compartment',
  value,
}));
const mockHoverCompartmentReconfigure = jest.fn((value: unknown) => ({
  kind: 'hover-compartment',
  value,
}));
const mockLanguageCompartmentReconfigure = jest.fn((value: unknown) => ({
  kind: 'language-compartment',
  value,
}));
const mockLoadLanguageSupport = jest.fn<Promise<unknown>, [string]>();

jest.mock('../../../components/Editor/codemirror', () => {
  class MockEditorView {
    state: { doc: FakeDoc; selection: { main: { head: number } } };
    scrollDOM = {
      scrollTop: 0,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    contentDOM = document.createElement('div');
    // applyNavigation reads view.dom.isConnected in its deferred re-scroll guard.
    dom = { isConnected: true };
    dispatch = jest.fn();
    destroy = jest.fn();
    focus = jest.fn();

    constructor({ state, parent }: { state: { doc: FakeDoc }; parent: HTMLElement }) {
      this.state = { selection: { main: { head: 0 } }, ...state };
      parent.appendChild(this.contentDOM);
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      lastEditorView = this;
    }

    setState(newState: { doc: FakeDoc }) {
      this.state = { selection: { main: { head: 0 } }, ...newState };
    }
  }

  return {
    EditorView: MockEditorView,
    EditorState: {
      create: ({ doc }: { doc: string }) => ({
        doc: new FakeDoc(doc),
      }),
    },
    reconcileDoc: jest.fn(),
    completionCompartment: {
      reconfigure: mockCompletionCompartmentReconfigure,
    },
    hoverCompartment: {
      reconfigure: mockHoverCompartmentReconfigure,
    },
    languageCompartment: {
      reconfigure: mockLanguageCompartmentReconfigure,
    },
    loadLanguageSupport: mockLoadLanguageSupport,
    createEditorExtensions: mockCreateEditorExtensions,
    applyEditorTheme: jest.fn(),
    reconfigureCompletion: mockReconfigureCompletion,
    reconfigureHover: mockReconfigureHover,
    resetCompletion: mockResetCompletion,
    updateEditorDiagnostics: mockUpdateEditorDiagnostics,
    setGitBaseline: { of: (value: unknown) => ({ value }) },
    gitGutterExtension: jest.fn(() => []),
  };
});

jest.mock('../../../wails/bindings', () => ({
  LSPRetryProvision: jest.fn().mockResolvedValue(undefined),
  LSPSetInterpreter: jest.fn().mockResolvedValue(undefined),
  LSPClearInterpreter: jest.fn().mockResolvedValue(undefined),
  LSPDoctor: jest.fn().mockResolvedValue({ family: 'python', candidates: [] }),
}));

import { CodeMirrorEditor } from '../../../components/Editor/CodeMirrorEditor';
import { applyEditorTheme } from '../../../components/Editor/codemirror';
import { useIDEStore } from '../../../stores/ideStore';
import { useLSPStore } from '../../../stores/lspStore';

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadLanguageSupport.mockResolvedValue(null);
  lastEditorView = null;
  useIDEStore.setState(useIDEStore.getInitialState());
  useLSPStore.setState(useLSPStore.getInitialState());
  global.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

describe('CodeMirrorEditor', () => {
  it('reconfigures the current file language after it loads', async () => {
    const language = { name: 'typescript-support' };
    mockLoadLanguageSupport.mockResolvedValueOnce(language);

    render(
      <CodeMirrorEditor
        fileId="/project/main.ts"
        filename="main.ts"
        content="const value = 1;"
        openFileIds={['/project/main.ts']}
      />
    );

    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalledWith('main.ts'));
    expect(lastEditorView?.dispatch).toHaveBeenCalledWith({
      effects: { kind: 'language-compartment', value: language },
    });
  });

  it('ignores a language that resolves after switching files', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mockLoadLanguageSupport.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { rerender } = render(
      <CodeMirrorEditor
        fileId="/project/a.ts"
        filename="a.ts"
        content="const a = 1;"
        openFileIds={['/project/a.ts', '/project/b.py']}
      />
    );
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalledWith('a.ts'));

    rerender(
      <CodeMirrorEditor
        fileId="/project/b.py"
        filename="b.py"
        content="b = 1"
        openFileIds={['/project/a.ts', '/project/b.py']}
      />
    );
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalledWith('b.py'));
    lastEditorView?.dispatch.mockClear();

    await act(async () => first.resolve({ name: 'stale-typescript' }));
    expect(lastEditorView?.dispatch).not.toHaveBeenCalled();

    const python = { name: 'python-support' };
    await act(async () => second.resolve(python));
    expect(lastEditorView?.dispatch).toHaveBeenCalledWith({
      effects: { kind: 'language-compartment', value: python },
    });
  });

  it('distinguishes stale and current generations when switching A to B to A', async () => {
    const firstA = deferred<unknown>();
    const b = deferred<unknown>();
    const secondA = deferred<unknown>();
    mockLoadLanguageSupport
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(secondA.promise);

    const props = {
      content: 'const a = 1;',
      openFileIds: ['/project/a.ts', '/project/b.py'],
    };
    const { rerender } = render(
      <CodeMirrorEditor fileId="/project/a.ts" filename="a.ts" {...props} />
    );
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalledTimes(1));
    rerender(<CodeMirrorEditor fileId="/project/b.py" filename="b.py" {...props} />);
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalledTimes(2));
    rerender(<CodeMirrorEditor fileId="/project/a.ts" filename="a.ts" {...props} />);
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalledTimes(3));
    lastEditorView?.dispatch.mockClear();

    await act(async () => firstA.resolve({ name: 'stale-a' }));
    expect(lastEditorView?.dispatch).not.toHaveBeenCalled();

    const currentA = { name: 'current-a' };
    await act(async () => secondA.resolve(currentA));
    expect(lastEditorView?.dispatch).toHaveBeenCalledWith({
      effects: { kind: 'language-compartment', value: currentA },
    });
  });

  it('ignores a language that resolves after unmount', async () => {
    const pending = deferred<unknown>();
    mockLoadLanguageSupport.mockReturnValueOnce(pending.promise);
    const { unmount } = render(
      <CodeMirrorEditor
        fileId="/project/main.ts"
        filename="main.ts"
        content="const value = 1;"
        openFileIds={['/project/main.ts']}
      />
    );
    await waitFor(() => expect(mockLoadLanguageSupport).toHaveBeenCalled());
    const view = lastEditorView;
    view?.dispatch.mockClear();

    unmount();
    await act(async () => pending.resolve({ name: 'late-language' }));

    expect(view?.dispatch).not.toHaveBeenCalled();
  });

  it('reconfigures the editor theme when the global syntax theme changes', () => {
    render(
      <CodeMirrorEditor
        fileId="file-1"
        filename="main.ts"
        content={'x = 1'}
        openFileIds={['file-1']}
      />
    );
    (applyEditorTheme as jest.Mock).mockClear();

    act(() => {
      useIDEStore.getState().setEditorSyntaxTheme('reef');
    });

    expect(applyEditorTheme).toHaveBeenCalled();
    expect((applyEditorTheme as jest.Mock).mock.calls.at(-1)?.[1]).toBe('reef');
  });

  it('applies restored cursor and scroll when they arrive after mount', async () => {
    const { rerender } = render(
      <CodeMirrorEditor
        fileId="file-1"
        filename="main.ts"
        content={'one\ntwo\nthree'}
        openFileIds={['file-1']}
      />
    );

    expect(lastEditorView).not.toBeNull();
    expect(lastEditorView?.dispatch).not.toHaveBeenCalled();

    rerender(
      <CodeMirrorEditor
        fileId="file-1"
        filename="main.ts"
        content={'one\ntwo\nthree'}
        openFileIds={['file-1']}
        initialCursorLine={2}
        initialCursorColumn={3}
        initialScrollTop={55}
      />
    );

    await waitFor(() =>
      expect(lastEditorView?.dispatch).toHaveBeenCalledWith({
        selection: { anchor: 7 },
        scrollIntoView: false,
      })
    );
    expect(lastEditorView?.scrollDOM.scrollTop).toBe(55);
  });

  it('passes the absolute file path into editor extensions', () => {
    render(
      <CodeMirrorEditor
        fileId="/project/main.ts"
        filename="main.ts"
        content="const value = 1;"
        openFileIds={['/project/main.ts']}
      />
    );

    expect(mockCreateEditorExtensions).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'main.ts',
        filePath: '/project/main.ts',
      })
    );
  });

  it('reconfigures completion and hover from matching LSP server status', async () => {
    render(
      <CodeMirrorEditor
        fileId="/project/main.ts"
        filename="main.ts"
        content="const value = 1;"
        openFileIds={['/project/main.ts']}
      />
    );

    expect(lastEditorView).not.toBeNull();
    lastEditorView?.dispatch.mockClear();
    mockReconfigureCompletion.mockClear();
    mockReconfigureHover.mockClear();
    mockCompletionCompartmentReconfigure.mockClear();
    mockHoverCompartmentReconfigure.mockClear();

    act(() => {
      useIDEStore.getState().setWorkspace({ name: 'project', path: '/project' });
      useLSPStore.getState().setServerStatus({
        family: 'typescript',
        workspace: '/project',
        state: 'ready',
        completionTriggerCharacters: ['.', ':'],
      });
    });

    await waitFor(() => {
      expect(mockReconfigureCompletion).toHaveBeenCalledWith('/project/main.ts', ['.', ':']);
      expect(mockReconfigureHover).toHaveBeenCalledWith('/project/main.ts');
    });

    expect(lastEditorView?.dispatch).toHaveBeenCalledWith({
      effects: [
        {
          kind: 'completion-compartment',
          value: {
            kind: 'completion-source',
            filePath: '/project/main.ts',
            triggerCharacters: ['.', ':'],
          },
        },
        {
          kind: 'hover-compartment',
          value: {
            kind: 'hover-source',
            filePath: '/project/main.ts',
          },
        },
      ],
    });

    lastEditorView?.dispatch.mockClear();
    mockCompletionCompartmentReconfigure.mockClear();
    mockHoverCompartmentReconfigure.mockClear();

    act(() => {
      useLSPStore.getState().setServerStatus({
        family: 'typescript',
        workspace: '/project',
        state: 'error',
        error: 'server crashed',
      });
    });

    await waitFor(() => {
      expect(mockResetCompletion).toHaveBeenCalled();
      expect(mockHoverCompartmentReconfigure).toHaveBeenCalledWith([]);
    });

    expect(lastEditorView?.dispatch).toHaveBeenCalledWith({
      effects: [
        {
          kind: 'completion-compartment',
          value: {
            kind: 'completion-default',
          },
        },
        {
          kind: 'hover-compartment',
          value: [],
        },
      ],
    });
  });

  it('renders the LSP setup card when a python file reports a missing interpreter', async () => {
    render(
      <CodeMirrorEditor
        fileId="/project/app.py"
        filename="app.py"
        content="x = 1"
        openFileIds={['/project/app.py']}
      />
    );

    act(() => {
      useIDEStore.getState().setWorkspace({ name: 'project', path: '/project' });
      useLSPStore.getState().setServerStatus({
        family: 'python',
        workspace: '/project',
        state: 'ready',
        setupState: 'missing_interpreter',
        action: 'create_venv',
      });
    });

    await waitFor(() => expect(screen.getByText(/no python interpreter/i)).toBeInTheDocument());
  });

  it('clears the LSP setup card when reused for a file without an LSP family', async () => {
    const { rerender } = render(
      <CodeMirrorEditor
        fileId="/project/app.py"
        filename="app.py"
        content="x = 1"
        openFileIds={['/project/app.py']}
      />
    );

    act(() => {
      useIDEStore.getState().setWorkspace({ name: 'project', path: '/project' });
      useLSPStore.getState().setServerStatus({
        family: 'python',
        workspace: '/project',
        state: 'ready',
        setupState: 'missing_interpreter',
        action: 'create_venv',
      });
    });

    await waitFor(() => expect(screen.getByText(/no python interpreter/i)).toBeInTheDocument());

    rerender(
      <CodeMirrorEditor
        fileId="/project/README.md"
        filename="README.md"
        content="# Docs"
        openFileIds={['/project/README.md']}
      />
    );

    await waitFor(() =>
      expect(screen.queryByText(/no python interpreter/i)).not.toBeInTheDocument()
    );
  });

  // Regression: clicking a search result for a file that is already open in a
  // BACKGROUND tab must scroll to the target line. The tab's cached scroll
  // position was being restored on activation, overriding the pending
  // navigation, so the file switched but the viewport stayed put.
  it('lets a pending navigation drive the viewport instead of the cached scroll of a background tab', () => {
    const A = '/p/a.ts';
    const B = '/p/b.ts';
    const bContent = Array.from({ length: 50 }, (_, i) => `b line ${i + 1}`).join('\n');
    const shared = { openFileIds: [A, B] };
    const CACHED_SCROLL = 120;

    const { rerender } = render(
      <CodeMirrorEditor fileId={A} filename="a.ts" content={'a\nb\nc'} {...shared} />
    );
    // Show B, scroll it, switch back to A: B is now a cached background tab @120.
    rerender(<CodeMirrorEditor fileId={B} filename="b.ts" content={bContent} {...shared} />);
    lastEditorView!.scrollDOM.scrollTop = CACHED_SCROLL;
    rerender(<CodeMirrorEditor fileId={A} filename="a.ts" content={'a\nb\nc'} {...shared} />);

    lastEditorView!.scrollDOM.scrollTop = 0;
    lastEditorView!.dispatch.mockClear();

    // Queue a navigation to background B, then activate B (as a search-result click does).
    act(() => {
      useIDEStore.getState().requestEditorNavigation(B, 40, 1);
    });
    rerender(<CodeMirrorEditor fileId={B} filename="b.ts" content={bContent} {...shared} />);

    // The navigation still runs (moves the selection)...
    const navDispatch = lastEditorView!.dispatch.mock.calls.find(
      (c) => (c[0] as DispatchSpec).selection
    );
    expect(navDispatch).toBeDefined();
    // ...and the cached scroll must NOT be restored on top of it, or the target
    // line stays off-screen. The pending navigation owns the viewport.
    expect(lastEditorView!.scrollDOM.scrollTop).not.toBe(CACHED_SCROLL);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
