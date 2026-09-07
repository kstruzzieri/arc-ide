import type { RunState, VisualState } from '../types/runOutput';

export function getVisualState(
  profileId: string,
  backendState: RunState | undefined,
  stoppingProfileIds: string[],
  restartingProfileIds: string[],
  runInstanceId?: string,
  stoppingRunInstanceIds: string[] = [],
  restartingRunInstanceIds: string[] = []
): VisualState {
  const state = backendState ?? 'idle';
  if (
    stoppingProfileIds.includes(profileId) ||
    (runInstanceId != null && stoppingRunInstanceIds.includes(runInstanceId))
  ) {
    return 'stopping';
  }
  if (
    (restartingProfileIds.includes(profileId) ||
      (runInstanceId != null && restartingRunInstanceIds.includes(runInstanceId))) &&
    state !== 'running'
  ) {
    return 'stopping';
  }
  return state;
}
