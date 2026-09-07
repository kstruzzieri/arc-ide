import { renderHook, act } from '@testing-library/react';
import { useLSPEvents } from '../../hooks/useLSPEvents';
import { useLSPStore } from '../../stores/lspStore';
import { useIDEStore } from '../../stores/ideStore';
import { EventsOn } from '../../wails/runtime';

const mockEventsOn = EventsOn as jest.MockedFunction<typeof EventsOn>;

function captureEventHandlers() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  mockEventsOn.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
    handlers[event] = callback;
    return jest.fn(); // cancel function
  });
  return handlers;
}

function setActiveWorkspace(path = '/project') {
  useIDEStore.getState().setWorkspace({ name: path.split('/').pop() || path, path });
}

beforeEach(() => {
  jest.clearAllMocks();
  useLSPStore.setState(useLSPStore.getInitialState());
  useIDEStore.setState(useIDEStore.getInitialState());
});

describe('useLSPEvents', () => {
  it('subscribes to lsp:diagnostics, lsp:status, and lsp:error', () => {
    renderHook(() => useLSPEvents());

    const events = mockEventsOn.mock.calls.map((call) => call[0]);
    expect(events).toContain('lsp:diagnostics');
    expect(events).toContain('lsp:status');
    expect(events).toContain('lsp:error');
  });

  it('updates lspStore on lsp:diagnostics event', () => {
    const handlers = captureEventHandlers();
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:diagnostics']({
        workspace: '/project',
        uri: 'file:///test.ts',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: 'Type error',
          },
        ],
      });
    });

    const diags = useLSPStore.getState().diagnostics.get('file:///test.ts');
    expect(diags).toHaveLength(1);
    expect(diags![0].message).toBe('Type error');
    expect(useLSPStore.getState().errorCount()).toBe(1);
    expect(useLSPStore.getState().warningCount()).toBe(0);
  });

  it('ignores lsp:diagnostics from a different workspace', () => {
    const handlers = captureEventHandlers();
    setActiveWorkspace();
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:diagnostics']({
        workspace: '/other-project',
        uri: 'file:///other/test.ts',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: 'Stale error',
          },
        ],
      });
    });

    expect(useLSPStore.getState().diagnostics.size).toBe(0);
  });

  it('clears LSP state on workspace switch', () => {
    const handlers = captureEventHandlers();
    setActiveWorkspace('/project');
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:diagnostics']({
        workspace: '/project',
        uri: 'file:///project/test.ts',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: 'Type error',
          },
        ],
      });
      handlers['lsp:status']({
        family: 'typescript',
        workspace: '/project',
        state: 'ready',
      });
    });

    expect(useLSPStore.getState().diagnostics.size).toBe(1);
    expect(useLSPStore.getState().serverStatuses.size).toBe(1);

    act(() => {
      useIDEStore.getState().setWorkspace({ name: 'other-project', path: '/other-project' });
    });

    expect(useLSPStore.getState().diagnostics.size).toBe(0);
    expect(useLSPStore.getState().serverStatuses.size).toBe(0);
  });

  it('updates lspStore on lsp:status event', () => {
    const handlers = captureEventHandlers();
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:status']({
        family: 'typescript',
        workspace: '/project',
        command: '/project/node_modules/.bin/typescript-language-server',
        state: 'ready',
      });
    });

    const status = useLSPStore.getState().serverStatuses.get('/project::typescript');
    expect(status?.state).toBe('ready');
    expect(status?.command).toBe('/project/node_modules/.bin/typescript-language-server');
  });

  it('ignores lsp:status from a different workspace', () => {
    const handlers = captureEventHandlers();
    setActiveWorkspace('/project');
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:status']({
        family: 'typescript',
        workspace: '/other-project',
        state: 'error',
        error: 'stale server error',
      });
    });

    expect(useLSPStore.getState().serverStatuses.size).toBe(0);
    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('shows Toast on lsp:status with state=error (e.g., missing server binary)', () => {
    const handlers = captureEventHandlers();
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:status']({
        family: 'typescript',
        workspace: '/project',
        state: 'error',
        error:
          'typescript-language-server not found: install it with "npm install -g typescript-language-server typescript"',
      });
    });

    const toast = useIDEStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast!.type).toBe('error');
    expect(toast!.message).toContain('typescript-language-server not found');
  });

  it('does not show a raw Toast when lsp:status carries typed setup status', () => {
    const handlers = captureEventHandlers();
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:status']({
        family: 'python',
        workspace: '/project',
        state: 'error',
        error: 'pyright-langserver not found: install it with "npm install -g pyright"',
        setupState: 'missing_server',
        detailCode: 'server_not_found',
      });
    });

    const status = useLSPStore.getState().serverStatuses.get('/project::python');
    expect(status?.setupState).toBe('missing_server');
    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('does not show Toast on non-error lsp:status events', () => {
    const handlers = captureEventHandlers();
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:status']({
        family: 'typescript',
        workspace: '/project',
        state: 'ready',
      });
    });

    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('does not show duplicate Toast for same error', () => {
    const handlers = captureEventHandlers();
    renderHook(() => useLSPEvents());

    // First error status — should set toast
    act(() => {
      handlers['lsp:status']({
        family: 'typescript',
        workspace: '/project',
        state: 'error',
        error: 'server crashed, restarting in 1s (attempt 1/5)',
      });
    });

    const firstToast = useIDEStore.getState().toast;
    expect(firstToast).not.toBeNull();

    // Clear the toast to detect if a second one is set
    useIDEStore.getState().clearToast();
    expect(useIDEStore.getState().toast).toBeNull();

    // Second error status for same workspace::family — should NOT set toast
    act(() => {
      handlers['lsp:status']({
        family: 'typescript',
        workspace: '/project',
        state: 'error',
        error: 'server crashed, restarting in 2s (attempt 2/5)',
      });
    });

    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('shows Toast on lsp:error event (crash recovery exhausted)', () => {
    const handlers = captureEventHandlers();
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:error']({
        family: 'typescript',
        workspace: '/project',
        message: 'Language server for typescript crashed repeatedly.',
      });
    });

    const toast = useIDEStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast!.type).toBe('error');
    expect(toast!.message).toContain('crashed repeatedly');
  });

  it('ignores lsp:error from a different workspace', () => {
    const handlers = captureEventHandlers();
    setActiveWorkspace('/project');
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:error']({
        family: 'typescript',
        workspace: '/other-project',
        message: 'Language server for typescript crashed repeatedly.',
      });
    });

    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('cleans up subscriptions on unmount', () => {
    const cancelFns = [jest.fn(), jest.fn(), jest.fn()];
    let callIdx = 0;
    mockEventsOn.mockImplementation(() => cancelFns[callIdx++]);

    const { unmount } = renderHook(() => useLSPEvents());
    unmount();

    cancelFns.forEach((fn) => expect(fn).toHaveBeenCalled());
  });

  // --- Project-root containment (#20) ---

  it('accepts lsp:diagnostics from a project root inside the active workspace', () => {
    // Backend now emits diagnostics with workspace = detected project root,
    // which is *inside* the active workspace for TypeScript monorepo files.
    // The stale-event guard must accept these, not just exact matches.
    const handlers = captureEventHandlers();
    setActiveWorkspace('/project');
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:diagnostics']({
        workspace: '/project/frontend',
        uri: 'file:///project/frontend/src/App.tsx',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: 'Type error from nested package',
          },
        ],
      });
    });

    expect(useLSPStore.getState().diagnostics.size).toBe(1);
  });

  it('accepts lsp:status from a project root inside the active workspace', () => {
    const handlers = captureEventHandlers();
    setActiveWorkspace('/project');
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:status']({
        family: 'typescript',
        workspace: '/project/frontend',
        state: 'ready',
      });
    });

    const statuses = useLSPStore.getState().serverStatuses;
    expect(statuses.size).toBe(1);
    expect(Array.from(statuses.values())[0].workspace).toBe('/project/frontend');
  });

  it('rejects lsp:diagnostics whose workspace prefix-collides with the active workspace', () => {
    // /project-other must not be classified as inside /project.
    const handlers = captureEventHandlers();
    setActiveWorkspace('/project');
    renderHook(() => useLSPEvents());

    act(() => {
      handlers['lsp:diagnostics']({
        workspace: '/project-other',
        uri: 'file:///project-other/test.ts',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: 'should not appear',
          },
        ],
      });
    });

    expect(useLSPStore.getState().diagnostics.size).toBe(0);
  });
});
