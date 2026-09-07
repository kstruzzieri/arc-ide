import { useRef } from 'react';
import { useWorkspaces, useActiveWorkspaceId, useIDEStore } from '../../stores/ideStore';
import styles from './WorkspaceTabs.module.css';
import { accentVar } from '../../utils/accent';

/**
 * Workspace-View tab strip. Tabs switch the active workspace (which scopes the
 * tree). Active tab uses its accent. Rendered only in Workspace View.
 */
export function WorkspaceTabs() {
  const workspaces = useWorkspaces();
  const activeId = useActiveWorkspaceId();
  const setActiveWorkspace = useIDEStore((s) => s.setActiveWorkspace);
  const listRef = useRef<HTMLDivElement>(null);

  const tabs = workspaces.filter((w) => w.id !== 'project');
  if (tabs.length === 0) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    if (!items?.length) return;
    const idx = Array.from(items).findIndex((el) => el === document.activeElement);
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        next = idx < items.length - 1 ? idx + 1 : 0;
        break;
      case 'ArrowLeft':
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
  };

  return (
    <div
      ref={listRef}
      className={styles.tabs}
      role="tablist"
      aria-label="Workspaces"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((w) => {
        const isActive = w.id === activeId;
        return (
          <button
            key={w.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={styles.tab}
            style={{ ['--tab-accent' as string]: accentVar(w.accent) } as React.CSSProperties}
            onClick={() => setActiveWorkspace(w.id)}
          >
            <span
              className={styles.dot}
              style={{ background: accentVar(w.accent) }}
              aria-hidden="true"
            />
            {w.name}
          </button>
        );
      })}
    </div>
  );
}
