import { useEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { IDEShell } from '../../components/layout';
import { GolemPanel } from '../../components/Golem';
import { useIDEStore } from '../../stores/ideStore';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
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
