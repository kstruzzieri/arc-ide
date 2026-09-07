// src/components/FileExplorer/TreeRow.tsx
import React from 'react';
import { AlertCircleIcon, ChevronRightIcon, ChevronDownIcon } from '../icons';
import { FileIcon } from './FileIcon';
import { getFolderType } from './fileIconUtils';
import type { WorkspaceAccent } from '../../stores/ideStore';
import type { GitRowStatus } from '../../types/git';
import { accentVar } from '../../utils/accent';
import { shortenPath } from '../../utils/workspace';
import styles from './TreeRow.module.css';

/** VS Code-style status letters shown after the filename. */
const gitBadgeLetters: Record<GitRowStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

/** Fixed row height; MUST match `.row { height }` in TreeRow.module.css. */
export const ROW_HEIGHT = 28;

/** Stable DOM id for a row, used as aria-activedescendant target. */
export function rowDomId(key: string): string {
  return `treeitem-${encodeURIComponent(key)}`;
}

export interface TreeRowProps {
  kind: 'root' | 'entry';
  /** entry.path for entries; undefined for the root row. */
  path?: string;
  name: string;
  depth: number;
  level: number;
  isDir: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  regionAccent: WorkspaceAccent | null;
  fileAccent: WorkspaceAccent | null;
  ownershipAccent?: WorkspaceAccent | null;
  setSize: number;
  posInSet: number;
  /** Root only: absolute path shown as a dimmed label. */
  rootPath?: string;
  /** DOM id for aria-activedescendant. */
  rowId: string;
  /** True when this row is the keyboard-active descendant. */
  isActive: boolean;
  /** Show the expand chevron: true for unloaded dirs or dirs with children; false for loaded-empty dirs and files. */
  canExpand: boolean;
  /** The backend or latest lazy read could not read this item. */
  unreadable: boolean;
  /** Git working-tree decoration; undefined renders an undecorated row. */
  gitStatus?: GitRowStatus;
  onToggle: (kind: 'root' | 'entry', path?: string) => void;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
}

/**
 * A single windowed tree row (root or entry). All props are primitives or stable
 * callbacks, so React.memo skips re-render when nothing about this row changed —
 * the key enabler for cheap re-renders on toggle/select over large trees.
 */
function TreeRowImpl({
  kind,
  path,
  name,
  depth,
  level,
  isDir,
  isExpanded,
  isSelected,
  regionAccent,
  fileAccent,
  ownershipAccent,
  setSize,
  posInSet,
  rootPath,
  rowId,
  isActive,
  canExpand,
  unreadable,
  gitStatus,
  onToggle,
  onSelect,
  onOpen,
}: TreeRowProps) {
  const indentPx = depth * 16;
  const isHidden = isDir && getFolderType(name) === 'hidden';

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(kind, path);
  };

  const handleRowClick = () => {
    if (kind === 'root') {
      onToggle('root', undefined);
    } else if (path) {
      onSelect(path);
    }
  };

  const handleRowDoubleClick = () => {
    if (kind === 'root') return;
    if (isDir) {
      onToggle('entry', path);
    } else if (path) {
      onOpen(path);
    }
  };

  const className =
    `${styles.row}` +
    (kind === 'root' ? ` ${styles.root}` : '') +
    (regionAccent ? ` ${styles.tinted}` : '') +
    (ownershipAccent ? ` ${styles.ownershipRail}` : '') +
    (isActive ? ` ${styles.active}` : '');

  return (
    <div
      id={rowId}
      className={className}
      data-hidden={isHidden || undefined}
      data-git={gitStatus}
      style={
        {
          paddingLeft: `${indentPx}px`,
          ...(regionAccent ? { '--region-accent': `var(--accent-${regionAccent})` } : {}),
          ...(fileAccent ? { '--file-accent': accentVar(fileAccent) } : {}),
          ...(ownershipAccent ? { '--ownership-accent': accentVar(ownershipAccent) } : {}),
        } as React.CSSProperties
      }
      onClick={handleRowClick}
      onDoubleClick={handleRowDoubleClick}
      role="treeitem"
      aria-level={level}
      aria-setsize={setSize}
      aria-posinset={posInSet}
      aria-expanded={isDir ? isExpanded : undefined}
      aria-selected={isSelected || undefined}
      aria-label={
        // Keep the path a sighted user still sees when overriding the root name.
        unreadable
          ? `${name}, unreadable${kind === 'root' && rootPath ? `, ${shortenPath(rootPath)}` : ''}`
          : undefined
      }
      tabIndex={-1}
    >
      {canExpand ? (
        <button
          type="button"
          className={styles.toggle}
          onClick={handleToggleClick}
          aria-label={`Toggle ${name}`}
          data-testid="toggle-button"
          tabIndex={-1}
        >
          {isExpanded ? (
            <ChevronDownIcon data-testid="chevron-down" aria-hidden="true" />
          ) : (
            <ChevronRightIcon data-testid="chevron-right" aria-hidden="true" />
          )}
        </button>
      ) : (
        <span className={styles.toggleSpacer} />
      )}

      <FileIcon name={name} isDir={isDir} isExpanded={isExpanded} className={styles.icon} />
      {fileAccent && (
        <span className={styles.fileAccent} data-testid="file-accent-marker" aria-hidden="true" />
      )}
      <span className={styles.name}>{name}</span>
      {unreadable && (
        <span
          className={styles.unreadable}
          title="Unable to read this item"
          data-testid="unreadable-indicator"
          aria-hidden="true"
        >
          <AlertCircleIcon />
        </span>
      )}
      {kind === 'root' && rootPath && <span className={styles.path}>{shortenPath(rootPath)}</span>}
      {gitStatus && (
        <span className={styles.gitBadge} data-testid="git-badge" aria-hidden="true">
          {gitBadgeLetters[gitStatus]}
        </span>
      )}
    </div>
  );
}

export const TreeRow = React.memo(TreeRowImpl);
