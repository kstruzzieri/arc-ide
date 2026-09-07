import {
  StartRunProfile,
  StopRunProfile,
  RestartRunProfile,
  StopRunInstance as stopRunInstanceBinding,
  RestartRunInstance as restartRunInstanceBinding,
} from '../wails/bindings';
import { representativeRunInstanceId, useIDEStore } from '../stores/ideStore';

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function runControlsEnabled(): boolean {
  const state = useIDEStore.getState();
  return !state.runEventsPaused && !state.isLoadingProfiles;
}

export function startProfile(id: string, name: string): void {
  if (!runControlsEnabled()) return;
  StartRunProfile(id).catch((err: unknown) => {
    useIDEStore.getState().showToast(`Failed to start "${name}": ${msg(err)}`, 'error');
  });
}

export function stopProfile(id: string, name: string): void {
  if (!runControlsEnabled()) return;
  const store = useIDEStore.getState();
  // Profile-level stop deliberately targets only the newest live execution; a
  // sibling is stopped from its own output tab via stopRunInstance. See the
  // executor's Stop contract and the RunProfileSelector targeting tests.
  const runInstanceId = representativeRunInstanceId(store, id);
  store.setProfileStopping(id);
  if (runInstanceId) store.setRunStopping(runInstanceId);
  // StopRunProfile resolves only after the backend has fully stopped the run
  // (it blocks on process cleanup), or immediately when nothing was running
  // since Stop is an idempotent no-op. Clear the optimistic flag on resolution
  // so an idle/no-op stop cannot leave the spinner stuck — in that case no
  // terminal run:status would arrive to clear it. The terminal status clears
  // the same flag too; both are idempotent.
  StopRunProfile(id)
    .then(() => {
      useIDEStore.getState().clearProfileStopping(id);
      if (runInstanceId) useIDEStore.getState().clearRunStopping(runInstanceId);
    })
    .catch((err: unknown) => {
      useIDEStore.getState().clearProfileStopping(id);
      if (runInstanceId) useIDEStore.getState().clearRunStopping(runInstanceId);
      useIDEStore.getState().showToast(`Failed to stop "${name}": ${msg(err)}`, 'error');
    });
}

export function restartProfile(id: string, name: string): void {
  if (!runControlsEnabled()) return;
  const store = useIDEStore.getState();
  const runInstanceId = representativeRunInstanceId(store, id);
  store.setProfileRestarting(id);
  if (runInstanceId) store.setRunRestarting(runInstanceId);
  RestartRunProfile(id)
    .then(() => {
      useIDEStore.getState().clearProfileRestarting(id);
      if (runInstanceId) useIDEStore.getState().clearRunRestarting(runInstanceId);
    })
    .catch((err: unknown) => {
      useIDEStore.getState().clearProfileRestarting(id);
      if (runInstanceId) useIDEStore.getState().clearRunRestarting(runInstanceId);
      useIDEStore.getState().showToast(`Failed to restart "${name}": ${msg(err)}`, 'error');
    });
}

export function stopRunInstance(runInstanceId: string, profileName: string): void {
  if (!runControlsEnabled()) return;
  useIDEStore.getState().setRunStopping(runInstanceId);
  stopRunInstanceBinding(runInstanceId)
    .then(() => useIDEStore.getState().clearRunStopping(runInstanceId))
    .catch((err: unknown) => {
      useIDEStore.getState().clearRunStopping(runInstanceId);
      useIDEStore.getState().showToast(`Failed to stop "${profileName}": ${msg(err)}`, 'error');
    });
}

export function restartRunInstance(runInstanceId: string, profileName: string): void {
  if (!runControlsEnabled()) return;
  useIDEStore.getState().setRunRestarting(runInstanceId);
  restartRunInstanceBinding(runInstanceId)
    // The replaced instance's terminal run:status clears this too, but resolving
    // the binding is the only signal available when that status never lands.
    .then(() => useIDEStore.getState().clearRunRestarting(runInstanceId))
    .catch((err: unknown) => {
      useIDEStore.getState().clearRunRestarting(runInstanceId);
      useIDEStore.getState().showToast(`Failed to restart "${profileName}": ${msg(err)}`, 'error');
    });
}
