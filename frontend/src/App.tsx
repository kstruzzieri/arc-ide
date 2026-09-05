import './styles/tokens.css';
import './styles/reset.css';
import { useCallback, useEffect, useRef } from 'react';
import { IDEShell } from './components/layout';
import { RunProfiles } from './components/RunProfiles';
import { GolemPanel } from './components/Golem';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { FileExplorer } from './components/FileExplorer';
import { SearchPanel } from './components/Search';
import { GitPanel } from './components/GitPanel';
import { StructureView } from './components/Structure';
import { Editor } from './components/Editor';
import { Terminal } from './components/Terminal';
import { StatusBar } from './components/StatusBar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toast } from './components/Toast';
import { useAutosave } from './hooks/useAutosave';
import { useWorkspacePersistence } from './hooks/useWorkspacePersistence';
import { useRecentWorkspaces } from './hooks/useRecentWorkspaces';
import { useRunProfilesLoader } from './hooks/useRunProfiles';
import { drainRunHistoryForClose, useRunOutputListener } from './hooks/useRunOutput';
import { useGolemBridge } from './hooks/useGolemBridge';
import { useLSPDocumentSync } from './hooks/useLSPDocumentSync';
import { useLSPEvents } from './hooks/useLSPEvents';
import { useFileWatcher } from './hooks/useFileWatcher';
import { useGitSync } from './hooks/useGitSync';
import { useWorkspaceSearch } from './hooks/useWorkspaceSearch';
import { useWorkspaceDetection } from './hooks/useWorkspaceDetection';
import { useConflictProjectionSync } from './hooks/useProblemsProjection';
import { useWorkspace, useIDEStore, useSidebarView, useActiveAccent } from './stores/ideStore';
import { useGitStore } from './stores/gitStore';
import { ReadFile } from './wails/bindings';
import type { FileEvent } from './types/watcher';
import { getDirectoryPath, pathsReferToSameFile } from './utils/lspUri';
import { isDirVisible } from './utils/treeVisibility';
import { findEntryByPath } from './utils/findEntryByPath';
import { ensurePathLoaded } from './hooks/useEnsurePathLoaded';
import { flushAllFileEdits } from './utils/fileWrites';
import { focusConfigTab } from './utils/editorSurface';
import {
  confirmConfigClose,
  hasUnsavedConfigWork,
} from './components/GolemConfig/configCloseGuard';

// Module scope, not an inline arrow: IDEShell memoizes the Golem island on this
// callback's identity, and a fresh function per App render would throw that
// memo away every time App re-renders (sidebar view, workspace, …).
const renderGolemPanel = (visible: boolean) => <GolemPanel visible={visible} />;

function App() {
  // Per-directory debounce timers so concurrent changes in different dirs don't
  // collapse into one mis-scoped refetch.
  const reconcileTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // The app-close handshake (§5.5) asks the configuration surface first: it may
  // hold a dirty draft, an open editor, or a pending settings challenge that the
  // backend must not tear down underneath. A dirty surface is revealed before it
  // is asked, because the dialog it raises lives inside that pane.
  const golemConfigCloseGuard = useCallback(async () => {
    if (hasUnsavedConfigWork()) focusConfigTab();
    return confirmConfigClose('quit');
  }, []);

  useAutosave();
  useWorkspacePersistence(flushAllFileEdits, drainRunHistoryForClose, golemConfigCloseGuard);
  // Own run-event capture at the always-mounted App so collapsing the bottom
  // panel (which unmounts Terminal) cannot drop run output or history (#235).
  useRunOutputListener();
  // The Golem island stays mounted now (#271), but the bridge and the
  // repository binding it owns still live at the always-mounted App: they are
  // app-level, not panel-level.
  useGolemBridge();
  useWorkspaceDetection();
  useLSPDocumentSync();
  useLSPEvents();
  useRecentWorkspaces();
  // Mount workspace-search wiring once at the App level so the in-flight
  // request guards (workspace switch, unmount) survive panel toggling.
  useWorkspaceSearch();
  useGitSync();
  // Own the conflict-state reads at the always-mounted App: the Problems panel
  // unmounts when the bottom panel collapses, but the StatusBar consumes the
  // same conflict-aware projection and is always visible (#254).
  useConflictProjectionSync();
  const workspace = useWorkspace();
  const sidebarView = useSidebarView();
  const activeAccent = useActiveAccent();
  useRunProfilesLoader(workspace?.path);

  const reconcileDir = useCallback((dir: string) => {
    const s = useIDEStore.getState();
    const root = s.workspace?.path;
    if (!root) return;
    const isRoot = pathsReferToSameFile(dir, root);
    const node = isRoot ? { children: s.directoryTree } : findEntryByPath(s.directoryTree, dir);
    if (!node || node.children === undefined) return; // not loaded → ignore

    // A dir's children are visible when: it's root (always expanded via isRootExpanded)
    // or it's in expandedPaths AND its ancestor chain is visible (isDirVisible).
    // ponytail: isDirVisible alone is insufficient — it checks row visibility not content visibility
    const visible = isRoot
      ? s.isRootExpanded
      : s.expandedPaths.has(dir) &&
        isDirVisible(dir, {
          rootPath: root,
          isRootExpanded: s.isRootExpanded,
          expandedPaths: s.expandedPaths,
        });
    if (!visible) {
      s.markDirty(dir);
      return;
    }

    const timers = reconcileTimersRef.current;
    const existing = timers.get(dir);
    if (existing) clearTimeout(existing);
    timers.set(
      dir,
      setTimeout(() => {
        timers.delete(dir);
        void ensurePathLoaded(dir, { force: true });
      }, 75)
    );
  }, []);

  const handleFileChange = useCallback(
    (event: FileEvent) => {
      // Any working-tree event can change git status; the store debounces.
      useGitStore.getState().scheduleRefresh();

      // An open merge session is not an open editor buffer, so the reload path
      // below never sees it. Hand it every event for a file — including both
      // ends of a rename, since the session's path may be either — and let the
      // store decide whether anything actually moved. The backend watcher
      // already coalesces per path, so there is no timer here.
      if (!event.isDir) {
        const git = useGitStore.getState();
        void git.notifyMergeFileChanged(event.path);
        if (event.oldPath) void git.notifyMergeFileChanged(event.oldPath);
      }

      const { openFiles } = useIDEStore.getState();
      const openFile = openFiles.find((f) => f.path === event.path);

      if (event.type === 'modified' && !event.isDir) {
        if (!openFile || openFile.isModified) return;

        ReadFile(event.path)
          .then((result) => {
            if (result === null) {
              throw new Error(`ReadFile returned no content for ${event.path}`);
            }
            const state = useIDEStore.getState();
            const file = state.openFiles.find((f) => f.path === event.path);
            if (file && !file.isModified) {
              state.updateFileContent(file.id, result.content);
              state.setFileModified(file.id, false);
            }
          })
          .catch((err) => {
            console.error(`Failed to reload ${event.path}:`, err);
          });
        return;
      }

      if (
        event.type === 'created' ||
        event.type === 'deleted' ||
        event.type === 'renamed' ||
        event.isDir
      ) {
        const dir = getDirectoryPath(event.path) || event.path;
        reconcileDir(dir);
      }
    },
    [reconcileDir]
  );

  useFileWatcher(workspace?.path ?? null, handleFileChange);

  useEffect(() => {
    const timers = reconcileTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  return (
    <ErrorBoundary>
      <IDEShell
        accent={activeAccent}
        header={(openCommandPalette) => <Header onOpenCommandPalette={openCommandPalette} />}
        sidebar={<Sidebar />}
        leftPanel={
          sidebarView === 'search' ? (
            <SearchPanel />
          ) : sidebarView === 'git' ? (
            <GitPanel />
          ) : sidebarView === 'structure' ? (
            <StructureView />
          ) : (
            <FileExplorer />
          )
        }
        centerPanel={<Editor />}
        golemPanel={renderGolemPanel}
        bottomPanel={<Terminal />}
        rightPanel={<RunProfiles />}
        statusBar={<StatusBar />}
      />
      <Toast />
    </ErrorBoundary>
  );
}

export default App;
