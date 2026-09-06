import { StrictMode, useEffect, useState } from 'react';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { IDEShell } from '../../components/layout';
import { GolemPanel } from '../../components/Golem';
import { useIDEStore } from '../../stores/ideStore';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
import { focusEditorSurface } from '../../utils/editorSurface';
import type { ConversationView } from '../../types/golem';
import type { GolemWindowState } from '../../types/golemWindow';

jest.mock('../../wails/bindings', () => ({ ToggleMaximize: jest.fn() }));
jest.mock('../../wails/runtime', () => ({
  EventsOn: jest.fn().mockReturnValue(jest.fn()),
  WindowSetTitle: jest.fn(),
}));
jest.mock('../../utils/editorNavigation', () => ({ navigateToEditorLocation: jest.fn() }));
// #271 B6: the rail's two actions are bound calls. Their own suite drives the
// relay; here only the buttons and the geometry around them are under test.
jest.mock('../../golem/windowRelay', () => ({
  startMainGolemRelay: () => () => undefined,
  undockGolem: () => Promise.resolve(),
  dockGolem: () => Promise.resolve(),
  focusGolemWindow: () => Promise.resolve(),
  reportGolemWindowError: jest.fn(),
}));

const setViewport = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
};

const shell = () => (
  <IDEShell
    header={() => <div />}
    sidebar={<div />}
    leftPanel={<div />}
    centerPanel={<div data-testid="editor" />}
    golemPanel={() => <div data-testid="golem" />}
    bottomPanel={<div data-testid="terminal" />}
    rightPanel={<div data-testid="runs" />}
    statusBar={<div />}
  />
);

const filesColumn = () => document.querySelector('[data-center-panel="files"]') as HTMLElement;
const golemIsland = () => document.querySelector('[data-center-panel="golem"]') as HTMLElement;

beforeEach(() => {
  jest.useFakeTimers();
  useIDEStore.setState(useIDEStore.getInitialState());
  __resetGolemStore();
  for (const cssVar of [
    '--panel-left-width',
    '--panel-right-width',
    '--panel-bottom-height',
    '--panel-golem-width',
  ]) {
    document.documentElement.style.removeProperty(cssVar);
  }
  setViewport(1440);
});

afterEach(() => {
  jest.useRealTimers();
});

/** Mount counter + local state: proves a node moved rather than remounted. */
const mounts: Record<string, number> = {};
function Sentinel({ id }: { id: string }) {
  const [value, setValue] = useState('');
  useEffect(() => {
    mounts[id] = (mounts[id] ?? 0) + 1;
  }, [id]);
  return (
    <input
      data-testid={id}
      value={value}
      aria-label={id}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

const cssVar = (name: string) => document.documentElement.style.getPropertyValue(name);
const separator = (name: string) => screen.getByRole('separator', { name });

describe('IDEShell center pair', () => {
  it('starts with Files open and Golem as a rail, both trees mounted', () => {
    render(shell());
    expect(screen.getByRole('button', { name: 'Expand Golem panel' })).toBeInTheDocument();
    expect(filesColumn()).not.toHaveStyle({ display: 'none' });
    expect(golemIsland()).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('golem')).toBeInTheDocument(); // mounted, hidden
    // The Files landmark is the whole column — terminal included, not just the editor.
    const filesRegion = screen.getByRole('region', { name: 'Files' });
    expect(filesRegion).toBe(filesColumn());
    expect(filesRegion).toContainElement(screen.getByTestId('terminal'));
  });

  it('reveals Golem, drops the rail, and writes the island width to CSS', () => {
    render(shell());
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    expect(screen.queryByRole('button', { name: 'Expand Golem panel' })).toBeNull();
    expect(golemIsland()).not.toHaveStyle({ display: 'none' });
    expect(document.documentElement.style.getPropertyValue('--panel-golem-width')).toBe('420px');
  });

  it('reorders the pair in DOM order without remounting the panels', () => {
    render(shell());
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    const editorBefore = screen.getByTestId('editor');
    act(() => useIDEStore.getState().swapCenterOrder());
    const nodes = Array.from(document.querySelectorAll('[data-center-panel]')).map((n) =>
      n.getAttribute('data-center-panel')
    );
    expect(nodes).toEqual(['golem', 'files']);
    expect(screen.getByTestId('editor')).toBe(editorBefore);
  });

  it('leaves focus alone when a reorder happens while focus sits outside the pair', () => {
    render(
      <IDEShell
        header={() => <div />}
        sidebar={<div />}
        leftPanel={<div />}
        centerPanel={
          <button type="button" data-testid="editor">
            Editor action
          </button>
        }
        golemPanel={() => <div data-testid="golem" />}
        bottomPanel={<div />}
        rightPanel={<button type="button">Runs action</button>}
        statusBar={<div />}
      />
    );
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    act(() => screen.getByTestId('editor').focus());
    const dockButton = screen.getByRole('button', { name: 'Runs action' });
    act(() => dockButton.focus());

    act(() => useIDEStore.getState().swapCenterOrder());

    // The pair moved nodes, but the focus it is allowed to restore is its own.
    expect(document.activeElement).toBe(dockButton);
  });

  it('collapsing Files makes Golem fill and shows the Files rail', () => {
    render(shell());
    act(() => {
      useIDEStore.getState().revealCenterPanel('golem');
      useIDEStore.getState().setFilesPanelCollapsed(true);
    });
    expect(screen.getByRole('button', { name: 'Expand Files panel' })).toBeInTheDocument();
    expect(golemIsland()).toHaveAttribute('data-fill', 'true');
    expect(filesColumn()).toHaveStyle({ display: 'none' });
  });

  it('degrades only the non-requested panel at 1024px and keeps preferences intact', () => {
    setViewport(1024);
    useIDEStore.getState().setPanelSize('left', 180);
    useIDEStore.getState().setPanelSize('right', 180);
    render(shell());
    act(() => useIDEStore.getState().setGolemPanelCollapsed(false)); // both preferred open
    // reveal is still 'files' → Golem rails, preference untouched
    expect(screen.getByRole('button', { name: 'Expand Golem panel' })).toBeInTheDocument();
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(false);
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    expect(screen.getByRole('button', { name: 'Expand Files panel' })).toBeInTheDocument();
    expect(useIDEStore.getState().isFilesPanelCollapsed).toBe(false);
  });

  // §6.3, rendered rather than flag-deep: an explicit editor intent has to put
  // the Files column back on screen, whichever way it was hidden.
  it('brings a railed Files column back on screen for an explicit editor focus', () => {
    render(shell());
    act(() => useIDEStore.getState().setFilesPanelCollapsed(true));
    expect(filesColumn()).toHaveStyle({ display: 'none' });

    act(() => focusEditorSurface('file'));

    expect(filesColumn()).not.toHaveStyle({ display: 'none' });
    expect(screen.queryByRole('button', { name: 'Expand Files panel' })).not.toBeInTheDocument();
    // The landmark is back with it, and still names the whole column.
    expect(screen.getByRole('region', { name: 'Files' })).toContainElement(
      screen.getByTestId('terminal')
    );
  });

  it('recovers a responsively railed Files column for focused run output', () => {
    setViewport(1024);
    useIDEStore.getState().setPanelSize('left', 180);
    useIDEStore.getState().setPanelSize('right', 180);
    render(shell());
    // Both preferred open, Golem requested: window pressure rails Files.
    act(() => useIDEStore.getState().setGolemPanelCollapsed(false));
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    expect(filesColumn()).toHaveStyle({ display: 'none' });

    act(() => useIDEStore.getState().focusProfileOutput('profile-1'));

    expect(filesColumn()).not.toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('terminal')).toBeVisible();
    // A transient retarget, not a saved collapse of the chat.
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(false);
  });

  it('keeps a hidden center root out of the accessibility tree', () => {
    render(shell());
    expect(screen.queryByRole('region', { name: 'Golem' })).not.toBeInTheDocument();

    act(() => useIDEStore.getState().revealCenterPanel('golem'));

    expect(screen.getByRole('region', { name: 'Golem' })).toBe(golemIsland());
  });

  it('carries Editor, terminal and chat state through reorder and collapse', () => {
    render(
      <IDEShell
        header={() => <div />}
        sidebar={<div />}
        leftPanel={<div />}
        centerPanel={<Sentinel id="editor-state" />}
        golemPanel={() => <Sentinel id="golem-state" />}
        bottomPanel={<Sentinel id="terminal-state" />}
        rightPanel={<div />}
        statusBar={<div />}
      />
    );
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    for (const id of ['editor-state', 'golem-state', 'terminal-state']) {
      fireEvent.change(screen.getByTestId(id), { target: { value: id } });
    }
    const before = ['editor-state', 'golem-state', 'terminal-state'].map((id) =>
      screen.getByTestId(id)
    );

    act(() => useIDEStore.getState().swapCenterOrder());
    act(() => useIDEStore.getState().setFilesPanelCollapsed(true));
    act(() => useIDEStore.getState().setFilesPanelCollapsed(false));

    for (const [index, id] of ['editor-state', 'golem-state', 'terminal-state'].entries()) {
      expect(screen.getByTestId(id)).toBe(before[index]);
      expect(screen.getByTestId(id)).toHaveValue(id);
      expect(mounts[id]).toBe(1);
    }
  });

  it('clamps an oversized restored island into both the CSS variable and the separator', () => {
    useIDEStore.setState({
      panelSizes: { left: 260, right: 280, bottom: 200, golem: 800 },
      isGolemPanelCollapsed: false,
    });
    render(shell());

    expect(cssVar('--panel-golem-width')).toBe('454px');
    const seam = separator('Resize panel golem width');
    expect(seam).toHaveAttribute('aria-valuenow', '454');
    expect(seam).toHaveAttribute('aria-valuemax', '454');
    expect(seam).toHaveAttribute('aria-valuemin', '320');
    // Effective, not preferred: widening must be able to give the 800 back.
    expect(useIDEStore.getState().panelSizes.golem).toBe(800);
  });

  it('clamps oversized restored side widths at 1024 and still shows one usable center', () => {
    setViewport(1024);
    useIDEStore.setState({ panelSizes: { left: 600, right: 600, bottom: 200, golem: 420 } });
    render(shell());

    expect(cssVar('--panel-left-width')).toBe('358px');
    expect(cssVar('--panel-right-width')).toBe('180px');
    expect(separator('Resize panel left width')).toHaveAttribute('aria-valuenow', '358');
    expect(separator('Resize panel right width')).toHaveAttribute('aria-valuenow', '180');
    // 1024 - 86 - 538 = 400: the Files column plus the Golem rail, exactly.
    expect(filesColumn()).not.toHaveStyle({ display: 'none' });
    expect(screen.getByRole('button', { name: 'Expand Golem panel' })).toBeInTheDocument();
    expect(useIDEStore.getState().panelSizes).toMatchObject({ left: 600, right: 600 });
  });

  it('recovers the preferred split when the window widens again', () => {
    setViewport(1024);
    useIDEStore.setState({
      panelSizes: { left: 180, right: 180, bottom: 200, golem: 420 },
      isGolemPanelCollapsed: false,
    });
    render(shell());
    expect(screen.getByRole('button', { name: 'Expand Golem panel' })).toBeInTheDocument();

    act(() => {
      setViewport(1440);
      window.dispatchEvent(new Event('resize'));
      jest.advanceTimersByTime(32);
    });

    expect(screen.queryByRole('button', { name: 'Expand Golem panel' })).toBeNull();
    expect(cssVar('--panel-golem-width')).toBe('420px');
    expect(useIDEStore.getState().panelSizes).toMatchObject({ left: 180, right: 180, golem: 420 });
  });

  it('gives the island CSS away live while a side is being dragged, then commits once', () => {
    useIDEStore.setState({
      panelSizes: { left: 260, right: 280, bottom: 200, golem: 420 },
      isGolemPanelCollapsed: false,
    });
    render(shell());
    expect(cssVar('--panel-golem-width')).toBe('420px');

    act(() => {
      fireEvent.mouseDown(separator('Resize panel left width'), { clientX: 260, clientY: 0 });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 360, clientY: 0 }));
      jest.advanceTimersByTime(32);
    });

    // The peer gave way before mouseup: ceiling = 1440 - 86 - 360 - 280 - 360.
    expect(cssVar('--panel-left-width')).toBe('360px');
    expect(cssVar('--panel-golem-width')).toBe('354px');
    expect(useIDEStore.getState().panelSizes.left).toBe(260); // nothing persisted yet

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(useIDEStore.getState().panelSizes.left).toBe(360);
    expect(useIDEStore.getState().panelSizes.golem).toBe(420);
  });

  // Spec §9 acceptance: the seam's polarity follows the order, because the
  // island it sizes changes sides with it. Dragging the seam left has to widen
  // a Golem sitting on the right and narrow one sitting on the left.
  it.each([['files-first', 454] as const, ['golem-first', 380] as const])(
    'resizes the island with the polarity of the %s order',
    (order, expected) => {
      useIDEStore.setState({ panelSizes: { left: 260, right: 280, bottom: 200, golem: 420 } });
      render(shell());
      act(() => useIDEStore.getState().revealCenterPanel('golem'));
      act(() => useIDEStore.getState().setCenterOrder(order));
      expect(cssVar('--panel-golem-width')).toBe('420px');

      act(() => {
        fireEvent.mouseDown(separator('Resize panel golem width'), { clientX: 500, clientY: 0 });
      });
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 460, clientY: 0 }));
        jest.advanceTimersByTime(32);
      });

      // files-first clamps at the 454px ceiling on the way up; golem-first has
      // room to give the full 40px back.
      expect(cssVar('--panel-golem-width')).toBe(`${expected}px`);
    }
  );

  it('cancels an in-flight gesture when a repository restore redefines the layout', () => {
    render(shell());
    act(() => {
      fireEvent.mouseDown(separator('Resize panel left width'), { clientX: 260, clientY: 0 });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 0 }));
      jest.advanceTimersByTime(32);
    });
    expect(cssVar('--panel-left-width')).toBe('400px');

    act(() => {
      useIDEStore.setState({ workspace: { path: '/repo/two' } as never });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'));
    });

    // The abandoned drag is neither saved nor left on screen.
    expect(useIDEStore.getState().panelSizes.left).toBe(260);
    expect(cssVar('--panel-left-width')).toBe('260px');
  });

  // A reveal that changes no collapse flag changes no effective width either
  // (`computeCenterLayout` only consults `reveal` when degraded), so it must not
  // invalidate a live gesture. An async editor/diff intent resolving mid-drag —
  // `focusEditorSurface` after an await — is the everyday way that happens.
  it('survives an editor reveal that lands mid-gesture', () => {
    render(shell());
    act(() => useIDEStore.getState().revealCenterPanel('golem'));

    act(() => {
      fireEvent.mouseDown(separator('Resize panel left width'), { clientX: 260, clientY: 0 });
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 0 }));
      jest.advanceTimersByTime(32);
    });
    expect(cssVar('--panel-left-width')).toBe('400px');

    act(() => focusEditorSurface('file'));
    expect(useIDEStore.getState().centerReveal).toBe('files');

    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 420, clientY: 0 }));
      jest.advanceTimersByTime(32);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(useIDEStore.getState().panelSizes.left).toBe(420);
    expect(cssVar('--panel-left-width')).toBe('420px');
  });
});

describe('IDEShell center reorder by drag', () => {
  const MIME = 'application/x-firn-center-panel';

  /**
   * The browser's drag data store is in *protected* mode during dragover: the
   * types are readable, the payload is not. Only drop exposes it — so the
   * transport hands back '' until `expose` is set, exactly as WKWebView does.
   */
  const transport = (payload: string, { types = [MIME], expose = false } = {}) => ({
    dropEffect: 'none',
    effectAllowed: 'move',
    types,
    setData: jest.fn(),
    getData: jest.fn((type: string) => (expose && type === MIME ? payload : '')),
  });

  type DragInit = {
    dataTransfer?: object;
    clientX?: number;
    relatedTarget?: Element | null;
  };

  /**
   * jsdom has no DragEvent, so testing-library falls back to `Event` and drops
   * the pointer coordinates; they are re-attached here.
   */
  const drag = (
    kind: 'dragStart' | 'dragEnter' | 'dragOver' | 'dragLeave' | 'drop' | 'dragEnd',
    node: Element,
    init: DragInit = {}
  ) => {
    const { clientX, relatedTarget, ...rest } = init;
    const event = createEvent[kind](node, rest);
    if (clientX !== undefined) Object.defineProperty(event, 'clientX', { value: clientX });
    if (relatedTarget !== undefined) {
      Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
    }
    act(() => {
      fireEvent(node, event);
      jest.advanceTimersByTime(32);
    });
  };

  /** Controlled geometry: jsdom measures every element as a zero-sized box. */
  const measure = (node: HTMLElement, left: number, right: number) => {
    node.getBoundingClientRect = () =>
      ({ left, right, top: 0, bottom: 100, width: right - left, height: 100 }) as DOMRect;
  };

  const openPair = () => {
    render(shell());
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    measure(filesColumn(), 100, 500);
    measure(golemIsland(), 500, 900);
  };

  const edgeOf = (node: HTMLElement) =>
    node.getAttribute('data-drop-over') ? node.getAttribute('data-drop-edge') : null;

  it('lights the far edge only past the midpoint, then places Golem left', () => {
    openPair();
    const source = transport('golem');
    drag('dragStart', golemIsland(), { dataTransfer: source });

    // Files is the left island: its right half is still short of the swap.
    drag('dragOver', filesColumn(), { dataTransfer: source, clientX: 350 });
    expect(edgeOf(filesColumn())).toBeNull();
    drag('drop', filesColumn(), {
      dataTransfer: transport('golem', { expose: true }),
      clientX: 350,
    });
    expect(useIDEStore.getState().centerOrder).toBe('files-first');

    drag('dragStart', golemIsland(), { dataTransfer: source });
    drag('dragOver', filesColumn(), { dataTransfer: source, clientX: 250 });
    expect(edgeOf(filesColumn())).toBe('left');
    drag('drop', filesColumn(), {
      dataTransfer: transport('golem', { expose: true }),
      clientX: 250,
    });

    expect(useIDEStore.getState().centerOrder).toBe('golem-first');
    expect(edgeOf(filesColumn())).toBeNull();
  });

  it('places Files right from its own bar, and repeat delivery re-asserts the same order', () => {
    openPair();
    const grip = screen.getByRole('group', { name: 'Files panel header' });
    const source = transport('files');
    drag('dragStart', grip, { dataTransfer: source });
    // The bar is the real drag source: it dims itself through the store.
    expect(useIDEStore.getState().centerDrag).toBe('files');
    expect(source.setData).toHaveBeenCalledWith(MIME, 'files');

    drag('dragOver', golemIsland(), { dataTransfer: source, clientX: 650 });
    expect(edgeOf(golemIsland())).toBeNull();
    drag('dragOver', golemIsland(), { dataTransfer: source, clientX: 750 });
    expect(edgeOf(golemIsland())).toBe('right');

    const payload = transport('files', { expose: true });
    drag('drop', golemIsland(), { dataTransfer: payload, clientX: 750 });
    expect(useIDEStore.getState().centerOrder).toBe('golem-first');
    expect(useIDEStore.getState().centerDrag).toBeNull();
    // Directed assignment, not a toggle: a duplicate delivery cannot flip back.
    drag('drop', golemIsland(), { dataTransfer: payload, clientX: 750 });
    expect(useIDEStore.getState().centerOrder).toBe('golem-first');
  });

  it('ignores a foreign drag and a payload that does not match the captured source', () => {
    openPair();
    drag('dragOver', filesColumn(), {
      dataTransfer: transport('', { types: ['Files'] }),
      clientX: 250,
    });
    expect(edgeOf(filesColumn())).toBeNull();
    drag('drop', filesColumn(), {
      dataTransfer: transport('', { types: ['Files'], expose: true }),
      clientX: 250,
    });
    expect(useIDEStore.getState().centerOrder).toBe('files-first');

    drag('dragStart', golemIsland(), { dataTransfer: transport('golem') });
    drag('drop', filesColumn(), {
      dataTransfer: transport('files', { expose: true }),
      clientX: 250,
    });
    expect(useIDEStore.getState().centerOrder).toBe('files-first');

    // The same gesture with its own payload does move — the rejections above
    // were the payload's doing, not a drop the shell never listened for.
    drag('dragStart', golemIsland(), { dataTransfer: transport('golem') });
    drag('drop', filesColumn(), {
      dataTransfer: transport('golem', { expose: true }),
      clientX: 250,
    });
    expect(useIDEStore.getState().centerOrder).toBe('golem-first');
  });

  it('keeps the indicator while the pointer crosses a child, and drops it on cancel', () => {
    openPair();
    const source = transport('golem');
    drag('dragStart', golemIsland(), { dataTransfer: source });
    drag('dragOver', filesColumn(), { dataTransfer: source, clientX: 250 });
    expect(edgeOf(filesColumn())).toBe('left');

    drag('dragLeave', filesColumn(), { relatedTarget: screen.getByTestId('editor') });
    expect(edgeOf(filesColumn())).toBe('left');
    drag('dragLeave', filesColumn(), { relatedTarget: golemIsland() });
    expect(edgeOf(filesColumn())).toBeNull();

    drag('dragOver', filesColumn(), { dataTransfer: source, clientX: 250 });
    drag('dragEnd', golemIsland(), { dataTransfer: source });
    expect(useIDEStore.getState().centerOrder).toBe('files-first');
    expect(useIDEStore.getState().centerDrag).toBeNull();
    expect(edgeOf(filesColumn())).toBeNull();
  });

  // A drag fires `dragover` continuously; the island underneath it must not be
  // rebuilt at pointer rate just because the shell around it re-renders.
  it('does not re-render the Golem island during a dragover storm', () => {
    const renders = jest.fn();
    function Probe() {
      renders();
      return <div data-testid="golem" />;
    }
    const golemPanel = () => <Probe />;
    render(
      <IDEShell
        header={() => <div />}
        sidebar={<div />}
        leftPanel={<div />}
        centerPanel={<div data-testid="editor" />}
        golemPanel={golemPanel}
        bottomPanel={<div />}
        rightPanel={<div />}
        statusBar={<div />}
      />
    );
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    measure(filesColumn(), 100, 500);
    measure(golemIsland(), 500, 900);

    const source = transport('golem');
    drag('dragStart', golemIsland(), { dataTransfer: source });
    drag('dragOver', filesColumn(), { dataTransfer: source, clientX: 250 });
    const baseline = renders.mock.calls.length;

    for (let i = 0; i < 10; i += 1) {
      drag('dragOver', filesColumn(), { dataTransfer: source, clientX: 250 + i });
    }
    expect(edgeOf(filesColumn())).toBe('left');
    expect(renders).toHaveBeenCalledTimes(baseline);
  });
});

describe('IDEShell layout announcements', () => {
  const announcer = () => screen.getByRole('status', { name: 'Layout changes' });

  it('says nothing on mount, including StrictMode effect replay', () => {
    render(<StrictMode>{shell()}</StrictMode>);
    expect(announcer()).toBeEmptyDOMElement();
  });

  it('announces the committed swap once, and nothing for an unchanged order', () => {
    render(shell());
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    act(() => useIDEStore.getState().setCenterOrder('golem-first'));
    expect(announcer()).toHaveTextContent('Golem panel moved left.');

    act(() => useIDEStore.getState().setCenterOrder('golem-first'));
    expect(announcer()).toHaveTextContent('Golem panel moved left.');
  });

  it('combines a collapse and the expand it caused into one message', () => {
    render(shell());
    act(() => useIDEStore.getState().setFilesPanelCollapsed(true));
    expect(announcer()).toHaveTextContent('Files panel collapsed. Golem panel expanded.');
  });

  it('stays quiet while a repository restore redefines the layout', () => {
    render(shell());
    act(() => {
      useIDEStore.setState({ workspace: { path: '/repo/two' } as never });
      useIDEStore.getState().applyCenterLayout({
        centerOrder: 'golem-first',
        golemWidth: 420,
        isGolemPanelCollapsed: false,
        isFilesPanelCollapsed: true,
      });
    });
    expect(announcer()).toBeEmptyDOMElement();
  });

  // The real restore is two renders apart: the path lands, and only after
  // LoadWorkspaceState resolves does applyCenterLayout follow. A session
  // comparison alone is blind to that gap, so the apply has to carry its own
  // "this was a restore" marker (spec §2.4, D2, §7).
  it('stays quiet and keeps focus when the apply lands a render after the path', () => {
    render(
      <IDEShell
        header={() => <div />}
        sidebar={<div />}
        leftPanel={<div />}
        centerPanel={<div data-testid="editor" />}
        golemPanel={() => (
          <button type="button" data-testid="golem-action">
            Golem action
          </button>
        )}
        bottomPanel={<div />}
        rightPanel={
          <button type="button" data-testid="runs-action">
            Runs action
          </button>
        }
        statusBar={<div />}
      />
    );
    const runs = screen.getByTestId('runs-action');
    act(() => runs.focus());

    act(() => {
      useIDEStore.setState({ workspace: { path: '/repo/two' } as never });
    });
    act(() => {
      useIDEStore.getState().applyCenterLayout({
        centerOrder: 'golem-first',
        golemWidth: 420,
        isGolemPanelCollapsed: false,
        isFilesPanelCollapsed: true,
      });
    });

    expect(announcer()).toBeEmptyDOMElement();
    expect(document.activeElement).toBe(runs);
  });

  // A repository with no saved state file never reaches applyCenterLayout, so
  // its session lives its whole life at the seed revision. The reset that opens
  // the *next* restore then reads as a gesture unless it moves the marker too —
  // announcing a swap and a collapse the user never asked for, and pulling
  // focus onto the rail mid-restore.
  it('stays quiet and keeps focus when a switch resets a never-restored session', () => {
    render(
      <IDEShell
        header={() => <div />}
        sidebar={<div />}
        leftPanel={<div />}
        centerPanel={<div data-testid="editor" />}
        golemPanel={() => (
          <button type="button" data-testid="golem-action">
            Golem action
          </button>
        )}
        bottomPanel={<div />}
        rightPanel={
          <button type="button" data-testid="runs-action">
            Runs action
          </button>
        }
        statusBar={<div />}
      />
    );
    // Gestures in repository A, with no restore behind them.
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    act(() => useIDEStore.getState().setCenterOrder('golem-first'));
    const runs = screen.getByTestId('runs-action');
    act(() => runs.focus());
    // Those gestures were announced legitimately; only what follows is at issue.
    announcer().textContent = '';

    act(() => {
      useIDEStore.setState({ workspace: { path: '/repo/two' } as never });
    });
    act(() => {
      useIDEStore.getState().resetWorkspaceSession();
    });

    expect(announcer()).toBeEmptyDOMElement();
    expect(document.activeElement).toBe(runs);
  });
});

describe('IDEShell center focus', () => {
  const conversation = {
    identity: { repoEpoch: 1, workspaceId: 'project', conversationId: 'c1' },
    workspaceLabel: 'repo',
    available: true,
    needsConsent: false,
    warnings: [],
    initError: null,
    destination: null,
    rawEvents: [],
    transcript: [],
    runs: {},
    activeRunId: null,
    draft: '',
    queuedTurns: [],
    pendingConsentTurn: null,
    lastFailedTurn: null,
  } as unknown as ConversationView;

  const hostedShell = () => (
    <IDEShell
      header={() => <div />}
      sidebar={<div />}
      leftPanel={<div />}
      centerPanel={<div data-testid="editor" />}
      golemPanel={(visible) => <GolemPanel visible={visible} />}
      bottomPanel={<div />}
      rightPanel={<div />}
      statusBar={<div />}
    />
  );

  const composer = () => screen.getByLabelText('Message Golem');

  beforeEach(() => {
    useGolemStore.setState({
      conversations: { c1: conversation },
      selectedConversationId: 'c1',
      hydratedIdentity: conversation.identity,
      bridgePhase: 'ready',
    });
  });

  it('never steals focus for a saved-open island the budget has railed', () => {
    setViewport(1024);
    useIDEStore.setState({
      panelSizes: { left: 180, right: 180, bottom: 200, golem: 420 },
      isGolemPanelCollapsed: false,
    });
    render(hostedShell());
    expect(screen.getByRole('button', { name: 'Expand Golem panel' })).toBeInTheDocument();

    act(() => useGolemStore.getState().requestComposerFocus());
    expect(document.activeElement).not.toBe(composer());
  });

  it('focuses the composer when its rail is clicked, and never on widening alone', () => {
    setViewport(1024);
    useIDEStore.setState({
      panelSizes: { left: 180, right: 180, bottom: 200, golem: 420 },
      isGolemPanelCollapsed: false,
    });
    render(hostedShell());

    act(() => {
      setViewport(1440);
      window.dispatchEvent(new Event('resize'));
      jest.advanceTimersByTime(32);
    });
    // The island is visible again, but nothing asked to type in it.
    expect(document.activeElement).not.toBe(composer());

    act(() => {
      setViewport(1024);
      window.dispatchEvent(new Event('resize'));
      jest.advanceTimersByTime(32);
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand Golem panel' }));
    });
    expect(document.activeElement).toBe(composer());
  });

  it('moves focus to the rail that replaced an explicitly collapsed panel', () => {
    render(hostedShell());
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    act(() => composer().focus());
    expect(document.activeElement).toBe(composer());

    act(() => useIDEStore.getState().setGolemPanelCollapsed(true));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Expand Golem panel' }));
  });
});

// ── #271 B6: the center while the satellite owns the chat ────────────────────

describe('IDEShell center pair, undocked', () => {
  const windowPhase = (phase: GolemWindowState['phase'], revision: number, reason?: string) =>
    act(() =>
      useGolemStore.getState().setWindowState({
        mode: phase === 'ready' || phase === 'closing' ? 'undocked' : 'docked',
        phase,
        instance: phase === 'closed' ? 0 : 1,
        restorePending: false,
        stateRevision: revision,
        handoff: phase === 'closed' ? 0 : 1,
        ...(reason === undefined ? {} : { reason }),
      })
    );

  /** Records the effective visibility the shell hands the island's host. */
  const visibility: boolean[] = [];
  const undockShell = () => (
    <IDEShell
      header={() => <div />}
      sidebar={<div />}
      leftPanel={<div />}
      centerPanel={<div data-testid="editor" />}
      golemPanel={(visible) => {
        visibility.push(visible);
        return <div data-testid="golem" data-visible={String(visible)} />;
      }}
      bottomPanel={<div data-testid="terminal" />}
      rightPanel={<div data-testid="runs" />}
      statusBar={<div />}
    />
  );

  beforeEach(() => {
    visibility.length = 0;
  });

  it('keeps the docked content while a saved undocked window is still bootstrapping', () => {
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    render(undockShell());
    windowPhase('bootstrapping', 1);

    // The satellite does not own the surface yet, so this window still shows it.
    expect(golemIsland()).not.toHaveStyle({ display: 'none' });
    expect(screen.queryByRole('group', { name: 'Golem window' })).toBeNull();
    expect(screen.getByTestId('golem')).toHaveAttribute('data-visible', 'true');
  });

  it('replaces the island with a two-action rail once the window is ready', () => {
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    render(undockShell());
    windowPhase('ready', 2);

    const rail = screen.getByRole('group', { name: 'Golem window' });
    const focus = screen.getByRole('button', { name: 'Focus Golem window' });
    const dock = screen.getByRole('button', { name: 'Dock Golem panel' });
    expect(rail).toContainElement(focus);
    expect(rail).toContainElement(dock);
    // Two siblings, never a button inside a button.
    expect(focus.querySelector('button')).toBeNull();
    expect(dock.querySelector('button')).toBeNull();
    expect(focus.closest('button')).toBe(focus);

    // The tree stays mounted, but it is neither visible nor focusable-into.
    expect(golemIsland()).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('golem')).toHaveAttribute('data-visible', 'false');
    expect(visibility.at(-1)).toBe(false);
    // Files fills the center and cannot be collapsed away from it.
    expect(filesColumn()).not.toHaveStyle({ display: 'none' });
    expect(screen.queryByRole('button', { name: 'Collapse Files panel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand Golem panel' })).toBeNull();
  });

  it('keeps the rail through the re-dock and disables a second transfer request', () => {
    render(undockShell());
    windowPhase('ready', 2);
    expect(screen.getByRole('button', { name: 'Dock Golem panel' })).toBeEnabled();

    windowPhase('closing', 3);

    expect(screen.getByRole('group', { name: 'Golem window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dock Golem panel' })).toBeDisabled();
    // Bringing the window forward is still possible while it hands back.
    expect(screen.getByRole('button', { name: 'Focus Golem window' })).toBeEnabled();
  });

  it('re-enables Dock as the retry when the re-dock stalls with a reason', () => {
    render(undockShell());
    windowPhase('ready', 2);
    windowPhase('closing', 3);
    expect(screen.getByRole('button', { name: 'Dock Golem panel' })).toBeDisabled();

    // Go authorized the close but the window never retired: the phase stays
    // `closing` and the snapshot names why. Dock is the retry.
    windowPhase(
      'closing',
      4,
      'The Golem window has not closed within 2s; the close is still pending.'
    );
    const dock = screen.getByRole('button', { name: 'Dock Golem panel' });
    expect(dock).toBeEnabled();
    expect(dock).toHaveAttribute('title', 'Retry docking the Golem panel');
    expect(screen.getByRole('button', { name: 'Focus Golem window' })).toBeEnabled();
  });

  it('restores the saved split when the re-dock completes', () => {
    useIDEStore.getState().setPanelSize('golem', 520);
    render(undockShell());
    windowPhase('ready', 2);
    windowPhase('closing', 3);
    expect(cssVar('--panel-golem-width')).toBe('520px');

    // What the relay does on the authoritative `closed`.
    windowPhase('closed', 4);
    act(() => useIDEStore.getState().revealCenterPanel('golem'));

    expect(screen.queryByRole('group', { name: 'Golem window' })).toBeNull();
    expect(golemIsland()).not.toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('golem')).toHaveAttribute('data-visible', 'true');
    expect(screen.getByRole('button', { name: 'Collapse Files panel' })).toBeInTheDocument();
    // Subject to the budget at this moment: the seam is live again, so the
    // saved 520 is clamped to the ceiling — and the preference is still 520.
    expect(cssVar('--panel-golem-width')).toBe('454px');
    expect(useIDEStore.getState().panelSizes.golem).toBe(520);
  });

  it('leaves oversized saved widths alone at 1024px without railing Files', () => {
    setViewport(1024);
    useIDEStore.getState().setPanelSize('left', 600);
    useIDEStore.getState().setPanelSize('right', 600);
    useIDEStore.getState().setPanelSize('golem', 880);
    render(undockShell());
    windowPhase('ready', 2);

    // Undocked is not degraded: Files is whole, and the sides are still
    // allocated by the ordinary joint clamp Plan A owns.
    expect(filesColumn()).not.toHaveStyle({ display: 'none' });
    expect(screen.queryByRole('button', { name: 'Expand Files panel' })).toBeNull();
    expect(cssVar('--panel-left-width')).toBe('358px');
    expect(cssVar('--panel-right-width')).toBe('180px');
    // The retained preference, not a split width: there is no seam to size.
    expect(cssVar('--panel-golem-width')).toBe('880px');
    expect(useIDEStore.getState().panelSizes.golem).toBe(880);
  });

  it('recovers the split after a re-dock once the window is wide enough again', () => {
    setViewport(1024);
    useIDEStore.getState().setPanelSize('golem', 880);
    render(undockShell());
    windowPhase('ready', 2);

    windowPhase('closed', 3);
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    // Still too narrow for the pair, so Plan A's degradation rails Files.
    expect(filesColumn()).toHaveStyle({ display: 'none' });

    act(() => {
      setViewport(1600);
      window.dispatchEvent(new Event('resize'));
    });
    act(() => jest.advanceTimersByTime(32));

    expect(golemIsland()).not.toHaveStyle({ display: 'none' });
    expect(filesColumn()).not.toHaveStyle({ display: 'none' });
    // 1600 - 86 - 540 = 974; ceiling = min(900, 800, 974 - 360) = 614.
    expect(cssVar('--panel-golem-width')).toBe('614px');
  });

  /** The one sr-only region the shell owns (spec §7). */
  const announcer = () => screen.getByRole('status', { name: 'Layout changes' });
  /**
   * A real focus target that survives the transition, inside the column that
   * stays: a bare div is never focused, so it would prove nothing.
   */
  const holdFocus = () => {
    const held = screen.getByRole('group', { name: 'Files panel header' });
    act(() => held.focus());
    expect(document.activeElement).toBe(held);
    return held;
  };

  it('announces the undock and moves no focus when the user opens the window', () => {
    act(() => useIDEStore.getState().revealCenterPanel('golem'));
    render(undockShell());
    const held = holdFocus();

    windowPhase('ready', 2);

    // A window move is not a collapse: it is named for what it is, and the
    // satellite's own composer — not this shell — is what takes the caret.
    expect(announcer().textContent).toBe('Golem moved to its own window.');
    expect(document.activeElement).toBe(held);
  });

  it('announces the re-dock and moves no focus when the window hands back', () => {
    render(undockShell());
    windowPhase('ready', 2);
    const held = holdFocus();

    windowPhase('closing', 3);
    windowPhase('closed', 4);

    // The reveal and the caret that follow a completed re-dock are the relay's
    // explicit act (§5.3); the shell only says the chat came back.
    expect(announcer().textContent).toBe('Golem docked.');
    expect(document.activeElement).toBe(held);
  });

  it('says nothing when a saved undocked window is restored at startup', () => {
    render(undockShell());
    // Go publishes the saved preference first; the relay's one restore opens
    // the window from there, so no user just moved the chat.
    act(() =>
      useGolemStore.getState().setWindowState({
        mode: 'undocked',
        phase: 'closed',
        instance: 0,
        restorePending: true,
        stateRevision: 1,
        handoff: 0,
      })
    );
    windowPhase('bootstrapping', 2);
    windowPhase('bootstrapped', 3);
    windowPhase('ready', 4);

    expect(announcer().textContent).toBe('');
  });
});
