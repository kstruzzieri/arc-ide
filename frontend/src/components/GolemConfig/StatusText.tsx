/**
 * Status is a dot plus plain text (spec §4.7) — never a bordered pill and never
 * colour alone. Every caller passes a label, so the dot is decorative.
 */

import styles from './GolemConfig.module.css';

export type StatusTone = 'ok' | 'warn' | 'bad' | 'dim';

export function StatusText({ tone, children }: { tone: StatusTone; children: string }) {
  return (
    <span className={styles.status} data-tone={tone}>
      <span className={styles.statusDot} aria-hidden="true" />
      {children}
    </span>
  );
}
