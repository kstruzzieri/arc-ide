/** Sentinel value for the "All Profiles" virtual tab in Timeline view */
export const ALL_PROFILES_ID = '__all__';

/**
 * Namespace marker separating an archived run selection from a live
 * runInstanceId. `activeRunOutputId` holds both, so every reader has to agree on
 * one spelling of the prefix.
 */
export const HISTORY_PREFIX = 'history:';

/** Selection id for an archived run, as stored in `activeRunOutputId`. */
export function historySelectionId(historyId: string): string {
  return `${HISTORY_PREFIX}${historyId}`;
}

/** The archived run a selection names, or undefined for a live/virtual tab. */
export function historyIdFromSelection(selection: string | null | undefined): string | undefined {
  return selection?.startsWith(HISTORY_PREFIX) ? selection.slice(HISTORY_PREFIX.length) : undefined;
}

/** Max entries per retained ordinary execution or compound step before FIFO truncation */
export const MAX_OUTPUT_ENTRIES = 10_000;

/** Retained ordinary executions per profile (current + predecessor for Diff) */
export const MAX_RETAINED_RUNS = 2;

/** Raw event payload from backend (chunk-oriented, may split/merge lines) */
export interface OutputChunk {
  runInstanceId: string;
  profileId: string;
  parentRunInstanceId?: string;
  stepIdx: number;
  launchSeq?: number;
  workspaceEpoch?: number;
  stream: 'stdout' | 'stderr';
  data: string;
  timestamp: number;
}

/** Stored entry (line-oriented, always one complete line per entry) */
export interface OutputEntry {
  stream: 'stdout' | 'stderr';
  text: string;
  timestamp: number;
}

export type RunState = 'idle' | 'running' | 'stopped' | 'failed' | 'success';

export interface RunHistoryEntry {
  state: 'success' | 'failed' | 'stopped';
  duration: number; // milliseconds
  timestamp: number; // when run completed (UnixMilli)
}

export type VisualState = RunState | 'stopping';

export type RunOutputViewMode = 'merged' | 'lanes' | 'diff' | 'timeline';

/** Payload of the run:status event (top-level runs and compound aggregates). */
export interface RunStatusEvent {
  runInstanceId: string;
  profileId: string;
  parentRunInstanceId?: string;
  stepIdx: number;
  launchSeq?: number;
  workspaceEpoch?: number;
  state: RunState;
  exitCode: number;
  timestamp?: number;
  reason?: string;
}

export interface RunOutput {
  profileId: string;
  runInstanceId: string;
  launchSeq?: number;
  workspaceEpoch?: number;
  workingDir?: string;
  state: RunState;
  exitCode: number;
  entries: OutputEntry[];
  /**
   * The live buffer dropped older entries at MAX_OUTPUT_ENTRIES, so `entries` is
   * a suffix of what the run produced. Carried into the archived record so a
   * partial log is never presented (or diffed) as a complete one.
   */
  truncated?: boolean;
}

export interface FoldedRegion {
  kind: 'fold';
  id: string;
  summary: string;
  lineCount: number;
  entries: OutputEntry[];
}

export type FoldedItem = OutputEntry | FoldedRegion;

export function isFoldedRegion(item: FoldedItem): item is FoldedRegion {
  return (item as FoldedRegion).kind === 'fold';
}

export type CompoundStepState =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'stopped';

export interface CompoundStep {
  idx: number;
  runInstanceId: string;
  profileId: string;
  name: string;
  state: CompoundStepState;
  exitCode: number;
  workingDir: string;
  durationMs: number;
  startedAt?: number;
  endedAt?: number;
  errorMessage?: string;
}

export interface CompoundRun {
  compoundId: string;
  runInstanceId: string;
  launchSeq?: number;
  workspaceEpoch?: number;
  name: string;
  state: RunState;
  /** Aggregate exit code; meaningful once `state` is terminal (from run:status). */
  exitCode?: number;
  currentStep: number;
  etaMs?: number;
  steps: CompoundStep[];
  stepOutputs: Record<number, OutputEntry[]>;
  selectedStepIdx?: number;
  failedReference?: { stepIdx: number; path: string; line: number; column: number };
}

export interface CompoundRunEvent {
  runInstanceId: string;
  compoundId: string;
  launchSeq?: number;
  workspaceEpoch?: number;
  name: string;
  state: RunState;
  currentStep: number;
  steps: CompoundStep[];
  reason?: string;
}
