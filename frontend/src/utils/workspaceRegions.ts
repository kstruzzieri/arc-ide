import { normalizePathForComparison } from './lspUri';
import type { WorkspaceAccent, FileEntry } from '../stores/ideStore';
import type { workspace } from '../wails/bindings';

/**
 * Repo-relative, forward-slash path for `absPath` under `repoRoot`.
 * Returns '' for the repo root itself, and null for paths outside the root.
 *
 * Uses normalizePathForComparison (from lspUri) so containment checks share the
 * same cross-platform semantics as the rest of the app: backslashes are
 * converted to forward slashes and Windows drive-letter paths compare
 * case-insensitively. The returned slice preserves the original case.
 */
export function relativePathFromRoot(absPath: string, repoRoot: string): string | null {
  if (!absPath || !repoRoot) return null;

  const toFwd = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = toFwd(absPath);
  const root = toFwd(repoRoot);

  const cmpPath = normalizePathForComparison(path);
  const cmpRoot = normalizePathForComparison(root);

  if (cmpPath === cmpRoot) return '';
  if (cmpPath.startsWith(cmpRoot + '/')) {
    // normalizePathForComparison preserves length, so slicing the original
    // forward-slashed path by the root length yields the correct-case suffix.
    return path.slice(root.length + 1);
  }
  return null;
}

function orderedWorkspaces(workspaces: workspace.WorkspaceDef[]): workspace.WorkspaceDef[] {
  return workspaces
    .filter((candidate) => candidate.id !== 'project')
    .sort((a, b) => b.relDir.length - a.relDir.length);
}

function resolveRelativeWorkspace(
  relPath: string,
  workspaces: workspace.WorkspaceDef[]
): workspace.WorkspaceDef | null {
  return (
    workspaces.find(
      (candidate) =>
        candidate.relDir === '' ||
        relPath === candidate.relDir ||
        relPath.startsWith(candidate.relDir + '/')
    ) ?? null
  );
}

/** Builds a segment-safe, longest-prefix resolver for file workspace ownership. */
export function createWorkspacePathResolver(
  repoRoot: string,
  workspaces: workspace.WorkspaceDef[]
): (absPath: string) => workspace.WorkspaceDef | null {
  const ordered = orderedWorkspaces(workspaces);

  return (absPath: string): workspace.WorkspaceDef | null => {
    const rel = relativePathFromRoot(absPath, repoRoot);
    return rel === null ? null : resolveRelativeWorkspace(rel, ordered);
  };
}

// Exact, case-sensitive Docker filenames. Includes both the legacy
// `docker-compose.*` and the Compose-Spec canonical `compose.*` names.
// ponytail: exact-match only — override/env compose variants
// (docker-compose.prod.yml, compose.override.yaml) are intentionally not
// matched; add pattern matching only if a concrete need appears.
const DOCKER_FILE_NAMES = new Set([
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  '.dockerignore',
]);

/** Fixed file-type accent for Docker and Terraform files at any tree depth. */
export function getInfraFileAccent(
  entry: Pick<FileEntry, 'name' | 'isDir'>
): WorkspaceAccent | null {
  if (entry.isDir) return null;
  if (DOCKER_FILE_NAMES.has(entry.name)) return 'docker';
  return entry.name.endsWith('.tf') || entry.name.endsWith('.tfvars') ? 'terraform' : null;
}

/**
 * Builds a per-entry accent resolver for Project View region tinting. Call once
 * per (repoRoot, workspaces) identity and reuse across all rows.
 *
 * Rules (in order):
 *  1. Longest segment-safe non-empty relDir prefix wins → that workspace accent.
 *  2. Root workspaces (relDir === "") contribute no ambient region tint.
 *  3. Loose root file (not a dir, no path separator) → getInfraFileAccent.
 *  4. Otherwise null.
 */
export function createRegionAccentResolver(
  repoRoot: string,
  workspaces: workspace.WorkspaceDef[]
): (entry: FileEntry) => WorkspaceAccent | null {
  const ordered = orderedWorkspaces(workspaces);

  return (entry: FileEntry): WorkspaceAccent | null => {
    const rel = relativePathFromRoot(entry.path, repoRoot);
    if (rel === null) return null;

    const owner = resolveRelativeWorkspace(rel, ordered);
    if (owner?.relDir) return owner.accent as WorkspaceAccent;

    if (!entry.isDir && !rel.includes('/')) {
      return getInfraFileAccent(entry);
    }
    return null;
  };
}
