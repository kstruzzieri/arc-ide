import { useEffect, useRef } from 'react';
import { EventsOn } from '../wails/runtime';
import { useLSPStore, pathContainsOrEquals } from '../stores/lspStore';
import { useIDEStore } from '../stores/ideStore';
import type { LSPDiagnostic, LSPServerStatus } from '../stores/lspStore';
import { canonicalizeFileURI } from '../utils/lspUri';

interface DiagnosticsPayload {
  workspace: string;
  uri: string;
  version?: number;
  diagnostics: LSPDiagnostic[];
}

interface ErrorPayload {
  family: string;
  workspace: string;
  message: string;
}

/**
 * Accepts LSP backend events whose `workspace` field is at or inside the
 * active workspace. TypeScript project-root detection (#20) emits events
 * keyed by the detected project root, which is a path *inside* the active
 * workspace; before #20 this was always an exact match. Containment keeps
 * the stale-event guard correct for both legacy and project-root events.
 */
function isActiveWorkspaceEvent(workspace?: string): boolean {
  const activeWorkspace = useIDEStore.getState().workspace?.path;
  if (!activeWorkspace || !workspace) return true;
  return pathContainsOrEquals(activeWorkspace, workspace);
}

/**
 * useLSPEvents subscribes to backend LSP Wails events and routes them
 * into lspStore. Shows Toast notifications for actionable errors.
 *
 * Toast deduplication: Only one Toast per workspace::family error state.
 * Crash-retry status updates update the store but don't spam Toasts.
 */
export function useLSPEvents() {
  // Track which workspace::family combos have already shown an error Toast
  // to avoid spamming on crash-retry backoff cycles.
  const toastedErrors = useRef(new Set<string>());

  useEffect(() => {
    const cancelWorkspace = useIDEStore.subscribe((state, prevState) => {
      const workspacePath = state.workspace?.path ?? null;
      const prevWorkspacePath = prevState.workspace?.path ?? null;
      if (workspacePath === prevWorkspacePath) return;

      const lspState = useLSPStore.getState();
      lspState.clearAllDiagnostics();
      lspState.clearAllStatuses();
      toastedErrors.current.clear();
    });

    const cancelDiagnostics = EventsOn('lsp:diagnostics', (payload: DiagnosticsPayload) => {
      if (!payload?.uri) return;

      // Reject diagnostics from a non-active workspace
      if (!isActiveWorkspaceEvent(payload.workspace)) {
        return;
      }

      useLSPStore
        .getState()
        .setDiagnostics(canonicalizeFileURI(payload.uri), payload.diagnostics ?? []);
    });

    const cancelStatus = EventsOn('lsp:status', (payload: LSPServerStatus) => {
      if (!payload?.family) return;
      if (!isActiveWorkspaceEvent(payload.workspace)) return;

      useLSPStore.getState().setServerStatus(payload);

      const hasTypedSetupStatus = Boolean(payload.setupState);

      if (payload.state === 'error' && payload.error && !hasTypedSetupStatus) {
        // Deduplicate: only toast once per workspace::family error state
        const dedupeKey = `${payload.workspace}::${payload.family}`;
        if (!toastedErrors.current.has(dedupeKey)) {
          toastedErrors.current.add(dedupeKey);
          useIDEStore.getState().showToast(payload.error, 'error');
        }
      } else if (payload.state === 'ready') {
        // Server recovered — clear the dedup guard so future errors can toast again
        const dedupeKey = `${payload.workspace}::${payload.family}`;
        toastedErrors.current.delete(dedupeKey);
      }
    });

    const cancelError = EventsOn('lsp:error', (payload: ErrorPayload) => {
      if (!payload?.message) return;
      if (!isActiveWorkspaceEvent(payload.workspace)) return;

      // Terminal errors (crash exhaustion) always show a Toast regardless of dedup
      useIDEStore.getState().showToast(payload.message, 'error');
    });

    return () => {
      cancelWorkspace();
      cancelDiagnostics();
      cancelStatus();
      cancelError();
    };
  }, []);
}
