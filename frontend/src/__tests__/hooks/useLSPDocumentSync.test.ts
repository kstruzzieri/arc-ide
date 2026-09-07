import { renderHook, act } from '@testing-library/react';
import { useIDEStore } from '../../stores/ideStore';
import { EventsOn } from '../../wails/runtime';

const mockEventsOn = EventsOn as jest.Mock;

// Mock Wails LSP bindings
const mockDidOpen = jest.fn().mockResolvedValue(undefined);
const mockDidChange = jest.fn().mockResolvedValue(undefined);
const mockDidSave = jest.fn().mockResolvedValue(undefined);
const mockDidClose = jest.fn().mockResolvedValue(undefined);

jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    LSPDidOpen: (...args: unknown[]) => mockDidOpen(...args),
    LSPDidChange: (...args: unknown[]) => mockDidChange(...args),
    LSPDidSave: (...args: unknown[]) => mockDidSave(...args),
    LSPDidClose: (...args: unknown[]) => mockDidClose(...args),
  };
});

// Import after mocks
import { useLSPDocumentSync } from '../../hooks/useLSPDocumentSync';
import { resetLSPDocumentSyncState } from '../../utils/lspDocumentSync';

beforeEach(() => {
  jest.useFakeTimers();
  mockDidOpen.mockClear();
  mockDidChange.mockClear();
  mockDidSave.mockClear();
  mockDidClose.mockClear();
  mockEventsOn.mockClear();
  resetLSPDocumentSyncState();
  // Reset EventsOn to default: returns a cleanup function
  mockEventsOn.mockImplementation(() => jest.fn());
  useIDEStore.setState({
    openFiles: [],
    activeFileId: null,
    workspace: { name: 'test', path: '/test/workspace' },
  });
});

afterEach(() => {
  jest.useRealTimers();
});

function openTestFile(overrides = {}) {
  const file = {
    id: '/test/workspace/main.ts',
    name: 'main.ts',
    path: '/test/workspace/main.ts',
    language: 'typescript',
    encoding: 'utf-8',
    lineEndings: 'LF',
    content: 'const x = 1;',
    isModified: false,
    ...overrides,
  };
  useIDEStore.getState().openFile(file);
  return file;
}

describe('useLSPDocumentSync', () => {
  describe('didOpen', () => {
    it('should send didOpen when a TS file is opened', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1);
      expect(mockDidOpen).toHaveBeenCalledWith(
        '/test/workspace/main.ts',
        'typescript',
        1,
        'const x = 1;'
      );
    });

    it('should not send didOpen for unsupported file types', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile({
          id: '/test/workspace/readme.md',
          name: 'readme.md',
          path: '/test/workspace/readme.md',
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).not.toHaveBeenCalled();
    });

    it('should not send duplicate didOpen for the same file', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Close and reopen should send didClose then didOpen
      act(() => {
        useIDEStore.getState().closeFile('/test/workspace/main.ts');
      });

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(2);
      expect(mockDidClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('didChange', () => {
    it('should send debounced didChange when content changes', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Simulate content change
      act(() => {
        useIDEStore.getState().updateFileContent('/test/workspace/main.ts', 'const x = 2;');
      });

      // Should not have sent yet (debounce)
      expect(mockDidChange).not.toHaveBeenCalled();

      // Advance past 150ms debounce
      act(() => {
        jest.advanceTimersByTime(200);
      });

      expect(mockDidChange).toHaveBeenCalledTimes(1);
      expect(mockDidChange).toHaveBeenCalledWith(
        '/test/workspace/main.ts',
        2,
        expect.arrayContaining([expect.objectContaining({ text: 'const x = 2;' })])
      );
    });

    it('should coalesce rapid changes into one didChange', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Three rapid changes
      act(() => {
        useIDEStore.getState().updateFileContent('/test/workspace/main.ts', 'const x = 2;');
      });
      act(() => {
        jest.advanceTimersByTime(50);
        useIDEStore.getState().updateFileContent('/test/workspace/main.ts', 'const x = 3;');
      });
      act(() => {
        jest.advanceTimersByTime(50);
        useIDEStore.getState().updateFileContent('/test/workspace/main.ts', 'const x = 4;');
      });

      // Advance past debounce from last change
      act(() => {
        jest.advanceTimersByTime(200);
      });

      // Only the final content should be sent
      expect(mockDidChange).toHaveBeenCalledTimes(1);
      expect(mockDidChange).toHaveBeenCalledWith(
        '/test/workspace/main.ts',
        expect.any(Number),
        expect.arrayContaining([expect.objectContaining({ text: 'const x = 4;' })])
      );
    });
  });

  describe('didSave', () => {
    it('should send didSave when isModified transitions to false', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Simulate edit then save
      act(() => {
        useIDEStore.getState().updateFileContent('/test/workspace/main.ts', 'const x = 2;');
      });

      act(() => {
        useIDEStore.getState().setFileModified('/test/workspace/main.ts', false);
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidSave).toHaveBeenCalledTimes(1);
      expect(mockDidSave).toHaveBeenCalledWith('/test/workspace/main.ts');
    });
  });

  describe('didClose', () => {
    it('should send didClose when a tab is closed', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        useIDEStore.getState().closeFile('/test/workspace/main.ts');
      });

      expect(mockDidClose).toHaveBeenCalledTimes(1);
      expect(mockDidClose).toHaveBeenCalledWith('/test/workspace/main.ts');
    });

    it('should flush pending didChange on close instead of dropping it', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Start a change (creates a pending debounce)
      act(() => {
        useIDEStore.getState().updateFileContent('/test/workspace/main.ts', 'const x = 2;');
      });

      // Close before debounce fires — should flush the pending change
      act(() => {
        useIDEStore.getState().closeFile('/test/workspace/main.ts');
      });

      await act(async () => {
        await Promise.resolve();
      });

      // didChange should have been flushed immediately on close
      expect(mockDidChange).toHaveBeenCalledTimes(1);
      expect(mockDidChange).toHaveBeenCalledWith(
        '/test/workspace/main.ts',
        expect.any(Number),
        expect.arrayContaining([expect.objectContaining({ text: 'const x = 2;' })])
      );
      expect(mockDidClose).toHaveBeenCalledTimes(1);

      // Advancing past the original debounce should NOT send a second didChange
      act(() => {
        jest.advanceTimersByTime(200);
      });

      expect(mockDidChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('workspace switch', () => {
    it('should close all documents when workspace changes', async () => {
      renderHook(() => useLSPDocumentSync());

      // Open two files
      act(() => {
        openTestFile();
        openTestFile({
          id: '/test/workspace/utils.ts',
          name: 'utils.ts',
          path: '/test/workspace/utils.ts',
          content: 'export const y = 2;',
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(2);

      // Switch workspace
      act(() => {
        useIDEStore.setState({
          workspace: { name: 'other', path: '/other/workspace' },
        });
      });

      // Both files should get didClose
      expect(mockDidClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('version tracking', () => {
    it('should increment version numbers monotonically', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Version 1 on open
      expect(mockDidOpen).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        1,
        expect.any(String)
      );

      // Change content
      act(() => {
        useIDEStore.getState().updateFileContent('/test/workspace/main.ts', 'v2');
      });
      act(() => {
        jest.advanceTimersByTime(200);
      });

      // Version 2 on change
      expect(mockDidChange).toHaveBeenCalledWith(expect.any(String), 2, expect.any(Array));

      // Another change
      act(() => {
        useIDEStore.getState().updateFileContent('/test/workspace/main.ts', 'v3');
      });
      act(() => {
        jest.advanceTimersByTime(200);
      });

      // Version 3
      expect(mockDidChange).toHaveBeenLastCalledWith(expect.any(String), 3, expect.any(Array));
    });
  });

  describe('lsp:reconnect', () => {
    function captureReconnectHandler() {
      let reconnectHandler:
        | ((payload: { workspace?: string; documents?: string[] }) => void)
        | null = null;
      mockEventsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'lsp:reconnect') {
          reconnectHandler = handler as typeof reconnectHandler;
        }
        return jest.fn();
      });
      return () => reconnectHandler;
    }

    it('should re-send didOpen for open files after server reconnect', async () => {
      const getReconnectHandler = captureReconnectHandler();

      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1);

      // Simulate server crash recovery — backend emits lsp:reconnect with file URIs
      const reconnectHandler = getReconnectHandler();
      expect(reconnectHandler).not.toBeNull();
      act(() => {
        reconnectHandler!({
          workspace: '/test/workspace',
          documents: ['file:///test/workspace/main.ts'],
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      // didOpen should have been re-sent for the reconnected document
      expect(mockDidOpen).toHaveBeenCalledTimes(2);
      expect(mockDidOpen).toHaveBeenLastCalledWith(
        '/test/workspace/main.ts',
        'typescript',
        expect.any(Number),
        'const x = 1;'
      );
    });

    it('should not re-send didOpen for files not in the reconnect list', async () => {
      const getReconnectHandler = captureReconnectHandler();

      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1);

      // Reconnect with a different file — our open file should NOT get re-opened
      const reconnectHandler = getReconnectHandler();
      act(() => {
        reconnectHandler!({
          documents: ['file:///test/workspace/other.ts'],
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1); // no additional didOpen
    });

    it('should ignore reconnect events from a non-active workspace', async () => {
      const getReconnectHandler = captureReconnectHandler();

      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1);

      const reconnectHandler = getReconnectHandler();
      act(() => {
        reconnectHandler!({
          workspace: '/other/workspace',
          documents: ['file:///test/workspace/main.ts'],
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1);
    });

    it('should re-send didOpen when reconnect workspace is a nested project root', async () => {
      // After PR #95, backend emits payload.workspace as the detected TS
      // project root (e.g. /repo/packages/ui), not the active workspace
      // (/repo). Equality-based filtering dropped these events and left
      // restarted servers with no open documents until the file was reopened.
      const getReconnectHandler = captureReconnectHandler();

      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile({
          id: '/test/workspace/packages/ui/main.ts',
          name: 'main.ts',
          path: '/test/workspace/packages/ui/main.ts',
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1);

      const reconnectHandler = getReconnectHandler();
      act(() => {
        reconnectHandler!({
          workspace: '/test/workspace/packages/ui',
          documents: ['file:///test/workspace/packages/ui/main.ts'],
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(2);
      expect(mockDidOpen).toHaveBeenLastCalledWith(
        '/test/workspace/packages/ui/main.ts',
        'typescript',
        expect.any(Number),
        'const x = 1;'
      );
    });

    it('should match reconnect URIs with percent-encoded Unix paths', async () => {
      const getReconnectHandler = captureReconnectHandler();

      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile({
          id: '/test/workspace/file with #hash.ts',
          name: 'file with #hash.ts',
          path: '/test/workspace/file with #hash.ts',
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1);

      const reconnectHandler = getReconnectHandler();
      act(() => {
        reconnectHandler!({
          documents: ['file:///test/workspace/file%20with%20%23hash.ts'],
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(2);
      expect(mockDidOpen).toHaveBeenLastCalledWith(
        '/test/workspace/file with #hash.ts',
        'typescript',
        expect.any(Number),
        'const x = 1;'
      );
    });

    it('should match backend reconnect URIs with PathEscape-preserved characters', async () => {
      const getReconnectHandler = captureReconnectHandler();

      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile({
          id: '/test/workspace/a&b+c=d$e@f:main.ts',
          name: 'a&b+c=d$e@f:main.ts',
          path: '/test/workspace/a&b+c=d$e@f:main.ts',
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1);

      const reconnectHandler = getReconnectHandler();
      act(() => {
        reconnectHandler!({
          documents: ['file:///test/workspace/a&b+c=d$e@f:main.ts'],
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(2);
      expect(mockDidOpen).toHaveBeenLastCalledWith(
        '/test/workspace/a&b+c=d$e@f:main.ts',
        'typescript',
        expect.any(Number),
        'const x = 1;'
      );
    });

    it('should match reconnect URIs with Windows-style file paths', async () => {
      const getReconnectHandler = captureReconnectHandler();

      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile({
          id: 'C:\\Users\\test\\My Project\\main.ts',
          name: 'main.ts',
          path: 'C:\\Users\\test\\My Project\\main.ts',
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(1);

      const reconnectHandler = getReconnectHandler();
      act(() => {
        reconnectHandler!({
          documents: ['file:///c:/Users/test/My%20Project/main.ts'],
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockDidOpen).toHaveBeenCalledTimes(2);
      expect(mockDidOpen).toHaveBeenLastCalledWith(
        'C:\\Users\\test\\My Project\\main.ts',
        'typescript',
        expect.any(Number),
        'const x = 1;'
      );
    });
  });

  describe('workspace switch flush', () => {
    it('should flush pending didChange for all files before workspace switch closeAll', async () => {
      renderHook(() => useLSPDocumentSync());

      act(() => {
        openTestFile();
        openTestFile({
          id: '/test/workspace/utils.ts',
          name: 'utils.ts',
          path: '/test/workspace/utils.ts',
          content: 'export const y = 2;',
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Start changes on both files (pending debounce)
      act(() => {
        useIDEStore.getState().updateFileContent('/test/workspace/main.ts', 'changed main');
      });
      act(() => {
        useIDEStore.getState().updateFileContent('/test/workspace/utils.ts', 'changed utils');
      });

      // Switch workspace before debounce fires
      act(() => {
        useIDEStore.setState({
          workspace: { name: 'other', path: '/other/workspace' },
        });
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Both pending changes should have been flushed
      expect(mockDidChange).toHaveBeenCalledTimes(2);
      // Both files should get didClose
      expect(mockDidClose).toHaveBeenCalledTimes(2);
    });
  });
});
