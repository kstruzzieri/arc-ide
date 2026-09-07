import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LSPSetupCard } from '../../../components/Editor/LSPSetupCard';
import { describeSetup } from '../../../components/Editor/lspSetupNotice';
import { useIDEStore } from '../../../stores/ideStore';
import type { LSPServerStatus } from '../../../stores/lspStore';

const mockRetry = jest.fn().mockResolvedValue(undefined);
const mockSetInterpreter = jest.fn().mockResolvedValue(undefined);
const mockClearInterpreter = jest.fn().mockResolvedValue(undefined);
const mockDoctor = jest.fn().mockResolvedValue({ family: 'python', candidates: ['/cand'] });

jest.mock('../../../wails/bindings', () => ({
  LSPRetryProvision: (...args: unknown[]) => mockRetry(...args),
  LSPSetInterpreter: (...args: unknown[]) => mockSetInterpreter(...args),
  LSPClearInterpreter: (...args: unknown[]) => mockClearInterpreter(...args),
  LSPDoctor: (...args: unknown[]) => mockDoctor(...args),
}));

function status(overrides: Partial<LSPServerStatus>): LSPServerStatus {
  return { family: 'python', workspace: '/proj', state: 'ready', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  useIDEStore.setState(useIDEStore.getInitialState());
  mockDoctor.mockResolvedValue({ family: 'python', candidates: ['/cand'] });
});

describe('describeSetup', () => {
  it('returns null when ready', () => {
    expect(describeSetup(status({ setupState: 'ready' }))).toBeNull();
  });

  it('returns null when setupState is absent', () => {
    expect(describeSetup(status({}))).toBeNull();
  });

  it('describes a missing interpreter with a venv hint', () => {
    const notice = describeSetup(status({ setupState: 'missing_interpreter' }));
    expect(notice).not.toBeNull();
    expect(notice!.tone).toBe('warning');
    expect(notice!.hint.toLowerCase()).toContain('venv');
  });

  it('describes a missing server as an error', () => {
    const notice = describeSetup(status({ setupState: 'missing_server' }));
    expect(notice!.tone).toBe('error');
  });

  it('shows a 0% download hint when provisionPct is zero', () => {
    const notice = describeSetup(status({ setupState: 'provisioning', provisionPct: 0 }));
    expect(notice!.hint).toContain('(0%)');
  });

  it('describes an active manual override when ready', () => {
    const notice = describeSetup(
      status({ setupState: 'ready', configSource: 'override', interpreterPath: '/manual/python' })
    );
    expect(notice).not.toBeNull();
    expect(notice!.tone).toBe('info');
    expect(notice!.message).toContain('/manual/python');
  });

  it('still returns null when ready without an override', () => {
    expect(describeSetup(status({ setupState: 'ready', configSource: 'detected' }))).toBeNull();
  });

  it('uses ASCII ellipsis in the provisioning message', () => {
    const notice = describeSetup(status({ setupState: 'provisioning' }));
    expect(notice!.message).toContain('...');
    expect(notice!.message).not.toContain('…');
  });
});

describe('LSPSetupCard', () => {
  it('renders nothing when ready', () => {
    const { container } = render(
      <LSPSetupCard status={status({ setupState: 'ready' })} workspacePath="/proj" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the message and hint for missing_interpreter', () => {
    render(
      <LSPSetupCard status={status({ setupState: 'missing_interpreter' })} workspacePath="/proj" />
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/no python interpreter/i)).toBeInTheDocument();
  });

  it('offline status renders Retry wired to LSPRetryProvision with the status project root', async () => {
    const user = userEvent.setup();
    render(
      <LSPSetupCard
        status={status({
          setupState: 'offline',
          action: 'retry',
          projectRoot: '/proj/services/api',
        })}
        workspacePath="/proj"
      />
    );
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(mockRetry).toHaveBeenCalledWith('python', '/proj/services/api');
  });

  it('Retry falls back to the workspace path when the status has no project root', async () => {
    const user = userEvent.setup();
    render(
      <LSPSetupCard
        status={status({ setupState: 'offline', action: 'retry' })}
        workspacePath="/proj"
      />
    );
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(mockRetry).toHaveBeenCalledWith('python', '/proj');
  });

  it('reports Retry failures', async () => {
    mockRetry.mockRejectedValueOnce(new Error('network unavailable'));
    const user = userEvent.setup();
    render(
      <LSPSetupCard
        status={status({ setupState: 'offline', action: 'retry' })}
        workspacePath="/proj"
      />
    );
    await user.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() =>
      expect(useIDEStore.getState().toast).toEqual({
        message: 'Failed to retry LSP provisioning: network unavailable',
        type: 'error',
      })
    );
  });

  it('provisioning shows progress and no Retry button', () => {
    render(
      <LSPSetupCard
        status={status({ setupState: 'provisioning', provisionPct: 25 })}
        workspacePath="/proj"
      />
    );
    expect(screen.getByText(/25%/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('select_interpreter populates candidates from LSPDoctor and sets on choose', async () => {
    const user = userEvent.setup();
    render(
      <LSPSetupCard
        status={status({ setupState: 'missing_interpreter', action: 'select_interpreter' })}
        workspacePath="/proj"
      />
    );
    const option = await screen.findByRole('option', { name: '/cand' });
    expect(option).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole('combobox', { name: /select interpreter/i }),
      '/cand'
    );
    expect(mockSetInterpreter).toHaveBeenCalledWith('/proj', '/cand');
  });

  it('ready with an active override renders Reset to auto wired to clear', async () => {
    const user = userEvent.setup();
    render(
      <LSPSetupCard
        status={status({
          setupState: 'ready',
          configSource: 'override',
          interpreterPath: '/manual/python',
        })}
        workspacePath="/proj"
      />
    );
    await user.click(screen.getByRole('button', { name: /reset to auto/i }));
    expect(mockClearInterpreter).toHaveBeenCalledWith('/proj');
  });

  it('reports Reset-to-auto failures', async () => {
    mockClearInterpreter.mockRejectedValueOnce(new Error('workspace write failed'));
    const user = userEvent.setup();
    render(
      <LSPSetupCard
        status={status({ setupState: 'ready', configSource: 'override' })}
        workspacePath="/proj"
      />
    );
    await user.click(screen.getByRole('button', { name: /reset to auto/i }));
    await waitFor(() =>
      expect(useIDEStore.getState().toast).toEqual({
        message: 'Failed to reset the Python interpreter: workspace write failed',
        type: 'error',
      })
    );
  });

  it('renders Reset to auto when an interpreter override is active', async () => {
    const user = userEvent.setup();
    render(
      <LSPSetupCard
        status={status({ setupState: 'config_degraded', configSource: 'override' })}
        workspacePath="/proj"
      />
    );
    await user.click(screen.getByRole('button', { name: /reset to auto/i }));
    expect(mockClearInterpreter).toHaveBeenCalledWith('/proj');
  });
});
