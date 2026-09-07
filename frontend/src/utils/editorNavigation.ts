/**
 * Shared editor navigation utilities.
 *
 * Centralizes "open file if needed, then navigate to location" logic
 * so Problems panel, definition navigation, and other consumers
 * share a single code path instead of duplicating file-open flows.
 */

import { useIDEStore, type EditorFile, type EditorNavigationRequest } from '../stores/ideStore';
import { ReadFile } from '../wails/bindings';
import { createEditorFile } from './editorFile';
import { focusEditorSurface } from './editorSurface';
import { flushWorkingTreeEdit } from './fileWrites';
import { getFileNameFromPath, pathsReferToSameFile, toNativeLocalPath } from './lspUri';

interface EditorNavigationOptions {
  shouldApply?: () => boolean;
}

function shouldApplyNavigation(options?: EditorNavigationOptions): boolean {
  return options?.shouldApply?.() ?? true;
}

/**
 * The already-open editor file for `localPath`, if any. Single source of truth
 * for "is this file open?" so the open flow and the navigation flow can never
 * disagree about what counts as the same file.
 */
function findOpenFile(localPath: string): EditorFile | undefined {
  return useIDEStore.getState().openFiles.find((f) => pathsReferToSameFile(f.id, localPath));
}

/**
 * Opens a file in the editor if it isn't already open, and activates its tab.
 * Returns the EditorFile on success, or null if the file could not be read.
 */
export async function ensureEditorFileOpen(
  path: string,
  options?: EditorNavigationOptions
): Promise<EditorFile | null> {
  const localPath = toNativeLocalPath(path);

  try {
    await flushWorkingTreeEdit(localPath);
  } catch {
    return null; // the pending write already surfaced its save error
  }

  // Already open — just activate and return
  const existing = findOpenFile(localPath);
  if (existing) {
    if (!shouldApplyNavigation(options)) return null;
    useIDEStore.getState().setActiveFile(existing.id);
    focusEditorSurface('file');
    return existing;
  }

  // Read and open
  try {
    const content = await ReadFile(localPath);
    if (content === null) {
      throw new Error(`ReadFile returned no content for ${localPath}`);
    }
    if (!shouldApplyNavigation(options)) return null;

    if (content.isBinary) {
      useIDEStore
        .getState()
        .showToast(`Cannot open binary file: ${getFileNameFromPath(localPath)}`, 'error');
      return null;
    }

    const file = createEditorFile(localPath, content);
    useIDEStore.getState().openFile(file);
    focusEditorSurface('file');
    return file;
  } catch (err) {
    if (!shouldApplyNavigation(options)) return null;

    const message = err instanceof Error ? err.message : 'Unknown error';
    useIDEStore.getState().showToast(`Failed to open file: ${message}`, 'error');
    return null;
  }
}

/**
 * Opens a file (if needed), activates the tab, and requests a cursor jump
 * to the given 1-based line and column.
 */
export async function navigateToEditorLocation(
  path: string,
  line: number,
  column: number,
  options?: EditorNavigationOptions
): Promise<void> {
  // Register the navigation BEFORE the tab is activated when the file is already
  // open. Activating a tab runs the editor's file-switch effect, which restores
  // a background tab's remembered scroll position; if the navigation is already
  // pending when that runs, the editor skips the scroll restore and lets this
  // jump own the viewport. Setting it only afterwards (which a not-yet-open file
  // must do, since its id doesn't exist until it opens) loses the jump for an
  // already-open background tab — the file switches but the target line stays
  // off-screen. A not-yet-open file has no cached scroll, so ordering is moot
  // there and the post-open request below covers it.
  const existing = findOpenFile(toNativeLocalPath(path));
  let preRegisteredNavigation: EditorNavigationRequest | null = null;
  if (existing && shouldApplyNavigation(options)) {
    useIDEStore.getState().requestEditorNavigation(existing.id, line, column);
    preRegisteredNavigation = useIDEStore.getState().pendingEditorNavigation;
  }

  const file = await ensureEditorFileOpen(path, options);
  if (!file || !shouldApplyNavigation(options)) {
    // The open/activate did not happen (a failed working-tree flush, or the user
    // switched workspaces mid-flight). Retract the navigation we registered up
    // front, otherwise it lingers in the store and would later hijack the
    // viewport the next time that tab is activated for an unrelated reason —
    // and, in the workspace-switch case, would point into the old workspace.
    // Revisions can be reused after the editor consumes and clears a request,
    // so only retract the exact request object registered by this operation.
    if (
      preRegisteredNavigation &&
      useIDEStore.getState().pendingEditorNavigation === preRegisteredNavigation
    ) {
      useIDEStore
        .getState()
        .clearPendingEditorNavigation(
          preRegisteredNavigation.fileId,
          preRegisteredNavigation.revision
        );
    }
    return;
  }

  // Freshly opened file: its id did not exist before activation, so request the
  // jump now. (An already-open file was pre-registered above.)
  if (!existing) {
    useIDEStore.getState().requestEditorNavigation(file.id, line, column);
  }
}
