import { memo, useState, useRef, useEffect, useCallback } from 'react';
import styles from './Header.module.css';
import { ChevronDownIcon, SearchIcon, FolderOutlineIcon, FolderOpenOutlineIcon } from '../icons';
import { useWorkspace, useRecentWorkspaces } from '../../stores/ideStore';
import { useOpenFolder } from '../../hooks/useOpenFolder';
import { openWorkspaceByPath } from '../../utils/workspace';
import { formatShortcut, isMac } from '../../utils/platform';
import firnIcon from '../../assets/branding/icon.svg';
import { WorkspaceSelector } from './WorkspaceSelector';
import { RunProfileSelector } from './RunProfileSelector';
import { BranchSwitcher } from '../git/BranchSwitcher';

const MENU_ID = 'workspace-menu';

/**
 * Memoised because #271 makes the shell re-render at pointer rate during a seam
 * drag or a panel reorder, and the shell calls its `header` render-prop on every
 * one of those renders. The single prop is the shell's own stable
 * `openCommandPalette` callback, so the memo actually bails out; everything else
 * the header shows comes from store subscriptions that re-render it on their own.
 */
export const Header = memo(function Header({
  onOpenCommandPalette,
}: {
  onOpenCommandPalette: () => void;
}) {
  const workspace = useWorkspace();
  const workspaceName = workspace?.name || 'No workspace';
  const { openFolder } = useOpenFolder();
  const recentWorkspaces = useRecentWorkspaces();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Filter out current workspace from recent list
  const recentProjects = recentWorkspaces.filter((w) => w.path !== workspace?.path);

  const toggleMenu = useCallback(() => {
    setIsMenuOpen((prev) => !prev);
  }, []);

  const handleOpenFolder = useCallback(() => {
    setIsMenuOpen(false);
    openFolder();
  }, [openFolder]);

  const handleOpenRecent = useCallback((path: string) => {
    setIsMenuOpen(false);
    openWorkspaceByPath(path);
  }, []);

  // Keyboard support on the trigger button
  const handleButtonKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' && !isMenuOpen) {
        e.preventDefault();
        setIsMenuOpen(true);
      }
    },
    [isMenuOpen]
  );

  // Arrow key / Home / End navigation within the menu
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items?.length) return;

    const currentIndex = Array.from(items).findIndex((el) => el === document.activeElement);
    let nextIndex: number | null = null;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
        break;
      case 'ArrowUp':
        e.preventDefault();
        nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
        break;
      case 'Home':
        e.preventDefault();
        nextIndex = 0;
        break;
      case 'End':
        e.preventDefault();
        nextIndex = items.length - 1;
        break;
    }

    if (nextIndex !== null) {
      items[nextIndex].focus();
    }
  }, []);

  // Auto-focus first menu item when opened
  useEffect(() => {
    if (isMenuOpen) {
      requestAnimationFrame(() => {
        menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
      });
    }
  }, [isMenuOpen]);

  // Close menu on outside click or Escape
  useEffect(() => {
    if (!isMenuOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsMenuOpen(false);
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsMenuOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isMenuOpen]);

  return (
    <>
      {/* Traffic lights spacer (macOS only) */}
      {isMac() && <div className={styles.trafficLights} aria-hidden="true" />}

      {/* Logo */}
      <div className={styles.logo}>
        <img src={firnIcon} alt="Firn" className={styles.logoIcon} />
        <span className={styles.logoText}>Firn</span>
      </div>

      {/* Workspace selector with dropdown */}
      <div className={styles.workspaceWrapper}>
        <button
          type="button"
          ref={buttonRef}
          className={styles.workspaceBtn}
          onClick={toggleMenu}
          onKeyDown={handleButtonKeyDown}
          aria-label="Repository menu"
          aria-expanded={isMenuOpen}
          aria-haspopup="menu"
          aria-controls={isMenuOpen ? MENU_ID : undefined}
        >
          <span className={styles.workspaceDot} aria-hidden="true" />
          <span className={styles.workspaceName}>{workspaceName}</span>
          <ChevronDownIcon className={styles.chevron} aria-hidden="true" />
        </button>

        {isMenuOpen && (
          <div
            ref={menuRef}
            id={MENU_ID}
            className={styles.workspaceMenu}
            role="menu"
            aria-label="Workspace"
            onKeyDown={handleMenuKeyDown}
          >
            <button
              type="button"
              className={styles.menuItem}
              onClick={handleOpenFolder}
              role="menuitem"
              tabIndex={-1}
            >
              <FolderOpenOutlineIcon className={styles.menuIcon} aria-hidden="true" />
              <span>Open Folder...</span>
              <span className={styles.menuShortcut}>{formatShortcut('\u2318O')}</span>
            </button>

            {recentProjects.length > 0 && (
              <>
                <div className={styles.menuDivider} role="separator" />
                <div className={styles.menuLabel}>Recent Projects</div>
                {recentProjects.map((project) => (
                  <button
                    type="button"
                    key={project.path}
                    className={styles.menuItem}
                    onClick={() => handleOpenRecent(project.path)}
                    role="menuitem"
                    tabIndex={-1}
                    title={project.path}
                  >
                    <FolderOutlineIcon className={styles.menuIcon} aria-hidden="true" />
                    <span className={styles.menuItemName}>{project.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Workspace selector (within-repo focus) */}
      <WorkspaceSelector />

      {/* Always-visible branch switcher (hidden when the workspace isn't a repo) */}
      <BranchSwitcher compact />

      {/* Search */}
      <button
        type="button"
        className={`${styles.headerBtn} ${styles.searchBtn}`}
        aria-label="Search everywhere"
        onClick={onOpenCommandPalette}
      >
        <SearchIcon aria-hidden="true" />
        <span>Search Everywhere</span>
      </button>

      {/* Spacer */}
      <div className={styles.spacer} />

      {/* Run-profile selector (right-aligned) */}
      <RunProfileSelector />
    </>
  );
});
