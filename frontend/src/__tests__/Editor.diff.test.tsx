import { render, screen, fireEvent, act, createEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useIDEStore } from '../stores/ideStore';
import { useGitStore, type DiffSession, type MergeSession } from '../stores/gitStore';
import type { workspace } from '../wails/bindings';

jest.mock('../wails/bindings', () => ({
  OpenFolderDialog: jest.fn(),
  ListRecentWorkspaces: jest.fn(() => Promise.resolve([])),
  GitStatus: jest.fn(),
  GitStage: jest.fn(),
  GitUnstage: jest.fn(),
  GitCommit: jest.fn(),
  GitPull: jest.fn(),
  GitPush: jest.fn(),
  GitBranches: jest.fn(),
  GitCheckout: jest.fn(),
  GitCommitMessageAvailable: jest.fn(),
  GitGenerateCommitMessage: jest.fn(),
  GitFileAtRev: jest.fn(),
  ReadFile: jest.fn(),
}));

jest.mock('../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
}));

// The merge view itself is unit-tested in GitDiffView.test; here it would
// drag CodeMirror into a tab-behavior test.
jest.mock('../components/Editor/GitDiffView', () => ({
  GitDiffView: ({ session }: { session: DiffSession }) => (
    <div data-testid="git-diff-view">{session.path}</div>
  ),
}));
// Both surfaces stay mounted now, so the editor renders even under a focused
// diff; stub CodeMirror to keep it out of these tab-behavior tests.
jest.mock('../components/Editor/CodeMirrorEditor', () => ({
  CodeMirrorEditor: () => <div data-testid="cm-editor" />,
}));
jest.mock('../components/Editor/MergeResolutionView', () => ({
  MergeResolutionView: ({
    session,
    visible,
    onFinalizingChange,
  }: {
    session: MergeSession;
    visible: boolean;
    onFinalizingChange?: (finalizing: boolean) => void;
  }) => (
    <div data-testid="merge-resolution-view" data-visible={visible}>
      {session.path}
      <button type="button" onClick={() => onFinalizingChange?.(true)}>
        Start deferred finalize
      </button>
    </div>
  ),
}));

import { Editor } from '../components/Editor';

const session: DiffSession = {
  path: 'src/a.ts',
  absPath: '/repo/src/a.ts',
  context: 'unstaged',
  left: { label: 'Index', content: 'old' },
  right: { label: 'Working Tree', content: 'new' },
  binary: false,
  truncated: false,
  hunks: [],
};

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

const textMergeSession = {
  kind: 'text',
  path: 'clash.go',
  absPath: '/repo/clash.go',
  repoRoot: '/repo',
  labels: mergeSession.labels,
  fileQueue: ['clash.go'],
  requestRevision: 1,
  epoch: 1,
  fileWriteRevision: 1,
  content: '<<<<<<< current\nleft\n=======\nright\n>>>>>>> incoming\n',
  encoding: 'utf-8',
  lineEndings: 'lf',
  regions: [
    {
      index: 0,
      startLine: 1,
      endLine: 5,
      ours: ['left'],
      base: [],
      theirs: ['right'],
      hasBase: false,
      oursLabel: 'current',
      theirLabel: 'incoming',
    },
  ],
  decisions: {},
  readOnly: false,
} as unknown as MergeSession;

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

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({
    workspace: { name: 'repo', path: '/repo' },
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
  });
});

describe('Editor merge-resolution tab', () => {
  it('keeps the merge surface mounted while another tab is selected and closes through the guard', () => {
    const requestMergeClose = jest.fn();
    useIDEStore.setState({ openFiles: [openFile('f1', 'other.ts')], activeFileId: 'f1' });
    useGitStore.setState({ mergeSession, mergeFocused: true, requestMergeClose });

    render(<Editor />);

    const mergeTab = screen.getByRole('tab', { name: /clash\.go.*merge/i });
    expect(mergeTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /other\.ts/i }));
    expect(screen.getByTestId('merge-resolution-view')).toHaveAttribute('data-visible', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Close merge resolution' }));
    // The tab X takes the identical path as Escape: a touched session gets the
    // discard confirmation rather than closing outright.
    expect(requestMergeClose).toHaveBeenCalledTimes(1);
  });

  it('never closes a merge session directly from the tab', () => {
    const requestMergeClose = jest.fn();
    const closeMergeResolution = jest.fn();
    useGitStore.setState({
      mergeSession: { ...mergeSession, dirty: true } as unknown as MergeSession,
      mergeFocused: true,
      requestMergeClose,
      closeMergeResolution,
    });

    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: 'Close merge resolution' }));

    expect(requestMergeClose).toHaveBeenCalledTimes(1);
    expect(closeMergeResolution).not.toHaveBeenCalled();
  });

  it('disables merge close while its surface reports a deferred finalize', () => {
    const requestMergeClose = jest.fn();
    useGitStore.setState({ mergeSession, mergeFocused: true, requestMergeClose });

    render(<Editor />);

    fireEvent.click(screen.getByRole('button', { name: 'Start deferred finalize' }));
    const close = screen.getByRole('button', { name: 'Close merge resolution' });
    expect(close).toBeDisabled();
    fireEvent.click(close);
    expect(requestMergeClose).not.toHaveBeenCalled();
  });

  it('restores focus after a close that did not come from the tab X', async () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'other.ts')], activeFileId: 'f1' });
    useGitStore.setState({ mergeSession, mergeFocused: true });
    render(<Editor />);

    // A view-originated close (Escape, or the resolved-outside notice) bypasses
    // the tab entirely, so focus restoration cannot hang off the X handler.
    act(() => {
      useGitStore.setState({ mergeSession: null, mergeFocused: false });
    });

    // Restoration is deferred until the tab state settles, so poll rather than
    // race a fixed delay.
    await waitFor(() => expect(screen.getByRole('tab', { name: /other\.ts/i })).toHaveFocus());
  });

  it('falls back to the main landmark when a close leaves no tabs', async () => {
    useGitStore.setState({ mergeSession, mergeFocused: true });
    const main = document.createElement('div');
    main.id = 'main-content';
    main.tabIndex = -1;
    document.body.appendChild(main);
    render(<Editor />);
    expect(screen.getByRole('tab', { name: /clash\.go.*merge/i })).toBeInTheDocument();

    act(() => {
      useGitStore.setState({ mergeSession: null, mergeFocused: false });
    });

    await waitFor(() => expect(main).toHaveFocus());
    main.remove();
  });

  it('keeps an explicitly focused diff selected when a merge session is installed', () => {
    useGitStore.setState({
      diffSession: session,
      diffFocused: true,
      mergeSession,
      mergeFocused: false,
    });

    render(<Editor />);

    expect(useGitStore.getState().diffFocused).toBe(true);
    expect(screen.getByRole('tab', { name: /a\.ts.*diff/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it.each([
    ['file', false, false, /other\.ts/i],
    ['diff', true, false, /a\.ts.*diff/i],
    ['merge', false, true, /clash\.go.*merge/i],
  ])(
    'does not steal the focused %s surface during a failed-stage baseline rebase',
    (_focus, diffFocused, mergeFocused, selectedTab) => {
      useIDEStore.setState({ openFiles: [openFile('f1', 'other.ts')], activeFileId: 'f1' });
      useGitStore.setState({
        diffSession: session,
        diffFocused,
        mergeSession: textMergeSession,
        mergeFocused,
      });
      render(<Editor />);

      act(() => {
        useGitStore.setState({
          mergeSession: {
            ...textMergeSession,
            content: (textMergeSession as { content: string }).content + '\nrebased baseline',
            fileWriteRevision: 2,
          } as MergeSession,
        });
      });

      expect(useGitStore.getState().diffFocused).toBe(diffFocused);
      expect(useGitStore.getState().mergeFocused).toBe(mergeFocused);
      expect(screen.getByRole('tab', { name: selectedTab })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    }
  );
});

describe('Editor git diff tab', () => {
  it('renders a diff tab and view when a session is focused', () => {
    useGitStore.setState({ diffSession: session, diffFocused: true });

    render(<Editor />);

    expect(screen.getByRole('tab', { name: /a\.ts.*diff/i })).toBeInTheDocument();
    expect(screen.getByTestId('git-diff-view')).toHaveTextContent('src/a.ts');
  });

  it('marks only the diff tab active while the diff is focused', () => {
    useIDEStore.setState({
      openFiles: [openFile('f1', 'other.ts')],
      activeFileId: 'f1',
    });
    useGitStore.setState({ diffSession: session, diffFocused: true });

    render(<Editor />);

    expect(screen.getByRole('tab', { name: /a\.ts.*diff/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: /other\.ts/i })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('marks only the file tab active once the diff is unfocused', () => {
    useIDEStore.setState({
      openFiles: [openFile('f1', 'other.ts')],
      activeFileId: 'f1',
    });
    useGitStore.setState({ diffSession: session, diffFocused: false });

    render(<Editor />);

    expect(screen.getByRole('tab', { name: /other\.ts/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: /a\.ts.*diff/i })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('shows the diff instead of the welcome screen even with no open files', () => {
    useGitStore.setState({ diffSession: session, diffFocused: true });

    render(<Editor />);

    expect(screen.queryByText('Command Palette')).not.toBeInTheDocument();
  });

  it('shows the diff when there is no active file, even if unfocused', () => {
    // After closing the file opened from a diff, the diff tab remains and
    // there is nothing else to show, so the diff must render (not blank).
    useIDEStore.setState({ openFiles: [], activeFileId: null });
    useGitStore.setState({ diffSession: session, diffFocused: false });

    render(<Editor />);

    expect(screen.getByTestId('git-diff-view')).toBeInTheDocument();
  });

  it('yields the diff when a file is opened (activeFileId changes)', () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'other.ts')], activeFileId: 'f1' });
    useGitStore.setState({ diffSession: session, diffFocused: true });

    const { rerender } = render(<Editor />);

    // Open a different file, as a tree double-click would.
    act(() => {
      useIDEStore.setState({
        openFiles: [openFile('f1', 'other.ts'), openFile('f2', 'new.ts')],
        activeFileId: 'f2',
      });
    });
    rerender(<Editor />);

    expect(useGitStore.getState().diffFocused).toBe(false);
  });

  it('closing the diff tab clears the session', () => {
    useGitStore.setState({ diffSession: session, diffFocused: true });

    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: /close diff/i }));

    expect(useGitStore.getState().diffSession).toBeNull();
  });

  it('clicking a file tab unfocuses the diff without closing it', () => {
    useIDEStore.setState({
      openFiles: [openFile('f1', 'other.ts')],
      activeFileId: 'f1',
    });
    useGitStore.setState({ diffSession: session, diffFocused: true });

    render(<Editor />);
    fireEvent.click(screen.getByRole('tab', { name: /other\.ts/i }));

    expect(useGitStore.getState().diffFocused).toBe(false);
    expect(useGitStore.getState().diffSession).not.toBeNull();
  });

  it('clicking the diff tab refocuses an unfocused session', () => {
    useIDEStore.setState({
      openFiles: [openFile('f1', 'other.ts')],
      activeFileId: 'f1',
    });
    useGitStore.setState({ diffSession: session, diffFocused: false });

    render(<Editor />);
    act(() => {
      fireEvent.click(screen.getByRole('tab', { name: /a\.ts.*diff/i }));
    });

    expect(useGitStore.getState().diffFocused).toBe(true);
  });

  it('uses one selected tab stop and moves focus without activating tabs', () => {
    useIDEStore.setState({
      openFiles: [openFile('f1', 'one.ts'), openFile('f2', 'two.ts')],
      activeFileId: 'f1',
    });
    useGitStore.setState({ diffSession: session, diffFocused: false });

    render(<Editor />);

    const one = screen.getByRole('tab', { name: /one\.ts/i });
    const two = screen.getByRole('tab', { name: /two\.ts/i });
    const diff = screen.getByRole('tab', { name: /a\.ts.*diff/i });
    expect([one.tabIndex, two.tabIndex, diff.tabIndex]).toEqual([0, -1, -1]);

    one.focus();
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    expect(two).toHaveFocus();
    expect(useIDEStore.getState().activeFileId).toBe('f1');

    fireEvent.keyDown(two, { key: 'ArrowLeft' });
    expect(one).toHaveFocus();
    fireEvent.keyDown(one, { key: 'ArrowLeft' });
    expect(diff).toHaveFocus();
    fireEvent.keyDown(diff, { key: 'ArrowRight' });
    expect(one).toHaveFocus();

    two.focus();
    fireEvent.keyDown(two, { key: 'End' });
    expect(diff).toHaveFocus();
    expect(useGitStore.getState().diffFocused).toBe(false);

    fireEvent.keyDown(diff, { key: 'ArrowRight' });
    expect(one).toHaveFocus();
    fireEvent.keyDown(one, { key: 'End' });
    fireEvent.keyDown(diff, { key: 'Home' });
    expect(one).toHaveFocus();
  });

  it('activates focused file and diff tabs with Enter and Space', () => {
    useIDEStore.setState({
      openFiles: [openFile('f1', 'one.ts'), openFile('f2', 'two.ts')],
      activeFileId: 'f1',
    });
    useGitStore.setState({ diffSession: session, diffFocused: false });

    render(<Editor />);

    const one = screen.getByRole('tab', { name: /one\.ts/i });
    const two = screen.getByRole('tab', { name: /two\.ts/i });
    const diff = screen.getByRole('tab', { name: /a\.ts.*diff/i });

    one.focus();
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    fireEvent.keyDown(two, { key: 'Enter' });
    expect(useIDEStore.getState().activeFileId).toBe('f2');

    two.focus();
    fireEvent.keyDown(two, { key: 'End' });
    fireEvent.keyDown(diff, { key: ' ' });
    expect(useGitStore.getState().diffFocused).toBe(true);
  });

  it('keeps every tab associated with the stable editor panel', () => {
    const spacedPath = '/repo/src/My File.ts';
    useIDEStore.setState({
      openFiles: [openFile(spacedPath, 'My File.ts'), openFile('f2', 'two.ts')],
      activeFileId: spacedPath,
    });
    useGitStore.setState({ diffSession: session, diffFocused: false });

    render(<Editor />);

    const panel = screen.getByRole('tabpanel');
    const tabs = screen.getAllByRole('tab');
    expect(panel).toHaveAttribute('id', 'editor-tabpanel');
    for (const tab of tabs) expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(tabs[0].id).not.toMatch(/\s/);
    expect(panel).toHaveAttribute('aria-labelledby', tabs[0].id);
    expect(document.getElementById(panel.getAttribute('aria-labelledby') ?? '')).toBe(tabs[0]);

    fireEvent.click(tabs[1]);
    expect(panel).toHaveAttribute('aria-labelledby', tabs[1].id);
  });

  it('keeps editor close buttons outside tab semantics', () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'one.ts')], activeFileId: 'f1' });
    useGitStore.setState({ diffSession: session, diffFocused: false });

    render(<Editor />);

    for (const close of screen.getAllByRole('button', { name: /close/i })) {
      expect(close.closest('[role="tab"]')).toBeNull();
    }
  });

  it('exposes the modified indicator to assistive tech', () => {
    useIDEStore.setState({
      openFiles: [{ ...openFile('f1', 'one.ts'), isModified: true }],
      activeFileId: 'f1',
    });

    render(<Editor />);

    const dot = screen.getByRole('img', { name: 'Modified' });
    expect(dot.closest('[role="tab"]')).not.toBeNull();
    // The indicator folds into the tab's accessible name rather than staying a silent glyph.
    expect(screen.getByRole('tab', { name: /one\.ts.*modified/i })).toBe(
      dot.closest('[role="tab"]')
    );
  });

  it('does not consume native keyboard events from close buttons', () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'one.ts')], activeFileId: 'f1' });

    render(<Editor />);

    const close = screen.getByRole('button', { name: 'Close one.ts' });
    const event = createEvent.keyDown(close, { key: ' ' });
    fireEvent(close, event);

    expect(event.defaultPrevented).toBe(false);
    expect(useIDEStore.getState().openFiles).toHaveLength(1);
  });

  it('moves focus to the selected file tab after a keyboard close', async () => {
    const user = userEvent.setup();
    useIDEStore.setState({
      openFiles: [openFile('f1', 'one.ts'), openFile('f2', 'two.ts')],
      activeFileId: 'f1',
    });

    render(<Editor />);

    const close = screen.getByRole('button', { name: 'Close one.ts' });
    close.focus();
    await user.keyboard(' ');

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Close one.ts' })).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /two\.ts/i })).toHaveFocus();
    });
  });

  it('moves focus to the selected file tab after closing a diff with Enter', async () => {
    const user = userEvent.setup();
    useIDEStore.setState({ openFiles: [openFile('f1', 'one.ts')], activeFileId: 'f1' });
    useGitStore.setState({ diffSession: session, diffFocused: true });

    render(<Editor />);

    const close = screen.getByRole('button', { name: 'Close diff' });
    close.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Close diff' })).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /one\.ts/i })).toHaveFocus();
    });
  });

  it('moves focus to main content after closing the last editor tab', async () => {
    const user = userEvent.setup();
    useIDEStore.setState({ openFiles: [openFile('f1', 'one.ts')], activeFileId: 'f1' });

    render(
      <main id="main-content" tabIndex={-1}>
        <Editor />
      </main>
    );

    const close = screen.getByRole('button', { name: 'Close one.ts' });
    close.focus();
    await user.keyboard(' ');

    await waitFor(() => expect(document.getElementById('main-content')).toHaveFocus());
  });
});

describe('Editor workspace tab accents', () => {
  const workspaces = [
    { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
    { id: 'root:go', name: 'Root Go', relDir: '', type: 'go', accent: 'terraform' },
    { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'web', accent: 'frontend' },
    { id: 'backend', name: 'Backend', relDir: 'backend', type: 'go', accent: 'go' },
    { id: 'api', name: 'API', relDir: 'backend/api', type: 'go', accent: 'python' },
  ] as workspace.WorkspaceDef[];

  it('resolves root, nested, boundary, and unrelated tabs independently of the active workspace', () => {
    useIDEStore.setState({
      workspaces,
      activeWorkspaceId: 'frontend',
      openFiles: [
        { ...openFile('f1', 'App.tsx'), path: '/repo/frontend/src/App.tsx' },
        { ...openFile('f2', 'root.go'), path: '/repo/root.go' },
        { ...openFile('f3', 'api.go'), path: '/repo/backend/api/api.go' },
        { ...openFile('f4', 'apiary.go'), path: '/repo/backend/apiary/apiary.go' },
        { ...openFile('f5', 'notes.md'), path: '/outside/notes.md' },
      ],
      activeFileId: 'f1',
    });

    render(<Editor />);

    expect(screen.getByRole('tab', { name: /App\.tsx/i }).parentElement).toHaveStyle(
      '--tab-accent: var(--accent-frontend)'
    );
    expect(screen.getByRole('tab', { name: /root\.go/i }).parentElement).toHaveStyle(
      '--tab-accent: var(--accent-terraform)'
    );
    expect(screen.getByRole('tab', { name: /api\.go/i }).parentElement).toHaveStyle(
      '--tab-accent: var(--accent-python)'
    );
    expect(screen.getByRole('tab', { name: /apiary\.go/i }).parentElement).toHaveStyle(
      '--tab-accent: var(--accent-go)'
    );
    expect(
      screen
        .getByRole('tab', { name: /notes\.md/i })
        .parentElement?.style.getPropertyValue('--tab-accent')
    ).toBe('');
  });

  it('colors a diff tab with its file workspace rather than the active workspace', () => {
    useIDEStore.setState({ workspaces, activeWorkspaceId: 'frontend' });
    useGitStore.setState({
      diffSession: {
        ...session,
        path: 'backend/api/diff.go',
        absPath: '/repo/backend/api/diff.go',
      },
      diffFocused: true,
    });

    render(<Editor />);

    expect(screen.getByRole('tab', { name: /diff\.go.*diff/i }).parentElement).toHaveStyle(
      '--tab-accent: var(--accent-python)'
    );
  });

  it('falls back to the neutral project token for an accent without a CSS token', () => {
    useIDEStore.setState({
      workspaces: [
        { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
        { id: 'legacy', name: 'Legacy', relDir: 'legacy', type: 'web', accent: 'magenta' },
      ] as workspace.WorkspaceDef[],
      openFiles: [{ ...openFile('f1', 'old.ts'), path: '/repo/legacy/old.ts' }],
      activeFileId: 'f1',
    });

    render(<Editor />);

    const tab = screen.getByRole('tab', { name: /old\.ts/i });
    expect(tab.parentElement).toHaveStyle('--tab-accent: var(--accent-project)');
    expect(tab.parentElement?.className).toContain('workspaceTab');
  });
});

describe('Editor merge queue hand-off', () => {
  it('does not restore fallback focus during the gap between queued files', async () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'other.ts')], activeFileId: 'f1' });
    useGitStore.setState({ mergeSession, mergeFocused: true });
    render(<Editor />);
    const fileTab = screen.getByRole('tab', { name: /other\.ts/i });
    fileTab.blur();

    // The finalized session closes and the next one is still opening.
    act(() => {
      useGitStore.setState({ mergeSession: null, mergeFocused: false, mergeAdvancePending: true });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    // Focus must not bounce to the file tab mid-hand-off.
    expect(fileTab).not.toHaveFocus();

    act(() => {
      useGitStore.setState({
        mergeSession: { ...mergeSession, path: 'next.go' } as unknown as MergeSession,
        mergeFocused: true,
        mergeAdvancePending: false,
      });
    });
    expect(screen.getByRole('tab', { name: /next\.go.*merge/i })).toBeInTheDocument();
  });

  it('restores fallback focus when the next queued file fails to open', async () => {
    useIDEStore.setState({ openFiles: [openFile('f1', 'other.ts')], activeFileId: 'f1' });
    useGitStore.setState({ mergeSession, mergeFocused: true });
    render(<Editor />);
    const fileTab = screen.getByRole('tab', { name: /other\.ts/i });
    fileTab.blur();

    act(() => {
      useGitStore.setState({ mergeSession: null, mergeFocused: false, mergeAdvancePending: true });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(fileTab).not.toHaveFocus();

    act(() => {
      useGitStore.setState({ mergeAdvancePending: false });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    expect(fileTab).toHaveFocus();
  });

  it('keeps a polite announcement region mounted outside the merge view', () => {
    useGitStore.setState({
      mergeSession,
      mergeFocused: true,
      mergeQueueAnnouncement: 'Now resolving next.go. 2 conflicted files remaining.',
    });
    render(<Editor />);

    const region = screen.getByTestId('merge-queue-announcement');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Now resolving next.go. 2 conflicted files remaining.');
  });

  it('still shows the announcement while the next surface is opening', () => {
    useGitStore.setState({
      mergeSession: null,
      mergeFocused: false,
      mergeAdvancePending: true,
      mergeQueueAnnouncement: 'Now resolving next.go. 1 conflicted file remaining.',
    });
    useIDEStore.setState({ openFiles: [openFile('f1', 'other.ts')], activeFileId: 'f1' });
    render(<Editor />);

    // The region does not live inside the merge view, so the gap cannot hide it.
    expect(screen.getByTestId('merge-queue-announcement')).toHaveTextContent(
      'Now resolving next.go. 1 conflicted file remaining.'
    );
  });
});
