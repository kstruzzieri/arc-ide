import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FileExplorer, rowDomId } from '../../../components/FileExplorer';
import { useIDEStore } from '../../../stores/ideStore';
import { useGitStore } from '../../../stores/gitStore';
import { ReadDirectory, ReadFile } from '../../../wails/bindings';
import { filesystem } from '../../../wails/bindings';
import { installVirtualLayout } from '../../helpers/virtualTree';

// Mock Wails bindings
jest.mock('../../../wails/bindings', () => {
  const actual = jest.requireActual('../../../wails/bindings');
  return {
    ...actual,
    ReadDirectory: jest.fn(),
    ReadFile: jest.fn(),
    OpenFolderDialog: jest.fn(),
  };
});

jest.mock('../../../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
}));

import { OpenFolderDialog } from '../../../wails/bindings';

// Mock the useDirectoryTree hook to prevent automatic fetching
const mockRefetch = jest.fn();
jest.mock('../../../components/FileExplorer/useDirectoryTree', () => ({
  useDirectoryTree: () => ({ refetch: mockRefetch }),
}));

// Create mock directory tree using proper FileEntry class
const mockDirectoryTree = [
  filesystem.FileEntry.createFrom({
    name: 'src',
    path: '/workspace/src',
    isDir: true,
    size: 0,
    modTime: new Date().toISOString(),
    children: [
      {
        name: 'App.tsx',
        path: '/workspace/src/App.tsx',
        isDir: false,
        size: 1024,
        modTime: new Date().toISOString(),
      },
      {
        name: 'components',
        path: '/workspace/src/components',
        isDir: true,
        size: 0,
        modTime: new Date().toISOString(),
        children: [
          {
            name: 'Button.tsx',
            path: '/workspace/src/components/Button.tsx',
            isDir: false,
            size: 512,
            modTime: new Date().toISOString(),
          },
        ],
      },
    ],
  }),
  filesystem.FileEntry.createFrom({
    name: 'package.json',
    path: '/workspace/package.json',
    isDir: false,
    size: 256,
    modTime: new Date().toISOString(),
  }),
];

describe('FileExplorer', () => {
  let restoreVirtualLayout: () => void;

  beforeEach(() => {
    restoreVirtualLayout = installVirtualLayout(400);
    jest.clearAllMocks();
    // Default mock that won't resolve during most tests
    (ReadDirectory as jest.Mock).mockImplementation(() => new Promise(() => {}));
    (ReadFile as jest.Mock).mockImplementation(() => new Promise(() => {}));
    mockRefetch.mockImplementation(() => {});
    // Reset store state
    useIDEStore.setState({
      workspace: { name: 'test-workspace', path: '/workspace' },
      isLoading: false,
      directoryTree: [],
      expandedPaths: new Set<string>(),
      isLoadingTree: false,
      treeError: null,
    });
  });

  afterEach(() => {
    restoreVirtualLayout();
  });

  describe('loading states', () => {
    it('shows loading skeleton when isLoadingTree is true', () => {
      // With useDirectoryTree mocked, we have full control over state
      act(() => {
        useIDEStore.setState({
          workspace: { name: 'test', path: '/test' },
          isLoadingTree: true,
          directoryTree: [],
        });
      });

      render(<FileExplorer />);

      // Should immediately show loading skeleton since isLoadingTree is true
      expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
    });

    it('shows empty state when no workspace is set', () => {
      act(() => {
        useIDEStore.setState({ workspace: null });
      });
      render(<FileExplorer />);
      expect(screen.getByText(/open a folder/i)).toBeInTheDocument();
    });

    it('shows empty state when workspace has no files', () => {
      // With hook mocked, directoryTree stays empty
      render(<FileExplorer />);
      expect(screen.getByText(/no files/i)).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('shows error message when treeError is set', () => {
      // With hook mocked, we can set error state directly
      act(() => {
        useIDEStore.setState({ treeError: 'Failed to read directory' });
      });

      render(<FileExplorer />);

      expect(screen.getByText(/failed to read directory/i)).toBeInTheDocument();
    });

    it('shows retry button on error', () => {
      // With hook mocked, we can set error state directly
      act(() => {
        useIDEStore.setState({ treeError: 'Failed to read directory' });
      });

      render(<FileExplorer />);

      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });
  });

  describe('tree rendering', () => {
    beforeEach(() => {
      act(() => {
        useIDEStore.setState({
          directoryTree: mockDirectoryTree,
          // isRootExpanded true so the root row + top-level entries are in the flat list
          isRootExpanded: true,
        });
      });
    });

    it('renders top-level entries', () => {
      // No expanded paths → only root + top-level files/dirs appear in the flat list.
      render(<FileExplorer />);
      // The virtualizer now mounts rows (shim provides layout). Flat list contains
      // the root row, 'src', and 'package.json' at the top level.
      expect(screen.getByText('src')).toBeInTheDocument();
      expect(screen.getByText('package.json')).toBeInTheDocument();
    });

    it('decorates rows from the gitStore status map', () => {
      act(() => {
        useGitStore.setState({
          statusByPath: { '/workspace/package.json': 'modified' },
        });
      });

      render(<FileExplorer />);

      const badge = screen.getByTestId('git-badge');
      expect(badge).toHaveTextContent('M');
      expect(screen.getByText('package.json').closest('[role="treeitem"]')).toHaveAttribute(
        'data-git',
        'modified'
      );
    });

    it('leaves unrelated rows undecorated', () => {
      act(() => {
        useGitStore.setState({
          statusByPath: { '/workspace/other.ts': 'modified' },
        });
      });

      render(<FileExplorer />);

      expect(screen.queryByTestId('git-badge')).not.toBeInTheDocument();
    });

    it('does not render nested files when folder is collapsed', () => {
      render(<FileExplorer />);
      // 'src' is collapsed → its children are absent from the flat list
      expect(screen.queryByText('App.tsx')).not.toBeInTheDocument();
    });

    it('renders nested files when folder is expanded', () => {
      act(() => {
        useIDEStore.setState({ expandedPaths: new Set(['/workspace/src']) });
      });
      render(<FileExplorer />);
      // src expanded → App.tsx and 'components' appear as treeitems
      expect(screen.getByText('App.tsx')).toBeInTheDocument();
      expect(screen.getByText('components')).toBeInTheDocument();
    });

    it('renders deeply nested files when parent folders are expanded', () => {
      act(() => {
        useIDEStore.setState({
          expandedPaths: new Set(['/workspace/src', '/workspace/src/components']),
        });
      });
      render(<FileExplorer />);
      // Both src and src/components expanded → Button.tsx is in the flat list
      expect(screen.getByText('Button.tsx')).toBeInTheDocument();
    });
  });

  describe('interactions', () => {
    beforeEach(() => {
      act(() => {
        useIDEStore.setState({
          directoryTree: mockDirectoryTree,
          expandedPaths: new Set(['/workspace/src']),
          isRootExpanded: true,
        });
      });
    });

    it('toggles folder expansion when chevron is clicked', () => {
      render(<FileExplorer />);
      // TreeRow renders a toggle button with aria-label "Toggle <name>" for dirs.
      // The 'src' folder is expanded, so click its toggle to collapse it.
      const toggle = screen.getByRole('button', { name: /toggle src/i });
      fireEvent.click(toggle);

      // After collapsing, src's children should no longer be in the flat list
      expect(screen.queryByText('App.tsx')).not.toBeInTheDocument();
    });

    it('selects (but does not open) a file on single click', () => {
      act(() => {
        useIDEStore.setState({ selectedPath: null, openFiles: [] });
      });

      render(<FileExplorer />);

      // App.tsx is visible because src is expanded in beforeEach.
      fireEvent.click(screen.getByText('App.tsx'));

      // Single click selects only: selectedPath is set, no file is opened.
      const state = useIDEStore.getState();
      expect(state.selectedPath).toBe('/workspace/src/App.tsx');
      expect(state.openFiles).toHaveLength(0);
    });

    it('opens a file on double click', async () => {
      (ReadFile as jest.Mock).mockResolvedValue({ content: 'test', encoding: 'utf-8' });
      act(() => {
        useIDEStore.setState({ openFiles: [], activeFileId: null });
      });

      render(<FileExplorer />);

      // App.tsx is visible because src is expanded in beforeEach.
      fireEvent.doubleClick(screen.getByText('App.tsx'));

      // Double click opens the file in the editor.
      await waitFor(() => {
        const state = useIDEStore.getState();
        expect(state.activeFileId).toBe('/workspace/src/App.tsx');
      });
    });

    it('reveals the active file by marking its row the active descendant', async () => {
      act(() => {
        useIDEStore.setState({
          isRootExpanded: true,
          expandedPaths: new Set(['/workspace/src']),
          selectedPath: '/workspace/src/App.tsx',
        });
      });

      render(<FileExplorer />);

      // The reveal effect locates the selected row and marks it the active
      // descendant (and keeps it within the rendered window).
      await waitFor(() => {
        const tree = screen.getByRole('tree');
        expect(tree).toHaveAttribute('aria-activedescendant', rowDomId('/workspace/src/App.tsx'));
      });
    });

    it('does not open folder when folder name is clicked', () => {
      // Reset openFiles to ensure clean state
      act(() => {
        useIDEStore.setState({ openFiles: [] });
      });
      render(<FileExplorer />);

      // Clicking folder row calls onSelect (which sets selectedPath), not openFile.
      // Verify openFiles remains empty after clicking 'src'.
      fireEvent.click(screen.getByText('src'));

      const state = useIDEStore.getState();
      expect(state.openFiles).toHaveLength(0);
    });
  });

  describe('data fetching', () => {
    it('calls refetch on retry button click', () => {
      act(() => {
        useIDEStore.setState({ treeError: 'Some error' });
      });

      render(<FileExplorer />);

      const retryButton = screen.getByRole('button', { name: /retry/i });
      fireEvent.click(retryButton);

      expect(mockRefetch).toHaveBeenCalled();
    });
  });

  describe('Open Folder', () => {
    beforeEach(() => {
      act(() => {
        useIDEStore.setState({
          workspace: null,
          directoryTree: [],
        });
      });
    });

    it('calls OpenFolderDialog when Open Folder button is clicked', async () => {
      (OpenFolderDialog as jest.Mock).mockResolvedValue('/Users/test/project');

      render(<FileExplorer />);

      const openButton = screen.getByRole('button', { name: /open folder/i });
      fireEvent.click(openButton);

      await waitFor(() => {
        expect(OpenFolderDialog).toHaveBeenCalled();
      });
    });

    it('sets workspace when folder is selected', async () => {
      (OpenFolderDialog as jest.Mock).mockResolvedValue('/Users/test/my-project');

      render(<FileExplorer />);

      fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

      await waitFor(() => {
        const state = useIDEStore.getState();
        expect(state.workspace).toEqual({
          name: 'my-project',
          path: '/Users/test/my-project',
        });
      });
    });

    it('does nothing when dialog is cancelled', async () => {
      (OpenFolderDialog as jest.Mock).mockResolvedValue(''); // Empty string = cancelled

      render(<FileExplorer />);

      fireEvent.click(screen.getByRole('button', { name: /open folder/i }));

      await waitFor(() => {
        expect(OpenFolderDialog).toHaveBeenCalled();
      });

      // Workspace should remain null
      const state = useIDEStore.getState();
      expect(state.workspace).toBeNull();
    });
  });
});
