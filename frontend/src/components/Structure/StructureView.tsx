import { useCallback, useId, useMemo, useState } from 'react';
import styles from './StructureView.module.css';
import { ChevronDownIcon, ChevronRightIcon, SearchIcon, CollapseIcon } from '../icons';
import { useDocumentSymbols } from '../../hooks/useDocumentSymbols';
import {
  filterSymbolTree,
  symbolKindMeta,
  type DocumentSymbolNode,
} from '../../utils/documentSymbols';
import { navigateToEditorLocation } from '../../utils/editorNavigation';

/** Stable key for a node's position in the tree (used for collapse state). */
function nodeKey(parentKey: string, index: number, node: DocumentSymbolNode): string {
  return `${parentKey}/${index}:${node.name}:${node.kind}`;
}

/** Collects the keys of every container (has children) node in the tree. */
function collectContainerKeys(
  nodes: DocumentSymbolNode[],
  parentKey: string,
  acc: Set<string>
): void {
  nodes.forEach((node, i) => {
    if (node.children && node.children.length > 0) {
      const key = nodeKey(parentKey, i, node);
      acc.add(key);
      collectContainerKeys(node.children, key, acc);
    }
  });
}

interface RefreshIconProps {
  className?: string;
}
function RefreshIcon({ className }: RefreshIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface SymbolRowProps {
  node: DocumentSymbolNode;
  depth: number;
  nodeId: string;
  tabStopId: string | undefined;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onFocusNode: (key: string) => void;
  onSelect: (node: DocumentSymbolNode) => void;
}

function SymbolRow({
  node,
  depth,
  nodeId,
  tabStopId,
  collapsed,
  onToggle,
  onFocusNode,
  onSelect,
}: SymbolRowProps) {
  const meta = symbolKindMeta(node.kind);
  const hasChildren = !!node.children && node.children.length > 0;
  const isCollapsed = collapsed.has(nodeId);
  const groupId = useId();

  return (
    <>
      <div
        className={styles.row}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        aria-owns={hasChildren && !isCollapsed ? groupId : undefined}
        tabIndex={nodeId === tabStopId ? 0 : -1}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node)}
        onFocus={() => onFocusNode(nodeId)}
        onKeyDown={(e) => {
          const treeItems = Array.from(
            e.currentTarget
              .closest('[role="tree"]')
              ?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []
          );
          const index = treeItems.indexOf(e.currentTarget);
          const focusAt = (nextIndex: number) => {
            treeItems[Math.max(0, Math.min(nextIndex, treeItems.length - 1))]?.focus();
          };

          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(node);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusAt(index + 1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusAt(index - 1);
          } else if (e.key === 'Home') {
            e.preventDefault();
            focusAt(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            focusAt(treeItems.length - 1);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (hasChildren && isCollapsed) onToggle(nodeId);
            else if (hasChildren) focusAt(index + 1);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (hasChildren && !isCollapsed) {
              onToggle(nodeId);
            } else {
              for (let i = index - 1; i >= 0; i -= 1) {
                if (treeItems[i].getAttribute('aria-level') === String(depth)) {
                  treeItems[i].focus();
                  break;
                }
              }
            }
          }
        }}
        title={`${meta.label}: ${node.name}`}
      >
        <span
          className={`${styles.twisty} ${hasChildren ? '' : styles.leaf}`}
          onClick={(e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            onToggle(nodeId);
          }}
          aria-hidden={!hasChildren}
        >
          {hasChildren &&
            (isCollapsed ? (
              <ChevronRightIcon className={styles.twistyIcon} />
            ) : (
              <ChevronDownIcon className={styles.twistyIcon} />
            ))}
        </span>
        <span className={`${styles.kind} ${styles[meta.className] ?? ''}`}>{meta.glyph}</span>
        <span className={styles.name}>{node.name}</span>
        {node.detail && <span className={styles.detail}>{node.detail}</span>}
      </div>
      {hasChildren && !isCollapsed && (
        <div id={groupId} role="group">
          {node.children!.map((child, i) => {
            const childId = nodeKey(nodeId, i, child);
            return (
              <SymbolRow
                key={childId}
                node={child}
                depth={depth + 1}
                nodeId={childId}
                tabStopId={tabStopId}
                collapsed={collapsed}
                onToggle={onToggle}
                onFocusNode={onFocusNode}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

interface EmptyStateProps {
  title: string;
  message: string;
  tone?: 'neutral' | 'warn' | 'error';
  action?: { label: string; onClick: () => void };
  icon: React.ReactNode;
}
function EmptyState({ title, message, tone = 'neutral', action, icon }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <div
        className={`${styles.emptyGlyph} ${tone === 'warn' ? styles.warn : ''} ${tone === 'error' ? styles.error : ''}`}
      >
        {icon}
      </div>
      <h4 className={styles.emptyTitle}>{title}</h4>
      <p className={styles.emptyMsg}>{message}</p>
      {action && (
        <button type="button" className={styles.emptyAction} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

const InfoIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M4 6h10M4 12h7M4 18h9" strokeLinecap="round" />
  </svg>
);
const BlockedIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M9 9l6 6M15 9l-6 6" strokeLinecap="round" />
  </svg>
);
const WarnIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M12 3l9 16H3z" strokeLinejoin="round" />
    <path d="M12 9v5M12 17h.01" strokeLinecap="round" />
  </svg>
);
const ErrorIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4M12 16h.01" strokeLinecap="round" />
  </svg>
);

export function StructureView() {
  const { status, symbols, filePath, refresh } = useDocumentSymbols();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  // Reset collapse state when the file changes — position-based keys would
  // otherwise bleed across files and the Set would grow unbounded over a
  // session. Storing the previous file in state and adjusting during render is
  // React's documented "reset state on prop change" pattern (no effect needed).
  const [prevFile, setPrevFile] = useState(filePath);
  if (prevFile !== filePath) {
    setPrevFile(filePath);
    if (collapsed.size > 0) setCollapsed(new Set());
  }

  const filtered = useMemo(() => filterSymbolTree(symbols, query), [symbols, query]);

  const visibleNodeIds = useMemo(() => {
    const ids: string[] = [];
    const collect = (nodes: DocumentSymbolNode[], parentKey: string) => {
      nodes.forEach((node, i) => {
        const id = nodeKey(parentKey, i, node);
        ids.push(id);
        if (node.children?.length && !collapsed.has(id)) collect(node.children, id);
      });
    };
    collect(filtered, 'root');
    return ids;
  }, [collapsed, filtered]);
  const tabStopId =
    activeNodeId && visibleNodeIds.includes(activeNodeId) ? activeNodeId : visibleNodeIds[0];

  const handleToggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Collapse the *rendered* tree — using `filtered`, not `symbols`, so the keys
  // line up with the visible nodes when a filter is active.
  const handleCollapseAll = useCallback(() => {
    const keys = new Set<string>();
    collectContainerKeys(filtered, 'root', keys);
    setCollapsed(keys);
  }, [filtered]);

  const handleSelect = useCallback(
    (node: DocumentSymbolNode) => {
      if (!filePath) return;
      const pos = node.selectionRange?.start ?? node.range.start;
      navigateToEditorLocation(filePath, pos.line + 1, pos.character + 1);
    },
    [filePath]
  );

  const showTree = status === 'ready';

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Structure</span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconBtn}
            title="Collapse all"
            onClick={handleCollapseAll}
            disabled={!showTree}
          >
            <CollapseIcon className={styles.actionIcon} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="Refresh"
            onClick={refresh}
            disabled={status === 'no-file'}
          >
            <RefreshIcon className={styles.actionIcon} />
          </button>
        </div>
      </div>

      {showTree && (
        <div className={styles.filterRow}>
          <SearchIcon className={styles.filterIcon} />
          <input
            className={styles.filterInput}
            placeholder="Filter symbols…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter symbols"
          />
        </div>
      )}

      <div className={styles.body}>
        {status === 'loading' && (
          <div className={styles.loading} role="status" aria-label="Loading symbols">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={styles.skelRow} style={{ paddingLeft: 8 + (i % 2) * 20 }}>
                <span className={styles.skelBox} />
                <span className={styles.skelBar} style={{ width: `${40 + ((i * 13) % 40)}%` }} />
              </div>
            ))}
          </div>
        )}

        {status === 'no-file' && (
          <EmptyState
            icon={InfoIcon}
            title="No file open"
            message="Open a file in the editor to see its structure."
          />
        )}

        {status === 'unsupported' && (
          <EmptyState
            icon={BlockedIcon}
            title="Structure unavailable for this file"
            message="No language server covers this file type. Open a source file to see its outline."
          />
        )}

        {status === 'lsp-unavailable' && (
          <EmptyState
            icon={WarnIcon}
            tone="warn"
            title="Language server not ready"
            message="Structure will populate once the language server for this file is ready."
            action={{ label: 'Retry', onClick: refresh }}
          />
        )}

        {status === 'empty' && (
          <EmptyState
            icon={InfoIcon}
            title="No symbols in this file"
            message="The language server returned no symbols for this file."
          />
        )}

        {status === 'error' && (
          <EmptyState
            icon={ErrorIcon}
            tone="error"
            title="Couldn't load structure"
            message="The documentSymbol request failed or timed out."
            action={{ label: 'Retry', onClick: refresh }}
          />
        )}

        {showTree && filtered.length === 0 && (
          <EmptyState
            icon={InfoIcon}
            title="No matching symbols"
            message={`Nothing matches “${query.trim()}”.`}
          />
        )}

        {showTree && filtered.length > 0 && (
          <div className={styles.tree} role="tree" aria-label="Document symbols">
            {filtered.map((node, i) => {
              const id = nodeKey('root', i, node);
              return (
                <SymbolRow
                  key={id}
                  node={node}
                  depth={0}
                  nodeId={id}
                  tabStopId={tabStopId}
                  collapsed={collapsed}
                  onToggle={handleToggle}
                  onFocusNode={setActiveNodeId}
                  onSelect={handleSelect}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
