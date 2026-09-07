// src/__tests__/components/FileExplorer/FileExplorer.lazy.test.tsx
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FileExplorer } from '../../../components/FileExplorer';
import { useIDEStore } from '../../../stores/ideStore';
import { ReadDirectoryShallow } from '../../../wails/bindings';
import { filesystem } from '../../../wails/bindings';
import { installVirtualLayout } from '../../helpers/virtualTree';
import { __resetEnsurePathLoaded } from '../../../hooks/useEnsurePathLoaded';

jest.mock('../../../wails/bindings', () => {
  const actual = jest.requireActual('../../../wails/bindings');
  return {
    ...actual,
    ReadDirectory: jest.fn(),
    ReadDirectoryShallow: jest.fn(),
    ReadFile: jest.fn(),
    OpenFolderDialog: jest.fn(),
  };
});

jest.mock('../../../wails/runtime', () => ({
  WindowSetTitle: jest.fn(),
}));

const mockRefetch = jest.fn();
jest.mock('../../../components/FileExplorer/useDirectoryTree', () => ({
  useDirectoryTree: () => ({ refetch: mockRefetch }),
}));

// Children here are already FileEntry instances, so the constructor is the
// right entry point. createFrom would re-run Create.Array over every child, and
// useDefineForClassFields gives each instance an own `children` key even when
// unset — so the conversion would turn the unloaded sentinel (undefined) into
// an empty array and make the directory look loaded.
const dir = (path: string, children?: filesystem.FileEntry[]) =>
  new filesystem.FileEntry({
    name: path.split('/').pop()!,
    path,
    isDir: true,
    size: 0,
    modTime: new Date().toISOString(),
    children,
  });

describe('FileExplorer lazy-load on expand', () => {
  let restoreVirtualLayout: () => void;

  beforeEach(() => {
    restoreVirtualLayout = installVirtualLayout(400);
    jest.clearAllMocks();
    __resetEnsurePathLoaded();

    // Seed store: workspace /r, one unloaded dir /r/a (children === undefined)
    useIDEStore.setState({
      workspace: { name: 'r', path: '/r' },
      isLoading: false,
      isLoadingTree: false,
      treeError: null,
      directoryTree: [dir('/r/a')], // children undefined = unloaded
      expandedPaths: new Set<string>(),
      isRootExpanded: true,
      loadingPaths: new Set<string>(),
      dirtyPaths: new Set<string>(),
      toast: null,
    });

    (ReadDirectoryShallow as jest.Mock).mockResolvedValue([dir('/r/a/x')]);
  });

  afterEach(() => {
    restoreVirtualLayout();
  });

  it('calls ReadDirectoryShallow with the dir path when a collapsed dir is expanded', async () => {
    render(<FileExplorer />);

    // /r/a is visible as a top-level entry (root is expanded)
    const toggle = screen.getByRole('button', { name: /toggle a/i });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(ReadDirectoryShallow).toHaveBeenCalledTimes(1);
      expect(ReadDirectoryShallow).toHaveBeenCalledWith('/r/a', '/r');
    });
  });

  it('does NOT call ReadDirectoryShallow when a dir is collapsed', async () => {
    // Pre-expand /r/a so clicking toggle will collapse it
    act(() => {
      useIDEStore.setState({ expandedPaths: new Set(['/r/a']) });
    });

    render(<FileExplorer />);

    const toggle = screen.getByRole('button', { name: /toggle a/i });
    fireEvent.click(toggle);

    // Give any async call a chance to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(ReadDirectoryShallow).not.toHaveBeenCalled();
  });

  it('keeps an unreadable loaded-empty dir visible and retryable', async () => {
    const unreadable = dir('/r/a', []);
    unreadable.unreadable = true;
    act(() => {
      useIDEStore.setState({ directoryTree: [unreadable] });
    });

    render(<FileExplorer />);

    const row = screen.getByRole('treeitem', { name: 'a, unreadable' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('unreadable-indicator')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /toggle a/i }));

    await waitFor(() => {
      expect(ReadDirectoryShallow).toHaveBeenCalledWith('/r/a', '/r');
      expect(screen.getByRole('treeitem', { name: 'a' })).toBeInTheDocument();
      expect(screen.queryByTestId('unreadable-indicator')).not.toBeInTheDocument();
    });
  });

  it('keeps keyboard focus on an unreadable row while ArrowRight retries it', async () => {
    const unreadable = dir('/r/a', []);
    unreadable.unreadable = true;
    act(() => {
      useIDEStore.setState({ directoryTree: [unreadable] });
    });

    render(<FileExplorer />);
    const tree = screen.getByRole('tree', { name: 'File explorer' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });

    const row = screen.getByRole('treeitem', { name: 'a, unreadable' });
    expect(tree).toHaveAttribute('aria-activedescendant', row.id);
    fireEvent.keyDown(tree, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(ReadDirectoryShallow).toHaveBeenCalledWith('/r/a', '/r');
      expect(tree).toHaveAttribute('aria-activedescendant', row.id);
    });
  });

  it('retries a rejected expansion after collapse and re-expand', async () => {
    const realChild = dir('/r/a/real', []);
    (ReadDirectoryShallow as jest.Mock)
      .mockRejectedValueOnce(new Error('open /private/r/a: permission denied'))
      .mockResolvedValueOnce([realChild]);

    render(<FileExplorer />);
    const toggle = screen.getByRole('button', { name: /toggle a/i });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: 'a, unreadable' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });
    expect(useIDEStore.getState().toast).toEqual({
      message: 'Failed to load a',
      type: 'error',
    });

    fireEvent.click(toggle);
    expect(screen.getByRole('treeitem', { name: 'a, unreadable' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: 'real' })).toBeInTheDocument();
      expect(screen.getByRole('treeitem', { name: 'a' })).toHaveAttribute('aria-expanded', 'true');
    });
    expect(ReadDirectoryShallow).toHaveBeenCalledTimes(2);
    expect(useIDEStore.getState().directoryTree[0].unreadable).toBe(false);
    expect(useIDEStore.getState().dirtyPaths.has('/r/a')).toBe(false);
  });
});
