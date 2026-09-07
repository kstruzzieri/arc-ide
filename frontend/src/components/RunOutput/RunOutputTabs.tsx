import {
  archivedRunLabel,
  compareRunHistorySummaries,
  isLiveRunState,
  orderedRunIds,
  useIDEStore,
  useRunOutputs,
  useActiveRunOutputId,
} from '../../stores/ideStore';
import { getVisualState } from '../../utils/visualState';
import { ALL_PROFILES_ID, historyIdFromSelection, historySelectionId } from '../../types/runOutput';
import type { VisualState } from '../../types/runOutput';
import styles from './RunOutputTabs.module.css';

export function RunOutputTabs() {
  const runOutputs = useRunOutputs();
  const activeId = useActiveRunOutputId();
  const stoppingIds = useIDEStore((s) => s.stoppingProfileIds);
  const restartingIds = useIDEStore((s) => s.restartingProfileIds);
  const stoppingRunIds = useIDEStore((s) => s.stoppingRunInstanceIds);
  const restartingRunIds = useIDEStore((s) => s.restartingRunInstanceIds);
  const setActiveRunOutput = useIDEStore((s) => s.setActiveRunOutput);
  const profiles = useIDEStore((s) => s.runProfiles);
  const runCompounds = useIDEStore((s) => s.runCompounds);
  const compoundIdByRunInstance = useIDEStore((s) => s.compoundIdByRunInstance);
  const runInstanceIdsByProfile = useIDEStore((s) => s.runInstanceIdsByProfile);
  const runLaunchSeqByInstance = useIDEStore((s) => s.runLaunchSeqByInstance);
  const latestRunInstanceIdByProfile = useIDEStore((s) => s.latestRunInstanceIdByProfile);
  const runHistorySummaries = useIDEStore((s) => s.runHistorySummaries);

  const runIndex = { runOutputs, runInstanceIdsByProfile, runLaunchSeqByInstance };
  const ordinaryIds = Object.keys(runInstanceIdsByProfile).flatMap((profileId) =>
    orderedRunIds(runIndex, profileId).filter((id) => runOutputs[id])
  );
  const compoundIds = Object.values(runCompounds).map((run) => run.runInstanceId);
  const archiveSummaries = Object.values(runHistorySummaries)
    .filter((summary) => summary.kind === 'ordinary' && summary.outputAvailable)
    .sort(compareRunHistorySummaries);
  const archiveIds = archiveSummaries.map((summary) => historySelectionId(summary.historyId));
  const tabIds = [...ordinaryIds, ...archiveIds, ...compoundIds];
  const ordinaryProfileIds = new Set(Object.values(runOutputs).map((output) => output.profileId));
  for (const summary of archiveSummaries) ordinaryProfileIds.add(summary.profileId);
  if (tabIds.length === 0) return null;

  // Label by profile name, disambiguating the retained predecessor as "(previous)".
  // The raw runInstanceId is a backend-internal counter, so it stays out of the
  // visible label (it remains on the tab title for debugging).
  const getTabLabel = (id: string) => {
    const labelHistoryId = historyIdFromSelection(id);
    if (labelHistoryId) {
      const summary = runHistorySummaries[labelHistoryId];
      const name =
        profiles.find((profile) => profile.id === summary?.profileId)?.name ??
        summary?.profileName ??
        summary?.profileId ??
        id;
      return summary ? archivedRunLabel(summary, archiveSummaries, name) : name;
    }
    const output = runOutputs[id];
    if (output) {
      const name =
        profiles.find((profile) => profile.id === output.profileId)?.name ?? output.profileId;
      const profileRunIds = ordinaryIds.filter(
        (runId) => runOutputs[runId]?.profileId === output.profileId
      );
      if (profileRunIds.filter((runId) => isLiveRunState(runOutputs[runId]?.state)).length > 1) {
        return `${name}, Run ${profileRunIds.indexOf(id) + 1}`;
      }
      return latestRunInstanceIdByProfile[output.profileId] === id ? name : `${name} (previous)`;
    }
    const compoundId = compoundIdByRunInstance[id];
    return runCompounds[compoundId]?.name ?? id;
  };

  return (
    <div className={styles.tabBar}>
      {tabIds.map((id) => {
        const output = runOutputs[id];
        const historyId = historyIdFromSelection(id);
        const historySummary = historyId ? runHistorySummaries[historyId] : undefined;
        const compoundId = compoundIdByRunInstance[id];
        const compound = compoundId ? runCompounds[compoundId] : undefined;
        const vs: VisualState = historySummary
          ? (historySummary.state as VisualState)
          : output && output.state !== 'running' && output.state !== 'idle'
            ? output.state
            : getVisualState(
                output?.profileId ?? compoundId ?? id,
                output && isLiveRunState(output.state)
                  ? 'running'
                  : (output?.state ?? compound?.state),
                output ? [] : stoppingIds,
                output ? [] : restartingIds,
                output?.runInstanceId,
                stoppingRunIds,
                restartingRunIds
              );
        const isActive = activeId === id;
        const label = getTabLabel(id);
        return (
          <button
            type="button"
            key={id}
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            onClick={() => setActiveRunOutput(id)}
            title={historySummary ? label : output ? id : (compoundId ?? id)}
          >
            <span className={`${styles.tabDot} ${styles[`dot${capitalize(vs)}`] ?? ''}`} />
            <span className={isActive ? (styles[`name${capitalize(vs)}`] ?? '') : ''}>{label}</span>
          </button>
        );
      })}
      {/* Timeline ("All") is ordinary-profiles-only; compounds have their own
          all-steps view, so gate this tab on the ordinary outputs count. */}
      {ordinaryProfileIds.size >= 2 && (
        <button
          type="button"
          className={`${styles.tab} ${activeId === ALL_PROFILES_ID ? styles.tabActive : ''} ${styles.tabAll}`}
          onClick={() => setActiveRunOutput(ALL_PROFILES_ID)}
        >
          All
        </button>
      )}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
