import { useMemo } from 'react';
import styles from './StatusBar.module.css';
import { StatusBranchIcon, CheckIcon, AlertCircleIcon } from '../icons';
import { useActiveFile, useCursorPosition } from '../../stores/ideStore';
import { useGitBranchInfo, useGitStore } from '../../stores/gitStore';
import { useGolemStore } from '../../stores/golemStore';
import { computeProblemsSeverityTotals } from '../../stores/lspStore';
import { useProblemsProjection } from '../../hooks/useProblemsProjection';
import { showGolem } from '../../utils/commands';
import { EditorThemePicker } from './EditorThemePicker';

export function StatusBar() {
  const { branch, ahead, behind } = useGitBranchInfo();
  // Same conflict-aware projection as the Problems tab, so both surfaces of
  // the window chrome agree during a merge: unresolved conflict regions count
  // as warnings and the conflicted file's raw diagnostics are suppressed.
  const problems = useProblemsProjection();
  const {
    errors: errorCount,
    warnings: warningCount,
    info: infoCount,
  } = useMemo(() => computeProblemsSeverityTotals(problems), [problems]);
  const activeFile = useActiveFile();
  const cursorPosition = useCursorPosition();

  // The git segment is a control, not a label: clicking the branch opens the
  // always-visible header branch switcher; the arrows push/pull directly.
  const handleBranchClick = () => {
    useGitStore.getState().requestBranchPopupFocus();
  };

  return (
    <>
      <div className={styles.left}>
        {branch && (
          <span className={styles.item}>
            <button
              type="button"
              className={styles.segmentBtn}
              onClick={handleBranchClick}
              aria-label={`Branch: ${branch}. Open branch switcher`}
              title="Switch branch"
            >
              <StatusBranchIcon aria-hidden="true" />
              <span>{branch}</span>
            </button>
            {ahead > 0 && (
              <button
                type="button"
                className={`${styles.segmentBtn} ${styles.aheadBehind}`}
                onClick={() => void useGitStore.getState().push()}
                aria-label={`Push ${ahead} outgoing ${ahead === 1 ? 'commit' : 'commits'}`}
                title="Push"
              >
                {`↑${ahead}`}
              </button>
            )}
            {behind > 0 && (
              <button
                type="button"
                className={`${styles.segmentBtn} ${styles.aheadBehind}`}
                onClick={() => void useGitStore.getState().pull()}
                aria-label={`Pull ${behind} incoming ${behind === 1 ? 'commit' : 'commits'}`}
                title="Pull"
              >
                {`↓${behind}`}
              </button>
            )}
          </span>
        )}
        <DiagnosticsIndicator errors={errorCount} warnings={warningCount} info={infoCount} />
      </div>
      <div className={styles.spacer} />
      <div className={styles.right}>
        <GolemIndicator />
        <EditorThemePicker />
        {activeFile && (
          <>
            <span className={styles.item}>{activeFile.language || 'Plain Text'}</span>
            <span className={styles.item}>{activeFile.encoding || 'UTF-8'}</span>
            <span className={styles.item}>
              Ln {cursorPosition.line}, Col {cursorPosition.column}
            </span>
          </>
        )}
      </div>
    </>
  );
}

/**
 * The persistent Golem segment (#226 Task B8).
 *
 * Always mounted, because it is the only Golem surface that survives a
 * collapsed right panel or Runs mode — background activity in another
 * workspace would otherwise have nowhere to be seen.
 */
function GolemIndicator() {
  const conversations = useGolemStore((state) => state.conversations);
  const lastActiveConversationId = useGolemStore((state) => state.lastActiveConversationId);
  const activityRevision = useGolemStore((state) => state.activityRevision);
  const lastFailureConversationId = useGolemStore((state) => state.lastFailureConversationId);
  const failureRevision = useGolemStore((state) => state.failureRevision);
  const selectedConversationId = useGolemStore((state) => state.selectedConversationId);

  const { label, state, conversationId } = useMemo(() => {
    let canceling = 0;
    let live = 0;
    let cancelingOwner: string | null = null;
    let liveOwner: string | null = null;
    let approvalOwner: string | null = null;
    let failureOwner: string | null = null;
    const cancelingOwners = new Set<string>();
    const liveOwners = new Set<string>();
    const approvalOwners = new Set<string>();
    const failureOwners = new Set<string>();
    for (const [id, conversation] of Object.entries(conversations)) {
      for (const run of Object.values(conversation.runs)) {
        if (run.phase === 'canceling') {
          canceling += 1;
          cancelingOwner = cancelingOwner ?? id;
          cancelingOwners.add(id);
        } else if (run.phase === 'running' || run.phase === 'admitting') {
          live += 1;
          liveOwner = liveOwner ?? id;
          liveOwners.add(id);
        } else if (run.phase === 'needs-consent') {
          approvalOwner = approvalOwner ?? id;
          approvalOwners.add(id);
        }
      }
      // A failed run is the signal in its own right. `lastFailedTurn` exists to
      // power Retry, so it is set only for a turn this client sent and holds the
      // request for; a run that died in the background carries neither, and
      // reading only that field would report Idle over a dead run.
      // ponytail: a status-hydrated failure carries no retryable request, so it
      // clears from here only when the workspace itself recovers.
      if (
        !conversation.available ||
        conversation.initError !== null ||
        conversation.lastFailedTurn ||
        Object.values(conversation.runs).some((run) => run.phase === 'failed')
      ) {
        failureOwner = failureOwner ?? id;
        failureOwners.add(id);
      }
    }

    // Fixed priority: canceling, approval, running, past failure, then idle.
    if (canceling > 0) {
      const active = activityRevision > 0 ? lastActiveConversationId : null;
      const target = active !== null && cancelingOwners.has(active) ? active : cancelingOwner;
      return { label: 'Canceling', state: 'active', conversationId: target };
    }

    if (approvalOwner !== null) {
      const active = activityRevision > 0 ? lastActiveConversationId : null;
      const target = active !== null && approvalOwners.has(active) ? active : approvalOwner;
      return { label: 'Approval needed', state: 'attention', conversationId: target };
    }

    if (live > 0) {
      const active = activityRevision > 0 ? lastActiveConversationId : null;
      // `lastActiveConversationId` names the conversation that moved last, which
      // is not always one that is still running: activating the segment must
      // open a conversation the count is actually about.
      const target = active !== null && liveOwners.has(active) ? active : liveOwner;
      return { label: `${live} running`, state: 'active', conversationId: target };
    }

    // Resolved independently of activity: the conversation that last failed is
    // not always the one that last ran. Mirrors the live path above —
    // `lastFailureConversationId` only picks WHICH failure to open when several
    // qualify, so a recovered latest failure cannot hide an older one.
    if (failureOwner !== null) {
      const failed = failureRevision > 0 ? lastFailureConversationId : null;
      const target = failed !== null && failureOwners.has(failed) ? failed : failureOwner;
      return { label: 'Attention', state: 'attention', conversationId: target };
    }

    return { label: 'Idle', state: 'idle', conversationId: selectedConversationId };
  }, [
    conversations,
    lastActiveConversationId,
    activityRevision,
    lastFailureConversationId,
    failureRevision,
    selectedConversationId,
  ]);

  return (
    <span className={styles.item}>
      <button
        type="button"
        className={styles.segmentBtn}
        data-golem-state={state}
        // Deliberately state-only: a repository root or a provider endpoint has
        // no business being read out of the window chrome.
        aria-label={`Golem: ${label}. Open the Golem panel`}
        title="Open Golem"
        onClick={() => showGolem(conversationId ?? undefined)}
      >
        <span>Golem: {label}</span>
      </button>
    </span>
  );
}

interface DiagnosticsIndicatorProps {
  errors: number;
  warnings: number;
  info: number;
}

function DiagnosticsIndicator({ errors, warnings, info }: DiagnosticsIndicatorProps) {
  const hasIssues = errors > 0 || warnings > 0 || info > 0;

  return (
    <span className={`${styles.item} ${errors > 0 ? styles.error : ''}`}>
      {hasIssues ? (
        <>
          <AlertCircleIcon aria-hidden="true" />
          <span>{formatDiagnosticsSummary(errors, warnings, info)}</span>
        </>
      ) : (
        <>
          <CheckIcon aria-hidden="true" />
          <span>No issues</span>
        </>
      )}
    </span>
  );
}

function formatDiagnosticsSummary(errors: number, warnings: number, info: number): string {
  const parts: string[] = [];

  if (errors > 0) {
    parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
  }
  if (warnings > 0) {
    parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
  }
  if (info > 0) {
    parts.push(`${info} info`);
  }

  return parts.join(', ');
}
