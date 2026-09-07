jest.mock('../wails/bindings', () => ({
  WriteFile: jest.fn(),
}));

import { WriteFile } from '../wails/bindings';
import { CancellablePromise } from '../wails/runtime';
import {
  flushAllFileEdits,
  isWritableFormat,
  saveOpenFileToDisk,
  writeFileSerialized,
} from './fileWrites';
import { useIDEStore, type EditorFile } from '../stores/ideStore';

const mockWriteFile = WriteFile as jest.MockedFunction<typeof WriteFile>;

const file = (over: Partial<EditorFile> = {}): EditorFile => ({
  id: 'f1',
  name: 'conflicted.ts',
  path: '/repo/src/conflicted.ts',
  language: 'typescript',
  encoding: 'utf-8',
  lineEndings: 'lf',
  content: 'buffer content',
  isModified: true,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
  useIDEStore.setState({ openFiles: [] });
});

describe('isWritableFormat', () => {
  it('accepts the encodings and line endings WriteFile can round-trip', () => {
    expect(isWritableFormat('utf-8', 'lf')).toBe(true);
    expect(isWritableFormat('utf-8-bom', 'crlf')).toBe(true);
    expect(isWritableFormat('utf-16le', 'none')).toBe(true);
  });

  it('rejects formats WriteFile would re-encode lossily', () => {
    expect(isWritableFormat('latin-1', 'lf')).toBe(false);
    expect(isWritableFormat('utf-8', 'mixed')).toBe(false);
    expect(isWritableFormat(undefined, 'lf')).toBe(false);
    expect(isWritableFormat('utf-8', undefined)).toBe(false);
  });
});

describe('saveOpenFileToDisk', () => {
  it('resolves without writing when the file is not open', async () => {
    await saveOpenFileToDisk('/repo/src/conflicted.ts');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('resolves without writing when the open buffer is clean', async () => {
    useIDEStore.setState({ openFiles: [file({ isModified: false })] });
    await saveOpenFileToDisk('/repo/src/conflicted.ts');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it.each([
    ['latin-1', 'lf'],
    ['utf-8', 'cr'],
    ['utf-8', 'mixed'],
  ])('refuses a dirty buffer with unsupported %s/%s format', async (encoding, lineEndings) => {
    useIDEStore.setState({ openFiles: [file({ encoding, lineEndings })] });

    await expect(saveOpenFileToDisk('/repo/src/conflicted.ts')).rejects.toThrow(
      /unsupported file format/i
    );

    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(true);
  });

  it('writes a dirty buffer to disk with its encoding and clears isModified', async () => {
    useIDEStore.setState({ openFiles: [file({ encoding: 'utf-8-bom', lineEndings: 'crlf' })] });

    await saveOpenFileToDisk('/repo/src/conflicted.ts');

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/repo/src/conflicted.ts',
      'buffer content',
      'utf-8-bom',
      'crlf',
      false
    );
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(false);
  });

  it('loops until the buffer is stable when an edit lands mid-write', async () => {
    useIDEStore.setState({ openFiles: [file()] });
    // First write races with a keystroke: mutate the buffer while the write is
    // in flight, so the flush must write again with the newer content.
    mockWriteFile.mockImplementationOnce(() => {
      useIDEStore.setState({
        openFiles: [file({ content: 'newer content', isModified: true })],
      });
      return CancellablePromise.resolve();
    });

    await saveOpenFileToDisk('/repo/src/conflicted.ts');

    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile).toHaveBeenLastCalledWith(
      '/repo/src/conflicted.ts',
      'newer content',
      'utf-8',
      'lf',
      false
    );
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(false);
  });

  it('rewrites a stable buffer after a later queued write', async () => {
    let finishInitialWrite!: () => void;
    let markInitialWriteStarted!: () => void;
    const initialWrite = new CancellablePromise<void>((resolve) => (finishInitialWrite = resolve));
    const initialWriteStarted = new Promise<void>((resolve) => (markInitialWriteStarted = resolve));
    mockWriteFile.mockImplementationOnce(() => {
      markInitialWriteStarted();
      return initialWrite;
    });
    useIDEStore.setState({ openFiles: [file()] });

    const flush = saveOpenFileToDisk('/repo/src/conflicted.ts');
    await initialWriteStarted;
    const staleWrite = writeFileSerialized(
      '/repo/src/conflicted.ts',
      'stale autosave',
      'utf-8',
      'lf',
      false
    );

    finishInitialWrite();
    await Promise.all([flush, staleWrite]);

    expect(mockWriteFile.mock.calls.map((call) => call[1])).toEqual([
      'buffer content',
      'stale autosave',
      'buffer content',
    ]);
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(false);
  });

  it('waits for queued writes before accepting a clean buffer', async () => {
    let finishWrite!: () => void;
    const queuedWrite = new CancellablePromise<void>((resolve) => (finishWrite = resolve));
    mockWriteFile.mockReturnValueOnce(queuedWrite);
    useIDEStore.setState({ openFiles: [file({ isModified: false })] });
    const pending = writeFileSerialized(
      '/repo/src/conflicted.ts',
      'buffer content',
      'utf-8',
      'lf',
      false
    );
    let flushSettled = false;

    const flush = saveOpenFileToDisk('/repo/src/conflicted.ts').then(() => (flushSettled = true));
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeWrite = flushSettled;

    finishWrite();
    await Promise.all([flush, pending]);
    expect(settledBeforeWrite).toBe(false);
  });

  it('waits for a close-triggered queued save before resolving', async () => {
    let finishInitialWrite!: () => void;
    let finishCloseWrite!: () => void;
    let markInitialWriteStarted!: () => void;
    let markCloseWriteStarted!: () => void;
    const initialWrite = new CancellablePromise<void>((resolve) => (finishInitialWrite = resolve));
    const closeWrite = new CancellablePromise<void>((resolve) => (finishCloseWrite = resolve));
    const initialWriteStarted = new Promise<void>((resolve) => (markInitialWriteStarted = resolve));
    const closeWriteStarted = new Promise<void>((resolve) => (markCloseWriteStarted = resolve));
    mockWriteFile
      .mockImplementationOnce(() => {
        markInitialWriteStarted();
        return initialWrite;
      })
      .mockImplementationOnce(() => {
        markCloseWriteStarted();
        return closeWrite;
      });
    useIDEStore.setState({ openFiles: [file()] });

    const flush = saveOpenFileToDisk('/repo/src/conflicted.ts');
    await initialWriteStarted;
    useIDEStore.getState().updateFileContent('f1', 'final edit before close');
    useIDEStore.getState().closeFile('f1');
    const closeSave = writeFileSerialized(
      '/repo/src/conflicted.ts',
      'final edit before close',
      'utf-8',
      'lf',
      false
    );
    let flushSettled = false;
    void flush.then(() => (flushSettled = true));

    finishInitialWrite();
    await closeWriteStarted;
    await Promise.resolve();
    const settledBeforeCloseWrite = flushSettled;
    finishCloseWrite();
    await Promise.all([flush, closeSave]);

    expect(settledBeforeCloseWrite).toBe(false);
    expect(mockWriteFile).toHaveBeenLastCalledWith(
      '/repo/src/conflicted.ts',
      'final edit before close',
      'utf-8',
      'lf',
      false
    );
  });

  it('rejects when a later close-save fails', async () => {
    let finishInitialWrite!: () => void;
    let markInitialWriteStarted!: () => void;
    const initialWrite = new CancellablePromise<void>((resolve) => (finishInitialWrite = resolve));
    const initialWriteStarted = new Promise<void>((resolve) => (markInitialWriteStarted = resolve));
    mockWriteFile
      .mockImplementationOnce(() => {
        markInitialWriteStarted();
        return initialWrite;
      })
      .mockRejectedValueOnce(new Error('close-save failed'));
    useIDEStore.setState({ openFiles: [file()] });

    const flush = saveOpenFileToDisk('/repo/src/conflicted.ts');
    await initialWriteStarted;
    useIDEStore.getState().closeFile('f1');
    const closeSave = writeFileSerialized(
      '/repo/src/conflicted.ts',
      'buffer content',
      'utf-8',
      'lf',
      false
    );
    const results = Promise.allSettled([flush, closeSave]);
    finishInitialWrite();

    const [flushResult, closeResult] = await results;
    expect(flushResult).toMatchObject({
      status: 'rejected',
      reason: new Error('close-save failed'),
    });
    expect(closeResult).toMatchObject({
      status: 'rejected',
      reason: new Error('close-save failed'),
    });
  });

  it('waits for an already queued close-save when the file is absent', async () => {
    let finishWrite!: () => void;
    const queuedWrite = new CancellablePromise<void>((resolve) => (finishWrite = resolve));
    mockWriteFile.mockReturnValueOnce(queuedWrite);
    const closeSave = writeFileSerialized(
      '/repo/src/conflicted.ts',
      'closed content',
      'utf-8',
      'lf',
      false
    );
    let flushSettled = false;

    const flush = saveOpenFileToDisk('/repo/src/conflicted.ts').then(() => (flushSettled = true));
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeCloseWrite = flushSettled;
    finishWrite();
    await Promise.all([flush, closeSave]);

    expect(settledBeforeCloseWrite).toBe(false);
  });

  it('does not clear isModified when the write itself fails', async () => {
    useIDEStore.setState({ openFiles: [file()] });
    mockWriteFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(saveOpenFileToDisk('/repo/src/conflicted.ts')).rejects.toThrow('disk full');
    expect(useIDEStore.getState().openFiles[0].isModified).toBe(true);
  });
});

describe('flushAllFileEdits', () => {
  it('waits for writes that were already queued', async () => {
    let finishWrite!: () => void;
    const queuedWrite = new CancellablePromise<void>((resolve) => (finishWrite = resolve));
    mockWriteFile.mockReturnValueOnce(queuedWrite);
    const save = writeFileSerialized(
      '/repo/src/conflicted.ts',
      'closed content',
      'utf-8',
      'lf',
      false
    );
    let flushSettled = false;

    const flush = flushAllFileEdits().then(() => (flushSettled = true));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const settledBeforeWrite = flushSettled;
    finishWrite();
    await Promise.all([save, flush]);

    expect(settledBeforeWrite).toBe(false);
  });

  it('reports a failure from a write that was already queued', async () => {
    let failWrite!: (error: Error) => void;
    const queuedWrite = new CancellablePromise<void>((_resolve, reject) => (failWrite = reject));
    mockWriteFile.mockReturnValueOnce(queuedWrite);
    const save = writeFileSerialized(
      '/repo/src/conflicted.ts',
      'closed content',
      'utf-8',
      'lf',
      false
    );
    const flush = flushAllFileEdits();

    failWrite(new Error('close-save failed'));
    const [saveResult, flushResult] = await Promise.allSettled([save, flush]);

    expect(saveResult).toMatchObject({
      status: 'rejected',
      reason: new Error('close-save failed'),
    });
    expect(flushResult).toMatchObject({
      status: 'rejected',
      reason: new Error('close-save failed'),
    });
  });
});
