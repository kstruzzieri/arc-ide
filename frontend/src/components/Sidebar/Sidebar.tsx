import { useCallback } from 'react';
import styles from './Sidebar.module.css';
import {
  FilesIcon,
  SearchIcon,
  GitBranchIcon,
  PlayIcon,
  StructureIcon,
  SettingsIcon,
} from '../icons';
import { useIDEStore, SidebarView, useIsLeftPanelCollapsed } from '../../stores/ideStore';
import { formatShortcut } from '../../utils/platform';

const SIDEBAR_ITEMS: Array<{
  view: SidebarView;
  icon: typeof FilesIcon;
  label: string;
  shortcut?: string;
}> = [
  { view: 'explorer', icon: FilesIcon, label: 'Explorer', shortcut: '⌘1' },
  { view: 'search', icon: SearchIcon, label: 'Search', shortcut: '⌘⇧F' },
  { view: 'git', icon: GitBranchIcon, label: 'Source Control', shortcut: '⌘⇧G' },
  { view: 'run', icon: PlayIcon, label: 'Run Profiles' },
  { view: 'structure', icon: StructureIcon, label: 'Structure', shortcut: '⌘⇧Y' },
];

export function Sidebar() {
  const activeView = useIDEStore((state) => state.activeSidebarView);
  const setSidebarView = useIDEStore((state) => state.setSidebarView);
  const isLeftPanelCollapsed = useIsLeftPanelCollapsed();
  const toggleLeftPanel = useIDEStore((state) => state.toggleLeftPanel);

  const handleSidebarClick = useCallback(
    (view: SidebarView) => {
      if (view === activeView && !isLeftPanelCollapsed) {
        // Clicking the active view collapses the panel
        toggleLeftPanel();
      } else if (isLeftPanelCollapsed) {
        // If panel is collapsed, expand it and switch to the clicked view
        toggleLeftPanel();
        setSidebarView(view);
      } else {
        // Just switch views
        setSidebarView(view);
      }
    },
    [activeView, isLeftPanelCollapsed, toggleLeftPanel, setSidebarView]
  );

  return (
    <>
      {SIDEBAR_ITEMS.map(({ view, icon: Icon, label, shortcut }) => (
        <button
          type="button"
          key={view}
          className={`${styles.activityBtn} ${activeView === view && !isLeftPanelCollapsed ? styles.active : ''}`}
          title={shortcut ? `${label} (${formatShortcut(shortcut)})` : label}
          onClick={() => handleSidebarClick(view)}
          aria-pressed={activeView === view && !isLeftPanelCollapsed}
          aria-label={label}
        >
          <Icon aria-hidden="true" />
        </button>
      ))}

      <div className={styles.spacer} />

      <button type="button" className={styles.activityBtn} title="Settings" aria-label="Settings">
        <SettingsIcon aria-hidden="true" />
      </button>
    </>
  );
}
