import { renderHook } from '@testing-library/react';
import { useIDEStore } from '../../stores/ideStore';
import { useFileTreePresentation } from '../../hooks/useFileTreePresentation';
import type { workspace } from '../../wails/bindings';
import type { FileEntry } from '../../stores/ideStore';

const root = '/Users/me/repo';
const defs = [
  { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
  { id: 'frontend', name: 'Frontend', relDir: 'frontend', type: 'frontend', accent: 'frontend' },
  { id: 'go', name: 'Go', relDir: 'backend/go', type: 'go', accent: 'go' },
] as workspace.WorkspaceDef[];

const nestedDockerfile = {
  name: 'Dockerfile',
  path: `${root}/frontend/Dockerfile`,
  isDir: false,
} as FileEntry;

const tree: FileEntry[] = [
  { name: 'README.md', path: `${root}/README.md`, isDir: false } as FileEntry,
  {
    name: 'frontend',
    path: `${root}/frontend`,
    isDir: true,
    children: [
      { name: 'App.tsx', path: `${root}/frontend/App.tsx`, isDir: false } as FileEntry,
      nestedDockerfile,
    ],
  } as FileEntry,
  {
    name: 'backend',
    path: `${root}/backend`,
    isDir: true,
    children: [
      {
        name: 'go',
        path: `${root}/backend/go`,
        isDir: true,
        children: [
          { name: 'main.go', path: `${root}/backend/go/main.go`, isDir: false } as FileEntry,
        ],
      } as FileEntry,
    ],
  } as FileEntry,
];

function seed(activeWorkspaceId: string) {
  useIDEStore.setState({
    workspace: { name: 'repo', path: root },
    workspaces: defs,
    activeWorkspaceId,
    lastFocusedWorkspaceId: activeWorkspaceId !== 'project' ? activeWorkspaceId : null,
    directoryTree: tree,
  });
}

describe('useFileTreePresentation', () => {
  it('project mode exposes the full tree + a region resolver', () => {
    seed('project');
    const { result } = renderHook(() => useFileTreePresentation());
    expect(result.current.mode).toBe('project');
    expect(result.current.roots).toHaveLength(3);
    expect(result.current.rootLabel).toBe('repo');
    expect(result.current.scopedError).toBe(false);
    expect(result.current.treeAccent).toBeUndefined();
    expect(result.current.getRegionAccent?.(tree[1])).toBe('frontend');
    expect(result.current.getRegionAccent?.(nestedDockerfile)).toBe('frontend');
    expect(result.current.getFileAccent(nestedDockerfile)).toBe('docker');
  });

  it('workspace mode keeps file and region accents independent for nested infra files', () => {
    seed('frontend');
    const { result } = renderHook(() => useFileTreePresentation());

    expect(result.current.roots).toContain(nestedDockerfile);
    expect(result.current.getRegionAccent?.(nestedDockerfile)).toBe('frontend');
    expect(result.current.getFileAccent(nestedDockerfile)).toBe('docker');
  });

  it('workspace mode scopes to the children while row washes follow workspace ownership', () => {
    seed('go');
    const { result } = renderHook(() => useFileTreePresentation());
    expect(result.current.mode).toBe('workspace');
    expect(result.current.rootLabel).toBe('Go');
    expect(result.current.roots.map((e) => e.name)).toEqual(['main.go']);
    // Active scope stays cyan, while each row resolves its owning workspace.
    expect(result.current.treeAccent).toBe('go');
    expect(result.current.getRegionAccent?.(tree[0])).toBeNull();
    expect(result.current.getRegionAccent?.(tree[1])).toBe('frontend');
    expect(result.current.scopedError).toBe(false);
  });

  it('workspace mode scopes through normalized absolute paths, including Windows paths', () => {
    useIDEStore.setState({
      workspace: { name: 'repo', path: 'c:/repo' },
      workspaces: [
        { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
        {
          id: 'frontend',
          name: 'Frontend',
          relDir: 'frontend',
          type: 'frontend',
          accent: 'frontend',
        },
      ] as workspace.WorkspaceDef[],
      activeWorkspaceId: 'frontend',
      lastFocusedWorkspaceId: 'frontend',
      directoryTree: [
        {
          name: 'frontend',
          path: 'C:\\Repo\\frontend',
          isDir: true,
          children: [
            { name: 'App.tsx', path: 'C:\\Repo\\frontend\\App.tsx', isDir: false } as FileEntry,
          ],
        } as FileEntry,
      ],
    });

    const { result } = renderHook(() => useFileTreePresentation());
    expect(result.current.roots.map((e) => e.name)).toEqual(['App.tsx']);
    expect(result.current.rootPath).toBe('C:\\Repo\\frontend');
    expect(result.current.scopedError).toBe(false);
  });

  it('root workspace keeps its outer accent while nested row washes follow ownership', () => {
    useIDEStore.setState({
      workspace: { name: 'repo', path: root },
      workspaces: [
        { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
        { id: 'root:go', name: 'Go', relDir: '', type: 'go', accent: 'go' },
        {
          id: 'frontend',
          name: 'Frontend',
          relDir: 'frontend',
          type: 'frontend',
          accent: 'frontend',
        },
      ] as workspace.WorkspaceDef[],
      activeWorkspaceId: 'root:go',
      lastFocusedWorkspaceId: 'root:go',
      directoryTree: tree,
    });
    const { result } = renderHook(() => useFileTreePresentation());
    expect(result.current.roots).toHaveLength(3);
    expect(result.current.treeAccent).toBe('go');
    expect(result.current.getRegionAccent?.(tree[0])).toBe('go');
    expect(result.current.getRegionAccent?.(tree[1])).toBe('frontend');
    expect(result.current.getOwnershipAccent?.(tree[1])).toBe('frontend');
    expect(result.current.scopedError).toBe(false);
  });

  it('sets scopedError when the workspace folder is missing from the tree', () => {
    useIDEStore.setState({
      workspace: { name: 'repo', path: root },
      workspaces: [
        { id: 'project', name: 'Project', relDir: '', type: 'project', accent: 'project' },
        { id: 'ghost', name: 'Ghost', relDir: 'does/not/exist', type: 'go', accent: 'go' },
      ] as workspace.WorkspaceDef[],
      activeWorkspaceId: 'ghost',
      lastFocusedWorkspaceId: 'ghost',
      directoryTree: tree,
    });
    const { result } = renderHook(() => useFileTreePresentation());
    expect(result.current.scopedError).toBe(true);
    expect(result.current.roots).toEqual([]);
  });

  it('exposes an unreadable scoped directory as the workspace root state', () => {
    useIDEStore.setState({
      workspace: { name: 'repo', path: root },
      workspaces: defs,
      activeWorkspaceId: 'frontend',
      lastFocusedWorkspaceId: 'frontend',
      directoryTree: [
        {
          name: 'frontend',
          path: `${root}/frontend`,
          isDir: true,
          children: [],
          unreadable: true,
        } as unknown as FileEntry,
      ],
    });

    const { result } = renderHook(() => useFileTreePresentation());

    expect(result.current.rootUnreadable).toBe(true);
    expect(result.current.scopedError).toBe(false);
    expect(result.current.roots).toEqual([]);
  });

  it('exposes the nearest unreadable ancestor of a nested workspace', () => {
    useIDEStore.setState({
      workspace: { name: 'repo', path: root },
      workspaces: defs,
      activeWorkspaceId: 'go',
      lastFocusedWorkspaceId: 'go',
      directoryTree: [
        {
          name: 'backend',
          path: `${root}/backend`,
          isDir: true,
          unreadable: true,
          children: [
            {
              name: 'go',
              path: `${root}/backend/go`,
              isDir: true,
              children: [
                {
                  name: 'stale.go',
                  path: `${root}/backend/go/stale.go`,
                  isDir: false,
                } as FileEntry,
              ],
            } as FileEntry,
          ],
        } as unknown as FileEntry,
      ],
    });

    const { result } = renderHook(() => useFileTreePresentation());

    expect(result.current.rootUnreadable).toBe(true);
    expect(result.current.rootPath).toBe(`${root}/backend`);
    expect(result.current.scopedError).toBe(false);
    expect(result.current.roots).toEqual([]);
  });
});
