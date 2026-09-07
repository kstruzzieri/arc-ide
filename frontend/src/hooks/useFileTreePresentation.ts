import { useMemo } from 'react';
import {
  useWorkspace,
  useWorkspaces,
  useActiveWorkspace,
  useDirectoryTree,
  useTreeViewMode,
  useCanFocusWorkspace,
} from '../stores/ideStore';
import type { FileEntry, WorkspaceAccent } from '../stores/ideStore';
import {
  createRegionAccentResolver,
  createWorkspacePathResolver,
  getInfraFileAccent,
  relativePathFromRoot,
} from '../utils/workspaceRegions';

export interface FileTreePresentation {
  mode: 'project' | 'workspace';
  canFocusWorkspace: boolean;
  /** Repo name (project) or workspace name (workspace). */
  rootLabel: string;
  /** Repo root (project) or workspace dir absolute path (workspace). */
  rootPath: string;
  /** Top-level entries to render as tree roots. */
  roots: FileEntry[];
  /** True when a workspace's relDir cannot be located in the loaded tree. */
  scopedError: boolean;
  /** The scoped workspace directory itself could not be read. */
  rootUnreadable: boolean;
  /**
   * Per-entry tint resolver. Project View → per-region multi-color resolver.
   * Workspace View → uniform resolver returning the active workspace accent.
   */
  getRegionAccent?: (entry: FileEntry) => WorkspaceAccent | null;
  /** Fixed Docker/Terraform accent, independent of the workspace region tint. */
  getFileAccent: (entry: FileEntry) => WorkspaceAccent | null;
  /** Workspace View only: per-row workspace ownership accent. */
  getOwnershipAccent?: (entry: FileEntry) => WorkspaceAccent | null;
  /**
   * Active workspace accent, used for the Workspace-View left rail. Undefined in
   * Project View (regions are multi-color) and when the workspace has no accent.
   */
  treeAccent?: WorkspaceAccent;
}

/**
 * Finds the exact scoped directory, or the nearest unreadable ancestor when
 * that directory cannot yet be reached. This uses the same normalized relative
 * paths as region tinting, including segment-safe Windows/backslash behavior.
 */
function findScopedNode(tree: FileEntry[], repoRoot: string, relDir: string): FileEntry | null {
  for (const entry of tree) {
    if (!entry.isDir) continue;
    const entryRel = relativePathFromRoot(entry.path, repoRoot);
    if (entryRel === relDir) return entry;
    if (!entryRel || !relDir.startsWith(`${entryRel}/`)) continue;
    if (entry.unreadable) return entry;
    const childMatch = entry.children ? findScopedNode(entry.children, repoRoot, relDir) : null;
    if (childMatch) return childMatch;
  }
  return null;
}

export function useFileTreePresentation(): FileTreePresentation {
  const repo = useWorkspace();
  const workspaces = useWorkspaces();
  const active = useActiveWorkspace();
  const tree = useDirectoryTree();
  const mode = useTreeViewMode();
  const canFocusWorkspace = useCanFocusWorkspace();

  const repoRoot = repo?.path ?? '';
  const repoName = repo?.name ?? '';

  const getRegionAccent = useMemo(
    () => (mode === 'project' ? createRegionAccentResolver(repoRoot, workspaces) : undefined),
    [mode, repoRoot, workspaces]
  );
  const getOwnershipAccent = useMemo(() => {
    if (mode !== 'workspace') return undefined;
    const resolveWorkspace = createWorkspacePathResolver(repoRoot, workspaces);
    return (entry: FileEntry): WorkspaceAccent | null =>
      (resolveWorkspace(entry.path)?.accent as WorkspaceAccent) || null;
  }, [mode, repoRoot, workspaces]);

  return useMemo<FileTreePresentation>(() => {
    const base = {
      mode,
      canFocusWorkspace,
      getFileAccent: getInfraFileAccent,
      rootUnreadable: false,
    };

    if (mode === 'project') {
      return {
        ...base,
        rootLabel: repoName,
        rootPath: repoRoot,
        roots: tree,
        scopedError: false,
        getRegionAccent,
      };
    }

    const relDir = active?.relDir ?? '';
    const workspaceLabel = active?.name ?? repoName;
    // The outer rail carries the active scope; row washes follow ownership.
    const treeAccent = (active?.accent as WorkspaceAccent) || undefined;

    if (relDir === '') {
      return {
        ...base,
        rootLabel: workspaceLabel,
        rootPath: repoRoot,
        roots: tree,
        scopedError: false,
        getRegionAccent: getOwnershipAccent,
        getOwnershipAccent,
        treeAccent,
      };
    }

    const scoped = findScopedNode(tree, repoRoot, relDir);
    const scopedIsExact = scoped !== null && relativePathFromRoot(scoped.path, repoRoot) === relDir;
    const rootUnreadable = Boolean(scoped?.unreadable);
    const scopedUnloaded = scopedIsExact && scoped.children === undefined && !rootUnreadable;
    return {
      ...base,
      rootLabel: workspaceLabel,
      rootPath: scoped?.path ?? `${repoRoot}/${relDir}`,
      roots: scopedIsExact ? (scoped.children ?? []) : [],
      scopedError: scoped === null || scopedUnloaded,
      rootUnreadable,
      getRegionAccent: getOwnershipAccent,
      getOwnershipAccent,
      treeAccent,
    };
  }, [
    mode,
    canFocusWorkspace,
    repoName,
    repoRoot,
    tree,
    active,
    getRegionAccent,
    getOwnershipAccent,
  ]);
}
