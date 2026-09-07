import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEffectiveRunTarget } from '../../hooks/useEffectiveRunTarget';
import { Panel } from '../layout';
import { RunProfileCard } from './RunProfileCard';
import { RunProfileForm } from './RunProfileForm';
import { TreeViewToggle } from '../FileExplorer/TreeViewToggle';
import {
  useRunProfiles,
  useIsLoadingProfiles,
  useProfilesError,
  useIDEStore,
  useRunProfileState,
  useRunProfileForm,
  useTreeViewMode,
  useActiveWorkspaceId,
  useWorkspaces,
  isLiveRunState,
  representativeRunInstanceId,
} from '../../stores/ideStore';
import { getVisualState } from '../../utils/visualState';
import { estimateRemaining } from '../../utils/estimateCompletion';
import {
  groupProfiles,
  isJustRan,
  SECTION_LABEL,
  type SectionGroup,
  type WorkspaceGroup,
} from '../../utils/groupProfiles';
import type { RunProfile } from '../../types/runProfile';
import type { RunOutput } from '../../types/runOutput';
import styles from './RunProfiles.module.css';
import { accentVar } from '../../utils/accent';

export function RunProfiles() {
  const profiles = useRunProfiles();
  const isLoading = useIsLoadingProfiles();
  const error = useProfilesError();
  const reloadRunProfiles = useIDEStore((s) => s.reloadRunProfiles);
  const runOutputs = useIDEStore((s) => s.runOutputs);
  const latestRunInstanceIdByProfile = useIDEStore((s) => s.latestRunInstanceIdByProfile);
  const runInstanceIdsByProfile = useIDEStore((s) => s.runInstanceIdsByProfile);
  const runLaunchSeqByInstance = useIDEStore((s) => s.runLaunchSeqByInstance);
  const runCompounds = useIDEStore((s) => s.runCompounds);
  const compoundIdByRunInstance = useIDEStore((s) => s.compoundIdByRunInstance);
  const runHistory = useIDEStore((s) => s.runHistory);
  const hiddenProfileIds = useIDEStore((s) => s.hiddenProfileIds);
  const stoppingIds = useIDEStore((s) => s.stoppingProfileIds);
  const restartingIds = useIDEStore((s) => s.restartingProfileIds);
  const stoppingRunIds = useIDEStore((s) => s.stoppingRunInstanceIds);
  const restartingRunIds = useIDEStore((s) => s.restartingRunInstanceIds);
  const runStartTimestamps = useIDEStore((s) => s.runStartTimestamps);
  const focusProfileOutput = useIDEStore((s) => s.focusProfileOutput);
  const runProfileState = useRunProfileState();
  const runProfileForm = useRunProfileForm();
  const openRunProfileForm = useIDEStore((s) => s.openRunProfileForm);
  const viewMode = useTreeViewMode(); // 'project' | 'workspace'
  const activeWorkspaceId = useActiveWorkspaceId();
  const workspaces = useWorkspaces();
  const effectiveTargetId = useEffectiveRunTarget();
  const currentRun = useCallback(
    (profileId: string) => {
      const ordinaryRunInstanceId = representativeRunInstanceId(
        { runOutputs, runInstanceIdsByProfile, runLaunchSeqByInstance },
        profileId
      );
      const aggregateRunInstanceId = latestRunInstanceIdByProfile[profileId];
      const runInstanceId = ordinaryRunInstanceId ?? aggregateRunInstanceId;
      const ordinaryState = runOutputs[ordinaryRunInstanceId ?? '']?.state;
      return {
        runInstanceId,
        state:
          ordinaryState == null
            ? runCompounds[compoundIdByRunInstance[aggregateRunInstanceId]]?.state
            : isLiveRunState(ordinaryState)
              ? 'running'
              : ordinaryState,
      };
    },
    [
      runOutputs,
      runInstanceIdsByProfile,
      runLaunchSeqByInstance,
      latestRunInstanceIdByProfile,
      runCompounds,
      compoundIdByRunInstance,
    ]
  );
  const currentVisualState = useCallback(
    (profileId: string) => {
      const execution = currentRun(profileId);
      return getVisualState(
        profileId,
        execution.state,
        stoppingIds,
        restartingIds,
        execution.runInstanceId,
        stoppingRunIds,
        restartingRunIds
      );
    },
    [currentRun, stoppingIds, restartingIds, stoppingRunIds, restartingRunIds]
  );

  // Render-time "now" for the just-ran recency window. Kept out of any memo deps
  // so grouping stays pure/memoized; recomputed each render (e.g. via etaTick).
  const nowMs = Date.now();

  // Filter out hidden profiles
  const visibleProfiles = useMemo(
    () => profiles.filter((p) => !hiddenProfileIds.includes(p.id)),
    [profiles, hiddenProfileIds]
  );

  // Detect duplicate names for disambiguation
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of visibleProfiles) {
      counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    }
    return counts;
  }, [visibleProfiles]);

  // Periodic tick to refresh ETA sort order while profiles are running.
  // Without this, Date.now() in the sort memo stales until a store change.
  const hasRunning = useMemo(
    () => visibleProfiles.some((p) => currentVisualState(p.id) === 'running'),
    [visibleProfiles, currentVisualState]
  );
  const [etaTick, setEtaTick] = useState(0);
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => setEtaTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  // Helper: sort running profiles by ETA ascending (finishing soonest first),
  // then non-running profiles in their original order.
  const sortByEta = useMemo(() => {
    return (profiles: RunProfile[]): RunProfile[] => {
      const now = Date.now();
      const running: { profile: RunProfile; eta: number }[] = [];
      const rest: RunProfile[] = [];

      for (const p of profiles) {
        const vs = currentVisualState(p.id);
        if (vs === 'running') {
          const runInstanceId = currentRun(p.id).runInstanceId;
          const startTs =
            (runInstanceId ? runStartTimestamps[runInstanceId] : undefined) ??
            runStartTimestamps[p.id] ??
            now;
          const elapsed = now - startTs;
          const history = runHistory[p.id] ?? [];
          const eta = estimateRemaining(history, elapsed);
          // null ETA (insufficient data) sorts to end of running group
          running.push({ profile: p, eta: eta ?? Infinity });
        } else {
          rest.push(p);
        }
      }

      running.sort((a, b) => a.eta - b.eta);
      return [...running.map((r) => r.profile), ...rest];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- etaTick forces re-sort when ETA estimates update
  }, [currentRun, currentVisualState, runHistory, runStartTimestamps, etaTick]);

  // Apply ETA sort BEFORE grouping so running-soonest profiles bubble up within
  // their section (groupProfiles preserves input order for activated/pinned/detected).
  const sortedVisible = useMemo(() => sortByEta(visibleProfiles), [visibleProfiles, sortByEta]);
  const grouped = useMemo(
    () => groupProfiles(sortedVisible, runProfileState, { viewMode, activeWorkspaceId }),
    [sortedVisible, runProfileState, viewMode, activeWorkspaceId]
  );

  const renderCard = (profile: RunProfile, section: SectionGroup['key']) => {
    const execution = currentRun(profile.id);
    const ordinaryOutput = execution.runInstanceId
      ? runOutputs[execution.runInstanceId]
      : undefined;
    const compoundRun =
      runCompounds[compoundIdByRunInstance[latestRunInstanceIdByProfile[profile.id]]];
    // A compound never produces an ordinary RunOutput (its output lives in
    // stepOutputs), so synthesize the card-facing view from the aggregate run.
    // The aggregate carries no entries — matching the pre-Phase-2A card — but it
    // does carry state + exitCode, which the card needs for the failed/stop UI.
    const runOutput: RunOutput | undefined =
      ordinaryOutput ??
      (compoundRun
        ? {
            profileId: profile.id,
            runInstanceId: compoundRun.runInstanceId,
            state: compoundRun.state,
            exitCode: compoundRun.exitCode ?? 0,
            entries: [],
          }
        : undefined);
    const vs = currentVisualState(profile.id);
    const isDormant = !runOutput && !runHistory[profile.id]?.length;
    const isDuplicate = (nameCounts.get(profile.name) ?? 0) > 1;
    // Drives both the "Run another" affordance (room for one more) and the
    // concurrency badge (more than one live), so it is counted once.
    const liveRunCount = (runInstanceIdsByProfile[profile.id] ?? []).filter((id) =>
      isLiveRunState(runOutputs[id]?.state)
    ).length;

    return (
      <RunProfileCard
        key={profile.id}
        profile={profile}
        visualState={vs}
        runOutput={runOutput}
        runHistory={runHistory[profile.id] ?? []}
        isDormant={isDormant}
        isDuplicate={isDuplicate}
        section={section}
        isSelectedTarget={effectiveTargetId === profile.id}
        canRunAnother={profile.type === 'single' && liveRunCount === 1}
        liveRunCount={liveRunCount}
        isFreshestRun={
          grouped.freshestRunId === profile.id &&
          isJustRan(runProfileState[profile.id]?.lastRunAt, nowMs)
        }
        onFocusOutput={focusProfileOutput}
      />
    );
  };

  const renderSection = (g: SectionGroup, collapseDetected: boolean) => {
    if (collapseDetected && g.key === 'detected') {
      return (
        <details key={g.key} className={styles.group}>
          <summary className={styles.groupLabel}>
            {SECTION_LABEL[g.key]} <span className={styles.sectionCount}>{g.profiles.length}</span>
          </summary>
          {g.profiles.map((p) => renderCard(p, g.key))}
        </details>
      );
    }
    return (
      <div key={g.key} className={styles.group}>
        <span className={styles.groupLabel}>
          {SECTION_LABEL[g.key]} <span className={styles.sectionCount}>{g.profiles.length}</span>
        </span>
        {g.profiles.map((p) => renderCard(p, g.key))}
      </div>
    );
  };

  // Counter scoped to the current view: running count + total.
  const scopedProfiles = useMemo(
    () =>
      viewMode === 'workspace'
        ? visibleProfiles.filter((p) => (p.workspaceId ?? '') === activeWorkspaceId)
        : visibleProfiles,
    [visibleProfiles, viewMode, activeWorkspaceId]
  );
  // Running count for an arbitrary profile list (used for both the global header
  // counter and the per-workspace group counter in Project View).
  const countRunning = (list: RunProfile[]): number =>
    list.filter((p) => currentVisualState(p.id) === 'running').length;
  const runningCount = countRunning(scopedProfiles);
  const totalCountScoped = scopedProfiles.length;

  // Per-workspace running·total for Project-View group headers. Flatten the
  // group's section profiles so the counter reflects that workspace only.
  const groupCounts = (wg: WorkspaceGroup): { running: number; total: number } => {
    const groupProfilesList = wg.sections.flatMap((s) => s.profiles);
    return { running: countRunning(groupProfilesList), total: groupProfilesList.length };
  };

  const hideableProfiles = useMemo(
    () =>
      viewMode === 'workspace'
        ? profiles.filter((p) => (p.workspaceId ?? '') === activeWorkspaceId)
        : profiles,
    [profiles, viewMode, activeWorkspaceId]
  );

  // Derive hidden count from intersection with the *view-scoped* profile set so a
  // hidden profile in another workspace doesn't inflate the Workspace-View count.
  const hiddenCount = useMemo(() => {
    const profileIds = new Set(hideableProfiles.map((p) => p.id));
    return hiddenProfileIds.filter((id) => profileIds.has(id)).length;
  }, [hideableProfiles, hiddenProfileIds]);

  const title = (
    <>
      Run Profiles
      {runningCount > 0 && <span className={styles.runningCount}>● {runningCount} running</span>}
      <span className={styles.totalCount}>{totalCountScoped} total</span>
      {hiddenCount > 0 && <span className={styles.hiddenCount}>({hiddenCount} hidden)</span>}
    </>
  );

  // View-aware "nothing to show" gate. The active workspace may have zero
  // profiles while other workspaces have some, so we can't gate on the global
  // visible list — that left Workspace View blank. Gate on the rendered set.
  const isViewEmpty =
    viewMode === 'project' ? grouped.workspaceGroups.length === 0 : grouped.sections.length === 0;

  return (
    <Panel
      title={title}
      actions={
        runProfileForm ? null : (
          <>
            <TreeViewToggle ariaLabel="Run profiles view" />
            <button
              type="button"
              className={styles.createButton}
              onClick={() => openRunProfileForm({ mode: 'create' })}
              aria-label="New profile"
              title="New profile"
            >
              +
            </button>
          </>
        )
      }
    >
      {runProfileForm ? (
        <RunProfileForm state={runProfileForm} />
      ) : (
        <div className={styles.list}>
          {isLoading ? (
            <div className={styles.empty}>
              <p>Loading profiles...</p>
            </div>
          ) : error ? (
            <div className={styles.empty}>
              <p className={styles.errorText}>{error}</p>
              <button type="button" className={styles.createButton} onClick={reloadRunProfiles}>
                Retry
              </button>
            </div>
          ) : isViewEmpty ? (
            <RunProfilesEmpty />
          ) : viewMode === 'project' ? (
            grouped.workspaceGroups.map((wg) => {
              const counts = groupCounts(wg);
              const accent = workspaces.find((w) => w.id === wg.workspaceId)?.accent;
              return (
                <div
                  key={wg.workspaceId}
                  className={styles.workspaceGroup}
                  style={
                    { ['--region-accent' as string]: accentVar(accent) } as React.CSSProperties
                  }
                >
                  <div className={styles.workspaceHeader}>
                    <span
                      className={styles.workspaceDot}
                      style={{ background: accentVar(accent) }}
                    />
                    <span className={styles.workspaceName}>{wg.workspaceName}</span>
                    {counts.running > 0 && (
                      <span className={styles.runningCount}>● {counts.running} running</span>
                    )}
                    <span className={styles.groupTotal}>· {counts.total}</span>
                  </div>
                  {wg.sections.map((s) => renderSection(s, true))}
                </div>
              );
            })
          ) : (
            grouped.sections.map((s) => renderSection(s, false))
          )}
          <HiddenSection profiles={hideableProfiles} hiddenProfileIds={hiddenProfileIds} />
        </div>
      )}
    </Panel>
  );
}

function HiddenSection({
  profiles,
  hiddenProfileIds,
}: {
  profiles: RunProfile[];
  hiddenProfileIds: string[];
}) {
  const unhideProfile = useIDEStore((s) => s.unhideProfile);
  const hidden = profiles.filter((p) => hiddenProfileIds.includes(p.id));
  if (hidden.length === 0) return null;
  return (
    <details className={styles.group}>
      <summary className={styles.groupLabel}>
        Hidden <span className={styles.sectionCount}>{hidden.length}</span>
      </summary>
      {hidden.map((p) => (
        <div key={p.id} className={styles.hiddenRow}>
          <div className={styles.hiddenName}>{p.name}</div>
          <button
            type="button"
            className={styles.hiddenShow}
            onClick={() => unhideProfile(p.id)}
            aria-label={`Show ${p.name}`}
          >
            Show
          </button>
        </div>
      ))}
    </details>
  );
}

function RunProfilesEmpty() {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyText}>No profiles detected.</span>
      <span className={styles.emptyHint}>
        Add a profile with <strong>+</strong> or open a project with package.json, go.mod, or
        Makefile.
      </span>
    </div>
  );
}
