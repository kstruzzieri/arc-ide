import { act, fireEvent, render, screen } from '@testing-library/react';
import { RunOutputPanel } from '../../../components/RunOutput/RunOutputPanel';
import { RunOutputTabs } from '../../../components/RunOutput/RunOutputTabs';
import { RunOutputToolbar } from '../../../components/RunOutput/RunOutputToolbar';
import { useIDEStore } from '../../../stores/ideStore';
import { ALL_PROFILES_ID } from '../../../types/runOutput';
import type { CompoundRun, RunOutput } from '../../../types/runOutput';
import type { RunProfile } from '../../../types/runProfile';

const mockStartProfile = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockStopProfile = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockRestartProfile = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockStopInstance = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockRestartInstance = jest.fn<Promise<void>, [string]>(() => Promise.resolve());

jest.mock('../../../wails/bindings', () => ({
  StartRunProfile: (id: string) => mockStartProfile(id),
  StopRunProfile: (id: string) => mockStopProfile(id),
  RestartRunProfile: (id: string) => mockRestartProfile(id),
  StopRunInstance: (id: string) => mockStopInstance(id),
  RestartRunInstance: (id: string) => mockRestartInstance(id),
}));

jest.mock('../../../components/RunProfiles/CompoundExecutionView', () => ({
  CompoundExecutionView: ({ compound }: { compound: CompoundRun }) => (
    <div data-testid="compound-view">{compound.compoundId}</div>
  ),
}));

jest.mock('../../../components/RunOutput/MergedView', () => ({
  MergedView: ({ workingDir }: { workingDir?: string }) => (
    <div data-testid="merged-working-dir">{workingDir}</div>
  ),
}));
jest.mock('../../../components/RunOutput/LanesView', () => ({
  LanesView: () => <div data-testid="lanes-view" />,
}));
jest.mock('../../../components/RunOutput/DiffView', () => ({
  DiffView: ({
    entries,
    previousEntries,
    workingDir,
    previousWorkingDir,
  }: {
    entries: Array<{ text: string }>;
    previousEntries: Array<{ text: string }>;
    workingDir?: string;
    previousWorkingDir?: string;
  }) => (
    <div data-testid="diff-props">
      {JSON.stringify({
        entries: entries.map((entry) => entry.text),
        previousEntries: previousEntries.map((entry) => entry.text),
        workingDir,
        previousWorkingDir,
      })}
    </div>
  ),
}));
jest.mock('../../../components/RunOutput/TimelineView', () => ({
  TimelineView: ({ runOutputs }: { runOutputs: Record<string, RunOutput> }) => (
    <div data-testid="timeline-run-ids">{Object.keys(runOutputs).join(',')}</div>
  ),
}));

const output = (
  runInstanceId: string,
  profileId: string,
  text: string,
  workingDir: string,
  state: RunOutput['state'] = 'success',
  launchSeq = 1
): RunOutput =>
  ({
    runInstanceId,
    profileId,
    state,
    exitCode: 0,
    workingDir,
    entries: [{ stream: 'stdout', text, timestamp: 1 }],
    launchSeq,
    workspaceEpoch: 1,
  }) as RunOutput;

const setPhase2BState = (patch: Partial<ReturnType<typeof useIDEStore.getState>>) => {
  useIDEStore.setState(patch);
};

const profile = (id: string, name: string): RunProfile => ({
  id,
  name,
  type: 'single',
  source: 'user',
  command: 'echo test',
});

const compound = (): CompoundRun => ({
  runInstanceId: 'agg-r1',
  compoundId: 'ci',
  name: 'CI',
  state: 'running',
  currentStep: 0,
  steps: [],
  stepOutputs: {},
});

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({
    ...useIDEStore.getInitialState(),
    workspace: { name: 'Repo', path: '/repo' },
    runProfiles: [profile('p1', 'Build'), profile('p2', 'Test')],
    runOutputs: {},
    runInstanceIdsByProfile: {},
    latestRunInstanceIdByProfile: {},
    runCompounds: {},
    compoundIdByRunInstance: {},
  });
});

it('renders retained ordinary tabs in indexed order with profile and opaque run labels', () => {
  useIDEStore.setState({
    runOutputs: {
      r2: output('r2', 'p1', 'new', 'new-dir'),
      r3: output('r3', 'p2', 'test', 'test-dir'),
      r1: output('r1', 'p1', 'old', 'old-dir'),
    },
    runInstanceIdsByProfile: { p1: ['r1', 'r2'], p2: ['r3'] },
    latestRunInstanceIdByProfile: { p1: 'r2', p2: 'r3' },
    activeRunOutputId: 'r2',
  });

  render(<RunOutputTabs />);

  const labels = screen.getAllByRole('button').map((button) => button.textContent);
  expect(labels).toEqual(['Build (previous)', 'Build', 'Test', 'All']);
  fireEvent.click(screen.getByRole('button', { name: 'Build (previous)' }));
  expect(useIDEStore.getState().activeRunOutputId).toBe('r1');
});

it('labels two live executions by stable launch order and keeps selection keyed by RID', () => {
  setPhase2BState({
    runOutputs: {
      second: output('second', 'p1', 'second', 'new-dir', 'running', 22),
      first: output('first', 'p1', 'first', 'old-dir', 'running', 21),
    },
    runInstanceIdsByProfile: { p1: ['first', 'second'] },
    latestRunInstanceIdByProfile: { p1: 'second' },
    runLaunchSeqByInstance: { first: 21, second: 22 },
    stoppingProfileIds: ['p1'],
    stoppingRunInstanceIds: ['first'],
    activeRunOutputId: 'second',
  });

  render(<RunOutputTabs />);

  const firstRunTab = screen.getByRole('button', { name: 'Build, Run 1' });
  const secondRunTab = screen.getByRole('button', { name: 'Build, Run 2' });
  expect(firstRunTab).toBeInTheDocument();
  expect(secondRunTab).toBeInTheDocument();
  expect(screen.queryByText(/previous|older|newer/i)).not.toBeInTheDocument();
  expect(firstRunTab.querySelector('span')).toHaveClass('dotStopping');
  expect(secondRunTab.querySelector('span')).toHaveClass('dotRunning');

  fireEvent.click(firstRunTab);
  expect(useIDEStore.getState().activeRunOutputId).toBe('first');
});

it('disables run controls while workspace event admission is paused', () => {
  setPhase2BState({
    runOutputs: {
      live: output('live', 'p1', 'live', 'work', 'running', 21),
    },
    runInstanceIdsByProfile: { p1: ['live'] },
    latestRunInstanceIdByProfile: { p1: 'live' },
    runLaunchSeqByInstance: { live: 21 },
    activeRunOutputId: 'live',
    runEventsPaused: true,
    isLoadingProfiles: true,
  });

  render(<RunOutputToolbar />);

  expect(screen.getByRole('button', { name: 'Re-run profile' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Stop profile' })).toBeDisabled();
});

it('controls a selected output-before-status buffer by its exact RID', () => {
  setPhase2BState({
    runOutputs: {
      older: output('older', 'p1', 'older', 'work', 'running', 10),
      provisional: output('provisional', 'p1', 'early', 'work', 'idle', 20),
    },
    runInstanceIdsByProfile: { p1: ['older', 'provisional'] },
    latestRunInstanceIdByProfile: { p1: 'provisional' },
    runLaunchSeqByInstance: { older: 10, provisional: 20 },
    activeRunOutputId: 'provisional',
  });

  render(<RunOutputToolbar />);

  const stop = screen.getByRole('button', { name: 'Stop profile' });
  expect(stop).toBeEnabled();
  fireEvent.click(stop);
  fireEvent.click(screen.getByRole('button', { name: 'Re-run profile' }));

  expect(mockStopInstance).toHaveBeenCalledWith('provisional');
  expect(mockRestartInstance).toHaveBeenCalledWith('provisional');
  expect(mockStartProfile).not.toHaveBeenCalled();
});

it('does not apply another profile lifecycle state to a colliding historical run id', () => {
  useIDEStore.setState({
    runOutputs: {
      p2: output('p2', 'p1', 'old', 'old-dir'),
      r2: output('r2', 'p1', 'new', 'new-dir'),
    },
    runInstanceIdsByProfile: { p1: ['p2', 'r2'] },
    latestRunInstanceIdByProfile: { p1: 'r2' },
    stoppingProfileIds: ['p2'],
    activeRunOutputId: 'p2',
  });

  render(<RunOutputTabs />);

  const historicalDot = screen
    .getByRole('button', { name: 'Build (previous)' })
    .querySelector('span');
  expect(historicalDot).toHaveClass('dotSuccess');
  expect(historicalDot).not.toHaveClass('dotStopping');
});

it('does not show All for two retained runs of one profile', () => {
  useIDEStore.setState({
    runOutputs: {
      r1: output('r1', 'p1', 'old', 'old-dir'),
      r2: output('r2', 'p1', 'new', 'new-dir'),
    },
    runInstanceIdsByProfile: { p1: ['r1', 'r2'] },
    latestRunInstanceIdByProfile: { p1: 'r2' },
    activeRunOutputId: 'r2',
  });

  render(<RunOutputTabs />);

  expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
});

it('renders only the latest ordinary execution per profile in All Profiles', () => {
  useIDEStore.setState({
    runOutputs: {
      r1: output('r1', 'p1', 'old', 'old-dir'),
      r2: output('r2', 'p1', 'new', 'new-dir'),
      r3: output('r3', 'p2', 'test', 'test-dir'),
    },
    runInstanceIdsByProfile: { p1: ['r1', 'r2'], p2: ['r3'] },
    latestRunInstanceIdByProfile: { p1: 'r2', p2: 'r3' },
    activeRunOutputId: ALL_PROFILES_ID,
    runOutputViewMode: 'timeline',
  });

  render(<RunOutputPanel />);

  expect(screen.getByTestId('timeline-run-ids').textContent).toBe('r2,r3');
});

it('falls All Profiles back to the latest retained execution after clearing a newer terminal tab', () => {
  setPhase2BState({
    runOutputs: {
      live: output('live', 'p1', 'live', 'live-dir', 'running', 10),
      done: output('done', 'p1', 'done', 'done-dir', 'failed', 11),
      other: output('other', 'p2', 'other', 'other-dir', 'success', 12),
    },
    runInstanceIdsByProfile: { p1: ['live', 'done'], p2: ['other'] },
    latestRunInstanceIdByProfile: { p1: 'done', p2: 'other' },
    runLaunchSeqByInstance: { live: 10, done: 11, other: 12 },
    activeRunOutputId: ALL_PROFILES_ID,
    runOutputViewMode: 'timeline',
  });

  render(<RunOutputPanel />);
  expect(screen.getByTestId('timeline-run-ids').textContent).toBe('done,other');

  act(() => {
    useIDEStore.getState().clearRunOutput('done');
  });

  expect(screen.getByTestId('timeline-run-ids').textContent).toBe('live,other');
});

it('derives Diff entries and both working directories from the indexed predecessor', () => {
  useIDEStore.setState({
    runOutputs: {
      r1: output('r1', 'p1', 'old', 'packages/old'),
      r2: output('r2', 'p1', 'new', 'packages/new'),
    },
    runInstanceIdsByProfile: { p1: ['r1', 'r2'] },
    latestRunInstanceIdByProfile: { p1: 'r2' },
    activeRunOutputId: 'r2',
    runOutputViewMode: 'diff',
  });

  render(<RunOutputPanel />);

  expect(screen.getByTestId('diff-props')).toHaveTextContent(
    JSON.stringify({
      entries: ['new'],
      previousEntries: ['old'],
      workingDir: 'packages/new',
      previousWorkingDir: 'packages/old',
    })
  );
});

it('keeps Diff available between two concurrently live retained executions', () => {
  setPhase2BState({
    runOutputs: {
      first: output('first', 'p1', 'first-live', 'packages/first', 'running', 30),
      second: output('second', 'p1', 'second-live', 'packages/second', 'running', 31),
    },
    runInstanceIdsByProfile: { p1: ['first', 'second'] },
    latestRunInstanceIdByProfile: { p1: 'second' },
    runLaunchSeqByInstance: { first: 30, second: 31 },
    activeRunOutputId: 'second',
    runOutputViewMode: 'diff',
  });

  render(<RunOutputPanel />);

  expect(screen.getByTestId('diff-props')).toHaveTextContent(
    JSON.stringify({
      entries: ['second-live'],
      previousEntries: ['first-live'],
      workingDir: 'packages/second',
      previousWorkingDir: 'packages/first',
    })
  );
});

it('uses the selected historical execution working directory for output links', () => {
  useIDEStore.setState({
    runOutputs: {
      r1: output('r1', 'p1', 'old', 'packages/old'),
      r2: output('r2', 'p1', 'new', 'packages/new'),
    },
    runInstanceIdsByProfile: { p1: ['r1', 'r2'] },
    latestRunInstanceIdByProfile: { p1: 'r2' },
    activeRunOutputId: 'r1',
    runOutputViewMode: 'merged',
  });

  render(<RunOutputPanel />);

  expect(screen.getByTestId('merged-working-dir')).toHaveTextContent('packages/old');
});

it('targets the selected live ordinary RID for Stop and Restart', () => {
  useIDEStore.setState({
    runOutputs: {
      r1: output('r1', 'p1', 'older live', 'packages/old', 'running', 1),
      r2: output('r2', 'p1', 'newer live', 'packages/new', 'running', 2),
    },
    runInstanceIdsByProfile: { p1: ['r1', 'r2'] },
    latestRunInstanceIdByProfile: { p1: 'r2' },
    activeRunOutputId: 'r1',
  });

  render(<RunOutputToolbar />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop profile' }));
  fireEvent.click(screen.getByRole('button', { name: 'Re-run profile' }));

  expect(mockStopInstance).toHaveBeenCalledWith('r1');
  expect(mockRestartInstance).toHaveBeenCalledWith('r1');
  expect(mockStopProfile).not.toHaveBeenCalled();
  expect(mockRestartProfile).not.toHaveBeenCalled();
});

it('starts the selected terminal profile again without stopping its live sibling', () => {
  useIDEStore.setState({
    runOutputs: {
      r1: output('r1', 'p1', 'old', 'packages/old', 'success', 1),
      r2: output('r2', 'p1', 'live', 'packages/new', 'running', 2),
    },
    runInstanceIdsByProfile: { p1: ['r1', 'r2'] },
    latestRunInstanceIdByProfile: { p1: 'r2' },
    activeRunOutputId: 'r1',
  });

  render(<RunOutputToolbar />);
  expect(screen.getByRole('button', { name: 'Stop profile' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Re-run profile' }));

  expect(mockStartProfile).toHaveBeenCalledWith('p1');
  expect(mockRestartInstance).not.toHaveBeenCalled();
  expect(mockStopInstance).not.toHaveBeenCalled();
  expect(mockStopProfile).not.toHaveBeenCalled();
});

it('evicts a selected terminal tab before a live tab and selects the newly launched RID', () => {
  setPhase2BState({
    workspaceEpoch: 1,
    runProfiles: [profile('p1', 'Build')],
    runOutputs: {
      live: output('live', 'p1', 'live', 'live-dir', 'running', 40),
      terminal: output('terminal', 'p1', 'terminal', 'terminal-dir', 'failed', 41),
    },
    runInstanceIdsByProfile: { p1: ['live', 'terminal'] },
    latestRunInstanceIdByProfile: { p1: 'terminal' },
    runLaunchSeqByInstance: { live: 40, terminal: 41 },
    runStartTimestamps: { live: 1000 },
    activeRunOutputId: 'terminal',
  });

  useIDEStore.getState().handleRunStatus({
    runInstanceId: 'new',
    profileId: 'p1',
    launchSeq: 42,
    workspaceEpoch: 1,
    stepIdx: 0,
    state: 'running',
    exitCode: 0,
    timestamp: 2000,
  });

  const state = useIDEStore.getState();
  expect(state.runInstanceIdsByProfile.p1).toEqual(['live', 'new']);
  expect(state.activeRunOutputId).toBe('new');
});

it('resolves a compound aggregate run instance for rendering and controls', async () => {
  useIDEStore.setState({
    runCompounds: { ci: compound() },
    compoundIdByRunInstance: { 'agg-r1': 'ci' },
    activeRunOutputId: 'agg-r1',
  });

  render(<RunOutputPanel />);

  expect(screen.getByTestId('compound-view')).toHaveTextContent('ci');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-run profile' }));
    await Promise.resolve();
  });
  expect(mockStopProfile).toHaveBeenCalledWith('ci');
  expect(mockRestartProfile).toHaveBeenCalledWith('ci');
});
