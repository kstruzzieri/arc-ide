import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunProfiles } from '../../components/RunProfiles/RunProfiles';
import { useIDEStore } from '../../stores/ideStore';
import type { RunProfile, RunProfileUIState } from '../../types/runProfile';
import type { RunOutput } from '../../types/runOutput';

const mockStartProfile = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockStopProfile = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockRestartProfile = jest.fn<Promise<void>, [string]>(() => Promise.resolve());

jest.mock('../../wails/bindings', () => ({
  StartRunProfile: (id: string) => mockStartProfile(id),
  StopRunProfile: (id: string) => mockStopProfile(id),
  RestartRunProfile: (id: string) => mockRestartProfile(id),
  PinRunProfile: jest.fn(() => Promise.resolve()),
  UnpinRunProfile: jest.fn(() => Promise.resolve()),
  SetActiveVariant: jest.fn(() => Promise.resolve()),
  AdoptRunProfile: jest.fn(() => Promise.resolve()),
  UnadoptRunProfile: jest.fn(() => Promise.resolve()),
}));

const WS = 'frontend';

// One profile per section, all scoped to the same workspace so the
// workspace-view grouping resolves them into Working Set / Pinned / Recent / Detected.
const activatedProfile: RunProfile = {
  id: 'activated-1',
  name: 'Build',
  type: 'single',
  source: 'detected',
  command: 'npm run build',
  workspaceId: WS,
  workspaceName: 'Frontend',
};
const pinnedProfile: RunProfile = {
  id: 'pinned-1',
  name: 'Dev',
  type: 'single',
  source: 'user',
  command: 'npm run dev',
  workspaceId: WS,
  workspaceName: 'Frontend',
};
const recentProfile: RunProfile = {
  id: 'recent-1',
  name: 'Test',
  type: 'single',
  source: 'detected',
  command: 'npm test',
  workspaceId: WS,
  workspaceName: 'Frontend',
};
const detectedProfile: RunProfile = {
  id: 'detected-1',
  name: 'Lint',
  type: 'single',
  source: 'detected',
  command: 'npm run lint',
  workspaceId: WS,
  workspaceName: 'Frontend',
};

const allProfiles = [activatedProfile, pinnedProfile, recentProfile, detectedProfile];

const profileState: Record<string, RunProfileUIState> = {
  // adopted detected -> activated (Working Set)
  [activatedProfile.id]: { adopted: true, lastRunAt: 1000 },
  // non-adopted detected with lastRunAt > 0 -> recent
  [recentProfile.id]: { lastRunAt: 500 },
  // detectedProfile has no lastRunAt -> detected
};

function makeRunOutput(
  profileId: string,
  state: RunOutput['state'],
  runInstanceId = 'r1',
  launchSeq = 1,
  text?: string
): RunOutput {
  return {
    runInstanceId,
    profileId,
    state,
    exitCode: 0,
    entries: text == null ? [] : [{ stream: 'stdout', text, timestamp: launchSeq }],
    launchSeq,
    workspaceEpoch: 1,
  } as RunOutput;
}

const setPhase2BState = (patch: Partial<ReturnType<typeof useIDEStore.getState>>) => {
  useIDEStore.setState(patch);
};

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState({
    runProfiles: allProfiles,
    runProfileState: profileState,
    activeWorkspaceId: WS, // workspace view
    runOutputs: {},
    runInstanceIdsByProfile: {},
    latestRunInstanceIdByProfile: {},
    runCompounds: {},
    compoundIdByRunInstance: {},
    runHistory: {},
    runStartTimestamps: {},
    hiddenProfileIds: [],
    stoppingProfileIds: [],
    restartingProfileIds: [],
    isLoadingProfiles: false,
    profilesError: null,
    toast: null,
  });
  // Form state persists across tests in the singleton store; reset it so a
  // leaked open-form from one test doesn't render over the list in the next.
  useIDEStore.getState().closeRunProfileForm();
});

describe('RunProfiles panel grouping (workspace view)', () => {
  it('renders all four section labels', () => {
    render(<RunProfiles />);

    expect(screen.getByText('Working Set')).toBeInTheDocument();
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText('Detected')).toBeInTheDocument();
  });
});

describe('RunProfiles panel header counter', () => {
  it('shows running and total counts scoped to the active workspace', () => {
    useIDEStore.setState({
      runOutputs: { r1: makeRunOutput(pinnedProfile.id, 'running') },
      runInstanceIdsByProfile: { [pinnedProfile.id]: ['r1'] },
      latestRunInstanceIdByProfile: { [pinnedProfile.id]: 'r1' },
    });

    render(<RunProfiles />);

    expect(screen.getByText(/1 running/i)).toBeInTheDocument();
    expect(screen.getByText(/\d+ total/i)).toBeInTheDocument();
  });

  it('counts running state from the explicit latest run instance', () => {
    useIDEStore.setState({
      runOutputs: {
        old: makeRunOutput(pinnedProfile.id, 'success'),
        live: { ...makeRunOutput(pinnedProfile.id, 'running'), runInstanceId: 'live' },
      },
      runInstanceIdsByProfile: { [pinnedProfile.id]: ['old', 'live'] },
      latestRunInstanceIdByProfile: { [pinnedProfile.id]: 'live' },
    });

    render(<RunProfiles />);

    expect(screen.getByText(/1 running/i)).toBeInTheDocument();
  });

  it('uses the newest live execution for a mixed live-and-failed profile card', () => {
    setPhase2BState({
      runProfiles: [pinnedProfile],
      runProfileState: {},
      runOutputs: {
        live: makeRunOutput(pinnedProfile.id, 'running', 'live', 10, 'live output'),
        failed: makeRunOutput(pinnedProfile.id, 'failed', 'failed', 11, 'failed output'),
      },
      runInstanceIdsByProfile: { [pinnedProfile.id]: ['live', 'failed'] },
      latestRunInstanceIdByProfile: { [pinnedProfile.id]: 'failed' },
      runLaunchSeqByInstance: { live: 10, failed: 11 },
      runStartTimestamps: { live: Date.now() - 1000 },
    });

    render(<RunProfiles />);

    expect(screen.getByText(/1 running/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Stop Dev' }).length).toBeGreaterThan(0);
    expect(screen.getByText('live output')).toBeInTheDocument();
    expect(screen.queryByText('failed output')).not.toBeInTheDocument();
  });

  it('offers Run another with one live plus one terminal execution and removes it at the two-live cap', () => {
    setPhase2BState({
      runProfiles: [pinnedProfile],
      runProfileState: {},
      runOutputs: {
        terminal: makeRunOutput(pinnedProfile.id, 'failed', 'terminal', 19),
        first: makeRunOutput(pinnedProfile.id, 'running', 'first', 20),
      },
      runInstanceIdsByProfile: { [pinnedProfile.id]: ['terminal', 'first'] },
      latestRunInstanceIdByProfile: { [pinnedProfile.id]: 'first' },
      runLaunchSeqByInstance: { terminal: 19, first: 20 },
      runStartTimestamps: { first: Date.now() - 1000 },
    });

    render(<RunProfiles />);

    const runAnother = screen.getByRole('button', { name: 'Run another Dev' });
    fireEvent.click(runAnother);
    expect(mockStartProfile).toHaveBeenCalledWith(pinnedProfile.id);

    act(() => {
      setPhase2BState({
        runOutputs: {
          first: makeRunOutput(pinnedProfile.id, 'running', 'first', 20),
          second: makeRunOutput(pinnedProfile.id, 'idle', 'second', 21),
        },
        runInstanceIdsByProfile: { [pinnedProfile.id]: ['first', 'second'] },
        latestRunInstanceIdByProfile: { [pinnedProfile.id]: 'second' },
        runLaunchSeqByInstance: { first: 20, second: 21 },
        runStartTimestamps: { first: Date.now() - 1000, second: Date.now() - 500 },
      });
    });

    expect(screen.queryByRole('button', { name: 'Run another Dev' })).not.toBeInTheDocument();
  });

  it('badges the card only once a profile has more than one live execution', () => {
    setPhase2BState({
      runProfiles: [pinnedProfile],
      runProfileState: {},
      runOutputs: {
        terminal: makeRunOutput(pinnedProfile.id, 'failed', 'terminal', 19),
        first: makeRunOutput(pinnedProfile.id, 'running', 'first', 20),
      },
      runInstanceIdsByProfile: { [pinnedProfile.id]: ['terminal', 'first'] },
      latestRunInstanceIdByProfile: { [pinnedProfile.id]: 'first' },
      runLaunchSeqByInstance: { terminal: 19, first: 20 },
      runStartTimestamps: { first: Date.now() - 1000 },
    });

    render(<RunProfiles />);

    // A retained terminal sibling is not a concurrent run, so no badge yet.
    expect(screen.queryByText('2 running')).not.toBeInTheDocument();

    act(() => {
      setPhase2BState({
        runOutputs: {
          first: makeRunOutput(pinnedProfile.id, 'running', 'first', 20),
          second: makeRunOutput(pinnedProfile.id, 'idle', 'second', 21),
        },
        runInstanceIdsByProfile: { [pinnedProfile.id]: ['first', 'second'] },
        latestRunInstanceIdByProfile: { [pinnedProfile.id]: 'second' },
        runLaunchSeqByInstance: { first: 20, second: 21 },
        runStartTimestamps: { first: Date.now() - 1000, second: Date.now() - 500 },
      });
    });

    // Both live: the card's status and Stop track only the newest, so the badge
    // is what tells the user a sibling survives a Stop.
    expect(screen.getByText('2 running')).toBeInTheDocument();

    act(() => {
      setPhase2BState({
        runOutputs: {
          first: makeRunOutput(pinnedProfile.id, 'stopped', 'first', 20),
          second: makeRunOutput(pinnedProfile.id, 'running', 'second', 21),
        },
      });
    });

    expect(screen.queryByText('2 running')).not.toBeInTheDocument();
  });

  it('counts a compound through its aggregate run instance without an ordinary output', () => {
    const compoundProfile: RunProfile = {
      id: 'ci',
      name: 'CI',
      type: 'compound',
      source: 'user',
      steps: [pinnedProfile.id],
      workspaceId: WS,
      workspaceName: 'Frontend',
    };
    useIDEStore.setState({
      runProfiles: [compoundProfile],
      latestRunInstanceIdByProfile: { ci: 'agg-r1' },
      runCompounds: {
        ci: {
          runInstanceId: 'agg-r1',
          compoundId: 'ci',
          name: 'CI',
          state: 'running',
          currentStep: 0,
          steps: [],
          stepOutputs: {},
        },
      },
      compoundIdByRunInstance: { 'agg-r1': 'ci' },
    });

    render(<RunProfiles />);

    expect(screen.getByText(/1 running/i)).toBeInTheDocument();
  });

  it('renders a failed compound card exit code from its aggregate run', () => {
    const compoundProfile: RunProfile = {
      id: 'ci',
      name: 'CI',
      type: 'compound',
      source: 'user',
      steps: [pinnedProfile.id],
      workspaceId: WS,
      workspaceName: 'Frontend',
    };
    useIDEStore.setState({
      runProfiles: [compoundProfile],
      runProfileState: { ci: { adopted: true } },
      latestRunInstanceIdByProfile: { ci: 'agg-r1' },
      runCompounds: {
        ci: {
          runInstanceId: 'agg-r1',
          compoundId: 'ci',
          name: 'CI',
          state: 'failed',
          exitCode: 3,
          currentStep: 0,
          steps: [],
          stepOutputs: {},
        },
      },
      compoundIdByRunInstance: { 'agg-r1': 'ci' },
      runHistory: { ci: [{ state: 'failed', duration: 1000, timestamp: 2000 }] },
    });

    render(<RunProfiles />);

    expect(screen.getByText('exit 3')).toBeInTheDocument();
  });

  it('shows the stopping UI (not "Restarting") when a live compound is stopped', () => {
    const compoundProfile: RunProfile = {
      id: 'ci',
      name: 'CI',
      type: 'compound',
      source: 'user',
      steps: [pinnedProfile.id],
      workspaceId: WS,
      workspaceName: 'Frontend',
    };
    useIDEStore.setState({
      runProfiles: [compoundProfile],
      runProfileState: { ci: { adopted: true } },
      latestRunInstanceIdByProfile: { ci: 'agg-r1' },
      runCompounds: {
        ci: {
          runInstanceId: 'agg-r1',
          compoundId: 'ci',
          name: 'CI',
          state: 'running',
          currentStep: 0,
          steps: [],
          stepOutputs: {},
        },
      },
      compoundIdByRunInstance: { 'agg-r1': 'ci' },
      stoppingProfileIds: ['ci'],
      stopRequestTimestamps: { ci: 1000 },
    });

    render(<RunProfiles />);

    // The real-stop path keys off the compound's live 'running' state, which is
    // only visible to the card because the aggregate run is synthesized into a
    // RunOutput. A regression would fall back to the restart indicator.
    expect(screen.queryByText(/Restarting/i)).not.toBeInTheDocument();
  });
});

// Profiles for project view: two workspaces, one with a detected profile.
const goDetectedProfile: RunProfile = {
  id: 'go-detected-1',
  name: 'Go Build',
  type: 'single',
  source: 'detected',
  command: 'go build ./...',
  workspaceId: 'go',
  workspaceName: 'Go',
};
const goUserProfile: RunProfile = {
  id: 'go-user-1',
  name: 'Go Test',
  type: 'single',
  source: 'user',
  command: 'go test ./...',
  workspaceId: 'go',
  workspaceName: 'Go',
};

describe('RunProfiles panel — project view', () => {
  beforeEach(() => {
    // Switching to project view: activeWorkspaceId === 'project'
    useIDEStore.setState({
      runProfiles: [pinnedProfile, detectedProfile, goUserProfile, goDetectedProfile],
      runProfileState: {
        // pinnedProfile is user-sourced with no state entry — lands in Pinned section
        // detectedProfile has no lastRunAt — stays in Detected section
        // goUserProfile: no state — Pinned (user source)
      },
      activeWorkspaceId: 'project',
      runOutputs: {},
      runHistory: {},
      runStartTimestamps: {},
      hiddenProfileIds: [],
      stoppingProfileIds: [],
      restartingProfileIds: [],
      isLoadingProfiles: false,
      profilesError: null,
      toast: null,
    });
  });

  it('renders both workspace names as group headers', () => {
    render(<RunProfiles />);
    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(screen.getByText('Go')).toBeInTheDocument();
  });

  it('renders the Detected section inside a <details> element', () => {
    const { container } = render(<RunProfiles />);
    // In project view, renderSection is called with collapseDetected=true,
    // so any group with key 'detected' renders as <details>.
    expect(container.querySelector('details')).toBeInTheDocument();
  });
});

describe('RunProfiles panel — empty state', () => {
  it('renders the empty-state hint when there are no profiles', () => {
    useIDEStore.setState({
      runProfiles: [],
      runProfileState: {},
      isLoadingProfiles: false,
      profilesError: null,
    });

    render(<RunProfiles />);

    expect(screen.getByText(/No profiles detected\./i)).toBeInTheDocument();
  });

  it('renders the empty-state hint in Workspace View when the active workspace has no profiles but another does', () => {
    // Active workspace ('frontend') owns zero profiles; another workspace ('go')
    // owns one. The view-aware gate must show the empty hint, not blank.
    useIDEStore.setState({
      runProfiles: [goDetectedProfile], // belongs to workspace 'go'
      runProfileState: {},
      activeWorkspaceId: WS, // workspace view, scoped to 'frontend' (empty)
      runOutputs: {},
      runHistory: {},
      runStartTimestamps: {},
      hiddenProfileIds: [],
      stoppingProfileIds: [],
      restartingProfileIds: [],
      isLoadingProfiles: false,
      profilesError: null,
      toast: null,
    });

    render(<RunProfiles />);

    expect(screen.getByText(/No profiles detected\./i)).toBeInTheDocument();
  });
});

test('marks the effective run target card as selected', () => {
  useIDEStore.setState({
    runProfiles: [{ id: 'p1', name: 'dev', type: 'single', source: 'user', workspaceId: WS }],
    runProfileState: {},
    hiddenProfileIds: [],
    activeWorkspaceId: WS,
    selectedProfileId: 'p1',
  });
  render(<RunProfiles />);
  expect(screen.getByRole('button', { name: /Run target: dev/i })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

describe('RunProfiles panel — create form', () => {
  it('opens the create form from the header + button', () => {
    render(<RunProfiles />);
    fireEvent.click(screen.getByRole('button', { name: /new profile/i }));
    expect(useIDEStore.getState().runProfileForm).toEqual({ mode: 'create' });
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
  });

  it('renders the form instead of the list when a form is active', () => {
    useIDEStore.getState().openRunProfileForm({ mode: 'create' });
    render(<RunProfiles />);
    expect(screen.queryByRole('button', { name: /new profile/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
  });
});

describe('RunProfiles panel — hidden section', () => {
  it('does not show hidden profiles from other workspaces in Workspace view', () => {
    useIDEStore.setState({
      runProfiles: [pinnedProfile, detectedProfile, goUserProfile],
      runProfileState: {},
      activeWorkspaceId: WS,
      hiddenProfileIds: [goUserProfile.id],
      runOutputs: {},
      runHistory: {},
      runStartTimestamps: {},
      stoppingProfileIds: [],
      restartingProfileIds: [],
      isLoadingProfiles: false,
      profilesError: null,
      toast: null,
    });

    render(<RunProfiles />);

    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    expect(screen.queryByText('Go Test')).not.toBeInTheDocument();
  });
});

describe('RunProfiles panel — view toggle', () => {
  it('renders a Workspace/Project segmented toggle and switching to Project drives setTreeViewMode', async () => {
    const user = userEvent.setup();
    // Provide a real non-project workspace so the Workspace segment is enabled
    // and setTreeViewMode('workspace') has a valid target.
    useIDEStore.setState({
      runProfiles: allProfiles,
      runProfileState: profileState,
      workspaces: [
        { id: 'project', name: 'Project', relDir: '', accent: 'project' },
        { id: WS, name: 'Frontend', relDir: 'frontend', accent: 'frontend' },
      ] as never,
      activeWorkspaceId: WS, // start in workspace view
      runOutputs: {},
      runHistory: {},
      runStartTimestamps: {},
      hiddenProfileIds: [],
      stoppingProfileIds: [],
      restartingProfileIds: [],
      isLoadingProfiles: false,
      profilesError: null,
      toast: null,
    });

    render(<RunProfiles />);

    const projectBtn = screen.getByRole('button', { name: 'Project' });
    const workspaceBtn = screen.getByRole('button', { name: 'Workspace' });
    expect(projectBtn).toBeInTheDocument();
    expect(workspaceBtn).toBeInTheDocument();
    // Currently in workspace view
    expect(workspaceBtn).toHaveAttribute('aria-pressed', 'true');
    expect(projectBtn).toHaveAttribute('aria-pressed', 'false');

    await user.click(projectBtn);

    // setTreeViewMode('project') sets activeWorkspaceId to 'project'
    expect(useIDEStore.getState().activeWorkspaceId).toBe('project');
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'true');
  });
});
