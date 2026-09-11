/**
 * The Source picker (#312): the ONE control that changes what you are editing.
 * A labelled trigger button over a role="listbox" popover with visible group
 * headings — CURATED · YOURS · START FROM — so the two entries named `local`
 * stay apart in the list, and a group eyebrow keeps them apart while closed.
 * The popover clamps against `.root` (cqw), never the viewport (§4.7).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import styles from './GolemConfig.module.css';
import {
  START_BLANK_VALUE,
  startFromProfileId,
  type ProfileSelectModel,
  type ProfileSelectOption,
} from './profileSelect';

export const SOURCE_PICKER_ID = 'golem-profile-select';
export const SOURCE_CURRENT_ID = `${SOURCE_PICKER_ID}-current`;
export const SOURCE_DESCRIPTION_ID = `${SOURCE_PICKER_ID}-desc`;
export const SOURCE_LOADING_ID = `${SOURCE_PICKER_ID}-loading`;
const LIST_ID = `${SOURCE_PICKER_ID}-list`;
const LABEL_ID = `${SOURCE_PICKER_ID}-label`;
/** [F1] The notices live OUTSIDE the listbox (a `<p>` is an illegal listbox child)
 *  and reach it through `aria-describedby`. */
const REFUSAL_ID = `${LIST_ID}-refusal`;
const NOTICE_ID = `${LIST_ID}-notice`;

type Group = '' | 'Curated' | 'Yours' | 'Start from';
/** [C2] ids may not contain spaces: `aria-labelledby` splits on them. */
const GROUP_ID: Record<Exclude<Group, ''>, string> = {
  Curated: `${LIST_ID}-g-curated`,
  Yours: `${LIST_ID}-g-yours`,
  'Start from': `${LIST_ID}-g-start-from`,
};
const UNAVAILABLE_SUFFIX = ' (unavailable)';

interface Row {
  option: ProfileSelectOption;
  label: string;
  group: Group;
  annotation: string;
  start: boolean;
}

export interface SourcePickerProps {
  model: ProfileSelectModel;
  /** The ONE gate (§4.8 amended): projection === null || sourceLocked || saving. */
  disabled: boolean;
  /** Space-separated ids of the description / loading lines, or undefined. */
  describedBy: string | undefined;
  /**
   * [K8][N5] '' or the ONE Invalid/Limited refusal, covering both unselectable
   * halves of the list: it disables the START FROM entries, and it names (never
   * causes) the refusal the MODEL already applies to the profile rows off `ready`.
   * The two conditions are the same two states, so they are one notice and one id.
   */
  refusal: string;
  /** [A5] `Loading profiles…` while the list is unloaded, the bounded message while unavailable, '' otherwise. */
  listNotice: string;
  onOpen: () => void;
  onSelect: (value: string) => void;
  onStartBlank: () => void;
  onStartFromProfile: (profileId: string) => void;
}

function flatten(model: ProfileSelectModel, refusal: string): Row[] {
  const plain = (
    option: ProfileSelectOption,
    group: Group,
    annotation = '',
    start = false
  ): Row => ({
    option,
    // [C9] The shipped model appends the suffix ONLY for a proven-absent retention; the picker
    // shows that fact as a trailing annotation and never invents it for a limited/unloaded list.
    label: option.label.endsWith(UNAVAILABLE_SUFFIX)
      ? option.label.slice(0, -UNAVAILABLE_SUFFIX.length)
      : option.label,
    group,
    annotation: option.label.endsWith(UNAVAILABLE_SUFFIX) ? 'unavailable' : annotation,
    start,
  });
  const rows: Row[] = [plain(model.applied, '', model.applied.disabled ? '' : 'on disk')];
  if (model.blank !== null) rows.push(plain(model.blank, ''));
  if (model.retained !== null) rows.push(plain(model.retained, ''));
  for (const option of model.curated) rows.push(plain(option, 'Curated'));
  for (const option of model.yours) rows.push(plain(option, 'Yours'));
  const startDisabled = refusal !== '';
  rows.push(
    plain({ ...model.startFrom.blank, disabled: startDisabled }, 'Start from', 'new draft', true)
  );
  for (const option of model.startFrom.curated) {
    rows.push(plain({ ...option, disabled: startDisabled }, 'Start from', 'new draft', true));
  }
  return rows;
}

export function SourcePicker({
  model,
  disabled,
  describedBy,
  refusal,
  listNotice,
  onOpen,
  onSelect,
  onStartBlank,
  onStartFromProfile,
}: SourcePickerProps) {
  const [open, setOpen] = useState(false);
  // [C8] The active entry is tracked by IDENTITY (option value), not index: `onOpen` starts an
  // async list refresh that can add, drop or reorder rows while the user is arrowing.
  const [activeValue, setActiveValue] = useState<string | null>(null);
  /** A fresh object per request, so the focus effect runs once per open (RoutingCard's pendingFocus idiom). */
  const [pendingFocus, setPendingFocus] = useState<{ target: 'list' } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = flatten(model, refusal);
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.option.value === model.value)
  );
  // [A4] -1 when the active identity vanished from a refreshed list: nothing is active, Enter is
  // a no-op, aria-activedescendant is absent. Never a silent snap to another entry.
  const activeIndex = rows.findIndex((row) => row.option.value === activeValue);
  const active = activeIndex === -1 ? undefined : rows[activeIndex];
  /** [A4] First-letter type-ahead: characters typed within 500ms accumulate into one prefix. */
  const typeahead = useRef<{ prefix: string; at: number }>({ prefix: '', at: 0 });

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  // [C10] The focus request is set in the SAME synchronous block as the open state — never
  // derived from `open` in a separate effect — so React batches both into one commit.
  const openList = () => {
    setActiveValue(rows[selectedIndex].option.value);
    setOpen(true);
    setPendingFocus({ target: 'list' });
    onOpen();
  };
  useEffect(() => {
    if (pendingFocus === null) return;
    listRef.current?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);
  // [A4] Reveal the active option; jsdom has no scrollIntoView, hence the optional call.
  useEffect(() => {
    if (!open || activeValue === null) return;
    const index = rows.findIndex((row) => row.option.value === activeValue);
    if (index >= 0)
      document.getElementById(`${LIST_ID}-o${index}`)?.scrollIntoView?.({ block: 'nearest' });
    // rows is derived from props; the effect keys on the identity that moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeValue]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const choose = (row: Row | undefined) => {
    if (row === undefined || row.option.disabled) return;
    close(true);
    if (row.option.value === START_BLANK_VALUE) {
      onStartBlank();
      return;
    }
    const startId = startFromProfileId(row.option.value);
    if (startId !== null) {
      onStartFromProfile(startId);
      return;
    }
    if (row.option.value !== model.value) onSelect(row.option.value);
  };
  const move = (index: number) =>
    setActiveValue(rows[Math.max(0, Math.min(rows.length - 1, index))].option.value);
  const typeTo = (key: string) => {
    const now = Date.now();
    const prefix =
      (now - typeahead.current.at < 500 ? typeahead.current.prefix : '') + key.toLowerCase();
    typeahead.current = { prefix, at: now };
    const from = activeIndex === -1 ? 0 : activeIndex + (prefix.length === 1 ? 1 : 0);
    const order = [...rows.slice(from), ...rows.slice(0, from)];
    const hit = order.find((row) => row.label.toLowerCase().startsWith(prefix));
    if (hit !== undefined) setActiveValue(hit.option.value);
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openList();
    }
  };
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(activeIndex === -1 ? 0 : activeIndex + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(activeIndex === -1 ? 0 : activeIndex - 1);
        return;
      case 'Home':
        event.preventDefault();
        move(0);
        return;
      case 'End':
        event.preventDefault();
        move(rows.length - 1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        return;
      case 'Escape':
        event.preventDefault();
        // [X7] SaveProfileButton listens for Escape on `document`; React attaches this
        // handler to the root container, BELOW document, so stopping propagation here
        // keeps a picker Escape from also closing an open Save popover.
        event.stopPropagation();
        close(true);
        return;
      // [C10] Tab departs FROM THE TRIGGER: focus it synchronously (the list unmounts), and the
      // browser's default Tab / Shift+Tab then moves to the trigger's neighbour — no preventDefault.
      case 'Tab':
        close(true);
        return;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          typeTo(event.key);
        }
    }
  };

  const optionId = (index: number) => `${LIST_ID}-o${index}`;
  const selected = rows[selectedIndex];
  const currentText =
    model.applied.disabled && model.value === model.applied.value
      ? model.applied.label
      : `${model.group !== '' ? `${model.group} · ` : ''}${selected.label}${selected.annotation === 'unavailable' ? ' (unavailable)' : ''}`;
  const triggerText =
    model.applied.disabled && model.value === model.applied.value ? (
      <span className={`${styles.pickerValue} ${styles.pickerEmpty}`}>{model.applied.label}</span>
    ) : (
      <span className={styles.pickerValue}>
        {model.group !== '' && <span className={styles.pickerGroup}>{model.group}</span>}
        {selected.label}
      </span>
    );

  function renderOption(row: Row, index: number) {
    // [K8][N5] A disabled row says WHY it is disabled — the same sentence the list's
    // one refusal notice carries, on the row the user actually pointed at.
    return (
      <div
        key={row.option.value}
        id={optionId(index)}
        role="option"
        aria-selected={row.option.value === model.value}
        aria-disabled={row.option.disabled || undefined}
        title={row.option.disabled && refusal !== '' ? refusal : undefined}
        data-active={index === activeIndex || undefined}
        className={`${styles.pickerOption} ${row.start ? styles.pickerStart : ''}`}
        onPointerMove={() => setActiveValue(row.option.value)}
        onClick={() => choose(row)}
      >
        {row.label}
        {row.annotation !== '' && <span className={styles.pickerAnnotation}>{row.annotation}</span>}
      </div>
    );
  }

  // Ungrouped rows first, then one role="group" per named group, in flattened order.
  const items: ReactElement[] = rows
    .filter((row) => row.group === '')
    .map((row) => renderOption(row, rows.indexOf(row)));
  for (const group of ['Curated', 'Yours', 'Start from'] as const) {
    const groupRows = rows.filter((row) => row.group === group);
    if (groupRows.length === 0) continue;
    items.push(
      <div
        key={GROUP_ID[group]}
        role="group"
        aria-labelledby={GROUP_ID[group]}
        className={styles.pickerGroupBlock}
      >
        <div id={GROUP_ID[group]} className={styles.pickerHeading} role="presentation">
          {group}
        </div>
        {groupRows.map((row) => renderOption(row, rows.indexOf(row)))}
      </div>
    );
  }

  return (
    <div className={styles.picker} ref={rootRef}>
      <label className={styles.sourceLabel} id={LABEL_ID} htmlFor={SOURCE_PICKER_ID}>
        Source
      </label>
      {/* [C11] The label is the button's NAME; the current value reaches assistive technology as its description. */}
      <span
        id={SOURCE_CURRENT_ID}
        className={styles.srOnly}
      >{`Current source: ${currentText}`}</span>
      <button
        type="button"
        ref={triggerRef}
        id={SOURCE_PICKER_ID}
        className={styles.pickerTrigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={LIST_ID}
        // [F2] The accessible NAME is exactly `Source` in every browser: `<label
        // htmlFor>` names a <button> only in some engines, so the labelledby is
        // explicit. The current value stays a DESCRIPTION, never part of the name.
        aria-labelledby={LABEL_ID}
        aria-describedby={[SOURCE_CURRENT_ID, describedBy ?? '']
          .filter((id) => id !== '')
          .join(' ')}
        data-value={model.value}
        disabled={disabled}
        onKeyDown={onTriggerKey}
        onClick={() => (open ? close(false) : openList())}
      >
        {triggerText}
        {selected.annotation === 'unavailable' && (
          <span className={styles.pickerFlag}>unavailable</span>
        )}
        <svg className={styles.pickerCaret} viewBox="0 0 8 5" aria-hidden="true">
          <path d="M0 0l4 5 4-5z" />
        </svg>
      </button>
      {open && (
        // [F1] A plain popover wrapper: the listbox owns ONLY options and groups —
        // a `<p>` among them is an illegal listbox child — and the notices sit
        // beside it, reachable through the listbox's `aria-describedby`.
        <div className={styles.pickerList}>
          <div
            ref={listRef}
            id={LIST_ID}
            role="listbox"
            aria-labelledby={LABEL_ID}
            aria-describedby={
              [refusal !== '' ? REFUSAL_ID : '', listNotice !== '' ? NOTICE_ID : '']
                .filter((id) => id !== '')
                .join(' ') || undefined
            }
            aria-activedescendant={activeIndex === -1 ? undefined : optionId(activeIndex)}
            tabIndex={-1}
            className={styles.pickerListbox}
            onKeyDown={onListKey}
          >
            {items}
          </div>
          {refusal !== '' && (
            <p id={REFUSAL_ID} className={styles.menuHint}>
              {refusal}
            </p>
          )}
          {listNotice !== '' && (
            <p id={NOTICE_ID} className={styles.menuHint}>
              {listNotice}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
