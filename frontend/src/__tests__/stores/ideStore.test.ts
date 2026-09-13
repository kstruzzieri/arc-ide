import { useIDEStore } from '../../stores/ideStore';

// Reset store between tests
beforeEach(() => {
  useIDEStore.setState({
    openFiles: [],
    activeFileId: null,
    toast: null,
    heldToasts: [],
    isLeftPanelCollapsed: false,
    isRightPanelCollapsed: false,
    isBottomPanelCollapsed: false,
    panelSizes: { left: 260, right: 280, bottom: 200, golem: 420 },
    terminalSessions: [],
    activeTerminalSessionId: null,
  });
});

describe('ideStore - editor actions', () => {
  it('should add lineEndings to opened files', () => {
    const { openFile } = useIDEStore.getState();
    openFile({
      id: '/test/file.ts',
      name: 'file.ts',
      path: '/test/file.ts',
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });

    const file = useIDEStore.getState().openFiles[0];
    expect(file.lineEndings).toBe('LF');
  });

  it('should update file content and mark as modified', () => {
    const { openFile, updateFileContent } = useIDEStore.getState();
    openFile({
      id: '/test/file.ts',
      name: 'file.ts',
      path: '/test/file.ts',
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });

    updateFileContent('/test/file.ts', 'const x = 2;');

    const file = useIDEStore.getState().openFiles[0];
    expect(file.content).toBe('const x = 2;');
    expect(file.isModified).toBe(true);
  });

  it('should not mark unmodified file when content is same', () => {
    const { openFile, updateFileContent } = useIDEStore.getState();
    openFile({
      id: '/test/file.ts',
      name: 'file.ts',
      path: '/test/file.ts',
      language: 'typescript',
      encoding: 'utf-8',
      lineEndings: 'LF',
      content: 'const x = 1;',
      isModified: false,
    });

    updateFileContent('/test/file.ts', 'const x = 1;');

    const file = useIDEStore.getState().openFiles[0];
    expect(file.isModified).toBe(false);
  });
});

describe('ideStore - panel collapse', () => {
  it('should start with all panels visible', () => {
    const state = useIDEStore.getState();
    expect(state.isLeftPanelCollapsed).toBe(false);
    expect(state.isRightPanelCollapsed).toBe(false);
    expect(state.isBottomPanelCollapsed).toBe(false);
  });

  it('should toggle left panel', () => {
    const { toggleLeftPanel } = useIDEStore.getState();
    toggleLeftPanel();
    expect(useIDEStore.getState().isLeftPanelCollapsed).toBe(true);
    toggleLeftPanel();
    expect(useIDEStore.getState().isLeftPanelCollapsed).toBe(false);
  });

  it('should toggle right panel', () => {
    const { toggleRightPanel } = useIDEStore.getState();
    toggleRightPanel();
    expect(useIDEStore.getState().isRightPanelCollapsed).toBe(true);
    toggleRightPanel();
    expect(useIDEStore.getState().isRightPanelCollapsed).toBe(false);
  });

  it('should toggle bottom panel', () => {
    const { toggleBottomPanel } = useIDEStore.getState();
    toggleBottomPanel();
    expect(useIDEStore.getState().isBottomPanelCollapsed).toBe(true);
    toggleBottomPanel();
    expect(useIDEStore.getState().isBottomPanelCollapsed).toBe(false);
  });
});

describe('ideStore - setPanelSize', () => {
  it('should set individual panel sizes', () => {
    const { setPanelSize } = useIDEStore.getState();
    setPanelSize('left', 300);
    expect(useIDEStore.getState().panelSizes.left).toBe(300);
    expect(useIDEStore.getState().panelSizes.right).toBe(280);
    expect(useIDEStore.getState().panelSizes.bottom).toBe(200);
  });

  it('should preserve other panel sizes when one changes', () => {
    const { setPanelSize } = useIDEStore.getState();
    setPanelSize('right', 350);
    setPanelSize('bottom', 150);
    const sizes = useIDEStore.getState().panelSizes;
    expect(sizes).toEqual({ left: 260, right: 350, bottom: 150, golem: 420 });
  });

  it('should clamp negative values to zero', () => {
    const { setPanelSize } = useIDEStore.getState();
    setPanelSize('left', -100);
    expect(useIDEStore.getState().panelSizes.left).toBe(0);
  });

  it('should round fractional values', () => {
    const { setPanelSize } = useIDEStore.getState();
    setPanelSize('left', 250.7);
    expect(useIDEStore.getState().panelSizes.left).toBe(251);
  });

  it('should ignore NaN values', () => {
    const { setPanelSize } = useIDEStore.getState();
    setPanelSize('left', NaN);
    expect(useIDEStore.getState().panelSizes.left).toBe(260);
  });

  it('should ignore Infinity values', () => {
    const { setPanelSize } = useIDEStore.getState();
    setPanelSize('left', Infinity);
    expect(useIDEStore.getState().panelSizes.left).toBe(260);
  });
});

describe('ideStore - terminal sessions', () => {
  it('should add a terminal session and set it active', () => {
    const { addTerminalSession } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });

    const state = useIDEStore.getState();
    expect(state.terminalSessions).toHaveLength(1);
    expect(state.terminalSessions[0]).toEqual({ id: 'term-1', title: 'Terminal 1' });
    expect(state.activeTerminalSessionId).toBe('term-1');
  });

  it('should switch active to the newly added session', () => {
    const { addTerminalSession } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });
    addTerminalSession({ id: 'term-2', title: 'Terminal 2' });

    expect(useIDEStore.getState().activeTerminalSessionId).toBe('term-2');
  });

  it('should remove a session and fall back active to last remaining', () => {
    const { addTerminalSession, removeTerminalSession } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });
    addTerminalSession({ id: 'term-2', title: 'Terminal 2' });

    removeTerminalSession('term-2');

    const state = useIDEStore.getState();
    expect(state.terminalSessions).toHaveLength(1);
    expect(state.activeTerminalSessionId).toBe('term-1');
  });

  it('should set activeTerminalSessionId to null when last session is removed', () => {
    const { addTerminalSession, removeTerminalSession } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });

    removeTerminalSession('term-1');

    const state = useIDEStore.getState();
    expect(state.terminalSessions).toHaveLength(0);
    expect(state.activeTerminalSessionId).toBeNull();
  });

  it('should fall back to adjacent session when removing middle active session', () => {
    const { addTerminalSession, setActiveTerminalSession, removeTerminalSession } =
      useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });
    addTerminalSession({ id: 'term-2', title: 'Terminal 2' });
    addTerminalSession({ id: 'term-3', title: 'Terminal 3' });
    addTerminalSession({ id: 'term-4', title: 'Terminal 4' });
    setActiveTerminalSession('term-2');

    removeTerminalSession('term-2');

    // With [term-1, term-2 (active), term-3, term-4], removing term-2 should fall back
    // to term-3 (the session now at the same index position), not term-4 (the last one).
    expect(useIDEStore.getState().activeTerminalSessionId).toBe('term-3');
  });

  it('should fall back to left neighbor when removing last-position active session', () => {
    const { addTerminalSession, removeTerminalSession } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });
    addTerminalSession({ id: 'term-2', title: 'Terminal 2' });
    addTerminalSession({ id: 'term-3', title: 'Terminal 3' });
    // term-3 is active (last added)

    removeTerminalSession('term-3');

    // Should fall back to term-2 (left neighbor), not term-1
    expect(useIDEStore.getState().activeTerminalSessionId).toBe('term-2');
  });

  it('should not change active when removing a non-active session', () => {
    const { addTerminalSession, setActiveTerminalSession, removeTerminalSession } =
      useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });
    addTerminalSession({ id: 'term-2', title: 'Terminal 2' });
    setActiveTerminalSession('term-1');

    removeTerminalSession('term-2');

    expect(useIDEStore.getState().activeTerminalSessionId).toBe('term-1');
  });

  it('should set active terminal session', () => {
    const { addTerminalSession, setActiveTerminalSession } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });
    addTerminalSession({ id: 'term-2', title: 'Terminal 2' });

    setActiveTerminalSession('term-1');

    expect(useIDEStore.getState().activeTerminalSessionId).toBe('term-1');
  });

  it('should rename a terminal session', () => {
    const { addTerminalSession, renameTerminalSession } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });

    renameTerminalSession('term-1', 'My Shell');

    expect(useIDEStore.getState().terminalSessions[0].title).toBe('My Shell');
  });

  it('should reorder terminal sessions', () => {
    const { addTerminalSession, reorderTerminalSessions } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });
    addTerminalSession({ id: 'term-2', title: 'Terminal 2' });
    addTerminalSession({ id: 'term-3', title: 'Terminal 3' });

    reorderTerminalSessions(0, 2);

    const sessions = useIDEStore.getState().terminalSessions;
    expect(sessions.map((s) => s.id)).toEqual(['term-2', 'term-3', 'term-1']);
  });

  it('should handle reorder with same index (no-op)', () => {
    const { addTerminalSession, reorderTerminalSessions } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });
    addTerminalSession({ id: 'term-2', title: 'Terminal 2' });

    reorderTerminalSessions(0, 0);

    const sessions = useIDEStore.getState().terminalSessions;
    expect(sessions.map((s) => s.id)).toEqual(['term-1', 'term-2']);
  });

  it('should ignore out-of-bounds reorder indices', () => {
    const { addTerminalSession, reorderTerminalSessions } = useIDEStore.getState();
    addTerminalSession({ id: 'term-1', title: 'Terminal 1' });
    addTerminalSession({ id: 'term-2', title: 'Terminal 2' });

    reorderTerminalSessions(-1, 0);
    reorderTerminalSessions(0, 5);

    const sessions = useIDEStore.getState().terminalSessions;
    expect(sessions.map((s) => s.id)).toEqual(['term-1', 'term-2']);
  });
});

describe('ideStore - toast', () => {
  it('should show and clear toast', () => {
    const { showToast } = useIDEStore.getState();
    showToast('Save failed', 'error');

    expect(useIDEStore.getState().toast).toEqual({
      message: 'Save failed',
      type: 'error',
    });
  });

  it('should clear toast', () => {
    const { showToast, clearToast } = useIDEStore.getState();
    showToast('Save failed', 'error');
    clearToast();

    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('holds a displaced sticky toast and restores it when the covering toast clears', () => {
    // A sticky toast carries something the user must act on (#290's refused
    // save); a passing toast may cover it but must not lose it.
    const { showToast, clearToast } = useIDEStore.getState();
    showToast('Act on me', 'error', true);
    showToast('Passing', 'info');
    expect(useIDEStore.getState().toast).toEqual({ message: 'Passing', type: 'info' });

    clearToast();
    expect(useIDEStore.getState().toast).toEqual({
      message: 'Act on me',
      type: 'error',
      sticky: true,
    });

    clearToast();
    expect(useIDEStore.getState().toast).toBeNull();
    expect(useIDEStore.getState().heldToasts).toEqual([]);
  });

  it('stacks displaced sticky toasts and does not hold a repeat of the same message', () => {
    const { showToast, clearToast } = useIDEStore.getState();
    showToast('First workspace', 'error', true);
    showToast('Second workspace', 'error', true);
    showToast('Second workspace', 'error', true);
    expect(useIDEStore.getState().heldToasts).toEqual([
      { message: 'First workspace', type: 'error', sticky: true },
    ]);

    clearToast();
    expect(useIDEStore.getState().toast?.message).toBe('First workspace');
    clearToast();
    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('re-showing a held sticky toast promotes it instead of duplicating it', () => {
    const { showToast, clearToast } = useIDEStore.getState();
    showToast('Act on me', 'error', true);
    showToast('Passing', 'info');
    showToast('Act on me', 'error', true);
    expect(useIDEStore.getState().heldToasts).toEqual([]);
    clearToast();
    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('retires a toast by message from the slot or the held stack', () => {
    const { showToast, retireToast } = useIDEStore.getState();
    showToast('Held', 'error', true);
    showToast('Shown', 'error', true);
    showToast('Passing', 'info');
    expect(useIDEStore.getState().heldToasts.map((t) => t.message)).toEqual(['Held', 'Shown']);

    // Held only: leaves the displayed toast alone.
    retireToast('Held');
    expect(useIDEStore.getState().toast?.message).toBe('Passing');
    expect(useIDEStore.getState().heldToasts.map((t) => t.message)).toEqual(['Shown']);

    // Displayed: gives way to the most recent held toast.
    retireToast('Passing');
    expect(useIDEStore.getState().toast?.message).toBe('Shown');
    expect(useIDEStore.getState().heldToasts).toEqual([]);

    // Unknown message: no-op.
    retireToast('Never shown');
    expect(useIDEStore.getState().toast?.message).toBe('Shown');

    retireToast('Shown');
    expect(useIDEStore.getState().toast).toBeNull();
  });
});
