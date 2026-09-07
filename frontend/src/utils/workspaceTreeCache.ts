import type { filesystem } from '../wails/bindings';

const MAX_CACHED_WORKSPACE_TREES = 12;

const workspaceTreeCache = new Map<string, filesystem.FileEntry[]>();

export function getCachedWorkspaceTree(path: string): filesystem.FileEntry[] | undefined {
  if (!path) return undefined;

  const tree = workspaceTreeCache.get(path);
  if (tree === undefined) return undefined;

  // Refresh insertion order so recently-used workspaces stay hot.
  workspaceTreeCache.delete(path);
  workspaceTreeCache.set(path, tree);

  return tree;
}

export function setCachedWorkspaceTree(path: string, tree: filesystem.FileEntry[]): void {
  if (!path) return;

  workspaceTreeCache.delete(path);
  workspaceTreeCache.set(path, tree);

  while (workspaceTreeCache.size > MAX_CACHED_WORKSPACE_TREES) {
    const oldestPath = workspaceTreeCache.keys().next().value;
    if (!oldestPath) break;
    workspaceTreeCache.delete(oldestPath);
  }
}

export function clearWorkspaceTreeCache(): void {
  workspaceTreeCache.clear();
}
