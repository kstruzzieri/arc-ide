import { WriteFile } from '../wails/bindings';
import { useIDEStore } from '../stores/ideStore';
import { normalizePathForComparison, pathsReferToSameFile } from './lspUri';

/** All editor and diff writes share this queue so one path is never written
 * concurrently by two UI surfaces. */
interface FileWriteQueueEntry {
  promise?: Promise<unknown>;
}

const writeQueues = new Map<string, FileWriteQueueEntry>();
const fileWriteRevisions = new Map<string, number>();

type LockedFileWrite = (
  content: string,
  encoding: string,
  lineEndings: string,
  createBackup?: boolean
) => Promise<void>;

export function getFileWriteRevision(path: string): number {
  return fileWriteRevisions.get(normalizePathForComparison(path)) ?? 0;
}

/** Record a worktree write performed by a backend operation that already owns
 * the path lock (for example, choosing one side of a binary conflict). */
export function markFileWriteAttempt(path: string): void {
  const key = normalizePathForComparison(path);
  fileWriteRevisions.set(key, (fileWriteRevisions.get(key) ?? 0) + 1);
}

function queueFileOperation<T>(
  path: string,
  operation: (write: LockedFileWrite, hasQueuedWrites: () => boolean) => Promise<T>,
  continueAfterFailure: boolean
): Promise<T> {
  const key = normalizePathForComparison(path);
  const previous = writeQueues.get(key)?.promise;
  const entry: FileWriteQueueEntry = {};
  writeQueues.set(key, entry);
  const run = (): Promise<T> =>
    operation(
      (content, encoding, lineEndings, createBackup = false) => {
        markFileWriteAttempt(path);
        return WriteFile(path, content, encoding, lineEndings, createBackup);
      },
      () => writeQueues.get(key) !== entry
    );
  const start = (): Promise<T> => {
    try {
      return run();
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const predecessor = previous && continueAfterFailure ? previous.catch(() => undefined) : previous;
  const current = predecessor ? predecessor.then(run) : start();
  entry.promise = current;
  void current
    .finally(() => {
      if (writeQueues.get(key) === entry) writeQueues.delete(key);
    })
    .catch(() => undefined);
  return current;
}

/** Run one operation exclusively against a file's write queue. The supplied
 * writer bypasses the queue because the operation already owns it. A failed
 * predecessor aborts the operation so barriers never bless stale bytes. */
export function withFileWriteLock<T>(
  path: string,
  operation: (write: LockedFileWrite, hasQueuedWrites: () => boolean) => Promise<T>
): Promise<T> {
  return queueFileOperation(path, operation, false);
}

export function writeFileSerialized(
  path: string,
  content: string,
  encoding: string,
  lineEndings: string,
  createBackup = false
): Promise<void> {
  // A newer explicit save should still run after an older failed save.
  return queueFileOperation(
    path,
    (write) => write(content, encoding, lineEndings, createBackup),
    true
  );
}

async function waitForFileWrites(path: string): Promise<void> {
  const key = normalizePathForComparison(path);
  for (;;) {
    const queued = writeQueues.get(key)?.promise;
    if (!queued) return;
    await queued;
  }
}

async function settleAllFileWrites(): Promise<PromiseRejectedResult | undefined> {
  let firstFailure: PromiseRejectedResult | undefined;
  while (writeQueues.size > 0) {
    const results = await Promise.allSettled([...writeQueues.keys()].map(waitForFileWrites));
    firstFailure ??= results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
  }
  return firstFailure;
}

/** Encodings and line endings WriteFile can round-trip without loss. The
 * single source of truth for "may this surface write this file" — shared by
 * the editable diff pane and the merge resolution session. */
const WRITABLE_ENCODINGS = new Set(['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be']);
const WRITABLE_LINE_ENDINGS = new Set(['lf', 'crlf', 'none']);

export function isWritableFormat(encoding?: string, lineEndings?: string): boolean {
  return WRITABLE_ENCODINGS.has(encoding ?? '') && WRITABLE_LINE_ENDINGS.has(lineEndings ?? '');
}

/**
 * Await a durable flush of an open editor buffer to disk. Unlike autosave
 * (debounced, hook-local) and queueWorkingTreeEdit (whose open-file branch only
 * updates the buffer), this WRITES through the per-path serialized queue and
 * resolves only when the on-disk bytes match a stable buffer snapshot — looping
 * if a keystroke lands mid-write — then clears isModified. A file that is not
 * open, or is already clean, resolves after any queued path writes settle.
 * Callers that must read the file's true on-disk state await this first.
 */
export async function saveOpenFileToDisk(absPath: string): Promise<void> {
  const initial = openFileFor(absPath);
  if (initial?.isModified && !isWritableFormat(initial.encoding, initial.lineEndings)) {
    throw new Error(`Unsupported file format: ${initial.encoding}/${initial.lineEndings}`);
  }
  // Settle any pending debounced diff edit first so buffer/disk ordering holds.
  await flushWorkingTreeEdit(absPath);
  // A close-save or autosave may already own the path even when the file is
  // absent or marked clean. Snapshot callers need that write to finish first.
  await waitForFileWrites(absPath);
  for (;;) {
    const stable = await withFileWriteLock(absPath, async (write, hasQueuedWrites) => {
      const file = openFileFor(absPath);
      if (!file || !file.isModified) return true;
      if (!isWritableFormat(file.encoding, file.lineEndings)) {
        throw new Error(`Unsupported file format: ${file.encoding}/${file.lineEndings}`);
      }
      const snapshot = file.content;
      await write(snapshot, file.encoding, file.lineEndings, false);
      const after = openFileFor(absPath);
      // A save queued while this write was in flight must run before we can
      // decide which buffer revision is durably last.
      if (hasQueuedWrites()) return false;
      if (!after) return true;
      if (after.content !== snapshot) return false;
      useIDEStore.getState().setFileModified(after.id, false);
      return true;
    });
    if (stable) return;
  }
}

interface WorkingTreeEdit {
  absPath: string;
  displayPath: string;
  content: string;
  encoding: string;
  lineEndings: string;
  onSaved?: () => void;
}

interface PendingWorkingTreeEdit extends WorkingTreeEdit {
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
  draining?: Promise<void>;
}

const DISK_WRITE_DEBOUNCE_MS = 400;
const pendingWorkingTreeEdits = new Map<string, PendingWorkingTreeEdit>();

function openFileFor(path: string) {
  return useIDEStore.getState().openFiles.find((f) => pathsReferToSameFile(f.path, path));
}

export function queueWorkingTreeEdit(edit: WorkingTreeEdit): void {
  const key = normalizePathForComparison(edit.absPath);
  const openFile = openFileFor(edit.absPath);
  if (openFile) {
    const pending = pendingWorkingTreeEdits.get(key);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingWorkingTreeEdits.delete(key);
    if (openFile.content !== edit.content) {
      useIDEStore.getState().updateFileContent(openFile.id, edit.content);
    } else if (pending?.draining && !openFile.isModified) {
      // The matching buffer must still save after the older in-flight diff
      // write, or that write could leave disk behind a clean buffer.
      useIDEStore.getState().setFileModified(openFile.id, true);
    }
    edit.onSaved?.();
    return;
  }

  const existing = pendingWorkingTreeEdits.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const pending = existing ?? { ...edit, revision: 0 };
  Object.assign(pending, edit);
  pending.revision += 1;
  pending.timer = setTimeout(() => {
    pending.timer = undefined;
    void drainWorkingTreeEdit(edit.absPath).catch(() => undefined);
  }, DISK_WRITE_DEBOUNCE_MS);
  pendingWorkingTreeEdits.set(key, pending);
}

function drainWorkingTreeEdit(path: string): Promise<void> {
  const key = normalizePathForComparison(path);
  const pending = pendingWorkingTreeEdits.get(key);
  if (!pending) return Promise.resolve();
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }
  if (pending.draining) return pending.draining;

  pending.draining = (async () => {
    try {
      while (pendingWorkingTreeEdits.get(key) === pending) {
        if (pending.timer) {
          clearTimeout(pending.timer);
          pending.timer = undefined;
        }
        const revision = pending.revision;
        const content = pending.content;
        const openFile = openFileFor(path);

        if (openFile) {
          if (openFile.content !== content) {
            useIDEStore.getState().updateFileContent(openFile.id, content);
          }
        } else {
          await writeFileSerialized(
            pending.absPath,
            content,
            pending.encoding,
            pending.lineEndings,
            false
          );
        }

        if (pending.revision === revision) {
          pendingWorkingTreeEdits.delete(key);
          pending.onSaved?.();
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useIDEStore
        .getState()
        .showToast(`Failed to save ${pending.displayPath}: ${message}`, 'error');
      throw err;
    } finally {
      pending.draining = undefined;
    }
  })();

  return pending.draining;
}

/** Flush a pending diff edit before any editor surface reads the file. */
export function flushWorkingTreeEdit(path: string): Promise<void> {
  return drainWorkingTreeEdit(path);
}

/** Flush every debounced diff edit during the app's coordinated close. */
export async function flushAllWorkingTreeEdits(): Promise<void> {
  const results = await Promise.allSettled(
    [...pendingWorkingTreeEdits.keys()].map(drainWorkingTreeEdit)
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

/** Final close flush: settle diff drafts first, then persist the resulting
 * latest editor buffers through the same per-path write queues. */
export async function flushAllFileEdits(): Promise<void> {
  // Capture writes that already exist before the first await so a fast
  // rejection cannot disappear from the queue before close observes it.
  const preexistingWrites = settleAllFileWrites();
  let diffFailure: unknown;
  try {
    await flushAllWorkingTreeEdits();
  } catch (err) {
    diffFailure = err;
  }
  const files = useIDEStore.getState().openFiles.filter((file) => file.isModified);
  const results = await Promise.allSettled(
    files.map((file) =>
      writeFileSerialized(file.path, file.content, file.encoding, file.lineEndings, false).catch(
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          useIDEStore.getState().showToast(`Failed to save ${file.name}: ${message}`, 'error');
          throw err;
        }
      )
    )
  );
  const failure = results.find((result) => result.status === 'rejected');
  const preexistingWriteFailure = await preexistingWrites;
  const queuedFailure = await settleAllFileWrites();
  if (diffFailure !== undefined) throw diffFailure;
  if (failure?.status === 'rejected') throw failure.reason;
  if (preexistingWriteFailure) throw preexistingWriteFailure.reason;
  if (queuedFailure) throw queuedFailure.reason;
}
