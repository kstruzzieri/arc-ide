import { useEffect } from 'react';
import { useIDEStore } from '../stores/ideStore';
import { ListRecentWorkspaces } from '../wails/bindings';

const MAX_RECENT = 10;

/**
 * Fetches recent workspaces from the backend on mount.
 *
 * In-session workspace switches are handled by the optimistic update in
 * `openWorkspaceByPath`, so we intentionally do NOT refetch when
 * `workspace.path` changes — the backend only persists `LastOpened`
 * during `SaveWorkspaceState` (autosave / blur / close), so an
 * immediate refetch would overwrite the optimistic state with stale data.
 *
 * If an optimistic update occurs while the backend fetch is in flight,
 * we merge rather than replace: optimistic entries (fresher) take
 * precedence, and the backend backfills any historical workspaces that
 * the optimistic path didn't know about.
 */
export function useRecentWorkspaces() {
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const versionAtStart = useIDEStore.getState().recentWorkspacesVersion;

      try {
        const all = await ListRecentWorkspaces();
        if (cancelled) return;

        const backendEntries = (all ?? []).slice(0, MAX_RECENT);

        if (useIDEStore.getState().recentWorkspacesVersion !== versionAtStart) {
          // An optimistic update happened while the fetch was in flight.
          // Merge: keep optimistic entries, backfill with backend entries
          // that aren't already represented in the in-memory list.
          const current = useIDEStore.getState().recentWorkspaces;
          const currentPaths = new Set(current.map((w) => w.path));
          const backfill = backendEntries.filter((w) => !currentPaths.has(w.path));
          const merged = [...current, ...backfill].slice(0, MAX_RECENT);
          useIDEStore.getState().setRecentWorkspaces(merged);
        } else {
          useIDEStore.getState().setRecentWorkspaces(backendEntries);
        }
      } catch (err) {
        console.warn('Failed to load recent workspaces:', err);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);
}
