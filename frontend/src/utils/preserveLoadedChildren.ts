import type { FileEntry } from '../stores/ideStore';

/**
 * Merges a freshly-read shallow directory level (`newLevel`) over the previous
 * level (`oldLevel`), preserving the already-loaded `children` of any child
 * directory that still exists (matched by path). New entries come in as-is
 * (unloaded dirs stay unloaded); removed entries drop out. Used by reconcile so
 * re-reading one directory level does not blow away the loaded state of surviving
 * subdirectories.
 */
export function preserveLoadedChildren(
  oldLevel: FileEntry[] | undefined,
  newLevel: FileEntry[]
): FileEntry[] {
  if (!oldLevel || oldLevel.length === 0) return newLevel;
  const byPath = new Map(oldLevel.map((n) => [n.path, n]));
  return newLevel.map((n) => {
    const prev = byPath.get(n.path);
    if (!prev || !n.isDir || (prev.children === undefined && !prev.unreadable)) return n;
    return {
      ...n,
      ...(prev.children === undefined ? {} : { children: prev.children }),
      ...(prev.unreadable ? { unreadable: true } : {}),
    } as FileEntry;
  });
}
