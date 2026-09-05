import { useIDEStore } from '../../stores/ideStore';
import type { RunHistoryEntry } from '../../types/runOutput';
import type { RunProfile } from '../../types/runProfile';

// Reset lifecycle state between tests
beforeEach(() => {
  useIDEStore.setState({
    stoppingProfileIds: [],
    restartingProfileIds: [],
    runHistory: {},
    waveformData: {},
    hiddenProfileIds: [],
    runStartTimestamps: {},
    stopRequestTimestamps: {},
    activeRunOutputId: null,
    runOutputs: {},
    runInstanceIdsByProfile: {},
    latestRunInstanceIdByProfile: {},
    activeTerminalTab: 'terminal',
    isBottomPanelCollapsed: false,
    isFilesPanelCollapsed: false,
    isGolemPanelCollapsed: true,
    centerReveal: 'files',
  });
});

describe('lifecycleStore - setProfileStopping / clearProfileStopping', () => {
  it('should add a profile id to stoppingProfileIds', () => {
    const { setProfileStopping } = useIDEStore.getState();
    setProfileStopping('profile-1');
    expect(useIDEStore.getState().stoppingProfileIds).toContain('profile-1');
  });

  it('should add multiple distinct ids', () => {
    const { setProfileStopping } = useIDEStore.getState();
    setProfileStopping('profile-1');
    setProfileStopping('profile-2');
    const ids = useIDEStore.getState().stoppingProfileIds;
    expect(ids).toContain('profile-1');
    expect(ids).toContain('profile-2');
    expect(ids).toHaveLength(2);
  });

  it('should remove a profile id with clearProfileStopping', () => {
    const { setProfileStopping, clearProfileStopping } = useIDEStore.getState();
    setProfileStopping('profile-1');
    clearProfileStopping('profile-1');
    expect(useIDEStore.getState().stoppingProfileIds).not.toContain('profile-1');
  });

  it('clearProfileStopping is a no-op for an absent id', () => {
    const { setProfileStopping, clearProfileStopping } = useIDEStore.getState();
    setProfileStopping('profile-1');
    clearProfileStopping('profile-99');
    expect(useIDEStore.getState().stoppingProfileIds).toContain('profile-1');
    expect(useIDEStore.getState().stoppingProfileIds).toHaveLength(1);
  });

  it('should only remove the targeted id, leaving others intact', () => {
    const { setProfileStopping, clearProfileStopping } = useIDEStore.getState();
    setProfileStopping('profile-1');
    setProfileStopping('profile-2');
    clearProfileStopping('profile-1');
    const ids = useIDEStore.getState().stoppingProfileIds;
    expect(ids).not.toContain('profile-1');
    expect(ids).toContain('profile-2');
  });
});

describe('lifecycleStore - setProfileRestarting / clearProfileRestarting', () => {
  it('should add a profile id to restartingProfileIds', () => {
    const { setProfileRestarting } = useIDEStore.getState();
    setProfileRestarting('profile-1');
    expect(useIDEStore.getState().restartingProfileIds).toContain('profile-1');
  });

  it('should remove a profile id with clearProfileRestarting', () => {
    const { setProfileRestarting, clearProfileRestarting } = useIDEStore.getState();
    setProfileRestarting('profile-1');
    clearProfileRestarting('profile-1');
    expect(useIDEStore.getState().restartingProfileIds).not.toContain('profile-1');
  });

  it('clearProfileRestarting is a no-op for an absent id', () => {
    const { setProfileRestarting, clearProfileRestarting } = useIDEStore.getState();
    setProfileRestarting('profile-1');
    clearProfileRestarting('profile-99');
    expect(useIDEStore.getState().restartingProfileIds).toContain('profile-1');
    expect(useIDEStore.getState().restartingProfileIds).toHaveLength(1);
  });
});

describe('lifecycleStore - appendRunHistory', () => {
  const makeEntry = (timestamp: number): RunHistoryEntry => ({
    state: 'success',
    duration: 1000,
    timestamp,
  });

  it('should append a history entry for a profile', () => {
    const { appendRunHistory } = useIDEStore.getState();
    const entry = makeEntry(1000);
    appendRunHistory('profile-1', entry);
    const history = useIDEStore.getState().runHistory['profile-1'];
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(entry);
  });

  it('should append multiple entries in order', () => {
    const { appendRunHistory } = useIDEStore.getState();
    appendRunHistory('profile-1', makeEntry(1000));
    appendRunHistory('profile-1', makeEntry(2000));
    appendRunHistory('profile-1', makeEntry(3000));
    const history = useIDEStore.getState().runHistory['profile-1'];
    expect(history).toHaveLength(3);
    expect(history[0].timestamp).toBe(1000);
    expect(history[2].timestamp).toBe(3000);
  });

  it('should cap history at 50 entries (oldest dropped)', () => {
    const { appendRunHistory } = useIDEStore.getState();
    // Add 55 entries
    for (let i = 1; i <= 55; i++) {
      appendRunHistory('profile-1', makeEntry(i));
    }
    const history = useIDEStore.getState().runHistory['profile-1'];
    expect(history).toHaveLength(50);
    // Oldest (timestamps 1-5) should be dropped; newest (6-55) remain
    expect(history[0].timestamp).toBe(6);
    expect(history[49].timestamp).toBe(55);
  });

  it('should keep exactly 50 entries when exactly 50 are added', () => {
    const { appendRunHistory } = useIDEStore.getState();
    for (let i = 1; i <= 50; i++) {
      appendRunHistory('profile-1', makeEntry(i));
    }
    expect(useIDEStore.getState().runHistory['profile-1']).toHaveLength(50);
  });

  it('should maintain separate histories per profile', () => {
    const { appendRunHistory } = useIDEStore.getState();
    appendRunHistory('profile-1', makeEntry(100));
    appendRunHistory('profile-2', makeEntry(200));
    expect(useIDEStore.getState().runHistory['profile-1']).toHaveLength(1);
    expect(useIDEStore.getState().runHistory['profile-2']).toHaveLength(1);
    expect(useIDEStore.getState().runHistory['profile-1'][0].timestamp).toBe(100);
    expect(useIDEStore.getState().runHistory['profile-2'][0].timestamp).toBe(200);
  });
});

describe('lifecycleStore - updateWaveform', () => {
  it('should initialize a 12-slot buffer of zeros for a new profile', () => {
    const { updateWaveform } = useIDEStore.getState();
    updateWaveform('profile-1', 5);
    const data = useIDEStore.getState().waveformData['profile-1'];
    expect(data).toHaveLength(12);
  });

  it('should shift the buffer left and append the new entry count', () => {
    const { updateWaveform } = useIDEStore.getState();
    // First call initializes [0,0,0,0,0,0,0,0,0,0,0,0], shifts to [0,0,0,0,0,0,0,0,0,0,0,5]
    updateWaveform('profile-1', 5);
    const data = useIDEStore.getState().waveformData['profile-1'];
    expect(data[11]).toBe(5);
    // Slots 0-10 should all be 0 (original zeros shifted left)
    expect(data.slice(0, 11).every((v) => v === 0)).toBe(true);
  });

  it('should accumulate values across multiple calls', () => {
    const { updateWaveform } = useIDEStore.getState();
    updateWaveform('profile-1', 3);
    updateWaveform('profile-1', 7);
    const data = useIDEStore.getState().waveformData['profile-1'];
    expect(data[11]).toBe(7);
    expect(data[10]).toBe(3);
  });

  it('should maintain buffer length at 12 regardless of calls', () => {
    const { updateWaveform } = useIDEStore.getState();
    for (let i = 0; i < 20; i++) {
      updateWaveform('profile-1', i);
    }
    expect(useIDEStore.getState().waveformData['profile-1']).toHaveLength(12);
  });

  it('should maintain separate waveform buffers per profile', () => {
    const { updateWaveform } = useIDEStore.getState();
    updateWaveform('profile-1', 3);
    updateWaveform('profile-2', 9);
    expect(useIDEStore.getState().waveformData['profile-1'][11]).toBe(3);
    expect(useIDEStore.getState().waveformData['profile-2'][11]).toBe(9);
  });
});

describe('lifecycleStore - hideProfile / unhideProfile', () => {
  it('should add a profile id to hiddenProfileIds', () => {
    const { hideProfile } = useIDEStore.getState();
    hideProfile('profile-1');
    expect(useIDEStore.getState().hiddenProfileIds).toContain('profile-1');
  });

  it('hideProfile is idempotent (duplicate ids are not added)', () => {
    const { hideProfile } = useIDEStore.getState();
    hideProfile('profile-1');
    hideProfile('profile-1');
    expect(useIDEStore.getState().hiddenProfileIds).toHaveLength(1);
  });

  it('should remove a profile id with unhideProfile', () => {
    const { hideProfile, unhideProfile } = useIDEStore.getState();
    hideProfile('profile-1');
    unhideProfile('profile-1');
    expect(useIDEStore.getState().hiddenProfileIds).not.toContain('profile-1');
  });

  it('unhideProfile is a no-op for an absent id', () => {
    const { hideProfile, unhideProfile } = useIDEStore.getState();
    hideProfile('profile-1');
    unhideProfile('profile-99');
    expect(useIDEStore.getState().hiddenProfileIds).toContain('profile-1');
    expect(useIDEStore.getState().hiddenProfileIds).toHaveLength(1);
  });
});

describe('lifecycleStore - focusProfileOutput', () => {
  it('should select the newest retained run instance for the profile', () => {
    useIDEStore.setState({ runInstanceIdsByProfile: { 'profile-1': ['r1'] } });
    const { focusProfileOutput } = useIDEStore.getState();
    focusProfileOutput('profile-1');
    expect(useIDEStore.getState().activeRunOutputId).toBe('r1');
  });

  it('should set activeTerminalTab to "output"', () => {
    const { focusProfileOutput } = useIDEStore.getState();
    focusProfileOutput('profile-1');
    expect(useIDEStore.getState().activeTerminalTab).toBe('output');
  });

  it('should set isBottomPanelCollapsed to false (open the panel)', () => {
    const { focusProfileOutput } = useIDEStore.getState();
    // Start with panel collapsed
    useIDEStore.setState({ isBottomPanelCollapsed: true });
    focusProfileOutput('profile-1');
    expect(useIDEStore.getState().isBottomPanelCollapsed).toBe(false);
  });

  it('should keep panel open when already open', () => {
    const { focusProfileOutput } = useIDEStore.getState();
    useIDEStore.setState({ isBottomPanelCollapsed: false });
    focusProfileOutput('profile-2');
    expect(useIDEStore.getState().isBottomPanelCollapsed).toBe(false);
  });

  // The output dock lives inside the Files column (#271), so focusing a run's
  // output has to reveal that column too, however it came to be hidden.
  it('reveals a preference-collapsed Files column', () => {
    useIDEStore.getState().setFilesPanelCollapsed(true);
    useIDEStore.getState().focusProfileOutput('profile-1');
    expect(useIDEStore.getState()).toMatchObject({
      isFilesPanelCollapsed: false,
      centerReveal: 'files',
      activeTerminalTab: 'output',
      isBottomPanelCollapsed: false,
    });
  });

  it('retargets the transient reveal when Files is only responsively hidden', () => {
    // Saved collapse already false: only the transient target can bring the
    // column back from a window-pressure rail, and a repeat click must repeat it.
    useIDEStore.getState().revealCenterPanel('golem');
    expect(useIDEStore.getState().isFilesPanelCollapsed).toBe(false);

    useIDEStore.getState().focusProfileOutput('profile-1');
    expect(useIDEStore.getState().centerReveal).toBe('files');

    useIDEStore.getState().revealCenterPanel('golem');
    useIDEStore.getState().focusProfileOutput('profile-1');
    expect(useIDEStore.getState().centerReveal).toBe('files');
  });
});

describe('lifecycleStore - stopRequestTimestamps', () => {
  it('setProfileStopping stamps stopRequestTimestamps', () => {
    const before = Date.now();
    const { setProfileStopping } = useIDEStore.getState();
    setProfileStopping('profile-1');
    const ts = useIDEStore.getState().stopRequestTimestamps['profile-1'];
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('setProfileStopping does not overwrite existing timestamp', () => {
    useIDEStore.setState({ stopRequestTimestamps: { 'profile-1': 12345 } });
    const { setProfileStopping } = useIDEStore.getState();
    setProfileStopping('profile-1');
    expect(useIDEStore.getState().stopRequestTimestamps['profile-1']).toBe(12345);
  });

  it('setProfileRestarting stamps stopRequestTimestamps', () => {
    const before = Date.now();
    const { setProfileRestarting } = useIDEStore.getState();
    setProfileRestarting('profile-1');
    const ts = useIDEStore.getState().stopRequestTimestamps['profile-1'];
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('setProfileRestarting does not overwrite existing timestamp', () => {
    useIDEStore.setState({ stopRequestTimestamps: { 'profile-1': 99999 } });
    const { setProfileRestarting } = useIDEStore.getState();
    setProfileRestarting('profile-1');
    expect(useIDEStore.getState().stopRequestTimestamps['profile-1']).toBe(99999);
  });

  it('clearProfileStopping clears stopRequestTimestamps', () => {
    const { setProfileStopping, clearProfileStopping } = useIDEStore.getState();
    setProfileStopping('profile-1');
    clearProfileStopping('profile-1');
    expect(useIDEStore.getState().stopRequestTimestamps['profile-1']).toBeUndefined();
  });

  it('clearProfileRestarting clears stopRequestTimestamps', () => {
    const { setProfileRestarting, clearProfileRestarting } = useIDEStore.getState();
    setProfileRestarting('profile-1');
    clearProfileRestarting('profile-1');
    expect(useIDEStore.getState().stopRequestTimestamps['profile-1']).toBeUndefined();
  });

  it('handleRunStatus with terminal state clears stopRequestTimestamps', () => {
    const { handleRunStatus } = useIDEStore.getState();
    handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 9000,
    });
    useIDEStore.setState({ stopRequestTimestamps: { 'profile-1': 10000 } });
    handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'stopped',
      exitCode: 0,
      timestamp: 11000,
    });
    expect(useIDEStore.getState().stopRequestTimestamps['profile-1']).toBeUndefined();
  });

  it('handleRunStatus with running state clears stopRequestTimestamps (restart)', () => {
    useIDEStore.setState({
      runOutputs: {},
      stopRequestTimestamps: { 'profile-1': 10000 },
    });
    const { handleRunStatus } = useIDEStore.getState();
    handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 11000,
    });
    expect(useIDEStore.getState().stopRequestTimestamps['profile-1']).toBeUndefined();
  });
});

describe('lifecycleStore - run output working directory snapshots', () => {
  const makeProfile = (workingDir: string): RunProfile => ({
    id: 'profile-1',
    name: 'test',
    type: 'single',
    source: 'user',
    command: 'npm test',
    workingDir,
  });

  beforeEach(() => {
    useIDEStore.setState({
      runProfiles: [makeProfile('frontend')],
      runOutputs: {},
      runInstanceIdsByProfile: {},
      latestRunInstanceIdByProfile: {},
      activeRunOutputId: null,
    });
  });

  it('keeps existing output links tied to the working directory from run start', () => {
    const store = useIDEStore.getState();

    store.handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 1000,
    });
    store.appendRunOutput({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      stream: 'stderr',
      data: 'src/App.tsx:7:11\n',
      timestamp: 1001,
    });

    useIDEStore.setState({ runProfiles: [makeProfile('packages/web')] });

    const output = useIDEStore.getState().runOutputs.r1;
    expect(output.workingDir).toBe('frontend');
    expect(output.entries[0].text).toBe('src/App.tsx:7:11');
  });

  it('preserves previous run working directory separately when a profile is rerun', () => {
    const store = useIDEStore.getState();

    store.handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 1000,
    });
    store.appendRunOutput({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      stream: 'stderr',
      data: 'src/old.ts:1:1\n',
      timestamp: 1001,
    });
    store.handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'failed',
      exitCode: 1,
      timestamp: 2000,
    });

    useIDEStore.setState({ runProfiles: [makeProfile('packages/web')] });
    store.handleRunStatus({
      runInstanceId: 'r2',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 3000,
    });

    const outputs = useIDEStore.getState().runOutputs;
    expect(outputs.r2.workingDir).toBe('packages/web');
    expect(outputs.r1.workingDir).toBe('frontend');
    expect(outputs.r1.entries[0].text).toBe('src/old.ts:1:1');
  });

  it('preserves both working directories when rerun output arrives before running status', () => {
    const store = useIDEStore.getState();

    // First run r1 (default profile workingDir 'frontend').
    store.handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 1000,
    });
    store.appendRunOutput({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      stream: 'stderr',
      data: 'src/old.ts:1:1\n',
      timestamp: 1001,
    });
    store.handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'failed',
      exitCode: 1,
      timestamp: 2000,
    });

    // Rerun r2: output arrives BEFORE the running status, so appendRunOutput
    // provisions the retained r2 record with its own working directory.
    useIDEStore.setState({ runProfiles: [makeProfile('packages/web')] });
    store.appendRunOutput({
      runInstanceId: 'r2',
      profileId: 'profile-1',
      stepIdx: 0,
      stream: 'stdout',
      data: 'new line\n',
      timestamp: 2500,
    });
    store.handleRunStatus({
      runInstanceId: 'r2',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 3000,
    });

    const outputs = useIDEStore.getState().runOutputs;
    expect(outputs.r2.workingDir).toBe('packages/web');
    expect(outputs.r2.entries[0].text).toBe('new line');
    expect(outputs.r1.workingDir).toBe('frontend');
    expect(outputs.r1.entries[0].text).toBe('src/old.ts:1:1');
  });

  it('drops stale terminal status after rerun output provisioned a newer buffer', () => {
    const store = useIDEStore.getState();

    store.handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 1000,
    });
    store.appendRunOutput({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      stream: 'stderr',
      data: 'old line\n',
      timestamp: 1001,
    });
    store.handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'failed',
      exitCode: 1,
      timestamp: 2000,
    });

    store.appendRunOutput({
      runInstanceId: 'r2',
      profileId: 'profile-1',
      stepIdx: 0,
      stream: 'stdout',
      data: 'new line\n',
      timestamp: 2500,
    });
    store.handleRunStatus({
      runInstanceId: 'r1',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'failed',
      exitCode: 1,
      timestamp: 2600,
    });

    const outputs = useIDEStore.getState().runOutputs;
    expect(outputs.r2.state).toBe('idle');
    expect(outputs.r2.entries.map((entry) => entry.text)).toEqual(['new line']);
    expect(outputs.r1.state).toBe('failed');
    expect(outputs.r1.entries.map((entry) => entry.text)).toEqual(['old line']);

    store.handleRunStatus({
      runInstanceId: 'r2',
      profileId: 'profile-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 3000,
    });

    const runningOutput = useIDEStore.getState().runOutputs.r2;
    expect(runningOutput.runInstanceId).toBe('r2');
    expect(runningOutput.state).toBe('running');
    expect(runningOutput.entries.map((entry) => entry.text)).toEqual(['new line']);
  });
});

describe('lifecycleStore - resetWorkspaceRunState', () => {
  it('should clear stoppingProfileIds', () => {
    const { setProfileStopping, resetWorkspaceRunState } = useIDEStore.getState();
    setProfileStopping('profile-1');
    resetWorkspaceRunState();
    expect(useIDEStore.getState().stoppingProfileIds).toEqual([]);
  });

  it('should clear restartingProfileIds', () => {
    const { setProfileRestarting, resetWorkspaceRunState } = useIDEStore.getState();
    setProfileRestarting('profile-1');
    resetWorkspaceRunState();
    expect(useIDEStore.getState().restartingProfileIds).toEqual([]);
  });

  it('should clear runHistory', () => {
    const { appendRunHistory, resetWorkspaceRunState } = useIDEStore.getState();
    appendRunHistory('profile-1', { state: 'success', duration: 500, timestamp: 1000 });
    resetWorkspaceRunState();
    expect(useIDEStore.getState().runHistory).toEqual({});
  });

  it('should clear waveformData', () => {
    const { updateWaveform, resetWorkspaceRunState } = useIDEStore.getState();
    updateWaveform('profile-1', 5);
    resetWorkspaceRunState();
    expect(useIDEStore.getState().waveformData).toEqual({});
  });

  it('should preserve hiddenProfileIds until the outgoing workspace is saved', () => {
    const { hideProfile, resetWorkspaceRunState, resetWorkspaceSession } = useIDEStore.getState();
    hideProfile('profile-1');

    // resetWorkspaceRunState runs before the workspace-switch flush captures
    // the outgoing workspace, so it must leave persisted preferences alone.
    resetWorkspaceRunState();
    expect(useIDEStore.getState().hiddenProfileIds).toEqual(['profile-1']);

    // resetWorkspaceSession runs during the incoming workspace's restore,
    // after that snapshot has been taken.
    resetWorkspaceSession();
    expect(useIDEStore.getState().hiddenProfileIds).toEqual([]);
  });

  it('should clear runStartTimestamps', () => {
    useIDEStore.setState({ runStartTimestamps: { 'profile-1': 12345 } });
    const { resetWorkspaceRunState } = useIDEStore.getState();
    resetWorkspaceRunState();
    expect(useIDEStore.getState().runStartTimestamps).toEqual({});
  });

  it('should clear stopRequestTimestamps', () => {
    useIDEStore.setState({ stopRequestTimestamps: { 'profile-1': 12345 } });
    const { resetWorkspaceRunState } = useIDEStore.getState();
    resetWorkspaceRunState();
    expect(useIDEStore.getState().stopRequestTimestamps).toEqual({});
  });
});
