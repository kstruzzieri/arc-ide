import { useIDEStore } from '../../stores/ideStore';

const historyId = '018f0000-0000-7000-8000-000000000001';
const selectionKey = `history:${historyId}`;

const archived = (profileId: string) => ({
  historyId,
  kind: 'ordinary',
  profileId,
  profileName: profileId === 'build' ? 'Build' : 'Test',
  state: 'success',
  exitCode: 0,
  startedAt: 100,
  completedAt: 200,
  outputAvailable: true,
  workingDir: '/repo',
  entries: [{ stream: 'stdout', text: 'old', timestamp: 150 }],
});

const setPhase2CState = (profileId: string, activeRunOutputId: string) => {
  const setState = useIDEStore.setState as unknown as (patch: Record<string, unknown>) => void;
  setState({
    ...useIDEStore.getInitialState(),
    workspaceEpoch: 7,
    runEventsPaused: false,
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
    runHistoryRecords: { [historyId]: archived(profileId) },
    runHistorySummaries: { [historyId]: archived(profileId) },
    activeRunOutputId,
  });
};

const startBuild = () =>
  useIDEStore.getState().handleRunStatus({
    runInstanceId: 'r1',
    profileId: 'build',
    stepIdx: 0,
    launchSeq: 1,
    workspaceEpoch: 7,
    state: 'running',
    exitCode: 0,
    timestamp: 300,
  });

const setPhase2CCompoundState = (profileId: string, activeRunOutputId: string) => {
  setPhase2CState(profileId, activeRunOutputId);
  const setState = useIDEStore.setState as unknown as (patch: Record<string, unknown>) => void;
  setState({
    runProfiles: [
      {
        id: 'ci',
        name: 'CI',
        type: 'compound',
        source: 'user',
        steps: ['build'],
      },
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
    runHistoryRecords: {
      [historyId]: {
        ...archived(profileId),
        kind: profileId === 'ci' ? 'compound-aggregate' : 'ordinary',
      },
    },
    runHistorySummaries: {
      [historyId]: {
        ...archived(profileId),
        kind: profileId === 'ci' ? 'compound-aggregate' : 'ordinary',
      },
    },
    runCompounds: {
      ci: {
        compoundId: 'ci',
        runInstanceId: 'aggregate-r1',
        launchSeq: 2,
        workspaceEpoch: 7,
        name: 'CI',
        state: 'running',
        currentStep: 0,
        steps: [],
        stepOutputs: {},
      },
    },
    latestRunInstanceIdByProfile: { ci: 'aggregate-r1' },
    compoundIdByRunInstance: { 'aggregate-r1': 'ci' },
  });
};

const startCompound = () =>
  useIDEStore.getState().handleCompoundRun({
    runInstanceId: 'aggregate-r1',
    compoundId: 'ci',
    name: 'CI',
    launchSeq: 2,
    workspaceEpoch: 7,
    state: 'running',
    currentStep: 0,
    steps: [],
  });

it('stores archive records under raw UUID keys and uses the prefix only for selection', () => {
  setPhase2CState('build', selectionKey);
  const state = useIDEStore.getState() as unknown as {
    runHistoryRecords: Record<string, unknown>;
    runHistorySummaries: Record<string, unknown>;
    activeRunOutputId: string;
  };

  expect(Object.keys(state.runHistoryRecords)).toEqual([historyId]);
  expect(Object.keys(state.runHistorySummaries)).toEqual([historyId]);
  expect(state.runHistoryRecords).not.toHaveProperty(selectionKey);
  expect(state.activeRunOutputId).toBe(selectionKey);
});

it('a same-profile ordinary launch steals historical selection', () => {
  setPhase2CState('build', selectionKey);
  startBuild();
  expect(useIDEStore.getState().activeRunOutputId).toBe('r1');
});

it('a different-profile ordinary launch preserves historical selection', () => {
  setPhase2CState('test', selectionKey);
  startBuild();
  expect(useIDEStore.getState().activeRunOutputId).toBe(selectionKey);
});

it('ALL_PROFILES_ID keeps its current auto-selection behavior', () => {
  setPhase2CState('test', '__all__');
  startBuild();
  expect(useIDEStore.getState().activeRunOutputId).toBe('r1');
});

it('a same-profile compound launch steals historical selection', () => {
  setPhase2CCompoundState('ci', selectionKey);
  startCompound();
  expect(useIDEStore.getState().activeRunOutputId).toBe('aggregate-r1');
});

it('a different-profile compound launch preserves historical selection', () => {
  setPhase2CCompoundState('test', selectionKey);
  startCompound();
  expect(useIDEStore.getState().activeRunOutputId).toBe(selectionKey);
});

it('a compound launch preserves current ALL_PROFILES_ID auto-selection behavior', () => {
  setPhase2CCompoundState('test', '__all__');
  startCompound();
  expect(useIDEStore.getState().activeRunOutputId).toBe('aggregate-r1');
});
