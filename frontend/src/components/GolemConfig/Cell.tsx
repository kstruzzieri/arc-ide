/**
 * One labelled cell of a row strip.
 *
 * The visible column-header row is decorative (`aria-hidden`), so each cell
 * carries its own column name. The label is a real element rather than
 * generated `::before` content: it is the accessible name of the cell at every
 * width, and it simply stops being visually hidden under the narrow container
 * query, where the header row is dropped and the strip stacks. One mechanism
 * instead of a screen-reader label plus a CSS-only visual label that would
 * double-announce.
 */

import type { ReactNode } from 'react';
import styles from './GolemConfig.module.css';

export function Cell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={className}>
      <span className={styles.cellLabel}>{label}</span>
      {children}
    </span>
  );
}
