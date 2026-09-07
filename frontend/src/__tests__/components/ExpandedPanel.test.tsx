import { render, screen, fireEvent } from '@testing-library/react';
import { ExpandedPanel, getStopProgressPercent } from '../../components/RunProfiles/ExpandedPanel';
import type { RunProfile } from '../../types/runProfile';
import type { OutputEntry, RunHistoryEntry, RunOutput } from '../../types/runOutput';

const mockProfile: RunProfile = {
  id: 'test-1',
  name: 'go test',
  type: 'single',
  source: 'user',
  command: 'go test ./...',
  workingDir: '/tmp/project',
};

const noop = () => {};

function makeEntries(count: number): OutputEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    stream: 'stdout' as const,
    text: `line-${i}`,
    timestamp: 1,
  }));
}

function makeRunOutput(entries: OutputEntry[], state: RunOutput['state'] = 'success'): RunOutput {
  return {
    runInstanceId: 'r1',
    profileId: 'test-1',
    state,
    exitCode: 0,
    entries,
  };
}

function renderPanel({
  profile = mockProfile,
  visualState = 'idle',
  runHistory = [],
  runOutput,
  stopElapsedMs = 0,
  onFocusOutput = noop,
  onEdit,
}: {
  profile?: RunProfile;
  visualState?: 'idle' | 'running' | 'stopping' | 'failed' | 'success' | 'stopped';
  runHistory?: RunHistoryEntry[];
  runOutput?: RunOutput;
  stopElapsedMs?: number;
  onFocusOutput?: (profileId: string) => void;
  onEdit?: () => void;
} = {}) {
  return render(
    <ExpandedPanel
      profile={profile}
      visualState={visualState}
      runOutput={runOutput}
      runHistory={runHistory}
      elapsed={2000}
      stopElapsedMs={stopElapsedMs}
      onFocusOutput={onFocusOutput}
      onStart={noop}
      onStop={noop}
      onRestart={noop}
      onPin={noop}
      onUnpin={noop}
      onHide={noop}
      onEdit={onEdit}
    />
  );
}

describe('getStopProgressPercent', () => {
  it('returns 0 at start of grace period', () => {
    expect(getStopProgressPercent(0, 3000)).toBe(0);
  });

  it('returns 50 at midpoint', () => {
    expect(getStopProgressPercent(1500, 3000)).toBe(50);
  });

  it('caps at 100', () => {
    expect(getStopProgressPercent(5000, 3000)).toBe(100);
  });
});

describe('ExpandedPanel', () => {
  it('renders dormant copy for idle profiles with no history', () => {
    renderPanel();
    expect(screen.getByText('Never run — click play to start')).toBeInTheDocument();
  });

  it('preserves cancelled semantics for idle profiles whose last run was stopped', () => {
    renderPanel({
      runHistory: [{ state: 'stopped', duration: 1800, timestamp: Date.now() }],
    });
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('renders failed detail with exit code for failed state', () => {
    renderPanel({
      visualState: 'failed',
      runOutput: {
        runInstanceId: 'r1',
        profileId: 'test-1',
        state: 'failed',
        exitCode: 2,
        entries: [{ stream: 'stderr', text: 'boom', timestamp: Date.now() }],
      },
      runHistory: [{ state: 'failed', duration: 1800, timestamp: Date.now() }],
    });
    expect(screen.getByText('Exit 2')).toBeInTheDocument();
    expect(screen.getByText('Process failed')).toBeInTheDocument();
  });

  it('renders stopping progress from the real stop elapsed time', () => {
    renderPanel({
      visualState: 'stopping',
      stopElapsedMs: 1500,
      runOutput: {
        runInstanceId: 'r1',
        profileId: 'test-1',
        state: 'running',
        exitCode: 0,
        entries: [],
      },
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('force-kill in 2s')).toBeInTheDocument();
  });

  it('shows restarting indicator when stopping a non-running profile', () => {
    renderPanel({ visualState: 'stopping', stopElapsedMs: 0 });
    expect(screen.getByText(/Restarting/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('ExpandedPanel output preview', () => {
  const successHistory: RunHistoryEntry[] = [
    { state: 'success', duration: 1800, timestamp: Date.now() },
  ];

  it('opens the full output when the preview is clicked', () => {
    const onFocusOutput = jest.fn();
    renderPanel({
      visualState: 'success',
      runHistory: successHistory,
      runOutput: makeRunOutput(makeEntries(5)),
      onFocusOutput,
    });

    fireEvent.click(screen.getByRole('button', { name: /open full output/i }));

    expect(onFocusOutput).toHaveBeenCalledWith('test-1');
  });

  it('opens the full output via Enter and Space on the preview', () => {
    const onFocusOutput = jest.fn();
    renderPanel({
      visualState: 'success',
      runHistory: successHistory,
      runOutput: makeRunOutput(makeEntries(5)),
      onFocusOutput,
    });

    const preview = screen.getByRole('button', { name: /open full output/i });
    fireEvent.keyDown(preview, { key: 'Enter' });
    fireEvent.keyDown(preview, { key: ' ' });

    expect(onFocusOutput).toHaveBeenCalledTimes(2);
    expect(onFocusOutput).toHaveBeenNthCalledWith(1, 'test-1');
    expect(onFocusOutput).toHaveBeenNthCalledWith(2, 'test-1');
  });

  it('renders more than four preview lines when the output is long', () => {
    renderPanel({
      visualState: 'success',
      runHistory: successHistory,
      runOutput: makeRunOutput(makeEntries(10)),
    });

    // Old behaviour capped the tail at 4 lines, hiding the earliest output.
    expect(screen.getByText('line-0')).toBeInTheDocument();
    expect(screen.getByText('line-9')).toBeInTheDocument();
  });

  it('keeps a long preview scrolled to the newest output', () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight'
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 640,
    });

    try {
      renderPanel({
        visualState: 'success',
        runHistory: successHistory,
        runOutput: makeRunOutput(makeEntries(50)),
      });

      const preview = screen.getByRole('button', { name: /open full output/i });

      expect(preview.scrollTop).toBe(preview.scrollHeight);
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
      } else {
        delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      }
    }
  });

  it('does not render a clickable preview when there is no output', () => {
    renderPanel({ visualState: 'success', runHistory: successHistory });

    expect(screen.queryByRole('button', { name: /open full output/i })).toBeNull();
  });

  it('does not open output when the user is selecting text in the preview', () => {
    const onFocusOutput = jest.fn();
    const originalGetSelection = window.getSelection;
    window.getSelection = () => ({ toString: () => 'a copied error line' }) as unknown as Selection;

    try {
      renderPanel({
        visualState: 'success',
        runHistory: successHistory,
        runOutput: makeRunOutput(makeEntries(5)),
        onFocusOutput,
      });

      fireEvent.click(screen.getByRole('button', { name: /open full output/i }));

      expect(onFocusOutput).not.toHaveBeenCalled();
    } finally {
      window.getSelection = originalGetSelection;
    }
  });

  it('opens the full output when the failed-state preview is clicked', () => {
    const onFocusOutput = jest.fn();
    renderPanel({
      visualState: 'failed',
      runHistory: [{ state: 'failed', duration: 1800, timestamp: Date.now() }],
      runOutput: makeRunOutput(makeEntries(3), 'failed'),
      onFocusOutput,
    });

    fireEvent.click(screen.getByRole('button', { name: /open full output/i }));

    expect(onFocusOutput).toHaveBeenCalledWith('test-1');
  });
});

describe('ExpandedPanel edit action', () => {
  it('shows Edit for a user single profile and opens the edit form', () => {
    const onEdit = jest.fn();
    renderPanel({
      profile: { id: 'u1', name: 'Dev', type: 'single', source: 'user', command: 'npm run dev' },
      onEdit,
    });
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('labels the action "Customize" for a detected profile', () => {
    renderPanel({
      profile: {
        id: 'd1',
        name: 'npm run dev',
        type: 'single',
        source: 'detected',
        command: 'npm run dev',
      },
      onEdit: jest.fn(),
    });
    expect(screen.getByRole('button', { name: /customize/i })).toBeInTheDocument();
  });

  it('hides Edit/Customize for compound profiles', () => {
    renderPanel({
      profile: {
        id: 'c1',
        name: 'CI',
        type: 'compound',
        source: 'detected',
        steps: ['a'],
      } as RunProfile,
      onEdit: jest.fn(),
    });
    expect(screen.queryByRole('button', { name: /edit|customize/i })).not.toBeInTheDocument();
  });
});
