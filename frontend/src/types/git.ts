// Frontend view of internal/git types plus classification logic. The backend
// ships raw porcelain XY letters; everything presentational lives here.

import { joinRepoPath } from '../utils/paths';

/** Mirrors git.FileChange from the Go backend (generated bindings model shape). */
export interface GitFileChange {
  path: string;
  origPath?: string;
  index: string;
  worktree: string;
  unmerged?: boolean;
}

/** Decoration category for a single tree row / change row. */
export type GitRowStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface ChangeClassification {
  /** Appears in the Staged Changes list (index has a change). */
  staged: boolean;
  /** Appears in the Changes list (worktree differs from index). */
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  /** Intent-to-add entry (porcelain ".A", from git add -N): tracked as an
   * empty index blob, content unstaged. The UI offers untrack on these. */
  intentToAdd: boolean;
  rowStatus: GitRowStatus;
}

const letterStatus: Record<string, GitRowStatus> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
};

/**
 * Buckets one porcelain entry. A partially staged file is legitimately in
 * both staged and unstaged buckets — that is how git models it, and the
 * panel renders it in both lists like JetBrains/VS Code do.
 */
export function classifyChange(change: GitFileChange): ChangeClassification {
  if (change.unmerged) {
    return {
      staged: false,
      unstaged: false,
      untracked: false,
      conflicted: true,
      intentToAdd: false,
      rowStatus: 'conflicted',
    };
  }
  if (change.index === '?') {
    return {
      staged: false,
      unstaged: false,
      untracked: true,
      conflicted: false,
      intentToAdd: false,
      rowStatus: 'untracked',
    };
  }
  const staged = change.index !== '.';
  const unstaged = change.worktree !== '.';
  // ".A" only arises from git add -N: an unstaged addition of a tracked path.
  const intentToAdd = change.index === '.' && change.worktree === 'A';
  // Worktree letter wins for the row look: it is what the user sees on disk.
  const rowStatus =
    (unstaged ? letterStatus[change.worktree] : letterStatus[change.index]) ?? 'modified';
  return { staged, unstaged, untracked: false, conflicted: false, intentToAdd, rowStatus };
}

/**
 * Absolute-path lookup for tree-row decoration. Porcelain paths are
 * repo-root-relative, so join against repoRoot — NOT the workspace path,
 * which may be a subdirectory of the repository. Keys are normalized
 * (forward slashes) so OS-flavored tree paths match after the same
 * normalization.
 */
export function buildStatusByPath(
  repoRoot: string,
  files: GitFileChange[]
): Record<string, GitRowStatus> {
  const map: Record<string, GitRowStatus> = {};
  for (const f of files) {
    map[joinRepoPath(repoRoot, f.path)] = classifyChange(f).rowStatus;
  }
  return map;
}
