import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { filesystem, runhistory, workspace } from '../wails/bindings';
import type { RunProfile, RunProfileUIState } from '../types/runProfile';
import type { FormState } from '../utils/runProfileForm';
import { LineAssembler } from '../utils/lineAssembler';
import {
  DEFAULT_CENTER_LAYOUT,
  initialCenterReveal,
  type CenterLayoutPrefs,
  type CenterOrder,
  type CenterPanel,
} from '../utils/centerLayout';
import type {
  CompoundRun,
  CompoundRunEvent,
  OutputChunk,
  OutputEntry,
  RunHistoryEntry,
  RunOutput,
  RunState,
  RunStatusEvent,
  RunOutputViewMode,
} from '../types/runOutput';
import {
  MAX_OUTPUT_ENTRIES,
  MAX_RETAINED_RUNS,
  ALL_PROFILES_ID,
  historyIdFromSelection,
} from '../types/runOutput';
import { estimateDuration, estimateRemaining } from '../utils/estimateCompletion';
import { parseFileReferences } from '../utils/parseFileReferences';
import { pathsReferToSameFile } from '../utils/lspUri';
import { replaceChildrenAt } from '../utils/replaceChildrenAt';
import { preserveLoadedChildren } from '../utils/preserveLoadedChildren';
import { findEntryByPath } from '../utils/findEntryByPath';
import {
  type SyntaxThemeId,
  DEFAULT_SYNTAX_THEME_ID,
  isSyntaxThemeId,
} from '../components/Editor/codemirror/palettes';

const SYNTAX_THEME_STORAGE_KEY = 'firn.editorSyntaxTheme';

export function loadInitialSyntaxTheme(): SyntaxThemeId {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(SYNTAX_THEME_STORAGE_KEY) : null;
    return isSyntaxThemeId(raw) ? raw : DEFAULT_SYNTAX_THEME_ID;
  } catch {
    return DEFAULT_SYNTAX_THEME_ID;
  }
}

// Types
export type SidebarView = 'explorer' | 'search' | 'git' | 'run' | 'structure';
export type TerminalTab = 'terminal' | 'output' | 'problems';
// Named per workspace type, matching the --accent-* tokens and the accent
// strings emitted by internal/workspace/detect.go. Re-exported from
// utils/accent, which owns the one tuple the type and the runtime lookup are
// both derived from. 'rust' is accepted so the palette is complete; nothing
// emits it until Cargo.toml detection lands.
import type { WorkspaceAccent } from '../utils/accent';
export type { WorkspaceAccent };

// Re-export FileEntry for convenience
export type FileEntry = filesystem.FileEntry;

export interface WorkspaceInfo {
  name: string;
  path: string;
}

export interface EditorFile {
  id: string;
  name: string;
  path: string;
  language: string;
  encoding: string;
  lineEndings: string;
  content: string;
  isModified: boolean;
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface TerminalSession {
  id: string;
  title: string;
}

export interface EditorNavigationRequest {
  fileId: string;
  line: number;
  column: number;
  revision: number;
}

export interface NavigationLocation {
  fileId: string;
  line: number;
  column: number;
}

const MAX_NAVIGATION_HISTORY = 50;

const defaultPanelSizes = {
  left: 260,
  right: 280,
  bottom: 200,
  golem: DEFAULT_CENTER_LAYOUT.golemWidth,
};

function createDefaultWorkspaceSessionState() {
  return {
    activeSidebarView: 'explorer' as SidebarView,
    isLeftPanelCollapsed: false,
    isRightPanelCollapsed: false,
    isBottomPanelCollapsed: false,
    panelSizes: { ...defaultPanelSizes },
    // #271 center pair. Preferences persist per repository session; centerReveal
    // is the transient "which center panel was explicitly requested" target
    // that the effective-layout budget protects under window pressure.
    centerOrder: DEFAULT_CENTER_LAYOUT.centerOrder as CenterOrder,
    isGolemPanelCollapsed: DEFAULT_CENTER_LAYOUT.isGolemPanelCollapsed,
    isFilesPanelCollapsed: DEFAULT_CENTER_LAYOUT.isFilesPanelCollapsed,
    centerReveal: 'files' as CenterPanel,
    centerDrag: null as CenterPanel | null,
    openFiles: [] as EditorFile[],
    activeFileId: null as string | null,
    cursorPosition: { line: 1, column: 1 },
    scrollPositions: {} as Record<string, number>,
    cursorPositions: {} as Record<string, CursorPosition>,
    expandedPaths: new Set<string>(),
    loadingPaths: new Set<string>(),
    dirtyPaths: new Set<string>(),
    selectedPath: null as string | null,
    isRootExpanded: true,
    // Cleared here rather than in resetWorkspaceRunState: the workspace switch
    // flush serializes the outgoing workspace synchronously, and that runs
    // after openWorkspaceByPath but before this restore reset. Clearing any
    // earlier would persist an empty list under the workspace being left.
    hiddenProfileIds: [] as string[],
    pendingEditorNavigation: null as EditorNavigationRequest | null,
    navigationHistory: [] as NavigationLocation[],
    navigationForward: [] as NavigationLocation[],
  };
}

interface IDEState {
  // Workspace
  workspace: WorkspaceInfo | null;
  isLoading: boolean;

  // Workspace identity (#53)
  workspaces: workspace.WorkspaceDef[];
  activeWorkspaceId: string;
  lastFocusedWorkspaceId: string | null;

  // File Explorer
  directoryTree: filesystem.FileEntry[];
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  dirtyPaths: Set<string>;
  selectedPath: string | null;
  isRootExpanded: boolean;
  isLoadingTree: boolean;
  treeError: string | null;

  // Sidebar
  activeSidebarView: SidebarView;

  // Panel visibility and sizes
  isLeftPanelCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  isBottomPanelCollapsed: boolean;
  panelSizes: { left: number; right: number; bottom: number; golem: number };
  // #271 center pair
  centerOrder: CenterOrder;
  isGolemPanelCollapsed: boolean;
  isFilesPanelCollapsed: boolean;
  centerReveal: CenterPanel;
  /** Panel currently being dragged for reorder; never persisted. */
  centerDrag: CenterPanel | null;

  // Editor
  openFiles: EditorFile[];
  activeFileId: string | null;
  cursorPosition: CursorPosition;

  // Toast
  toast: { message: string; type: 'error' | 'info' } | null;

  // Terminal
  activeTerminalTab: TerminalTab;
  terminalSessions: TerminalSession[];
  activeTerminalSessionId: string | null;
  workingDirectory: string;

  // Run Profiles
  runProfiles: RunProfile[];
  runProfileState: Record<string, RunProfileUIState>;
  // Run-profile create/edit form view-state (null = list view)
  runProfileForm: FormState;
  isLoadingProfiles: boolean;
  profilesError: string | null;
  /** Bumped to re-run the run-profile loader after a failed load. */
  profilesReloadNonce: number;
  // Header selector: session-only single Cmd+R target. Not persisted; the
  // effective target re-resolves from recency on launch (see resolveEffectiveRunTarget).
  selectedProfileId: string | null;

  // Run Output
  runOutputs: Record<string, RunOutput>;
  runInstanceIdsByProfile: Record<string, string[]>;
  runLaunchSeqByInstance: Record<string, number>;
  discardedRunLaunchSeqsByProfile: Record<string, number[]>;
  discardedThroughLaunchSeqByProfile: Record<string, number>;
  workspaceEpoch: number;
  runEventsPaused: boolean;
  // Explicit current-execution pointer per profile. May point at an id already
  // removed from runOutputs — that dangling value is the deliberate "cleared
  // tab" tombstone that keeps late events from resurrecting a run or falling
  // back to a predecessor (see clearRunOutput / appendRunOutput guards).
  latestRunInstanceIdByProfile: Record<string, string>;
  runCompounds: Record<string, CompoundRun>;
  compoundIdByRunInstance: Record<string, string>; // aggregate runInstanceId -> compoundId
  activeRunOutputId: string | null;
  runOutputViewMode: RunOutputViewMode;
  runOutputAutoScroll: boolean;

  // Process lifecycle UI
  stoppingProfileIds: string[];
  restartingProfileIds: string[];
  stoppingRunInstanceIds: string[];
  restartingRunInstanceIds: string[];
  runHistory: Record<string, RunHistoryEntry[]>;
  runHistorySummaries: Record<string, runhistory.Summary>;
  runHistoryRecords: Record<string, runhistory.Summary | runhistory.Record>;
  waveformData: Record<string, number[]>;
  hiddenProfileIds: string[];
  runStartTimestamps: Record<string, number>;
  stopRequestTimestamps: Record<string, number>;

  // Per-file view state (for persistence)
  scrollPositions: Record<string, number>; // fileId -> scrollTop
  cursorPositions: Record<string, CursorPosition>; // fileId -> cursor

  // Workspace persistence
  isRestoringWorkspace: boolean;

  // Recent workspaces
  recentWorkspaces: workspace.Summary[];
  recentWorkspacesVersion: number;

  // Status
  editorSyntaxTheme: SyntaxThemeId;

  // Editor navigation
  pendingEditorNavigation: EditorNavigationRequest | null;

  // Navigation history (back/forward)
  navigationHistory: NavigationLocation[];
  navigationForward: NavigationLocation[];
}

interface IDEActions {
  // Workspace actions
  setWorkspace: (workspace: WorkspaceInfo | null) => void;
  setWorkspaces: (defs: workspace.WorkspaceDef[]) => void;
  setActiveWorkspace: (id: string) => void;
  setTreeViewMode: (mode: 'project' | 'workspace') => void;
  setLoading: (isLoading: boolean) => void;

  // File Explorer actions
  setDirectoryTree: (tree: filesystem.FileEntry[]) => void;
  mergeChildren: (path: string, children: FileEntry[]) => void;
  markUnreadable: (path: string) => void;
  toggleExpanded: (path: string) => void;
  addLoadingPath: (path: string) => void;
  removeLoadingPath: (path: string) => void;
  markDirty: (path: string) => void;
  clearDirty: (path: string) => void;
  setSelectedPath: (path: string | null) => void;
  toggleRootExpanded: () => void;
  setTreeLoading: (loading: boolean) => void;
  setTreeError: (error: string | null) => void;

  // Sidebar actions
  setSidebarView: (view: SidebarView) => void;

  // Panel actions
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleBottomPanel: () => void;
  setPanelSize: (panel: 'left' | 'right' | 'bottom' | 'golem', size: number) => void;
  // #271 center pair
  setCenterOrder: (order: CenterOrder) => void;
  swapCenterOrder: () => void;
  setGolemPanelCollapsed: (collapsed: boolean) => void;
  setFilesPanelCollapsed: (collapsed: boolean) => void;
  revealCenterPanel: (panel: CenterPanel) => void;
  applyCenterLayout: (prefs: CenterLayoutPrefs) => void;
  setCenterDrag: (panel: CenterPanel | null) => void;

  // Editor actions
  openFile: (file: EditorFile) => void;
  closeFile: (fileId: string) => void;
  setActiveFile: (fileId: string | null) => void;
  setCursorPosition: (position: CursorPosition) => void;
  setFileModified: (fileId: string, isModified: boolean) => void;
  updateFileContent: (fileId: string, content: string) => void;

  // Toast actions
  showToast: (message: string, type: 'error' | 'info') => void;
  clearToast: () => void;

  // Terminal actions
  setTerminalTab: (tab: TerminalTab) => void;
  addTerminalSession: (session: TerminalSession) => void;
  removeTerminalSession: (sessionId: string) => void;
  setActiveTerminalSession: (sessionId: string) => void;
  renameTerminalSession: (sessionId: string, title: string) => void;
  reorderTerminalSessions: (fromIndex: number, toIndex: number) => void;
  setWorkingDirectory: (path: string) => void;

  // Run Profile actions
  setRunProfilesSnapshot: (
    profiles: RunProfile[],
    profileState: Record<string, RunProfileUIState>,
    workspaceEpoch?: number,
    historySnapshot?: runhistory.Snapshot
  ) => void;
  setSelectedProfile: (id: string | null) => void;
  adoptProfileLocal: (id: string) => void;
  unadoptProfileLocal: (id: string) => void;
  setProfilesLoading: (loading: boolean) => void;
  setProfilesError: (error: string | null) => void;
  reloadRunProfiles: () => void;
  addOrUpdateProfile: (profile: RunProfile) => void;
  removeProfile: (id: string) => void;
  openRunProfileForm: (state: Exclude<FormState, null>) => void;
  closeRunProfileForm: () => void;

  // Run Output actions
  appendRunOutput: (chunk: OutputChunk) => boolean;
  handleRunStatus: (status: RunStatusEvent) => void;
  clearRunOutput: (runInstanceId: string) => void;
  clearAllRunOutputs: () => void;
  handleCompoundRun: (event: CompoundRunEvent) => void;
  appendCompoundRunOutput: (compoundId: string, stepIdx: number, chunk: OutputChunk) => void;
  clearCompoundRunOutput: (compoundId: string) => void;
  setActiveRunOutput: (id: string | null) => void;
  setRunOutputViewMode: (mode: RunOutputViewMode) => void;
  toggleAutoScroll: () => void;

  // Process lifecycle actions
  setProfileStopping: (profileId: string) => void;
  clearProfileStopping: (profileId: string) => void;
  setProfileRestarting: (profileId: string) => void;
  clearProfileRestarting: (profileId: string) => void;
  setRunStopping: (runInstanceId: string) => void;
  clearRunStopping: (runInstanceId: string) => void;
  setRunRestarting: (runInstanceId: string) => void;
  clearRunRestarting: (runInstanceId: string) => void;
  appendRunHistory: (profileId: string, entry: RunHistoryEntry) => void;
  updateWaveform: (profileId: string, entryCount: number) => void;
  hideProfile: (id: string) => void;
  unhideProfile: (id: string) => void;
  focusProfileOutput: (profileId: string) => void;
  pauseRunEvents: () => void;
  resetWorkspaceRunState: () => void;

  // Per-file view state actions
  setScrollPosition: (fileId: string, scrollTop: number) => void;
  setFileCursorPosition: (fileId: string, position: CursorPosition) => void;

  // Workspace persistence actions
  setRestoringWorkspace: (restoring: boolean) => void;
  resetWorkspaceSession: () => void;

  // Recent workspaces actions
  setRecentWorkspaces: (workspaces: workspace.Summary[]) => void;

  // Status actions
  setEditorSyntaxTheme: (id: SyntaxThemeId) => void;

  // Editor navigation actions
  requestEditorNavigation: (fileId: string, line: number, column: number) => void;
  clearPendingEditorNavigation: (fileId: string, revision: number) => void;

  // Navigation history actions
  pushNavigationHistory: (entry: NavigationLocation) => void;
  goBack: (current: NavigationLocation) => NavigationLocation | undefined;
  goForward: (current: NavigationLocation) => NavigationLocation | undefined;
}

type IDEStore = IDEState & IDEActions;

// Line assemblers are per-run-instance, stored outside Zustand (mutable, not serializable).
// Each assembler's emit callback is swappable so appendRunOutput can collect lines
// into a local array per chunk, then commit once to the store.
const lineAssemblers = new Map<string, LineAssembler>();
const assemblerCallbacks = new Map<string, (entry: OutputEntry) => void>();

function getOrCreateAssembler(
  runInstanceId: string,
  emitFn: (entry: OutputEntry) => void
): LineAssembler {
  assemblerCallbacks.set(runInstanceId, emitFn);
  let assembler = lineAssemblers.get(runInstanceId);
  if (!assembler) {
    assembler = new LineAssembler((entry) => {
      const cb = assemblerCallbacks.get(runInstanceId);
      if (cb) cb(entry);
    });
    lineAssemblers.set(runInstanceId, assembler);
  }
  return assembler;
}

// Canonical key for a compound step's line assembler. Used for BOTH routing
// step output into an assembler and flushing it on terminal, so the two always
// agree, keyed purely on (compoundId, stepIdx) with no dependency on any
// backend key encoding.
function compoundStepAssemblerKey(compoundId: string, stepIdx: number): string {
  return JSON.stringify([compoundId, stepIdx]);
}

function clearCompoundStepAssemblers(compoundId: string, steps: CompoundRun['steps']): void {
  for (const step of steps) {
    const key = compoundStepAssemblerKey(compoundId, step.idx);
    lineAssemblers.delete(key);
    assemblerCallbacks.delete(key);
  }
}

// Push a chunk through the assembler for `key` and return the complete lines it
// emitted. Shared by ordinary and compound output paths.
function collectChunkEntries(key: string, chunk: OutputChunk): OutputEntry[] {
  const pending: OutputEntry[] = [];
  const assembler = getOrCreateAssembler(key, (entry) => pending.push(entry));
  assembler.push(chunk.stream, chunk.data, chunk.timestamp);
  return pending;
}

// Flush any carry-over from the assembler for `key`, returning the flushed
// entries, then drop the assembler and its callback. No-op (empty) if absent.
function flushAssembler(key: string): OutputEntry[] {
  const flushed: OutputEntry[] = [];
  const assembler = lineAssemblers.get(key);
  if (!assembler) return flushed;
  assemblerCallbacks.set(key, (entry) => flushed.push(entry));
  assembler.flush();
  lineAssemblers.delete(key);
  assemblerCallbacks.delete(key);
  return flushed;
}

function getProfileWorkingDirSnapshot(
  state: Pick<IDEState, 'runProfiles'>,
  profileId: string
): string | undefined {
  return state.runProfiles.find((profile) => profile.id === profileId)?.workingDir;
}

function createRunOutput(
  profileId: string,
  runInstanceId: string,
  launchSeq: number,
  workspaceEpoch: number,
  workingDir?: string
): RunOutput {
  return {
    profileId,
    runInstanceId,
    launchSeq,
    workspaceEpoch,
    workingDir,
    state: 'idle',
    exitCode: 0,
    entries: [],
  };
}

// Caps the merged buffer and reports whether the cap actually dropped anything,
// so a run whose oldest output was discarded archives as partial.
function cappedRunEntries(
  existing: OutputEntry[],
  incoming: OutputEntry[],
  wasTruncated: boolean | undefined
): { entries: OutputEntry[]; truncated: boolean } {
  const combined = [...existing, ...incoming];
  const entries = capOutputEntries(combined);
  return { entries, truncated: wasTruncated === true || entries.length < combined.length };
}

function capOutputEntries(entries: OutputEntry[]): OutputEntry[] {
  if (entries.length <= MAX_OUTPUT_ENTRIES) return entries;
  const retained = entries.slice(entries.length - MAX_OUTPUT_ENTRIES + 1);
  retained.unshift({
    stream: 'stdout',
    text: '[truncated — oldest output removed]',
    timestamp: retained[0]?.timestamp ?? Date.now(),
  });
  return retained;
}

const isTerminalRunState = (state: RunState | undefined): boolean =>
  state === 'stopped' || state === 'failed' || state === 'success';

export const isLiveRunState = (state: RunState | undefined): boolean =>
  state === 'idle' || state === 'running';

const MAX_DISCARDED_RUN_SEQS = 50;

type RunIndexState = Pick<
  IDEState,
  'runOutputs' | 'runInstanceIdsByProfile' | 'runLaunchSeqByInstance'
>;

// The run indexes a workspace switch or a failed load must drop together. Kept
// as one helper so a newly added index cannot be cleared in one caller and
// missed in the other.
function emptyWorkspaceRunState() {
  return {
    selectedProfileId: null,
    runOutputs: {},
    runInstanceIdsByProfile: {},
    runLaunchSeqByInstance: {},
    discardedRunLaunchSeqsByProfile: {},
    discardedThroughLaunchSeqByProfile: {},
    latestRunInstanceIdByProfile: {},
    runCompounds: {},
    compoundIdByRunInstance: {},
    activeRunOutputId: null,
    stoppingProfileIds: [],
    restartingProfileIds: [],
    stoppingRunInstanceIds: [],
    restartingRunInstanceIds: [],
    runHistory: {},
    runHistorySummaries: {},
    runHistoryRecords: {},
    waveformData: {},
    runStartTimestamps: {},
    stopRequestTimestamps: {},
  } satisfies Partial<IDEState>;
}

/** Run instance ids for a profile, oldest launch first. */
export function orderedRunIds(state: RunIndexState, profileId: string): string[] {
  return [...(state.runInstanceIdsByProfile[profileId] ?? [])].sort(
    (a, b) =>
      (state.runLaunchSeqByInstance[a] ?? state.runOutputs[a]?.launchSeq ?? 0) -
      (state.runLaunchSeqByInstance[b] ?? state.runOutputs[b]?.launchSeq ?? 0)
  );
}

export function newestLiveRunInstanceId(
  state: RunIndexState,
  profileId: string
): string | undefined {
  return orderedRunIds(state, profileId)
    .reverse()
    .find((id) => isLiveRunState(state.runOutputs[id]?.state));
}

export function representativeRunInstanceId(
  state: RunIndexState,
  profileId: string
): string | undefined {
  return newestLiveRunInstanceId(state, profileId) ?? orderedRunIds(state, profileId).at(-1);
}

function nextLaunchSeq(state: Pick<IDEState, 'runLaunchSeqByInstance'>): number {
  return Math.max(0, ...Object.values(state.runLaunchSeqByInstance)) + 1;
}

function eventLaunchSeq(
  state: Pick<IDEState, 'runLaunchSeqByInstance'>,
  runInstanceId: string,
  launchSeq: number | undefined
): number {
  return state.runLaunchSeqByInstance[runInstanceId] ?? launchSeq ?? nextLaunchSeq(state);
}

function acceptsRunEvent(
  state: Pick<
    IDEState,
    | 'workspaceEpoch'
    | 'runEventsPaused'
    | 'runOutputs'
    | 'runInstanceIdsByProfile'
    | 'runLaunchSeqByInstance'
    | 'discardedRunLaunchSeqsByProfile'
    | 'discardedThroughLaunchSeqByProfile'
    | 'compoundIdByRunInstance'
  >,
  event: {
    runInstanceId: string;
    profileId: string;
    launchSeq?: number;
    workspaceEpoch?: number;
  }
): boolean {
  if (state.runEventsPaused) return false;
  if (event.workspaceEpoch != null && event.workspaceEpoch !== state.workspaceEpoch) return false;

  const retained =
    state.runOutputs[event.runInstanceId] != null ||
    state.runInstanceIdsByProfile[event.profileId]?.includes(event.runInstanceId) === true ||
    state.compoundIdByRunInstance[event.runInstanceId] != null;
  const knownSeq = state.runLaunchSeqByInstance[event.runInstanceId];
  if (retained) {
    return event.launchSeq == null || knownSeq == null || event.launchSeq === knownSeq;
  }

  const launchSeq = event.launchSeq ?? knownSeq;
  if (launchSeq == null) return true;
  if (state.discardedRunLaunchSeqsByProfile[event.profileId]?.includes(launchSeq)) return false;
  return launchSeq > (state.discardedThroughLaunchSeqByProfile[event.profileId] ?? 0);
}

function discardRunSeqs(
  state: Pick<
    IDEState,
    | 'runLaunchSeqByInstance'
    | 'discardedRunLaunchSeqsByProfile'
    | 'discardedThroughLaunchSeqByProfile'
  >,
  profileId: string,
  runInstanceIds: string[]
) {
  const additions = runInstanceIds
    .map((id) => state.runLaunchSeqByInstance[id])
    .filter((seq): seq is number => seq != null);
  if (additions.length === 0) {
    return {
      discardedRunLaunchSeqsByProfile: state.discardedRunLaunchSeqsByProfile,
      discardedThroughLaunchSeqByProfile: state.discardedThroughLaunchSeqByProfile,
    };
  }

  const seqs = [
    ...new Set([...(state.discardedRunLaunchSeqsByProfile[profileId] ?? []), ...additions]),
  ].sort((a, b) => a - b);
  const compacted = seqs.slice(-MAX_DISCARDED_RUN_SEQS);
  const removed = seqs.slice(0, -MAX_DISCARDED_RUN_SEQS);
  return {
    discardedRunLaunchSeqsByProfile: {
      ...state.discardedRunLaunchSeqsByProfile,
      [profileId]: compacted,
    },
    discardedThroughLaunchSeqByProfile: {
      ...state.discardedThroughLaunchSeqByProfile,
      [profileId]: Math.max(state.discardedThroughLaunchSeqByProfile[profileId] ?? 0, ...removed),
    },
  };
}

function retainRunOutput(
  state: Pick<
    IDEState,
    | 'runOutputs'
    | 'runInstanceIdsByProfile'
    | 'runLaunchSeqByInstance'
    | 'discardedRunLaunchSeqsByProfile'
    | 'discardedThroughLaunchSeqByProfile'
    | 'latestRunInstanceIdByProfile'
    | 'activeRunOutputId'
  >,
  output: RunOutput
) {
  const previousIds = state.runInstanceIdsByProfile[output.profileId] ?? [];
  const indexedIds = previousIds.includes(output.runInstanceId)
    ? previousIds
    : [...previousIds, output.runInstanceId];
  const runOutputs = { ...state.runOutputs, [output.runInstanceId]: output };
  const runLaunchSeqByInstance = {
    ...state.runLaunchSeqByInstance,
    [output.runInstanceId]: output.launchSeq ?? 0,
  };
  const orderedIds = [...indexedIds].sort(
    (a, b) => (runLaunchSeqByInstance[a] ?? 0) - (runLaunchSeqByInstance[b] ?? 0)
  );
  const prunedIds: string[] = [];
  while (orderedIds.length > MAX_RETAINED_RUNS) {
    const terminalIndex = orderedIds.findIndex((id) => isTerminalRunState(runOutputs[id]?.state));
    prunedIds.push(...orderedIds.splice(terminalIndex >= 0 ? terminalIndex : 0, 1));
  }
  const retainedIds = orderedIds;
  for (const runInstanceId of prunedIds) {
    delete runOutputs[runInstanceId];
    lineAssemblers.delete(runInstanceId);
    assemblerCallbacks.delete(runInstanceId);
  }
  const discarded = discardRunSeqs(
    {
      runLaunchSeqByInstance,
      discardedRunLaunchSeqsByProfile: state.discardedRunLaunchSeqsByProfile,
      discardedThroughLaunchSeqByProfile: state.discardedThroughLaunchSeqByProfile,
    },
    output.profileId,
    prunedIds
  );
  const previousLatest = state.latestRunInstanceIdByProfile[output.profileId];
  const previousLatestSeq =
    (previousLatest == null ? undefined : runLaunchSeqByInstance[previousLatest]) ??
    Math.max(
      state.discardedThroughLaunchSeqByProfile[output.profileId] ?? 0,
      ...(state.discardedRunLaunchSeqsByProfile[output.profileId] ?? [])
    );
  const latestRunInstanceId =
    previousLatest == null ||
    (runLaunchSeqByInstance[output.runInstanceId] ?? 0) >= previousLatestSeq
      ? output.runInstanceId
      : previousLatest;
  for (const runInstanceId of prunedIds) {
    delete runLaunchSeqByInstance[runInstanceId];
  }
  return {
    runOutputs,
    runLaunchSeqByInstance,
    ...discarded,
    runInstanceIdsByProfile: {
      ...state.runInstanceIdsByProfile,
      [output.profileId]: retainedIds,
    },
    latestRunInstanceIdByProfile: {
      ...state.latestRunInstanceIdByProfile,
      [output.profileId]: latestRunInstanceId,
    },
    activeRunOutputId: prunedIds.includes(state.activeRunOutputId ?? '')
      ? output.runInstanceId
      : state.activeRunOutputId,
  };
}

function selectionProfileId(
  state: Pick<
    IDEState,
    'runOutputs' | 'runHistorySummaries' | 'runHistoryRecords' | 'compoundIdByRunInstance'
  >,
  selection: string | null
): string | undefined {
  if (!selection || selection === ALL_PROFILES_ID) return undefined;
  const historyId = historyIdFromSelection(selection);
  if (historyId != null) {
    return (
      state.runHistorySummaries[historyId]?.profileId ??
      state.runHistoryRecords[historyId]?.profileId
    );
  }
  return state.runOutputs[selection]?.profileId ?? state.compoundIdByRunInstance[selection];
}

const MAX_RUN_HISTORY_SUMMARIES = 50;
const MAX_RICH_RUN_HISTORY_RECORDS = 5;

// Mirrors the Go store's ordering exactly: completion time, then history ID by
// code-unit order. Plain `<` rather than localeCompare so both sides agree on
// same-millisecond ties without depending on the runtime's collation.
export function compareRunHistorySummaries(a: runhistory.Summary, b: runhistory.Summary): number {
  if (a.completedAt !== b.completedAt) return a.completedAt - b.completedAt;
  if (a.historyId === b.historyId) return 0;
  return a.historyId < b.historyId ? -1 : 1;
}

export function archivedRunLabel(
  summary: runhistory.Summary,
  sortedSummaries: runhistory.Summary[],
  profileName: string
): string {
  const profileSummaries = sortedSummaries.filter(
    (candidate) => candidate.profileId === summary.profileId
  );
  if (profileSummaries.length < 2) return `${profileName} (saved)`;
  // Match by id, not object identity: a summary rebuilt by the merge compares
  // unequal to the one in the list and would silently label "saved 0 of N".
  const position = profileSummaries.findIndex(
    (candidate) => candidate.historyId === summary.historyId
  );
  if (position < 0) return `${profileName} (saved)`;
  return `${profileName} (saved ${position + 1} of ${profileSummaries.length})`;
}

function runHistorySummary(value: runhistory.Summary | runhistory.Record): runhistory.Summary {
  return {
    historyId: value.historyId,
    kind: value.kind,
    profileId: value.profileId,
    profileName: value.profileName,
    state: value.state,
    exitCode: value.exitCode,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    outputAvailable: value.outputAvailable,
    truncated: value.truncated,
  };
}

export function mergeRunHistoryArchiveMaps(
  state: Pick<IDEState, 'runHistorySummaries' | 'runHistoryRecords'>,
  incoming: Array<runhistory.Summary | runhistory.Record>
): Pick<IDEState, 'runHistorySummaries' | 'runHistoryRecords'> {
  const runHistorySummaries = { ...state.runHistorySummaries };
  const runHistoryRecords = { ...state.runHistoryRecords };
  const incomingRecordIds: string[] = [];
  for (const value of incoming) {
    const summary = runHistorySummary(value);
    if (!summary.historyId) continue;
    runHistorySummaries[summary.historyId] = summary;
    if (!summary.outputAvailable || summary.kind !== 'ordinary') {
      delete runHistoryRecords[summary.historyId];
    } else if ('version' in value && value.version === 1) {
      runHistoryRecords[summary.historyId] = value;
      incomingRecordIds.push(summary.historyId);
    } else if (!runHistoryRecords[summary.historyId]) {
      runHistoryRecords[summary.historyId] = summary;
    }
  }

  const summariesByProfile = new Map<string, runhistory.Summary[]>();
  for (const summary of Object.values(runHistorySummaries)) {
    const summaries = summariesByProfile.get(summary.profileId) ?? [];
    summaries.push(summary);
    summariesByProfile.set(summary.profileId, summaries);
  }
  const retainedSummaryIds = new Set<string>();
  for (const summaries of summariesByProfile.values()) {
    for (const summary of summaries
      .sort(compareRunHistorySummaries)
      .slice(-MAX_RUN_HISTORY_SUMMARIES)) {
      retainedSummaryIds.add(summary.historyId);
    }
  }
  for (const historyId of Object.keys(runHistorySummaries)) {
    if (!retainedSummaryIds.has(historyId)) {
      delete runHistorySummaries[historyId];
      delete runHistoryRecords[historyId];
    }
  }

  const richByProfile = new Map<string, runhistory.Summary[]>();
  for (const historyId of Object.keys(runHistoryRecords)) {
    const summary = runHistorySummaries[historyId];
    if (!summary?.outputAvailable || summary.kind !== 'ordinary') {
      delete runHistoryRecords[historyId];
      continue;
    }
    const summaries = richByProfile.get(summary.profileId) ?? [];
    summaries.push(summary);
    richByProfile.set(summary.profileId, summaries);
  }
  for (const summaries of richByProfile.values()) {
    const retained = new Set<string>();
    const profileId = summaries[0]?.profileId;
    for (const historyId of [
      ...incomingRecordIds.filter(
        (historyId) => runHistorySummaries[historyId]?.profileId === profileId
      ),
      ...summaries
        .sort(compareRunHistorySummaries)
        .reverse()
        .map((summary) => summary.historyId),
    ]) {
      if (retained.size === MAX_RICH_RUN_HISTORY_RECORDS) break;
      retained.add(historyId);
    }
    for (const summary of summaries) {
      if (!retained.has(summary.historyId)) delete runHistoryRecords[summary.historyId];
    }
  }

  return { runHistorySummaries, runHistoryRecords };
}

function mergeRunHistorySnapshot(
  state: Pick<IDEState, 'runHistory' | 'runHistorySummaries' | 'runHistoryRecords'>,
  snapshot: runhistory.Snapshot
): Pick<IDEState, 'runHistory' | 'runHistorySummaries' | 'runHistoryRecords'> {
  const runHistory = Object.fromEntries(
    Object.entries(state.runHistory).map(([profileId, entries]) => [profileId, [...entries]])
  );
  const existingSummaryIds = new Set(Object.keys(state.runHistorySummaries));
  const seen = new Set<string>();
  const summaries = (snapshot.summaries ?? [])
    .map((summary, index) => ({ summary, index }))
    .sort((a, b) => a.summary.completedAt - b.summary.completedAt || a.index - b.index);
  const archives = mergeRunHistoryArchiveMaps(
    state,
    summaries.map(({ summary }) => summary)
  );

  for (const { summary } of summaries) {
    if (!summary.historyId || seen.has(summary.historyId)) continue;
    seen.add(summary.historyId);

    if (
      existingSummaryIds.has(summary.historyId) ||
      !archives.runHistorySummaries[summary.historyId]
    ) {
      continue;
    }
    if (summary.state !== 'success' && summary.state !== 'failed' && summary.state !== 'stopped') {
      continue;
    }

    const entries = runHistory[summary.profileId] ?? [];
    entries.push({
      state: summary.state,
      duration: Math.max(0, summary.completedAt - summary.startedAt),
      timestamp: summary.completedAt,
    });
    runHistory[summary.profileId] = entries;
  }

  for (const [profileId, entries] of Object.entries(runHistory)) {
    runHistory[profileId] = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.index - b.index)
      .slice(-50)
      .map(({ entry }) => entry);
  }

  return { runHistory, ...archives };
}

export const useIDEStore = create<IDEStore>()(
  devtools(
    (set, get) => ({
      // Initial state
      workspace: null,
      isLoading: false,
      workspaces: [],
      activeWorkspaceId: 'project',
      lastFocusedWorkspaceId: null,
      directoryTree: [],
      isLoadingTree: false,
      treeError: null,
      ...createDefaultWorkspaceSessionState(),
      toast: null,
      activeTerminalTab: 'terminal',
      terminalSessions: [],
      activeTerminalSessionId: null,
      workingDirectory: '',
      runProfiles: [],
      runProfileState: {},
      runProfileForm: null,
      isLoadingProfiles: false,
      profilesError: null,
      profilesReloadNonce: 0,
      selectedProfileId: null,
      runOutputs: {},
      runInstanceIdsByProfile: {},
      runLaunchSeqByInstance: {},
      discardedRunLaunchSeqsByProfile: {},
      discardedThroughLaunchSeqByProfile: {},
      workspaceEpoch: 0,
      runEventsPaused: false,
      latestRunInstanceIdByProfile: {},
      runCompounds: {},
      compoundIdByRunInstance: {},
      activeRunOutputId: null,
      runOutputViewMode: 'merged' as RunOutputViewMode,
      runOutputAutoScroll: true,
      stoppingProfileIds: [],
      restartingProfileIds: [],
      stoppingRunInstanceIds: [],
      restartingRunInstanceIds: [],
      runHistory: {},
      runHistorySummaries: {},
      runHistoryRecords: {},
      waveformData: {},
      runStartTimestamps: {},
      stopRequestTimestamps: {},
      isRestoringWorkspace: false,
      recentWorkspaces: [],
      recentWorkspacesVersion: 0,
      editorSyntaxTheme: loadInitialSyntaxTheme(),
      pendingEditorNavigation: null,

      // Workspace actions
      setWorkspace: (workspace) =>
        set({ workspace, workingDirectory: workspace?.path ?? '' }, false, 'setWorkspace'),

      setWorkspaces: (defs) =>
        set(
          (state) => {
            const activeValid = defs.some((d) => d.id === state.activeWorkspaceId);
            const nextActive = activeValid ? state.activeWorkspaceId : 'project';

            const lastStillValid =
              state.lastFocusedWorkspaceId !== null &&
              defs.some((d) => d.id === state.lastFocusedWorkspaceId);
            let nextLast = lastStillValid ? state.lastFocusedWorkspaceId : null;

            // If the active workspace is a real (non-project) workspace, lastFocused follows it.
            if (nextActive !== 'project') {
              nextLast = nextActive;
            }

            return {
              workspaces: defs,
              activeWorkspaceId: nextActive,
              lastFocusedWorkspaceId: nextLast,
            };
          },
          false,
          'setWorkspaces'
        ),

      setActiveWorkspace: (id) =>
        set(
          (state) => {
            const valid = state.workspaces.some((d) => d.id === id);
            const nextId = valid ? id : 'project';
            return {
              activeWorkspaceId: nextId,
              lastFocusedWorkspaceId: nextId !== 'project' ? nextId : state.lastFocusedWorkspaceId,
            };
          },
          false,
          'setActiveWorkspace'
        ),

      setTreeViewMode: (mode) =>
        set(
          (state) => {
            if (mode === 'project') {
              return { activeWorkspaceId: 'project' };
            }
            const candidates = state.workspaces.filter((w) => w.id !== 'project');
            const lastValid =
              state.lastFocusedWorkspaceId &&
              candidates.some((w) => w.id === state.lastFocusedWorkspaceId)
                ? state.lastFocusedWorkspaceId
                : null;
            const firstNonRoot = candidates.find((w) => w.relDir !== '');
            const firstRoot = candidates.find((w) => w.relDir === '');
            const target = lastValid ?? firstNonRoot?.id ?? firstRoot?.id ?? 'project';
            return {
              activeWorkspaceId: target,
              lastFocusedWorkspaceId: target !== 'project' ? target : state.lastFocusedWorkspaceId,
            };
          },
          false,
          'setTreeViewMode'
        ),

      setLoading: (isLoading) => set({ isLoading }, false, 'setLoading'),

      // File Explorer actions
      setDirectoryTree: (directoryTree) =>
        set({ directoryTree, treeError: null, isLoadingTree: false }, false, 'setDirectoryTree'),

      mergeChildren: (path, children) =>
        set(
          (state) => {
            const normalized = children ?? [];
            const root = state.workspace?.path;
            if (root && pathsReferToSameFile(path, root)) {
              return { directoryTree: preserveLoadedChildren(state.directoryTree, normalized) };
            }
            const existing = findEntryByPath(state.directoryTree, path);
            const merged = preserveLoadedChildren(existing?.children, normalized);
            return { directoryTree: replaceChildrenAt(state.directoryTree, path, merged) };
          },
          false,
          'mergeChildren'
        ),

      markUnreadable: (path) =>
        set(
          (state) => ({
            directoryTree: replaceChildrenAt(state.directoryTree, path, undefined, true),
          }),
          false,
          'markUnreadable'
        ),

      addLoadingPath: (path) =>
        set(
          (s) => {
            const n = new Set(s.loadingPaths);
            n.add(path);
            return { loadingPaths: n };
          },
          false,
          'addLoadingPath'
        ),
      removeLoadingPath: (path) =>
        set(
          (s) => {
            const n = new Set(s.loadingPaths);
            n.delete(path);
            return { loadingPaths: n };
          },
          false,
          'removeLoadingPath'
        ),
      markDirty: (path) =>
        set(
          (s) => {
            const n = new Set(s.dirtyPaths);
            n.add(path);
            return { dirtyPaths: n };
          },
          false,
          'markDirty'
        ),
      clearDirty: (path) =>
        set(
          (s) => {
            const n = new Set(s.dirtyPaths);
            n.delete(path);
            return { dirtyPaths: n };
          },
          false,
          'clearDirty'
        ),

      toggleExpanded: (path) =>
        set(
          (state) => {
            const newExpanded = new Set(state.expandedPaths);
            if (newExpanded.has(path)) {
              newExpanded.delete(path);
            } else {
              newExpanded.add(path);
            }
            return { expandedPaths: newExpanded };
          },
          false,
          'toggleExpanded'
        ),

      setSelectedPath: (selectedPath) => set({ selectedPath }, false, 'setSelectedPath'),

      toggleRootExpanded: () =>
        set((state) => ({ isRootExpanded: !state.isRootExpanded }), false, 'toggleRootExpanded'),

      setTreeLoading: (isLoadingTree) => set({ isLoadingTree }, false, 'setTreeLoading'),

      setTreeError: (treeError) => set({ treeError, isLoadingTree: false }, false, 'setTreeError'),

      // Sidebar actions
      setSidebarView: (activeSidebarView) => set({ activeSidebarView }, false, 'setSidebarView'),

      // Panel actions
      toggleLeftPanel: () =>
        set(
          (state) => ({ isLeftPanelCollapsed: !state.isLeftPanelCollapsed }),
          false,
          'toggleLeftPanel'
        ),

      toggleRightPanel: () =>
        set(
          (state) => ({ isRightPanelCollapsed: !state.isRightPanelCollapsed }),
          false,
          'toggleRightPanel'
        ),

      toggleBottomPanel: () =>
        set(
          (state) => ({ isBottomPanelCollapsed: !state.isBottomPanelCollapsed }),
          false,
          'toggleBottomPanel'
        ),

      setPanelSize: (panel, size) => {
        const clamped = Math.max(0, Math.round(size));
        if (!Number.isFinite(clamped)) return;
        set(
          (state) => ({
            panelSizes: { ...state.panelSizes, [panel]: clamped },
          }),
          false,
          'setPanelSize'
        );
      },

      // #271 center pair. The not-both-collapsed invariant lives in the two
      // setters, so no caller has to order a collapse against the other panel.
      setCenterOrder: (centerOrder) => set({ centerOrder }, false, 'setCenterOrder'),

      swapCenterOrder: () =>
        set(
          (state) => ({
            centerOrder: state.centerOrder === 'files-first' ? 'golem-first' : 'files-first',
          }),
          false,
          'swapCenterOrder'
        ),

      setGolemPanelCollapsed: (collapsed) =>
        set(
          (state) => ({
            isGolemPanelCollapsed: collapsed,
            isFilesPanelCollapsed: collapsed ? false : state.isFilesPanelCollapsed,
          }),
          false,
          'setGolemPanelCollapsed'
        ),

      setFilesPanelCollapsed: (collapsed) =>
        set(
          (state) => ({
            isFilesPanelCollapsed: collapsed,
            isGolemPanelCollapsed: collapsed ? false : state.isGolemPanelCollapsed,
          }),
          false,
          'setFilesPanelCollapsed'
        ),

      revealCenterPanel: (panel) =>
        set(
          (state) => ({
            centerReveal: panel,
            isGolemPanelCollapsed: panel === 'golem' ? false : state.isGolemPanelCollapsed,
            isFilesPanelCollapsed: panel === 'files' ? false : state.isFilesPanelCollapsed,
          }),
          false,
          'revealCenterPanel'
        ),

      // Restore path: one set, already normalized, so the subscribe-and-save
      // hook never observes a half-applied pair.
      applyCenterLayout: (prefs) =>
        set(
          (state) => ({
            centerOrder: prefs.centerOrder,
            isGolemPanelCollapsed: prefs.isGolemPanelCollapsed,
            isFilesPanelCollapsed: prefs.isFilesPanelCollapsed,
            panelSizes: { ...state.panelSizes, golem: prefs.golemWidth },
            centerReveal: initialCenterReveal(prefs),
          }),
          false,
          'applyCenterLayout'
        ),

      setCenterDrag: (centerDrag) => set({ centerDrag }, false, 'setCenterDrag'),

      // Editor actions
      openFile: (file) =>
        set(
          (state) => {
            const exists = state.openFiles.some((f) => f.id === file.id);
            if (exists) {
              return { activeFileId: file.id };
            }
            return {
              openFiles: [...state.openFiles, file],
              activeFileId: file.id,
            };
          },
          false,
          'openFile'
        ),

      closeFile: (fileId) =>
        set(
          (state) => {
            const newFiles = state.openFiles.filter((f) => f.id !== fileId);
            const newActiveId =
              state.activeFileId === fileId
                ? (newFiles[newFiles.length - 1]?.id ?? null)
                : state.activeFileId;
            return { openFiles: newFiles, activeFileId: newActiveId };
          },
          false,
          'closeFile'
        ),

      setActiveFile: (activeFileId) => set({ activeFileId }, false, 'setActiveFile'),

      setCursorPosition: (cursorPosition) => set({ cursorPosition }, false, 'setCursorPosition'),

      setFileModified: (fileId, isModified) =>
        set(
          (state) => ({
            openFiles: state.openFiles.map((f) => (f.id === fileId ? { ...f, isModified } : f)),
          }),
          false,
          'setFileModified'
        ),

      updateFileContent: (fileId, content) =>
        set(
          (state) => ({
            openFiles: state.openFiles.map((f) => {
              if (f.id !== fileId) return f;
              if (f.content === content) return f;
              return { ...f, content, isModified: true };
            }),
          }),
          false,
          'updateFileContent'
        ),

      // Toast actions
      showToast: (message, type) => set({ toast: { message, type } }, false, 'showToast'),

      clearToast: () => set({ toast: null }, false, 'clearToast'),

      // Terminal actions
      setTerminalTab: (activeTerminalTab) => set({ activeTerminalTab }, false, 'setTerminalTab'),

      addTerminalSession: (session) =>
        set(
          (state) => ({
            terminalSessions: [...state.terminalSessions, session],
            activeTerminalSessionId: session.id,
          }),
          false,
          'addTerminalSession'
        ),

      removeTerminalSession: (sessionId) =>
        set(
          (state) => {
            const oldIndex = state.terminalSessions.findIndex((s) => s.id === sessionId);
            const newSessions = state.terminalSessions.filter((s) => s.id !== sessionId);
            let newActiveId = state.activeTerminalSessionId;
            if (state.activeTerminalSessionId === sessionId) {
              // Fall back to adjacent session: prefer left neighbor, then right, then null
              const fallbackIndex = Math.min(oldIndex, newSessions.length - 1);
              newActiveId = fallbackIndex >= 0 ? newSessions[fallbackIndex].id : null;
            }
            return { terminalSessions: newSessions, activeTerminalSessionId: newActiveId };
          },
          false,
          'removeTerminalSession'
        ),

      setActiveTerminalSession: (sessionId) =>
        set({ activeTerminalSessionId: sessionId }, false, 'setActiveTerminalSession'),

      renameTerminalSession: (sessionId, title) =>
        set(
          (state) => ({
            terminalSessions: state.terminalSessions.map((s) =>
              s.id === sessionId ? { ...s, title } : s
            ),
          }),
          false,
          'renameTerminalSession'
        ),

      reorderTerminalSessions: (fromIndex, toIndex) =>
        set(
          (state) => {
            if (
              fromIndex === toIndex ||
              fromIndex < 0 ||
              toIndex < 0 ||
              fromIndex >= state.terminalSessions.length ||
              toIndex >= state.terminalSessions.length
            ) {
              return state;
            }
            const sessions = [...state.terminalSessions];
            const [moved] = sessions.splice(fromIndex, 1);
            sessions.splice(toIndex, 0, moved);
            return { terminalSessions: sessions };
          },
          false,
          'reorderTerminalSessions'
        ),

      setWorkingDirectory: (workingDirectory) =>
        set({ workingDirectory }, false, 'setWorkingDirectory'),

      // Run Profile actions
      setRunProfilesSnapshot: (runProfiles, runProfileState, workspaceEpoch, historySnapshot) =>
        set(
          (state) => {
            const reset = state.runEventsPaused ? emptyWorkspaceRunState() : {};
            const historyState = {
              runHistory: state.runEventsPaused ? {} : state.runHistory,
              runHistorySummaries: state.runEventsPaused ? {} : state.runHistorySummaries,
              runHistoryRecords: state.runEventsPaused ? {} : state.runHistoryRecords,
            };
            return {
              runProfiles,
              runProfileState,
              profilesError: null,
              isLoadingProfiles: false,
              workspaceEpoch:
                workspaceEpoch != null && workspaceEpoch > 0
                  ? workspaceEpoch
                  : state.workspaceEpoch,
              runEventsPaused: false,
              ...reset,
              ...(historySnapshot ? mergeRunHistorySnapshot(historyState, historySnapshot) : {}),
            };
          },
          false,
          'setRunProfilesSnapshot'
        ),

      setSelectedProfile: (id) => set({ selectedProfileId: id }, false, 'setSelectedProfile'),

      adoptProfileLocal: (id) =>
        set(
          (state) => ({
            runProfileState: {
              ...state.runProfileState,
              [id]: { ...state.runProfileState[id], adopted: true },
            },
          }),
          false,
          'adoptProfileLocal'
        ),

      unadoptProfileLocal: (id) =>
        set(
          (state) => {
            // Mirror the backend (store.go SetAdopted): clearing adoption on an
            // entry with no recency drops the entry entirely so the optimistic
            // map matches what the server persists.
            const prev = state.runProfileState[id];
            const next = { ...state.runProfileState };
            if (prev?.lastRunAt) {
              next[id] = { ...prev, adopted: false };
            } else {
              delete next[id];
            }
            return { runProfileState: next };
          },
          false,
          'unadoptProfileLocal'
        ),

      setProfilesLoading: (isLoadingProfiles) =>
        set({ isLoadingProfiles }, false, 'setProfilesLoading'),

      setProfilesError: (profilesError) =>
        set(
          (state) => ({
            profilesError,
            isLoadingProfiles: false,
            ...(state.runEventsPaused
              ? { runProfiles: [], runProfileState: {}, ...emptyWorkspaceRunState() }
              : {}),
          }),
          false,
          'setProfilesError'
        ),

      // Bumping the nonce re-runs useRunProfilesLoader, which is the only path
      // that clears runEventsPaused. Without it a failed load leaves the run
      // controls disabled until the user switches workspaces, because the
      // runprofiles:changed handler also bails while events are paused.
      reloadRunProfiles: () =>
        set(
          (state) => ({ profilesReloadNonce: state.profilesReloadNonce + 1 }),
          false,
          'reloadRunProfiles'
        ),

      openRunProfileForm: (state) => set({ runProfileForm: state }, false, 'openRunProfileForm'),
      closeRunProfileForm: () => set({ runProfileForm: null }, false, 'closeRunProfileForm'),

      addOrUpdateProfile: (profile) =>
        set(
          (state) => {
            const exists = state.runProfiles.some((p) => p.id === profile.id);
            if (exists) {
              return {
                runProfiles: state.runProfiles.map((p) => (p.id === profile.id ? profile : p)),
              };
            }
            return { runProfiles: [...state.runProfiles, profile] };
          },
          false,
          'addOrUpdateProfile'
        ),

      removeProfile: (id) =>
        set(
          (state) => ({
            runProfiles: state.runProfiles.filter((p) => p.id !== id),
          }),
          false,
          'removeProfile'
        ),

      // Run Output actions
      appendRunOutput: (chunk) => {
        const snapshot = get();
        if (
          snapshot.runEventsPaused ||
          (chunk.workspaceEpoch != null && chunk.workspaceEpoch !== snapshot.workspaceEpoch)
        ) {
          return false;
        }

        // Compound step output → routed by explicit fields into runCompounds.
        if (chunk.parentRunInstanceId) {
          const compoundId = snapshot.compoundIdByRunInstance[chunk.parentRunInstanceId];
          if (!compoundId) return false;
          const run = snapshot.runCompounds[compoundId];
          if (!run || run.runInstanceId !== chunk.parentRunInstanceId) return false;
          snapshot.appendCompoundRunOutput(compoundId, chunk.stepIdx, chunk);
          return true;
        }

        if (!acceptsRunEvent(snapshot, chunk)) return false;

        const launchSeq = eventLaunchSeq(snapshot, chunk.runInstanceId, chunk.launchSeq);
        const latestRunInstanceId = snapshot.latestRunInstanceIdByProfile[chunk.profileId];
        const existing = snapshot.runOutputs[chunk.runInstanceId];

        if (latestRunInstanceId === chunk.runInstanceId && !existing) return false;
        if (chunk.launchSeq == null && latestRunInstanceId !== chunk.runInstanceId) {
          const latestRunStartedAt = snapshot.runStartTimestamps[latestRunInstanceId];
          if (
            existing ||
            snapshot.runOutputs[latestRunInstanceId]?.state === 'running' ||
            (latestRunStartedAt != null && chunk.timestamp <= latestRunStartedAt)
          ) {
            return false;
          }
        }
        if (existing && isTerminalRunState(existing.state)) return false;
        if (
          !existing &&
          (snapshot.runInstanceIdsByProfile[chunk.profileId] ?? []).filter((id) =>
            isLiveRunState(snapshot.runOutputs[id]?.state)
          ).length >= MAX_RETAINED_RUNS
        ) {
          return false;
        }

        if (!existing) {
          set(
            (state) => {
              const wd = getProfileWorkingDirSnapshot(state, chunk.profileId);
              const retained = retainRunOutput(
                state,
                createRunOutput(
                  chunk.profileId,
                  chunk.runInstanceId,
                  launchSeq,
                  chunk.workspaceEpoch ?? state.workspaceEpoch,
                  wd
                )
              );
              return {
                ...retained,
                runStartTimestamps: {
                  ...state.runStartTimestamps,
                  [chunk.runInstanceId]: chunk.timestamp,
                  [chunk.profileId]: chunk.timestamp,
                },
              };
            },
            false,
            'appendRunOutput:provision'
          );
        }

        const pendingEntries = collectChunkEntries(chunk.runInstanceId, chunk);
        if (pendingEntries.length === 0) return true;

        set(
          (state) => {
            const ex = state.runOutputs[chunk.runInstanceId];
            if (!ex || isTerminalRunState(ex.state)) return state;
            const combined = [...ex.entries, ...pendingEntries];
            const entries = capOutputEntries(combined);
            return {
              runOutputs: {
                ...state.runOutputs,
                [chunk.runInstanceId]: {
                  ...ex,
                  entries,
                  truncated: ex.truncated || entries.length < combined.length,
                },
              },
            };
          },
          false,
          'appendRunOutput'
        );
        return true;
      },

      handleRunStatus: (status) => {
        const { profileId, runInstanceId, parentRunInstanceId, state: newState, exitCode } = status;
        const timestamp = status.timestamp ?? Date.now();
        if (parentRunInstanceId) return; // steps flow only via run:compound

        const snapshot = get();
        if (!acceptsRunEvent(snapshot, status)) return;
        const launchSeq = eventLaunchSeq(snapshot, runInstanceId, status.launchSeq);
        const isCompoundAggregate =
          snapshot.runProfiles.some(
            (profile) => profile.id === profileId && profile.type === 'compound'
          ) || snapshot.compoundIdByRunInstance[runInstanceId] != null;
        const latestRunInstanceId = snapshot.latestRunInstanceIdByProfile[profileId];
        const latestRunStartedAt = snapshot.runStartTimestamps[profileId];
        const existingBefore = snapshot.runOutputs[runInstanceId];

        if (isCompoundAggregate) {
          const currentCompound = snapshot.runCompounds[profileId];
          const indexedCompoundId = snapshot.compoundIdByRunInstance[runInstanceId];
          if (!latestRunInstanceId) {
            if (newState !== 'running' || indexedCompoundId != null) return;
          } else if (latestRunInstanceId === runInstanceId) {
            if (
              indexedCompoundId !== profileId ||
              currentCompound?.runInstanceId !== runInstanceId ||
              isTerminalRunState(currentCompound.state) ||
              (newState === 'running' && currentCompound.state === 'running')
            ) {
              return;
            }
          } else {
            const latestCompoundId = snapshot.compoundIdByRunInstance[latestRunInstanceId];
            const hasTerminalCurrent =
              latestCompoundId === profileId &&
              currentCompound?.runInstanceId === latestRunInstanceId &&
              isTerminalRunState(currentCompound.state);
            const hasClearedTombstone = latestCompoundId == null && currentCompound == null;
            const latestLaunchSeq =
              snapshot.runLaunchSeqByInstance[latestRunInstanceId] ?? currentCompound?.launchSeq;
            const isNewerLaunch =
              status.launchSeq != null
                ? latestLaunchSeq != null && status.launchSeq > latestLaunchSeq
                : status.timestamp != null &&
                  latestRunStartedAt != null &&
                  status.timestamp > latestRunStartedAt;
            if (
              newState !== 'running' ||
              indexedCompoundId != null ||
              (!hasTerminalCurrent && !hasClearedTombstone) ||
              !isNewerLaunch
            ) {
              return;
            }
          }
        }

        if (!isCompoundAggregate && status.launchSeq != null) {
          if (
            existingBefore &&
            (isTerminalRunState(existingBefore.state) ||
              (newState === 'running' && existingBefore.state === 'running'))
          ) {
            return;
          }
          if (!existingBefore) {
            if (newState !== 'running') return;
            const liveCount = (snapshot.runInstanceIdsByProfile[profileId] ?? []).filter((id) =>
              isLiveRunState(snapshot.runOutputs[id]?.state)
            ).length;
            if (liveCount >= MAX_RETAINED_RUNS) return;
          }
        } else if (!isCompoundAggregate) {
          if (!latestRunInstanceId) {
            if (isTerminalRunState(newState) && !existingBefore) return;
          } else {
            if (latestRunInstanceId === runInstanceId && !existingBefore) return;
            if (
              latestRunInstanceId === runInstanceId &&
              existingBefore &&
              (isTerminalRunState(existingBefore.state) ||
                (newState === 'running' && existingBefore.state === 'running'))
            ) {
              return;
            }
            if (
              latestRunInstanceId !== runInstanceId &&
              (existingBefore ||
                newState !== 'running' ||
                status.timestamp == null ||
                snapshot.runOutputs[latestRunInstanceId]?.state === 'running' ||
                (latestRunStartedAt != null && status.timestamp <= latestRunStartedAt))
            ) {
              return;
            }
          }
        }

        const rotatesCompound =
          isCompoundAggregate &&
          latestRunInstanceId != null &&
          latestRunInstanceId !== runInstanceId;
        const priorCompound = snapshot.runCompounds[profileId];
        if (rotatesCompound && priorCompound) {
          clearCompoundStepAssemblers(profileId, priorCompound.steps);
        }

        const flushedEntries =
          !isCompoundAggregate && isTerminalRunState(newState) ? flushAssembler(runInstanceId) : [];

        set(
          (state) => {
            const runWorkingDir = getProfileWorkingDirSnapshot(state, profileId);
            const existing = state.runOutputs[runInstanceId];
            const updated: RunOutput | undefined = isCompoundAggregate
              ? undefined
              : {
                  ...(existing ??
                    createRunOutput(
                      profileId,
                      runInstanceId,
                      launchSeq,
                      status.workspaceEpoch ?? state.workspaceEpoch,
                      runWorkingDir
                    )),
                  state: newState,
                  exitCode,
                  workingDir:
                    newState === 'running'
                      ? runWorkingDir
                      : (existing?.workingDir ?? runWorkingDir),
                  ...cappedRunEntries(existing?.entries ?? [], flushedEntries, existing?.truncated),
                };

            // --- Lifecycle flags ---
            let { stoppingProfileIds, restartingProfileIds } = state;
            let { stoppingRunInstanceIds, restartingRunInstanceIds } = state;

            if (isTerminalRunState(newState)) {
              stoppingRunInstanceIds = stoppingRunInstanceIds.filter((id) => id !== runInstanceId);
              restartingRunInstanceIds = restartingRunInstanceIds.filter(
                (id) => id !== runInstanceId
              );
              const hasStoppingSibling = stoppingRunInstanceIds.some(
                (id) => state.runOutputs[id]?.profileId === profileId
              );
              const hasRestartingSibling = restartingRunInstanceIds.some(
                (id) => state.runOutputs[id]?.profileId === profileId
              );
              if (!hasStoppingSibling) {
                stoppingProfileIds = stoppingProfileIds.filter((id) => id !== profileId);
              }
              if (!hasRestartingSibling) {
                restartingProfileIds = restartingProfileIds.filter((id) => id !== profileId);
              }
            } else if (newState === 'running') {
              restartingRunInstanceIds = restartingRunInstanceIds.filter(
                (id) => id !== runInstanceId
              );
              if (
                !restartingRunInstanceIds.some(
                  (id) => state.runOutputs[id]?.profileId === profileId
                )
              ) {
                restartingProfileIds = restartingProfileIds.filter((id) => id !== profileId);
              }
            }

            // --- Stop request timestamp ---
            let { stopRequestTimestamps } = state;
            if (isTerminalRunState(newState) || newState === 'running') {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { [runInstanceId]: _removedRun, ...withoutRun } = stopRequestTimestamps;
              stopRequestTimestamps = withoutRun;
              if (
                !stoppingProfileIds.includes(profileId) &&
                !restartingProfileIds.includes(profileId)
              ) {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { [profileId]: _removedProfile, ...withoutProfile } = stopRequestTimestamps;
                stopRequestTimestamps = withoutProfile;
              }
            }

            // --- Start timestamp ---
            let { runStartTimestamps } = state;
            if (newState === 'running') {
              const representative = representativeRunInstanceId(state, profileId);
              const representativeSeq =
                representative == null ? -1 : (state.runLaunchSeqByInstance[representative] ?? -1);
              runStartTimestamps = {
                ...runStartTimestamps,
                [runInstanceId]: timestamp,
                ...(launchSeq >= representativeSeq ? { [profileId]: timestamp } : {}),
              };
            } else if (isTerminalRunState(newState)) {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { [runInstanceId]: _removed, ...rest } = runStartTimestamps;
              runStartTimestamps = rest;
            }

            // --- Run history ---
            let { runHistory } = state;
            if (
              isTerminalRunState(newState) &&
              (state.runStartTimestamps[runInstanceId] ?? state.runStartTimestamps[profileId]) !=
                null &&
              (isCompoundAggregate || existingBefore?.state === 'running')
            ) {
              const startedAt =
                state.runStartTimestamps[runInstanceId] ?? state.runStartTimestamps[profileId];
              const existingHistory = runHistory[profileId] ?? [];
              const entry: RunHistoryEntry = {
                state: newState as RunHistoryEntry['state'],
                duration: timestamp - startedAt,
                timestamp,
              };
              const updatedHistory = [...existingHistory, entry];
              const capped =
                updatedHistory.length > 50
                  ? updatedHistory.slice(updatedHistory.length - 50)
                  : updatedHistory;
              runHistory = { ...runHistory, [profileId]: capped };
            }

            // --- Auto-select first running profile ---
            let { activeRunOutputId } = state;
            const activeProfileId = selectionProfileId(state, activeRunOutputId);
            if (
              newState === 'running' &&
              existingBefore?.state !== 'running' &&
              (!activeRunOutputId ||
                activeRunOutputId === ALL_PROFILES_ID ||
                activeProfileId === profileId ||
                (rotatesCompound && activeRunOutputId === latestRunInstanceId))
            ) {
              activeRunOutputId = runInstanceId;
            }

            const retainedOutput = updated ? retainRunOutput(state, updated) : undefined;
            let { runCompounds } = state;
            let { compoundIdByRunInstance } = state;
            let runLaunchSeqByInstance =
              retainedOutput?.runLaunchSeqByInstance ?? state.runLaunchSeqByInstance;
            let latestRunInstanceIdByProfile =
              retainedOutput?.latestRunInstanceIdByProfile ?? state.latestRunInstanceIdByProfile;
            if (isCompoundAggregate) {
              runLaunchSeqByInstance = {
                ...runLaunchSeqByInstance,
                [runInstanceId]: launchSeq,
              };
              if (rotatesCompound && latestRunInstanceId) {
                delete runLaunchSeqByInstance[latestRunInstanceId];
              }
              latestRunInstanceIdByProfile = {
                ...latestRunInstanceIdByProfile,
                [profileId]: runInstanceId,
              };
              const compound = state.runCompounds[profileId];
              if (newState === 'running' && compound?.runInstanceId !== runInstanceId) {
                const profileName = state.runProfiles.find(
                  (profile) => profile.id === profileId
                )?.name;
                const index = { ...compoundIdByRunInstance };
                if (latestRunInstanceId) delete index[latestRunInstanceId];
                index[runInstanceId] = profileId;
                compoundIdByRunInstance = index;
                runCompounds = {
                  ...runCompounds,
                  [profileId]: {
                    compoundId: profileId,
                    runInstanceId,
                    launchSeq,
                    workspaceEpoch: status.workspaceEpoch ?? state.workspaceEpoch,
                    name: profileName ?? profileId,
                    state: 'running',
                    exitCode,
                    currentStep: 0,
                    steps: [],
                    stepOutputs: {},
                  },
                };
              } else if (compound?.runInstanceId === runInstanceId) {
                // The aggregate run:status is the only carrier of a compound's
                // exit code (run:compound snapshots omit it), so capture it here.
                runCompounds = {
                  ...runCompounds,
                  [profileId]: { ...compound, state: newState, exitCode },
                };
              }
            }
            return {
              ...(retainedOutput ?? {}),
              runCompounds,
              compoundIdByRunInstance,
              runLaunchSeqByInstance,
              latestRunInstanceIdByProfile,
              stoppingProfileIds,
              restartingProfileIds,
              stoppingRunInstanceIds,
              restartingRunInstanceIds,
              stopRequestTimestamps,
              runStartTimestamps,
              runHistory,
              activeRunOutputId:
                activeRunOutputId === state.activeRunOutputId
                  ? (retainedOutput?.activeRunOutputId ?? activeRunOutputId)
                  : activeRunOutputId,
            };
          },
          false,
          'handleRunStatus'
        );
      },

      clearRunOutput: (runInstanceId) => {
        const snapshot = useIDEStore.getState();
        const compoundId = snapshot.compoundIdByRunInstance[runInstanceId];
        if (compoundId) {
          snapshot.clearCompoundRunOutput(compoundId);
          return;
        }
        set(
          (state) => {
            const existing = state.runOutputs[runInstanceId];
            if (!existing) return state;

            if (!isTerminalRunState(existing.state)) {
              lineAssemblers.delete(runInstanceId);
              assemblerCallbacks.delete(runInstanceId);
              return {
                runOutputs: {
                  ...state.runOutputs,
                  [runInstanceId]: { ...existing, entries: [] },
                },
              };
            }

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { [runInstanceId]: _discarded, ...rest } = state.runOutputs;
            lineAssemblers.delete(runInstanceId);
            assemblerCallbacks.delete(runInstanceId);
            const remainingForProfile = (
              state.runInstanceIdsByProfile[existing.profileId] ?? []
            ).filter((id) => id !== runInstanceId);
            const runInstanceIdsByProfile = { ...state.runInstanceIdsByProfile };
            if (remainingForProfile.length > 0) {
              runInstanceIdsByProfile[existing.profileId] = remainingForProfile;
            } else {
              delete runInstanceIdsByProfile[existing.profileId];
            }
            let activeRunOutputId = state.activeRunOutputId;
            if (activeRunOutputId === runInstanceId) {
              const remainingOrdinary = Object.values(runInstanceIdsByProfile)
                .flat()
                .filter((id) => rest[id]);
              const remainingCompounds = Object.values(state.runCompounds).map(
                (compound) => compound.runInstanceId
              );
              activeRunOutputId =
                remainingForProfile.at(-1) ?? remainingOrdinary[0] ?? remainingCompounds[0] ?? null;
            }
            const discarded = discardRunSeqs(state, existing.profileId, [runInstanceId]);
            const runLaunchSeqByInstance = { ...state.runLaunchSeqByInstance };
            delete runLaunchSeqByInstance[runInstanceId];
            return {
              runOutputs: rest,
              runLaunchSeqByInstance,
              runInstanceIdsByProfile,
              activeRunOutputId,
              ...discarded,
              stoppingRunInstanceIds: state.stoppingRunInstanceIds.filter(
                (id) => id !== runInstanceId
              ),
              restartingRunInstanceIds: state.restartingRunInstanceIds.filter(
                (id) => id !== runInstanceId
              ),
            };
          },
          false,
          'clearRunOutput'
        );
      },

      clearAllRunOutputs: () => {
        lineAssemblers.clear();
        assemblerCallbacks.clear();
        set(
          (state) => {
            const preserved: Record<string, RunOutput> = {};
            for (const [id, output] of Object.entries(state.runOutputs)) {
              if (!isTerminalRunState(output.state)) {
                preserved[id] = { ...output, entries: [] };
              }
            }
            // Preserve still-running compounds (entries cleared). Dropping them
            // would orphan composite output chunks for the active step — they
            // would be ignored by appendRunOutput until the next snapshot.
            const preservedCompounds: Record<string, CompoundRun> = {};
            for (const [id, compound] of Object.entries(state.runCompounds)) {
              if (compound.state === 'running') {
                preservedCompounds[id] = { ...compound, stepOutputs: {} };
              }
            }
            const preservedRunIdsByProfile: Record<string, string[]> = {};
            for (const [profileId, ids] of Object.entries(state.runInstanceIdsByProfile)) {
              const liveIds = ids.filter((id) => preserved[id]);
              if (liveIds.length > 0) preservedRunIdsByProfile[profileId] = liveIds;
            }
            const firstId =
              Object.keys(preserved)[0] ??
              Object.values(preservedCompounds)[0]?.runInstanceId ??
              null;
            const activeCompoundId =
              state.activeRunOutputId != null
                ? state.compoundIdByRunInstance[state.activeRunOutputId]
                : undefined;
            const activeStillValid =
              state.activeRunOutputId != null &&
              (preserved[state.activeRunOutputId] != null ||
                (activeCompoundId != null && preservedCompounds[activeCompoundId] != null));
            const preservedIndex: Record<string, string> = {};
            for (const [id, compound] of Object.entries(preservedCompounds)) {
              if (compound.runInstanceId) preservedIndex[compound.runInstanceId] = id;
            }
            let discardedRunLaunchSeqsByProfile = state.discardedRunLaunchSeqsByProfile;
            let discardedThroughLaunchSeqByProfile = state.discardedThroughLaunchSeqByProfile;
            for (const [profileId, ids] of Object.entries(state.runInstanceIdsByProfile)) {
              const terminalIds = ids.filter((id) =>
                isTerminalRunState(state.runOutputs[id]?.state)
              );
              const discarded = discardRunSeqs(
                {
                  runLaunchSeqByInstance: state.runLaunchSeqByInstance,
                  discardedRunLaunchSeqsByProfile,
                  discardedThroughLaunchSeqByProfile,
                },
                profileId,
                terminalIds
              );
              discardedRunLaunchSeqsByProfile = discarded.discardedRunLaunchSeqsByProfile;
              discardedThroughLaunchSeqByProfile = discarded.discardedThroughLaunchSeqByProfile;
            }
            const sequenceIds = new Set([
              ...Object.keys(preserved),
              ...Object.values(preservedCompounds).map((compound) => compound.runInstanceId),
              ...Object.entries(state.runCompounds)
                .filter(
                  ([profileId, compound]) =>
                    isTerminalRunState(compound.state) &&
                    state.latestRunInstanceIdByProfile[profileId] === compound.runInstanceId
                )
                .map(([, compound]) => compound.runInstanceId),
            ]);
            const runLaunchSeqByInstance = Object.fromEntries(
              [...sequenceIds].map((id) => [
                id,
                state.runLaunchSeqByInstance[id] ??
                  Object.values(state.runCompounds).find(
                    (compound) => compound.runInstanceId === id
                  )?.launchSeq ??
                  0,
              ])
            );
            return {
              runOutputs: preserved,
              runLaunchSeqByInstance,
              runInstanceIdsByProfile: preservedRunIdsByProfile,
              discardedRunLaunchSeqsByProfile,
              discardedThroughLaunchSeqByProfile,
              runCompounds: preservedCompounds,
              compoundIdByRunInstance: preservedIndex,
              stoppingRunInstanceIds: state.stoppingRunInstanceIds.filter((id) => preserved[id]),
              restartingRunInstanceIds: state.restartingRunInstanceIds.filter(
                (id) => preserved[id]
              ),
              activeRunOutputId: activeStillValid ? state.activeRunOutputId : firstId,
            };
          },
          false,
          'clearAllRunOutputs'
        );
      },

      // Compound run actions
      handleCompoundRun: (event) => {
        const {
          compoundId,
          runInstanceId,
          name,
          state: aggregateState,
          currentStep,
          steps,
        } = event;

        // Aggregate status is emitted before each snapshot and authorizes the RID.
        const snapshot = useIDEStore.getState();
        if (
          snapshot.runEventsPaused ||
          (event.workspaceEpoch != null && event.workspaceEpoch !== snapshot.workspaceEpoch)
        ) {
          return;
        }
        const prevRun = snapshot.runCompounds[compoundId];
        if (
          snapshot.latestRunInstanceIdByProfile[compoundId] !== runInstanceId ||
          snapshot.compoundIdByRunInstance[runInstanceId] !== compoundId ||
          prevRun?.runInstanceId !== runInstanceId ||
          prevRun?.state !== aggregateState
        ) {
          return;
        }
        const prevStepStates = new Map<number, string>();
        if (prevRun) {
          for (const step of prevRun.steps) {
            prevStepStates.set(step.idx, step.state);
          }
        }

        const isStepTerminal = (s: string) => s === 'success' || s === 'failed' || s === 'stopped';

        // Flush assemblers for steps that BECAME terminal this event, collecting
        // their carry-over before we touch the store (mirrors handleRunStatus).
        const flushedByStep = new Map<number, OutputEntry[]>();
        // Steps that transitioned into a terminal state this event (for history).
        const newlyTerminal: typeof steps = [];
        for (const step of steps) {
          const prevState = prevStepStates.get(step.idx);
          const becameTerminal = isStepTerminal(step.state) && !isStepTerminal(prevState ?? '');
          if (becameTerminal) {
            newlyTerminal.push(step);
            const flushed = flushAssembler(compoundStepAssemblerKey(compoundId, step.idx));
            if (flushed.length > 0) {
              flushedByStep.set(step.idx, flushed);
            }
          }
        }

        set(
          (state) => {
            const existing = state.runCompounds[compoundId];
            // A terminal compound transitioning back to running is a NEW run of
            // the same profile: start its step outputs fresh instead of carrying
            // the previous execution's output into the new run.
            const isNewRun =
              existing != null && isStepTerminal(existing.state) && aggregateState === 'running';
            const preservedOutputs: Record<number, OutputEntry[]> = isNewRun
              ? {}
              : { ...(existing?.stepOutputs ?? {}) };

            // Merge flushed carry-over into the corresponding step outputs.
            for (const [stepIdx, flushed] of flushedByStep) {
              const current = preservedOutputs[stepIdx] ?? [];
              preservedOutputs[stepIdx] = capOutputEntries([...current, ...flushed]);
            }

            // --- Selected step ---
            let selectedStepIdx: number | undefined;
            const runningStep = steps.find((s) => s.state === 'running');
            if (runningStep) {
              selectedStepIdx = runningStep.idx;
            } else if (aggregateState === 'failed') {
              selectedStepIdx = steps.find((s) => s.state === 'failed')?.idx;
            }
            if (selectedStepIdx == null) {
              selectedStepIdx = existing?.selectedStepIdx ?? currentStep ?? 0;
            }

            // --- Run history (only for steps that became terminal this event) ---
            let runHistory = state.runHistory;
            for (const step of newlyTerminal) {
              if (step.startedAt == null || step.endedAt == null) continue;
              if (step.state !== 'success' && step.state !== 'failed' && step.state !== 'stopped') {
                continue;
              }
              const existingHistory = runHistory[step.profileId] ?? [];
              const entry: RunHistoryEntry = {
                state: step.state,
                duration: step.endedAt - step.startedAt,
                timestamp: step.endedAt,
              };
              const updatedHistory = [...existingHistory, entry];
              const capped =
                updatedHistory.length > 50
                  ? updatedHistory.slice(updatedHistory.length - 50)
                  : updatedHistory;
              runHistory = { ...runHistory, [step.profileId]: capped };
            }

            // --- Failed reference ---
            let failedReference: CompoundRun['failedReference'];
            if (aggregateState === 'failed') {
              const failedStep = steps.find((s) => s.state === 'failed');
              if (failedStep) {
                const text = (preservedOutputs[failedStep.idx] ?? [])
                  .map((entry) => entry.text)
                  .join('\n');
                const refs = parseFileReferences(text);
                if (refs.length > 0) {
                  const ref = refs[0];
                  failedReference = {
                    stepIdx: failedStep.idx,
                    path: ref.path,
                    line: ref.line,
                    column: ref.column,
                  };
                }
              }
            }

            // --- ETA (best-effort sum of running remaining + pending estimates) ---
            let etaMs: number | undefined;
            let etaTotal = 0;
            let etaHasValue = false;
            for (const step of steps) {
              const history = runHistory[step.profileId] ?? [];
              if (step.state === 'running') {
                const elapsed = step.startedAt != null ? Date.now() - step.startedAt : 0;
                const remaining = estimateRemaining(history, Math.max(0, elapsed));
                if (remaining != null) {
                  etaTotal += remaining;
                  etaHasValue = true;
                }
              } else if (step.state === 'pending') {
                const estimate = estimateDuration(history);
                if (estimate != null) {
                  etaTotal += estimate;
                  etaHasValue = true;
                }
              }
            }
            if (etaHasValue) {
              etaMs = etaTotal;
            }

            const newRun: CompoundRun = {
              compoundId,
              runInstanceId,
              launchSeq: event.launchSeq ?? existing?.launchSeq,
              workspaceEpoch: event.workspaceEpoch ?? existing?.workspaceEpoch,
              name,
              state: aggregateState,
              currentStep,
              etaMs,
              steps,
              stepOutputs: preservedOutputs,
              selectedStepIdx,
              failedReference,
            };

            // Maintain aggregate-runInstanceId -> compoundId index. On rotation,
            // drop the previous instance's mapping.
            const index = { ...state.compoundIdByRunInstance };
            if (prevRun && prevRun.runInstanceId && prevRun.runInstanceId !== runInstanceId) {
              delete index[prevRun.runInstanceId];
            }
            index[runInstanceId] = compoundId;

            let activeRunOutputId = state.activeRunOutputId;
            const activeProfileId = selectionProfileId(state, activeRunOutputId);
            if (
              activeRunOutputId === prevRun?.runInstanceId ||
              (aggregateState === 'running' &&
                (!activeRunOutputId ||
                  activeRunOutputId === ALL_PROFILES_ID ||
                  activeProfileId === compoundId))
            ) {
              activeRunOutputId = runInstanceId;
            }

            return {
              runCompounds: { ...state.runCompounds, [compoundId]: newRun },
              compoundIdByRunInstance: index,
              latestRunInstanceIdByProfile: {
                ...state.latestRunInstanceIdByProfile,
                [compoundId]: runInstanceId,
              },
              runHistory,
              activeRunOutputId,
            };
          },
          false,
          'handleCompoundRun'
        );
      },

      appendCompoundRunOutput: (compoundId, stepIdx, chunk) => {
        const pendingEntries = collectChunkEntries(
          compoundStepAssemblerKey(compoundId, stepIdx),
          chunk
        );
        if (pendingEntries.length === 0) return;

        set(
          (state) => {
            const existing = state.runCompounds[compoundId];
            if (!existing) return state; // compound disappeared between calls

            const current = existing.stepOutputs[stepIdx] ?? [];
            let entries = [...current, ...pendingEntries];
            if (entries.length > MAX_OUTPUT_ENTRIES) {
              entries = entries.slice(entries.length - MAX_OUTPUT_ENTRIES + 1);
              entries.unshift({
                stream: 'stdout',
                text: '[truncated — oldest output removed]',
                timestamp: entries[0]?.timestamp ?? Date.now(),
              });
            }

            return {
              runCompounds: {
                ...state.runCompounds,
                [compoundId]: {
                  ...existing,
                  stepOutputs: { ...existing.stepOutputs, [stepIdx]: entries },
                },
              },
            };
          },
          false,
          'appendCompoundRunOutput'
        );
      },

      clearCompoundRunOutput: (compoundId) => {
        const existing = useIDEStore.getState().runCompounds[compoundId];
        if (existing) {
          clearCompoundStepAssemblers(compoundId, existing.steps);
        }
        set(
          (state) => {
            const run = state.runCompounds[compoundId];
            if (!run) return state;
            return {
              runCompounds: {
                ...state.runCompounds,
                [compoundId]: { ...run, stepOutputs: {} },
              },
            };
          },
          false,
          'clearCompoundRunOutput'
        );
      },

      setActiveRunOutput: (id) =>
        set(
          (state) => ({
            activeRunOutputId: id,
            runOutputViewMode:
              id === ALL_PROFILES_ID
                ? 'timeline'
                : state.runOutputViewMode === 'timeline'
                  ? 'merged'
                  : state.runOutputViewMode,
          }),
          false,
          'setActiveRunOutput'
        ),

      setRunOutputViewMode: (mode) =>
        set({ runOutputViewMode: mode }, false, 'setRunOutputViewMode'),

      toggleAutoScroll: () =>
        set(
          (state) => ({ runOutputAutoScroll: !state.runOutputAutoScroll }),
          false,
          'toggleAutoScroll'
        ),

      // Process lifecycle actions
      setProfileStopping: (profileId) =>
        set(
          (state) => ({
            stoppingProfileIds: state.stoppingProfileIds.includes(profileId)
              ? state.stoppingProfileIds
              : [...state.stoppingProfileIds, profileId],
            stopRequestTimestamps:
              state.stopRequestTimestamps[profileId] != null
                ? state.stopRequestTimestamps
                : { ...state.stopRequestTimestamps, [profileId]: Date.now() },
          }),
          false,
          'setProfileStopping'
        ),

      clearProfileStopping: (profileId) =>
        set(
          (state) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { [profileId]: _removed, ...restTimestamps } = state.stopRequestTimestamps;
            return {
              stoppingProfileIds: state.stoppingProfileIds.filter((id) => id !== profileId),
              stopRequestTimestamps: restTimestamps,
            };
          },
          false,
          'clearProfileStopping'
        ),

      setProfileRestarting: (profileId) =>
        set(
          (state) => ({
            restartingProfileIds: state.restartingProfileIds.includes(profileId)
              ? state.restartingProfileIds
              : [...state.restartingProfileIds, profileId],
            stopRequestTimestamps:
              state.stopRequestTimestamps[profileId] != null
                ? state.stopRequestTimestamps
                : { ...state.stopRequestTimestamps, [profileId]: Date.now() },
          }),
          false,
          'setProfileRestarting'
        ),

      clearProfileRestarting: (profileId) =>
        set(
          (state) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { [profileId]: _removed, ...restTimestamps } = state.stopRequestTimestamps;
            return {
              restartingProfileIds: state.restartingProfileIds.filter((id) => id !== profileId),
              stopRequestTimestamps: restTimestamps,
            };
          },
          false,
          'clearProfileRestarting'
        ),

      setRunStopping: (runInstanceId) =>
        set(
          (state) => ({
            stoppingRunInstanceIds: state.stoppingRunInstanceIds.includes(runInstanceId)
              ? state.stoppingRunInstanceIds
              : [...state.stoppingRunInstanceIds, runInstanceId],
            stopRequestTimestamps:
              state.stopRequestTimestamps[runInstanceId] != null
                ? state.stopRequestTimestamps
                : { ...state.stopRequestTimestamps, [runInstanceId]: Date.now() },
          }),
          false,
          'setRunStopping'
        ),

      clearRunStopping: (runInstanceId) =>
        set(
          (state) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { [runInstanceId]: _removed, ...restTimestamps } = state.stopRequestTimestamps;
            return {
              stoppingRunInstanceIds: state.stoppingRunInstanceIds.filter(
                (id) => id !== runInstanceId
              ),
              stopRequestTimestamps: restTimestamps,
            };
          },
          false,
          'clearRunStopping'
        ),

      setRunRestarting: (runInstanceId) =>
        set(
          (state) => ({
            restartingRunInstanceIds: state.restartingRunInstanceIds.includes(runInstanceId)
              ? state.restartingRunInstanceIds
              : [...state.restartingRunInstanceIds, runInstanceId],
            stopRequestTimestamps:
              state.stopRequestTimestamps[runInstanceId] != null
                ? state.stopRequestTimestamps
                : { ...state.stopRequestTimestamps, [runInstanceId]: Date.now() },
          }),
          false,
          'setRunRestarting'
        ),

      clearRunRestarting: (runInstanceId) =>
        set(
          (state) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { [runInstanceId]: _removed, ...restTimestamps } = state.stopRequestTimestamps;
            return {
              restartingRunInstanceIds: state.restartingRunInstanceIds.filter(
                (id) => id !== runInstanceId
              ),
              stopRequestTimestamps: restTimestamps,
            };
          },
          false,
          'clearRunRestarting'
        ),

      appendRunHistory: (profileId, entry) =>
        set(
          (state) => {
            const existing = state.runHistory[profileId] ?? [];
            const updated = [...existing, entry];
            const capped = updated.length > 50 ? updated.slice(updated.length - 50) : updated;
            return { runHistory: { ...state.runHistory, [profileId]: capped } };
          },
          false,
          'appendRunHistory'
        ),

      updateWaveform: (profileId, entryCount) =>
        set(
          (state) => {
            const existing = state.waveformData[profileId] ?? new Array(12).fill(0);
            const shifted = [...existing.slice(1), entryCount];
            return { waveformData: { ...state.waveformData, [profileId]: shifted } };
          },
          false,
          'updateWaveform'
        ),

      hideProfile: (id) =>
        set(
          (state) => ({
            hiddenProfileIds: state.hiddenProfileIds.includes(id)
              ? state.hiddenProfileIds
              : [...state.hiddenProfileIds, id],
          }),
          false,
          'hideProfile'
        ),

      unhideProfile: (id) =>
        set(
          (state) => ({
            hiddenProfileIds: state.hiddenProfileIds.filter((hid) => hid !== id),
          }),
          false,
          'unhideProfile'
        ),

      focusProfileOutput: (profileId) =>
        set(
          (state) => {
            const latestRunInstanceId = state.latestRunInstanceIdByProfile[profileId];
            const compoundRunInstanceId = state.compoundIdByRunInstance[latestRunInstanceId]
              ? latestRunInstanceId
              : undefined;
            return {
              activeRunOutputId:
                representativeRunInstanceId(state, profileId) ?? compoundRunInstanceId ?? null,
              activeTerminalTab: 'output' as TerminalTab,
              isBottomPanelCollapsed: false,
            };
          },
          false,
          'focusProfileOutput'
        ),

      pauseRunEvents: () => set({ runEventsPaused: true }, false, 'pauseRunEvents'),

      // Clears transient run state for the workspace being left. Deliberately
      // leaves hiddenProfileIds alone: this runs before the workspace-switch
      // flush captures the outgoing state, so clearing it here would persist an
      // empty list under the old workspace. resetWorkspaceSession clears it
      // later, once the outgoing snapshot has been taken.
      resetWorkspaceRunState: () => {
        lineAssemblers.clear();
        assemblerCallbacks.clear();
        set(
          {
            ...emptyWorkspaceRunState(),
            runProfiles: [],
            runProfileState: {},
            runProfileForm: null,
          },
          false,
          'resetWorkspaceRunState'
        );
      },

      // Per-file view state actions
      setScrollPosition: (fileId, scrollTop) =>
        set(
          (state) => ({
            scrollPositions: { ...state.scrollPositions, [fileId]: scrollTop },
          }),
          false,
          'setScrollPosition'
        ),

      setFileCursorPosition: (fileId, position) =>
        set(
          (state) => ({
            cursorPositions: { ...state.cursorPositions, [fileId]: position },
          }),
          false,
          'setFileCursorPosition'
        ),

      // Workspace persistence actions
      setRestoringWorkspace: (isRestoringWorkspace) =>
        set({ isRestoringWorkspace }, false, 'setRestoringWorkspace'),

      resetWorkspaceSession: () =>
        set(createDefaultWorkspaceSessionState(), false, 'resetWorkspaceSession'),

      // Recent workspaces actions
      setRecentWorkspaces: (recentWorkspaces) =>
        set({ recentWorkspaces }, false, 'setRecentWorkspaces'),

      // Status actions
      setEditorSyntaxTheme: (id) => {
        if (!isSyntaxThemeId(id)) return;
        set({ editorSyntaxTheme: id }, false, 'setEditorSyntaxTheme');
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(SYNTAX_THEME_STORAGE_KEY, id);
          }
        } catch {
          // localStorage may be unavailable (private mode / WebView quirks); state still updates.
        }
      },

      // Editor navigation actions
      requestEditorNavigation: (fileId, line, column) =>
        set(
          (state) => ({
            pendingEditorNavigation: {
              fileId,
              line,
              column,
              revision: (state.pendingEditorNavigation?.revision ?? 0) + 1,
            },
          }),
          false,
          'requestEditorNavigation'
        ),

      clearPendingEditorNavigation: (fileId, revision) =>
        set(
          (state) => {
            const nav = state.pendingEditorNavigation;
            if (nav && nav.fileId === fileId && nav.revision === revision) {
              return { pendingEditorNavigation: null };
            }
            return {};
          },
          false,
          'clearPendingEditorNavigation'
        ),

      // Navigation history actions
      pushNavigationHistory: (entry) =>
        set(
          (state) => {
            const history = [...state.navigationHistory, entry];
            if (history.length > MAX_NAVIGATION_HISTORY) {
              history.splice(0, history.length - MAX_NAVIGATION_HISTORY);
            }
            return { navigationHistory: history, navigationForward: [] };
          },
          false,
          'pushNavigationHistory'
        ),

      goBack: (current: NavigationLocation) => {
        const state = get();
        if (state.navigationHistory.length === 0) return undefined;
        const entry = state.navigationHistory[state.navigationHistory.length - 1];
        set(
          {
            navigationHistory: state.navigationHistory.slice(0, -1),
            navigationForward: [...state.navigationForward, current],
          },
          false,
          'goBack'
        );
        return entry;
      },

      goForward: (current: NavigationLocation) => {
        const state = get();
        if (state.navigationForward.length === 0) return undefined;
        const entry = state.navigationForward[state.navigationForward.length - 1];
        set(
          {
            navigationHistory: [...state.navigationHistory, current],
            navigationForward: state.navigationForward.slice(0, -1),
          },
          false,
          'goForward'
        );
        return entry;
      },
    }),
    { name: 'ide-store' }
  )
);

// Selector hooks for common use cases
// These use stable selectors to prevent unnecessary re-renders
export const useWorkspace = () => useIDEStore((state) => state.workspace);
export const useWorkspaces = () => useIDEStore((state) => state.workspaces);
export const useActiveWorkspaceId = () => useIDEStore((state) => state.activeWorkspaceId);
export const useActiveWorkspace = () =>
  useIDEStore((state) => state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null);
export const useTreeViewMode = (): 'project' | 'workspace' =>
  useIDEStore((state) => (state.activeWorkspaceId === 'project' ? 'project' : 'workspace'));
export const useSelectedProfileId = (): string | null =>
  useIDEStore((state) => state.selectedProfileId);
export const useCanFocusWorkspace = (): boolean =>
  useIDEStore((state) => state.workspaces.some((w) => w.id !== 'project'));
export const useActiveAccent = (): WorkspaceAccent =>
  useIDEStore(
    (state) =>
      (state.workspaces.find((w) => w.id === state.activeWorkspaceId)?.accent as WorkspaceAccent) ??
      'project'
  );
export const useIsLoading = () => useIDEStore((state) => state.isLoading);
export const useSidebarView = () => useIDEStore((state) => state.activeSidebarView);
export const useIsLeftPanelCollapsed = () => useIDEStore((state) => state.isLeftPanelCollapsed);
export const useIsRightPanelCollapsed = () => useIDEStore((state) => state.isRightPanelCollapsed);
export const useIsBottomPanelCollapsed = () => useIDEStore((state) => state.isBottomPanelCollapsed);
export const useCenterOrder = () => useIDEStore((state) => state.centerOrder);
export const useIsGolemPanelCollapsed = () => useIDEStore((state) => state.isGolemPanelCollapsed);
export const useIsFilesPanelCollapsed = () => useIDEStore((state) => state.isFilesPanelCollapsed);
export const useCenterReveal = () => useIDEStore((state) => state.centerReveal);
export const useOpenFiles = () => useIDEStore((state) => state.openFiles);
export const useActiveFileId = () => useIDEStore((state) => state.activeFileId);
export const useActiveFile = () =>
  useIDEStore((state) => {
    const activeFileId = state.activeFileId;
    return activeFileId ? (state.openFiles.find((f) => f.id === activeFileId) ?? null) : null;
  });
export const useCursorPosition = () => useIDEStore((state) => state.cursorPosition);
export const useTerminalTab = () => useIDEStore((state) => state.activeTerminalTab);
export const useTerminalSessions = () => useIDEStore((state) => state.terminalSessions);
export const useActiveTerminalSessionId = () =>
  useIDEStore((state) => state.activeTerminalSessionId);
export const useActiveTerminalSession = () =>
  useIDEStore((state) => {
    const id = state.activeTerminalSessionId;
    return id ? (state.terminalSessions.find((s) => s.id === id) ?? null) : null;
  });
export const useEditorSyntaxTheme = (): SyntaxThemeId =>
  useIDEStore((state) => state.editorSyntaxTheme);
export const useDirectoryTree = () => useIDEStore((state) => state.directoryTree);
export const useExpandedPaths = () => useIDEStore((state) => state.expandedPaths);
export const useLoadingPaths = () => useIDEStore((s) => s.loadingPaths);
export const useSelectedPath = () => useIDEStore((state) => state.selectedPath);
export const useIsRootExpanded = () => useIDEStore((state) => state.isRootExpanded);
export const useIsLoadingTree = () => useIDEStore((state) => state.isLoadingTree);
export const useTreeError = () => useIDEStore((state) => state.treeError);
export const useToast = () => useIDEStore((state) => state.toast);
export const useRunProfiles = () => useIDEStore((state) => state.runProfiles);
export const useRunProfileState = () => useIDEStore((state) => state.runProfileState);
export const useRunProfileForm = () => useIDEStore((state) => state.runProfileForm);
export const useDetectedProfiles = () =>
  useIDEStore(useShallow((state) => state.runProfiles.filter((p) => p.source === 'detected')));
export const useSavedProfiles = () =>
  useIDEStore(useShallow((state) => state.runProfiles.filter((p) => p.source === 'user')));
export const useIsLoadingProfiles = () => useIDEStore((state) => state.isLoadingProfiles);
export const useProfilesError = () => useIDEStore((state) => state.profilesError);
export const useRecentWorkspaces = () => useIDEStore((state) => state.recentWorkspaces);
export const useRunOutputs = () => useIDEStore((state) => state.runOutputs);
export const useRunCompounds = () => useIDEStore((state) => state.runCompounds);
export const useActiveRunOutputId = () => useIDEStore((state) => state.activeRunOutputId);
export const useActiveRunOutput = () =>
  useIDEStore((state) => {
    const id = state.activeRunOutputId;
    return id && id !== '__all__' ? (state.runOutputs[id] ?? null) : null;
  });
export const useActiveCompoundRun = () =>
  useIDEStore((state) => {
    const id = state.activeRunOutputId;
    const compoundId = id ? state.compoundIdByRunInstance[id] : undefined;
    return compoundId ? (state.runCompounds[compoundId] ?? null) : null;
  });
export const useRunOutputViewMode = () => useIDEStore((state) => state.runOutputViewMode);
export const useRunOutputAutoScroll = () => useIDEStore((state) => state.runOutputAutoScroll);
