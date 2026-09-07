import { useCallback } from 'react';
import { useIDEStore } from '../stores/ideStore';
import { OpenFolderDialog } from '../wails/bindings';
import { openWorkspaceByPath } from '../utils/workspace';

// Module-level lock shared across all hook instances (Header, FileExplorer,
// useKeyboardShortcuts) so concurrent triggers from different entry points
// are properly guarded.
let isOpening = false;

/**
 * Shared hook for opening a folder via the native dialog.
 * Handles: native picker -> workspace state -> window title.
 *
 * Directory tree fetching is NOT done here — it's handled reactively by
 * `useDirectoryTree` which watches `workspace.path` changes.
 *
 * This hook only provides the `openFolder` action — it does NOT register
 * keyboard shortcuts. Use `useKeyboardShortcuts` once at the app level for that.
 */
export function useOpenFolder() {
  const openFolder = useCallback(async () => {
    // Guard against concurrent invocations (e.g., rapid double-click)
    if (isOpening) return;
    isOpening = true;

    try {
      const folderPath = await OpenFolderDialog();

      // User cancelled
      if (!folderPath) return;

      openWorkspaceByPath(folderPath);
    } catch (err) {
      console.error('Failed to open folder:', err);
      useIDEStore
        .getState()
        .showToast(
          `Failed to open folder: ${err instanceof Error ? err.message : 'Unknown error'}`,
          'error'
        );
    } finally {
      isOpening = false;
    }
  }, []);

  return { openFolder };
}

// Exported for testing only
export function _resetOpeningLock() {
  isOpening = false;
}
