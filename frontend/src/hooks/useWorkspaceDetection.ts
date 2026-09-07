import { useEffect } from 'react';
import { useIDEStore } from '../stores/ideStore';
import { DetectWorkspaces } from '../wails/bindings';

/**
 * Detects the focused workspaces inside the open repo whenever the repo path
 * changes. Read-only: results are held in the store, never written to disk.
 * Clears the list when no repo is open.
 */
export function useWorkspaceDetection() {
  const repoPath = useIDEStore((state) => state.workspace?.path ?? '');

  useEffect(() => {
    if (!repoPath) {
      useIDEStore.getState().setWorkspaces([]);
      return;
    }

    // Clear any prior repo's workspaces immediately so a stale list/selection
    // cannot leak across repo switches. setWorkspaces([]) resets the active id
    // to "project"; detection (and any session restore) repopulate it below.
    useIDEStore.getState().setWorkspaces([]);

    let cancelled = false;
    DetectWorkspaces(repoPath)
      .then((defs) => {
        if (!cancelled) {
          useIDEStore.getState().setWorkspaces(defs ?? []);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('workspace detection failed:', err);
          useIDEStore.getState().setWorkspaces([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [repoPath]);
}
