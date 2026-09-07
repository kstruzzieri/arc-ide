import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { runhistory } from '../../../wails/bindings';
import { RunOutputPanel } from '../../../components/RunOutput/RunOutputPanel';
import { RunOutputTabs } from '../../../components/RunOutput/RunOutputTabs';
import { RunOutputToolbar } from '../../../components/RunOutput/RunOutputToolbar';
import { useRunProfilesLoader } from '../../../hooks/useRunProfiles';
import { useIDEStore } from '../../../stores/ideStore';
import { ALL_PROFILES_ID } from '../../../types/runOutput';
import type { RunOutput } from '../../../types/runOutput';

const mockStartProfile = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockStopInstance = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockRestartInstance = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockClearRunHistoryRecord = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockClearAllRunHistory = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockGetRunHistoryRecord = jest.fn<Promise<runhistory.Record>, [string]>();
const mockLoadRunProfiles = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockGetRunProfilesSnapshot = jest.fn<Promise<unknown>, []>();
const mockGetRunHistorySnapshot = jest.fn<Promise<runhistory.Snapshot>, []>();

jest.mock('../../../wails/bindings', () => {
  const actual = jest.requireActual('../../../wails/bindings');
  return {
    ...actual,
    StartRunProfile: (id: string) => mockStartProfile(id),
    StopRunProfile: jest.fn(() => Promise.resolve()),
    RestartRunProfile: jest.fn(() => Promise.resolve()),
    StopRunInstance: (id: string) => mockStopInstance(id),
    RestartRunInstance: (id: string) => mockRestartInstance(id),
    ClearRunHistoryRecord: (id: string) => mockClearRunHistoryRecord(id),
    ClearAllRunHistory: () => mockClearAllRunHistory(),
    GetRunHistoryRecord: (id: string) => mockGetRunHistoryRecord(id),
    LoadRunProfiles: (path: string) => mockLoadRunProfiles(path),
    GetRunProfilesSnapshot: () => mockGetRunProfilesSnapshot(),
    GetRunHistorySnapshot: () => mockGetRunHistorySnapshot(),
  };
});
jest.mock('../../../wails/runtime', () => ({
  EventsOn: jest.fn(() => jest.fn()),
}));

jest.mock('../../../components/RunProfiles/CompoundExecutionView', () => ({
  CompoundExecutionView: () => <div data-testid="compound-view" />,
}));
jest.mock('../../../components/RunOutput/MergedView', () => ({
  MergedView: ({ entries }: { entries: Array<{ text: string }> }) => (
    <div data-testid="merged-entries">{entries.map((entry) => entry.text).join(',')}</div>
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

const olderId = '018f0000-0000-7000-8000-000000000001';
const middleId = '018f0000-0000-7000-8000-000000000002';
const newestId = '018f0000-0000-7000-8000-000000000003';
const otherId = '018f0000-0000-7000-8000-000000000004';
const redactedId = '018f0000-0000-7000-8000-000000000005';
const compoundId = '018f0000-0000-7000-8000-000000000006';

function summary(
  historyId: string,
  profileId: string,
  completedAt: number,
  options: Partial<runhistory.Summary> = {}
): runhistory.Summary {
  return {
    historyId,
    kind: runhistory.RecordKind.RecordKindOrdinary,
    profileId,
    profileName: profileId === 'build' ? 'Archived Build' : 'Archived Test',
    state: 'success',
    exitCode: 0,
    startedAt: completedAt - 50,
    completedAt,
    outputAvailable: true,
    ...options,
  };
}

function record(value: runhistory.Summary, text: string, workingDir: string): runhistory.Record {
  return new runhistory.Record({
    version: 1,
    ...value,
    workingDir,
    entries: [{ stream: 'stdout', text, timestamp: value.completedAt }],
  });
}

function liveOutput(
  runInstanceId = 'live',
  profileId = 'build',
  text = 'live',
  launchSeq = 1
): RunOutput {
  return {
    runInstanceId,
    profileId,
    state: 'success',
    exitCode: 0,
    workingDir: `/repo/${runInstanceId}`,
    entries: [{ stream: 'stdout', text, timestamp: launchSeq }],
    launchSeq,
    workspaceEpoch: 7,
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

function setPhase2CState(patch: Partial<ReturnType<typeof useIDEStore.getState>>) {
  useIDEStore.setState({
    ...useIDEStore.getInitialState(),
    workspace: { name: 'Repo', path: '/repo' },
    workspaceEpoch: 7,
    runProfiles: [
      {
        id: 'build',
        name: 'Build',
        type: 'single',
        source: 'user',
        command: 'go build ./...',
      },
      {
        id: 'test',
        name: 'Test',
        type: 'single',
        source: 'user',
        command: 'go test ./...',
      },
    ],
    runHistorySummaries: {},
    runHistoryRecords: {},
    ...patch,
  });
}

function RunProfilesLoader({ workspacePath }: { workspacePath: string | null }) {
  useRunProfilesLoader(workspacePath);
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClearRunHistoryRecord.mockReset();
  mockClearAllRunHistory.mockReset();
  mockGetRunHistoryRecord.mockReset();
  mockLoadRunProfiles.mockReset();
  mockGetRunProfilesSnapshot.mockReset();
  mockGetRunHistorySnapshot.mockReset();
  mockClearRunHistoryRecord.mockResolvedValue(undefined);
  mockClearAllRunHistory.mockResolvedValue(undefined);
  mockLoadRunProfiles.mockResolvedValue(undefined);
});

it('loads a selected ordinary archive once and reuses its cached rich record', async () => {
  const selected = summary(olderId, 'build', 50);
  const newerPlaceholders = [middleId, newestId, otherId, redactedId, compoundId].map(
    (historyId, index) => summary(historyId, 'build', (index + 1) * 100)
  );
  const summaries = Object.fromEntries(
    [selected, ...newerPlaceholders].map((value) => [value.historyId, value])
  );
  mockGetRunHistoryRecord.mockResolvedValueOnce(record(selected, 'lazy output', '/repo/lazy'));
  setPhase2CState({
    runHistorySummaries: summaries,
    runHistoryRecords: { ...summaries },
    activeRunOutputId: null,
    runOutputViewMode: 'merged',
  });

  render(<RunOutputPanel />);
  expect(mockGetRunHistoryRecord).not.toHaveBeenCalled();

  act(() => useIDEStore.setState({ activeRunOutputId: `history:${olderId}` }));
  await waitFor(() => expect(mockGetRunHistoryRecord).toHaveBeenCalledWith(olderId));
  await waitFor(() =>
    expect(screen.getByTestId('merged-entries')).toHaveTextContent('lazy output')
  );
  expect(useIDEStore.getState().runHistoryRecords[olderId]).toMatchObject({
    version: 1,
    historyId: olderId,
  });
  expect(useIDEStore.getState().runHistorySummaries[olderId]).toEqual(selected);
  expect(useIDEStore.getState().runHistorySummaries[olderId]).not.toHaveProperty('version');
  expect(useIDEStore.getState().runHistorySummaries[olderId]).not.toHaveProperty('entries');
  expect(useIDEStore.getState().runHistorySummaries[olderId]).not.toHaveProperty('workingDir');
  expect(Object.keys(useIDEStore.getState().runHistoryRecords)).toHaveLength(5);

  act(() => useIDEStore.setState({ activeRunOutputId: null }));
  await waitFor(() => expect(screen.queryByTestId('merged-entries')).toBeNull());
  act(() => useIDEStore.setState({ activeRunOutputId: `history:${olderId}` }));
  await waitFor(() =>
    expect(screen.getByTestId('merged-entries')).toHaveTextContent('lazy output')
  );
  expect(mockGetRunHistoryRecord).toHaveBeenCalledTimes(1);
});

it('moves inner tab selection and view mode atomically in both directions', () => {
  const archivedBuild = summary(newestId, 'build', 300);
  const archivedTest = summary(otherId, 'test', 400);
  setPhase2CState({
    runHistorySummaries: {
      [newestId]: archivedBuild,
      [otherId]: archivedTest,
    },
    runHistoryRecords: {
      [newestId]: archivedBuild,
      [otherId]: archivedTest,
    },
    activeRunOutputId: `history:${newestId}`,
    runOutputViewMode: 'diff',
  });

  render(<RunOutputTabs />);
  fireEvent.click(screen.getByRole('button', { name: 'Test (saved)' }));
  expect(useIDEStore.getState()).toMatchObject({
    activeRunOutputId: `history:${otherId}`,
    runOutputViewMode: 'diff',
  });

  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(useIDEStore.getState()).toMatchObject({
    activeRunOutputId: ALL_PROFILES_ID,
    runOutputViewMode: 'timeline',
  });

  fireEvent.click(screen.getByRole('button', { name: 'Build (saved)' }));
  expect(useIDEStore.getState()).toMatchObject({
    activeRunOutputId: `history:${newestId}`,
    runOutputViewMode: 'merged',
  });
});

it('shows selected archive read failure and retries the demanded record', async () => {
  const archivedBuild = summary(newestId, 'build', 300);
  mockGetRunHistoryRecord
    .mockRejectedValueOnce(new Error('record unreadable'))
    .mockResolvedValueOnce(record(archivedBuild, 'recovered output', '/repo/recovered'));
  setPhase2CState({
    runHistorySummaries: { [newestId]: archivedBuild },
    runHistoryRecords: { [newestId]: archivedBuild },
    activeRunOutputId: `history:${newestId}`,
    runOutputViewMode: 'merged',
  });

  render(<RunOutputPanel />);
  expect(screen.getByText('Loading run output…')).toBeInTheDocument();
  expect(screen.queryByTestId('merged-entries')).not.toBeInTheDocument();

  expect(await screen.findByRole('alert')).toHaveTextContent('record unreadable');
  expect(useIDEStore.getState().toast).toEqual({
    message: 'Failed to load run output: record unreadable',
    type: 'error',
  });
  expect(useIDEStore.getState().runHistorySummaries[newestId]).toEqual(archivedBuild);

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(mockGetRunHistoryRecord).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByTestId('merged-entries')).toHaveTextContent('recovered output')
  );
});

it('ignores a delayed rich response after workspace ownership changes', async () => {
  const pending = deferred<runhistory.Record>();
  const workspaceA = summary(newestId, 'build', 300);
  const workspaceB = summary(newestId, 'test', 400);
  mockGetRunHistoryRecord.mockReturnValueOnce(pending.promise);
  setPhase2CState({
    runHistorySummaries: { [newestId]: workspaceA },
    runHistoryRecords: { [newestId]: workspaceA },
    activeRunOutputId: `history:${newestId}`,
  });

  render(<RunOutputPanel />);
  await waitFor(() => expect(mockGetRunHistoryRecord).toHaveBeenCalledWith(newestId));

  act(() => {
    setPhase2CState({
      workspace: { name: 'Other', path: '/other' },
      workspaceEpoch: 8,
      runHistorySummaries: { [newestId]: workspaceB },
      runHistoryRecords: { [newestId]: workspaceB },
      activeRunOutputId: null,
    });
  });
  await act(async () => pending.resolve(record(workspaceA, 'workspace A', '/repo/a')));

  expect(useIDEStore.getState().runHistoryRecords[newestId]).toEqual(workspaceB);
  expect(screen.queryByText('workspace A')).not.toBeInTheDocument();
});

it('loads only the immediate archived Diff predecessor and lets redaction block older output', async () => {
  const older = summary(olderId, 'build', 100);
  const middle = summary(middleId, 'build', 200);
  const newest = summary(newestId, 'build', 300);
  mockGetRunHistoryRecord.mockImplementation(async (historyId) => {
    if (historyId === newestId) return record(newest, 'newest', '/repo/newest');
    if (historyId === middleId) return record(middle, 'middle', '/repo/middle');
    return record(older, 'oldest', '/repo/oldest');
  });
  setPhase2CState({
    runHistorySummaries: { [olderId]: older, [middleId]: middle, [newestId]: newest },
    runHistoryRecords: { [olderId]: older, [middleId]: middle, [newestId]: newest },
    activeRunOutputId: `history:${newestId}`,
    runOutputViewMode: 'diff',
  });

  const view = render(<RunOutputPanel />);
  await waitFor(() =>
    expect(screen.getByTestId('diff-props')).toHaveTextContent(
      JSON.stringify({
        entries: ['newest'],
        previousEntries: ['middle'],
        workingDir: '/repo/newest',
        previousWorkingDir: '/repo/middle',
      })
    )
  );
  expect(mockGetRunHistoryRecord).toHaveBeenCalledWith(newestId);
  expect(mockGetRunHistoryRecord).toHaveBeenCalledWith(middleId);
  expect(mockGetRunHistoryRecord).not.toHaveBeenCalledWith(olderId);

  view.unmount();
  jest.clearAllMocks();
  const redactedMiddle = { ...middle, outputAvailable: false };
  setPhase2CState({
    runHistorySummaries: {
      [olderId]: older,
      [middleId]: redactedMiddle,
      [newestId]: newest,
    },
    runHistoryRecords: { [newestId]: record(newest, 'newest', '/repo/newest') },
    activeRunOutputId: `history:${newestId}`,
    runOutputViewMode: 'diff',
  });

  render(<RunOutputPanel />);
  expect(screen.getByTestId('diff-props')).toHaveTextContent(
    JSON.stringify({
      entries: ['newest'],
      previousEntries: [],
      workingDir: '/repo/newest',
    })
  );
  expect(mockGetRunHistoryRecord).not.toHaveBeenCalled();
  expect(useIDEStore.getState().runHistorySummaries[middleId]).toEqual(redactedMiddle);
});

it('blocks archived Diff while its readable predecessor load has failed', async () => {
  const predecessor = summary(middleId, 'build', 200);
  const selected = summary(newestId, 'build', 300);
  mockGetRunHistoryRecord.mockRejectedValueOnce(new Error('predecessor unreadable'));
  setPhase2CState({
    runHistorySummaries: {
      [middleId]: predecessor,
      [newestId]: selected,
    },
    runHistoryRecords: {
      [middleId]: predecessor,
      [newestId]: record(selected, 'selected', '/repo/selected'),
    },
    activeRunOutputId: `history:${newestId}`,
    runOutputViewMode: 'diff',
  });

  render(<RunOutputPanel />);
  expect(screen.getByText('Loading previous run output…')).toBeInTheDocument();
  expect(screen.queryByTestId('diff-props')).not.toBeInTheDocument();

  expect(await screen.findByRole('alert')).toHaveTextContent('predecessor unreadable');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(screen.queryByTestId('diff-props')).not.toBeInTheDocument();
  expect(useIDEStore.getState().toast).toEqual({
    message: 'Failed to load run output: predecessor unreadable',
    type: 'error',
  });
});

it('keeps live and archived Diff predecessor namespaces isolated in both directions', () => {
  const archivedOlder = summary(olderId, 'build', 100);
  const archivedNewest = summary(newestId, 'build', 300);
  setPhase2CState({
    runOutputs: {
      live1: liveOutput('live1', 'build', 'live older', 1),
      live2: liveOutput('live2', 'build', 'live newest', 2),
    },
    runInstanceIdsByProfile: { build: ['live1', 'live2'] },
    latestRunInstanceIdByProfile: { build: 'live2' },
    runLaunchSeqByInstance: { live1: 1, live2: 2 },
    runHistorySummaries: { [archivedNewest.historyId]: archivedNewest },
    runHistoryRecords: {
      [archivedNewest.historyId]: record(archivedNewest, 'archive', '/repo/archive'),
    },
    activeRunOutputId: 'live2',
    runOutputViewMode: 'diff',
  });

  const view = render(<RunOutputPanel />);
  expect(screen.getByTestId('diff-props')).toHaveTextContent(
    JSON.stringify({
      entries: ['live newest'],
      previousEntries: ['live older'],
      workingDir: '/repo/live2',
      previousWorkingDir: '/repo/live1',
    })
  );
  expect(mockGetRunHistoryRecord).not.toHaveBeenCalled();

  view.unmount();
  setPhase2CState({
    runOutputs: { live1: liveOutput('live1', 'build', 'live output', 1) },
    runInstanceIdsByProfile: { build: ['live1'] },
    latestRunInstanceIdByProfile: { build: 'live1' },
    runHistorySummaries: {
      [olderId]: archivedOlder,
      [newestId]: archivedNewest,
    },
    runHistoryRecords: {
      [olderId]: record(archivedOlder, 'archive older', '/repo/archive-old'),
      [newestId]: record(archivedNewest, 'archive newest', '/repo/archive-new'),
    },
    activeRunOutputId: `history:${newestId}`,
    runOutputViewMode: 'diff',
  });

  render(<RunOutputPanel />);
  expect(screen.getByTestId('diff-props')).toHaveTextContent(
    JSON.stringify({
      entries: ['archive newest'],
      previousEntries: ['archive older'],
      workingDir: '/repo/archive-new',
      previousWorkingDir: '/repo/archive-old',
    })
  );
  expect(screen.getByTestId('diff-props')).not.toHaveTextContent('live output');
});

it('builds All from one current run per profile plus readable archive fallback only', async () => {
  const archivedBuild = summary(newestId, 'build', 300);
  const olderTest = summary(otherId, 'test', 200);
  const redactedTest = summary(redactedId, 'test', 400, { outputAvailable: false });
  const compound = summary(compoundId, 'deploy', 500, {
    kind: runhistory.RecordKind.RecordKindCompoundAggregate,
    profileName: 'Deploy',
  });
  mockGetRunHistoryRecord.mockResolvedValueOnce(record(olderTest, 'archived test', '/repo/test'));
  setPhase2CState({
    runOutputs: { live: liveOutput() },
    runInstanceIdsByProfile: { build: ['live'] },
    latestRunInstanceIdByProfile: { build: 'live' },
    runLaunchSeqByInstance: { live: 1 },
    runHistorySummaries: {
      [newestId]: archivedBuild,
      [otherId]: olderTest,
      [redactedId]: redactedTest,
      [compoundId]: compound,
    },
    runHistoryRecords: {
      [newestId]: archivedBuild,
      [otherId]: olderTest,
    },
    activeRunOutputId: ALL_PROFILES_ID,
    runOutputViewMode: 'timeline',
  });

  const view = render(<RunOutputPanel />);
  expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByTestId('timeline-run-ids')).toHaveTextContent(`live,history:${otherId}`)
  );
  expect(mockGetRunHistoryRecord).toHaveBeenCalledTimes(1);
  expect(mockGetRunHistoryRecord).toHaveBeenCalledWith(otherId);
  expect(mockGetRunHistoryRecord).not.toHaveBeenCalledWith(newestId);
  expect(mockGetRunHistoryRecord).not.toHaveBeenCalledWith(redactedId);
  expect(mockGetRunHistoryRecord).not.toHaveBeenCalledWith(compoundId);

  view.unmount();
  setPhase2CState({
    runOutputs: { live: liveOutput() },
    runInstanceIdsByProfile: { build: ['live'] },
    latestRunInstanceIdByProfile: { build: 'live' },
    runHistorySummaries: { [newestId]: archivedBuild },
    runHistoryRecords: { [newestId]: archivedBuild },
    activeRunOutputId: 'live',
  });
  render(<RunOutputTabs />);
  expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
});

it('uses current profile names for archive tabs and disables deleted-profile controls', () => {
  const archivedBuild = summary(newestId, 'build', 300);
  setPhase2CState({
    runProfiles: [
      {
        id: 'build',
        name: 'Compile',
        type: 'single',
        source: 'user',
        command: 'go build ./...',
      },
    ],
    runHistorySummaries: { [newestId]: archivedBuild },
    runHistoryRecords: {
      [newestId]: record(archivedBuild, 'newest', '/repo/newest'),
    },
    activeRunOutputId: `history:${newestId}`,
  });

  render(
    <>
      <RunOutputTabs />
      <RunOutputToolbar />
    </>
  );
  expect(screen.getByRole('button', { name: 'Compile (saved)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop profile' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Re-run profile' }));
  expect(mockStartProfile).toHaveBeenCalledWith('build');
  expect(mockStopInstance).not.toHaveBeenCalled();
  expect(mockRestartInstance).not.toHaveBeenCalled();

  act(() => useIDEStore.setState({ runProfiles: [] }));
  expect(screen.getByRole('button', { name: 'Archived Build (saved)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Re-run profile' })).toBeDisabled();
});

it('keeps one archive visible during durable clear and tombstones it only after success', async () => {
  const pending = deferred<void>();
  const archivedBuild = summary(newestId, 'build', 300);
  mockClearRunHistoryRecord.mockReturnValueOnce(pending.promise);
  setPhase2CState({
    runHistorySummaries: { [newestId]: archivedBuild },
    runHistoryRecords: {
      [newestId]: record(archivedBuild, 'newest', '/repo/newest'),
    },
    activeRunOutputId: `history:${newestId}`,
  });

  render(
    <>
      <RunOutputTabs />
      <RunOutputToolbar />
    </>
  );
  const clear = screen.getByRole('button', { name: 'Clear output' });
  fireEvent.click(clear);
  fireEvent.click(clear);
  await waitFor(() => expect(mockClearRunHistoryRecord).toHaveBeenCalledWith(newestId));
  expect(mockClearRunHistoryRecord).toHaveBeenCalledTimes(1);
  expect(clear).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Build (saved)' })).toBeInTheDocument();
  expect(useIDEStore.getState().runHistoryRecords[newestId]).toMatchObject({ version: 1 });

  await act(async () => pending.resolve());
  await waitFor(() =>
    expect(useIDEStore.getState().runHistorySummaries[newestId]).toMatchObject({
      outputAvailable: false,
    })
  );
  expect(useIDEStore.getState().runHistoryRecords[newestId]).toBeUndefined();
  expect(useIDEStore.getState().runHistorySummaries[newestId]).not.toHaveProperty('version');
  expect(useIDEStore.getState().runHistorySummaries[newestId]).not.toHaveProperty('entries');
  expect(useIDEStore.getState().runHistorySummaries[newestId]).not.toHaveProperty('workingDir');
  expect(screen.queryByRole('button', { name: 'Build (saved)' })).not.toBeInTheDocument();
});

it('scopes pending archive clear ownership to the current workspace', async () => {
  const pendingA = deferred<void>();
  const pendingB = deferred<void>();
  const archiveA = summary(newestId, 'build', 300);
  const archiveB = summary(otherId, 'test', 400);
  mockClearRunHistoryRecord
    .mockReturnValueOnce(pendingA.promise)
    .mockReturnValueOnce(pendingB.promise);
  setPhase2CState({
    runHistorySummaries: { [newestId]: archiveA },
    runHistoryRecords: { [newestId]: record(archiveA, 'A', '/repo/a') },
    activeRunOutputId: `history:${newestId}`,
  });

  render(<RunOutputToolbar />);
  fireEvent.click(screen.getByRole('button', { name: 'Clear output' }));
  expect(screen.getByRole('button', { name: 'Clear output' })).toBeDisabled();

  act(() => {
    setPhase2CState({
      workspace: { name: 'Other', path: '/other' },
      workspaceEpoch: 8,
      runHistorySummaries: { [otherId]: archiveB },
      runHistoryRecords: { [otherId]: record(archiveB, 'B', '/other/b') },
      activeRunOutputId: `history:${otherId}`,
    });
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Clear output' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Clear output' }));
  expect(mockClearRunHistoryRecord.mock.calls).toEqual([[newestId], [otherId]]);
  expect(screen.getByRole('button', { name: 'Clear output' })).toBeDisabled();

  await act(async () => pendingA.resolve());
  expect(screen.getByRole('button', { name: 'Clear output' })).toBeDisabled();
  expect(useIDEStore.getState().runHistorySummaries[otherId].outputAvailable).toBe(true);

  await act(async () => pendingB.resolve());
  await waitFor(() =>
    expect(useIDEStore.getState().runHistorySummaries[otherId].outputAvailable).toBe(false)
  );
});

it('keeps archive data and selection visible when durable clear fails', async () => {
  const archivedBuild = summary(newestId, 'build', 300);
  mockClearRunHistoryRecord.mockRejectedValueOnce(new Error('disk denied'));
  setPhase2CState({
    runHistorySummaries: { [newestId]: archivedBuild },
    runHistoryRecords: {
      [newestId]: record(archivedBuild, 'newest', '/repo/newest'),
    },
    activeRunOutputId: `history:${newestId}`,
  });

  render(
    <>
      <RunOutputTabs />
      <RunOutputToolbar />
    </>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Clear output' }));

  await waitFor(() => expect(useIDEStore.getState().toast?.message).toContain('disk denied'));
  expect(useIDEStore.getState().runHistorySummaries[newestId]).toEqual(archivedBuild);
  expect(useIDEStore.getState().runHistoryRecords[newestId]).toMatchObject({ version: 1 });
  expect(useIDEStore.getState().activeRunOutputId).toBe(`history:${newestId}`);
  expect(screen.getByRole('button', { name: 'Build (saved)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Clear output' })).toBeEnabled();
});

it('clears live All immediately but tombstones archives only after zero-argument success', async () => {
  const pending = deferred<void>();
  const archivedTest = summary(otherId, 'test', 200);
  const archivedDeploy = summary(newestId, 'deploy', 300, { profileName: 'Deploy' });
  mockClearAllRunHistory.mockReturnValueOnce(pending.promise);
  setPhase2CState({
    runOutputs: { live: liveOutput() },
    runInstanceIdsByProfile: { build: ['live'] },
    latestRunInstanceIdByProfile: { build: 'live' },
    runHistorySummaries: {
      [otherId]: archivedTest,
      [newestId]: archivedDeploy,
    },
    runHistoryRecords: {
      [otherId]: record(archivedTest, 'test', '/repo/test'),
      [newestId]: record(archivedDeploy, 'deploy', '/repo/deploy'),
    },
    activeRunOutputId: ALL_PROFILES_ID,
  });

  render(
    <>
      <RunOutputTabs />
      <RunOutputToolbar />
    </>
  );
  const clear = screen.getByRole('button', { name: 'Clear output' });
  fireEvent.click(clear);
  fireEvent.click(clear);
  await waitFor(() => expect(mockClearAllRunHistory).toHaveBeenCalledWith());
  const lifecycle = jest.requireActual('../../../hooks/useRunOutput') as {
    waitForRunHistoryClears?: () => Promise<void>;
  };
  expect(typeof lifecycle.waitForRunHistoryClears).toBe('function');
  let clearBarrierSettled = false;
  const clearBarrier = lifecycle.waitForRunHistoryClears?.().then(() => {
    clearBarrierSettled = true;
  });
  await act(async () => Promise.resolve());
  expect(clearBarrierSettled).toBe(false);
  expect(mockClearAllRunHistory).toHaveBeenCalledTimes(1);
  expect(useIDEStore.getState().runOutputs.live).toBeUndefined();
  expect(useIDEStore.getState().runHistorySummaries[otherId].outputAvailable).toBe(true);
  expect(screen.getByRole('button', { name: 'Test (saved)' })).toBeInTheDocument();

  await act(async () => pending.resolve());
  await clearBarrier;
  await waitFor(() =>
    expect(
      Object.values(useIDEStore.getState().runHistorySummaries).every(
        (value) => !value.outputAvailable
      )
    ).toBe(true)
  );
  expect(useIDEStore.getState().runHistoryRecords).toEqual({});
});

it('keeps archives after Clear All rejection while retaining existing live-clear routing', async () => {
  const archivedTest = summary(otherId, 'test', 200);
  mockClearAllRunHistory.mockRejectedValueOnce(new Error('history busy'));
  setPhase2CState({
    runOutputs: { live: liveOutput() },
    runInstanceIdsByProfile: { build: ['live'] },
    latestRunInstanceIdByProfile: { build: 'live' },
    runHistorySummaries: { [otherId]: archivedTest },
    runHistoryRecords: {
      [otherId]: record(archivedTest, 'test', '/repo/test'),
    },
    activeRunOutputId: ALL_PROFILES_ID,
  });

  render(
    <>
      <RunOutputTabs />
      <RunOutputToolbar />
    </>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Clear output' }));

  await waitFor(() => expect(useIDEStore.getState().toast?.message).toContain('history busy'));
  expect(useIDEStore.getState().runOutputs.live).toBeUndefined();
  expect(useIDEStore.getState().runHistorySummaries[otherId]).toEqual(archivedTest);
  expect(useIDEStore.getState().runHistoryRecords[otherId]).toMatchObject({ version: 1 });
  expect(screen.getByRole('button', { name: 'Test (saved)' })).toBeInTheDocument();
});

it.each(['resolve', 'reject'] as const)(
  'holds LoadRunProfiles(B) behind a pending Clear All in A that later %s',
  async (outcome) => {
    const pending = deferred<void>();
    const archiveA = summary(newestId, 'build', 300);
    const archiveB = summary(otherId, 'test', 400);
    mockClearAllRunHistory.mockReturnValueOnce(pending.promise);
    mockGetRunProfilesSnapshot.mockResolvedValueOnce({
      profiles: [{ id: 'test', name: 'Test', type: 'single', source: 'user' }],
      profileState: {},
      workspaceEpoch: 8,
    });
    mockGetRunHistorySnapshot.mockResolvedValueOnce(
      new runhistory.Snapshot({ version: 1, summaries: [archiveB] })
    );
    setPhase2CState({
      runHistorySummaries: { [newestId]: archiveA },
      runHistoryRecords: { [newestId]: record(archiveA, 'A', '/repo/a') },
      activeRunOutputId: ALL_PROFILES_ID,
    });

    const { rerender } = render(
      <>
        <RunOutputToolbar />
        <RunProfilesLoader workspacePath={null} />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear output' }));
    await waitFor(() => expect(mockClearAllRunHistory).toHaveBeenCalledWith());

    act(() => {
      setPhase2CState({
        workspace: { name: 'Other', path: '/other' },
        workspaceEpoch: 8,
        runHistorySummaries: { [otherId]: archiveB },
        runHistoryRecords: { [otherId]: archiveB },
        activeRunOutputId: `history:${otherId}`,
      });
    });
    rerender(
      <>
        <RunOutputToolbar />
        <RunProfilesLoader workspacePath="/other" />
      </>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockLoadRunProfiles).not.toHaveBeenCalled();

    await act(async () => {
      if (outcome === 'resolve') pending.resolve();
      else pending.reject(new Error('A clear failed'));
    });

    await waitFor(() => expect(mockLoadRunProfiles).toHaveBeenCalledWith('/other'));
    await waitFor(() =>
      expect(useIDEStore.getState().runHistorySummaries[otherId]).toEqual(archiveB)
    );
    expect(useIDEStore.getState().runHistorySummaries[newestId]).toBeUndefined();
    expect(useIDEStore.getState().toast).toBeNull();
  }
);

it('disables archive clear while profiles are loading or run events are paused', () => {
  const archivedBuild = summary(newestId, 'build', 300);
  setPhase2CState({
    runHistorySummaries: { [newestId]: archivedBuild },
    runHistoryRecords: {
      [newestId]: record(archivedBuild, 'newest', '/repo/newest'),
    },
    activeRunOutputId: `history:${newestId}`,
    isLoadingProfiles: true,
    runEventsPaused: true,
  });

  render(<RunOutputToolbar />);
  const clear = screen.getByRole('button', { name: 'Clear output' });
  expect(clear).toBeDisabled();
  fireEvent.click(clear);
  expect(mockClearRunHistoryRecord).not.toHaveBeenCalled();
  expect(mockClearAllRunHistory).not.toHaveBeenCalled();
});

it('reports a failed All-timeline archive read once across sibling-driven effect re-runs', async () => {
  const showToast = jest.fn();
  const build = summary(olderId, 'build', 100);
  const test = summary(middleId, 'test', 200);
  const failing = summary(newestId, 'lint', 300);
  setPhase2CState({
    activeRunOutputId: ALL_PROFILES_ID,
    runOutputViewMode: 'timeline',
    runProfiles: [
      { id: 'build', name: 'Build', type: 'single', source: 'user', command: 'x' },
      { id: 'test', name: 'Test', type: 'single', source: 'user', command: 'x' },
      { id: 'lint', name: 'Lint', type: 'single', source: 'user', command: 'x' },
    ],
    runHistorySummaries: {
      [build.historyId]: build,
      [test.historyId]: test,
      [failing.historyId]: failing,
    },
    showToast,
  });

  const pending = {
    [build.historyId]: deferred<runhistory.Record>(),
    [test.historyId]: deferred<runhistory.Record>(),
    [failing.historyId]: deferred<runhistory.Record>(),
  };
  mockGetRunHistoryRecord.mockImplementation((id) => pending[id].promise);

  render(<RunOutputPanel />);
  await waitFor(() => expect(mockGetRunHistoryRecord).toHaveBeenCalledTimes(3));

  // Each sibling that resolves re-runs the timeline effect while `failing` is
  // still in flight; the re-entrant request must not add a second reaction.
  for (const resolved of [build, test]) {
    await act(async () => {
      pending[resolved.historyId].resolve(record(resolved, 'done', '/repo'));
      await Promise.resolve();
    });
  }

  await act(async () => {
    pending[failing.historyId].reject(new Error('disk gone'));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockGetRunHistoryRecord).toHaveBeenCalledTimes(3);
  expect(showToast.mock.calls).toEqual([['Failed to load run output: disk gone', 'error']]);
});

it('leaves timeline mode onto the newest archived run when no live output exists', () => {
  const oldest = summary(olderId, 'build', 100);
  const newest = summary(middleId, 'test', 200);
  setPhase2CState({
    activeRunOutputId: ALL_PROFILES_ID,
    runOutputViewMode: 'timeline',
    runHistorySummaries: { [oldest.historyId]: oldest, [newest.historyId]: newest },
  });

  render(<RunOutputToolbar />);
  fireEvent.click(screen.getByText('Merged'));

  expect(useIDEStore.getState().activeRunOutputId).toBe(`history:${newest.historyId}`);
  expect(useIDEStore.getState().runOutputViewMode).toBe('merged');
});

it('adopts a retention tombstone instead of reporting the redacted record as invalid', async () => {
  const showToast = jest.fn();
  // Stale belief: the store redacted this record for budget after the last
  // snapshot, so the frontend summary still advertises readable output.
  const stale = summary(olderId, 'build', 100);
  setPhase2CState({
    activeRunOutputId: `history:${stale.historyId}`,
    runOutputViewMode: 'merged',
    runHistorySummaries: { [stale.historyId]: stale },
    showToast,
  });
  mockGetRunHistoryRecord.mockResolvedValue(
    new runhistory.Record({ version: 1, ...stale, outputAvailable: false })
  );

  render(<RunOutputPanel />);
  await waitFor(() => expect(mockGetRunHistoryRecord).toHaveBeenCalledWith(stale.historyId));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const state = useIDEStore.getState();
  expect(state.runHistorySummaries[stale.historyId].outputAvailable).toBe(false);
  expect(state.runHistoryRecords[stale.historyId]).toBeUndefined();
  expect(state.activeRunOutputId).toBeNull();
  expect(showToast.mock.calls).toEqual([
    ['Saved output for this run was cleared to stay within the history limit.', 'info'],
  ]);
  expect(screen.queryByText(/Could not load run output/)).not.toBeInTheDocument();
});

it('still reports a structurally malformed archived record as an error', async () => {
  const showToast = jest.fn();
  const archived = summary(olderId, 'build', 100);
  setPhase2CState({
    activeRunOutputId: `history:${archived.historyId}`,
    runOutputViewMode: 'merged',
    runHistorySummaries: { [archived.historyId]: archived },
    showToast,
  });
  mockGetRunHistoryRecord.mockResolvedValue(
    new runhistory.Record({ version: 1, ...archived, historyId: middleId })
  );

  render(<RunOutputPanel />);
  await waitFor(() => expect(mockGetRunHistoryRecord).toHaveBeenCalledWith(archived.historyId));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(showToast).toHaveBeenCalledWith(
    `Failed to load run output: Invalid run history record ${archived.historyId}`,
    'error'
  );
  expect(useIDEStore.getState().runHistorySummaries[archived.historyId].outputAvailable).toBe(true);
});

it('warns that an archived run is partial, and says so in Diff terms', async () => {
  const archived = summary(olderId, 'build', 100);
  setPhase2CState({
    activeRunOutputId: `history:${archived.historyId}`,
    runOutputViewMode: 'merged',
    runHistorySummaries: { [archived.historyId]: archived },
  });
  mockGetRunHistoryRecord.mockResolvedValue(
    new runhistory.Record({
      version: 1,
      ...archived,
      truncated: true,
      workingDir: '/repo',
      entries: [{ stream: 'stdout', text: 'tail', timestamp: 100 }],
    })
  );

  render(<RunOutputPanel />);
  await waitFor(() => expect(screen.getByText(/this log is partial/i)).toBeInTheDocument());

  // In Diff the consequence is different: the missing head invents differences.
  act(() => {
    useIDEStore.getState().setRunOutputViewMode('diff');
  });
  await waitFor(() =>
    expect(
      screen.getByText(/differences near the start of the output may not be real/i)
    ).toBeInTheDocument()
  );
});

it('does not warn about a complete archived run', async () => {
  const archived = summary(olderId, 'build', 100);
  setPhase2CState({
    activeRunOutputId: `history:${archived.historyId}`,
    runOutputViewMode: 'merged',
    runHistorySummaries: { [archived.historyId]: archived },
  });
  mockGetRunHistoryRecord.mockResolvedValue(record(archived, 'complete', '/repo'));

  render(<RunOutputPanel />);
  await waitFor(() => expect(mockGetRunHistoryRecord).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.queryByText(/partial/i)).not.toBeInTheDocument();
});

it('numbers archive tabs by history id rather than object identity', () => {
  const first = summary(olderId, 'build', 100);
  const second = summary(middleId, 'build', 200);
  setPhase2CState({
    runHistorySummaries: { [first.historyId]: first, [second.historyId]: second },
  });

  render(<RunOutputTabs />);
  // A summary rebuilt by the merge is equal but not identical; indexOf would
  // have labelled it "saved 0 of 2".
  expect(screen.getByText('Build (saved 1 of 2)')).toBeInTheDocument();
  expect(screen.getByText('Build (saved 2 of 2)')).toBeInTheDocument();
  expect(screen.queryByText(/saved 0 of/)).not.toBeInTheDocument();
});
