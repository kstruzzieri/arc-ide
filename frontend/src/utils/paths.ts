// Path-shape normalization shared by git decoration, tree lookups, and any
// map keyed by file path. Git always emits forward slashes (even on Windows,
// including `rev-parse --show-toplevel`), while OS/tree paths may not — so
// every key must pass through here before comparison.

/** Forward slashes only, no trailing slash (except a bare root "/"). */
export function normalizeFsPath(path: string): string {
  const forward = path.replace(/\\/g, '/');
  if (forward.length > 1 && forward.endsWith('/')) {
    return forward.replace(/\/+$/, '') || '/';
  }
  return forward;
}

/** Join a repo root with a porcelain repo-relative path into a normalized key. */
export function joinRepoPath(repoRoot: string, relPath: string): string {
  return `${normalizeFsPath(repoRoot).replace(/\/$/, '')}/${relPath}`;
}
