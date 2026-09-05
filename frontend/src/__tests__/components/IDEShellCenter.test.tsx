import { StrictMode, useEffect, useState } from 'react';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { IDEShell } from '../../components/layout';
import { GolemPanel } from '../../components/Golem';
import { useIDEStore } from '../../stores/ideStore';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
import { focusEditorSurface } from '../../utils/editorSurface';
import type { ConversationView } from '../../types/golem';

jest.mock('../../wails/bindings', () => ({ ToggleMaximize: jest.fn() }));
jest.mock('../../wails/runtime', () => ({
  EventsOn: jest.fn().mockReturnValue(jest.fn()),
  WindowSetTitle: jest.fn(),
}));
jest.mock('../../utils/editorNavigation', () => ({ navigateToEditorLocation: jest.fn() }));

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
    let renders = 0;
    function Probe() {
      renders += 1;
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
    const baseline = renders;

    for (let i = 0; i < 10; i += 1) {
      drag('dragOver', filesColumn(), { dataTransfer: source, clientX: 250 + i });
    }
    expect(edgeOf(filesColumn())).toBe('left');
    expect(renders).toBe(baseline);
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
