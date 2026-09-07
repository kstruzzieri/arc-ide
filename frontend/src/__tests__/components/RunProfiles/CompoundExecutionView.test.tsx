import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompoundExecutionView } from '../../../components/RunProfiles/CompoundExecutionView';
import { useIDEStore } from '../../../stores/ideStore';
import type {
  CompoundRun,
  CompoundStep,
  CompoundStepState,
  OutputEntry,
} from '../../../types/runOutput';

jest.mock('../../../components/RunOutput/MergedView', () => ({
  MergedView: ({ entries, workingDir }: { entries: { text: string }[]; workingDir?: string }) => (
    <div data-testid="merged" data-workingdir={workingDir}>
      {entries.map((e, i) => (
        <span key={i}>{e.text}</span>
      ))}
    </div>
  ),
}));

jest.mock('../../../components/RunOutput/SourceTimelineView', () => ({
  SourceTimelineView: ({ sources }: { sources: { label: string }[] }) => (
    <div data-testid="timeline">
      {sources.map((s, i) => (
        <span key={i}>{s.label}</span>
      ))}
    </div>
  ),
}));

const stopMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../wails/bindings', () => ({
  StopRunProfile: (id: string) => stopMock(id),
}));

function entry(text: string, ts = 1): OutputEntry {
  return { stream: 'stdout', text, timestamp: ts };
}

function makeStep(overrides: Partial<CompoundStep> & { idx: number }): CompoundStep {
  return {
    runInstanceId: `step-r${overrides.idx}`,
    profileId: `p${overrides.idx}`,
    name: `Step ${overrides.idx}`,
    state: 'pending',
    exitCode: 0,
    workingDir: `dir${overrides.idx}`,
    durationMs: 0,
    ...overrides,
  };
}

function makeCompound(overrides: Partial<CompoundRun> = {}): CompoundRun {
  return {
    runInstanceId: 'r1',
    compoundId: 'compound-1',
    name: 'Build & Deploy',
    state: 'running',
    currentStep: 0,
    steps: [makeStep({ idx: 0 })],
    stepOutputs: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  stopMock.mockResolvedValue(undefined);
  useIDEStore.setState(useIDEStore.getInitialState());
  useIDEStore.setState({ workspace: { name: 'Repo', path: '/repo' } });
});

describe('CompoundExecutionView', () => {
  it('renders all six step states distinctly', () => {
    const states: CompoundStepState[] = [
      'pending',
      'running',
      'success',
      'failed',
      'skipped',
      'stopped',
    ];
    const steps = states.map((state, idx) => makeStep({ idx, state }));
    const compound = makeCompound({ state: 'running', steps });

    render(<CompoundExecutionView compound={compound} />);

    for (const state of states) {
      expect(document.querySelector(`[data-state="${state}"]`)).toBeInTheDocument();
    }
  });

  it('auto-selects the running stage on mount', () => {
    const steps = [
      makeStep({ idx: 0, state: 'success' }),
      makeStep({ idx: 1, state: 'running' }),
      makeStep({ idx: 2, state: 'pending' }),
    ];
    const compound = makeCompound({
      state: 'running',
      currentStep: 1,
      steps,
      stepOutputs: {
        0: [entry('step zero output')],
        1: [entry('step one output')],
      },
    });

    render(<CompoundExecutionView compound={compound} />);

    const merged = screen.getByTestId('merged');
    expect(merged).toHaveTextContent('step one output');
    expect(merged).not.toHaveTextContent('step zero output');
  });

  it('auto-selects the failed stage when aggregate state is failed', () => {
    const steps = [
      makeStep({ idx: 0, state: 'success' }),
      makeStep({ idx: 1, state: 'failed' }),
      makeStep({ idx: 2, state: 'skipped' }),
    ];
    const compound = makeCompound({
      state: 'failed',
      currentStep: 1,
      steps,
      stepOutputs: {
        0: [entry('step zero output')],
        1: [entry('step one failure')],
      },
    });

    render(<CompoundExecutionView compound={compound} />);

    const merged = screen.getByTestId('merged');
    expect(merged).toHaveTextContent('step one failure');
  });

  it('passes the selected step working directory to MergedView', () => {
    const steps = [
      makeStep({ idx: 0, state: 'success', workingDir: 'frontend' }),
      makeStep({ idx: 1, state: 'running', workingDir: 'backend' }),
    ];
    const compound = makeCompound({
      state: 'running',
      currentStep: 1,
      steps,
      stepOutputs: { 1: [entry('running output')] },
    });

    render(<CompoundExecutionView compound={compound} />);

    expect(screen.getByTestId('merged')).toHaveAttribute('data-workingdir', 'backend');
  });

  it('renders the All steps tab using step labels', () => {
    const steps = [
      makeStep({ idx: 0, state: 'success', name: 'Lint' }),
      makeStep({ idx: 1, state: 'running', name: 'Test' }),
    ];
    const compound = makeCompound({
      state: 'running',
      steps,
      stepOutputs: { 0: [entry('lint output')], 1: [entry('test output')] },
    });

    render(<CompoundExecutionView compound={compound} />);

    fireEvent.click(screen.getByRole('tab', { name: /all steps/i }));

    const timeline = screen.getByTestId('timeline');
    expect(timeline).toHaveTextContent('Lint');
    expect(timeline).toHaveTextContent('Test');
  });

  it('marks the selected internal tab with aria-selected', () => {
    render(<CompoundExecutionView compound={makeCompound()} />);

    const stages = screen.getByRole('tab', { name: /stages/i });
    const allSteps = screen.getByRole('tab', { name: /all steps/i });

    expect(stages).toHaveAttribute('aria-selected', 'true');
    expect(allSteps).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(allSteps);

    expect(stages).toHaveAttribute('aria-selected', 'false');
    expect(allSteps).toHaveAttribute('aria-selected', 'true');
  });

  it('uses one selected tab stop and moves focus without changing the view', () => {
    render(<CompoundExecutionView compound={makeCompound()} />);

    const stages = screen.getByRole('tab', { name: /stages/i });
    const allSteps = screen.getByRole('tab', { name: /all steps/i });
    expect([stages.tabIndex, allSteps.tabIndex]).toEqual([0, -1]);

    stages.focus();
    fireEvent.keyDown(stages, { key: 'ArrowRight' });
    expect(allSteps).toHaveFocus();
    expect(stages).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(allSteps, { key: 'ArrowLeft' });
    expect(stages).toHaveFocus();
    fireEvent.keyDown(stages, { key: 'ArrowLeft' });
    expect(allSteps).toHaveFocus();
    fireEvent.keyDown(allSteps, { key: 'ArrowRight' });
    expect(stages).toHaveFocus();
    fireEvent.keyDown(stages, { key: 'End' });
    expect(allSteps).toHaveFocus();
    fireEvent.keyDown(allSteps, { key: 'Home' });
    expect(stages).toHaveFocus();

    fireEvent.click(allSteps);
    expect([stages.tabIndex, allSteps.tabIndex]).toEqual([-1, 0]);
  });

  it('associates both tabs with the named compound-output panel', () => {
    render(<CompoundExecutionView compound={makeCompound()} />);

    const stages = screen.getByRole('tab', { name: /stages/i });
    const allSteps = screen.getByRole('tab', { name: /all steps/i });
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'compound-output-panel');
    expect(stages).toHaveAttribute('aria-controls', panel.id);
    expect(allSteps).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', stages.id);

    fireEvent.click(allSteps);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', allSteps.id);
  });

  it('lets the user select a stage by clicking its row', () => {
    const steps = [
      makeStep({ idx: 0, state: 'running', name: 'First' }),
      makeStep({ idx: 1, state: 'pending', name: 'Second' }),
    ];
    const compound = makeCompound({
      state: 'running',
      currentStep: 0,
      steps,
      stepOutputs: { 0: [entry('first output')], 1: [entry('second output')] },
    });

    render(<CompoundExecutionView compound={compound} />);
    expect(screen.getByTestId('merged')).toHaveTextContent('first output');

    fireEvent.click(screen.getByRole('button', { name: /Second/ }));
    expect(screen.getByTestId('merged')).toHaveTextContent('second output');
  });

  it('resets selected stage when the compound id changes', () => {
    const first = makeCompound({
      compoundId: 'ci',
      name: 'CI',
      state: 'running',
      currentStep: 1,
      steps: [
        makeStep({ idx: 0, state: 'success', name: 'Build' }),
        makeStep({ idx: 1, state: 'running', name: 'Test' }),
      ],
      stepOutputs: {
        0: [entry('build output')],
        1: [entry('test output')],
      },
    });
    const second = makeCompound({
      compoundId: 'deploy',
      name: 'Deploy',
      state: 'success',
      currentStep: 0,
      steps: [makeStep({ idx: 0, state: 'success', name: 'Deploy' })],
      stepOutputs: {
        0: [entry('deploy output')],
      },
    });

    const { rerender } = render(<CompoundExecutionView compound={first} />);
    expect(screen.getByTestId('merged')).toHaveTextContent('test output');

    rerender(<CompoundExecutionView compound={second} />);

    expect(screen.getByTestId('merged')).toHaveTextContent('deploy output');
  });

  it('shows the step error message when there is no output', () => {
    const steps = [
      makeStep({
        idx: 0,
        state: 'failed',
        errorMessage: 'process exited with code 1',
      }),
    ];
    const compound = makeCompound({ state: 'failed', steps, stepOutputs: {} });

    render(<CompoundExecutionView compound={compound} />);

    expect(screen.getByText('process exited with code 1')).toBeInTheDocument();
  });

  it('stops the compound via StopRunProfile with the compound id', () => {
    const compound = makeCompound({
      state: 'running',
      steps: [makeStep({ idx: 0, state: 'running' })],
    });

    render(<CompoundExecutionView compound={compound} />);

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(stopMock).toHaveBeenCalledWith('compound-1');
  });

  it('does not render the Stop button when the compound is not running', () => {
    const compound = makeCompound({
      state: 'success',
      steps: [makeStep({ idx: 0, state: 'success' })],
    });

    render(<CompoundExecutionView compound={compound} />);

    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('shows a toast when stopping the compound rejects', async () => {
    stopMock.mockRejectedValueOnce(new Error('boom'));
    const compound = makeCompound({
      state: 'running',
      steps: [makeStep({ idx: 0, state: 'running' })],
    });

    render(<CompoundExecutionView compound={compound} />);

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));

    await waitFor(() => {
      expect(useIDEStore.getState().toast).toEqual({
        message: 'Failed to stop "Build & Deploy": boom',
        type: 'error',
      });
    });
  });

  it('jumps to the failure using the stored failed reference', () => {
    const navigateMock = jest.fn();
    useIDEStore.setState({ requestEditorNavigation: navigateMock });

    const steps = [
      makeStep({ idx: 0, state: 'success' }),
      makeStep({ idx: 1, state: 'failed', workingDir: 'backend' }),
    ];
    const compound = makeCompound({
      state: 'failed',
      currentStep: 1,
      steps,
      stepOutputs: { 1: [entry('failure output')] },
      failedReference: { stepIdx: 1, path: 'src/main.go', line: 42, column: 7 },
    });

    render(<CompoundExecutionView compound={compound} />);

    fireEvent.click(screen.getByRole('button', { name: /jump to failure/i }));

    expect(navigateMock).toHaveBeenCalledWith('/repo/backend/src/main.go', 42, 7);
  });

  it('does not render the Jump to failure button without a failed reference', () => {
    const compound = makeCompound({
      state: 'failed',
      steps: [makeStep({ idx: 0, state: 'failed' })],
    });

    render(<CompoundExecutionView compound={compound} />);

    expect(screen.queryByRole('button', { name: /jump to failure/i })).not.toBeInTheDocument();
  });

  it('formats the compound ETA when present', () => {
    const compound = makeCompound({
      state: 'running',
      etaMs: 5000,
      steps: [makeStep({ idx: 0, state: 'running' })],
    });

    render(<CompoundExecutionView compound={compound} />);

    expect(screen.getByText('~5s')).toBeInTheDocument();
  });
});
