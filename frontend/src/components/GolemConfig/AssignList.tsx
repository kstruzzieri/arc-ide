/**
 * The Assign list of a defined-model row (#263 wave 4d): the use cases this
 * model can be routed to, inline under the row. It GROWS the row the way the
 * route editor grows its own — nothing floats, so `.cardBody`'s
 * `overflow-x: auto` can never clip it — and borrows the Source picker's
 * listbox grammar: `aria-activedescendant`, arrows, Home/End, Enter, Escape.
 *
 * Every id here is derived from the owner's INDEX-based `id`, never from the
 * role: identifiers may carry spaces, and `aria-*` id references split on them.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import styles from './GolemConfig.module.css';

export interface AssignOption {
  useCase: string;
  /** `''` when the use case can take this model; otherwise why it cannot — shown, and the option is `aria-disabled`. */
  reason: string;
}

export interface AssignListProps {
  /** DOM id of the listbox; the trigger's `aria-controls` while open. */
  id: string;
  /**
   * The MODEL being routed — the list's accessible name says so. The staged
   * change carries the model's facts and the backend retargets or forks the
   * use case's own role; the defined role itself is never bound.
   */
  modelName: string;
  options: readonly AssignOption[];
  onChoose: (useCase: string) => void;
  /** Escape: the owner unmounts the list and returns focus to the trigger. */
  onClose: () => void;
}

/** Index-derived, never role-derived: identifiers may carry spaces, `#`, `:`. */
const optionId = (id: string, index: number): string => `${id}-o${index}`;

export function AssignList({ id, modelName, options, onChoose, onClose }: AssignListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // The cursor starts on the first use case that can actually be chosen.
  const [active, setActive] = useState(
    Math.max(
      0,
      options.findIndex((option) => option.reason === '')
    )
  );

  // Focus lands on the list once it exists. The list never disables, so a
  // mount effect is the `pendingFocus` idiom with nothing to wait for.
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // [A4] Reveal the cursor: the list scrolls past 320px, and an offscreen active
  // option is a keyboard dead end. jsdom has no scrollIntoView, hence the optional call.
  useEffect(() => {
    document.getElementById(optionId(id, active))?.scrollIntoView?.({ block: 'nearest' });
  }, [id, active]);
  const move = (index: number) => setActive(Math.max(0, Math.min(options.length - 1, index)));
  const choose = (index: number) => {
    const option = options[index];
    if (option === undefined || option.reason !== '') return;
    onChoose(option.useCase);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(active + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(active - 1);
        return;
      case 'Home':
        event.preventDefault();
        move(0);
        return;
      case 'End':
        event.preventDefault();
        move(options.length - 1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        return;
      case 'Escape':
        event.preventDefault();
        // [X7] SaveProfileButton listens for Escape on `document`; stopping here
        // keeps this Escape from also closing an open Save popover.
        event.stopPropagation();
        onClose();
        return;
      default:
        return;
    }
  };

  return (
    <div className={styles.assignPanel}>
      <span id={`${id}-label`} className={styles.fieldLabel}>{`Assign ${modelName} to`}</span>
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-labelledby={`${id}-label`}
        aria-activedescendant={optionId(id, active)}
        tabIndex={-1}
        className={styles.pickerListbox}
        onKeyDown={onKeyDown}
      >
        {options.map((option, index) => (
          <div
            key={option.useCase}
            id={optionId(id, index)}
            role="option"
            aria-selected={false}
            aria-disabled={option.reason !== '' || undefined}
            data-active={index === active || undefined}
            className={styles.pickerOption}
            onPointerMove={() => setActive(index)}
            onClick={() => choose(index)}
          >
            {option.useCase}
            {option.reason !== '' && (
              <span className={styles.pickerAnnotation}>{option.reason}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
