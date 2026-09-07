import { useIDEStore } from '../../stores/ideStore';
import { estimateRemaining } from '../../utils/estimateCompletion';
import type { OutputChunk, RunState, RunStatusEvent } from '../../types/runOutput';

const status = (
  runInstanceId: string,
  state: RunState,
  launchSeq: number,
  timestamp: number,
  workspaceEpoch = 7
): RunStatusEvent => ({
  runInstanceId,
  profileId: 'p1',
  stepIdx: 0,
  state,
  exitCode: state === 'failed' ? 1 : 0,
  timestamp,
  launchSeq,
  workspaceEpoch,
});

const chunk = (
  runInstanceId: string,
  data: string,
  launchSeq: number,
  timestamp: number,
  workspaceEpoch = 7
): OutputChunk => ({
  runInstanceId,
  profileId: 'p1',
  stepIdx: 0,
  stream: 'stdout',
  data,
  timestamp,
  launchSeq,
  workspaceEpoch,
});

const phase2BState = () => useIDEStore.getState();

beforeEach(() => {
  useIDEStore.setState({
    ...useIDEStore.getInitialState(),
    workspaceEpoch: 7,
    runLaunchSeqByInstance: {},
    stoppingRunInstanceIds: [],
    restartingRunInstanceIds: [],
    discardedRunLaunchSeqsByProfile: {},
    discardedThroughLaunchSeqByProfile: {},
  });
});

describe('Phase 2B same-profile ordinary runs', () => {
  it('keeps two live buffers isolated when later-launch output arrives before either running status', () => {
    const store = useIDEStore.getState();

    // Deliberately reverse wall-clock order: launchSeq, not timestamp or RID text,
    // selects r2 as the newest live run.
    store.appendRunOutput(chunk('r2', 'two ', 20, 50));
    store.handleRunStatus(status('r1', 'running', 10, 100));
    store.appendRunOutput(chunk('r1', 'one\n', 10, 101));
    store.appendRunOutput(chunk('r2', 'lines\n', 20, 51));
    store.handleRunStatus(status('r2', 'running', 20, 52));

    const state = phase2BState();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r1', 'r2']);
    expect(state.runOutputs.r1.entries.map((entry) => entry.text)).toEqual(['one']);
    expect(state.runOutputs.r2.entries.map((entry) => entry.text)).toEqual(['two lines']);
    expect(state.runLaunchSeqByInstance).toEqual({ r1: 10, r2: 20 });
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r2');
  });

  it('tracks start and optimistic lifecycle state by RID so one terminal sibling cannot clear another', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 10, 100));
    store.handleRunStatus(status('r2', 'running', 20, 200));
    expect(store.setRunStopping).toEqual(expect.any(Function));
    expect(store.setRunRestarting).toEqual(expect.any(Function));
    store.setRunStopping('r1');
    store.setRunRestarting('r2');

    store.handleRunStatus(status('r1', 'stopped', 10, 300));

    const state = phase2BState();
    expect(state.runStartTimestamps.r1).toBeUndefined();
    expect(state.runStartTimestamps.r2).toBe(200);
    expect(state.stopRequestTimestamps.r1).toBeUndefined();
    expect(state.stopRequestTimestamps.r2).toEqual(expect.any(Number));
    expect(state.stoppingRunInstanceIds).not.toContain('r1');
    expect(state.restartingRunInstanceIds).toContain('r2');
  });

  it('retains the newest two terminal launches and moves selection when the selected buffer is evicted', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 10, 100));
    store.handleRunStatus(status('r1', 'failed', 10, 110));
    store.handleRunStatus(status('r2', 'running', 20, 120));
    store.handleRunStatus(status('r2', 'success', 20, 130));
    store.setActiveRunOutput('r1');
    store.handleRunStatus(status('r3', 'running', 30, 140));
    store.handleRunStatus(status('r3', 'success', 30, 160));

    const state = phase2BState();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r2', 'r3']);
    expect(state.runOutputs.r1).toBeUndefined();
    expect(state.activeRunOutputId).toBe('r3');
    expect(state.runHistory.p1).toEqual([
      { state: 'failed', duration: 10, timestamp: 110 },
      { state: 'success', duration: 10, timestamp: 130 },
      { state: 'success', duration: 20, timestamp: 160 },
    ]);
  });

  it('evicts a terminal buffer before an older live sibling when a new run is admitted', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 10, 100));
    store.handleRunStatus(status('r2', 'running', 20, 110));
    store.handleRunStatus(status('r2', 'failed', 20, 120));
    store.setActiveRunOutput('r2');

    store.handleRunStatus(status('r3', 'running', 30, 130));

    const state = phase2BState();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r1', 'r3']);
    expect(state.runOutputs.r1.state).toBe('running');
    expect(state.runOutputs.r2).toBeUndefined();
    expect(state.activeRunOutputId).toBe('r3');
  });

  it('drops an impossible third live RID without replacing either admitted live buffer', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 10, 100));
    store.handleRunStatus(status('r2', 'running', 20, 110));
    store.handleRunStatus(status('r3', 'running', 30, 120));
    store.appendRunOutput(chunk('r3', 'must not route\n', 30, 121));

    const state = phase2BState();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r1', 'r2']);
    expect(state.runOutputs.r3).toBeUndefined();
  });

  it('drops a cleared newer terminal RID while an older live RID continues streaming', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 10, 100));
    store.handleRunStatus(status('r2', 'running', 20, 110));
    store.handleRunStatus(status('r2', 'success', 20, 120));
    store.clearRunOutput('r2');

    store.appendRunOutput(chunk('r1', 'still live\n', 10, 121));
    store.appendRunOutput(chunk('r2', 'late cleared\n', 20, 122));

    const state = phase2BState();
    expect(state.runOutputs.r1.entries.map((entry) => entry.text)).toEqual(['still live']);
    expect(state.runOutputs.r2).toBeUndefined();
  });

  it('keeps sibling lifecycle monotonic when a terminal RID receives duplicate and regressive statuses', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 10, 100));
    store.handleRunStatus(status('r2', 'running', 20, 110));
    store.handleRunStatus(status('r1', 'stopped', 10, 120));

    store.handleRunStatus(status('r1', 'failed', 10, 130));
    store.handleRunStatus(status('r1', 'running', 10, 140));

    const state = phase2BState();
    expect(state.runOutputs.r1.state).toBe('stopped');
    expect(state.runOutputs.r2.state).toBe('running');
    expect(state.runHistory.p1).toEqual([{ state: 'stopped', duration: 20, timestamp: 120 }]);
  });

  it('clear all empties both live siblings without losing their output routes', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 10, 100));
    store.handleRunStatus(status('r2', 'running', 20, 110));
    store.appendRunOutput(chunk('r1', 'before one\n', 10, 111));
    store.appendRunOutput(chunk('r2', 'before two\n', 20, 112));

    store.clearAllRunOutputs();
    store.appendRunOutput(chunk('r1', 'after one\n', 10, 120));
    store.appendRunOutput(chunk('r2', 'after two\n', 20, 121));

    const state = phase2BState();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r1', 'r2']);
    expect(state.runOutputs.r1.entries.map((entry) => entry.text)).toEqual(['after one']);
    expect(state.runOutputs.r2.entries.map((entry) => entry.text)).toEqual(['after two']);
  });

  it('bounds tombstones while applying the compacted launch floor only to unknown RIDs', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('live-r1', 'running', 1, 10));
    for (let seq = 2; seq <= 81; seq++) {
      const rid = `r${seq}`;
      store.handleRunStatus(status(rid, 'running', seq, seq * 10));
      store.handleRunStatus(status(rid, 'success', seq, seq * 10 + 1));
      store.clearRunOutput(rid);
    }

    const compacted = phase2BState();
    expect(compacted.discardedRunLaunchSeqsByProfile.p1).toEqual(expect.any(Array));
    expect(compacted.discardedRunLaunchSeqsByProfile.p1?.length).toBeLessThanOrEqual(50);
    expect(compacted.discardedThroughLaunchSeqByProfile.p1).toBeGreaterThan(1);
    expect(compacted.runOutputs.r2).toBeUndefined();
    expect(compacted.runInstanceIdsByProfile.p1).not.toContain('r2');

    store.appendRunOutput(chunk('r2', 'stale\n', 2, 998));
    store.handleRunStatus(status('r2', 'running', 2, 999));
    store.appendRunOutput(chunk('live-r1', 'still live\n', 1, 1000));
    store.handleRunStatus(status('live-r1', 'success', 1, 1001));

    const state = phase2BState();
    expect(state.runOutputs.r2).toBeUndefined();
    expect(state.runInstanceIdsByProfile.p1).not.toContain('r2');
    expect(state.runOutputs['live-r1'].entries.map((entry) => entry.text)).toEqual(['still live']);
    expect(state.runOutputs['live-r1'].state).toBe('success');
  });

  it('rejects old-epoch output before any current-workspace run exists', () => {
    const store = useIDEStore.getState();
    store.appendRunOutput(chunk('r1', 'old\n', 10, 100, 6));
    expect(phase2BState().runOutputs).toEqual({});
  });

  it('reports whether an output chunk was accepted so waveform counting can use the same gate', () => {
    const store = useIDEStore.getState();
    const rejected = store.appendRunOutput(chunk('old', 'old\n', 10, 100, 6));
    const accepted = store.appendRunOutput(chunk('current', 'current\n', 20, 101, 7));

    expect({ rejected, accepted }).toEqual({ rejected: false, accepted: true });
  });

  it('rejects old-epoch status events as well as output', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('old-status', 'running', 11, 101, 6));

    expect(phase2BState().runOutputs).toEqual({});
  });

  it('rejects old-epoch compound snapshots as well as ordinary events', () => {
    const store = useIDEStore.getState();
    useIDEStore.setState({
      runProfiles: [
        { id: 'ci', name: 'CI', type: 'compound', source: 'user', steps: ['p1'] },
        { id: 'p1', name: 'Build', type: 'single', source: 'user', command: 'echo build' },
      ],
    });
    store.handleRunStatus({
      ...status('old-compound', 'running', 12, 101, 6),
      profileId: 'ci',
    });
    store.handleCompoundRun({
      runInstanceId: 'old-compound',
      compoundId: 'ci',
      name: 'CI',
      state: 'running',
      currentStep: 0,
      steps: [],
      launchSeq: 12,
      workspaceEpoch: 6,
    });

    const state = phase2BState();
    expect(state.runCompounds).toEqual({});
  });

  it('rejects current-epoch status, output, and compound updates while event acceptance is paused', () => {
    const store = useIDEStore.getState();
    useIDEStore.setState({
      runProfiles: [
        { id: 'ci', name: 'CI', type: 'compound', source: 'user', steps: ['p1'] },
        { id: 'p1', name: 'Build', type: 'single', source: 'user', command: 'echo build' },
      ],
    });
    store.handleRunStatus({
      ...status('aggregate', 'running', 12, 100, 7),
      profileId: 'ci',
    });
    store.handleCompoundRun({
      runInstanceId: 'aggregate',
      compoundId: 'ci',
      name: 'CI',
      state: 'running',
      currentStep: 0,
      steps: [],
      launchSeq: 12,
      workspaceEpoch: 7,
    });

    useIDEStore.setState({ runEventsPaused: true });
    const accepted = store.appendRunOutput(chunk('ordinary-output', 'late\n', 20, 110, 7));
    store.handleRunStatus(status('ordinary-status', 'running', 21, 111, 7));
    store.handleCompoundRun({
      runInstanceId: 'aggregate',
      compoundId: 'ci',
      name: 'Late CI update',
      state: 'running',
      currentStep: 0,
      steps: [],
      launchSeq: 12,
      workspaceEpoch: 7,
    });

    const state = phase2BState();
    expect(accepted).toBe(false);
    expect(state.runOutputs).toEqual({});
    expect(state.runCompounds.ci.name).toBe('CI');
  });

  it('rotates compound aggregates by launch sequence and retains only the current sequence identity', () => {
    const store = useIDEStore.getState();
    useIDEStore.setState({
      runProfiles: [
        { id: 'ci', name: 'CI', type: 'compound', source: 'user', steps: ['p1'] },
        { id: 'p1', name: 'Build', type: 'single', source: 'user', command: 'echo build' },
      ],
    });
    const aggregateStatus = (
      runInstanceId: string,
      state: RunState,
      launchSeq: number,
      timestamp: number
    ): RunStatusEvent => ({
      ...status(runInstanceId, state, launchSeq, timestamp),
      profileId: 'ci',
    });

    store.handleRunStatus(aggregateStatus('aggregate-1', 'running', 10, 100));
    store.handleRunStatus(aggregateStatus('aggregate-1', 'success', 10, 200));
    store.handleRunStatus(aggregateStatus('aggregate-2', 'running', 20, 100));

    let state = phase2BState();
    expect(state.latestRunInstanceIdByProfile.ci).toBe('aggregate-2');
    expect(state.runLaunchSeqByInstance).toEqual({ 'aggregate-2': 20 });

    store.handleRunStatus(aggregateStatus('aggregate-2', 'success', 20, 250));
    store.handleRunStatus(aggregateStatus('aggregate-stale', 'running', 15, 300));

    state = phase2BState();
    expect(state.latestRunInstanceIdByProfile.ci).toBe('aggregate-2');
    expect(state.runCompounds.ci.runInstanceId).toBe('aggregate-2');
    expect(state.runLaunchSeqByInstance).toEqual({ 'aggregate-2': 20 });
  });

  it('keeps one bounded compound sequence tombstone across Clear All for the next rerun', () => {
    const store = useIDEStore.getState();
    useIDEStore.setState({
      runProfiles: [
        { id: 'ci', name: 'CI', type: 'compound', source: 'user', steps: ['p1'] },
        { id: 'p1', name: 'Build', type: 'single', source: 'user', command: 'echo build' },
      ],
    });
    const aggregateStatus = (
      runInstanceId: string,
      state: RunState,
      launchSeq: number,
      timestamp: number
    ): RunStatusEvent => ({
      ...status(runInstanceId, state, launchSeq, timestamp),
      profileId: 'ci',
    });

    store.handleRunStatus(aggregateStatus('aggregate-1', 'running', 10, 100));
    store.handleRunStatus(aggregateStatus('aggregate-1', 'success', 10, 200));
    store.clearAllRunOutputs();

    let state = phase2BState();
    expect(state.runCompounds).toEqual({});
    expect(state.latestRunInstanceIdByProfile.ci).toBe('aggregate-1');
    expect(state.runLaunchSeqByInstance).toEqual({ 'aggregate-1': 10 });

    store.handleRunStatus(aggregateStatus('aggregate-2', 'running', 20, 100));

    state = phase2BState();
    expect(state.runCompounds.ci.runInstanceId).toBe('aggregate-2');
    expect(state.runLaunchSeqByInstance).toEqual({ 'aggregate-2': 20 });
  });

  it('keeps the epoch barrier after workspace reset so delayed old output cannot resurrect a run', () => {
    const store = useIDEStore.getState();
    store.resetWorkspaceRunState();
    store.appendRunOutput(chunk('r2', 'also old\n', 20, 200, 6));

    expect(phase2BState().runOutputs).toEqual({});
  });

  it('uses the newest live launch for profile-level ETA while keeping terminal history profile-keyed', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('history-r1', 'running', 10, 100));
    store.handleRunStatus(status('history-r1', 'success', 10, 200));
    store.handleRunStatus(status('history-r2', 'running', 20, 300));
    store.handleRunStatus(status('history-r2', 'success', 20, 600));
    store.handleRunStatus(status('live-r1', 'running', 30, 1200));
    store.handleRunStatus(status('live-r2', 'running', 40, 1400));

    const state = phase2BState();
    const representative = state.latestRunInstanceIdByProfile.p1;
    const elapsed = 1500 - state.runStartTimestamps[representative];
    expect(representative).toBe('live-r2');
    expect(state.runHistory.p1).toEqual([
      { state: 'success', duration: 100, timestamp: 200 },
      { state: 'success', duration: 300, timestamp: 600 },
    ]);
    expect(state.runInstanceIdsByProfile.p1).toEqual(['live-r1', 'live-r2']);
    expect(state.runStartTimestamps[representative]).toBe(1400);
    expect(elapsed).toBe(100);
    expect(estimateRemaining(state.runHistory.p1, elapsed)).toBe(100);
  });
});
