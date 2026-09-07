import { act, fireEvent, render, screen } from '@testing-library/react';
import { StatusBar } from '../../components/StatusBar';
import { useConflictProjectionSync } from '../../hooks/useProblemsProjection';
import { __resetGolemStore, useGolemStore } from '../../stores/golemStore';
import { useIDEStore } from '../../stores/ideStore';
import { useGitStore } from '../../stores/gitStore';
import { useLSPStore, type LSPDiagnostic } from '../../stores/lspStore';
import { parseGolemStatus } from '../../types/golem';
import { git } from '../../wails/bindings';

const mockGitConflictState = jest.fn();

jest.mock('../../wails/bindings', () => {
  const actual = jest.requireActual('../../wails/bindings');
  return {
    ...actual,
    GitConflictState: (...args: unknown[]) => mockGitConflictState(...args),
  };
});

jest.mock('../../wails/runtime', () => ({
  EventsOn: jest.fn(() => jest.fn()),
}));

/** The conflict-read effect lives at App level, always mounted; mirror that here. */
function StatusBarWithSync() {
  useConflictProjectionSync();
  return <StatusBar />;
}

function conflictRegion(index: number, hasBase = false) {
  return {
    index,
    startLine: index * 8 + 1,
    endLine: index * 8 + (hasBase ? 8 : 6),
    ours: ['ours'],
    base: hasBase ? ['base'] : [],
    theirs: ['theirs'],
    hasBase,
    oursLabel: 'HEAD',
    theirLabel: 'feature',
    baseEndsWithNewline: true,
    oursEndsWithNewline: true,
    theirsEndsWithNewline: true,
  };
}

function conflictState(path: string, regions: ReturnType<typeof conflictRegion>[]) {
  const stage = { hash: 'abc123', mode: '100644', size: 12 };
  return {
    stages: { path, base: stage, ours: stage, theirs: stage, binary: false },
    snapshot: {
      content: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n',
      encoding: 'utf-8',
      lineEndings: 'lf',
      regions,
    },
    heads: {
      operation: 'merge',
      ours: { label: 'main', hash: 'abc123', subject: 'main change' },
      theirs: { label: 'feature', hash: 'def456', subject: 'feature change' },
    },
    sourceVersion: `version:${path}`,
  };
}

function setGitStatus(
  repoRoot: string,
  files: Array<{ path: string; index: string; worktree: string; unmerged: boolean }>
) {
  useGitStore.setState({
    root: repoRoot,
    epoch: 1,
    statusRevision: 1,
    status: new git.RepoStatus({
      isRepo: true,
      repoRoot,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      files,
    }),
  });
}

function diagnostic(message: string, severity = 1): LSPDiagnostic {
  return {
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } },
    severity,
    source: 'gopls',
    message,
  };
}

describe('StatusBar diagnostics summary', () => {
  beforeEach(() => {
    __resetGolemStore();
    mockGitConflictState.mockReset();
    useIDEStore.setState(useIDEStore.getInitialState(), true);
    useGitStore.setState(useGitStore.getInitialState(), true);
    useLSPStore.setState(useLSPStore.getInitialState(), true);
  });

  afterEach(() => {
    act(() => {
      useIDEStore.setState(useIDEStore.getInitialState(), true);
      useGitStore.setState(useGitStore.getInitialState(), true);
      useLSPStore.setState(useLSPStore.getInitialState(), true);
    });
  });

  it('shows raw severity counts when no merge is active', () => {
    useLSPStore
      .getState()
      .setDiagnostics('file:///repo/a.go', [
        diagnostic('undefined: foo'),
        diagnostic('unused variable', 2),
        diagnostic('consider simplifying', 3),
      ]);

    render(<StatusBarWithSync />);

    expect(screen.getByText('1 error, 1 warning, 1 info')).toBeInTheDocument();
  });

  it('counts conflict regions as warnings and suppresses raw marker errors during a merge', async () => {
    mockGitConflictState.mockResolvedValue(
      conflictState('conflict.go', [
        conflictRegion(0),
        conflictRegion(1, true),
        conflictRegion(2),
        conflictRegion(3),
      ])
    );
    setGitStatus('/repo', [{ path: 'conflict.go', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore
      .getState()
      .setDiagnostics('file:///repo/conflict.go', [
        diagnostic('expected declaration'),
        diagnostic('expected semicolon'),
      ]);
    useLSPStore.getState().setDiagnostics('file:///repo/other.go', [diagnostic('undefined: bar')]);

    render(<StatusBarWithSync />);

    // 1 raw error from the clean file plus 4 conflict regions as warnings; the
    // conflicted file's 2 raw errors are suppressed, matching the Problems tab.
    expect(await screen.findByText('1 error, 4 warnings')).toBeInTheDocument();
    expect(screen.queryByText(/2 errors/)).not.toBeInTheDocument();
  });

  it('drops the conflict warnings when accepted status marks the file clean', async () => {
    mockGitConflictState.mockResolvedValue(conflictState('app.py', [conflictRegion(0)]));
    setGitStatus('/repo', [{ path: 'app.py', index: 'U', worktree: 'U', unmerged: true }]);
    useLSPStore
      .getState()
      .setDiagnostics('file:///repo/app.py', [diagnostic('Unexpected indentation')]);

    render(<StatusBarWithSync />);
    expect(await screen.findByText('1 warning')).toBeInTheDocument();

    act(() => {
      const status = useGitStore.getState().status!;
      useGitStore.setState((state) => ({
        status: new git.RepoStatus({
          ...status,
          files: [{ path: 'app.py', index: 'M', worktree: '.', unmerged: false }],
        }),
        statusRevision: state.statusRevision + 1,
      }));
    });

    expect(screen.getByText('1 error')).toBeInTheDocument();
  });
});

// ── Golem segment (#226 Task B8) ──────────────────────────────────────────────
// Always mounted: it is the only Golem surface that survives a collapsed right
// panel or Runs mode, so background activity has somewhere to be seen.

const GOLEM_EPOCH = 4;
const ENDPOINT = 'https://api.example.test/v1';

const golemIdentity = (workspaceId: string, conversationId: string) => ({
  repoEpoch: GOLEM_EPOCH,
  workspaceId,
  conversationId,
});

const golemRun = (
  workspaceId: string,
  conversationId: string,
  runId: string,
  state: 'running' | 'canceling',
  workspaceLabel: string
) => ({
  identity: { ...golemIdentity(workspaceId, conversationId), runId },
  workspaceLabel,
  state,
});

const hydrateGolem = (over: Record<string, unknown> = {}) => {
  act(() => {
    useGolemStore.getState().hydrateStatus(
      parseGolemStatus({
        available: true,
        workspaceLabel: 'Frontend',
        identity: golemIdentity('frontend', 'conv-frontend'),
        destination: {
          provider: 'anthropic',
          model: 'claude',
          endpoint: ENDPOINT,
          classification: 'remote',
          digest: 'd',
        },
        needsConsent: false,
        activeRuns: [],
        ...over,
      })
    );
  });
};

const golemSegment = () => screen.getByRole('button', { name: /^Golem:/ });

describe('StatusBar Golem segment', () => {
  beforeEach(() => {
    __resetGolemStore();
    mockGitConflictState.mockReset();
    useIDEStore.setState(useIDEStore.getInitialState(), true);
    useGitStore.setState(useGitStore.getInitialState(), true);
    useLSPStore.setState(useLSPStore.getInitialState(), true);
  });

  afterEach(() => {
    act(() => {
      __resetGolemStore();
      useIDEStore.setState(useIDEStore.getInitialState(), true);
      useGitStore.setState(useGitStore.getInitialState(), true);
      useLSPStore.setState(useLSPStore.getInitialState(), true);
    });
  });

  it('is mounted and idle before anything is hydrated', () => {
    render(<StatusBar />);

    expect(golemSegment()).toHaveTextContent('Golem: Idle');
  });

  it('stays mounted while the Golem island is a rail and the dock is collapsed', () => {
    useIDEStore.setState({ isRightPanelCollapsed: true, isGolemPanelCollapsed: true });
    render(<StatusBar />);

    expect(golemSegment()).toBeInTheDocument();
  });

  it('counts every live run across conversations', () => {
    render(<StatusBar />);
    hydrateGolem({
      activeRuns: [
        golemRun('frontend', 'conv-frontend', 'run-1', 'running', 'Frontend'),
        golemRun('infra', 'conv-infra', 'run-2', 'running', 'Infra'),
      ],
    });

    expect(golemSegment()).toHaveTextContent('Golem: 2 running');
  });

  it('uses the singular form for one run', () => {
    render(<StatusBar />);
    hydrateGolem({
      activeRuns: [golemRun('frontend', 'conv-frontend', 'run-1', 'running', 'Frontend')],
    });

    expect(golemSegment()).toHaveTextContent('Golem: 1 running');
  });

  it('counts a run still awaiting admission', () => {
    render(<StatusBar />);
    hydrateGolem({
      activeRuns: [golemRun('frontend', 'conv-frontend', 'run-1', 'running', 'Frontend')],
    });

    // The phase `submitTurn` leaves a turn in until the backend admits it: the
    // request is already gone, so the segment must not read Idle over it.
    act(() => {
      const { conversations } = useGolemStore.getState();
      const conversation = conversations['conv-frontend'];
      useGolemStore.setState({
        conversations: {
          ...conversations,
          'conv-frontend': {
            ...conversation,
            runs: { 'run-1': { ...conversation.runs['run-1'], phase: 'admitting' } },
          },
        },
      });
    });

    expect(golemSegment()).toHaveTextContent('Golem: 1 running');
  });

  it('reports approval needed and opens the conversation awaiting consent', () => {
    useIDEStore.setState({ isRightPanelCollapsed: true });
    render(<StatusBar />);
    hydrateGolem();
    hydrateGolem({
      identity: golemIdentity('backend', 'conv-backend'),
      workspaceLabel: 'Backend',
      activeRuns: [golemRun('backend', 'conv-backend', 'run-1', 'running', 'Backend')],
    });

    act(() => {
      const { conversations } = useGolemStore.getState();
      const conversation = conversations['conv-backend'];
      useGolemStore.setState({
        conversations: {
          ...conversations,
          'conv-backend': {
            ...conversation,
            runs: { 'run-1': { ...conversation.runs['run-1'], phase: 'needs-consent' } },
          },
        },
      });
    });

    expect(golemSegment()).toHaveTextContent('Golem: Approval needed');
    expect(golemSegment()).toHaveAttribute('data-golem-state', 'attention');

    fireEvent.click(golemSegment());

    expect(useGolemStore.getState().selectedConversationId).toBe('conv-backend');
    expect(useIDEStore.getState()).toMatchObject({
      centerReveal: 'golem',
      isGolemPanelCollapsed: false,
    });
  });

  it('prioritizes canceling, then approval, then running and routes each mixed state', () => {
    useIDEStore.setState({ isRightPanelCollapsed: true });
    render(<StatusBar />);
    hydrateGolem({
      activeRuns: [golemRun('frontend', 'conv-frontend', 'run-1', 'running', 'Frontend')],
    });
    hydrateGolem({
      identity: golemIdentity('backend', 'conv-backend'),
      workspaceLabel: 'Backend',
      activeRuns: [golemRun('backend', 'conv-backend', 'run-2', 'running', 'Backend')],
    });
    act(() => {
      const { conversations } = useGolemStore.getState();
      const backend = conversations['conv-backend'];
      useGolemStore.setState({
        conversations: {
          ...conversations,
          'conv-backend': {
            ...backend,
            runs: { 'run-2': { ...backend.runs['run-2'], phase: 'needs-consent' } },
          },
        },
      });
    });

    expect(golemSegment()).toHaveTextContent('Golem: Approval needed');
    fireEvent.click(golemSegment());
    expect(useGolemStore.getState().selectedConversationId).toBe('conv-backend');

    hydrateGolem({
      identity: golemIdentity('infra', 'conv-infra'),
      workspaceLabel: 'Infra',
      activeRuns: [golemRun('infra', 'conv-infra', 'run-3', 'canceling', 'Infra')],
    });

    expect(golemSegment()).toHaveTextContent('Golem: Canceling');
    fireEvent.click(golemSegment());
    expect(useGolemStore.getState().selectedConversationId).toBe('conv-infra');
  });

  it('ranks canceling above the running count', () => {
    render(<StatusBar />);
    hydrateGolem({
      activeRuns: [
        golemRun('frontend', 'conv-frontend', 'run-1', 'running', 'Frontend'),
        golemRun('infra', 'conv-infra', 'run-2', 'canceling', 'Infra'),
      ],
    });

    expect(golemSegment()).toHaveTextContent('Golem: Canceling');
  });

  it('reports attention for an unavailable workspace once nothing is running', () => {
    render(<StatusBar />);
    hydrateGolem({ available: false, initError: 'golem.yaml could not be read.' });

    expect(golemSegment()).toHaveTextContent('Golem: Attention');
  });

  it('reports attention when a background run dies with no request to retry', () => {
    render(<StatusBar />);
    hydrateGolem({
      activeRuns: [golemRun('frontend', 'conv-frontend', 'run-1', 'running', 'Frontend')],
    });
    expect(golemSegment()).toHaveTextContent('Golem: 1 running');

    act(() => {
      useGolemStore.getState().ingestRunStatus({
        identity: { ...golemIdentity('frontend', 'conv-frontend'), runId: 'run-1' },
        state: 'failed',
        message: 'the provider died',
      });
    });

    // The workspace is still available and the run was only ever known by
    // status, so it left no `lastFailedTurn` behind — the death is still the
    // one thing this segment exists to report.
    const conversation = useGolemStore.getState().conversations['conv-frontend'];
    expect(conversation.available).toBe(true);
    expect(conversation.lastFailedTurn).toBeNull();
    expect(golemSegment()).toHaveTextContent('Golem: Attention');
  });

  it('keeps reporting a conversation that still holds a failure after a later one recovers', () => {
    useIDEStore.setState({ isRightPanelCollapsed: true });
    render(<StatusBar />);
    hydrateGolem({
      activeRuns: [golemRun('frontend', 'conv-frontend', 'run-1', 'running', 'Frontend')],
    });
    act(() => {
      useGolemStore.getState().ingestRunStatus({
        identity: { ...golemIdentity('frontend', 'conv-frontend'), runId: 'run-1' },
        state: 'failed',
        message: 'the provider died',
      });
    });
    expect(golemSegment()).toHaveTextContent('Golem: Attention');

    // Backend fails after Frontend, then recovers completely.
    hydrateGolem({
      identity: golemIdentity('backend', 'conv-backend'),
      workspaceLabel: 'Backend',
      available: false,
    });
    hydrateGolem({
      identity: golemIdentity('backend', 'conv-backend'),
      workspaceLabel: 'Backend',
    });
    expect(useGolemStore.getState().lastFailureConversationId).toBe('conv-backend');
    expect(useGolemStore.getState().conversations['conv-backend'].available).toBe(true);

    // The newest failure is gone, but Frontend's dead run is not, and it is
    // still the only thing this segment exists to report.
    expect(golemSegment()).toHaveTextContent('Golem: Attention');

    fireEvent.click(golemSegment());

    expect(useGolemStore.getState().selectedConversationId).toBe('conv-frontend');
  });

  it('ranks a live run above a past failure', () => {
    render(<StatusBar />);
    hydrateGolem({
      available: false,
      identity: golemIdentity('backend', 'conv-backend'),
      workspaceLabel: 'Backend',
    });
    hydrateGolem({
      activeRuns: [golemRun('frontend', 'conv-frontend', 'run-1', 'running', 'Frontend')],
    });

    expect(golemSegment()).toHaveTextContent('Golem: 1 running');
  });

  it('opens the Golem panel on the active conversation', () => {
    useIDEStore.setState({ isRightPanelCollapsed: true });
    render(<StatusBar />);
    hydrateGolem({
      activeRuns: [golemRun('infra', 'conv-infra', 'run-2', 'running', 'Infra')],
    });

    fireEvent.click(golemSegment());

    expect(useIDEStore.getState()).toMatchObject({
      centerReveal: 'golem',
      isGolemPanelCollapsed: false,
    });
    expect(useGolemStore.getState().selectedConversationId).toBe('conv-infra');
  });

  it('opens the conversation the count is about, not the one that merely moved last', () => {
    useIDEStore.setState({ isRightPanelCollapsed: true });
    render(<StatusBar />);
    hydrateGolem();
    hydrateGolem({
      identity: golemIdentity('backend', 'conv-backend'),
      workspaceLabel: 'Backend',
      activeRuns: [golemRun('backend', 'conv-backend', 'run-1', 'running', 'Backend')],
    });
    hydrateGolem({
      activeRuns: [golemRun('frontend', 'conv-frontend', 'run-2', 'running', 'Frontend')],
    });

    // Frontend moved last, then its run ended: the count is Backend's.
    act(() => {
      useGolemStore.getState().ingestRunStatus({
        identity: { ...golemIdentity('frontend', 'conv-frontend'), runId: 'run-2' },
        state: 'canceled',
      });
    });
    expect(golemSegment()).toHaveTextContent('Golem: 1 running');

    fireEvent.click(golemSegment());

    expect(useGolemStore.getState().selectedConversationId).toBe('conv-backend');
  });

  it('opens the Golem panel on the failed conversation when nothing is running', () => {
    useIDEStore.setState({ isRightPanelCollapsed: true });
    render(<StatusBar />);
    hydrateGolem();
    hydrateGolem({
      available: false,
      identity: golemIdentity('backend', 'conv-backend'),
      workspaceLabel: 'Backend',
    });

    fireEvent.click(golemSegment());

    expect(useGolemStore.getState().selectedConversationId).toBe('conv-backend');
    // The dock is Runs' home now (#271): revealing the chat never touches it.
    expect(useIDEStore.getState().isRightPanelCollapsed).toBe(true);
  });

  it('opens the panel from idle without inventing a conversation', () => {
    useIDEStore.setState({ isRightPanelCollapsed: true });
    render(<StatusBar />);

    fireEvent.click(golemSegment());

    expect(useIDEStore.getState()).toMatchObject({
      centerReveal: 'golem',
      isGolemPanelCollapsed: false,
    });
    expect(useGolemStore.getState().selectedConversationId).toBeNull();
  });

  it('names the state in the accessible name and exposes no endpoint or conversation id', () => {
    render(<StatusBar />);
    hydrateGolem({
      activeRuns: [
        golemRun('frontend', 'conv-frontend', 'run-1', 'running', 'Frontend'),
        golemRun('infra', 'conv-infra', 'run-2', 'running', 'Infra'),
      ],
    });

    const name = golemSegment().getAttribute('aria-label') ?? '';
    expect(name).toContain('2 running');
    expect(name).not.toContain(ENDPOINT);
    expect(name).not.toContain('conv-frontend');
    expect(name).not.toContain('conv-infra');
  });
});
