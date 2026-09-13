/**
 * The Apply bar (#263 spec §4.1 item 4, §3.3, mockup v10).
 *
 * Dirty only, and honest about what "dirty" means: `N staged changes`, one
 * chip per change reading `target · field` (ruling 7), then Discard and Apply.
 * A chip is not decoration — it is the only handle some changes have
 * (a staged provider-add has no applied row to sit on), so every chip opens and
 * focuses the editor that produced it.
 *
 * The bar renders no result state. Consent, drops, conflict, busy, and recovery
 * are their own panels above it, because each one replaces the whole question
 * the bar is asking rather than decorating it.
 */

import type { ApplySource, Change } from '../../types/golemConfig';
import { changeStableID } from '../../types/golemConfig';
import styles from './GolemConfig.module.css';

/**
 * A chip asking a card to open and focus the editor behind one change identity.
 * The nonce makes every request distinct, so clicking the same chip twice
 * focuses twice.
 */
export interface EditorFocusRequest {
  changeId: string;
  nonce: number;
}

/**
 * `target · field`, the one chip grammar (ruling 7); the row's WAS lines carry
 * the values.
 *
 * [C23] A route change bundles model, think and exposure and the bar has no
 * applied document to diff against, so it names the row honestly; a provider
 * update names every field it carries.
 */
export function changeChipLabel(change: Change): string {
  switch (change.kind) {
    case 'route':
      return `${change.useCase} · route`;
    case 'route-unassign':
      return `${change.useCase} · unassigned`;
    case 'provider-add':
      return `${change.name} · new provider`;
    case 'provider-update': {
      const fields = [
        change.endpoint !== undefined ? 'endpoint' : '',
        change.apiFormat !== undefined ? 'type' : '',
      ].filter((field) => field !== '');
      return `${change.name} · ${fields.join(', ')}`;
    }
    case 'provider-remove':
      return `${change.name} · removed`;
    // [F7] Setting a key and clearing one are opposite intents; one label for both
    // left the chip unable to say which of them Apply would send.
    case 'provider-key-set':
      return `${change.name} · API key`;
    case 'provider-key-clear':
      return `${change.name} · API key cleared`;
    // [C6] `removed` alone read as a provider removal: a provider and a model role
    // may carry the same name, and the two chips sat side by side saying the same
    // thing about different things.
    case 'role-remove':
      return `${change.role} · model removed`;
  }
}

const sourceChipLabel = (source: ApplySource): string | null => {
  switch (source.kind) {
    case 'applied':
      return null;
    case 'blank':
      return 'source → blank configuration';
    case 'profile':
      return `source → ${source.profileId}`;
  }
};

export interface ApplyBarProps {
  /** The draft source, so a replacement gets the chip it is counted as. */
  source: ApplySource;
  /** The COALESCED changes — what Apply actually sends (§3.3). */
  changes: readonly Change[];
  /** `changes.length` plus one when the source itself is a replacement. */
  count: number;
  /** Why Apply is unavailable, or null when it is available. */
  blocked: string | null;
  /**
   * True while a settings write or a pending consent challenge owns the
   * request: the chips and Apply are frozen, because the visible request is
   * what the challenge token is bound to (§3.3, §4.6a).
   */
  locked: boolean;
  /**
   * Discard's own lock, deliberately narrower than `locked`: §3.3 has Discard
   * invalidate a pending challenge, which makes it one of §4.6a's
   * cancel-then-transition paths rather than an edit of a frozen request.
   */
  discardLocked: boolean;
  onApply: () => void;
  onDiscard: () => void;
  /** Opens and focuses the editor behind a change chip. */
  onOpenChange: (changeId: string) => void;
  /** Opens the source summary behind the source chip. */
  onOpenSource: () => void;
}

export function ApplyBar({
  source,
  changes,
  count,
  blocked,
  locked,
  discardLocked,
  onApply,
  onDiscard,
  onOpenChange,
  onOpenSource,
}: ApplyBarProps) {
  const sourceChip = sourceChipLabel(source);

  return (
    <div className={styles.draftBar} data-testid="golem-config-draft">
      <span className={styles.draftCount}>{`${count} staged change${count === 1 ? '' : 's'}`}</span>
      <span className={styles.chips}>
        {sourceChip !== null && (
          <button type="button" className={styles.chip} disabled={locked} onClick={onOpenSource}>
            {sourceChip}
          </button>
        )}
        {changes.map((change) => {
          const id = changeStableID(change);
          return (
            <button
              key={id}
              type="button"
              className={styles.chip}
              disabled={locked}
              onClick={() => onOpenChange(id)}
            >
              {changeChipLabel(change)}
            </button>
          );
        })}
      </span>
      <span className={styles.grow} />
      <button
        type="button"
        className={`${styles.button} ${styles.quiet}`}
        disabled={discardLocked}
        onClick={onDiscard}
      >
        Discard
      </button>
      <button
        type="button"
        className={`${styles.button} ${styles.primary}`}
        disabled={locked || blocked !== null}
        onClick={onApply}
      >
        Apply
      </button>
      {blocked !== null && <p className={styles.draftBlocked}>{blocked}</p>}
    </div>
  );
}
