/**
 * Center-pair reorder decisions (#271 spec §4.1–4.2).
 *
 * Pure: no React, no store, no DOM. The bar, the rail and the shell all route
 * their gesture through these two functions, so keyboard and pointer reorder
 * cannot drift apart on which side a panel lands.
 */

import type { CenterOrder, CenterPanel } from './centerLayout';

/** DataTransfer type carried by a center-panel drag; foreign drops lack it. */
export const CENTER_DRAG_MIME = 'application/x-firn-center-panel';

interface ChordKeys {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * ⌘⇧← / ⌘⇧→ (Ctrl on Windows/Linux) on a bar or rail: the order that puts
 * `panel` on the side the arrow points at, or null when the chord does not
 * apply. Mirrors the `chordModifier` shape in useKeyboardShortcuts: Alt makes
 * a different chord, not a sloppier spelling of this one.
 */
export function reorderTargetForKey(
  e: ChordKeys,
  panel: CenterPanel,
  mac: boolean
): CenterOrder | null {
  const modifier = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!modifier || !e.shiftKey || e.altKey) return null;
  if (e.key === 'ArrowLeft') return panel === 'files' ? 'files-first' : 'golem-first';
  if (e.key === 'ArrowRight') return panel === 'files' ? 'golem-first' : 'files-first';
  return null;
}

/**
 * The order an in-flight drag would commit, or null while the drop is a no-op.
 * `initialOrder` is the order captured at dragstart, so the answer is a stable
 * assignment rather than a toggle: repeat delivery of the same drop is
 * harmless. The pointer has to cross the target island's midpoint — until then
 * the drag has not actually asked to pass the other panel.
 */
export function reorderTargetForDrop(
  source: CenterPanel,
  initialOrder: CenterOrder,
  target: CenterPanel,
  midpoint: number,
  clientX: number
): CenterOrder | null {
  if (source === target || !Number.isFinite(midpoint) || !Number.isFinite(clientX)) return null;
  const targetIsLeft = (target === 'files') === (initialOrder === 'files-first');
  if (targetIsLeft ? clientX >= midpoint : clientX <= midpoint) return null;
  return (source === 'files') === targetIsLeft ? 'files-first' : 'golem-first';
}
