import { useCallback, useEffect, useRef, useState } from 'react';
import { matchCommands, type Command } from '../../utils/commands';
import { formatShortcut } from '../../utils/platform';
import styles from './CommandPalette.module.css';

const LISTBOX_ID = 'command-palette-listbox';

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: readonly Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [previousOpen, setPreviousOpen] = useState(open);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restorePendingRef = useRef(false);
  const matches = matchCommands(commands, query);
  const currentIndex = matches.length ? Math.min(activeIndex, matches.length - 1) : -1;
  const activeCommand = currentIndex >= 0 ? matches[currentIndex] : undefined;

  if (open !== previousOpen) {
    setPreviousOpen(open);
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }

  const restoreFocus = useCallback(() => {
    if (!restorePendingRef.current) return;
    restorePendingRef.current = false;
    const previous = previousFocusRef.current;
    const target = previous?.isConnected ? previous : document.getElementById('main-content');
    target?.focus();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      const activeElement = document.activeElement;
      previousFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
      restorePendingRef.current = true;
      if (!dialog.open) dialog.showModal();
      inputRef.current?.focus();
      return;
    }

    if (dialog.open) dialog.close();
    restoreFocus();
  }, [open, restoreFocus]);

  useEffect(
    () => () => {
      const dialog = dialogRef.current;
      if (dialog?.open) dialog.close();
      restoreFocus();
    },
    [restoreFocus]
  );

  useEffect(() => {
    if (open) activeOptionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeCommand, open]);

  const closePalette = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    restoreFocus();
    onClose();
  }, [onClose, restoreFocus]);

  const execute = useCallback(
    (command: Command | undefined) => {
      if (!command || command.enabled?.() === false) return;
      command.run();
      closePalette();
    },
    [closePalette]
  );

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-label="Command palette"
      aria-modal="true"
      onCancel={(event) => {
        // Native close requests (e.g. platform Escape handling) must route
        // through closePalette, or the open prop desyncs from the dialog.
        event.preventDefault();
        closePalette();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();

        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            if (matches.length) setActiveIndex((currentIndex + 1) % matches.length);
            break;
          case 'ArrowUp':
            event.preventDefault();
            if (matches.length) {
              setActiveIndex((currentIndex - 1 + matches.length) % matches.length);
            }
            break;
          case 'Home':
            event.preventDefault();
            if (matches.length) setActiveIndex(0);
            break;
          case 'End':
            event.preventDefault();
            if (matches.length) setActiveIndex(matches.length - 1);
            break;
          case 'Enter':
            event.preventDefault();
            execute(activeCommand);
            break;
          case 'Escape':
            event.preventDefault();
            closePalette();
            break;
          case 'Tab':
            event.preventDefault();
            inputRef.current?.focus();
            break;
        }
      }}
    >
      <input
        ref={inputRef}
        className={styles.search}
        role="combobox"
        aria-label="Command palette"
        aria-autocomplete="list"
        aria-controls={LISTBOX_ID}
        aria-expanded={open}
        aria-activedescendant={
          activeCommand ? `command-palette-option-${activeCommand.id}` : undefined
        }
        placeholder="Type a command"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
      />
      <div className={styles.results}>
        <ul id={LISTBOX_ID} role="listbox" aria-label="Commands" className={styles.list}>
          {matches.map((command, index) => {
            const selected = index === currentIndex;
            return (
              <li key={command.id}>
                <button
                  ref={selected ? activeOptionRef : undefined}
                  id={`command-palette-option-${command.id}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  className={styles.option}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => execute(command)}
                >
                  <span className={styles.title}>{command.title}</span>
                  {command.shortcut && (
                    <kbd className={styles.shortcut}>{formatShortcut(command.shortcut)}</kbd>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {!matches.length && (
          <p className={styles.empty} role="status">
            No commands found
          </p>
        )}
      </div>
    </dialog>
  );
}
