const mockStart = jest.fn().mockResolvedValue(undefined);
const mockStop = jest.fn().mockResolvedValue(undefined);
const mockRestart = jest.fn().mockResolvedValue(undefined);
jest.mock('../../wails/bindings', () => ({
  StartRunProfile: (...a: unknown[]) => mockStart(...a),
  StopRunProfile: (...a: unknown[]) => mockStop(...a),
  RestartRunProfile: (...a: unknown[]) => mockRestart(...a),
}));

import { startProfile, stopProfile, restartProfile } from '../../utils/profileActions';
import { useIDEStore } from '../../stores/ideStore';

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({ stoppingProfileIds: [], restartingProfileIds: [] });
});

test('startProfile calls the binding', () => {
  startProfile('p1', 'Dev');
  expect(mockStart).toHaveBeenCalledWith('p1');
});

test('stopProfile flags stopping then calls the binding', () => {
  stopProfile('p1', 'Dev');
  expect(useIDEStore.getState().stoppingProfileIds).toContain('p1');
  expect(mockStop).toHaveBeenCalledWith('p1');
});

test('restartProfile flags restarting then calls the binding', () => {
  restartProfile('p1', 'Dev');
  expect(useIDEStore.getState().restartingProfileIds).toContain('p1');
  expect(mockRestart).toHaveBeenCalledWith('p1');
});

test('stopProfile clears the stopping flag once the binding resolves (idle no-op safe)', async () => {
  // Stop is an idempotent no-op for an already-idle profile (returns nil), so no
  // terminal run:status would arrive to clear the optimistic flag — resolution
  // must clear it, or the spinner sticks. (criticize-review bug #2)
  mockStop.mockResolvedValueOnce(undefined);
  stopProfile('p1', 'Dev');
  expect(useIDEStore.getState().stoppingProfileIds).toContain('p1');
  await Promise.resolve();
  await Promise.resolve();
  expect(useIDEStore.getState().stoppingProfileIds).not.toContain('p1');
});

test('restartProfile clears terminal-run flags once its start-style rerun resolves', async () => {
  useIDEStore.setState({
    runOutputs: {
      r1: {
        runInstanceId: 'r1',
        profileId: 'p1',
        state: 'success',
        exitCode: 0,
        entries: [],
        launchSeq: 1,
      },
    },
    runInstanceIdsByProfile: { p1: ['r1'] },
    runLaunchSeqByInstance: { r1: 1 },
  });

  restartProfile('p1', 'Dev');
  expect(useIDEStore.getState().restartingProfileIds).toContain('p1');
  expect(useIDEStore.getState().restartingRunInstanceIds).toContain('r1');
  await Promise.resolve();
  await Promise.resolve();
  expect(useIDEStore.getState().restartingProfileIds).not.toContain('p1');
  expect(useIDEStore.getState().restartingRunInstanceIds).not.toContain('r1');
});
