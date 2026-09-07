// src/utils/flattenTree.test.ts
import { flattenVisibleTree, ROOT_ROW_KEY } from './flattenTree';
import type { FileEntry, WorkspaceAccent } from '../stores/ideStore';
import { getInfraFileAccent } from './workspaceRegions';

const file = (path: string, name: string): FileEntry =>
  ({ name, path, isDir: false, size: 0, modTime: '' }) as FileEntry;
const dir = (path: string, name: string, children: FileEntry[] = []): FileEntry =>
  ({ name, path, isDir: true, size: 0, modTime: '', children }) as FileEntry;

const base = {
  selectedPath: null as string | null,
  isRootExpanded: true,
  rootLabel: 'repo',
  rootPath: '/repo',
};

describe('flattenVisibleTree', () => {
  it('emits a single root row when the root is collapsed', () => {
    const rows = flattenVisibleTree({
      ...base,
      isRootExpanded: false,
      roots: [file('/repo/a.ts', 'a.ts')],
      expandedPaths: new Set(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'root',
      key: ROOT_ROW_KEY,
      depth: 0,
      level: 1,
      fileAccent: null,
    });
  });

  it('walks expanded branches in pre-order with correct depth/level', () => {
    const roots = [
      dir('/repo/src', 'src', [file('/repo/src/x.ts', 'x.ts')]),
      file('/repo/b.ts', 'b.ts'),
    ];
    const rows = flattenVisibleTree({
      ...base,
      roots,
      expandedPaths: new Set(['/repo/src']),
    });
    expect(rows.map((r) => r.key)).toEqual([
      ROOT_ROW_KEY,
      '/repo/src',
      '/repo/src/x.ts',
      '/repo/b.ts',
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1]);
    expect(rows.map((r) => r.level)).toEqual([1, 2, 3, 2]);
  });

  it('does not descend into collapsed directories', () => {
    const roots = [dir('/repo/src', 'src', [file('/repo/src/x.ts', 'x.ts')])];
    const rows = flattenVisibleTree({ ...base, roots, expandedPaths: new Set() });
    expect(rows.map((r) => r.key)).toEqual([ROOT_ROW_KEY, '/repo/src']);
    expect(rows[1].isExpanded).toBe(false);
  });

  it('computes setSize and posInSet per sibling group', () => {
    const roots = [
      dir('/repo/src', 'src', [file('/repo/src/x.ts', 'x.ts'), file('/repo/src/y.ts', 'y.ts')]),
      file('/repo/b.ts', 'b.ts'),
    ];
    const rows = flattenVisibleTree({
      ...base,
      roots,
      expandedPaths: new Set(['/repo/src']),
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['/repo/src']).toMatchObject({ setSize: 2, posInSet: 1 });
    expect(byKey['/repo/b.ts']).toMatchObject({ setSize: 2, posInSet: 2 });
    expect(byKey['/repo/src/x.ts']).toMatchObject({ setSize: 2, posInSet: 1 });
    expect(byKey['/repo/src/y.ts']).toMatchObject({ setSize: 2, posInSet: 2 });
  });

  it('precomputes regionAccent from the resolver, null when absent', () => {
    const roots = [file('/repo/a.ts', 'a.ts')];
    const resolver = (e: FileEntry): WorkspaceAccent | null =>
      e.path === '/repo/a.ts' ? 'frontend' : null;
    const tinted = flattenVisibleTree({
      ...base,
      roots,
      expandedPaths: new Set(),
      getRegionAccent: resolver,
    });
    expect(tinted.find((r) => r.key === '/repo/a.ts')?.regionAccent).toBe('frontend');

    const untinted = flattenVisibleTree({ ...base, roots, expandedPaths: new Set() });
    expect(untinted.find((r) => r.key === '/repo/a.ts')?.regionAccent).toBeNull();
  });

  it('precomputes independent region and file accents for a nested infra file', () => {
    const dockerfile = file('/repo/frontend/Dockerfile', 'Dockerfile');
    const rows = flattenVisibleTree({
      ...base,
      roots: [dir('/repo/frontend', 'frontend', [dockerfile])],
      expandedPaths: new Set(['/repo/frontend']),
      getRegionAccent: () => 'frontend',
      getFileAccent: getInfraFileAccent,
    });
    const row = rows.find((candidate) => candidate.key === dockerfile.path)!;

    expect(row.regionAccent).toBe('frontend');
    expect(row.fileAccent).toBe('docker');
  });

  it('marks the selected entry', () => {
    const roots = [file('/repo/a.ts', 'a.ts'), file('/repo/b.ts', 'b.ts')];
    const rows = flattenVisibleTree({
      ...base,
      selectedPath: '/repo/b.ts',
      roots,
      expandedPaths: new Set(),
    });
    expect(rows.find((r) => r.key === '/repo/a.ts')?.isSelected).toBe(false);
    expect(rows.find((r) => r.key === '/repo/b.ts')?.isSelected).toBe(true);
  });
});
