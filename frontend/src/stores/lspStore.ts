import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { fileURIToPath, pathsReferToSameFile } from '../utils/lspUri';
import { getPlatform } from '../utils/platform';

const pathSep = getPlatform() === 'windows' ? '\\' : '/';

/**
 * Reports whether `child` is exactly `parent` or strictly below it.
 *
 * Both arguments must use the host platform's path separator and be
 * cleaned absolute paths (the backend cleans them via filepath.Clean
 * before emitting). A separator-suffixed prefix check is used so that
 * "/foo/bar" is not falsely classified as a child of "/foo/ba".
 *
 * Case sensitivity follows the underlying filesystem behavior of the
 * paths — since both sides come from the same Go source they will be
 * cased consistently in practice.
 */
export function pathContainsOrEquals(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  if (parent === child) return true;
  const parentWithSep = parent.endsWith(pathSep) ? parent : parent + pathSep;
  return child.startsWith(parentWithSep);
}

// --- Types ---

export interface LSPPosition {
  line: number;
  character: number;
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface LSPDiagnostic {
  range: LSPRange;
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
}

export type LSPSetupState =
  | 'ready'
  | 'missing_server'
  | 'missing_interpreter'
  | 'misconfigured_env'
  | 'config_degraded'
  | 'retryable'
  | 'provisioning'
  | 'offline'
  | 'provision_failed';

export type LSPSetupAction = 'create_venv' | 'select_interpreter' | 'retry';

export interface LSPServerStatus {
  family: string;
  workspace: string;
  command?: string;
  state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'error';
  error?: string;
  completionTriggerCharacters?: string[];
  setupState?: LSPSetupState;
  provisionPct?: number;
  interpreterPath?: string;
  projectRoot?: string;
  configSource?: string;
  extraPaths?: string[];
  pythonVersion?: string;
  action?: LSPSetupAction;
  detailCode?: string;
}

// --- Store ---

/** Build the composite key for serverStatuses. */
export function serverStatusKey(workspace: string, family: string): string {
  return `${workspace}::${family}`;
}

interface LSPState {
  /** URI -> diagnostics array. Updated by publishDiagnostics notifications. */
  diagnostics: Map<string, LSPDiagnostic[]>;
  /** "workspace::family" -> server status. Updated by lsp:status events. */
  serverStatuses: Map<string, LSPServerStatus>;
  /**
   * Last completed conflict-state read, written by useConflictProjectionSync
   * (mounted once at App level so it survives the bottom panel collapsing).
   * Consumers filter it against the current git status before use.
   */
  conflictRead: ConflictProjectionRead | null;
}

interface LSPActions {
  setDiagnostics: (uri: string, diagnostics: LSPDiagnostic[]) => void;
  removeDiagnostics: (uri: string) => void;
  clearAllDiagnostics: () => void;
  setConflictRead: (read: ConflictProjectionRead | null) => void;

  setServerStatus: (status: LSPServerStatus) => void;
  removeServerStatus: (workspace: string, family: string) => void;
  clearAllStatuses: () => void;

  /** Clear server statuses for a given workspace. */
  clearWorkspaceState: (workspace: string) => void;

  /** Derived: total count of severity=1 diagnostics across all files.
   *  Note: This is a method, not a reactive selector. Phase 4 should convert
   *  to proper derived state when wiring StatusBar consumers. */
  errorCount: () => number;
  /** Derived: total count of severity=2 diagnostics across all files. */
  warningCount: () => number;
}

type LSPStore = LSPState & LSPActions;

export const useLSPStore = create<LSPStore>()(
  devtools(
    (set, get) => ({
      diagnostics: new Map(),
      serverStatuses: new Map(),
      conflictRead: null,

      setDiagnostics: (uri, diagnostics) =>
        set(
          (state) => {
            const next = new Map(state.diagnostics);
            next.set(uri, diagnostics);
            return { diagnostics: next };
          },
          false,
          'setDiagnostics'
        ),

      removeDiagnostics: (uri) =>
        set(
          (state) => {
            const next = new Map(state.diagnostics);
            next.delete(uri);
            return { diagnostics: next };
          },
          false,
          'removeDiagnostics'
        ),

      clearAllDiagnostics: () => set({ diagnostics: new Map() }, false, 'clearAllDiagnostics'),

      setConflictRead: (read) => set({ conflictRead: read }, false, 'setConflictRead'),

      setServerStatus: (status) =>
        set(
          (state) => {
            const next = new Map(state.serverStatuses);
            next.set(serverStatusKey(status.workspace, status.family), status);
            return { serverStatuses: next };
          },
          false,
          'setServerStatus'
        ),

      removeServerStatus: (workspace, family) =>
        set(
          (state) => {
            const next = new Map(state.serverStatuses);
            next.delete(serverStatusKey(workspace, family));
            return { serverStatuses: next };
          },
          false,
          'removeServerStatus'
        ),

      clearAllStatuses: () => set({ serverStatuses: new Map() }, false, 'clearAllStatuses'),

      clearWorkspaceState: (workspace) =>
        set(
          (state) => {
            // Server status entries may be keyed by nested project roots
            // (TypeScript monorepo packages). Clearing a workspace must
            // sweep every status whose root is at or beneath the cleared
            // workspace path, not just exact matches.
            const nextStatuses = new Map(state.serverStatuses);
            for (const [key, status] of nextStatuses) {
              if (pathContainsOrEquals(workspace, status.workspace)) {
                nextStatuses.delete(key);
              }
            }
            return { serverStatuses: nextStatuses };
          },
          false,
          'clearWorkspaceState'
        ),

      errorCount: () => {
        let count = 0;
        for (const diags of get().diagnostics.values()) {
          for (const d of diags) {
            if (d.severity === 1) count++;
          }
        }
        return count;
      },

      warningCount: () => {
        let count = 0;
        for (const diags of get().diagnostics.values()) {
          for (const d of diags) {
            if (d.severity === 2) count++;
          }
        }
        return count;
      },
    }),
    { name: 'lsp-store' }
  )
);

/**
 * Finds the most specific server status for a file path.
 *
 * Since TypeScript root detection (#20) keys servers by detected project
 * root rather than the active workspace, the editor needs to look up
 * status by the file's path: it picks the status whose `workspace` is
 * the longest prefix of `filePath` for the matching family. This makes
 * completion trigger characters and ready-state UX work correctly for
 * nested monorepo packages.
 *
 * For language families that still key by active workspace root, the
 * lookup also works because the workspace prefix is the only candidate
 * and it always wins.
 *
 * Returns undefined when no server for the family covers the file.
 */
export function findServerStatusForFile(
  serverStatuses: Map<string, LSPServerStatus>,
  filePath: string,
  family: string
): LSPServerStatus | undefined {
  if (!filePath) return undefined;
  let best: LSPServerStatus | undefined;
  let bestLen = -1;
  for (const status of serverStatuses.values()) {
    if (status.family !== family) continue;
    if (!pathContainsOrEquals(status.workspace, filePath)) continue;
    if (status.workspace.length > bestLen) {
      best = status;
      bestLen = status.workspace.length;
    }
  }
  return best;
}

// --- Reactive selector hooks ---

function countByPredicate(
  diagnostics: Map<string, LSPDiagnostic[]>,
  predicate: (diagnostic: LSPDiagnostic) => boolean
): number {
  let count = 0;
  for (const diags of diagnostics.values()) {
    for (const d of diags) {
      if (predicate(d)) count++;
    }
  }
  return count;
}

/** Reactive total count of diagnostics shown in the Problems panel. */
export const useLSPDiagnosticCount = () =>
  useLSPStore((state) => countByPredicate(state.diagnostics, () => true));

/** Diagnostics for a specific URI. Returns empty array if none. */
export const useDiagnosticsForURI = (uri: string | null) =>
  useLSPStore((state) => (uri ? (state.diagnostics.get(uri) ?? []) : []));

export interface GroupedDiagnostic {
  filePath: string;
  uri: string;
  diagnostics: LSPDiagnostic[];
}

export interface ConflictDiagnosticSummary {
  filePath: string;
  repoRoot: string;
  repoPath: string;
  unresolvedRegionCount: number;
  markerLineCount: number;
}

export type ProblemsGroup =
  | ({ kind: 'diagnostics' } & GroupedDiagnostic)
  | ({ kind: 'conflict' } & ConflictDiagnosticSummary);

export interface ProblemsProjection {
  groups: ProblemsGroup[];
  count: number;
}

/** A completed conflict-state sweep, tagged with the repo identity it read. */
export interface ConflictProjectionRead {
  repoRoot: string;
  epoch: number;
  conflicts: ConflictDiagnosticSummary[];
}

export interface ProblemsSeverityTotals {
  errors: number;
  warnings: number;
  info: number;
}

/**
 * Severity breakdown of a Problems projection, for the StatusBar summary.
 * Conflict regions count as warnings and the conflicted file's raw
 * diagnostics are already suppressed by the projection, so these totals
 * always sum to the projection count shown on the Problems tab badge.
 */
export function computeProblemsSeverityTotals(
  projection: ProblemsProjection
): ProblemsSeverityTotals {
  const totals: ProblemsSeverityTotals = { errors: 0, warnings: 0, info: 0 };
  for (const group of projection.groups) {
    if (group.kind === 'conflict') {
      totals.warnings += group.unresolvedRegionCount;
      continue;
    }
    for (const d of group.diagnostics) {
      if (d.severity === 1) totals.errors++;
      else if (d.severity === 2) totals.warnings++;
      else totals.info++;
    }
  }
  return totals;
}

/** Compute grouped diagnostics from a diagnostics Map. Pure function for use in selectors. */
export function computeGroupedDiagnostics(
  diagnostics: Map<string, LSPDiagnostic[]>
): GroupedDiagnostic[] {
  const groups: GroupedDiagnostic[] = [];
  for (const [uri, diags] of diagnostics) {
    if (diags.length === 0) continue;
    const filePath = fileURIToPath(uri) ?? uri;
    groups.push({ filePath, uri, diagnostics: diags });
  }

  // Sort groups: files with errors first, then by path
  groups.sort((a, b) => {
    const aHasError = a.diagnostics.some((d) => d.severity === 1);
    const bHasError = b.diagnostics.some((d) => d.severity === 1);
    if (aHasError !== bHasError) return aHasError ? -1 : 1;
    return a.filePath.localeCompare(b.filePath);
  });

  // Sort diagnostics within each group
  for (const group of groups) {
    group.diagnostics = [...group.diagnostics].sort((a, b) => {
      if ((a.severity ?? 4) !== (b.severity ?? 4)) return (a.severity ?? 4) - (b.severity ?? 4);
      if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
      return a.range.start.character - b.range.start.character;
    });
  }

  return groups;
}

/** Derive the ordinary Problems view without altering published LSP diagnostics. */
export function computeProblemsProjection(
  diagnostics: Map<string, LSPDiagnostic[]>,
  conflicts: ConflictDiagnosticSummary[]
): ProblemsProjection {
  const groups: ProblemsGroup[] = [];
  const emittedConflicts = new Set<number>();
  let count = 0;

  for (const group of computeGroupedDiagnostics(diagnostics)) {
    const conflictIndex = conflicts.findIndex((conflict) =>
      pathsReferToSameFile(conflict.filePath, group.filePath)
    );
    if (conflictIndex < 0) {
      groups.push({ kind: 'diagnostics', ...group });
      count += group.diagnostics.length;
      continue;
    }
    if (emittedConflicts.has(conflictIndex)) continue;

    const conflict = conflicts[conflictIndex];
    groups.push({ kind: 'conflict', ...conflict });
    count += conflict.unresolvedRegionCount;
    emittedConflicts.add(conflictIndex);
  }

  conflicts.forEach((conflict, index) => {
    if (emittedConflicts.has(index)) return;
    groups.push({ kind: 'conflict', ...conflict });
    count += conflict.unresolvedRegionCount;
  });

  return { groups, count };
}

/** Reactive hook: all diagnostics grouped by file. Uses the diagnostics map reference for subscription. */
export function useGroupedDiagnostics(): GroupedDiagnostic[] {
  const diagnostics = useLSPStore((state) => state.diagnostics);
  return computeGroupedDiagnostics(diagnostics);
}
