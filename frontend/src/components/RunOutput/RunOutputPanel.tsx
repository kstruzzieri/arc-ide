import { useState, useCallback, useEffect, useMemo } from 'react';
import type { runhistory } from '../../wails/bindings';
import { GetRunHistoryRecord } from '../../wails/bindings';
import {
  compareRunHistorySummaries,
  mergeRunHistoryArchiveMaps,
  useActiveRunOutput,
  useActiveCompoundRun,
  useActiveRunOutputId,
  useRunOutputViewMode,
  useRunOutputAutoScroll,
  useRunOutputs,
  useWorkspace,
  useIDEStore,
  orderedRunIds,
} from '../../stores/ideStore';
import { ALL_PROFILES_ID, historyIdFromSelection, historySelectionId } from '../../types/runOutput';
import type { RunOutput } from '../../types/runOutput';
import { RunOutputToolbar } from './RunOutputToolbar';
import { RunOutputTabs } from './RunOutputTabs';
import { MergedView } from './MergedView';
import { LanesView } from './LanesView';
import { DiffView } from './DiffView';
import { TimelineView } from './TimelineView';
// Import the compound view file directly (not the RunProfiles barrel) to avoid a
// circular import, since CompoundExecutionView imports from ../RunOutput/*.
import { CompoundExecutionView } from '../RunProfiles/CompoundExecutionView';
import styles from './RunOutput.module.css';

const pendingHistoryReads = new Map<string, Promise<runhistory.Record>>();

interface HistoryReadState {
  status: 'loading' | 'error';
  message?: string;
}

type UpdateHistoryReadState = (key: string, state?: HistoryReadState) => void;

function historyReadKey(
  workspacePath: string | undefined,
  workspaceEpoch: number,
  historyId: string
): string {
  return `${workspacePath ?? ''}\0${workspaceEpoch}\0${historyId}`;
}

function isRichHistoryRecord(
  value: runhistory.Summary | runhistory.Record | undefined
): value is runhistory.Record {
  return value != null && 'version' in value && value.version === 1;
}

function projectHistoryRecord(value: runhistory.Record): RunOutput {
  return {
    runInstanceId: historySelectionId(value.historyId),
    profileId: value.profileId,
    state: value.state as RunOutput['state'],
    exitCode: value.exitCode,
    workingDir: value.workingDir,
    entries: (value.entries ?? []) as RunOutput['entries'],
    truncated: value.truncated,
  };
}

type StoreState = ReturnType<typeof useIDEStore.getState>;

function immediateArchivePredecessor(
  state: Pick<StoreState, 'runHistorySummaries'>,
  current: runhistory.Summary
): runhistory.Summary | undefined {
  const summaries = Object.values(state.runHistorySummaries)
    .filter((summary) => summary.kind === 'ordinary' && summary.profileId === current.profileId)
    .sort(compareRunHistorySummaries);
  const index = summaries.findIndex((summary) => summary.historyId === current.historyId);
  return index > 0 ? summaries[index - 1] : undefined;
}

function requestHistoryRecord(
  summary: runhistory.Summary,
  demanded: (state: StoreState) => boolean,
  updateReadState: UpdateHistoryReadState
): void {
  const captured = useIDEStore.getState();
  const workspacePath = captured.workspace?.path;
  const workspaceEpoch = captured.workspaceEpoch;
  const key = historyReadKey(workspacePath, workspaceEpoch, summary.historyId);
  updateReadState(key, { status: 'loading' });
  // One observer per in-flight read. The timeline effect re-runs whenever any
  // sibling record resolves, so re-entrant calls for a still-pending key would
  // otherwise stack a second reaction on the same promise and report the same
  // failure once per re-run.
  if (pendingHistoryReads.has(key)) return;

  // outputAvailable=false is not corruption: the store redacts a record when it
  // ages past the per-profile rich limit or the workspace byte target, and the
  // summary the frontend holds only refreshes on workspace load. Treat it as the
  // authoritative tombstone and let it flow through to the merge, which drops the
  // record and flips the summary. Only a genuinely malformed record throws.
  const request = GetRunHistoryRecord(summary.historyId).then((value) => {
    if (value.version !== 1 || value.historyId !== summary.historyId || value.kind !== 'ordinary') {
      throw new Error(`Invalid run history record ${summary.historyId}`);
    }
    return value;
  });
  pendingHistoryReads.set(key, request);
  void request.then(
    () => pendingHistoryReads.delete(key),
    () => pendingHistoryReads.delete(key)
  );

  void request
    .then((record) => {
      const current = useIDEStore.getState();
      const currentSummary = current.runHistorySummaries[summary.historyId];
      if (
        current.workspace?.path !== workspacePath ||
        current.workspaceEpoch !== workspaceEpoch ||
        currentSummary !== summary ||
        currentSummary.kind !== 'ordinary' ||
        !currentSummary.outputAvailable ||
        !demanded(current)
      ) {
        return;
      }
      let applied = false;
      const selection = historySelectionId(summary.historyId);
      useIDEStore.setState((state) => {
        if (
          state.workspace?.path !== workspacePath ||
          state.workspaceEpoch !== workspaceEpoch ||
          state.runHistorySummaries[summary.historyId] !== summary ||
          !demanded(state)
        ) {
          return state;
        }
        applied = true;
        const merged = mergeRunHistoryArchiveMaps(state, [record]);
        // A tombstoned record loses its tab, so release the selection with it
        // rather than stranding the panel on a tab that no longer renders.
        if (record.outputAvailable || state.activeRunOutputId !== selection) return merged;
        return { ...merged, activeRunOutputId: null };
      });
      if (applied) {
        updateReadState(key);
        if (!record.outputAvailable) {
          useIDEStore
            .getState()
            .showToast(
              'Saved output for this run was cleared to stay within the history limit.',
              'info'
            );
        }
      }
    })
    .catch((err: unknown) => {
      const current = useIDEStore.getState();
      const currentSummary = current.runHistorySummaries[summary.historyId];
      if (
        current.workspace?.path !== workspacePath ||
        current.workspaceEpoch !== workspaceEpoch ||
        currentSummary !== summary ||
        currentSummary.kind !== 'ordinary' ||
        !currentSummary.outputAvailable ||
        !demanded(current)
      ) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      updateReadState(key, { status: 'error', message });
      current.showToast(`Failed to load run output: ${message}`, 'error');
    });
}

function HistoryReadMessage({
  label,
  state,
  onRetry,
}: {
  label: string;
  state: HistoryReadState | undefined;
  onRetry: () => void;
}) {
  const failed = state?.status === 'error';
  return (
    <div className={styles.emptyState} role={failed ? 'alert' : 'status'}>
      <p>{failed ? `Could not load run output: ${state.message}` : label}</p>
      {failed && (
        <button type="button" className={styles.viewModeBtn} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function RunOutputPanel() {
  const liveActiveOutput = useActiveRunOutput();
  const activeCompound = useActiveCompoundRun();
  const activeId = useActiveRunOutputId();
  const viewMode = useRunOutputViewMode();
  const autoScroll = useRunOutputAutoScroll();
  const runOutputs = useRunOutputs();
  const runInstanceIdsByProfile = useIDEStore((state) => state.runInstanceIdsByProfile);
  const latestRunInstanceIdByProfile = useIDEStore((state) => state.latestRunInstanceIdByProfile);
  const runLaunchSeqByInstance = useIDEStore((state) => state.runLaunchSeqByInstance);
  const runHistorySummaries = useIDEStore((state) => state.runHistorySummaries);
  const runHistoryRecords = useIDEStore((state) => state.runHistoryRecords);
  const workspaceEpoch = useIDEStore((state) => state.workspaceEpoch);
  const workspace = useWorkspace();
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(new Set());
  const [historyReadStates, setHistoryReadStates] = useState<Record<string, HistoryReadState>>({});

  const workspacePath = workspace?.path;
  const updateHistoryReadState = useCallback<UpdateHistoryReadState>((key, next) => {
    setHistoryReadStates((current) => {
      if (next) return { ...current, [key]: next };
      if (!(key in current)) return current;
      const updated = { ...current };
      delete updated[key];
      return updated;
    });
  }, []);
  const selectedHistoryId = historyIdFromSelection(activeId);
  const selectedHistorySummary = selectedHistoryId
    ? runHistorySummaries[selectedHistoryId]
    : undefined;
  const selectedHistoryValue = selectedHistoryId ? runHistoryRecords[selectedHistoryId] : undefined;
  const selectedHistoryRecord = isRichHistoryRecord(selectedHistoryValue)
    ? selectedHistoryValue
    : undefined;
  const archiveActiveOutput = selectedHistoryRecord
    ? projectHistoryRecord(selectedHistoryRecord)
    : undefined;
  const activeOutput = liveActiveOutput ?? archiveActiveOutput;
  const activeWorkingDir = activeOutput?.workingDir;
  const selectedHistoryReadState = selectedHistoryId
    ? historyReadStates[historyReadKey(workspacePath, workspaceEpoch, selectedHistoryId)]
    : undefined;

  const loadSelectedHistory = useCallback(() => {
    if (
      !selectedHistorySummary?.outputAvailable ||
      selectedHistorySummary.kind !== 'ordinary' ||
      selectedHistoryRecord
    ) {
      return;
    }
    const selection = historySelectionId(selectedHistorySummary.historyId);
    requestHistoryRecord(
      selectedHistorySummary,
      (state) => state.activeRunOutputId === selection,
      updateHistoryReadState
    );
  }, [selectedHistorySummary, selectedHistoryRecord, updateHistoryReadState]);

  useEffect(() => {
    loadSelectedHistory();
  }, [loadSelectedHistory]);

  const archivePredecessor = useMemo(
    () =>
      selectedHistorySummary?.kind === 'ordinary'
        ? immediateArchivePredecessor({ runHistorySummaries }, selectedHistorySummary)
        : undefined,
    [runHistorySummaries, selectedHistorySummary]
  );
  const archivePredecessorValue = archivePredecessor
    ? runHistoryRecords[archivePredecessor.historyId]
    : undefined;
  const archivePredecessorRecord = isRichHistoryRecord(archivePredecessorValue)
    ? archivePredecessorValue
    : undefined;
  const archivePredecessorReadState = archivePredecessor
    ? historyReadStates[historyReadKey(workspacePath, workspaceEpoch, archivePredecessor.historyId)]
    : undefined;

  const loadArchivePredecessor = useCallback(() => {
    if (
      viewMode !== 'diff' ||
      !selectedHistorySummary ||
      !archivePredecessor?.outputAvailable ||
      archivePredecessorRecord
    ) {
      return;
    }
    const selection = historySelectionId(selectedHistorySummary.historyId);
    requestHistoryRecord(
      archivePredecessor,
      (state) => {
        const current = state.runHistorySummaries[selectedHistorySummary.historyId];
        return (
          state.activeRunOutputId === selection &&
          state.runOutputViewMode === 'diff' &&
          current != null &&
          immediateArchivePredecessor(state, current)?.historyId === archivePredecessor.historyId
        );
      },
      updateHistoryReadState
    );
  }, [
    archivePredecessor,
    archivePredecessorRecord,
    selectedHistorySummary,
    updateHistoryReadState,
    viewMode,
  ]);

  useEffect(() => {
    loadArchivePredecessor();
  }, [loadArchivePredecessor]);

  const currentTimelineOutputs = useMemo(() => {
    const filtered: typeof runOutputs = {};
    const runIndex = { runOutputs, runInstanceIdsByProfile, runLaunchSeqByInstance };
    for (const profileId of Object.keys(runInstanceIdsByProfile)) {
      const latestId = latestRunInstanceIdByProfile[profileId];
      const id =
        (latestId && runOutputs[latestId] ? latestId : undefined) ??
        orderedRunIds(runIndex, profileId)
          .filter((runId) => runOutputs[runId])
          .at(-1);
      if (id && runOutputs[id]) filtered[id] = runOutputs[id];
    }
    return filtered;
  }, [runOutputs, runInstanceIdsByProfile, latestRunInstanceIdByProfile, runLaunchSeqByInstance]);

  const archiveTimelineSummaries = useMemo(() => {
    if (activeId !== ALL_PROFILES_ID) return [];
    const currentProfiles = new Set(
      Object.values(currentTimelineOutputs).map((output) => output.profileId)
    );
    const byProfile = new Map<string, runhistory.Summary[]>();
    for (const summary of Object.values(runHistorySummaries)) {
      if (summary.kind !== 'ordinary' || currentProfiles.has(summary.profileId)) continue;
      const summaries = byProfile.get(summary.profileId) ?? [];
      summaries.push(summary);
      byProfile.set(summary.profileId, summaries);
    }
    return [...byProfile.values()]
      .map((summaries) =>
        summaries
          .sort(compareRunHistorySummaries)
          .reverse()
          .find((summary) => summary.outputAvailable)
      )
      .filter((summary): summary is runhistory.Summary => summary != null);
  }, [activeId, currentTimelineOutputs, runHistorySummaries]);

  useEffect(() => {
    for (const summary of archiveTimelineSummaries) {
      if (isRichHistoryRecord(runHistoryRecords[summary.historyId])) continue;
      requestHistoryRecord(
        summary,
        (state) => {
          if (state.activeRunOutputId !== ALL_PROFILES_ID) return false;
          const hasCurrent = Object.values(state.runOutputs).some(
            (output) => output.profileId === summary.profileId
          );
          if (hasCurrent) return false;
          const newestReadable = Object.values(state.runHistorySummaries)
            .filter(
              (candidate) =>
                candidate.kind === 'ordinary' &&
                candidate.profileId === summary.profileId &&
                candidate.outputAvailable
            )
            .sort(compareRunHistorySummaries)
            .at(-1);
          return newestReadable?.historyId === summary.historyId;
        },
        updateHistoryReadState
      );
    }
  }, [archiveTimelineSummaries, runHistoryRecords, updateHistoryReadState]);

  const timelineOutputs = useMemo(() => {
    const filtered = { ...currentTimelineOutputs };
    for (const summary of archiveTimelineSummaries) {
      const value = runHistoryRecords[summary.historyId];
      if (isRichHistoryRecord(value)) {
        filtered[historySelectionId(summary.historyId)] = projectHistoryRecord(value);
      }
    }
    return filtered;
  }, [archiveTimelineSummaries, currentTimelineOutputs, runHistoryRecords]);

  const previousOutput = useMemo(() => {
    if (selectedHistoryId) {
      return archivePredecessorRecord ? projectHistoryRecord(archivePredecessorRecord) : undefined;
    }
    if (!activeOutput) return undefined;
    const ids = runInstanceIdsByProfile[activeOutput.profileId] ?? [];
    const index = ids.indexOf(activeOutput.runInstanceId);
    return index > 0 ? runOutputs[ids[index - 1]] : undefined;
  }, [
    activeOutput,
    archivePredecessorRecord,
    runInstanceIdsByProfile,
    runOutputs,
    selectedHistoryId,
  ]);
  const selectedHistoryNeedsRecord =
    selectedHistorySummary?.kind === 'ordinary' &&
    selectedHistorySummary.outputAvailable &&
    !selectedHistoryRecord;
  const diffPredecessorNeedsRecord =
    viewMode === 'diff' &&
    selectedHistoryId != null &&
    archivePredecessor?.outputAvailable === true &&
    !archivePredecessorRecord;

  // A partial log must say so. In Diff it matters most: comparing a truncated
  // run against a complete one manufactures differences near the truncated end.
  const truncationNotice = useMemo(() => {
    const current = activeOutput?.truncated === true;
    const previous = viewMode === 'diff' && previousOutput?.truncated === true;
    if (!current && !previous) return undefined;
    if (viewMode !== 'diff') {
      return 'Output was dropped to fit the saved-output limit — this log is partial.';
    }
    if (current && previous) {
      return 'Both runs are partial, so differences near the start of the output may not be real.';
    }
    return current
      ? 'This run is partial, so differences near the start of the output may not be real.'
      : 'The previous run is partial, so differences near the start of the output may not be real.';
  }, [activeOutput?.truncated, previousOutput?.truncated, viewMode]);

  const handleToggleFold = useCallback((foldId: string) => {
    setExpandedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(foldId)) {
        next.delete(foldId);
      } else {
        next.add(foldId);
      }
      return next;
    });
  }, []);

  // A compound run owns the entire output surface (it has its own internal
  // tabs/views), so it takes precedence over the ordinary view modes.
  if (activeCompound) {
    return (
      <div className={styles.panelContainer}>
        <RunOutputTabs />
        <RunOutputToolbar />
        <CompoundExecutionView key={activeCompound.compoundId} compound={activeCompound} />
      </div>
    );
  }

  return (
    <div className={styles.panelContainer}>
      <RunOutputTabs />
      <RunOutputToolbar />
      {viewMode === 'timeline' ? (
        <TimelineView
          runOutputs={timelineOutputs}
          autoScroll={autoScroll}
          workspacePath={workspacePath}
        />
      ) : selectedHistoryNeedsRecord ? (
        <HistoryReadMessage
          label="Loading run output…"
          state={selectedHistoryReadState}
          onRetry={loadSelectedHistory}
        />
      ) : diffPredecessorNeedsRecord ? (
        <HistoryReadMessage
          label="Loading previous run output…"
          state={archivePredecessorReadState}
          onRetry={loadArchivePredecessor}
        />
      ) : activeOutput ? (
        <>
          {truncationNotice && (
            <div className={styles.truncationNotice} role="status">
              {truncationNotice}
            </div>
          )}
          {viewMode === 'merged' && (
            <MergedView
              entries={activeOutput.entries}
              autoScroll={autoScroll}
              expandedFolds={expandedFolds}
              onToggleFold={handleToggleFold}
              workingDir={activeWorkingDir}
              workspacePath={workspacePath}
            />
          )}
          {viewMode === 'lanes' && (
            <LanesView
              entries={activeOutput.entries}
              autoScroll={autoScroll}
              workingDir={activeWorkingDir}
              workspacePath={workspacePath}
            />
          )}
          {viewMode === 'diff' && (
            <DiffView
              entries={activeOutput.entries}
              previousEntries={previousOutput?.entries ?? []}
              workingDir={activeWorkingDir}
              previousWorkingDir={previousOutput?.workingDir}
              workspacePath={workspacePath}
            />
          )}
        </>
      ) : (
        <div className={styles.emptyState}>
          <p>Run a profile to see output here</p>
        </div>
      )}
    </div>
  );
}
