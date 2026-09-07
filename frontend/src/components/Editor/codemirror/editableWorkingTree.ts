/**
 * Editable working-tree side of the git diff viewer (issue #169).
 *
 * The working tree is the only side of a diff that is a live file rather than a
 * revision snapshot, so it is the only side the user may edit — and only in an
 * unstaged diff, where the right pane shows the working tree (in a staged diff
 * the right pane is the index snapshot). Edits route to a single source of
 * truth: the open editor buffer if the file is open (the diff already reads that
 * buffer), else straight to disk. Extracted from GitDiffView so the persist +
 * update-listener wiring is unit-testable without a live CodeMirror view.
 */
import { EditorView, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { DiffSession } from '../../../stores/gitStore';
import { useIDEStore } from '../../../stores/ideStore';
import { queueWorkingTreeEdit, isWritableFormat } from '../../../utils/fileWrites';
import { externalDocUpdate } from './reconcileDoc';

/**
 * Whether the working-tree (right) pane of this diff is editable: only an
 * unstaged, textual, in-size diff qualifies. Staged (HEAD → index), binary, and
 * too-large diffs stay read-only on both sides.
 */
export function isWorkingTreeEditable(session: DiffSession): boolean {
  return (
    session.context === 'unstaged' &&
    !session.binary &&
    !session.truncated &&
    isWritableFormat(session.worktreeEncoding, session.worktreeLineEndings)
  );
}

/**
 * Persist an edit to the working-tree side of a diff. If the file is open in the
 * editor, route the edit through its buffer so the editor and the diff stay a
 * single source of truth — autosave then debounces the write to disk and the
 * FS-watcher-driven git refresh repaints the diff.
 */
export function persistWorkingTreeEdit(
  session: DiffSession,
  content: string,
  onSaved?: () => void
): void {
  // The shared queue routes to an open buffer when present, otherwise to a
  // debounced, per-path serialized disk write.
  const encoding = session.worktreeEncoding;
  const lineEndings = session.worktreeLineEndings;
  if (encoding === undefined || lineEndings === undefined) {
    // Unreachable while isWorkingTreeEditable gates the listener, but if that
    // invariant ever breaks this drops user keystrokes — scream, don't swallow.
    useIDEStore.getState().showToast(`Cannot save ${session.path}: unknown file encoding`, 'error');
    return;
  }
  queueWorkingTreeEdit({
    absPath: session.absPath,
    displayPath: session.path,
    content,
    encoding,
    lineEndings,
    onSaved,
  });
}

/**
 * A CodeMirror extension for the working-tree pane that persists edits as they
 * happen. Attach it to the right pane only, and only when the diff is editable
 * (see isWorkingTreeEditable). Non-doc updates (scroll, selection, folding) are
 * ignored so only real edits write back.
 */
export function workingTreeEditListener(
  session: DiffSession,
  onEdit?: () => void,
  onSaved?: () => void
): Extension {
  return EditorView.updateListener.of((update: ViewUpdate) => {
    const externallyReconciled = update.transactions.some(
      (transaction) => transaction.annotation(externalDocUpdate) === true
    );
    if (update.docChanged && !externallyReconciled) {
      onEdit?.();
      persistWorkingTreeEdit(session, update.state.doc.toString(), onSaved);
    }
  });
}
