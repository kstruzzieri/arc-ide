import { useEffect, useCallback, useRef } from 'react';
import { ReadDirectoryShallow } from '../../wails/bindings';
import { useIDEStore, useWorkspace } from '../../stores/ideStore';
import { getCachedWorkspaceTree } from '../../utils/workspaceTreeCache';

/**
 * Hook to manage directory tree data fetching and state.
 * Automatically fetches the tree when the workspace changes.
 *
 * Uses a request generation counter so that when the workspace changes
 * mid-flight, stale ReadDirectoryShallow results are silently discarded instead
 * of overwriting the tree for the newly-selected workspace.
 */
export function useDirectoryTree() {
  const workspace = useWorkspace();
  const setDirectoryTree = useIDEStore((state) => state.setDirectoryTree);
  const setTreeLoading = useIDEStore((state) => state.setTreeLoading);
  const setTreeError = useIDEStore((state) => state.setTreeError);
  const requestIdRef = useRef(0);

  const fetchTree = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const isCurrentWorkspace = () => useIDEStore.getState().workspace === workspace;
    if (!workspace?.path) {
      if (!isCurrentWorkspace()) return;
      setDirectoryTree([]);
      setTreeLoading(false);
      return;
    }

    const cachedTree = getCachedWorkspaceTree(workspace.path);
    const hasCachedTree = Boolean(cachedTree?.length);
    // A cached-empty tree is still known content: no skeleton across its
    // refresh, but failures use the uncached error strategy (hasCachedTree).
    const hasCachedEntry = cachedTree !== undefined;

    // setTreeError also clears isLoadingTree, so it must run before
    // setTreeLoading(true) or the skeleton never survives the same batch.
    setTreeError(null);
    if (!hasCachedEntry) {
      setTreeLoading(true);
    }

    try {
      const entries = await ReadDirectoryShallow(workspace.path, workspace.path);
      const state = useIDEStore.getState();
      if (requestIdRef.current !== requestId || state.workspace !== workspace) return;
      state.mergeChildren(workspace.path, entries);
      state.clearDirty(workspace.path);
    } catch {
      const state = useIDEStore.getState();
      if (requestIdRef.current !== requestId || state.workspace !== workspace) return;
      if (hasCachedTree) {
        state.markDirty(workspace.path);
        state.showToast('Failed to refresh file tree', 'error');
        return;
      }
      setTreeError('Failed to read directory');
    } finally {
      if (
        requestIdRef.current === requestId &&
        useIDEStore.getState().workspace === workspace &&
        !hasCachedEntry
      ) {
        setTreeLoading(false);
      }
    }
  }, [workspace, setDirectoryTree, setTreeLoading, setTreeError]);

  // Fetch tree when workspace changes
  useEffect(() => {
    const requestIds = requestIdRef;
    void fetchTree();
    return () => {
      requestIds.current++;
    };
  }, [fetchTree]);

  return { refetch: fetchTree };
}
