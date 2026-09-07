import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { MergedView } from '../RunOutput/MergedView';
import { SourceTimelineView } from '../RunOutput/SourceTimelineView';
import type { TimelineSource } from '../RunOutput/SourceTimelineView';
import { resolveFileReferencePath } from '../../utils/parseFileReferences';
import { useIDEStore, useWorkspace, useRunOutputAutoScroll } from '../../stores/ideStore';
import { stopProfile } from '../../utils/profileActions';
import type { CompoundRun, CompoundStep, CompoundStepState } from '../../types/runOutput';
import styles from './CompoundExecutionView.module.css';

interface CompoundExecutionViewProps {
  compound: CompoundRun;
}

interface CompoundViewState {
  compoundId: string;
  selectedStepIdx: number;
  tab: 'stages' | 'all';
  expandedFolds: Set<string>;
}

const STATE_LABELS: Record<CompoundStepState, string> = {
  pending: 'Pending',
  running: 'Running',
  success: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
  stopped: 'Stopped',
};

/** Format a millisecond duration as `Nms` (sub-second) or `Ns` (>= 1s). */
function formatStepDuration(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 1000)}s`;
}

/** Format the compound ETA as `~Ns`. */
function formatEta(ms: number): string {
  return `~${Math.round(ms / 1000)}s`;
}

function initialSelectedStepIdx(compound: CompoundRun): number {
  return compound.steps.find((s) => s.state === 'running')?.idx ?? compound.steps[0]?.idx ?? 0;
}

function createInitialViewState(compoundId: string, selectedStepIdx: number): CompoundViewState {
  return {
    compoundId,
    selectedStepIdx,
    tab: 'stages',
    expandedFolds: new Set(),
  };
}

function initialViewState(compound: CompoundRun): CompoundViewState {
  return createInitialViewState(compound.compoundId, initialSelectedStepIdx(compound));
}

function moveTabFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  if (target.getAttribute('role') !== 'tab') return;

  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const index = tabs.indexOf(target);
  let next: number | null = null;

  switch (event.key) {
    case 'ArrowRight':
      next = index < tabs.length - 1 ? index + 1 : 0;
      break;
    case 'ArrowLeft':
      next = index > 0 ? index - 1 : tabs.length - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = tabs.length - 1;
      break;
  }

  if (next !== null) {
    event.preventDefault();
    tabs[next]?.focus();
  }
}

export function CompoundExecutionView({ compound }: CompoundExecutionViewProps) {
  const workspace = useWorkspace();
  const workspacePath = workspace?.path;
  const autoScroll = useRunOutputAutoScroll();
  const runControlsDisabled = useIDEStore((s) => s.runEventsPaused || s.isLoadingProfiles);
  const requestEditorNavigation = useIDEStore((s) => s.requestEditorNavigation);
  const defaultSelectedStepIdx = initialSelectedStepIdx(compound);
  const currentInitialViewState = useMemo(
    () => createInitialViewState(compound.compoundId, defaultSelectedStepIdx),
    [compound.compoundId, defaultSelectedStepIdx]
  );

  const [viewState, setViewState] = useState<CompoundViewState>(() => initialViewState(compound));
  const isCurrentCompound = viewState.compoundId === compound.compoundId;
  const selectedStepIdx = isCurrentCompound ? viewState.selectedStepIdx : defaultSelectedStepIdx;
  const tab = isCurrentCompound ? viewState.tab : 'stages';
  const expandedFolds = isCurrentCompound ? viewState.expandedFolds : new Set<string>();

  const runningStepIdx = compound.steps.find((s) => s.state === 'running')?.idx;
  const isAggregateFailed = compound.state === 'failed';
  const firstFailedStepIdx = compound.steps.find((s) => s.state === 'failed')?.idx;

  const setSelectedStage = useCallback(
    (stepIdx: number) => {
      setViewState((prev) => {
        const base = prev.compoundId === compound.compoundId ? prev : currentInitialViewState;
        if (base.compoundId === compound.compoundId && base.selectedStepIdx === stepIdx) {
          return base;
        }
        return { ...base, selectedStepIdx: stepIdx };
      });
    },
    [compound.compoundId, currentInitialViewState]
  );

  const setCompoundTab = useCallback(
    (nextTab: 'stages' | 'all') => {
      setViewState((prev) => {
        const base = prev.compoundId === compound.compoundId ? prev : currentInitialViewState;
        if (base.compoundId === compound.compoundId && base.tab === nextTab) {
          return base;
        }
        return { ...base, tab: nextTab };
      });
    },
    [compound.compoundId, currentInitialViewState]
  );

  // Auto-select the running stage when a step transitions to running.
  useEffect(() => {
    if (runningStepIdx !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional auto-follow of the active step
      setSelectedStage(runningStepIdx);
    }
  }, [runningStepIdx, setSelectedStage]);

  // Auto-select the first failed stage when the compound aggregate fails.
  useEffect(() => {
    if (isAggregateFailed && firstFailedStepIdx !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional jump to the failed step
      setSelectedStage(firstFailedStepIdx);
    }
  }, [isAggregateFailed, firstFailedStepIdx, setSelectedStage]);

  const selectedStep: CompoundStep | undefined = compound.steps.find(
    (s) => s.idx === selectedStepIdx
  );
  const selectedEntries = compound.stepOutputs[selectedStepIdx] ?? [];

  const handleToggleFold = useCallback(
    (foldId: string) => {
      setViewState((prev) => {
        const base = prev.compoundId === compound.compoundId ? prev : currentInitialViewState;
        const next = new Set(base.expandedFolds);
        if (next.has(foldId)) {
          next.delete(foldId);
        } else {
          next.add(foldId);
        }
        return { ...base, expandedFolds: next };
      });
    },
    [compound.compoundId, currentInitialViewState]
  );

  const handleStop = () => {
    stopProfile(compound.compoundId, compound.name);
  };

  const handleJumpToFailure = () => {
    if (!compound.failedReference) return;
    const failedStep = compound.steps.find((s) => s.idx === compound.failedReference!.stepIdx);
    const resolvedPath = resolveFileReferencePath(
      compound.failedReference.path,
      failedStep?.workingDir,
      workspacePath
    );
    requestEditorNavigation(
      resolvedPath,
      compound.failedReference.line,
      compound.failedReference.column
    );
  };

  const timelineSources: TimelineSource[] = useMemo(
    () =>
      compound.steps.map((step) => ({
        id: String(step.idx),
        label: step.name,
        workingDir: step.workingDir,
        entries: compound.stepOutputs[step.idx] ?? [],
      })),
    [compound.steps, compound.stepOutputs]
  );

  return (
    <div className={styles.compoundRoot}>
      <div className={styles.header}>
        <span className={styles.headerName}>{compound.name}</span>
        <span className={styles.headerBadge} data-state={compound.state}>
          {compound.state}
        </span>
        {compound.etaMs !== undefined && (
          <span className={styles.eta}>{formatEta(compound.etaMs)}</span>
        )}
        <span className={styles.headerSpacer} />
        <div className={styles.headerActions}>
          {compound.failedReference && (
            <button
              type="button"
              className={`${styles.actionButton} ${styles.jumpButton}`}
              onClick={handleJumpToFailure}
            >
              Jump to failure
            </button>
          )}
          {compound.state === 'running' && (
            <button
              type="button"
              className={`${styles.actionButton} ${styles.stopButton}`}
              onClick={handleStop}
              disabled={runControlsDisabled}
              aria-label={`Stop ${compound.name}`}
            >
              Stop
            </button>
          )}
        </div>
      </div>

      <div className={styles.tabBar}>
        <div
          className={styles.tabGroup}
          role="tablist"
          aria-label="Compound output view"
          onKeyDown={moveTabFocus}
        >
          <button
            type="button"
            id="compound-stages-tab"
            role="tab"
            aria-selected={tab === 'stages'}
            aria-controls="compound-output-panel"
            tabIndex={tab === 'stages' ? 0 : -1}
            className={styles.tabButton}
            onClick={() => setCompoundTab('stages')}
          >
            Stages
          </button>
          <button
            type="button"
            id="compound-all-tab"
            role="tab"
            aria-selected={tab === 'all'}
            aria-controls="compound-output-panel"
            tabIndex={tab === 'all' ? 0 : -1}
            className={styles.tabButton}
            onClick={() => setCompoundTab('all')}
          >
            All steps
          </button>
        </div>
      </div>

      {tab === 'stages' ? (
        <div
          id="compound-output-panel"
          className={styles.compoundBody}
          role="tabpanel"
          aria-labelledby="compound-stages-tab"
          tabIndex={0}
        >
          <div className={styles.stageList}>
            {compound.steps.map((step) => {
              const duration = formatStepDuration(step.durationMs);
              const isSelected = step.idx === selectedStepIdx;
              return (
                <button
                  type="button"
                  key={step.idx}
                  className={`${styles.stageRow} ${isSelected ? styles.selected : ''}`}
                  data-state={step.state}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => setSelectedStage(step.idx)}
                >
                  <span className={styles.stageDot} data-state={step.state} aria-hidden="true" />
                  <span className={styles.stageInfo}>
                    <span className={styles.stageName}>{step.name}</span>
                    <span className={styles.stageMeta}>
                      <span className={styles.stageState} data-state={step.state}>
                        {STATE_LABELS[step.state]}
                      </span>
                      {duration && <span className={styles.stageDuration}>{duration}</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className={styles.stageOutput}>
            {selectedEntries.length === 0 && selectedStep?.errorMessage ? (
              <div className={styles.stageError}>{selectedStep.errorMessage}</div>
            ) : (
              <MergedView
                entries={selectedEntries}
                autoScroll={autoScroll}
                expandedFolds={expandedFolds}
                onToggleFold={handleToggleFold}
                workingDir={selectedStep?.workingDir}
                workspacePath={workspacePath}
              />
            )}
          </div>
        </div>
      ) : (
        <div
          id="compound-output-panel"
          className={styles.allBody}
          role="tabpanel"
          aria-labelledby="compound-all-tab"
          tabIndex={0}
        >
          <SourceTimelineView
            sources={timelineSources}
            autoScroll={autoScroll}
            workspacePath={workspacePath}
            emptyMessage="No output yet"
          />
        </div>
      )}
    </div>
  );
}
