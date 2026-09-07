import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceTabs } from '../../components/FileExplorer/WorkspaceTabs';
import { useIDEStore } from '../../stores/ideStore';
import type { workspace } from '../../wails/bindings';

const defs = [
  { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
  { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'frontend', accent: 'frontend' },
  { id: 'go', name: 'Go', relDir: 'backend/go', type: 'go', accent: 'go' },
] as workspace.WorkspaceDef[];

describe('WorkspaceTabs', () => {
  beforeEach(() => {
    useIDEStore.setState({
      workspaces: defs,
      activeWorkspaceId: 'frontend',
      lastFocusedWorkspaceId: 'frontend',
    });
  });

  it('renders a tab per non-project workspace', () => {
    render(<WorkspaceTabs />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Frontend', 'Go']);
  });

  it('marks the active workspace tab as selected', () => {
    render(<WorkspaceTabs />);
    expect(screen.getByRole('tab', { name: 'Frontend' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Go' })).toHaveAttribute('aria-selected', 'false');
  });

  it('switches the active workspace on click', () => {
    render(<WorkspaceTabs />);
    fireEvent.click(screen.getByRole('tab', { name: 'Go' }));
    expect(useIDEStore.getState().activeWorkspaceId).toBe('go');
  });

  it('moves focus to the next tab with ArrowRight', () => {
    render(<WorkspaceTabs />);
    const first = screen.getByRole('tab', { name: 'Frontend' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Go' })).toHaveFocus();
  });

  it('renders nothing when there are no non-project workspaces', () => {
    useIDEStore.setState({ workspaces: [defs[0]], activeWorkspaceId: 'project' });
    const { container } = render(<WorkspaceTabs />);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
});
