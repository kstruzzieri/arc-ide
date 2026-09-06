import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
import { useIDEStore } from '../../stores/ideStore';
import { useSearchStore } from '../../stores/searchStore';
import { parseGolemStatus } from '../../types/golem';
import type { GolemWindowState } from '../../types/golemWindow';
import {
  createCommands,
  matchCommands,
  showGolem,
  showRunProfiles,
  type Command,
} from '../../utils/commands';

const mockUndock = jest.fn();
const mockDock = jest.fn();
const mockFocusWindow = jest.fn();
const mockReportWindowError = jest.fn();

// The relay itself is B6's own suite; here it is the seam the commands call.
jest.mock('../../golem/windowRelay', () => ({
  undockGolem: (...args: unknown[]) => mockUndock(...args) as Promise<void>,
  dockGolem: (...args: unknown[]) => mockDock(...args) as Promise<void>,
  focusGolemWindow: (...args: unknown[]) => mockFocusWindow(...args) as Promise<void>,
  reportGolemWindowError: (...args: unknown[]) => mockReportWindowError(...args),
}));

const mockNavigateToEditorLocation = jest.fn();
const mockStartProfile = jest.fn().mockResolvedValue(undefined);
const mockRestartProfile = jest.fn().mockResolvedValue(undefined);

jest.mock('../../wails/bindings', () => ({
  StartRunProfile: (...args: unknown[]) => mockStartProfile(...args),
  RestartRunProfile: (...args: unknown[]) => mockRestartProfile(...args),
  StopRunProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/editorNavigation', () => ({
  navigateToEditorLocation: (...args: unknown[]) => mockNavigateToEditorLocation(...args),
}));

const command = (id: string, title: string, keywords?: string[]): Command => ({
  id,
  title,
  keywords,
  run: jest.fn(),
});

test('keeps registry order for an empty query', () => {
  const commands = [command('z', 'Zulu'), command('a', 'Alpha')];
  expect(matchCommands(commands, '   ').map((item) => item.id)).toEqual(['z', 'a']);
});

test('ranks exact, prefix, word-boundary, then loose subsequences', () => {
  const commands = [
    command('loose', 'Repair'),
    command('word', 'Run Profiles'),
    command('prefix', 'RP Utilities'),
    command('exact', 'RP'),
  ];
  expect(matchCommands(commands, 'rp').map((item) => item.id)).toEqual([
    'exact',
    'prefix',
    'word',
    'loose',
  ]);
});

test('matches aliases case-insensitively and omits disabled/nonmatches', () => {
  const commands: Command[] = [
    { ...command('git', 'Source Control', ['git', 'scm']), enabled: () => true },
    { ...command('hidden', 'Git History', ['git']), enabled: () => false },
    command('run', 'Run Profiles'),
  ];
  expect(matchCommands(commands, 'GIT').map((item) => item.id)).toEqual(['git']);
});

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState(useIDEStore.getInitialState());
  useSearchStore.setState(useSearchStore.getInitialState());
  __resetGolemStore();
  mockUndock.mockResolvedValue(undefined);
  mockDock.mockResolvedValue(undefined);
  mockFocusWindow.mockResolvedValue(undefined);
});

const windowPhase = (phase: GolemWindowState['phase'], over: Partial<GolemWindowState> = {}) => {
  useGolemStore.getState().setWindowState({
    mode: phase === 'ready' || phase === 'closing' ? 'undocked' : 'docked',
    phase,
    instance: phase === 'closed' ? 0 : 1,
    restorePending: false,
    stateRevision: 1,
    handoff: phase === 'closed' ? 0 : 1,
    ...over,
  });
};

const commandById = (id: string) => {
  const command = createCommands(jest.fn()).find((item) => item.id === id);
  if (!command) throw new Error(`Missing command: ${id}`);
  return command;
};

const setProfileOutputState = (state: 'idle' | 'running' | 'success' | 'failed' | 'stopped') => {
  useIDEStore.setState({
    runOutputs: {
      r1: {
        runInstanceId: 'r1',
        profileId: 'p1',
        state,
        exitCode: 0,
        entries: [],
      },
    },
    runInstanceIdsByProfile: { p1: ['r1'] },
    latestRunInstanceIdByProfile: { p1: 'r1' },
  });
};

test('creates the approved command registry with stable metadata', () => {
  const openFolder = jest.fn();
  const commands = createCommands(openFolder);

  expect(commands.map((item) => item.id)).toEqual([
    'open-folder',
    'show-explorer',
    'show-search',
    'show-source-control',
    'show-run-profiles',
    'show-golem',
    'golem-configuration',
    'toggle-golem-panel',
    'golem-undock',
    'golem-dock',
    'swap-center-panels',
    'show-structure',
    'navigate-back',
    'navigate-forward',
    'run-selected-profile',
    'restart-selected-profile',
  ]);
  expect(
    commands.map(({ id, title, keywords, shortcut }) => ({ id, title, keywords, shortcut }))
  ).toEqual([
    { id: 'open-folder', title: 'Open Folder', keywords: ['folder', 'workspace'], shortcut: '⌘O' },
    { id: 'show-explorer', title: 'Show Explorer', keywords: undefined, shortcut: undefined },
    { id: 'show-search', title: 'Show Search', keywords: ['find', 'workspace'], shortcut: '⌘⇧F' },
    {
      id: 'show-source-control',
      title: 'Show Source Control',
      keywords: ['git'],
      shortcut: undefined,
    },
    {
      id: 'show-run-profiles',
      title: 'Show Run Profiles',
      keywords: undefined,
      shortcut: undefined,
    },
    {
      id: 'show-golem',
      title: 'Show Golem',
      keywords: ['ai', 'chat'],
      shortcut: '⌘⇧I',
    },
    {
      id: 'golem-configuration',
      title: 'Golem: Configuration',
      keywords: ['settings', 'models', 'providers', 'config', 'ai'],
      shortcut: undefined,
    },
    {
      id: 'toggle-golem-panel',
      title: 'Golem: Toggle Panel',
      keywords: ['ai', 'chat', 'collapse', 'expand', 'layout'],
      shortcut: undefined,
    },
    {
      id: 'golem-undock',
      title: 'Golem: Undock into a Window',
      keywords: ['window', 'monitor', 'detach'],
      shortcut: undefined,
    },
    {
      id: 'golem-dock',
      title: 'Golem: Dock into the Main Window',
      keywords: ['window', 'attach'],
      shortcut: undefined,
    },
    {
      id: 'swap-center-panels',
      title: 'Swap Files and Golem panels',
      keywords: ['layout', 'reorder', 'golem', 'files'],
      shortcut: undefined,
    },
    {
      id: 'show-structure',
      title: 'Show Structure',
      keywords: ['symbols', 'outline'],
      shortcut: '⌘⇧Y',
    },
    { id: 'navigate-back', title: 'Navigate Back', keywords: undefined, shortcut: undefined },
    { id: 'navigate-forward', title: 'Navigate Forward', keywords: undefined, shortcut: undefined },
    {
      id: 'run-selected-profile',
      title: 'Run Selected Profile',
      keywords: undefined,
      shortcut: '⌘R',
    },
    {
      id: 'restart-selected-profile',
      title: 'Restart Selected Profile',
      keywords: undefined,
      shortcut: '⌘R',
    },
  ]);

  commands[0].run();
  expect(openFolder).toHaveBeenCalledTimes(1);
});

test('shows search by selecting and expanding the sidebar, then focusing its input', () => {
  useIDEStore.setState({ activeSidebarView: 'explorer', isLeftPanelCollapsed: true });

  commandById('show-search').run();

  expect(useIDEStore.getState().activeSidebarView).toBe('search');
  expect(useIDEStore.getState().isLeftPanelCollapsed).toBe(false);
  expect(useSearchStore.getState().focusInputRevision).toBe(1);
});

test('shows run profiles by expanding only the right panel', () => {
  useIDEStore.setState({
    activeSidebarView: 'git',
    isLeftPanelCollapsed: true,
    isRightPanelCollapsed: true,
  });

  commandById('show-run-profiles').run();

  expect(useIDEStore.getState().isRightPanelCollapsed).toBe(false);
  expect(useIDEStore.getState().activeSidebarView).toBe('git');
  expect(useIDEStore.getState().isLeftPanelCollapsed).toBe(true);
});

const golemStatus = (conversationId: string, workspaceId: string) =>
  parseGolemStatus({
    available: true,
    workspaceLabel: workspaceId,
    identity: { repoEpoch: 3, workspaceId, conversationId },
    needsConsent: false,
    activeRuns: [],
  });

describe('showGolem', () => {
  it('reveals the Golem island and arms the composer', () => {
    useIDEStore.setState({ activeSidebarView: 'git' });
    const focusBefore = useGolemStore.getState().composerFocusRevision;

    commandById('show-golem').run();

    expect(useIDEStore.getState()).toMatchObject({
      centerReveal: 'golem',
      isGolemPanelCollapsed: false,
    });
    expect(useGolemStore.getState().composerFocusRevision).toBeGreaterThan(focusBefore);
    // Only the center pair: the sidebar is not this command's business.
    expect(useIDEStore.getState().activeSidebarView).toBe('git');
  });

  it('leaves the Runs dock exactly as the user left it', () => {
    useIDEStore.setState({ isRightPanelCollapsed: true });

    showGolem();

    expect(useIDEStore.getState().isRightPanelCollapsed).toBe(true);
  });

  it('selects the named conversation without disturbing the IDE workspace', () => {
    useGolemStore.getState().hydrateStatus(golemStatus('conv-a', 'frontend'));
    useGolemStore.getState().hydrateStatus(golemStatus('conv-b', 'backend'));
    useIDEStore.setState({ activeWorkspaceId: 'frontend' });
    expect(useGolemStore.getState().selectedConversationId).toBe('conv-a');

    showGolem('conv-b');

    expect(useGolemStore.getState().selectedConversationId).toBe('conv-b');
    expect(useIDEStore.getState()).toMatchObject({
      centerReveal: 'golem',
      isGolemPanelCollapsed: false,
    });
    expect(useIDEStore.getState().activeWorkspaceId).toBe('frontend');
  });

  it('keeps the current selection when called without a conversation', () => {
    useGolemStore.getState().hydrateStatus(golemStatus('conv-a', 'frontend'));

    showGolem();

    expect(useGolemStore.getState().selectedConversationId).toBe('conv-a');
  });
});

it('golem-configuration opens and focuses the app-global configuration tab', () => {
  useIDEStore.setState({ isRightPanelCollapsed: true });
  const command = createCommands(jest.fn()).find((c) => c.id === 'golem-configuration');
  expect(command).toBeDefined();
  command!.run();
  const golem = useGolemStore.getState();
  expect(golem.configTabOpen).toBe(true);
  expect(golem.configTabFocused).toBe(true);
  // The editor-area tab is the surface now: the right panel keeps whatever the
  // user had.
  expect(useIDEStore.getState().isRightPanelCollapsed).toBe(true);
});

test('showRunProfiles is exported for direct use and expands the dock', () => {
  useIDEStore.setState({ isRightPanelCollapsed: true });

  showRunProfiles();

  expect(useIDEStore.getState().isRightPanelCollapsed).toBe(false);
});

test('enables navigation only for an active file with history and preserves navigation semantics', () => {
  const back = commandById('navigate-back');
  const forward = commandById('navigate-forward');

  expect(back.enabled?.()).toBe(false);
  useIDEStore.setState({ activeFileId: '/current.ts' });
  expect(back.enabled?.()).toBe(false);
  useIDEStore.getState().pushNavigationHistory({ fileId: '/source.ts', line: 3, column: 2 });
  expect(back.enabled?.()).toBe(true);

  useIDEStore.setState({
    cursorPosition: { line: 9, column: 4 },
    cursorPositions: { '/current.ts': { line: 12, column: 8 } },
  });
  back.run();

  expect(mockNavigateToEditorLocation).toHaveBeenCalledWith('/source.ts', 3, 2);
  expect(useIDEStore.getState().navigationForward).toEqual([
    { fileId: '/current.ts', line: 12, column: 8 },
  ]);
  expect(forward.enabled?.()).toBe(true);
  forward.run();
  expect(mockNavigateToEditorLocation).toHaveBeenLastCalledWith('/current.ts', 12, 8);
});

test('resolves run targets at invocation time and ignores stopping or restarting targets', () => {
  const run = commandById('run-selected-profile');
  const restart = commandById('restart-selected-profile');

  useIDEStore.setState({
    runProfiles: [
      { id: 'p1', name: 'dev', type: 'single', source: 'user', workspaceId: 'ws' },
      { id: 'p2', name: 'test', type: 'single', source: 'user', workspaceId: 'ws' },
    ],
    activeWorkspaceId: 'ws',
    selectedProfileId: 'p2',
  });
  run.run();
  expect(mockStartProfile).toHaveBeenCalledWith('p2');

  useIDEStore.setState({
    selectedProfileId: 'p1',
  });
  setProfileOutputState('running');
  restart.run();
  expect(mockRestartProfile).toHaveBeenCalledWith('p1');

  mockStartProfile.mockClear();
  mockRestartProfile.mockClear();
  useIDEStore.setState({ stoppingProfileIds: ['p1'] });
  run.run();
  useIDEStore.setState({ stoppingProfileIds: [], restartingProfileIds: ['p1'] });
  restart.run();

  expect(mockStartProfile).not.toHaveBeenCalled();
  expect(mockRestartProfile).not.toHaveBeenCalled();
});

test('re-evaluates mutually exclusive run and restart availability from late-bound state', () => {
  const commands = createCommands(jest.fn());
  const availableActions = () =>
    matchCommands(commands, '')
      .map((item) => item.id)
      .filter((id) => id === 'run-selected-profile' || id === 'restart-selected-profile');

  useIDEStore.setState({
    runProfiles: [{ id: 'p1', name: 'test', type: 'single', source: 'user', workspaceId: 'ws' }],
    activeWorkspaceId: 'ws',
    selectedProfileId: 'p1',
  });

  for (const state of ['success', 'failed', 'stopped']) {
    setProfileOutputState(state as 'success' | 'failed' | 'stopped');
    expect(availableActions()).toEqual(['run-selected-profile']);
  }

  setProfileOutputState('idle');
  expect(availableActions()).toEqual(['restart-selected-profile']);

  setProfileOutputState('running');
  expect(availableActions()).toEqual(['restart-selected-profile']);

  useIDEStore.setState({ stoppingProfileIds: ['p1'] });
  expect(availableActions()).toEqual([]);

  useIDEStore.setState({ stoppingProfileIds: [], restartingProfileIds: ['p1'] });
  expect(availableActions()).toEqual([]);
});

test('hides and blocks run commands while workspace event admission is paused', () => {
  const commands = createCommands(jest.fn());
  useIDEStore.setState({
    runProfiles: [{ id: 'p1', name: 'test', type: 'single', source: 'user', workspaceId: 'ws' }],
    activeWorkspaceId: 'ws',
    selectedProfileId: 'p1',
    runEventsPaused: true,
    isLoadingProfiles: true,
  });

  const run = commands.find((item) => item.id === 'run-selected-profile');
  const restart = commands.find((item) => item.id === 'restart-selected-profile');
  expect(run?.enabled?.()).toBe(false);
  expect(restart?.enabled?.()).toBe(false);

  run?.run();
  restart?.run();
  expect(mockStartProfile).not.toHaveBeenCalled();
  expect(mockRestartProfile).not.toHaveBeenCalled();
});

test('derives selected-profile command state from the explicit latest run instance', () => {
  useIDEStore.setState({
    runProfiles: [{ id: 'p1', name: 'test', type: 'single', source: 'user', workspaceId: 'ws' }],
    activeWorkspaceId: 'ws',
    selectedProfileId: 'p1',
    runOutputs: {
      r1: {
        runInstanceId: 'r1',
        profileId: 'p1',
        state: 'success',
        exitCode: 0,
        entries: [],
      },
      r2: {
        runInstanceId: 'r2',
        profileId: 'p1',
        state: 'running',
        exitCode: 0,
        entries: [],
      },
    },
    runInstanceIdsByProfile: { p1: ['r1', 'r2'] },
    latestRunInstanceIdByProfile: { p1: 'r2' },
  });

  expect(commandById('run-selected-profile').enabled?.()).toBe(false);
  expect(commandById('restart-selected-profile').enabled?.()).toBe(true);
});

test('derives compound command state through the aggregate run instance', () => {
  useIDEStore.setState({
    runProfiles: [{ id: 'ci', name: 'CI', type: 'compound', source: 'user', steps: ['p1'] }],
    selectedProfileId: 'ci',
    latestRunInstanceIdByProfile: { ci: 'agg-r1' },
    runCompounds: {
      ci: {
        runInstanceId: 'agg-r1',
        compoundId: 'ci',
        name: 'CI',
        state: 'running',
        currentStep: 0,
        steps: [],
        stepOutputs: {},
      },
    },
    compoundIdByRunInstance: { 'agg-r1': 'ci' },
  });

  expect(commandById('run-selected-profile').enabled?.()).toBe(false);
  expect(commandById('restart-selected-profile').enabled?.()).toBe(true);
});

it('swap-center-panels flips the center order', () => {
  commandById('swap-center-panels').run();
  expect(useIDEStore.getState().centerOrder).toBe('golem-first');
});

describe('toggle-golem-panel (#271 §7)', () => {
  const setViewport = (width: number) =>
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });

  afterEach(() => setViewport(1024));

  it('reveals and focuses the chat from its default-collapsed rail', () => {
    setViewport(1440);
    const focusBefore = useGolemStore.getState().composerFocusRevision;

    commandById('toggle-golem-panel').run();

    expect(useIDEStore.getState()).toMatchObject({
      isGolemPanelCollapsed: false,
      centerReveal: 'golem',
    });
    expect(useGolemStore.getState().composerFocusRevision).toBeGreaterThan(focusBefore);
  });

  it('collapses only while the island is effectively visible, and refocus never toggles', () => {
    setViewport(1440);
    commandById('toggle-golem-panel').run();
    const focusAfterReveal = useGolemStore.getState().composerFocusRevision;

    // Repeat showGolem: refocuses without collapsing.
    showGolem();
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(false);
    expect(useGolemStore.getState().composerFocusRevision).toBeGreaterThan(focusAfterReveal);

    commandById('toggle-golem-panel').run();
    expect(useIDEStore.getState()).toMatchObject({
      isGolemPanelCollapsed: true,
      isFilesPanelCollapsed: false,
    });
  });

  it('reveals rather than saving true when window pressure railed a preferred-open island', () => {
    // Saved open, but the budget rails it at 1024 with Files requested.
    setViewport(1024);
    useIDEStore.getState().setPanelSize('left', 180);
    useIDEStore.getState().setPanelSize('right', 180);
    useIDEStore.setState({
      isGolemPanelCollapsed: false,
      isFilesPanelCollapsed: false,
      centerReveal: 'files',
      isLeftPanelCollapsed: false,
      isRightPanelCollapsed: false,
    });

    commandById('toggle-golem-panel').run();

    expect(useIDEStore.getState()).toMatchObject({
      isGolemPanelCollapsed: false,
      centerReveal: 'golem',
    });
  });
});

describe('window commands (#271 §5.3)', () => {
  it('offers undock only from a settled docked surface', () => {
    expect(commandById('golem-undock').enabled!()).toBe(true);

    useGolemStore.getState().setHostFrozen(true);
    expect(commandById('golem-undock').enabled!()).toBe(false);

    useGolemStore.getState().setHostFrozen(false);
    windowPhase('bootstrapping');
    expect(commandById('golem-undock').enabled!()).toBe(false);
    windowPhase('ready');
    expect(commandById('golem-undock').enabled!()).toBe(false);
  });

  it('offers dock only while the satellite is ready', () => {
    expect(commandById('golem-dock').enabled!()).toBe(false);
    windowPhase('closing');
    expect(commandById('golem-dock').enabled!()).toBe(false);
    windowPhase('ready');
    expect(commandById('golem-dock').enabled!()).toBe(true);
  });

  it('reports a refused transition instead of leaving the promise unhandled', async () => {
    mockUndock.mockRejectedValue(new Error('no display available'));
    commandById('golem-undock').run();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockReportWindowError).toHaveBeenCalledTimes(1);
    expect((mockReportWindowError.mock.calls[0][0] as Error).message).toBe('no display available');

    mockDock.mockRejectedValue(new Error('the window is busy'));
    windowPhase('ready');
    commandById('golem-dock').run();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockReportWindowError).toHaveBeenCalledTimes(2);
  });

  it('withdraws the panel toggle for the whole of a transfer', () => {
    expect(commandById('toggle-golem-panel').enabled!()).toBe(true);
    for (const phase of ['bootstrapping', 'bootstrapped', 'ready', 'closing'] as const) {
      windowPhase(phase);
      expect(commandById('toggle-golem-panel').enabled!()).toBe(false);
    }
  });
});

describe('showGolem across windows', () => {
  it('focuses the satellite instead of a hidden tree once it owns the chat', () => {
    windowPhase('ready');
    const focusBefore = useGolemStore.getState().composerFocusRevision;

    showGolem();

    expect(mockFocusWindow).toHaveBeenCalledTimes(1);
    // The request still lands: the satellite's own surface consumes it.
    expect(useGolemStore.getState().composerFocusRevision).toBeGreaterThan(focusBefore);
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(true);
  });

  it('retains the selection and the focus request through a transfer', () => {
    useGolemStore.getState().hydrateStatus(golemStatus('conv-a', 'frontend'));
    useGolemStore.getState().hydrateStatus(golemStatus('conv-b', 'backend'));
    windowPhase('closing');
    const focusBefore = useGolemStore.getState().composerFocusRevision;

    showGolem('conv-b');

    expect(useGolemStore.getState().selectedConversationId).toBe('conv-b');
    expect(useGolemStore.getState().composerFocusRevision).toBeGreaterThan(focusBefore);
    // Neither host is visible mid-transfer, so nothing is revealed or focused.
    expect(mockFocusWindow).not.toHaveBeenCalled();
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(true);
  });

  it('surfaces a refused selection rather than dropping it', () => {
    showGolem('conv-that-never-existed');

    expect(useIDEStore.getState().toast).toEqual({
      message: 'That Golem conversation is no longer open.',
      type: 'error',
    });
    // The reveal still happens: seeing the chat was the other half of the ask.
    expect(useIDEStore.getState().isGolemPanelCollapsed).toBe(false);
  });
});
