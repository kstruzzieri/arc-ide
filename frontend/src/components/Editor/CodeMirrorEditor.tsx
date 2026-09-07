/**
 * CodeMirror Editor Component
 *
 * A React wrapper for CodeMirror 6 that provides:
 * - Automatic language detection based on filename
 * - Firn Glacier theme integration
 * - Content change notifications
 * - Cursor position tracking
 * - LSP diagnostics display (underlines + gutter markers)
 * - Programmatic navigation support
 * - Proper cleanup on unmount
 */

import { useEffect, useRef, useCallback, memo, useState } from 'react';
import {
  EditorView,
  EditorState,
  createEditorExtensions,
  applyEditorTheme,
  languageCompartment,
  loadLanguageSupport,
  completionCompartment,
  hoverCompartment,
  reconfigureCompletion,
  reconfigureHover,
  resetCompletion,
  reconcileDoc,
  updateEditorDiagnostics,
  setGitBaseline,
} from './codemirror';
import { useIDEStore } from '../../stores/ideStore';
import { applyNavigation } from './applyNavigation';
import { useLSPStore, findServerStatusForFile } from '../../stores/lspStore';
import type { LSPServerStatus } from '../../stores/lspStore';
import { LSPSetupCard } from './LSPSetupCard';
import { filePathToURI } from '../../utils/lspUri';
import { lspFamilyForFile } from '../../utils/lspLanguageId';
import styles from './CodeMirrorEditor.module.css';

interface CodeMirrorEditorProps {
  /** Unique identifier for the file */
  fileId: string;
  /** Filename used for language detection */
  filename: string;
  /** Initial content of the file */
  content: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Tab size (default: 2) */
  tabSize?: number;
  /** Callback when content changes */
  onContentChange?: (fileId: string, content: string) => void;
  /** Callback when cursor position changes */
  onCursorChange?: (line: number, column: number) => void;
  /** Callback when editor is focused */
  onFocus?: () => void;
  /** Callback when editor is blurred */
  onBlur?: () => void;
  /** Callback when scroll position changes */
  onScrollChange?: (scrollTop: number) => void;
  /** Initial cursor line to set on mount (for workspace restore) */
  initialCursorLine?: number;
  /** Initial cursor column to set on mount (for workspace restore) */
  initialCursorColumn?: number;
  /** Initial scroll top to set on mount (for workspace restore) */
  initialScrollTop?: number;
  /** Ids of all currently-open files; drives cached-state eviction on close. */
  openFileIds: string[];
  /** HEAD content for the git change gutter; null renders no markers. */
  gitBaseline?: string | null;
}

/**
 * CodeMirror editor component with full IDE integration.
 * Memoized to prevent unnecessary re-renders.
 */
export const CodeMirrorEditor = memo(function CodeMirrorEditor({
  fileId,
  filename,
  content,
  readOnly = false,
  tabSize = 2,
  onContentChange,
  onCursorChange,
  onFocus,
  onBlur,
  onScrollChange,
  initialCursorLine,
  initialCursorColumn,
  initialScrollTop,
  openFileIds,
  gitBaseline = null,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const fileIdRef = useRef(fileId);
  const hasAppliedInitialCursorRef = useRef(false);
  const hasAppliedInitialScrollRef = useRef(false);
  // Flag to skip onChange during external content sync
  const isSyncingRef = useRef(false);

  // Per-file EditorState cache (history/selection/cursor live in state; scroll is DOM-only).
  const stateCacheRef = useRef<Map<string, { state: EditorState; scrollTop: number }>>(new Map());
  const prevFileIdRef = useRef<string | undefined>(undefined);
  // Latest-callback refs so the mount-time DOM listeners never call a stale callback.
  const onScrollChangeRef = useRef(onScrollChange);
  const onFocusRef = useRef(onFocus);
  const onBlurRef = useRef(onBlur);
  onScrollChangeRef.current = onScrollChange;
  onFocusRef.current = onFocus;
  onBlurRef.current = onBlur;

  const [setupStatus, setSetupStatus] = useState<LSPServerStatus | undefined>(undefined);

  // Keep refs in sync
  fileIdRef.current = fileId;

  // Stable callback for content changes
  const handleContentChange = useCallback(
    (newContent: string) => {
      // Skip if we're syncing external content to prevent loops
      if (isSyncingRef.current) return;
      if (onContentChange) {
        onContentChange(fileIdRef.current, newContent);
      }
    },
    [onContentChange]
  );

  const applyInitialCursor = useCallback(() => {
    const view = editorRef.current;
    if (!view || initialCursorLine === undefined || initialCursorLine <= 0) return;

    const lineNum = Math.min(initialCursorLine, view.state.doc.lines);
    const line = view.state.doc.line(lineNum);
    const col = Math.min((initialCursorColumn ?? 1) - 1, line.length);
    view.dispatch({
      selection: { anchor: line.from + col },
      scrollIntoView: false,
    });
    hasAppliedInitialCursorRef.current = true;
  }, [initialCursorColumn, initialCursorLine]);

  const applyInitialScroll = useCallback(() => {
    const view = editorRef.current;
    if (!view || initialScrollTop === undefined || initialScrollTop < 0) return;

    requestAnimationFrame(() => {
      if (!editorRef.current) return;
      editorRef.current.scrollDOM.scrollTop = initialScrollTop;
      hasAppliedInitialScrollRef.current = true;
    });
  }, [initialScrollTop]);

  // Create the single editor view once. It persists across tab switches; the
  // switch effect below swaps EditorState in place so undo history survives.
  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: createEditorExtensions({
          filename,
          filePath: fileId,
          readOnly,
          tabSize,
          syntaxThemeId: useIDEStore.getState().editorSyntaxTheme,
          onChange: handleContentChange,
          onCursorChange,
        }),
      }),
      parent: containerRef.current,
    });

    editorRef.current = view;
    prevFileIdRef.current = fileId;

    applyInitialCursor();
    applyInitialScroll();

    const uri = filePathToURI(fileId);
    const existingDiags = useLSPStore.getState().diagnostics.get(uri);
    if (existingDiags && existingDiags.length > 0) {
      updateEditorDiagnostics(view, existingDiags);
    }

    const handleFocusEvent = () => onFocusRef.current?.();
    const handleBlurEvent = () => onBlurRef.current?.();
    const handleScroll = () => onScrollChangeRef.current?.(view.scrollDOM.scrollTop);

    view.contentDOM.addEventListener('focus', handleFocusEvent);
    view.contentDOM.addEventListener('blur', handleBlurEvent);
    view.scrollDOM.addEventListener('scroll', handleScroll);

    return () => {
      view.contentDOM.removeEventListener('focus', handleFocusEvent);
      view.contentDOM.removeEventListener('blur', handleBlurEvent);
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      view.destroy();
      editorRef.current = null;
    };
    // Mount once; the switch effect handles per-file state. content/filename/etc.
    // are intentionally captured for the initial file only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap EditorState when the active file changes: save the outgoing file's
  // state, restore the incoming file's cached state (or build a fresh one).
  useEffect(() => {
    const view = editorRef.current;
    if (!view) return;

    const prevFileId = prevFileIdRef.current;
    if (prevFileId === fileId) return; // mount already shows this file

    if (prevFileId !== undefined) {
      stateCacheRef.current.set(prevFileId, {
        state: view.state,
        scrollTop: view.scrollDOM.scrollTop,
      });
    }

    const cached = stateCacheRef.current.get(fileId);
    if (cached) {
      view.setState(cached.state);
      // External reload while this tab was inactive: bring doc up to date
      // without touching undo history. CM maps the restored selection through
      // the splice, so the cursor is best-effort here — a large off-screen edit
      // can drift it. Acceptable for the rare reload-while-backgrounded case.
      isSyncingRef.current = true;
      reconcileDoc(view, content);
      isSyncingRef.current = false;
      // The cached state baked in whatever theme was live when cached; the
      // live-theme subscription only updates the active view, so re-theme now.
      applyEditorTheme(view, useIDEStore.getState().editorSyntaxTheme);
      // A pending navigation for this file (e.g. clicking a search result for a
      // file that is already open in a background tab) must own the viewport.
      // Restoring the tab's remembered scroll here would override the jump — the
      // file switches but the target line stays off-screen. Skip the scroll
      // restore in that case and let the navigation effect scroll to the target,
      // exactly as it does for a freshly-opened file.
      // navigateToEditorLocation registers a pending navigation before it
      // activates an already-open tab, so this is set in time to suppress the
      // restore for a search-result jump.
      const navPendingForThisFile =
        useIDEStore.getState().pendingEditorNavigation?.fileId === fileId;
      if (!navPendingForThisFile) {
        view.scrollDOM.scrollTop = cached.scrollTop;
      }
      // Restored state already carries selection/scroll; suppress initial apply.
      hasAppliedInitialCursorRef.current = true;
      hasAppliedInitialScrollRef.current = true;
    } else {
      view.setState(
        EditorState.create({
          doc: content,
          extensions: createEditorExtensions({
            filename,
            filePath: fileId,
            readOnly,
            tabSize,
            syntaxThemeId: useIDEStore.getState().editorSyntaxTheme,
            onChange: handleContentChange,
            onCursorChange,
          }),
        })
      );
      hasAppliedInitialCursorRef.current = false;
      hasAppliedInitialScrollRef.current = false;
      applyInitialCursor();
      applyInitialScroll();
    }

    // Diagnostics may have arrived while this tab was inactive.
    const diags = useLSPStore.getState().diagnostics.get(filePathToURI(fileId));
    updateEditorDiagnostics(view, diags ?? []);

    prevFileIdRef.current = fileId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // Language chunks load independently of state construction. The same view
  // serves every tab, so each effect generation must reject late results.
  useEffect(() => {
    const view = editorRef.current;
    if (!view) return;

    let cancelled = false;
    void loadLanguageSupport(filename).then((language) => {
      if (cancelled || editorRef.current !== view) return;
      view.dispatch({ effects: languageCompartment.reconfigure(language ?? []) });
    });

    return () => {
      cancelled = true;
    };
  }, [fileId, filename]);

  // Push the git gutter baseline into the (possibly just-swapped) state.
  // Depends on fileId so a file switch re-applies it after view.setState,
  // which replaces the whole EditorState including the gutter field. The
  // null-on-null skip avoids a no-op dispatch on mount: the field's default
  // is already null, and a fresh state after a switch also starts null.
  const lastBaselineRef = useRef<string | null>(null);
  useEffect(() => {
    const view = editorRef.current;
    if (!view) return;
    const stateIsFresh = lastBaselineRef.current === null;
    if (gitBaseline === null && stateIsFresh) return;
    lastBaselineRef.current = gitBaseline;
    view.dispatch({ effects: setGitBaseline.of(gitBaseline) });
  }, [gitBaseline, fileId]);

  // Evict cached state for files that are no longer open (closed tabs).
  // Runs after the switch effect so the outgoing file's save is never lost.
  const openFileIdsKey = openFileIds.join(' ');
  useEffect(() => {
    const open = new Set(openFileIds);
    for (const id of stateCacheRef.current.keys()) {
      if (!open.has(id)) {
        stateCacheRef.current.delete(id);
      }
    }
    // openFileIdsKey is the stable dep; openFileIds identity changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFileIdsKey]);

  useEffect(() => {
    if (hasAppliedInitialCursorRef.current) return;
    applyInitialCursor();
  }, [applyInitialCursor]);

  useEffect(() => {
    if (hasAppliedInitialScrollRef.current) return;
    applyInitialScroll();
  }, [applyInitialScroll]);

  // Update content when it changes externally (e.g., file reload). Uses a
  // minimal, non-undoable splice so a disk change never lands on the undo stack.
  useEffect(() => {
    const view = editorRef.current;
    if (!view) return;
    isSyncingRef.current = true;
    reconcileDoc(view, content);
    isSyncingRef.current = false;
  }, [content]);

  // Subscribe to diagnostics for this file's URI
  useEffect(() => {
    const uri = filePathToURI(fileId);
    let prevDiags = useLSPStore.getState().diagnostics.get(uri);

    const cancel = useLSPStore.subscribe((state) => {
      const diags = state.diagnostics.get(uri);
      if (diags === prevDiags) return;
      prevDiags = diags;

      const view = editorRef.current;
      if (!view) return;

      updateEditorDiagnostics(view, diags ?? []);
    });

    return cancel;
  }, [fileId]);

  // Live-swap the editor theme when the global syntax theme changes. The initial
  // theme is baked in by createEditorExtensions, so we only handle later changes.
  useEffect(() => {
    let prev = useIDEStore.getState().editorSyntaxTheme;
    return useIDEStore.subscribe((state) => {
      const next = state.editorSyntaxTheme;
      if (next === prev) return;
      prev = next;
      const currentView = editorRef.current;
      if (currentView) applyEditorTheme(currentView, next);
    });
  }, []);

  // Enable LSP completion/hover when the matching server becomes ready.
  useEffect(() => {
    const family = lspFamilyForFile(filename);
    if (!family) {
      setSetupStatus(undefined);
      return;
    }

    let lastConfigKey: string | null = null;

    const applyLSPFeatureConfiguration = () => {
      const currentView = editorRef.current;
      if (!currentView) return;

      // fileId is the file's local path (EditorFile.id === EditorFile.path).
      // Status lookup is by file path so nested project-root servers (#20)
      // drive completion/hover correctly inside monorepo packages.
      const status = findServerStatusForFile(useLSPStore.getState().serverStatuses, fileId, family);
      setSetupStatus(status);
      const isReady = status?.state === 'ready';
      const triggerCharacters = status?.completionTriggerCharacters ?? [];
      const nextConfigKey = isReady
        ? `${status?.workspace ?? ''}::${family}::${triggerCharacters.join('\u0000')}`
        : null;

      if (nextConfigKey === lastConfigKey) return;
      if (!nextConfigKey && lastConfigKey === null) return;

      currentView.dispatch({
        effects: [
          completionCompartment.reconfigure(
            isReady ? reconfigureCompletion(fileId, triggerCharacters) : resetCompletion()
          ),
          hoverCompartment.reconfigure(isReady ? reconfigureHover(fileId) : []),
        ],
      });

      lastConfigKey = nextConfigKey;
    };

    applyLSPFeatureConfiguration();

    // Use reference equality on the resolved status entry to skip work during
    // unrelated store updates (e.g. diagnostics arriving on every keystroke).
    let prevStatus = findServerStatusForFile(useLSPStore.getState().serverStatuses, fileId, family);

    const cancelStatus = useLSPStore.subscribe((state) => {
      const status = findServerStatusForFile(state.serverStatuses, fileId, family);
      if (status === prevStatus) return;
      prevStatus = status;
      applyLSPFeatureConfiguration();
    });

    const cancelWorkspace = useIDEStore.subscribe((state, prevState) => {
      if (state.workspace?.path !== prevState.workspace?.path) {
        applyLSPFeatureConfiguration();
      }
    });

    return () => {
      cancelStatus();
      cancelWorkspace();
    };
  }, [fileId, filename]);

  // Handle programmatic navigation requests
  useEffect(() => {
    const cancel = useIDEStore.subscribe((state, prevState) => {
      const nav = state.pendingEditorNavigation;
      const prevNav = prevState.pendingEditorNavigation;
      if (!nav || nav === prevNav || nav.fileId !== fileIdRef.current) return;

      const view = editorRef.current;
      if (!view) return;

      applyNavigation(view, nav);
      useIDEStore.getState().clearPendingEditorNavigation(nav.fileId, nav.revision);
    });

    // Also check if there's a pending navigation right now (e.g., file just opened)
    const nav = useIDEStore.getState().pendingEditorNavigation;
    if (nav && nav.fileId === fileId && editorRef.current) {
      applyNavigation(editorRef.current, nav);
      useIDEStore.getState().clearPendingEditorNavigation(nav.fileId, nav.revision);
    }

    return cancel;
  }, [fileId]);

  return (
    <div className={styles.editorRoot}>
      <LSPSetupCard status={setupStatus} workspacePath={setupStatus?.workspace ?? ''} />
      <div ref={containerRef} className={styles.container} data-testid="codemirror-editor" />
    </div>
  );
});

CodeMirrorEditor.displayName = 'CodeMirrorEditor';
