/**
 * Test: Header Component
 *
 * Tests for the Header component.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Header } from '../components/Header';
import { useIDEStore } from '../stores/ideStore';
import { formatShortcut } from '../utils/platform';

jest.mock('../wails/bindings', () => ({
  OpenFolderDialog: jest.fn(),
  ListRecentWorkspaces: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
  EventsOn: jest.fn(() => jest.fn()),
}));

import { OpenFolderDialog } from '../wails/bindings';
import { WindowSetTitle } from '../wails/runtime';

const renderHeader = (onOpenCommandPalette = jest.fn()) =>
  render(<Header onOpenCommandPalette={onOpenCommandPalette} />);

describe('Header Component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useIDEStore.setState({
      workspace: null,
      recentWorkspaces: [],
    });
  });

  it('should render the app name', () => {
    renderHeader();
    expect(screen.getByText('Firn')).toBeInTheDocument();
  });

  it('should render navigation buttons', () => {
    renderHeader();
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('should open the command palette from Search Everywhere without showing its shortcut', () => {
    const onOpenCommandPalette = jest.fn();
    renderHeader(onOpenCommandPalette);
    const searchButton = screen.getByRole('button', { name: 'Search everywhere' });
    fireEvent.click(searchButton);

    expect(searchButton).toHaveTextContent('Search Everywhere');
    expect(searchButton).not.toHaveTextContent(formatShortcut('⇧⌘P'));
    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('should show "No workspace" when no workspace is set', () => {
    renderHeader();
    expect(screen.getByText('No workspace')).toBeInTheDocument();
  });

  it('should show workspace name when workspace is set', () => {
    useIDEStore.setState({
      workspace: { name: 'my-project', path: '/Users/test/my-project' },
    });
    renderHeader();
    expect(screen.getByText('my-project')).toBeInTheDocument();
  });

  it('should call OpenFolderDialog when Open Folder menu item is clicked', async () => {
    (OpenFolderDialog as jest.Mock).mockResolvedValue('/Users/test/project');

    renderHeader();

    // Open the repository dropdown menu
    fireEvent.click(screen.getByRole('button', { name: /repository menu/i }));

    // Click "Open Folder..." in the dropdown
    fireEvent.click(screen.getByText('Open Folder...'));

    await waitFor(() => {
      expect(OpenFolderDialog).toHaveBeenCalled();
    });
  });

  it('should update workspace and window title after folder selection', async () => {
    (OpenFolderDialog as jest.Mock).mockResolvedValue('/Users/test/my-app');

    renderHeader();

    // Open the repository dropdown menu
    fireEvent.click(screen.getByRole('button', { name: /repository menu/i }));

    // Click "Open Folder..." in the dropdown
    fireEvent.click(screen.getByText('Open Folder...'));

    await waitFor(() => {
      const state = useIDEStore.getState();
      expect(state.workspace).toEqual({
        name: 'my-app',
        path: '/Users/test/my-app',
      });
      expect(WindowSetTitle).toHaveBeenCalledWith('my-app \u2014 Firn');
    });
  });

  it('should show recent projects in the dropdown menu', () => {
    useIDEStore.setState({
      workspace: { name: 'current', path: '/Users/test/current' },
      recentWorkspaces: [
        { name: 'current', path: '/Users/test/current', lastOpened: '2026-01-01T00:00:00Z' },
        {
          name: 'other-project',
          path: '/Users/test/other-project',
          lastOpened: '2025-12-31T00:00:00Z',
        },
      ],
    });

    renderHeader();

    // Open the repository dropdown menu
    fireEvent.click(screen.getByRole('button', { name: /repository menu/i }));

    // Current workspace should be filtered out, only "other-project" should appear
    expect(screen.getByText('other-project')).toBeInTheDocument();
    expect(screen.getByText('Recent Projects')).toBeInTheDocument();
  });

  it('should exclude the current workspace from the recent projects list', () => {
    useIDEStore.setState({
      workspace: { name: 'active-project', path: '/Users/test/active-project' },
      recentWorkspaces: [
        {
          name: 'active-project',
          path: '/Users/test/active-project',
          lastOpened: '2026-01-03T00:00:00Z',
        },
        {
          name: 'other-a',
          path: '/Users/test/other-a',
          lastOpened: '2026-01-02T00:00:00Z',
        },
        {
          name: 'other-b',
          path: '/Users/test/other-b',
          lastOpened: '2026-01-01T00:00:00Z',
        },
      ],
    });

    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /repository menu/i }));

    // The dropdown menu items should include only non-current workspaces.
    // "active-project" text appears in the workspace button label, but should
    // NOT appear as a menuitem in the recent projects list.
    const menuItems = screen.getAllByRole('menuitem');
    const recentMenuItemNames = menuItems
      .map((item) => item.textContent)
      .filter((text) => text !== 'Open Folder...');

    expect(recentMenuItemNames).toContain('other-a');
    expect(recentMenuItemNames).toContain('other-b');
    expect(recentMenuItemNames).not.toContain('active-project');
  });

  it('should switch workspace immediately when a recent project is clicked', () => {
    useIDEStore.setState({
      workspace: { name: 'current', path: '/Users/test/current' },
      recentWorkspaces: [
        {
          name: 'target-project',
          path: '/Users/test/target-project',
          lastOpened: '2026-01-01T00:00:00Z',
        },
      ],
    });

    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /repository menu/i }));
    fireEvent.click(screen.getByText('target-project'));

    // Workspace should switch immediately (synchronous, optimistic update)
    const state = useIDEStore.getState();
    expect(state.workspace).toEqual({
      name: 'target-project',
      path: '/Users/test/target-project',
    });
    expect(WindowSetTitle).toHaveBeenCalledWith('target-project \u2014 Firn');
  });

  it('renders the workspace selector when a repo is open', () => {
    useIDEStore.setState({
      workspace: { name: 'repo', path: '/repo' },
      workspaces: [
        { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
      ] as never,
      activeWorkspaceId: 'project',
    });
    renderHeader();
    expect(screen.getByRole('button', { name: /workspace selector/i })).toBeInTheDocument();
  });
});
