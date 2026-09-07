import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Terminal } from '../../components/Terminal';
import { useConflictProjectionSync } from '../../hooks/useProblemsProjection';
import { useIDEStore } from '../../stores/ideStore';
import { useGitStore, type MergeSession } from '../../stores/gitStore';
import { useLSPStore, type LSPDiagnostic } from '../../stores/lspStore';
import { git, runhistory } from '../../wails/bindings';
import { EventsOn } from '../../wails/runtime';
import { Terminal as XTerm } from '@xterm/xterm';

const mockCreateTerminal = jest.fn();
const mockCloseTerminal = jest.fn();
const mockGetRunHistoryRecord = jest.fn();
const mockGitConflictState = jest.fn();

jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    CreateTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
    WriteTerminal: jest.fn(),
    CloseTerminal: (...args: unknown[]) => mockCloseTerminal(...args),
    ResizeTerminal: jest.fn(),
    GetRunHistoryRecord: (...args: unknown[]) => mockGetRunHistoryRecord(...args),
    GitConflictState: (...args: unknown[]) => mockGitConflictState(...args),
  };
});

jest.mock('../../wails/runtime', () => ({
  EventsOn: jest.fn(() => jest.fn()),
}));

function conflictRegion(index: number, hasBase = false) {
  return {
    index,
    startLine: index * 8 + 1,
    endLine: index * 8 + (hasBase ? 8 : 6),
    ours: ['ours'],
    base: hasBase ? ['base'] : [],
    theirs: ['theirs'],
    hasBase,
    oursLabel: 'HEAD',
    theirLabel: 'feature',
    baseEndsWithNewline: true,
    oursEndsWithNewline: true,
    theirsEndsWithNewline: true,
  };
}

function conflictState(path: string, regions: ReturnType<typeof conflictRegion>[]) {
  const stage = { hash: 'abc123', mode: '100644', size: 12 };
  return {
    stages: { path, base: stage, ours: stage, theirs: stage, binary: false },
    snapshot: {
      content: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n',
      encoding: 'utf-8',
      lineEndings: 'lf',
      regions,
    },
    heads: {
      operation: 'merge',
      ours: { label: 'main', hash: 'abc123', subject: 'main change' },
      theirs: { label: 'feature', hash: 'def456', subject: 'feature change' },
    },
    sourceVersion: `version:${path}`,
  };
}

function setGitStatus(
  repoRoot: string,
  files: Array<{ path: string; index: string; worktree: string; unmerged: boolean }>,
  statusRevision = 1
) {
  useGitStore.setState({
    root: repoRoot,
    epoch: 1,
    statusRevision,
    status: new git.RepoStatus({
      isRepo: true,
      repoRoot,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      files,
    }),
  });
}

function diagnostic(message: string, source = 'gopls'): LSPDiagnostic {
  return {
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } },
    severity: 1,
    source,
    message,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The conflict-read effect lives at App level, always mounted; mirror that here. */
function TerminalWithConflictSync() {
  useConflictProjectionSync();
  return <Terminal />;
}

describe('Terminal component', () => {
  beforeEach(() => {
    mockCreateTerminal.mockReset();
    mockCloseTerminal.mockReset();
    mockGetRunHistoryRecord.mockReset();
    mockCloseTerminal.mockResolvedValue(undefined);
    mockCreateTerminal.mockResolvedValueOnce('term-1').mockResolvedValueOnce('term-2');
    mockGetRunHistoryRecord.mockResolvedValue({
      version: 1,
      historyId: '018f0000-0000-7000-8000-000000000001',
      kind: runhistory.RecordKind.RecordKindOrdinary,
      profileId: 'p1',
      profileName: 'Build',
      state: 'success',
      exitCode: 0,
      startedAt: 1,
      completedAt: 2,
      outputAvailable: true,
      entries: [],
    });
    useIDEStore.setState({
      activeTerminalTab: 'terminal',
      terminalSessions: [],
      activeTerminalSessionId: null,
      runOutputs: {},
      runInstanceIdsByProfile: {},
      latestRunInstanceIdByProfile: {},
      runCompounds: {},
      compoundIdByRunInstance: {},
      activeRunOutputId: null,
      toast: null,
    });
  });

  it('does not auto-create a session; the panel waits for an explicit +', () => {
    render(<Terminal />);

    // No PTY is spawned on mount — a shell only starts when the user asks.
    expect(mockCreateTerminal).not.toHaveBeenCalled();
    expect(screen.queryByText('Terminal 1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('New terminal session')).toBeInTheDocument();
  });

  it('creates a session on demand, starting the shell in the loaded workspace root', async () => {
    useIDEStore.setState({
      workspace: { name: 'flux-ml', path: '/repo/flux-ml' } as ReturnType<
        typeof useIDEStore.getState
      >['workspace'],
    });

    render(<Terminal />);
    fireEvent.click(screen.getByLabelText('New terminal session'));

    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
    // The PTY must spawn in the workspace, not the app process's cwd (which
    // under wails dev is the firn checkout itself).
    expect(mockCreateTerminal).toHaveBeenCalledWith('/repo/flux-ml');
  });

  it('routes a terminal:output event only to the xterm session matching its termId', async () => {
    render(<Terminal />);
    fireEvent.click(screen.getByLabelText('New terminal session'));
    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('New terminal session'));
    expect(await screen.findByText('Terminal 2')).toBeInTheDocument();

    // The single-payload contract (#273 Task 4): the backend now emits one
    // { termId, data } object per "terminal:output" event instead of two
    // positional (id, data) arguments.
    const registration = jest
      .mocked(EventsOn)
      .mock.calls.find(([event]) => event === 'terminal:output');
    expect(registration).toBeDefined();
    const handler = registration![1] as (evt: { termId: string; data: string }) => void;

    const writeSpy = jest.spyOn(XTerm.prototype, 'write');
    writeSpy.mockClear();

    act(() => {
      handler({ termId: 'term-1', data: 'hello from term-1' });
    });

    // With two live sessions mounted, a mis-routed event would write into
    // both xterm instances instead of just the matching one.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('hello from term-1');

    writeSpy.mockRestore();
  });

  it('leaves the terminal panel empty after closing the last session and resets the next default title', async () => {
    render(<Terminal />);
    fireEvent.click(screen.getByLabelText('New terminal session'));

    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Close Terminal 1'));

    await waitFor(() => {
      expect(screen.queryByText('Terminal 1')).not.toBeInTheDocument();
    });
    expect(mockCloseTerminal).toHaveBeenCalledWith('term-1');
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('New terminal session')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('New terminal session'));

    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
    expect(screen.queryByText('Terminal 2')).not.toBeInTheDocument();
    expect(mockCreateTerminal).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed spawn and lets the user retry with +', async () => {
    mockCreateTerminal.mockReset();
    mockCreateTerminal.mockRejectedValueOnce(new Error('pty unavailable'));
    mockCreateTerminal.mockResolvedValueOnce('term-1');

    render(<Terminal />);
    fireEvent.click(screen.getByLabelText('New terminal session'));

    await waitFor(() => {
      expect(useIDEStore.getState().toast?.message).toContain('pty unavailable');
    });
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('New terminal session'));

    expect(await screen.findByText('Terminal 1')).toBeInTheDocument();
    expect(mockCreateTerminal).toHaveBeenCalledTimes(2);
  });

  it('uses manual keyboard navigation within the panel tablist', () => {
    render(<Terminal />);

    const panelTabs = within(screen.getByRole('tablist', { name: 'Terminal panels' }));
    const output = panelTabs.getByRole('tab', { name: 'Output' });
    const problems = panelTabs.getByRole('tab', { name: 'Problems' });
    const terminal = panelTabs.getByRole('tab', { name: 'Terminal' });
    expect([output.tabIndex, problems.tabIndex, terminal.tabIndex]).toEqual([-1, -1, 0]);

    terminal.focus();
    fireEvent.keyDown(terminal, { key: 'ArrowLeft' });
    expect(problems).toHaveFocus();
    expect(useIDEStore.getState().activeTerminalTab).toBe('terminal');

    fireEvent.keyDown(problems, { key: 'Home' });
    expect(output).toHaveFocus();
    fireEvent.keyDown(output, { key: 'ArrowLeft' });
    expect(terminal).toHaveFocus();
    fireEvent.keyDown(terminal, { key: 'End' });
    expect(terminal).toHaveFocus();
  });

  it('associates every panel tab with the named Terminal panel', () => {
    render(<Terminal />);

    const tablist = screen.getByRole('tablist', { name: 'Terminal panels' });
    const tabs = within(tablist).getAllByRole('tab');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'terminal-panel-content');
    for (const tab of tabs) expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute(
      'aria-labelledby',
      within(tablist).getByRole('tab', { name: 'Terminal' }).id
    );
  });

  it('renders retained output tabs without treating two runs of one profile as All Profiles', () => {
    useIDEStore.setState({
      activeTerminalTab: 'output',
      runProfiles: [{ id: 'p1', name: 'Build', type: 'single', source: 'user' }],
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
      activeRunOutputId: 'r2',
    });

    render(<Terminal />);

    expect(screen.getAllByText('Build (previous)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Build').length).toBeGreaterThan(0);
    expect(screen.queryByTitle('All Profiles Timeline')).not.toBeInTheDocument();
  });

  it('keeps archive-only output navigable from the outer Output tab row', async () => {
    const historyId = '018f0000-0000-7000-8000-000000000001';
    const archived = {
      historyId,
      kind: runhistory.RecordKind.RecordKindOrdinary,
      profileId: 'p1',
      profileName: 'Build',
      state: 'success',
      exitCode: 0,
      startedAt: 1,
      completedAt: 2,
      outputAvailable: true,
    };
    useIDEStore.setState({
      activeTerminalTab: 'output',
      runProfiles: [{ id: 'p1', name: 'Build', type: 'single', source: 'user' }],
      runOutputs: {},
      runInstanceIdsByProfile: {},
      runHistorySummaries: { [historyId]: archived },
      runHistoryRecords: { [historyId]: archived },
      activeRunOutputId: null,
    });

    render(<Terminal />);

    const archiveTab = screen
      .getAllByRole('button', { name: 'Build (saved)' })
      .find((tab) => tab.classList.contains('sessionTab'));
    expect(archiveTab).toBeInTheDocument();
    fireEvent.click(archiveTab as HTMLElement);
    expect(useIDEStore.getState().activeRunOutputId).toBe(`history:${historyId}`);
    await waitFor(() => expect(mockGetRunHistoryRecord).toHaveBeenCalledWith(historyId));
  });

  it('gives one live run and one saved archive unique names in both output tab rows', () => {
    const historyId = '018f0000-0000-7000-8000-000000000010';
    const archived = {
      historyId,
      kind: runhistory.RecordKind.RecordKindOrdinary,
      profileId: 'p1',
      profileName: 'Build',
      state: 'success',
      exitCode: 0,
      startedAt: 1,
      completedAt: 2,
      outputAvailable: true,
    };
    useIDEStore.setState({
      activeTerminalTab: 'output',
      runProfiles: [{ id: 'p1', name: 'Build', type: 'single', source: 'user' }],
      runOutputs: {
        live: {
          runInstanceId: 'live',
          profileId: 'p1',
          state: 'running',
          exitCode: 0,
          entries: [],
        },
      },
      runInstanceIdsByProfile: { p1: ['live'] },
      latestRunInstanceIdByProfile: { p1: 'live' },
      runHistorySummaries: { [historyId]: archived },
      runHistoryRecords: { [historyId]: archived },
      activeRunOutputId: 'live',
    });

    render(<Terminal />);

    expect(screen.getAllByRole('button', { name: 'Build' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Build (saved)' })).toHaveLength(2);
  });

  it('gives two saved archives unique ordinal names in both output tab rows', () => {
    const olderId = '018f0000-0000-7000-8000-000000000011';
    const newerId = '018f0000-0000-7000-8000-000000000012';
    const older = {
      historyId: olderId,
      kind: runhistory.RecordKind.RecordKindOrdinary,
      profileId: 'p1',
      profileName: 'Build',
      state: 'success',
      exitCode: 0,
      startedAt: 1,
      completedAt: 2,
      outputAvailable: true,
    };
    const newer = { ...older, historyId: newerId, startedAt: 3, completedAt: 4 };
    useIDEStore.setState({
      activeTerminalTab: 'output',
      runProfiles: [{ id: 'p1', name: 'Build', type: 'single', source: 'user' }],
      runOutputs: {},
      runInstanceIdsByProfile: {},
      runHistorySummaries: { [newerId]: newer, [olderId]: older },
      runHistoryRecords: { [newerId]: newer, [olderId]: older },
      activeRunOutputId: null,
    });

    render(<Terminal />);

    const olderTabs = screen.getAllByRole('button', { name: 'Build (saved 1 of 2)' });
    const newerTabs = screen.getAllByRole('button', { name: 'Build (saved 2 of 2)' });
    expect(olderTabs).toHaveLength(2);
    expect(newerTabs).toHaveLength(2);
    for (const tab of [...olderTabs, ...newerTabs]) {
      expect(tab).not.toHaveAttribute('title', expect.stringContaining('018f'));
    }
  });

  it('shows outer All for distinct ordinary profiles across live and archive namespaces', async () => {
    const historyId = '018f0000-0000-7000-8000-000000000002';
    const archived = {
      historyId,
      kind: runhistory.RecordKind.RecordKindOrdinary,
      profileId: 'p2',
      profileName: 'Test',
      state: 'success',
      exitCode: 0,
      startedAt: 1,
      completedAt: 2,
      outputAvailable: true,
    };
    useIDEStore.setState({
      activeTerminalTab: 'output',
      runProfiles: [
        { id: 'p1', name: 'Build', type: 'single', source: 'user' },
        { id: 'p2', name: 'Test', type: 'single', source: 'user' },
      ],
      runOutputs: {
        live: {
          runInstanceId: 'live',
          profileId: 'p1',
          state: 'success',
          exitCode: 0,
          entries: [],
        },
      },
      runInstanceIdsByProfile: { p1: ['live'] },
      latestRunInstanceIdByProfile: { p1: 'live' },
      runHistorySummaries: { [historyId]: archived },
      runHistoryRecords: { [historyId]: archived },
      activeRunOutputId: 'live',
    });

    render(<Terminal />);

    expect(screen.getByTitle('All Profiles Timeline')).toBeInTheDocument();

    // Only timeline mode renders the All Profiles comparison; every other view
    // mode resolves __all__ to no active output and falls through to the empty
    // state. setActiveRunOutput owns that coupling, so selecting the tab from
    // any other mode must land in timeline.
    useIDEStore.setState({ runOutputViewMode: 'merged' });
    await userEvent.click(screen.getByTitle('All Profiles Timeline'));

    expect(useIDEStore.getState().activeRunOutputId).toBe('__all__');
    expect(useIDEStore.getState().runOutputViewMode).toBe('timeline');
  });

  it('renders launch-ordered live labels, RID lifecycle state, and All from retained identities', () => {
    useIDEStore.setState({
      activeTerminalTab: 'output',
      runProfiles: [
        { id: 'p1', name: 'Build', type: 'single', source: 'user' },
        { id: 'p2', name: 'Test', type: 'single', source: 'user' },
      ],
      runOutputs: {
        first: {
          runInstanceId: 'first',
          profileId: 'p1',
          state: 'running',
          exitCode: 0,
          entries: [],
          launchSeq: 10,
        },
        second: {
          runInstanceId: 'second',
          profileId: 'p1',
          state: 'running',
          exitCode: 0,
          entries: [],
          launchSeq: 20,
        },
        'test-live': {
          runInstanceId: 'test-live',
          profileId: 'p2',
          state: 'running',
          exitCode: 0,
          entries: [],
          launchSeq: 30,
        },
      },
      runInstanceIdsByProfile: { p1: ['first', 'second'], p2: ['test-live'] },
      latestRunInstanceIdByProfile: { p1: 'second', p2: 'cleared-terminal' },
      runLaunchSeqByInstance: { first: 10, second: 20, 'test-live': 30 },
      stoppingProfileIds: ['p1'],
      stoppingRunInstanceIds: ['first'],
      activeRunOutputId: 'second',
    });

    render(<Terminal />);

    expect(screen.getAllByText('Build, Run 1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Build, Run 2').length).toBeGreaterThan(0);
    expect(screen.getByTitle('All Profiles Timeline')).toBeInTheDocument();

    const firstOuterTab = screen
      .getAllByTitle('first')
      .find((tab) => tab.classList.contains('sessionTab'));
    const secondOuterTab = screen
      .getAllByTitle('second')
      .find((tab) => tab.classList.contains('sessionTab'));
    expect(firstOuterTab?.querySelector('span')).toHaveClass('stateStopping');
    expect(secondOuterTab?.querySelector('span')).toHaveClass('stateRunning');
  });

  it('keeps session tabs in a separate manual-activation tablist', () => {
    useIDEStore.setState({
      terminalSessions: [
        { id: 'term-1', title: 'Terminal 1' },
        { id: 'term-2', title: 'Terminal 2' },
      ],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const sessionList = screen.getByRole('tablist', { name: 'Terminal sessions' });
    const terminalOne = within(sessionList).getByRole('tab', { name: /Terminal 1/ });
    const terminalTwo = within(sessionList).getByRole('tab', { name: /Terminal 2/ });
    expect([terminalOne.tabIndex, terminalTwo.tabIndex]).toEqual([0, -1]);

    terminalOne.focus();
    fireEvent.keyDown(terminalOne, { key: 'ArrowRight' });
    expect(terminalTwo).toHaveFocus();
    expect(useIDEStore.getState().activeTerminalSessionId).toBe('term-1');

    fireEvent.keyDown(terminalTwo, { key: 'Home' });
    expect(terminalOne).toHaveFocus();
    fireEvent.keyDown(terminalOne, { key: 'ArrowLeft' });
    expect(terminalTwo).toHaveFocus();
    fireEvent.keyDown(terminalTwo, { key: 'Enter' });
    expect(useIDEStore.getState().activeTerminalSessionId).toBe('term-2');
  });

  it('associates each session tab with its terminal panel', () => {
    useIDEStore.setState({
      terminalSessions: [
        { id: 'term-1', title: 'Terminal 1' },
        { id: 'term-2', title: 'Terminal 2' },
      ],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const sessionList = screen.getByRole('tablist', { name: 'Terminal sessions' });
    for (const tab of within(sessionList).getAllByRole('tab')) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    }
  });

  it('keeps rename and close controls outside session-tab semantics', () => {
    useIDEStore.setState({
      terminalSessions: [{ id: 'term-1', title: 'Terminal 1' }],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const tab = within(screen.getByRole('tablist', { name: 'Terminal sessions' })).getByRole(
      'tab',
      { name: /Terminal 1/ }
    );
    const close = screen.getByRole('button', { name: 'Close Terminal 1' });
    expect(close.closest('[role="tab"]')).toBeNull();

    fireEvent.doubleClick(tab);
    expect(
      screen.getByRole('textbox', { name: 'Rename Terminal 1' }).closest('[role="tab"]')
    ).toBeNull();
  });

  it('keeps the entire visual session tab interactive', () => {
    useIDEStore.setState({
      terminalSessions: [
        { id: 'term-1', title: 'Terminal 1' },
        { id: 'term-2', title: 'Terminal 2' },
      ],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const tab = within(screen.getByRole('tablist', { name: 'Terminal sessions' })).getByRole(
      'tab',
      { name: /Terminal 2/ }
    );
    const visualTab = tab.parentElement as HTMLElement;

    fireEvent.click(visualTab);
    expect(useIDEStore.getState().activeTerminalSessionId).toBe('term-2');

    fireEvent.contextMenu(visualTab, { clientX: 10, clientY: 20 });
    const menu = screen.getByRole('menu', { name: 'Actions for Terminal 2' });
    fireEvent.keyDown(within(menu).getByRole('menuitem', { name: 'Rename' }), { key: 'Escape' });

    fireEvent.doubleClick(visualTab);
    expect(screen.getByRole('textbox', { name: 'Rename Terminal 2' })).toBeInTheDocument();
  });

  it('does not route a close-button context menu to the session tab', () => {
    useIDEStore.setState({
      terminalSessions: [{ id: 'term-1', title: 'Terminal 1' }],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const event = createEvent.contextMenu(screen.getByRole('button', { name: 'Close Terminal 1' }));
    fireEvent(screen.getByRole('button', { name: 'Close Terminal 1' }), event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('leaves rename inputs and close buttons in control of their own keys', async () => {
    useIDEStore.setState({
      terminalSessions: [{ id: 'term-1', title: 'Terminal 1' }],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const sessionList = screen.getByRole('tablist', { name: 'Terminal sessions' });
    const tab = within(sessionList).getByRole('tab', { name: /Terminal 1/ });
    const close = screen.getByRole('button', { name: 'Close Terminal 1' });
    const closeSpace = createEvent.keyDown(close, { key: ' ' });
    fireEvent(close, closeSpace);
    expect(closeSpace.defaultPrevented).toBe(false);

    fireEvent.doubleClick(tab);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Renamed session' } });
    fireEvent.doubleClick(input);
    expect(input).toHaveValue('Renamed session');

    const inputContextMenu = createEvent.contextMenu(input);
    fireEvent(input, inputContextMenu);
    expect(inputContextMenu.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    const inputSpace = createEvent.keyDown(input, { key: ' ' });
    fireEvent(input, inputSpace);
    expect(inputSpace.defaultPrevented).toBe(false);

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(tab).toHaveFocus());
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(useIDEStore.getState().terminalSessions[0].title).toBe('Terminal 1');
  });

  it('returns focus to the session tab after committing a rename with Enter', async () => {
    useIDEStore.setState({
      terminalSessions: [{ id: 'term-1', title: 'Terminal 1' }],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const tab = within(screen.getByRole('tablist', { name: 'Terminal sessions' })).getByRole(
      'tab',
      { name: /Terminal 1/ }
    );
    fireEvent.doubleClick(tab);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Committed session' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useIDEStore.getState().terminalSessions[0].title).toBe('Committed session');
    await waitFor(() => expect(tab).toHaveFocus());
  });

  it.each([
    ['ContextMenu', false],
    ['F10', true],
  ])('opens an accessible session menu with %s', (key, shiftKey) => {
    useIDEStore.setState({
      terminalSessions: [{ id: 'term-1', title: 'Terminal 1' }],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const tab = within(screen.getByRole('tablist', { name: 'Terminal sessions' })).getByRole(
      'tab',
      { name: /Terminal 1/ }
    );
    expect(tab).toHaveAttribute('aria-haspopup', 'menu');
    // aria-expanded is deliberately absent: on a role="tab" it would describe the
    // tabpanel state and contradict aria-selected. Menu state is conveyed by focus.
    expect(tab).not.toHaveAttribute('aria-expanded');

    tab.focus();
    fireEvent.keyDown(tab, { key, shiftKey });

    const menu = screen.getByRole('menu', { name: 'Actions for Terminal 1' });
    const rename = within(menu).getByRole('menuitem', { name: 'Rename' });
    const close = within(menu).getByRole('menuitem', { name: 'Close Terminal' });
    expect([rename.tabIndex, close.tabIndex]).toEqual([-1, -1]);
    expect(rename).toHaveFocus();

    fireEvent.keyDown(rename, { key: 'ArrowDown' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'ArrowDown' });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(rename, { key: 'ArrowUp' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Home' });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(rename, { key: 'End' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(tab).toHaveFocus();
  });

  it.each([
    ['Tab', false],
    ['Shift+Tab', true],
  ])('dismisses the session menu while %s moves focus onward', async (_label, shift) => {
    const user = userEvent.setup();
    useIDEStore.setState({
      terminalSessions: [{ id: 'term-1', title: 'Terminal 1' }],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const tab = within(screen.getByRole('tablist', { name: 'Terminal sessions' })).getByRole(
      'tab',
      { name: /Terminal 1/ }
    );
    fireEvent.keyDown(tab, { key: 'ContextMenu' });
    const menu = screen.getByRole('menu');
    const rename = within(menu).getByRole('menuitem', { name: 'Rename' });
    expect(rename).toHaveFocus();

    await user.tab({ shift });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(rename).not.toHaveFocus();
    const destination = shift
      ? screen.getByRole('tabpanel', { name: 'Terminal' })
      : within(screen.getByRole('tablist', { name: 'Terminal panels' })).getByRole('tab', {
          name: 'Terminal',
        });
    expect(destination).toHaveFocus();
  });

  it('does not steal focus when the session menu is dismissed with the pointer', async () => {
    const user = userEvent.setup();
    useIDEStore.setState({
      terminalSessions: [{ id: 'term-1', title: 'Terminal 1' }],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const tab = within(screen.getByRole('tablist', { name: 'Terminal sessions' })).getByRole(
      'tab',
      { name: /Terminal 1/ }
    );
    fireEvent.contextMenu(tab, { clientX: 10, clientY: 20 });
    const menu = screen.getByRole('menu');
    const overlay = menu.previousElementSibling as HTMLElement;
    const newSession = screen.getByRole('button', { name: 'New terminal session' });
    newSession.focus();

    await user.click(overlay);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(newSession).toHaveFocus();
  });

  it('restores the invoking tab when overlay dismissal has no new focus destination', async () => {
    const user = userEvent.setup();
    useIDEStore.setState({
      terminalSessions: [{ id: 'term-1', title: 'Terminal 1' }],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    const tab = within(screen.getByRole('tablist', { name: 'Terminal sessions' })).getByRole(
      'tab',
      { name: /Terminal 1/ }
    );
    fireEvent.contextMenu(tab, { clientX: 10, clientY: 20 });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toHaveFocus();

    await user.click(menu.previousElementSibling as HTMLElement);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(tab).toHaveFocus();
  });

  it('restores focus after cancelling rename and closing sessions from the menu', async () => {
    useIDEStore.setState({
      terminalSessions: [
        { id: 'term-1', title: 'Terminal 1' },
        { id: 'term-2', title: 'Terminal 2' },
      ],
      activeTerminalSessionId: 'term-1',
    });

    render(<Terminal />);

    let sessionList = screen.getByRole('tablist', { name: 'Terminal sessions' });
    const first = within(sessionList).getByRole('tab', { name: /Terminal 1/ });
    fireEvent.keyDown(first, { key: 'F10', shiftKey: true });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(first).toHaveFocus());
    expect(useIDEStore.getState().terminalSessions[0].title).toBe('Terminal 1');

    fireEvent.keyDown(first, { key: 'ContextMenu' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Terminal' }));
    await waitFor(() => {
      sessionList = screen.getByRole('tablist', { name: 'Terminal sessions' });
      expect(within(sessionList).getByRole('tab', { name: /Terminal 2/ })).toHaveFocus();
    });

    const second = within(sessionList).getByRole('tab', { name: /Terminal 2/ });
    fireEvent.keyDown(second, { key: 'ContextMenu' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Terminal' }));
    await waitFor(() => {
      expect(screen.queryByRole('tablist', { name: 'Terminal sessions' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New terminal session' })).toHaveFocus();
    });
  });
});

describe('Terminal — conflicted Problems projection', () => {
  beforeEach(() => {
    mockGitConflictState.mockReset();
    useIDEStore.setState(useIDEStore.getInitialState(), true);
    useIDEStore.setState({ activeTerminalTab: 'problems', toast: null });
    useGitStore.setState(useGitStore.getInitialState(), true);
    useLSPStore.setState(useLSPStore.getInitialState(), true);
  });

  afterEach(() => {
    act(() => {
      useIDEStore.setState(useIDEStore.getInitialState(), true);
      useGitStore.setState(useGitStore.getInitialState(), true);
      useLSPStore.setState(useLSPStore.getInitialState(), true);
    });
  });

  it('renders one warning row but counts exact conflict regions in the badge', async () => {
    const regions = [
      conflictRegion(0),
      conflictRegion(1, true),
      conflictRegion(2),
      conflictRegion(3),
    ];
    mockGitConflictState.mockResolvedValue(conflictState('conflict.go', regions));
    const openMergeResolution = jest.fn().mockResolvedValue(true);
    setGitStatus('/repo', [{ path: 'conflict.go', index: 'U', worktree: 'U', unmerged: true }]);
    useGitStore.setState({ openMergeResolution });
    const rawDiagnostics = [diagnostic('expected declaration'), diagnostic('expected semicolon')];
    useLSPStore.getState().setDiagnostics('file:///repo/conflict.go', rawDiagnostics);

    render(<TerminalWithConflictSync />);

    const message = await screen.findByText(
      '4 unresolved conflict regions — language diagnostics are suspended (13 conflict marker lines).'
    );
    const row = message.parentElement as HTMLElement;
    expect(within(row).getByText('W')).toBeInTheDocument();
    expect(screen.queryByText('expected declaration')).not.toBeInTheDocument();
    expect(screen.queryByText('expected semicolon')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('tab', { name: /Problems/ })).getByText('4')
    ).toBeInTheDocument();
    expect(useLSPStore.getState().diagnostics.get('file:///repo/conflict.go')).toBe(rawDiagnostics);

    await userEvent.click(within(row).getByRole('button', { name: 'Resolve conflict.go' }));

    expect(openMergeResolution).toHaveBeenCalledWith('conflict.go', ['conflict.go']);
  });

  it('opens Resolve with the current ordered conflict queue', async () => {
    mockGitConflictState.mockImplementation((_repoRoot: string, path: string) =>
      Promise.resolve(conflictState(path, [conflictRegion(0)]))
    );
    const openMergeResolution = jest.fn().mockResolvedValue(true);
    setGitStatus('/repo', [
      { path: 'first.py', index: 'U', worktree: 'U', unmerged: true },
      { path: 'second.go', index: 'U', worktree: 'U', unmerged: true },
    ]);
    useGitStore.setState({ openMergeResolution });

    render(<TerminalWithConflictSync />);

    await userEvent.click(await screen.findByRole('button', { name: 'Resolve second.go' }));

    expect(openMergeResolution).toHaveBeenCalledWith('second.go', ['first.py', 'second.go']);
  });

  it('removes a conflict warning immediately when accepted status marks the file clean', async () => {
    mockGitConflictState.mockResolvedValue(conflictState('app.py', [conflictRegion(0)]));
    setGitStatus('/repo', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore
      .getState()
      .setDiagnostics('file:///repo/app.py', [diagnostic('Unexpected indentation', 'pyright')]);
    render(<TerminalWithConflictSync />);
    expect(await screen.findByText(/language diagnostics are suspended/)).toBeInTheDocument();

    act(() => {
      const status = useGitStore.getState().status!;
      useGitStore.setState((state) => ({
        status: new git.RepoStatus({
          ...status,
          files: [{ path: 'app.py', index: 'M', worktree: '.', unmerged: false }],
        }),
        statusRevision: state.statusRevision + 1,
      }));
    });

    expect(screen.queryByText(/language diagnostics are suspended/)).not.toBeInTheDocument();
    expect(screen.getByText('Unexpected indentation')).toBeInTheDocument();
  });

  it('keeps the collapsed warning across a status refresh while the re-read is in flight', async () => {
    const second = deferred<ReturnType<typeof conflictState>>();
    mockGitConflictState
      .mockResolvedValueOnce(conflictState('app.go', [conflictRegion(0)]))
      .mockReturnValueOnce(second.promise);
    setGitStatus('/repo', [{ path: 'app.go', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore
      .getState()
      .setDiagnostics('file:///repo/app.go', [diagnostic('expected declaration')]);

    render(<TerminalWithConflictSync />);
    expect(await screen.findByText(/language diagnostics are suspended/)).toBeInTheDocument();

    act(() => {
      setGitStatus('/repo', [{ path: 'app.go', index: 'U', worktree: 'U', unmerged: true }], 2);
    });

    expect(screen.getByText(/language diagnostics are suspended/)).toBeInTheDocument();
    expect(screen.queryByText('expected declaration')).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(conflictState('app.go', [conflictRegion(0)]));
      await second.promise;
    });

    expect(screen.getByText(/language diagnostics are suspended/)).toBeInTheDocument();
  });

  it('does not repeat an identical conflict read failure toast on every refresh', async () => {
    mockGitConflictState.mockRejectedValue(new Error('disk denied'));
    setGitStatus('/repo', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }]);
    render(<TerminalWithConflictSync />);
    await waitFor(() =>
      expect(useIDEStore.getState().toast?.message).toBe(
        'Could not read conflict state for app.py: disk denied'
      )
    );

    act(() => {
      useIDEStore.setState({ toast: null });
    });
    act(() => {
      setGitStatus('/repo', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }], 2);
    });
    await waitFor(() => expect(mockGitConflictState).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(useIDEStore.getState().toast).toBeNull();

    mockGitConflictState.mockResolvedValue(conflictState('app.py', [conflictRegion(0)]));
    act(() => {
      setGitStatus('/repo', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }], 3);
    });
    expect(await screen.findByText(/language diagnostics are suspended/)).toBeInTheDocument();

    mockGitConflictState.mockRejectedValue(new Error('disk denied'));
    act(() => {
      setGitStatus('/repo', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }], 4);
    });
    await waitFor(() =>
      expect(useIDEStore.getState().toast?.message).toBe(
        'Could not read conflict state for app.py: disk denied'
      )
    );
  });

  it('surfaces the same conflict read failure after switching repositories', async () => {
    mockGitConflictState.mockRejectedValue(new Error('disk denied'));
    setGitStatus('/repo-old', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }]);
    render(<TerminalWithConflictSync />);
    await waitFor(() =>
      expect(useIDEStore.getState().toast?.message).toBe(
        'Could not read conflict state for app.py: disk denied'
      )
    );

    act(() => {
      useIDEStore.setState({ toast: null });
      useGitStore.getState().resetForWorkspace('/repo-new');
      useGitStore.setState({
        statusRevision: 1,
        status: new git.RepoStatus({
          isRepo: true,
          repoRoot: '/repo-new',
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          files: [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }],
        }),
      });
    });

    await waitFor(() => expect(mockGitConflictState).toHaveBeenCalledWith('/repo-new', 'app.py'));
    await waitFor(() =>
      expect(useIDEStore.getState().toast?.message).toBe(
        'Could not read conflict state for app.py: disk denied'
      )
    );
  });

  it('surfaces the same conflict read failure after a conflict-free interval', async () => {
    mockGitConflictState.mockRejectedValue(new Error('disk denied'));
    setGitStatus('/repo', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }]);
    render(<TerminalWithConflictSync />);
    await waitFor(() =>
      expect(useIDEStore.getState().toast?.message).toBe(
        'Could not read conflict state for app.py: disk denied'
      )
    );

    act(() => {
      useIDEStore.setState({ toast: null });
      setGitStatus('/repo', [], 2);
    });
    act(() => {
      setGitStatus('/repo', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }], 3);
    });

    await waitFor(() => expect(mockGitConflictState).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(useIDEStore.getState().toast?.message).toBe(
        'Could not read conflict state for app.py: disk denied'
      )
    );
  });

  it('retains real diagnostics when a snapshot arrives without parsed regions', async () => {
    const read = deferred<unknown>();
    mockGitConflictState.mockReturnValue(read.promise);
    const state = conflictState('odd.ts', [conflictRegion(0)]);
    setGitStatus('/repo', [{ path: 'odd.ts', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore.getState().setDiagnostics('file:///repo/odd.ts', [diagnostic('real error')]);

    render(<TerminalWithConflictSync />);
    await waitFor(() => expect(mockGitConflictState).toHaveBeenCalledWith('/repo', 'odd.ts'));
    await act(async () => {
      read.resolve({ ...state, snapshot: { ...state.snapshot, regions: undefined } });
      await read.promise;
    });

    expect(screen.getByText('real error')).toBeInTheDocument();
    expect(screen.queryByText(/language diagnostics are suspended/)).not.toBeInTheDocument();
    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('does not install a stale conflict read after clean status replaces it', async () => {
    const pending = deferred<ReturnType<typeof conflictState>>();
    mockGitConflictState.mockReturnValue(pending.promise);
    setGitStatus('/repo', [{ path: 'stale.go', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore
      .getState()
      .setDiagnostics('file:///repo/stale.go', [diagnostic('real parser error')]);
    render(<TerminalWithConflictSync />);
    await waitFor(() => expect(mockGitConflictState).toHaveBeenCalledWith('/repo', 'stale.go'));

    act(() => {
      const status = useGitStore.getState().status!;
      useGitStore.setState((state) => ({
        status: new git.RepoStatus({ ...status, files: [] }),
        statusRevision: state.statusRevision + 1,
      }));
    });
    await act(async () => {
      pending.resolve(conflictState('stale.go', [conflictRegion(0), conflictRegion(1)]));
      await pending.promise;
    });

    expect(screen.queryByText(/language diagnostics are suspended/)).not.toBeInTheDocument();
    expect(screen.getByText('real parser error')).toBeInTheDocument();
  });

  it('drops an old repository read after switching to a different repository', async () => {
    const oldRead = deferred<ReturnType<typeof conflictState>>();
    mockGitConflictState.mockImplementation((repoRoot: string, path: string) =>
      repoRoot === '/repo-old'
        ? oldRead.promise
        : Promise.resolve(conflictState(path, [conflictRegion(0)]))
    );
    setGitStatus('/repo-old', [{ path: 'old.go', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore.getState().setDiagnostics('file:///repo/old.go', [diagnostic('old diagnostic')]);
    render(<TerminalWithConflictSync />);
    await waitFor(() => expect(mockGitConflictState).toHaveBeenCalledWith('/repo-old', 'old.go'));

    act(() => {
      useGitStore.getState().resetForWorkspace('/repo-new');
      useGitStore.setState({
        statusRevision: 1,
        status: new git.RepoStatus({
          isRepo: true,
          repoRoot: '/repo-new',
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          files: [{ path: 'new.py', index: 'U', worktree: 'U', unmerged: true }],
        }),
      });
    });
    expect(
      await screen.findByText(
        '1 unresolved conflict region — language diagnostics are suspended (3 conflict marker lines).'
      )
    ).toBeInTheDocument();

    await act(async () => {
      oldRead.resolve(
        conflictState('old.go', [
          conflictRegion(0),
          conflictRegion(1),
          conflictRegion(2),
          conflictRegion(3),
        ])
      );
      await oldRead.promise;
    });

    expect(screen.queryByText(/^4 unresolved conflict regions/)).not.toBeInTheDocument();
    expect(screen.getByText('old diagnostic')).toBeInTheDocument();
  });

  it('retains real diagnostics and surfaces an exact conflict read failure', async () => {
    mockGitConflictState.mockRejectedValue(new Error('disk denied'));
    setGitStatus('/repo', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore
      .getState()
      .setDiagnostics('file:///repo/app.py', [diagnostic('Unexpected indentation', 'pyright')]);

    render(<TerminalWithConflictSync />);

    await waitFor(() =>
      expect(useIDEStore.getState().toast?.message).toBe(
        'Could not read conflict state for app.py: disk denied'
      )
    );
    expect(screen.getByText('Unexpected indentation')).toBeInTheDocument();
    expect(screen.queryByText(/language diagnostics are suspended/)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('tab', { name: /Problems/ })).getByText('1')
    ).toBeInTheDocument();
  });

  it('retains real diagnostics without an error when the conflict has no text snapshot', async () => {
    const read = deferred<unknown>();
    mockGitConflictState.mockReturnValue(read.promise);
    const state = conflictState('binary.dat', []);
    setGitStatus('/repo', [{ path: 'binary.dat', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore
      .getState()
      .setDiagnostics('file:///repo/binary.dat', [diagnostic('Binary file diagnostic')]);

    render(<TerminalWithConflictSync />);
    await waitFor(() => expect(mockGitConflictState).toHaveBeenCalledWith('/repo', 'binary.dat'));
    await act(async () => {
      read.resolve({ ...state, stages: { ...state.stages, binary: true }, snapshot: undefined });
      await read.promise;
    });

    expect(screen.getByText('Binary file diagnostic')).toBeInTheDocument();
    expect(screen.queryByText(/language diagnostics are suspended/)).not.toBeInTheDocument();
    expect(useIDEStore.getState().toast).toBeNull();
  });

  it('retains real diagnostics when the exact snapshot has no unresolved regions', async () => {
    const read = deferred<ReturnType<typeof conflictState>>();
    mockGitConflictState.mockReturnValue(read.promise);
    setGitStatus('/repo', [{ path: 'resolved.ts', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore
      .getState()
      .setDiagnostics('file:///repo/resolved.ts', [diagnostic('Valid post-resolution diagnostic')]);

    render(<TerminalWithConflictSync />);
    await waitFor(() => expect(mockGitConflictState).toHaveBeenCalledWith('/repo', 'resolved.ts'));
    await act(async () => {
      read.resolve(conflictState('resolved.ts', []));
      await read.promise;
    });

    expect(screen.getByText('Valid post-resolution diagnostic')).toBeInTheDocument();
    expect(screen.queryByText(/language diagnostics are suspended/)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('tab', { name: /Problems/ })).getByText('1')
    ).toBeInTheDocument();
  });
});

describe('Terminal — git signal on focus exit', () => {
  const mergeSession = {
    kind: 'text',
    path: 'conflict.ts',
    absPath: '/repo/conflict.ts',
    repoRoot: '/repo',
    labels: {
      operation: 'merge',
      ours: { label: 'main', hash: 'a', subject: '' },
      theirs: { label: 'feature', hash: 'b', subject: '' },
    },
    fileQueue: ['conflict.ts'],
    requestRevision: 1,
    epoch: 1,
    fileWriteRevision: 1,
    sourceVersion: 'v1:x',
    stages: { path: 'conflict.ts', binary: false },
    dirty: false,
    reloadPending: false,
    closeRequested: false,
    content: '',
    encoding: 'utf-8',
    lineEndings: 'lf',
    regions: [],
    decisions: {},
    readOnly: false,
  } as unknown as MergeSession;

  const openPanel = async () => {
    render(<Terminal />);
    await userEvent.click(screen.getByRole('button', { name: /new terminal/i }));
    const panel = document.getElementById('terminal-panel-content');
    if (!panel) throw new Error('terminal panel not rendered');
    return panel;
  };

  beforeEach(() => {
    useGitStore.getState().resetForWorkspace('/repo');
  });

  it('schedules a git refresh when focus leaves the terminal while a merge session is open', async () => {
    const scheduleRefresh = jest.fn();
    useGitStore.setState({ mergeSession, scheduleRefresh });
    const panel = await openPanel();

    fireEvent.focusOut(panel, { relatedTarget: document.body });

    // `git add` in the embedded terminal touches no watched file and .git is
    // not watched, so leaving the terminal is the signal that a status read is
    // worth doing.
    expect(scheduleRefresh).toHaveBeenCalledTimes(1);
  });

  it('adds no refresh when no merge session is open', async () => {
    const scheduleRefresh = jest.fn();
    useGitStore.setState({ mergeSession: null, scheduleRefresh });
    const panel = await openPanel();

    fireEvent.focusOut(panel, { relatedTarget: document.body });

    expect(scheduleRefresh).not.toHaveBeenCalled();
  });

  it('ignores focus moves that stay inside the terminal', async () => {
    const scheduleRefresh = jest.fn();
    useGitStore.setState({ mergeSession, scheduleRefresh });
    const panel = await openPanel();
    const inside = document.createElement('textarea');
    panel.appendChild(inside);

    fireEvent.focusOut(panel, { relatedTarget: inside });

    expect(scheduleRefresh).not.toHaveBeenCalled();
  });
});
