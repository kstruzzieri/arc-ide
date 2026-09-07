import { applyNavigation } from '../../../components/Editor/applyNavigation';
import type { EditorNavigationRequest } from '../../../stores/ideStore';

// Regression guard for the bug where clicking a search result opened the file
// but left the viewport at the top. On a freshly-opened file the document is
// swapped into the shared view in the same commit, so CodeMirror resolves
// `scrollIntoView: true` against an unmeasured document and the target line
// stays off-screen (the cursor lands correctly). The fix re-asserts the scroll
// on the next animation frame, once the layout exists — guarded against a stale
// navigation or a torn-down view.
//
// applyNavigation is extracted into its own module so these tests run against
// the real EditorView (whose static scrollIntoView is a pure effect factory)
// without the heavy CodeMirror component mock.

interface NavDispatchSpec {
  selection?: { anchor: number };
  scrollIntoView?: boolean;
  effects?: { value: { y: string } };
}

/**
 * Minimal fake of the EditorView surface applyNavigation touches. The dispatch
 * spy updates the tracked selection head so the deferred re-scroll's guard
 * (`selection.main.head === pos`) behaves like the real view.
 */
function makeFakeView(text: string, connected = true) {
  const lines = text.split('\n');
  const view = {
    dom: { isConnected: connected },
    scrollDOM: document.createElement('div'),
    focus: jest.fn(),
    dispatch: jest.fn((spec: NavDispatchSpec) => {
      if (spec.selection) {
        view.state.selection = { main: { head: spec.selection.anchor } };
      }
    }),
    state: {
      selection: { main: { head: 0 } },
      doc: {
        lines: lines.length,
        line(lineNumber: number) {
          let from = 0;
          for (let i = 0; i < lineNumber - 1; i += 1) {
            from += (lines[i] ?? '').length + 1;
          }
          return { from, length: (lines[lineNumber - 1] ?? '').length };
        },
      },
    },
  };
  return view;
}

const DOC = Array.from({ length: 20 }, (_, i) => `line ${i + 1} contents`).join('\n');

function nav(line: number, column = 1): EditorNavigationRequest {
  return { fileId: '/f.ts', line, column, revision: 1 };
}

let rafCallbacks = new Map<number, FrameRequestCallback>();
let nextRafId = 1;

beforeEach(() => {
  // Capture rAF callbacks so each test controls when the deferred re-scroll runs.
  rafCallbacks = new Map();
  nextRafId = 1;
  global.requestAnimationFrame = jest.fn((cb: FrameRequestCallback) => {
    const id = nextRafId;
    nextRafId += 1;
    rafCallbacks.set(id, cb);
    return id;
  });
  global.cancelAnimationFrame = jest.fn((id: number) => {
    rafCallbacks.delete(id);
  });
});

function flushRaf() {
  const pending = [...rafCallbacks.values()];
  rafCallbacks.clear();
  pending.forEach((cb) => cb(0));
}

describe('applyNavigation', () => {
  it('moves the selection and scrolls synchronously', () => {
    const view = makeFakeView(DOC);
    const expectedPos = view.state.doc.line(5).from + 2; // line 5, column 3

    applyNavigation(view as never, nav(5, 3));

    expect(view.dispatch).toHaveBeenNthCalledWith(1, {
      selection: { anchor: expectedPos },
      scrollIntoView: true,
    });
    expect(view.focus).toHaveBeenCalled();
  });

  it('re-asserts the scroll on the next animation frame (fresh-open fix)', () => {
    const view = makeFakeView(DOC);

    applyNavigation(view as never, nav(12));
    expect(view.dispatch).toHaveBeenCalledTimes(1); // only the synchronous scroll so far

    flushRaf();

    expect(view.dispatch).toHaveBeenCalledTimes(2);
    const second = view.dispatch.mock.calls[1][0] as NavDispatchSpec;
    // The deferred dispatch carries a scrollIntoView effect, not a selection change.
    expect(second.selection).toBeUndefined();
    expect(second.effects?.value.y).toBe('nearest');
  });

  it('skips the deferred re-scroll if the selection has moved on (stale nav guard)', () => {
    const view = makeFakeView(DOC);

    applyNavigation(view as never, nav(8));
    // Simulate a rapid file switch / follow-up navigation before the frame runs.
    view.state.selection = { main: { head: 999 } };
    flushRaf();

    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  it('skips the deferred re-scroll if the document has changed', () => {
    const view = makeFakeView(DOC);

    applyNavigation(view as never, nav(8));
    view.state.doc = makeFakeView(DOC).state.doc;
    flushRaf();

    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  it('skips the deferred re-scroll if the view was torn down', () => {
    const view = makeFakeView(DOC, /* connected */ false);

    applyNavigation(view as never, nav(8));
    flushRaf();

    expect(view.dispatch).toHaveBeenCalledTimes(1);
  });

  // A jump far into a large document resolves against ESTIMATED line heights
  // (CodeMirror only measures what it has rendered), so the first scroll lands
  // short and the target is still off-screen. Observed in the wild: line 1105
  // scrolled to 4375 while the line sat ~15000px further down. The scroll must
  // keep re-asserting, as each frame measures more, until the line is on screen.
  function withGeometry(
    view: ReturnType<typeof makeFakeView>,
    isVisible: () => boolean
  ): ReturnType<typeof makeFakeView> {
    const extended = view as ReturnType<typeof makeFakeView> & {
      coordsAtPos: () => { top: number; bottom: number };
    };
    extended.scrollDOM.getBoundingClientRect = () => ({ top: 90, bottom: 704 }) as DOMRect;
    // Off-screen far below until the caller says it converged.
    extended.coordsAtPos = () =>
      isVisible() ? { top: 200, bottom: 210 } : { top: 15596, bottom: 15606 };
    return extended;
  }

  it('keeps re-asserting the scroll until the target line is really in view', () => {
    const view = makeFakeView(DOC);
    let reasserts = 0;
    withGeometry(view, () => reasserts >= 3);
    const inner = view.dispatch;
    view.dispatch = jest.fn((spec: NavDispatchSpec) => {
      if (spec.effects) reasserts += 1;
      return inner(spec);
    }) as typeof view.dispatch;

    applyNavigation(view as never, nav(12));

    flushRaf(); // 1st re-assert (still off-screen)
    expect(reasserts).toBe(1);
    flushRaf(); // 2nd
    expect(reasserts).toBe(2);
    flushRaf(); // 3rd — after this the line reports visible
    expect(reasserts).toBe(3);

    flushRaf(); // converged: must NOT scroll again
    expect(reasserts).toBe(3);
  });

  it.each(['wheel', 'pointerdown'])('stops re-asserting after user %s input', (eventType) => {
    const view = makeFakeView(DOC);
    let reasserts = 0;
    withGeometry(view, () => false);
    const inner = view.dispatch;
    view.dispatch = jest.fn((spec: NavDispatchSpec) => {
      if (spec.effects) reasserts += 1;
      return inner(spec);
    }) as typeof view.dispatch;

    applyNavigation(view as never, nav(12));
    flushRaf();
    expect(reasserts).toBe(1);

    view.scrollDOM.dispatchEvent(new Event(eventType));
    for (let i = 0; i < 10; i += 1) flushRaf();

    expect(reasserts).toBe(1);
  });

  // Line wrapping is enabled, and search results routinely match long lines, so
  // a wrapped match can be taller than the viewport. Requiring the WHOLE line to
  // fit would be unsatisfiable there and burn every retry frame; the line's start
  // being on screen is what "scrolled to it" means.
  it('treats a wrapped line taller than the viewport as in view', () => {
    const view = makeFakeView(DOC);
    let reasserts = 0;
    const extended = view as ReturnType<typeof makeFakeView> & {
      coordsAtPos: () => { top: number; bottom: number };
    };
    extended.scrollDOM.getBoundingClientRect = () => ({ top: 90, bottom: 704 }) as DOMRect;
    // Starts just inside the viewport, wraps far past its bottom edge.
    extended.coordsAtPos = () => ({ top: 200, bottom: 5000 });
    const inner = view.dispatch;
    view.dispatch = jest.fn((spec: NavDispatchSpec) => {
      if (spec.effects) reasserts += 1;
      return inner(spec);
    }) as typeof view.dispatch;

    applyNavigation(view as never, nav(12));
    flushRaf();
    flushRaf();

    expect(reasserts).toBe(0);
  });

  it('stops re-asserting after a bounded number of frames when it never converges', () => {
    const view = makeFakeView(DOC);
    let reasserts = 0;
    withGeometry(view, () => false); // never visible
    const inner = view.dispatch;
    view.dispatch = jest.fn((spec: NavDispatchSpec) => {
      if (spec.effects) reasserts += 1;
      return inner(spec);
    }) as typeof view.dispatch;

    applyNavigation(view as never, nav(12));
    for (let i = 0; i < 25; i += 1) flushRaf();

    // Bounded: never spins forever.
    expect(reasserts).toBeGreaterThan(1);
    expect(reasserts).toBeLessThanOrEqual(8);
  });

  it('clamps to the last line and ignores non-positive lines', () => {
    const view = makeFakeView(DOC);
    applyNavigation(view as never, nav(999));
    expect(view.dispatch).toHaveBeenNthCalledWith(1, {
      selection: { anchor: view.state.doc.line(20).from },
      scrollIntoView: true,
    });

    const view2 = makeFakeView(DOC);
    applyNavigation(view2 as never, nav(0));
    expect(view2.dispatch).not.toHaveBeenCalled();
  });
});
