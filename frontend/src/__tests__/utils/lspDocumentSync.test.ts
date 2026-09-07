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

import {
  closeLSPDocument,
  flushLSPDocumentChange,
  openLSPDocument,
  resetLSPDocumentSyncState,
  scheduleLSPDocumentChange,
  saveLSPDocument,
  trackedLSPDocumentPaths,
} from '../../utils/lspDocumentSync';

beforeEach(() => {
  jest.useFakeTimers();
  mockDidOpen.mockClear();
  mockDidChange.mockClear();
  mockDidSave.mockClear();
  mockDidClose.mockClear();
  resetLSPDocumentSyncState();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('lspDocumentSync', () => {
  it('flushes the current buffer immediately when a completion request races the debounce', async () => {
    await openLSPDocument(
      '/test/workspace/main.ts',
      'typescript',
      'const features = getFeatures()'
    );

    await flushLSPDocumentChange(
      '/test/workspace/main.ts',
      'const features = getFeatures();\nfeatures.'
    );

    expect(mockDidOpen).toHaveBeenCalledWith(
      '/test/workspace/main.ts',
      'typescript',
      1,
      'const features = getFeatures()'
    );
    expect(mockDidChange).toHaveBeenCalledWith(
      '/test/workspace/main.ts',
      2,
      expect.arrayContaining([
        expect.objectContaining({ text: 'const features = getFeatures();\nfeatures.' }),
      ])
    );
  });

  it('cancels the scheduled debounce after an explicit flush', async () => {
    await openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 1;');

    scheduleLSPDocumentChange('/test/workspace/main.ts', 'const x = 2;');
    await flushLSPDocumentChange('/test/workspace/main.ts');

    expect(mockDidChange).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(300);

    expect(mockDidChange).toHaveBeenCalledTimes(1);
  });

  it('clears stale pending content when an explicit flush is already synced', async () => {
    await openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 1;');

    scheduleLSPDocumentChange('/test/workspace/main.ts', 'const x = 2;');

    await expect(flushLSPDocumentChange('/test/workspace/main.ts', 'const x = 1;')).resolves.toBe(
      false
    );
    await expect(flushLSPDocumentChange('/test/workspace/main.ts')).resolves.toBe(false);

    expect(mockDidChange).not.toHaveBeenCalled();
  });

  it('flushes the latest pending content when didOpen is still in flight', async () => {
    let resolveOpen: () => void = () => {};
    mockDidOpen.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveOpen = resolve;
      })
    );

    const openPromise = openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 1;');
    await Promise.resolve();

    scheduleLSPDocumentChange('/test/workspace/main.ts', 'const x = 2;');
    const flushPromise = flushLSPDocumentChange('/test/workspace/main.ts');
    scheduleLSPDocumentChange('/test/workspace/main.ts', 'const x = 3;');

    resolveOpen();
    await openPromise;
    await flushPromise;

    expect(mockDidChange).toHaveBeenCalledTimes(1);
    expect(mockDidChange).toHaveBeenCalledWith(
      '/test/workspace/main.ts',
      2,
      expect.arrayContaining([expect.objectContaining({ text: 'const x = 3;' })])
    );
  });

  it('keeps newer pending content when an explicit flush waits for didOpen', async () => {
    let resolveOpen: () => void = () => {};
    mockDidOpen.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveOpen = resolve;
      })
    );

    const openPromise = openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 1;');
    await Promise.resolve();

    const flushPromise = flushLSPDocumentChange('/test/workspace/main.ts', 'const x = 2;');
    scheduleLSPDocumentChange('/test/workspace/main.ts', 'const x = 3;');

    resolveOpen();
    await openPromise;
    await flushPromise;

    expect(mockDidChange).toHaveBeenCalledWith(
      '/test/workspace/main.ts',
      2,
      expect.arrayContaining([expect.objectContaining({ text: 'const x = 2;' })])
    );

    jest.advanceTimersByTime(200);
    await Promise.resolve();

    expect(mockDidChange).toHaveBeenCalledTimes(2);
    expect(mockDidChange).toHaveBeenLastCalledWith(
      '/test/workspace/main.ts',
      3,
      expect.arrayContaining([expect.objectContaining({ text: 'const x = 3;' })])
    );
  });

  it('sends didSave after syncing unsent content', async () => {
    await openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 1;');

    scheduleLSPDocumentChange('/test/workspace/main.ts', 'const x = 2;');
    await saveLSPDocument('/test/workspace/main.ts', 'const x = 2;');

    expect(mockDidChange).toHaveBeenCalledTimes(1);
    expect(mockDidSave).toHaveBeenCalledWith('/test/workspace/main.ts');
    expect(mockDidChange.mock.invocationCallOrder[0]).toBeLessThan(
      mockDidSave.mock.invocationCallOrder[0]
    );
  });

  it('sends didClose with the latest content on close', async () => {
    await openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 1;');

    scheduleLSPDocumentChange('/test/workspace/main.ts', 'const x = 2;');
    await closeLSPDocument('/test/workspace/main.ts', 'const x = 2;');

    expect(mockDidChange).toHaveBeenCalledTimes(1);
    expect(mockDidClose).toHaveBeenCalledWith('/test/workspace/main.ts');
    expect(mockDidChange.mock.invocationCallOrder[0]).toBeLessThan(
      mockDidClose.mock.invocationCallOrder[0]
    );
  });

  it('waits for an in-flight close before reopening the same path', async () => {
    let resolveClose: () => void = () => {};
    mockDidClose.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveClose = resolve;
      })
    );

    await openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 1;');

    const closePromise = closeLSPDocument('/test/workspace/main.ts');
    const reopenPromise = openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 2;');

    await Promise.resolve();

    expect(mockDidClose).toHaveBeenCalledTimes(1);
    expect(mockDidOpen).toHaveBeenCalledTimes(1);

    resolveClose();
    await closePromise;
    await reopenPromise;

    expect(mockDidOpen).toHaveBeenCalledTimes(2);
    expect(mockDidClose.mock.invocationCallOrder[0]).toBeLessThan(
      mockDidOpen.mock.invocationCallOrder[1]
    );
    expect(mockDidOpen).toHaveBeenLastCalledWith(
      '/test/workspace/main.ts',
      'typescript',
      2,
      'const x = 2;'
    );
  });

  it('does not save a reopened document from a stale in-flight save', async () => {
    let resolveOpen: () => void = () => {};
    mockDidOpen.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveOpen = resolve;
      })
    );

    const openPromise = openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 1;');
    await Promise.resolve();

    const savePromise = saveLSPDocument('/test/workspace/main.ts', 'const x = 2;');
    const closePromise = closeLSPDocument('/test/workspace/main.ts', 'const x = 2;');
    const reopenPromise = openLSPDocument('/test/workspace/main.ts', 'typescript', 'const y = 1;');

    resolveOpen();
    await openPromise;
    await closePromise;
    await reopenPromise;
    await savePromise;

    expect(mockDidOpen).toHaveBeenCalledTimes(2);
    expect(mockDidClose).toHaveBeenCalledTimes(1);
    expect(mockDidSave).not.toHaveBeenCalled();
  });

  it('does not leave a tracked document after didOpen fails', async () => {
    mockDidOpen.mockRejectedValueOnce(new Error('server unavailable'));

    await expect(
      openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 1;')
    ).rejects.toThrow('server unavailable');

    expect(trackedLSPDocumentPaths()).toEqual([]);

    await closeLSPDocument('/test/workspace/main.ts');
    expect(mockDidClose).not.toHaveBeenCalled();

    await openLSPDocument('/test/workspace/main.ts', 'typescript', 'const x = 2;');
    expect(mockDidOpen).toHaveBeenCalledTimes(2);
  });
});
