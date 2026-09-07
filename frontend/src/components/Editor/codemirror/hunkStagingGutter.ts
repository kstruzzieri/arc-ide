/**
 * Per-hunk staging gutter for the diff viewer. Renders a stage/unstage button
 * at each git hunk's new-side start line in the right pane, backed by the
 * store's applyHunk (git apply --cached). The hunk set is fixed for a given
 * diff session, so the markers are static — a fresh session rebuilds the pane.
 */
import { EditorView, gutter, GutterMarker } from '@codemirror/view';
import { RangeSet, type Extension } from '@codemirror/state';
import type { git } from '../../../wails/bindings';
import { useGitStore, type DiffContext } from '../../../stores/gitStore';
import { useIDEStore } from '../../../stores/ideStore';
import { diffLines } from '../../../utils/lineDiff';

/**
 * How a hunk control behaves in a given diff context. An 'unstaged' diff
 * (index → working tree) stages its hunks into the index; a 'staged' diff
 * (HEAD → index) unstages them (git apply --reverse).
 */
export function hunkStagingAction(context: DiffContext): { reverse: boolean; label: string } {
  return context === 'staged'
    ? { reverse: true, label: 'Unstage hunk' }
    : { reverse: false, label: 'Stage hunk' };
}

/**
 * The clickable gutter button for one hunk. Extracted from the GutterMarker so
 * the click → applyHunk wiring is testable without a live CodeMirror view.
 * A stale button (its hunk's snapshot lines carry unsaved edits, so the patch
 * no longer matches the screen) renders disabled instead of disappearing; the
 * save/refresh cycle re-delivers it live with a fresh patch.
 */
export function createHunkButton(
  hunk: git.Hunk,
  context: DiffContext,
  stale = false
): HTMLButtonElement {
  const { reverse, label } = hunkStagingAction(context);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cm-hunkStageBtn';
  btn.textContent = reverse ? '−' : '+';
  btn.setAttribute('aria-label', `${label} at line ${hunk.newStart}`);
  if (stale) {
    btn.disabled = true;
    btn.title = 'Saving edit…';
    return btn;
  }
  btn.title = label;
  // Act on mousedown, not click: in the editable pane a gutter mousedown moves
  // the cursor, whose active-line change re-renders the gutter and can replace
  // this button before mouseup — the click event then never fires on it.
  // preventDefault + stopPropagation also keep CodeMirror's own gutter handling
  // (line selection, focus) away from the press.
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Single-flight: runOp silently refuses while another git op runs, which
    // reads as a dead button — say why instead.
    const { opInFlight, applyHunk } = useGitStore.getState();
    if (opInFlight) {
      useIDEStore
        .getState()
        .showToast(`Git ${opInFlight} in progress — try again in a moment`, 'info');
      return;
    }
    void applyHunk(hunk.patch, reverse);
  });
  return btn;
}

class HunkMarker extends GutterMarker {
  constructor(
    private readonly hunk: git.Hunk,
    private readonly context: DiffContext,
    private readonly stale: boolean
  ) {
    super();
  }
  override toDOM(): Node {
    return createHunkButton(this.hunk, this.context, this.stale);
  }
}

/**
 * Where each hunk control sits while the pane holds unsaved edits, and whether
 * it is still live. A hunk's patch applies to the *index*, so a local edit
 * only stales the hunks whose snapshot lines it touches — those render
 * disabled in place (never vanishing mid-edit) until the save/refresh delivers
 * fresh patches, while the rest stay stageable with their anchors shifted past
 * inserted/removed lines.
 */
export function visibleHunks(
  hunks: git.Hunk[],
  cleanContent: string,
  currentContent: string
): { hunk: git.Hunk; line: number; stale: boolean }[] {
  if (currentContent === cleanContent) {
    return hunks.map((h) => ({ hunk: h, line: h.newStart, stale: false }));
  }
  // Local edits as line ranges: [fromA, toA) in snapshot coords, [fromB, toB)
  // in on-screen coords (0-based, exclusive).
  const edits = diffLines(cleanContent, currentContent);
  return hunks.map((h) => {
    const start = h.newStart - 1;
    const end = start + h.newLines;
    let offset = 0;
    let stale = false;
    for (const e of edits) {
      if (e.fromA < end && e.toA > start) {
        stale = true;
        continue;
      }
      if (e.toA <= start) offset += e.toB - e.fromB - (e.toA - e.fromA);
    }
    return { hunk: h, line: h.newStart + offset, stale };
  });
}

/**
 * A gutter for the right pane carrying a stage/unstage button at each hunk's
 * new-side start line. Returns nothing when there are no hunks (untracked,
 * binary, too-large, or clean diffs) so the pane stays plain.
 */
export function hunkStagingGutter(
  hunks: git.Hunk[],
  context: DiffContext,
  cleanContent?: string
): Extension {
  if (hunks.length === 0) return [];
  return gutter({
    class: 'cm-hunkGutter',
    markers: (view: EditorView) => {
      const doc = view.state.doc;
      // An editable pane can diverge from the git snapshot before its debounced
      // save/refresh. Keep every control in place — live ones shifted to their
      // on-screen lines, edit-touched ones disabled — so nothing flickers away.
      const visible =
        cleanContent === undefined
          ? hunks.map((h) => ({ hunk: h, line: h.newStart, stale: false }))
          : visibleHunks(hunks, cleanContent, doc.toString());
      const ranges = visible
        // A pure deletion anchors on the line after the removal; at the top of
        // the file (or a whole-file deletion) that computes to 0 — clamp to
        // line 1 like the change gutter does, instead of dropping the button.
        .map((v) => (v.hunk.newLines === 0 ? { ...v, line: Math.max(1, v.line) } : v))
        .filter(({ line }) => line >= 1 && line <= doc.lines)
        .map(({ hunk, line, stale }) =>
          new HunkMarker(hunk, context, stale).range(doc.line(line).from)
        );
      if (ranges.length === 0) return RangeSet.empty;
      // sort=true is load-bearing: visibleHunks' anchor shifts can reorder
      // entries (a large deletion between hunks moves a later one above an
      // earlier one), and RangeSet.of throws on unsorted input.
      return RangeSet.of(ranges, true);
    },
  });
}
