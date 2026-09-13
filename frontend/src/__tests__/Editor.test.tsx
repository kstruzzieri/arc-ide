import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { useIDEStore } from '../stores/ideStore';
import { useGitStore, type DiffSession, type MergeSession } from '../stores/gitStore';
import { __resetGolemStore, useGolemStore } from '../stores/golemStore';
import { showGolemConfiguration } from '../utils/commands';
import { focusConfigTab } from '../utils/editorSurface';
import { registerConfigCloseHandler } from '../components/GolemConfig/configCloseGuard';

jest.mock('../wails/bindings', () => ({
  OpenFolderDialog: jest.fn(),
  ListRecentWorkspaces: jest.fn(() => Promise.resolve([])),
  CancelGolemRun: jest.fn(),
  RunGolemTurn: jest.fn(),
}));

const mockWindowSetTitle = jest.fn();
jest.mock('../wails/runtime', () => ({
  // Indirected, not referenced: `utils/commands` now reaches the runtime
  // adapter through the #271 window relay, so this factory runs during the
  // imports above — while `mockWindowSetTitle` is still in its temporal dead
  // zone. Every other suite in this repo already spells its mocks this way.
  WindowSetTitle: (...args: unknown[]) => mockWindowSetTitle(...args),
}));

// The real CodeMirrorEditor drags the full CM6 + LSP extension graph into
// jsdom; the suppression tests below only need the Editor shell to mount.
jest.mock('../components/Editor/CodeMirrorEditor', () => {
  const mockReact = require('react');
  return {
    CodeMirrorEditor: () => mockReact.createElement('div', { 'data-testid': 'codemirror-mock' }),
  };
});

// The surfaces themselves are unit-tested in their own suites; here they would
// only drag CodeMirror and the Golem settings transport into a tab-behaviour
// test.
jest.mock('../components/Editor/GitDiffView', () => {
  const mockReact = require('react');
  return { GitDiffView: () => mockReact.createElement('div', { 'data-testid': 'diff-mock' }) };
});
jest.mock('../components/Editor/MergeResolutionView', () => {
  const mockReact = require('react');
  return {
    MergeResolutionView: () => mockReact.createElement('div', { 'data-testid': 'merge-mock' }),
  };
});
jest.mock('../components/GolemConfig/GolemConfigWorkspace', () => {
  const mockReact = require('react');
  return {
    GolemConfigWorkspace: ({ onClose }: { onClose: () => void }) =>
      mockReact.createElement(
        'div',
        { 'data-testid': 'golem-config-mock' },
        mockReact.createElement(
          'button',
          { type: 'button', onClick: onClose },
          'Close configuration'
        )
      ),
  };
});

import { Editor } from '../components/Editor';
import * as platform from '../utils/platform';

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({
    workspace: null,
    workspaces: [],
    activeWorkspaceId: 'project',
    openFiles: [],
    activeFileId: null,
    recentWorkspaces: [],
  });
  useGitStore.setState({
    diffSession: null,
    diffFocused: false,
    mergeSession: null,
    mergeFocused: false,
    mergeAdvancePending: false,
  });
  __resetGolemStore();
});

function openFile(id: string, name: string) {
  return {
    id,
    name,
    path: `/repo/src/${name}`,
    content: '',
    isModified: false,
    language: 'typescript',
    encoding: 'UTF-8',
    lineEndings: 'LF' as const,
  };
}

const diffSession = {
  path: 'src/a.ts',
  absPath: '/repo/src/a.ts',
  context: 'unstaged',
  left: { label: 'Index', content: 'old' },
  right: { label: 'Working Tree', content: 'new' },
  binary: false,
  truncated: false,
  hunks: [],
} as unknown as DiffSession;

const otherDiffSession = { ...diffSession, path: 'src/b.ts', absPath: '/repo/src/b.ts' };

const mergeSession = {
  kind: 'sides',
  path: 'clash.go',
  absPath: '/repo/clash.go',
  repoRoot: '/repo',
  labels: {
    operation: 'merge',
    ours: { label: 'current', hash: 'abc', subject: '' },
    theirs: { label: 'incoming', hash: 'def', subject: '' },
  },
  fileQueue: ['clash.go'],
  requestRevision: 1,
  epoch: 1,
  fileWriteRevision: 1,
  stages: { path: 'clash.go', binary: true },
} as unknown as MergeSession;

const otherMergeSession = {
  ...mergeSession,
  path: 'other.go',
  absPath: '/repo/other.go',
} as unknown as MergeSession;

const configTab = () => screen.getByRole('tab', { name: 'Golem Configuration' });

describe('Editor Welcome Screen', () => {
  it('should show keyboard shortcuts when no files are open', () => {
    render(<Editor />);
    expect(screen.getByText('Open File')).toBeInTheDocument();
    expect(screen.getByText('Command Palette')).toBeInTheDocument();
    expect(screen.getByText('Quick Search')).toBeInTheDocument();
  });

  it('should show recent projects section when recent workspaces exist', () => {
    useIDEStore.setState({
      recentWorkspaces: [
        { name: 'project-a', path: '/Users/test/project-a', lastOpened: '2026-01-01T00:00:00Z' },
        { name: 'project-b', path: '/Users/test/project-b', lastOpened: '2025-12-31T00:00:00Z' },
      ],
    });

    render(<Editor />);
    expect(screen.getByText('Recent Projects')).toBeInTheDocument();
    expect(screen.getByText('project-a')).toBeInTheDocument();
    expect(screen.getByText('project-b')).toBeInTheDocument();
  });

  it('should not show recent projects section when list is empty', () => {
    render(<Editor />);
    expect(screen.queryByText('Recent Projects')).not.toBeInTheDocument();
  });

  it('should filter out the current workspace from recent projects', () => {
    useIDEStore.setState({
      workspace: { name: 'current', path: '/Users/test/current' },
      recentWorkspaces: [
        { name: 'current', path: '/Users/test/current', lastOpened: '2026-01-02T00:00:00Z' },
        { name: 'other', path: '/Users/test/other', lastOpened: '2026-01-01T00:00:00Z' },
      ],
    });

    render(<Editor />);
    expect(screen.getByText('other')).toBeInTheDocument();
    // "current" should only appear once (in the store, not in the list)
    const currentElements = screen.queryAllByText('current');
    expect(currentElements).toHaveLength(0);
  });

  it('should open a workspace when a recent project is clicked', () => {
    useIDEStore.setState({
      recentWorkspaces: [
        { name: 'my-project', path: '/Users/test/my-project', lastOpened: '2026-01-01T00:00:00Z' },
      ],
    });

    render(<Editor />);

    fireEvent.click(screen.getByText('my-project'));

    const state = useIDEStore.getState();
    expect(state.workspace).toEqual({
      name: 'my-project',
      path: '/Users/test/my-project',
    });
    expect(mockWindowSetTitle).toHaveBeenCalledWith('my-project \u2014 Firn');
  });

  it('should shorten displayed paths with ~ for home directories', () => {
    useIDEStore.setState({
      recentWorkspaces: [
        {
          name: 'my-project',
          path: '/Users/testuser/projects/my-project',
          lastOpened: '2026-01-01T00:00:00Z',
        },
      ],
    });

    render(<Editor />);
    expect(screen.getByText('~/projects/my-project')).toBeInTheDocument();
  });

  it('suppresses the browser native find dialog when no files are open', () => {
    const isMacSpy = jest.spyOn(platform, 'isMac').mockReturnValue(true);
    try {
      render(<Editor />);

      const event = new KeyboardEvent('keydown', {
        key: 'f',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });

      window.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    } finally {
      isMacSpy.mockRestore();
    }
  });

  it('leaves Cmd+Shift+F untouched so it can be claimed by project search', () => {
    render(<Editor />);

    const event = new KeyboardEvent('keydown', {
      key: 'F',
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('does not suppress unmodified F keystrokes when no files are open', () => {
    render(<Editor />);

    const event = new KeyboardEvent('keydown', {
      key: 'f',
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps suppressing native find when files are open but the editor is unfocused', () => {
    useIDEStore.setState({
      openFiles: [
        {
          id: 'file-1',
          name: 'a.ts',
          path: '/ws/a.ts',
          language: 'typescript',
          encoding: 'utf-8',
          lineEndings: 'lf',
          content: '',
          isModified: false,
        },
      ],
      activeFileId: 'file-1',
    });

    const isMacSpy = jest.spyOn(platform, 'isMac').mockReturnValue(false);
    try {
      render(<Editor />);

      const event = new KeyboardEvent('keydown', {
        key: 'f',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });

      window.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    } finally {
      isMacSpy.mockRestore();
    }
  });

  it('suppresses plain Cmd+F on macOS', () => {
    const isMacSpy = jest.spyOn(platform, 'isMac').mockReturnValue(true);
    try {
      render(<Editor />);

      const event = new KeyboardEvent('keydown', {
        key: 'f',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });

      window.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    } finally {
      isMacSpy.mockRestore();
    }
  });

  it('shows the welcome screen only while no editor surface — configuration included — is open', () => {
    render(<Editor />);
    expect(screen.getByText('Open File')).toBeInTheDocument();

    act(() => {
      focusConfigTab();
    });

    expect(screen.queryByText('Open File')).not.toBeInTheDocument();
    expect(screen.getByTestId('golem-config-mock')).toBeVisible();
  });

  it('does not swallow Ctrl+Cmd+F, the macOS toggle-fullscreen shortcut', () => {
    const isMacSpy = jest.spyOn(platform, 'isMac').mockReturnValue(true);
    try {
      render(<Editor />);

      const event = new KeyboardEvent('keydown', {
        key: 'f',
        ctrlKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });

      window.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
    } finally {
      isMacSpy.mockRestore();
    }
  });
});

describe('Golem configuration tab (#263 Slice B)', () => {
  it('is one app-global tab: reopening focuses the existing instance', () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'a.ts')], activeFileId: 'f1' });
    render(<Editor />);

    act(() => {
      focusConfigTab();
    });
    act(() => {
      // A file tab takes focus back, then the palette/dock re-opens.
      fireEvent.click(screen.getByRole('tab', { name: /a\.ts/i }));
    });
    act(() => {
      focusConfigTab();
    });

    expect(screen.getAllByRole('tab', { name: 'Golem Configuration' })).toHaveLength(1);
    expect(screen.getAllByTestId('golem-config-mock')).toHaveLength(1);
    expect(configTab()).toHaveAttribute('aria-selected', 'true');
  });

  it('carries the specified tab id, label, and tablist name', () => {
    render(<Editor />);
    act(() => {
      focusConfigTab();
    });

    expect(configTab()).toHaveAttribute('id', 'tab-golem-config');
    expect(screen.getByRole('tablist', { name: 'Open editors' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-golem-config');
  });

  it('joins the roving tab order and activates from the keyboard', () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'a.ts')], activeFileId: 'f1' });
    render(<Editor />);
    act(() => {
      focusConfigTab();
    });

    const fileTab = screen.getByRole('tab', { name: /a\.ts/i });
    expect([fileTab.tabIndex, configTab().tabIndex]).toEqual([-1, 0]);

    configTab().focus();
    fireEvent.keyDown(configTab(), { key: 'ArrowLeft' });
    expect(fileTab).toHaveFocus();

    fireEvent.keyDown(fileTab, { key: 'End' });
    expect(configTab()).toHaveFocus();

    // Focus alone must not switch surfaces; Enter is what selects.
    fireEvent.click(fileTab);
    expect(screen.getByTestId('golem-config-mock')).not.toBeVisible();
    configTab().focus();
    fireEvent.keyDown(configTab(), { key: 'Enter' });
    expect(screen.getByTestId('golem-config-mock')).toBeVisible();
  });

  it('switches between the configuration tab and file, diff, and merge surfaces', () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'a.ts')], activeFileId: 'f1' });
    render(<Editor />);
    act(() => {
      focusConfigTab();
    });
    expect(screen.getByTestId('codemirror-mock')).not.toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/i }));
    expect(screen.getByTestId('codemirror-mock')).toBeVisible();
    expect(screen.getByTestId('golem-config-mock')).not.toBeVisible();

    // A diff opened from the Git panel while the configuration tab is selected
    // has to become visible, not open behind it.
    fireEvent.click(configTab());
    act(() => {
      useGitStore.setState({ diffSession, diffFocused: true });
    });
    expect(screen.getByTestId('diff-mock')).toBeVisible();
    expect(screen.getByTestId('golem-config-mock')).not.toBeVisible();

    fireEvent.click(configTab());
    expect(screen.getByTestId('golem-config-mock')).toBeVisible();
    expect(screen.getByTestId('diff-mock')).not.toBeVisible();

    act(() => {
      useGitStore.setState({ mergeSession, mergeFocused: true, diffFocused: false });
    });
    expect(screen.getByTestId('merge-mock')).toBeVisible();
    expect(screen.getByTestId('golem-config-mock')).not.toBeVisible();

    fireEvent.click(configTab());
    expect(screen.getByTestId('golem-config-mock')).toBeVisible();
  });

  // §6.3: the dialog the guard raises lives inside the configuration pane, and
  // a pane inside a railed Files column cannot show one.
  it('reveals a railed Files column when the dirty configuration tab is asked to close', async () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'a.ts')], activeFileId: 'f1' });
    render(<Editor />);
    act(() => {
      focusConfigTab();
    });

    const confirm = jest.fn().mockResolvedValue(false);
    registerConfigCloseHandler({ hasUnsavedWork: () => true, confirm });
    try {
      act(() => useIDEStore.getState().setFilesPanelCollapsed(true));

      fireEvent.click(screen.getByRole('button', { name: 'Close Golem Configuration' }));

      expect(useIDEStore.getState().isFilesPanelCollapsed).toBe(false);
      await waitFor(() => expect(confirm).toHaveBeenCalledWith('close'));
      // Refused: the tab stays, still selected on the revealed column.
      expect(configTab()).toHaveAttribute('aria-selected', 'true');
    } finally {
      registerConfigCloseHandler(null);
    }
  });

  it('closes cleanly from the tab and from the surface, restoring focus', async () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'a.ts')], activeFileId: 'f1' });
    render(<Editor />);
    act(() => {
      focusConfigTab();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close Golem Configuration' }));

    // Closing now asks the surface first (§4.6a). Nothing is mounted to answer
    // here, so the guard resolves clean — one microtask later, not synchronously.
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'Golem Configuration' })).not.toBeInTheDocument()
    );
    expect(screen.queryByTestId('golem-config-mock')).not.toBeInTheDocument();
    expect(useGolemStore.getState().configTabOpen).toBe(false);
    await waitFor(() => expect(screen.getByRole('tab', { name: /a\.ts/i })).toHaveFocus());

    // The surface's own Close is the same clean teardown.
    act(() => {
      focusConfigTab();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close configuration' }));
    await waitFor(() => expect(screen.queryByTestId('golem-config-mock')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('tab', { name: /a\.ts/i })).toHaveFocus());
  });

  // gitStore.openDiff only ever RAISES diffFocused (`focus ? true : state.…`),
  // so a second diff opened while the flag is already true is no rising edge at
  // all. Without the configuration tab also parking the git-side focus, the
  // session swaps behind this surface and the Git-panel click is dead.
  it('reveals a diff opened from the Git panel while a diff was already focused', () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'a.ts')], activeFileId: 'f1' });
    render(<Editor />);

    act(() => {
      useGitStore.setState({ diffSession, diffFocused: true });
    });
    expect(screen.getByTestId('diff-mock')).toBeVisible();

    act(() => {
      showGolemConfiguration(); // the palette command, not the raw store action
    });
    expect(screen.getByTestId('golem-config-mock')).toBeVisible();

    act(() => {
      // Another file's diff row: openDiff swaps the session and re-raises the
      // already-true focus flag.
      useGitStore.setState({ diffSession: otherDiffSession, diffFocused: true });
    });

    expect(screen.getByTestId('diff-mock')).toBeVisible();
    expect(screen.getByTestId('golem-config-mock')).not.toBeVisible();
    expect(configTab()).toHaveAttribute('aria-selected', 'false');
  });

  it('reveals a merge re-opened while a merge was already focused', () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'a.ts')], activeFileId: 'f1' });
    render(<Editor />);

    act(() => {
      useGitStore.setState({ mergeSession, mergeFocused: true });
    });
    expect(screen.getByTestId('merge-mock')).toBeVisible();

    act(() => {
      focusConfigTab();
    });
    expect(screen.getByTestId('golem-config-mock')).toBeVisible();

    act(() => {
      // The conflict queue advancing: openMergeResolution replaces the session
      // and re-asserts mergeFocused: true.
      useGitStore.setState({ mergeSession: otherMergeSession, mergeFocused: true });
    });

    expect(screen.getByTestId('merge-mock')).toBeVisible();
    expect(screen.getByTestId('golem-config-mock')).not.toBeVisible();
    expect(configTab()).toHaveAttribute('aria-selected', 'false');
  });

  it('stays open and mounted across a workspace switch, selection following the restored file', () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'a.ts')], activeFileId: 'f1' });
    render(<Editor />);
    act(() => {
      focusConfigTab();
    });

    act(() => {
      // Opening another project retires that workspace's editors...
      useIDEStore.setState({
        workspace: { name: 'other', path: '/other' },
        openFiles: [],
        activeFileId: null,
      });
    });
    // ...and the app-global surface survives, showing while nothing else can.
    expect(screen.getByTestId('golem-config-mock')).toBeVisible();

    act(() => {
      // Then the new workspace restores its own layout, which activates a file
      // and so runs the real focusEditorSurface('file') path.
      useIDEStore.setState({ openFiles: [openFile('f2', 'b.ts')] });
      useIDEStore.getState().setActiveFile('f2');
    });

    // The contract is open + mounted (spec §3.1/§4.6a); selection legitimately
    // follows the restored file.
    expect(useGolemStore.getState().configTabOpen).toBe(true);
    expect(configTab()).toBeInTheDocument();
    expect(screen.getByTestId('golem-config-mock')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /b\.ts/i })).toHaveAttribute('aria-selected', 'true');
    expect(configTab()).toHaveAttribute('aria-selected', 'false');
  });

  // §Task 10 / #309: a narrow tab strip (`.tabBar { overflow-x: auto }`) can
  // scroll the active tab out of sight; jsdom has no scrollIntoView, hence the
  // optional call and the stub below.
  it('scrolls the Golem Configuration tab into view when it becomes active (#309)', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scroll = jest.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      useIDEStore.setState({ openFiles: [openFile('f1', 'a.ts')], activeFileId: 'f1' });
      render(<Editor />);

      act(() => {
        focusConfigTab();
      });

      expect(configTab()).toHaveAttribute('aria-selected', 'true');
      expect(scroll).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('reveals the tab again when the already-active tab is clicked (#309)', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scroll = jest.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      render(<Editor />);
      act(() => {
        focusConfigTab();
      });
      scroll.mockClear();

      fireEvent.click(configTab());

      expect(scroll).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
