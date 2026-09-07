import { act, renderHook, waitFor } from '@testing-library/react';
import { useIDEStore } from '../../stores/ideStore';

const callbacks = new Map<string, (...args: unknown[]) => void>();
jest.mock('../../wails/runtime', () => ({
  EventsOn: jest.fn((event: string, callback: (...args: unknown[]) => void) => {
    callbacks.set(event, callback);
    return jest.fn();
  }),
  WindowSetTitle: jest.fn(),
}));

const historyId = '018f0000-0000-7000-8000-000000000001';
const mockAppendRunHistoryRecord = jest.fn<Promise<unknown>, [unknown]>(() =>
  Promise.resolve({
    historyId,
    kind: 'ordinary',
    profileId: 'build',
    profileName: 'Build',
    state: 'stopped',
    startedAt: 100,
    completedAt: 200,
    outputAvailable: true,
  })
);
const mockLoadRunProfiles = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockClearAllRunHistory = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockGetRunProfilesSnapshot = jest.fn(() =>
  Promise.resolve({
    profiles: [
      {
        id: 'build',
        name: 'Build',
        type: 'single',
        source: 'user',
        command: 'go build ./...',
      },
    ],
    profileState: {},
    workspaceEpoch: 8,
  })
);
const mockGetRunHistorySnapshot = jest.fn(() => Promise.resolve({ version: 1, summaries: [] }));
jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    AppendRunHistoryRecord: (record: unknown) => mockAppendRunHistoryRecord(record),
    ClearAllRunHistory: () => mockClearAllRunHistory(),
    LoadRunProfiles: (path: string) => mockLoadRunProfiles(path),
    GetRunProfilesSnapshot: () => mockGetRunProfilesSnapshot(),
    GetRunHistorySnapshot: () => mockGetRunHistorySnapshot(),
  };
});

import * as runOutputModule from '../../hooks/useRunOutput';
import { useRunOutputListener } from '../../hooks/useRunOutput';
import { useRunProfilesLoader } from '../../hooks/useRunProfiles';
import { openWorkspaceByPath } from '../../utils/workspace';

type Phase2CHistoryState = ReturnType<typeof useIDEStore.getState> & {
  runHistoryRecords: Record<string, unknown>;
  runHistorySummaries: Record<string, { outputAvailable: boolean }>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const status = (runInstanceId: string, state: 'running' | 'success' | 'stopped', reason = '') => ({
  runInstanceId,
  profileId: 'build',
  stepIdx: 0,
  launchSeq: runInstanceId === 'r1' ? 1 : 2,
  workspaceEpoch: 7,
  state,
  exitCode: state === 'success' ? 0 : 130,
  timestamp: state === 'running' ? 100 : 200,
  reason,
});

const output = (runInstanceId: string) => ({
  runInstanceId,
  profileId: 'build',
  stepIdx: 0,
  launchSeq: runInstanceId === 'r1' ? 1 : 2,
  workspaceEpoch: 7,
  stream: 'stdout',
  data: 'hello\n',
  timestamp: 150,
});

beforeEach(() => {
  jest.clearAllMocks();
  callbacks.clear();
  mockAppendRunHistoryRecord.mockResolvedValue({
    historyId,
    kind: 'ordinary',
    profileId: 'build',
    profileName: 'Build',
    state: 'stopped',
    startedAt: 100,
    completedAt: 200,
    outputAvailable: true,
  });
  mockLoadRunProfiles.mockResolvedValue(undefined);
  mockClearAllRunHistory.mockResolvedValue(undefined);
  mockGetRunProfilesSnapshot.mockResolvedValue({
    profiles: [
      {
        id: 'build',
        name: 'Build',
        type: 'single',
        source: 'user',
        command: 'go build ./...',
      },
    ],
    profileState: {},
    workspaceEpoch: 8,
  });
  mockGetRunHistorySnapshot.mockResolvedValue({ version: 1, summaries: [] });
  useIDEStore.setState({
    ...useIDEStore.getInitialState(),
    workspace: { name: 'Repo', path: '/repo' },
    runProfiles: [
      {
        id: 'build',
        name: 'Build',
        type: 'single',
        source: 'user',
        command: 'go build ./...',
      },
    ],
    workspaceEpoch: 7,
    runEventsPaused: false,
  });
});

it('persists an empty-reason user stop without durable runtime identity', async () => {
  const { unmount } = renderHook(() => useRunOutputListener());
  act(() => {
    callbacks.get('run:status')?.(status('r1', 'running'));
    callbacks.get('run:output')?.(output('r1'));
    callbacks.get('run:status')?.(status('r1', 'stopped'));
  });

  await waitFor(() => expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1));
  const payload = mockAppendRunHistoryRecord.mock.calls[0][0] as Record<string, unknown>;
  expect(payload).toMatchObject({
    kind: 'ordinary',
    profileId: 'build',
    profileName: 'Build',
    state: 'stopped',
    startedAt: 100,
    completedAt: 200,
    workspaceEpoch: 7,
    workingDir: '/repo',
    entries: [{ stream: 'stdout', text: 'hello', timestamp: 150 }],
  });
  expect(payload).not.toHaveProperty('runInstanceId');
  expect(payload).not.toHaveProperty('launchSeq');

  await waitFor(() => {
    const state = useIDEStore.getState() as unknown as Phase2CHistoryState;
    expect(Object.keys(state.runHistoryRecords)).toEqual([historyId]);
    expect(state.runHistoryRecords).not.toHaveProperty(`history:${historyId}`);
  });
  expect(useIDEStore.getState().runHistory.build).toHaveLength(1);
  unmount();
});

it.each(['workspace-switch', 'shutdown'])(
  'does not persist an administratively stopped run with reason %s',
  async (reason) => {
    const { unmount } = renderHook(() => useRunOutputListener());
    act(() => {
      callbacks.get('run:status')?.(status('r1', 'running'));
      callbacks.get('run:output')?.(output('r1'));
      callbacks.get('run:status')?.(status('r1', 'stopped'));
    });
    await waitFor(() => expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1));

    act(() => {
      callbacks.get('run:status')?.(status('r2', 'running'));
      callbacks.get('run:output')?.(output('r2'));
      callbacks.get('run:status')?.(status('r2', 'stopped', reason));
    });
    await act(async () => {
      await runOutputModule.drainRunHistoryQueue();
    });

    expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1);
    unmount();
  }
);

it('persists compound aggregate and step summaries without rich payload', async () => {
  const aggregateProfileId = `ci-${'界'.repeat(2_000)}`;
  const aggregateProfileName = `CI ${'界'.repeat(2_000)}`;
  const stepProfileId = `build-${'界'.repeat(2_000)}`;
  const stepProfileName = `Build ${'界'.repeat(2_000)}`;
  const setState = useIDEStore.setState as unknown as (patch: Record<string, unknown>) => void;
  setState({
    runProfiles: [
      {
        id: aggregateProfileId,
        name: aggregateProfileName,
        type: 'compound',
        source: 'user',
        steps: [stepProfileId],
      },
      {
        id: stepProfileId,
        name: stepProfileName,
        type: 'single',
        source: 'user',
        command: 'go build ./...',
      },
    ],
  });
  const { unmount } = renderHook(() => useRunOutputListener());

  act(() => {
    callbacks.get('run:status')?.({
      runInstanceId: 'aggregate',
      profileId: aggregateProfileId,
      stepIdx: 0,
      launchSeq: 3,
      workspaceEpoch: 7,
      state: 'running',
      exitCode: 0,
      timestamp: 100,
      reason: '',
    });
    callbacks.get('run:compound')?.({
      runInstanceId: 'aggregate',
      compoundId: aggregateProfileId,
      name: aggregateProfileName,
      state: 'running',
      currentStep: 0,
      launchSeq: 3,
      workspaceEpoch: 7,
      steps: [
        {
          idx: 0,
          runInstanceId: 'step-r1',
          parentRunInstanceId: 'aggregate',
          profileId: stepProfileId,
          name: stepProfileName,
          state: 'running',
          exitCode: 0,
          workingDir: '/repo',
          durationMs: 0,
          startedAt: 110,
          workspaceEpoch: 7,
          launchSeq: 0,
        },
      ],
    });
    callbacks.get('run:output')?.({
      runInstanceId: 'step-r1',
      parentRunInstanceId: 'aggregate',
      profileId: stepProfileId,
      stepIdx: 0,
      launchSeq: 0,
      workspaceEpoch: 7,
      stream: 'stdout',
      data: 'must stay session-only\n',
      timestamp: 120,
    });
    callbacks.get('run:compound')?.({
      runInstanceId: 'aggregate',
      compoundId: aggregateProfileId,
      name: aggregateProfileName,
      state: 'success',
      currentStep: 1,
      launchSeq: 3,
      workspaceEpoch: 7,
      steps: [
        {
          idx: 0,
          runInstanceId: 'step-r1',
          parentRunInstanceId: 'aggregate',
          profileId: stepProfileId,
          name: stepProfileName,
          state: 'success',
          exitCode: 0,
          workingDir: '/repo',
          durationMs: 40,
          startedAt: 110,
          endedAt: 150,
          workspaceEpoch: 7,
          launchSeq: 0,
        },
      ],
    });
    callbacks.get('run:status')?.({
      runInstanceId: 'aggregate',
      profileId: aggregateProfileId,
      stepIdx: 0,
      launchSeq: 3,
      workspaceEpoch: 7,
      state: 'success',
      exitCode: 0,
      timestamp: 160,
      reason: '',
    });
  });

  await waitFor(() => expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(2));
  const payloads = mockAppendRunHistoryRecord.mock.calls.map(
    ([payload]) => payload as Record<string, unknown>
  );
  expect(payloads.map((payload) => payload.kind).sort()).toEqual([
    'compound-aggregate',
    'compound-step',
  ]);
  for (const payload of payloads) {
    expect(payload.workspaceEpoch).toBe(7);
    expect(payload).not.toHaveProperty('entries');
    expect(payload).not.toHaveProperty('workingDir');
    expect(new TextEncoder().encode(String(payload.profileId)).byteLength).toBeLessThanOrEqual(
      4 << 10
    );
    expect(new TextEncoder().encode(String(payload.profileName)).byteLength).toBeLessThanOrEqual(
      4 << 10
    );
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThan(12 << 10);
  }
  expect(useIDEStore.getState().runProfiles.map((profile) => profile.id)).toEqual([
    aggregateProfileId,
    stepProfileId,
  ]);
  unmount();
});

it('detaches a timed-out generation so the next workspace can persist without releasing it', async () => {
  jest.useFakeTimers();
  let releaseOld: () => void = () => {};
  try {
    mockAppendRunHistoryRecord
      .mockImplementationOnce(
        () =>
          new Promise<unknown>((resolve) => {
            releaseOld = () =>
              resolve({
                historyId: '018f0000-0000-7000-8000-000000000010',
                kind: 'ordinary',
                profileId: 'build',
                profileName: 'Build',
                state: 'success',
                startedAt: 100,
                completedAt: 200,
                outputAvailable: true,
              });
          })
      )
      .mockResolvedValueOnce({
        historyId: '018f0000-0000-7000-8000-000000000020',
        kind: 'ordinary',
        profileId: 'build',
        profileName: 'Build',
        state: 'success',
        startedAt: 300,
        completedAt: 400,
        outputAvailable: true,
      });
    const enqueue = runOutputModule.enqueueRunHistoryRecord as unknown as (
      record: Record<string, unknown>
    ) => void;
    const record = {
      kind: 'ordinary',
      profileId: 'build',
      profileName: 'Build',
      state: 'success',
      exitCode: 0,
      startedAt: 100,
      completedAt: 200,
      workingDir: '/repo',
      entries: [],
    };

    enqueue(record);
    enqueue({ ...record, completedAt: 250 });
    await Promise.resolve();
    expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1);

    const draining = runOutputModule.drainRunHistoryQueue();
    jest.advanceTimersByTime(300);
    await draining;

    useIDEStore.setState({
      workspace: { name: 'Other', path: '/other' },
      workspaceEpoch: 8,
    });
    enqueue({ ...record, startedAt: 300, completedAt: 400, workingDir: '/other' });
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(2);
    expect(
      (mockAppendRunHistoryRecord.mock.calls[1][0] as { completedAt: number }).completedAt
    ).toBe(400);
    expect(useIDEStore.getState().runHistoryRecords).toHaveProperty(
      '018f0000-0000-7000-8000-000000000020'
    );

    releaseOld();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(2);
    expect(useIDEStore.getState().runHistoryRecords).not.toHaveProperty(
      '018f0000-0000-7000-8000-000000000010'
    );
  } finally {
    releaseOld();
    await runOutputModule.drainRunHistoryQueue();
    jest.useRealTimers();
  }
});

it('pauses the real open flow before ownership changes and drains accepted work before load', async () => {
  let releaseAppend: () => void = () => {};
  mockAppendRunHistoryRecord.mockImplementationOnce(
    () =>
      new Promise<unknown>((resolve) => {
        releaseAppend = () =>
          resolve({
            historyId,
            kind: 'ordinary',
            profileId: 'build',
            profileName: 'Build',
            state: 'success',
            startedAt: 100,
            completedAt: 200,
            outputAvailable: true,
          });
      })
  );
  const { unmount: unmountOutput } = renderHook(() => useRunOutputListener());
  let unmountProfiles: (() => void) | undefined;
  try {
    act(() => {
      callbacks.get('run:status')?.(status('r1', 'running'));
      callbacks.get('run:status')?.(status('r1', 'success'));
      openWorkspaceByPath('/other');
      callbacks.get('run:status')?.({
        ...status('gap', 'running'),
        workspaceEpoch: 8,
      });
    });

    expect(useIDEStore.getState().runEventsPaused).toBe(true);
    expect(useIDEStore.getState().runOutputs).not.toHaveProperty('gap');

    ({ unmount: unmountProfiles } = renderHook(() => useRunProfilesLoader('/other')));
    await waitFor(() => expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1));
    expect(mockLoadRunProfiles).not.toHaveBeenCalled();

    releaseAppend();
    await waitFor(() => expect(mockLoadRunProfiles).toHaveBeenCalledWith('/other'));
    expect(mockAppendRunHistoryRecord.mock.invocationCallOrder[0]).toBeLessThan(
      mockLoadRunProfiles.mock.invocationCallOrder[0]
    );
  } finally {
    releaseAppend();
    unmountProfiles?.();
    unmountOutput();
    await runOutputModule.drainRunHistoryQueue();
  }
});

it('bounds live summary metadata at 50 and rich ordinary cache at five', async () => {
  mockAppendRunHistoryRecord.mockImplementation(async (value) => {
    const record = value as { completedAt: number };
    return {
      historyId: `00000000-0000-7000-8000-${String(record.completedAt).padStart(12, '0')}`,
      kind: 'ordinary',
      profileId: 'build',
      profileName: 'Build',
      state: 'success',
      startedAt: record.completedAt - 10,
      completedAt: record.completedAt,
      outputAvailable: true,
    };
  });
  const enqueue = runOutputModule.enqueueRunHistoryRecord as unknown as (
    record: Record<string, unknown>
  ) => void;
  for (let completedAt = 1; completedAt <= 55; completedAt++) {
    enqueue({
      kind: 'ordinary',
      profileId: 'build',
      profileName: 'Build',
      state: 'success',
      exitCode: 0,
      startedAt: completedAt - 1,
      completedAt,
      entries: [],
    });
  }

  await runOutputModule.drainRunHistoryQueue();

  const state = useIDEStore.getState() as unknown as Phase2CHistoryState;
  expect(Object.keys(state.runHistorySummaries)).toHaveLength(50);
  expect(Object.keys(state.runHistoryRecords)).toHaveLength(5);
  expect(state.runHistorySummaries).not.toHaveProperty('00000000-0000-7000-8000-000000000001');
  expect(state.runHistoryRecords).not.toHaveProperty('00000000-0000-7000-8000-000000000050');
});

it('drops paused compound terminal snapshots before a reused run ID is admitted', async () => {
  useIDEStore.setState({
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
    ],
  });
  const { unmount } = renderHook(() => useRunOutputListener());
  act(() => {
    callbacks.get('run:status')?.({
      runInstanceId: 'reused',
      profileId: 'ci',
      launchSeq: 1,
      workspaceEpoch: 7,
      state: 'running',
      exitCode: 0,
      timestamp: 100,
    });
    useIDEStore.getState().pauseRunEvents();
    callbacks.get('run:compound')?.({
      runInstanceId: 'reused',
      compoundId: 'ci',
      name: 'Old CI',
      state: 'success',
      currentStep: 1,
      launchSeq: 1,
      steps: [
        {
          idx: 0,
          runInstanceId: 'old-step',
          parentRunInstanceId: 'reused',
          profileId: 'build',
          name: 'Old Build',
          state: 'success',
          exitCode: 0,
          durationMs: 50,
          startedAt: 100,
          endedAt: 150,
          launchSeq: 0,
        },
      ],
    });
    useIDEStore.getState().resetWorkspaceRunState();
    useIDEStore.setState({
      workspace: { name: 'Other', path: '/other' },
      workspaceEpoch: 8,
      runEventsPaused: false,
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
      ],
    });
    callbacks.get('run:status')?.({
      runInstanceId: 'reused',
      profileId: 'ci',
      launchSeq: 1,
      workspaceEpoch: 8,
      state: 'running',
      exitCode: 0,
      timestamp: 200,
    });
    callbacks.get('run:status')?.({
      runInstanceId: 'reused',
      profileId: 'ci',
      launchSeq: 1,
      workspaceEpoch: 8,
      state: 'success',
      exitCode: 0,
      timestamp: 250,
    });
  });

  await runOutputModule.drainRunHistoryQueue();
  expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1);
  expect(mockAppendRunHistoryRecord.mock.calls[0][0]).toMatchObject({
    kind: 'compound-aggregate',
    profileName: 'CI',
  });
  unmount();
});

it('serializes history appends and drains rejection plus a stalled tail within 300ms', async () => {
  jest.useFakeTimers();
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const module = runOutputModule as unknown as Record<string, unknown>;
    expect(typeof module.enqueueRunHistoryRecord).toBe('function');
    expect(typeof module.drainRunHistoryQueue).toBe('function');
    const enqueue = module.enqueueRunHistoryRecord as (record: Record<string, unknown>) => void;
    const drain = module.drainRunHistoryQueue as () => Promise<void>;
    const record = {
      kind: 'ordinary',
      profileId: 'build',
      profileName: 'Build',
      state: 'success',
      exitCode: 0,
      startedAt: 100,
      completedAt: 200,
      workingDir: '/repo',
      entries: [],
    };
    let releaseFirst: () => void = () => {};
    mockAppendRunHistoryRecord
      .mockImplementationOnce(
        () =>
          new Promise<unknown>((resolve) => {
            releaseFirst = () => resolve({});
          })
      )
      .mockRejectedValueOnce(new Error('history disk full'))
      .mockImplementationOnce(() => new Promise<unknown>(() => {}));

    enqueue(record);
    enqueue({ ...record, completedAt: 300 });
    enqueue({ ...record, completedAt: 400 });
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
    expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1);

    releaseFirst();
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
    expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(3);
    expect(
      mockAppendRunHistoryRecord.mock.calls.map(
        ([payload]) => (payload as { completedAt: number }).completedAt
      )
    ).toEqual([200, 300, 400]);

    const draining = drain();
    jest.advanceTimersByTime(300);
    await expect(draining).resolves.toBeUndefined();
  } finally {
    consoleError.mockRestore();
    jest.useRealTimers();
  }
});

it('toasts a current append failure and keeps the queue available for the next record', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockAppendRunHistoryRecord.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce({
    historyId,
    kind: 'ordinary',
    profileId: 'build',
    profileName: 'Build',
    state: 'success',
    startedAt: 100,
    completedAt: 300,
    outputAvailable: true,
  });
  const record = {
    kind: 'ordinary',
    profileId: 'build',
    profileName: 'Build',
    state: 'success',
    exitCode: 0,
    startedAt: 100,
    completedAt: 200,
    workspaceEpoch: 7,
    entries: [],
  };

  try {
    runOutputModule.enqueueRunHistoryRecord(record as never);
    runOutputModule.enqueueRunHistoryRecord({ ...record, completedAt: 300 } as never);
    await runOutputModule.drainRunHistoryQueue();

    expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(2);
    expect(useIDEStore.getState().toast).toEqual({
      message: 'Run history could not be saved: disk full',
      type: 'error',
    });
  } finally {
    consoleError.mockRestore();
  }
});

it('does not toast when an append failure belongs to an old workspace', async () => {
  const pending = deferred<unknown>();
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockAppendRunHistoryRecord.mockReturnValueOnce(pending.promise);
  const record = {
    kind: 'ordinary',
    profileId: 'build',
    profileName: 'Build',
    state: 'success',
    exitCode: 0,
    startedAt: 100,
    completedAt: 200,
    workspaceEpoch: 7,
    entries: [],
  };

  try {
    runOutputModule.enqueueRunHistoryRecord(record as never);
    await waitFor(() => expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1));
    act(() => {
      useIDEStore.setState({
        workspace: { name: 'Other', path: '/other' },
        workspaceEpoch: 8,
        toast: null,
      });
    });
    pending.reject(new Error('old disk full'));
    await runOutputModule.drainRunHistoryQueue();

    expect(useIDEStore.getState().toast).toBeNull();
  } finally {
    consoleError.mockRestore();
  }
});

it('bounds the persisted rich payload without truncating the live output line', async () => {
  const hugeLine = '界'.repeat(3_600_000);
  const entries = [
    ...Array.from({ length: 10_000 }, (_, index) => ({
      stream: 'stdout' as const,
      text: `line ${index}`,
      timestamp: index + 1,
    })),
    { stream: 'stdout' as const, text: hugeLine, timestamp: 20_000 },
  ];
  useIDEStore.setState({
    runOutputs: {
      r1: {
        runInstanceId: 'r1',
        profileId: 'build',
        launchSeq: 1,
        workspaceEpoch: 7,
        workingDir: '/repo',
        state: 'running',
        exitCode: 0,
        entries,
      },
    },
    runInstanceIdsByProfile: { build: ['r1'] },
    latestRunInstanceIdByProfile: { build: 'r1' },
    runLaunchSeqByInstance: { r1: 1 },
    runStartTimestamps: { r1: 100 },
  });
  const { unmount } = renderHook(() => useRunOutputListener());

  act(() => {
    callbacks.get('run:status')?.(status('r1', 'success'));
  });
  await waitFor(() => expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1));

  const payload = mockAppendRunHistoryRecord.mock.calls[0][0] as {
    entries: Array<{ text: string }>;
  };
  expect(payload.entries.length).toBeLessThanOrEqual(10_000);
  expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(
    10 << 20
  );
  expect(
    useIDEStore.getState().runOutputs.r1.entries.some((entry) => entry.text === hugeLine)
  ).toBe(true);
  unmount();
});

it('orders Clear All after accepted appends and lets later appends continue after rejection', async () => {
  const firstAppend = deferred<unknown>();
  const order: string[] = [];
  mockAppendRunHistoryRecord
    .mockImplementationOnce(() => {
      order.push('append-1');
      return firstAppend.promise;
    })
    .mockImplementationOnce(async () => {
      order.push('append-2');
      return {};
    });
  mockClearAllRunHistory.mockImplementationOnce(async () => {
    order.push('clear');
    throw new Error('clear failed');
  });
  const module = runOutputModule as unknown as Record<string, unknown>;
  expect(typeof module.enqueueClearAllRunHistory).toBe('function');
  const enqueueClear = module.enqueueClearAllRunHistory as () => Promise<void>;
  const enqueue = runOutputModule.enqueueRunHistoryRecord as unknown as (
    record: Record<string, unknown>
  ) => void;
  const record = {
    kind: 'ordinary',
    profileId: 'build',
    profileName: 'Build',
    state: 'success',
    exitCode: 0,
    startedAt: 100,
    completedAt: 200,
    entries: [],
  };

  enqueue(record);
  await Promise.resolve();
  const clearing = enqueueClear();
  enqueue({ ...record, completedAt: 300 });
  expect(order).toEqual(['append-1']);
  expect(mockClearAllRunHistory).not.toHaveBeenCalled();

  firstAppend.resolve({});
  await expect(clearing).rejects.toThrow('clear failed');
  await runOutputModule.drainRunHistoryQueue();

  expect(order).toEqual(['append-1', 'clear', 'append-2']);
  expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(2);
});

it('marks the persisted record when the budget drops output, and leaves a fitting run unmarked', async () => {
  const hugeLine = '界'.repeat(3_600_000);
  const baseOutput = {
    runInstanceId: 'r1',
    profileId: 'build',
    launchSeq: 1,
    workspaceEpoch: 7,
    workingDir: '/repo',
    state: 'running' as const,
    exitCode: 0,
  };
  const index = {
    runInstanceIdsByProfile: { build: ['r1'] },
    latestRunInstanceIdByProfile: { build: 'r1' },
    runLaunchSeqByInstance: { r1: 1 },
    runStartTimestamps: { r1: 100 },
  };

  useIDEStore.setState({
    runOutputs: {
      r1: { ...baseOutput, entries: [{ stream: 'stdout', text: hugeLine, timestamp: 1 }] },
    },
    ...index,
  });
  let hook = renderHook(() => useRunOutputListener());
  act(() => {
    callbacks.get('run:status')?.(status('r1', 'success'));
  });
  await waitFor(() => expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1));
  expect((mockAppendRunHistoryRecord.mock.calls[0][0] as { truncated?: boolean }).truncated).toBe(
    true
  );
  hook.unmount();

  mockAppendRunHistoryRecord.mockClear();
  useIDEStore.setState({
    runOutputs: {
      r1: { ...baseOutput, entries: [{ stream: 'stdout', text: 'short', timestamp: 1 }] },
    },
    ...index,
  });
  hook = renderHook(() => useRunOutputListener());
  act(() => {
    callbacks.get('run:status')?.(status('r1', 'success'));
  });
  await waitFor(() => expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1));
  expect((mockAppendRunHistoryRecord.mock.calls[0][0] as { truncated?: boolean }).truncated).toBe(
    false
  );
  hook.unmount();
});

it('carries a live-capped buffer through as truncated even when the record fits', async () => {
  useIDEStore.setState({
    runOutputs: {
      r1: {
        runInstanceId: 'r1',
        profileId: 'build',
        launchSeq: 1,
        workspaceEpoch: 7,
        workingDir: '/repo',
        state: 'running',
        exitCode: 0,
        entries: [{ stream: 'stdout', text: 'tail', timestamp: 1 }],
        // The live buffer already dropped older entries at MAX_OUTPUT_ENTRIES.
        truncated: true,
      },
    },
    runInstanceIdsByProfile: { build: ['r1'] },
    latestRunInstanceIdByProfile: { build: 'r1' },
    runLaunchSeqByInstance: { r1: 1 },
    runStartTimestamps: { r1: 100 },
  });
  const { unmount } = renderHook(() => useRunOutputListener());
  act(() => {
    callbacks.get('run:status')?.(status('r1', 'success'));
  });
  await waitFor(() => expect(mockAppendRunHistoryRecord).toHaveBeenCalledTimes(1));
  expect((mockAppendRunHistoryRecord.mock.calls[0][0] as { truncated?: boolean }).truncated).toBe(
    true
  );
  unmount();
});
