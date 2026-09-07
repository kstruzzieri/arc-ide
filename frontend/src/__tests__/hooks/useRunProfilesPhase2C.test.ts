import { act, renderHook, waitFor } from '@testing-library/react';
import { runhistory } from '../../wails/bindings';
import { useIDEStore } from '../../stores/ideStore';

const mockDrainRunHistoryQueue = jest.fn<Promise<void>, []>(() => Promise.resolve());
jest.mock('../../hooks/useRunOutput', () => ({
  ...jest.requireActual('../../hooks/useRunOutput'),
  drainRunHistoryQueue: () => mockDrainRunHistoryQueue(),
}));

const mockLoadRunProfiles = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockGetRunProfilesSnapshot = jest.fn<Promise<unknown>, []>(() =>
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
    workspaceEpoch: 7,
  })
);
const mockGetRunHistorySnapshot = jest.fn<Promise<unknown>, []>(() =>
  Promise.resolve({ version: 1, summaries: [] })
);

jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    LoadRunProfiles: (path: string) => mockLoadRunProfiles(path),
    GetRunProfilesSnapshot: () => mockGetRunProfilesSnapshot(),
    GetRunHistorySnapshot: () => mockGetRunHistorySnapshot(),
  };
});

let runprofilesChanged: ((snapshot: unknown) => void) | null = null;
jest.mock('../../wails/runtime', () => ({
  EventsOn: jest.fn((event: string, callback: (snapshot: unknown) => void) => {
    if (event === 'runprofiles:changed') {
      runprofilesChanged = callback;
    }
    return jest.fn();
  }),
}));

import { useRunProfilesLoader } from '../../hooks/useRunProfiles';

type Phase2CHistoryState = ReturnType<typeof useIDEStore.getState> & {
  runHistoryRecords: Record<string, unknown>;
  runHistorySummaries: Record<string, { outputAvailable: boolean }>;
};

const historyState = (): Phase2CHistoryState =>
  useIDEStore.getState() as unknown as Phase2CHistoryState;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  runprofilesChanged = null;
  mockDrainRunHistoryQueue.mockResolvedValue(undefined);
  mockLoadRunProfiles.mockResolvedValue(undefined);
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
    workspaceEpoch: 7,
  });
  mockGetRunHistorySnapshot.mockResolvedValue({ version: 1, summaries: [] });
  useIDEStore.setState({
    ...useIDEStore.getInitialState(),
    workspace: { name: 'Repo', path: '/repo' },
  });
});

it('drains accepted history writes before switching backend profile ownership', async () => {
  let releaseDrain: () => void = () => {};
  mockDrainRunHistoryQueue.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseDrain = resolve;
      })
  );

  renderHook(() => useRunProfilesLoader('/repo'));
  await act(async () => {
    await Promise.resolve();
  });

  expect(mockDrainRunHistoryQueue).toHaveBeenCalledTimes(1);
  expect(mockLoadRunProfiles).not.toHaveBeenCalled();

  await act(async () => {
    releaseDrain();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockLoadRunProfiles).toHaveBeenCalledWith('/repo');
  expect(mockDrainRunHistoryQueue.mock.invocationCallOrder[0]).toBeLessThan(
    mockLoadRunProfiles.mock.invocationCallOrder[0]
  );
});

it.each(['resolve', 'reject'] as const)(
  'waits for a pending destructive history clear to %s before loading the next workspace',
  async (outcome) => {
    const lifecycle = jest.requireActual('../../hooks/useRunOutput') as {
      trackRunHistoryClear?: <T>(promise: Promise<T>) => Promise<T>;
    };
    expect(typeof lifecycle.trackRunHistoryClear).toBe('function');
    const pending = deferred<void>();
    const operation =
      outcome === 'reject'
        ? pending.promise.catch((err: unknown) => {
            useIDEStore
              .getState()
              .showToast(
                `Failed to clear output: ${err instanceof Error ? err.message : String(err)}`,
                'error'
              );
          })
        : pending.promise;
    lifecycle.trackRunHistoryClear?.(operation);

    renderHook(() => useRunProfilesLoader('/other'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockLoadRunProfiles).not.toHaveBeenCalled();

    await act(async () => {
      if (outcome === 'resolve') pending.resolve();
      else pending.reject(new Error('clear failed'));
      await operation;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockLoadRunProfiles).toHaveBeenCalledWith('/other');
    if (outcome === 'reject') {
      expect(useIDEStore.getState().toast?.message).toContain('clear failed');
    }
  }
);

it('hydrates lazy archive summaries into capped completion history without touching live RID maps', async () => {
  const summaries = Array.from({ length: 52 }, (_, index) => ({
    historyId: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    kind:
      index === 10
        ? runhistory.RecordKind.RecordKindCompoundStep
        : runhistory.RecordKind.RecordKindOrdinary,
    profileId: 'build',
    profileName: 'Build',
    state: index % 2 === 0 ? 'success' : 'failed',
    exitCode: index % 2 === 0 ? 0 : 1,
    startedAt: index * 100,
    completedAt: index * 100 + 25,
    outputAvailable: index >= 46 && index !== 50,
  })).reverse();
  mockGetRunHistorySnapshot.mockResolvedValueOnce({ version: 1, summaries });
  const originalApply = useIDEStore.getState().setRunProfilesSnapshot;
  const atomicApply = jest.fn((...args: unknown[]) =>
    (originalApply as unknown as (...values: unknown[]) => void)(...args)
  );
  const setState = useIDEStore.setState as unknown as (patch: Record<string, unknown>) => void;
  setState({ setRunProfilesSnapshot: atomicApply });

  renderHook(() => useRunProfilesLoader('/repo'));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockGetRunHistorySnapshot).toHaveBeenCalledTimes(1);
  expect(atomicApply).toHaveBeenCalledTimes(1);
  expect(atomicApply.mock.calls[0][3]).toEqual({ version: 1, summaries });
  const state = historyState();
  expect(state.runHistory.build).toHaveLength(50);
  expect(state.runHistory.build[0]).toEqual({
    state: 'success',
    duration: 25,
    timestamp: 225,
  });
  expect(state.runHistory.build.at(-1)).toEqual({
    state: 'failed',
    duration: 25,
    timestamp: 5125,
  });
  expect(Object.keys(state.runHistoryRecords)).toEqual([
    '00000000-0000-7000-8000-000000000046',
    '00000000-0000-7000-8000-000000000047',
    '00000000-0000-7000-8000-000000000048',
    '00000000-0000-7000-8000-000000000049',
    '00000000-0000-7000-8000-000000000051',
  ]);
  expect(Object.keys(state.runHistorySummaries)).toHaveLength(50);
  expect(state.runHistorySummaries['00000000-0000-7000-8000-000000000050']).toMatchObject({
    outputAvailable: false,
  });
  expect(state.runOutputs).toEqual({});
  expect(state.runInstanceIdsByProfile).toEqual({});
  expect(state.latestRunInstanceIdByProfile).toEqual({});
  expect(state.runLaunchSeqByInstance).toEqual({});
  expect(state.runCompounds).toEqual({});

  const archiveBeforeReactiveUpdate = state.runHistoryRecords;
  const summariesBeforeReactiveUpdate = state.runHistorySummaries;
  const historyBeforeRepeatedHydration = state.runHistory.build;
  act(() => {
    useIDEStore
      .getState()
      .setRunProfilesSnapshot(
        useIDEStore.getState().runProfiles,
        useIDEStore.getState().runProfileState,
        7,
        new runhistory.Snapshot({ version: 1, summaries })
      );
  });
  expect(historyState().runHistory.build).toEqual(historyBeforeRepeatedHydration);
  expect(Object.keys(historyState().runHistorySummaries)).toHaveLength(50);

  act(() => {
    runprofilesChanged?.({
      profiles: [
        {
          id: 'build',
          name: 'Renamed Build',
          type: 'single',
          source: 'user',
          command: 'go build ./...',
        },
      ],
      profileState: {},
      workspaceEpoch: 7,
    });
  });
  expect(atomicApply).toHaveBeenCalledTimes(3);
  expect(atomicApply.mock.calls[2][3]).toBeUndefined();
  expect(historyState().runHistoryRecords).toEqual(archiveBeforeReactiveUpdate);
  expect(historyState().runHistorySummaries).toEqual(summariesBeforeReactiveUpdate);
});

it('serializes B then C loads and surfaces only the current workspace history warning', async () => {
  const profilesB = deferred<unknown>();
  const historyB = deferred<unknown>();
  mockGetRunProfilesSnapshot.mockReturnValueOnce(profilesB.promise).mockResolvedValueOnce({
    profiles: [
      {
        id: 'c',
        name: 'C profile',
        type: 'single',
        source: 'user',
        command: 'echo c',
      },
    ],
    profileState: {},
    workspaceEpoch: 9,
  });
  mockGetRunHistorySnapshot.mockReturnValueOnce(historyB.promise).mockResolvedValueOnce({
    version: 1,
    summaries: [],
    warning: 'C history index repaired',
  });
  useIDEStore.setState({
    workspace: { name: 'B', path: '/b' },
    workspaceEpoch: 8,
    toast: null,
  });

  const { rerender } = renderHook(({ path }: { path: string }) => useRunProfilesLoader(path), {
    initialProps: { path: '/b' },
  });
  await waitFor(() => expect(mockGetRunProfilesSnapshot).toHaveBeenCalledTimes(1));

  act(() => {
    useIDEStore.setState({ workspace: { name: 'C', path: '/c' } });
    rerender({ path: '/c' });
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  try {
    expect(mockLoadRunProfiles.mock.calls).toEqual([['/b']]);
  } finally {
    await act(async () => {
      profilesB.resolve({
        profiles: [
          {
            id: 'b',
            name: 'B profile',
            type: 'single',
            source: 'user',
            command: 'echo b',
          },
        ],
        profileState: {},
        workspaceEpoch: 8,
      });
      historyB.resolve({
        version: 1,
        summaries: [],
        warning: 'B history index repaired',
      });
    });
  }

  await waitFor(() => expect(mockLoadRunProfiles).toHaveBeenCalledWith('/c'));
  await waitFor(() => expect(useIDEStore.getState().runProfiles[0]?.id).toBe('c'));
  expect(mockLoadRunProfiles.mock.calls).toEqual([['/b'], ['/c']]);
  expect(useIDEStore.getState().runProfiles.some((profile) => profile.id === 'b')).toBe(false);
  expect(useIDEStore.getState().toast).toEqual({
    message: 'C history index repaired',
    type: 'info',
  });
});

it('hydrates healthy profiles when run history is unavailable', async () => {
  mockGetRunProfilesSnapshot.mockResolvedValueOnce({
    profiles: [
      {
        id: 'healthy',
        name: 'Healthy profile',
        type: 'single',
        source: 'user',
        command: 'echo healthy',
      },
    ],
    profileState: { healthy: { adopted: true, lastRunAt: 12 } },
    workspaceEpoch: 11,
  });
  mockGetRunHistorySnapshot.mockRejectedValueOnce(new Error('history disk unavailable'));

  renderHook(() => useRunProfilesLoader('/repo'));

  await waitFor(() => expect(useIDEStore.getState().runProfiles[0]?.id).toBe('healthy'));
  expect(useIDEStore.getState()).toMatchObject({
    runProfileState: { healthy: { adopted: true, lastRunAt: 12 } },
    workspaceEpoch: 11,
    profilesError: null,
    isLoadingProfiles: false,
    runEventsPaused: false,
    toast: {
      message: 'Run history unavailable: history disk unavailable',
      type: 'info',
    },
  });
});

it('workspace reset prevents duplicate summary hydration after switching away and back', async () => {
  const snapshot = {
    version: 1,
    summaries: [
      {
        historyId: '018f0000-0000-7000-8000-000000000001',
        kind: 'ordinary',
        profileId: 'build',
        profileName: 'Build',
        state: 'success',
        startedAt: 100,
        completedAt: 150,
        outputAvailable: true,
      },
    ],
  };
  mockGetRunHistorySnapshot.mockResolvedValue(snapshot);

  const { rerender } = renderHook(({ path }: { path: string }) => useRunProfilesLoader(path), {
    initialProps: { path: '/repo' },
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  rerender({ path: '/other' });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  rerender({ path: '/repo' });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(historyState().runHistory.build).toEqual([
    { state: 'success', duration: 50, timestamp: 150 },
  ]);
});
