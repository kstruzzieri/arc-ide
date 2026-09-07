import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './WorkspaceSelector.module.css';
import { ChevronDownIcon } from '../icons';
import {
  useWorkspace,
  useWorkspaces,
  useActiveWorkspaceId,
  useIDEStore,
} from '../../stores/ideStore';
import { EventsOn } from '../../wails/runtime';
import { accentVar } from '../../utils/accent';

const MENU_ID = 'workspace-selector-menu';

export function WorkspaceSelector() {
  const repo = useWorkspace();
  const workspaces = useWorkspaces();
  const activeId = useActiveWorkspaceId();
  const setActiveWorkspace = useIDEStore((s) => s.setActiveWorkspace);

  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const select = useCallback(
    (id: string) => {
      if (id !== activeId) setActiveWorkspace(id);
      setIsOpen(false);
      buttonRef.current?.focus();
    },
    [setActiveWorkspace, activeId]
  );

  const handleTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' && !isOpen) {
        e.preventDefault();
        setIsOpen(true);
      }
    },
    [isOpen]
  );

  // Open via the native-menu shortcut (Cmd/Ctrl+Shift+.).
  useEffect(() => {
    const off = EventsOn('menu:switch-workspace', () => setIsOpen(true));
    return () => off();
  }, []);

  // Arrow / Home / End navigation within the menu.
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    if (!items?.length) return;
    const idx = Array.from(items).findIndex((el) => el === document.activeElement);
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        next = idx < items.length - 1 ? idx + 1 : 0;
        break;
      case 'ArrowUp':
        e.preventDefault();
        next = idx > 0 ? idx - 1 : items.length - 1;
        break;
      case 'Home':
        e.preventDefault();
        next = 0;
        break;
      case 'End':
        e.preventDefault();
        next = items.length - 1;
        break;
    }
    if (next !== null) items[next].focus();
  }, []);

  // Focus the first item when opened; cancel the frame if we close/unmount first.
  useEffect(() => {
    if (!isOpen) return;
    const raf = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!isOpen) return;
    function onClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [isOpen]);

  if (!repo) return null;

  return (
    <div className={styles.wrapper}>
      <button
        type="button"
        ref={buttonRef}
        className={styles.trigger}
        onClick={() => setIsOpen((p) => !p)}
        onKeyDown={handleTriggerKeyDown}
        aria-label="Workspace selector"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? MENU_ID : undefined}
      >
        <span
          className={styles.dot}
          style={{ background: accentVar(active?.accent ?? 'project') }}
          aria-hidden="true"
        />
        <span className={styles.name}>{active?.name ?? 'Project'}</span>
        <ChevronDownIcon className={styles.chevron} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          id={MENU_ID}
          className={styles.menu}
          role="menu"
          aria-label="Workspaces"
          onKeyDown={handleMenuKeyDown}
        >
          <div className={styles.menuLabel} role="presentation">
            Workspaces
          </div>
          {workspaces.map((w) => (
            <button
              type="button"
              key={w.id}
              className={styles.menuItem}
              role="menuitemradio"
              aria-checked={w.id === activeId}
              tabIndex={-1}
              onClick={() => select(w.id)}
              title={w.relDir || './'}
            >
              <span
                className={styles.dot}
                style={{ background: accentVar(w.accent) }}
                aria-hidden="true"
              />
              <span className={styles.itemName}>{w.name}</span>
              <span className={styles.itemDir}>{w.relDir || './'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
