import { useEffect, useCallback } from 'react';
import { useIDEStore, type EditorFile } from '../stores/ideStore';
import { EventsOn } from '../wails/runtime';
import { languageIdForFile } from '../utils/lspLanguageId';
import { filePathToURI } from '../utils/lspUri';
import { pathContainsOrEquals } from '../stores/lspStore';
import {
  closeLSPDocument,
  forgetLSPDocument,
  openLSPDocument,
  resetLSPDocumentSyncState,
  saveLSPDocument,
  scheduleLSPDocumentChange,
  trackedLSPDocumentPaths,
} from '../utils/lspDocumentSync';

interface LSPReconnectPayload {
  workspace?: string;
  documents?: string[];
}

/**
 * useLSPDocumentSync wires the editor's document lifecycle to the backend LSP manager.
 *
 * Responsibilities:
 * - Send didOpen when a file is first opened (not on duplicate tab opens)
 * - Send debounced didChange (150ms) when file content changes
 * - Send didSave after autosave completes
 * - Send didClose when the last tab for a file is closed or workspace switches
 *
 * Document versions are tracked per-file and increment monotonically.
 * The frontend is the source of truth for version numbers.
 */
export function useLSPDocumentSync() {
  // --- didOpen ---
  const sendDidOpen = useCallback((file: EditorFile) => {
    const langId = languageIdForFile(file.name);
    if (!langId) return; // unsupported language — backend will no-op anyway

    openLSPDocument(file.path, langId, file.content)?.catch((err) => {
      console.error(`LSP didOpen failed for ${file.path}:`, err);
    });
  }, []);

  // --- didChange (debounced) ---
  const sendDidChange = useCallback((path: string, content: string) => {
    scheduleLSPDocumentChange(path, content, (err) => {
      console.error(`LSP didChange failed for ${path}:`, err);
    });
  }, []);

  // --- didSave ---
  const sendDidSave = useCallback((path: string, content: string) => {
    void saveLSPDocument(path, content).catch((err) => {
      console.error(`LSP didSave failed for ${path}:`, err);
    });
  }, []);

  // --- didClose ---
  // lastContent: content to flush if there's a pending debounced didChange.
  // Caller must provide this because the file may already be removed from openFiles.
  const sendDidClose = useCallback((path: string, lastContent?: string) => {
    void closeLSPDocument(path, lastContent).catch((err) => {
      console.error(`LSP didClose failed for ${path}:`, err);
    });
  }, []);

  // Close all tracked documents (used during workspace switch)
  const closeAll = useCallback(() => {
    for (const path of trackedLSPDocumentPaths()) {
      const file = useIDEStore.getState().openFiles.find((f) => f.path === path);
      void closeLSPDocument(path, file?.content).catch((err) => {
        console.error(`LSP didClose failed for ${path}:`, err);
      });
    }
  }, []);

  // --- Watch store for file lifecycle events (single subscription) ---
  useEffect(() => {
    let prevOpenFiles: EditorFile[] = useIDEStore.getState().openFiles;

    return useIDEStore.subscribe((state, prevState) => {
      const currentFiles = state.openFiles;

      // Detect newly opened files
      for (const file of currentFiles) {
        const wasOpen = prevOpenFiles.some((f) => f.id === file.id);
        if (!wasOpen) {
          sendDidOpen(file);
        }
      }

      // Detect closed files — pass last known content for flushing pending changes
      for (const prevFile of prevOpenFiles) {
        const stillOpen = currentFiles.some((f) => f.id === prevFile.id);
        if (!stillOpen) {
          sendDidClose(prevFile.path, prevFile.content);
        }
      }

      // Detect content changes and save completions (only for files that existed before)
      for (const file of currentFiles) {
        const prevFile = prevState.openFiles.find((f) => f.id === file.id);
        if (!prevFile) continue;

        // Content changed while modified = didChange
        if (file.content !== prevFile.content && file.isModified) {
          sendDidChange(file.path, file.content);
        }

        // isModified went true→false = save completed
        if (prevFile.isModified && !file.isModified) {
          sendDidSave(file.path, file.content);
        }
      }

      prevOpenFiles = currentFiles;
    });
  }, [sendDidOpen, sendDidClose, sendDidChange, sendDidSave]);

  // --- Watch for workspace switches ---
  useEffect(() => {
    let prevWorkspacePath = useIDEStore.getState().workspace?.path;

    return useIDEStore.subscribe((state) => {
      const currentPath = state.workspace?.path;
      if (currentPath !== prevWorkspacePath) {
        // Workspace changed — close all documents from the old workspace
        closeAll();
        prevWorkspacePath = currentPath;
      }
    });
  }, [closeAll]);

  // --- Listen for lsp:reconnect after server crash recovery ---
  useEffect(() => {
    const cancel = EventsOn('lsp:reconnect', (payload: LSPReconnectPayload) => {
      const reconnectedURIs = payload?.documents;
      if (!reconnectedURIs || reconnectedURIs.length === 0) return;

      // payload.workspace is the server's project root (may be a nested
      // package), not the active workspace path — use containment so
      // nested TypeScript project reconnects aren't dropped.
      const activeWorkspace = useIDEStore.getState().workspace?.path;
      if (
        activeWorkspace &&
        payload.workspace &&
        !pathContainsOrEquals(activeWorkspace, payload.workspace)
      ) {
        return;
      }

      const reconnectSet = new Set(reconnectedURIs);

      // Re-send didOpen for all currently open files that match the reconnected paths
      const { openFiles } = useIDEStore.getState();
      for (const file of openFiles) {
        if (reconnectSet.has(filePathToURI(file.path))) {
          // Clear the stale guard first so the new server instance gets a fresh didOpen.
          forgetLSPDocument(file.path);
          sendDidOpen(file);
        }
      }
    });

    return cancel;
  }, [sendDidOpen]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      resetLSPDocumentSyncState();
    };
  }, []);

  // All lifecycle events are driven by store subscriptions above.
  // No return value needed — this hook is fire-and-forget like useAutosave.
}
