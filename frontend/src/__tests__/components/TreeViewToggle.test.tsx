import { render, screen, fireEvent } from '@testing-library/react';
import { TreeViewToggle } from '../../components/FileExplorer/TreeViewToggle';
import { useIDEStore } from '../../stores/ideStore';
import type { workspace } from '../../wails/bindings';

const defs = [
  { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
  { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'frontend', accent: 'frontend' },
] as workspace.WorkspaceDef[];

describe('TreeViewToggle', () => {
  beforeEach(() => {
    useIDEStore.setState({
      workspaces: [],
      activeWorkspaceId: 'project',
      lastFocusedWorkspaceId: null,
    });
  });

  it('disables the Workspace segment when there are no workspaces', () => {
    render(<TreeViewToggle />);
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeDisabled();
  });

  it('marks the active segment with aria-pressed', () => {
    useIDEStore.setState({ workspaces: defs, activeWorkspaceId: 'project' });
    render(<TreeViewToggle />);
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Workspace' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('switches to workspace mode on click', () => {
    useIDEStore.setState({ workspaces: defs, activeWorkspaceId: 'project' });
    render(<TreeViewToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(useIDEStore.getState().activeWorkspaceId).toBe('frontend');
  });
});
