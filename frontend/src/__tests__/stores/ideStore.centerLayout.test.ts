import { useIDEStore } from '../../stores/ideStore';

beforeEach(() => {
  useIDEStore.setState(useIDEStore.getInitialState());
});

describe('ideStore center layout', () => {
  it('starts files-first, Golem collapsed, Files open, golem width 420, reveal files', () => {
    const s = useIDEStore.getState();
    expect(s.centerOrder).toBe('files-first');
    expect(s.isGolemPanelCollapsed).toBe(true);
    expect(s.isFilesPanelCollapsed).toBe(false);
    expect(s.panelSizes.golem).toBe(420);
    expect(s.centerReveal).toBe('files');
  });

  it('swapCenterOrder flips the pair and setCenterOrder is idempotent', () => {
    useIDEStore.getState().swapCenterOrder();
    expect(useIDEStore.getState().centerOrder).toBe('golem-first');
    useIDEStore.getState().setCenterOrder('golem-first');
    expect(useIDEStore.getState().centerOrder).toBe('golem-first');
    useIDEStore.getState().setCenterOrder('files-first');
    expect(useIDEStore.getState().centerOrder).toBe('files-first');
  });

  it('collapsing the second panel expands the other (never both collapsed)', () => {
    const s = useIDEStore.getState();
    s.setGolemPanelCollapsed(false);
    s.setFilesPanelCollapsed(true);
    expect(useIDEStore.getState()).toMatchObject({
      isFilesPanelCollapsed: true,
      isGolemPanelCollapsed: false,
    });
    useIDEStore.getState().setGolemPanelCollapsed(true);
    expect(useIDEStore.getState()).toMatchObject({
      isFilesPanelCollapsed: false,
      isGolemPanelCollapsed: true,
    });
  });

  it('revealCenterPanel sets the transient target and expands that panel', () => {
    useIDEStore.getState().revealCenterPanel('golem');
    expect(useIDEStore.getState()).toMatchObject({
      centerReveal: 'golem',
      isGolemPanelCollapsed: false,
    });
    useIDEStore.getState().setFilesPanelCollapsed(true);
    useIDEStore.getState().revealCenterPanel('files');
    expect(useIDEStore.getState()).toMatchObject({
      centerReveal: 'files',
      isFilesPanelCollapsed: false,
    });
  });

  it('setPanelSize accepts golem and rounds it', () => {
    useIDEStore.getState().setPanelSize('golem', 512.4);
    expect(useIDEStore.getState().panelSizes.golem).toBe(512);
  });

  it('applyCenterLayout applies all four preferences atomically and derives the reveal', () => {
    useIDEStore.getState().applyCenterLayout({
      centerOrder: 'golem-first',
      golemWidth: 600,
      isGolemPanelCollapsed: false,
      isFilesPanelCollapsed: true,
    });
    expect(useIDEStore.getState()).toMatchObject({
      centerOrder: 'golem-first',
      isGolemPanelCollapsed: false,
      isFilesPanelCollapsed: true,
      centerReveal: 'golem',
    });
    expect(useIDEStore.getState().panelSizes.golem).toBe(600);
  });

  it('resetWorkspaceSession restores the center defaults', () => {
    useIDEStore.getState().applyCenterLayout({
      centerOrder: 'golem-first',
      golemWidth: 600,
      isGolemPanelCollapsed: false,
      isFilesPanelCollapsed: false,
    });
    const revisionBefore = useIDEStore.getState().centerLayoutRevision;
    useIDEStore.getState().resetWorkspaceSession();
    expect(useIDEStore.getState()).toMatchObject({
      centerOrder: 'files-first',
      isGolemPanelCollapsed: true,
      centerReveal: 'files',
    });
    expect(useIDEStore.getState().panelSizes.golem).toBe(420);
    // The marker is monotonic across the reset: a reset opens a restore, and a
    // session that never got one would otherwise hand the next reset an
    // unchanged revision for the shell to read as a gesture.
    expect(useIDEStore.getState().centerLayoutRevision).toBe(revisionBefore + 1);
  });
});
