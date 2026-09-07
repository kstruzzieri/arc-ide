// src/__tests__/components/FileExplorer/FileExplorerVirtualization.test.tsx
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { FileExplorer } from '../../../components/FileExplorer/FileExplorer';
import { useIDEStore } from '../../../stores/ideStore';
import { installVirtualLayout } from '../../helpers/virtualTree';
import type { filesystem, workspace } from '../../../wails/bindings';

// FileExplorer mounts useDirectoryTree, which auto-fetches through Wails when a
// workspace exists. This test seeds the store directly, so prevent the fetch.
const mockRefetch = jest.fn();
jest.mock('../../../components/FileExplorer/useDirectoryTree', () => ({
  useDirectoryTree: () => ({ refetch: mockRefetch }),
}));

jest.mock('../../../wails/bindings', () => ({
  ReadDirectory: jest.fn(),
  ReadFile: jest.fn(),
  OpenFolderDialog: jest.fn(),
}));

jest.mock('../../../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
}));

function makeFlatTree(n: number): filesystem.FileEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `file-${i}.ts`,
    path: `/repo/file-${i}.ts`,
    isDir: false,
    size: 0,
    modTime: '',
  })) as filesystem.FileEntry[];
}

describe('FileExplorer virtualization', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installVirtualLayout(400);
  });
  afterEach(() => {
    restore();
    jest.clearAllMocks();
    act(() => {
      useIDEStore.setState({
        workspace: null,
        workspaces: [],
        activeWorkspaceId: 'project',
        lastFocusedWorkspaceId: null,
        directoryTree: [],
        expandedPaths: new Set(),
        selectedPath: null,
        isRootExpanded: true,
        isLoadingTree: false,
        treeError: null,
      });
    });
  });

  it('mounts only a bounded window of rows for a large tree', () => {
    const tree = makeFlatTree(5000);
    tree[0].unreadable = true;
    act(() => {
      useIDEStore.setState({
        // workspace is WorkspaceInfo: { name, path }
        workspace: { name: 'repo', path: '/repo' },
        workspaces: [
          { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
        ] as workspace.WorkspaceDef[],
        activeWorkspaceId: 'project',
        directoryTree: tree,
        isRootExpanded: true,
        isLoadingTree: false,
        treeError: null,
      });
    });

    render(<FileExplorer />);

    const rendered = screen.getAllByRole('treeitem');
    expect(screen.getByRole('treeitem', { name: 'file-0.ts, unreadable' })).toBeInTheDocument();
    expect(screen.getByTestId('unreadable-indicator')).toHaveAttribute('aria-hidden', 'true');
    // 400px / 28px ≈ 15 visible + overscan + root, nowhere near 5000.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
  });
});
