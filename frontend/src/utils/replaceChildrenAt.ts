import type { FileEntry } from '../stores/ideStore';
import { normalizePathForComparison } from './lspUri';

/**
 * Returns a new tree where the node at `targetPath` has its unreadable state
 * set and, when supplied, its children replaced. Only nodes on the path from a
 * root to the target are recreated; all other subtrees keep their identity (so
 * memoized consumers and the virtualizer skip untouched branches). Returns the
 * input array unchanged if `targetPath` is not present.
 */
export function replaceChildrenAt(
  nodes: FileEntry[],
  targetPath: string,
  children?: FileEntry[],
  unreadable = false
): FileEntry[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (samePath(node.path, targetPath)) {
      changed = true;
      return {
        ...node,
        ...(children === undefined ? {} : { children }),
        unreadable,
      } as FileEntry;
    }
    if (node.isDir && node.children && isAncestorPath(node.path, targetPath)) {
      const newChildren = replaceChildrenAt(node.children, targetPath, children, unreadable);
      if (newChildren !== node.children) {
        changed = true;
        return { ...node, children: newChildren } as FileEntry;
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

/** True if `ancestor` is a path-prefix segment-boundary parent of `descendant`. */
function isAncestorPath(ancestor: string, descendant: string): boolean {
  const normalizedAncestor = normalizePathForComparison(ancestor);
  const normalizedDescendant = normalizePathForComparison(descendant);
  return (
    normalizedDescendant === normalizedAncestor ||
    normalizedDescendant.startsWith(`${normalizedAncestor}/`)
  );
}

function samePath(a: string, b: string): boolean {
  return normalizePathForComparison(a) === normalizePathForComparison(b);
}
