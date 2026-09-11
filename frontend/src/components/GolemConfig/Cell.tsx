/**
 * One cell of a table row. The header row carries the column names for
 * assistive technology at every width (it is visually hidden, never removed,
 * below 600 container px), so the optional `label` here is an aria-hidden
 * visual echo (`TYPE`, `API KEY`, `THINK`) shown only in the record form.
 */

import type { ReactNode } from 'react';
import styles from './GolemConfig.module.css';

export function Cell({
  label,
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span role="cell" className={`${styles.cell} ${className ?? ''}`}>
      {label !== undefined && (
        <b className={styles.recordLabel} aria-hidden="true">
          {label}
        </b>
      )}
      {children}
    </span>
  );
}
