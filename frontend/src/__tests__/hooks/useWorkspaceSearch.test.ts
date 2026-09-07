import { renderHook, act } from '@testing-library/react';
import { useIDEStore } from '../../stores/ideStore';
import { useSearchStore } from '../../stores/searchStore';

// --- Wails App mocks ---
const mockSearchWorkspace = jest.fn();
const mockCancelSearch = jest.fn().mockResolvedValue(undefined);

jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    SearchWorkspace: (...args: unknown[]) => mockSearchWorkspace(...args),
    CancelSearch: (...args: unknown[]) => mockCancelSearch(...args),
  };
});

// Imported after mocks so the hook closes over the mocks above.
import { SEARCH_DEBOUNCE_MS, useWorkspaceSearch } from '../../hooks/useWorkspaceSearch';
import type { SearchResponse } from '../../types/search';

function buildResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    requestId: 'unset',
    status: 'success',
    message: '',
    files: [],
    totalFiles: 0,
    totalLines: 0,
    truncated: false,
    matchCap: 1000,
    durationMs: 4,
    ...overrides,
  };
}

function setWorkspace(path: string | null) {
  if (path === null) {
    useIDEStore.setState({ workspace: null });
  } else {
    useIDEStore.setState({ workspace: { name: 'ws', path } });
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  mockSearchWorkspace.mockReset();
  mockCancelSearch.mockClear();
  mockSearchWorkspace.mockImplementation(async (req: { requestId: string }) =>
    buildResponse({ requestId: req.requestId })
  );
  useSearchStore.setState(useSearchStore.getInitialState());
  setWorkspace(null);
});

afterEach(() => {
  // Drain any pending timers so they don't leak into the next test.
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Type a query, advance past the debounce window, then flush microtasks so
 * the SearchWorkspace promise resolves and the store updates land before
 * assertions run.
 */
async function typeAndDebounce(query: string, ms = SEARCH_DEBOUNCE_MS): Promise<void> {
  act(() => {
    useSearchStore.getState().setQuery(query);
  });
  act(() => {
    jest.advanceTimersByTime(ms);
  });
  await flushMicrotasks();
}

async function toggleOption(
  option: 'regex' | 'caseSensitive' | 'wholeWord',
  value: boolean,
  ms = SEARCH_DEBOUNCE_MS
): Promise<void> {
  act(() => {
    useSearchStore.getState().setOption(option, value);
  });
  act(() => {
    jest.advanceTimersByTime(ms);
  });
  await flushMicrotasks();
}

describe('useWorkspaceSearch', () => {
  it('does not call SearchWorkspace when no workspace is open', async () => {
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');

    expect(mockSearchWorkspace).not.toHaveBeenCalled();
    expect(useSearchStore.getState().uiState).toEqual({ kind: 'no-workspace' });
  });

  it('does not call SearchWorkspace when query is empty or whitespace', async () => {
    setWorkspace('/workspace');
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('   ');

    expect(mockSearchWorkspace).not.toHaveBeenCalled();
    expect(useSearchStore.getState().uiState).toEqual({ kind: 'empty-query' });
  });

  it('calls SearchWorkspace once after the debounce window with the typed query and root', async () => {
    setWorkspace('/workspace');
    renderHook(() => useWorkspaceSearch());

    act(() => {
      useSearchStore.getState().setQuery('alpha');
    });
    expect(mockSearchWorkspace).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(mockSearchWorkspace).toHaveBeenCalledTimes(1);
    const arg = mockSearchWorkspace.mock.calls[0][0];
    expect(arg.root).toBe('/workspace');
    expect(arg.query).toBe('alpha');
    expect(arg.options).toEqual({ regex: false, caseSensitive: false, wholeWord: false });
    expect(typeof arg.requestId).toBe('string');
    expect(arg.requestId.length).toBeGreaterThan(0);
  });

  it('does not re-render its host when query or options change', async () => {
    setWorkspace('/workspace');
    let renderCount = 0;

    renderHook(() => {
      renderCount += 1;
      useWorkspaceSearch();
    });

    expect(renderCount).toBe(1);

    act(() => {
      useSearchStore.getState().setQuery('alpha');
    });
    act(() => {
      useSearchStore.getState().setOption('regex', true);
    });
    act(() => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(renderCount).toBe(1);
    expect(mockSearchWorkspace).toHaveBeenCalledTimes(1);
    expect(mockSearchWorkspace.mock.calls[0][0].options.regex).toBe(true);
  });

  it('coalesces rapid typing into one backend call with the latest query', async () => {
    setWorkspace('/workspace');
    renderHook(() => useWorkspaceSearch());

    act(() => useSearchStore.getState().setQuery('a'));
    act(() => jest.advanceTimersByTime(50));
    act(() => useSearchStore.getState().setQuery('al'));
    act(() => jest.advanceTimersByTime(50));
    act(() => useSearchStore.getState().setQuery('alpha'));
    act(() => jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    await flushMicrotasks();

    expect(mockSearchWorkspace).toHaveBeenCalledTimes(1);
    expect(mockSearchWorkspace.mock.calls[0][0].query).toBe('alpha');
  });

  it('applies a successful response to the store with results state', async () => {
    setWorkspace('/workspace');
    mockSearchWorkspace.mockImplementation(async (req: { requestId: string }) =>
      buildResponse({
        requestId: req.requestId,
        totalFiles: 1,
        totalLines: 1,
        files: [
          {
            path: '/workspace/a.ts',
            relativePath: 'a.ts',
            matches: [{ line: 1, column: 1, text: 'match', submatches: [] }],
          },
        ],
      })
    );
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');

    expect(useSearchStore.getState().uiState.kind).toBe('results');
  });

  it('drops a stale response that arrives after a newer one has been applied', async () => {
    setWorkspace('/workspace');
    // First request: never resolves until we manually resolve it.
    let resolveFirst!: (response: SearchResponse) => void;
    mockSearchWorkspace.mockImplementationOnce(
      () => new Promise<SearchResponse>((resolve) => (resolveFirst = resolve))
    );
    // Second request: resolves immediately with no_matches.
    mockSearchWorkspace.mockImplementationOnce(async (req: { requestId: string }) =>
      buildResponse({ requestId: req.requestId, status: 'no_matches' })
    );
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');
    const firstRequestId = mockSearchWorkspace.mock.calls[0][0].requestId as string;
    expect(useSearchStore.getState().activeRequestId).toBe(firstRequestId);

    // User changes query while first request is still in flight. The second
    // request resolves immediately with no_matches and applies, clearing
    // activeRequestId to null and setting uiState to no-matches.
    await typeAndDebounce('beta');
    expect(mockSearchWorkspace).toHaveBeenCalledTimes(2);
    expect(useSearchStore.getState().uiState.kind).toBe('no-matches');
    expect(useSearchStore.getState().activeRequestId).toBeNull();

    // First request finally resolves with its (now-stale) id and would-be
    // results. Because activeRequestId is null (or any value other than
    // firstRequestId), the response is dropped and uiState stays no-matches.
    await act(async () => {
      resolveFirst(
        buildResponse({
          requestId: firstRequestId,
          totalFiles: 999,
          files: [
            {
              path: '/workspace/stale.ts',
              relativePath: 'stale.ts',
              matches: [{ line: 1, column: 1, text: 'stale', submatches: [] }],
            },
          ],
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useSearchStore.getState().uiState.kind).toBe('no-matches');
  });

  it('cancels an in-flight request when the query changes', async () => {
    setWorkspace('/workspace');
    mockSearchWorkspace.mockImplementation(() => new Promise<SearchResponse>(() => {}));
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');
    const firstRequestId = useSearchStore.getState().activeRequestId;
    expect(firstRequestId).not.toBeNull();

    act(() => {
      useSearchStore.getState().setQuery('beta');
    });

    expect(mockCancelSearch).toHaveBeenCalledWith(firstRequestId);
    expect(mockSearchWorkspace).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(mockSearchWorkspace).toHaveBeenCalledTimes(2);
    expect(mockSearchWorkspace.mock.calls[1][0].query).toBe('beta');
    expect(useSearchStore.getState().activeRequestId).toBe(
      mockSearchWorkspace.mock.calls[1][0].requestId
    );
  });

  it('cancels an in-flight request when search options change', async () => {
    setWorkspace('/workspace');
    mockSearchWorkspace.mockImplementation(() => new Promise<SearchResponse>(() => {}));
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');
    const firstRequestId = useSearchStore.getState().activeRequestId;
    expect(firstRequestId).not.toBeNull();

    act(() => {
      useSearchStore.getState().setOption('regex', true);
    });

    expect(mockCancelSearch).toHaveBeenCalledWith(firstRequestId);
    expect(mockSearchWorkspace).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(mockSearchWorkspace).toHaveBeenCalledTimes(2);
    expect(mockSearchWorkspace.mock.calls[1][0].query).toBe('alpha');
    expect(mockSearchWorkspace.mock.calls[1][0].options.regex).toBe(true);
  });

  it('cancels the in-flight request when the workspace switches', async () => {
    setWorkspace('/workspace-a');
    mockSearchWorkspace.mockImplementation(
      () => new Promise<SearchResponse>(() => {}) // never resolves
    );
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');
    const inflightRequestId = useSearchStore.getState().activeRequestId;
    expect(inflightRequestId).not.toBeNull();

    act(() => {
      setWorkspace('/workspace-b');
    });
    await flushMicrotasks();

    expect(mockCancelSearch).toHaveBeenCalledWith(inflightRequestId);
    expect(useSearchStore.getState().query).toBe('');
    expect(useSearchStore.getState().activeRequestId).toBeNull();
  });

  it('cancels the in-flight request on unmount', async () => {
    setWorkspace('/workspace');
    mockSearchWorkspace.mockImplementation(() => new Promise<SearchResponse>(() => {}));
    const { unmount } = renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');
    const inflightRequestId = useSearchStore.getState().activeRequestId;
    expect(inflightRequestId).not.toBeNull();

    unmount();

    expect(mockCancelSearch).toHaveBeenCalledWith(inflightRequestId);
  });

  it('does not call SearchWorkspace if the user clears the query during the debounce window', async () => {
    setWorkspace('/workspace');
    renderHook(() => useWorkspaceSearch());

    act(() => useSearchStore.getState().setQuery('alpha'));
    act(() => jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 50));
    act(() => useSearchStore.getState().setQuery(''));
    act(() => jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    await flushMicrotasks();

    expect(mockSearchWorkspace).not.toHaveBeenCalled();
    expect(mockCancelSearch).not.toHaveBeenCalled();
    expect(useSearchStore.getState().uiState).toEqual({ kind: 'empty-query' });
  });

  it('cancels the in-flight request when the user clears the query', async () => {
    setWorkspace('/workspace');
    mockSearchWorkspace.mockImplementation(() => new Promise<SearchResponse>(() => {}));
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');
    const inflightRequestId = useSearchStore.getState().activeRequestId;
    expect(inflightRequestId).not.toBeNull();

    act(() => {
      useSearchStore.getState().setQuery('');
    });
    await flushMicrotasks();

    expect(mockCancelSearch).toHaveBeenCalledWith(inflightRequestId);
    expect(mockSearchWorkspace).toHaveBeenCalledTimes(1);
    expect(useSearchStore.getState().uiState).toEqual({ kind: 'empty-query' });
    expect(useSearchStore.getState().activeRequestId).toBeNull();

    act(() => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await flushMicrotasks();

    expect(mockSearchWorkspace).toHaveBeenCalledTimes(1);
  });

  it('routes a SearchWorkspace rejection to failSearch with the error message', async () => {
    setWorkspace('/workspace');
    mockSearchWorkspace.mockImplementation(async () => {
      throw new Error('rg crashed');
    });
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');

    expect(useSearchStore.getState().uiState).toEqual({
      kind: 'failed',
      message: 'rg crashed',
    });
    expect(useSearchStore.getState().activeRequestId).toBeNull();
  });

  it('retriggers a search when an option toggles', async () => {
    setWorkspace('/workspace');
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');
    expect(mockSearchWorkspace).toHaveBeenCalledTimes(1);

    await toggleOption('regex', true);

    expect(mockSearchWorkspace).toHaveBeenCalledTimes(2);
    expect(mockSearchWorkspace.mock.calls[1][0].options.regex).toBe(true);
  });

  it('maps a missing_tool response to the missing-tool UI state', async () => {
    setWorkspace('/workspace');
    mockSearchWorkspace.mockImplementation(async (req: { requestId: string }) =>
      buildResponse({ requestId: req.requestId, status: 'missing_tool', message: 'install rg' })
    );
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');

    expect(useSearchStore.getState().uiState).toEqual({
      kind: 'missing-tool',
      message: 'install rg',
    });
  });

  it('maps an invalid_regex response to the invalid-regex UI state', async () => {
    setWorkspace('/workspace');
    mockSearchWorkspace.mockImplementation(async (req: { requestId: string }) =>
      buildResponse({
        requestId: req.requestId,
        status: 'invalid_regex',
        message: 'unclosed group',
      })
    );
    renderHook(() => useWorkspaceSearch());

    act(() => {
      useSearchStore.getState().setOption('regex', true);
    });
    await typeAndDebounce('(unclosed');

    expect(useSearchStore.getState().uiState).toEqual({
      kind: 'invalid-regex',
      message: 'unclosed group',
    });
  });

  it('narrows an unknown status to failed so the UI surfaces the issue', async () => {
    setWorkspace('/workspace');
    mockSearchWorkspace.mockImplementation(async (req: { requestId: string }) => ({
      ...buildResponse({ requestId: req.requestId }),
      // Cast through unknown so TS lets us inject a status the union doesn't model.
      status: 'mystery_state' as unknown as SearchResponse['status'],
      message: '',
    }));
    renderHook(() => useWorkspaceSearch());

    await typeAndDebounce('alpha');

    const state = useSearchStore.getState().uiState;
    expect(state.kind).toBe('failed');
    if (state.kind === 'failed') {
      expect(state.message).toContain('mystery_state');
    }
  });
});
