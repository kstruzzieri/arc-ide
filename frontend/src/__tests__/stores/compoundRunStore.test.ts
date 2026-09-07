import { useIDEStore } from '../../stores/ideStore';
import { MAX_OUTPUT_ENTRIES } from '../../types/runOutput';
import type { CompoundRunEvent, OutputChunk, RunStatusEvent } from '../../types/runOutput';

const COMPOUND_ID = 'ci';
const AGG_RID = 'r2';
const STEP0_RID = 'r3';

function makeEvent(overrides: Partial<CompoundRunEvent> = {}): CompoundRunEvent {
  return {
    runInstanceId: AGG_RID,
    compoundId: COMPOUND_ID,
    name: 'CI',
    state: 'running',
    currentStep: 0,
    steps: [
      {
        idx: 0,
        runInstanceId: STEP0_RID,
        profileId: 'build',
        name: 'Build',
        state: 'running',
        exitCode: 0,
        workingDir: 'frontend',
        durationMs: 0,
        startedAt: 1000,
      },
    ],
    ...overrides,
  };
}

function makeChunk(data: string, overrides: Partial<OutputChunk> = {}): OutputChunk {
  return {
    runInstanceId: STEP0_RID,
    profileId: 'build',
    parentRunInstanceId: AGG_RID,
    stepIdx: 0,
    stream: 'stdout',
    data,
    timestamp: 5000,
    ...overrides,
  };
}

function aggregateStatus(
  runInstanceId: string,
  state: RunStatusEvent['state'],
  timestamp: number
): RunStatusEvent {
  return {
    runInstanceId,
    profileId: COMPOUND_ID,
    stepIdx: 0,
    state,
    exitCode: state === 'failed' ? 1 : 0,
    timestamp,
  };
}

function snapshot(
  runInstanceId: string,
  state: 'running' | 'success' | 'failed' | 'stopped' = 'running'
): CompoundRunEvent {
  const terminal = state !== 'running';
  return makeEvent({
    runInstanceId,
    state,
    steps: [
      {
        idx: 0,
        runInstanceId: `${runInstanceId}-step-0`,
        profileId: 'build',
        name: 'Build',
        state,
        exitCode: state === 'failed' ? 1 : 0,
        workingDir: 'frontend',
        durationMs: terminal ? 100 : 0,
        startedAt: 1000,
        endedAt: terminal ? 1100 : undefined,
      },
    ],
  });
}

function deliverCompoundSnapshot(event: CompoundRunEvent, timestamp = 1000): void {
  const store = useIDEStore.getState();
  store.handleRunStatus({
    ...aggregateStatus(event.runInstanceId, event.state, timestamp),
    profileId: event.compoundId,
  });
  store.handleCompoundRun(event);
}

beforeEach(() => {
  // Clear cross-test line assemblers before installing this test's workspace.
  useIDEStore.getState().resetWorkspaceRunState();
  useIDEStore.setState({
    runProfiles: [
      { id: COMPOUND_ID, name: 'CI', type: 'compound', source: 'user', steps: ['build'] },
      { id: 'build', name: 'Build', type: 'single', source: 'user', command: 'echo build' },
    ],
    runCompounds: {},
    runOutputs: {},
    runInstanceIdsByProfile: {},
    latestRunInstanceIdByProfile: {},
    compoundIdByRunInstance: {},
    runHistory: {},
    stoppingProfileIds: [],
    restartingProfileIds: [],
    runStartTimestamps: {},
    stopRequestTimestamps: {},
    activeRunOutputId: null,
    runEventsPaused: false,
  });
});

describe('compoundRunStore - handleCompoundRun', () => {
  it('creates a CompoundRun with step metadata', () => {
    deliverCompoundSnapshot(makeEvent());
    const run = useIDEStore.getState().runCompounds[COMPOUND_ID];
    expect(run).toBeDefined();
    expect(run.name).toBe('CI');
    expect(run.state).toBe('running');
    expect(run.currentStep).toBe(0);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].profileId).toBe('build');
    expect(run.steps[0].state).toBe('running');
    expect(run.stepOutputs).toEqual({});
  });

  it('replaces name/state/currentStep/steps but preserves existing stepOutputs', () => {
    deliverCompoundSnapshot(makeEvent());
    // Route some output into step 0.
    useIDEStore.getState().appendRunOutput(makeChunk('hello\n'));
    const outputsBefore = useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0];
    expect(outputsBefore).toHaveLength(1);

    // Deliver an updated event (e.g. name change / step advanced).
    deliverCompoundSnapshot(
      makeEvent({
        name: 'CI v2',
        currentStep: 1,
        steps: [
          {
            idx: 0,
            runInstanceId: STEP0_RID,
            profileId: 'build',
            name: 'Build',
            state: 'running',
            exitCode: 0,
            workingDir: 'frontend',
            durationMs: 0,
            startedAt: 1000,
          },
        ],
      })
    );

    const run = useIDEStore.getState().runCompounds[COMPOUND_ID];
    expect(run.name).toBe('CI v2');
    expect(run.currentStep).toBe(1);
    expect(run.stepOutputs[0]).toHaveLength(1);
    expect(run.stepOutputs[0][0].text).toBe('hello');
  });
});

describe('compoundRunStore - appendRunOutput routing for composite keys', () => {
  it('routes assembled line into runCompounds stepOutputs without creating runOutputs', () => {
    deliverCompoundSnapshot(makeEvent());
    useIDEStore.getState().appendRunOutput(makeChunk('hello\n'));

    const run = useIDEStore.getState().runCompounds[COMPOUND_ID];
    expect(run.stepOutputs[0]).toBeDefined();
    expect(run.stepOutputs[0]).toHaveLength(1);
    expect(run.stepOutputs[0][0].text).toBe('hello');
    expect(run.stepOutputs[0][0].stream).toBe('stdout');

    // No ordinary RunOutput tab for the step's profile — it routed to the compound.
    expect(useIDEStore.getState().runOutputs['build']).toBeUndefined();
  });

  it('drops orphan composite output when no compound exists', () => {
    useIDEStore.getState().appendRunOutput(makeChunk('orphan\n'));
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID]).toBeUndefined();
    expect(useIDEStore.getState().runOutputs['build']).toBeUndefined();
  });
});

describe('compoundRunStore - terminal step flush', () => {
  it('flushes unterminated content when a step becomes terminal', () => {
    deliverCompoundSnapshot(makeEvent());
    // Chunk WITHOUT a trailing newline — stays in the assembler carry-over.
    useIDEStore.getState().appendRunOutput(makeChunk('partial line'));
    // Not yet emitted as a complete line.
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0]).toBeUndefined();

    // Step transitions to success -> flush.
    deliverCompoundSnapshot(
      makeEvent({
        state: 'success',
        steps: [
          {
            idx: 0,
            runInstanceId: STEP0_RID,
            profileId: 'build',
            name: 'Build',
            state: 'success',
            exitCode: 0,
            workingDir: 'frontend',
            durationMs: 50,
            startedAt: 1000,
            endedAt: 1050,
          },
        ],
      })
    );

    const run = useIDEStore.getState().runCompounds[COMPOUND_ID];
    expect(run.stepOutputs[0]).toHaveLength(1);
    expect(run.stepOutputs[0][0].text).toBe('partial line');
  });
});

describe('compoundRunStore - run history on terminal step', () => {
  it('appends a RunHistoryEntry for a step with startedAt and endedAt', () => {
    deliverCompoundSnapshot(makeEvent());
    deliverCompoundSnapshot(
      makeEvent({
        state: 'success',
        steps: [
          {
            idx: 0,
            runInstanceId: STEP0_RID,
            profileId: 'build',
            name: 'Build',
            state: 'success',
            exitCode: 0,
            workingDir: 'frontend',
            durationMs: 50,
            startedAt: 1000,
            endedAt: 1050,
          },
        ],
      })
    );

    const history = useIDEStore.getState().runHistory['build'];
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe('success');
    expect(history[0].duration).toBe(50);
    expect(history[0].timestamp).toBe(1050);
  });

  it('does not re-append history when the same terminal snapshot is delivered twice', () => {
    deliverCompoundSnapshot(makeEvent());
    const terminalEvent = makeEvent({
      state: 'success',
      steps: [
        {
          idx: 0,
          runInstanceId: STEP0_RID,
          profileId: 'build',
          name: 'Build',
          state: 'success',
          exitCode: 0,
          workingDir: 'frontend',
          durationMs: 50,
          startedAt: 1000,
          endedAt: 1050,
        },
      ],
    });
    deliverCompoundSnapshot(terminalEvent);
    deliverCompoundSnapshot(terminalEvent);
    expect(useIDEStore.getState().runHistory['build']).toHaveLength(1);
  });
});

describe('compoundRunStore - clearRunOutput / clearCompoundRunOutput', () => {
  it('clearRunOutput resolves an aggregate run instance and clears its stepOutputs', () => {
    deliverCompoundSnapshot(makeEvent());
    useIDEStore.getState().appendRunOutput(makeChunk('hello\n'));
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0]).toHaveLength(1);

    useIDEStore.getState().clearRunOutput(AGG_RID);
    const run = useIDEStore.getState().runCompounds[COMPOUND_ID];
    expect(run).toBeDefined();
    expect(run.stepOutputs).toEqual({});

    // Assembler was reset: new output after clear starts fresh.
    useIDEStore.getState().appendRunOutput(makeChunk('again\n'));
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0]).toHaveLength(1);
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0][0].text).toBe('again');
  });

  it('clearCompoundRunOutput clears stepOutputs while keeping the run record', () => {
    deliverCompoundSnapshot(makeEvent());
    useIDEStore.getState().appendRunOutput(makeChunk('hello\n'));
    useIDEStore.getState().clearCompoundRunOutput(COMPOUND_ID);
    const run = useIDEStore.getState().runCompounds[COMPOUND_ID];
    expect(run).toBeDefined();
    expect(run.steps).toHaveLength(1);
    expect(run.stepOutputs).toEqual({});
  });
});

describe('compoundRunStore - resetWorkspaceRunState', () => {
  it('clears runCompounds to {}', () => {
    deliverCompoundSnapshot(makeEvent());
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID]).toBeDefined();
    useIDEStore.getState().resetWorkspaceRunState();
    expect(useIDEStore.getState().runCompounds).toEqual({});
  });
});

describe('compoundRunStore - rerun resets step output', () => {
  it('starts step outputs fresh when a terminal compound runs again', () => {
    // First run: produce output, then go terminal.
    deliverCompoundSnapshot(makeEvent());
    useIDEStore.getState().appendRunOutput(makeChunk('first run\n'));
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0]).toHaveLength(1);
    deliverCompoundSnapshot(
      makeEvent({
        state: 'success',
        steps: [
          {
            idx: 0,
            runInstanceId: STEP0_RID,
            profileId: 'build',
            name: 'Build',
            state: 'success',
            exitCode: 0,
            workingDir: 'frontend',
            durationMs: 1000,
            startedAt: 1000,
            endedAt: 2000,
          },
        ],
      })
    );

    // Second run of the same compound gets a fresh aggregate identity and output.
    const rerun = makeEvent({
      runInstanceId: 'r4',
      steps: [{ ...makeEvent().steps[0], runInstanceId: 'r5' }],
    });
    deliverCompoundSnapshot(rerun, 3000);
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0] ?? []).toHaveLength(0);

    useIDEStore
      .getState()
      .appendRunOutput(
        makeChunk('second run\n', { runInstanceId: 'r5', parentRunInstanceId: 'r4' })
      );
    const outputs = useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0];
    expect(outputs).toHaveLength(1);
    expect(outputs[0].text).toBe('second run');
  });
});

describe('compoundRunStore - clearAllRunOutputs', () => {
  it('preserves a still-running compound so later output is not orphaned', () => {
    deliverCompoundSnapshot(makeEvent());
    useIDEStore.getState().appendRunOutput(makeChunk('before clear\n'));

    useIDEStore.getState().clearAllRunOutputs();

    const run = useIDEStore.getState().runCompounds[COMPOUND_ID];
    expect(run).toBeDefined();
    expect(run.state).toBe('running');
    expect(run.stepOutputs).toEqual({});

    // Composite output produced after the clear must still route into the
    // preserved compound (not be dropped as orphan).
    useIDEStore.getState().appendRunOutput(makeChunk('after clear\n'));
    const outputs = useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0];
    expect(outputs).toHaveLength(1);
    expect(outputs[0].text).toBe('after clear');
  });
});

describe('compoundRunStore - identity routing & stale-event guards', () => {
  it('routes step 0 output by parentRunInstanceId + stepIdx', () => {
    const s = useIDEStore.getState();
    deliverCompoundSnapshot(makeEvent());
    s.appendRunOutput(makeChunk('line\n', { stepIdx: 0 }));
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0]?.[0]?.text).toBe('line');
  });

  it('drops a stale run:output chunk while the buffer is running', () => {
    const s = useIDEStore.getState();
    // Establish a running single-profile buffer at r5.
    s.handleRunStatus({
      runInstanceId: 'r5',
      profileId: 'build',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 1,
    });
    s.appendRunOutput({
      runInstanceId: 'r5',
      profileId: 'build',
      stepIdx: 0,
      stream: 'stdout',
      data: 'fresh\n',
      timestamp: 2,
    });
    // A late chunk from an OLD instance r4 must be dropped.
    s.appendRunOutput({
      runInstanceId: 'r4',
      profileId: 'build',
      stepIdx: 0,
      stream: 'stdout',
      data: 'stale\n',
      timestamp: 3,
    });
    const entries = useIDEStore.getState().runOutputs.r5.entries.map((e) => e.text);
    expect(entries).toEqual(['fresh']);
  });

  it('rotates the buffer when rerun output arrives before its running status', () => {
    const s = useIDEStore.getState();
    // First run completes.
    s.handleRunStatus({
      runInstanceId: 'r5',
      profileId: 'build',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 1,
    });
    s.appendRunOutput({
      runInstanceId: 'r5',
      profileId: 'build',
      stepIdx: 0,
      stream: 'stdout',
      data: 'old\n',
      timestamp: 2,
    });
    s.handleRunStatus({
      runInstanceId: 'r5',
      profileId: 'build',
      stepIdx: 0,
      state: 'success',
      exitCode: 0,
      timestamp: 3,
    });
    // Rerun output (r6) arrives BEFORE its running status → must rotate, not drop.
    s.appendRunOutput({
      runInstanceId: 'r6',
      profileId: 'build',
      stepIdx: 0,
      stream: 'stdout',
      data: 'new\n',
      timestamp: 4,
    });
    const out = useIDEStore.getState().runOutputs.r6;
    expect(out.runInstanceId).toBe('r6');
    expect(out.entries.map((e) => e.text)).toEqual(['new']);
    expect(useIDEStore.getState().runOutputs.r5.entries.map((e) => e.text)).toEqual(['old']);
  });

  it('drops a stale run:status that would flush the active run', () => {
    const s = useIDEStore.getState();
    s.handleRunStatus({
      runInstanceId: 'r7',
      profileId: 'build',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 1,
    });
    s.appendRunOutput({
      runInstanceId: 'r7',
      profileId: 'build',
      stepIdx: 0,
      stream: 'stdout',
      data: 'partial',
      timestamp: 2,
    });
    // A late terminal status from old instance r6 must not flush/alter the r7 run.
    s.handleRunStatus({
      runInstanceId: 'r6',
      profileId: 'build',
      stepIdx: 0,
      state: 'success',
      exitCode: 0,
      timestamp: 3,
    });
    expect(useIDEStore.getState().runOutputs.r7.state).toBe('running');
  });

  it('does not let a stale running compound snapshot replace a rerun', () => {
    deliverCompoundSnapshot(makeEvent({ runInstanceId: 'r10', state: 'running' }), 1000);
    // First run completes, then a newer rerun starts running.
    deliverCompoundSnapshot(makeEvent({ runInstanceId: 'r10', state: 'success' }), 1100);
    deliverCompoundSnapshot(makeEvent({ runInstanceId: 'r12', state: 'running' }), 2000);
    // A late old 'running' snapshot (r10) must be dropped.
    deliverCompoundSnapshot(makeEvent({ runInstanceId: 'r10', state: 'running' }), 1000);
    expect(useIDEStore.getState().runCompounds[COMPOUND_ID].runInstanceId).toBe('r12');
  });
});

describe('compoundRunStore - Phase 2A regressions', () => {
  it('seeds compound state and identity indexes from the initial aggregate running status', () => {
    useIDEStore.getState().handleRunStatus(aggregateStatus('r10', 'running', 1000));

    const state = useIDEStore.getState();
    const compound = state.runCompounds[COMPOUND_ID];
    expect(compound).toBeDefined();
    expect(compound?.compoundId).toBe(COMPOUND_ID);
    expect(compound?.runInstanceId).toBe('r10');
    expect(compound?.state).toBe('running');
    expect(state.compoundIdByRunInstance).toEqual({ r10: COMPOUND_ID });
    expect(state.latestRunInstanceIdByProfile[COMPOUND_ID]).toBe('r10');
  });

  it('captures the aggregate exit code onto the compound run on a terminal status', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.handleRunStatus(aggregateStatus('r10', 'failed', 1100));

    const compound = useIDEStore.getState().runCompounds[COMPOUND_ID];
    expect(compound.state).toBe('failed');
    expect(compound.exitCode).toBe(1);
  });

  it('rejects delayed running status and snapshot after a newer rerun completes', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));
    store.handleCompoundRun(snapshot('r10', 'success'));

    store.handleRunStatus(aggregateStatus('r12', 'running', 2000));
    store.handleCompoundRun(snapshot('r12'));
    store.handleRunStatus(aggregateStatus('r12', 'success', 2100));
    store.handleCompoundRun(snapshot('r12', 'success'));

    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));

    const state = useIDEStore.getState();
    expect(state.runCompounds[COMPOUND_ID].runInstanceId).toBe('r12');
    expect(state.runCompounds[COMPOUND_ID].state).toBe('success');
    expect(state.compoundIdByRunInstance).toEqual({ r12: COMPOUND_ID });
    expect(state.latestRunInstanceIdByProfile[COMPOUND_ID]).toBe('r12');
  });

  it('does not recreate a terminal compound from delayed final events after Clear All', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));
    store.handleCompoundRun(snapshot('r10', 'success'));
    store.clearAllRunOutputs();

    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));
    store.handleCompoundRun(snapshot('r10', 'success'));

    const state = useIDEStore.getState();
    expect(state.runCompounds).toEqual({});
    expect(state.compoundIdByRunInstance).toEqual({});
    expect(state.activeRunOutputId).toBeNull();
  });

  it('accepts a timestamp-newer aggregate rerun from a fully cleared tombstone', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));
    store.handleCompoundRun(snapshot('r10', 'success'));
    store.clearAllRunOutputs();

    store.handleRunStatus(aggregateStatus('r12', 'running', 2000));

    let state = useIDEStore.getState();
    expect(state.runCompounds[COMPOUND_ID]?.runInstanceId).toBe('r12');
    expect(state.runCompounds[COMPOUND_ID]?.steps).toEqual([]);
    expect(state.compoundIdByRunInstance).toEqual({ r12: COMPOUND_ID });
    expect(state.latestRunInstanceIdByProfile[COMPOUND_ID]).toBe('r12');

    store.handleCompoundRun(snapshot('r12'));
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));

    state = useIDEStore.getState();
    expect(state.runCompounds[COMPOUND_ID].runInstanceId).toBe('r12');
    expect(state.runCompounds[COMPOUND_ID].steps).toHaveLength(1);
  });

  it('does not recreate an old compound from StopAll final events after workspace reset', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.resetWorkspaceRunState();

    store.handleRunStatus(aggregateStatus('r10', 'stopped', 1100));
    store.handleCompoundRun(snapshot('r10', 'stopped'));

    const state = useIDEStore.getState();
    expect(state.runCompounds).toEqual({});
    expect(state.compoundIdByRunInstance).toEqual({});
    expect(state.latestRunInstanceIdByProfile[COMPOUND_ID]).toBeUndefined();
  });

  it('clears an ordinary run whose RID equals a compound profile id without clearing the compound', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus(AGG_RID, 'running', 1000));
    store.handleCompoundRun(snapshot(AGG_RID));
    store.appendRunOutput(makeChunk('compound output\n'));
    store.handleRunStatus({
      runInstanceId: COMPOUND_ID,
      profileId: 'build',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 2000,
    });
    store.appendRunOutput({
      runInstanceId: COMPOUND_ID,
      profileId: 'build',
      stepIdx: 0,
      stream: 'stdout',
      data: 'ordinary output\n',
      timestamp: 2001,
    });
    store.handleRunStatus({
      runInstanceId: COMPOUND_ID,
      profileId: 'build',
      stepIdx: 0,
      state: 'success',
      exitCode: 0,
      timestamp: 2002,
    });

    store.clearRunOutput(COMPOUND_ID);

    const state = useIDEStore.getState();
    expect(state.runOutputs[COMPOUND_ID]).toBeUndefined();
    expect(state.runCompounds[COMPOUND_ID].stepOutputs[0]?.map((entry) => entry.text)).toEqual([
      'compound output',
    ]);
  });

  it('does not let a compound snapshot steal an ordinary selection with the same id', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus({
      runInstanceId: COMPOUND_ID,
      profileId: 'build',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 2000,
    });
    store.handleRunStatus({
      runInstanceId: COMPOUND_ID,
      profileId: 'build',
      stepIdx: 0,
      state: 'success',
      exitCode: 0,
      timestamp: 2001,
    });
    store.setActiveRunOutput(COMPOUND_ID);

    store.handleRunStatus(aggregateStatus(AGG_RID, 'running', 3000));
    store.handleCompoundRun(snapshot(AGG_RID));

    expect(useIDEStore.getState().activeRunOutputId).toBe(COMPOUND_ID);
  });

  it('preserves the truncation sentinel when terminal flush exceeds the step cap', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus(AGG_RID, 'running', 1000));
    store.handleCompoundRun(snapshot(AGG_RID));
    store.appendRunOutput(
      makeChunk(
        `${Array.from({ length: MAX_OUTPUT_ENTRIES + 1 }, (_, index) => `line-${index}`).join('\n')}\n`
      )
    );
    store.appendRunOutput(makeChunk('partial terminal line'));

    expect(useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0][0].text).toBe(
      '[truncated — oldest output removed]'
    );

    store.handleRunStatus(aggregateStatus(AGG_RID, 'success', 1100));
    store.handleCompoundRun(snapshot(AGG_RID, 'success'));

    const entries = useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0];
    expect(entries).toHaveLength(MAX_OUTPUT_ENTRIES);
    expect(entries[0].text).toBe('[truncated — oldest output removed]');
    expect(entries.at(-1)?.text).toBe('partial terminal line');
  });

  it('clears pending step carry-over when an authorized aggregate rerun rotates', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.appendRunOutput(
      makeChunk('old partial', {
        runInstanceId: 'r10-step-0',
        parentRunInstanceId: 'r10',
      })
    );
    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));

    store.handleRunStatus(aggregateStatus('r12', 'running', 2000));
    store.handleCompoundRun(snapshot('r12'));
    store.appendRunOutput(
      makeChunk('new line\n', {
        runInstanceId: 'r12-step-0',
        parentRunInstanceId: 'r12',
      })
    );

    expect(
      useIDEStore.getState().runCompounds[COMPOUND_ID].stepOutputs[0]?.map((entry) => entry.text)
    ).toEqual(['new line']);
  });

  it('rejects a mismatched running aggregate status without an ordering timestamp', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));
    store.handleCompoundRun(snapshot('r10', 'success'));

    store.handleRunStatus({
      runInstanceId: 'r12',
      profileId: COMPOUND_ID,
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
    });
    store.handleCompoundRun(snapshot('r12'));

    const state = useIDEStore.getState();
    expect(state.runCompounds[COMPOUND_ID].runInstanceId).toBe('r10');
    expect(state.runCompounds[COMPOUND_ID].state).toBe('success');
    expect(state.latestRunInstanceIdByProfile[COMPOUND_ID]).toBe('r10');
  });

  it('rejects same-RID running status and snapshot after the aggregate is terminal', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));
    store.handleCompoundRun(snapshot('r10', 'success'));

    store.handleRunStatus(aggregateStatus('r10', 'running', 1200));
    store.handleCompoundRun(snapshot('r10'));

    const state = useIDEStore.getState();
    expect(state.runCompounds[COMPOUND_ID].runInstanceId).toBe('r10');
    expect(state.runCompounds[COMPOUND_ID].state).toBe('success');
  });

  it('rejects a compound snapshot whose aggregate state was not authorized by status', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));
    store.handleCompoundRun(snapshot('r10', 'success'));

    store.handleRunStatus(aggregateStatus('r10', 'failed', 1200));
    store.handleCompoundRun(snapshot('r10', 'failed'));

    const state = useIDEStore.getState();
    expect(state.runCompounds[COMPOUND_ID].state).toBe('success');
    expect(state.runHistory[COMPOUND_ID]).toEqual([
      { state: 'success', duration: 100, timestamp: 1100 },
    ]);
  });

  it.each(['success', 'failed', 'stopped'] as const)(
    'does not regress an aggregate %s execution on same-RID idle status',
    (terminalState) => {
      const store = useIDEStore.getState();
      store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
      store.handleCompoundRun(snapshot('r10'));
      store.handleRunStatus(aggregateStatus('r10', terminalState, 1100));
      store.handleCompoundRun(snapshot('r10', terminalState));

      store.handleRunStatus(aggregateStatus('r10', 'idle', 1200));

      expect(useIDEStore.getState().runCompounds[COMPOUND_ID].state).toBe(terminalState);
    }
  );

  it('does not duplicate aggregate history for repeated terminal status', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));
    store.handleCompoundRun(snapshot('r10', 'success'));

    store.handleRunStatus(aggregateStatus('r10', 'success', 1100));
    store.handleCompoundRun(snapshot('r10', 'success'));

    expect(useIDEStore.getState().runHistory[COMPOUND_ID]).toEqual([
      { state: 'success', duration: 100, timestamp: 1100 },
    ]);
  });

  it('rejects old aggregate terminal events after reset removes its profile snapshot', () => {
    const store = useIDEStore.getState();
    store.handleRunStatus(aggregateStatus('r10', 'running', 1000));
    store.handleCompoundRun(snapshot('r10'));
    store.resetWorkspaceRunState();
    useIDEStore.setState({
      runProfiles: [
        { id: 'build', name: 'Build', type: 'single', source: 'user', command: 'echo build' },
      ],
    });

    store.handleRunStatus(aggregateStatus('r10', 'stopped', 1100));
    store.handleCompoundRun(snapshot('r10', 'stopped'));

    const state = useIDEStore.getState();
    expect(state.runOutputs.r10).toBeUndefined();
    expect(state.runCompounds).toEqual({});
    expect(state.compoundIdByRunInstance).toEqual({});
    expect(state.latestRunInstanceIdByProfile[COMPOUND_ID]).toBeUndefined();
  });
});
