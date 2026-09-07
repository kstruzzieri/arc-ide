import { useIDEStore } from '../../stores/ideStore';
import { ALL_PROFILES_ID, MAX_OUTPUT_ENTRIES } from '../../types/runOutput';
import type { OutputChunk, RunState, RunStatusEvent } from '../../types/runOutput';
import type { RunProfile } from '../../types/runProfile';

type Phase2AState = ReturnType<typeof useIDEStore.getState> & {
  runInstanceIdsByProfile: Record<string, string[]>;
  latestRunInstanceIdByProfile: Record<string, string>;
};

const profile = (
  id: string,
  workingDir: string,
  type: RunProfile['type'] = 'single'
): RunProfile => ({
  id,
  name: id.toUpperCase(),
  type,
  source: 'user',
  command: type === 'single' ? 'echo test' : undefined,
  steps: type === 'compound' ? ['p1'] : undefined,
  workingDir,
});

const status = (
  runInstanceId: string,
  state: RunState,
  profileId = 'p1',
  timestamp = Date.now(),
  launchSeq?: number
): RunStatusEvent => ({
  runInstanceId,
  profileId,
  stepIdx: 0,
  state,
  exitCode: state === 'failed' ? 1 : 0,
  timestamp,
  launchSeq,
});

const chunk = (
  runInstanceId: string,
  data: string,
  profileId = 'p1',
  timestamp = Date.now(),
  launchSeq?: number
): OutputChunk => ({
  runInstanceId,
  profileId,
  stepIdx: 0,
  stream: 'stdout',
  data,
  timestamp,
  launchSeq,
});

const phase2State = (): Phase2AState => useIDEStore.getState() as Phase2AState;

let nextStartedAt = 1000;
let nextLaunchSeq = 1;

const completeRun = (runInstanceId: string, data: string, profileId = 'p1', startedAt?: number) => {
  const start = startedAt ?? nextStartedAt;
  if (startedAt == null) nextStartedAt += 1000;
  const launchSeq = nextLaunchSeq++;
  const store = useIDEStore.getState();
  store.handleRunStatus(status(runInstanceId, 'running', profileId, start, launchSeq));
  store.appendRunOutput(chunk(runInstanceId, data, profileId, start + 1, launchSeq));
  store.handleRunStatus(status(runInstanceId, 'success', profileId, start + 2, launchSeq));
  return launchSeq;
};

beforeEach(() => {
  nextStartedAt = 1000;
  nextLaunchSeq = 1;
  useIDEStore.setState({
    ...useIDEStore.getInitialState(),
    runProfiles: [
      profile('p1', 'packages/old'),
      profile('p2', 'packages/two'),
      profile('ci', '.', 'compound'),
    ],
    runOutputs: {},
    runCompounds: {},
    compoundIdByRunInstance: {},
    runInstanceIdsByProfile: {},
    latestRunInstanceIdByProfile: {},
  } as Partial<Phase2AState>);
  useIDEStore.getState().resetWorkspaceRunState();
  useIDEStore.setState({
    runProfiles: [
      profile('p1', 'packages/old'),
      profile('p2', 'packages/two'),
      profile('ci', '.', 'compound'),
    ],
  });
});

describe('ordinary run-instance output history', () => {
  it('retains reruns by backend run instance and removes the legacy predecessor fields', () => {
    completeRun('r1', 'old\n');
    useIDEStore.setState((state) => ({
      runProfiles: state.runProfiles.map((runProfile) =>
        runProfile.id === 'p1' ? { ...runProfile, workingDir: 'packages/new' } : runProfile
      ),
    }));
    completeRun('r2', 'new\n');

    const state = phase2State();
    expect(Object.keys(state.runOutputs)).toEqual(['r1', 'r2']);
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r1', 'r2']);
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r2');
    expect(state.runOutputs.r1.entries.map((entry) => entry.text)).toEqual(['old']);
    expect(state.runOutputs.r2.entries.map((entry) => entry.text)).toEqual(['new']);
    expect(state.runOutputs.r1.workingDir).toBe('packages/old');
    expect(state.runOutputs.r2.workingDir).toBe('packages/new');
    expect(state.runOutputs.r2).not.toHaveProperty('previousEntries');
    expect(state.runOutputs.r2).not.toHaveProperty('previousWorkingDir');
    expect(state.runOutputs.r2).not.toHaveProperty('runCount');
  });

  it('accepts output before running status without losing entries or current identity', () => {
    const store = useIDEStore.getState();
    store.appendRunOutput(chunk('r1', 'early\n'));
    store.handleRunStatus(status('r1', 'running'));

    const state = phase2State();
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r1');
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r1']);
    expect(state.runOutputs.r1.state).toBe('running');
    expect(state.runOutputs.r1.entries.map((entry) => entry.text)).toEqual(['early']);
  });

  it('accepts terminal status after output arrives before any status', () => {
    const store = useIDEStore.getState();
    store.appendRunOutput(chunk('r1', 'early\n', 'p1', 1000));
    store.handleRunStatus(status('r1', 'success', 'p1', 1100));

    const state = phase2State();
    expect(state.runOutputs.r1.state).toBe('success');
    expect(state.runOutputs.r1.entries.map((entry) => entry.text)).toEqual(['early']);
    expect(state.runHistory.p1).toBeUndefined();
  });

  it('does not regress a terminal execution on delayed same-RID running status', () => {
    completeRun('r1', 'done\n', 'p1', 1000);

    useIDEStore.getState().handleRunStatus(status('r1', 'running', 'p1', 1200));

    const state = phase2State();
    expect(state.runOutputs.r1.state).toBe('success');
    expect(state.runStartTimestamps.p1).toBe(1000);
  });

  it.each(['success', 'failed', 'stopped'] as const)(
    'does not regress an ordinary %s execution on same-RID idle status',
    (terminalState) => {
      const store = useIDEStore.getState();
      store.handleRunStatus(status('r1', 'running', 'p1', 1000));
      store.handleRunStatus(status('r1', terminalState, 'p1', 1100));

      store.handleRunStatus(status('r1', 'idle', 'p1', 1200));

      expect(phase2State().runOutputs.r1.state).toBe(terminalState);
    }
  );

  it('rejects a mismatched ordinary running status without an ordering timestamp', () => {
    completeRun('r1', 'done\n', 'p1', 1000);

    useIDEStore.getState().handleRunStatus({
      runInstanceId: 'r2',
      profileId: 'p1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
    });

    const state = phase2State();
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r1');
    expect(state.runOutputs.r2).toBeUndefined();
  });

  it('does not duplicate ordinary history for repeated terminal status', () => {
    completeRun('r1', 'done\n', 'p1', 1000);

    useIDEStore.getState().handleRunStatus(status('r1', 'success', 'p1', 1002));

    expect(phase2State().runHistory.p1).toEqual([
      { state: 'success', duration: 2, timestamp: 1002 },
    ]);
  });

  it('keeps the first start timestamp when running status is duplicated', () => {
    const store = useIDEStore.getState();
    store.appendRunOutput(chunk('r1', 'early\n', 'p1', 900));
    store.handleRunStatus(status('r1', 'running', 'p1', 1000));
    store.handleRunStatus(status('r1', 'running', 'p1', 1200));

    const state = phase2State();
    expect(state.runOutputs.r1.state).toBe('running');
    expect(state.runStartTimestamps.p1).toBe(1000);
  });

  it('keeps per-instance line assembly isolated and enforces the existing entry cap', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 'p1', 1000));
    store.appendRunOutput(chunk('r1', 'old partial', 'p1', 1001));
    store.handleRunStatus(status('r1', 'success', 'p1', 1002));

    store.handleRunStatus(status('r2', 'running', 'p1', 2000));
    store.appendRunOutput(chunk('r2', 'new ', 'p1', 2001));
    store.appendRunOutput(chunk('r2', 'line\n', 'p1', 2002));
    store.appendRunOutput(
      chunk(
        'r2',
        `${Array.from({ length: MAX_OUTPUT_ENTRIES }, (_, index) => `line-${index}`).join('\n')}\n`,
        'p1',
        2003
      )
    );

    const state = phase2State();
    expect(state.runOutputs.r1.entries.map((entry) => entry.text)).toEqual(['old partial']);
    expect(state.runOutputs.r2.entries).toHaveLength(MAX_OUTPUT_ENTRIES);
    expect(state.runOutputs.r2.entries[0].text).toBe('[truncated — oldest output removed]');
    expect(state.runOutputs.r2.entries.at(-1)?.text).toBe(`line-${MAX_OUTPUT_ENTRIES - 1}`);
  });

  it('rejects late output and status from a retained predecessor after the newest run completes', () => {
    const r1LaunchSeq = completeRun('r1', 'old\n');
    completeRun('r2', 'new\n');

    const store = useIDEStore.getState();
    store.appendRunOutput(chunk('r1', 'late\n', 'p1', 1003, r1LaunchSeq));
    store.handleRunStatus(status('r1', 'failed', 'p1', 1004, r1LaunchSeq));

    const state = phase2State();
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r2');
    expect(state.runOutputs.r1.state).toBe('success');
    expect(state.runOutputs.r1.entries.map((entry) => entry.text)).toEqual(['old']);
    expect(state.runOutputs.r2.entries.map((entry) => entry.text)).toEqual(['new']);
  });

  it('rejects late output from a pruned execution after the newest run completes', () => {
    const r1LaunchSeq = completeRun('r1', 'one\n', 'p1', 1000);
    completeRun('r2', 'two\n', 'p1', 2000);
    completeRun('r3', 'three\n', 'p1', 3000);

    useIDEStore.getState().appendRunOutput(chunk('r1', 'late\n', 'p1', 1001, r1LaunchSeq));

    const state = phase2State();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r2', 'r3']);
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r3');
    expect(state.runOutputs.r1).toBeUndefined();
  });

  it('rejects late running and terminal status from a pruned execution', () => {
    const r1LaunchSeq = completeRun('r1', 'one\n', 'p1', 1000);
    completeRun('r2', 'two\n', 'p1', 2000);
    completeRun('r3', 'three\n', 'p1', 3000);

    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 'p1', 1000, r1LaunchSeq));
    store.handleRunStatus(status('r1', 'failed', 'p1', 1002, r1LaunchSeq));

    const state = phase2State();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r2', 'r3']);
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r3');
    expect(state.runOutputs.r1).toBeUndefined();
    expect(state.runOutputs.r3.state).toBe('success');
  });

  it('accepts genuinely newer output before status after pruning older executions', () => {
    completeRun('r1', 'one\n', 'p1', 1000);
    completeRun('r2', 'two\n', 'p1', 2000);
    completeRun('r3', 'three\n', 'p1', 3000);

    useIDEStore.getState().appendRunOutput(chunk('r4', 'early\n', 'p1', 4000));

    const state = phase2State();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r3', 'r4']);
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r4');
    expect(state.runOutputs.r4.entries.map((entry) => entry.text)).toEqual(['early']);
  });

  it('does not resurrect a cleared execution after newer output arrives before status', () => {
    completeRun('r1', 'one\n', 'p1', 1000);
    completeRun('r2', 'two\n', 'p1', 2000);
    const store = useIDEStore.getState();
    store.clearRunOutput('r2');

    store.appendRunOutput(chunk('r3', 'new early\n', 'p1', 3001));
    store.appendRunOutput(chunk('r2', 'stale\n', 'p1', 2001));
    store.handleRunStatus(status('r3', 'running', 'p1', 3000));

    const state = phase2State();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r1', 'r3']);
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r3');
    expect(state.runOutputs.r2).toBeUndefined();
    expect(state.runOutputs.r3.state).toBe('running');
    expect(state.runOutputs.r3.entries.map((entry) => entry.text)).toEqual(['new early']);
  });

  it('selects a new execution when a retained run of the same profile is active', () => {
    completeRun('r1', 'one\n', 'p1', 1000);
    useIDEStore.getState().setActiveRunOutput('r1');

    useIDEStore.getState().handleRunStatus(status('r2', 'running', 'p1', 2000));

    expect(phase2State().activeRunOutputId).toBe('r2');
  });

  it.each([null, ALL_PROFILES_ID])(
    'selects a new execution when the active selection is %s',
    (activeRunOutputId) => {
      completeRun('r1', 'one\n', 'p1', 1000);
      useIDEStore.getState().setActiveRunOutput(activeRunOutputId);

      useIDEStore.getState().handleRunStatus(status('r2', 'running', 'p1', 2000));

      expect(phase2State().activeRunOutputId).toBe('r2');
    }
  );

  it('does not select a new execution over an active run from another profile', () => {
    completeRun('r1', 'one\n', 'p1', 1000);
    completeRun('other-r1', 'other\n', 'p2', 1500);
    useIDEStore.getState().setActiveRunOutput('other-r1');

    useIDEStore.getState().handleRunStatus(status('r2', 'running', 'p1', 2000));

    expect(phase2State().activeRunOutputId).toBe('other-r1');
  });

  it('focuses the newest live sibling before a newer terminal sibling', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r1', 'running', 'p1', 1000, 1));
    store.handleRunStatus(status('r2', 'running', 'p1', 2000, 2));
    store.handleRunStatus(status('r2', 'success', 'p1', 2001, 2));

    store.focusProfileOutput('p1');

    expect(phase2State().activeRunOutputId).toBe('r1');
  });

  it('keeps only two executions and selects the newest when a selected tab is pruned', () => {
    completeRun('r1', 'one\n');
    completeRun('r2', 'two\n');
    useIDEStore.getState().setActiveRunOutput('r1');
    completeRun('r3', 'three\n');

    const state = phase2State();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r2', 'r3']);
    expect(Object.keys(state.runOutputs)).toEqual(['r2', 'r3']);
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r3');
    expect(state.activeRunOutputId).toBe('r3');
  });

  it('does not make an older retained tab current after clearing the newest execution', () => {
    completeRun('r1', 'one\n');
    completeRun('r2', 'two\n');
    useIDEStore.getState().setActiveRunOutput('r2');

    useIDEStore.getState().clearRunOutput('r2');

    let state = phase2State();
    expect(state.runOutputs.r2).toBeUndefined();
    expect(state.runInstanceIdsByProfile.p1).toEqual(['r1']);
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r2');
    expect(state.activeRunOutputId).toBe('r1');

    useIDEStore.getState().handleRunStatus(status('r2', 'failed'));
    state = phase2State();
    expect(state.runOutputs.r2).toBeUndefined();
    expect(state.latestRunInstanceIdByProfile.p1).toBe('r2');

    useIDEStore.getState().focusProfileOutput('p1');
    expect(phase2State().activeRunOutputId).toBe('r1');
    expect(phase2State().latestRunInstanceIdByProfile.p1).toBe('r2');
  });

  it.each(['clearRunOutput', 'clearAllRunOutputs'] as const)(
    'keeps output-before-status execution routable through %s',
    (clearAction) => {
      const store = useIDEStore.getState();
      store.appendRunOutput(chunk('r1', 'early\n', 'p1', 1001));

      if (clearAction === 'clearRunOutput') {
        store.clearRunOutput('r1');
      } else {
        store.clearAllRunOutputs();
      }
      store.handleRunStatus(status('r1', 'running', 'p1', 1000));
      store.appendRunOutput(chunk('r1', 'later\n', 'p1', 1002));

      const state = phase2State();
      expect(state.runOutputs.r1.state).toBe('running');
      expect(state.runOutputs.r1.entries.map((entry) => entry.text)).toEqual(['later']);
      expect(state.runInstanceIdsByProfile.p1).toEqual(['r1']);
      expect(state.latestRunInstanceIdByProfile.p1).toBe('r1');
    }
  );

  it('hard-clears running execution state on workspace reset', () => {
    completeRun('r1', 'old\n');
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r2', 'running'));
    store.appendRunOutput(chunk('r2', 'live\n'));

    store.resetWorkspaceRunState();

    const state = phase2State();
    expect(state.runOutputs.r1).toBeUndefined();
    expect(state.runOutputs.r2).toBeUndefined();
    expect(state.runInstanceIdsByProfile).toEqual({});
    expect(state.latestRunInstanceIdByProfile).toEqual({});
    expect(state.activeRunOutputId).toBeNull();
    expect(state.runCompounds).toEqual({});
  });

  it('clear-all preserves only running output without falling back the current pointer', () => {
    completeRun('r1', 'old\n');
    const store = useIDEStore.getState();
    store.handleRunStatus(status('r2', 'running'));
    store.appendRunOutput(chunk('r2', 'live\n'));
    store.clearAllRunOutputs();

    let state = phase2State();
    expect(Object.keys(state.runOutputs)).toEqual(['r2']);
    expect(state.runOutputs.r2.entries).toEqual([]);
    expect(state.runInstanceIdsByProfile).toEqual({ p1: ['r2'] });
    expect(state.latestRunInstanceIdByProfile).toEqual({ p1: 'r2' });

    store.handleRunStatus(status('r2', 'success'));
    store.clearAllRunOutputs();

    state = phase2State();
    expect(state.runOutputs).toEqual({});
    expect(state.runInstanceIdsByProfile).toEqual({});
    expect(state.latestRunInstanceIdByProfile).toEqual({ p1: 'r2' });
    expect(state.activeRunOutputId).toBeNull();
  });
});

describe('compound aggregate coexistence', () => {
  it('keeps aggregate status out of ordinary output while preserving lifecycle history', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(status('agg-r1', 'running', 'ci', 1000));

    let state = phase2State();
    expect(state.runOutputs).toEqual({});
    expect(state.latestRunInstanceIdByProfile.ci).toBe('agg-r1');
    expect(state.activeRunOutputId).toBe('agg-r1');
    expect(state.runStartTimestamps.ci).toBe(1000);

    store.handleCompoundRun({
      runInstanceId: 'agg-r1',
      compoundId: 'ci',
      name: 'CI',
      state: 'running',
      currentStep: 0,
      steps: [],
    });
    store.handleRunStatus(status('agg-r1', 'success', 'ci', 1500));

    state = phase2State();
    expect(state.runOutputs).toEqual({});
    expect(state.runCompounds.ci.runInstanceId).toBe('agg-r1');
    expect(state.runCompounds.ci.state).toBe('success');
    expect(state.compoundIdByRunInstance).toEqual({ 'agg-r1': 'ci' });
    expect(state.runHistory.ci).toEqual([{ state: 'success', duration: 500, timestamp: 1500 }]);

    store.setActiveRunOutput(null);
    store.focusProfileOutput('ci');
    expect(phase2State().activeRunOutputId).toBe('agg-r1');
  });
});
