import { LSPDidChange, LSPDidClose, LSPDidOpen, LSPDidSave } from '../wails/bindings';
import { lsp } from '../wails/bindings';

export const DIDCHANGE_DEBOUNCE_MS = 150;

type TrackedDocument = {
  syncedContent: string;
  pendingContent?: string;
  changeTimer?: ReturnType<typeof setTimeout>;
  openPromise?: Promise<void>;
  opened?: boolean;
};

const versions = new Map<string, number>();
const documents = new Map<string, TrackedDocument>();
const closeBarriers = new Map<string, Promise<void>>();

function nextVersion(path: string): number {
  const current = versions.get(path) ?? 0;
  const next = current + 1;
  versions.set(path, next);
  return next;
}

function clearChangeTimer(doc: TrackedDocument): void {
  if (!doc.changeTimer) return;
  clearTimeout(doc.changeTimer);
  doc.changeTimer = undefined;
}

export function openLSPDocument(
  path: string,
  languageID: string,
  content: string
): Promise<void> | null {
  if (documents.has(path)) return null;

  const doc: TrackedDocument = {
    syncedContent: content,
  };
  documents.set(path, doc);

  const closeBarrier = closeBarriers.get(path) ?? Promise.resolve();
  const openPromise = closeBarrier
    .then(async () => {
      if (documents.get(path) !== doc) return;
      await LSPDidOpen(path, languageID, nextVersion(path), content);
      doc.opened = true;
    })
    .catch((err) => {
      if (documents.get(path) === doc) {
        clearChangeTimer(doc);
        documents.delete(path);
      }
      throw err;
    })
    .finally(() => {
      if (doc.openPromise === openPromise) {
        doc.openPromise = undefined;
      }
    });

  doc.openPromise = openPromise;
  return openPromise;
}

export function scheduleLSPDocumentChange(
  path: string,
  content: string,
  onError?: (err: unknown) => void
): void {
  const doc = documents.get(path);
  if (!doc) return;

  if (content === doc.syncedContent) {
    doc.pendingContent = undefined;
    clearChangeTimer(doc);
    return;
  }

  doc.pendingContent = content;
  clearChangeTimer(doc);
  doc.changeTimer = setTimeout(() => {
    void flushLSPDocumentChange(path).catch((err) => onError?.(err));
  }, DIDCHANGE_DEBOUNCE_MS);
}

export async function flushLSPDocumentChange(path: string, content?: string): Promise<boolean> {
  const doc = documents.get(path);
  if (!doc) return false;

  clearChangeTimer(doc);

  const hasExplicitContent = content !== undefined;
  const pendingContentAtFlushStart = doc.pendingContent;
  let nextContent = content ?? doc.pendingContent;
  if (nextContent === undefined || nextContent === doc.syncedContent) {
    doc.pendingContent = undefined;
    return false;
  }

  if (doc.openPromise) {
    await doc.openPromise;
  }

  const current = documents.get(path);
  if (current !== doc || !current.opened) return false;

  if (hasExplicitContent) {
    nextContent = content;
  } else {
    clearChangeTimer(current);
    nextContent = current.pendingContent;
  }

  if (nextContent === undefined || nextContent === current.syncedContent) {
    if (
      !hasExplicitContent ||
      current.pendingContent === pendingContentAtFlushStart ||
      current.pendingContent === nextContent
    ) {
      current.pendingContent = undefined;
    }
    return false;
  }

  if (!hasExplicitContent || current.pendingContent === nextContent) {
    current.pendingContent = undefined;
  }

  const change = new lsp.TextDocumentContentChangeEvent({ text: nextContent });
  await LSPDidChange(path, nextVersion(path), [change]);
  current.syncedContent = nextContent;
  return true;
}

export async function saveLSPDocument(path: string, content: string): Promise<void> {
  const doc = documents.get(path);
  if (!doc) return;

  await flushLSPDocumentChange(path, content);

  const current = documents.get(path);
  if (current !== doc) return;

  if (current.openPromise) {
    await current.openPromise;
  }
  if (documents.get(path) !== current || !current.opened) return;

  await LSPDidSave(path);
}

export function closeLSPDocument(path: string, lastContent?: string): Promise<void> {
  const doc = documents.get(path);
  if (!doc) return closeBarriers.get(path) ?? Promise.resolve();

  clearChangeTimer(doc);
  documents.delete(path);

  const closePromise = closeTrackedDocument(path, doc, lastContent);
  trackCloseBarrier(path, closePromise);
  return closePromise;
}

async function closeTrackedDocument(
  path: string,
  doc: TrackedDocument,
  lastContent?: string
): Promise<void> {
  try {
    if (doc.openPromise) {
      await doc.openPromise;
    }
  } catch {
    return;
  }

  if (!doc.opened) return;

  const nextContent = lastContent ?? doc.pendingContent;
  if (nextContent !== undefined && nextContent !== doc.syncedContent) {
    const change = new lsp.TextDocumentContentChangeEvent({ text: nextContent });
    await LSPDidChange(path, nextVersion(path), [change]);
  }

  await LSPDidClose(path);
}

function trackCloseBarrier(path: string, closePromise: Promise<void>): void {
  const barrier = closePromise
    .catch(() => {
      // The caller still observes the close failure; the barrier only keeps later
      // opens ordered after the attempted close.
    })
    .then(() => {
      if (closeBarriers.get(path) === barrier) {
        closeBarriers.delete(path);
      }
    });
  closeBarriers.set(path, barrier);
}

export function forgetLSPDocument(path: string): void {
  const doc = documents.get(path);
  if (!doc) return;
  clearChangeTimer(doc);
  documents.delete(path);
}

export function trackedLSPDocumentPaths(): string[] {
  return [...documents.keys()];
}

export function resetLSPDocumentSyncState(): void {
  for (const doc of documents.values()) {
    clearChangeTimer(doc);
  }
  documents.clear();
  versions.clear();
  closeBarriers.clear();
}
