/**
 * Editor Component
 *
 * The main editor panel with tab bar and CodeMirror integration.
 * Manages open files, tab switching, and editor state.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import styles from './Editor.module.css';
import {
  useOpenFiles,
  useActiveFile,
  useIDEStore,
  useRecentWorkspaces,
  useWorkspace,
  useWorkspaces,
} from '../../stores/ideStore';
import { FileIcon } from '../FileExplorer/FileIcon';
import { FolderOutlineIcon, GitBranchIcon, SettingsIcon } from '../icons';
import { GolemConfigWorkspace } from '../GolemConfig/GolemConfigWorkspace';
import { confirmConfigClose, hasUnsavedConfigWork } from '../GolemConfig/configCloseGuard';
import { useGolemStore } from '../../stores/golemStore';
import { formatShortcut, isMac } from '../../utils/platform';
import { openWorkspaceByPath, shortenPath } from '../../utils/workspace';
import { focusConfigTab, focusEditorSurface } from '../../utils/editorSurface';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { GitDiffView } from './GitDiffView';
import { MergeResolutionView } from './MergeResolutionView';
import { useGitStore } from '../../stores/gitStore';
import { useGitBaseline } from '../../hooks/useGitBaseline';
import { getLanguageName } from './codemirror';
import { createWorkspacePathResolver } from '../../utils/workspaceRegions';
import { accentVar } from '../../utils/accent';
import type { workspace as workspaceModels } from '../../wails/bindings';
import firnLogo from '../../assets/branding/banner-transparent.svg';

export function Editor() {
  const openFiles = useOpenFiles();
  const activeFile = useActiveFile();
  const workspace = useWorkspace();
  const workspaces = useWorkspaces();
  const recentWorkspaces = useRecentWorkspaces();
  const resolveWorkspace = useMemo(
    () => createWorkspacePathResolver(workspace?.path ?? '', workspaces),
    [workspace?.path, workspaces]
  );
  const diffSession = useGitStore((state) => state.diffSession);
  const diffFocused = useGitStore((state) => state.diffFocused);
  const mergeSession = useGitStore((state) => state.mergeSession);
  const mergeFocused = useGitStore((state) => state.mergeFocused);
  const mergeAdvancePending = useGitStore((state) => state.mergeAdvancePending);
  // The store owns the queue, so it owns the hand-off text too; this component
  // only keeps the live region mounted outside the conditional merge view, so a
  // next surface that mounts late cannot swallow the announcement.
  const queueAnnouncement = useGitStore((state) => state.mergeQueueAnnouncement);
  // The one app-global configuration tab (#263 spec §3.1). It is an explicit
  // fourth editor surface beside file/diff/merge — not an EditorFile, not a
  // virtual-document registry — so the store carries nothing but its open and
  // focus flags.
  const configTabOpen = useGolemStore((state) => state.configTabOpen);
  const configTabFocused = useGolemStore((state) => state.configTabFocused);
  const gitBaseline = useGitBaseline(activeFile?.path);
  const setActiveFile = useIDEStore((state) => state.setActiveFile);
  const closeFile = useIDEStore((state) => state.closeFile);
  const updateFileContent = useIDEStore((state) => state.updateFileContent);
  const setCursorPosition = useIDEStore((state) => state.setCursorPosition);
  const setFileCursorPosition = useIDEStore((state) => state.setFileCursorPosition);
  const setScrollPosition = useIDEStore((state) => state.setScrollPosition);
  const scrollPositions = useIDEStore((state) => state.scrollPositions);
  const cursorPositions = useIDEStore((state) => state.cursorPositions);
  const editorRef = useRef<HTMLDivElement>(null);
  const restoreFocusAfterCloseRef = useRef(false);
  const [mergeFinalizing, setMergeFinalizing] = useState(false);

  // Handle content changes from the editor
  const handleContentChange = useCallback(
    (fileId: string, content: string) => {
      updateFileContent(fileId, content);
    },
    [updateFileContent]
  );

  // Handle cursor position changes — updates both global (status bar) and per-file (persistence)
  const handleCursorChange = useCallback(
    (line: number, column: number) => {
      setCursorPosition({ line, column });
      if (activeFile) {
        setFileCursorPosition(activeFile.id, { line, column });
      }
    },
    [setCursorPosition, setFileCursorPosition, activeFile]
  );

  // Handle scroll position changes
  const handleScrollChange = useCallback(
    (scrollTop: number) => {
      if (activeFile) {
        setScrollPosition(activeFile.id, scrollTop);
      }
    },
    [activeFile, setScrollPosition]
  );

  // Suppress the webview's native Cmd+F / Ctrl+F find dialog whenever nothing
  // else claimed the shortcut. When an editor is focused, CodeMirror handles
  // Mod-f and calls preventDefault before this window-level listener runs, so
  // the guard below leaves it alone. Without this, focusing the file tree or
  // welcome screen and pressing Cmd+F surfaces a browser find bar that cannot
  // search workspace files (WebView2 ships one built in). Cmd+Shift+F is left
  // untouched because it is reserved for the project Search panel.
  useEffect(() => {
    const handleNativeFindSuppression = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.shiftKey || event.altKey) return;
      // Ctrl+Cmd+F is the macOS toggle-fullscreen shortcut; never swallow it.
      if (isMac() && event.ctrlKey) return;

      const key = event.key.toLowerCase();
      if (key !== 'f') return;

      const usesPlatformModifier = isMac() ? event.metaKey : event.ctrlKey;
      if (!usesPlatformModifier) return;

      // Suppress only the native find UI; do not navigate or mutate anything.
      event.preventDefault();
    };

    window.addEventListener('keydown', handleNativeFindSuppression);
    return () => window.removeEventListener('keydown', handleNativeFindSuppression);
  }, []);

  // Opening or switching to a real file supersedes the diff preview: the diff
  // is a transient tab, so yield focus to the file the user just opened
  // (e.g. a double-click in the file tree). Only react to an actual change of
  // the active file, not the initial mount, so a diff opened while a file
  // happens to be active isn't immediately dismissed. Opening a diff never
  // changes the active file id, so this doesn't fight the diff on open.
  const activeFileId = activeFile?.id;
  const prevActiveFileIdRef = useRef(activeFileId);
  useEffect(() => {
    if (prevActiveFileIdRef.current === activeFileId) return;
    prevActiveFileIdRef.current = activeFileId;
    if (activeFileId) {
      // Passive: this mirrors an activation someone else already performed (and
      // already revealed for, when it was an intent). Revealing here would also
      // fire for a workspace restore's reopened tabs.
      focusEditorSurface('file', { reveal: false });
    }
    return undefined;
  }, [activeFileId]);

  // A diff or merge opened from elsewhere (the Git panel, a conflict queue)
  // takes editor focus in the git store directly, so watch that rising edge and
  // retire the configuration tab's focus with it. Tab clicks re-assert focus on
  // an already-focused surface, which is no edge at all, so they clear the flag
  // themselves through focusEditorSurface.
  const otherFocusRef = useRef({ diff: diffFocused, merge: mergeFocused });
  useEffect(() => {
    const previous = otherFocusRef.current;
    // Per surface, not on the disjunction: focus moving straight from the diff
    // to the merge leaves the disjunction flat and would look like no change.
    if ((diffFocused && !previous.diff) || (mergeFocused && !previous.merge)) {
      useGolemStore.getState().setConfigTabFocused(false);
    }
    otherFocusRef.current = { diff: diffFocused, merge: mergeFocused };
  }, [diffFocused, mergeFocused]);

  // Precedence: the configuration tab wins while it is the focused surface, and
  // also when nothing else is left to show — the same rule the diff tab follows
  // so the panel never renders blank.
  const showConfig =
    configTabOpen && (configTabFocused || (!activeFile && !diffSession && !mergeSession));
  // Show the diff when it's focused, or when there's simply no file to show
  // instead (e.g. the file opened from a diff was closed, leaving only the
  // diff tab) — otherwise the panel would render blank.
  const showDiff = !showConfig && !!diffSession && (diffFocused || (!activeFile && !mergeSession));
  const showMerge = !showConfig && !!mergeSession && !showDiff && (mergeFocused || !activeFile);
  const diffOwner = diffSession ? resolveWorkspace(diffSession.absPath) : null;
  const mergeOwner = mergeSession ? resolveWorkspace(mergeSession.absPath) : null;

  // Any close of the merge surface — Escape, the tab X, the resolved-outside
  // notice, or a confirmed discard — ends with the session becoming null. One
  // effect observing that transition restores focus for all of them. A queue
  // hand-off also passes through null, so it is excluded: focus would bounce
  // out of the merge surface and back for every file in the queue.
  const hadMergeSessionRef = useRef(mergeSession !== null);
  useEffect(() => {
    const had = hadMergeSessionRef.current;
    if (mergeSession !== null) {
      hadMergeSessionRef.current = true;
    } else if (!mergeAdvancePending) {
      hadMergeSessionRef.current = false;
    }
    if (had && mergeSession === null && !mergeAdvancePending) {
      restoreFocusAfterCloseRef.current = true;
    }
  }, [mergeSession, mergeAdvancePending]);

  useEffect(() => {
    if (!restoreFocusAfterCloseRef.current) return undefined;

    // Closing an active file can also update diff focus in a following effect.
    // Wait for that state to settle, then focus the final selected tab or the
    // main landmark when the tablist became empty.
    const timeout = window.setTimeout(() => {
      restoreFocusAfterCloseRef.current = false;
      const selectedTab = editorRef.current?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]'
      );
      const fallback = document.getElementById('main-content') ?? editorRef.current;
      (selectedTab ?? fallback)?.focus();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [
    activeFileId,
    configTabOpen,
    diffFocused,
    diffSession,
    mergeAdvancePending,
    mergeSession,
    openFiles,
  ]);

  // Re-fetch the diff each time it becomes visible so it reflects edits made in
  // the editor while it was in the background (the working-tree side re-reads
  // the live buffer).
  const prevShowDiffRef = useRef(showDiff);
  useEffect(() => {
    if (showDiff && !prevShowDiffRef.current) {
      void useGitStore.getState().refreshOpenDiff();
    }
    prevShowDiffRef.current = showDiff;
  }, [showDiff]);

  // #309: a narrow tab strip scrolls (`.tabBar { overflow-x: auto }`), so the
  // active configuration tab must never stay scrolled out of view — on
  // activation AND on re-activation (clicking the tab again while active).
  const revealConfigTab = () =>
    document
      .getElementById('tab-golem-config')
      ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  useEffect(() => {
    if (showConfig) revealConfigTab();
  }, [showConfig]);

  // The one choke point for closing the configuration surface, so the §4.6a
  // prompt cannot be routed around. A dirty surface is revealed first: the
  // dialog it raises lives inside that pane, and a hidden pane cannot show one.
  const closeConfigTab = () => {
    if (hasUnsavedConfigWork()) focusConfigTab();
    void confirmConfigClose('close').then((proceed) => {
      if (!proceed) return;
      restoreFocusAfterCloseRef.current = true;
      useGolemStore.getState().closeConfigTab();
    });
  };

  // Welcome screen when no editor surface at all is open
  if (openFiles.length === 0 && !diffSession && !mergeSession && !configTabOpen) {
    // Filter out the currently open workspace from recent list
    const recentProjects = recentWorkspaces.filter((w) => w.path !== workspace?.path);

    return (
      <div ref={editorRef} className={styles.editor} tabIndex={-1}>
        <div className={styles.welcome}>
          <img src={firnLogo} alt="Firn IDE" className={styles.welcomeLogo} />
          <div className={styles.shortcuts}>
            <div className={styles.shortcutItem}>
              <span className={styles.shortcutLabel}>Open File</span>
              <kbd>{formatShortcut('\u2318O')}</kbd>
            </div>
            <div className={styles.shortcutItem}>
              <span className={styles.shortcutLabel}>Command Palette</span>
              <kbd>{formatShortcut('\u2318\u21e7P')}</kbd>
            </div>
            <div className={styles.shortcutItem}>
              <span className={styles.shortcutLabel}>Quick Search</span>
              <kbd>{formatShortcut('\u2318K')}</kbd>
            </div>
          </div>
          {recentProjects.length > 0 && (
            <div className={styles.recentProjects}>
              <h3 className={styles.recentTitle}>Recent Projects</h3>
              <ul className={styles.recentList}>
                {recentProjects.map((project) => (
                  <li key={project.path}>
                    <button
                      type="button"
                      className={styles.recentItem}
                      onClick={() => openWorkspaceByPath(project.path)}
                      title={project.path}
                    >
                      <FolderOutlineIcon className={styles.recentIcon} aria-hidden="true" />
                      <div className={styles.recentItemText}>
                        <span className={styles.recentName}>{project.name}</span>
                        <span className={styles.recentPath}>{shortenPath(project.path)}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={editorRef} className={styles.editor} tabIndex={-1}>
      {/* Tab bar */}
      <div
        data-testid="merge-queue-announcement"
        role="status"
        aria-live="polite"
        className={styles.srOnly}
      >
        {queueAnnouncement}
      </div>
      <div className={styles.tabBar} role="tablist" aria-label="Open editors">
        {openFiles.map((file) => {
          // A focused diff tab owns the active state, so the file tab it was
          // opened from doesn't also read as active.
          const isActive = file.id === activeFile?.id && !showDiff && !showMerge && !showConfig;
          const languageName = getLanguageName(file.name);
          const owner = resolveWorkspace(file.path);

          const activateFileTab = () => {
            focusEditorSurface('file');
            setActiveFile(file.id);
          };

          return (
            <div
              key={file.id}
              className={`${styles.tab} ${owner ? styles.workspaceTab : ''} ${isActive ? styles.active : ''}`}
              style={tabAccentStyle(owner)}
              title={`${file.path}\n${languageName}`}
              onClick={activateFileTab}
            >
              <div
                id={editorTabId(file.id)}
                className={styles.tabTarget}
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                aria-controls="editor-tabpanel"
                onKeyDown={(event) => handleTabKeyDown(event, activateFileTab)}
              >
                <FileIcon name={file.name} isDir={false} className={styles.tabIcon} />
                <span className={styles.tabName}>{file.name}</span>
                {file.isModified && (
                  <span className={styles.tabDot} role="img" aria-label="Modified" />
                )}
              </div>
              <button
                className={styles.tabClose}
                onClick={(e) => {
                  e.stopPropagation();
                  restoreFocusAfterCloseRef.current = true;
                  closeFile(file.id);
                }}
                aria-label={`Close ${file.name}`}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
        {diffSession && (
          <div
            className={`${styles.tab} ${diffOwner ? styles.workspaceTab : ''} ${showDiff ? styles.active : ''}`}
            style={tabAccentStyle(diffOwner)}
            title={`${diffSession.path}\n${diffSession.left.label} ↔ ${diffSession.right.label}`}
            onClick={() => focusEditorSurface('diff')}
          >
            <div
              id="tab-git-diff"
              className={styles.tabTarget}
              role="tab"
              tabIndex={showDiff ? 0 : -1}
              aria-selected={showDiff}
              aria-controls="editor-tabpanel"
              onKeyDown={(event) => handleTabKeyDown(event, () => focusEditorSurface('diff'))}
            >
              <GitBranchIcon className={styles.tabIcon} aria-hidden="true" />
              <span className={styles.tabName}>{diffTabName(diffSession.path)} (diff)</span>
            </div>
            <button
              className={styles.tabClose}
              onClick={(e) => {
                e.stopPropagation();
                restoreFocusAfterCloseRef.current = true;
                useGitStore.getState().closeDiff();
              }}
              aria-label="Close diff"
              type="button"
            >
              <CloseIcon />
            </button>
          </div>
        )}
        {mergeSession && (
          <div
            className={`${styles.tab} ${mergeOwner ? styles.workspaceTab : ''} ${showMerge ? styles.active : ''}`}
            style={tabAccentStyle(mergeOwner)}
            title={mergeSession.path}
            onClick={() => focusEditorSurface('merge')}
          >
            <div
              id="tab-merge-resolution"
              className={styles.tabTarget}
              role="tab"
              tabIndex={showMerge ? 0 : -1}
              aria-selected={showMerge}
              aria-controls="editor-tabpanel"
              onKeyDown={(event) => handleTabKeyDown(event, () => focusEditorSurface('merge'))}
            >
              <GitBranchIcon className={styles.tabIcon} aria-hidden="true" />
              <span className={styles.tabName}>{diffTabName(mergeSession.path)} (merge)</span>
            </div>
            <button
              className={styles.tabClose}
              onClick={(event) => {
                event.stopPropagation();
                if (mergeFinalizing) return;
                // Same guard as Escape and the resolved-outside notice: a
                // touched session gets the discard confirmation, and focus
                // restoration is handled by the close effect below rather than
                // by this handler, which view-originated closes never reach.
                useGitStore.getState().requestMergeClose();
              }}
              aria-label="Close merge resolution"
              type="button"
              disabled={mergeFinalizing}
            >
              <CloseIcon />
            </button>
          </div>
        )}
        {configTabOpen && (
          <div
            className={`${styles.tab} ${showConfig ? styles.active : ''}`}
            title={'Golem Configuration\nApplies to every workspace'}
            onClick={() => {
              focusConfigTab();
              revealConfigTab();
            }}
          >
            <div
              id="tab-golem-config"
              className={styles.tabTarget}
              role="tab"
              tabIndex={showConfig ? 0 : -1}
              aria-selected={showConfig}
              aria-controls="editor-tabpanel"
              onKeyDown={(event) => handleTabKeyDown(event, focusConfigTab)}
            >
              <SettingsIcon className={styles.tabIcon} aria-hidden="true" />
              <span className={styles.tabName}>Golem Configuration</span>
            </div>
            <button
              className={styles.tabClose}
              onClick={(event) => {
                event.stopPropagation();
                closeConfigTab();
              }}
              aria-label="Close Golem Configuration"
              type="button"
            >
              <CloseIcon />
            </button>
          </div>
        )}
      </div>

      {/* Editor content */}
      <div
        id="editor-tabpanel"
        className={styles.content}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={
          showConfig
            ? 'tab-golem-config'
            : showMerge
              ? 'tab-merge-resolution'
              : showDiff
                ? 'tab-git-diff'
                : activeFile
                  ? editorTabId(activeFile.id)
                  : undefined
        }
      >
        {/* Both surfaces stay mounted and are toggled with CSS so switching
            between a file and its diff preserves scroll position (no rebuild):
            the diff keeps its merge-view scroll, and the editor doesn't jump
            back to the top and re-restore its scroll on every return. */}
        {diffSession && (
          <div className={styles.pane} style={{ display: showDiff ? undefined : 'none' }}>
            <GitDiffView session={diffSession} visible={showDiff} />
          </div>
        )}
        {mergeSession && (
          <div className={styles.pane} style={{ display: showMerge ? undefined : 'none' }}>
            <MergeResolutionView
              session={mergeSession}
              visible={showMerge}
              onFinalizingChange={setMergeFinalizing}
            />
          </div>
        )}
        {/* Same hidden-pane pattern: the configuration surface stays mounted
            behind a file or diff so its loaded projection — and, from the next
            tasks on, its draft — survives a switch away and back. */}
        {configTabOpen && (
          <div className={styles.pane} style={{ display: showConfig ? undefined : 'none' }}>
            <GolemConfigWorkspace onClose={closeConfigTab} />
          </div>
        )}
        {activeFile && (
          <div
            className={styles.editorContent}
            style={{ display: showDiff || showMerge || showConfig ? 'none' : undefined }}
          >
            <CodeMirrorEditor
              fileId={activeFile.id}
              filename={activeFile.name}
              content={activeFile.content || ''}
              openFileIds={openFiles.map((f) => f.id)}
              gitBaseline={gitBaseline}
              onContentChange={handleContentChange}
              onCursorChange={handleCursorChange}
              onScrollChange={handleScrollChange}
              initialScrollTop={scrollPositions[activeFile.id]}
              initialCursorLine={cursorPositions[activeFile.id]?.line}
              initialCursorColumn={cursorPositions[activeFile.id]?.column}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function editorTabId(fileId: string): string {
  return `tab-file-${encodeURIComponent(fileId)}`;
}

/** Inline style carrying a tab's owning-workspace accent token, if any. */
function tabAccentStyle(owner: workspaceModels.WorkspaceDef | null): CSSProperties | undefined {
  if (!owner) return undefined;
  return { ['--tab-accent' as string]: accentVar(owner.accent) } as CSSProperties;
}

/** Tab label for the diff preview: filename only, path lives in the tooltip. */
function diffTabName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function handleTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, action: () => void) {
  if (event.currentTarget !== event.target) return;

  const tabs = Array.from(
    event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
  );
  const index = tabs.indexOf(event.currentTarget);
  let next: number | null = null;

  switch (event.key) {
    case 'ArrowRight':
      next = index < tabs.length - 1 ? index + 1 : 0;
      break;
    case 'ArrowLeft':
      next = index > 0 ? index - 1 : tabs.length - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = tabs.length - 1;
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      action();
      return;
  }

  if (next !== null) {
    event.preventDefault();
    tabs[next]?.focus();
  }
}

/**
 * Close icon for tab close buttons.
 */
function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
