import { render, screen, fireEvent, act } from '@testing-library/react';
import { WorkspaceSelector } from '../../components/Header/WorkspaceSelector';
import { useIDEStore } from '../../stores/ideStore';
import { EventsOn } from '../../wails/runtime';
import type { workspace } from '../../wails/bindings';

jest.mock('../../wails/runtime', () => ({
  EventsOn: jest.fn(() => jest.fn()),
}));

const defs = [
  { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
  { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'frontend', accent: 'frontend' },
] as workspace.WorkspaceDef[];

beforeEach(() => {
  (EventsOn as jest.Mock).mockClear();
  useIDEStore.setState({
    workspace: { name: 'repo', path: '/repo' },
    workspaces: defs,
    activeWorkspaceId: 'project',
  });
});

it('renders the active workspace name', () => {
  render(<WorkspaceSelector />);
  expect(screen.getByRole('button', { name: /workspace/i })).toHaveTextContent('Project');
});

it('opens the menu and lists workspaces', () => {
  render(<WorkspaceSelector />);
  fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
  expect(screen.getByRole('menuitemradio', { name: /Frontend/ })).toBeInTheDocument();
});

it('selecting a workspace updates the active id', () => {
  render(<WorkspaceSelector />);
  fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Frontend/ }));
  expect(useIDEStore.getState().activeWorkspaceId).toBe('frontend');
});

it('renders nothing when no repo is open', () => {
  useIDEStore.setState({ workspace: null });
  const { container } = render(<WorkspaceSelector />);
  expect(container).toBeEmptyDOMElement();
});

it('marks the active workspace with aria-checked', () => {
  render(<WorkspaceSelector />);
  fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
  expect(screen.getByRole('menuitemradio', { name: /Project/ })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  expect(screen.getByRole('menuitemradio', { name: /Frontend/ })).toHaveAttribute(
    'aria-checked',
    'false'
  );
});

it('ArrowDown on the trigger opens the menu', () => {
  render(<WorkspaceSelector />);
  fireEvent.keyDown(screen.getByRole('button', { name: /workspace/i }), { key: 'ArrowDown' });
  expect(screen.getByRole('menu')).toBeInTheDocument();
});

it('Escape closes the menu', () => {
  render(<WorkspaceSelector />);
  fireEvent.click(screen.getByRole('button', { name: /workspace/i }));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

it('opens via the menu:switch-workspace event', () => {
  render(<WorkspaceSelector />);
  const call = (EventsOn as jest.Mock).mock.calls.find((c) => c[0] === 'menu:switch-workspace');
  expect(call).toBeDefined();
  act(() => call![1]());
  expect(screen.getByRole('menu')).toBeInTheDocument();
});
