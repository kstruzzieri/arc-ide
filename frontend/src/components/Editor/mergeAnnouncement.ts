import type { MergeDecision } from '../../stores/gitStore';

/** Pure text for the merge surface: the decision names and the live-region
 * announcement. Kept out of MergeResolutionView so that file exports only
 * components and Fast Refresh can hot-swap it. */
export function decisionLabel(decision: MergeDecision | undefined): string {
  switch (decision) {
    case 'C':
      return 'Current';
    case 'I':
      return 'Incoming';
    case 'B':
      return 'Both';
    case 'M':
      return 'Manual';
    default:
      return 'unresolved';
  }
}

export function describeMergeAnnouncement(
  previous: Record<number, MergeDecision>,
  next: Record<number, MergeDecision>,
  totalRegions: number
): string | null {
  const resolved: number[] = [];
  const reopened: number[] = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const index = Number(key);
    if (previous[index] === next[index]) continue;
    if (next[index] === undefined) reopened.push(index);
    else resolved.push(index);
  }
  if (resolved.length === 0 && reopened.length === 0) return null;
  resolved.sort((a, b) => a - b);
  reopened.sort((a, b) => a - b);
  const parts: string[] = [];
  if (resolved.length === 1) {
    parts.push(
      `Conflict ${resolved[0] + 1} resolved: took ${decisionLabel(next[resolved[0]]).toLowerCase()}`
    );
  } else if (resolved.length > 1) {
    parts.push(`Conflicts ${resolved.map((index) => index + 1).join(', ')} resolved`);
  }
  if (reopened.length === 1) {
    parts.push(`Conflict ${reopened[0] + 1} reopened`);
  } else if (reopened.length > 1) {
    parts.push(`Conflicts ${reopened.map((index) => index + 1).join(', ')} reopened`);
  }
  const remaining = totalRegions - Object.keys(next).length;
  return `${parts.join('. ')}. ${remaining} unresolved.`;
}
