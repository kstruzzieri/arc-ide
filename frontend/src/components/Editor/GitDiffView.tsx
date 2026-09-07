import { useEffect, useMemo, useRef } from 'react';
import { MergeView, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { getDiffRequestRevision, useGitStore, type DiffSession } from '../../stores/gitStore';
import { useEditorSyntaxTheme } from '../../stores/ideStore';
import { diffLines } from '../../utils/lineDiff';
import { ensureEditorFileOpen } from '../../utils/editorNavigation';
import { buildTheme, gitGutterExtension, loadLanguageSupport, setGitBaseline } from './codemirror';
import { hunkStagingGutter } from './codemirror/hunkStagingGutter';
import { isWorkingTreeEditable, workingTreeEditListener } from './codemirror/editableWorkingTree';
import { reconcileDoc } from './codemirror/reconcileDoc';
import styles from './GitDiffView.module.css';

/**
 * Side-by-side diff for the git preview tab, a plain MergeView (not the editing
 * unified view). The left pane and every staged/binary/too-large side is a
 * revision snapshot and stays read-only; the right pane of an unstaged diff is
 * the live working tree, so it alone is editable and writes back through the
 * open editor buffer or straight to disk (#169).
 */
/** Split-ratio bounds: neither pane may shrink past this. */
const MIN_SPLIT = 15;
const MAX_SPLIT = 85;

function hunkSignature(session: DiffSession): string {
  return JSON.stringify(session.hunks.map((h) => [h.newStart, h.newLines, h.patch]));
}

export function GitDiffView({
  session,
  visible = true,
}: {
  session: DiffSession;
  /** The diff stays mounted but CSS-hidden when not shown; on re-show its
   * CodeMirror panes need a remeasure or they keep a stale, too-tall scroll
   * geometry (a phantom scrollbar). */
  visible?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const localEditRevisionRef = useRef(0);
  // The openDiff request id current when the user last typed. Sessions whose
  // requestRevision is not past this barrier were built from a read that
  // started before the edit — their content predates the pane and must never
  // reconcile it backward.
  const editBarrierRef = useRef(0);
  // Active divider drag's teardown, so unmount mid-drag removes the window
  // listeners the mouseup would otherwise have to wait for.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);
  const structuralKeyRef = useRef<string | null>(null);
  const hunkCompartmentRef = useRef<Compartment | null>(null);
  const hunkSigRef = useRef('');
  const hunkContentRef = useRef('');
  const themeId = useEditorSyntaxTheme();

  useEffect(() => {
    if (!visible) return;
    const view = mergeRef.current;
    view?.a.requestMeasure();
    view?.b.requestMeasure();
  }, [visible, session]);

  // Hunk count from the same line diff the gutter uses — render-derived, so
  // no post-mount state write. May differ from the merge view's char-level
  // chunking by at most adjacent-hunk merging, which is fine for a count.
  const diffCount = useMemo(
    () => diffLines(session.left.content, session.right.content).length,
    [session.left.content, session.right.content]
  );

  useEffect(() => {
    const current = mergeRef.current;
    const editableRight = isWorkingTreeEditable(session);
    const sessionKey = JSON.stringify([session.context, session.absPath]);
    const structuralKey = JSON.stringify([
      session.path,
      session.absPath,
      session.context,
      session.left.label,
      session.left.content,
      session.right.label,
      editableRight ? 'editable' : session.right.content,
      session.binary,
      session.truncated,
      session.worktreeEncoding,
      session.worktreeLineEndings,
      themeId,
    ]);

    if (!hostRef.current || session.binary || session.truncated) {
      current?.destroy();
      mergeRef.current = null;
      sessionKeyRef.current = null;
      localEditRevisionRef.current = 0;
      structuralKeyRef.current = null;
      hunkCompartmentRef.current = null;
      return;
    }

    const sameSession = sessionKeyRef.current === sessionKey;
    if (!sameSession) localEditRevisionRef.current = 0;

    if (current && structuralKeyRef.current === structuralKey) {
      sessionKeyRef.current = sessionKey;
      const compartment = hunkCompartmentRef.current;
      const sig = hunkSignature(session);
      if (
        compartment &&
        // A suppressed-hunks refresh (dirty buffer mid-save) ships no hunks;
        // keep the previous gutter — its markers already dim where the edits
        // landed — instead of collapsing the column until the next refresh.
        !session.hunksSuppressed &&
        (sig !== hunkSigRef.current || session.right.content !== hunkContentRef.current)
      ) {
        hunkSigRef.current = sig;
        hunkContentRef.current = session.right.content;
        current.b.dispatch({
          effects: compartment.reconfigure(
            hunkStagingGutter(
              session.hunks,
              session.context,
              editableRight ? session.right.content : undefined
            )
          ),
        });
      }

      // A session whose request started after the user's last keystroke read
      // the post-edit buffer/disk: it is authoritative even while local edits
      // are outstanding. One that predates the edit must never win.
      const postEdit = (session.requestRevision ?? 0) > editBarrierRef.current;
      const liveContent = current.b.state.doc.toString();
      if (liveContent === session.right.content) {
        localEditRevisionRef.current = 0;
      } else if (editableRight && (localEditRevisionRef.current === 0 || postEdit)) {
        reconcileDoc(current.b, session.right.content);
        localEditRevisionRef.current = 0;
      }
      return;
    }

    let rightContent = session.right.content;
    if (current && sameSession && localEditRevisionRef.current > 0) {
      const postEdit = (session.requestRevision ?? 0) > editBarrierRef.current;
      const liveContent = current.b.state.doc.toString();
      if (liveContent !== session.right.content && !postEdit) {
        // A watcher refresh can finish with an older disk/buffer snapshot while
        // the user is still typing. Rebuild around the live document, not the
        // stale response; a later matching refresh becomes the new baseline.
        rightContent = liveContent;
      } else {
        localEditRevisionRef.current = 0;
      }
    }
    sessionKeyRef.current = sessionKey;
    current?.destroy();
    structuralKeyRef.current = structuralKey;

    const filename = session.path.split('/').pop() ?? session.path;
    // No lineWrapping here: the merge view aligns the two panes with spacer
    // widgets sized from measured line heights, and wrapped lines re-measure
    // as pane widths settle — producing sudden mid-scroll jumps and blank
    // regions. Long lines scroll horizontally inside their pane instead.
    const base: Extension[] = [
      lineNumbers(),
      // JetBrains diff-navigation keys.
      keymap.of([{ key: 'F7', run: goToNextChunk, shift: goToPreviousChunk }]),
      buildTheme(themeId),
    ];
    const leftLanguage = new Compartment();
    const rightLanguage = new Compartment();
    // Revision snapshots are read-only. Only the working-tree (right) side of an
    // unstaged diff is a live file, so it alone drops these and instead persists
    // edits back through the open buffer or disk (#169).
    const readOnly: Extension[] = [EditorView.editable.of(false), EditorState.readOnly.of(true)];

    // Only the right pane (the new side: working tree for unstaged, index for
    // staged) carries the per-hunk stage/unstage buttons — git hunks are keyed
    // by their new-side start line, which always matches this pane's content
    // (the store suppresses hunks when the pane shows an unsaved editor buffer
    // git hasn't diffed, so anchors never drift). An in-place edit dirties that
    // buffer the same way, so the gutter is likewise suppressed until the next
    // post-save refresh recomputes the hunks against the new working tree.
    const hunkCompartment = new Compartment();
    hunkCompartmentRef.current = hunkCompartment;
    hunkSigRef.current = hunkSignature(session);
    hunkContentRef.current = session.right.content;
    const view = new MergeView({
      a: {
        doc: session.left.content,
        extensions: [...base, leftLanguage.of([]), ...readOnly],
      },
      b: {
        doc: rightContent,
        extensions: [
          ...base,
          rightLanguage.of([]),
          ...(editableRight
            ? [
                workingTreeEditListener(
                  session,
                  () => {
                    localEditRevisionRef.current += 1;
                    // Refreshes requested up to this moment read pre-edit
                    // content; only later ones may reconcile the pane.
                    editBarrierRef.current = getDiffRequestRevision();
                  },
                  () => {
                    if (sessionKeyRef.current !== sessionKey) return;
                    // Start a post-write read after the latest content reaches
                    // disk; it invalidates older refresh requests and delivers
                    // the authoritative buffer/disk state. Deliberately DO NOT
                    // clear localEditRevision here: a refresh that started
                    // before this save can still land afterwards, and with the
                    // guard down its stale content would reconcile the pane
                    // backward — eating the newest keystrokes and leaving the
                    // pane silently diverged from the file (the mass-"deletion"
                    // bug). The reconcile effect clears the guard only when an
                    // arriving session's content actually matches the pane.
                    void useGitStore.getState().refreshOpenDiff();
                  }
                ),
                // The editable pane gets its own undo history (Cmd-Z /
                // Cmd-Shift-Z), like the regular editor; undone edits persist
                // through the same update listener as typed ones, and external
                // reconciles are annotated addToHistory:false (reconcileDoc) so
                // undo never un-applies a refresh.
                history(),
                keymap.of(historyKeymap),
                // Standard editing keys, matching the main editor. Enter MUST
                // be bound: unbound it falls through to WebKit's
                // contenteditable default, whose block insert reads back
                // through the DOM observer as two newlines per press.
                keymap.of([...defaultKeymap, indentWithTab]),
                // The file view's change gutter rides along: amber/green bars
                // and deletion wedges against the index baseline (seeded after
                // build), click -> peek/revert popup. Revert restores the index
                // content for that hunk, persisting like any typed edit. The
                // merge view's own non-clickable bars are hidden on this pane
                // via the editableRight root class so gutters don't double up.
                gitGutterExtension(),
              ]
            : readOnly),
          hunkCompartment.of(
            hunkStagingGutter(
              session.hunks,
              session.context,
              editableRight ? session.right.content : undefined
            )
          ),
        ],
      },
      parent: hostRef.current,
      gutter: true,
      highlightChanges: true,
    });
    mergeRef.current = view;
    // Seed the clickable change gutter's baseline with the index side. Left
    // content is in the structural key, so a changed baseline always passes
    // through this rebuild path.
    if (editableRight) {
      view.b.dispatch({ effects: setGitBaseline.of(session.left.content) });
    }
    void loadLanguageSupport(filename).then((language) => {
      if (mergeRef.current !== view || sessionKeyRef.current !== sessionKey) return;
      view.a.dispatch({ effects: leftLanguage.reconfigure(language ?? []) });
      view.b.dispatch({ effects: rightLanguage.reconfigure(language ?? []) });
    });
  }, [session, themeId]);

  useEffect(
    () => () => {
      const view = mergeRef.current;
      mergeRef.current = null;
      view?.destroy();
    },
    []
  );

  // Navigate from the right (working-tree) side, center the landed chunk, and
  // leave focus there — where the user reads and, in an unstaged diff, edits.
  const navigate = (direction: 'next' | 'prev') => {
    const side = mergeRef.current?.b;
    if (!side) return;
    (direction === 'next' ? goToNextChunk : goToPreviousChunk)(side);
    side.dispatch({
      effects: EditorView.scrollIntoView(side.state.selection.main.head, { y: 'center' }),
    });
    side.focus();
  };

  // Column split, applied as a CSS variable so the panes, the divider, and
  // the header labels all track the same ratio.
  const setSplit = (percent: number) => {
    const clamped = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, Math.round(percent)));
    rootRef.current?.style.setProperty('--diff-left', `${clamped}%`);
    return clamped;
  };

  const currentSplit = (): number => {
    const raw = rootRef.current?.style.getPropertyValue('--diff-left');
    const parsed = raw ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : 50;
  };

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      setSplit(((ev.clientX - rect.left) / rect.width) * 100);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dragCleanupRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Unmount mid-drag must not leave window listeners behind.
    dragCleanupRef.current = onUp;
  };

  const handleDividerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setSplit(currentSplit() + (e.key === 'ArrowLeft' ? -2 : 2));
  };

  // The working-tree side edits in place, but Open File still brings up the
  // full editor (LSP, search, its own tab) and yields the diff tab to it.
  const openFile = () => void ensureEditorFileOpen(session.absPath);

  if (session.binary) {
    return (
      <div className={styles.stateMessage} data-testid="diff-binary">
        Binary file changed — no text diff available.
      </div>
    );
  }
  if (session.truncated) {
    return (
      <div className={styles.stateMessage} data-testid="diff-too-large">
        Diff too large to display.
      </div>
    );
  }

  const rootClass = isWorkingTreeEditable(session)
    ? `${styles.diffRoot} ${styles.editableRight}`
    : styles.diffRoot;

  return (
    <div className={rootClass} ref={rootRef} data-testid="diff-root">
      <div className={styles.toolbar}>
        <div className={styles.labels} aria-hidden="true">
          <span>{session.left.label}</span>
          <span>{session.right.label}</span>
        </div>
        <div className={styles.nav}>
          <span className={styles.diffCount}>
            {diffCount} difference{diffCount === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => navigate('prev')}
            aria-label="Previous difference"
            title="Previous difference (Shift-F7)"
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => navigate('next')}
            aria-label="Next difference"
            title="Next difference (F7)"
          >
            ↓
          </button>
          <button
            type="button"
            className={styles.openBtn}
            onClick={() => void openFile()}
            title="Open the file to edit"
          >
            Open File
          </button>
        </div>
      </div>
      <div ref={hostRef} className={styles.mergeHost} data-testid="merge-host">
        <button
          type="button"
          className={styles.divider}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize diff columns"
          title="Drag to resize columns"
          onMouseDown={handleDividerMouseDown}
          onKeyDown={handleDividerKeyDown}
        />
      </div>
    </div>
  );
}
