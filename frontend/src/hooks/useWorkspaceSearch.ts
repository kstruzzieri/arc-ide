import { useEffect, useRef } from 'react';
import { CancelSearch, SearchWorkspace } from '../wails/bindings';
import { search } from '../wails/bindings';
import { useIDEStore } from '../stores/ideStore';
import { useSearchStore } from '../stores/searchStore';
import type { SearchResponse, SearchStatus } from '../types/search';

export const SEARCH_DEBOUNCE_MS = 250;

const KNOWN_STATUSES: ReadonlySet<SearchStatus> = new Set<SearchStatus>([
  'success',
  'no_matches',
  'missing_tool',
  'invalid_regex',
  'canceled',
  'failed',
]);

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err.length > 0) return err;
  return 'Search failed.';
}

// Narrow the generated `status: string` to the SearchStatus union, defaulting
// unknown statuses to 'failed' so the UI surfaces the issue rather than
// silently dropping the response.
function narrowResponse(raw: search.SearchResponse): SearchResponse {
  const status: SearchStatus = KNOWN_STATUSES.has(raw.status as SearchStatus)
    ? (raw.status as SearchStatus)
    : 'failed';
  return {
    requestId: raw.requestId,
    status,
    message:
      status === 'failed' && !raw.message ? `Unexpected search status: ${raw.status}` : raw.message,
    files: raw.files,
    totalFiles: raw.totalFiles,
    totalLines: raw.totalLines,
    truncated: raw.truncated,
    matchCap: raw.matchCap,
    durationMs: raw.durationMs,
  };
}

function fireCancelSearch(requestId: string): void {
  void CancelSearch(requestId).catch((err) => {
    console.error(`Search cancel failed for ${requestId}:`, err);
  });
}

/**
 * useWorkspaceSearch wires the search store to backend ripgrep.
 *
 * Responsibilities:
 *   - debounce query/option changes by SEARCH_DEBOUNCE_MS before invoking
 *     SearchWorkspace, so rapid typing collapses into one request
 *   - assign each fired request a unique RequestID; drop stale responses by
 *     comparing against the store's activeRequestId
 *   - on query/option supersession, workspace switch, or unmount, fire
 *     CancelSearch(activeRequestId) so the backend ripgrep process is reaped
 *     instead of running to completion
 *   - keep ideStore.workspace and searchStore in sync: empty query → empty
 *     state, no workspace → no-workspace state
 *
 * The hook is fire-and-forget; mount it once at the top of the app. It uses
 * vanilla store subscriptions internally so query/option changes do not
 * re-render the component that hosts the hook.
 */
export function useWorkspaceSearch(): void {
  const requestCounter = useRef(0);

  useEffect(() => {
    let debounceTimer: number | null = null;
    let searchGeneration = 0;
    const canceledRequestIds = new Set<string>();

    const cancelActiveSearch = () => {
      const activeRequestId = useSearchStore.getState().activeRequestId;
      if (!activeRequestId || canceledRequestIds.has(activeRequestId)) return;
      canceledRequestIds.add(activeRequestId);
      fireCancelSearch(activeRequestId);
    };

    const clearPendingSearch = (cancelActive: boolean) => {
      searchGeneration += 1;
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (cancelActive) cancelActiveSearch();
    };

    const scheduleSearch = () => {
      // Query/option changes supersede any active backend search. Stale
      // responses are still guarded by generation in case cancellation races
      // with a response already on its way back from Wails.
      clearPendingSearch(true);

      const workspacePath = useIDEStore.getState().workspace?.path ?? null;
      const { query, options } = useSearchStore.getState();
      const trimmedQuery = query.trim();

      if (!workspacePath) {
        useSearchStore.getState().setNoWorkspace();
        return;
      }

      if (!trimmedQuery) {
        useSearchStore.getState().setEmptyQuery();
        return;
      }

      const requestId = `search-${Date.now()}-${++requestCounter.current}`;
      const generation = searchGeneration;
      const requestQuery = query;
      const requestOptions = { ...options };

      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        if (generation !== searchGeneration) return;

        useSearchStore.getState().beginSearch(requestId);

        const request = new search.SearchRequest({
          requestId,
          root: workspacePath,
          query: requestQuery,
          options: requestOptions,
        });

        void SearchWorkspace(request)
          .then((raw) => {
            if (generation !== searchGeneration) return;
            if (useSearchStore.getState().activeRequestId !== requestId) return;
            useSearchStore.getState().applyResponse(narrowResponse(raw));
          })
          .catch((err) => {
            if (generation !== searchGeneration) return;
            if (useSearchStore.getState().activeRequestId !== requestId) return;
            useSearchStore.getState().failSearch(requestId, errorMessage(err));
          });
      }, SEARCH_DEBOUNCE_MS);
    };

    const unsubscribeWorkspace = useIDEStore.subscribe((state, prevState) => {
      const workspacePath = state.workspace?.path ?? null;
      const previousWorkspacePath = prevState.workspace?.path ?? null;
      if (workspacePath === previousWorkspacePath) return;

      clearPendingSearch(true);
      useSearchStore.getState().resetForWorkspace(workspacePath);
    });

    const unsubscribeSearch = useSearchStore.subscribe((state, prevState) => {
      if (state.query === prevState.query && state.options === prevState.options) return;
      scheduleSearch();
    });

    scheduleSearch();

    return () => {
      clearPendingSearch(true);
      unsubscribeWorkspace();
      unsubscribeSearch();
    };
  }, []);
}
