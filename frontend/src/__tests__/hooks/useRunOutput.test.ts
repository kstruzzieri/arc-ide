const mockEventsOn = jest
  .fn<() => void, [string, (...args: unknown[]) => void]>()
  .mockImplementation(() => jest.fn());

jest.mock('../../wails/runtime', () => ({
  EventsOn: mockEventsOn,
}));

jest.mock('../../wails/bindings', () => ({}));

import { renderHook } from '@testing-library/react';
import { useRunOutputListener } from '../../hooks/useRunOutput';
import { useIDEStore } from '../../stores/ideStore';

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({
    runOutputs: {},
    runInstanceIdsByProfile: {},
    latestRunInstanceIdByProfile: {},
    activeRunOutputId: null,
    runOutputViewMode: 'merged',
    runOutputAutoScroll: true,
  });
});

describe('useRunOutputListener', () => {
  it('does not keep a waveform timer alive while idle', () => {
    jest.useFakeTimers();
    try {
      renderHook(() => useRunOutputListener());

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('should subscribe to run:output and run:status events', () => {
    renderHook(() => useRunOutputListener());

    expect(mockEventsOn).toHaveBeenCalledWith('run:output', expect.any(Function));
    expect(mockEventsOn).toHaveBeenCalledWith('run:status', expect.any(Function));
  });

  it('should clean up event listeners on unmount', () => {
    const cleanupOutput = jest.fn();
    const cleanupStatus = jest.fn();
    mockEventsOn.mockReturnValueOnce(cleanupOutput).mockReturnValueOnce(cleanupStatus);

    const { unmount } = renderHook(() => useRunOutputListener());
    unmount();

    expect(cleanupOutput).toHaveBeenCalled();
    expect(cleanupStatus).toHaveBeenCalled();
  });

  it('should auto-select first running profile', () => {
    renderHook(() => useRunOutputListener());

    const statusCallback = mockEventsOn.mock.calls.find(([event]) => event === 'run:status')?.[1];

    expect(statusCallback).toBeDefined();
    statusCallback!({
      runInstanceId: 'r1',
      profileId: 'test-1',
      stepIdx: 0,
      state: 'running',
      exitCode: 0,
    });

    expect(useIDEStore.getState().activeRunOutputId).toBe('r1');
  });

  it('should subscribe to run:compound and route to handleCompoundRun', () => {
    const handleCompoundRun = jest.fn();
    useIDEStore.setState({ handleCompoundRun });

    renderHook(() => useRunOutputListener());

    expect(mockEventsOn).toHaveBeenCalledWith('run:compound', expect.any(Function));

    const compoundCallback = mockEventsOn.mock.calls.find(
      ([event]) => event === 'run:compound'
    )?.[1];
    expect(compoundCallback).toBeDefined();

    const event = {
      runInstanceId: 'agg-r1',
      compoundId: 'ci',
      name: 'CI',
      state: 'running',
      currentStep: 0,
      steps: [],
    };
    compoundCallback!(event);

    expect(handleCompoundRun).toHaveBeenCalledWith(event);
  });

  it('should not count composite step output toward waveform data', () => {
    jest.useFakeTimers();
    try {
      const updateWaveform = jest.fn();
      useIDEStore.setState({ updateWaveform, appendRunOutput: jest.fn(() => true) });

      renderHook(() => useRunOutputListener());

      const outputCallback = mockEventsOn.mock.calls.find(([event]) => event === 'run:output')?.[1];
      expect(outputCallback).toBeDefined();

      // A chunk with a parentRunInstanceId is compound step output and must NOT
      // be counted; a plain chunk ("real") is a normal profile and SHOULD be.
      outputCallback!({
        runInstanceId: 'step-r1',
        profileId: 'build',
        parentRunInstanceId: 'agg-r1',
        stepIdx: 0,
        stream: 'stdout',
        data: 'x\n',
        timestamp: 1,
      });
      outputCallback!({
        runInstanceId: 'r1',
        profileId: 'real',
        stepIdx: 0,
        stream: 'stdout',
        data: 'y\n',
        timestamp: 2,
      });

      // Drive the 500ms waveform flush interval.
      jest.advanceTimersByTime(600);

      expect(updateWaveform).toHaveBeenCalledWith('real', expect.any(Number));
      expect(updateWaveform).not.toHaveBeenCalledWith('build', expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts only ordinary chunks accepted by the store in the aggregate profile waveform', () => {
    jest.useFakeTimers();
    try {
      const updateWaveform = jest.fn();
      const appendRunOutput = jest
        .fn<boolean, [unknown]>()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      useIDEStore.setState({
        workspaceEpoch: 7,
        runEventsPaused: false,
        updateWaveform,
        appendRunOutput,
      });

      renderHook(() => useRunOutputListener());
      const outputCallback = mockEventsOn.mock.calls.find(([event]) => event === 'run:output')?.[1];
      expect(outputCallback).toBeDefined();

      outputCallback!({
        runInstanceId: 'r1',
        profileId: 'p1',
        stepIdx: 0,
        stream: 'stdout',
        data: 'accepted sibling one\n',
        timestamp: 1,
        launchSeq: 10,
        workspaceEpoch: 7,
      });
      outputCallback!({
        runInstanceId: 'old-r2',
        profileId: 'p1',
        stepIdx: 0,
        stream: 'stdout',
        data: 'rejected old epoch\n',
        timestamp: 2,
        launchSeq: 20,
        workspaceEpoch: 6,
      });
      outputCallback!({
        runInstanceId: 'r3',
        profileId: 'p1',
        stepIdx: 0,
        stream: 'stdout',
        data: 'accepted sibling two\n',
        timestamp: 3,
        launchSeq: 30,
        workspaceEpoch: 7,
      });

      jest.advanceTimersByTime(600);

      expect(updateWaveform).toHaveBeenCalledTimes(1);
      expect(updateWaveform).toHaveBeenCalledWith('p1', 2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops a queued waveform bucket when the workspace epoch changes before flush', () => {
    jest.useFakeTimers();
    try {
      const updateWaveform = jest.fn();
      useIDEStore.setState({
        workspaceEpoch: 1,
        runEventsPaused: false,
        updateWaveform,
        appendRunOutput: jest.fn(() => true),
      });

      renderHook(() => useRunOutputListener());
      const outputCallback = mockEventsOn.mock.calls.find(([event]) => event === 'run:output')?.[1];
      expect(outputCallback).toBeDefined();

      outputCallback!({
        runInstanceId: 'old-run',
        profileId: 'shared-profile-id',
        stepIdx: 0,
        stream: 'stdout',
        data: 'accepted before switch\n',
        timestamp: 1,
        launchSeq: 10,
        workspaceEpoch: 1,
      });

      useIDEStore.setState({ workspaceEpoch: 2, runEventsPaused: false });
      jest.advanceTimersByTime(600);

      expect(updateWaveform).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
