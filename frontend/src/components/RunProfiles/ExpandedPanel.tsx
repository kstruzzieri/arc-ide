import { useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { VisualState, RunOutput, RunHistoryEntry, OutputEntry } from '../../types/runOutput';
import type { RunProfile } from '../../types/runProfile';
import { PlayIcon, StopIcon, RestartIcon } from '../icons';
import { formatDuration } from '../../utils/formatDuration';
import { estimateRemaining } from '../../utils/estimateCompletion';
import styles from './ExpandedPanel.module.css';

const GRACE_PERIOD_MS = 3000;

/**
 * Number of trailing output lines kept in the in-card preview. The preview is
 * scrollable (~10 lines visible at a time) and clicking it opens the full,
 * virtualized output tab — so this only needs enough scrollback to be useful.
 * Kept modest on purpose: the preview is NOT virtualized and re-renders on every
 * output burst of a live run, so a large tail would multiply reconciliation cost
 * on the streaming hot path. Deep history lives in the virtualized Output tab.
 */
const PREVIEW_TAIL_COUNT = 40;

/**
 * Compute stop-progress as a clamped 0-100 integer.
 */
export function getStopProgressPercent(elapsedSinceStop: number, gracePeriod: number): number {
  return Math.max(0, Math.min(100, Math.round((elapsedSinceStop / gracePeriod) * 100)));
}

export interface ExpandedPanelProps {
  profile: RunProfile;
  visualState: VisualState;
  runOutput: RunOutput | undefined;
  runHistory: RunHistoryEntry[];
  elapsed: number;
  stopElapsedMs: number;
  onFocusOutput: (profileId: string) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onHide: () => void;
  onEdit?: () => void;
  onUnadopt?: () => void;
}

/* ── Helpers ──────────────────────────────────────────────────── */

function getTailEntries(entries: OutputEntry[] | undefined, count: number): OutputEntry[] {
  if (!entries || entries.length === 0) return [];
  return entries.slice(-count);
}

function OutputTail({
  entries,
  profileName,
  onActivate,
}: {
  entries: OutputEntry[];
  profileName?: string;
  onActivate?: () => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    preview.scrollTop = preview.scrollHeight;
  }, [entries]);

  if (entries.length === 0) return null;

  const interactiveProps = onActivate
    ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': `Open full output${profileName ? ` for ${profileName}` : ''}`,
        title: 'Open full output',
        onClick: () => {
          // Don't hijack the click when the user is drag-selecting text to copy
          // (e.g. an error line) — only navigate on a plain click.
          if ((window.getSelection()?.toString().length ?? 0) > 0) return;
          onActivate();
        },
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onActivate();
          }
        },
      }
    : {};

  const className = [styles.outputPreview, onActivate ? styles.outputPreviewClickable : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={previewRef} className={className} {...interactiveProps}>
      {entries.map((entry, i) => (
        <div
          key={i}
          className={entry.stream === 'stderr' ? styles.outputStderr : styles.outputLine}
        >
          {entry.text}
        </div>
      ))}
    </div>
  );
}

function StatsRow({
  elapsed,
  durationLabel,
  profile,
  runHistory,
  resultLabel,
  eta,
}: {
  elapsed: number;
  durationLabel?: string;
  profile: RunProfile;
  runHistory: RunHistoryEntry[];
  resultLabel?: string;
  eta?: number | null;
}) {
  const avgDuration =
    runHistory.length > 0
      ? runHistory.reduce((sum, h) => sum + h.duration, 0) / runHistory.length
      : 0;

  return (
    <div className={styles.statRow}>
      <div className={styles.stat}>
        <span className={styles.statLabel}>{durationLabel ?? 'Elapsed'}</span>
        <span className={styles.statValueHl}>{formatDuration(elapsed)}</span>
      </div>
      {profile.workingDir && (
        <div className={styles.stat}>
          <span className={styles.statLabel}>Dir</span>
          <span className={styles.statValue}>{profile.workingDir}</span>
        </div>
      )}
      {runHistory.length > 0 && (
        <div className={styles.stat}>
          <span className={styles.statLabel}>Avg</span>
          <span className={styles.statValue}>{formatDuration(avgDuration)}</span>
        </div>
      )}
      <div className={styles.stat}>
        <span className={styles.statLabel}>Runs</span>
        <span className={styles.statValue}>{runHistory.length}</span>
      </div>
      {eta !== null && eta !== undefined && (
        <span className={styles.stat}>
          <span className={styles.statLabel}>ETA</span>
          <span className={styles.statValue}>
            {eta === 0 ? 'overrunning' : `~${formatDuration(eta)} left`}
          </span>
        </span>
      )}
      {resultLabel && (
        <div className={styles.stat}>
          <span className={styles.statLabel}>Result</span>
          <span className={styles.statValue}>{resultLabel}</span>
        </div>
      )}
    </div>
  );
}

/* ── Sub-panels ───────────────────────────────────────────────── */

function RunningPanel({
  profile,
  runOutput,
  runHistory,
  elapsed,
  onFocusOutput,
}: {
  profile: RunProfile;
  runOutput: RunOutput | undefined;
  runHistory: RunHistoryEntry[];
  elapsed: number;
  onFocusOutput: (profileId: string) => void;
}) {
  const tail = getTailEntries(runOutput?.entries, PREVIEW_TAIL_COUNT);
  const eta = estimateRemaining(runHistory, elapsed);
  return (
    <>
      <OutputTail
        entries={tail}
        profileName={profile.name}
        onActivate={() => onFocusOutput(profile.id)}
      />
      <StatsRow elapsed={elapsed} profile={profile} runHistory={runHistory} eta={eta} />
    </>
  );
}

function StoppingPanel({
  profile,
  runOutput,
  runHistory,
  elapsed,
  stopElapsedMs,
  onFocusOutput,
}: {
  profile: RunProfile;
  runOutput: RunOutput | undefined;
  runHistory: RunHistoryEntry[];
  elapsed: number;
  stopElapsedMs: number;
  onFocusOutput: (profileId: string) => void;
}) {
  const progress = getStopProgressPercent(stopElapsedMs, GRACE_PERIOD_MS);
  const remainingMs = Math.max(0, GRACE_PERIOD_MS - stopElapsedMs);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const tail = getTailEntries(runOutput?.entries, PREVIEW_TAIL_COUNT);

  return (
    <>
      <div className={styles.stopProgress}>
        <div className={styles.stopLabel}>
          <span>Sending SIGTERM...</span>
          <span className={styles.stopHint}>force-kill in {remainingSeconds}s</span>
        </div>
        <div className={styles.stopBar}>
          <div
            className={styles.stopFill}
            style={{ width: `${progress}%` }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          />
        </div>
      </div>
      <OutputTail
        entries={tail}
        profileName={profile.name}
        onActivate={() => onFocusOutput(profile.id)}
      />
      <StatsRow elapsed={elapsed} profile={profile} runHistory={runHistory} />
    </>
  );
}

function FailedPanel({
  profile,
  runOutput,
  runHistory,
  elapsed,
  onFocusOutput,
}: {
  profile: RunProfile;
  runOutput: RunOutput | undefined;
  runHistory: RunHistoryEntry[];
  elapsed: number;
  onFocusOutput: (profileId: string) => void;
}) {
  const exitCode = runOutput?.exitCode;
  const tail = getTailEntries(runOutput?.entries, PREVIEW_TAIL_COUNT);

  return (
    <>
      <div className={styles.errorDetail}>
        <div className={styles.errorHeader}>
          <span className={styles.errorCode}>
            {exitCode !== undefined ? `Exit ${exitCode}` : 'Process terminated'}
          </span>
          <span className={styles.errorLabel}>Process failed</span>
        </div>
      </div>
      <OutputTail
        entries={tail}
        profileName={profile.name}
        onActivate={() => onFocusOutput(profile.id)}
      />
      <StatsRow
        elapsed={runHistory[runHistory.length - 1]?.duration ?? elapsed}
        durationLabel="Duration"
        profile={profile}
        runHistory={runHistory}
      />
    </>
  );
}

function DormantPanel({ profile }: { profile: RunProfile }) {
  return (
    <div className={styles.dormantInfo}>
      {profile.detectedFrom && (
        <div className={styles.dormantRow}>
          <span className={styles.dormantLabel}>Source</span>
          <span className={styles.dormantValue}>{profile.detectedFrom}</span>
        </div>
      )}
      {!profile.detectedFrom && profile.source === 'user' && (
        <div className={styles.dormantRow}>
          <span className={styles.dormantLabel}>Source</span>
          <span className={styles.dormantValue}>User-defined</span>
        </div>
      )}
      {profile.workingDir && (
        <div className={styles.dormantRow}>
          <span className={styles.dormantLabel}>Dir</span>
          <span className={styles.dormantValue}>{profile.workingDir}</span>
        </div>
      )}
      {profile.command && (
        <div className={styles.dormantRow}>
          <span className={styles.dormantLabel}>Command</span>
          <span className={styles.dormantValue}>{profile.command}</span>
        </div>
      )}
      <div className={styles.dormantRow}>
        <span className={styles.dormantValue}>Never run — click play to start</span>
      </div>
    </div>
  );
}

function getResultLabel(lastEntry: RunHistoryEntry | undefined): string | undefined {
  if (!lastEntry) return undefined;
  switch (lastEntry.state) {
    case 'success':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Cancelled';
    default:
      return undefined;
  }
}

function IdlePanel({
  profile,
  runOutput,
  runHistory,
  elapsed,
  onFocusOutput,
}: {
  profile: RunProfile;
  runOutput: RunOutput | undefined;
  runHistory: RunHistoryEntry[];
  elapsed: number;
  onFocusOutput: (profileId: string) => void;
}) {
  const lastEntry = runHistory[runHistory.length - 1];
  const resultLabel = getResultLabel(lastEntry);
  const tail = getTailEntries(runOutput?.entries, PREVIEW_TAIL_COUNT);

  return (
    <>
      <OutputTail
        entries={tail}
        profileName={profile.name}
        onActivate={() => onFocusOutput(profile.id)}
      />
      <StatsRow
        elapsed={lastEntry?.duration ?? elapsed}
        durationLabel="Duration"
        profile={profile}
        runHistory={runHistory}
        resultLabel={resultLabel}
      />
    </>
  );
}

function SuccessPanel({
  profile,
  runOutput,
  runHistory,
  elapsed,
  onFocusOutput,
}: {
  profile: RunProfile;
  runOutput: RunOutput | undefined;
  runHistory: RunHistoryEntry[];
  elapsed: number;
  onFocusOutput: (profileId: string) => void;
}) {
  const tail = getTailEntries(runOutput?.entries, PREVIEW_TAIL_COUNT);
  return (
    <>
      <OutputTail
        entries={tail}
        profileName={profile.name}
        onActivate={() => onFocusOutput(profile.id)}
      />
      <StatsRow
        elapsed={runHistory[runHistory.length - 1]?.duration ?? elapsed}
        durationLabel="Duration"
        profile={profile}
        runHistory={runHistory}
      />
    </>
  );
}

function StoppedPanel({ profile }: { profile: RunProfile }) {
  return (
    <div className={styles.dormantInfo}>
      <div className={styles.dormantRow}>
        <span className={styles.dormantLabel}>Status</span>
        <span className={styles.dormantValue}>Cancelled</span>
      </div>
      {profile.workingDir && (
        <div className={styles.dormantRow}>
          <span className={styles.dormantLabel}>Dir</span>
          <span className={styles.dormantValue}>{profile.workingDir}</span>
        </div>
      )}
    </div>
  );
}

/* ── Actions ──────────────────────────────────────────────────── */

function ActionsRow({
  profile,
  visualState,
  hasOutput,
  onFocusOutput,
  onStart,
  onStop,
  onRestart,
  onPin,
  onUnpin,
  onHide,
  onEdit,
  onUnadopt,
}: {
  profile: RunProfile;
  visualState: VisualState;
  hasOutput: boolean;
  onFocusOutput: (profileId: string) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onHide: () => void;
  onEdit?: () => void;
  onUnadopt?: () => void;
}) {
  const isRunningOrStopping = visualState === 'running' || visualState === 'stopping';
  const isStopping = visualState === 'stopping';
  const isTerminal = visualState === 'failed' || visualState === 'stopped';

  return (
    <div className={styles.actions}>
      {isRunningOrStopping ? (
        <>
          <button
            type="button"
            className={styles.actionDanger}
            onClick={onStop}
            disabled={isStopping}
            aria-label={`Stop ${profile.name}`}
          >
            <StopIcon /> {isStopping ? 'Stopping\u2026' : 'Stop'}
          </button>
          <button
            type="button"
            className={styles.actionPurple}
            onClick={onRestart}
            disabled={isStopping}
            aria-label={`Restart ${profile.name}`}
          >
            <RestartIcon /> Restart
          </button>
        </>
      ) : isTerminal ? (
        <button
          type="button"
          className={styles.actionPurple}
          onClick={onRestart}
          aria-label={`Restart ${profile.name}`}
        >
          <RestartIcon /> Restart
        </button>
      ) : (
        <button
          type="button"
          className={styles.actionPrimary}
          onClick={onStart}
          aria-label={`Start ${profile.name}`}
        >
          <PlayIcon /> Run
        </button>
      )}
      {hasOutput && (
        <button
          type="button"
          className={styles.actionGhost}
          onClick={() => onFocusOutput(profile.id)}
          aria-label={`View output ${profile.name}`}
        >
          Output
        </button>
      )}
      <span className={styles.spacer} />
      {onUnadopt && (
        <button
          type="button"
          className={styles.actionGhost}
          onClick={onUnadopt}
          aria-label={`Remove ${profile.name} from working set`}
        >
          Remove
        </button>
      )}
      {profile.source === 'detected' ? (
        <button
          type="button"
          className={styles.actionGhost}
          onClick={onPin}
          aria-label={`Pin ${profile.name}`}
        >
          Pin
        </button>
      ) : (
        <button
          type="button"
          className={styles.actionGhost}
          onClick={onUnpin}
          aria-label={`Unpin ${profile.name}`}
        >
          Unpin
        </button>
      )}
      {onEdit && profile.type === 'single' && (
        <button
          type="button"
          className={styles.actionGhost}
          onClick={onEdit}
          aria-label={`${profile.source === 'detected' ? 'Customize' : 'Edit'} ${profile.name}`}
        >
          {profile.source === 'detected' ? 'Customize' : 'Edit'}
        </button>
      )}
      <button
        type="button"
        className={styles.actionGhost}
        onClick={onHide}
        aria-label={`Hide ${profile.name}`}
      >
        Hide
      </button>
    </div>
  );
}

/* ── Main Component ───────────────────────────────────────────── */

export function ExpandedPanel({
  profile,
  visualState,
  runOutput,
  runHistory,
  elapsed,
  stopElapsedMs,
  onFocusOutput,
  onStart,
  onStop,
  onRestart,
  onPin,
  onUnpin,
  onHide,
  onEdit,
  onUnadopt,
}: ExpandedPanelProps) {
  function renderPanel() {
    switch (visualState) {
      case 'running':
        return (
          <RunningPanel
            profile={profile}
            runOutput={runOutput}
            runHistory={runHistory}
            elapsed={elapsed}
            onFocusOutput={onFocusOutput}
          />
        );
      case 'stopping': {
        // If backend state is not 'running', this is a restart of a dead process,
        // not an actual SIGTERM sequence — show a simpler restarting indicator
        const isRealStop = runOutput?.state === 'running';
        return isRealStop ? (
          <StoppingPanel
            profile={profile}
            runOutput={runOutput}
            runHistory={runHistory}
            elapsed={elapsed}
            stopElapsedMs={stopElapsedMs}
            onFocusOutput={onFocusOutput}
          />
        ) : (
          <div className={styles.statRow}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Status</span>
              <span className={styles.statValueHl}>Restarting&hellip;</span>
            </div>
          </div>
        );
      }
      case 'failed':
        return (
          <FailedPanel
            profile={profile}
            runOutput={runOutput}
            runHistory={runHistory}
            elapsed={elapsed}
            onFocusOutput={onFocusOutput}
          />
        );
      case 'success':
        return (
          <SuccessPanel
            profile={profile}
            runOutput={runOutput}
            runHistory={runHistory}
            elapsed={elapsed}
            onFocusOutput={onFocusOutput}
          />
        );
      case 'stopped':
        return <StoppedPanel profile={profile} />;
      case 'idle':
        if (runHistory.length === 0) {
          return <DormantPanel profile={profile} />;
        }
        return (
          <IdlePanel
            profile={profile}
            runOutput={runOutput}
            runHistory={runHistory}
            elapsed={elapsed}
            onFocusOutput={onFocusOutput}
          />
        );
      default:
        return null;
    }
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      {renderPanel()}
      <ActionsRow
        profile={profile}
        visualState={visualState}
        hasOutput={runOutput !== undefined && runOutput.entries.length > 0}
        onFocusOutput={onFocusOutput}
        onStart={onStart}
        onStop={onStop}
        onRestart={onRestart}
        onPin={onPin}
        onUnpin={onUnpin}
        onHide={onHide}
        onEdit={onEdit}
        onUnadopt={onUnadopt}
      />
    </div>
  );
}
