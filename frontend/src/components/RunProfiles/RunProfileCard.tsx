import { useState, useEffect } from 'react';
import { StatusBadge } from './StatusBadge';
import { ExpandedPanel } from './ExpandedPanel';
import { getTagColor } from '../../utils/tagColors';
import { formatDuration } from '../../utils/formatDuration';
import { PlayIcon, StopIcon, RestartIcon, LoaderIcon } from '../icons';
import {
  PinRunProfile,
  UnpinRunProfile,
  SetActiveVariant,
  AdoptRunProfile,
  UnadoptRunProfile,
} from '../../wails/bindings';
import { useIDEStore } from '../../stores/ideStore';
import { useProfileActions } from '../../hooks/useProfileActions';
import type { RunProfile } from '../../types/runProfile';
import type { VisualState, RunHistoryEntry, RunOutput } from '../../types/runOutput';
import type { ProfileSection } from '../../utils/groupProfiles';
import styles from './RunProfileCard.module.css';

/**
 * Custom hook for a live elapsed timer. Returns elapsed ms since startTs.
 * Returns 0 when startTs is undefined (not running).
 */
function useElapsedTimer(startTs: number | undefined): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTs) {
      setElapsed(0); // eslint-disable-line react-hooks/set-state-in-effect -- reset is intentional on dependency change
      return;
    }
    // Initial value + interval — all managed in one effect
    setElapsed(Date.now() - startTs);
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTs);
    }, 1000);
    return () => clearInterval(interval);
  }, [startTs]);

  return startTs ? elapsed : 0;
}

interface RunProfileCardProps {
  profile: RunProfile;
  visualState: VisualState;
  runOutput: RunOutput | undefined;
  runHistory: RunHistoryEntry[];
  isDormant: boolean;
  isDuplicate: boolean;
  onFocusOutput: (profileId: string) => void;
  section?: ProfileSection;
  isFreshestRun?: boolean;
  isSelectedTarget?: boolean;
  canRunAnother?: boolean;
  /** Live ordinary executions for this profile. Only >1 is rendered. */
  liveRunCount?: number;
}

function getStateClass(visualState: VisualState): string {
  switch (visualState) {
    case 'running':
      return styles.running;
    case 'stopping':
      return styles.stopping;
    case 'failed':
      return styles.failed;
    case 'success':
      return styles.success;
    default:
      return '';
  }
}

function getDurationLabel(
  visualState: VisualState,
  elapsed: number,
  runHistory: RunHistoryEntry[],
  runOutput: RunOutput | undefined,
  isDormant: boolean
): string {
  if (isDormant) return '';

  switch (visualState) {
    case 'running':
      return formatDuration(elapsed);
    case 'stopping':
      return '';
    case 'failed':
      return runOutput !== undefined ? `exit ${runOutput.exitCode}` : '';
    case 'success': {
      const last = runHistory[runHistory.length - 1];
      return last ? formatDuration(last.duration) : '';
    }
    case 'stopped':
      return '';
    case 'idle': {
      const last = runHistory[runHistory.length - 1];
      return last ? formatDuration(last.duration) : '';
    }
    default:
      return '';
  }
}

export function RunProfileCard({
  profile,
  visualState,
  runOutput,
  runHistory,
  isDormant,
  isDuplicate,
  onFocusOutput,
  section,
  isFreshestRun,
  isSelectedTarget,
  canRunAnother,
  liveRunCount = 0,
}: RunProfileCardProps) {
  const addOrUpdateProfile = useIDEStore((s) => s.addOrUpdateProfile);
  const showToast = useIDEStore((s) => s.showToast);
  const openRunProfileForm = useIDEStore((s) => s.openRunProfileForm);

  const startTs = useIDEStore(
    (s) => s.runStartTimestamps[runOutput?.runInstanceId ?? ''] ?? s.runStartTimestamps[profile.id]
  );
  const stopRequestTs = useIDEStore(
    (s) =>
      s.stopRequestTimestamps[runOutput?.runInstanceId ?? ''] ?? s.stopRequestTimestamps[profile.id]
  );

  const isRunningOrStopping = visualState === 'running' || visualState === 'stopping';
  const computedElapsed = useElapsedTimer(isRunningOrStopping ? startTs : undefined);
  const computedStopElapsed = useElapsedTimer(
    visualState === 'stopping' ? stopRequestTs : undefined
  );

  // Shared action handlers — used by both inline action button and ExpandedPanel
  const {
    start: handleStart,
    stop: handleStop,
    restart: handleRestart,
  } = useProfileActions(profile);

  const handleEdit = () => openRunProfileForm({ mode: 'edit', profile });

  const handlePin = () => {
    PinRunProfile(profile.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Failed to pin "${profile.name}": ${message}`, 'error');
    });
  };

  const handleUnpin = () => {
    UnpinRunProfile(profile.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`Failed to unpin "${profile.name}": ${message}`, 'error');
    });
  };

  const handleHide = () => {
    useIDEStore.getState().hideProfile(profile.id);
  };

  const handleAdopt = () => {
    useIDEStore.getState().adoptProfileLocal(profile.id);
    AdoptRunProfile(profile.id).catch((err: unknown) => {
      useIDEStore.getState().unadoptProfileLocal(profile.id);
      showToast(
        `Failed to adopt "${profile.name}": ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    });
  };

  const handleUnadopt = () => {
    useIDEStore.getState().unadoptProfileLocal(profile.id);
    UnadoptRunProfile(profile.id).catch((err: unknown) => {
      useIDEStore.getState().adoptProfileLocal(profile.id);
      showToast(
        `Failed to remove "${profile.name}": ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    });
  };

  const handleSelectTarget = (e: React.MouseEvent) => {
    e.stopPropagation();
    useIDEStore.getState().setSelectedProfile(profile.id);
  };

  const envVariants = (profile.envVariants ?? []).filter((variant) => variant.name);
  const hasEnvVariants = envVariants.length > 0;

  const handleVariantChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    const nextVariant = e.currentTarget.value;

    SetActiveVariant(profile.id, nextVariant)
      .then(() => {
        addOrUpdateProfile({ ...profile, activeVariant: nextVariant });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`Failed to switch "${profile.name}" env: ${message}`, 'error');
      });
  };

  const isActiveState =
    visualState === 'running' || visualState === 'stopping' || visualState === 'failed';

  const [manualExpanded, setManualExpanded] = useState(false);
  // Manual expand only applies to non-active states; active states use forceExpand
  const isExpanded = !isActiveState && manualExpanded;

  const handleCardClick = () => {
    // Clicking anywhere on the card selects it as the Cmd+R target...
    useIDEStore.getState().setSelectedProfile(profile.id);
    // ...and toggles the expanded detail. Active states force-expand via CSS, so
    // manual toggling only applies to non-active cards — including dormant
    // (never-run) ones, so their Edit/Pin/Hide actions are reachable without
    // having to run the profile first.
    if (!isActiveState) {
      setManualExpanded((prev) => !prev);
    }
  };

  const handleActionClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (visualState === 'idle' || visualState === 'success') {
      handleStart();
    } else if (visualState === 'running') {
      handleStop();
    } else if (visualState === 'stopped' || visualState === 'failed') {
      handleRestart();
    }
  };

  const durationLabel = getDurationLabel(
    visualState,
    computedElapsed,
    runHistory,
    runOutput,
    isDormant
  );

  const cardClassName = [
    styles.card,
    getStateClass(visualState),
    isDormant ? styles.dormant : '',
    isActiveState ? styles.forceExpand : '',
    !isActiveState && isExpanded ? styles.expanded : '',
    isFreshestRun ? styles.justRan : '',
    isSelectedTarget ? styles.selectedTarget : '',
  ]
    .filter(Boolean)
    .join(' ');

  function renderActionButton() {
    if (visualState === 'stopping') {
      return (
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.actionBtnLoading}`}
          disabled
          aria-label="Stopping"
          tabIndex={-1}
        >
          <LoaderIcon aria-hidden="true" />
        </button>
      );
    }

    if (visualState === 'running') {
      return (
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.actionBtnStop}`}
          onClick={handleActionClick}
          aria-label={`Stop ${profile.name}`}
        >
          <StopIcon aria-hidden="true" />
        </button>
      );
    }

    if (visualState === 'stopped' || visualState === 'failed') {
      return (
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.actionBtnRestart}`}
          onClick={handleActionClick}
          aria-label={`Restart ${profile.name}`}
        >
          <RestartIcon aria-hidden="true" />
        </button>
      );
    }

    // idle / success
    return (
      <button
        type="button"
        className={`${styles.actionBtn} ${styles.actionBtnPlay}`}
        onClick={handleActionClick}
        aria-label={`Run ${profile.name}`}
      >
        <PlayIcon aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      className={cardClassName}
      onClick={handleCardClick}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          handleCardClick();
        }
      }}
      role="button"
      aria-label={profile.name}
    >
      {/* Row 1: action button + name + duration */}
      <div className={styles.row1}>
        <button
          type="button"
          className={`${styles.targetToggle} ${isSelectedTarget ? styles.targetToggleOn : ''}`}
          onClick={handleSelectTarget}
          aria-pressed={isSelectedTarget ? true : false}
          aria-label={
            isSelectedTarget ? `Run target: ${profile.name}` : `Set as run target: ${profile.name}`
          }
          title="Cmd+R target"
        >
          <span className={styles.targetDot} aria-hidden="true" />
        </button>
        {renderActionButton()}
        {canRunAnother && (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnPlay}`}
            onClick={(event) => {
              event.stopPropagation();
              handleStart();
            }}
            aria-label={`Run another ${profile.name}`}
          >
            <PlayIcon aria-hidden="true" />
          </button>
        )}
        <span className={styles.name}>{profile.name}</span>
        <StatusBadge visualState={visualState} profile={profile} runHistory={runHistory} />
        {/* With concurrent executions the card's status reflects the newest run
            only, and its Stop targets that run alone. Without this the surviving
            sibling makes a successful Stop look like it did nothing. */}
        {liveRunCount > 1 && <span className={styles.runCountChip}>{liveRunCount} running</span>}
        {isFreshestRun && <span className={styles.justRanChip}>just ran</span>}
        {durationLabel && <span className={styles.duration}>{durationLabel}</span>}
        {(section === 'recent' || section === 'detected') && (
          <button
            type="button"
            className={styles.adoptBtn}
            onClick={(e) => {
              e.stopPropagation();
              handleAdopt();
            }}
            aria-label={`Adopt ${profile.name}`}
          >
            <span aria-hidden="true">+</span> adopt
          </button>
        )}
      </div>

      {/* Row 2: command line */}
      {profile.command && (
        <div className={styles.cmd}>
          {profile.command}
          {isDuplicate && profile.detectedFrom && (
            <span className={styles.cmdSource}>{profile.detectedFrom}</span>
          )}
        </div>
      )}

      {/* Row 3: tags and env selector */}
      {((profile.tags && profile.tags.length > 0) || hasEnvVariants) && (
        <div className={styles.rowBottom}>
          {profile.tags && profile.tags.length > 0 && (
            <div className={styles.tags}>
              {profile.tags.map((tag) => {
                const color = getTagColor(tag);
                return (
                  <span
                    key={tag}
                    className={styles.tag}
                    style={{ background: color.background, color: color.text }}
                  >
                    {tag}
                  </span>
                );
              })}
            </div>
          )}
          {hasEnvVariants && (
            <label
              className={styles.variantSelector}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className={styles.variantLabel}>env</span>
              <select
                className={styles.variantSelect}
                value={profile.activeVariant ?? ''}
                onChange={handleVariantChange}
                aria-label={`${profile.name} environment variant`}
              >
                <option value="">base</option>
                {envVariants.map((variant) => (
                  <option key={variant.name} value={variant.name}>
                    {variant.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {/* Hover reveal — expanded on hover/focus */}
      <div className={styles.hoverReveal}>
        <ExpandedPanel
          profile={profile}
          visualState={visualState}
          runOutput={runOutput}
          runHistory={runHistory}
          elapsed={computedElapsed}
          stopElapsedMs={computedStopElapsed}
          onFocusOutput={onFocusOutput}
          onStart={handleStart}
          onStop={handleStop}
          onRestart={handleRestart}
          onPin={handlePin}
          onUnpin={handleUnpin}
          onHide={handleHide}
          onEdit={handleEdit}
          onUnadopt={section === 'activated' ? handleUnadopt : undefined}
        />
      </div>
    </div>
  );
}
