import { act, render, screen, fireEvent } from '@testing-library/react';
import { RunProfileSelector } from '../../components/Header/RunProfileSelector';
import { useIDEStore } from '../../stores/ideStore';

const mockStart = jest.fn().mockResolvedValue(undefined);
const mockRestart = jest.fn().mockResolvedValue(undefined);
const mockStop = jest.fn().mockResolvedValue(undefined);
jest.mock('../../wails/bindings', () => ({
  StartRunProfile: (...a: unknown[]) => mockStart(...a),
  StopRunProfile: (...a: unknown[]) => mockStop(...a),
  RestartRunProfile: (...a: unknown[]) => mockRestart(...a),
  SetActiveVariant: jest.fn().mockResolvedValue(undefined),
}));

const setPhase2BState = (patch: Partial<ReturnType<typeof useIDEStore.getState>>) => {
  useIDEStore.setState(patch);
};

const ordinaryOutput = (
  runInstanceId: string,
  state: 'idle' | 'running' | 'failed' | 'success',
  launchSeq: number
) => ({
  runInstanceId,
  profileId: 'p1',
  state,
  exitCode: state === 'failed' ? 1 : 0,
  entries: [],
  launchSeq,
  workspaceEpoch: 1,
});

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({
    runProfiles: [{ id: 'p1', name: 'dev', type: 'single', source: 'user', workspaceId: 'ws1' }],
    runProfileState: {},
    runOutputs: {},
    runInstanceIdsByProfile: {},
    latestRunInstanceIdByProfile: {},
    runCompounds: {},
    compoundIdByRunInstance: {},
    hiddenProfileIds: [],
    stoppingProfileIds: [],
    restartingProfileIds: [],
    runEventsPaused: false,
    isLoadingProfiles: false,
    activeWorkspaceId: 'ws1', // drives workspace view (NOT a treeViewMode field)
    workspaces: [{ id: 'ws1', name: 'frontend', path: '/x', accent: 'frontend' }] as never,
    selectedProfileId: null,
  });
});

test('shows the effective target name and a Run action', () => {
  render(<RunProfileSelector />);
  expect(screen.getByText('dev')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Run selected profile: dev/i })).toBeEnabled();
});

test('disables the run action while workspace event admission is paused', () => {
  setPhase2BState({ runEventsPaused: true, isLoadingProfiles: true });

  render(<RunProfileSelector />);

  expect(screen.getByRole('button', { name: /Run selected profile: dev/i })).toBeDisabled();
});

test('clicking the action segment starts the target', () => {
  render(<RunProfileSelector />);
  fireEvent.click(screen.getByRole('button', { name: /Run selected profile: dev/i }));
  expect(mockStart).toHaveBeenCalledWith('p1');
});

test('with no profiles, shows disabled No profile state', () => {
  useIDEStore.setState({ runProfiles: [] });
  render(<RunProfileSelector />);
  expect(screen.getByText(/No profile/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /No run profile selected/i })).toBeDisabled();
});

test('derives the header action from the explicit latest run instance', () => {
  useIDEStore.setState({
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

  render(<RunProfileSelector />);

  expect(screen.getByRole('button', { name: /Stop selected profile: dev/i })).toBeEnabled();
});

test('keeps the header on the newest live action when a newer sibling has failed', async () => {
  setPhase2BState({
    runOutputs: {
      live: ordinaryOutput('live', 'running', 10),
      failed: ordinaryOutput('failed', 'failed', 11),
    },
    runInstanceIdsByProfile: { p1: ['live', 'failed'] },
    latestRunInstanceIdByProfile: { p1: 'failed' },
    runLaunchSeqByInstance: { live: 10, failed: 11 },
  });

  render(<RunProfileSelector />);

  const stop = screen.getByRole('button', { name: /Stop selected profile: dev/i });
  await act(async () => {
    fireEvent.click(stop);
    await Promise.resolve();
  });
  expect(mockStop).toHaveBeenCalledWith('p1');
  expect(mockRestart).not.toHaveBeenCalled();
});

test('targets the newest provisional live RID when output arrives before status', () => {
  mockStop.mockImplementationOnce(() => new Promise<void>(() => {}));
  setPhase2BState({
    runOutputs: {
      older: ordinaryOutput('older', 'running', 10),
      provisional: ordinaryOutput('provisional', 'idle', 20),
    },
    runInstanceIdsByProfile: { p1: ['older', 'provisional'] },
    latestRunInstanceIdByProfile: { p1: 'provisional' },
    runLaunchSeqByInstance: { older: 10, provisional: 20 },
  });

  render(<RunProfileSelector />);

  fireEvent.click(screen.getByRole('button', { name: /Stop selected profile: dev/i }));
  expect(mockStop).toHaveBeenCalledWith('p1');
  expect(useIDEStore.getState().stoppingRunInstanceIds).toContain('provisional');
  expect(useIDEStore.getState().stoppingRunInstanceIds).not.toContain('older');
});

test('offers Run another with one live plus one terminal execution and removes it at live capacity', () => {
  setPhase2BState({
    runOutputs: {
      terminal: ordinaryOutput('terminal', 'failed', 19),
      first: ordinaryOutput('first', 'running', 20),
    },
    runInstanceIdsByProfile: { p1: ['terminal', 'first'] },
    latestRunInstanceIdByProfile: { p1: 'first' },
    runLaunchSeqByInstance: { terminal: 19, first: 20 },
  });

  render(<RunProfileSelector />);

  fireEvent.click(screen.getByRole('button', { name: 'Run another dev' }));
  expect(mockStart).toHaveBeenCalledWith('p1');

  act(() => {
    setPhase2BState({
      runOutputs: {
        first: ordinaryOutput('first', 'running', 20),
        second: ordinaryOutput('second', 'idle', 21),
      },
      runInstanceIdsByProfile: { p1: ['first', 'second'] },
      latestRunInstanceIdByProfile: { p1: 'second' },
      runLaunchSeqByInstance: { first: 20, second: 21 },
    });
  });

  expect(screen.queryByRole('button', { name: 'Run another dev' })).not.toBeInTheDocument();
});

test('derives a compound header action through its aggregate run instance', () => {
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

  render(<RunProfileSelector />);

  expect(screen.getByRole('button', { name: /Stop selected profile: CI/i })).toBeEnabled();
});
