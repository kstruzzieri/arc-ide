import { useRef, useState } from 'react';
import { ClearRunHistoryRecord } from '../../wails/bindings';
import { enqueueClearAllRunHistory, trackRunHistoryClear } from '../../hooks/useRunOutput';
import {
  compareRunHistorySummaries,
  isLiveRunState,
  useIDEStore,
  useRunOutputViewMode,
  useRunOutputAutoScroll,
  useActiveRunOutputId,
} from '../../stores/ideStore';
import {
  restartProfile,
  restartRunInstance,
  startProfile,
  stopProfile,
  stopRunInstance,
} from '../../utils/profileActions';
import { ALL_PROFILES_ID, historyIdFromSelection, historySelectionId } from '../../types/runOutput';
import type { RunOutputViewMode } from '../../types/runOutput';
import styles from './RunOutput.module.css';

const VIEW_MODES: Array<{ id: RunOutputViewMode; label: string }> = [
  { id: 'merged', label: 'Merged' },
  { id: 'lanes', label: 'Lanes' },
  { id: 'diff', label: 'Diff' },
  { id: 'timeline', label: 'Timeline' },
];

interface ClearOperation {
  workspacePath: string | undefined;
  workspaceEpoch: number;
}

export function RunOutputToolbar() {
  const viewMode = useRunOutputViewMode();
  const autoScroll = useRunOutputAutoScroll();
  const activeId = useActiveRunOutputId();
  const setViewMode = useIDEStore((s) => s.setRunOutputViewMode);
  const toggleAutoScroll = useIDEStore((s) => s.toggleAutoScroll);
  const clearRunOutput = useIDEStore((s) => s.clearRunOutput);
  const clearAllRunOutputs = useIDEStore((s) => s.clearAllRunOutputs);
  const clearCompoundRunOutput = useIDEStore((s) => s.clearCompoundRunOutput);
  const setActiveRunOutput = useIDEStore((s) => s.setActiveRunOutput);
  const runOutputs = useIDEStore((s) => s.runOutputs);
  const runCompounds = useIDEStore((s) => s.runCompounds);
  const compoundIdByRunInstance = useIDEStore((s) => s.compoundIdByRunInstance);
  const runInstanceIdsByProfile = useIDEStore((s) => s.runInstanceIdsByProfile);
  const runProfiles = useIDEStore((s) => s.runProfiles);
  const runHistorySummaries = useIDEStore((s) => s.runHistorySummaries);
  const workspace = useIDEStore((s) => s.workspace);
  const workspaceEpoch = useIDEStore((s) => s.workspaceEpoch);
  const runControlsDisabled = useIDEStore((s) => s.runEventsPaused || s.isLoadingProfiles);
  const [clearOperation, setClearOperation] = useState<ClearOperation | null>(null);
  const clearOperationRef = useRef<ClearOperation | null>(null);
  const clearPending =
    clearOperation?.workspacePath === workspace?.path &&
    clearOperation?.workspaceEpoch === workspaceEpoch;
  // Toast copy is user-facing, so resolve the display name rather than leaking
  // the profile id into "Failed to stop ...".
  const displayName = (profileId: string): string =>
    runProfiles.find((profile) => profile.id === profileId)?.name ??
    runCompounds[profileId]?.name ??
    profileId;

  const isAllProfiles = activeId === ALL_PROFILES_ID;
  const activeHistoryId = historyIdFromSelection(activeId);
  const activeHistorySummary = activeHistoryId ? runHistorySummaries[activeHistoryId] : undefined;
  const hasActiveProfile = activeId && !isAllProfiles;
  const activeOutput = hasActiveProfile ? runOutputs[activeId] : undefined;
  const activeCompoundId =
    activeId && !isAllProfiles ? compoundIdByRunInstance[activeId] : undefined;
  const activeCompound = activeCompoundId ? runCompounds[activeCompoundId] : undefined;
  const isActiveOutputLive = isLiveRunState(activeOutput?.state);
  const isRunning = isActiveOutputLive || activeCompound?.state === 'running';
  const outputIds = Object.values(runInstanceIdsByProfile)
    .map((ids) => ids.filter((id) => runOutputs[id]).at(-1))
    .filter((id): id is string => id != null);
  const archiveSummaries = Object.values(runHistorySummaries)
    .filter((summary) => summary.kind === 'ordinary' && summary.outputAvailable)
    .sort(compareRunHistorySummaries);
  const ordinaryProfileIds = new Set(
    outputIds.map((id) => runOutputs[id]?.profileId).filter((id): id is string => id != null)
  );
  for (const summary of archiveSummaries) ordinaryProfileIds.add(summary.profileId);
  const canTimeline = ordinaryProfileIds.size >= 2;
  // archiveSummaries is oldest-first, so land on the newest saved run — the same
  // recency outputIds already applies per profile via .at(-1).
  const firstOutputId = outputIds[0] ?? archiveSummaries.at(-1)?.historyId;
  const currentHistoryProfile = activeHistorySummary
    ? runProfiles.find((profile) => profile.id === activeHistorySummary.profileId)
    : undefined;
  const controlProfileId = activeOutput?.profileId ?? activeCompoundId ?? currentHistoryProfile?.id;

  const handleViewMode = (mode: RunOutputViewMode) => {
    // Gate timeline mode: only allow with 2+ profiles
    if (mode === 'timeline' && !canTimeline) return;
    setViewMode(mode);
    if (mode === 'timeline') {
      setActiveRunOutput(ALL_PROFILES_ID);
    } else if (isAllProfiles) {
      if (firstOutputId) {
        setActiveRunOutput(
          outputIds.includes(firstOutputId) ? firstOutputId : historySelectionId(firstOutputId)
        );
      }
    }
  };

  const handleRerun = () => {
    if (runControlsDisabled) return;
    if (activeHistorySummary) {
      if (currentHistoryProfile) {
        startProfile(currentHistoryProfile.id, currentHistoryProfile.name);
      }
    } else if (activeOutput) {
      if (isActiveOutputLive) {
        restartRunInstance(activeOutput.runInstanceId, displayName(activeOutput.profileId));
      } else {
        startProfile(activeOutput.profileId, displayName(activeOutput.profileId));
      }
    } else if (controlProfileId) {
      restartProfile(controlProfileId, displayName(controlProfileId));
    }
  };

  const handleStop = () => {
    if (runControlsDisabled) return;
    if (activeOutput && isActiveOutputLive) {
      stopRunInstance(activeOutput.runInstanceId, displayName(activeOutput.profileId));
    } else if (controlProfileId && activeCompound?.state === 'running') {
      stopProfile(controlProfileId, displayName(controlProfileId));
    }
  };

  const beginClear = (): ClearOperation => {
    const operation = { workspacePath: workspace?.path, workspaceEpoch };
    clearOperationRef.current = operation;
    setClearOperation(operation);
    return operation;
  };

  const finishClear = (operation: ClearOperation) => {
    if (clearOperationRef.current !== operation) return;
    clearOperationRef.current = null;
    setClearOperation((current) => (current === operation ? null : current));
  };

  const handleClear = () => {
    if (runControlsDisabled || clearPending) return;
    if (activeHistoryId && activeHistorySummary?.outputAvailable) {
      const operation = beginClear();
      void trackRunHistoryClear(
        ClearRunHistoryRecord(activeHistoryId)
          .then(() => {
            useIDEStore.setState((state) => {
              if (
                state.workspace?.path !== operation.workspacePath ||
                state.workspaceEpoch !== operation.workspaceEpoch
              ) {
                return state;
              }
              const summary = state.runHistorySummaries[activeHistoryId];
              if (!summary) return state;
              const runHistoryRecords = { ...state.runHistoryRecords };
              delete runHistoryRecords[activeHistoryId];
              return {
                runHistorySummaries: {
                  ...state.runHistorySummaries,
                  [activeHistoryId]: { ...summary, outputAvailable: false },
                },
                runHistoryRecords,
                activeRunOutputId:
                  state.activeRunOutputId === historySelectionId(activeHistoryId)
                    ? null
                    : state.activeRunOutputId,
              };
            });
          })
          .catch((err: unknown) => {
            const state = useIDEStore.getState();
            if (
              state.workspace?.path === operation.workspacePath &&
              state.workspaceEpoch === operation.workspaceEpoch
            ) {
              state.showToast(
                `Failed to clear output: ${err instanceof Error ? err.message : String(err)}`,
                'error'
              );
            }
          })
          .finally(() => finishClear(operation))
      );
      return;
    }
    if (isAllProfiles) {
      const operation = beginClear();
      clearAllRunOutputs();
      void trackRunHistoryClear(
        enqueueClearAllRunHistory()
          .then(() => {
            useIDEStore.setState((state) => {
              if (
                state.workspace?.path !== operation.workspacePath ||
                state.workspaceEpoch !== operation.workspaceEpoch
              ) {
                return state;
              }
              return {
                runHistorySummaries: Object.fromEntries(
                  Object.entries(state.runHistorySummaries).map(([historyId, summary]) => [
                    historyId,
                    { ...summary, outputAvailable: false },
                  ])
                ),
                runHistoryRecords: {},
              };
            });
          })
          .catch((err: unknown) => {
            const state = useIDEStore.getState();
            if (
              state.workspace?.path === operation.workspacePath &&
              state.workspaceEpoch === operation.workspaceEpoch
            ) {
              state.showToast(
                `Failed to clear output: ${err instanceof Error ? err.message : String(err)}`,
                'error'
              );
            }
          })
          .finally(() => finishClear(operation))
      );
      return;
    }
    if (activeCompound) {
      clearCompoundRunOutput(activeCompoundId as string);
    } else if (activeId) {
      clearRunOutput(activeId);
    }
  };

  return (
    <div className={styles.toolbar}>
      {/* The compound view owns its own internal tabs, so hide the segmented
          view-mode group while a compound run is active. */}
      {!activeCompound && (
        <div className={styles.viewModeGroup}>
          {VIEW_MODES.map(({ id, label }) => (
            <button
              type="button"
              key={id}
              className={`${styles.viewModeBtn} ${viewMode === id ? styles.active : ''}`}
              onClick={() => handleViewMode(id)}
              disabled={id === 'timeline' && !canTimeline}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className={styles.toolbarDivider} />

      <button
        type="button"
        className={styles.toolbarBtn}
        onClick={handleRerun}
        disabled={runControlsDisabled || !controlProfileId}
        title="Re-run"
        aria-label="Re-run profile"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </button>

      <button
        type="button"
        className={`${styles.toolbarBtn} ${styles.danger}`}
        onClick={handleStop}
        disabled={runControlsDisabled || !isRunning}
        title="Stop"
        aria-label="Stop profile"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>

      <button
        type="button"
        className={styles.toolbarBtn}
        onClick={handleClear}
        disabled={runControlsDisabled || clearPending || !activeId}
        title="Clear output"
        aria-label="Clear output"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
      </button>

      <div className={styles.toolbarSpacer} />

      <button
        type="button"
        className={`${styles.autoscrollIndicator} ${autoScroll ? styles.pinned : ''}`}
        onClick={toggleAutoScroll}
        title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
        aria-label="Toggle auto-scroll"
      >
        <span className={styles.autoscrollDot} />
        Auto-scroll
      </button>
    </div>
  );
}
