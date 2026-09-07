import { renderHook, act, waitFor } from '@testing-library/react';
import { useIDEStore } from '../../stores/ideStore';
import type { RunProfile } from '../../types/runProfile';

// Mock Wails App bindings
const mockLoadRunProfiles = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
const mockGetRunProfilesSnapshot = jest.fn().mockResolvedValue({ profiles: [], profileState: {} });
const mockGetRunHistorySnapshot = jest.fn().mockResolvedValue({ version: 1, summaries: [] });
const mockStartRunProfile = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
jest.mock('../../wails/bindings', () => ({
  LoadRunProfiles: mockLoadRunProfiles,
  GetRunProfilesSnapshot: mockGetRunProfilesSnapshot,
  GetRunHistorySnapshot: mockGetRunHistorySnapshot,
  StartRunProfile: mockStartRunProfile,
  StopRunProfile: jest.fn().mockResolvedValue(undefined),
  RestartRunProfile: jest.fn().mockResolvedValue(undefined),
}));

// Mock Wails runtime
const mockEventsOn = jest
  .fn<() => void, [string, (profiles: unknown) => void]>()
  .mockImplementation(() => jest.fn());
jest.mock('../../wails/runtime', () => ({
  EventsOn: mockEventsOn,
}));

// Import after mocks
import { useRunProfilesLoader, normalizeProfileState } from '../../hooks/useRunProfiles';
import { startProfile } from '../../utils/profileActions';

const setPhase2BState = (patch: Partial<ReturnType<typeof useIDEStore.getState>>) => {
  useIDEStore.setState(patch);
};

const sampleProfiles: RunProfile[] = [
  {
    id: 'detected-go-mod-build',
    name: 'go build',
    type: 'single',
    source: 'detected',
    command: 'go build ./...',
    detectedFrom: 'go.mod',
    tags: ['build'],
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({
    runProfiles: [],
    isLoadingProfiles: false,
    profilesError: null,
  });
  mockLoadRunProfiles.mockResolvedValue(undefined);
  mockGetRunProfilesSnapshot.mockResolvedValue({ profiles: sampleProfiles, profileState: {} });
});

describe('normalizeProfileState', () => {
  test('normalizeProfileState keeps valid entries, drops malformed', () => {
    const out = normalizeProfileState({
      a: { adopted: true, lastRunAt: 5 },
      b: { adopted: 'nope', lastRunAt: 'x' },
      c: null,
    });
    expect(out.a).toEqual({ adopted: true, lastRunAt: 5 });
    expect(out.b).toEqual({ adopted: false, lastRunAt: 0 });
    expect(out.c).toBeUndefined();
  });
});

describe('useRunProfilesLoader', () => {
  it('should not load when path is null', () => {
    renderHook(() => useRunProfilesLoader(null));
    expect(mockLoadRunProfiles).not.toHaveBeenCalled();
  });

  it('should load profiles on mount with valid path', async () => {
    renderHook(() => useRunProfilesLoader('/workspace'));

    // Should set loading
    expect(useIDEStore.getState().isLoadingProfiles).toBe(true);

    await waitFor(() => expect(useIDEStore.getState().isLoadingProfiles).toBe(false));

    expect(mockLoadRunProfiles).toHaveBeenCalledWith('/workspace');
    expect(mockGetRunProfilesSnapshot).toHaveBeenCalled();
    expect(useIDEStore.getState().runProfiles).toEqual(sampleProfiles);
    expect(useIDEStore.getState().isLoadingProfiles).toBe(false);
  });

  it('should subscribe to runprofiles:changed event', () => {
    renderHook(() => useRunProfilesLoader('/workspace'));

    expect(mockEventsOn).toHaveBeenCalledWith('runprofiles:changed', expect.any(Function));
  });

  it('should clean up event listener on unmount', () => {
    const mockCleanup = jest.fn();
    mockEventsOn.mockReturnValueOnce(mockCleanup);

    const { unmount } = renderHook(() => useRunProfilesLoader('/workspace'));
    unmount();

    expect(mockCleanup).toHaveBeenCalled();
  });

  it('should set error on load failure', async () => {
    mockLoadRunProfiles.mockRejectedValueOnce(new Error('Permission denied'));

    renderHook(() => useRunProfilesLoader('/workspace'));

    await waitFor(() => expect(useIDEStore.getState().profilesError).toBe('Permission denied'));

    expect(useIDEStore.getState().profilesError).toBe('Permission denied');
    expect(useIDEStore.getState().isLoadingProfiles).toBe(false);
  });

  it('blocks run admission while a workspace load holds the event barrier', async () => {
    let resolveLoad: () => void = () => {};
    mockLoadRunProfiles.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );
    mockGetRunProfilesSnapshot.mockResolvedValueOnce({
      profiles: sampleProfiles,
      profileState: {},
      workspaceEpoch: 2,
    });

    renderHook(() => useRunProfilesLoader('/next-workspace'));
    startProfile(sampleProfiles[0].id, sampleProfiles[0].name);

    expect(useIDEStore.getState()).toMatchObject({
      isLoadingProfiles: true,
      runEventsPaused: true,
    });
    expect(mockStartRunProfile).not.toHaveBeenCalled();
    await waitFor(() => expect(mockLoadRunProfiles).toHaveBeenCalledWith('/next-workspace'));

    await act(async () => {
      resolveLoad();
    });
    await waitFor(() => expect(useIDEStore.getState().runEventsPaused).toBe(false));

    startProfile(sampleProfiles[0].id, sampleProfiles[0].name);
    expect(mockStartRunProfile).toHaveBeenCalledWith(sampleProfiles[0].id);
  });

  it('clears stale running UI after a failed workspace load and re-enables it only after retry', async () => {
    setPhase2BState({
      runProfiles: [
        {
          id: 'stale',
          name: 'Stale build',
          type: 'single',
          source: 'user',
          command: 'sleep 60',
        },
      ],
      selectedProfileId: 'stale',
      runOutputs: {
        staleRun: {
          runInstanceId: 'staleRun',
          profileId: 'stale',
          state: 'running',
          exitCode: 0,
          entries: [],
          launchSeq: 1,
          workspaceEpoch: 1,
        },
      },
      runInstanceIdsByProfile: { stale: ['staleRun'] },
      latestRunInstanceIdByProfile: { stale: 'staleRun' },
      runLaunchSeqByInstance: { staleRun: 1 },
      stoppingRunInstanceIds: ['staleRun'],
      restartingRunInstanceIds: [],
      workspaceEpoch: 1,
      runEventsPaused: false,
      profilesError: null,
    });
    mockLoadRunProfiles.mockRejectedValueOnce(new Error('workspace unavailable'));

    const { rerender } = renderHook(({ path }: { path: string }) => useRunProfilesLoader(path), {
      initialProps: { path: '/broken' },
    });

    await waitFor(() => expect(useIDEStore.getState().profilesError).toBe('workspace unavailable'));

    let state = useIDEStore.getState();
    expect(state.profilesError).toBe('workspace unavailable');
    expect(state.runProfiles).toEqual([]);
    expect(state.selectedProfileId).toBeNull();
    expect(state.runOutputs).toEqual({});
    expect(state.runInstanceIdsByProfile).toEqual({});
    expect(state.latestRunInstanceIdByProfile).toEqual({});
    expect(state.runEventsPaused).toBe(true);

    mockLoadRunProfiles.mockResolvedValueOnce(undefined);
    mockGetRunProfilesSnapshot.mockResolvedValueOnce({
      profiles: sampleProfiles,
      profileState: {},
      workspaceEpoch: 2,
    });

    rerender({ path: '/retry' });
    await waitFor(() => expect(useIDEStore.getState().runEventsPaused).toBe(false));

    state = useIDEStore.getState();
    expect(state.profilesError).toBeNull();
    expect(state.runProfiles).toEqual(sampleProfiles);
    expect(state.isLoadingProfiles).toBe(false);
    expect(state).toMatchObject({
      runEventsPaused: false,
      workspaceEpoch: 2,
    });

    state.handleRunStatus({
      runInstanceId: 'retry-run',
      profileId: sampleProfiles[0].id,
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
      timestamp: 200,
      launchSeq: 1,
      workspaceEpoch: 2,
    });
    expect(useIDEStore.getState().runOutputs['retry-run']?.state).toBe('running');
  });

  it('should finish a stale load before dispatching and hydrating the next workspace', async () => {
    // First render with workspace A — make it resolve slowly
    let resolveA: () => void = () => {};
    mockLoadRunProfiles.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveA = resolve;
        })
    );

    const { rerender } = renderHook(
      ({ path }: { path: string | null }) => useRunProfilesLoader(path),
      { initialProps: { path: '/workspace-a' } }
    );
    await waitFor(() => expect(mockLoadRunProfiles).toHaveBeenCalledWith('/workspace-a'));

    // Switch to workspace B before A resolves
    const profilesB: RunProfile[] = [
      { id: 'b1', name: 'B profile', type: 'single', source: 'user', command: 'echo b' },
    ];
    mockLoadRunProfiles.mockResolvedValueOnce(undefined);
    mockGetRunProfilesSnapshot.mockResolvedValueOnce({ profiles: profilesB, profileState: {} });

    rerender({ path: '/workspace-b' });
    await act(async () => Promise.resolve());
    try {
      expect(mockLoadRunProfiles).not.toHaveBeenCalledWith('/workspace-b');
      expect(useIDEStore.getState().runProfiles).toEqual([]);
    } finally {
      await act(async () => resolveA());
    }

    await waitFor(() => expect(useIDEStore.getState().runProfiles).toEqual(profilesB));
    expect(mockLoadRunProfiles.mock.calls).toEqual([['/workspace-a'], ['/workspace-b']]);
    expect(useIDEStore.getState().runProfiles).toEqual(profilesB);
  });

  it('carries workspace ownership fields through normalization', async () => {
    mockGetRunProfilesSnapshot.mockResolvedValueOnce({
      profiles: [
        {
          id: 'detected-frontend-package-json-dev',
          name: 'npm run dev',
          type: 'single',
          source: 'detected',
          command: 'npm run dev',
          workingDir: 'frontend',
          workspaceId: 'frontend',
          workspaceName: 'Frontend',
          workspaceRelDir: 'frontend',
        },
      ],
      profileState: {},
    });

    renderHook(() => useRunProfilesLoader('/workspace'));

    await waitFor(() =>
      expect(useIDEStore.getState().runProfiles[0]?.workspaceId).toBe('frontend')
    );

    const profiles = useIDEStore.getState().runProfiles;
    expect(profiles[0]?.workspaceId).toBe('frontend');
    expect(profiles[0]?.workspaceName).toBe('Frontend');
    expect(profiles[0]?.workspaceRelDir).toBe('frontend');
  });

  it('should update profiles when reactive event fires', async () => {
    let eventCallback: (snap: unknown) => void = () => {};
    mockEventsOn.mockImplementationOnce((_event: string, cb: (snap: unknown) => void) => {
      eventCallback = cb;
      return jest.fn();
    });
    mockGetRunProfilesSnapshot.mockResolvedValueOnce({
      profiles: sampleProfiles,
      profileState: {},
      workspaceEpoch: 1,
    });

    renderHook(() => useRunProfilesLoader('/workspace'));

    const updatedProfiles: RunProfile[] = [
      ...sampleProfiles,
      {
        id: 'detected-pkg-start',
        name: 'npm run start',
        type: 'single',
        source: 'detected',
        command: 'npm run start',
        tags: ['dev'],
      },
    ];

    await waitFor(() => expect(useIDEStore.getState().runEventsPaused).toBe(false));

    act(() => {
      eventCallback({ profiles: updatedProfiles, profileState: {}, workspaceEpoch: 1 });
    });

    expect(useIDEStore.getState().runProfiles).toEqual(updatedProfiles);
  });

  it('ignores reactive snapshots outside the active epoch barrier', async () => {
    let eventCallback: (snap: unknown) => void = () => {};
    mockEventsOn.mockImplementationOnce((_event: string, cb: (snap: unknown) => void) => {
      eventCallback = cb;
      return jest.fn();
    });
    mockGetRunProfilesSnapshot.mockResolvedValueOnce({
      profiles: sampleProfiles,
      profileState: {},
      workspaceEpoch: 2,
    });

    renderHook(() => useRunProfilesLoader('/workspace'));
    await waitFor(() => expect(useIDEStore.getState().workspaceEpoch).toBe(2));

    const staleProfiles: RunProfile[] = [
      {
        id: 'stale',
        name: 'Stale',
        type: 'single',
        source: 'user',
        command: 'echo stale',
      },
    ];

    act(() => {
      eventCallback({ profiles: staleProfiles, profileState: {}, workspaceEpoch: 1 });
      eventCallback({ profiles: staleProfiles, profileState: {} });
      useIDEStore.getState().pauseRunEvents();
      eventCallback({ profiles: staleProfiles, profileState: {}, workspaceEpoch: 2 });
    });

    expect(useIDEStore.getState().runProfiles).toEqual(sampleProfiles);
    expect(useIDEStore.getState().workspaceEpoch).toBe(2);
    expect(useIDEStore.getState().runEventsPaused).toBe(true);
  });

  it('recovers from a failed load when the retry nonce is bumped', async () => {
    mockLoadRunProfiles.mockRejectedValueOnce(new Error('workspace unavailable'));

    renderHook(() => useRunProfilesLoader('/workspace-a'));
    await waitFor(() =>
      expect(useIDEStore.getState().profilesError).toContain('workspace unavailable')
    );

    // A failed load leaves run events paused, which also makes the
    // runprofiles:changed handler bail — so without a retry the run controls
    // stay disabled until the workspace path itself changes.
    expect(useIDEStore.getState().profilesError).toContain('workspace unavailable');
    expect(useIDEStore.getState().runEventsPaused).toBe(true);

    act(() => {
      useIDEStore.getState().reloadRunProfiles();
    });
    await waitFor(() => expect(useIDEStore.getState().runEventsPaused).toBe(false));

    expect(useIDEStore.getState().profilesError).toBeNull();
    expect(useIDEStore.getState().runEventsPaused).toBe(false);
    expect(useIDEStore.getState().runProfiles).toEqual(sampleProfiles);
  });
});
