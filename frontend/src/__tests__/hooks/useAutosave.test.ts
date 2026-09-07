import { renderHook, act } from '@testing-library/react';
import { useIDEStore } from '../../stores/ideStore';

// Mock Wails WriteFile
const mockWriteFile = jest.fn().mockResolvedValue(undefined);
jest.mock('../../wails/bindings', () => ({
  WriteFile: (...args: unknown[]) => mockWriteFile(...args),
}));

// Import after mocks
import { useAutosave } from '../../hooks/useAutosave';

beforeEach(() => {
  jest.useFakeTimers();
  mockWriteFile.mockClear();
  useIDEStore.setState({
    openFiles: [],
    activeFileId: null,
    toast: null,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

function openTestFile(overrides = {}) {
  useIDEStore.getState().openFile({
    id: '/test/file.ts',
    name: 'file.ts',
    path: '/test/file.ts',
    language: 'typescript',
    encoding: 'utf-8',
    lineEndings: 'LF',
    content: 'original',
    isModified: false,
    ...overrides,
  });
  useIDEStore.setState({ activeFileId: '/test/file.ts' });
}

describe('useAutosave', () => {
  it('should save file after idle timeout', async () => {
    openTestFile();
    renderHook(() => useAutosave());

    // Simulate content change
    act(() => {
      useIDEStore.getState().updateFileContent('/test/file.ts', 'modified');
    });

    // Advance past debounce
    act(() => {
      jest.advanceTimersByTime(1600);
    });

    // Wait for async WriteFile
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockWriteFile).toHaveBeenCalledWith('/test/file.ts', 'modified', 'utf-8', 'LF', false);
  });

  it('should clear modified flag after successful save', async () => {
    openTestFile();
    renderHook(() => useAutosave());

    act(() => {
      useIDEStore.getState().updateFileContent('/test/file.ts', 'modified');
    });

    act(() => {
      jest.advanceTimersByTime(1600);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const file = useIDEStore.getState().openFiles[0];
    expect(file.isModified).toBe(false);
  });

  it('writes a newer buffer revision that arrives while a save is in flight', async () => {
    let resolveFirst!: () => void;
    mockWriteFile
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(undefined);
    openTestFile();
    renderHook(() => useAutosave());

    act(() => useIDEStore.getState().updateFileContent('/test/file.ts', 'first edit'));
    act(() => jest.advanceTimersByTime(1600));
    await act(async () => Promise.resolve());
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    act(() => useIDEStore.getState().updateFileContent('/test/file.ts', 'second edit'));
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile.mock.calls[1][1]).toBe('second edit');
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(false);
  });

  it('should show toast on save failure', async () => {
    mockWriteFile.mockRejectedValueOnce(new Error('Permission denied'));
    openTestFile();
    renderHook(() => useAutosave());

    act(() => {
      useIDEStore.getState().updateFileContent('/test/file.ts', 'modified');
    });

    act(() => {
      jest.advanceTimersByTime(1600);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const toast = useIDEStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast?.type).toBe('error');
  });

  it('re-arms the debounce after a failed save so autosave keeps trying', async () => {
    // A transient failure (file locked, disk full) must not permanently
    // disable autosave: scheduling is transition-based (isModified false ->
    // true), and a failed save leaves the flag true, so without a re-arm no
    // later keystroke would ever schedule another save.
    mockWriteFile.mockRejectedValueOnce(new Error('EBUSY'));
    openTestFile();
    renderHook(() => useAutosave());

    act(() => {
      useIDEStore.getState().updateFileContent('/test/file.ts', 'modified');
    });
    act(() => {
      jest.advanceTimersByTime(1600);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    // No further edits: the retry must fire on its own.
    act(() => {
      jest.advanceTimersByTime(1600);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(false);
  });

  it('should not save unmodified files', () => {
    openTestFile();
    renderHook(() => useAutosave());

    // No content change, just advance time
    act(() => {
      jest.advanceTimersByTime(5000);
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('should save dirty file when tab is closed before debounce fires', async () => {
    openTestFile();
    renderHook(() => useAutosave());

    // Modify file content (triggers debounce timer)
    act(() => {
      useIDEStore.getState().updateFileContent('/test/file.ts', 'unsaved changes');
    });

    // Close the tab before the debounce fires — the file leaves openFiles while dirty
    act(() => {
      useIDEStore.getState().closeFile('/test/file.ts');
    });

    // The save should happen immediately using the captured content from before removal
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/test/file.ts',
      'unsaved changes',
      'utf-8',
      'LF',
      false
    );
  });
});
