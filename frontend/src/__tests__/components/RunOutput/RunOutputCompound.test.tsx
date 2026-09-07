import { fireEvent, render, screen } from '@testing-library/react';
import { RunOutputPanel } from '../../../components/RunOutput/RunOutputPanel';
import { RunOutputToolbar } from '../../../components/RunOutput/RunOutputToolbar';
import { RunOutputTabs } from '../../../components/RunOutput/RunOutputTabs';
import { useIDEStore } from '../../../stores/ideStore';
import type { CompoundRun, RunOutput } from '../../../types/runOutput';

// --- Mocks -----------------------------------------------------------------

const mockStop = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockRestart = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
jest.mock('../../../wails/bindings', () => ({
  StopRunProfile: (id: string) => mockStop(id),
  RestartRunProfile: (id: string) => mockRestart(id),
}));

jest.mock('../../../components/RunProfiles/CompoundExecutionView', () => ({
  CompoundExecutionView: ({ compound }: { compound: { compoundId: string } }) => (
    <div data-testid="compound-view">{compound.compoundId}</div>
  ),
}));

// Stub the heavy ordinary views so panel render stays focused.
jest.mock('../../../components/RunOutput/MergedView', () => ({
  MergedView: () => <div data-testid="merged-view" />,
}));
jest.mock('../../../components/RunOutput/LanesView', () => ({
  LanesView: () => <div data-testid="lanes-view" />,
}));
jest.mock('../../../components/RunOutput/DiffView', () => ({
  DiffView: () => <div data-testid="diff-view" />,
}));
jest.mock('../../../components/RunOutput/TimelineView', () => ({
  TimelineView: () => <div data-testid="timeline-view" />,
}));

// --- Fixtures --------------------------------------------------------------

function makeCompound(overrides: Partial<CompoundRun> = {}): CompoundRun {
  return {
    runInstanceId: 'r1',
    compoundId: 'ci',
    name: 'CI',
    state: 'running',
    currentStep: 0,
    steps: [],
    stepOutputs: {},
    ...overrides,
  };
}

function makeRunOutput(overrides: Partial<RunOutput> = {}): RunOutput {
  return {
    runInstanceId: 'r1',
    profileId: 'p1',
    state: 'running',
    exitCode: 0,
    entries: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState(useIDEStore.getInitialState());
  useIDEStore.setState({ workspace: { name: 'Repo', path: '/repo' } });
});

// --- Panel -----------------------------------------------------------------

describe('RunOutputPanel compound rendering', () => {
  it('renders CompoundExecutionView when the active id is a compound id', () => {
    useIDEStore.setState({
      runOutputs: {},
      runCompounds: { ci: makeCompound() },
      compoundIdByRunInstance: { r1: 'ci' },
      activeRunOutputId: 'r1',
    });

    render(<RunOutputPanel />);

    expect(screen.getByTestId('compound-view')).toHaveTextContent('ci');
  });

  it('renders the compound view even when view mode is timeline', () => {
    useIDEStore.setState({
      runOutputs: {},
      runCompounds: { ci: makeCompound() },
      compoundIdByRunInstance: { r1: 'ci' },
      activeRunOutputId: 'r1',
      runOutputViewMode: 'timeline',
    });

    render(<RunOutputPanel />);

    expect(screen.getByTestId('compound-view')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-view')).not.toBeInTheDocument();
  });

  it('renders ordinary views (not compound) for a plain run output', () => {
    useIDEStore.setState({
      runOutputs: { r1: makeRunOutput() },
      runInstanceIdsByProfile: { p1: ['r1'] },
      latestRunInstanceIdByProfile: { p1: 'r1' },
      runCompounds: {},
      activeRunOutputId: 'r1',
      runOutputViewMode: 'merged',
    });

    render(<RunOutputPanel />);

    expect(screen.queryByTestId('compound-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('merged-view')).toBeInTheDocument();
  });
});

// --- Toolbar ---------------------------------------------------------------

describe('RunOutputToolbar compound controls', () => {
  it('calls clearCompoundRunOutput with the compound id on Clear', () => {
    const clearCompoundRunOutput = jest.fn();
    useIDEStore.setState({
      runOutputs: {},
      runCompounds: { ci: makeCompound() },
      compoundIdByRunInstance: { r1: 'ci' },
      activeRunOutputId: 'r1',
      clearCompoundRunOutput,
    });

    render(<RunOutputToolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear output' }));

    expect(clearCompoundRunOutput).toHaveBeenCalledWith('ci');
  });

  it('stops a running compound via the compound id', () => {
    useIDEStore.setState({
      runOutputs: {},
      runCompounds: { ci: makeCompound({ state: 'running' }) },
      compoundIdByRunInstance: { r1: 'ci' },
      activeRunOutputId: 'r1',
    });

    render(<RunOutputToolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Stop profile' }));

    expect(mockStop).toHaveBeenCalledWith('ci');
  });

  it('re-runs a compound via the compound id', () => {
    useIDEStore.setState({
      runOutputs: {},
      runCompounds: { ci: makeCompound({ state: 'failed' }) },
      compoundIdByRunInstance: { r1: 'ci' },
      activeRunOutputId: 'r1',
    });

    render(<RunOutputToolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Re-run profile' }));

    expect(mockRestart).toHaveBeenCalledWith('ci');
  });

  it('hides the view-mode group when a compound is active', () => {
    useIDEStore.setState({
      runOutputs: {},
      runCompounds: { ci: makeCompound() },
      compoundIdByRunInstance: { r1: 'ci' },
      activeRunOutputId: 'r1',
    });

    render(<RunOutputToolbar />);

    expect(screen.queryByRole('button', { name: 'Merged' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Timeline' })).not.toBeInTheDocument();
    // Action controls remain available.
    expect(screen.getByRole('button', { name: 'Clear output' })).toBeInTheDocument();
  });

  it('shows the view-mode group for an ordinary active output', () => {
    useIDEStore.setState({
      runOutputs: { r1: makeRunOutput() },
      runInstanceIdsByProfile: { p1: ['r1'] },
      latestRunInstanceIdByProfile: { p1: 'r1' },
      runCompounds: {},
      activeRunOutputId: 'r1',
    });

    render(<RunOutputToolbar />);

    expect(screen.getByRole('button', { name: 'Merged' })).toBeInTheDocument();
  });

  it('disables Timeline with one ordinary output alongside a compound', () => {
    useIDEStore.setState({
      runOutputs: { r1: makeRunOutput({ runInstanceId: 'r1', profileId: 'p1' }) },
      runInstanceIdsByProfile: { p1: ['r1'] },
      latestRunInstanceIdByProfile: { p1: 'r1' },
      runCompounds: {
        ci: makeCompound({ runInstanceId: 'agg-r1', compoundId: 'ci', name: 'CI' }),
      },
      compoundIdByRunInstance: { 'agg-r1': 'ci' },
      activeRunOutputId: 'r1',
    });

    render(<RunOutputToolbar />);

    expect(screen.getByRole('button', { name: 'Timeline' })).toBeDisabled();
  });
});

// --- Tabs ------------------------------------------------------------------

describe('RunOutputTabs compound tabs', () => {
  it('renders a tab for a compound that has no ordinary output', () => {
    useIDEStore.setState({
      runOutputs: {},
      runCompounds: { ci: makeCompound({ name: 'CI' }) },
      compoundIdByRunInstance: { r1: 'ci' },
      activeRunOutputId: 'r1',
    });

    render(<RunOutputTabs />);

    expect(screen.getByText('CI')).toBeInTheDocument();
  });

  it('does not render the All timeline tab for compounds only', () => {
    useIDEStore.setState({
      runOutputs: {},
      runCompounds: {
        ci: makeCompound({ runInstanceId: 'r1', compoundId: 'ci', name: 'CI' }),
        deploy: makeCompound({ runInstanceId: 'r2', compoundId: 'deploy', name: 'Deploy' }),
      },
      compoundIdByRunInstance: { r1: 'ci', r2: 'deploy' },
      activeRunOutputId: 'r1',
    });

    render(<RunOutputTabs />);

    expect(screen.queryByText('All')).not.toBeInTheDocument();
  });

  it('renders the All timeline tab when 2+ ordinary outputs exist', () => {
    useIDEStore.setState({
      runOutputs: {
        r1: makeRunOutput({ runInstanceId: 'r1', profileId: 'p1' }),
        r2: makeRunOutput({ runInstanceId: 'r2', profileId: 'p2' }),
      },
      runInstanceIdsByProfile: { p1: ['r1'], p2: ['r2'] },
      latestRunInstanceIdByProfile: { p1: 'r1', p2: 'r2' },
      runCompounds: {},
      activeRunOutputId: 'r1',
    });

    render(<RunOutputTabs />);

    expect(screen.getByText('All')).toBeInTheDocument();
  });

  it('keeps compound storage separate from the ordinary timeline count', () => {
    useIDEStore.setState({
      runOutputs: { ordinary: makeRunOutput({ runInstanceId: 'ordinary', profileId: 'p1' }) },
      runInstanceIdsByProfile: { p1: ['ordinary'] },
      latestRunInstanceIdByProfile: { p1: 'ordinary' },
      runCompounds: { ci: makeCompound({ compoundId: 'ci', name: 'CI' }) },
      compoundIdByRunInstance: { r1: 'ci' },
      activeRunOutputId: 'ordinary',
    });

    render(<RunOutputTabs />);

    expect(screen.queryByText('All')).not.toBeInTheDocument();
    expect(screen.getAllByText('CI')).toHaveLength(1);
    expect(screen.getByText('p1')).toBeInTheDocument();
  });
});
