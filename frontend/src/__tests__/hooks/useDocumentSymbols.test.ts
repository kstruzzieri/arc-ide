import { renderHook, act } from '@testing-library/react';
import { useIDEStore } from '../../stores/ideStore';
import { useLSPStore, type LSPServerStatus } from '../../stores/lspStore';

const mockDocumentSymbol = jest.fn();
const mockFlush = jest.fn().mockResolvedValue(true);

jest.mock('../../wails/bindings', () => ({
  LSPDocumentSymbol: (...args: unknown[]) => mockDocumentSymbol(...args),
}));

jest.mock('../../utils/lspDocumentSync', () => ({
  flushLSPDocumentChange: (...args: unknown[]) => mockFlush(...args),
}));

import { useDocumentSymbols, STRUCTURE_FETCH_DEBOUNCE_MS } from '../../hooks/useDocumentSymbols';

const RANGE = { start: { line: 3, character: 2 }, end: { line: 5, character: 1 } };
const SYMBOLS = [{ name: 'Widget', kind: 5, range: RANGE, selectionRange: RANGE, children: [] }];

function setActiveFile(path: string | null, content = 'x') {
  const file = path
    ? [
        {
          id: path,
          name: path.split('/').pop()!,
          path,
          language: 'typescript',
          encoding: 'utf-8',
          lineEndings: 'lf',
          content,
          isModified: false,
        },
      ]
    : [];
  act(() => {
    useIDEStore.setState({ openFiles: file as never, activeFileId: path });
  });
}

function setServer(
  status: Partial<LSPServerStatus> & {
    workspace: string;
    family: string;
    state: LSPServerStatus['state'];
  }
) {
  act(() => {
    useLSPStore.getState().setServerStatus(status as LSPServerStatus);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockDocumentSymbol.mockReset();
  mockDocumentSymbol.mockResolvedValue(SYMBOLS);
  mockFlush.mockClear();
  useLSPStore.getState().clearAllStatuses();
  setActiveFile(null);
});

afterEach(() => {
  jest.useRealTimers();
});

// Advance timers and flush the microtask queue so awaited promises resolve.
async function flushAsync(ms = STRUCTURE_FETCH_DEBOUNCE_MS) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

it('reports no-file when nothing is open', () => {
  const { result } = renderHook(() => useDocumentSymbols());
  expect(result.current.status).toBe('no-file');
  expect(mockDocumentSymbol).not.toHaveBeenCalled();
});

it('reports unsupported for a file with no known LSP family', async () => {
  setActiveFile('/ws/notes.txt');
  const { result } = renderHook(() => useDocumentSymbols());
  await flushAsync();
  expect(result.current.status).toBe('unsupported');
  expect(mockDocumentSymbol).not.toHaveBeenCalled();
});

it('reports lsp-unavailable when no ready server covers the file', async () => {
  setActiveFile('/ws/main.ts');
  setServer({ workspace: '/ws', family: 'typescript', state: 'starting' });
  const { result } = renderHook(() => useDocumentSymbols());
  await flushAsync();
  expect(result.current.status).toBe('lsp-unavailable');
  expect(mockDocumentSymbol).not.toHaveBeenCalled();
});

it('fetches and reports ready with symbols when a server is ready', async () => {
  setActiveFile('/ws/main.ts');
  setServer({ workspace: '/ws', family: 'typescript', state: 'ready' });
  const { result } = renderHook(() => useDocumentSymbols());
  await flushAsync();
  expect(mockFlush).toHaveBeenCalledWith('/ws/main.ts');
  expect(mockDocumentSymbol).toHaveBeenCalledWith('/ws/main.ts');
  expect(result.current.status).toBe('ready');
  expect(result.current.symbols).toHaveLength(1);
  expect(result.current.symbols[0].name).toBe('Widget');
});

it('reports empty when the server returns no symbols', async () => {
  mockDocumentSymbol.mockResolvedValue([]);
  setActiveFile('/ws/main.ts');
  setServer({ workspace: '/ws', family: 'typescript', state: 'ready' });
  const { result } = renderHook(() => useDocumentSymbols());
  await flushAsync();
  expect(result.current.status).toBe('empty');
});

it('reports empty when the server returns null', async () => {
  mockDocumentSymbol.mockResolvedValue(null);
  setActiveFile('/ws/main.ts');
  setServer({ workspace: '/ws', family: 'typescript', state: 'ready' });
  const { result } = renderHook(() => useDocumentSymbols());
  await flushAsync();
  expect(result.current.status).toBe('empty');
});

it('reports error when the request fails', async () => {
  mockDocumentSymbol.mockRejectedValue(new Error('boom'));
  setActiveFile('/ws/main.ts');
  setServer({ workspace: '/ws', family: 'typescript', state: 'ready' });
  const { result } = renderHook(() => useDocumentSymbols());
  await flushAsync();
  expect(result.current.status).toBe('error');
});

it('drops a stale response when the active file changed mid-flight', async () => {
  setServer({ workspace: '/ws', family: 'typescript', state: 'ready' });

  // File A resolves slowly with A's symbols; File B resolves fast with B's.
  const slow = [{ name: 'FromA', kind: 12, range: RANGE, selectionRange: RANGE, children: [] }];
  const fast = [{ name: 'FromB', kind: 12, range: RANGE, selectionRange: RANGE, children: [] }];
  mockDocumentSymbol.mockImplementation((path: string) => {
    if (path === '/ws/a.ts') return new Promise((r) => setTimeout(() => r(slow), 500));
    return Promise.resolve(fast);
  });

  setActiveFile('/ws/a.ts');
  const { result, rerender } = renderHook(() => useDocumentSymbols());
  await flushAsync(0); // kick off A's (slow) fetch

  // Switch to B before A resolves.
  setActiveFile('/ws/b.ts');
  rerender();
  await flushAsync(0); // B resolves fast
  expect(result.current.symbols[0]?.name).toBe('FromB');

  // Now let A's slow response arrive — it must be discarded.
  await flushAsync(500);
  expect(result.current.symbols[0]?.name).toBe('FromB');
  expect(result.current.filePath).toBe('/ws/b.ts');
});

it('re-fetches when refresh() is called', async () => {
  setActiveFile('/ws/main.ts');
  setServer({ workspace: '/ws', family: 'typescript', state: 'ready' });
  const { result } = renderHook(() => useDocumentSymbols());
  await flushAsync();
  expect(mockDocumentSymbol).toHaveBeenCalledTimes(1);

  // refresh() bumps state; let the re-render commit its effect (which schedules
  // the fetch timer) before advancing timers.
  act(() => {
    result.current.refresh();
  });
  await flushAsync(0);
  expect(mockDocumentSymbol).toHaveBeenCalledTimes(2);
});
