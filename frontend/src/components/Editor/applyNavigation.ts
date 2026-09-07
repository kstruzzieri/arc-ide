import { EditorView } from '@codemirror/view';
import type { EditorNavigationRequest } from '../../stores/ideStore';

/**
 * Move the cursor to a navigation target and scroll it into view.
 *
 * Lives in its own module (rather than inside CodeMirrorEditor) so it can be
 * unit tested without the component's heavy CodeMirror mock, and so the
 * component file only exports React components (fast-refresh friendly).
 */
export function applyNavigation(view: EditorView, nav: EditorNavigationRequest): void {
  const doc = view.state.doc;
  const lineNum = Math.min(nav.line, doc.lines);
  if (lineNum <= 0) return;
  const line = doc.line(lineNum);
  const col = Math.min((nav.column ?? 1) - 1, line.length);
  const pos = line.from + col;

  view.dispatch({
    selection: { anchor: pos },
    scrollIntoView: true,
  });
  view.focus();

  scheduleScrollAssert(view, pos, doc, MAX_SCROLL_ASSERT_FRAMES);
}

/**
 * How many animation frames the scroll may be re-asserted for. A jump far into
 * a large document needs more than one: CodeMirror only measures the lines it
 * has rendered and estimates the rest, so the first scroll lands on an estimate,
 * and only once that new region is rendered and measured does the real offset
 * become known. Each frame narrows the error, so a handful of frames converges
 * even for a line thousands of rows down. Bounded so a target that can never be
 * reached (or a user who scrolls away) cannot spin.
 */
const MAX_SCROLL_ASSERT_FRAMES = 8;

/**
 * True when `pos` is rendered and its line starts inside the scroller viewport.
 *
 * Deliberately tests only the TOP edge. Line wrapping is enabled, so a long
 * match (search results routinely hit long lines) can wrap taller than the
 * viewport in a narrow editor; requiring the whole line to fit would then be
 * unsatisfiable and burn every retry frame on a target that is already as
 * visible as it can be. "Scrolled to the line" means its start is on screen.
 */
function isPosInView(view: EditorView, pos: number): boolean {
  try {
    const coords = view.coordsAtPos(pos);
    if (!coords) return false;
    const box = view.scrollDOM.getBoundingClientRect();
    return coords.top >= box.top && coords.top <= box.bottom;
  } catch {
    // Unmeasured view (or a test double without geometry): treat as not yet in
    // view so the scroll is asserted rather than skipped.
    return false;
  }
}

/**
 * Re-assert the scroll until the target line is genuinely on screen.
 *
 * `scrollIntoView: true` on the initial dispatch resolves against whatever
 * geometry CodeMirror has at its next measure. Right after a file switch the new
 * document is unmeasured, so a distant target resolves against estimated line
 * heights and the viewport lands short — the cursor is correct but the line is
 * off-screen. Re-asserting on each frame lets the estimate converge as newly
 * rendered lines get measured, and we stop as soon as the line is actually
 * visible.
 *
 * Guards: bail if the view was torn down, if a file switch replaced the
 * document, or if follow-up navigation moved the selection off `pos`, so we
 * never yank a view the user has moved on to. Wheel and pointer input cancel
 * the sequence immediately so an explicit user interaction also wins.
 */
function scheduleScrollAssert(
  view: EditorView,
  pos: number,
  doc: EditorView['state']['doc'],
  attemptsLeft: number
): void {
  let frameId: number | null = null;
  let finished = false;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    view.scrollDOM.removeEventListener('wheel', cleanup);
    view.scrollDOM.removeEventListener('pointerdown', cleanup);
  };

  const schedule = (remainingAttempts: number) => {
    frameId = requestAnimationFrame(() => {
      if (finished) return;
      frameId = null;
      if (
        !view.dom.isConnected ||
        view.state.doc !== doc ||
        view.state.selection.main.head !== pos ||
        isPosInView(view, pos)
      ) {
        cleanup();
        return;
      }

      view.dispatch({ effects: EditorView.scrollIntoView(pos) });

      if (remainingAttempts > 1) {
        schedule(remainingAttempts - 1);
      } else {
        cleanup();
      }
    });
  };

  view.scrollDOM.addEventListener('wheel', cleanup);
  view.scrollDOM.addEventListener('pointerdown', cleanup);
  schedule(attemptsLeft);
}
