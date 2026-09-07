jest.mock('../../wails/bindings', () => ({
  GitStatus: jest.fn(),
  GitBranches: jest.fn(),
  GitCheckout: jest.fn(),
  GitStage: jest.fn(),
  GitUnstage: jest.fn(),
  GitCommit: jest.fn(),
  GitPull: jest.fn(),
  GitPush: jest.fn(),
  GitCommitMessageAvailable: jest.fn(),
  GitGenerateCommitMessage: jest.fn(),
  GitFileAtRev: jest.fn(),
  ReadFile: jest.fn(),
}));

import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { GitCheckout, GitBranches } from '../../wails/bindings';
import { BranchSwitcher } from './BranchSwitcher';
import { useGitStore } from '../../stores/gitStore';
import type { git } from '../../wails/bindings';

const mockCheckout = GitCheckout as jest.MockedFunction<typeof GitCheckout>;

function seed(isRepo: boolean, branch = 'main', branches = ['main', 'feature/x']) {
  act(() => {
    useGitStore.getState().resetForWorkspace('/repo');
    useGitStore.setState({
      status: {
        isRepo,
        repoRoot: '/repo',
        branch,
        upstream: '',
        ahead: 0,
        behind: 0,
        files: [],
      } as unknown as git.RepoStatus,
      branches,
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckout.mockResolvedValue(undefined);
  (GitBranches as jest.Mock).mockResolvedValue(['main', 'feature/x']);
});

describe('BranchSwitcher', () => {
  it('renders nothing outside a git repository', () => {
    seed(false);
    const { container } = render(<BranchSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the current branch name', () => {
    seed(true, 'feature/git-integration');
    render(<BranchSwitcher />);
    expect(screen.getByRole('button', { name: /feature\/git-integration/i })).toBeInTheDocument();
  });

  it('opens a searchable popup and checks out a branch', async () => {
    seed(true);
    render(<BranchSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: /branch: main/i }));
    const popup = screen.getByRole('listbox');
    fireEvent.change(screen.getByPlaceholderText(/find or create branch/i), {
      target: { value: 'feature' },
    });
    fireEvent.click(within(popup).getByRole('option', { name: 'feature/x' }));
    await act(async () => {});

    expect(GitCheckout).toHaveBeenCalledWith('/repo', 'feature/x', false);
  });

  it('creates a branch from a novel query', async () => {
    seed(true);
    render(<BranchSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: /branch: main/i }));
    fireEvent.change(screen.getByPlaceholderText(/find or create branch/i), {
      target: { value: 'feature/brand-new' },
    });
    fireEvent.click(screen.getByRole('option', { name: /create branch feature\/brand-new/i }));
    await act(async () => {});

    expect(GitCheckout).toHaveBeenCalledWith('/repo', 'feature/brand-new', true);
  });

  it('opens when focusBranchRevision bumps (status bar / shortcut handoff)', () => {
    seed(true);
    render(<BranchSwitcher />);

    act(() => {
      useGitStore.getState().requestBranchPopupFocus();
    });

    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('portals the popup to document.body with fixed positioning', () => {
    seed(true);
    render(<BranchSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: /branch: main/i }));
    const popup = screen.getByTestId('branch-popup');

    // Portaled out of the panel so no ancestor stacking/overflow can clip it.
    expect(popup.parentElement).toBe(document.body);
    expect(popup.style.position).toBe('fixed');
  });

  it('focuses the search input on the very first open', () => {
    // First open renders with pos === null (the placement layout effect has
    // not run), so the popup mounts one commit later; the focus effect must
    // re-run when the input actually exists, not only when `open` flips.
    seed(true);
    render(<BranchSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: /branch: main/i }));

    expect(document.activeElement).toBe(screen.getByLabelText('Find or create branch'));
  });

  it('anchors the popup on-screen even when the trigger is narrow and left-aligned', () => {
    // The panel trigger sits on its own left-aligned row; right-edge anchoring
    // computed from a short branch name pinned the popup's right edge near the
    // window's left, hanging the whole menu off-screen. The popup must anchor
    // by its left edge, clamped inside the viewport (jsdom rects are all
    // zeros, which models the narrowest possible trigger).
    seed(true);
    render(<BranchSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: /branch: main/i }));
    const popup = screen.getByTestId('branch-popup');

    expect(popup.style.right).toBe('');
    const left = Number.parseFloat(popup.style.left);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 280).toBeLessThanOrEqual(window.innerWidth);
  });

  it('stays open when clicking inside the portaled popup', () => {
    seed(true);
    render(<BranchSwitcher />);

    fireEvent.click(screen.getByRole('button', { name: /branch: main/i }));
    fireEvent.mouseDown(screen.getByPlaceholderText(/find or create branch/i));

    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('restores the owning trigger focus after Escape when two instances are mounted', async () => {
    seed(true);
    render(
      <>
        <BranchSwitcher />
        <BranchSwitcher respondToFocusRequest={false} />
      </>
    );

    const triggers = screen.getAllByRole('button', { name: /branch: main/i });
    fireEvent.click(triggers[1]);
    await act(async () => {});
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(triggers[1]).toHaveFocus();
  });

  it('restores its trigger focus after choosing an option', async () => {
    seed(true);
    render(<BranchSwitcher />);

    const trigger = screen.getByRole('button', { name: /branch: main/i });
    fireEvent.click(trigger);
    await act(async () => {});
    fireEvent.click(screen.getByRole('option', { name: 'feature/x' }));
    await act(async () => {});

    expect(trigger).toHaveFocus();
  });

  it('does not steal focus from an outside pointer destination', async () => {
    seed(true);
    render(
      <>
        <BranchSwitcher />
        <button type="button">Destination</button>
      </>
    );

    fireEvent.click(screen.getByRole('button', { name: /branch: main/i }));
    await act(async () => {});
    const destination = screen.getByRole('button', { name: 'Destination' });
    destination.focus();
    fireEvent.mouseDown(destination);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(destination).toHaveFocus();
  });
});
